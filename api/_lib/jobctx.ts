// Charles — which queue job, and which attempt of it, is running right now.
//
// Live, round 6 (2026-09-24): one "How am I doing?" was answered TWICE, about
// five minutes apart. Its first attempt waited ~127s on a slow model call; the
// job's lock was never refreshed, so after 5 minutes (db/0005 claim_job's
// abandoned-job window) a sweep reclaimed it and ran it again — while the
// first attempt was still alive underneath, and also replied. Two answers,
// double the model cost.
//
// Two defences, both keyed on this context:
//   - the drain heartbeats a running job's lock (queue.ts), so a job that is
//     alive is never reclaimed in the first place;
//   - every WhatsApp send checks the job is still this attempt's (wa.ts). A
//     reclaimed attempt is fenced off: it stops, and sends nothing.

import { AsyncLocalStorage } from "node:async_hooks";

export interface JobCtx {
  id: number;
  /** The worker id this attempt claimed the job with: the fencing token. */
  worker: string;
  /** Last time ownership was confirmed, so a turn's 2–3 sends cost one read, not three. */
  checkedAt?: number;
  /**
   * Epoch ms by which this attempt must be finished: the drain's hard stop,
   * safely inside Vercel's 300-second kill. See jobMsLeft.
   */
  deadlineAt?: number;
  /** True when a failure now makes the job dead rather than retried. */
  lastAttempt?: boolean;
  /** Which attempt this is, from 1. */
  attempt?: number;
  /** The job's kind (jobs.kind): see jobKind. */
  kind?: string;
}

export const jobCtx = new AsyncLocalStorage<JobCtx>();

/** Thrown at a send when this attempt no longer owns its job. Never retried: the job is someone else's now. */
export class JobFencedError extends Error {
  constructor(id: number) {
    super(`job ${id} was reclaimed by another worker; this attempt stops without sending`);
    this.name = "JobFencedError";
  }
}

/**
 * How long this job attempt has left, or null outside a job.
 *
 * Live test, round 10 (2026-09-26): a plan build's strategy call spent 66% of
 * its output on hidden reasoning, came back cut off, and was retried — and the
 * retry pushed the invocation past Vercel's 300-second limit. The platform
 * killed the function mid-call, so nothing recorded a failure: the job sat
 * "running" with last_error null for 26 minutes until the person happened to
 * write again. A retry that cannot finish must not start. Model calls read
 * this (models.ts) and refuse to start a call there is no time for, which
 * turns a silent platform kill into an ordinary job failure: recorded, retried
 * by a fresh worker with a full budget, and visible in the queue.
 */
export function jobMsLeft(): number | null {
  const at = jobCtx.getStore()?.deadlineAt;
  return typeof at === "number" ? at - Date.now() : null;
}

/** Whether a failure in this attempt is final (the job will not be retried). */
export function onLastAttempt(): boolean {
  return jobCtx.getStore()?.lastAttempt === true;
}

/**
 * The kind of job this code runs inside ("inbound", "plan_build_stage", …),
 * or null outside one. Lets shared code (the guardrails) treat running out
 * of time differently where a retry is cheap: a plan-build stage retries
 * only itself, while rethrowing inside an inbound turn would re-run the
 * owner's whole turn.
 */
export function jobKind(): string | null {
  return jobCtx.getStore()?.kind ?? null;
}

/**
 * Job kinds that retry a whole unit of work when an attempt runs out of
 * time, rather than settle for less inside it: a plan-build stage, and a
 * plan repair (engine/repair.ts), which redoes the same parts with the same
 * checks. Inside them a guardrail out of time rethrows (safety.ts judge,
 * moneymap.ts) instead of failing open and storing a step unchecked, and
 * a model call refused for time is a warning, not an error (models.ts) —
 * one list, so the three never disagree (review, round 22).
 */
const RETRY_ON_DEADLINE = new Set(["plan_build_stage", "plan_repair"]);
export function retriesOnDeadline(): boolean {
  const k = jobKind();
  return k !== null && RETRY_ON_DEADLINE.has(k);
}

/**
 * For a guardrail that ran out of time: inside a job that retries (above),
 * rethrow instead of failing open. A plan repair rethrows even on its last
 * attempt — the part it would store unchecked already has a safe version,
 * the library wording the person has, so failing the repair loses nothing
 * (review, round 22). A build stage on its last attempt still fails open: a
 * plan with a step checked by fewer guards beats no plan.
 */
export function rethrowGuardrailDeadline(err: unknown): void {
  if (!(err instanceof DeadlineError) || !retriesOnDeadline()) return;
  if (jobKind() === "plan_repair") throw err;
  rethrowIfRetryable(err);
}

/**
 * Thrown by a job that must wait for other work to finish first (a plan
 * repair waiting on the build's own late lane, engine/repair.ts). The queue
 * puts it back without counting the attempt, to run again after `delayMs`.
 */
export class JobHoldError extends Error {
  readonly delayMs: number;
  constructor(reason: string, delayMs: number) {
    super(reason);
    this.name = "JobHoldError";
    this.delayMs = delayMs;
  }
}

/** Thrown instead of starting work the job attempt has no time left to finish. */
export class DeadlineError extends Error {
  constructor(what: string, leftMs: number) {
    super(`out of time: ${what} needs more than the ${Math.max(0, Math.round(leftMs / 1000))}s this attempt has left; a fresh worker will retry`);
    this.name = "DeadlineError";
  }
}

/**
 * For a catch that would otherwise settle for a weaker result (an untailored
 * workstream, a plan with no strategy): when the only thing wrong is that
 * this attempt ran out of time, and the job will be retried, rethrow so a
 * fresh worker does it properly. On the last attempt, let the caller degrade
 * as before: a plan with a gap beats no plan.
 */
export function rethrowIfRetryable(err: unknown): void {
  if (err instanceof DeadlineError && !onLastAttempt()) throw err;
}

/**
 * Throws JobFencedError if this code runs inside a job attempt that no
 * longer owns its job. Called before FALLBACK writes in catch-all handlers:
 * a stale attempt that fails for any reason (a model timeout, say) must not
 * reset the stage or pending action the live attempt is working with
 * (review of round 6). Outside a job, it does nothing.
 */
export async function fenceCheck(): Promise<void> {
  const job = jobCtx.getStore();
  if (!job) return;
  const { stillOwnJob } = await import("./db.js");
  if (!(await stillOwnJob(job.id, job.worker))) throw new JobFencedError(job.id);
  job.checkedAt = Date.now();
}
