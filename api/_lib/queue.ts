// Charles — draining the work queue.
//
// The webhook makes the inbound message durable and answers Meta in
// milliseconds. This is what then does the actual work, and it can be driven
// from three places, all safe to run at once:
//   1. the webhook invocation itself, right after it responds (the fast path)
//   2. /api/worker, called by a schedule or by hand (the catch-up sweep)
//   3. the next inbound message from anyone, which opportunistically drains
//      whatever was left behind
//
// That third one matters more than it looks: it means a job orphaned by a
// killed instance is picked up by ordinary traffic, with no cron at all. On
// Vercel's Hobby plan, where scheduled jobs cannot run more than once a day,
// it is the difference between self-healing and stuck.

import { claimJob, db, claimJobById, ensureWatchdog, failPlanBuild, nextWatchdog, requeueOverrun, requeueStaleRunning, finishJob, holdJob, reclaimStalePlanBuilds, retryJob, findBusiness, findBusinessById, otherJobRunningFor, queuedWorkDue, stillOwnJob, touchJob, updateBusiness, wakeHeldRepair, workInFlight } from "./db.js";
import { env } from "./env.js";
import { jobCtx, JobFencedError, JobHoldError } from "./jobctx.js";
import { randomUUID } from "node:crypto";
import { runGoalOptionsJob } from "./engine/build.js";
import { handleInbound } from "./engine/index.js";
import { autoRetryFailedBuilds, handOverOverdueBuilds, runPlanBuildStage } from "./engine/planbuild.js";
import { sendButtons, sendText } from "./wa.js";
import type { InboundMessage, JobRow } from "./types.js";
import { flushTracking, since, track, trackFailure, withTrackContext } from "./track.js";
import { currentHop, mayWakeWorker, nextHop } from "./chain.js";
import { runAlerts } from "./alerts.js";
import { typicalMinutes } from "./eta.js";

export interface DrainOptions {
  maxJobs?: number;
  /** Stop claiming new work once this much time has gone. */
  budgetMs?: number;
  /**
   * From the drain's start, when job attempts must be finished (default
   * budgetMs + 30s: 270s for the usual 240s budget, inside the 300s kill).
   */
  hardStopMs?: number;
  label?: string;
  /**
   * When nothing can run right now but a queued job becomes runnable within
   * this long (a retry's backoff, a short hold), wait for it inside this
   * invocation instead of ending. Only the worker sets it: the webhook hands
   * on instead (see handOn), so it never sits idle on Meta's connection.
   */
  waitForDueMs?: number;
  /** Don't wake a fresh worker when work is left. Tests of a single drain use it. */
  noHandOn?: boolean;
}

export interface DrainReport {
  claimed: number;
  done: number;
  failed: number;
  /** Put back because the same owner was already being handled elsewhere. */
  held?: number;
  /** Stopped because another worker had reclaimed the job (see jobctx.ts). */
  fenced?: number;
}

/**
 * Well inside claim_job's 5-minute abandoned window, even with a slow
 * database, and three beats inside the watchdog's 100s (db.ts
 * STALE_RUNNING_MS). Round 21: at one beat a minute, a dead worker could
 * only be noticed 150s after its last touch; at 30s it is 100s.
 */
let HEARTBEAT_MS = 30_000;
/** Tests only. Returns the undo. */
export function __setHeartbeatMs(ms: number): () => void {
  const was = HEARTBEAT_MS;
  HEARTBEAT_MS = ms;
  return () => {
    HEARTBEAT_MS = was;
  };
}

/**
 * How long past the hard stop an attempt may still be running before the
 * overrun guard acts (see drainQueue): 20s, so a send, a DB call or a Jev
 * check that started just inside the hard stop (each bounded at 10-20s) is
 * not mistaken for a hang. The guard fires at ~290s, before the 300s kill.
 */
let OVERRUN_GRACE_MS = 20_000;
/** Tests only. Returns the undo. */
export function __setOverrunGraceMs(ms: number): () => void {
  const was = OVERRUN_GRACE_MS;
  OVERRUN_GRACE_MS = ms;
  return () => {
    OVERRUN_GRACE_MS = was;
  };
}

// Unique per drain, not per process: it is the fencing token (jobctx.ts), and
// one Vercel instance runs concurrent invocations in the same process — two
// drains with the same label would otherwise share a token.
const workerId = (label: string): string => `${label}-${process.env.VERCEL_REGION ?? "local"}-${process.pid}-${randomUUID().slice(0, 8)}`;

