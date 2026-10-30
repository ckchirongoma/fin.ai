// Charles — the work queue, and the one property that is hard to see by reading.
//
// Two drains run at once in normal operation: the webhook's own invocation and
// the sweep. They claim independently, which is what makes throughput work —
// and which is exactly why two messages from the SAME owner must never be
// handled at the same time. If they are, the second finishes with a `stage`
// computed from state the first has already moved past, and the conversation
// jumps backwards in front of a real person.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.WORKER_SECRET = "fake-worker-secret";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";

import { makeFakeDb, installFakeNet, type FakeDb, type FakeNet } from "./_fakes.ts";

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let dbmod: typeof import("../api/_lib/db.ts");
let queue: typeof import("../api/_lib/queue.ts");

before(async () => {
  net = installFakeNet();
  db = makeFakeDb();
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  queue = await import("../api/_lib/queue.ts");
});

after(() => {
  restore?.();
  net?.restore();
});

beforeEach(() => {
  db.tables.jobs = [];
  net.sent.length = 0;
});

const queueJob = (waId: string, text: string) =>
  dbmod.enqueue({ kind: "inbound", waId, payload: { waMessageId: `m-${Math.random()}`, from: waId, timestamp: Date.now(), kind: "text", text } });

test("a claimed job is locked, so a second worker cannot take the same one", async () => {
  await queueJob("27820000001", "hello");
  const first = await dbmod.claimJob("worker-a");
  const second = await dbmod.claimJob("worker-b");

  assert.ok(first);
  assert.equal(second, null, "one job, one worker");
  assert.equal(first!.status, "running");
  assert.equal(first!.attempts, 1);
});

test("a job abandoned by a killed instance becomes claimable again", async () => {
  await queueJob("27820000002", "hello");
  const job = await dbmod.claimJob("worker-a");
  assert.ok(job);

  // What a function killed at its timeout leaves behind.
  db.tables.jobs!.find((j) => j.id === job!.id)!.locked_at = new Date(Date.now() - 6 * 60_000).toISOString();

  const reclaimed = await dbmod.claimJob("worker-b");
  assert.equal(reclaimed?.id, job!.id, "work must not be lost when an instance dies");
  assert.equal(reclaimed!.attempts, 2);
});

test("two messages from the same owner are never claimed at the same time", async () => {
  await queueJob("27820000003", "first");
  await queueJob("27820000003", "second");

  const a = await dbmod.claimJob("worker-a");
  assert.ok(a);
  assert.equal(await dbmod.otherJobRunningFor("27820000003", a!.id), false, "nothing else is running yet");

  // PRIORITY 0 (db/0013_claim_job_owner_order.sql): before this fix, the
  // second message WAS claimable here — the queue only noticed the owner was
  // busy in a second, separate check (otherJobRunningFor) run AFTER the
  // claim, and held it back with a flat 5s delay. That check-then-hold was
  // itself racy (see the dedicated ordering tests below) and is exactly what
  // let a later message's `run_after` overtake an earlier one's. Now the
  // owner check is inside the one atomic claim itself: a later job for a
  // busy owner is simply never handed out in the first place.
  const b = await dbmod.claimJob("worker-b");
  assert.equal(b, null, "the second message must not be claimable while the first is still pending");

  await dbmod.finishJob(a!.id, "done");
  const c = await dbmod.claimJob("worker-c");
  assert.ok(c, "and becomes claimable the moment the first one is actually done");
});

test("messages from different owners still run in parallel", async () => {
  await queueJob("27820000004", "hello");
  await queueJob("27820000005", "hello");

  const a = await dbmod.claimJob("worker-a");
  const b = await dbmod.claimJob("worker-b");
  assert.ok(a && b);
  assert.equal(await dbmod.otherJobRunningFor(b!.wa_id!, b!.id), false, "independent owners are independent");
});

// ── PRIORITY 0: the root-cause fix (db/0013_claim_job_owner_order.sql) ────
//
// Live, 2026-09-22: four messages from one owner, created 2-3s apart in order
// 59, 60, 61, 62, were CLAIMED (locked_at order) as 59 -> 61 -> 62 -> 60. Job
// 60 (a "Done" tap) lost the claim race every time, and each loss pushed its
// run_after five seconds further out via holdJob — which newer messages for
// the same owner (60 was created SECOND, but its retries kept landing behind
// 61 and 62's untouched, earlier run_after) kept overtaking. The actual bug
// was not in any action handler — it was that claim_job() had no idea what
// "the same owner" even meant, so per-owner ordering was enforced AFTER the
// claim, racily, instead of inside the one atomic statement that decides who
// gets the job.

