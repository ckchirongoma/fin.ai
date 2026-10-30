// Charles — building the plan: identity → goals → rule → context → plan.
//
// The rule that shapes this whole file (CLAUDE.md rule 1): the model never
// chooses or invents plan structure. A fixed library of modules decides what
// is in the plan; the model only tailors the wording of steps that were chosen
// by `needs()` conditions running over signals the person actually gave.
//
// The second rule (rule 4): this is collaborative. The person is shown three
// genuinely different 90-day goals and three money rules, and picks. The plan
// is built from their choices, not from the diagnostic alone.

import { fenceCheck, JobFencedError } from "../jobctx.js";
import { askJSON, describeModelCall, traceModelCalls, type ModelCallTrace } from "../models.js";
import { rulePrompt, goalPrompt, readbackPrompt } from "../prompts.js";
import { type Workstream, type HydratedWorkstream } from "../playbooks.js";
import { checkDistress, checkTraceability, hedgeUnknown, stabilizingMessage } from "../safety.js";
import { arbitrateTrade } from "../judgement.js";
import { claimGoalOptionsDelivery, goalOptionsInFlight, enqueueGoalOptions, findBusinessById, recordSafetyEvent, storeGoalOptions, updateBusiness, db } from "../db.js";
import { randomUUID } from "node:crypto";
import { figuresFrom, groundingFrom, hedgeIfGuess, tagIfGuess, ungroundedMoney, type Grounding } from "../grounding.js";
import { sendButtons, sendText } from "../wa.js";
import { ACT } from "../actions.js";
import { normaliseRecommend } from "../recommend.js";
import { env } from "../env.js";
import { errorText, since, track, trackFailure, trackUnmet } from "../track.js";
import { queueKeptQuestions } from "./kept.js";
import type { RuleOption, Business, HouseholdContext, GoalOption, JobRow, MapEntry } from "../types.js";

export const PRODUCT_NAME = "Charles";

/**
 * Which third of the cohort this household starts in, from its Money Map on
 * day one. Three coarse bands, on purpose: anything finer would imply a
 * precision an eight-question rubric does not have.
 */
export function baselineTier(map: MapEntry[]): "low" | "mid" | "high" {
  const score = map.reduce((n, m) => n + (m.status === "green" ? 2 : m.status === "amber" ? 1 : 0), 0);
  if (score <= 4) return "low";
  if (score <= 9) return "mid";
  return "high";
}

/**
 * The two things recorded ONCE, at the moment the first plan is created, and
 * never updated: the starting tier and the day-one map. Harm to the people
 * starting weakest is the product's biggest risk (the Kenya evidence), and
 * the only way to see it is to compare outcomes against where each household
 * STARTED. `??` is what makes "never updated" true on a rebuild.
 */
export function dayOneFields(biz: Pick<Business, "baseline_tier" | "map_first">, map: MapEntry[]) {
  return {
    baseline_tier: biz.baseline_tier ?? baselineTier(map),
    map_first: biz.map_first ?? map,
  };
}

// ── The anti-hallucination gate on the context stage ──────────────
//
// Given thin diagnostic answers, a context call will invent specifics and
// assert them as settled fact. Two defences, neither a fresh model call for
// the fields most likely to be invented:
//   1. `income` and `owes` are never asked of a model at all — they are
//      copied from what the person ANSWERED, which cannot invent anything.
//   2. What is still generated freely (cushion, cover, one_liner) is checked
//      with one Jev call for whether it is traceable to the diagnostic, the
//      identity, or the chosen goal/rule — and, whenever `identity.unsure` is
//      set, hedged unconditionally.

/** The income and the debts as the person gave them, never a model's restatement. */
export function deriveContextDefaults(answers: Record<string, string>, _goal: GoalOption[] | null | undefined): { income: string; owes: string } {
  // Their own answer counts only when it IS a figure: "not sure" or a bare
  // "1" typed at the income question is not one.
  const income = (answers.income || "").trim();
  return {
    income: income && figuresFrom(income).size ? income : "",
    owes: (answers.owes || "").trim(),
  };
}

