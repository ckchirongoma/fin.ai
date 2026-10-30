// Fin — a job attempt never starts a model call it has no time to finish.
//
// Live test, round 10 (2026-09-26), a Kenyan plan build: the strategy call
// spent 66% of its output on hidden reasoning and came back without its
// "reading", so the stage retried — and the retry pushed the invocation past
// Vercel's 300-second limit. The platform killed the function mid-call. No
// code ran after that, so nothing recorded a failure: the job sat "running",
// last_error null, for 26 minutes, until the owner happened to write again.
//
// The fix: every job attempt carries a deadline inside the 300s kill
// (queue.ts hardStopAt → jobctx.ts deadlineAt), model calls refuse to start
// without enough of it left (models.ts callWindow), and the strategy stage
// hands itself to a fresh worker instead of retrying on borrowed time. These
// tests fail without that fix.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
delete process.env.TYPESAFE_API_KEY;

import { installFakeNet, makeFakeDb, type FakeDb, type FakeNet } from "./_fakes.ts";

const MODEL_ROLES = ["plan_builder", "safety"].map((role) => ({
  role, provider: "openrouter", model: `test/${role}`, fallbacks: [], params: {}, enabled: true,
}));

let db: FakeDb;
let net: FakeNet;
let dbmod: typeof import("../api/_lib/db.ts");
let pb: typeof import("../api/_lib/engine/planbuild.ts");
let queue: typeof import("../api/_lib/queue.ts");
let models: typeof import("../api/_lib/models.ts");
let jobctx: typeof import("../api/_lib/jobctx.ts");
let restore: () => void;

/** What the strategy call returns; a test swaps it for one without a reading. */
let strategyReply: () => Record<string, unknown>;
const goodStrategy = () => ({
  reading: ["A test business with a real gap."],
  working: ["Regulars come back"],
  leaking: ["No-shows"],
  how_we_win: "Charge for the certainty they already want.",
  wont_do: ["Nothing paid this quarter"],
  money_logic: "One saved slot a month pays for this.",
  milestones: { d30: "Asked once", d60: "Deposits standard", d90: "No-shows rare" },
  risks: [{ risk: "Waiving it once", response: "One line, identical for everyone." }],
});

before(async () => {
  net = installFakeNet();
  net.onModel(/AREA RUBRIC/, () => ({
    context: { name: "Test Biz", earns: "a wage", location: "Nairobi", one_liner: "things, in Nairobi" },
    goal: "Take deposits on every booking.",
    map: ["income", "spending", "debt", "cushion", "credit_record", "protection", "family_money", "goals"].map((domain) => ({ domain, status: "red", note: "x" })),
  }));
  net.onModel(/You are scoring one household's money life against a fixed rubric/, () => ({
    income: "red", spending: "red", debt: "amber", cushion: "amber",
    credit_record: "red", protection: "red", family_money: "red", goals: "red",
  }));
  net.onModel(/You are writing the STRATEGY part of a money plan/, () => strategyReply());
  net.onModel(/You are a strict checker/, (prompt) => {
    const ids = [...prompt.matchAll(/- "([a-z_]+)":/g)].map((m) => m[1]!);
    return Object.fromEntries(ids.map((id) => [id, false]));
  });
  db = makeFakeDb({ model_config: MODEL_ROLES, knowledge_entries: [], tools: [] });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  models = await import("../api/_lib/models.ts");
  models.__clearModelCache();
  pb = await import("../api/_lib/engine/planbuild.ts");
  queue = await import("../api/_lib/queue.ts");
  jobctx = await import("../api/_lib/jobctx.ts");
});

after(() => {
  restore?.();
  net?.restore();
});

beforeEach(() => {
  for (const t of ["jobs", "businesses", "plan_builds", "plans", "plan_steps", "business_map", "messages", "commitments", "safety_events"]) db.tables[t] = [];
  net.sent.length = 0;
  net.modelCalls.length = 0;
  strategyReply = goodStrategy;
});

