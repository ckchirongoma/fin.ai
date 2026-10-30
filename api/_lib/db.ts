// Fin — the database, behind one door.
//
// Every query in the product goes through the service role, never an anon key:
// db/0001 locks the person-data tables with RLS and no policies, so the public
// key cannot read or write them at all. That is the point — a business's data
// is reachable only through this backend.

import { AsyncLocalStorage } from "node:async_hooks";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";
import { forgetBuffered, setTrackContext, currentTrackContext, track, trackFailure } from "./track.js";
import type {
  Business,
  HouseholdContext,
  CommitmentRow,
  HydratedWorkstream,
  JobRow,
  KnowledgeRow,
  MapEntry,
  PlanBuildRow,
  PlanBuildStep,
  PlanRow,
  PlanStepRow,
  Stage,
  Strategy,
  ToolRow,
} from "./types.js";

/** The longest any one database request may take. Supabase answers in milliseconds. */
export const DB_TIMEOUT_MS = 20_000;

/** fetch, with a timeout added to whatever signal the caller already passed. */
export function fetchWithTimeout(ms: number): typeof fetch {
  return (input, init = {}) => {
    const timeout = AbortSignal.timeout(ms);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetch(input, { ...init, signal });
  };
}

let client: SupabaseClient | null = null;

/**
 * Created on first use, not at import. Vercel imports every function module
 * during a build, and a build must not fail because a secret is not set.
 */
export function db(): SupabaseClient {
  if (!client) {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see HANDOFF-DEPLOY.md section 3).");
    }
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      // Round 13: two plan-build jobs sat "running", last_error null, for
      // 9-13 minutes. A database call with no timeout that hangs holds the
      // job until the platform kills the function, and nothing records why.
      global: { headers: { "x-fin": "backend" }, fetch: fetchWithTimeout(DB_TIMEOUT_MS) },
    });
  }
  return client;
}

/** Test seam: swap in a fake client. Returns a restore function. */
export function __setClient(fake: SupabaseClient | null): () => void {
  const prev = client;
  client = fake;
  return () => {
    client = prev;
  };
}

// ── Businesses ───────────────────────────────────────────────────

export async function findBusiness(waId: string): Promise<Business | null> {
  // No deleted_at filter: "forget my business" removes the row outright, so
  // there is nothing to filter out, and filtering would have hidden the
  // constraint failure that made returning impossible.
  const { data, error } = await db().from("businesses").select("*").eq("wa_id", waId).maybeSingle();
  if (error) throw error;
  return (data as Business) ?? null;
}

export async function findBusinessById(id: string): Promise<Business | null> {
  const { data, error } = await db().from("businesses").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as Business) ?? null;
}

export async function createBusiness(waId: string, country: string): Promise<Business> {
  const { data, error } = await db()
    .from("businesses")
    .insert({ wa_id: waId, country, stage: "diag" as Stage, diag_step: 0, answers: {} })
    .select()
    .single();
  if (error) throw error;
  const biz = data as Business;
  setTrackContext({ businessId: biz.id, country, stage: "diag" });
  track("business_created", { category: "funnel", businessId: biz.id, stage: "diag", props: { country } });
  return biz;
}

export async function updateBusiness(id: string, patch: Partial<Business> & Record<string, unknown>): Promise<void> {
  const { error } = await db().from("businesses").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
  // Every stage a person moves into is a funnel event: where they are, where
  // they came from, and — read across people — where they stop.
  if (typeof patch.stage === "string") {
    const ctx = currentTrackContext();
    const from = ctx.businessId === id ? (ctx.stage ?? null) : null;
    if (from !== patch.stage) {
      track("stage_entered", { category: "funnel", businessId: id, stage: patch.stage, props: { from, to: patch.stage } });
      if (ctx.businessId === id) setTrackContext({ stage: patch.stage });
    }
  }
}

/**
 * "Forget my business" — a real deletion, not a flag.
 *
 * It has to be a real one for two reasons. The promise made to the person is
 * that everything is gone, and POPIA backs that. And `wa_id` is UNIQUE, so
 * anything that leaves the row behind leaves that phone number permanently
 * taken: the person who changes their mind next week cannot come back, because
 * creating their business fails on a constraint they can neither see nor clear.
 *
 * db/0007 puts ON DELETE CASCADE on the older tables that lacked it, so the
 * database enforces this on its own. The explicit deletes here are belt and
 * braces — they make this correct even against a database where 0007 has not
 * been applied yet, and they cover the two tables keyed by wa_id rather than
 * by business id.
 */
export async function forgetBusiness(id: string): Promise<void> {
  const client = db();
  const { data } = await client.from("businesses").select("wa_id, country").eq("id", id).maybeSingle();
  const row = data as { wa_id: string; country: string } | null;

  // Children first, deepest first: plan_steps hangs off plans, not off the
  // business, so it has to go before the plans it belongs to.
  const { data: plans } = await client.from("plans").select("id").eq("business_id", id);
  for (const p of (plans as { id: string }[]) ?? []) {
    await client.from("plan_steps").delete().eq("plan_id", p.id);
  }

  for (const table of [
    "plans",
    "business_map",
    "decisions",
    "messages",
    "commitments",
    "outcomes",
    "nudges",
    "safety_events",
    "retrieval_gaps",
    "knowledge_signals",
    "connector_tokens",
    "plan_sessions",
    "proposed_changes",
    "owner_notes",
    "jobs",
  ]) {
    const { error } = await client.from(table).delete().eq("business_id", id);
    if (error) console.error(`forgetBusiness: ${table}`, error);
  }

  if (row?.wa_id) {
    await client.from("plan_access_codes").delete().eq("wa_id", row.wa_id);
    // Inbound jobs are enqueued keyed by wa_id, not business_id (the business
    // may not exist yet when the webhook first sees the message) — the
    // business_id-keyed "jobs" delete above only ever clears nudge/freshness
    // jobs, never a queued or stuck inbound message. Without this, a forget
    // does nothing to stop whatever this owner already had queued from
    // continuing to run afterward.
    // "queued" covers both a fresh job and one currently being held/retried
    // behind another owner's lock (holdJob/retryJob both set status back to
    // "queued" with a bumped run_after — "held" is a report label, never a
    // persisted status). A "running" job is deliberately left alone: it may
    // be this very forget request being processed, and deleting a job row
    // out from under the invocation still executing it is its own hazard.
    // Done and dead inbound jobs kept the phone number and the person's words
    // in payload after a forget (found 2026-10, building tracking). Every one
    // that is not running goes; a running one may be this forget itself.
    await client.from("jobs").delete().eq("wa_id", row.wa_id).neq("status", "running");
    // The de-duplication ledger goes too: it is a list of this person's message
    // ids. Losing it only risks re-handling a message Meta redelivers within
    // the retry window, which is a far smaller cost than keeping it.
    await client.from("wa_inbound").delete().eq("wa_id", row.wa_id);
  }

  // Tracking keeps what happened, never who: their words and the link to them
  // go before the business row (db/0024's trigger does the same).
  track("business_forgotten", { category: "funnel", businessId: null, props: { country: row?.country ?? null } });
  {
    const { error: scrubErr } = await client.from("events").update({ business_id: null, excerpt: null, turn_id: null }).eq("business_id", id);
    if (scrubErr) console.warn("forgetBusiness: events scrub", scrubErr);
  }
  setTrackContext({ businessId: null, said: null, turnId: null });
  forgetBuffered(id);

  const { error } = await client.from("businesses").delete().eq("id", id);
  if (error) throw error;

  // A count, with nothing identifying in it, so "how many people asked?" can be
  // answered without keeping what they asked us to delete.
  await client.from("forget_log").insert({ country: row?.country ?? null }).then(
    (r) => void r,
    () => void 0,
  );
}

// ── Message log (both directions — the connector reads this as memory) ──

export async function recordMessage(
  businessId: string | null,
  direction: "in" | "out",
  text: string,
  extra: { kind?: string; waMessageId?: string; meta?: Record<string, unknown> } = {},
): Promise<void> {
  if (!businessId) return;
  try {
    // A person's message is recorded once, however many times its job runs:
    // a retried or reclaimed inbound job (jobctx.ts) re-runs handleInbound,
    // and used to write the same message into the conversation twice.
    if (direction === "in" && extra.waMessageId) {
      const { data: seen } = await db().from("messages").select("id").eq("wa_message_id", extra.waMessageId).eq("direction", "in").limit(1);
      if ((seen as unknown[] | null)?.length) return;
    }
    const { error } = await db().from("messages").insert({
      business_id: businessId,
      direction,
      text: (text || "").slice(0, 8000),
      kind: extra.kind ?? "text",
      wa_message_id: extra.waMessageId ?? null,
      meta: extra.meta ?? {},
    });
    // supabase-js reports a failed insert as {error}, not a throw.
    if (error) throw new Error(error.message ?? String(error));
    // The nudge writer decides partly on "when did we last speak", so the
    // outbound side of the conversation has to move that marker as well.
    if (direction === "out") {
      await db().from("businesses").update({ last_outbound_at: new Date().toISOString() }).eq("id", businessId);
    }
  } catch (err) {
    // A message log failure must never take down a live conversation.
    console.error("recordMessage failed", err);
  }
}

/** The conversation-log kind of a web sign-in code (api/plan.ts, via sendText). */
export const LOGIN_CODE_KIND = "login_code";

/**
 * A row that is (or was) a one-time sign-in code. New ones carry the kind;
 * rows from before 2026-09-25 are plain "text" and are recognised by their
 * wording — the bare six digits, or the earlier "Your Fin code is NNNNNN".
 * Outbound only: a person typing six digits at Fin is conversation.
 */