/**
 * Every money figure in these fields that the person never gave is labelled
 * as a guess — mechanically, no model — and the check leaves a
 * `price_grounding` row either way.
 */
export async function groundMoneyFields<T extends object>(
  obj: T,
  keys: (keyof T)[],
  given: Set<number> | Grounding,
  mode: "tag" | "sentence",
  ctx: { businessId?: string | null; surface: string },
): Promise<{ value: T; hedged: string[] }> {
  const out = { ...obj } as Record<string, unknown>;
  const hedged: string[] = [];
  for (const k of keys) {
    const v = out[k as string];
    if (typeof v !== "string" || !v) continue;
    const r = mode === "tag" ? tagIfGuess(v, given) : hedgeIfGuess(v, given);
    if (r.hedged) {
      out[k as string] = r.text;
      hedged.push(String(k));
    }
  }
  void ctx;
  return { value: out as T, hedged };
}

export async function recordPriceGrounding(businessId: string | null | undefined, surface: string, hedged: string[]): Promise<void> {
  await recordSafetyEvent({
    businessId,
    check: "price_grounding",
    engine: "none", // arithmetic, not a judgement
    outcome: hedged.length ? "flag" : "pass",
    flags: hedged,
    detail: `${surface}${hedged.length ? `: hedged ${hedged.join(", ")}` : ": every figure traced to the person's own answers"}`.slice(0, 300),
  });
}

const CONTEXT_TRACE_LABELS = {
  cushion: "what they could reach in an emergency",
  cover: "what cover they have",
  one_liner: "their money life, in one line",
} as const;

export async function applyContextGuardrails(
  context: HouseholdContext,
  answers: Record<string, string>,
  biz: Pick<Business, "goal" | "rule" | "identity">,
  ctx: { businessId?: string | null } = {},
): Promise<HouseholdContext> {
  const derived = deriveContextDefaults(answers, biz.goal);
  const out: HouseholdContext = {
    ...context,
    income: derived.income || hedgeUnknown("what comes in each month"),
    owes: derived.owes || hedgeUnknown("who they owe"),
  };

  const checked = await checkTraceability(
    { cushion: out.cushion ?? "", cover: out.cover ?? "", one_liner: out.one_liner ?? "" },
    CONTEXT_TRACE_LABELS,
    { diagnostic_answers: answers, established_identity: biz.identity, chosen_goal: biz.goal, chosen_rule: biz.rule },
    ctx,
  );
  out.cushion = checked.fields.cushion;
  out.cover = checked.fields.cover;
  out.one_liner = checked.fields.one_liner;

  if (biz.identity?.unsure) {
    if (out.cushion && !checked.flagged.includes("cushion")) out.cushion = hedgeUnknown(CONTEXT_TRACE_LABELS.cushion, out.cushion);
    if (out.cover && !checked.flagged.includes("cover")) out.cover = hedgeUnknown(CONTEXT_TRACE_LABELS.cover, out.cover);
    if (out.one_liner && !checked.flagged.includes("one_liner")) out.one_liner = hedgeUnknown(CONTEXT_TRACE_LABELS.one_liner, out.one_liner);
  }

  return out;
}

/** Where this plan can be read on the web. Empty until a domain is configured. */
export const planUrl = (): string | null => (env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/plan` : null);

/**
 * The connector section only renders for a person who has actually connected
 * their own AI. A plan document must never tell someone to use something that
 * is not live for them.
 */
export async function existingConnectorUrl(businessId: string): Promise<string | null> {
  if (!env.PUBLIC_BASE_URL) return null;
  const { data } = await db()
    .from("connector_tokens")
    .select("token_hash")
    .eq("business_id", businessId)
    .is("revoked_at", null)
    .limit(1);
  return (data as unknown[])?.length ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/mcp/<your private address — send "connect" on WhatsApp>` : null;
}

