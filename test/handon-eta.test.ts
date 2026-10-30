// Fin — the queue hands on its leftover work, and waits are stated honestly.
//
// Founder, 2026-09-24: "it takes forever for a report to come". The plan build
// is a chain of six jobs; a drain takes at most four, and on a quiet number the
// rest waited for the next message from anyone. These tests pin the hand-on
// (queue.ts), the worker's async mode, and the estimate owners are given (eta.ts).

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.WORKER_SECRET = "fake-worker-secret";
process.env.PUBLIC_BASE_URL = "https://fin.test";

import { installFakeNet, makeFakeDb, type FakeDb, type FakeNet } from "./_fakes.ts";

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let queue: typeof import("../api/_lib/queue.ts");
let eta: typeof import("../api/_lib/eta.ts");

const job = (id: number, over: Record<string, unknown> = {}) => ({
  id, kind: "no_such_kind", business_id: null, wa_id: null, payload: {}, status: "queued", attempts: 0, max_attempts: 3,
  run_after: new Date(Date.now() - 1000).toISOString(), locked_at: null, locked_by: null, last_error: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over,
});

before(async () => {
  net = installFakeNet();
  db = makeFakeDb({ jobs: [], safety_events: [], plan_builds: [] });
  const dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  queue = await import("../api/_lib/queue.ts");
  eta = await import("../api/_lib/eta.ts");
});

after(() => {
  restore?.();
  net?.restore();
});

beforeEach(() => {
  db.tables.jobs = [];
  db.tables.safety_events = [];
  net.workerCalls.length = 0;
  eta.__resetEtaCache();
});

/** Hand-ons to a normal worker. The watch runner's own wake-up (?watch=1, round 16) is counted separately. */
const handOns = () => net.workerCalls.filter((c) => c.url.includes("async=1"));

test("a drain that did work and leaves work behind wakes a fresh worker, with the secret", async () => {
  db.tables.jobs = [job(1), job(2), job(3)];
  const report = await queue.drainQueue({ maxJobs: 1, label: "webhook" });
  assert.equal(report.claimed, 1);
  assert.equal(handOns().length, 1, "handed on once");
  assert.equal(handOns()[0]!.url, "https://fin.test/api/worker?max=10&async=1&hop=1", "the woken worker knows it is one call deep (chain.ts)");
  assert.equal(handOns()[0]!.auth, "Bearer fake-worker-secret");
});

test("a drain that found nothing to do never wakes anyone (no empty wake-up loops)", async () => {
  await queue.drainQueue({ maxJobs: 4, label: "webhook" });
  assert.equal(handOns().length, 0);
});

test("a drain that finished everything hands on nothing", async () => {
  db.tables.jobs = [job(1, { max_attempts: 1 })]; // fails once, goes dead, nothing left
  await queue.drainQueue({ maxJobs: 4, label: "webhook" });
  assert.equal(db.tables.jobs[0]!.status, "dead");
  assert.equal(handOns().length, 0);
});

test("work waiting on a backoff a few seconds out still counts as left behind", async () => {
  db.tables.jobs = [job(1, { max_attempts: 3 })]; // fails, retried ~10s out
  await queue.drainQueue({ maxJobs: 4, label: "webhook" });
  assert.equal(db.tables.jobs[0]!.status, "queued");
  assert.equal(handOns().length, 1, "a retry due within a minute is handed on, not left for traffic");
});

test("the worker's async mode answers 202 at once", async () => {
  const worker = await import("../api/worker.ts");
  const res = await worker.POST(new Request("https://fin.test/api/worker?max=10&async=1", { method: "POST", headers: { Authorization: "Bearer fake-worker-secret" } }));
  assert.equal(res.status, 202);
  const bad = await worker.POST(new Request("https://fin.test/api/worker?async=1", { method: "POST" }));
  assert.equal(bad.status, 403, "still fails closed without the secret");
});

const timing = (scores: number[], detail = "total; v2") =>
  scores.map((score, i) => ({ id: i + 1, check_name: "plan_build_timing", score, created_at: new Date().toISOString(), detail }));

