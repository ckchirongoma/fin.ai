// Charles — the plan build, as a resumable state machine.
//
// The monolithic version of this (see git history: build.ts's old
// runPlanBuildStep) ran five or six model calls back to back inside ONE job:
// context extraction, a module audit, a strategy, and one tailoring call per
// part of the plan. That whole chain had to finish inside a single Vercel
// invocation's timeout, and a stuck call anywhere meant redoing the lot from
// the top — the incident this file exists to fix took roughly seven minutes
// end to end, with the person's `stage` sitting on "building_plan" the whole
// time and nothing durable behind it.
//
// Each phase below reads and writes `plan_builds` (db/0012) instead of local
// variables, and is dispatched as its own short job (kind "plan_build_stage",
// see api/_lib/queue.ts). A crash or timeout loses at most the phase in
// flight — the next attempt resumes from `plan_builds.stage`, not from zero.
//
// The phases: "context" (one call) -> "building", where the strategy and the
// workstream tailoring run as two INDEPENDENT jobs against the same context
// (matching the original's Promise.all concurrency, just across jobs instead
// of within one) -> "finalize" (writes the plan) -> "pdf" -> "done". Whichever
// of strategy/workstreams finishes last is the one that advances the row past
// "building" — see tryAdvanceToFinalize in db.ts for how that race is made
// safe without a lock.

import { DeadlineError, fenceCheck, jobMsLeft, JobFencedError, onLastAttempt, rethrowIfRetryable } from "../jobctx.js";
import { askJSON } from "../models.js";
import { contextPrompt, STRATEGY_FIELDS, strategyPrompt, workstreamPrompt, type StrategyHalf } from "../prompts.js";
import { pickPlaybook, stepKnowledgePins } from "../playbooks.js";
import { businessKnownFacts, checkStepCompliance, checkStrategy, flattenStrategy, unflattenStrategy } from "../safety.js";
import { checkArtifact } from "./artifact.js";
import { auditModules } from "../judgement.js";
import { scoreMoneyMap } from "../moneymap.js";
import { shortlist, kSheet, tSheet } from "../retrieval.js";
import {
  db,
  enqueueForPlan,
  enqueuePlanBuildStage,
  failPlanBuild,
  findBusinessById,
  finishPlanBuild,
  getPlanBuild,
  heartbeatPlanBuild,
  knowledgeFor,
  planFor,
  recordPlanBuildTiming,
  recordSafetyEvent,
  resetPlanBuild,
  resumePointFor,
  revivePlanBuildRow,
  failedBuildsToRetry,
  AUTO_RETRIED,
  saveContextStage,
  saveFinalizeStage,
  saveStrategyStage,
  saveWorkstreamResult,
  adoptLatePart,
  adoptLateStrategy,
  wakeHeldRepair,
  handOverPlanBuild,
  overdueBuilds,
  toolsFor,
  tryAdvanceToFinalize,
  updateBusiness,
} from "../db.js";
import { sendButtons, sendText } from "../wa.js";
import { ACT } from "../actions.js";
import { planDocHTML } from "../plandoc.js";
import { deliverRenderedPdf, pdfConfigured, renderPdf } from "../pdfclient.js";
import { SEND_PDF_BUTTON } from "./planpdf.js";
import { applyContextGuardrails, dayOneFields, existingConnectorUrl, forCountry, groundMoneyFields, hydrateWorkstream, ownerTools, withOwnerTools, planUrl, PRODUCT_NAME, recordPriceGrounding } from "./build.js";
import { groundingFrom } from "../grounding.js";
import { queueKeptQuestions } from "./kept.js";
import { degradedNote, queuePlanRepair } from "./repair.js";
import { since, track, trackFailure, trackUnmet } from "../track.js";
import type { Business, HouseholdContext, HydratedWorkstream, JobRow, PlanBuildRow, Strategy } from "../types.js";

/**
 * The bounds on every plan_builder request a build stage makes (context,
 * strategy, each workstream's tailoring), passed as AskOptions.maxRequestMs
 * and minRequestMs.
 *
 * 150s, not the ordinary 90s: legitimate slow calls of ~125s were seen live
 * and must not be cut — cutting one costs the call and a retry. But round
 * 21's KE build had calls that never finished their body at all, and with
 * no cap the only thing that ended them was Vercel's 300s kill (seven
 * minutes of silence for the person, then a requeue). Cut at 150s, a stalled
 * call fails where the code can see it and falls back or retries.
 *
 * 45s: a build call given a shorter window than that (what the attempt has
 * left, less the few seconds kept to record the result) is unlikely to
 * finish, and one aborted part-way is still billed. Better to throw
 * DeadlineError before sending it and let the job retry on a fresh worker
 * with a whole budget.
 */
export const BUILD_CALL_MAX_MS = 150_000;
/**
 * Round 24: 90s, not 45s. Round 23, live: of 24 build calls that failed,
 * not one fallback model got a token in the 45-60s it was left after the
 * primary was cut; every one was a minute paid for nothing before the job
 * retried. A tailoring call that succeeds takes 65-200s. Under 90s, the
 * fresh worker is the better bet, at once.
 */
export const BUILD_CALL_MIN_MS = 90_000;
/**
 * Streamed (models.ts streamFor, the default since round 22), a build call
 * that stalls is cut after 60s with no first token or 30s of silence, and
 * the next model gets the time that is left: round 22's failed attempts
 * spent 150s on a primary that was not writing, then timed out the fallback
 * on what remained, and cost about four minutes each. So the whole-request
 * cap only has to stop a call that is still writing, and that is the call
 * most worth letting finish.
 *
 * Round 24: 230s, not 210s. Round 23, live: calls still writing were cut at
 * 210s (successful ones took up to 200s), the fallback then had too little
 * time to write anything, and the attempt was lost. 230s still leaves a
 * fresh attempt (270s) about half a minute for the checks on what it wrote.
 */
export const BUILD_STREAM_MAX_MS = 230_000;

/**
 * The hand-over deadline. Round 23, live: 6 of 14 builds took more than 8
 * minutes (up to 14.3), every one of them a build whose strategy or one part
 * needed a second or third attempt, while the rest of the plan sat finished.
 * Six minutes into a build, whatever is still being written stops holding
 * the person up: the plan goes out with the parts not yet tailored in the
 * library's wording and, if it is not written yet, without the strategy;
 * the hand-over says which, and the plan repair (engine/repair.ts) finishes
 * them — using what the build's own lanes deliver late, when they do,
 * rather than paying for it twice. Checked once a minute by the tick, and by
 * every drain and watchdog pass in between, so the plan is with the person
 * within about seven minutes of their last tap.
 */
export const HAND_OVER_AFTER_MS = 6 * 60_000;
/** In plan_builds.last_error: this build was handed over at the deadline. */
export const HANDED_OVER = "[handed over at the deadline]";
const BUILD_CALL_CAPS = { maxRequestMs: BUILD_CALL_MAX_MS, maxStreamMs: BUILD_STREAM_MAX_MS, minRequestMs: BUILD_CALL_MIN_MS } as const;

/** Starts a fresh build, or replaces a fully-finished/failed one with a new attempt. */
export async function startPlanBuild(biz: Business): Promise<void> {
  await resetPlanBuild(biz.id);
  await enqueuePlanBuildStage(biz.id, "context");
  track("plan_build_started", {
    category: "funnel",
    props: { goals: biz.goal?.length ?? 0, rules: biz.rule?.length ?? 0, rebuild: Boolean(biz.current_plan_id) },
  });
}

/**
 * A new message arrived while the person is parked on "building_plan" and the
 * in-flight stage has gone quiet longer than the opportunistic sweep's own
 * grace period (see reclaimStalePlanBuilds in db.ts, which should normally
 * have already caught this). Resumes from `plan_builds.stage` — never restarts
 * from "context" — because by the time anyone notices, most of the expensive
 * work may already be paid for and sitting in the row.
 */
