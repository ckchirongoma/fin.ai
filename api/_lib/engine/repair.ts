// Charles — redoing a part of the plan that went out degraded.
//
// Round 22, live: of twelve builds, four shipped with something missing.
// GH's had no written strategy (the person was told it was "flagged to be
// fixed", and nothing ever fixed it); ZA's and GHb's headline part, "Land
// your first standing contracts", went out in library wording when
// tailoring it ran out of time — and nobody told those people at all.
//
// A plan with a gap still beats no plan, so the build keeps shipping on its
// last attempt. What changes is what happens next: the hand-over says which
// part is missing or generic, and this job redoes it once the person has the
// plan — the same strategy writer and the same part tailoring the build uses
// (engine/planbuild.ts writeStrategy, tailorPart), the same checks on every
// word. What it writes goes into the stored plan, which is what the web page
// and any later PDF are rendered from (engine/planpdf.ts), and the person is
// told it is done.
//
// Keyed on the business only, never the person's number: a repair takes a
// minute or two of model calls, and the person's own messages must not wait
// behind it.

import { buildLanesRunning, db, enqueueForPlan, REPAIR_HELD, findBusinessById, getPlanBuild, knowledgeFor, toolsFor, updatePlanBuildWorkstream } from "../db.js";
import { JobHoldError } from "../jobctx.js";
import { pickPlaybook } from "../playbooks.js";
import { sendButtons } from "../wa.js";
import { since, track } from "../track.js";
import { ownerTools, planUrl } from "./build.js";
import { checkArtifact } from "./artifact.js";
import { HANDED_OVER, tailorPart, writeStrategy } from "./planbuild.js";
import { SEND_PDF_BUTTON } from "./planpdf.js";
import { ACT } from "../actions.js";
import type { Business, HydratedWorkstream, JobRow, PlanBuildRow } from "../types.js";

export interface RepairPayload {
  plan_id: string;
  /** Library part ids that went out untailored. */
  parts: string[];
  /** True when the written strategy is missing. */
  strategy: boolean;
  /** Progress, so a retry does not redo what is done… */
  parts_done?: string[];
  strategy_done?: boolean;
  /** Parts whose rewrite reached the stored plan (some steps may have moved on and been left). */
  rewritten?: string[];
  /** …and what the person has been told, so it is said once. */
  told_parts?: string[];
  told_strategy?: boolean;
  /** When the hand-over queued it: how long it may wait for the build's own late lanes. */
  queued_at?: string;
}

/**
 * How long a repair waits, from the hand-over, for the build's own strategy
 * or workstreams job still running when the build was handed over at its
 * deadline (engine/planbuild.ts). Such a job ends within one attempt (270s
 * at most), and whatever it finishes is used instead of paying for it again;
 * queue.ts wakes the repair the moment it ends. Past this, the repair writes
 * its own.
 */
export const REPAIR_WAITS_FOR_LANES_MS = 300_000;
/**
 * Longer than queue.ts HAND_ON_WITHIN_MS (60s), so no worker is woken just to
 * sit and wait for it: the lane's own end wakes it (db.ts wakeHeldRepair),
 * and the tick looks every minute.
 */
const REPAIR_HOLD_MS = 90_000;

/** Queued by the hand-over (runPdfStage). Never throws: the hand-over is never failed over this. */
export async function queuePlanRepair(businessId: string, payload: RepairPayload): Promise<boolean> {
  if (!payload.parts.length && !payload.strategy) return false;
  try {
    await enqueueForPlan("plan_repair", businessId, payload.plan_id, payload as unknown as Record<string, unknown>, 20);
    return true;
  } catch (err) {
    console.error("plan-repair: could not queue it", err);
    return false;
  }
}

/** "See every rand you owe" and "Build a cushion you can reach". */
const titlesOf = (titles: string[]): string => (titles.length > 1 ? `${titles.slice(0, -1).map((t) => `"${t}"`).join(", ")} and "${titles[titles.length - 1]}"` : `"${titles[0]}"`);

/**
 * What the hand-over says about a degraded plan: true, and naming what
 * happens next. Empty when nothing is missing.
 */
export function degradedNote(untailored: Pick<HydratedWorkstream, "title">[], strategyMissing: boolean, repairQueued: boolean, handedOver = false): string {
  const lines: string[] = [];
  if (strategyMissing) {
    lines.push(
      handedOver
        ? // Handed over at the deadline (engine/planbuild.ts): not a failure, still being written.
          `The written strategy (who we win with, the risks, the milestones) is still being written. I sent your steps first so you aren't kept waiting, and they don't depend on it. ${repairQueued ? "I'll send it to you here as soon as it's done." : "I've noted it so it gets written."}`
        : `One part didn't come out right this time: the written strategy (who we win with, the risks, the milestones). Your steps don't depend on it. ${repairQueued ? "I'm writing it again now and I'll send it to you here when it's done." : "I've noted it so it gets written."}`,
    );
  }
  if (untailored.length) {
    const t = untailored.map((w) => w.title);
    const it = t.length === 1 ? "it" : "them";
    lines.push(
      `${t.length === 1 ? `One part, ${titlesOf(t)}, is` : `${titlesOf(t)} are`} in my standard wording for now: ${handedOver ? `I sent your plan before I'd finished fitting ${it} to your situation, so you weren't kept waiting` : `I ran out of time fitting ${it} to your situation`}. The method is the same and you can start on it as it is. ${repairQueued ? `I'm rewriting ${it} for your business now and I'll tell you when that's done.` : ""}`.trim(),
    );
  }
  return lines.join("\n\n");
}