// One try writes the strategy as two halves at once (round 26): the first half counts the try.
const strategyCalls = () => net.modelCalls.filter((c) => /You are writing the STRATEGY part/.test(c.prompt) && !/HALF OF THE STRATEGY: only "wont_do"/.test(c.prompt)).length;

/** A business whose build has done its context stage and owes strategy + workstreams. */
async function builtToStrategy(waId: string, signals: Record<string, unknown> = { owes_any: true, top_problem: "m_owed" }) {
  const biz = await dbmod.createBusiness(waId, "KE");
  await dbmod.updateBusiness(biz.id, {
    stage: "building_plan",
    biz_stage: "stretching",
    answers: { objective: "grow", blockers: "cash is tight", income: "R5,000" },
    signals,
    identity: { name: "Test Biz", earns: "a wage", one_liner: "things, in Nairobi", unsure: null },
    goal: [{ label: "Out of debt", what: "Clear the account", why_you: "it costs the most", worth: "No figure given", first_move: "list it", catch: "none" }],
    rule: [{ label: "Payday first", rule: "Payday first.", why_it_works: "What is paid first gets paid.", what_it_costs_you: null }],
  } as never);
  await pb.startPlanBuild((await dbmod.findBusinessById(biz.id))!);
  await queue.drainQueue({ maxJobs: 1, noHandOn: true }); // the context stage
  const build = await dbmod.getPlanBuild(biz.id);
  assert.equal(build?.stage, "building");
  return (await dbmod.findBusinessById(biz.id))!;
}

// ── The call window ──────────────────────────────────────────────

test("outside a job, a model call keeps its ordinary timeout", () => {
  assert.equal(models.callWindow("x"), undefined);
});

test("inside a job, a call's timeout is cut to what the attempt has left", async () => {
  await jobctx.jobCtx.run({ id: 1, worker: "w", deadlineAt: Date.now() + 60_000 }, async () => {
    const w = models.callWindow("x")!;
    assert.ok(w <= 55_000 && w > 50_000, `window ${w}ms`);
  });
  await jobctx.jobCtx.run({ id: 1, worker: "w", deadlineAt: Date.now() + 250_000 }, async () => {
    assert.equal(models.callWindow("x"), 90_000, "never longer than the ordinary 90s");
  });
});

test("inside a job with too little time left, askJSON refuses to start a call at all", async () => {
  net.modelCalls.length = 0;
  await jobctx.jobCtx.run({ id: 1, worker: "w", deadlineAt: Date.now() + models.MIN_CALL_MS - 1_000 }, async () => {
    await assert.rejects(models.askJSON("plan_builder", "anything", { label: "t" }), jobctx.DeadlineError);
  });
  assert.equal(net.modelCalls.length, 0, "no request was sent");
});

// ── The round-10 incident ────────────────────────────────────────

test("strategy fails its first try with too little time for a second: it hands the stage on instead of retrying into the kill", async () => {
  const biz = await builtToStrategy("254700000901");
  // The live failure: a strategy that came back without its reading.
  strategyReply = () => ({ ...goodStrategy(), reading: [] });

  // Time for one build call (BUILD_CALL_MIN_MS, 90s), not for two.
  await jobctx.jobCtx.run({ id: 1, worker: "w", deadlineAt: Date.now() + 99_000, lastAttempt: false }, async () => {
    await assert.rejects(pb.runStrategyStage(biz), jobctx.DeadlineError);
  });

  assert.equal(strategyCalls(), 1, "no second strategy call was started on borrowed time");
  const build = await dbmod.getPlanBuild(biz.id);
  assert.equal(build?.strategy_done, false, "the stage is still owed — not saved with its strategy missing");
  assert.equal(db.tables.safety_events!.filter((e) => e.check_name === "plan_strategy").length, 0, "no 'strategy missing' flag for a plan that will still get one");
});