export async function resumePlanBuild(biz: Business): Promise<void> {
  const pb = await getPlanBuild(biz.id);
  if (!pb || pb.stage === "done") {
    // Nothing to resume: the build the person is waiting on is missing, or
    // finished without moving them on. Every minute of it starts again.
    track("plan_build_resumed", {
      category: "ops",
      severity: "warn",
      props: { from: pb ? "done" : "missing", at: "context" },
      fingerprint: `plan_build_resumed:${pb ? "done" : "missing"}`,
      summary: `A person was waiting on a plan build that was ${pb ? "already finished" : "missing"}; it was started again from the beginning`,
    });
    return startPlanBuild(biz);
  }
  if (pb.stage === "failed") return reviveFailedBuild(biz.id, pb, "revived by the person's message");
  await heartbeatPlanBuild(biz.id); // debounces a second resume landing moments later
  // A build that went quiet mid-stage; the sweep in db.ts should have caught it first.
  track("plan_build_resumed", {
    category: "ops",
    severity: "warn",
    props: { from: "stalled", at: pb.stage, parts_left: pb.pending_workstreams?.length ?? 0, strategy_done: pb.strategy_done },
    fingerprint: `plan_build_resumed:stalled:${pb.stage}`,
    summary: `A plan build went quiet at ${pb.stage} and was picked up again by the person's message`,
  });
  if (pb.stage === "context") return enqueuePlanBuildStage(biz.id, "context");
  if (pb.stage === "finalize") return enqueuePlanBuildStage(biz.id, "finalize");
  if (pb.stage === "pdf") return enqueuePlanBuildStage(biz.id, "pdf");
  // "building": strategy and the workstreams are independent lanes — resume
  // whichever one(s) are still unfinished.
  if (pb.pending_workstreams.length) await enqueuePlanBuildStage(biz.id, "workstreams");
  if (!pb.strategy_done) await enqueuePlanBuildStage(biz.id, "strategy");
}

/**
 * A failed build, picked up from its saved work. Before (live report, round
 * 3): "failed" restarted from "context", throwing away the context, the
 * strategy and every tailored part already paid for — while the apology
 * promised to "pick it back up from where it stopped".
 */
export async function reviveFailedBuild(businessId: string, pb: PlanBuildRow, why: string): Promise<void> {
  const at = resumePointFor(pb) ?? "context"; // nothing saved worth keeping: from the top
  // The previous error travels in the note, and with it any auto-retry marker.
  const note = `${why} at ${at}; previous error: ${pb.last_error ?? "none"}`;
  if (!(await revivePlanBuildRow(businessId, at, note))) return; // someone else already moved it
  // The failure itself was already reported (plan_build_failed). The business
  // is passed: the automatic retry runs from the cron, outside any turn.
  track("plan_build_resumed", { category: "ops", businessId, props: { from: "failed", at, auto: why.includes(AUTO_RETRIED) } });
  if (at === "context" || at === "pdf" || at === "finalize") return enqueuePlanBuildStage(businessId, at);
  if (pb.pending_workstreams.length) await enqueuePlanBuildStage(businessId, "workstreams");
  if (!pb.strategy_done) await enqueuePlanBuildStage(businessId, "strategy");
}

/**
 * One automatic retry for failed builds whose owner is still waiting on
 * "building_plan" — never for a build ended on purpose (no playbook fits, and
 * the person was routed to clarify_objective), never twice.
 */
export async function autoRetryFailedBuilds(): Promise<number> {
  let n = 0;
  for (const pb of await failedBuildsToRetry()) {
    const biz = await findBusinessById(pb.business_id);
    if (!biz || biz.stage !== "building_plan") continue;
    await reviveFailedBuild(pb.business_id, pb, `${AUTO_RETRIED} automatic retry`);
    n++;
  }
  return n;
}

/** An honest, specific answer to "what's taking so long" — never just "still working". */
export function buildProgressText(pb: PlanBuildRow | null): string {
  if (!pb || pb.stage === "context") return "reading through everything you told me";
  if (pb.stage === "building") {
    const done = pb.workstreams.length;
    const total = done + pb.pending_workstreams.length;
    return total ? `tailoring part ${Math.min(done + 1, total)} of ${total}` : "putting the plan together";
  }
  if (pb.stage === "finalize") return "putting the plan together";
  if (pb.stage === "pdf") return "writing out the PDF";
  return "still building";
}

/**
 * Dispatched by api/_lib/queue.ts for every "plan_build_stage" job. A stage
 * that throws on the job's LAST attempt is the build failing: queue.ts marks
 * plan_builds "failed" and tells the person it will try again. Earlier
 * attempts are only retries (job_retry), and a fenced-off attempt is not
 * this worker's failure.
 */
export async function runPlanBuildStage(job: JobRow): Promise<void> {
  try {
    await dispatchPlanBuildStage(job);
  } catch (err) {
    // A strategy or workstreams lane still running when its build was
    // handed over at the deadline: the plan is with the person, and what the
    // lane could not finish is the plan repair's now. Not retried, never the
    // build failing (queue.ts would otherwise mark a finished build failed).
    const step = (job.payload as { step?: string } | null)?.step;
    if (!(err instanceof JobFencedError) && (step === "strategy" || step === "workstreams") && job.business_id && (await handedOverSince(job.business_id))) {
      track("plan_build_lane_late", { category: "performance", businessId: job.business_id, props: { step, ok: false, error: (err instanceof Error ? err.name : "error").slice(0, 40) } });
      return;
    }
    if (!(err instanceof JobFencedError) && onLastAttempt()) {
      const step = String((job.payload as { step?: string } | null)?.step ?? "unknown");
      // Counted (the daily email's failed builds, /admin), not emailed: the
      // same last attempt is job_dead in queue.ts, which already emails at once.
      trackFailure("plan_build_failed", err, {
        severity: "critical",
        alert: "none",
        props: { step },
        fingerprint: `plan_build_failed:${step}:${err instanceof Error ? err.name : "error"}`,
        summary: `A plan build failed at its ${step} stage on the last attempt; the person is waiting on a retry`,
      });
    }
    throw err;
  }
}

/** Was this business's current build handed over at its deadline (so its lanes are late)? */
async function handedOverSince(businessId: string): Promise<boolean> {
  const pb = await getPlanBuild(businessId).catch(() => null);
  return Boolean(pb && pb.stage !== "building" && pb.stage !== "context" && pb.stage !== "failed" && (pb.last_error ?? "").includes(HANDED_OVER));
}

/**
 * Every build still in "building" past HAND_OVER_AFTER_MS, handed over with
 * what it has. From cronTick, the watchdog and every drain (queue.ts): cheap
 * when nothing is overdue, one query. `now` lets a test move the clock.
 */
export async function handOverOverdueBuilds(now = Date.now()): Promise<number> {
  let n = 0;
  for (const row of await overdueBuilds(new Date(now - HAND_OVER_AFTER_MS).toISOString())) {
    if (await handOverBuild(row.business_id, now)) n++;
  }
  return n;
}