export function isLoginCodeRow(m: { direction: string; text: string; kind?: string | null }): boolean {
  if (m.kind === LOGIN_CODE_KIND) return true;
  if (m.direction !== "out") return false;
  const t = (m.text ?? "").trim();
  return /^\d{6}$/.test(t) || /Your Fin code is \d{6}/.test(t);
}

/**
 * The last `limit` turns of the conversation, oldest first — what the prompts
 * show as RECENT CONVERSATION and the person's AI gets as recent_whatsapp.
 * Sign-in codes are never part of it: the tester read real codes out of this
 * table (live, 2026-09-25), and everything that reads the conversation as
 * memory would otherwise hand them to a model, to the person's AI on their
 * laptop, or to whoever else reads that AI's context. The rows themselves stay
 * in the table (the live verifier reads a code back by kind to sign in with a
 * synthetic number); they just never travel. A few extra rows are read so the
 * filter does not shorten the memory.
 */
export async function recentMessages(businessId: string, limit = 12): Promise<{ direction: string; text: string; kind?: string | null }[]> {
  const { data } = await db()
    .from("messages")
    .select("direction, text, kind")
    .eq("business_id", businessId)
    .neq("kind", LOGIN_CODE_KIND)
    .order("id", { ascending: false })
    .limit(limit + 10);
  return ((data as { direction: string; text: string; kind?: string | null }[]) ?? [])
    .filter((m) => !isLoginCodeRow(m))
    .slice(0, limit)
    .map((m) => ({ direction: m.direction, text: m.text, kind: m.kind ?? null }))
    .reverse();
}

/** The single most recent thing Fin said, and when — used to coalesce a
 * burst of stale messages into one apology instead of one per message. */
export async function lastOutboundMessage(businessId: string): Promise<{ text: string; createdAt: string } | null> {
  const { data } = await db()
    .from("messages")
    .select("text, created_at")
    .eq("business_id", businessId)
    .eq("direction", "out")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = data as { text: string; created_at: string } | null;
  return row ? { text: row.text, createdAt: row.created_at } : null;
}

// ── Inbound de-duplication ───────────────────────────────────────

/**
 * Meta retries any webhook it does not get a fast 200 for. Without this, one
 * message could build two plans. Returns true when this id is new.
 */
export async function claimInbound(waMessageId: string, waId: string): Promise<boolean> {
  const { error } = await db().from("wa_inbound").insert({ wa_message_id: waMessageId, wa_id: waId });
  if (!error) return true;
  // 23505 = unique violation: we have already handled this exact message.
  if ((error as { code?: string }).code === "23505") return false;
  throw error;
}

// ── Jobs ─────────────────────────────────────────────────────────

export async function enqueue(job: {
  kind: JobRow["kind"];
  businessId?: string | null;
  waId?: string | null;
  payload?: Record<string, unknown>;
  runAfterSeconds?: number;
  maxAttempts?: number;
}): Promise<number> {
  const runAfter = new Date(Date.now() + (job.runAfterSeconds ?? 0) * 1000).toISOString();
  const { data, error } = await db()
    .from("jobs")
    .insert({
      kind: job.kind,
      business_id: job.businessId ?? null,
      wa_id: job.waId ?? null,
      payload: job.payload ?? {},
      run_after: runAfter,
      // Written out rather than left to the column defaults: these three decide
      // whether the job is ever picked up and how many times it may fail, which
      // is too important to be invisible at the call site.
      status: "queued",
      attempts: 0,
      max_attempts: job.maxAttempts ?? 3,
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: number }).id;
}

/** Atomic: two workers waking at once can never claim the same row. */
export async function claimJob(worker: string): Promise<JobRow | null> {
  const { data, error } = await db().rpc("claim_job", { p_worker: worker });
  if (error) throw error;
  const rows = (data as JobRow[]) ?? [];
  return rows[0] ?? null;
}

/**
 * Is another worker already handling this owner?
 *
 * Two drains can be live at once — the webhook's own invocation and a sweep —
 * and each claims independently. Without this, two messages from the same owner
 * can be processed concurrently and interleave their writes: the second
 * overwrites `stage` with a value computed from the state the first has already
 * moved past, and the conversation jumps backwards. Messages from DIFFERENT
 * people are genuinely independent and still run in parallel.
 */
export async function otherJobRunningFor(waId: string, exceptJobId: number): Promise<boolean> {
  if (!waId) return false;
  const { data } = await db()
    .from("jobs")
    .select("id, locked_at")
    .eq("wa_id", waId)
    .eq("status", "running");
  const rows = (data as { id: number; locked_at: string | null }[]) ?? [];
  const stale = Date.now() - 5 * 60_000;
  return rows.some((r) => r.id !== exceptJobId && new Date(r.locked_at ?? 0).getTime() > stale);
}

export async function finishJob(id: number, status: "done" | "failed" | "dead", lastError?: string, worker?: string): Promise<void> {
  // With `worker`, only the attempt that still holds the job can close it: a
  // fenced-off attempt must not mark done a job another worker is running.
  let q = db().from("jobs").update({ status, last_error: lastError ?? null, updated_at: new Date().toISOString() }).eq("id", id);
  if (worker) q = q.eq("locked_by", worker);
  await q;
}

/** Heartbeat: a job that is still being worked on keeps its lock fresh, so the sweep never takes it for abandoned. */
export async function touchJob(id: number, worker: string): Promise<void> {
  await db().from("jobs").update({ locked_at: new Date().toISOString() }).eq("id", id).eq("locked_by", worker).eq("status", "running");
}

/** The fencing check: is this job still running under this worker's claim? */
export async function stillOwnJob(id: number, worker: string): Promise<boolean> {
  const { data, error } = await db().from("jobs").select("status, locked_by").eq("id", id).maybeSingle();
  // On a read failure, don't silence a reply that may be the only one: the
  // heartbeat is the main defence; this is the second.
  if (error || !data) return true;
  const row = data as { status: string; locked_by: string | null };
  // "queued" with this worker's claim still on it: the overrun guard queued
  // the next attempt but left this late one free to finish (requeueOverrun).
  return (row.status === "running" || row.status === "queued") && row.locked_by === worker;
}

/**
 * Put a job back without counting the attempt.
 *
 * Used when the job was not tried at all — it was claimed and immediately
 * handed back because another worker had the same owner. Counting that as a
 * failed attempt would let a chatty owner exhaust max_attempts and get an
 * apology for a message nothing was ever wrong with.
 */