/** Jobs that take minutes, not seconds. */
const LONG_JOBS = new Set<JobRow["kind"]>(["plan_build_stage", "goal_options", "plan_repair"]);
/** The room a long job needs before the invocation's hard stop to be started here rather than handed on. */
export const LONG_JOB_ROOM_MS = 200_000;
/**
 * The room a job whose single model calls take minutes needs: the plan
 * build's strategy and workstreams lanes, and the plan repair that redoes
 * them. Round 24, live: 6 of 8 failed build calls were the contracts part,
 * refused for time with seconds left because its lane had been claimed by a
 * worker already part-way through its own budget (a long job could start
 * with only 200s left, and that part's call alone can take over 200s). One
 * of these starts only at the top of a fresh worker, with a whole attempt;
 * otherwise it goes to one at once.
 */
export const FULL_ATTEMPT_ROOM_MS = 250_000;
const needsFullAttempt = (job: JobRow): boolean =>
  job.kind === "plan_repair" || (job.kind === "plan_build_stage" && (job.payload?.step === "strategy" || job.payload?.step === "workstreams"));

export async function drainQueue(opts: DrainOptions = {}): Promise<DrainReport> {
  const maxJobs = opts.maxJobs ?? 5;
  const budgetMs = opts.budgetMs ?? 240_000;
  const started = Date.now();
  const me = workerId(opts.label ?? "worker");
  const report: DrainReport = { claimed: 0, done: 0, failed: 0 };

  // Vercel's Hobby cron cannot run more than once a day, so ordinary traffic
  // IS the schedule for noticing a plan build whose stage job died quietly.
  // Cheap when nothing is stale (one query, normally zero rows) — see
  // reclaimStalePlanBuilds for why 90s, not the jobs table's own 5 minutes.
  try {
    await reclaimStalePlanBuilds();
    await autoRetryFailedBuilds();
    // A build past its six-minute deadline goes out with what it has
    // (engine/planbuild.ts); here, as well as on the tick, so it is not
    // left waiting for the minute.
    await handOverOverdueBuilds();
  } catch (err) {
    console.warn("reclaimStalePlanBuilds / autoRetryFailedBuilds / handOverOverdueBuilds failed", err);
  }

  // With a way to hand on, stop STARTING jobs well before the invocation's
  // 300-second kill: a stage started with a minute to live is killed mid-way,
  // and a killed drain never hands on. What is left goes to a fresh worker
  // with a full budget instead.
  const canHandOn = !opts.noHandOn && Boolean(env.PUBLIC_BASE_URL && env.WORKER_SECRET);
  const claimUntil = canHandOn ? Math.max(budgetMs * 0.6, budgetMs - 90_000) : budgetMs;
  let reclaimTries = 0;
  // The moment every job attempt in this drain must be done by (jobctx.ts
  // jobMsLeft): budget plus the margin a drain keeps below Vercel's 300s
  // kill. Model calls will not start past it, so a slow job fails where the
  // queue can see it instead of being killed where nothing can.
  const hardStopAt = started + (opts.hardStopMs ?? budgetMs + 30_000);
  // 200s in production (a 270s window); proportionally less for a drain
  // given a shorter budget, so a drain never defers a long job it was started
  // fresh to run. Measured from the budget's own window, not the hard stop: a
  // hard stop nearer than the budget is exactly when a stage has no room.
  const longJobRoom = Math.min(LONG_JOB_ROOM_MS, Math.floor((budgetMs + 30_000) * 0.74));
  // The same, for a job that needs a whole attempt (needsFullAttempt).
  const fullAttemptRoom = Math.min(FULL_ATTEMPT_ROOM_MS, Math.floor((budgetMs + 30_000) * 0.92));

  while (report.claimed < maxJobs && Date.now() - started < claimUntil) {
    let job: JobRow | null;
    try {
      job = await claimJob(me);
    } catch (err) {
      console.error("claimJob failed", err);
      break;
    }
    if (!job) {
      // Nothing claimable now. Only a worker that has not started anything
      // yet waits (the freshly woken hand-on worker, at the top of its full
      // budget): once a drain has done work it breaks instead, and handOn
      // wakes a fresh worker for whatever becomes due.
      const wait = opts.waitForDueMs ?? 0;
      if (wait > 0 && report.claimed === 0) {
        const due = await queuedWorkDue(wait).catch(() => ({ ready: 0, soonestMs: null, nextMs: null }));
        const left = claimUntil - (Date.now() - started);
        // Something due by now that claim_job would not hand out may have
        // become due between the two queries, or be a clock skew: retry the
        // claim a couple of times before giving up on it.
        if (due.ready > 0 && reclaimTries < 2 && left > 5_000) {
          reclaimTries++;
          await sleep(1_000);
          continue;
        }
        // The soonest job that is not due yet (a retry's backoff), whatever
        // else is sitting blocked behind a busy owner.
        if (due.nextMs !== null && due.nextMs + 5_000 < left) {
          await sleep(due.nextMs + 250);
          continue;
        }
      }
      break;
    }
    report.claimed++;

    // A long job (a plan-build stage, the customer options: minutes of model
    // calls) claimed late in this invocation would be killed before it
    // finished, and a killed worker goes silent: the watchdog requeues it
    // 100s later and the person waits for nothing. Round 19's 26-minute
    // KE build was four of those in a row. With a way to hand on, it goes
    // straight back (its attempt not spent) to a fresh worker with a whole
    // budget instead.
    if (LONG_JOBS.has(job.kind) && canHandOn && hardStopAt - Date.now() < (needsFullAttempt(job) ? fullAttemptRoom : longJobRoom)) {
      await holdJob(job.id, job.attempts, "deferred to a fresh worker: not enough time left in this one");
      track("job_deferred", { category: "performance", businessId: job.business_id, props: { kind: job.kind, stage: typeof job.payload?.step === "string" ? job.payload.step : null, ms_left: hardStopAt - Date.now() } });
      report.held = (report.held ?? 0) + 1;
      break;
    }

    // One owner, one worker at a time. Put it straight back with a short delay
    // rather than interleaving writes with whoever has it.
    //
    // PRIORITY 0 (live, 2026-09-22): this used to be the ONLY place that
    // enforced per-owner ordering, and it is exactly what broke it. Two
    // workers could each claim a DIFFERENT job for the SAME owner within
    // milliseconds of each other — claim_job() itself had no idea what "the
    // same owner" meant — and each hold here pushed run_after five seconds
    // into the future, which a message the person hadn't even sent yet at
    // that moment could still land ahead of once it arrived. That is how a
    // job created SECOND was claimed LAST, behind two later messages.
    //
    // The actual fix (db/0013_claim_job_owner_order.sql) moved the ordering
    // into claim_job() itself: a job for a busy owner is never handed out in
    // the first place, so this check can no longer find anything to catch —
    // see the tests in test/queue.test.ts that prove that directly. It stays
    // as a harmless, now-redundant safety net rather than being deleted,
    // since the actual fix has to reach a real database to take effect.
    if (job.kind === "inbound" && job.wa_id && (await otherJobRunningFor(job.wa_id, job.id))) {
      await holdJob(job.id, job.attempts, "another message from this person is still being handled");
      report.claimed--;
      report.held = (report.held ?? 0) + 1;
      continue;
    }

    // A long job (a plan-build stage, the customer options) gets a watchdog
    // BEFORE it runs, and a fresh worker woken to carry it, so that if this
    // function dies mid-job something other than this function notices
    // (db.ts, "The watchdog"). Only when none is running already: one chain,
    // not one per job.
    if ((job.kind === "plan_build_stage" || job.kind === "goal_options") && (await ensureWatchdog().catch(() => false)) && canHandOn) {
      await wakeWatch(opts.label ?? "worker");
    }

    // Heartbeat (see jobctx.ts): refresh the lock every 30 seconds while
    // this attempt works, so a slow model call never lets the job look
    // abandoned.
    const beat = setInterval(() => void touchJob(job!.id, me).catch(() => {}), HEARTBEAT_MS);
    // Tracking: every event inside the job carries its id (and its owner,
    // when the job knows one); its own outcome is one event at the end.
    const jobStarted = Date.now();
    const jobFacts = { kind: job.kind, attempt: job.attempts, max_attempts: job.max_attempts, stage: typeof job.payload?.step === "string" ? job.payload.step : undefined };
    const jobTrack = { jobId: job.id, businessId: job.business_id ?? null, channel: job.kind === "inbound" ? ("whatsapp" as const) : ("system" as const) };
    // The overrun guard. Round 21, live: a KE build's strategy and
    // workstreams attempts hung in a model call's body read past the hard
    // stop, where nothing in the job could see them. The heartbeat kept the
    // job looking alive until Vercel killed the function at 300s; only 150s
    // after that did the watchdog requeue it — seven minutes of silence for
    // the person. So queue the next attempt NOW, from this timer, while the
    // process still runs, to start just after the kill. This attempt is not
    // fenced: if it is only slow and finishes before the kill, its finishJob
    // closes the job and the queued copy never runs (db.ts requeueOverrun).
    // On the last attempt there is no next one to queue; requeueStaleRunning
    // deals with the job after the kill, as before — this only says so at once.
    const overrun = setTimeout(() => {
      void (async () => {
        const facts = { ...jobFacts, job_id: job!.id };
        await withTrackContext(jobTrack, async () => {
          track("job_overran_hard_stop", {
            category: "failure",
            severity: "error",
            alert: "immediate",
            businessId: job!.business_id,
            props: facts,
            fingerprint: `job_overran_hard_stop:${job!.kind}:${String(jobFacts.stage ?? "")}`,
            summary: `A ${job!.kind.replace(/_/g, " ")}${jobFacts.stage ? ` (${jobFacts.stage})` : ""} job was still running ${Math.round(OVERRUN_GRACE_MS / 1000)}s past its invocation's hard stop on attempt ${job!.attempts}${job!.attempts < job!.max_attempts ? "; handed to a fresh worker" : " (its last); the watchdog takes it after the kill"}`,
          });
        });
        if (job!.attempts < job!.max_attempts) await requeueOverrun(job!.id, me).catch((err) => console.warn(`job ${job!.id}: overrun requeue failed`, err));
        await flushTracking();
        if (canHandOn) await handOn(opts.label ?? "worker");
      })().catch((err) => console.warn(`job ${job!.id}: overrun guard failed`, err));
    }, Math.max(0, hardStopAt + OVERRUN_GRACE_MS - Date.now()));
    try {
      await withTrackContext(jobTrack, () =>
        jobCtx.run({ id: job!.id, worker: me, deadlineAt: hardStopAt, lastAttempt: job!.attempts >= job!.max_attempts, attempt: job!.attempts, kind: job!.kind }, () => runJob(job!)),
      );
      await finishJob(job.id, "done", undefined, me);
      report.done++;
      if (job.kind !== "watchdog") track("job_done", { category: "performance", businessId: job.business_id, ms: since(jobStarted), props: jobFacts });
      // A plan repair may be waiting on this lane (engine/repair.ts): now, not on its next poll.
      if (job.kind === "plan_build_stage" && job.business_id && (jobFacts.stage === "strategy" || jobFacts.stage === "workstreams")) {
        await wakeHeldRepair(job.business_id).catch((e) => console.warn("wakeHeldRepair failed", e));
      }
    } catch (err) {
      if (err instanceof JobFencedError) {
        // Someone else owns the job now and will finish it: no retry, no
        // apology, no status write — this attempt simply stops.
        console.warn(err.message);
        report.fenced = (report.fenced ?? 0) + 1;
        continue;
      }
      // A stale attempt that failed some other way must not mark a plan
      // build failed or apologise for a job another worker now owns.
      if (!(await stillOwnJob(job.id, me).catch(() => true))) {
        report.fenced = (report.fenced ?? 0) + 1;
        continue;
      }
      // Not a failure: the job is waiting on other work (jobctx.ts JobHoldError).
      if (err instanceof JobHoldError) {
        await holdJob(job.id, job.attempts, err.message, err.delayMs);
        report.held = (report.held ?? 0) + 1;
        track("job_held", { category: "performance", businessId: job.business_id, props: { ...jobFacts, ms_held: err.delayMs } });
        continue;
      }
      report.failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`job ${job.id} (${job.kind}) attempt ${job.attempts} failed:`, message);

      if (job.attempts >= job.max_attempts) {
        await finishJob(job.id, "dead", message, me);
        // A job out of attempts is work a person was waiting for that will
        // not happen by itself: a plan build stage is the worst of these.
        trackFailure("job_dead", err, {
          businessId: job.business_id,
          severity: job.kind === "plan_build_stage" || job.kind === "inbound" || job.kind === "goal_options" ? "critical" : "error",
          alert: "immediate",
          ms: since(jobStarted),
          props: jobFacts,
          fingerprint: `job_dead:${job.kind}:${String(jobFacts.stage ?? "")}`,
          summary: `A ${job.kind.replace(/_/g, " ")}${jobFacts.stage ? ` (${jobFacts.stage})` : ""} job failed ${job.attempts} times and gave up: ${message.slice(0, 160)}`,
        });
        // Marks plan_builds.stage "failed" only now — its own retries (up to
        // max_attempts) may well have succeeded, and flagging it on every
        // transient attempt would make handleBuildingPlan restart the whole
        // machinery over a hiccup the job system was about to fix itself.
        if (job.kind === "plan_build_stage" && job.business_id) await failPlanBuild(job.business_id, message);
        await apologise(job, message);
      } else {
        await retryJob(job.id, job.attempts, message, me);
        trackFailure("job_retry", err, {
          businessId: job.business_id,
          severity: "warn",
          alert: "digest",
          ms: since(jobStarted),
          props: jobFacts,
          fingerprint: `job_retry:${job.kind}:${String(jobFacts.stage ?? "")}`,
        });
      }
    } finally {
      clearInterval(beat);
      clearTimeout(overrun);
    }
  }

  if (report.claimed) console.log(`drain[${opts.label ?? "worker"}]: ${JSON.stringify(report)}`);
  await flushTracking();
  // Any drain that did work revives the watch if work is still in flight and
  // the chain has lapsed — so one lost link can never leave a build unwatched
  // for longer than the next message or hand-on.
  if (report.claimed > 0 && canHandOn && (await workInFlight().catch(() => false)) && (await ensureWatchdog().catch(() => false))) await wakeWatch(opts.label ?? "worker");
  if (report.claimed > 0 && canHandOn) await handOn(opts.label ?? "worker");
  return report;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How far ahead a queued job still counts as "left for us to do". */