async function handOverBuild(businessId: string, now: number): Promise<boolean> {
  // Read, decide, write only if nothing moved in between (handOverPlanBuild):
  // a lane saving a part in that moment means reading again, at most twice.
  for (let i = 0; i < 3; i++) {
    const pb = await getPlanBuild(businessId);
    if (!pb || pb.stage !== "building" || !pb.context) return false;
    const biz = await findBusinessById(businessId);
    if (!biz || biz.deleted_at) return false;
    const book = pickPlaybook(biz.biz_stage || "stretching", biz.signals ?? {}, biz.answers || {}, biz.goal || [], pb.dropped_modules);
    if (!book) return false; // nothing to hand over: the lanes' own failure path says so
    const tools = await toolsFor(biz.country);
    const countryToolIds = new Set(tools.map((t) => t.id));
    const owned = ownerTools(biz.answers || {}, countryToolIds);
    const late = pb.pending_workstreams.map((id) => libraryPart(book, id, countryToolIds, owned)).filter((w): w is HydratedWorkstream => Boolean(w));
    const strategyLate = !pb.strategy_done;
    const note = `${HANDED_OVER} ${strategyLate ? "strategy still being written; " : ""}${late.length ? `in library wording: ${late.map((w) => w.id).join(", ")}; ` : ""}${pb.last_error ?? ""}`.trim();
    if (!(await handOverPlanBuild(businessId, pb.updated_at, { workstreams: [...pb.workstreams, ...late], note }))) continue;
    const startedAt = pb.created_at ? Date.parse(pb.created_at) : Number.NaN;
    track("plan_build_handed_over", {
      category: "performance",
      severity: "warn",
      alert: "digest",
      businessId,
      ms: Number.isFinite(startedAt) ? now - startedAt : null,
      props: { strategy_late: strategyLate, parts_late: late.map((w) => w.id), parts_done: pb.workstreams.length },
      fingerprint: "plan_build_handed_over",
      summary: "A plan build reached its six-minute deadline and was handed over with what it had; the rest follows by plan repair",
    });
    await enqueuePlanBuildStage(businessId, "finalize");
    return true;
  }
  return false;
}

async function dispatchPlanBuildStage(job: JobRow): Promise<void> {
  if (!job.business_id) throw new Error("plan_build_stage job has no business");
  const step = (job.payload as { step?: string } | null)?.step;
  await heartbeatPlanBuild(job.business_id);
  const biz = await findBusinessById(job.business_id);
  if (!biz) return; // forgotten mid-build — nothing left to build for

  if (step === "context") return runContextStage(biz);
  if (step === "strategy") return runStrategyStage(biz);
  if (step === "workstreams") return runWorkstreamsStage(biz);
  if (step === "finalize") return runFinalizeStage(biz);
  if (step === "pdf") return runPdfStage(biz);
  throw new Error(`unknown plan build step "${String(step)}"`);
}

// ── Stage 1: context, the map, and which fixed modules apply ─────

export async function runContextStage(biz: Business): Promise<void> {
  const stageStarted = Date.now();
  const pb = await getPlanBuild(biz.id);
  if (!pb || pb.stage !== "context") return; // already advanced — a late/duplicate job, no-op

  const answers = biz.answers || {};
  const stage = biz.biz_stage || "stretching";

  const c = await askJSON(
    "plan_builder",
    contextPrompt(answers, stage, biz.goal, biz.rule, biz.identity, biz.country),
    { maxTokens: 2600, label: "build:context", reasoning: { enabled: false }, ...BUILD_CALL_CAPS },
  );
  const rawContext = c.context as HouseholdContext | undefined;
  let map = (c.map as PlanBuildRow["map"]) || [];
  if (!rawContext || !map.length) throw new Error("context/map missing from build:context");

  // Priority 2, 2026-09-22: this exact call, given deliberately generic
  // answers, invented a specific customer segment and a specific price and
  // asserted both as settled fact while its own identity.unsure said the
  // diagnostic was too thin to be sure of anything. See engine/build.ts's
  // applyContextGuardrails for what runs here now: the two fields that were
  // actually invented are computed from the customer the person already
  // chose (never re-asked of a model), and whatever is still generated
  // freely is checked for traceability to the diagnostic and hedged,
  // unconditionally, whenever that flag is set.
  const guarded = await applyContextGuardrails(rawContext, answers, biz, { businessId: biz.id });

  // Bug 2: the goal is sent to the person a few lines down ("Right. {goal}")
  // and restated as the day-90 milestone; the context fields feed every
  // later prompt. A figure in either that the person never gave is labelled a
  // guess here, before it can be inherited downstream as if it were fact.
  const given = groundingFrom(answers);
  const goalCheck = await groundMoneyFields({ goal: String(c.goal ?? "") }, ["goal"], given, "sentence", { businessId: biz.id, surface: "goal" });
  c.goal = goalCheck.value.goal;
  const ctxCheck = await groundMoneyFields(
    guarded,
    (Object.keys(guarded) as (keyof HouseholdContext)[]).filter((k) => !["name", "location", "income", "owes"].includes(String(k))),
    given,
    "sentence",
    { businessId: biz.id, surface: "context" },
  );
  const context = ctxCheck.value;
  await recordPriceGrounding(biz.id, "goal and money context", [...goalCheck.hedged, ...ctxCheck.hedged.map((k) => `context.${k}`)]);

  // The colour is decided against the rubric, independently of the call that
  // just wrote the notes — so two people in the same situation score the same.
  const scores = await scoreMoneyMap(answers, biz.identity, biz.goal, { businessId: biz.id });
  if (Object.keys(scores).length) {
    map = map.map((m) => (scores[m.domain] ? { ...m, status: scores[m.domain]! } : m));
  }

  let book = pickPlaybook(stage, biz.signals ?? {}, answers, biz.goal || []);
  let dropped: string[] = [];
  if (book) {
    // Rule 1, belt and braces: ask of each chosen module whether the answers
    // really evidence it, and swap out any that clearly do not — before a
    // token is spent tailoring it.
    dropped = await auditModules(
      book.workstreams.map((w) => ({ id: w.id, title: w.title, why: w.why })),
      { answers, problemInTheirWords: biz.signals?.problem_in_their_words ?? null, topProblem: biz.signals?.top_problem ?? null },
      { businessId: biz.id },
    );
    if (dropped.length) book = pickPlaybook(stage, biz.signals ?? {}, answers, biz.goal || [], dropped) ?? book;
  }
  if (!book) {
    // Saying "I don't have enough" is a real answer. Three generic parts
    // would be worse than nothing, and this is the moment that decides it.
    // Not a failure in the retry sense — reusing "failed" here only to end
    // this build attempt cleanly, so the opportunistic sweep in db.ts stops
    // touching it. The person has already been routed to clarify_objective,
    // which is not a stage handleBuilding's restart logic ever looks at.
    // Their goal, in their own words, is what could not be built on.
    trackUnmet("plan_not_buildable", { excerpt: answers.objective ?? null, props: { biz_stage: stage, dropped } });
    await failPlanBuild(biz.id, "no playbook resolves for this household — person routed to clarify_objective");
    await updateBusiness(biz.id, { context, map, stage: "clarify_objective", pending_action: null });
    await sendText(
      biz.wa_id,
      `I don't have enough to build you a real 90 days yet. Nothing you've told me points at a specific problem I can fix, and I'd rather say that than hand you three generic parts.\n\nTell me the one thing that would make the biggest difference to your money in the next three months — and be specific.`,
      biz.id,
    );
    return;
  }

  const advanced = await saveContextStage(biz.id, {
    goal: String(c.goal ?? ""),
    context,
    map,
    droppedModules: dropped,
    workstreamIds: book.workstreams.map((w) => w.id),
  });
  if (!advanced) return; // someone else already moved this row on
  track("plan_build_stage_done", {
    category: "performance",
    ms: since(stageStarted),
    props: { step: "context", modules: book.workstreams.map((w) => w.id), dropped, map_areas: map.length },
  });

  // No message here any more. "Right. <goal>. Let me put the whole thing
  // together. Won't be long." read as if the plan were done, and then the
  // owner waited minutes more (founder, 2026-09-24). The wait is stated once,
  // honestly, when the line is chosen (engine/index.ts); the goal is in the
  // plan itself.
  await enqueuePlanBuildStage(biz.id, "strategy");
  await enqueuePlanBuildStage(biz.id, "workstreams");
}

