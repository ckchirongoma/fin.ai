// Fin — a message this old is not a live instruction any more.
//
// Incident, 2026-09-21: a per-owner lock stuck for hours meant a backlog of
// messages queued up and then replayed HOURS LATE once it cleared — every one
// of them answered as if it had just arrived, including a "forget my
// business" that fired long after the owner had moved on and answered
// several more questions. These tests drive handleInbound directly with a
// message whose own WhatsApp timestamp (not the time the test runs) is old,
// which is exactly the shape of a message that sat queued for hours.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
process.env.WORKER_SECRET = "fake-worker-secret";
delete process.env.TYPESAFE_API_KEY;

import { installFakeNet, makeFakeDb, textFrom, type FakeDb, type FakeNet } from "./_fakes.ts";

const OWNER = "27809979999";
const STALE_MS = 20 * 60 * 1000; // well past the 10-minute window

const MODEL_ROLES = ["router", "wa_reply", "help", "plan_builder", "safety"].map((role) => ({
  role, provider: "openrouter", model: `test/${role}`, fallbacks: [], params: {}, enabled: true,
}));

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let engine: typeof import("../api/_lib/engine/index.ts");

before(async () => {
  net = installFakeNet();
  net.onModel(/You are a strict checker/, () => ({}));
  net.onModel(/Classify this message from a person to their money assistant/, () => ({
    intent: "question", domain: null, tool_need: null, missing_fact: null, risk: [], search_terms: "x",
  }));
  net.onModel(/You maintain one person's money memory/, () => ({ context_updates: null, map_updates: null, decisions: null, commitments: null, results: null }));
  net.onModel(/ROUTER RESULT/, () => ({ message: "One thing to do.", artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: null }));

  db = makeFakeDb({ model_config: MODEL_ROLES, knowledge_entries: [], tools: [] });
  const dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  engine = await import("../api/_lib/engine/index.ts");
});

after(() => {
  restore?.();
  net?.restore();
});

const seedBusiness = (overrides: Record<string, unknown> = {}) => {
  const row = {
    id: `biz-${db.tables.businesses!.length + 1}`,
    wa_id: OWNER,
    country: "ZA",
    stage: "plan_ready",
    diag_step: 12,
    answers: {},
    pending_action: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
  db.tables.businesses!.push(row);
  return row;
};

beforeEach(() => {
  db.tables.businesses!.length = 0;
  db.tables.messages!.length = 0;
  net.sent.length = 0;
  net.modelCalls.length = 0;
});

const allText = () => net.sent.map((m) => m.body).join("\n---\n");

test("a message hours old is never acted on, and gets one honest apology instead", async () => {
  const biz = seedBusiness();
  const callsBefore = net.modelCalls.length;

  await engine.handleInbound(textFrom(OWNER, "Getting more customers", { timestamp: Date.now() - STALE_MS }));

  assert.equal(net.modelCalls.length, callsBefore, "not a single model call spent on stale mail");
  assert.match(allText(), /delayed/i);
  const stillSameStage = db.tables.businesses!.find((b) => b.id === biz.id)!.stage;
  assert.equal(stillSameStage, "plan_ready", "the stage never moved because of stale input");
});

test("a burst of stale messages gets ONE apology, not one per message", async () => {
  seedBusiness();
  await engine.handleInbound(textFrom(OWNER, "Hi", { timestamp: Date.now() - STALE_MS }));
  await engine.handleInbound(textFrom(OWNER, "?", { timestamp: Date.now() - STALE_MS + 1000 }));
  await engine.handleInbound(textFrom(OWNER, "Getting more customers", { timestamp: Date.now() - STALE_MS + 2000 }));

  const apologies = net.sent.filter((m) => /delayed/i.test(m.body));
  assert.equal(apologies.length, 1, `expected one apology across the whole backlog, got ${apologies.length}`);
});

test("a fresh message is answered normally, even right after a stale one", async () => {
  seedBusiness();
  await engine.handleInbound(textFrom(OWNER, "Hi", { timestamp: Date.now() - STALE_MS }));
  net.sent.length = 0;

  await engine.handleInbound(textFrom(OWNER, "1", { timestamp: Date.now() }));

  // "1" against plan_ready dispatches to the plan pusher / step flow, not the
  // stale-apology path — the exact reply text isn't the point, only that it
  // was NOT dropped as stale.
  assert.ok(!/delayed/i.test(allText()), "a fresh message must not be swept up by the stale gate");
});

test("a brand-new number's first message is never 'stale', however old its timestamp", async () => {
  // No seeded business: isNew is true.
  await engine.handleInbound(textFrom(OWNER, "Hi", { timestamp: Date.now() - STALE_MS }));

  assert.match(allText(), /forget my money/i, "the normal welcome went out, not an apology");
  assert.equal(db.tables.businesses!.length, 1, "a business was created for a first contact, however delayed");
});

test("forget my money is refused when it arrives stale, before it ever reaches the confirm step", async () => {
  const biz = seedBusiness();
  await engine.handleInbound(textFrom(OWNER, "forget my money", { timestamp: Date.now() - STALE_MS }));

  assert.equal(db.tables.businesses!.find((b) => b.id === biz.id)?.pending_action, null, "no confirm prompt was ever armed");
  assert.equal(db.tables.businesses!.length, 1, "and nothing was deleted");
  assert.match(allText(), /delayed/i);
});