const HAND_ON_WITHIN_MS = 60_000;

/**
 * The plan build is a chain of six jobs, and the webhook's drain takes at
 * most four, inside one invocation's budget. Whatever was left used to wait
 * for the next inbound message from anyone — the only other trigger on a
 * Hobby plan, whose cron runs once a day — so on a quiet number the last
 * stages (finalize, then the PDF) sat queued until the person wrote again
 * (founder, 2026-09-24: "it takes forever for a report to come"). The test
 * script never saw it: it calls /api/worker every few seconds while it waits.
 *
 * So a drain that did work and leaves work behind wakes a fresh worker
 * invocation, with its own time budget, and returns. It hands on only after
 * doing something (report.claimed > 0), so a queue that cannot move — every
 * job waiting on a busy owner — never turns into a loop of empty wake-ups.
 */
async function handOn(label: string): Promise<void> {
  try {
    const due = await queuedWorkDue(HAND_ON_WITHIN_MS);
    if (due.ready === 0 && due.soonestMs === null) return;
    // Deep enough already (chain.ts): the once-a-minute tick, a fresh chain,
    // carries the work on, so this chain's render is never refused.
    if (!mayWakeWorker()) {
      track("self_call_capped", { category: "performance", props: { what: "hand_on", label, hop: currentHop(), ready: due.ready } });
      return;
    }
    const base = (env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
    const wake = () =>
      fetch(`${base}/api/worker?max=10&async=1&hop=${nextHop()}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.WORKER_SECRET}` },
        signal: AbortSignal.timeout(15_000),
      });
    // One retry: a cold start can outlast one attempt, and a lost wake-up is
    // what ends the watchdog chain (round 14).
    const res = await wake().catch(async (err) => {
      console.warn(`drain[${label}]: hand-on attempt failed, retrying once`, err);
      return wake();
    });
    console.log(`drain[${label}]: handed on (${due.ready} ready, next in ${due.soonestMs ?? 0}ms) → worker ${res.status}`);
    // Refused by the platform (a 508 when the chain was too deep): the work
    // waits for the next tick. On the record, not only in the log.
    if (!res.ok) selfCallRefused("hand_on", label, res);
  } catch (err) {
    // The work is durable in the queue either way; the next message still drains it.
    console.warn(`drain[${label}]: hand-on failed`, err);
  }
}