/**
 * The strategy, written and checked: one try. Used by the build's strategy
 * stage (two tries) and by a plan repair (engine/repair.ts), which writes it
 * again after the hand-over when the build could not.
 */
export async function writeStrategy(biz: Business, pb: Pick<PlanBuildRow, "goal" | "context" | "map" | "dropped_modules">): Promise<Strategy> {
  const answers = biz.answers || {};
  const bizStage = biz.biz_stage || "stretching";
  const book = pickPlaybook(bizStage, biz.signals ?? {}, answers, biz.goal || [], pb.dropped_modules);
  const context = pb.context;

  if (!book || !context) throw new Error("strategy: context stage did not leave enough behind");
  const [knowledge, tools] = await Promise.all([knowledgeFor(biz.country), toolsFor(biz.country)]);
  const short = await shortlist(
    knowledge,
    tools,
    {
      text: [pb.goal, answers.objective, answers.blockers, answers.owes].filter(Boolean).join(" "),
      stage: bizStage,
      headache: answers.objective ?? null,
      maxKnowledge: 5,
      maxTools: 6,
    },
    { businessId: biz.id, country: biz.country, log: false },
  );
  const toolsSheetStr = tSheet(short.tools);
  // Two halves at once (STRATEGY_FIELDS): round 25, live, 13 of 27 strategy
  // calls written whole ran out of their window at the 230s cap, while the
  // contracts part, split the same way, failed 0 of 26. Each half sees the
  // whole business and writes only its own fields.
  const halves: StrategyHalf[] = ["reading", "plan"];
  const replies = await Promise.all(
    halves.map((half, i) =>
      askJSON(
        "plan_builder",
        strategyPrompt({
          answers,
          stage: bizStage,
          identity: biz.identity,
          goal: biz.goal,
          rule: biz.rule,
          alternatives: biz.alternatives,
          ctx: context,
          map: pb.map ?? [],
          planGoal: pb.goal ?? "",
          partTitles: book.workstreams.map((w) => w.title),
          knowledgeSheet: kSheet(short.knowledge),
          toolsSheet: toolsSheetStr,
          countryCode: biz.country,
          ownedTools: ownerTools(answers, new Set(tools.map((t) => t.id))).map((id) => tools.find((t) => t.id === id)?.name ?? id),
          half,
        }),
        // The one place db/0009's own comment says "quality outranks speed" —
        // "low", not "medium", and explicit rather than inherited, so a future
        // model_config change to plan_builder's role-wide setting cannot
        // silently push this back into the empty-content failure this whole
        // incident was about.
        { maxTokens: 3600, label: `build:strategy:${i + 1}`, reasoning: { effort: "low" }, ...BUILD_CALL_CAPS },
      ),
    ),
  );
  // Each half's own fields only: a reply that wrote the other half's too is not mixed in.
  const raw: Record<string, unknown> = Object.fromEntries(
    halves.flatMap((half, i) => STRATEGY_FIELDS[half].filter((f) => f in (replies[i] ?? {})).map((f) => [f, (replies[i] as Record<string, unknown>)[f]])),
  );

  // A model sometimes returns a list as one string, or a paragraph as a
  // list or an object of parts. Round 18: "came back without how_we_win"
  // with how_we_win present — read the shape, not just the one we asked for.
  const text = (v: unknown): string =>
    typeof v === "string" ? v.trim() : Array.isArray(v) ? v.map(text).filter(Boolean).join(" ") : v && typeof v === "object" ? Object.values(v).map(text).filter(Boolean).join(" ") : "";
  const strings = (v: unknown, max: number): string[] =>
    (Array.isArray(v) ? v.map(text) : typeof v === "string" ? [v.trim()] : []).filter((x) => x.length > 0).slice(0, max);
  const ms = (raw.milestones ?? {}) as Record<string, unknown>;
  const draft: Strategy = {
    reading: strings(raw.reading, 3),
    working: strings(raw.working, 5),
    leaking: strings(raw.leaking, 5),
    how_we_win: text(raw.how_we_win),
    wont_do: strings(raw.wont_do, 3),
    money_logic: text(raw.money_logic),
    milestones: { d30: text(ms.d30), d60: text(ms.d60), d90: text(ms.d90) },
    risks: Array.isArray(raw.risks)
      ? (raw.risks as { risk?: unknown; response?: unknown }[])
          .map((r) => ({ risk: String(r.risk ?? "").trim(), response: String(r.response ?? "").trim() }))
          .filter((r) => r.risk && r.response)
          .slice(0, 3)
      : [],
  };
  // Live, 2026-09-23: this condition used to be an `if` with no else — a
  // draft with no reading or no how_we_win left the strategy null, the
  // stage marked done, and nothing on record anywhere. It is a failure,
  // and it is now said to be one.
  if (!draft.reading.length || !draft.how_we_win) {
    throw new Error(`strategy came back without ${!draft.reading.length ? "its reading" : "how_we_win"} (fields present: ${Object.keys(raw).join(", ") || "none"}; how_we_win was ${JSON.stringify(raw.how_we_win ?? null).slice(0, 80)})`);
  }
  // The strategy is where the model writes at its most fluent — which is
  // exactly where an invented number or a phantom "you told me" slips in.
  const checked = await checkStrategy(
    // Every field, item by item — milestones and risks included. They
    // used to be left out entirely, and an invented price reached the
    // owner through milestones.d90 unhedged (see checkStrategy).
    flattenStrategy(draft),
    toolsSheetStr,
    String(context.one_liner ?? ""),
    // Priority 2: lets checkStrategy's traceability sub-check verify
    // each field against the real diagnostic, not just against a
    // summary the same pipeline already wrote. Priority 2b: knownFacts
    // lets it catch a drifted name mechanically, same as every other
    // owner-facing reply.
    {
      businessId: biz.id,
      answers,
      knownFacts: businessKnownFacts(biz),
      // NOT the plan's goal: that is model output from the context stage
      // (told to "make it concrete with a number") that the person never
      // confirmed — as grounding it would launder exactly the invented
      // figure this check exists to catch (review of 3aad635).
      grounding: { established_identity: biz.identity, chosen_goal: biz.goal, chosen_rule: biz.rule },
    },
  );
  // Bug 2, the surface the judged check kept missing: every figure in
  // every strategy item is traced mechanically to the person's answers or
  // the verified costs in the library sheets this call was given.
  const given = groundingFrom(answers, [toolsSheetStr, kSheet(short.knowledge)]);
  const grounded = await groundMoneyFields(checked.fields, Object.keys(checked.fields), given, "sentence", { businessId: biz.id, surface: "strategy" });
  await recordPriceGrounding(biz.id, "strategy", grounded.hedged);
  return unflattenStrategy(draft, grounded.value);
}

// ── Stage 2a: the strategy — the narrative two-thirds of the document ──

