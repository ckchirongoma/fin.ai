// Charles — the five judgements that used to be a writer grading its own work.
// Each one: what it decides, what it may NOT do, and what happens when no
// engine can run.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.TYPESAFE_API_KEY = "fake-jev-key";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";
process.env.WORKER_SECRET = "fake-worker-secret";

import { installFakeNet, makeFakeDb, type FakeDb, type FakeNet } from "./_fakes.ts";

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let j: typeof import("../api/_lib/judgement.ts");
let env: Record<string, string | undefined>;
let playbooks: typeof import("../api/_lib/playbooks.ts");

// What the model backstop answers with, changed per test.
let backstop: Record<string, unknown> = {};

before(async () => {
  net = installFakeNet();
  const roles = ["router", "wa_reply", "help", "plan_builder", "safety"].map((role) => ({
    role, provider: "openrouter", model: "xiaomi/mimo-v2.5", fallbacks: [], params: {}, enabled: true,
  }));
  db = makeFakeDb({ model_config: roles });
  const dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  env = (await import("../api/_lib/env.ts")).env as unknown as Record<string, string | undefined>;
  j = await import("../api/_lib/judgement.ts");
  playbooks = await import("../api/_lib/playbooks.ts");
  net.onModel(/You are a strict checker/, () => backstop);
});

after(() => {
  restore?.();
  net?.restore();
});

beforeEach(() => {
  db.tables.safety_events!.length = 0;
  net.jev.calls.length = 0;
  net.jev.handler = null;
  env.TYPESAFE_API_KEY = "fake-jev-key";
  backstop = {};
});

const events = (check: string) => db.tables.safety_events!.filter((e) => e.check_name === check);

// ── 1. Transcript arbitration ────────────────────────────────────

const chooses = (choice: string, confidence = 0.9) => () => ({
  trade: { type: "choice", choice, probabilities: { [choice]: confidence }, confidence },
});

test("no confusable word, no call: the check costs nothing for most people", async () => {
  net.jev.handler = chooses("stokvel");
  const r = await j.arbitrateTrade({ person: "Lerato, domestic work three days a week" });
  assert.equal(r.question, null);
  assert.equal(r.ran, false, "arbitration never applied — no confusable pair in the text");
  assert.equal(net.jev.calls.length, 0);
});

test("'stock fell' heard, but the answers describe a savings club: the person is asked, in pre-written words", async () => {
  net.jev.handler = chooses("stokvel");
  const r = await j.arbitrateTrade({
    person: "Nomsa, I pay into the stock fell every month",
    owes: "Family or friends",
    objective: "I want my pot in December without borrowing",
  });
  assert.equal(r.question, "Did you mean a stokvel rather than stock that fell?");
  assert.equal(r.ran, true);
});

test("the reverse: 'stokvel' heard, answers describe shares that dropped", async () => {
  net.jev.handler = chooses("stock_fell");
  const r = await j.arbitrateTrade({ person: "my stokvel dropped 20% this year", objective: "the shares I bought on the app lost value" });
  assert.equal(r.question, "Did you mean stock that fell rather than a stokvel?");
  assert.equal(r.ran, true);
});

test("mashonisa versus machine is arbitrated the same way", async () => {
  net.jev.handler = chooses("mashonisa");
  const r = await j.arbitrateTrade({ person: "the machine takes R200 every week from my grant, with interest" });
  assert.equal(r.question, "Did you mean a mashonisa rather than a machine?");
  assert.equal(r.ran, true);
});

test("when the answers agree with what was heard, nothing is asked — but arbitration DID run and confirm it, which the caller must trust", async () => {
  // Incident, 2026-09-21 (Charlie): a plain, unambiguous word still let the
  // model's own spurious `identity.unsure` slip through, because
  // `question: null` here looked identical to arbitration never having run
  // at all. `ran: true` is the fix: a caller must know this was
  // independently CONFIRMED, not merely untested.
  net.jev.handler = chooses("stokvel");
  const r = await j.arbitrateTrade({ person: "a stokvel of twelve of us, R200 a month" });
  assert.equal(r.question, null);
  assert.equal(r.ran, true, "arbitration ran and positively confirmed the stokvel reading");
});