/**
 * One watchdog pass: reclaim what went quiet, and keep watching while work
 * is in flight. The next link is queued, and the watch runner woken to carry
 * it, whatever happens to the reclaim — a pass that throws must not end the
 * chain (a watchdog has one attempt).
 */
export async function runWatchdog(jobId: number): Promise<void> {
  let requeued = 0;
  try {
    await reclaimStalePlanBuilds();
    await handOverOverdueBuilds().catch((err) => console.warn("watchdog: handOverOverdueBuilds failed", err));
    requeued = await requeueStaleRunning();
  } finally {
    const inFlight = await workInFlight().catch(() => true);
    if (inFlight) await ensureWatchdog(jobId);
    const canHandOn = Boolean(env.PUBLIC_BASE_URL && env.WORKER_SECRET);
    if (inFlight && canHandOn) {
      // A normal worker for the work itself (including anything just
      // requeued), and the watch runner for the next link — two different
      // functions, so a stage that hangs can never swallow the watchdog.
      if (requeued > 0 || (await queuedWorkDue(0).catch(() => ({ ready: 0 }))).ready > 0) await handOn("watchdog");
      await wakeWatch("watchdog");
    }
  }
}

/**
 * Live test, round 15: the next watchdog sat queued, never claimed, for
 * 8-15 minutes, twice. The worker woken to run it (handOn) went through
 * claim_job, which hands out the OLDEST due job — the build stage, not the
 * watchdog — and that stage hung, taking the watchdog's only runner with it.
 * So the watchdog has a runner of its own (/api/worker?watch=1) that claims
 * the watchdog job by id and runs nothing else.
 */
