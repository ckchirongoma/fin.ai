// Charles — five more judgements, each one a place where the thing being
// checked used to grade its own homework.
//
//   arbitrateTrade      the laundromat-heard-as-lodge class of error
//   scoreScam           how a forwarded offer reads, independent of the writer
//   gateNudge           would this follow-up actually help, or repeat itself
//   outcomePlausible    guards the map against feel-good inflation
//   auditModules        rule 1, belt and braces: was this module earned?
//
// The same laws as safety.ts, and they are not restated loosely:
//   - A judgement may flag or soften. It never silences and it never WRITES —
//     every sentence a person reads from these is pre-written here.
//   - Two engines: Jev, then the `safety` model. Both down means the check
//     passes through AND writes an `unavailable` row. Never silently.
//   - Thresholds are per-check and written down. Raising one to quiet a noisy
//     check is a design change, not a tweak.

import { askJev, type JevQuestion } from "./jev.js";
import { askJSON } from "./models.js";
import { env } from "./env.js";
import { recordSafetyEvent } from "./db.js";
import { judge, type SafetyCtx } from "./safety.js";
import { country } from "./countries.js";

type Engine = "jev" | "model" | "none";

const jevLive = (): boolean => Boolean(env.TYPESAFE_API_KEY);
const modelLive = (): boolean => Boolean(env.OPENROUTER_API_KEY);

// ── 1. Transcript arbitration ────────────────────────────────────

/**
 * Trades a transcriber (or a typo) turns into a different, real word. Each
 * group is a set of readings that sound or look alike. When the person's words
 * contain one of them, the whole diagnostic decides which was meant.
 */
interface Reading {
  key: string;
  label: string;
  terms: string[];
  means: string;
}
export const CONFUSABLES: { readings: Reading[] }[] = [
  {
    readings: [
      { key: "stokvel", label: "a stokvel", terms: ["stokvel", "stokvels", "stockvel"], means: "a savings club where members pay in each month and take turns receiving the pot" },
      { key: "stock_fell", label: "stock that fell", terms: ["stock fell", "stocks fell", "stock fall"], means: "shares or goods whose value dropped" },
    ],
  },
  {
    readings: [
      { key: "debit_order", label: "a debit order", terms: ["debit order", "debit orders", "debicheck"], means: "a payment a company takes from the bank account automatically each month" },
      { key: "debt_order", label: "a debt order", terms: ["debt order", "debt orders"], means: "a court order about a debt" },
    ],
  },
  {
    readings: [
      { key: "mashonisa", label: "a mashonisa", terms: ["mashonisa", "mashonisas", "loan shark", "shylock"], means: "an informal, unregistered money lender charging very high interest" },
      { key: "machine", label: "a machine", terms: ["machine", "machines"], means: "equipment or an ATM" },
    ],
  },
  {
    readings: [
      { key: "two_pot", label: "two-pot retirement savings", terms: ["two-pot", "two pot", "2-pot", "2 pot"], means: "the retirement savings component a member may withdraw from once a tax year" },
      { key: "two_pots", label: "two pots of money", terms: ["two pots", "two accounts", "two jars"], means: "money kept in two separate places or accounts" },
    ],
  },
];

const mentions = (text: string, term: string): boolean => new RegExp(`\\b${term.replace(/\s+/g, "\\s+")}\\b`, "i").test(text);

/**
 * `question` is a ready-to-send confirmation ONLY when the diagnostic as a
 * whole supports a different reading than the words that were heard.
 *
 * `ran` is the field that used not to exist, and its absence was a real bug
 * (2026-09-21): a plain "Rinse, a laundromat" — unambiguous, arbitration
 * runs, confirms the laundromat reading, correctly returns no question — was
 * followed by the caller falling back to the MODEL's own self-reported
 * `identity.unsure`, which does not know arbitration just independently
 * confirmed there is nothing to be unsure about here. `question: null` used
 * to mean two different things — "arbitration ran and found no
 * disagreement" and "arbitration never ran at all" — and a caller cannot
 * make the right decision (trust this verdict vs. fall back to the model's
 * own doubt) without being able to tell those apart. `ran` is true exactly
 * when an engine produced an authoritative answer, whatever that answer
 * was — including "confirmed, no disagreement" and "neither reading fits."
 * It is false only when arbitration genuinely never reached a verdict: no
 * confusable pair in the text, both readings present (real context, not an
 * error), or no engine could answer at all.
 */
export interface TradeArbitration {
  question: string | null;
  ran: boolean;
}