test("'neither fits' still counts as a verdict — an engine answered, so ran is true", async () => {
  net.jev.handler = chooses("other");
  const r = await j.arbitrateTrade({ person: "I fix the washing machine at the laundry" });
  assert.equal(r.question, null);
  assert.equal(r.ran, true);
  assert.equal(net.jev.calls.length, 1, "the engine was actually asked");
});

test("both readings in the person's own words is context, not an error — no call, and arbitration never ran", async () => {
  net.jev.handler = chooses("stokvel");
  const r = await j.arbitrateTrade({ person: "my stokvel paid out and the stock fell the same week" });
  assert.equal(r.question, null);
  assert.equal(r.ran, false);
  assert.equal(net.jev.calls.length, 0);
});

test("low confidence never overrides what the person said, but the engine still reached a verdict", async () => {
  net.jev.handler = chooses("stokvel", 0.3);
  const r = await j.arbitrateTrade({ person: "the stock fell this year" });
  assert.equal(r.question, null);
  assert.equal(r.ran, true);
});

test("the judge decides WHETHER to ask; every word of the question is pre-written", async () => {
  net.jev.handler = chooses("stokvel");
  const r = await j.arbitrateTrade({ person: "the stock fell, R200 a month" });
  assert.match(r.question!, /^Did you mean (a stokvel|stock that fell) rather than (a stokvel|stock that fell)\?$/);
});

test("Jev down: the model backstop arbitrates, and the audit row says which engine", async () => {
  backstop = { trade: "stokvel" };
  const r = await j.arbitrateTrade({ person: "the stock fell, R200 a month" });
  assert.equal(r.question, "Did you mean a stokvel rather than stock that fell?");
  assert.equal(r.ran, true);
  assert.equal(events("trade_arbitration")[0]!.engine, "model");
});

test("no engine at all: ran is false, and an 'unavailable' row on the record", async () => {
  net.onModel(/You are a strict checker/, () => { throw new Error("down"); });
  env.TYPESAFE_API_KEY = "";
  const r = await j.arbitrateTrade({ person: "the stock fell, R200 a month" }, { businessId: "b1" });
  assert.equal(r.question, null);
  assert.equal(r.ran, false, "no engine could arbitrate — the model's own doubt, if any, must still be used");
  assert.equal(events("trade_arbitration")[0]!.outcome, "unavailable");
});

// ── 2. Scam scoring ──────────────────────────────────────────────

const scores = (score: number) => () => ({ scam: { type: "score", score, confidence: 0.9, legend: {}, probabilities: {} } });

test("scam levels: benign, unverifiable, advance-fee", async () => {
  net.jev.handler = scores(0.1);
  assert.equal(await j.scoreScam("A supplier's price list for June"), 0);
  net.jev.handler = scores(1.0);
  assert.equal(await j.scoreScam("Vague offer from a WhatsApp number"), 1);
  net.jev.handler = scores(1.9);
  assert.equal(await j.scoreScam("Pay R500 to release your R50 000 grant"), 2);
});

test("an exact tie between unverifiable and advance-fee rounds toward the warning", async () => {
  net.jev.handler = scores(1.5);
  assert.equal(await j.scoreScam("something"), 2);
});

test("nothing to score is null, not level 0", async () => {
  assert.equal(await j.scoreScam("   "), null);
});

test("level 2 is written to the audit trail as a block", async () => {
  net.jev.handler = scores(2);
  await j.scoreScam("pay the fee");
  assert.equal(events("scam_score")[0]!.outcome, "block");
});

test("Jev down: the model backstop scores it, choosing the higher level when unsure", async () => {
  backstop = { level: 2 };
  assert.equal(await j.scoreScam("pay the fee"), 2);
  assert.equal(events("scam_score")[0]!.engine, "model");
});