export async function runStrategyStage(biz: Business): Promise<void> {
  const pb = await getPlanBuild(biz.id);
  if (!pb || pb.stage !== "building" || pb.strategy_done) return;

  // Two tries, then a LOUD failure. Live, 2026-09-23: a finished build had
  // plans.strategy NULL, strategy_done true, last_error null — the person got
  // a plan with its whole strategy half missing, and nothing anywhere said
  // so. A failed strategy still does not cost the person their steps (the
  // document has a fallback for exactly this), but it is now recorded where
  // it can be seen: plan_builds.last_error, a plan_strategy safety event
  // that /api/health counts, and one honest line to the person at hand-over.
  const attempt = (): Promise<Strategy> => writeStrategy(biz, pb);

  let strategy: Strategy | null = null;
  const errors: string[] = [];
  // The second try only if there is time for it: the worker function has
  // 300s, and a job killed mid-call sits "running" until its lease expires
  // while the person waits. Past this, fail loudly now instead.
  const started = Date.now();
  const SECOND_TRY_BUDGET_MS = 100_000;
  // No second try in less than a build call may start with (BUILD_CALL_MIN_MS)
  // and the moment kept to record it: the call would refuse to start anyway.
  const STRATEGY_TRY_MS = BUILD_CALL_MIN_MS + 10_000;
  for (let i = 0; i < 2 && !strategy; i++) {
    // Round 10, live: the stage's own clock said there was time, but the job
    // had started late in its invocation, and the second try was killed by
    // the platform mid-call. The invocation's clock (jobMsLeft) decides too.
    const left = jobMsLeft();
    const outOfTime = i > 0 && (Date.now() - started > SECOND_TRY_BUDGET_MS || (left !== null && left < STRATEGY_TRY_MS));
    if (outOfTime) {
      // Not the last attempt: hand the whole stage to a fresh worker with a
      // full budget, rather than saving a plan with its strategy missing.
      if (!onLastAttempt()) throw new DeadlineError("a second strategy attempt", left ?? 0);
      errors.push(`second attempt skipped: out of time after ${Math.round((Date.now() - started) / 1000)}s`);
      break;
    }
    // Keeps plan_builds' heartbeat fresh while a slow call runs, so health
    // and the reclaim sweep see a live build, not a stale one.
    await heartbeatPlanBuild(biz.id);
    try {
      strategy = await attempt();
    } catch (err) {
      if (err instanceof JobFencedError) throw err;
      rethrowIfRetryable(err);
      errors.push((err as Error)?.message ?? String(err));
      console.warn(`strategy attempt ${i + 1} failed`, err);
    }
  }
  // Handed over at the deadline while this was being written: the plan is
  // with the person, and the repair writes the strategy into it — with this
  // one, if there is one, instead of paying for another.
  if (await handedOverSince(biz.id)) {
    const adopted = strategy ? await adoptLateStrategy(biz.id, pb.created_at, strategy) : false;
    track("plan_build_lane_late", { category: "performance", businessId: biz.id, ms: since(started), props: { step: "strategy", ok: Boolean(strategy), adopted } });
    return;
  }
  const failure = strategy ? null : `strategy missing after 2 attempts: ${errors.join(" | ")}`.slice(0, 1500);
  if (failure) {
    await recordSafetyEvent({ businessId: biz.id, check: "plan_strategy", engine: "none", outcome: "flag", flags: ["strategy_missing"], detail: failure });
    // The person is told at hand-over that this was "flagged to be fixed"
    // (runPdfStage). This event, emailed at once, is that flag. Each error's
    // head only: its tail can quote the model's reply, kept in the row above.
    trackFailure("strategy_missing", new Error(errors.map((e) => e.split(" (")[0]).join(" | ") || "no attempt ran"), {
      severity: "error",
      alert: "immediate",
      ms: since(started),
      props: { errors: errors.length },
      fingerprint: "strategy_missing",
      summary: "A plan went out without its written strategy; the person was told it has been flagged to be fixed",
    });
  }

  if (!(await saveStrategyStage(biz.id, strategy, failure)) && strategy) {
    // Handed over in the moment between the check above and the save.
    const adopted = await adoptLateStrategy(biz.id, pb.created_at, strategy);
    if (adopted) track("plan_build_lane_late", { category: "performance", businessId: biz.id, ms: since(started), props: { step: "strategy", ok: true, adopted } });
  }
  track("plan_build_stage_done", { category: "performance", ms: since(started), props: { step: "strategy", ok: Boolean(strategy), errors: errors.length } });
  if (await tryAdvanceToFinalize(biz.id)) await enqueuePlanBuildStage(biz.id, "finalize");
}

// ── Stage 2b: tailor each part of the plan ────────────────────────

/** What tailoring one part needs: the build's own reads, passed in so a stage reads them once for all its parts. */
export interface PartInputs {
  biz: Business;
  goal: string;
  context: HouseholdContext;
  book: NonNullable<ReturnType<typeof pickPlaybook>>;
  knowledge: Awaited<ReturnType<typeof knowledgeFor>>;
  tools: Awaited<ReturnType<typeof toolsFor>>;
  /** Banking or savings products the person already uses (build.ts ownerTools). */
  owned: string[];
}

/**
 * One part of the plan tailored to this business, every step checked: what
 * the workstreams stage saves, and what a plan repair (engine/repair.ts)
 * writes over a part that went out in library wording. Null when the
 * playbook no longer has the part. When tailoring fails (and this attempt
 * is not to be retried), the part comes back in library wording, marked
 * `untailored`, so the hand-over can say so and a repair can redo it.
 */
/**
 * From this many steps a part is tailored as two parallel calls. Round 24,
 * live: "Land your first standing contracts", the only part with four
 * steps (each with a ready-to-send artifact), made 6 of the 8 failed build
 * calls, the four slowest that succeeded (218-248s, on second tries), and
 * every part handed over late. Its model writes at a steady ~30 tokens a
 * second, so the time is the length: two halves at once take about half.
 */
export const SPLIT_PART_FROM_STEPS = 4;
export function partHalves(ids: string[]): string[][] {
  if (ids.length < SPLIT_PART_FROM_STEPS) return [ids];
  const mid = Math.ceil(ids.length / 2);
  return [ids.slice(0, mid), ids.slice(mid)];
}

/** A part exactly as the library words it, marked so the hand-over says so and a repair redoes it. */
const libraryWording = (ws: Parameters<typeof hydrateWorkstream>[0]): HydratedWorkstream => ({ ...hydrateWorkstream(ws, null), untailored: true });

/**
 * A part in library wording for this country and this owner's tools, with no
 * model call: what the hand-over deadline sends for a part still being
 * tailored. Fixed library text (rule 1), so there is nothing invented to check.
 */
export function libraryPart(book: NonNullable<ReturnType<typeof pickPlaybook>>, wsId: string, countryToolIds: ReadonlySet<string>, owned: string[]): HydratedWorkstream | null {
  const libraryWs = book.workstreams.find((w) => w.id === wsId);
  return libraryWs ? libraryWording(withOwnerTools(forCountry(libraryWs, countryToolIds), owned)) : null;
}