/**
 * Writes a repaired part's steps into the stored plan — only steps still as
 * they were handed over: open, never sent to the person (pushed_at), still in
 * the hand-over's wording and with its tool. A step the person has been sent,
 * started, finished, skipped or had changed since is never rewritten under
 * them (review, round 22: the hand-over's "Start step 1" can land between
 * the repair starting and its write). The sent check is in the write
 * itself, so a step sent a moment before is left alone too.
 */
async function storePart(biz: Business, planId: string, part: HydratedWorkstream, before: HydratedWorkstream | undefined, ctx: PlanBuildRow["context"]): Promise<number> {
  const { data, error } = await db().from("plan_steps").select("id, step_key, push, tool_id, status, pushed_at").eq("plan_id", planId);
  if (error) throw error;
  const rows = (data as { id: string; step_key: string | null; push: string | null; tool_id: string | null; status: string; pushed_at: string | null }[]) ?? [];
  // The step the person has open in front of them, as of now.
  const now = (await findBusinessById(biz.id)) ?? biz;
  const active = new Set([now.walk?.step_id, now.pending_action?.step_id].filter((x): x is string => typeof x === "string"));
  let n = 0;
  for (const st of part.steps) {
    const row = rows.find((r) => r.step_key === st.id);
    const was = before?.steps.find((x) => x.id === st.id);
    if (!row || row.status !== "open" || row.pushed_at || active.has(row.id)) continue;
    // Changed since the hand-over — reworded, or its tool swapped by the person ("Change my plan").
    if (was && (row.push !== was.push || (row.tool_id ?? null) !== (was.tool_id ?? null))) continue;
    const artifact = checkArtifact(st.artifact, { context: ctx, identity: biz.identity });
    const { data: hit, error: upErr } = await db()
      .from("plan_steps")
      .update({ push: st.push, artifact: artifact.text ?? artifact.draft, why_for_you: st.why_for_you, tool_id: st.tool_id ?? null })
      .eq("id", row.id)
      .eq("status", "open")
      .is("pushed_at", null)
      .select("id");
    if (upErr) throw upErr;
    if ((hit as unknown[] | null)?.length) n++;
  }
  return n;
}