test("the warning names the country's free advisor and says never to use the link", () => {
  const za = j.scamWarning("ZA");
  assert.match(za, /National Credit Regulator/);
  assert.match(za, /don't use the link/i);
  assert.match(za, /Don't pay anything/);
  assert.match(za, /don't send an ID number or bank details/);
});

// ── 3. The nudge gate ────────────────────────────────────────────

const nouls = (wont_help: number, repeats_recent: number) => () => ({
  wont_help: { type: "noul", noul: wont_help },
  repeats_recent: { type: "noul", noul: repeats_recent },
});
const nudgeState = { business: { name: "Thandi" }, daysSinceLastMessage: 4, openCommitments: "set up booking link", recentNudges: "monday_focus" };

test("a follow-up that would not help is skipped", async () => {
  net.jev.handler = nouls(0.9, 0.1);
  const g = await j.gateNudge("This week for Thandi's: post three times.", nudgeState);
  assert.equal(g.skip, true);
  assert.match(g.reason, /unlikely to help/);
});

test("a follow-up that repeats a recent one is skipped, and says why", async () => {
  net.jev.handler = nouls(0.1, 0.85);
  const g = await j.gateNudge("This week for Thandi's: post three times.", nudgeState);
  assert.equal(g.skip, true);
  assert.match(g.reason, /repeat/);
});

test("a useful, fresh follow-up goes out", async () => {
  net.jev.handler = nouls(0.1, 0.05);
  assert.equal((await j.gateNudge("Did you set up the booking link?", nudgeState)).skip, false);
});

test("with no engine the gate lets the nudge through — on the record", async () => {
  net.onModel(/You are a strict checker/, () => { throw new Error("down"); });
  env.TYPESAFE_API_KEY = "";
  assert.equal((await j.gateNudge("Did you set up the booking link?", nudgeState)).skip, false);
  assert.equal(events("nudge_gate")[0]!.outcome, "unavailable");
});

// ── 4. Outcome attribution ───────────────────────────────────────

const implausible = (n: number) => () => ({ implausible: { type: "noul", noul: n } });
const step = { title: "Set up your booking link", domain: "protection", done_when: "one booking came through it" };

test("'Yes, already' a minute after a step that takes weeks: the map does not move", async () => {
  net.jev.handler = implausible(0.9);
  assert.equal(await j.outcomePlausible(step, { minutesSinceDone: 1 }), false);
});

test("a plausible improvement moves the map as before", async () => {
  net.jev.handler = implausible(0.15);
  assert.equal(await j.outcomePlausible(step, { minutesSinceDone: 6000 }), true);
});

test("only a calibrated score can withhold the map: a model backstop's bare 'yes' cannot", async () => {
  backstop = { implausible: true };
  assert.equal(await j.outcomePlausible(step, { minutesSinceDone: 1 }), true);
});

test("no engine: the map moves exactly as it used to", async () => {
  net.onModel(/You are a strict checker/, () => { throw new Error("down"); });
  env.TYPESAFE_API_KEY = "";
  assert.equal(await j.outcomePlausible(step, { minutesSinceDone: 1 }), true);
});

// ── 5. Module audit ──────────────────────────────────────────────

const mods = [
  { id: "m_cash", title: "Get control of the cash", why: "cash is tight" },
  { id: "m_time", title: "Get your time back", why: "too busy" },
  { id: "m_found", title: "Be findable", why: "word of mouth only" },
];
const evidence = (topProblem: string | null = null) => ({ answers: { blockers: "Cash is tight" }, problemInTheirWords: "cash is tight", topProblem });
const auditAnswers = (byId: Record<string, number>) => () =>
  Object.fromEntries(Object.entries(byId).map(([id, n]) => [id, { type: "noul", noul: n }]));

test("a module the answers clearly do not evidence is dropped before it is tailored", async () => {
  net.jev.handler = auditAnswers({ m_cash: 0.9, m_time: 0.1, m_found: 0.8 });
  assert.deepEqual(await j.auditModules(mods, evidence()), ["m_time"]);
});

test("the owner's own stated top problem is never audited away", async () => {
  net.jev.handler = auditAnswers({ m_cash: 0.05, m_time: 0.9, m_found: 0.9 });
  assert.deepEqual(await j.auditModules(mods, evidence("m_cash")), []);
});

test("a plan is never audited down to nothing", async () => {
  net.jev.handler = auditAnswers({ m_cash: 0.1, m_time: 0.1, m_found: 0.1 });
  assert.deepEqual(await j.auditModules(mods, evidence()), []);
});

test("a borderline module is kept: only 'clearly not evidenced' drops anything", async () => {
  net.jev.handler = auditAnswers({ m_cash: 0.9, m_time: 0.45, m_found: 0.5 });
  assert.deepEqual(await j.auditModules(mods, evidence()), []);
});

test("without Jev the audit does nothing — a model's bare 'false' is not enough to drop a module", async () => {
  env.TYPESAFE_API_KEY = "";
  assert.deepEqual(await j.auditModules(mods, evidence()), []);
  assert.equal(net.jev.calls.length, 0);
});

test("Jev unreachable: keep everything, on the record", async () => {
  net.jev.handler = null; // 503
  assert.deepEqual(await j.auditModules(mods, evidence()), []);
  assert.equal(events("module_audit")[0]!.outcome, "unavailable");
});

test("pickPlaybook can leave a module out, and the next-best steps in", () => {
  const signals = { month_short: true, dont_know_where: true, no_cushion: true, owes_any: true, top_problem: "m_month" };
  const answers = { objective_kind: "Make the month fit" };
  const first = playbooks.pickPlaybook("stretching", signals, answers, [])!;
  assert.ok(first.workstreams.some((w) => w.id === "m_month"));
  const without = playbooks.pickPlaybook("stretching", signals, answers, [], ["m_month"])!;
  assert.ok(!without.workstreams.some((w) => w.id === "m_month"));
  assert.ok(without.workstreams.length >= 1);
  assert.notEqual(without.workstreams[0]!.id, first.workstreams[0]!.id, "the lead part is rebuilt, not stale");
});

// ── In a real conversation ───────────────────────────────────────

test("a scam the writer waved through still reaches the owner as a warning", async () => {
  const dbmod = await import("../api/_lib/db.ts");
  const engine = await import("../api/_lib/engine/index.ts");
  const OWNER = "27809970000";
  const biz = await dbmod.createBusiness(OWNER, "ZA");
  await dbmod.updateBusiness(biz.id, {
    stage: "plan_ready",
    consent_at: new Date().toISOString(),
    context: { name: "Thandi", earns: "a salon wage", location: "Woodstock" },
    identity: { name: "Thandi", earns: "a salon wage", one_liner: "A salon wage", unsure: null },
  } as never);

  net.media.mime = "image/jpeg";
  net.media.bytes = new Uint8Array([255, 216, 255, 224]);
  net.onModel(/Report what is in it/, () => "WHAT IT IS: a grant message\nWHAT IT SAYS: You qualify for R50 000. Send R500 and your bank PIN to release it today.");
  net.onModel(/Classify this message from a person to their money assistant/, () => ({
    intent: "forward_file", domain: "spending", tool_need: null, missing_fact: null, risk: [], search_terms: "grant",
  }));
  // The WRITER says it looks fine. That is the failure being guarded against.
  net.onModel(/The person forwarded something/, () => ({
    message: "This looks like a good opportunity — you should apply today.",
    artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: null,
  }));
  net.onModel(/You maintain one person's money memory/, () => ({ context_updates: null, map_updates: null, decisions: null, commitments: null, results: null }));

  // Jev: the scam score says advance-fee; every yes/no check says all clear.
  net.jev.handler = (payload) =>
    Object.fromEntries(
      Object.entries(payload.questions).map(([id, q]: [string, any]) => [
        id,
        q.type === "score" ? { type: "score", score: 1.9, confidence: 0.9, legend: {}, probabilities: {} } : { type: "noul", noul: 0.05 },
      ]),
    );

  net.sent.length = 0;
  await engine.handleInbound({
    waMessageId: "wamid.scam.1", from: OWNER, timestamp: Date.now(), kind: "image", text: "is this real?", mediaId: "m", mimeType: "image/jpeg",
  });
  const said = net.sent.map((m) => m.body).join("\n---\n");
  assert.ok(said.includes(j.scamWarning("ZA")), "the pre-written warning is what the owner reads");
  assert.ok(!/good opportunity/i.test(said), "the writer's reassurance never reaches them");
  assert.equal(events("scam_score")[0]!.outcome, "block");
});

test("withScamAdvisor: a warning gets the advisor once; a reassurance is never kept", () => {
  assert.match(j.withScamAdvisor("That's a scam — don't send it.", "ZA")!, /Ask the National Credit Regulator/);
  assert.equal(j.withScamAdvisor("Scam. Ask the National Credit Regulator before you do anything.", "ZA"), "Scam. Ask the National Credit Regulator before you do anything.");
  assert.equal(j.withScamAdvisor("This looks legit, go ahead and apply.", "ZA"), null);
  assert.equal(j.withScamAdvisor("This looks like a good opportunity — but don't send money first.", "ZA"), null);
  assert.equal(j.withScamAdvisor("Open your account at the bank this week.", "ZA"), null);
  assert.match(j.withScamAdvisor("That's a fraud.", "ZA")!, /Ask /);
});