export async function tailorPart(inp: PartInputs, wsId: string): Promise<HydratedWorkstream | null> {
  const { biz, goal, context, book, knowledge, tools, owned } = inp;
  const answers = biz.answers || {};
  const bizStage = biz.biz_stage || "stretching";
  const countryToolIds = new Set(tools.map((t) => t.id));
  const libraryWs = book.workstreams.find((w) => w.id === wsId);
  if (!libraryWs) return null;
  const i = book.workstreams.indexOf(libraryWs);
  // Only this country's tools may be offered — see forCountry().
  const ws = withOwnerTools(forCountry(libraryWs, countryToolIds), owned);
  const prior = book.workstreams
    .slice(0, i)
    .map((x) => `${x.title}: ${x.steps.map((y) => y.title).join("; ")}`)
    .join(". ");

  const subject = [ws.title, ws.why, ...ws.steps.map((s) => `${s.title} ${s.brief}`)].join(" ");
  // A step names its knowledge per country; only this country's row survives.
  const pinKnowledge = stepKnowledgePins(ws.steps, knowledge, biz.country);
  const pinTools = ws.steps.flatMap((s) => s.tool_choices ?? []);

  const short = await shortlist(
    knowledge,
    tools,
    {
      text: subject,
      stage: bizStage,
      domain: ws.domain,
      headache: answers.objective || answers.blockers,
      pinKnowledge,
      pinTools,
      maxKnowledge: 6,
      maxTools: Math.max(6, pinTools.length),
    },
    { businessId: biz.id, country: biz.country, log: false },
  );
  const toolsSheetStr = tSheet(short.tools);

  let hydrated: HydratedWorkstream;
  try {
    // A long part is written as parallel halves (SPLIT_PART_FROM_STEPS):
    // each call sees the whole part and writes only its own steps.
    const halves = partHalves(ws.steps.map((st) => st.id));
    const replies = await Promise.all(
      halves.map((ids, i) =>
        askJSON(
          "plan_builder",
          workstreamPrompt({
            answers,
            stage: bizStage,
            goal: biz.goal,
            rule: biz.rule,
            ctx: context,
            ws,
            prior,
            identity: biz.identity,
            knowledgeSheet: kSheet(short.knowledge),
            toolsSheet: toolsSheetStr,
            countryCode: biz.country,
            planGoal: goal,
            ownedTools: owned.map((id) => tools.find((t) => t.id === id)?.name ?? id),
            ...(halves.length > 1 ? { writeOnly: ids } : {}),
          }),
          // Tailoring a fixed module's wording to this business is closer to
          // the strategy step than to pure extraction — kept at "low" for
          // the same reason. See build:strategy:1/2 above.
          { maxTokens: halves.length > 1 ? 2800 : 4400, label: halves.length > 1 ? `build:ws:${ws.id}:${i + 1}` : `build:ws:${ws.id}`, reasoning: { effort: "low" }, ...BUILD_CALL_CAPS },
        ),
      ),
    );
    // Each half keeps only the steps it was asked for; the part's own line comes from the first.
    const steps = replies.flatMap((r, i) => ((r as { steps?: { id?: string }[] }).steps ?? []).filter((st) => halves.length === 1 || halves[i]!.includes(String(st?.id))));
    hydrated = hydrateWorkstream(ws, { why_for_you: String((replies[0] as { why_for_you?: unknown }).why_for_you ?? ""), steps } as never);
  } catch (err) {
    if (err instanceof JobFencedError) throw err;
    rethrowIfRetryable(err);
    // One part failing must not lose the other two. The untailored
    // version still carries the real method, just in library wording.
    console.log(`workstream ${ws.id} tailoring failed`, err);
    trackFailure("workstream_untailored", err, {
      severity: "warn",
      props: { workstream: ws.id },
      summary: `Plan part ${ws.id} went out in library wording: tailoring it to the person failed`,
    });
    hydrated = libraryWording(ws);
  }

  // Every step is checked before it is stored — independently of
  // whatever the generating call claims about itself.
  const steps = await Promise.all(
    hydrated.steps.map(async (st) => {
      const base = ws.steps.find((s) => s.id === st.id);
      const r = await checkStepCompliance(st.push, st.artifact, toolsSheetStr, {
        businessId: biz.id,
        libraryOutcome: base?.outcome ?? "",
        title: st.title,
        // Priority 2b: a step's push/artifact is prose tailored fresh
        // for this business, exactly where a name can drift.
        knownFacts: businessKnownFacts(biz),
      });
      // Belt and braces with step_compliance's judged ungrounded_price
      // (which the live test showed working): the same arithmetic as the
      // strategy. Never the artifact — that is text the person sends to
      // their own customers, where a hedge would read as nonsense.
      const given = groundingFrom(answers, [toolsSheetStr, kSheet(short.knowledge)]);
      const g = await groundMoneyFields({ push: r.push, why_for_you: st.why_for_you }, ["push", "why_for_you"], given, "sentence", { businessId: biz.id, surface: `step ${st.id}` });
      if (g.hedged.length) await recordPriceGrounding(biz.id, `step ${st.id}`, g.hedged);
      return { ...st, push: g.value.push, why_for_you: g.value.why_for_you, artifact: r.artifact };
    }),
  );

  // The workstream's own "why this matters for you" is printed in the
  // plan document too — the same arithmetic as its steps.
  const wsGiven = groundingFrom(answers, [toolsSheetStr, kSheet(short.knowledge)]);
  const wsWhy = await groundMoneyFields({ why_for_you: hydrated.why_for_you ?? "" }, ["why_for_you"], wsGiven, "sentence", { businessId: biz.id, surface: `workstream ${ws.id}` });
  if (wsWhy.hedged.length) await recordPriceGrounding(biz.id, `workstream ${ws.id}`, wsWhy.hedged);

  return { ...hydrated, why_for_you: wsWhy.value.why_for_you, steps };
}


export async function runWorkstreamsStage(biz: Business): Promise<void> {
  const stageStarted = Date.now();
  const pb = await getPlanBuild(biz.id);
  if (!pb || pb.stage !== "building") return;
  if (!pb.pending_workstreams.length) {
    if (await tryAdvanceToFinalize(biz.id)) await enqueuePlanBuildStage(biz.id, "finalize");
    return;
  }

  const answers = biz.answers || {};
  const bizStage = biz.biz_stage || "stretching";
  const book = pickPlaybook(bizStage, biz.signals ?? {}, answers, biz.goal || [], pb.dropped_modules);
  const context = pb.context;
  if (!book || !context) throw new Error("workstreams: context stage did not leave enough behind");

  const [knowledge, tools] = await Promise.all([knowledgeFor(biz.country), toolsFor(biz.country)]);

  // Each part gets its OWN shortlist, scored against that part's subject —
  // not the whole country's library. Run concurrently, same as the
  // monolithic build did with Promise.all; only the SAVE below is
  // sequential, to avoid a read-modify-write race on plan_builds.workstreams.
  const countryToolIds = new Set(tools.map((t) => t.id));
  const owned = ownerTools(answers, countryToolIds);
  // Each part is saved the moment it is done, one save at a time (see
  // saveWorkstreamResult). Live test, round 11: one part ran out of time,
  // the stage threw, and the parts that HAD finished were thrown away with
  // it — the retry redid all of them, ~4.7 minutes of work paid for twice.
  // Now the retry finds only the unfinished part still pending.
  let saving: Promise<unknown> = Promise.resolve();
  let untailored = 0;
  let late = 0;
  const settled = await Promise.allSettled(
    pb.pending_workstreams.map(async (wsId) => {
      const done = await tailorPart({ biz, goal: pb.goal ?? "", context, book, knowledge, tools, owned }, wsId);
      if (!done) return null; // module audit dropped it after this job was already enqueued — nothing to save
      if (done.untailored) untailored++;
      // Sequential on purpose — see the comment above saveWorkstreamResult.
      // Not saved because the build was handed over at its deadline with
      // this part in library wording: kept for the repair (adoptLatePart).
      saving = saving.then(async () => {
        if (!(await saveWorkstreamResult(biz.id, done.id, done)) && !done.untailored && (await adoptLatePart(biz.id, pb.created_at, done))) late++;
      });
      await saving;
      return done.id;
    }),
  );
  await saving;
  // A part that failed (out of time, fenced off) fails the stage AFTER the
  // others are safely saved, so the retry has only that part left to do.
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  track("plan_build_stage_done", { category: "performance", ms: since(stageStarted), props: { step: "workstreams", parts: settled.length, untailored } });
  if (late) track("plan_build_lane_late", { category: "performance", businessId: biz.id, ms: since(stageStarted), props: { step: "workstreams", ok: true, adopted: late } });

  if (await tryAdvanceToFinalize(biz.id)) await enqueuePlanBuildStage(biz.id, "finalize");
}

// ── Stage 3: write the plan ────────────────────────────────────────

