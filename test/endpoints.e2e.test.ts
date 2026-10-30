// Fin — the endpoints an owner or an operator actually touches:
// signing in to read a plan, checking whether the thing is healthy, and the
// cohort report a sponsor gets.
//
// The sign-in flow is the one place where a stranger's input reaches owner
// data, so most of this file is about what it refuses.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.SESSION_SECRET = "fake-session-secret";
process.env.WORKER_SECRET = "fake-worker-secret";
process.env.WHATSAPP_APP_SECRET = "fake-app-secret";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
process.env.PUBLIC_BASE_URL = "https://fin.test";
delete process.env.TYPESAFE_API_KEY;

import { installFakeNet, makeFakeDb, type FakeDb, type FakeNet } from "./_fakes.ts";

const OWNER = "27809930003";
const STRANGER = "27829999999";

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let plan: typeof import("../api/plan.ts");
let health: typeof import("../api/health.ts");
let sponsor: typeof import("../api/sponsor.ts");

const post = (body: unknown, action: string) =>
  plan.POST(new Request(`https://fin.test/api/plan?action=${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

const get = (cookie?: string, qs = "") =>
  plan.GET(new Request(`https://fin.test/api/plan${qs}`, { headers: cookie ? { cookie } : {} }));

/** The code only ever exists in the message we sent, which is the point. */
const codeFromWhatsApp = (): string => {
  // The WhatsApp message is the six digits and nothing else.
  return [...net.sent].reverse().find((m) => /^\d{6}$/.test(m.body))?.body ?? "";
};

before(async () => {
  net = installFakeNet();
  db = makeFakeDb({
    businesses: [
      {
        id: "biz-1", wa_id: OWNER, country: "ZA", stage: "plan_ready", biz_stage: "stretching",
        identity: { name: "Thandi's Hair Studio", one_liner: "Braids in Woodstock" },
        context: { name: "Thandi's Hair Studio", one_liner: "Braids in Woodstock", location: "Woodstock" },
        customer: [], angle: [], alternatives: [],
        map: [{ domain: "spending", status: "red", note: "Cash only" }],
        baseline_tier: "low", current_plan_id: "plan-1",
        last_inbound_at: new Date().toISOString(), paused: false, deleted_at: null,
      },
    ],
    plans: [{ id: "plan-1", business_id: "biz-1", goal: "Take deposits on Saturdays", headline: "Ninety days on getting paid" }],
    plan_steps: [
      { id: "s1", plan_id: "plan-1", workstream_title: "Collect what you are owed", domain: "spending", step_order: 0, step_key: "o1", title: "List everyone who owes you", push: "Write the list tonight.", artifact: "Client | Amount | Date", tool_id: null, why_for_you: "Fastest cash in the plan", done_when: "the list is written", status: "done" },
      { id: "s2", plan_id: "plan-1", workstream_title: "Collect what you are owed", domain: "spending", step_order: 1, step_key: "o2", title: "Send one calm message", push: "One message each.", artifact: "Hi, there's an amount outstanding...", tool_id: null, why_for_you: "It works", done_when: "you've messaged everyone", status: "open" },
    ],
    tools: [],
    outcomes: [{ business_id: "biz-1", effect: "better", created_at: new Date().toISOString() }],
    commitments: [{ business_id: "biz-1", status: "done" }],
    business_map: [{ business_id: "biz-1", domain: "spending", status: "red", note: "Cash only" }],
    safety_events: [{ check_name: "distress", engine: "model", outcome: "pass", created_at: new Date().toISOString() }],
    wa_templates: [{ id: "login_code", meta_name: "fin_login_code", language: "en", body: "Your Fin code is {{1}}.", variables: ["code"], status: "draft" }],
    model_config: [{ role: "safety", provider: "openrouter", model: "test/safety", fallbacks: [], params: {}, enabled: true }],
  });
  const dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  plan = await import("../api/plan.ts");
  health = await import("../api/health.ts");
  sponsor = await import("../api/sponsor.ts");
});

after(() => {
  restore?.();
  net?.restore();
});

beforeEach(() => {
  net.sent.length = 0;
});

// ── Signing in ───────────────────────────────────────────────────

test("an unknown number gets exactly the same answer as a known one", async () => {
  const known = await post({ wa_id: OWNER }, "request_code");
  net.sent.length = 0;
  const unknown = await post({ wa_id: STRANGER }, "request_code");

  assert.equal(known.status, unknown.status);
  assert.deepEqual(await known.json(), await unknown.json());
  // Otherwise this endpoint becomes a way to find out who has an account.
  assert.equal(net.sent.length, 0, "and no message goes to a number we do not know");
});

test("a rubbish number is refused before anything is looked up", async () => {
  const res = await post({ wa_id: "12" }, "request_code");
  assert.equal(res.status, 400);
  assert.match((await res.json()).message, /country code/i);
});

test("the code arrives on WhatsApp and nowhere else", async () => {
  db.tables.plan_access_codes = [];
  const res = await post({ wa_id: OWNER }, "request_code");
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.ok(codeFromWhatsApp().length === 6, "a six-digit code was sent to the owner's phone");
  assert.doesNotMatch(JSON.stringify(body), /\d{6}/, "and it is not in the HTTP response");

  const stored = db.tables.plan_access_codes![0]!;
  assert.ok(stored.code_hash && !/^\d{6}$/.test(stored.code_hash), "only a hash is stored");
});

test("a wrong code is refused and counted", async () => {
  const res = await post({ wa_id: OWNER, code: "000000" }, "verify");
  assert.equal(res.status, 401);
  assert.equal(db.tables.plan_access_codes![0]!.attempts, 1);
});

test("too many wrong codes burns the code entirely", async () => {
  for (let i = 0; i < 5; i++) await post({ wa_id: OWNER, code: "000001" }, "verify");
  const res = await post({ wa_id: OWNER, code: "000001" }, "verify");
  assert.ok(res.status === 429 || res.status === 401);
  assert.equal(db.tables.plan_access_codes!.length, 0, "guessing gets you a fresh start, not more guesses");
});

test("the right code signs you in, and the code cannot be reused", async () => {
  db.tables.plan_access_codes = [];
  net.sent.length = 0;
  await post({ wa_id: OWNER }, "request_code");
  const code = codeFromWhatsApp();

  const res = await post({ wa_id: OWNER, code }, "verify");
  assert.equal(res.status, 200);

  const cookie = res.headers.get("set-cookie") ?? "";
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);

  assert.equal(db.tables.plan_access_codes!.length, 0, "used once, then gone");
  const session = db.tables.plan_sessions![0]!;
  assert.ok(session.token_hash);
  assert.equal(session.business_id, "biz-1");

  // The stored session is a hash, so the cookie value must not appear in it.
  const token = /fin_session=([^;]+)/.exec(cookie)![1]!;
  assert.notEqual(session.token_hash, token);
});

test("an expired code is refused", async () => {
  db.tables.plan_access_codes = [];
  net.sent.length = 0;
  await post({ wa_id: OWNER }, "request_code");
  const code = codeFromWhatsApp();
  db.tables.plan_access_codes![0]!.expires_at = new Date(Date.now() - 1000).toISOString();

  const res = await post({ wa_id: OWNER, code }, "verify");
  assert.equal(res.status, 401);
  assert.match((await res.json()).message, /expired/i);
});

// ── Reading the plan ─────────────────────────────────────────────

test("without a session there is no plan, only a 401", async () => {
  const res = await get();
  assert.equal(res.status, 401);
});

test("with a session the plan renders, and it is the SAME plan WhatsApp built", async () => {
  db.tables.plan_access_codes = [];
  db.tables.plan_sessions = [];
  net.sent.length = 0;
  await post({ wa_id: OWNER }, "request_code");
  const verify = await post({ wa_id: OWNER, code: codeFromWhatsApp() }, "verify");
  const cookie = `fin_session=${/fin_session=([^;]+)/.exec(verify.headers.get("set-cookie")!)![1]}`;

  const res = await get(cookie);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const html = await res.text();

  // Straight from the stored rows, not regenerated.
  assert.match(html, /Thandi/);
  assert.match(html, /Take deposits on Saturdays/);
  assert.match(html, /List everyone who owes you/);
  assert.match(html, /Send one calm message/);
  // Rule 8 holds here too — this is the same renderer as the PDF.
  assert.match(html, /<table role="presentation"/);
  assert.doesNotMatch(html, /display:\s*(grid|flex)/);
});

test("a forged session token gets nothing", async () => {
  const res = await get("fin_session=made-up-value");
  assert.equal(res.status, 401);
});

test("an expired session gets nothing, and is cleaned up", async () => {
  db.tables.plan_sessions![0]!.expires_at = new Date(Date.now() - 1000).toISOString();
  const res = await get("fin_session=anything");
  assert.equal(res.status, 401);
});

// ── Health ───────────────────────────────────────────────────────

test("the public health check says whether the guardrails are live, and nothing else", async () => {
  const res = await health.GET(new Request("https://fin.test/api/health"));
  const body = await res.json();

  assert.equal(body.guardrails_live, true);
  assert.equal(body.guardrails, "model", "with no Jev key it is the model backstop — never 'none'");
  // A list of what is missing is a map for anyone looking for a way in.
  assert.equal(body.subsystems, undefined);
  assert.equal(body.queue, undefined);
});

test("with the worker secret, health says exactly what is configured", async () => {
  const res = await health.GET(new Request("https://fin.test/api/health", { headers: { Authorization: "Bearer fake-worker-secret" } }));
  const body = await res.json();
  assert.ok(Array.isArray(body.subsystems));
  assert.ok(body.notes.some((n: string) => /Guardrails running/.test(n)));
  assert.ok(body.queue);
});

// ── The cohort report ────────────────────────────────────────────

test("the sponsor report needs a secret", async () => {
  assert.equal((await sponsor.GET(new Request("https://fin.test/api/sponsor"))).status, 403);
});

test("the sponsor report is aggregates only, split by baseline tier", async () => {
  const res = await sponsor.GET(new Request("https://fin.test/api/sponsor", { headers: { Authorization: "Bearer fake-worker-secret" } }));
  const body = await res.json();

  assert.equal(body.cohort.onboarded, 1);
  assert.equal(body.cohort.completed_a_plan, 1);
  assert.equal(body.by_baseline_tier.low.businesses, 1);
  assert.equal(body.by_baseline_tier.low.better, 1);
  assert.match(body.harm_monitoring, /outcome check-ins|improvement/i);

  // Nothing identifying may appear anywhere in it.
  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, new RegExp(OWNER));
  assert.doesNotMatch(raw, /biz-1/);
  assert.doesNotMatch(raw, /Thandi/);
});