export async function arbitrateTrade(answers: Record<string, string>, ctx: SafetyCtx = {}): Promise<TradeArbitration> {
  const text = Object.values(answers).join(" ");
  const group = CONFUSABLES.find((g) => g.readings.some((r) => r.terms.some((t) => mentions(text, t))));
  if (!group) return { question: null, ran: false };

  const heard = group.readings.filter((r) => r.terms.some((t) => mentions(text, t)));
  // Both readings appear in what they said: that is real context, not an
  // error to arbitrate. Leave it to the model's own question.
  if (heard.length !== 1) return { question: null, ran: false };

  const criteria: Record<string, string> = Object.fromEntries(group.readings.map((r) => [r.key, r.means]));
  criteria.other = "neither of these fits what the person described";
  const instructions =
    "Take every diagnostic answer together — where the money comes from, who depends on it, what they owe, what they are trying to fix. Which reading do the answers as a whole best support?";

  let winner: string | null = null;
  let confidence = 0;
  let engine: Engine = "none";

  if (jevLive()) {
    const out = await askJev({
      apiKey: env.TYPESAFE_API_KEY,
      state: { diagnostic_answers: answers },
      questions: { trade: { type: "choice", instructions, criteria } as JevQuestion },
    });
    const a = out.ok ? out.answers?.trade : undefined;
    if (a?.type === "choice") {
      winner = a.choice;
      confidence = a.confidence;
      engine = "jev";
    } else {
      console.log("safety[trade_arbitration] jev unavailable:", out.message);
    }
  }

  if (!winner && modelLive()) {
    try {
      const keys = Object.keys(criteria);
      const list = Object.entries(criteria).map(([k, v]) => `- "${k}": ${v}`).join("\n");
      const r = await askJSON(
        "safety",
        `You are a strict checker. You do not write advice. Read every diagnostic answer together and decide which description best fits what the person described.\n\nANSWERS:\n${JSON.stringify(answers).slice(0, 6000)}\n\nCHOOSE EXACTLY ONE:\n${list}\n\nReturn JSON only, no fences: {"trade": ${keys.map((k) => `"${k}"`).join(" | ")}}`,
        { maxTokens: 60, temperature: 0, label: "safety:trade_arbitration" },
      );
      if (typeof r.trade === "string" && keys.includes(r.trade)) {
        winner = r.trade;
        confidence = 0.6; // a model's pick carries no calibrated confidence; treat it as moderate
        engine = "model";
      }
    } catch (err) {
      console.log("safety[trade_arbitration] model backstop failed:", err);
    }
  }

  if (!winner) {
    await recordSafetyEvent({
      businessId: ctx.businessId,
      check: "trade_arbitration",
      engine: "none",
      outcome: "unavailable",
      detail: "Neither engine could arbitrate the trade; the model's own doubt, if any, stands.",
    });
    return { question: null, ran: false };
  }

  const heardReading = heard[0]!;
  const winnerReading = group.readings.find((r) => r.key === winner);
  const disagrees = Boolean(winnerReading) && winnerReading!.key !== heardReading.key && confidence >= 0.5;
  await recordSafetyEvent({
    businessId: ctx.businessId,
    check: "trade_arbitration",
    engine,
    outcome: disagrees ? "flag" : "pass",
    score: confidence,
    detail: `heard "${heardReading.key}", answers support "${winner}"`,
  });
  // Deterministic wording: the judge decides WHETHER to ask; it never writes it.
  // ran: true either way — an engine reached a verdict, whether or not it
  // disagreed with what was heard, and that verdict is authoritative on this
  // specific ambiguity: the caller must not also consult the model's own
  // self-reported doubt about it.
  return { question: disagrees ? `Did you mean ${winnerReading!.label} rather than ${heardReading.label}?` : null, ran: true };
}

// ── 2. Scam scoring ──────────────────────────────────────────────

export type ScamLevel = 0 | 1 | 2;

const SCAM_LEVELS = [
  "A verifiable offer from an official domain with no upfront payment and no request for personal banking details.",
  "Unverifiable but not extractive: vague terms or an unofficial channel, yet nothing is asked of the reader.",
  "Classic advance-fee markers: a fee to release funds, banking details or PINs requested, guaranteed approval, or pressure to act today.",
];

/**
 * Independent of the model that wrote the reply. The forward prompt already
 * carries a scam check; this makes the outcome not depend on the writer being
 * checked. Rounds toward the warning at exactly 1.5: a needless warning about
 * a real offer costs the person a minute, a missed one costs them money.
 */
