// Fin — the plan build is a resumable state machine, not one job.
//
// The incident this exists to prevent: the old build ran five or six model
// calls back to back inside a single job. A crash or a slow call anywhere
// meant redoing the whole thing — several expensive calls repeated to
// produce a plan that, in the worst report, took roughly seven minutes and
// three hours of real-world delay to finally land. These tests drive the
// state machine directly (engine/planbuild.ts + the plan_builds helpers in
// db.ts) and prove the specific guarantee the rearchitecture exists for:
// work already paid for is never redone.

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
delete process.env.TYPESAFE_API_KEY; // auditModules short-circuits to [] with no Jev key — see judgement.ts

import { installFakeNet, makeFakeDb, type FakeDb, type FakeNet } from "./_fakes.ts";

const MODEL_ROLES = ["plan_builder", "safety"].map((role) => ({
  role, provider: "openrouter", model: `test/${role}`, fallbacks: [], params: {}, enabled: true,
}));

let db: FakeDb;
let net: FakeNet;
let dbmod: typeof import("../api/_lib/db.ts");
let pb: typeof import("../api/_lib/engine/planbuild.ts");
let queue: typeof import("../api/_lib/queue.ts");
let restore: () => void;

function scriptModels(n: FakeNet): void {
  n.onModel(/AREA RUBRIC/, () => ({
    context: { name: "Test Biz", earns: "a wage", location: "Nowhere", one_liner: "things, in Nowhere" },
    goal: "Take deposits on every booking.",
    map: [
      { domain: "income", status: "red", note: "x" },
      { domain: "spending", status: "red", note: "x" },
      { domain: "debt", status: "amber", note: "x" },
      { domain: "cushion", status: "amber", note: "x" },
      { domain: "credit_record", status: "red", note: "x" },
      { domain: "protection", status: "red", note: "x" },
      { domain: "family_money", status: "red", note: "x" },
      { domain: "goals", status: "red", note: "x" },
    ],
  }));
  n.onModel(/You are scoring one household's money life against a fixed rubric/, () => ({
    income: "red", spending: "red", debt: "amber", cushion: "amber",
    credit_record: "red", protection: "red", family_money: "red", goals: "red",
  }));
  n.onModel(/You are writing the STRATEGY part of a money plan/, () => ({
    reading: ["A test business with a real gap.", "The gap is worth closing."],
    working: ["Regulars come back"],
    leaking: ["No-shows"],
    how_we_win: "Charge for the certainty they already want.",
    wont_do: ["Nothing paid this quarter"],
    money_logic: "One saved slot a month pays for this, and it costs nothing to start.",
    milestones: { d30: "Asked once", d60: "Deposits standard", d90: "No-shows rare" },
    risks: [{ risk: "Waiving it once", response: "One line, identical for everyone." }],
  }));
  n.onModel(/You are writing the person-facing wording for ONE part/, (prompt) => {
    const ids = [...prompt.matchAll(/id=([a-z0-9_]+)/g)].map((m) => m[1]);
    return {
      why_for_you: "This fits your Saturdays.",
      steps: ids.map((id) => ({ id, why_for_you: "Because of what you told me.", push: `Do it for ${id}.`, artifact: `Words for ${id}.`, tool_id: null })),
    };
  });
  n.onModel(/You are a strict checker/, (prompt) => {
    const ids = [...prompt.matchAll(/- "([a-z_]+)":/g)].map((m) => m[1]!);
    return Object.fromEntries(ids.map((id) => [id, false]));
  });
}

before(async () => {
  net = installFakeNet();
  scriptModels(net);
  db = makeFakeDb({ model_config: MODEL_ROLES, knowledge_entries: [], tools: [] });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  pb = await import("../api/_lib/engine/planbuild.ts");
  queue = await import("../api/_lib/queue.ts");
});

after(() => {
  restore?.();
  net?.restore();
});

beforeEach(() => {
  // Tests share one fake db/net for speed; drainQueue claims across ALL
  // businesses (correctly — that's how the real worker behaves), so a job
  // left behind by a previous test would otherwise get claimed instead of
  // the one this test actually means to drive.
  for (const t of ["jobs", "businesses", "plan_builds", "plans", "plan_steps", "business_map", "messages", "commitments", "safety_events"]) {
    db.tables[t] = [];
  }
  net.sent.length = 0;
  net.modelCalls.length = 0;
});