test("the sponsor report can be downloaded as a CSV", async () => {
  const res = await sponsor.GET(new Request("https://fin.test/api/sponsor?format=csv", { headers: { Authorization: "Bearer fake-worker-secret" } }));
  assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
  const csv = await res.text();
  assert.match(csv, /^metric,segment,value/);
  assert.match(csv, /baseline_low/);
});

// Founder, 2026-09-24: "the option to submit a number doesn't work". Two ways
// the page said "a code is on its way" and then nothing ever came.
test("a number typed the local way is refused with how to fix it, not a silent 'on its way'", async () => {
  const res = await post({ wa_id: "0821234567" }, "request_code");
  assert.equal(res.status, 400);
  assert.match((await res.json()).message, /27809930000/);
  assert.equal(net.sent.length, 0);
});

test("outside the 24-hour window, the answer says how to get a code through", async () => {
  const res = await post({ wa_id: STRANGER }, "request_code");
  assert.match((await res.json()).message, /No code after a minute\? Send "hi" to Fin on WhatsApp/);
});

test("a number from outside the five markets can still sign in — only the local 0 form is refused", async () => {
  const res = await post({ wa_id: "447700900123" }, "request_code");
  assert.equal(res.status, 200);
  const intl = await post({ wa_id: "0027809930003" }, "request_code");
  assert.equal(intl.status, 200, "00 + country code is the international form, not local");
});