/** Same words, ignoring case and punctuation. */
const sameWords = (a: string, b: string): boolean => a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() === b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The rule options as the person reads them: a rule that is its own label is shown once. */
export function ruleOptionsText(options: { label: string; rule?: string | null; what_it_costs_you?: string | null }[], guessed: Set<number> = new Set()): string {
  return options
    .map(
      (o, i) =>
        `${i + 1}. ${o.rule && sameWords(o.rule, o.label) ? `"${o.rule}"` : `${o.label}\n"${o.rule ?? ""}"`}${guessed.has(i) ? "\n(The figure in that line is my guess — check it before you rely on it.)" : ""}${o.what_it_costs_you ? `\nWhat it takes: ${o.what_it_costs_you}` : ""}`,
    )
    .join("\n\n");
}

/** "My pick" (normaliseRecommend): a long label, a whole sentence, is named by its number only. */
export function pickName(pick: string, options: { label: string }[]): string {
  const n = Number(/^Start with (\d+)/.exec(pick)?.[1]);
  const label = options[n - 1]?.label?.trim();
  const named = `Start with ${n} (${label})`;
  return label && label.length > 40 && pick.startsWith(named) ? `Start with ${n}${pick.slice(named.length)}` : pick;
}

// ── Step 1: who is this, and what should they aim at ─────────────
//
// Two model calls, not one: the read-back (readbackPrompt), sent with the
// confirm buttons the moment it returns; and a "goal_options" queue job
// (runGoalOptionsJob) queued as the read-back goes out, keyed on the
// household only so the person's next message never waits behind it. An
// options token minted on the read-back keeps the job honest: a correction
// replaces or clears it, so stale options are dropped.

/** Three goal cards at most — each one is read on a phone. */
export const MAX_GOAL_OPTIONS = 3;

/** pending_action left by a "That's right" tap that found the options job still on its way. */
const OPTIONS_WAIT = "goal_options_wait";

/** A model line, ready to sit inside a sentence: no trailing full stop. */
function stripStop(line: string | undefined): string {
  return String(line ?? "").trim().replace(/[.\s]+$/, "");
}

/**
 * Runs straight after the diagnostic. Hardship is checked FIRST, on the raw
 * answers, before a single plan-building token is spent: a person who cannot
 * buy food does not need a 90-day plan, and the evidence says handing them
 * one makes things worse.
 */
export async function runReadbackStep(biz: Business, correction?: string, opts: { distressCleared?: boolean } = {}): Promise<void> {
  const started = Date.now();
  const calls: ModelCallTrace[] = [];
  try {
    await traceModelCalls(calls, () => readbackStep(biz, correction, opts));
  } catch (err) {
    if (err instanceof JobFencedError) throw err;
    await recordTiming("readback_timing", biz.id, Date.now() - started, calls, "error");
    throw err;
  }
  await recordTiming("readback_timing", biz.id, Date.now() - started, calls, "sent");
}

/** One timing row: score = total seconds, detail = every model call in it. Never throws. */
async function recordTiming(check: "readback_timing" | "goal_options_timing", businessId: string, ms: number, calls: ModelCallTrace[], how: string): Promise<void> {
  try {
    const s = (n: number) => `${(n / 1000).toFixed(1)}s`;
    const models = calls.map(describeModelCall);
    const detail = [`total ${s(ms)}`, how, ...(models.length ? [`models: ${models.join(", ")}`] : [])].join("; ");
    console.log(`${check.replace("_timing", "")} timing [${businessId}]: ${detail}`);
    await recordSafetyEvent({ businessId, check, engine: "none", outcome: "pass", score: Math.round(ms / 100) / 10, detail: detail.slice(0, 1000) });
  } catch (err) {
    console.warn("recordTiming failed", check, err);
  }
}