async function freshBusiness(waId: string) {
  const biz = await dbmod.createBusiness(waId, "ZA");
  await dbmod.updateBusiness(biz.id, {
    stage: "building_plan",
    biz_stage: "stretching",
    answers: { objective: "grow", blockers: "cash is tight", income: "R5,000" },
    signals: { owes_any: true, top_problem: "m_owed" },
    identity: { name: "Test Biz", earns: "a wage", one_liner: "things, in Nowhere", unsure: null },
    goal: [{ label: "Out of debt", what: "Clear the account", why_you: "it costs the most", worth: "No figure given", first_move: "list it", catch: "none" }],
    rule: [{ label: "Payday first", rule: "Payday first.", why_it_works: "What is paid first gets paid.", what_it_costs_you: null }],
  } as never);
  return (await dbmod.findBusinessById(biz.id))!;
}

// `label` is a client-side-only diagnostic string (see models.ts) — never
// part of the actual request body — so counting calls to one stage means
// matching the prompt text itself, the same way scriptModels() routes them.
const contextCalls = () => net.modelCalls.filter((c) => /AREA RUBRIC/.test(c.prompt)).length;

describe("the plan build resumes instead of redoing finished work", () => {
  test("context advances the row to \"building\" and fans out one job each for strategy and the workstreams", async () => {
    const biz = await freshBusiness("27000000001");
    await pb.startPlanBuild(biz);

    let build = await dbmod.getPlanBuild(biz.id);
    assert.equal(build?.stage, "context");

    await queue.drainQueue({ maxJobs: 1 }); // runs exactly the context stage
    build = await dbmod.getPlanBuild(biz.id);
    assert.equal(build?.stage, "building");
    assert.equal(build?.strategy_done, false);
    assert.ok(build!.pending_workstreams.length >= 1);

    const queued = db.tables.jobs!.filter((j) => j.business_id === biz.id && j.kind === "plan_build_stage" && j.status === "queued");
    assert.deepEqual(
      queued.map((j) => j.payload.step).sort(),
      ["strategy", "workstreams"],
    );
  });

  test("a duplicate context job, run after the row has already finished, is a no-op", async () => {
    const biz = await freshBusiness("27000000002");
    await pb.startPlanBuild(biz);
    await queue.drainQueue({ maxJobs: 10 }); // the whole chain, end to end

    const before = await dbmod.getPlanBuild(biz.id);
    assert.equal(before?.stage, "done");
    const callsBefore = contextCalls();

    // Simulate Meta-style redelivery, or a duplicate reclaim: the SAME stage
    // re-enqueued long after the row has already finished. It has to be the
    // ONLY queued job for this to actually test what it claims — enqueuing it
    // any earlier just has drainQueue claim the naturally-next stage instead
    // (FIFO by id), never this one.
    await dbmod.enqueue({ kind: "plan_build_stage", businessId: biz.id, payload: { step: "context" } });
    await queue.drainQueue({ maxJobs: 1 });

    assert.equal(contextCalls(), callsBefore, "context was not re-run");
    const after = await dbmod.getPlanBuild(biz.id);
    assert.equal(after?.stage, before?.stage);
  });

  test("enqueuePlanBuildStage never piles up a duplicate of a step already queued", async () => {
    const biz = await freshBusiness("27000000003");
    await dbmod.resetPlanBuild(biz.id);
    await dbmod.enqueuePlanBuildStage(biz.id, "context");
    await dbmod.enqueuePlanBuildStage(biz.id, "context");
    await dbmod.enqueuePlanBuildStage(biz.id, "context");

    const rows = db.tables.jobs!.filter((j) => j.business_id === biz.id && j.kind === "plan_build_stage");
    assert.equal(rows.length, 1);
  });

  test("tryAdvanceToFinalize lets exactly one of two racing callers win", async () => {
    const biz = await freshBusiness("27000000004");
    await dbmod.resetPlanBuild(biz.id);
    // Fake the row into "everything just finished" without actually running
    // the stages — this test is about the race, not the content.
    await db.client.from("plan_builds").update({ stage: "building", strategy_done: true, pending_workstreams: [] }).eq("business_id", biz.id);

    const [a, b] = await Promise.all([dbmod.tryAdvanceToFinalize(biz.id), dbmod.tryAdvanceToFinalize(biz.id)]);
    assert.equal([a, b].filter(Boolean).length, 1, "exactly one caller gets to enqueue the finalize job");

    const build = await dbmod.getPlanBuild(biz.id);
    assert.equal(build?.stage, "finalize");
  });

  test("a build that dies after the workstreams finish but before strategy does resumes from \"building\", not from \"context\"", async () => {
    const biz = await freshBusiness("27000000005");
    await pb.startPlanBuild(biz);
    await queue.drainQueue({ maxJobs: 1 }); // context

    const contextCallsAfterFirstRun = contextCalls();
    assert.equal(contextCallsAfterFirstRun, 1);

    // Run the workstreams job specifically, leaving strategy still queued —
    // simulating the strategy job's own worker having died before claiming it.
    const wsJob = db.tables.jobs!.find((j) => j.business_id === biz.id && j.payload.step === "workstreams" && j.status === "queued");
    assert.ok(wsJob, "the workstreams job exists, queued");
    // Drive it directly rather than through drainQueue, so this test does not
    // depend on which of strategy/workstreams the queue happens to claim first.
    await pb.runWorkstreamsStage(biz);

    let build = await dbmod.getPlanBuild(biz.id);
    assert.equal(build?.pending_workstreams.length, 0, "the workstreams finished");
    assert.equal(build?.strategy_done, false, "strategy has not run yet");
    assert.equal(build?.stage, "building", "not advanced — strategy is still owed");

    // Now the strategy stage runs — as if a reclaim or a retry finally picked
    // it up. Context must not have been touched again.
    await pb.runStrategyStage(biz);
    assert.equal(contextCalls(), contextCallsAfterFirstRun, "context was never redone");

    build = await dbmod.getPlanBuild(biz.id);
    assert.equal(build?.stage, "finalize", "the last finisher advanced the row");
  });

  test("reclaimStalePlanBuilds re-enqueues a build whose heartbeat went quiet, and leaves a healthy one alone", async () => {
    const healthy = await freshBusiness("27000000006");
    await dbmod.resetPlanBuild(healthy.id); // heartbeat = now

    const stale = await freshBusiness("27000000007");
    await dbmod.resetPlanBuild(stale.id);
    await db.client.from("plan_builds").update({ heartbeat_at: new Date(Date.now() - 5 * 60_000).toISOString() }).eq("business_id", stale.id);
    // The job that was supposedly running died with nothing left behind —
    // exactly what an abandoned stage looks like.
    db.tables.jobs = db.tables.jobs!.filter((j) => j.business_id !== stale.id);

    const n = await dbmod.reclaimStalePlanBuilds();
    assert.ok(n >= 1);

    const healthyJobs = db.tables.jobs!.filter((j) => j.business_id === healthy.id);
    assert.equal(healthyJobs.length, 0, "a build with a fresh heartbeat is not touched");

    const staleJobs = db.tables.jobs!.filter((j) => j.business_id === stale.id && j.status === "queued");
    assert.ok(staleJobs.some((j) => j.payload.step === "context"), "the stalled context stage was re-enqueued");
  });

  test("finalize is idempotent: running it twice never writes a second plan", async () => {
    const biz = await freshBusiness("27000000008");
    await pb.startPlanBuild(biz);
    await queue.drainQueue({ maxJobs: 10 }); // the whole chain, end to end

    const build = await dbmod.getPlanBuild(biz.id);
    assert.equal(build?.stage, "done");
    const plansForBiz = db.tables.plans!.filter((p) => p.business_id === biz.id);
    assert.equal(plansForBiz.length, 1);

    // A duplicate/late finalize job landing after the build is already done.
    await dbmod.enqueue({ kind: "plan_build_stage", businessId: biz.id, payload: { step: "finalize" } });
    await queue.drainQueue({ maxJobs: 1 });

    assert.equal(db.tables.plans!.filter((p) => p.business_id === biz.id).length, 1, "still exactly one plan");
  });

  test("a full build, driven only through drainQueue the way a real webhook/worker would, reaches plan_ready", async () => {
    const biz = await freshBusiness("27000000009");
    await pb.startPlanBuild(biz);
    await queue.drainQueue({ maxJobs: 10 });

    const finished = await dbmod.findBusinessById(biz.id);
    assert.equal(finished?.stage, "plan_ready");
    const steps = db.tables.plan_steps!.filter((s) => s.plan_id === finished?.current_plan_id);
    assert.ok(steps.length >= 1);
    const build = await dbmod.getPlanBuild(biz.id);
    assert.equal(build?.stage, "done");
  });
});
