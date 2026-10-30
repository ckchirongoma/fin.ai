// Charles — proof that the webhook's background work is actually kept alive.
//
// Production incident, 2026-09-20: three real "Hi" messages were claimed by
// the queue and never answered. Root cause: the webhook responded 200 to
// Meta and then continued draining the queue as a bare, un-awaited promise
// (`void work.catch(...)`) with nothing telling Vercel's Node runtime to
// keep the instance alive past the response. Vercel is free to freeze or
// tear the instance down the instant the response is flushed — and did.
// Every job was locked "running" and then simply stopped, with no thrown
// error and no log line, because the process was gone before it could write
// one.
//
// No local or CI environment can reproduce Vercel's actual freeze behaviour
// — that is a property of Vercel's infrastructure, not of this code, and
// nothing here can prove Vercel will honour the call. What this DOES prove,
// and what would have caught the regression before it reached production:
// the handler must call `waitUntil` (`@vercel/functions`) with the drain
// promise whenever work was queued, and must not call it when nothing was.
// `waitUntil`'s own implementation reads a well-known global symbol
// (`Symbol.for("@vercel/request-context")`) that Vercel's runtime sets in
// production and that is simply absent in a test process — installing a fake
// one here is the same technique Vercel documents for testing this API.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

// These tests count waitUntil calls exactly; tracking's own end-of-request
// flush (track.ts tracked()) is a separate waitUntil, so it is kept off here.
process.env.TRACKING_OFF = "1";
process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.WHATSAPP_APP_SECRET = "top-secret-app-secret";
process.env.WHATSAPP_VERIFY_TOKEN = "charles-verify";
process.env.WORKER_SECRET = "fake-worker-secret";
delete process.env.WHATSAPP_ACCESS_TOKEN;
delete process.env.WHATSAPP_PHONE_NUMBER_ID;

import { makeFakeDb, type FakeDb } from "./_fakes.ts";

const REQ_CONTEXT = Symbol.for("@vercel/request-context");

let db: FakeDb;
let restore: () => void;
let hook: typeof import("../api/whatsapp-webhook.ts");
let waitUntilCalls: unknown[];

const sign = (raw: string): string => "sha256=" + createHmac("sha256", "top-secret-app-secret").update(raw, "utf8").digest("hex");

const post = (raw: string) =>
  hook.POST(new Request("https://charles.test/api/whatsapp-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(raw) },
    body: raw,
  }));

const envelope = (messages: unknown[]) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "1" }, messages } }] }],
});

const textMsg = (id: string, from = "27809930003", body = "hello") => ({
  from, id, timestamp: "1780000000", type: "text", text: { body },
});

before(async () => {
  db = makeFakeDb();
  const dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  hook = await import("../api/whatsapp-webhook.ts");
});

after(() => restore?.());

beforeEach(() => {
  waitUntilCalls = [];
  // The same contract Vercel's own runtime installs in production, and the
  // documented way to mock it: a global the SDK reads via `getContext()`.
  (globalThis as any)[REQ_CONTEXT] = { get: () => ({ waitUntil: (p: unknown) => waitUntilCalls.push(p) }) };
});

after(() => {
  delete (globalThis as any)[REQ_CONTEXT];
});

test("a message that gets queued is kept alive with waitUntil, not fired-and-forgotten", async () => {
  const raw = JSON.stringify(envelope([textMsg("wamid.lifetime-1")]));
  const res = await post(raw);
  assert.equal(res.status, 200);
  // This is the exact line that was missing in production: the drain promise
  // must be registered with the runtime, not just started and abandoned.
  assert.equal(waitUntilCalls.length, 1, "expected the drain work to be registered with waitUntil");
  assert.equal(typeof (waitUntilCalls[0] as Promise<unknown>).then, "function", "waitUntil must be called with a real promise");
  await waitUntilCalls[0]; // let the drain actually finish before the test exits
});

test("a duplicate delivery of the same message queues nothing new, so waitUntil is not called again", async () => {
  const raw = JSON.stringify(envelope([textMsg("wamid.lifetime-2")]));
  await post(raw);
  await waitUntilCalls[0];
  waitUntilCalls.length = 0;

  const res = await post(raw); // Meta's retry of the identical wamid
  assert.equal(res.status, 200);
  assert.equal(waitUntilCalls.length, 0, "a deduped redelivery has no work to keep alive");
});

test("a delivery-receipt-only payload (no messages) never calls waitUntil", async () => {
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "1" }, statuses: [{ id: "wamid.x", status: "delivered", recipient_id: "27809930003", timestamp: "1780000000" }] } }] }],
  });
  const res = await post(raw);
  assert.equal(res.status, 200);
  assert.equal(waitUntilCalls.length, 0, "a receipt is not work to keep the instance alive for");
});