export async function runWatch(opts: { waitMs?: number; label?: string } = {}): Promise<{ ran: boolean }> {
  const next = await nextWatchdog();
  if (!next) return { ran: false };
  const wait = new Date(next.run_after).getTime() - Date.now();
  if (wait > (opts.waitMs ?? 60_000)) return { ran: false };
  if (wait > 0) await sleep(wait);
  const me = workerId(opts.label ?? "watch");
  if (!(await claimJobById(next.id, me))) return { ran: false }; // another runner has it
  try {
    await runWatchdog(next.id);
    await finishJob(next.id, "done", undefined, me);
  } catch (err) {
    console.warn("watchdog pass failed", err);
    await finishJob(next.id, "dead", err instanceof Error ? err.message : String(err), me);
  }
  return { ran: true };
}

/**
 * The once-a-minute safety net (vercel.json cron → /api/worker?tick=1).
 * Round 18: the KE build sat 15 minutes — its strategy job orphaned, the
 * next watchdog queued and never claimed — until the person wrote again.
 * Every link in the watchdog chain is itself a request that can be lost;
 * this one is not part of the chain, so the chain can never be the only
 * thing watching. Idle (nothing in flight) it is two cheap reads.
 */
export async function cronTick(): Promise<{ inFlight: boolean; requeued: number; watchdogRan: boolean; alerts?: unknown }> {
  let requeued = 0;
  let ran = false;
  const inFlight = await workInFlight().catch(() => true);
  if (inFlight) {
    // The safety net first: a person waiting on a stalled build comes before
    // any email about it.
    await reclaimStalePlanBuilds().catch((err) => console.warn("tick: reclaimStalePlanBuilds failed", err));
    // Before the slow-build notice below: a build handed over now is not "taking longer than usual".
    await handOverOverdueBuilds().catch((err) => console.warn("tick: handOverOverdueBuilds failed", err));
    requeued = await requeueStaleRunning().catch(() => 0);
    // An overdue watchdog runs here and now; a lapsed chain gets a new link.
    ({ ran } = await runWatch({ waitMs: 0, label: "tick" }).catch(() => ({ ran: false })));
    if (!ran && (await ensureWatchdog().catch(() => false))) await wakeWatch("tick");
    if (requeued > 0 || (await queuedWorkDue(0).catch(() => ({ ready: 0 }))).ready > 0) await handOn("tick");
    await alertSlowBuilds().catch((err) => console.warn("tick: slow-build check failed", err));
    if (requeued) {
      console.log(`tick: requeued ${requeued} stale job(s)`);
      // A job whose worker died mid-way: the tick, not the person, noticed.
      track("stale_jobs_requeued", { category: "failure", severity: "warn", alert: "digest", props: { count: requeued } });
    }
  }
  // Then the alert pass, every minute whatever else is happening: it is what
  // turns recorded failures into an email (alerts.ts). It never throws.
  const alerts = await runAlerts().catch((err) => ({ error: String(err) }));
  await flushTracking();
  return { inFlight, requeued, watchdogRan: ran, alerts };
}