export async function scoreScam(content: string, ctx: SafetyCtx = {}): Promise<ScamLevel | null> {
  const text = (content ?? "").trim();
  if (!text) return null;

  if (jevLive()) {
    const out = await askJev({
      apiKey: env.TYPESAFE_API_KEY,
      state: { forwarded_content: text.slice(0, 8000) },
      questions: { scam: { type: "score", instructions: "How does this forwarded offer or message read?", criteria: SCAM_LEVELS } },
    });
    const a = out.ok ? out.answers?.scam : undefined;
    if (a?.type === "score") {
      const level = (a.score >= 1.5 ? 2 : a.score >= 0.5 ? 1 : 0) as ScamLevel;
      await recordSafetyEvent({ businessId: ctx.businessId, check: "scam_score", engine: "jev", outcome: level === 2 ? "block" : level === 1 ? "flag" : "pass", score: a.score, detail: `level ${level}` });
      return level;
    }
    console.log("safety[scam_score] jev unavailable:", out.message);
  }

  if (modelLive()) {
    try {
      const r = await askJSON(
        "safety",
        `You are a strict checker. You do not write advice. Read the forwarded message and choose the ONE description that fits.\n\nMESSAGE:\n${text.slice(0, 6000)}\n\n0: ${SCAM_LEVELS[0]}\n1: ${SCAM_LEVELS[1]}\n2: ${SCAM_LEVELS[2]}\n\nIf you are unsure between two, choose the higher number. Return JSON only, no fences: {"level": 0|1|2}`,
        { maxTokens: 40, temperature: 0, label: "safety:scam_score" },
      );
      const n = Number(r.level);
      if (n === 0 || n === 1 || n === 2) {
        await recordSafetyEvent({ businessId: ctx.businessId, check: "scam_score", engine: "model", outcome: n === 2 ? "block" : n === 1 ? "flag" : "pass", detail: `level ${n}` });
        return n as ScamLevel;
      }
    } catch (err) {
      console.log("safety[scam_score] model backstop failed:", err);
    }
  }

  await recordSafetyEvent({
    businessId: ctx.businessId,
    check: "scam_score",
    engine: "none",
    outcome: "unavailable",
    detail: "The scam score could not run; the forward prompt's own check is the only one in force.",
  });
  return null;
}