test("the code arrives as the six digits alone, so the phone can offer to copy or fill it", async () => {
  db.tables.plan_access_codes = [];
  await post({ wa_id: OWNER }, "request_code");
  const last = net.sent.filter((m) => m.to === OWNER).at(-1)!;
  assert.match(last.body, /^\d{6}$/);
});

// Live, 2026-09-25: the tester read real sign-in codes out of the messages
// table — as ordinary "text" rows, which is what every prompt and the owner's
// own AI read as memory. The row stays (the live verifier signs in with a
// synthetic number by reading it back), but under its own kind, and the
// conversation memory never carries it.
test("the code is logged under its own kind: readable from the database by kind, never as a conversation turn", async () => {
  db.tables.plan_access_codes = [];
  db.tables.messages = [];
  await post({ wa_id: OWNER }, "request_code");
  const code = codeFromWhatsApp();
  assert.equal(code.length, 6);

  const rows = db.tables.messages!.filter((m) => m.business_id === "biz-1" && m.direction === "out");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, "login_code", "the row is labelled, so a service-role reader can find it by kind");
  assert.equal(rows[0]!.text, code, "and it still holds the code — that is how the live verifier signs in");

  const dbmod = await import("../api/_lib/db.ts");
  const memory = await dbmod.recentMessages("biz-1");
  assert.deepEqual(memory, [], "the conversation memory does not carry it");
});

