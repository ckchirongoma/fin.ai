// Fin — the guardrails, and the two ways an owner used to get stranded.
//
// The distress path is the most ethically load-bearing behaviour in the
// product. The evidence it comes from is specific: in a field experiment with
// 640 Kenyan entrepreneurs, an AI mentor made the WEAKEST businesses about 10%
// worse. So a business showing real distress must get stabilising advice and a
// free human advisor instead of a 90-day growth plan — and, just as
// importantly, must be able to come back out of that state when things steady.
// The first version could not: it re-ran the check against the same frozen
// diagnostic answers forever.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";
process.env.WORKER_SECRET = "fake-worker-secret";
delete process.env.TYPESAFE_API_KEY;

import { drainJobs, installFakeNet, makeFakeDb, tapFrom, textFrom, type FakeDb, type FakeNet } from "./_fakes.ts";

const OWNER = "27809930002";

const MODEL_ROLES = ["router", "wa_reply", "help", "plan_builder", "safety"].map((role) => ({
  role, provider: "openrouter", model: `test/${role}`, fallbacks: [], params: {}, enabled: true,
}));

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let engine: typeof import("../api/_lib/engine/index.ts");

/** Flips between "this household is in hardship" and "it has steadied". */
let inDistress = true;

before(async () => {
  net = installFakeNet();

  net.onModel(/You are a strict checker/, (prompt) => {
    const ids = [...prompt.matchAll(/- "([a-z_]+)":/g)].map((m) => m[1]!);
    return Object.fromEntries(ids.map((id) => [id, id === "distress" ? inDistress : false]));
  });
  net.onModel(/THREE genuinely different 90-day goals|Read this person's money back to them/, () => ({
    identity: { name: "Nomsa", earns: "a cleaning job and one child grant", one_liner: "A cleaning job and one grant in Diepsloot", unsure: null },
    stage: "surviving", signals: { month_short: true, arrears: true, top_problem: "m_month" },
    objective_read: "Get the month under control.", reflection: "A cleaning job and one grant, behind on the rent.",
    recommend: "Start with 1 — the month first.",
    options: [{ id: "a", label: "The month without borrowing", what: "Get to the 30th without a new loan", why_you: "The rent is behind", worth: "No figure given", first_move: "Write down one week of spending", catch: "It needs the three pots" }],
  }));
  net.onModel(/You maintain one person's money memory/, () => ({ context_updates: null, map_updates: null, decisions: null, commitments: null, results: null }));

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

beforeEach(() => {
  net.sent.length = 0;
});

const allText = () => net.sent.map((m) => m.body).join("\n---\n");
const business = () => db.tables.businesses![0]!;

async function runDiagnostic(): Promise<void> {
  await engine.handleInbound(textFrom(OWNER, "hi"));
  const answers = [
    "Nomsa, I clean at a school and get one child grant",
    "1",
    "Diepsloot, Johannesburg",
    "I cannot pay rent this month and the landlord is threatening to lock me out",
    "4", "3", "3", "About R3,200", "2", "1", "5", "1",
  ];
  for (const a of answers) await engine.handleInbound(textFrom(OWNER, a));
}

test("a household in real hardship gets stabilising advice, not a plan", async () => {
  inDistress = true;
  await runDiagnostic();

  assert.equal(business().stage, "stabilizing");
  assert.equal(db.tables.plans!.length, 0, "no plan is built for a household that cannot pay rent");

  const text = allText();
  assert.match(text, /keeping food, a roof and transport covered/i);
  assert.match(text, /food, rent and transport before anything else/i);
  assert.match(text, /Don'?t borrow to cover it/i);
  // Rule 11 and rule 9: no credit, and the free advisor named — the NCR line, nobody selling anything.
  assert.match(text, /National Credit Regulator/);
  assert.match(text, /nobody there is selling you anything/);
  assert.doesNotMatch(text, /loan app|consolidat/i);

  const events = db.tables.safety_events!.filter((e) => e.check_name === "distress");
  assert.ok(events.length >= 1);
  assert.equal(events.at(-1)!.outcome, "block");
  assert.equal(events.at(-1)!.engine, "model", "with no Jev key the model backstop runs — the check is never simply skipped");
});

test("while things are still hard, the advice holds and the person is not pushed", async () => {
  inDistress = true;
  await engine.handleInbound(textFrom(OWNER, "still no luck, the landlord gave me a week"));

  assert.equal(business().stage, "stabilizing");
  assert.equal(db.tables.plans!.length, 0);
  assert.match(allText(), /no new borrowing/i);
});

test("stabilising is not a dead end: when things steady, the plan is offered", async () => {
  // The first version re-checked the same frozen diagnostic answers on every
  // message, so this verdict could never change and the person was locked out
  // of the product permanently.
  inDistress = false;
  await engine.handleInbound(textFrom(OWNER, "I paid the rent, my sister covered it and the grant came through"));

  const text = allText();
  assert.match(text, /steadier/i);
  const buttons = net.sent.flatMap((m) => m.buttons).map((b) => b.id);
  assert.ok(buttons.includes("a.build.now"));

  // Asked, not assumed: nothing is built until the person says so.
  assert.equal(db.tables.plans!.length, 0);
  assert.equal(business().stage, "stabilizing");

  // What they told us is kept, so the next check sees the new evidence.
  assert.match(business().answers.since_stabilising, /paid the rent/);
});

test("taking the offer starts the build", async () => {
  await engine.handleInbound(tapFrom(OWNER, "a.build.now", "Yes, build it"));
  assert.notEqual(business().stage, "stabilizing");
  assert.match(allText(), /really after|Get the month under control/i);
});

test("a build that dies leaves the person recoverable, not stranded", async () => {
  // Put the business into a transient build stage with no plan_builds row at
  // all — what a killed instance before the resumable machinery existed
  // would leave behind, or a build so stale even the opportunistic sweep
  // should have already reclaimed it. The next message must pick it up
  // rather than answering "Got it, I've written that down" forever.
  const biz = business();
  const dbmod = await import("../api/_lib/db.ts");
  db.tables.plan_builds!.length = 0;
  await dbmod.updateBusiness(biz.id, {
    stage: "building_plan",
    pending_action: { kind: "building", since: new Date(Date.now() - 10 * 60_000).toISOString() },
  } as never);

  net.sent.length = 0;
  await engine.handleInbound(textFrom(OWNER, "hello? are you still there"));

  // Not stranded: the person heard something immediately...
  assert.ok(net.sent.length > 0, "the person heard something back");
  // ...and a real stage job now exists to actually resume the build, rather
  // than the message just vanishing into "building_plan" with nothing behind
  // it — see engine/planbuild.ts's resumePlanBuild.
  const stageJobs = db.tables.jobs!.filter((j) => j.kind === "plan_build_stage" && j.business_id === biz.id && j.status === "queued");
  assert.ok(stageJobs.length > 0, "a stage job was enqueued to resume the build");
});

test("a message arriving DURING a healthy build says something true", async () => {
  const biz = business();
  const dbmod = await import("../api/_lib/db.ts");
  await dbmod.updateBusiness(biz.id, {
    stage: "building_plan",
    pending_action: { kind: "building", since: new Date().toISOString() },
  } as never);
  // A stage job genuinely in flight — a fresh heartbeat, the same as a real
  // plan_build_stage job leaves moments after being claimed.
  db.tables.plan_builds!.length = 0;
  db.tables.plan_builds!.push({
    business_id: biz.id,
    stage: "building",
    goal: "get the month to fit",
    context: {},
    map: [],
    dropped_modules: [],
    strategy: null,
    strategy_done: false,
    workstreams: [],
    pending_workstreams: ["w1"],
    plan_id: null,
    last_error: null,
    heartbeat_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  });

  net.sent.length = 0;
  await engine.handleInbound(textFrom(OWNER, "how long?"));
  assert.match(allText(), /Still putting it together/i);
  assert.equal(business().stage, "building_plan");

  // Review, 2026-09-24: the heartbeat only moves between model calls, so a
  // slow stage looked stalled. A running stage job in the queue is the truth.
  const pb = db.tables.plan_builds!.find((r) => r.business_id === biz.id)!;
  pb.heartbeat_at = new Date(Date.now() - 5 * 60_000).toISOString();
  db.tables.jobs = [
    { id: 900, kind: "plan_build_stage", business_id: biz.id, wa_id: null, payload: { step: "workstreams" }, status: "running", attempts: 1, max_attempts: 3, run_after: new Date().toISOString(), locked_at: new Date(Date.now() - 20_000).toISOString(), locked_by: "handon-x", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ];
  net.sent.length = 0;
  await engine.handleInbound(textFrom(OWNER, "still going?"));
  assert.match(allText(), /Still putting it together/i);
  assert.doesNotMatch(allText(), /Picking that back up/);

  // And a FAILED build is picked back up, never described as still going.
  pb.stage = "failed";
  pb.heartbeat_at = new Date().toISOString();
  db.tables.jobs = [];
  net.sent.length = 0;
  await engine.handleInbound(textFrom(OWNER, "hello?"));
  assert.match(allText(), /Picking that back up now/);
  assert.doesNotMatch(allText(), /Still putting it together/);
});

test("asking for no more check-ins is honoured, and ordinary conversation does not undo it", async () => {
  await engine.handleInbound(textFrom(OWNER, "stop"));
  assert.equal(business().paused, true);
  assert.match(allText(), /No more check-ins/i);

  net.sent.length = 0;
  await engine.handleInbound(textFrom(OWNER, "actually one more question about the rent"));
  assert.equal(business().paused, true, "messaging us is not consent to resume interrupting them");
});