/** Call A: the read-back, sent with the confirm buttons; call B is queued behind it. */
async function readbackStep(biz: Business, correction?: string, opts: { distressCleared?: boolean } = {}): Promise<void> {
  const started = Date.now();
  const answers = biz.answers || {};

  // Skipped only for the build a person confirmed on the way OUT of hardship
  // mode (engine/index.ts ACT.BUILD_NOW, which records it).
  const cleared = opts.distressCleared === true || biz.pending_action?.distress_cleared === true;
  if (!cleared && (await checkDistress(answers, { businessId: biz.id }))) {
    track("distress_detected", { severity: "warn", props: { source: "diagnostic" } });
    await updateBusiness(biz.id, { stage: "stabilizing", pending_action: null });
    await sendText(biz.wa_id, stabilizingMessage(biz.country, biz.context?.name || biz.identity?.name || ""), biz.id);
    await queueKeptQuestions(biz.id, "stabilising");
    return;
  }

  let prompt = readbackPrompt(answers, biz.country);
  if (correction) {
    prompt += `\n\nIMPORTANT: an earlier reading of this person's money was wrong. They have corrected it: "${correction}". Treat that as the truth about their situation, and build everything from it.`;
  }

  try {
    const result = await askJSON("plan_builder", prompt, { maxTokens: 1200, label: "build:readback", reasoning: { enabled: false } });
    const identity = (result.identity as Business["identity"]) || {
      name: "",
      earns: answers.person,
      one_liner: answers.person,
      unsure: null,
    };
    // An invented figure in the read-back is the first place it ever
    // appears, and the one every later surface inherits.
    const given = groundingFrom(answers);
    const readBack = await groundMoneyFields(
      { reflection: String(result.reflection || ""), objective_read: String(result.objective_read || answers.objective || "") },
      ["reflection", "objective_read"],
      given,
      "sentence",
      { businessId: biz.id, surface: "read_back" },
    );
    await recordPriceGrounding(biz.id, "read-back", readBack.hedged);
    const objective_read = String(readBack.value.objective_read || answers.objective || "");

    await fenceCheck();
    const token = randomUUID();
    await updateBusiness(biz.id, {
      identity,
      objective_read,
      biz_stage: (result.stage as Business["biz_stage"]) || "stretching",
      pending_goal_options: { options: [], recommend: "", token },
      stage: "confirm_identity",
      pending_action: null,
    });

    await enqueueGoalOptions(biz.id, token);

    // The transcription-doubt question, arbitrated: where the diagnostic as a
    // whole supports a different reading than the words that were heard, the
    // question is asked in pre-written words. `ran` says whether arbitration
    // reached any verdict; only when it did not does the model's own doubt get a say.
    const arbitrated = await arbitrateTrade(answers, { businessId: biz.id });
    const unsure = arbitrated.ran ? arbitrated.question : identity?.unsure;
    const body =
      `${readBack.value.reflection || ""}\n\nSo what you're really after: ${objective_read}` +
      (unsure ? `\n\n${unsure}` : "");

    await sendButtons(
      biz.wa_id,
      body.trim(),
      [
        { id: ACT.IDENTITY_OK, title: "That's right" },
        { id: ACT.IDENTITY_FIX, title: "Not quite" },
      ],
      biz.id,
    );
    track("readback_shown", {
      category: "funnel",
      ms: since(started),
      props: {
        correction: Boolean(correction),
        unsure_asked: Boolean(unsure),
        arbitrated: arbitrated.ran,
        hedged: readBack.hedged.length,
        biz_stage: (result.stage as Business["biz_stage"]) || "stretching",
      },
    });
  } catch (err) {
    if (err instanceof JobFencedError) throw err;
    await fenceCheck();
    console.log("runReadbackStep failed", biz.wa_id, err);
    trackFailure("readback_failed", err, {
      ms: since(started),
      props: { correction: Boolean(correction) },
      summary: `The read-back after the diagnostic failed; the person was asked to restate their aim (${errorText(err).slice(0, 160)})`,
    });
    // Land somewhere the NEXT message actually retries, rather than on a stage
    // with no handler — that is how a person gets silently stranded.
    await updateBusiness(biz.id, { stage: "clarify_objective", pending_action: null });
    await sendText(
      biz.wa_id,
      "Sorry — I couldn't quite work that out. Tell me again, in one sentence: what are you trying to fix or achieve with your money?",
      biz.id,
    );
  }
}