export async function runFinalizeStage(biz: Business): Promise<void> {
  const stageStarted = Date.now();
  const pb = await getPlanBuild(biz.id);
  if (!pb || pb.stage !== "finalize") return;

  if (pb.plan_id) {
    // A previous attempt got this far already — nothing left but the PDF.
    await enqueuePlanBuildStage(biz.id, "pdf");
    return;
  }

  try {
    const bizStage = biz.biz_stage || "stretching";
    const book = pickPlaybook(bizStage, biz.signals ?? {}, biz.answers || {}, biz.goal || [], pb.dropped_modules);
    if (!book) throw new Error("finalize: playbook no longer resolves for this business");
    const ordered = book.workstreams.map((w) => pb.workstreams.find((x) => x.id === w.id)).filter((w): w is HydratedWorkstream => Boolean(w));

    const { data: planRow, error: planErr } = await db()
      .from("plans")
      .insert({ business_id: biz.id, goal: pb.goal, headline: book.headline, strategy: pb.strategy })
      .select()
      .single();
    if (planErr) throw planErr;
    const planId = (planRow as { id: string }).id;

    // PRIORITY 5.1's gap, closed: this is the row `plan_steps.artifact`
    // actually comes from. checkStepCompliance above already ran on
    // st.push/st.artifact, but only for tone/safety (sensitive data, invented
    // claims) — never for an unresolved "[...]" placeholder, which is a
    // different failure (see engine/artifact.ts). Guarding here means the
    // stored row itself never carries a raw, half-filled template — belt and
    // braces alongside plandoc.ts and connector.ts guarding again at their
    // own read time. Grounded against `pb.context` rather than `biz.context`
    // deliberately: this stage runs BEFORE the `updateBusiness` a few lines
    // down persists the just-built context onto the business row itself, so
    // `biz.context` here is still whatever it was before this build — often
    // nothing at all on a business's first plan — while `pb.context` is the
    // name/location this exact build just settled on.
    const stepRows = ordered.flatMap((w, wi) =>
      w.steps.map((st, si) => {
        const artifact = checkArtifact(st.artifact, { context: pb.context, identity: biz.identity });
        return {
          plan_id: planId,
          workstream_title: w.title,
          domain: w.domain,
          step_order: wi * 100 + si,
          step_key: st.id,
          title: st.title,
          push: st.push,
          // The message itself, brackets and all — never the old apology in its
          // place (round 18). Every reader runs it through checkArtifact again.
          artifact: artifact.text ?? artifact.draft,
          tool_id: st.tool_id ?? null,
          why_for_you: st.why_for_you,
          done_when: st.done_when,
          status: "open",
        };
      }),
    );
    if (stepRows.length) {
      const { error } = await db().from("plan_steps").insert(stepRows);
      if (error) throw error;
    }

    // The map is also written to its own table, normalised, because the
    // connector and any sponsor reporting read it from there.
    const { error: mapErr } = await db()
      .from("business_map")
      .upsert(
        (pb.map ?? []).map((m) => ({ business_id: biz.id, domain: m.domain, status: m.status, note: m.note, updated_at: new Date().toISOString() })),
        { onConflict: "business_id,domain" },
      );
    // Not fatal to the plan, but the connector would read a stale map: on the record.
    if (mapErr) console.error("finalize: business_map upsert failed", mapErr.message);

    await updateBusiness(biz.id, {
      context: pb.context ?? undefined,
      map: pb.map ?? undefined,
      current_plan_id: planId,
      stage: "plan_ready",
      pending_action: null,
      ...dayOneFields(biz, pb.map ?? []),
    });

    // Nothing is sent here. "Your plan is done… Sending the whole thing as a
    // PDF now" used to go out at this point, and the PDF is a separate stage
    // that could then sit queued for minutes (founder, 2026-09-24: say it's
    // ready only when it is). The outline now goes out in the PDF stage,
    // immediately before the document itself.
    await saveFinalizeStage(biz.id, planId);
    await enqueuePlanBuildStage(biz.id, "pdf");
    track("plan_build_stage_done", { category: "performance", ms: since(stageStarted), props: { step: "finalize", parts: ordered.length, steps: stepRows.length } });
  } catch (err) {
    // A fenced-off attempt (jobctx.ts) must not write fallback state over the live one.
    if (err instanceof JobFencedError) throw err;
    await fenceCheck();
    // The same heuristic recovery the monolithic build used: a failure late
    // in this sequence (e.g. the message send, after both inserts already
    // landed) might have still left a real plan behind — check before
    // assuming nothing was written and duplicating it on retry.
    const existing = await planFor(biz.id).catch(() => null);
    if (existing?.steps.length) {
      // The error is swallowed from here on: this is its only record. A plan
      // saved before this build began is the PREVIOUS one (a rebuild whose
      // own write failed): the person is handed their old steps as the new 90
      // days, which is not a recovery.
      const olderPlan = Date.parse(existing.plan.created_at ?? "") < Date.parse(pb.created_at ?? "");
      trackFailure("plan_finalize_recovered", err, {
        severity: olderPlan ? "error" : "warn",
        ms: since(stageStarted),
        props: { steps: existing.steps.length, older_plan: olderPlan },
        summary: olderPlan
          ? "Writing a new plan failed, and the person's previous plan was handed over in its place"
          : "Writing a plan failed part-way, but a saved plan was found and used",
      });
      await saveFinalizeStage(biz.id, existing.plan.id);
      await updateBusiness(biz.id, { current_plan_id: existing.plan.id, stage: "plan_ready", pending_action: null });
      await enqueuePlanBuildStage(biz.id, "pdf");
      return;
    }
    throw err;
  }
}

// ── Stage 4: the PDF ───────────────────────────────────────────────

