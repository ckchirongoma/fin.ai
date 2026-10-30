// Fin — one question, one answer, however slow the model is.
//
// Live, round 6 (2026-09-24): one "How am I doing?" was answered TWICE, ~5
// minutes apart, in different words. The first attempt's model call ran
// ~127s; its lock was never refreshed, so after claim_job's 5-minute
// abandoned-job window a sweep reclaimed the job and ran it again — while the
// first attempt was still alive, and it replied too. jobs.attempts was 2,
// finished by "sweep-iad1-4". See api/_lib/jobctx.ts.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
process.env.WORKER_SECRET = "fake-worker-secret";
process.env.TYPESAFE_API_KEY = "fake-jev-key";

import { installFakeNet, makeFakeDb, textFrom, type FakeDb, type FakeNet } from "./_fakes.ts";

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let dbmod: typeof import("../api/_lib/db.ts");
let queue: typeof import("../api/_lib/queue.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The answer model: the first call can be held open (the slow attempt), later ones answer at once.
let answerCalls = 0;
let releaseFirst: (() => void) | null = null;
let firstStarted: (() => void) | null = null;
let holdFirst = false;

before(async () => {
  net = installFakeNet();
  const roles = ["router", "wa_reply", "help", "plan_builder", "safety"].map((role) => ({ role, provider: "openrouter", model: "t/m", fallbacks: [], params: {}, enabled: true }));
  db = makeFakeDb({ model_config: roles });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  queue = await import("../api/_lib/queue.ts");
  net.onModel(/Classify this message from a person to their money assistant/, () => ({ intent: "question", domain: "spending", tool_need: null, missing_fact: null, risk: [], search_terms: "" }));
  net.onModel(/ROUTER RESULT/, async () => {
    const n = ++answerCalls;
    if (n === 1 && holdFirst) {
      firstStarted?.();
      await new Promise<void>((r) => (releaseFirst = r));
      return { message: "SLOW ATTEMPT's answer", artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: null };
    }
    return { message: `Answer number ${n}`, artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: null };
  });
  net.onModel(/You maintain one person's money memory/, () => ({ context_updates: null, map_updates: null, decisions: null, commitments: null, results: null }));
});
after(() => {
  restore?.();
  net?.restore();
});
beforeEach(() => {
  net.sent.length = 0;
  answerCalls = 0;
  holdFirst = false;
  net.jev.handler = (payload) => Object.fromEntries(Object.keys(payload.questions).map((id) => [id, { type: "noul", noul: 0.05 }]));
});

async function planReady(wa: string) {
  const biz = await dbmod.createBusiness(wa, "ZA");
  db.tables.plans!.push({ id: `plan-${wa}`, business_id: biz.id, goal: "g", headline: "", strategy: null, created_at: new Date().toISOString() });
  db.tables.plan_steps!.push({ id: `s-${wa}`, plan_id: `plan-${wa}`, workstream_title: "Get paid", domain: "spending", step_order: 1, step_key: null, title: "Take payment without cash", push: "Do it.", artifact: null, why_for_you: "", done_when: "done", status: "open", pushed_at: null, done_at: null, skipped_reason: null, tool_id: null });
  await dbmod.updateBusiness(biz.id, { stage: "plan_ready", current_plan_id: `plan-${wa}`, context: { name: "Lindi's Braids" }, last_inbound_at: new Date().toISOString() } as never);
  return biz;
}
const answersTo = (wa: string) => net.sent.filter((m) => m.to === wa && /answer/i.test(m.body)).map((m) => m.body);

test("a slow attempt that outlives the abandoned-job window is fenced off: the owner gets exactly one answer", async () => {
  const wa = "27836660001";
  await planReady(wa);
  const msg = textFrom(wa, "How am I doing?");
  const jobId = await dbmod.enqueue({ kind: "inbound", waId: wa, payload: msg as never });
  holdFirst = true;
  const started = new Promise<void>((r) => (firstStarted = r));

  // Attempt 1 (the webhook's own drain) claims the job and stalls in the model call.
  const undo = queue.__setHeartbeatMs(3_600_000); // no heartbeat: the live incident, where the lock aged
  const attempt1 = queue.drainQueue({ label: "webhook", maxJobs: 1 });
  await started;

  // Five minutes pass with the lock never refreshed: the sweep sees an abandoned job.
  const row = db.tables.jobs!.find((j) => String(j.id) === String(jobId))!;
  row.locked_at = new Date(Date.now() - 6 * 60_000).toISOString();
  const attempt2 = await queue.drainQueue({ label: "sweep", maxJobs: 1 });
  assert.equal(attempt2.done, 1, "the sweep re-ran it and answered");

  // The slow attempt finally gets its model answer — and must not send it.
  releaseFirst!();
  const report1 = await attempt1;
  undo();

  assert.equal(report1.fenced, 1, "the stale attempt stopped at the send");
  assert.deepEqual(answersTo(wa), ["Answer number 2"], "exactly one answer reached the owner");
  assert.equal(row.status, "done");
  assert.match(String(row.locked_by), /^sweep-/, "the job belongs to the attempt that answered");
  const ins = db.tables.messages!.filter((m) => m.wa_message_id === msg.waMessageId && m.direction === "in");
  assert.equal(ins.length, 1, "the owner's message is in the conversation once, not once per attempt");
});

test("a live job keeps its lock fresh (heartbeat), so a slow answer is never reclaimed at all", async () => {
  const wa = "27836660002";
  await planReady(wa);
  const jobId = await dbmod.enqueue({ kind: "inbound", waId: wa, payload: textFrom(wa, "How am I doing?") as never });
  holdFirst = true;
  const started = new Promise<void>((r) => (firstStarted = r));
  const undo = queue.__setHeartbeatMs(20);
  const attempt = queue.drainQueue({ label: "webhook", maxJobs: 1 });
  await started;
  const row = db.tables.jobs!.find((j) => String(j.id) === String(jobId))!;
  row.locked_at = new Date(Date.now() - 6 * 60_000).toISOString(); // it LOOKS abandoned for a moment…
  await sleep(80); // …until the heartbeat refreshes it
  assert.ok(Date.now() - new Date(row.locked_at as string).getTime() < 60_000, "heartbeat refreshed the lock");
  const sweep = await queue.drainQueue({ label: "sweep", maxJobs: 1 });
  assert.equal(sweep.claimed, 0, "the sweep leaves a live job alone");
  releaseFirst!();
  await attempt;
  undo();
  assert.deepEqual(answersTo(wa), ["SLOW ATTEMPT's answer"], "one answer, from the only attempt");
});

test("worker ids are unique per drain, so two drains in one process never share a fencing token", async () => {
  const wa = "27836660003";
  await planReady(wa);
  await dbmod.enqueue({ kind: "inbound", waId: wa, payload: textFrom(wa, "How am I doing?") as never });
  await dbmod.enqueue({ kind: "inbound", waId: "27836660004", payload: textFrom("27836660004", "hi") as never });
  await queue.drainQueue({ label: "webhook", maxJobs: 1 });
  await queue.drainQueue({ label: "webhook", maxJobs: 1 });
  const lockers = db.tables.jobs!.filter((j) => [wa, "27836660004"].includes(String(j.wa_id))).map((j) => j.locked_by);
  assert.equal(new Set(lockers).size, 2);
});

// Review of round 6: the fence stopped the SEND, but catch-all handlers
// treated it as an ordinary failure and wrote fallback state first.
test("a fenced attempt writes no fallback state over the live one (applyChange)", async () => {
  const { jobCtx, JobFencedError } = await import("../api/_lib/jobctx.ts");
  const steps = await import("../api/_lib/engine/steps.ts");
  const wa = "27836660010";
  const biz = await planReady(wa);
  await dbmod.updateBusiness(biz.id, { stage: "walking", pending_action: { kind: "walk" } } as never);
  const jobId = await dbmod.enqueue({ kind: "inbound", waId: wa, payload: {} });
  const row = db.tables.jobs!.find((j) => String(j.id) === String(jobId))!;
  Object.assign(row, { status: "running", locked_by: "sweep-new", locked_at: new Date().toISOString() });
  await assert.rejects(
    jobCtx.run({ id: jobId, worker: "webhook-old" }, async () => steps.applyChange((await dbmod.findBusiness(wa))!, "this doesn't fit")),
    (e: unknown) => e instanceof JobFencedError,
  );
  const after = (await dbmod.findBusiness(wa))!;
  assert.equal(after.stage, "walking", "the live attempt's state is untouched");
  assert.deepEqual(after.pending_action, { kind: "walk" });
});

test("a stale attempt that fails some other way does not apologise or retry a job it no longer owns", async () => {
  const wa = "27836660011";
  await planReady(wa);
  const jobId = await dbmod.enqueue({ kind: "inbound", waId: wa, payload: textFrom(wa, "How am I doing?") as never, maxAttempts: 1 });
  holdFirst = true;
  const started = new Promise<void>((r) => (firstStarted = r));
  const undo = queue.__setHeartbeatMs(3_600_000);
  const attempt = queue.drainQueue({ label: "webhook", maxJobs: 1 });
  await started;
  const row = db.tables.jobs!.find((j) => String(j.id) === String(jobId))!;
  Object.assign(row, { locked_by: "sweep-new" }); // reclaimed while it waits
  // The slow attempt's model call now FAILS (not a fence) — on its last attempt.
  const origRelease = releaseFirst!;
  net.sent.length = 0;
  origRelease();
  const report = await attempt;
  undo();
  assert.equal(report.failed, 0);
  assert.ok(!net.sent.some((m) => m.to === wa && /went wrong/.test(m.body)), "no apology from the stale attempt");
  assert.notEqual(row.status, "dead", "the stale attempt did not kill the job");
});