/**
 * Call B: the goal options, from the identity call A established, for the
 * read-back that minted `token`. Stores them only if that read-back is still
 * the live one (db.storeGoalOptions); returns them, or null when a correction
 * got there first. Throws on failure, so the queue's own retries apply.
 */
async function generateGoalOptions(biz: Business, token: string): Promise<NonNullable<Business["pending_goal_options"]> | null> {
  const started = Date.now();
  const calls: ModelCallTrace[] = [];
  try {
    const pending = await traceModelCalls(calls, () => goalOptions(biz, token));
    await recordTiming("goal_options_timing", biz.id, Date.now() - started, calls, pending ? "stored" : "discarded (read-back corrected)");
    return pending;
  } catch (err) {
    if (err instanceof JobFencedError) throw err;
    await recordTiming("goal_options_timing", biz.id, Date.now() - started, calls, "error");
    throw err;
  }
}

async function goalOptions(biz: Business, token: string): Promise<NonNullable<Business["pending_goal_options"]> | null> {
  const answers = biz.answers || {};
  const result = await askJSON("plan_builder", goalPrompt(answers, biz.identity, biz.biz_stage || "stretching", biz.country), {
    maxTokens: 2400,
    label: "build:goal",
    reasoning: { enabled: false },
  });
  // "Worth: R800 a month in interest" shown to a person who gave no figure
  // would be the first place an invented number appears.
  const given = groundingFrom(answers);
  const hedgedHere: string[] = [];
  const options: GoalOption[] = [];
  for (const [i, o] of ((((result.options as GoalOption[]) || []) as GoalOption[]).slice(0, MAX_GOAL_OPTIONS)).entries()) {
    const g = await groundMoneyFields(o, ["worth", "what", "why_you", "first_move", "catch"], given, "tag", { businessId: biz.id, surface: "goal_options" });
    options.push(g.value);
    hedgedHere.push(...g.hedged.map((k) => `option_${i + 1}.${k}`));
  }
  const rec = hedgeIfGuess(String(result.recommend || ""), given);
  if (rec.hedged) hedgedHere.push("recommend");

  const pending = { options, recommend: rec.text, token };
  if (!(await storeGoalOptions(biz.id, token, { options, recommend: rec.text }, (result.signals as Business["signals"]) || {}))) {
    console.log(`goal options discarded [${biz.id}]: the read-back they were written for was corrected`);
    return null;
  }
  await recordPriceGrounding(biz.id, "goal options", hedgedHere);
  return pending;
}

/**
 * The "goal_options" queue job (queue.ts runJob). Reads the household fresh
 * and does nothing unless the read-back that queued it is still the live one.
 */
export async function runGoalOptionsJob(job: JobRow): Promise<void> {
  if (!job.business_id) throw new Error("goal_options job has no household");
  const token = typeof job.payload?.token === "string" ? job.payload.token : null;
  if (!token) return;
  const biz = await findBusinessById(job.business_id);
  if (!biz || biz.stage !== "confirm_identity") return;
  if (biz.pending_goal_options?.token !== token) return;
  if (biz.pending_goal_options.options?.length) return;
  const pending = await generateGoalOptions(biz, token);
  if (!pending) return;
  const fresh = await findBusinessById(biz.id);
  if (fresh?.stage === "confirm_identity" && fresh.pending_action?.kind === OPTIONS_WAIT) {
    await deliverGoalOptions(fresh, pending);
  }
}

