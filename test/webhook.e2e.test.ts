// Fin — the webhook's contract with Meta.
//
// Four properties, and every one of them was broken in the first version:
//   - an unsigned request is refused, because this endpoint is public and
//     anyone who found the URL could otherwise write owner data and spend
//     model credits
//   - the signature is checked against the RAW bytes, so a message containing
//     an accent or an emoji still verifies
//   - the same WhatsApp message id is never processed twice, however many
//     times Meta redelivers it
//   - delivery receipts are not messages, and a batch is not one message

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.WHATSAPP_APP_SECRET = "top-secret-app-secret";
process.env.WHATSAPP_VERIFY_TOKEN = "fin-verify";
process.env.WORKER_SECRET = "fake-worker-secret";
// No WhatsApp send credentials: the webhook must still accept and enqueue.
delete process.env.WHATSAPP_ACCESS_TOKEN;
delete process.env.WHATSAPP_PHONE_NUMBER_ID;

import { makeFakeDb, type FakeDb } from "./_fakes.ts";

let db: FakeDb;
let restore: () => void;
let hook: typeof import("../api/whatsapp-webhook.ts");

const sign = (raw: string): string => "sha256=" + createHmac("sha256", "top-secret-app-secret").update(raw, "utf8").digest("hex");

const post = (raw: string, signature?: string) =>
  hook.POST(new Request("https://fin.test/api/whatsapp-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(signature ? { "X-Hub-Signature-256": signature } : {}) },
    body: raw,
  }));

const envelope = (messages: unknown[], statuses: unknown[] = []) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "1" }, ...(messages.length ? { messages } : {}), ...(statuses.length ? { statuses } : {}) } }] }],
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

test("the verification handshake returns the raw challenge, not JSON", async () => {
  const res = await hook.GET(new Request("https://fin.test/api/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=fin-verify&hub.challenge=1158201444"));
  assert.equal(res.status, 200);
  // Wrapping it in quotes is the classic reason Meta reports "verification failed".
  assert.equal(await res.text(), "1158201444");
});

test("a wrong verify token is refused", async () => {
  const res = await hook.GET(new Request("https://fin.test/api/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=1"));
  assert.equal(res.status, 403);
});

test("an unsigned POST is refused and nothing is written", async () => {
  const raw = JSON.stringify(envelope([textMsg("wamid.unsigned")]));
  const res = await post(raw);
  assert.equal(res.status, 403);
  assert.equal(db.tables.jobs!.length, 0);
});

test("a POST signed with the wrong secret is refused", async () => {
  const raw = JSON.stringify(envelope([textMsg("wamid.badsig")]));
  const wrong = "sha256=" + createHmac("sha256", "not-the-secret").update(raw).digest("hex");
  assert.equal((await post(raw, wrong)).status, 403);
  assert.equal(db.tables.jobs!.length, 0);
});

test("a correctly signed message is accepted and queued", async () => {
  const raw = JSON.stringify(envelope([textMsg("wamid.good")]));
  const res = await post(raw, sign(raw));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "EVENT_RECEIVED");
  assert.equal(db.tables.jobs!.length, 1);
  assert.equal(db.tables.jobs![0]!.kind, "inbound");
  assert.equal(db.tables.wa_inbound!.length, 1);
});

test("a message containing non-ASCII still verifies, because the HMAC is over the raw bytes", async () => {
  // Meta escapes non-ASCII as \uXXXX. Re-serialising the parsed JSON changes
  // the bytes and the digest never matches — which would mean every message
  // with an accent, an emoji or a non-Latin script silently failing.
  const raw = '{"object":"whatsapp_business_account","entry":[{"id":"W","changes":[{"field":"messages","value":{"messages":[{"from":"27809930003","id":"wamid.accented","timestamp":"1780000000","type":"text","text":{"body":"Jo\\u00e3o\'s salon \\ud83d\\udc87\\ud83c\\udffe"}}]}}]}]}';
  const res = await post(raw, sign(raw));
  assert.equal(res.status, 200);
  const job = db.tables.jobs!.find((j) => j.payload.waMessageId === "wamid.accented");
  assert.ok(job, "the message was accepted");
  assert.match(job!.payload.text, /João's salon/);
});

test("Meta's retry of the same message never produces a second job", async () => {
  const before = db.tables.jobs!.length;
  const raw = JSON.stringify(envelope([textMsg("wamid.retried")]));
  await post(raw, sign(raw));
  await post(raw, sign(raw));
  await post(raw, sign(raw));
  assert.equal(db.tables.jobs!.length, before + 1, "three deliveries, one job");
});

test("delivery receipts are not messages", async () => {
  const before = db.tables.jobs!.length;
  const raw = JSON.stringify(envelope([], [{ id: "wamid.out.1", status: "delivered", timestamp: "1780000100", recipient_id: "27809930003", conversation: { expiration_timestamp: "1780086400" } }]));
  const res = await post(raw, sign(raw));
  assert.equal(res.status, 200);
  assert.equal(db.tables.jobs!.length, before, "a receipt must never start a conversation");
});

test("a batched delivery queues every message in it", async () => {
  const before = db.tables.jobs!.length;
  const raw = JSON.stringify(envelope([textMsg("wamid.b1", "27820000001"), textMsg("wamid.b2", "27820000002"), textMsg("wamid.b3", "27820000003")]));
  await post(raw, sign(raw));
  assert.equal(db.tables.jobs!.length, before + 3, "Meta batches; reading only the first message drops the rest");
});

test("a change on a field other than messages is ignored", async () => {
  const before = db.tables.jobs!.length;
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "W", changes: [{ field: "message_template_status_update", value: { event: "APPROVED", message_template_name: "fin_monday_focus" } }] }],
  });
  assert.equal((await post(raw, sign(raw))).status, 200);
  assert.equal(db.tables.jobs!.length, before);
});

test("unparseable JSON is accepted rather than retried forever", async () => {
  const raw = "{not json";
  const res = await post(raw, sign(raw));
  // Returning 500 for something we have already decided we cannot use only
  // guarantees Meta redelivers it.
  assert.equal(res.status, 200);
});

test("with no app secret the webhook refuses everything, loudly", async () => {
  const saved = process.env.WHATSAPP_APP_SECRET;
  try {
    // env is snapshotted at import, so reach into the module the same way a
    // misconfigured deploy would look from the outside.
    const envmod = await import("../api/_lib/env.ts");
    Object.defineProperty(envmod.env, "WHATSAPP_APP_SECRET", { value: "", configurable: true });
    const raw = JSON.stringify(envelope([textMsg("wamid.nosecret")]));
    const res = await post(raw, sign(raw));
    assert.equal(res.status, 503, "silently accepting unauthenticated traffic is the worse failure");
  } finally {
    const envmod = await import("../api/_lib/env.ts");
    Object.defineProperty(envmod.env, "WHATSAPP_APP_SECRET", { value: saved, configurable: true });
  }
});