/**
 * A plan build still running after 8 minutes is a person waiting far past
 * what they were told (typically 3-5 minutes): an immediate alert at 8
 * minutes, then once per further 10 (buckets 8-17, 18-27, …). Round 19: a
 * 26-minute build raised only an hourly warning.
 *
 * Edge-triggered, one alert per bucket, claimed in alert_state. Round 21:
 * the alert used to fire on a tick whose minute was exactly 10, 20, 30… —
 * a tick that ran late, was skipped, or ran twice in that minute lost the
 * alert or doubled it. Now any tick inside a bucket can raise it, and the
 * claim (alert_state's primary key, the way alerts.ts runDaily claims its
 * slot) makes sure only one does.
 */
export const SLOW_BUILD_FIRST_MIN = 8;
export const SLOW_BUILD_EVERY_MIN = 10;

/**
 * The person hears about a slow build once, at the latest of this and two
 * minutes past a typical build (eta.ts typicalMinutes) — never before
 * they could reasonably have expected the plan. Round 24: 7, not 6. A build
 * still unfinished at six minutes is handed over then (engine/planbuild.ts
 * HAND_OVER_AFTER_MS), so the notice is only for one that could not be:
 * never "this is taking longer" a moment before the plan arrives.
 */
export const SLOW_NOTICE_MIN = 7;
export const SLOW_BUILD_NOTICE =
  "This is taking longer than usual — sorry for the wait. I'm still working on your plan and nothing you've told me is lost. I'll send it here the moment it's ready; there's nothing you need to do.";

/** True for exactly one caller per key: alert_state's primary key makes the insert the claim. Any failure is "not claimed" — the next tick tries again. */
async function claimOnce(key: string, detail: string | null = null): Promise<boolean> {
  const { error } = await db().from("alert_state").insert({ key, at: new Date().toISOString(), detail });
  return !error;
}

/** One pass, from cronTick each minute. `now` lets a test move the clock. */
export async function alertSlowBuilds(now = Date.now()): Promise<void> {
  const { data, error } = await db().from("plan_builds").select("business_id, stage, created_at").in("stage", ["context", "building", "finalize", "pdf"]);
  if (error) throw error;
  let noticeMin: number | null = null;
  for (const b of (data as { business_id: string; stage: string; created_at: string | null }[] | null) ?? []) {
    if (!b.created_at) continue;
    const mins = Math.floor((now - new Date(b.created_at).getTime()) / 60_000);
    if (!Number.isFinite(mins) || mins < SLOW_NOTICE_MIN) continue;
    if (mins >= SLOW_BUILD_FIRST_MIN) {
      const bucket = Math.floor((mins - SLOW_BUILD_FIRST_MIN) / SLOW_BUILD_EVERY_MIN);
      if (await claimOnce(`build_slow:${b.business_id}:${b.created_at}:${bucket}`, b.stage)) {
        track("plan_build_slow", {
          category: "failure",
          severity: "error",
          alert: "immediate",
          businessId: b.business_id,
          ms: mins * 60_000,
          props: { stage: b.stage, minutes: mins },
          fingerprint: "plan_build_slow",
          summary: `A plan build has been running for ${mins} minutes (stage ${b.stage}); the person was told a few minutes`,
        });
      }
    }
    noticeMin ??= Math.max(SLOW_NOTICE_MIN, ((await typicalMinutes("plan_build_timing").catch(() => null)) ?? 4) + 2);
    // Not once the plan is being written out (finalize, pdf): it is seconds
    // away. Round 25, live: the notice reached KEc at 07:01:11 and the plan
    // at 07:01:12. A build stuck there is still paged at 8 minutes, above.
    if (mins >= noticeMin && (b.stage === "context" || b.stage === "building")) await noticeSlowBuild(b.business_id, b.created_at, mins, b.stage);
  }
}