export async function showGoalOptions(biz: Business): Promise<void> {
  if (biz.stage !== "confirm_identity") {
    trackUnmet("stale_tap", { severity: "info", props: { action: ACT.IDENTITY_OK, reason: "old_message", has_plan: Boolean(biz.current_plan_id) } });
    await sendText(biz.wa_id, "That button was for an earlier message — nothing's changed.", biz.id);
    return;
  }
  let pending = biz.pending_goal_options ?? null;
  if (!pending?.options?.length) {
    let token = pending?.token ?? null;
    if (token && (await goalOptionsInFlight(biz.id, token))) {
      await updateBusiness(biz.id, { pending_action: { kind: OPTIONS_WAIT, since: new Date().toISOString() } });
      await sendText(biz.wa_id, "Good. I'm still putting together what to aim at first — nearly ready. I'll send it here the moment it's done.", biz.id);
      const fresh = await findBusinessById(biz.id);
      if (fresh?.pending_goal_options?.token === token && fresh.pending_goal_options.options?.length) {
        await deliverGoalOptions(fresh, fresh.pending_goal_options);
      }
      return;
    }
    if (!token) {
      token = randomUUID();
      await updateBusiness(biz.id, { pending_goal_options: { options: [], recommend: "", token } });
    }
    try {
      pending = await generateGoalOptions({ ...biz, pending_goal_options: { options: [], recommend: "", token } }, token);
    } catch (err) {
      if (err instanceof JobFencedError) throw err;
      await fenceCheck();
      console.log("showGoalOptions: inline options failed", biz.wa_id, err);
      trackFailure("goal_options_failed", err, {
        props: { via: "inline" },
        summary: `Goal options failed after "That's right"; the person was asked to reply yes to retry (${errorText(err).slice(0, 160)})`,
      });
      await updateBusiness(biz.id, { pending_action: null });
      await sendText(biz.wa_id, "Sorry — I couldn't put together what to aim at just then. Reply yes and I'll try again.", biz.id);
      return;
    }
    if (!pending) {
      trackUnmet("stale_tap", { severity: "info", props: { action: ACT.IDENTITY_OK, reason: "old_message", readback_corrected: true } });
      await sendText(biz.wa_id, "That button was for an earlier message — nothing's changed.", biz.id);
      return;
    }
  }
  await deliverGoalOptions(biz, pending);
}

/** Sends the goal cards — at most once per read-back (db.claimGoalOptionsDelivery). */
async function deliverGoalOptions(biz: Business, pending: NonNullable<Business["pending_goal_options"]>): Promise<void> {
  if (!(await claimGoalOptionsDelivery(biz.id, pending.token ?? null))) return;
  const options = pending.options;

  const shown = options.slice(0, MAX_GOAL_OPTIONS);
  const body = shown.map((o, i) => goalCard(o, i + 1)).join("\n\n");
  const pick = normaliseRecommend((pending?.recommend ?? "").trim(), shown.map((o) => o.label));

  await sendText(
    biz.wa_id,
    `Before I build your plan, let's agree the one thing to fix first. A 90-day plan works best aimed at one thing, so we start there — it's not forever. Once that's steady, you can change the plan or add more.\n\n` +
      (pick ? `My pick: ${pick}\n\n` : "") +
      `${body}\n\n` +
      `Reply with the numbers that fit — 1, or 1 and 3. You know your month better than I do.`,
    biz.id,
  );
  if (!shown.length) {
    trackFailure("goal_options_failed", new Error("no goal options came back from the model"), {
      props: { via: "empty" },
      summary: "The person was asked to pick a goal from an empty list",
    });
  } else {
    const waitedSince = biz.pending_action?.kind === OPTIONS_WAIT ? Date.parse(String(biz.pending_action.since ?? "")) : Number.NaN;
    track("goal_options_shown", {
      category: "funnel",
      ms: Number.isFinite(waitedSince) ? Date.now() - waitedSince : null,
      props: {
        count: shown.length,
        recommended: Number(/^Start with (\d+)/i.exec(pick)?.[1]) || null,
        waited: Number.isFinite(waitedSince),
      },
    });
  }
}