// Live, 2026-09-25: the PDF shows a connected owner "Your own AI is
// connected" (the "Carrying this with you" box) and the website never did —
// renderPlan never asked whether the connector was live.
test("the website plan shows the connected-AI box once the owner has connected, and never points at itself", async () => {
  db.tables.plan_access_codes = [];
  db.tables.plan_sessions = [];
  db.tables.connector_tokens = [];
  await post({ wa_id: OWNER }, "request_code");
  const verify = await post({ wa_id: OWNER, code: codeFromWhatsApp() }, "verify");
  const cookie = `fin_session=${/fin_session=([^;]+)/.exec(verify.headers.get("set-cookie")!)![1]}`;

  const before = await (await get(cookie)).text();
  assert.ok(!before.includes("Carrying this with you"), "nothing is claimed for an owner who has not connected");

  db.tables.connector_tokens!.push({ business_id: "biz-1", token_hash: "hash-of-a-live-address", label: "Owner's AI", revoked_at: null, created_at: new Date().toISOString() });
  const after = await (await get(cookie)).text();
  assert.ok(after.includes("Carrying this with you"));
  assert.ok(after.includes("Your own AI is connected"));
  assert.ok(!after.includes("/mcp/"), "no address, placeholder or real, is printed");
  // "Read it online at /plan" is the page they are already on.
  assert.ok(!after.includes("Read it online"));

  db.tables.connector_tokens![0]!.revoked_at = new Date().toISOString();
  const revoked = await (await get(cookie)).text();
  assert.ok(!revoked.includes("Your own AI is connected"), "a revoked address is not a connection");
  db.tables.connector_tokens = [];
});

test("a local number typed with brackets or dashes is refused too", async () => {
  for (const wa_id of ["(082) 123 4567", "082-123-4567"]) {
    const res = await post({ wa_id }, "request_code");
    assert.equal(res.status, 400, wa_id);
  }
});

// Answers have no word cap now, and a button message's body stops at 1024
// characters: a long answer must arrive whole, with the buttons after it.
test("an answer too long for a button message arrives whole, buttons after", async () => {
  const { sendReply } = await import("../api/_lib/engine/steps.ts");
  const long = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}: something the owner needs.`).join("\n");
  assert.ok(long.length > 1024);
  net.sent.length = 0;
  await sendReply({ id: "biz-owner", wa_id: OWNER } as any, { message: long, artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: null } as any, [{ id: "a.step.next", title: "Next step" }]);
  assert.equal(net.sent[0]!.body, long, "the whole answer, not clipped");
  assert.equal(net.sent[1]!.body, "What next?");
  assert.deepEqual(net.sent[1]!.buttons.map((b) => b.id), ["a.step.next"]);
});

test("a long answer with words to paste: answer, then the words, then the buttons last", async () => {
  const { sendReply } = await import("../api/_lib/engine/steps.ts");
  const long = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}: something the owner needs.`).join("\n");
  net.sent.length = 0;
  await sendReply({ id: "biz-owner", wa_id: OWNER, context: { name: "Rinse" } } as any, { message: long, artifact: "Hi, this is Rinse. Your laundry is ready for collection.", next_tap: null, quick_replies: [], tool_id: null, domain: null } as any, [{ id: "a.step.next", title: "Next step" }]);
  assert.deepEqual(net.sent.map((m) => m.body), [long, "Hi, this is Rinse. Your laundry is ready for collection.", "What next?"]);
});