test("jobs for one owner are claimed strictly in creation order, even under repeated concurrent claim bursts and scrambled completion times", async () => {
  const waId = "27820000010";
  const ids: unknown[] = [];
  for (let i = 0; i < 4; i++) ids.push(await queueJob(waId, `msg-${i}`));

  // Each "how long would this one take" is the OPPOSITE of creation order, so
  // if claim_job ever let a later job be handed out while an earlier one was
  // still pending, the fast one would look done before the slow earlier one
  // ever started — exactly the shape of the live bug (job 60 lost every race
  // to jobs 61 and 62, created after it).
  const fakeDurationMs = [40, 10, 25, 5];
  const claimedOrder: unknown[] = [];

  while (claimedOrder.length < ids.length) {
    // Several claimers race for work at the exact same tick, every round —
    // exactly what the webhook's own inline drain and a /api/worker sweep (or
    // two overlapping webhook invocations) really do.
    const attempts = await Promise.all([dbmod.claimJob("w-a"), dbmod.claimJob("w-b"), dbmod.claimJob("w-c")]);
    const got = attempts.filter((j): j is NonNullable<(typeof attempts)[number]> => j !== null);
    assert.ok(got.length <= 1, "a single simultaneous burst may never claim more than one job for this owner");
    if (!got.length) continue;

    claimedOrder.push(got[0]!.id);
    await new Promise((r) => setTimeout(r, fakeDurationMs[claimedOrder.length - 1] ?? 5));
    await dbmod.finishJob(got[0]!.id, "done");
  }

  assert.deepEqual(claimedOrder, ids, "claimed — and therefore completed — strictly in creation order, however the claim attempts and processing times landed");
});

test("under concurrent claimers, a later job for the same owner is never handed out while an earlier one is still pending", async () => {
  const waId = "27820000011";
  const id1 = await queueJob(waId, "first");
  const id2 = await queueJob(waId, "second");

  // Fired at once, the way two overlapping webhook invocations really do.
  const [a, b, c] = await Promise.all([dbmod.claimJob("w-a"), dbmod.claimJob("w-b"), dbmod.claimJob("w-c")]);
  const claimed = [a, b, c].filter((j): j is NonNullable<typeof j> => j !== null);
  assert.equal(claimed.length, 1, "only the earliest job for this owner may be claimed while it is still pending");
  assert.equal(claimed[0]!.id, id1);

  // The old code's bug lived exactly here: a second, separate query
  // (otherJobRunningFor) run AFTER a claim, racy against another worker's own
  // claim landing at almost the same instant. Finishing the first job here and
  // re-racing proves the second one only ever becomes claimable once the
  // first one is actually done — not "probably done by the time we checked".
  await dbmod.finishJob(id1, "done");
  const [d, e] = await Promise.all([dbmod.claimJob("w-a"), dbmod.claimJob("w-b")]);
  const next = [d, e].filter((j): j is NonNullable<typeof j> => j !== null);
  assert.equal(next.length, 1);
  assert.equal(next[0]!.id, id2, "only once the earlier job finished does the next one for this owner become claimable");
});

test("holding a job does not burn one of its attempts", async () => {
  await queueJob("27820000006", "hello");
  const job = await dbmod.claimJob("worker-a");
  assert.equal(job!.attempts, 1);

  await dbmod.holdJob(job!.id, job!.attempts, "owner busy");
  const row = db.tables.jobs!.find((j) => j.id === job!.id)!;
  assert.equal(row.status, "queued");
  assert.equal(row.attempts, 0, "a chatty owner must not exhaust max_attempts on holds alone");
});

test("a failing job backs off, and gives up rather than looping forever", async () => {
  await queueJob("27820000007", "hello");
  const job = await dbmod.claimJob("worker-a");

  await dbmod.retryJob(job!.id, job!.attempts, "model unavailable");
  const row = db.tables.jobs!.find((j) => j.id === job!.id)!;
  assert.equal(row.status, "queued");
  assert.ok(new Date(row.run_after).getTime() > Date.now(), "the retry is delayed, not immediate");

  await dbmod.finishJob(job!.id, "dead", "gave up");
  assert.equal(db.tables.jobs!.find((j) => j.id === job!.id)!.status, "dead");
});

test("the drain stops when there is nothing to do", async () => {
  const report = await queue.drainQueue({ maxJobs: 5, label: "test" });
  assert.deepEqual(report, { claimed: 0, done: 0, failed: 0 });
});

test("a dead plan_build_stage job apologises and marks the build failed, instead of dying in total silence", async () => {
  // This job kind has no wa_id (it's keyed by business_id, not an inbound
  // message) — apologise() used to check `job.wa_id` unconditionally and
  // return early for every job kind but "inbound", so this one used to fail
  // for good with nobody ever told.
  const biz = await dbmod.createBusiness("27820000099", "ZA");
  await dbmod.resetPlanBuild(biz.id);
  await dbmod.enqueue({ kind: "plan_build_stage", businessId: biz.id, payload: { step: "not-a-real-step" }, maxAttempts: 1 });

  const report = await queue.drainQueue({ maxJobs: 1 });
  assert.equal(report.failed, 1);

  assert.ok(net.sent.some((m) => m.to === biz.wa_id && /Couldn't finish building your plan/.test(m.body)), "the owner heard something, not silence");
  const build = await dbmod.getPlanBuild(biz.id);
  assert.equal(build?.stage, "failed", "so the next message resumes the machinery instead of waiting on a dead job forever");
});