/** One goal card: the label, then each field on its own plainly labelled line. */
export function goalCard(o: GoalOption, n: number): string {
  const line = (label: string, v: string | undefined) => (v && v.trim() ? `\n${label}: ${v.trim()}` : "");
  return (
    `${n}. ${o.label}` +
    line("What it is", o.what) +
    line("Why it fits you", o.why_you) +
    line("What it's worth", o.worth) +
    line("First move this week", o.first_move) +
    line("The catch", o.catch)
  );
}

// ── Step 2: what usually happens instead, and the rule they will keep ──

export async function runRuleStep(biz: Business): Promise<void> {
  const started = Date.now();
  try {
    const result = await askJSON(
      "plan_builder",
      rulePrompt(biz.answers || {}, biz.biz_stage || "stretching", biz.goal || [], biz.identity, biz.country),
      { maxTokens: 3400, label: "build:rule", reasoning: { enabled: false } },
    );

    const given = groundingFrom(biz.answers || {});
    const hedgedHere: string[] = [];
    const alternatives: Business["alternatives"] = [];
    for (const [i, a] of (((result.alternatives as Business["alternatives"]) || []) as NonNullable<Business["alternatives"]>).entries()) {
      const g = await groundMoneyFields(a, ["why_people_do_it", "where_it_leaves_them"], given, "tag", { businessId: biz.id, surface: "alternatives" });
      alternatives.push(g.value);
      hedgedHere.push(...g.hedged.map((k) => `alternative_${i + 1}.${k}`));
    }
    const altText = alternatives
      .map((x) => `• ${x.name} — ${stripStop(x.why_people_do_it)}. Where it leaves you: ${stripStop(x.where_it_leaves_them)}.`)
      .join("\n");

    const options: RuleOption[] = [];
    const ruleGuessed = new Set<number>();
    for (const [i, o] of (((result.options as RuleOption[]) || []) as RuleOption[]).entries()) {
      const g = await groundMoneyFields(o, ["why_it_works", "what_it_costs_you"], given, "tag", { businessId: biz.id, surface: "rule_options" });
      // The rule is the line they will SAY to themselves, printed in quotes
      // as theirs — a tag inside it would be repeated. The warning goes beside it.
      if (o.rule && ungroundedMoney(o.rule, given).length) {
        g.value = { ...g.value, why_it_works: `${g.value.why_it_works} (The figure in that line is my guess — check it before you rely on it.)` };
        g.hedged.push("rule");
        ruleGuessed.add(i);
      }
      options.push(g.value);
      hedgedHere.push(...g.hedged.map((k) => `rule_${i + 1}.${k}`));
    }
    const ruleRec = hedgeIfGuess(String(result.recommend || ""), given);
    if (ruleRec.hedged) hedgedHere.push("recommend");
    result.recommend = ruleRec.text;
    await recordPriceGrounding(biz.id, "rule options", hedgedHere);
    const body = ruleOptionsText(options, ruleGuessed);

    await updateBusiness(biz.id, {
      alternatives,
      pending_rule_options: { options, recommend: String(result.recommend || "") },
      stage: "choose_rule",
      pending_action: null,
    });

    const rulePick = normaliseRecommend(String(result.recommend ?? "").trim(), options.map((o) => o.label));
    await sendText(
      biz.wa_id,
      (altText ? `What usually happens instead, for someone in your spot:\n${altText}\n\n` : "") +
        `So here's the thing that beats that: one rule you keep for 90 days. This becomes the line you say to yourself on payday.\n\n${body}\n\n` +
        (rulePick ? `My pick: ${pickName(rulePick, options)}\n\n` : "") +
        `Reply with the number of the rule you can actually keep, every single time. Two numbers only if you can truly keep both.`,
      biz.id,
    );
    if (!options.length) {
      trackFailure("rule_options_failed", new Error("no rule options came back from the model"), {
        ms: since(started),
        props: { via: "empty" },
        summary: "The person was asked to pick a money rule from an empty list",
      });
    } else {
      track("rule_options_shown", {
        category: "funnel",
        ms: since(started),
        props: {
          count: options.length,
          alternatives: alternatives.length,
          recommended: Number(/^Start with (\d+)/i.exec(rulePick)?.[1]) || null,
          figure_guessed: ruleGuessed.size,
          goals: biz.goal?.length ?? 0,
        },
      });
    }
  } catch (err) {
    if (err instanceof JobFencedError) throw err;
    await fenceCheck();
    console.log("runRuleStep failed", biz.wa_id, err);
    trackFailure("rule_options_failed", err, {
      ms: since(started),
      summary: `The rule options failed; the person was sent back to pick their goal again (${errorText(err).slice(0, 160)})`,
    });
    await updateBusiness(biz.id, { stage: "choose_goal", pending_action: null });
    await sendText(biz.wa_id, "That didn't come through. Tell me your goal again — reply with the numbers.", biz.id);
  }
}