export async function holdJob(id: number, attempts: number, reason: string, delayMs = 5_000): Promise<void> {
  await db()
    .from("jobs")
    .update({
      status: "queued",
      attempts: Math.max(0, attempts - 1),
      run_after: new Date(Date.now() + delayMs).toISOString(),
      last_error: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
}

/**
 * Failed but retriable: back off exponentially rather than hammering, with
 * up to as much again at random on top (at most 15s more). Round 22: five
 * build stages that failed together were retried within 18 seconds of each
 * other, into the same congested provider.
 */
export async function retryJob(id: number, attempts: number, lastError: string, worker?: string): Promise<void> {
  const base = Math.min(600, 5 * 2 ** attempts);
  const delaySeconds = base + Math.random() * Math.min(base, 15);
  let q = db()
    .from("jobs")
    .update({
      status: "queued",
      run_after: new Date(Date.now() + delaySeconds * 1000).toISOString(),
      last_error: lastError.slice(0, 2000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  // Only the attempt that holds the job can put it back (see finishJob).
  if (worker) q = q.eq("locked_by", worker);
  await q;
}

// ── Resumable plan builds ────────────────────────────────────────
//
// See db/0012_plan_build_stages.sql for why this table exists: the old
// build ran five or six model calls back to back inside one job, so a slow
// call anywhere, or a Vercel timeout, meant redoing the whole thing. Each
// phase now reads and writes this row instead of local variables, so a
// retry resumes from `stage`, never from "context" again.

export async function getPlanBuild(businessId: string): Promise<PlanBuildRow | null> {
  const { data, error } = await db().from("plan_builds").select("*").eq("business_id", businessId).maybeSingle();
  if (error) throw error;
  return (data as PlanBuildRow) ?? null;
}

/** Starts a build at "context" — also how a fully-failed build is restarted. */
export async function resetPlanBuild(businessId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db()
    .from("plan_builds")
    .upsert(
      {
        business_id: businessId,
        stage: "context",
        goal: null,
        context: null,
        map: null,
        dropped_modules: [],
        strategy: null,
        strategy_done: false,
        workstreams: [],
        pending_workstreams: [],
        plan_id: null,
        last_error: null,
        heartbeat_at: now,
        // Reset on every restart, not just the first insert: it is the start
        // of THIS attempt, which recordPlanBuildTiming measures from.
        created_at: now,
        updated_at: now,
      },
      { onConflict: "business_id" },
    );
  if (error) throw error;
}

/**
 * Where a FAILED build can pick up again, read from what it already saved —
 * never from zero when the expensive work is sitting in the row. Null means
 * there is nothing worth keeping (it died in "context"): start over.
 */
export function resumePointFor(pb: PlanBuildRow): "building" | "finalize" | "pdf" | null {
  if (!pb.context) return null;
  if (pb.plan_id) return "pdf";
  if (pb.strategy_done && !pb.pending_workstreams.length) return "finalize";
  return "building";
}

/** Puts a failed build back to the stage its saved work allows. Only a "failed" row moves. */
export async function revivePlanBuildRow(businessId: string, stage: "context" | "building" | "finalize" | "pdf", note: string): Promise<boolean> {
  const { data, error } = await db()
    .from("plan_builds")
    .update({ stage, last_error: note.slice(0, 2000), heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("stage", "failed")
    .select("business_id");
  if (error) throw error;
  return Boolean((data as unknown[] | null)?.length);
}

/**
 * Failed builds nobody has come back to: the person was told to "send anything",
 * and some never do — they sat on "building_plan" for good. Each gets ONE
 * automatic retry, marked in last_error so it can never loop.
 */
export const AUTO_RETRIED = "[auto-retried]";
export async function failedBuildsToRetry(olderThanMs = 10 * 60_000): Promise<PlanBuildRow[]> {
  const { data, error } = await db()
    .from("plan_builds")
    .select("*")
    .eq("stage", "failed")
    .lt("updated_at", new Date(Date.now() - olderThanMs).toISOString());
  if (error || !data) return [];
  return (data as PlanBuildRow[]).filter((r) => !(r.last_error ?? "").includes(AUTO_RETRIED));
}

export async function heartbeatPlanBuild(businessId: string): Promise<void> {
  await db().from("plan_builds").update({ heartbeat_at: new Date().toISOString() }).eq("business_id", businessId);
}

/** Context stage's output. Only takes effect once — a duplicate/late job no-ops. */
export async function saveContextStage(
  businessId: string,
  patch: { goal: string; context: HouseholdContext; map: MapEntry[]; droppedModules: string[]; workstreamIds: string[] },
): Promise<boolean> {
  const { data, error } = await db()
    .from("plan_builds")
    .update({
      stage: "building",
      goal: patch.goal,
      context: patch.context,
      map: patch.map,
      dropped_modules: patch.droppedModules,
      pending_workstreams: patch.workstreamIds,
      heartbeat_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("business_id", businessId)
    .eq("stage", "context")
    .select("business_id");
  if (error) throw error;
  return ((data as unknown[]) ?? []).length > 0;
}

/** `strategy` is legitimately null when the narrative failed to write — still "done". */
/**
 * The strategy lane is finished — with a strategy, or with a recorded reason
 * why not. `strategy_done` means "stop waiting for this lane", never "it
 * worked": a null strategy always comes with `failure`, written to
 * last_error so a finished build with no strategy is never silent again.
 */
export async function saveStrategyStage(businessId: string, strategy: Strategy | null, failure: string | null = null): Promise<boolean> {
  if (!strategy && !failure) failure = "strategy missing: no strategy and no reason given";
  const { data, error } = await db()
    .from("plan_builds")
    .update({ strategy, strategy_done: true, ...(failure ? { last_error: failure } : {}), heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("stage", "building")
    .select("business_id");
  if (error) throw new Error(`saveStrategyStage: ${error.message}`);
  // False once the build was handed over without it (handOverPlanBuild).
  return Boolean((data as unknown[] | null)?.length);
}

/**
 * Records one finished workstream and drops it from the pending list.
 *
 * Read-modify-write, not a SQL array append: callers save results ONE AT A
 * TIME, in sequence, even though the model calls that produced them ran
 * concurrently — see runWorkstreamsStage in engine/planbuild.ts. Two
 * concurrent writers here would race on this same read-modify-write and one
 * completed workstream would silently overwrite another.
 */
export async function saveWorkstreamResult(businessId: string, workstreamId: string, hydrated: HydratedWorkstream): Promise<boolean> {
  const pb = await getPlanBuild(businessId);
  if (!pb || pb.stage !== "building" || !pb.pending_workstreams.includes(workstreamId)) return false;
  const { data } = await db()
    .from("plan_builds")
    .update({
      workstreams: [...pb.workstreams, hydrated],
      pending_workstreams: pb.pending_workstreams.filter((id) => id !== workstreamId),
      heartbeat_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("business_id", businessId)
    .eq("stage", "building")
    .select("business_id");
  return Boolean((data as unknown[] | null)?.length);
}

// ── The hand-over deadline (engine/planbuild.ts handOverOverdueBuilds) ──

/** Builds still in "building" that began before `cutoff`. */
export async function overdueBuilds(cutoff: string): Promise<{ business_id: string }[]> {
  const { data, error } = await db().from("plan_builds").select("business_id").eq("stage", "building").lt("created_at", cutoff);
  if (error) throw error;
  return (data as { business_id: string }[] | null) ?? [];
}

/**
 * Moves a build on to "finalize" with what it has: the parts not yet
 * tailored in library wording (`workstreams` already carries them), the
 * strategy lane closed whether or not it is written. Only the row exactly as
 * it was read (`seenUpdatedAt`): a part or the strategy saved in between
 * changes `updated_at`, the update matches nothing, and the caller reads
 * again — a tailored part is never overwritten by its library wording.
 */
export async function handOverPlanBuild(businessId: string, seenUpdatedAt: string | undefined, patch: { workstreams: HydratedWorkstream[]; note: string }): Promise<boolean> {
  const now = new Date().toISOString();
  let q = db()
    .from("plan_builds")
    .update({ stage: "finalize", workstreams: patch.workstreams, pending_workstreams: [], strategy_done: true, last_error: patch.note.slice(0, 2000), heartbeat_at: now, updated_at: now })
    .eq("business_id", businessId)
    .eq("stage", "building");
  if (seenUpdatedAt) q = q.eq("updated_at", seenUpdatedAt);
  const { data, error } = await q.select("business_id");
  if (error) throw error;
  return Boolean((data as unknown[] | null)?.length);
}

/**
 * The strategy, finished by its own lane after the build was handed over
 * without it: kept in the same build's row (never a newer build's: a rebuild
 * resets `created_at`), and in the plan if it is written already and still
 * has none. The plan repair (engine/repair.ts) finds it there and uses it
 * instead of writing another.
 */
export async function adoptLateStrategy(businessId: string, builtAt: string | undefined, strategy: Strategy): Promise<boolean> {
  if (!builtAt) return false;
  const { data, error } = await db()
    .from("plan_builds")
    .update({ strategy, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("created_at", builtAt)
    .in("stage", ["finalize", "pdf", "done"])
    .is("strategy", null)
    .select("plan_id");
  if (error) throw error;
  const row = (data as { plan_id: string | null }[] | null)?.[0];
  if (!row) return false;
  if (row.plan_id) await db().from("plans").update({ strategy }).eq("id", row.plan_id).is("strategy", null);
  return true;
}

/**
 * A part tailored by its own lane after the build was handed over with it in
 * library wording: kept beside that wording (`late`), which is what the plan
 * was written from and what the hand-over named, for the repair to use.
 */
export async function adoptLatePart(businessId: string, builtAt: string | undefined, part: HydratedWorkstream): Promise<boolean> {
  if (!builtAt || part.untailored) return false;
  for (let i = 0; i < 3; i++) {
    const pb = await getPlanBuild(businessId);
    if (!pb || pb.created_at !== builtAt || !["finalize", "pdf", "done"].includes(pb.stage)) return false;
    const was = pb.workstreams.find((w) => w.id === part.id);
    if (!was?.untailored || was.late) return false;
    const { late: _late, ...clean } = part;
    let q = db()
      .from("plan_builds")
      .update({ workstreams: pb.workstreams.map((w) => (w.id === part.id ? { ...w, late: clean } : w)), updated_at: new Date().toISOString() })
      .eq("business_id", businessId)
      .eq("created_at", builtAt);
    if (pb.updated_at) q = q.eq("updated_at", pb.updated_at);
    const { data, error } = await q.select("business_id");
    if (error) throw error;
    if ((data as unknown[] | null)?.length) return true;
  }
  return false;
}

/**
 * The join point: strategy and the workstreams finish independently, and
 * whichever finishes last is the one that should move the row on. The
 * conditional `.eq("stage", "building")` is what makes this safe if both
 * finish within moments of each other — Postgres serializes the two
 * UPDATEs, and the second one's WHERE clause fails to match once the first
 * has already flipped the stage, so at most one caller ever gets `true`.
 */
export async function tryAdvanceToFinalize(businessId: string): Promise<boolean> {
  const pb = await getPlanBuild(businessId);
  if (!pb || pb.stage !== "building" || pb.pending_workstreams.length || !pb.strategy_done) return false;
  const { data, error } = await db()
    .from("plan_builds")
    .update({ stage: "finalize", heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("stage", "building")
    .select("business_id");
  if (error) throw error;
  return ((data as unknown[]) ?? []).length > 0;
}

/** The plan and its steps are written; only the PDF is left. */
export async function saveFinalizeStage(businessId: string, planId: string): Promise<void> {
  await db()
    .from("plan_builds")
    .update({ stage: "pdf", plan_id: planId, heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("stage", "finalize");
}

/**
 * A repaired part (engine/repair.ts) written over the hand-over's version in
 * the finished build's row, so the build's record matches the stored plan.
 * Only while the row still belongs to that plan.
 */
export async function updatePlanBuildWorkstream(businessId: string, planId: string, part: HydratedWorkstream): Promise<void> {
  const pb = await getPlanBuild(businessId);
  if (!pb || pb.plan_id !== planId) return;
  const workstreams = pb.workstreams.map((w) => (w.id === part.id ? part : w));
  const { error } = await db().from("plan_builds").update({ workstreams, updated_at: new Date().toISOString() }).eq("business_id", businessId).eq("plan_id", planId);
  if (error) throw new Error(`updatePlanBuildWorkstream: ${error.message}`);
}

export async function finishPlanBuild(businessId: string): Promise<void> {
  await db()
    .from("plan_builds")
    .update({ stage: "done", heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("business_id", businessId);
}

export interface DeadJobSummary {
  id: number;
  kind: string;
  /** For a plan_build_stage job, which stage died. */
  step: string | null;
  attempts: number;
  created_at: string;
  died_at: string | null;
  /** First 150 characters, with any long digit run (a phone number) masked. */
  last_error: string | null;
  /** false when the person has since been forgotten; null when the job had no owner (freshness). */
  business_exists: boolean | null;
}

/**
 * Live, 2026-09-23: /api/health said queue.dead = 8 and nothing more. This is
 * what makes a dead job diagnosable from the authenticated health body alone
 * — kind, when, and why — without ever returning a person's words or number.
 * An inbound job carries a wa_id rather than a business_id, so existence is
 * looked up by it, and the wa_id itself never leaves this function.
 */
export async function recentDeadJobs(limit = 10): Promise<DeadJobSummary[]> {
  const { data, error } = await db()
    .from("jobs")
    .select("id, kind, business_id, wa_id, payload, attempts, last_error, created_at, updated_at")
    .eq("status", "dead")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const jobs = (data as (Pick<JobRow, "id" | "kind" | "business_id" | "wa_id" | "payload" | "attempts" | "last_error"> & { created_at: string; updated_at: string | null })[]) ?? [];
  if (!jobs.length) return [];

  const ids = [...new Set(jobs.map((j) => j.business_id).filter((v): v is string => Boolean(v)))];
  const waIds = [...new Set(jobs.filter((j) => !j.business_id && j.wa_id).map((j) => j.wa_id as string))];
  const [byId, byWa] = await Promise.all([
    ids.length ? db().from("businesses").select("id, deleted_at").in("id", ids) : Promise.resolve({ data: [] }),
    waIds.length ? db().from("businesses").select("wa_id, deleted_at").in("wa_id", waIds) : Promise.resolve({ data: [] }),
  ]);
  const liveIds = new Set(((byId.data as { id: string; deleted_at: string | null }[]) ?? []).filter((b) => !b.deleted_at).map((b) => b.id));
  const liveWa = new Set(((byWa.data as { wa_id: string; deleted_at: string | null }[]) ?? []).filter((b) => !b.deleted_at).map((b) => b.wa_id));

  return jobs.map((j) => ({
    id: j.id,
    kind: j.kind,
    step: j.kind === "plan_build_stage" ? String((j.payload as { step?: string } | null)?.step ?? "") || null : null,
    attempts: j.attempts,
    created_at: j.created_at,
    died_at: j.updated_at ?? null,
    // Any phone-number-shaped run, formatted or not ("+27 66 312 9297").
    last_error: j.last_error ? j.last_error.replace(/\+?\d[\d\s().-]{7,}\d/g, "[number]").slice(0, 150) : null,
    business_exists: j.business_id ? liveIds.has(j.business_id) : j.wa_id ? liveWa.has(j.wa_id) : null,
  }));
}

const BUILD_STEPS: PlanBuildStep[] = ["context", "strategy", "workstreams", "finalize", "pdf"];

/**
 * Live, 2026-09-23: a plan build took over five minutes and nothing recorded
 * where the time went. Written once, when the build reaches "done", as a
 * safety_events row (check plan_build_timing — a note, not a guardrail; see
 * NOT_GUARDRAIL_CHECKS) so no migration is needed: `score` is the total in
 * seconds, `detail` the per-stage split.
 *
 * Total runs from plan_builds.created_at, which resetPlanBuild sets on every
 * (re)start. Each stage runs from its first job's enqueue to its last job's
 * finish, so queue wait and retries are counted — that is the time the person
 * actually waits. Strategy and workstreams overlap, so the stages do not sum
 * to the total. The pdf job is still running when this is called, so its
 * stage ends "now". Best effort: timing must never fail a finished build.
 */
export async function recordPlanBuildTiming(businessId: string, now = Date.now()): Promise<void> {
  try {
    const { data: pb } = await db().from("plan_builds").select("created_at, last_error").eq("business_id", businessId).maybeSingle();
    const startedAt = (pb as { created_at?: string } | null)?.created_at;
    const lastError = (pb as { last_error?: string | null } | null)?.last_error ?? null;
    if (!startedAt) return;
    const { data: jobsRaw } = await db()
      .from("jobs")
      .select("payload, attempts, created_at, updated_at, status")
      .eq("business_id", businessId)
      .eq("kind", "plan_build_stage")
      .gte("created_at", startedAt);
    const jobs = (jobsRaw as { payload: { step?: string } | null; attempts: number; created_at: string; updated_at: string | null; status: string }[] | null) ?? [];

    const secs = (ms: number) => Math.max(0, Math.round(ms / 1000));
    const total = secs(now - new Date(startedAt).getTime());
    const parts = [`total ${total}s`];
    for (const step of BUILD_STEPS) {
      const mine = jobs.filter((j) => j.payload?.step === step);
      if (!mine.length) continue;
      const from = Math.min(...mine.map((j) => new Date(j.created_at).getTime()));
      const to = Math.max(...mine.map((j) => (j.status === "done" && j.updated_at ? new Date(j.updated_at).getTime() : now)));
      const retries = mine.reduce((n, j) => n + Math.max(0, (j.attempts ?? 1) - 1), 0) + mine.length - 1;
      parts.push(`${step} ${secs(to - from)}s${retries > 0 ? ` (${retries} retr${retries === 1 ? "y" : "ies"})` : ""}`);
    }
    // "v2": built with the hand-on queue (queue.ts), so its time is a fair
    // sample for the wait people are told (eta.ts). "interrupted": it failed
    // or stalled and was revived on the way, so it is not.
    parts.push("v2");
    if (lastError) parts.push("interrupted");
    await recordSafetyEvent({ businessId, check: "plan_build_timing", engine: "none", outcome: "pass", score: total, detail: parts.join("; ") });
  } catch (err) {
    console.warn("recordPlanBuildTiming failed", err);
  }
}

/**
 * Work still waiting after a drain: how many queued jobs can run now, and how
 * soon the next one becomes runnable (a retry's backoff, a short hold). The
 * drain uses it to hand on to a fresh worker instead of leaving the rest of a
 * plan build to whoever messages next (founder, 2026-09-24: "it takes forever
 * for a report to come").
 */
export async function queuedWorkDue(withinMs: number, now = Date.now()): Promise<{ ready: number; soonestMs: number | null; nextMs: number | null }> {
  const { data, error } = await db()
    .from("jobs")
    .select("run_after")
    .eq("status", "queued")
    .lt("run_after", new Date(now + withinMs).toISOString())
    .order("run_after", { ascending: true })
    .limit(50);
  if (error) throw error;
  const due = ((data as { run_after: string }[] | null) ?? []).map((r) => new Date(r.run_after).getTime() - now);
  const future = due.filter((ms) => ms > 0);
  // ready counts rows claim_job may still refuse (a person's later message
  // waits behind their earlier one), so callers must not treat "ready" as
  // "claimable"; nextMs is the soonest job that is not due yet.
  return {
    ready: due.filter((ms) => ms <= 0).length,
    soonestMs: due.length ? Math.max(0, Math.min(...due)) : null,
    nextMs: future.length ? Math.min(...future) : null,
  };
}

/**
 * How long this usually takes, in seconds, from the timing rows each run
 * leaves (plan_build_timing, readback_timing) — the figure a person is told
 * (eta.ts). Only fair samples count: plan builds from the hand-on pipeline
 * ("v2") that were never interrupted or retried, and read-backs that were
 * actually sent. Fewer than five fair samples → null ("a few minutes"); under
 * eight, the median, so one slow run never sets the number; otherwise the
 * 75th percentile, so most people get it sooner than they were told.
 */
export async function typicalSeconds(check: "plan_build_timing" | "readback_timing", opts: { days?: number; limit?: number; min?: number } = {}): Promise<number | null> {
  const since = new Date(Date.now() - (opts.days ?? 14) * 864e5).toISOString();
  const { data, error } = await db()
    .from("safety_events")
    .select("score, detail, created_at")
    .eq("check_name", check)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 40);
  if (error) return null;
  const fair = (d: string) =>
    check === "plan_build_timing" ? /\bv2\b/.test(d) && !/interrupted|retr/.test(d) : /; sent\b/.test(d);
  const secs = ((data as { score: number | null; detail: string | null }[] | null) ?? [])
    .filter((r) => fair(r.detail ?? ""))
    .slice(0, 20)
    .map((r) => Number(r.score))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (secs.length < (opts.min ?? 5)) return null;
  const q = secs.length < 8 ? 0.5 : 0.75;
  return secs[Math.min(secs.length - 1, Math.ceil(secs.length * q) - 1)]!;
}

/**
 * Is a stage of this owner's plan build actually queued or running? The jobs
 * table knows: a running job's lock is refreshed every 30 seconds by the
 * drain's heartbeat, while plan_builds.heartbeat_at only moves between model
 * calls — so a slow stage looked stalled, and a person asking "how long?" got
 * "Picking that back up now" instead of an answer. Queued counts: the
 * owner's own message is draining the queue right now.
 */
export async function planBuildStageInFlight(businessId: string, now = Date.now()): Promise<boolean> {
  return jobInFlight(businessId, "plan_build_stage", now);
}

/**
 * Is the customer-options job for this read-back still queued or running?
 * Read at the "That's right" tap (engine/build.ts showGoalOptions):
 * options still on their way get an honest holding line, and only a job
 * that is genuinely gone (done, dead, or its lock long stale) is redone
 * inline — so the options are never generated twice at once. `token` is the
 * read-back's options token: a job left over from a read-back the person has
 * since corrected is not "the options on their way", because it can never
 * store what it writes (storeGoalOptions).
 */
export async function goalOptionsInFlight(businessId: string, token: string | null, now = Date.now()): Promise<boolean> {
  const { data, error } = await db()
    .from("jobs")
    .select("status, locked_at, payload")
    .eq("business_id", businessId)
    .eq("kind", "goal_options")
    .in("status", ["queued", "running"]);
  if (error) throw error;
  const fresh = new Date(now - 5 * 60_000).toISOString();
  return ((data as { status: string; locked_at: string | null; payload: { token?: string } | null }[] | null) ?? []).some(
    (r) => (r.payload?.token ?? null) === token && (r.status === "queued" || (r.locked_at ?? "") >= fresh),
  );
}

async function jobInFlight(businessId: string, kind: JobRow["kind"], now: number): Promise<boolean> {
  const { data, error } = await db()
    .from("jobs")
    .select("status, locked_at")
    .eq("business_id", businessId)
    .eq("kind", kind)
    .in("status", ["queued", "running"]);
  if (error) throw error;
  const fresh = new Date(now - 5 * 60_000).toISOString();
  return ((data as { status: string; locked_at: string | null }[] | null) ?? []).some((r) => r.status === "queued" || (r.locked_at ?? "") >= fresh);
}

/** The job that ran this stage has exhausted its own retries — see queue.ts. */
export async function failPlanBuild(businessId: string, error: string): Promise<void> {
  // Keep the one-automatic-retry marker across a second failure, or the
  // sweep would retry a build that fails every time, forever.
  const prev = (await getPlanBuild(businessId).catch(() => null))?.last_error ?? "";
  const kept = prev.includes(AUTO_RETRIED) && !error.includes(AUTO_RETRIED) ? `${AUTO_RETRIED} ${error}` : error;
  // Never a finished build: a lane's job that dies after the hand-over
  // (engine/planbuild.ts) must not mark the plan the person has as failed.
  await db()
    .from("plan_builds")
    .update({ stage: "failed", last_error: kept.slice(0, 2000), heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .neq("stage", "done");
}

/**
 * Enqueues a stage job, unless one is already queued or running for this
 * exact step — called from three places (starting a build, resuming a
 * stalled one, and the opportunistic sweep below), any of which could
 * otherwise race and pile up a duplicate.
 */
/**
 * Queues a follow-up for one plan (plan_repair, plan_pdf) unless one is
 * already waiting for it: a PDF stage run twice (an overrun, a fenced
 * attempt) must not queue two repairs or two PDFs.
 */
export async function enqueueForPlan(kind: "plan_repair" | "plan_pdf", businessId: string, planId: string, payload: Record<string, unknown>, runAfterSeconds: number): Promise<void> {
  const { data } = await db().from("jobs").select("id, payload").eq("business_id", businessId).eq("kind", kind).in("status", ["queued", "running"]);
  if (((data as { payload: { plan_id?: string } }[]) ?? []).some((j) => j.payload?.plan_id === planId)) return;
  await enqueue({ kind, businessId, payload: { ...payload, plan_id: planId }, runAfterSeconds });
}

/**
 * Is the build's own strategy or workstreams job still at work for this
 * business? A plan repair waits for it (engine/repair.ts): what it finishes
 * after the hand-over deadline is used, not paid for twice.
 */
export async function buildLanesRunning(businessId: string): Promise<boolean> {
  const { data } = await db().from("jobs").select("id, payload").eq("business_id", businessId).eq("kind", "plan_build_stage").eq("status", "running");
  return ((data as { payload: { step?: string } | null }[] | null) ?? []).some((j) => j.payload?.step === "strategy" || j.payload?.step === "workstreams");
}

/** Is a plan repair queued or running that will write this plan's missing strategy? (plandoc.ts strategyPending) */
export async function strategyRepairPending(businessId: string, planId: string): Promise<boolean> {
  const { data } = await db().from("jobs").select("payload").eq("business_id", businessId).eq("kind", "plan_repair").in("status", ["queued", "running"]);
  return ((data as { payload: { plan_id?: string; strategy?: boolean; strategy_done?: boolean } | null }[] | null) ?? []).some(
    (j) => j.payload?.plan_id === planId && j.payload.strategy === true && j.payload.strategy_done !== true,
  );
}

/**
 * A plan repair that put itself on hold (engine/repair.ts: waiting for a
 * build lane, or for the hand-over) runs now that what it waited for is
 * done. Only a held one: a repair still on its first short delay keeps it.
 */
export async function wakeHeldRepair(businessId: string): Promise<void> {
  const { data } = await db().from("jobs").select("id, last_error").eq("business_id", businessId).eq("kind", "plan_repair").eq("status", "queued");
  const held = ((data as { id: number; last_error: string | null }[] | null) ?? []).filter((j) => (j.last_error ?? "").startsWith(REPAIR_HELD));
  for (const j of held) await db().from("jobs").update({ run_after: new Date().toISOString() }).eq("id", j.id).eq("status", "queued");
}
/** How a plan repair's hold reason begins (engine/repair.ts), so wakeHeldRepair finds it. */
export const REPAIR_HELD = "plan repair: waiting";

export async function enqueuePlanBuildStage(businessId: string, step: PlanBuildStep): Promise<void> {
  const { data } = await db().from("jobs").select("id, payload").eq("business_id", businessId).eq("kind", "plan_build_stage").in("status", ["queued", "running"]);
  const already = ((data as { payload: { step?: string } }[]) ?? []).some((j) => j.payload?.step === step);
  if (already) return;
  await enqueue({ kind: "plan_build_stage", businessId, payload: { step } });
}

/**
 * Enqueues the customer-options job that follows a sent read-back
 * (engine/build.ts), for that read-back's options token.
 *
 * Keyed on the business ONLY — never the person's wa_id. Review of the
 * read-back split (2026-09-25): with the wa_id on it, claim_job's per-owner
 * ordering (db/0013) held the person's very next message behind the options
 * generation — a "That's right" tap got silence instead of the holding line,
 * and a "Not quite" waited out options for a business the person had just
 * said was wrong. The person's messages now run straight away; what keeps
 * the options honest is the token (storeGoalOptions), not the queue.
 *
 * A queued job for an EARLIER token (a read-back since corrected) is retired
 * here, so it never spends a model call on a business that no longer
 * exists. A job already queued or running for THIS token is not doubled — a
 * fenced-off attempt (jobctx.ts) re-running the read-back cannot queue a
 * second generation.
 */
export async function enqueueGoalOptions(businessId: string, token: string): Promise<boolean> {
  const { data } = await db()
    .from("jobs")
    .select("id, status, payload")
    .eq("business_id", businessId)
    .eq("kind", "goal_options")
    .in("status", ["queued", "running"]);
  const live = (data as { id: number; status: string; payload: { token?: string } | null }[] | null) ?? [];
  for (const j of live) {
    if ((j.payload?.token ?? null) !== token && j.status === "queued") {
      await db().from("jobs").update({ status: "done", last_error: "superseded by a corrected read-back" }).eq("id", j.id).eq("status", "queued");
    }
  }
  if (live.some((j) => (j.payload?.token ?? null) === token)) return false;
  await enqueue({ kind: "goal_options", businessId, payload: { token } });
  return true;
}

/**
 * Stores a generation of customer options, but only if the read-back it was
 * generated for is still the live one: the business still at
 * confirm_identity, still carrying the same options token. One conditional
 * UPDATE, so a correction ("Not quite", a typed correction, an answer to the
 * doubt question) that lands while call B is running always wins — the
 * stale options are thrown away, never stored or shown. Returns whether
 * they were stored.
 */
export async function storeGoalOptions(
  businessId: string,
  token: string,
  pending: { options: unknown[]; recommend: string },
  signals: unknown,
): Promise<boolean> {
  const { data, error } = await db()
    .from("businesses")
    .update({ signals, pending_goal_options: { ...pending, token }, updated_at: new Date().toISOString() })
    .eq("id", businessId)
    .eq("stage", "confirm_identity")
    .eq("pending_goal_options->>token", token)
    .select("id");
  if (error) throw error;
  return ((data as unknown[] | null) ?? []).length > 0;
}

/**
 * Moves the business from confirm_identity to choose_goal, once. The
 * options can be sent from two places — the person's tap, or the job that
 * finished after the person was told to wait — and both can see them stored
 * at nearly the same moment. Only the caller that wins this conditional
 * UPDATE sends them, so the person never gets the cards twice. With a token,
 * it also refuses if the read-back was corrected in the meantime.
 */
export async function claimGoalOptionsDelivery(businessId: string, token: string | null): Promise<boolean> {
  let q = db()
    .from("businesses")
    .update({ stage: "choose_goal", pending_action: null, updated_at: new Date().toISOString() })
    .eq("id", businessId)
    .eq("stage", "confirm_identity");
  if (token) q = q.eq("pending_goal_options->>token", token);
  const { data, error } = await q.select("id");
  if (error) throw error;
  return ((data as unknown[] | null) ?? []).length > 0;
}

// ── The watchdog ────────────────────────────────────────────────
//
// Live test, round 13: two plan-build jobs sat "running", attempts 1,
// last_error null, for 9 and 13 minutes. The function running each had died
// without a word, and the only things that reclaim a dead job — a drain
// starting (reclaimStalePlanBuilds; claim_job's 5-minute lock expiry) — only
// happen when a message arrives or a live worker hands on. With the dead
// function the only worker, nothing arrived until the tester sent "hi".
//
// So while work is in flight, one small "watchdog" job keeps itself queued a
// short way ahead. Every drain that ends with work due soon hands on to a
// fresh worker (queue.ts handOn), so the watchdog is always picked up by a
// function OTHER than the one that may die; it reclaims what went quiet and
// queues the next watchdog, and the chain stops when nothing is in flight.

/** How far ahead the next watchdog is queued. Inside handOn's 60s look-ahead. */
export const WATCHDOG_EVERY_S = 45;

/** Is anything in flight: a plan build not finished, or a job (other than a watchdog) queued or running? */
export async function workInFlight(): Promise<boolean> {
  const { data: builds } = await db().from("plan_builds").select("business_id").in("stage", ["context", "building", "finalize", "pdf"]).limit(1);
  if (builds?.length) return true;
  const { data: jobs } = await db().from("jobs").select("id").in("status", ["queued", "running"]).neq("kind", "watchdog").limit(1);
  return Boolean(jobs?.length);
}

/**
 * Queue a watchdog unless one is already queued or running (other than
 * `exceptId`, the one calling this from inside its own run). True if one was
 * queued. Two workers racing may queue two; the next run of each finds the
 * other and stops, so the chain never multiplies.
 */
export async function ensureWatchdog(exceptId?: number): Promise<boolean> {
  // From inside a watchdog's own run, only a QUEUED one counts as the next
  // link. Live test, round 14: two watchdogs running at the same moment
  // each saw the other "running", neither queued a successor, and the chain
  // ended — a dead plan-build stage then sat 47 minutes with nobody
  // watching. Two queued at once is harmless: the first to run finds the
  // other queued and stops, so the chain converges back to one.
  let q = db().from("jobs").select("id").eq("kind", "watchdog").in("status", exceptId !== undefined ? ["queued"] : ["queued", "running"]);
  if (exceptId !== undefined) q = q.neq("id", exceptId);
  const { data } = await q.limit(1);
  if (data?.length) return false;
  await enqueue({ kind: "watchdog", runAfterSeconds: WATCHDOG_EVERY_S, maxAttempts: 1 });
  return true;
}

/**
 * The queued watchdog, if any: the dedicated watch runner (queue.ts runWatch)
 * claims THIS job by id rather than through claim_job, so it can never pick
 * up a build stage instead and hang on it (round 15).
 */
export async function nextWatchdog(): Promise<{ id: number; run_after: string } | null> {
  const { data } = await db().from("jobs").select("id, run_after").eq("kind", "watchdog").eq("status", "queued").order("run_after", { ascending: true }).limit(1);
  return ((data as { id: number; run_after: string }[] | null) ?? [])[0] ?? null;
}

/** Claim one queued job by id. True only for the caller that flipped it from queued to running. */
export async function claimJobById(id: number, worker: string): Promise<boolean> {
  const { data } = await db()
    .from("jobs")
    .update({ status: "running", locked_by: worker, locked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "queued")
    .select("id");
  return Boolean((data as unknown[] | null)?.length);
}

/**
 * A job still "running" whose lock nobody has touched for `ms` belongs to a
 * function that died: the heartbeat (queue.ts) touches a live one every 30
 * seconds. Put it back in the queue for a fresh worker, with its attempts
 * kept. claim_job does the same after 5 minutes, but only when a drain runs
 * — which is exactly what does not happen when the person has stepped away.
 */
export async function requeueStaleRunning(ms = STALE_RUNNING_MS): Promise<number> {
  const cutoff = new Date(Date.now() - ms).toISOString();
  const { data } = await db()
    .from("jobs")
    .update({ status: "queued", locked_by: null, run_after: new Date().toISOString(), last_error: "requeued by the watchdog: its worker went silent", updated_at: new Date().toISOString() })
    .eq("status", "running")
    .neq("kind", "watchdog")
    .lt("locked_at", cutoff)
    .select("id, kind, business_id, attempts, payload");
  const rows = (data as { id: number; kind: string; business_id: string | null; attempts: number; payload: Record<string, unknown> | null }[] | null) ?? [];
  // Each one is a worker that died mid-job — the stall pattern behind every
  // slow plan build so far (round 19: KE's workstreams stage, four times).
  // One event each, naming what died and on which attempt, so the next stall
  // says where it is instead of only that it happened. A person was waiting
  // on all of these but a nudge or a freshness sweep.
  for (const r of rows) {
    // kept_question too: it is keyed on the person's number, so while it
    // sits dead, every message they send waits behind it.
    const ownerWaiting = r.kind === "plan_build_stage" || r.kind === "inbound" || r.kind === "goal_options" || r.kind === "kept_question";
    track("job_went_silent", {
      category: "failure",
      severity: ownerWaiting ? "error" : "warn",
      alert: ownerWaiting ? "immediate" : "digest",
      businessId: r.business_id,
      props: { kind: r.kind, stage: typeof r.payload?.step === "string" ? r.payload.step : null, attempt: r.attempts, job_id: r.id },
      fingerprint: `job_went_silent:${r.kind}:${typeof r.payload?.step === "string" ? r.payload.step : ""}`,
      summary: `A ${r.kind.replace(/_/g, " ")}${typeof r.payload?.step === "string" ? ` (${r.payload.step})` : ""} job's worker went silent on attempt ${r.attempts}; the job was put back in the queue`,
    });
  }
  return rows.length;
}

/**
 * Three missed heartbeats (queue.ts beats every 30s), plus slack for one
 * touch held up by a slow database (DB_TIMEOUT_MS, 20s). Round 21: at 150s
 * against a one-minute beat, a killed KE stage was requeued 2.5 minutes
 * after it died, on top of the minutes it had already hung — every second
 * of it a person hearing nothing.
 */
export const STALE_RUNNING_MS = 100_000;

/**
 * Queues the next attempt of a job whose attempt overran its invocation's
 * hard stop (queue.ts drainQueue's overrun guard), so a stuck attempt is
 * picked up 35s later instead of after the kill plus the watchdog's wait.
 * Scoped to the attempt that holds it (`locked_by = worker`), so it can
 * never take a job some other worker already owns.
 *
 * It does NOT fence the late attempt: locked_by stays. An attempt that is
 * late but still finishing (a slow send, a PDF render) must be allowed to
 * finish — review, round 21: clearing locked_by made its finishJob a no-op,
 * so the queued copy ran again and the person got a second reply, or the
 * whole plan twice. Now its sends still pass stillOwnJob, and its finishJob
 * still matches and closes the job, so the copy never runs. An attempt that
 * is truly stuck is killed at 300s; run_after is 35s out (the guard fires at
 * ~290s), past the kill, so the two never overlap — and claim_job writes
 * the new worker into locked_by when the copy is claimed: that is the fence.
 * `attempts` is left alone: the attempt was spent.
 */
export async function requeueOverrun(id: number, worker: string): Promise<boolean> {
  const { data, error } = await db()
    .from("jobs")
    .update({
      status: "queued",
      run_after: new Date(Date.now() + 35_000).toISOString(),
      updated_at: new Date().toISOString(),
      last_error: "overran the invocation's hard stop; handed to a fresh worker",
    })
    .eq("id", id)
    .eq("locked_by", worker)
    .eq("status", "running")
    .select("id");
  if (error) throw error;
  return Boolean((data as unknown[] | null)?.length);
}

/**
 * Opportunistic reclaim, run at the top of every drain (api/_lib/queue.ts)
 * rather than on a schedule — Vercel Hobby cron cannot run more than once a
 * day, so ordinary traffic IS the schedule. A row whose heartbeat has gone
 * quiet longer than `ttlMs` is treated as abandoned and re-enqueued from
 * where it stopped, never restarted from "context".
 */
export async function reclaimStalePlanBuilds(ttlMs = 90_000): Promise<number> {
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  const { data, error } = await db()
    .from("plan_builds")
    .select("business_id, stage, pending_workstreams, strategy_done")
    .in("stage", ["context", "building", "finalize", "pdf"])
    .lt("heartbeat_at", cutoff);
  if (error || !data?.length) return 0;

  let n = 0;
  for (const row of data as Pick<PlanBuildRow, "business_id" | "stage" | "pending_workstreams" | "strategy_done">[]) {
    if (row.stage === "context" || row.stage === "finalize" || row.stage === "pdf") {
      await enqueuePlanBuildStage(row.business_id, row.stage);
      n++;
      continue;
    }
    // stage === "building": the join itself may have been missed if the
    // finisher died right after its own write — try it directly first.
    if (!row.pending_workstreams.length && row.strategy_done) {
      if (await tryAdvanceToFinalize(row.business_id)) await enqueuePlanBuildStage(row.business_id, "finalize");
      n++;
      continue;
    }
    if (row.pending_workstreams.length) await enqueuePlanBuildStage(row.business_id, "workstreams");
    if (!row.strategy_done) await enqueuePlanBuildStage(row.business_id, "strategy");
    n++;
  }
  return n;
}

// ── Knowledge and tools ──────────────────────────────────────────

export async function knowledgeFor(country: string): Promise<KnowledgeRow[]> {
  const { data } = await db().from("knowledge_entries").select("*").eq("country", country);
  return (data as KnowledgeRow[]) ?? [];
}

export async function toolsFor(country: string): Promise<ToolRow[]> {
  const { data } = await db().from("tools").select("*").eq("country", country);
  return (data as ToolRow[]) ?? [];
}

export async function toolById(id: string, country: string): Promise<ToolRow | null> {
  const { data } = await db().from("tools").select("*").eq("id", id).eq("country", country).maybeSingle();
  return (data as ToolRow) ?? null;
}

// ── Plans ────────────────────────────────────────────────────────

export async function planFor(businessId: string): Promise<{ plan: PlanRow; steps: PlanStepRow[] } | null> {
  const { data: plan } = await db()
    .from("plans")
    .select("*")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!plan) return null;
  const { data: steps } = await db().from("plan_steps").select("*").eq("plan_id", (plan as PlanRow).id).order("step_order");
  return { plan: plan as PlanRow, steps: (steps as PlanStepRow[]) ?? [] };
}

export async function updateStep(id: string, patch: Partial<PlanStepRow> & Record<string, unknown>): Promise<void> {
  const { error } = await db().from("plan_steps").update(patch).eq("id", id);
  if (error) throw error;
}

// ── Follow-through ───────────────────────────────────────────────

export async function addCommitment(businessId: string, what: string, due: string | null, source = "whatsapp", planStepId?: string | null): Promise<CommitmentRow | null> {
  const { data, error } = await db()
    .from("commitments")
    .insert({ business_id: businessId, what, due, source, plan_step_id: planStepId ?? null, status: "open" })
    .select()
    .single();
  if (error) {
    console.error("addCommitment failed", error);
    return null;
  }
  return data as CommitmentRow;
}

export async function openCommitments(businessId: string): Promise<CommitmentRow[]> {
  const { data } = await db().from("commitments").select("*").eq("business_id", businessId).eq("status", "open").order("due");
  return (data as CommitmentRow[]) ?? [];
}

export async function logDecision(businessId: string, what: string, why: string | null, source = "whatsapp"): Promise<void> {
  const { error } = await db().from("decisions").insert({ business_id: businessId, what, why, source });
  if (error) console.error("logDecision failed", error);
}

// ── What Fin remembers about the person ───────────────────────
//
// Notes about the PERSON, not the business facts in businesses.context: the
// time they have, who helps them, how they like to work, what worries them
// (db/0032). Written by the person's own AI (connector.ts remember) and by the
// memory step after a WhatsApp or web answer (engine/qa.ts updateMemory), and
// read back into every prompt (engine/context.ts) and the person's AI's
// context, so both doors know the same person. Never an ID, bank or card
// detail; deleted with the business. Memory is an improvement, not a
// dependency: a failed read is an empty list, never a failed answer.

export const NOTE_ABOUT = ["person", "situation", "preference", "constraint", "worry", "goal", "other"] as const;
export type NoteAbout = (typeof NOTE_ABOUT)[number];
export interface OwnerNote {
  id: string;
  about: NoteAbout;
  note: string;
  source: string;
  created_at: string;
}
/** The longest note kept: a sentence or two, in the person's terms. */
export const NOTE_MAX = 300;
/** More than this many and the oldest go: memory is for what still matters. */
export const NOTES_KEPT = 60;

/**
 * Until db/0032 runs, every answer would read a table that is not there and
 * file the same failure. Once it is found missing, reads stop for a while
 * (memory is empty either way) and start again by themselves.
 */
let notesMissingUntil = 0;
const NOTES_RECHECK_MS = 10 * 60_000;
/** Tests only: forget that the table was found missing. */
export function __resetNotesBackoff(): void {
  notesMissingUntil = 0;
}

/** A failed owner_notes read or write, said once per cause; a missing table names the migration. */
function notesFailed(phase: "read" | "write" | "delete", error: unknown): void {
  const e = (typeof error === "string" ? { message: error } : error && typeof error === "object" ? error : {}) as { code?: unknown; message?: unknown };
  const said = String(e.message ?? "");
  const missing = e.code === "PGRST205" || e.code === "42P01" || (/owner_notes/.test(said) && /not find|does not exist/i.test(said));
  if (missing) notesMissingUntil = Date.now() + NOTES_RECHECK_MS;
  trackFailure("owner_notes_failed", `${e.code ? `${String(e.code)}: ` : ""}${String(e.message ?? "database error")}`.slice(0, 200), {
    severity: "warn",
    alert: "digest",
    props: { phase, missing_table: missing },
    fingerprint: `owner_notes_failed:${phase}:${missing ? "missing_table" : "other"}`,
    summary: missing
      ? "Fin cannot remember things about people: the owner_notes table is missing (run db/0032_owner_notes.sql)"
      : `Fin could not ${phase} what it remembers about a person`,
  });
}

/**
 * A note that carries something never to be kept: a password or PIN, or a
 * long run of digits (an ID, account or card number; a phone number too —
 * a note is about the person, never how to reach them).
 */
export const SECRET_DETAIL = /\b(?:password|passcode|pin(?:\s*(?:code|number))?|otp|cvv|cvc)\b|\d(?:[\s-]?\d){7,}/i;

/** Same text, ignoring case, spacing and punctuation: one note is not saved twice. */
const noteKey = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The person's notes, newest first. An empty list when there are none or the read failed. */
export async function ownerNotes(businessId: string, limit = 20): Promise<OwnerNote[]> {
  if (Date.now() < notesMissingUntil) return [];
  const { data, error } = await db()
    .from("owner_notes")
    .select("id, about, note, source, created_at")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    notesFailed("read", error);
    return [];
  }
  return ((data as OwnerNote[] | null) ?? []).map((n) => ({ ...n, id: String(n.id) }));
}

/**
 * Keeps one note about the person. The same note again is not a second row
 * (an AI can call this twice for one remark). Returns the note kept, or null
 * when it could not be saved.
 */
export async function addOwnerNote(businessId: string, about: string, note: string, source: "connector" | "whatsapp" | "web"): Promise<{ note: OwnerNote; fresh: boolean } | null> {
  const text = note.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);
  if (!text) return null;
  const kind: NoteAbout = (NOTE_ABOUT as readonly string[]).includes(about) ? (about as NoteAbout) : "other";
  const { data: have, error: readError } = await db()
    .from("owner_notes")
    .select("id, about, note, source, created_at")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(NOTES_KEPT + 20);
  if (readError) {
    notesFailed("write", readError);
    return null;
  }
  const existing = ((have as OwnerNote[] | null) ?? []).map((n) => ({ ...n, id: String(n.id) }));
  const same = existing.find((n) => noteKey(n.note) === noteKey(text));
  if (same) return { note: same, fresh: false };
  const { data, error } = await db()
    .from("owner_notes")
    .insert({ business_id: businessId, about: kind, note: text, source })
    .select("id, about, note, source, created_at")
    .single();
  if (error || !data) {
    notesFailed("write", error ?? "no row came back");
    return null;
  }
  // The oldest beyond the cap go, so memory stays about what still matters.
  const over = existing.slice(NOTES_KEPT - 1);
  for (const n of over) {
    const { error: trimError } = await db().from("owner_notes").delete().eq("id", n.id).eq("business_id", businessId);
    if (trimError) console.warn("addOwnerNote: an old note was not trimmed", trimError.message ?? trimError);
  }
  const row = data as OwnerNote;
  return { note: { ...row, id: String(row.id) }, fresh: true };
}

/** Deletes one note (the person asked to forget it, or it was wrong). True when it was there and is gone. */
export async function deleteOwnerNote(businessId: string, id: string): Promise<boolean | "error"> {
  const { data, error } = await db().from("owner_notes").delete().eq("id", id).eq("business_id", businessId).select("id");
  if (error) {
    // A malformed id is a cast error, not an outage: there is no such note.
    if (/invalid input syntax|22P02/.test(`${(error as { message?: string }).message ?? ""} ${(error as { code?: string }).code ?? ""}`)) return false;
    notesFailed("delete", error);
    return "error";
  }
  return ((data as unknown[] | null) ?? []).length > 0;
}

/** The decisions the person has made, newest first: the connector's history, and memory. */
export async function recentDecisions(businessId: string, limit = 10): Promise<{ what: string; why: string | null; source: string | null; created_at: string | null }[]> {
  const { data, error } = await db()
    .from("decisions")
    .select("what, why, source, created_at")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("recentDecisions failed", error.message ?? error);
    return [];
  }
  return (data as { what: string; why: string | null; source: string | null; created_at: string | null }[] | null) ?? [];
}

export async function logOutcome(businessId: string, what: string, effect: string, planStepId?: string | null, source = "whatsapp"): Promise<void> {
  const { error } = await db().from("outcomes").insert({ business_id: businessId, what, effect, plan_step_id: planStepId ?? null, source });
  if (error) console.error("logOutcome failed", error);
}

// ── The guardrail audit trail ────────────────────────────────────

/**
 * safety_events check names that are operational notes, not guardrail
 * checks: library learning (knowledge_signal), a plan that finished without
 * its strategy (plan_strategy, counted on its own on /api/health), build
 * timing (plan_build_timing, readback_timing, goal_options_timing), and
 * where one answer's time went (answer_timing, engine/qa.ts). Every
 * guardrail count — /api/health and the
 * sponsor report — leaves these out, or a busy day would look like a
 * well-guarded one.
 */
export const NOT_GUARDRAIL_CHECKS = ["knowledge_signal", "plan_strategy", "plan_build_timing", "answer_timing", "readback_timing", "goal_options_timing"] as const;

/**
 * Written for EVERY check, including the ones that found nothing and the ones
 * that could not run. An 'unavailable' row is the thing to alert on: it means
 * advice went out with that guardrail switched off.
 */
/**
 * Whether the person turn now in flight has left its knowledge_signal note.
 *
 * Live, 2026-09-23: three typed messages from one owner, two notes. The
 * design says every owner turn leaves one, but the note was only ever written
 * from inside afterTurn(), and several paths never get there. The dispatcher
 * opens one of these per inbound message (engine/index.ts handleInbound) and
 * writes a fallback note at the end if nothing else did. Async-local rather
 * than a module variable because the worker runs different people' jobs
 * concurrently, and one owner's note must never count for another's turn.
 */
export interface SignalTurn {
  noted: boolean;
}
export const signalTurn = new AsyncLocalStorage<SignalTurn>();

export async function recordSafetyEvent(e: {
  businessId?: string | null;
  check: string;
  engine: "jev" | "model" | "none";
  outcome: "pass" | "flag" | "block" | "unavailable";
  score?: number | null;
  flags?: string[];
  detail?: string;
}): Promise<void> {
  // A guardrail that could not run (Jev out of credit, the model backstop
  // down) is a failure the team must hear about: the person got a reply that
  // nothing checked, or a slower one.
  if (e.outcome === "unavailable") {
    track("guardrail_unavailable", {
      category: "failure",
      severity: e.engine === "none" ? "error" : "warn",
      businessId: e.businessId ?? undefined,
      alert: "digest",
      props: { check: e.check, engine: e.engine, detail: String(e.detail ?? "").slice(0, 200) },
      fingerprint: `guardrail_unavailable:${e.check}:${e.engine}`,
      summary: `Guardrail "${e.check}" could not run on ${e.engine}: ${String(e.detail ?? "").slice(0, 140)}`,
    });
  } else if (e.outcome === "flag" && !(NOT_GUARDRAIL_CHECKS as readonly string[]).includes(e.check)) {
    // The guardrail caught something and the reply was corrected or held:
    // what it catches, and how often, is worth seeing — not worth an email.
    track("guardrail_flagged", { category: "security", severity: "info", businessId: e.businessId ?? undefined, props: { check: e.check, engine: e.engine, flags: (e.flags ?? []).slice(0, 8) } });
  } else if (e.outcome === "block" && e.check !== "distress") {
    // A distress block is recorded once, as distress_detected, where it happens.
    track("guardrail_blocked", { category: "security", severity: "warn", businessId: e.businessId ?? undefined, alert: "digest", props: { check: e.check, engine: e.engine, flags: e.flags ?? [] }, fingerprint: `guardrail_blocked:${e.check}` });
  }
  // Marked before the insert: if the insert fails, a second note written by
  // the fallback would fail the same way, and the error is logged below.
  if (e.check === "knowledge_signal") {
    const turn = signalTurn.getStore();
    if (turn) turn.noted = true;
  }
  try {
    // supabase-js reports a failed insert as `{ error }`, not a throw — so a
    // bare await here was a silent failure, in the one table whose job is to
    // make failures visible.
    const { error } = await db().from("safety_events").insert({
      business_id: e.businessId ?? null,
      check_name: e.check,
      engine: e.engine,
      outcome: e.outcome,
      score: e.score ?? null,
      flags: e.flags ?? [],
      detail: (e.detail ?? "").slice(0, 2000),
    });
    if (error) throw new Error(error.message ?? String(error));
  } catch (err) {
    console.error("recordSafetyEvent failed", err);
  }
}

/**
 * One row per model call, so cost per owner is measured rather than guessed.
 * Best effort: a failed meter write must never fail a conversation.
 */
export async function recordModelUsage(u: {
  role?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cost?: number;
}): Promise<void> {
  try {
    const { error } = await db().from("model_usage").insert({
      role: u.role ?? null,
      model: u.model,
      prompt_tokens: u.promptTokens,
      completion_tokens: u.completionTokens,
      cost_usd: u.cost ?? null,
    });
    // supabase-js reports a rejected insert as { error }, not a throw.
    if (error) throw error;
  } catch (err) {
    console.warn("recordModelUsage failed", err);
  }
}

export async function recordRetrievalGap(g: {
  businessId?: string | null;
  country: string;
  query: string;
  domain?: string | null;
  topScore: number;
  /** True when the semantic second pass found something the keywords missed. */
  rescued?: boolean;
  /** Where the question came from; defaults to WhatsApp. */
  source?: SignalSource;
  /** The asker's own words; with none, no knowledge signal is written. */
  quote?: string | null;
}): Promise<void> {
  try {
    const { error } = await db().from("retrieval_gaps").insert({
      business_id: g.businessId ?? null,
      country: g.country,
      query: (g.query ?? "").slice(0, 1000),
      domain: g.domain ?? null,
      top_score: g.topScore,
      rescued: g.rescued ?? false,
    });
    if (error) throw new Error(error.message ?? String(error));
  } catch (err) {
    console.error("recordRetrievalGap failed", err);
  }
  // The same event, as a knowledge signal: the gap is already detected, so
  // this costs one insert and no model call (db/0015). Only with the asker's
  // own words — see the `quote` note in retrieval.ts.
  // No note here: the turn that led to this gap writes its own one note
  // (afterTurn, noteTurnSkipped or the dispatcher's fallback). A second one
  // from here broke "exactly one note per turn" for forwarded links.
  if (!g.quote?.trim()) return;
  await recordKnowledgeSignal({
    source: g.source ?? "whatsapp",
    businessId: g.businessId ?? null,
    country: g.country,
    type: "unanswered_question",
    rawQuote: g.quote,
    candidateClaim: g.rescued ? "keywords missed it; search-by-meaning found something" : "nothing in the library matched",
  });
}

// ── Knowledge signals (db/0015) ──────────────────────────────────

export type SignalSource = "whatsapp" | "mcp" | "web";
export type SignalType = "correction" | "new_fact_candidate" | "unanswered_question" | "outcome_report" | "contradiction";

export interface KnowledgeSignalRow {
  id: number;
  created_at: string;
  source: SignalSource;
  business_id: string | null;
  country: string | null;
  signal_type: SignalType;
  related_entity_type: "tool" | "knowledge_entry" | null;
  related_entity_id: string | null;
  raw_quote: string;
  candidate_claim: string | null;
  status: "new" | "reviewed" | "promoted" | "rejected";
  reviewed_at: string | null;
  reviewed_by: string | null;
  notes: string | null;
}

/**
 * One atomic row. Never throws: a signal is worth having, never worth
 * failing the person's reply over.
 */
export async function recordKnowledgeSignal(s: {
  source: SignalSource;
  businessId?: string | null;
  country?: string | null;
  type: SignalType;
  entity?: { type: "tool" | "knowledge_entry"; id: string } | null;
  rawQuote: string;
  candidateClaim?: string | null;
}): Promise<boolean> {
  // Cut by characters, not UTF-16 units: a cut through an emoji leaves half a
  // surrogate pair, which Postgres rejects and the signal would be lost.
  const cut = (x: string, n: number) => Array.from(x).slice(0, n).join("");
  const quote = cut((s.rawQuote ?? "").trim(), 2000);
  if (!quote) return false;
  try {
    const { error } = await db().from("knowledge_signals").insert({
      source: s.source,
      business_id: s.businessId ?? null,
      country: s.country ?? null,
      signal_type: s.type,
      related_entity_type: s.entity?.type ?? null,
      related_entity_id: s.entity?.id ?? null,
      raw_quote: quote,
      candidate_claim: s.candidateClaim ? cut(s.candidateClaim, 500) : null,
      status: "new",
    });
    if (error) throw new Error(error.message ?? String(error));
    return true;
  } catch (err) {
    // Live, 2026-09-23: zero signals across two test runs, and no way to tell
    // "nothing qualified" from "every insert failed" — a failure here only
    // ever reached the function log. It now also leaves a database row that
    // says so (a flag, never "unavailable": this is not a guardrail).
    console.error("recordKnowledgeSignal failed", err);
    await recordSafetyEvent({
      businessId: s.businessId ?? null,
      check: "knowledge_signal",
      engine: "none",
      outcome: "flag",
      flags: ["write_failed"],
      detail: `insert failed (${s.type}): ${(err as Error)?.message ?? String(err)}`.slice(0, 300),
    });
    return false;
  }
}

export async function listKnowledgeSignals(opts: { status?: string; sinceDays?: number; limit?: number }): Promise<KnowledgeSignalRow[]> {
  const since = new Date(Date.now() - (opts.sinceDays ?? 90) * 864e5).toISOString();
  const { data, error } = await db()
    .from("knowledge_signals")
    .select("*")
    .eq("status", opts.status ?? "new")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? 500, 1), 2000));
  if (error) throw new Error(error.message);
  return (data as KnowledgeSignalRow[]) ?? [];
}

/**
 * Marks signals reviewed / promoted / rejected. Notes APPEND, dated, so a
 * later change of mind never erases the source a promotion cited.
 */
export async function reviewKnowledgeSignals(ids: number[], r: { status: "reviewed" | "promoted" | "rejected"; reviewedBy: string; notes: string }): Promise<number> {
  if (!ids.length) return 0;
  const { data: rows, error: readErr } = await db().from("knowledge_signals").select("id, notes").in("id", ids);
  if (readErr) throw new Error(readErr.message);
  const now = new Date().toISOString();
  let updated = 0;
  for (const row of (rows as { id: number; notes: string | null }[]) ?? []) {
    const line = `[${now.slice(0, 10)} ${r.status} by ${r.reviewedBy}] ${r.notes}`;
    const { error } = await db()
      .from("knowledge_signals")
      .update({ status: r.status, reviewed_by: r.reviewedBy, reviewed_at: now, notes: row.notes ? `${row.notes}\n${line}` : line })
      .eq("id", row.id);
    if (error) throw new Error(error.message);
    updated++;
  }
  return updated;
}

/** Just what signal capture needs to name a tool or entry — not whole rows (embeddings included). */
export async function signalLibraryFor(country: string): Promise<{
  tools: Pick<ToolRow, "id" | "name" | "cost" | "setup">[];
  knowledge: Pick<KnowledgeRow, "id" | "title" | "owner_summary" | "cost">[];
}> {
  const [t, k] = await Promise.all([
    db().from("tools").select("id, name, cost, setup").eq("country", country),
    db().from("knowledge_entries").select("id, title, owner_summary, cost").eq("country", country),
  ]);
  return { tools: (t.data as never) ?? [], knowledge: (k.data as never) ?? [] };
}