export async function runPlanRepairJob(job: JobRow): Promise<void> {
  const started = Date.now();
  const p = job.payload as unknown as RepairPayload;
  const found = job.business_id ? await findBusinessById(job.business_id) : null;
  if (!found || found.deleted_at || !p?.plan_id) return;
  const biz: Business = found;
  const pb = await getPlanBuild(biz.id);
  // A newer plan (or a rebuild under way) replaced the one being repaired.
  if (biz.current_plan_id !== p.plan_id || !pb || pb.plan_id !== p.plan_id || !pb.context) {
    track("plan_repair_skipped", { category: "ops", businessId: biz.id, props: { reason: biz.current_plan_id !== p.plan_id ? "plan_replaced" : "build_row_moved_on" } });
    return;
  }
  const partsDone = new Set(p.parts_done ?? []);
  let strategyDone = p.strategy_done === true || !p.strategy;
  // The build's own lane may still be finishing what this repair is for
  // (handed over at the deadline): wait for it, once it ends queue.ts wakes
  // this job, and use what it wrote. Bounded, so a lost lane never holds it.
  const queuedAt = Date.parse(p.queued_at ?? "");
  const unfinished = !strategyDone || p.parts.some((x) => !partsDone.has(x));
  const mayWait = Number.isFinite(queuedAt) && Date.now() - queuedAt < REPAIR_WAITS_FOR_LANES_MS;
  // Queued as the hand-over's document is drawn: nothing is said about the
  // plan before the plan itself has gone out (runPdfStage wakes this job).
  if (mayWait && pb.stage === "pdf") throw new JobHoldError(`${REPAIR_HELD} for the plan's hand-over to be sent`, REPAIR_HOLD_MS);
  if (unfinished && mayWait && (await buildLanesRunning(biz.id))) {
    throw new JobHoldError(`${REPAIR_HELD} for the build's own strategy or workstreams job to finish`, REPAIR_HOLD_MS);
  }
  let adoptedStrategy = false;
  let adoptedParts = 0;
  // Parts rewritten into the stored plan (by id), and what has been said.
  const rewritten = new Set<string>(p.rewritten ?? []);
  const toldParts = new Set(p.told_parts ?? []);
  let toldStrategy = p.told_strategy === true;
  const note = async () => {
    job.payload = { ...job.payload, parts_done: [...partsDone], strategy_done: strategyDone, rewritten: [...rewritten], told_parts: [...toldParts], told_strategy: toldStrategy };
    const { error } = await db().from("jobs").update({ payload: job.payload }).eq("id", job.id);
    if (error) console.warn("plan-repair: could not note progress", error.message);
  };

  const book = pickPlaybook(biz.biz_stage || "stretching", biz.signals ?? {}, biz.answers || {}, biz.goal || [], pb.dropped_modules);
  const [knowledge, tools] = await Promise.all([knowledgeFor(biz.country), toolsFor(biz.country)]);
  const owned = ownerTools(biz.answers || {}, new Set(tools.map((t) => t.id)));
  let failure: unknown = null;

  const work: Promise<void>[] = [];
  if (!strategyDone) {
    work.push(
      (async () => {
        // Finished by the build's own lane after the hand-over (db.ts adoptLateStrategy).
        const strategy = pb.strategy ?? (await writeStrategy(biz, pb));
        adoptedStrategy = Boolean(pb.strategy);
        const { error } = await db().from("plans").update({ strategy }).eq("id", p.plan_id);
        if (error) throw error;
        await db().from("plan_builds").update({ strategy, updated_at: new Date().toISOString() }).eq("business_id", biz.id).eq("plan_id", p.plan_id);
        strategyDone = true;
      })().catch((err) => {
        failure = failure ?? err;
      }),
    );
  }
  for (const id of p.parts.filter((x) => !partsDone.has(x))) {
    work.push(
      (async () => {
        if (!book) throw new Error("plan-repair: the playbook no longer resolves for this business");
        const handed = pb.workstreams.find((w) => w.id === id);
        // Tailored by the build's own lane after the hand-over (db.ts adoptLatePart): already checked, step by step.
        const part = handed?.late ?? (await tailorPart({ biz, goal: pb.goal ?? "", context: pb.context!, book, knowledge, tools, owned }, id));
        if (handed?.late) adoptedParts++;
        if (!part) {
          partsDone.add(id); // the part is no longer in the plan: nothing to redo
          return;
        }
        if (part.untailored) throw new Error(`plan-repair: tailoring ${id} failed again`);
        const changed = await storePart(biz, p.plan_id, part, handed, pb.context);
        await updatePlanBuildWorkstream(biz.id, p.plan_id, part);
        partsDone.add(id);
        if (changed) rewritten.add(id);
      })().catch((err) => {
        failure = failure ?? err;
      }),
    );
  }
  await Promise.all(work);
  // The work is recorded first: a retry never pays for it twice.
  await note();

  // Then said, once: recorded as told only after it has gone, so a retry
  // says what this attempt could not, and never repeats what it did.
  const titleOf = (id: string): string => book?.workstreams.find((w) => w.id === id)?.title ?? pb.workstreams.find((w) => w.id === id)?.title ?? id;
  const newParts = [...rewritten].filter((id) => !toldParts.has(id));
  const newStrategy = p.strategy && strategyDone && !toldStrategy;
  const lines: string[] = [];
  // A build handed over at its deadline was told it is "still being written", not missing.
  const handedOver = (pb.last_error ?? "").includes(HANDED_OVER);
  if (newStrategy) lines.push(`${handedOver ? "Your plan's written strategy is done" : "The written strategy that was missing from your plan is done"}: who you win with, what could get in the way, and what success looks like at 30, 60 and 90 days.`);
  if (newParts.length) lines.push(`${titlesOf(newParts.map(titleOf))} ${newParts.length === 1 ? "is" : "are"} now written for you, not in my standard wording.`);
  // As they are now, not as they were when the job started minutes ago.
  const current = lines.length ? await findBusinessById(biz.id) : null;
  if (lines.length && current && !current.deleted_at && current.current_plan_id === p.plan_id) {
    const online = planUrl();
    const sent = await sendButtons(
      biz.wa_id,
      `${lines.join("\n\n")}${online ? `\n\nIt's in your plan: ${online}` : ""}`,
      // No "Next step" while the plan is paused for stabilising (rule 9).
      current.stage === "stabilizing" ? [SEND_PDF_BUTTON] : [SEND_PDF_BUTTON, { id: ACT.NEXT_STEP, title: "Next step" }],
      biz.id,
    );
    if (sent.ok) {
      newParts.forEach((id) => toldParts.add(id));
      if (newStrategy) toldStrategy = true;
      await note();
    }
  }
  track("plan_repaired", {
    category: "ops",
    businessId: biz.id,
    ms: since(started),
    props: {
      strategy: p.strategy ? strategyDone : null,
      parts: p.parts.length,
      parts_done: partsDone.size,
      rewritten: rewritten.size,
      told: toldParts.size + (toldStrategy ? 1 : 0),
      // Finished by the build's own late lanes rather than written again.
      adopted: adoptedParts + (adoptedStrategy ? 1 : 0),
      ok: !failure,
    },
  });
  // Whatever is left goes to the queue's retry (and, on the last attempt,
  // its apology: engine/queue.ts apologise).
  if (failure) throw failure;
}