/** A reply that already tells the person it is a scam and not to pay or send. */
export const WARNS_OF_SCAM = /\b(?:scam|fraud|fraudulent|fake|con\s+artists?)\b|\b(?:don'?t|do\s+not|never)\s+(?:send|pay|reply)\b/i;
/** A reply that reassures instead ("looks legit", "a good opportunity"): never kept on a scam. */
const REASSURES = /\b(?:looks?|seems?|sounds?)\s+(?:like\s+a\s+)?(?:legit|legitimate|real|genuine|safe|good|fine|ok(?:ay)?)\b|\bgood\s+opportunity\b|\bgo\s+ahead\s+and\s+(?:apply|pay|send)\b/i;

/**
 * The writer's own warning, when it is one, with the country's free advisor
 * added unless it is already named. Round 23, UG: "That's a scam — don't send
 * it … Report it to your district" was right and specific (PDM charges no
 * fee) but named nobody a person could ask. Null when the writer's text is no
 * warning: then the person gets scamWarning instead.
 */
export function withScamAdvisor(message: string, countryCode: string): string | null {
  if (!WARNS_OF_SCAM.test(message) || REASSURES.test(message)) return null;
  const c = country(countryCode);
  if (message.toLowerCase().includes(c.advisorName.toLowerCase())) return message;
  return `${message.trim()}\n\nNot sure about the next one like this? Ask ${c.advisor}.`;
}

/** What a person gets at scam level 2, in place of whatever the writer said. Written, not generated. */
export function scamWarning(countryCode: string): string {
  const advisor = country(countryCode).advisor;
  return [
    "Careful with this one. It has the classic signs of a scam: money or personal details asked for before anything is paid out, a guarantee that sounds too good, or pressure to act today.",
    "Don't pay anything, don't send an ID number or bank details, and don't reply to it.",
    `To check it, go to the organisation's official website yourself — type the address in, don't use the link — or ask ${advisor}. If you've already sent money or details, tell your bank straight away.`,
  ].join("\n\n");
}

// ── 3. The nudge gate ────────────────────────────────────────────

/**
 * Two questions before any follow-up leaves. A number's quality rating decides
 * whether it can grow, and a nudge nobody wanted is what lowers it. Either
 * answer being yes means skip — logged as a good outcome, like every other
 * "send nothing".
 */
export async function gateNudge(
  message: string,
  state: { business: unknown; daysSinceLastMessage: number | null; openCommitments: string; recentNudges: string },
  ctx: SafetyCtx = {},
): Promise<{ skip: boolean; reason: string }> {
  const { engine, verdicts, scores } = await judge(
    "nudge_gate",
    { proposed_message: message, ...state },
    {
      wont_help:
        "Given this person's money, what they have done so far and how long since they last wrote, would this message be unlikely to help them this week — because it is generic, mistimed, or about something they have already dealt with?",
      repeats_recent: "Does this message say essentially the same thing as one of the recent follow-ups listed, so the person would feel nagged?",
    },
    0.65,
    ctx,
  );
  const skip = verdicts.wont_help === true || verdicts.repeats_recent === true;
  if (engine !== "none") {
    await recordSafetyEvent({
      businessId: ctx.businessId,
      check: "nudge_gate",
      engine,
      outcome: skip ? "flag" : "pass",
      score: Math.max(scores.wont_help ?? 0, scores.repeats_recent ?? 0) || null,
      detail: skip ? (verdicts.repeats_recent ? "repeats a recent nudge" : "unlikely to help this week") : "",
    });
  }
  return { skip, reason: skip ? (verdicts.repeats_recent ? "would repeat a recent nudge" : "unlikely to help this week") : "" };
}

// ── 4. Outcome attribution ───────────────────────────────────────

/**
 * A map area moves up on a completed step plus a reported improvement. But an
 * owner who taps "Yes, already" a minute after finishing a step that takes
 * weeks to work is being kind, not reporting. That would inflate the map — and
 * every sponsor number built on it. This never argues with the person; it only
 * declines to move the map when the improvement is implausible. Conservative:
 * it needs Jev's calibrated score, and a model backstop's bare "yes" is not
 * enough to withhold anything.
 */
export async function outcomePlausible(
  step: { title: string; domain?: string | null; done_when?: string | null; outcome?: string | null },
  timing: { minutesSinceDone: number },
  ctx: SafetyCtx = {},
): Promise<boolean> {
  const { engine, scores } = await judge(
    "outcome_attribution",
    { completed_step: step, minutes_since_marked_done: Math.round(timing.minutesSinceDone), person_reports: "it has already made a difference" },
    {
      implausible:
        "The person says a completed money step has already made a real difference. Given what this step involves and how little time has passed, is a genuine improvement in that area implausible?",
    },
    0.7,
    ctx,
  );
  // Only a calibrated score can withhold the map move.
  const implausible = engine === "jev" && (scores.implausible ?? 0) > 0.7;
  if (engine !== "none") {
    await recordSafetyEvent({
      businessId: ctx.businessId,
      check: "outcome_attribution",
      engine,
      outcome: implausible ? "flag" : "pass",
      score: scores.implausible ?? null,
      detail: implausible ? "map not moved: improvement implausible this soon" : "",
    });
  }
  return !implausible;
}

// ── 5. Module audit ──────────────────────────────────────────────

/**
 * Rule 1 says the model never chooses plan structure; `pickPlaybook` does, from
 * signals the model read out of the diagnostic. This asks, independently, of
 * each chosen module: do the answers really evidence the problem it fixes? A
 * module that fails is dropped BEFORE a token is spent tailoring it.
 *
 * Deliberately timid: only Jev's calibrated "clearly not evidenced" (< 0.3)
 * drops anything, the person's own stated top problem is never dropped, and the
 * caller keeps the plan if nothing would remain.
 */
export async function auditModules(
  modules: { id: string; title: string; why: string }[],
  evidence: { answers: Record<string, string>; problemInTheirWords?: string | null; topProblem?: string | null },
  ctx: SafetyCtx = {},
): Promise<string[]> {
  if (!modules.length || !jevLive()) return [];

  const questions: Record<string, JevQuestion> = {};
  for (const m of modules) {
    questions[m.id] = {
      type: "noul",
      instructions: `Do these diagnostic answers actually show that this problem is real for this person's money: "${m.title}" — ${m.why}`,
    };
  }
  const out = await askJev({ apiKey: env.TYPESAFE_API_KEY, state: { diagnostic_answers: evidence.answers, problem_in_their_words: evidence.problemInTheirWords ?? null }, questions });
  if (!out.ok || !out.answers) {
    await recordSafetyEvent({ businessId: ctx.businessId, check: "module_audit", engine: "none", outcome: "unavailable", detail: out.message ?? "Jev unavailable" });
    return [];
  }

  const drop: string[] = [];
  for (const m of modules) {
    const a = out.answers[m.id];
    if (a?.type !== "noul") continue;
    if (m.id === evidence.topProblem) continue; // their own stated problem is never audited away
    if (a.noul < 0.3) drop.push(m.id);
  }
  // Never audit a plan down to nothing: an unproven module beats no plan.
  const kept = drop.length >= modules.length ? [] : drop;
  await recordSafetyEvent({
    businessId: ctx.businessId,
    check: "module_audit",
    engine: "jev",
    outcome: kept.length ? "flag" : "pass",
    detail: kept.length ? `dropped before tailoring: ${kept.join(", ")}` : "",
  });
  return kept;
}