export async function runPdfStage(biz: Business): Promise<void> {
  const stageStarted = Date.now();
  const pb = await getPlanBuild(biz.id);
  if (!pb || pb.stage !== "pdf" || !pb.plan_id) return;

  const bizStage = biz.biz_stage || "stretching";
  const book = pickPlaybook(bizStage, biz.signals ?? {}, biz.answers || {}, biz.goal || [], pb.dropped_modules);
  const ordered = book ? book.workstreams.map((w) => pb.workstreams.find((x) => x.id === w.id)).filter((w): w is HydratedWorkstream => Boolean(w)) : pb.workstreams;

  const tools = await toolsFor(biz.country);
  const toolsById = Object.fromEntries(tools.map((t) => [t.id, t]));
  const context = pb.context;

  const connectorUrl = await existingConnectorUrl(biz.id);
  // A strategy that went out missing is written after the hand-over
  // (engine/repair.ts), queued here, before the document is drawn, so the
  // document can say it is on its way. A strategy its lane finished after
  // the deadline, before this stage read the row, is in the document; the
  // stored plan (what the web page and a later PDF render) may have been
  // written without it.
  if (pb.strategy) await db().from("plans").update({ strategy: pb.strategy }).eq("id", pb.plan_id).is("strategy", null);
  const untailored = ordered.filter((w) => w.untailored);
  const handedOver = (pb.last_error ?? "").includes(HANDED_OVER);
  const repairQueued = await queuePlanRepair(biz.id, { plan_id: pb.plan_id, parts: untailored.map((w) => w.id), strategy: !pb.strategy, queued_at: new Date().toISOString() });
  const html = planDocHTML({
    productName: PRODUCT_NAME,
    countryCode: biz.country,
    ownerWords: biz.answers?.objective ?? null,
    ctx: {
      name: context?.name ?? "",
      one_liner: context?.one_liner ?? "",
      location: context?.location ?? "",
      goal: pb.goal ?? "",
      earns: context?.earns,
      depends: context?.depends,
      income: context?.income,
      owes: context?.owes,
      cushion: context?.cushion,
      cover: context?.cover,
      records: context?.records,
      statement: context?.statement,
    },
    stage: bizStage,
    objectiveRead: biz.objective_read || "",
    goal: biz.goal || [],
    rule: biz.rule || [],
    alternatives: biz.alternatives || [],
    map: pb.map ?? [],
    plan: { headline: book?.headline ?? "", order_note: book?.order_note ?? "", workstreams: ordered, goal: pb.goal ?? "" },
    strategy: pb.strategy,
    tools: toolsById,
    planUrl: planUrl(),
    connectorUrl,
    strategyPending: !pb.strategy && repairQueued,
  });

  const filename = `${(context?.name || "my").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "my"}-90-day-money-plan.pdf`;

  // The outline, the document and the hand-over arrive together, and nothing
  // is announced before it can be handed over: the PDF is rendered FIRST
  // (up to two minutes, and it can fail), then the outline says what is
  // actually coming. A render failure is never worth failing the build over.
  // A failed render, upload or send is recorded by pdfclient.ts (pdf_failed), at its cause.
  const renderStarted = Date.now();
  const bytes = await renderPdf(html, "plan");
  const renderMs = since(renderStarted);
  // Its second chance (round 22: one 508 and the person never got the file).
  // A failed render is tried again by a plan_pdf job a minute later, from
  // the stored plan (engine/planpdf.ts), and the person is told so.
  const pdfRetry = bytes || !pdfConfigured() ? false : await enqueueForPlan("plan_pdf", biz.id, pb.plan_id, {}, 60).then(
    () => true,
    (err) => {
      console.error("pdf stage: could not queue the PDF's retry", err);
      return false;
    },
  );
  const totalSteps = ordered.reduce((n, w) => n + w.steps.length, 0);
  const outline = ordered.map((w, i) => `${i + 1}. ${w.title}\n${w.steps.map((x) => `   • ${x.title}`).join("\n")}`).join("\n\n");
  const online = planUrl();
  await sendText(
    biz.wa_id,
    `Your 90-day money plan is ready. ${totalSteps} steps across ${ordered.length} part${ordered.length === 1 ? "" : "s"}, built around: ${pb.goal}\n\n${outline}${book?.order_note ? `\n\n${book.order_note}` : ""}\n\n` +
      (bytes
        ? "The full document is right below."
        : `The PDF didn't come out just then — that's on me, not on your plan. ${pdfRetry ? "I'll try it again in a minute and send it here. " : ""}Everything is saved${online ? `, and you can read the whole thing online at ${online}` : ""}.`),
    biz.id,
  );
  const sent = bytes ? await deliverRenderedPdf(bytes, biz.wa_id, filename, "Your 90-day money plan.", biz.id, "plan") : null;
  const delivered = sent?.ok === true;
  if (delivered) track("plan_pdf_sent", { ms: renderMs, props: { kb: Math.round((bytes?.byteLength ?? 0) / 1024), parts: ordered.length, steps: totalSteps } });
  if (sent && !delivered) {
    // Rendered but not uploaded: the same second chance as a failed render
    // (review, round 22). A refused send may have landed, and a closed
    // window cannot be reached: those get the button instead.
    const retry = sent.phase === "upload" && (await enqueueForPlan("plan_pdf", biz.id, pb.plan_id, {}, 60).then(() => true, () => false));
    const text = `The document didn't come through on WhatsApp just then. ${retry ? "I'll try it again in a minute and send it here. " : ""}Everything is saved${online ? ` — read the whole plan online at ${online}` : ""}.`;
    if (retry || sent.windowClosed) await sendText(biz.wa_id, text, biz.id);
    else await sendButtons(biz.wa_id, `${text} Tap below to try again.`, [SEND_PDF_BUTTON], biz.id);
  }

  // The hand-over, framed: where the plan lives, how the next 90 days work,
  // and that questions are welcome at any point — first testers wanted
  // exactly this said out loud once the report arrived. Founder, 2026-09-24:
  // every button has to say it is about the 90-day plan, and "connect" has to
  // say what it does for someone who has never heard of a connector.
  await sendText(
    biz.wa_id,
    // Only what the two messages above have not said. It used to announce
    // the plan a third time ("is ready" / the PDF / "is here — it's the
    // document just above") and repeat the link a failed PDF had just given.
    (delivered && online ? `You can also read it online at ${online}, and ask me about any part of it there.\n\n` : "") +
      // Rinse, 2026-09-24: the plan's narrow focus read as all there was.
      // Say it is deliberate, and that it can change once the first thing works.
      (pb.goal ? `It's focused on one thing on purpose: ${pb.goal.replace(/[.\s]+$/, "")}. Get that steady first — after that, we can change the plan or add other things. Just tell me, or tap "Change my plan".\n\n` : "") +
      // Never silent: when the strategy write-up failed (recorded in
      // plan_builds.last_error and a plan_strategy safety event) or a part
      // went out in library wording, say which, and what happens next.
      (() => {
        const n = degradedNote(untailored, !pb.strategy, repairQueued, handedOver);
        return n ? `${n}\n\n` : "";
      })() +
      "How the 90 days work:\n" +
      "1. I send you one step from your plan.\n" +
      "2. You do it, in your own time.\n" +
      "3. You tell me it's done.\n" +
      "4. I ask how it went, then send the next one.\n\n" +
      "Got a question — about a step, a letter from a lender, a fee, anything about your money? Just ask me here, any time." +
      // A person already connected must not be sent to "connect" — their AI
      // already reads this plan, and a new address would replace theirs.
      (connectorUrl
        ? "\n\nYour ChatGPT or Claude connection already reads this plan — nothing to update."
        : planUrl()
          ? '\n\nDo you use ChatGPT or Claude? You can give it your money picture and this plan, so it already knows your situation and you never have to explain it from the start. Send "connect" and I\'ll show you how, step by step.'
          : ""),
    biz.id,
  );
  // The Money Map as a page they can open and tap (engine/cards.ts): the
  // link only, since the hand-over has already spent its time on the PDF.
  try {
    const { cardLink } = await import("./cards.js");
    const map = await cardLink({ ...biz, map: pb.map ?? biz.map ?? null }, "map");
    if (map) await sendText(biz.wa_id, `Your Money Map, as a page you can tap through: ${map.url}`, biz.id);
  } catch (err) {
    console.warn("hand-over: map card not sent", err);
  }
  await sendButtons(
    biz.wa_id,
    "Ready when you are:\n\n" +
      "• Start step 1 — I send you the first step of your 90-day money plan.\n" +
      "• Why this order? — why the steps in your plan come in the order they do.\n" +
      "• Change my plan — tell me a step, tool or detail that doesn't fit.",
    [
      { id: ACT.NEXT_STEP, title: "Start step 1" },
      { id: ACT.WHY_ORDER, title: "Why this order?" },
      { id: ACT.CHANGE, title: "Change my plan" },
    ],
    biz.id,
  );

  await finishPlanBuild(biz.id);
  // The repair queued above waits for the hand-over (engine/repair.ts): it has gone.
  if (repairQueued) await wakeHeldRepair(biz.id).catch((err) => console.warn("pdf stage: could not wake the plan repair", err));
  // A question the person asked during the diagnostic, answered now that the
  // plan is with them (engine/kept.ts). Queued behind the hand-over, never
  // part of it: it cannot fail the build.
  await queueKeptQuestions(biz.id, "plan_ready");
  track("plan_build_stage_done", { category: "performance", ms: since(stageStarted), props: { step: "pdf", pdf: delivered } });
  // `ms` is the whole build as the person waited for it: from the start of
  // this attempt (resetPlanBuild), a failure and its revival included.
  const startedAt = pb.created_at ? Date.parse(pb.created_at) : Number.NaN;
  track("plan_ready", {
    category: "funnel",
    ms: Number.isFinite(startedAt) ? Date.now() - startedAt : null,
    props: {
      parts: ordered.length,
      steps: totalSteps,
      modules: ordered.map((w) => w.id),
      pdf: delivered,
      strategy: Boolean(pb.strategy),
      // A failed build picked back up (reviveFailedBuild's note). Not just
      // any last_error: a missing strategy writes one too, and is `strategy`.
      revived: /previous error:/.test(pb.last_error ?? ""),
      // Handed over at the deadline with something still being written.
      handed_over: handedOver,
    },
  });
  // Live, 2026-09-23: a build took over five minutes with nothing saying
  // where. One plan_build_timing row per finished build; never throws.
  await recordPlanBuildTiming(biz.id);
}