/**
 * Round 21, live: a KE owner heard nothing from 22:02 to 22:14 while their
 * build stalled — told "a few minutes", then twelve minutes of silence. One
 * honest line, once per build, says it is slow and that nothing is lost.
 * Claimed first (alert_state), so two ticks can never both send it. Not
 * sent when they are no longer waiting on the build (another stage), or when
 * Charles spoke to them in the last two minutes — that reply already told
 * them where things stand. Never throws: it runs inside the tick that also
 * revives stalled builds.
 */
async function noticeSlowBuild(businessId: string, createdAt: string, minutes: number, buildStage: string): Promise<void> {
  try {
    const biz = await findBusinessById(businessId);
    // Still waiting: building, or past finalize (stage plan_ready already)
    // with the plan not yet delivered — that is the PDF stage's outline.
    const waiting = biz && (biz.stage === "building_plan" || (biz.stage === "plan_ready" && (buildStage === "finalize" || buildStage === "pdf")));
    if (!biz || !waiting) return;
    if (biz.last_outbound_at && Date.now() - new Date(biz.last_outbound_at).getTime() < 2 * 60_000) return;
    // Claimed only now, just before the send: a tick that skips (Charles
    // spoke to them a minute ago) leaves the notice for a later one —
    // review, round 21: claimed first, one skip silenced the whole build.
    if (!(await claimOnce(`slow_notice:${businessId}:${createdAt}`))) return;
    const sent = await sendText(biz.wa_id, SLOW_BUILD_NOTICE, biz.id);
    // A refused send is wa_send_failed already; this says whether they got it.
    track("plan_build_slow_notice", { category: "ops", businessId: biz.id, props: { minutes, delivered: sent.ok } });
  } catch (err) {
    console.warn("tick: slow-build notice failed", err);
  }
}

/** Wake the dedicated watch runner (see runWatch). */
async function wakeWatch(label: string): Promise<void> {
  if (!env.PUBLIC_BASE_URL || !env.WORKER_SECRET) return;
  // The tick runs an overdue watchdog itself every minute: a chain too deep
  // to wake the watch runner leaves the next link to it (chain.ts).
  if (!mayWakeWorker()) {
    track("self_call_capped", { category: "performance", props: { what: "watch", label, hop: currentHop() } });
    return;
  }
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const wake = () =>
    fetch(`${base}/api/worker?watch=1&hop=${nextHop()}`, { method: "POST", headers: { Authorization: `Bearer ${env.WORKER_SECRET}` }, signal: AbortSignal.timeout(15_000) });
  try {
    const res = await wake().catch(() => wake());
    if (!res.ok) selfCallRefused("watch", label, res);
  } catch (err) {
    console.warn(`drain[${label}]: waking the watch runner failed`, err);
  }
}

/** A wake-up the platform refused (x-vercel-error says which: INFINITE_LOOP_DETECTED for a too-deep chain). */
function selfCallRefused(what: string, label: string, res: Response): void {
  const platform = res.headers.get("x-vercel-error");
  track("self_call_refused", {
    category: "failure",
    severity: "warn",
    alert: "digest",
    props: { what, label, hop: currentHop(), status: res.status, ...(platform ? { platform_error: platform } : {}) },
    fingerprint: `self_call_refused:${what}:${res.status}`,
  });
}