// ── Step 3: context, map, and the fixed-module plan ─────────────

/**
 * Rebuilds each step from the FIXED library entry and accepts only wording
 * from the model. Structure cannot leak in: a step the model invented has no
 * base to merge onto, and a tool it picked outside the step's allowed choices
 * is dropped.
 */
export interface TailoredStep {
  id: string;
  why_for_you?: string;
  push?: string;
  artifact?: string | null;
  tool_id?: string | null;
}

/**
 * A step's `tool_choices` are ids from one library; only the ids this
 * country actually has are offered to the model. A step left with no choice
 * offers no tool at all, which is what "tool: none" already means.
 */
export function forCountry(ws: Workstream, countryToolIds: ReadonlySet<string>): Workstream {
  return {
    ...ws,
    steps: ws.steps.map((s) => {
      if (!s.tool_choices) return s;
      const local = s.tool_choices.filter((id) => countryToolIds.has(id));
      const { tool_choices: _all, ...rest } = s;
      return local.length ? { ...rest, tool_choices: local } : rest;
    }),
  };
}

/**
 * The banking or savings products the person already uses, read from their
 * own words. A product they already use is the one every part uses: two
 * parts tailored at the same time must not each pick a different pocket.
 * Pure; only ids that exist in this country come back.
 */
const OWNER_TOOL_WORDS: [RegExp, string][] = [
  [/\bgoal ?save\b/i, "gotyme_goalsave"],
  [/\b(?:go ?tyme|tyme ?bank|tyme)\b/i, "gotyme_everyday"],
  [/\bpay ?shap\b/i, "payshap"],
];
export function ownerTools(answers: Record<string, string>, countryToolIds: ReadonlySet<string>): string[] {
  const words = Object.values(answers ?? {}).join(" \n ");
  return [...new Set(OWNER_TOOL_WORDS.filter(([re, id]) => countryToolIds.has(id) && re.test(words)).map(([, id]) => id))];
}

/** A step that offers a tool the person already uses offers only that one (see ownerTools). */
export function withOwnerTools(ws: Workstream, owned: readonly string[]): Workstream {
  if (!owned.length) return ws;
  return {
    ...ws,
    steps: ws.steps.map((s) => {
      const mine = s.tool_choices?.filter((id) => owned.includes(id)) ?? [];
      return mine.length ? { ...s, tool_choices: mine } : s;
    }),
  };
}

export function hydrateWorkstream(
  ws: Workstream,
  r: { why_for_you?: string; steps?: TailoredStep[] } | null,
): HydratedWorkstream {
  return {
    ...ws,
    why_for_you: r?.why_for_you || ws.why,
    steps: ws.steps.map((base) => {
      const got: Partial<TailoredStep> = (r?.steps || []).find((x) => x.id === base.id) ?? {};
      const toolId = base.tool_choices && got.tool_id && base.tool_choices.includes(got.tool_id) ? got.tool_id : null;
      return {
        ...base,
        why_for_you: got.why_for_you || "",
        push: got.push || base.outcome,
        artifact: base.artifact_brief ? got.artifact || null : null,
        tool_id: toolId,
      };
    }),
  };
}