test("with fewer than eight fair samples the estimate is the median, rounded up to whole minutes", async () => {
  db.tables.safety_events = timing([150, 200, 240, 300, 1500]); // one stalled build must not set the number
  assert.equal(await eta.typicalMinutes("plan_build_timing"), 4); // median 240s
  assert.equal(eta.minutesPhrase(4), "about 4 minutes");
  assert.equal(eta.minutesPhrase(1), "about a minute");
});

test("with eight or more it is the 75th percentile", async () => {
  db.tables.safety_events = timing([60, 90, 120, 150, 180, 210, 240, 600]);
  assert.equal(await eta.typicalMinutes("plan_build_timing"), 4); // p75 = 210s -> 4 minutes
});

test("only fair samples count: old-pipeline, interrupted and retried builds are left out", async () => {
  db.tables.safety_events = [
    ...timing([120, 120, 120, 120], "total; v2"),
    ...timing([1800, 1800, 1800], "total"), // before the hand-on queue
    ...timing([1800], "total; v2; interrupted"),
    ...timing([1800], "total; strategy 95s (1 retry); v2"),
  ];
  assert.equal(await eta.typicalMinutes("plan_build_timing"), null, "four fair samples is not enough to promise a number");
  db.tables.safety_events.push(...timing([120], "total; v2"));
  eta.__resetEtaCache();
  assert.equal(await eta.typicalMinutes("plan_build_timing"), 2);
});

test("with too little history there is no invented number", async () => {
  db.tables.safety_events = timing([90]);
  assert.equal(await eta.typicalMinutes("plan_build_timing"), null);
  assert.equal(eta.minutesPhrase(null), "a few minutes");
});

test("time left counts down honestly, and says so plainly once the usual time has gone", async () => {
  db.tables.safety_events = timing([240, 240, 240, 240, 240]);
  assert.equal(await eta.remainingPhrase("plan_build_timing", new Date(Date.now() - 60_000).toISOString()), "about 3 more minutes");
  assert.equal(await eta.remainingPhrase("plan_build_timing", new Date(Date.now() - 10 * 60_000).toISOString()), "taking longer than usual, but it's still going");
});

// Review, 2026-09-24: the hand-on worker's wait used to quit when any job
// anywhere was "ready", though claim_job refuses a message queued behind the
// same owner's earlier one — so the retry it was woken for was abandoned.
test("a fresh worker waits for a retry even when another owner's job is blocked behind it", async () => {
  const soon = new Date(Date.now() + 1500).toISOString();
  db.tables.jobs = [
    job(1, { kind: "inbound", wa_id: "27800000001", run_after: soon, _seq: 1, attempts: 1, max_attempts: 1 }),
    job(2, { kind: "inbound", wa_id: "27800000001", _seq: 2 }), // blocked behind job 1
  ];
  const started = Date.now();
  const report = await queue.drainQueue({ maxJobs: 1, label: "handon", waitForDueMs: 60_000, noHandOn: true });
  assert.equal(report.claimed, 1, "it waited for the retry and claimed it");
  assert.ok(Date.now() - started >= 1000);
});

test("a drain that has already done work does not sit waiting; it hands on instead", async () => {
  db.tables.jobs = [job(1, { max_attempts: 3 })]; // fails, retried ~10s out
  const started = Date.now();
  await queue.drainQueue({ maxJobs: 4, label: "handon", waitForDueMs: 60_000 });
  assert.ok(Date.now() - started < 5_000, "no mid-drain wait once something ran");
  assert.equal(handOns().length, 1);
});

test("a worker already two calls deep wakes nobody: the tick carries the work on, so the chain's render is never refused (round 23, 508)", async () => {
  const chain = await import("../api/_lib/chain.ts");
  db.tables.jobs = [job(1), job(2), job(3)];
  const report = await chain.withHop(2, () => queue.drainQueue({ maxJobs: 1, label: "handon" }));
  assert.equal(report.claimed, 1);
  assert.equal(handOns().length, 0, "no fourth call down this chain");
  db.tables.jobs = [job(4), job(5)];
  await chain.withHop(1, () => queue.drainQueue({ maxJobs: 1, label: "handon" }));
  assert.equal(handOns().length, 1);
  assert.match(handOns()[0]!.url, /&hop=2$/);
});