async function runJob(job: JobRow): Promise<void> {
  switch (job.kind) {
    case "inbound": {
      const msg = job.payload as unknown as InboundMessage;
      if (!msg?.from) throw new Error("inbound job has no sender");
      await handleInbound(msg);
      return;
    }
    case "nudge": {
      const { sendOneNudge } = await import("./nudges.js");
      if (!job.business_id) throw new Error("nudge job has no business");
      await sendOneNudge(job.business_id);
      return;
    }
    case "freshness": {
      const { runFreshnessSweep } = await import("./freshness.js");
      await runFreshnessSweep();
      return;
    }
    case "plan_build_stage": {
      await runPlanBuildStage(job);
      return;
    }
    case "watchdog": {
      await runWatchdog(job.id);
      return;
    }
    case "goal_options": {
      // Call B of the read-back split (engine/build.ts): queued as the
      // read-back is sent, keyed on the business only — never the person's
      // wa_id, so the person's reply never waits behind it (db/0013). A retry
      // redoes the options only; the read-back is never sent again from here.
      await runGoalOptionsJob(job);
      return;
    }
    case "kept_question": {
      // A question asked mid-diagnostic, answered after the hand-over
      // (engine/kept.ts). Keyed on the person's number, so it runs in order
      // with their own messages.
      const { runKeptQuestionJob } = await import("./engine/kept.js");
      await runKeptQuestionJob(job);
      return;
    }
    case "plan_repair": {
      // A part of a handed-over plan that went out degraded, redone
      // (engine/repair.ts). Keyed on the business only.
      const { runPlanRepairJob } = await import("./engine/repair.js");
      await runPlanRepairJob(job);
      return;
    }
    case "plan_pdf": {
      // The hand-over's PDF, tried again after it failed to render (engine/planpdf.ts).
      const { runPlanPdfJob } = await import("./engine/planpdf.js");
      await runPlanPdfJob(job);
      return;
    }
    default:
      throw new Error(`unknown job kind "${job.kind}"`);
  }
}

/**
 * A job that has exhausted its retries leaves someone waiting. Saying so is
 * the minimum; going silent is what makes a product feel broken.
 */
async function apologise(job: JobRow, reason: string): Promise<void> {
  try {
    // The question the person asked mid-diagnostic was promised an answer.
    if (job.kind === "kept_question" && job.wa_id) {
      await sendText(job.wa_id, "I couldn't answer the question you asked me earlier just now — that's on me. Send it to me again and I'll answer it straight away.", job.business_id);
      return;
    }
    if (job.kind === "inbound" && job.wa_id) {
      const biz = await findBusiness(job.wa_id);
      await sendText(
        job.wa_id,
        "Something went wrong on my side and I couldn't finish that. Send it again and I'll pick it straight up.",
        biz?.id ?? null,
      );
      return;
    }
    // A dead plan_build_stage job used to fail in total silence: it has no
    // wa_id (it's keyed by business_id, not by an inbound message), so the
    // check above never covered it, and the person just watched "building"
    // sit there forever with no explanation.
    if (job.kind === "plan_build_stage" && job.business_id) {
      const biz = await findBusinessById(job.business_id);
      if (biz) {
        await sendText(
          biz.wa_id,
          "Couldn't finish building your plan just then — that's on me, not on you. I'll try again on my own in a few minutes, keeping everything you've told me — or send me anything to try right now.",
          biz.id,
        );
      }
      return;
    }
    // A repair the hand-over promised ("I'll tell you when that's done").
    if (job.kind === "plan_repair" && job.business_id) {
      const biz = await findBusinessById(job.business_id);
      if (biz && !biz.deleted_at && biz.current_plan_id === job.payload?.plan_id) {
        await sendText(biz.wa_id, "I couldn't finish rewriting that part of your plan for your situation — that's on me. Your steps still work as they are, and you can ask me about any of them.", biz.id);
      }
      return;
    }
    // The PDF the hand-over said it would try again.
    if (job.kind === "plan_pdf" && job.business_id) {
      const biz = await findBusinessById(job.business_id);
      if (biz && !biz.deleted_at && biz.current_plan_id === job.payload?.plan_id) {
        const { SEND_PDF_BUTTON } = await import("./engine/planpdf.js");
        const { planUrl } = await import("./engine/build.js");
        const online = planUrl();
        await sendButtons(biz.wa_id, `I still couldn't make the PDF of your plan.${online ? ` The whole plan is online at ${online}.` : ""} Tap below any time to try again.`, [SEND_PDF_BUTTON], biz.id);
      }
      return;
    }
    // A dead customer-options job only leaves someone waiting if they have
    // already confirmed the read-back and were told the options were nearly
    // ready (engine/build.ts showGoalOptions). Clearing that wait is what
    // lets their next "yes" redo the options inline instead of waiting for a
    // job that will never come; a person who has not confirmed yet needs no
    // message — their tap will simply generate the options itself.
    if (job.kind === "goal_options" && job.business_id) {
      const biz = await findBusinessById(job.business_id);
      // Only for the job of the read-back the person is looking at: a job
      // left over from a read-back they since corrected leaves nobody waiting.
      const current = biz?.pending_goal_options?.token ?? null;
      if (biz?.stage === "confirm_identity" && biz.pending_action?.kind === "goal_options_wait" && current === (job.payload?.token ?? null)) {
        await updateBusiness(biz.id, { pending_action: null });
        await sendText(biz.wa_id, "I couldn't finish putting together who you could aim at — that's on me. Reply yes and I'll try again.", biz.id);
      }
    }
  } catch (err) {
    console.error("could not apologise for dead job", job.id, reason, err);
  }
}