test("on the job's last attempt the old behaviour stands: the plan goes ahead with the gap recorded", async () => {
  const biz = await builtToStrategy("254700000902");
  strategyReply = () => ({ ...goodStrategy(), reading: [] });

  await jobctx.jobCtx.run({ id: 1, worker: "w", deadlineAt: Date.now() + 60_000, lastAttempt: true }, async () => {
    await pb.runStrategyStage(biz);
  });

  const build = await dbmod.getPlanBuild(biz.id);
  assert.equal(build?.strategy_done, true);
  assert.equal(db.tables.safety_events!.filter((e) => e.check_name === "plan_strategy").length, 1, "the missing strategy is flagged");
});

test("with time to spare, a failed first strategy try is retried as before", async () => {
  const biz = await builtToStrategy("254700000903");
  let n = 0;
  strategyReply = () => (++n === 1 ? { ...goodStrategy(), reading: [] } : goodStrategy());

  await jobctx.jobCtx.run({ id: 1, worker: "w", deadlineAt: Date.now() + 250_000, lastAttempt: false }, async () => {
    await pb.runStrategyStage(biz);
  });
  assert.equal(strategyCalls(), 2);
  const build = await dbmod.getPlanBuild(biz.id);
  assert.equal(build?.strategy_done, true);
  assert.ok(build?.strategy, "the second try's strategy was saved");
});

test("through the queue: a job out of time is put back with a real error, never left 'running' with last_error null", async () => {
  const biz = await builtToStrategy("254700000904");
  net.modelCalls.length = 0;

  // A drain whose hard stop has already passed — the position the killed
  // retry was in. Every model call in it must refuse to start.
  const report = await queue.drainQueue({ maxJobs: 1, hardStopMs: 1, noHandOn: true });
  assert.equal(report.failed, 1);

  const job = db.tables.jobs!.find((j) => j.business_id === biz.id && j.kind === "plan_build_stage" && j.payload.step !== "context" && j.attempts === 1)!;
  assert.equal(job.status, "queued", "back in the queue for a fresh worker");
  assert.match(String(job.last_error), /out of time/, "and the reason is written down");
  assert.equal(net.modelCalls.length, 0, "no model request was started without time to finish it");
});

// ── Round 11: finished parts are kept when another part runs out of time ──

test("workstreams: a part that runs out of time fails the stage only after the finished parts are saved", async () => {
  const biz = await builtToStrategy("254700000905", { owes_any: true, owes_two_plus: true, records_weak: true, month_short: true, top_problem: "m_owed" });
  const pending = (await dbmod.getPlanBuild(biz.id))!.pending_workstreams;
  assert.ok(pending.length >= 2, `needs two parts to prove anything (got ${pending.length})`);

  const ctx: import("../api/_lib/jobctx.ts").JobCtx = { id: 1, worker: "w", deadlineAt: Date.now() + 250_000, lastAttempt: false };
  let first = true;
  net.onModel(/You are writing the person-facing wording for ONE part/, async (prompt) => {
    const ids = [...prompt.matchAll(/id=([a-z0-9_]+)/g)].map((m) => m[1]);
    if (first) {
      first = false;
      return { why_for_you: "Fits.", steps: ids.map((id) => ({ id, why_for_you: "Because.", push: `Do ${id}.`, artifact: null, tool_id: null })) };
    }
    // The other parts: wait until the first is saved, then run the clock out
    // and hand back something unusable, so the next try must refuse to start.
    for (let i = 0; i < 200 && (await dbmod.getPlanBuild(biz.id))!.pending_workstreams.length === pending.length; i++) await new Promise((r) => setTimeout(r, 5));
    ctx.deadlineAt = Date.now();
    return "not json";
  });

  await jobctx.jobCtx.run(ctx, async () => {
    await assert.rejects(pb.runWorkstreamsStage(biz), jobctx.DeadlineError);
  });

  const build = (await dbmod.getPlanBuild(biz.id))!;
  assert.equal(build.workstreams.length, 1, "the part that finished was saved");
  assert.equal(build.pending_workstreams.length, pending.length - 1, "only the unfinished parts are left for the retry");
  assert.equal(build.stage, "building");
});
