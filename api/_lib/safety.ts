// Charles — the guardrails, with two engines and an audit trail.
//
// THE PROBLEM THIS FILE FIXES
// The first version ran every safety check through Jev alone, keyed off an
// environment variable that appeared in no deploy document. Set up exactly as
// written, Charles shipped with distress detection, per-step compliance and
// rubric scoring all silently returning "nothing to see here". That is the
// precise failure the evidence warns about: in the Kenya RCT the businesses
// harmed by AI advice were the weakest ones, and these checks are what stand
// between a struggling owner and a 90-day growth plan they cannot act on.
//
// THE DESIGN NOW
//   1. Jev (TypeSafe System One) is preferred: calibrated probabilities,
//      ~150ms, near-zero cost, and it cannot be talked into anything because
//      it does not generate text.
//   2. If Jev is absent or unreachable, a small model runs the same checks
//      from the `safety` row in model_config. Slower and less calibrated, but
//      real.
//   3. If BOTH are unavailable the check still fails open — a judgement may
//      flag or soften, never silence — but it writes an `unavailable` row to
//      safety_events, so "the guardrails are off" is a fact in the database
//      and on /api/health, not a silence.
//
// The one hard stop in the whole file is a step that asks a person for an ID,
// bank, card or password detail. That is replaced outright, never hedged.

import { askJev, noulConfidenceIn, type JevQuestion } from "./jev.js";
import { askJSON } from "./models.js";
import { env } from "./env.js";
import { recordSafetyEvent } from "./db.js";
import { rethrowGuardrailDeadline } from "./jobctx.js";
import { track } from "./track.js";
import { country } from "./countries.js";
import type { Strategy } from "./types.js";
import { allSentences, groundingFrom, moneyIn, percentsIn, PRICE_HEDGE, ratesIn, sentencesOf } from "./grounding.js";
import { DIAG } from "./diagnostic.js";

export { ratesIn };

type Engine = "jev" | "model" | "none";

const jevLive = (): boolean => Boolean(env.TYPESAFE_API_KEY);
const modelLive = (): boolean => Boolean(env.OPENROUTER_API_KEY);

/** Shared context so every event can be traced back to a business. */
export interface SafetyCtx {
  businessId?: string | null;
  /**
   * The diagnostic answers, when a check needs to verify a specific claim
   * traces back to something the person actually said rather than being
   * invented mid-generation. See checkTraceability. Optional and additive —
   * a caller that omits it simply does not get that sub-check, never a
   * broken call.
   */
  answers?: Record<string, string>;
  /**
   * The small set of exact strings this business already has verbatim — its
   * name, its location, the chosen customer/angle labels — checked
   * mechanically (never judged, never a model call) against a generated
   * reply. See checkNameFidelity / businessKnownFacts. Optional and
   * additive, same as `answers` above.
   */
  knownFacts?: Record<string, string | null | undefined>;
  /**
   * What the person told Charles before, at any time (the household graph's
   * "they said" and setup-answer lines, graph.ts saidSheet). A "you told me"
   * that matches one is supported, however long ago it was said.
   */
  toldBefore?: string;
  /**
   * Everything else genuinely established that a traceability check should
   * count as grounding: the confirmed identity, the customer and angle the
   * owner chose, the goal already agreed with them. Without these, a
   * strategy item that correctly restates the chosen customer — or the
   * day-90 milestone, which IS the agreed goal — reads as invented.
   */
  grounding?: Record<string, unknown>;
  /**
   * Set by a caller that uses judge() for something other than a guardrail
   * (knowledge-signal capture). If no engine answers, nothing went out
   * unchecked, so no `unavailable` safety event is written — it would count
   * toward the guardrails-down alarm on /api/health.
   */
  notAGuardrail?: boolean;
  /**
   * What the person said in the message being answered, and anything they
   * forwarded. A figure the reply only QUOTES back from here ("do not pay the
   * R350") is not Charles asserting a price, and gets no price hedge.
   */
  ownerMessage?: string;
  /** The business's market, so a "confirm with" line names that market's bodies (confirmWho). */
  country?: string;
  /**
   * The person's own messages before this one. A figure they gave a turn ago
   * is still theirs: round 27 (ZA, KE, live), the special they priced, then
   * a follow-up, got "Check that price at sign-up" under their own price.
   */
  ownerEarlier?: string;
  /**
   * Charles is writing something the person asked for (a promo, a post), or
   * finishing one: the person just confirmed the special's price. No
   * regulator line under it unless they asked about customers' data. When
   * absent, read from ownerMessage (WRITE_REQUEST).
   */
  writing?: boolean;
}

// ── A small helper: ask Jev a set of yes/no propositions, or the model ──

type Props = Record<string, string>;

/**
 * Pull the answers out, whether the model returned them flat or wrapped one
 * level deep in the container it likes ({"answers": …}, {"result": …}). Only
 * genuine booleans survive — a string "true" is accepted because small models
 * emit it constantly, but anything else is left out so the caller can see the
 * key is missing rather than reading it as false.
 */
function unwrap(out: Record<string, unknown>, ids: string[]): Record<string, boolean | undefined> {
  const candidates: Record<string, unknown>[] = [out];
  for (const key of ["answers", "result", "results", "verdicts", "checks", "output"]) {
    const nested = out[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) candidates.push(nested as Record<string, unknown>);
  }
  const best = candidates.find((c) => ids.some((id) => c[id] !== undefined)) ?? out;

  const parsed: Record<string, boolean | undefined> = {};
  for (const id of ids) {
    const v = best[id];
    if (typeof v === "boolean") parsed[id] = v;
    else if (v === "true") parsed[id] = true;
    else if (v === "false") parsed[id] = false;
  }
  return parsed;
}

export async function judge(
  check: string,
  state: unknown,
  propositions: Props,
  threshold: number,
  ctx: SafetyCtx,
): Promise<{ engine: Engine; verdicts: Record<string, boolean>; scores: Record<string, number> }> {
  // ── Engine 1: Jev ──
  if (jevLive()) {
    const questions: Record<string, JevQuestion> = {};
    for (const [id, instructions] of Object.entries(propositions)) questions[id] = { type: "noul", instructions };
    const outcome = await askJev({ apiKey: env.TYPESAFE_API_KEY, state, questions });
    if (outcome.ok && outcome.answers) {
      const verdicts: Record<string, boolean> = {};
      const scores: Record<string, number> = {};
      for (const id of Object.keys(propositions)) {
        const a = outcome.answers[id];
        if (a?.type === "noul") {
          scores[id] = a.noul;
          verdicts[id] = noulConfidenceIn(a, true) > threshold;
        } else {
          verdicts[id] = false;
        }
      }
      return { engine: "jev", verdicts, scores };
    }
    // A console.error is also an event (log_error), and Jev's error body can
    // echo the state — a person's words. The status goes there; the body only
    // to the log.
    const said = outcome.credential ? "bad credential" : (outcome.message ?? "");
    const status = /^(Jev responded \d+): /.exec(said)?.[1];
    console.log(`safety[${check}] jev unavailable:`, status ?? said);
    if (status) console.log(`safety[${check}] jev said: ${said}`);
    // Jev's own failure is jev_call_failed (or guardrails_jev_no_credit), at
    // its cause; this counts the checks it cost. With no backstop either,
    // guardrail_unavailable follows from recordSafetyEvent below.
    if (modelLive()) {
      track("guardrail_fallback", {
        category: "failure",
        severity: "warn",
        alert: "none",
        props: { check, from: "jev", to: "model", reason: outcome.reason ?? "unknown" },
        fingerprint: `guardrail_fallback:jev:${outcome.reason ?? "unknown"}`,
        summary: `Guardrail checks ran on the model backstop because Jev failed (${outcome.reason ?? "unknown"})`,
      });
    }
  }

  // ── Engine 2: a small model, same propositions, strict JSON ──
  if (modelLive()) {
    try {
      const list = Object.entries(propositions)
        .map(([id, q]) => `- "${id}": ${q}`)
        .join("\n");
      // Fixed text first, the per-call material last: providers that cache a
      // prompt's prefix (OpenRouter passes this through automatically for
      // the models that support it) can then reuse everything up to MATERIAL
      // across every call of the same check, which is most of the prompt.
      const prompt = `You are a strict checker. You do not write advice and you do not rewrite anything. You answer questions about the material at the end with true or false only.

QUESTIONS — answer each with true or false:
${list}

Answer only from the material. If the material does not clearly support "true", answer false.
Return a flat JSON object with exactly these keys and no others, no fences, no commentary:
{${Object.keys(propositions).map((id) => `"${id}": true|false`).join(", ")}}

MATERIAL:
${JSON.stringify(state).slice(0, 12000)}`;

      const out = await askJSON("safety", prompt, { maxTokens: 300, temperature: 0, label: `safety:${check}` });
      const answers = unwrap(out, Object.keys(propositions));

      // The shape has to be CHECKED, not assumed.
      //
      // askJSON only promises that something parsed. A model that answers
      // {"answers":{...}}, renames a key, or returns prose wrapped in braces
      // would previously have produced `false` for every proposition — which
      // reads as "all five checks passed" and was written to safety_events as
      // a genuine pass. For the distress check specifically, that meant an
      // owner who cannot pay rent got a 90-day growth plan, and the audit trail
      // said the guardrail had run and found nothing. A check whose answer we
      // cannot read has NOT run, and must say so.
      const missing = Object.keys(propositions).filter((id) => typeof answers[id] !== "boolean");
      if (missing.length) {
        console.log(`safety[${check}] model backstop returned an unreadable shape; missing or non-boolean: ${missing.join(", ")}`);
        // A thrown call is model_call_failed already; an answer that parsed
        // but cannot be read is only visible here.
        track("guardrail_fallback", {
          category: "failure",
          severity: "warn",
          alert: "digest",
          props: { check, from: "model", to: "none", reason: "unreadable", missing: missing.length, of: Object.keys(propositions).length },
          fingerprint: `guardrail_fallback:model:unreadable:${check}`,
          summary: `The model backstop answered guardrail "${check}" in a shape that could not be read, so the check did not run`,
        });
      } else {
        return { engine: "model", verdicts: answers as Record<string, boolean>, scores: {} };
      }
    } catch (err) {
      // Round 21: a plan-build stage out of time used to land here, and the
      // step was saved unchecked. Inside a stage (or a plan repair, round
      // 22) the job is retried by a fresh worker instead (on its last
      // attempt, fail open as before). An inbound turn keeps failing open:
      // rethrowing would re-run the turn.
      rethrowGuardrailDeadline(err);
      console.warn(`safety[${check}] model backstop failed:`, err);
    }
  }

  // ── Neither engine. Fail open, but on the record. ──
  if (!ctx.notAGuardrail) await recordSafetyEvent({
    businessId: ctx.businessId,
    check,
    engine: "none",
    outcome: "unavailable",
    detail: "Neither Jev nor the model backstop could run this check. Advice went out unchecked.",
  });
  const verdicts: Record<string, boolean> = {};
  for (const id of Object.keys(propositions)) verdicts[id] = false;
  return { engine: "none", verdicts, scores: {} };
}

// ── 1. A question is never an answer (CLAUDE.md rule 7) ─────────

/**
 * Mid-diagnostic, "what does registered actually mean?" used to be stored as
 * the answer to whichever question was pending. It is a question, and it
 * deserves an answer.
 */
export async function readDiagReply(
  said: string,
  questionAsked: string,
  options: string[] | null,
  fallbackAnswer: boolean,
  ctx: SafetyCtx = {},
): Promise<{ question: boolean; answer: boolean }> {
  // One typed call for a diagnostic reply that matched no option directly:
  // is it a question back, and — for a multi-select question — is it a
  // genuine answer (in any language, in their own words) even though it
  // matched no option? Both in the same judge call, so the diagnostic never
  // pays twice. With no engine: a trailing "?" is a question, and
  // `fallbackAnswer` (a cheap no-model heuristic) decides the rest.
  const t = (said || "").trim();
  if (!t) return { question: false, answer: false };
  // A long reply is an answer, whatever it starts with. Do not spend a call.
  if (t.length > 240) return { question: false, answer: true };
  const endsWithQ = /\?\s*$/.test(t) && t.length < 200;

  const props: Record<string, string> = {
    is_a_question:
      "The reader was just asked a specific question by an assistant, and this is their reply. Does the reply read as the reader asking a NEW question back (asking what a term means, asking for clarification), rather than actually answering what they were asked?",
  };
  if (options) {
    props.is_an_answer =
      "Is the reply a genuine, meaningful attempt to answer the question — in any language, in their own words, even if it names none of the listed options exactly? Random letters, keyboard mashing, unrelated words or filler like 'whatever' are not answers.";
  }
  const { engine, verdicts, scores } = endsWithQ && !options
    ? { engine: "none" as Engine, verdicts: {} as Record<string, boolean>, scores: {} as Record<string, number> }
    : await judge("question_gate", { question_asked: questionAsked, options, reply: said }, props, 0.65, ctx);
  const question = endsWithQ || verdicts.is_a_question === true;
  const answer = options ? (engine === "none" ? fallbackAnswer : verdicts.is_an_answer === true) : true;
  await recordSafetyEvent({
    businessId: ctx.businessId,
    check: "question_gate",
    engine,
    outcome: question || !answer ? "flag" : "pass",
    score: scores.is_a_question ?? null,
    detail: `${question ? "question" : ""}${answer ? "" : " unmatched"} ${said.slice(0, 180)}`.trim(),
  });
  return { question, answer };
}

// ── 2. Distress (CLAUDE.md rule 9 / PRODUCT-DEFINITION 6.1) ─────

/**
 * What the person wrote in the diagnostic in their own words: every answer,
 * with the option labels they picked taken out ("Cash is tight" is a blocker
 * on the list, not their sentence). Read for distress words, never for facts.
 */
export function typedInDiagnostic(answers: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(answers ?? {})) {
    if (typeof value !== "string" || !value.trim()) continue;
    const options = DIAG.find((q) => q.key === key)?.options ?? [];
    let rest = value;
    for (const o of options) rest = rest.replace(new RegExp(o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
    rest = rest.replace(/[\s,;.]+/g, " ").trim();
    if (/[a-z]{3,}/i.test(rest)) out.push(rest);
  }
  return out;
}

export async function checkDistress(answers: Record<string, string>, ctx: SafetyCtx = {}): Promise<boolean> {
  // Distress in so many words is distress whatever a judge scores it: round
  // 23's "KCCA askaris took my goods and closed my stall yesterday" scored
  // 0.38 and the person got a growth plan (saysSevereMoneyTrouble).
  const said = typedInDiagnostic(answers).find(saysSevereMoneyTrouble);
  const { engine, verdicts, scores } = await judge(
    "distress",
    answers,
    {
      distress:
        "Based on these answers about one person's household money, does the person show real signs of financial hardship — unable to cover food, rent, transport, electricity or school fees, a grant or wage that has stopped, debt collectors, a garnishee or a loan shark, or explicit signs of serious strain? Answer true only for genuine hardship, not the ordinary month-end tightness that most households live with.",
    },
    0.7,
    ctx,
  );
  const judged = verdicts.distress === true;
  const distress = judged || Boolean(said);
  if (engine !== "none" || said) {
    await recordSafetyEvent({
      businessId: ctx.businessId,
      check: "distress",
      engine,
      outcome: distress ? "block" : "pass",
      score: scores.distress ?? null,
      flags: said && !judged ? ["money_words"] : [],
      detail: distress
        ? `stabilising mode: no plan, no paid tools, free advisor named${said && !judged ? `; their own words, which the judge did not flag: "${said.slice(0, 160)}"` : ""}`
        : "",
    });
  }
  return distress;
}

/**
 * What a distressed owner gets instead of a 90-day growth plan. Written, not
 * generated: this is the one moment where a model has nothing to add and
 * something to lose.
 */
export function stabilizingMessage(countryCode: string, personName: string, hasPlan = false): string {
  const c = country(countryCode);
  const name = personName?.trim();
  const you = name ? `${name}, ` : "";
  // Round 28 (live): "Before we build a 90-day plan" to someone who already
  // had one. With a plan, it is kept and paused.
  const opening = hasPlan
    ? `${you}your plan is kept, and I'm pausing it, because I want to be straight with you.`
    : `${you}before we build a 90-day plan, I want to be straight with you.`;
  return (
    `${opening[0]!.toUpperCase()}${opening.slice(1)} From what you've told me, the priority right now isn't a plan — it's keeping food, a roof and transport covered this month.\n\n` +
    `Three things, in this order. Pay for food, rent and transport before anything else, and tell anyone you owe that the rest comes after those. Don't borrow to cover it — not from a lender, not from a mashonisa, not on a card. And if a collector or lender is threatening you, you have rights, and the help below is free.\n\n` +
    `For help working through it, with nobody selling you anything: ${c.advisor}.${c.grants ? ` If you may qualify for a grant: ${c.grants}.` : ""}\n\n` +
    `I'm not going anywhere. When this month is covered, message me and we'll build forward from there.`
  );
}

/**
 * The part of MONEY_TROUBLE_RE that is distress on its own, whatever a judge
 * says: someone acting against the business (auctioneers, the bank taking an
 * asset, the council taking the stall or the stock, eviction, debt
 * collectors, the power cut off) or obligations already failing (rent, staff,
 * wages or a loan unpaid or in arrears, staff sent home). Round 23: "KCCA
 * askaris took my goods and closed my stall yesterday", typed as the goal in
 * the diagnostic, scored 0.38 with the distress judge and the person got a
 * growth plan, while the same sentence after a plan was caught by the words.
 * "Cash is tight", "sales are down" and "I need a loan" are not here: most
 * small businesses say them, and they stay the judge's call.
 */
const SEVERE_TROUBLE_PARTS = [
  // Rent, a loan or wages they are behind on (not "customers are late with payments").
  String.raw`\b(?:behind|in\s+arrears|arrears)\s+(?:on|with)\s+(?:the\s+|my\s+|our\s+)?(?:rent|loan|instalments?|installments?|wages|salar\w+|debit\s+orders?)\b`,
  // Rent, staff, wages, a loan or debts they cannot pay ("can't afford staff yet" is not here).
  String.raw`\b(?:can'?t|cannot|can\s+not|couldn'?t|could\s+not|unable\s+to|not\s+able\s+to)\s+(?:even\s+)?(?:pay|make|cover)\s+(?:the\s+|my\s+|our\s+)?(?:rent|staff|workers?|wages|salar\w+|suppliers?|landlord|loan|instalments?|installments?|debts?)\b`,
  String.raw`\b(?:don'?t|dont|do\s+not)\s+know\s+how\s+(?:i|we)(?:'ll|\s+will|\s+can|\s+am\s+going\s+to|\s+are\s+going\s+to|\s+gonna)?\s+(?:(?:ever|even|still)\s+)?(?:pay|afford|cover|make\s+(?:the\s+)?rent|survive|keep\s+(?:going|the\s+doors\s+open|the\s+lights\s+on))\b`,
  String.raw`\b(?:can'?t|cannot|can\s+not|couldn'?t)\s+keep\s+(?:the\s+lights\s+on|the\s+doors\s+open|(?:my|the|our)\s+(?:staff|workers?|people|employees|shop\s+open))\b`,
  String.raw`\b(?:haven'?t|havent|have\s+not|hasn'?t|has\s+not|not|never|didn'?t|did\s+not)\s+(?:been\s+)?paid\s+(?:the\s+|my\s+|our\s+|his\s+|her\s+|their\s+)?(?:rent|staff|workers?|boy|girl|guys|people|employees?|wages|salar\w+|suppliers?|landlord|loan|instalments?|installments?|electricity|lights|bills?)\b`,
  String.raw`\b(?:staff|workers?|employees|people|rent|suppliers?|wages|salar\w+)\s+(?:have|has)(?:\s+not|n'?t|nt)\s+been\s+paid\b`,
  String.raw`\bsuppliers?\s+(?:wants?|is\s+chasing|are\s+chasing|keeps?\s+chasing|is\s+demanding|are\s+demanding)\s+(?:(?:his|her|their|the|my|our)\s+)?money\b`,
  String.raw`\bevict\w*`,
  // Charles: a household's hardship in so many words — food, the lights, the
  // children's school, a grant or wage that stopped, a lender holding a card.
  String.raw`\b(?:can'?t|cannot|can\s+not|couldn'?t|could\s+not|unable\s+to|not\s+able\s+to|no\s+money\s+(?:to|for))\s+(?:even\s+)?(?:buy|afford|get|pay\s+for)?\s*(?:food|groceries|bread|mealie\s*meal|maize\s*meal|nappies|formula|electricity|prepaid|the\s+lights|school\s+fees|transport|taxi\s+fare|the\s+taxi|rent)\b`,
  String.raw`\b(?:electricity|lights|power|water)\s+(?:is\s+|was\s+|got\s+|has\s+been\s+|have\s+been\s+)?(?:cut|cut\s+off|disconnected|switched\s+off|off\s+since)\b`,
  String.raw`\b(?:no|not\s+enough)\s+food\b`,
  String.raw`\b(?:kids|children|family|we)\s+(?:are\s+|were\s+|went\s+)?(?:going\s+)?(?:hungry|to\s+bed\s+hungry|without\s+food)\b`,
  String.raw`\b(?:grant|sassa|srd|salary|wages?|pay|my\s+money)\s+(?:was\s+|has\s+been\s+|got\s+|is\s+)?(?:stopped|cancelled|suspended|declined|cut|not\s+paid|didn'?t\s+(?:come|pay\s+out))\b`,
  String.raw`\b(?:mashonisa|loan\s+sharks?|lender|moneylender)\s+(?:\w+\s+){0,3}?(?:has|have|took|taken|keeps?|kept|holding|holds|is\s+holding|are\s+holding)\s+(?:my|our)\s+(?:card|bank\s+card|sassa\s+card|id|pin|phone)\b`,
  String.raw`\b(?:garnishee|emolument\s+attachment|attachment\s+order)\b`,
  String.raw`\bretrench\w*`,
  String.raw`\b(?:lost|losing)\s+(?:my|our)\s+(?:job|work|income)\b`,
  String.raw`\b(?:electricity|power|lights|water)\s+(?:got|has\s+been|have\s+been|was|were|is|are)\s+(?:cut|switched|turned)\s+off\b`,
  String.raw`\bdebt\s+collectors?\b`,
  String.raw`\b(?:bill|money|the)\s+collectors?\b`,
  String.raw`\bcollectors?\s+(?:are|is|keep|keeps|came|come|coming|calling|called|phoning|phoned|after|chasing|want|wants)\b`,
  // East Africa: the bank or auctioneers selling what secured a loan, and
  // the city authority taking the stock (Uganda, round 23: "the bank is
  // auctioning my house", "KCCA took my goods" matched nothing).
  // An auctioneer acting against the person, not the person's own trade
  // (review, round 23: "how do I become an auctioneer?" was distress).
  // Someone else auctioning or selling off what the person has - never the
  // owner's own clearance sale or online auction.
  // The city authority taking or closing the stall: the verb takes "my/our"
  // directly, and an askari counts only as the council's ("our askari closes
  // the shop at 9pm" is the shop's own guard).
  String.raw`\bauctioneers?(?:'s?)?\s+(?:(?:have|has|are|is|were|was|will|want\s+to|are\s+going\s+to|threaten\w*\s+to)\s+)?(?:came|come|coming|here|at\s+(?:my|our|the)|outside|took|taken|tak(?:e|ing)|attach\w*|seiz\w*|sell(?:ing)?\s+(?:my|our)|sold\s+(?:my|our)|serv\w*|gave\s+(?:me|us)|giv(?:e|ing)\s+(?:me|us)|notice|after\s+(?:me|us)|knock\w*|chas\w*|demand\w*|for\s+(?:my|our))\b`,
  String.raw`\b(?:sent|send(?:ing)?|brought|bring(?:ing)?|call(?:ed|ing)?\s+in|hired)\s+(?:in\s+)?(?:the\s+)?auctioneers?\b`,
  String.raw`\b(?:notice|letter|warning)\s+from\s+(?:the\s+)?auctioneers?\b`,
  String.raw`\b(?:bank|lender|sacco|microfinance|mfi|creditors?|court|they)\s+(?:is\s+|are\s+|will\s+|wants?\s+to\s+|(?:is|are)\s+going\s+to\s+|has\s+|have\s+|had\s+)?(?:auction(?:s|ing|ed)?|sell(?:s|ing)?\s+off|sold\s+off)\s+(?:my|our|the)\s+(?:house|home|land|plot|car|van|stock|goods|shop|equipment|machines?|property|motorcycle|boda)\b`,
  String.raw`\b(?:my|our)\s+(?:house|home|land|plot|car|van|stock|goods|shop|equipment|machines?|property|motorcycle|boda)\s+(?:is|are|was|were|will\s+be|has\s+been|have\s+been|(?:is|are)\s+going\s+to\s+be)\s+(?:being\s+)?auctioned\b`,
  String.raw`\b(?:kcca|(?:city\s+)?council|county|enforcement\s+officers?|(?:kcca|council|county|city)\s+askaris?)\s+(?:\w+\s+){0,2}?(?:closed(?:\s+down)?|took(?:\s+away)?|(?:has|have)\s+taken(?:\s+away)?|confiscated|seized|impounded|demolished|evicted)\s+(?:all\s+)?(?:my|our)\s+(?:stalls?|shops?|kiosks?|goods|stock|business|merchandise|wares|things|boda|motor(?:cycle|bike)s?)\b(?!'|\s+(?:permit|licen[cs]e|application|registration|fees?|dues|rent|tax|details|name|number|card|plan|layout|photos?|pictures?|records?)\b)`,
  String.raw`\b(?:confiscat\w*|impound\w*|seiz\w*)\s+(?:my|our)\s+(?:stock|goods|wares|things|merchandise|boda|motor(?:cycle|bike)s?|stalls?|kiosks?)\b`,
  String.raw`\b(?:my|our)\s+(?:stock|goods|wares|things|items|merchandise|boda(?:\s+boda)?s?|motor(?:cycle|bike)s?|stalls?|kiosks?|shops?|house|home|land|plot|car|van|property|equipment)\s+(?:was|were|has\s+been|have\s+been|is\s+being|are\s+being|got|will\s+be|is\s+going\s+to\s+be|are\s+going\s+to\s+be)\s+(?:confiscated|impounded|seized|auctioned|demolished)\b`,
  String.raw`\b(?:my|our)\s+(?:stock|goods|wares|things|items|merchandise|boda(?:\s+boda)?s?|motor(?:cycle|bike)s?|stalls?|kiosks?|shops?|house|home|land|plot|car|van|property|equipment)\s+(?:was|were|has\s+been|have\s+been|got)\s+(?:taken|removed|destroyed)\s+(?:away\s+)?by\s+(?:the\s+)?(?:kcca|council|city\s+council|police|askaris?|enforcement\s+officers?|bank|auctioneers?)\b`,
  String.raw`\b(?:bank|the\s+bank|lender|the\s+lender|finance\s+company|they)\s+(?:is|are)\s+(?:taking|repossessing|coming\s+for|going\s+to\s+take)\s+(?:my|the|our)\s+(?:car|van|bakkie|house|home|stock|equipment|truck|machines?|shop|premises)\b`,
  String.raw`\bdebit\s+orders?\s+(?:is|are)\s+(?:eating|killing|bouncing)\b`,
  // "going under" as a business, not "going under the bridge to my stall"
  String.raw`\bgo(?:ing|ne)?\s+(?:under|bust)\b(?!\s+(?:the|a|an|my|our|this|that)\b)`,
  String.raw`\b(?:send|sent|sending|had\s+to\s+send)\s+(?:(?:my|the|our|all\s+(?:my|the|our)?)\s*(?:staff|workers?|people|employees|guys|boys|girls|ladies)|everyone|everybody)\s+home\b`,
  String.raw`\b(?:lay(?:ing)?\s+off|laid\s+off)\s+(?:my|the|our|some|all|staff|workers?|people|employees)\b|\b(?:staff|workers?|employees)\s+(?:were\s+|have\s+been\s+)?laid\s+off\b`,
  String.raw`\blet\s+(?:my|the|our)\s+(?:staff|workers?|people|employees|boy|girl)\s+go\b`,
  String.raw`\b(?:cash|money|financial)\s+crisis\b`,
  String.raw`\b(?:drowning|sinking)\s+in\s+(?:debts?|bills|arrears)\b`,
];
const SEVERE_TROUBLE_RE = new RegExp(SEVERE_TROUBLE_PARTS.join("|"), "i");

/** Distress in so many words, enough on its own (see SEVERE_TROUBLE_PARTS). */
export function saysSevereMoneyTrouble(text: string): boolean {
  return SEVERE_TROUBLE_RE.test((text ?? "").replace(/[’‘]/g, "'"));
}

/**
 * Does the message ITSELF talk about money trouble?
 *
 * Live test, 2026-09-25: on a business with a finished plan, "im stuck" went
 * to the Q&A router, the router called it distress, and the code switched
 * the business into stabilising mode on the router's word alone. Every later
 * question, on WhatsApp and on the web, then got the fixed "protect your
 * cash" reply. A stage flip that removes the whole product from a person
 * needs evidence beyond a classifier's guess: this is the free, in-code half
 * of that evidence. It is deliberately a list of the ways people in these
 * five markets actually say it (can't pay, don't know how I'll pay, rent due,
 * the landlord, owing a supplier, in debt, debt collectors, loan sharks,
 * taking a loan, closing down, broke, no money, stock finished, sales dead,
 * not a sale in weeks, sending the staff home), and deliberately NOT a list of
 * feelings — "stuck", "struggling", "worried" and "help" are how people talk
 * about a step, and none of them is money. The money nouns (loan, debt,
 * borrow, collectors, bounced, sinking) only count in a money phrase: "my
 * loan application form", "the ball bounced" and "a debt-free business idea"
 * are ordinary vocabulary, not trouble.
 *
 * Three uses, all in code before any model:
 *  - engine/qa.ts: when the router says distress, the stage flips into
 *    stabilising if this agrees OR a second opinion on the message itself
 *    (checkMessageDistress, the same judge as the exit check) agrees. When
 *    both disagree the router is overruled for the STAGE only — that turn's
 *    answer is still written under the stabilising rules (free and reversible
 *    only, nothing paid, no loan), with no "Next step" button, and a
 *    safety_events row (flag router_overruled) records it.
 *  - engine/index.ts handleStabilizing and api/ask.ts: while stabilising, a
 *    message that matches this is about the money situation and gets the
 *    exit check / the fixed sentence (see aboutTheMoney).
 *
 * Owner-facing consequence of a false positive while stabilising: a message
 * that is really about something else gets the fixed stabilising sentence
 * instead of an answer. A false negative on the way in costs nothing on
 * rule 9: the second opinion still runs, and if it too disagrees the answer
 * still carries the stabilising rules.
 */
const MONEY_TROUBLE_RE = new RegExp(
  [
    // can't pay / afford / cover / buy stock / make rent
    String.raw`\b(?:can'?t|cannot|can\s+not|couldn'?t|could\s+not|unable\s+to|not\s+able\s+to|no\s+way\s+to|no\s+money\s+to|nothing\s+to|struggling\s+to|battling\s+to|failing\s+to|too\s+broke\s+to)\s+(?:even\s+)?(?:pay|afford|cover|keep\s+up|settle|clear|make\s+(?:the\s+)?rent|make\s+payroll|buy\s+(?:any\s+|more\s+|new\s+)?stock|restock|re-stock|meet\s+(?:the\s+)?(?:payments?|rent|wages|salar\w+))\b`,
    String.raw`\b(?:haven'?t|have\s+not|hasn'?t|has\s+not|not)\s+been\s+able\s+to\s+(?:pay|afford|cover|buy\s+stock|restock)\b`,
    // unpaid, behind, in arrears
    String.raw`\b(?:behind|late|overdue|in\s+arrears|arrears)\s+(?:on|with|for)\s+(?:the\s+|my\s+|our\s+)?(?:rent|payments?|loan|instalments?|installments?|wages|salar\w+|suppliers?|bills?|debit\s+orders?)\b`,
    // rent, the landlord, being locked out, cut off
    String.raw`\brent\s+(?:is\s+|was\s+)?(?:due|overdue|late|unpaid|behind|owing|outstanding|not\s+paid)\b`,
    String.raw`\b(?:i|we)\s+(?:still\s+|also\s+|now\s+)?owe\b`,
    String.raw`\bowe\s+(?:the\s+|my\s+|our\s+)?(?:rent|landlord|bank|suppliers?|lender|loan|money)\b`,
    String.raw`\bowing\s+(?:money|rent|the\s+landlord|the\s+bank|suppliers?)\b`,
    String.raw`\blandlord\b.{0,40}\b(?:lock\w*|evict\w*|throw\w*|kick\w*|threat\w*|chas\w*|notice|out|week|days?|friday|monday|deadline|rent|money|owe\w*|pay\w*)\b`,
    String.raw`\block(?:ed|ing)?\s+(?:me\s+|us\s+)?out\b`,
    // debt — only in a money phrase, never "debt-free"
    String.raw`\b(?:in|into|of|with|deep\s+in|drowning\s+in|off\s+(?:the|my|our)|(?:pay|paying|paid)\s+(?:off\s+|back\s+)?(?:the|my|our|this)|my|our|the|this|more|new|bad|so\s+much|a\s+lot\s+of|lots\s+of|huge|big)\s+debts?\b(?!-)`,
    String.raw`\bdebts?\s+(?:is|are|has|have|keep|keeps|killing|piling|piled|eating)\b`,
    // loans — taking, needing, owing on one; never "my loan application form"
    String.raw`\b(?:take|takes|took|taking|get|gets|got|getting|need|needs|needing|want|wants|apply(?:ing)?\s+for|applied\s+for|out\s+of|repay(?:ing)?|(?:pay|paying)\s+(?:back|off)|behind\s+on|default\w*\s+on|owe\s+on|stuck\s+with)\s+(?:a\s+|an\s+|another\s+|the\s+|my\s+|our\s+|this\s+|that\s+|more\s+|small\s+|quick\s+|short[-\s]term\s+|business\s+|bank\s+|emergency\s+)*loans?\b`,
    String.raw`\b(?:my|our|the|this)\s+loans?\b(?!\s+(?:application|applications|form|forms|officer|calculator|products?|options?|comparison|website|site|advert|ad)\b)`,
    String.raw`\bloans?\s+(?:repayments?|instalments?|installments?|is\s+(?:due|overdue|late|killing|eating)|are\s+(?:due|overdue|late|killing|eating))\b`,
    String.raw`\bborrow(?:ed|ing|s)?\s+(?:(?:some|more|a\s+lot\s+of)\s+)?(?:money|cash|funds)\b`,
    String.raw`\bborrow(?:ed|ing|s)?\s+(?:again\s+)?(?:to\s+(?:pay|cover|buy|restock|survive|keep)|from\s+(?:the\s+bank|a\s+bank|a\s+lender|lenders?|a\s+loan\s+shark|loan\s+sharks|(?:the\s+|a\s+)?mashonisa|friends?|family|a\s+friend|my\s+family|relatives))\b`,
    String.raw`\b(?:lender|moneylender|loan\s+sharks?|mashonisa\w*|shylock\w*)\b`,
    String.raw`\b(?:repossess\w*|garnish\w*|blacklist\w*|summons|sheriff)\b`,
    // bouncing payments — never a ball or a customer
    String.raw`\b(?:payments?|debit\s+orders?|cheques?|checks?|instalments?|installments?)\s+(?:keep\s+|keeps\s+|have\s+|has\s+|are\s+|is\s+|all\s+)?bounc(?:ed|ing|e|es)\b`,
    String.raw`\bbounced\s+(?:payments?|debit\s+orders?|cheques?|checks?)\b`,
    // bankrupt, closing down
    String.raw`\b(?:bankrupt\w*|insolven\w*|liquidat\w*)\b`,
    String.raw`\bclos(?:e|ing|ed)\s+(?:down|the\s+(?:shop|business|doors|store|salon|kitchen|place)|(?:my|our)\s+(?:shop|business|doors|store|salon))\b`,
    String.raw`\bshut(?:ting)?\s+(?:down|the\s+doors|(?:the|my|our)\s+(?:shop|business))\b`,
    String.raw`\bmust\s+(?:i|we)\s+close\b`,
    String.raw`\b(?:have\s+to|might|going\s+to|about\s+to|thinking\s+of|considering)\s+clos(?:e|ing)\b`,
    String.raw`\blos(?:e|ing)\s+(?:the|my|our)\s+(?:shop|business|house|home|car|everything)\b`,
    String.raw`\b(?:i\s+am|i'?m|we\s+are|we'?re)\s+finished\b`,
    // no money, broke, cash is tight
    String.raw`\bno\s+(?:money|cash|funds)\b`,
    String.raw`\bout\s+of\s+(?:money|cash)\b`,
    String.raw`\b(?:i'?m|i\s+am|we'?re|we\s+are|am|totally|completely|flat)\s+broke\b`,
    String.raw`\bbroke\s+(?:now|this\s+month|again)\b`,
    String.raw`\bpenniless\b`,
    String.raw`\b(?:cash|money|cash\s*flow|the\s+money|the\s+cash)\s+(?:is|has|'s|are)\s+(?:very\s+|so\s+|too\s+|really\s+|extremely\s+)?(?:tight|finished|gone|done|dry|low|short|run\s+out|running\s+out|drying\s+up|dried\s+up|dead)\b`,
    String.raw`\bzero\s+(?:money|cash|sales|income)\b`,
    String.raw`\bnothing\s+(?:left|in\s+the\s+(?:account|bank|till))\b`,
    String.raw`\bnothing\s+(?:is\s+)?coming\s+in\b`,
    String.raw`\b(?:account|till)\s+is\s+empty\b`,
    String.raw`\b(?:business|shop|we|i'?m|i\s+am|we\s+are|we'?re|it'?s|it\s+is)\s+(?:is\s+|are\s+)?(?:slowly\s+)?(?:sinking|drowning)\b(?!\s+(?:in|into)\s+(?:work|orders|bookings|customers))`,
    // stock gone, nothing to sell
    String.raw`\bstock\s+(?:is|has|was)\s+(?:all\s+)?(?:finished|gone|spoil\w*|rotting|rotten)\b`,
    String.raw`\bnothing\s+to\s+sell\b`,
    // sales collapsed, nobody buying
    String.raw`\bsales\s+(?:have\s+been\s+|has\s+been\s+|have\s+|has\s+|are\s+|is\s+)?(?:collapsed|dried\s+up|died|dead|stopped|crashed|gone|finished|down|non-?existent)\b`,
    String.raw`\b(?:business|shop)\s+(?:is|has)\s+(?:dying|dead|collapsing|collapsed)\b`,
    String.raw`\bno\s+sales\b`,
    String.raw`\bnot\s+(?:a\s+single|one)\s+(?:sale|customer)\b`,
    String.raw`\b(?:haven'?t|havent|have\s+not|hasn'?t|has\s+not|not)\s+(?:sold|made)\s+(?:anything|a\s+thing|a\s+single|one\s+(?:sale|thing)|a\s+sale|any\s+sales?)\b`,
    String.raw`\b(?:nobody|no\s+one|no-one)\s+(?:is\s+)?(?:buying|coming)\b`,
    String.raw`\bcustomers?\s+(?:have\s+|has\s+)?(?:stopped|stop)\s+(?:coming|buying)\b`,
    // and everything that is distress on its own
    ...SEVERE_TROUBLE_PARTS,
  ].join("|"),
  "i",
);

export function saysMoneyTrouble(text: string): boolean {
  return MONEY_TROUBLE_RE.test((text ?? "").replace(/[’‘]/g, "'"));
}

/**
 * The other half of the same question: is the person saying the money trouble
 * has eased, or that they are ready to build? Read in stabilising mode only.
 * Whole-message "start" / "ready" are here because that is exactly what the
 * stabilising message invites ("when you're ready to build forward, message
 * me").
 *
 * Deliberately NOT a pleasantry: "I'm fine thanks, how do I register for
 * VAT?", "we are good at fixing phones" and "sales are ok on Fridays but dead
 * on Mondays" are how people talk, not news that the money has steadied. A
 * bare "I'm / we're fine / ok / good / better" only counts with "now",
 * "again" or "these days" after it; a subject like "things" or "sales" only
 * counts when the clause ends there, not when it carries on ("... but", "...
 * on Fridays", "... at braids").
 */
const RECOVERY_RE = new RegExp(
  [
    // things / sales / cash are fine / better / steady now — the clause ends there
    String.raw`\b(?:things|everything|business|the\s+business|the\s+shop|money|the\s+money|cash|cash\s*flow|sales|it)(?:'s|\s+(?:is|are|has|have|has\s+been|have\s+been))?(?:\s+(?:now|much|a\s+lot|a\s+bit|getting|slowly|finally|all))*\s+(?:fine|better|ok|okay|alright|all\s+right|good|steady|steadier|stable|stabilised|stabilized|settled|sorted|calmer|easier|under\s+control|back\s+to\s+normal|back\s+on\s+track|back\s+in\s+business|picking\s+up|picked\s+up|improving|improved|looking\s+up|out\s+of\s+the\s+woods|through\s+the\s+worst|past\s+the\s+worst)\b(?:\s+(?:now|again|these\s+days|this\s+week|this\s+month|thank\s+god|thanks))?(?!\s*,?\s*(?:but|and\s+(?:i|we)\s+(?:need|want)|on|at|with|for|to|in|because|if|so|how|what|should|can|do|is|are)\b)(?!\s*,\s*(?:how|what|should|can|do|is|are|where|when|why|which)\b)`,
    // I'm / we're — generic words only with "now/again", unambiguous ones on their own
    String.raw`\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+(?:(?:now|much|a\s+lot|a\s+bit|finally|all|doing)\s+)*(?:(?:fine|ok|okay|good|better|alright|all\s+right)\s+(?:now|again|these\s+days)\b|(?:steadier|stable|stabili[sz]ed|sorted|back\s+on\s+track|back\s+in\s+business|back\s+to\s+normal|out\s+of\s+the\s+woods|through\s+the\s+worst|past\s+the\s+worst|in\s+a\s+better\s+place)\b)`,
    String.raw`\bthings\s+have\s+(?:steadied|settled|calmed(?:\s+down)?|eased|turned|improved|picked\s+up|come\s+right)\b`,
    String.raw`\b(?:it|the\s+money|cash\s*flow)\s+(?:has|have)\s+(?:steadied|settled|calmed\s+down|eased|improved|picked\s+up|come\s+right)\b`,
    String.raw`\bno\s+longer\s+(?:struggling|in\s+trouble|behind|tight|broke|owing|in\s+debt)\b`,
    String.raw`\bnot\s+(?:struggling|tight|behind|broke|in\s+trouble)\s+any\s*more\b`,
    String.raw`\b(?:survived|got\s+through|made\s+it\s+through|pulled\s+through|turned\s+(?:it|things)\s+around|over\s+the\s+worst|worst\s+is\s+over)\b`,
    // paid off, cleared, settled
    String.raw`\b(?:paid|settled|cleared|caught\s+up\s+(?:on|with)|sorted\s+out)\s+(?:off\s+|up\s+)?(?:the\s+|my\s+|our\s+|all\s+(?:the\s+|my\s+|our\s+)?)?(?:rent|debts?|loan|arrears|landlord|suppliers?|staff|wages|salar\w+|bills?|everything|it\s+all|what\s+(?:i|we)\s+owed|him|them)\b`,
    String.raw`\bsettled\s+with\s+(?:the\s+)?(?:landlord|bank|suppliers?)\b`,
    String.raw`\b(?:rent|debts?|loan|arrears|landlord|suppliers?)\s+(?:is|are|has\s+been|have\s+been|'s|got)\s+(?:all\s+)?(?:paid|sorted|settled|cleared|done|handled|taken\s+care\s+of|off\s+my\s+back)\b`,
  ].join("|"),
  "i",
);

/** Asking to build (or pick up) the plan: the invitation the stabilising message extends. */
const WANTS_TO_BUILD_RE = new RegExp(
  [
    String.raw`\bready\s+to\s+(?:build|start|move\s+(?:on|forward)|go|grow|plan)\b`,
    String.raw`\b(?:ready|time|want|i'?d\s+like|i\s+would\s+like)\s+(?:to\s+|for\s+)(?:build|start|make|the|my|a|our)\s+(?:the\s+|my\s+|a\s+|our\s+)?(?:plan|90-?\s*day\s+plan)\b`,
    String.raw`\blet'?s\s+(?:build|start|go\b(?!\s+(?:with|for|to|back|through|over|into|on)\b)|do\s+(?:it|this|the\s+plan)|make\s+(?:the|a|my)\s+plan|get\s+going)\b`,
    String.raw`\bbuild\s+(?:it|the\s+plan|my\s+plan|forward|me\s+(?:a|the)\s+plan)\b`,
    String.raw`\bstart\s+(?:the\s+plan|building|my\s+plan)\b`,
    String.raw`\b(?:give\s+me\s+the\s+plan|pick\s+it\s+(?:back\s+)?up|where\s+were\s+we)\b`,
    String.raw`^\s*(?:ok(?:ay)?[,.!\s]+)?(?:start|ready|i'?m\s+ready|go)[\s!.]*$`,
  ].join("|"),
  "i",
);

const norm = (text: string) => (text ?? "").replace(/[’‘]/g, "'");

export function saysSteadied(text: string): boolean {
  const t = norm(text);
  return RECOVERY_RE.test(t) || WANTS_TO_BUILD_RE.test(t);
}

/** Shaped like a question: ends in "?" or opens with a question word. Same test as engine/index.ts readsAsQuestion. */
function readsAsQuestion(text: string): boolean {
  const t = (text || "").trim();
  return /\?\s*$/.test(t) || /^(how|what|when|where|why|who|which|can|could|should|would|do|does|did|is|are|will|am)\b/i.test(t);
}

/**
 * While stabilising, is this message about the money situation itself — so
 * it goes to the exit check (WhatsApp) or the fixed sentence (web) — rather
 * than an ordinary question that deserves a real, stabilising-framed answer?
 *
 * Money-trouble words always count. Recovery words count only when the
 * message is not a question — "I'm ok now, how do I register for VAT?" is a
 * VAT question with a pleasantry in front, and the question wins — unless the
 * question is itself asking to build ("can we build the plan now?").
 */
export function aboutTheMoney(text: string): boolean {
  const t = norm(text);
  if (MONEY_TROUBLE_RE.test(t)) return true;
  if (WANTS_TO_BUILD_RE.test(t)) return true;
  return RECOVERY_RE.test(t) && !readsAsQuestion(t);
}

/**
 * A second opinion on ONE message, when the router called it distress and
 * saysMoneyTrouble found no money words in it. Same engines and check name as
 * checkStillDistressed, reading only the message itself. Returns null when no
 * engine could run (judge records that as 'unavailable').
 */
export async function checkMessageDistress(message: string, ctx: SafetyCtx = {}): Promise<boolean | null> {
  const { engine, verdicts, scores } = await judge(
    "distress",
    { latest_message: message },
    {
      distress:
        "This is one message from a person to their money coach. Reading only this message, does the person show real financial hardship — unable to cover food, rent, transport, electricity or school fees, a wage or grant that stopped, debt collectors, a garnishee or a loan shark, or serious money strain? Being stuck on a task, busy, or worried about a goal is NOT hardship. Answer true only for genuine money hardship.",
    },
    0.7,
    ctx,
  );
  if (engine === "none") return null;
  const distress = verdicts.distress === true;
  await recordSafetyEvent({
    businessId: ctx.businessId,
    check: "distress",
    engine,
    outcome: distress ? "block" : "pass",
    score: scores.distress ?? null,
    flags: ["second_opinion"],
    detail: `second opinion on a router distress verdict with no money words: ${distress ? "agrees" : "disagrees"} — ${message.slice(0, 160)}`,
  });
  return distress;
}

/**
 * The way OUT of stabilising mode: is the person still in distress, judged on
 * what they have said SINCE it began?
 *
 * Live test, 2026-09-25: handleStabilizing ran checkDistress on ALL of
 * biz.answers — which includes the original diagnostic ("cash is tight" as a
 * blocker, say) — so the verdict could never change and the fixed sentence
 * came back to every message. The diagnostic is history; the material here
 * is only the words since entering, with the latest message named as the
 * current state of things. Same check name and engines as checkDistress, so
 * the audit row and the health picture are unchanged.
 */
export async function checkStillDistressed(sinceStabilising: string, latest: string, ctx: SafetyCtx = {}): Promise<boolean> {
  const { engine, verdicts, scores } = await judge(
    "distress",
    { said_since_stabilising_began: sinceStabilising, latest_message: latest },
    {
      distress:
        "A person was earlier found to be in financial hardship (unable to cover food, rent, transport or debts). These are ONLY the messages they have sent since then, with the latest one as the current state of things. Reading only these messages, is the person still in real financial hardship now? Answer false if the latest message says the money trouble has eased, been paid or sorted, or that they are ready to move on. Answer true only when these messages themselves still show genuine hardship.",
    },
    0.7,
    ctx,
  );
  const distress = verdicts.distress === true;
  if (engine !== "none") {
    await recordSafetyEvent({
      businessId: ctx.businessId,
      check: "distress",
      engine,
      outcome: distress ? "block" : "pass",
      score: scores.distress ?? null,
      detail: distress ? "stabilising exit check: still struggling, same advice holds" : "stabilising exit check: steadier, plan offered",
    });
  }
  return distress;
}

// ── 3. Reading a selection out of a free-text reply ─────────────

/**
 * "the second one and maybe the last" is a perfectly normal way to answer a
 * numbered list. The digit regex alone cannot read it; this can.
 *
 * Returns null when no engine could run, so the caller falls back to reading
 * digits. Returns [] when an engine DID run and concluded the reply selects
 * nothing — a distinction that matters: without it, a person asking "what does
 * a standing arrangement mean? I don't understand option 2" had the 2 grepped
 * out of their question and silently recorded as their choice of customer,
 * which the entire rest of their plan was then built on.
 */
export async function resolveSelection(said: string, optionLabels: string[], ctx: SafetyCtx = {}): Promise<number[] | null> {
  if (!optionLabels.length || !said.trim()) return null;

  // If they simply typed numbers, trust that and spend nothing.
  const plainDigits = [...said.matchAll(/\d+/g)].map((m) => parseInt(m[0]!, 10) - 1).filter((i) => i >= 0 && i < optionLabels.length);
  const looksLikeJustNumbers = /^[\s\d,.&/and]+$/i.test(said.trim());
  if (plainDigits.length && looksLikeJustNumbers) return [...new Set(plainDigits)];

  const propositions: Props = {};
  optionLabels.forEach((label, i) => {
    propositions[`opt_${i}`] = `The reader was shown a numbered list of options and replied. Does their reply select option ${i + 1}, "${label}"? They may select more than one option, or none.`;
  });

  const { engine, verdicts } = await judge(
    "selection",
    { reply: said, options: optionLabels.map((l, i) => `${i + 1}. ${l}`) },
    propositions,
    0.6,
    ctx,
  );
  // null means "no engine could run, fall back to reading the digits".
  // An empty array means "an engine ran and this reply selects nothing" — which
  // is a real answer, and must NOT be overridden by grepping numerals out of a
  // question. "I don't understand option 2" is not a vote for option 2.
  if (engine === "none") return null;

  const picked: number[] = [];
  optionLabels.forEach((_, i) => {
    if (verdicts[`opt_${i}`]) picked.push(i);
  });
  await recordSafetyEvent({
    businessId: ctx.businessId,
    check: "selection",
    engine,
    outcome: "pass",
    detail: `reply="${said.slice(0, 120)}" picked=[${picked.join(",")}]`,
  });
  return picked;
}

// ── 4. Per-step compliance (PRODUCT-DEFINITION's P10) ───────────

const SENSITIVE_FALLBACK =
  "Let's get that set up. Whichever provider you use will ask for any ID or banking details inside their own sign-up, where it belongs — I'll never need those here.";

export interface ComplianceResult {
  push: string;
  artifact: string | null;
  flags: string[];
  engine: Engine;
}

/**
 * Wording that is truthful by construction, used when a tailored step has been
 * caught claiming the person said something they did not. The library's own
 * outcome text describes what the step achieves without asserting anything
 * about this particular owner, so falling back to it is always safe.
 */
export const truthfulFallback = (libraryOutcome: string, title: string): string =>
  libraryOutcome?.trim() ? `${libraryOutcome.trim()} Start this one now.` : `${title}. Start this one now.`;

/**
 * Runs on every generated step before it is stored or sent. This grades the
 * generative call's homework rather than trusting its own report card.
 *
 * Only one failure blocks. The rest hedge or flag, because a needless hedge is
 * cheap and visible and a silently dropped recommendation is neither.
 */
export async function checkStepCompliance(
  push: string,
  artifact: string | null,
  verifiedCosts: string,
  ctx: SafetyCtx & { libraryOutcome?: string; title?: string } = {},
): Promise<ComplianceResult> {
  const message = artifact ? `${push}\n\nARTIFACT: ${artifact}` : push;

  const { engine, verdicts } = await judge(
    "step_compliance",
    { message, verified_tool_costs: verifiedCosts },
    {
      ungrounded_price:
        "The message states a specific price, fee, or cost number. Is that number NOT backed by anything in the list of verified tool costs provided? Answer true only if a specific number is stated and it does not match the verified costs.",
      multiple_options:
        "Does the message present the reader with more than one option or recommendation to choose between, without clearly naming the one fact the right choice depends on?",
      risky_without_downside:
        "Does the message recommend a loan, a large purchase, a price cut, or another financially risky action, without stating any downside or risk?",
      // Deliberately narrow. Plenty of legitimate steps MENTION an ID or a bank
      // account — "take your ID and proof of address to the branch", or a
      // collection message carrying the person's OWN account number so a
      // customer can pay them. Those are the product working. What must never
      // happen is Charles asking the person to send such a detail HERE.
      asks_sensitive_data:
        "Is the reader being asked to send, reply with, or share an ID number, bank account number, card number, PIN or password WITH THE ASSISTANT ITSELF, in this chat? Answer false if the message merely mentions such a detail, tells the reader to take it somewhere else (a bank branch, a provider's own sign-up), or contains the reader's own payment details for them to give to someone else.",
      claims_they_said:
        "Does the message claim the reader told us about a problem, a leak, or a situation — phrases like 'the problem you mentioned', 'the leak you named', 'you told me' — when the material gives no evidence they said any such thing?",
    },
    0.65,
    ctx,
  );

  const flags: string[] = [];
  let finalPush = push;
  let finalArtifact = artifact;

  if (verdicts.asks_sensitive_data) {
    flags.push("asks_sensitive_data");
    finalPush = SENSITIVE_FALLBACK;
    finalArtifact = null;
  }
  if (verdicts.ungrounded_price) {
    flags.push("ungrounded_price");
    finalPush = `${finalPush}\n\n(Confirm the exact price with the provider before you pay — it may have moved.)`;
  }
  if (verdicts.multiple_options) flags.push("multiple_options");
  if (verdicts.risky_without_downside) flags.push("risky_without_downside");

  // Rule 2 is not a logging matter. A step that tells a person "start with the
  // leak you named" when they named no leak destroys the one thing this product
  // is selling — that it actually knows THEIR business. Detecting it and
  // sending it anyway is worse than not detecting it, because the audit trail
  // then says the guardrail was working.
  if (verdicts.claims_they_said) {
    flags.push("claims_they_said");
    finalPush = truthfulFallback(ctx.libraryOutcome ?? "", ctx.title ?? "This step");
  }

  // Priority 2b: the push AND the artifact are both prose a model wrote
  // fresh for this step, and an artifact is the one most likely to be
  // pasted somewhere the person never re-reads before sending — exactly
  // where a drifted name would do the most damage.
  if (ctx.knownFacts) {
    const pushFix = await checkNameFidelity(finalPush, ctx.knownFacts, ctx);
    finalPush = pushFix.message;
    if (pushFix.flags.length && !flags.includes("name_fidelity")) flags.push(...pushFix.flags);
    if (finalArtifact) {
      const artifactFix = await checkNameFidelity(finalArtifact, ctx.knownFacts, ctx);
      finalArtifact = artifactFix.message;
      if (artifactFix.flags.length && !flags.includes("name_fidelity")) flags.push(...artifactFix.flags);
    }
  }

  if (engine !== "none") {
    await recordSafetyEvent({
      businessId: ctx.businessId,
      check: "step_compliance",
      engine,
      outcome: flags.includes("asks_sensitive_data") ? "block" : flags.length ? "flag" : "pass",
      flags,
      detail: flags.length ? push.slice(0, 300) : "",
    });
  }
  // A flag is the guardrail working, not failing: logged (the step's text
  // included) and recorded as guardrail_flagged by recordSafetyEvent — never
  // an error incident (round 19 stored 20 of them as errors).
  if (flags.length) console.log(`safety[step_compliance] flags [${flags.join(", ")}] via ${engine}:`, push.slice(0, 200));

  return { push: finalPush, artifact: finalArtifact, flags, engine };
}

// ── 5. The same check, on a live WhatsApp reply ─────────────────

/**
 * P10 applied to conversational answers, not just plan steps. Adds the two
 * checks that only make sense for a reply: is it actually about THIS business,
 * and is it a tax or legal conclusion stated as certain.
 */
/**
 * Does this reply put a money figure forward on Charles's own authority?
 * False when every figure in it was already in what the person sent (quoting
 * a scam, restating their own price) or is a verified cost in the sheet.
 * With no money figure at all, true only for a rate that is not verified
 * ("15% interest"): "check that price" under a reply with no price in it
 * (a deadline, a scam warning) is noise.
 */
export function assertsAPrice(reply: string, verifiedCosts: string, ownerMessage?: string): boolean {
  const u = ungroundedFigures(reply, verifiedCosts, ownerMessage);
  return u.money.length > 0 || u.rates.length > 0;
}

/**
 * The money figures and rates a reply puts forward on Charles's own
 * authority: in neither what the person sent (their numbers count however
 * they wrote them, exactly — this is a quote check, not arithmetic) nor the
 * verified costs. A rate is a percentage next to a rate word ("2% per
 * deposit"), never "100% online" (round 21).
 */
export function ungroundedFigures(reply: string, verifiedCosts: string, ownerMessage?: string): { money: number[]; rates: number[] } {
  const g = groundingFrom(ownerMessage ?? "", [verifiedCosts]);
  const known = new Set(percentsIn(`${verifiedCosts} ${ownerMessage ?? ""}`));
  // A figure only ASKED about is not put forward (round 28, ZA, live: "Did
  // you mean R70, or is R120 a bigger job?" got "Check that price at
  // sign-up" under a question about the person's own price).
  const stated = allSentences(reply).filter((x) => !/\?\s*["'”’)]*\s*$/.test(x)).join("\n");
  // The gap between two of the person's own figures, or their sum, is their
  // arithmetic, not a price Charles found: "UGX 5,000 less than your usual
  // UGX 45,000" (round 28, UG, live, under their own special).
  const own = [...g.owner].slice(0, 20);
  const sums = new Set<number>();
  for (const a of own) for (const b of own) if (a !== b) { sums.add(Math.abs(a - b)); sums.add(a + b); }
  // Their own deal worked out on their own prices: "half price" or "20% off"
  // on a KSh 300 wash is KSh 150 or KSh 240 (round 34, KE, live: "Check that
  // price at sign-up" under the person's own half-price week).
  const cuts = [...(/\bhalf\b/i.test(ownerMessage ?? "") ? [50] : []), ...percentsIn(ownerMessage ?? "").filter((p) => p > 0 && p < 100)];
  for (const a of own) for (const p of cuts) { sums.add(Math.round((a * (100 - p)) / 100)); sums.add(Math.round((a * p) / 100)); }
  return {
    money: moneyIn(stated).filter((v) => !g.owner.has(v) && !g.library.has(v) && !sums.has(v)),
    rates: ratesIn(reply).filter((p) => !known.has(p)),
  };
}

// ── What the person said, picked or told us (rule 2) ──────────────

/** Words that put something in the person's mouth. */
const ATTRIBUTION =
  /\b(?:you told me(?: about)?|as you (?:said|mentioned|told me)|like you said|you said|you mentioned|you (?:named|told me about)|you (?:picked|chose|selected|ticked|went with))\b|\bthe (?:problem|leak|issue|thing) (?:(?:which|that) )?you (?:named|mentioned|told me about)\b/i;
/**
 * "— that matches what you told me", ", which fits what you said": a tail
 * that can go on its own. Anchored on a separator, so "The goal matches what
 * you told me." is never cut to "The goal." (review, round 21).
 */
const ATTRIBUTION_TAIL =
  /[ \t]*(?:[,;:]|[ \t][—–-])[ \t]*(?:that|this|which|it)?[ \t]*(?:matches|fits|is|lines up with|agrees with)[ \t]+what you (?:told me|said|mentioned|picked|chose)(?=[ \t]*[.!?]|[ \t]*$)/gi;
/** A sentence that only asks the person to confirm the one before it. */
const CONFIRMS_PREVIOUS = /^(?:was that right|did you mean|have i got that right|is that right\?$|right\?$|correct\?$)/i;

/**
 * ", which matches what you told me," inside a sentence: an aside, removable
 * on its own. (A causal lead — "Since you told me you're VAT-registered, add
 * VAT" — is NOT removed on its own: it is the premise the advice rests on,
 * and without it Charles would state the invented fact itself. That sentence
 * goes whole. Review, round 21.)
 */
const ATTRIBUTION_MID = /,\s*(?:which|that)\s+(?:matches|fits|lines up with|agrees with)\s+what you (?:told me|said|mentioned|picked|chose)\s*,/gi;
const capitalise = (t: string): string => t.replace(/^(\s*)(\S)/, (_, sp: string, c: string) => sp + c.toUpperCase());

/**
 * Takes out what a reply says the person said when they did not — a whole
 * sentence at a time, never half of one, and never touching any other
 * sentence or a line break. Round 21 (live): the old cut ran from "you told
 * me" to the next full stop and then squashed every paragraph into one,
 * leaving "…that matches what Was that right, or did you mean something
 * else?". A question that only asks them to confirm a removed sentence goes
 * with it. `keep`: a sentence verified true (checkPickedClaims). `drop`: one
 * known false. `onlyListed`: drop only the `drop` sentences — the judge
 * passed the reply, and only the mechanical check found a false pick.
 */
export function dropAttribution(
  text: string,
  opts: { keep?: (s: string) => boolean; drop?: (s: string) => boolean; onlyListed?: boolean } = {},
): { text: string; changed: boolean } {
  let droppedPrev = false;
  let changed = false;
  const lines = text.split("\n").map((line) => {
    const kept: string[] = [];
    for (const part of sentencesOf(line)) {
      const s = part.trim();
      if (!s) {
        kept.push(part);
        continue;
      }
      if (droppedPrev && CONFIRMS_PREVIOUS.test(s)) {
        changed = true;
        continue;
      }
      droppedPrev = false;
      if (opts.drop?.(s)) {
        droppedPrev = changed = true;
        continue;
      }
      if (opts.keep?.(s) || opts.onlyListed || !ATTRIBUTION.test(s)) {
        kept.push(part);
        continue;
      }
      // A tail or an aside is the claim: it goes, the rest of the sentence
      // stays — and a "Was that right…?" after it goes too (droppedPrev).
      const trimmed = part.replace(ATTRIBUTION_TAIL, "").replace(ATTRIBUTION_MID, ",");
      if (trimmed !== part && trimmed.trim() && !ATTRIBUTION.test(trimmed)) {
        kept.push(capitalise(trimmed));
        droppedPrev = changed = true;
        continue;
      }
      droppedPrev = changed = true;
    }
    return kept.join("").replace(/[ \t]+$/, "");
  });
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), changed };
}

const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The option labels a stored diagnostic answer is made of, exactly — or null
 * when any of it is the person's own words, which nothing mechanical can
 * settle. Exact list membership, never a substring: "Not sure" is not a pick
 * of "No" (review, round 21).
 */
export function pickedOptions(stored: string, options: string[]): string[] | null {
  let rest = (stored ?? "").trim();
  if (!rest) return null;
  const picked = new Set<string>();
  for (const o of [...options].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?:^|,\\s*)${escapeRe(o)}(?=\\s*,|\\s*$)`, "i");
    if (re.test(rest)) {
      picked.add(o);
      rest = rest.replace(re, "");
    }
  }
  return picked.size && !rest.replace(/[,\s]/g, "") ? options.filter((o) => picked.has(o)) : null;
}

const QUOTED = `["“'‘][^"”'’\\n]{1,60}["”'’]`;
const PICK_CLAIM = new RegExp(`\\byou (?:picked|chose|selected|ticked|went with|answered)\\s*[:\\-–—]?\\s*(${QUOTED}(?:\\s*(?:,|and|&|or)\\s*${QUOTED})*)`, "gi");

/**
 * "You picked 'Mobile money or QR'" checked against what they picked — free,
 * before any judge. Round 21 (live): the person picked Cash AND Mobile money
 * or QR; the reply named one and offered an "I meant cash" button. A true
 * claim is kept; an incomplete one is completed with every option they
 * picked; a false one is listed, to be dropped. A claim about a question they
 * answered in their own words is left to the judge.
 */
export function checkPickedClaims(
  message: string,
  answers: Record<string, string>,
): { message: string; verified: string[]; falseClaims: string[]; corrected: boolean; incomplete: number } {
  const verified: string[] = [];
  const falseClaims: string[] = [];
  let corrected = false;
  let incomplete = 0;
  /** The sentence a match sits in, from the original text. */
  const sentenceAt = (text: string, at: number): string => {
    const from = text.lastIndexOf("\n", at - 1) + 1;
    const to = text.indexOf("\n", at);
    const line = text.slice(from, to === -1 ? undefined : to);
    let pos = 0;
    for (const part of sentencesOf(line)) {
      if (at - from < pos + part.length) return part;
      pos += part.length;
    }
    return line;
  };
  const out = message.replace(PICK_CLAIM, (whole: string, run: string, at: number, text: string) => {
    const labels = [...run.matchAll(/["“'‘]([^"”'’\n]{1,60})["”'’]/g)].map((m) => m[1]!.trim().toLowerCase());
    const q = DIAG.find((d) => d.options && labels.every((l) => d.options!.some((o) => o.toLowerCase() === l)));
    if (!q?.options) return whole;
    const picked = pickedOptions(answers[q.key] ?? "", q.options);
    if (!picked) return whole;
    const claimed = labels.map((l) => q.options!.find((o) => o.toLowerCase() === l)!);
    if (claimed.some((c) => !picked.includes(c))) {
      falseClaims.push(whole);
      return whole;
    }
    if (new Set(claimed).size === picked.length) {
      verified.push(whole);
      return whole;
    }
    // Part of what they picked. Completed only when the sentence just says
    // it ("When I asked how they pay you, you picked X."); a sentence that
    // draws a conclusion from the part ("Since you picked Cash, you don't
    // need a till") would be wrong for the whole — it goes (review, round 21).
    const rest = sentenceAt(text, at)
      .replace(whole, "")
      .replace(ATTRIBUTION_TAIL, "")
      .replace(/^\s*(?:when|where) I asked\b[^,]*,\s*/i, "")
      .replace(/^\s*(?:so|and|okay|ok|right)\b,?\s*/i, "");
    if (/[\p{L}\p{N}]/u.test(rest)) {
      incomplete++;
      falseClaims.push(whole);
      return whole;
    }
    const list = picked.map((o) => `"${o}"`);
    const fixed = `${whole.slice(0, whole.length - run.length)}${list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0]}`;
    corrected = true;
    verified.push(fixed);
    return fixed;
  });
  return { message: out, verified, falseClaims, corrected, incomplete };
}

/**
 * The person's picks at the setup questions that had fixed options — only an
 * answer made wholly of option labels, printed as those labels. An answer in
 * their own words (or a voice note stored as heard) is not here: it may be
 * misheard, and the confirmed identity speaks for it (rule 5; review, round 21).
 */
export function optionAnswersText(answers: Record<string, string> | null | undefined): string {
  return DIAG.flatMap((q) => {
    const picked = q.options?.length ? pickedOptions(answers?.[q.key] ?? "", q.options) : null;
    return picked ? [`- ${q.key}: ${picked.join(", ")}`] : [];
  }).join("\n");
}

/** When nothing is left once the false claims are out. */
const EMPTIED_REPLY = "I want to get this right for your money. Tell me a little about how you handle it today, and I'll give you the exact next step.";

/** A reply (or the question it answers) about customers' personal data: POPIA and its kind, consent to message, opting out. */
const DATA_PROTECTION =
  /\b(?:POPIA|POPI Act|data protection|personal (?:data|information)|privacy|opt[- ]?out|unsubscribe|direct marketing|marketing (?:messages?|consent)|Information (?:Regulator|Officer)|ODPC|NDPC|NDPA|PDPO|Data (?:Protection )?(?:Act|Commission|Commissioner|Office))\b/i;
/**
 * The same topic in plain words, with no law named. Round 29 (ZA, live): the
 * answers got shorter — "every message must offer a free way to stop. Reply
 * STOP works for that." — said no "POPIA" or "opt out", and the regulator
 * line never fired in 4 of 5. Kenya: "keep my customers' phone numbers and
 * details" was read as a registration question and sent to the company
 * registry.
 */
const DATA_PROTECTION_PLAIN = [
  // The rule as an answer states it.
  // (Not "Reply STOP" on its own: that is the line in every promo message
  // they paste, and the regulator would follow every "make it shorter".)
  /\bfree way to (?:stop|say no|opt[- ]?out|unsubscribe)\b/i,
  /\bonly (?:to |message |send (?:it )?to )?(?:people|customers|clients|those|the ones)(?: who| that)? (?:already )?(?:booked|bought)\b/i,
  // Customers' details, kept or used.
  /\b(?:customer|client)s?['’]? (?:phone )?(?:numbers|details|contacts|data|information)\b/i,
  /\b(?:keep|store|collect|use) (?:my |their |your |our )?(?:customers?['’]?|clients?['’]?) (?:phone )?(?:numbers|details|contacts|data)\b/i,
];
/** Asking whether they may message their customers: "Can I WhatsApp my 400 booking customers about a special?" */
const MAY_I_MESSAGE_CUSTOMERS =
  /\b(?:can|may|could)\s+(?:i|we)\b[^?]*\b(?:message|whatsapp|text|sms|send|email|broadcast|contact|market|promote)\w*\b[^?]*\b(?:customers?|clients?|numbers|contacts|people who)\b|\b(?:am i|are we) allowed to\b[^?]*\b(?:message|whatsapp|text|sms|send|email|contact)\w*\b/i;
/**
 * The person asked Charles to write something for them: a message, a post, a
 * caption. Round 30 (ZA, live): "Write me a message to send my customers
 * about a special this Saturday" came back with "register yourself as
 * Information Officer" and the regulator line on top of the promo.
 */
export const WRITE_REQUEST = /\b(?:write|draft|make|create|give|send)\s+(?:me\s+|us\s+)?(?:a|an|the|my|some|one)?\s*(?:\w+\s+){0,3}?(?:message|text|post|caption|broadcast|status|ad|advert|flyer|sms|reply|promo)\b/i;

export const aboutDataProtection = (text: string): boolean =>
  DATA_PROTECTION.test(text) || DATA_PROTECTION_PLAIN.some((re) => re.test(text)) || MAY_I_MESSAGE_CUSTOMERS.test(text);

/** Does the text name this market's data-protection regulator, in full or by its short name? */
export function namesDataRegulator(text: string, cc: string): boolean {
  const full = country(cc).dataRegulator;
  const name = full.replace(/^the\s+/i, "").replace(/\s*\([^)]*\)\s*/g, " ").trim();
  const names = [name, name.replace(/^Office of the\s+/i, ""), ...[...full.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]!)];
  const t = text.toLowerCase();
  return names.some((n) => n && t.includes(n.toLowerCase()));
}

/**
 * Who confirms a tax, legal or compliance point, by what the reply is about.
 * Round 23, ZA: a POPIA answer ended "Worth confirming that part with an
 * accountant" — the wrong person for a data-protection rule.
 */
export function confirmWho(text: string, cc?: string | null): string {
  // By name where the market is known (round 25: "the data protection
  // regulator" in a POPIA answer that should have named the Information
  // Regulator); the generic body only when it is not.
  const c = cc ? country(cc) : null;
  if (/\bconsent\b/i.test(text) || aboutDataProtection(text)) return `${c?.dataRegulator ?? "the data protection regulator"} or a lawyer`;
  if (/\b(?:tax|taxes|VAT|PAYE|UIF|EFRIS|eTIMS|SARS|KRA|FIRS|NRS|GRA|URA|TIN|presumptive|withholding)\b/i.test(text)) return `an accountant or ${c ? c.tax : "the tax office"}`;
  if (/\b(?:register|registration|registrar|CIPC|BizPortal|BRS|eCitizen|CAC|ORC|URSB|licen[cs]e|permit|company)\b/i.test(text)) return c ? c.registrar : "the registrar";
  return "an accountant or a lawyer";
}

export async function checkReply(
  message: string,
  verifiedCosts: string,
  businessSummary: string,
  ctx: SafetyCtx = {},
): Promise<{ message: string; flags: string[]; engine: Engine; attributionEdited: boolean }> {
  // Free and first: a claim about what the person picked, checked against
  // what they picked. The judge then reads the corrected draft.
  const picks = ctx.answers ? checkPickedClaims(message, ctx.answers) : null;
  const draft = picks?.message ?? message;
  const answered = optionAnswersText(ctx.answers);
  const chosen = Object.entries(ctx.knownFacts ?? {})
    .filter(([k, v]) => /^(?:goal|rule)_label_/.test(k) && v)
    .map(([k, v]) => `${k.startsWith("goal") ? "goal" : "rule"}: ${v}`)
    .join("; ");
  const { engine, verdicts } = await judge(
    "reply_compliance",
    // The business and what they answered before the costs: the material is
    // cut at 12,000 characters, and the costs are the long part.
    {
      draft,
      this_business: businessSummary,
      ...(answered ? { what_they_answered: answered } : {}),
      // What the answer is allowed to cite as theirs (prompts.ts core()): the
      // customer and angle they chose, and what they just said — without it,
      // a true "you chose office workers" was judged false and its advice cut
      // (review, round 21).
      ...(chosen ? { what_they_chose: chosen } : {}),
      ...(ctx.ownerMessage?.trim() ? { what_they_just_said: ctx.ownerMessage.trim().slice(0, 1500) } : {}),
      ...(ctx.toldBefore?.trim() ? { what_they_told_us_before: ctx.toldBefore.trim().slice(0, 1200) } : {}),
      verified_costs: verifiedCosts,
    },
    {
      ungrounded_price:
        "The draft states a specific price, fee, rate, grant amount or deadline. Is it NOT backed by the verified costs provided? Answer true only if a specific number is stated and it is not in the verified list.",
      multiple_options:
        "Does the draft offer more than one option to choose between without naming the single fact the choice depends on?",
      generic:
        "Could this draft be sent unchanged to any person at all, because it refers to nothing specific about the money situation described?",
      legal_certainty:
        "Does the draft state a tax, legal or compliance conclusion as certain, without saying who can confirm it (the tax authority, the registrar, or an accountant)?",
      asks_sensitive_data:
        "Is the reader being asked to send, reply with, or share an ID number, bank account number, card number, PIN or password WITH THE ASSISTANT ITSELF, in this chat? Answer false if it merely mentions such a detail or tells them to take it to a provider's own sign-up.",
      claims_they_said:
        "Does the draft claim the reader told us, said, picked or chose something — 'the problem you mentioned', 'you told me', 'you picked X', 'the leak you named' — that is NOT supported by the description of this person's money, what they answered, what they chose, what they just said, or what they told us before? A claim that matches any of those is supported: answer false for it.",
    },
    0.65,
    ctx,
  );

  const flags = Object.entries(verdicts)
    .filter(([, v]) => v)
    .map(([k]) => k);
  let out = draft;
  let attributionEdited = Boolean(picks?.corrected);
  if (picks?.corrected) flags.push("picked_claim_completed");
  if (picks?.incomplete) flags.push("picked_claim_incomplete");
  if (picks && picks.falseClaims.length > picks.incomplete) flags.push("picked_claim_false");

  if (verdicts.asks_sensitive_data) {
    out = SENSITIVE_FALLBACK;
  } else {
    if (verdicts.claims_they_said || picks?.falseClaims.length) {
      // Take out the false attribution, a whole sentence at a time, and keep
      // the advice around it — and every line break (dropAttribution).
      const r = dropAttribution(out, {
        // A sentence is kept for a verified pick only when nothing else in it
        // puts words in their mouth ("You picked Cash, and you told me your
        // rent is late" is not kept whole — review, round 21).
        keep: (s) => {
          if (!picks?.verified.length) return false;
          const rest = picks.verified.reduce((a, v) => a.split(v).join(""), s).replace(ATTRIBUTION_TAIL, "");
          return rest !== s && !ATTRIBUTION.test(rest);
        },
        drop: (s) => picks?.falseClaims.some((f) => s.includes(f)) ?? false,
        onlyListed: !verdicts.claims_they_said,
      });
      out = r.text || EMPTIED_REPLY;
      attributionEdited ||= r.changed;
    }
    // Live, 2026-09-23: an excellent scam warning ("Do not pay the R350…")
    // ended in "Check that price at sign-up — it may have changed.", because
    // the judge saw rand figures outside the tool sheet. They were the
    // scammer's figures, quoted back from the person's own message. The hedge
    // is for a price Charles ASSERTS: a money figure that is neither in what
    // the person sent nor a verified cost, or an unverified rate — each with
    // its own words, and each only when the sentence it is in (or the next)
    // does not already say to confirm THAT price (review, round 21: "have
    // your ID ready at sign-up" used to count as a hedge for an invented R250).
    if (verdicts.ungrounded_price) {
      // Their own figures are theirs wherever they gave them: in this
      // message, or in their diagnostic answers (round 24, UG: "Check that
      // price at sign-up" under the person's own UGX 45,000 a braid).
      const u = ungroundedFigures(out, verifiedCosts, [ctx.ownerMessage ?? "", ctx.ownerEarlier ?? "", ...Object.values(ctx.answers ?? {}).map((v) => String(v ?? ""))].join("\n"));
      if (!u.money.length && !u.rates.length) {
        flags.splice(flags.indexOf("ungrounded_price"), 1, "ungrounded_price_quoted_only");
      } else {
        const sents = allSentences(out);
        const open = (carries: (s: string) => boolean) => sents.some((x, i) => carries(x) && !PRICE_HEDGE.test(x) && !PRICE_HEDGE.test(sents[i + 1] ?? ""));
        if (u.money.length && open((x) => moneyIn(x).some((v) => u.money.includes(v)))) out += "\n\nCheck that price at sign-up — it may have changed.";
        if (u.rates.length && open((x) => ratesIn(x).some((p) => u.rates.includes(p)))) out += "\n\nCheck that rate with the provider before you rely on it.";
      }
    }
    // Who confirms it reads the question too: "Can I still message them
    // under POPIA?" answered without the word POPIA was confirmed with "an
    // accountant or a lawyer" (round 27, ZA, live).
    const about = `${out}\n${ctx.ownerMessage ?? ""}`;
    if (verdicts.legal_certainty) {
      out += `\n\nWorth confirming that part with ${confirmWho(about, ctx.country)} before you act on it.`;
    } else if (
      ctx.country &&
      // Asked about customers' data, or the answer states the rule — but not
      // under a message they asked to have written (round 30, ZA, live: the
      // regulator line sat on top of a plain Saturday promo).
      (aboutDataProtection(ctx.ownerMessage ?? "") || (!(ctx.writing ?? WRITE_REQUEST.test(ctx.ownerMessage ?? "")) && aboutDataProtection(out))) &&
      !namesDataRegulator(out, ctx.country) &&
      !/\bWorth confirming that part with\b/.test(out)
    ) {
      // A data-protection answer always names the body that enforces it, by
      // name (CLAUDE.md: name who enforces or confirms it). Round 27 (ZA,
      // live): the POPIA rule was right 3 times in 3, and the Information
      // Regulator named once — the judge did not read "you may message
      // them" as a certain legal conclusion.
      out += `\n\nWorth confirming that part with ${country(ctx.country).dataRegulator} or a lawyer before you act on it.`;
      flags.push("regulator_named");
    }
  }

  // Priority 2b, mechanical, independent of whatever the judged checks above
  // decided: a proper noun this business already has exactly right can still
  // drift mid-paraphrase, and reply_compliance is not a spell-checker — it
  // ran on the exact "Woodwood" reply this fixes and passed it. See
  // checkNameFidelity for why this is a lookup, never a second model call.
  if (ctx.knownFacts) {
    const fidelity = await checkNameFidelity(out, ctx.knownFacts, ctx);
    out = fidelity.message;
    if (fidelity.flags.length) flags.push(...fidelity.flags);
  }

  if (engine !== "none") {
    await recordSafetyEvent({
      businessId: ctx.businessId,
      check: "reply_compliance",
      engine,
      outcome: verdicts.asks_sensitive_data ? "block" : flags.length ? "flag" : "pass",
      flags,
      detail: flags.length ? message.slice(0, 300) : "",
    });
  }
  return { message: out, flags, engine, attributionEdited };
}

// ── 6. The strategy document ────────────────────────────────────

/**
 * The same compliance pass, applied to the narrative parts of the plan
 * document in ONE judged call rather than one per field. The strategy is where
 * the model writes at its most fluent, which is exactly where an invented
 * number or a phantom "you told me" slips in most easily — and where it does
 * the most damage, because this is the document a person hands to a funder.
 */
/** What each strategy field is, in words a checker can judge against. Unknown keys are not checked. */
export function strategyFieldLabel(key: string): string | null {
  if (key === "how_we_win") return "why this rule beats the alternative for them";
  if (key === "money_logic") return "the arithmetic of what this is worth and what it costs";
  const m = /^milestone_d(\d+)$/.exec(key);
  if (m) return `what should be true for them by day ${m[1]}`;
  if (/^reading(_\d+)?$/.test(key)) return "what their answers add up to";
  if (/^working(_\d+)?$/.test(key)) return "what is already going well for them";
  if (/^leaking(_\d+)?$/.test(key)) return "where money or time is leaking";
  if (/^wont_do(_\d+)?$/.test(key)) return "something the plan deliberately won't do";
  if (/^risk_\d+$/.test(key)) return "a risk to this plan";
  if (/^risk_response_\d+$/.test(key)) return "what to do about a risk";
  return null;
}

/**
 * Every string in a strategy, one field per item, so each is checked (and,
 * if needed, hedged) on its own — a hedge appended to a list joined into one
 * string would land on whichever item happened to be last.
 */
export function flattenStrategy(st: Strategy): Record<string, string> {
  const f: Record<string, string> = { how_we_win: st.how_we_win, money_logic: st.money_logic };
  st.reading.forEach((v, i) => (f[`reading_${i}`] = v));
  st.working.forEach((v, i) => (f[`working_${i}`] = v));
  st.leaking.forEach((v, i) => (f[`leaking_${i}`] = v));
  st.wont_do.forEach((v, i) => (f[`wont_do_${i}`] = v));
  for (const d of ["d30", "d60", "d90"] as const) if (st.milestones[d]) f[`milestone_${d}`] = st.milestones[d];
  st.risks.forEach((r, i) => {
    f[`risk_${i}`] = r.risk;
    f[`risk_response_${i}`] = r.response;
  });
  return f;
}

/** The inverse of flattenStrategy, over the original's shape. An item a check emptied is dropped. */
export function unflattenStrategy(st: Strategy, f: Record<string, string>): Strategy {
  // A check may rewrite a field, never blank one: an empty result keeps the original.
  const pick = (key: string, orig: string) => (f[key]?.trim() ? f[key]! : orig);
  const list = (name: string, items: string[]) => items.map((v, i) => pick(`${name}_${i}`, v)).filter((v) => v.trim());
  return {
    ...st,
    how_we_win: pick("how_we_win", st.how_we_win),
    money_logic: pick("money_logic", st.money_logic),
    reading: list("reading", st.reading),
    working: list("working", st.working),
    leaking: list("leaking", st.leaking),
    wont_do: list("wont_do", st.wont_do),
    milestones: {
      d30: pick("milestone_d30", st.milestones.d30),
      d60: pick("milestone_d60", st.milestones.d60),
      d90: pick("milestone_d90", st.milestones.d90),
    },
    risks: st.risks
      .map((r, i) => ({ risk: pick(`risk_${i}`, r.risk), response: pick(`risk_response_${i}`, r.response) }))
      .filter((r) => r.risk.trim() && r.response.trim()),
  };
}

export async function checkStrategy(
  fields: Record<string, string>,
  verifiedCosts: string,
  businessSummary: string,
  ctx: SafetyCtx = {},
): Promise<{ fields: Record<string, string>; flags: string[]; engine: Engine }> {
  const whole = Object.values(fields).join("\n");
  const { engine, verdicts } = await judge(
    "strategy_compliance",
    { document: whole, this_business: businessSummary, ...(optionAnswersText(ctx.answers) ? { what_they_answered: optionAnswersText(ctx.answers) } : {}), verified_tool_costs: verifiedCosts },
    {
      ungrounded_price:
        "The document states a specific price, fee, rate, grant amount or market figure. Is it NOT backed by the verified costs provided and NOT a number from the person's own money description? Answer true only if such a number is stated and comes from neither.",
      claims_they_said:
        "Does the document claim the person told us, said, picked or chose something — 'the leak you named', 'you told me', 'you mentioned' — that is NOT supported by the description of their money or by what they answered?",
      legal_certainty:
        "Does the document state a tax, legal or compliance conclusion as certain, without saying who can confirm it?",
      generic:
        "Could this document be handed unchanged to any person at all, because it engages with nothing specific about the money situation described?",
    },
    0.65,
    ctx,
  );

  const flags = Object.entries(verdicts).filter(([, v]) => v).map(([k]) => k);
  const out: Record<string, string> = { ...fields };

  if (verdicts.claims_they_said) {
    // Strip the false attribution, keep the substance: "As you said, two
    // offices pay monthly." -> "Two offices pay monthly." The old rule cut
    // from the phrase to the end of the sentence, which — once milestones
    // and risks were checked item by item — could blank the day-90 goal or
    // delete a whole risk (review of 4e685e5). A field is never emptied: if
    // stripping would leave nothing, the original stays.
    // One sentence at a time: a sentence the cuts left without an end
    // ("The goal matches what .") goes whole — and only a sentence the cuts
    // changed is ever tested (review, round 21: "Write down what you spend"
    // was being dropped from every field).
    const cut = (t: string): string =>
      t
        // "…, which matches what you told me." -> "…." first: the cuts below
        // would leave "…matches what ." (round 21 review).
        .replace(ATTRIBUTION_TAIL, "")
        // ", as you mentioned," / "As you said, " -> gone, with its commas.
        .replace(/,?\s*\b(as you (said|mentioned|told me)|like you said)\b\s*,?/gi, () => " ")
        // "the leak (which|that) you mentioned" -> "the leak"
        .replace(/\s+(which|that) you (named|mentioned|told me about)\b/gi, "")
        .replace(/\s+you (named|told me about)\b/gi, "")
        // "You told me (that) ..." / "You said (that) ..." / "you mentioned (that) ..."
        .replace(/\b(you (told me|said|mentioned)( that| about)?)\b\s*/gi, "")
        .replace(/\s+,/g, ",")
        .replace(/[ \t]{2,}/g, " ")
        // "the goal you mentioned." -> "the goal.", never "the goal ."
        .replace(/[ \t]+([.!?;:])/g, "$1");
    const DANGLING = /[ \t]*(?:[,;:—–-][ \t]*)?(?:that|this|which|it)?[ \t]*(?:matches|fits|is|lines up with|agrees with)[ \t]+what[ \t]*(?=[.!?]|$)/gim;
    const BROKEN = /\bwhat\s*[.!?]|\bwhat you (?:told me|said|mentioned|picked|chose|named)\b/i;
    for (const k of Object.keys(out)) {
      const field = out[k]!;
      const lines = field.split("\n").map((line) =>
        sentencesOf(line)
          .flatMap((part) => {
            const gap = part.match(/\s*$/)![0];
            const was = part.slice(0, part.length - gap.length);
            const now = capitalise(cut(was).trim());
            // Untouched by the cuts but still only an attribution ("This
            // matches what you chose."): it goes too.
            if (now === was) return BROKEN.test(was) ? [] : [part];
            return BROKEN.test(now) || !now ? [] : [now + gap];
          })
          .join("")
          .replace(/[ \t]+$/, ""),
      );
      // Every sentence was a claim: the cut text, with any dangling "matches
      // what" taken off — never the broken string, never the original claim.
      const tidied = lines.join("\n").trim() || cut(field).replace(DANGLING, "").trim();
      const fixedCase = tidied ? tidied[0]!.toUpperCase() + tidied.slice(1) : tidied;
      if (fixedCase) out[k] = fixedCase;
    }
  }
  if (verdicts.ungrounded_price && out.money_logic !== undefined) {
    out.money_logic += " Confirm any price in here at sign-up — prices move.";
  }
  if (verdicts.legal_certainty && out.money_logic !== undefined) {
    out.money_logic += " Anything touching tax or registration: confirm with the authority or an accountant before acting on it.";
  }

  // Priority 2: the strategy is exactly where the real incident's invented
  // price range and value proposition ended up ("...between R6,000 and
  // R15,000 coming in every month"). `ungrounded_price` above only catches a
  // number absent from the verified tool costs AND the business summary — a
  // figure the model itself already baked into that summary earlier in the
  // same build sails through untouched. This asks a narrower, more honest
  // question: is each claim actually traceable to the diagnostic, not just
  // consistent with something else the same pipeline already wrote.
  //
  // Live, 2026-09-22: this used to cover how_we_win and money_logic only.
  // With "not sure" given for both price and customers, both of those were
  // correctly hedged — and the SAME invented figure reached the person
  // unhedged through strategy.milestones.d90 ("…two nearby offices on
  // monthly accounts, paying you R1,500 - R3,000 each…"), because the
  // milestones were never handed to this function at all. Every field the
  // caller passes is now checked, and flattenStrategy() below passes all of
  // them, item by item.
  if (ctx.answers) {
    const labels: Record<string, string> = {};
    for (const k of Object.keys(out)) {
      const label = strategyFieldLabel(k);
      if (label) labels[k] = label;
    }
    const traced = await checkTraceability(
      Object.fromEntries(Object.keys(labels).map((k) => [k, out[k]!])),
      labels,
      { diagnostic_answers: ctx.answers, business_summary: businessSummary, ...(ctx.grounding ?? {}) },
      ctx,
    );
    for (const k of traced.flagged) {
      out[k] = traced.fields[k]!;
      if (!flags.includes(`invented_${k}`)) flags.push(`invented_${k}`);
    }
  }

  // Priority 2b, mechanical: the strategy is prose, and prose is exactly
  // where a proper noun drifts while a model paraphrases quickly.
  if (ctx.knownFacts) {
    for (const k of Object.keys(out)) {
      const fidelity = await checkNameFidelity(out[k]!, ctx.knownFacts, ctx);
      if (fidelity.flags.length) {
        out[k] = fidelity.message;
        if (!flags.includes("name_fidelity")) flags.push("name_fidelity");
      }
    }
  }

  if (engine !== "none") {
    await recordSafetyEvent({
      businessId: ctx.businessId,
      check: "strategy_compliance",
      engine,
      outcome: flags.length ? "flag" : "pass",
      flags,
      detail: flags.length ? whole.slice(0, 300) : "",
    });
  }
  return { fields: out, flags, engine };
}

// ── 7. Traceability — is this specific claim actually something the person said? ──
//
// Priority 2, 2026-09-22: given deliberately generic diagnostic answers
// ("I sell test services", no niche given anywhere), the build pipeline
// invented a specific customer segment ("Property managers or estate agents
// for rental inspections"), a specific price range ("R2,000 - R5,000
// monthly") and a specific value proposition — and asserted every one of
// them as settled fact, sent straight to the person's phone and, via MCP, to
// their own connected AI. `identity.unsure` had ALREADY been set to an
// honest flag ("The diagnostic answers were very brief...") by the same
// build — nothing downstream ever read it. See engine/build.ts's
// applyContextGuardrails for the gate that now reads it, unconditionally,
// and for why `context.customers` / `context.typical_price` specifically
// are no longer generated by a model at all (they are copied from the
// customer the OWNER already chose, never re-asked).
//
// This is the check for everything that still IS generated freely: is a
// specific claim — a customer type, a number, a channel, a benefit —
// genuinely traceable to what is known about this business, or does it
// introduce something new? Squarely a judgement call, so squarely Jev's:
// flag or soften, never silence, alongside every other check in this file.

export interface TraceabilityResult {
  fields: Record<string, string>;
  flagged: string[];
  engine: Engine;
}

/**
 * What an invented-but-plausible claim becomes: honest, and still useful.
 * Never a silent drop (a person still gets something to react to) and never
 * a silent assertion (they can see it is a guess, not a fact).
 */
export function hedgeUnknown(label: string, value?: string | null): string {
  const v = (value ?? "").trim();
  return v
    ? `${v} — you haven't confirmed this, so treat it as a starting guess.`
    : `You haven't told me ${label} yet — tell me and I'll fill this in.`;
}

/**
 * One judge() call covers however many fields are given, so checking a
 * whole context or strategy document costs the same single Jev call as
 * checking one field would — the same "the check is cheap, the harm is not"
 * trade every other check in this file makes.
 *
 * `grounding` is everything genuinely established about this business: the
 * diagnostic answers, the confirmed identity, the customer and angle the
 * OWNER chose. A fair restatement or combination of that material is never
 * flagged — only a claim that introduces something new. Deliberately timid,
 * like auditModules: only a positively confirmed "yes, this looks invented"
 * hedges anything, and a fail-open engine never manufactures a doubt of its
 * own on top of the writer's.
 */
export async function checkTraceability(
  fields: Record<string, string>,
  labels: Record<string, string>,
  grounding: unknown,
  ctx: SafetyCtx = {},
): Promise<TraceabilityResult> {
  const candidates = Object.entries(fields).filter(([k, v]) => labels[k] && v && v.trim());
  if (!candidates.length) return { fields, flagged: [], engine: "none" };

  const propositions: Props = {};
  for (const [k, v] of candidates) {
    propositions[k] =
      `GROUNDING is everything genuinely established about this person's money: their diagnostic answers, the read-back confirmed with them, and the goal and rule THEY chose. Read the value written for "${labels[k]}": "${v}". Does it introduce a specific fact — an income source, a debt, a number, a named product or benefit — that is NOT stated, directly implied, or a fair restatement/combination of something in GROUNDING? Answer true only if it looks invented or guessed from generic knowledge, rather than genuinely built from what is in GROUNDING.`;
  }

  const { engine, verdicts } = await judge("traceability", { grounding, values: Object.fromEntries(candidates) }, propositions, 0.65, ctx);

  const out = { ...fields };
  const flagged: string[] = [];
  if (engine !== "none") {
    for (const [k, v] of candidates) {
      if (verdicts[k] === true) {
        out[k] = hedgeUnknown(labels[k]!, v);
        flagged.push(k);
      }
    }
    await recordSafetyEvent({
      businessId: ctx.businessId,
      check: "traceability",
      engine,
      outcome: flagged.length ? "flag" : "pass",
      flags: flagged,
      detail: flagged.length ? flagged.map((k) => `${k}: "${fields[k]}"`).join("; ").slice(0, 300) : "",
    });
  }
  return { fields: out, flagged, engine };
}

// ── 8. Verbatim fact fidelity — mechanical, never judged, never a model call ──
//
// Priority 2b, 2026-09-22, root cause investigated and confirmed precisely,
// DISTINCT from Priority 2 above: a real reply read "...property managers in
// Woodwood search for tests in Woodstock..." — a wrong word for the
// business's own city, produced once, mid-sentence, in an otherwise fluent
// reply from the "help" role (reasoning explicitly off for speed).
// Confirmed NOT a data or prompt bug: businesses.context->>'location' was
// stored correctly as "Woodstock, Cape Town", with no corruption, and the
// prompt handed the model that exact string, verbatim, every single call.
// Confirmed the existing guardrail does not catch this class of error:
// Jev's reply_compliance ran on this EXACT reply (safety_events shows it
// firing a second before the message sent) and returned pass — Jev is
// active and working, it is simply not checking this specific thing, and it
// should not become the thing that checks it: a second model proof-reading a
// first model's prose is expensive and can itself drift on the same word.
//
// What Charles already knows exactly should be checked against the stored
// string directly, cheaply, mechanically — a plain lookup, never askJev,
// never askJSON. That is the whole fix, and it is deliberately the opposite
// shape of checkTraceability above: that one is a judgement (is this claim
// invented), this one is arithmetic on two strings (is this word the one we
// already have on file).

const STOPWORDS = new Set([
  "this", "that", "with", "from", "your", "have", "will", "they", "them",
  "what", "when", "where", "which", "there", "their", "about", "into",
  "over", "than", "then", "some", "more", "most", "much", "each", "every",
]);

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! : 1 + Math.min(prev[j]!, cur[j - 1]!, prev[j - 1]!);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Optimal-string-alignment distance: Levenshtein plus adjacent transposition
 * as ONE edit, so "Stduio" is one slip from "Studio", not two.
 */
function osa(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

const DERIVED_ENDINGS = ["s", "'s", "n", "ns", "an", "ans", "ian", "ians", "er", "ers", "ese"];
/** "nigerians" from "nigeria", "sowetans" from "soweto", "gautengers" from "gauteng". */
function isDerived(c: string, k: string): boolean {
  if (c.startsWith(k) && DERIVED_ENDINGS.includes(c.slice(k.length))) return true;
  const base = k.slice(0, -1);
  return /[aeiou]$/.test(k) && c.startsWith(base) && c.length > k.length && DERIVED_ENDINGS.includes(c.slice(base.length));
}

/**
 * A single reply word reads as a near-miss corruption of ONE distinctive,
 * single-word known term ("Woodwood" for "Woodstock"). The original rule is
 * kept for these — it is what caught the real incident — but only for a
 * known term of 6+ letters and a candidate of 5+: live on 2026-09-22 the
 * old 4-letter floor let "fresh" become "Free" and "start" become "State",
 * delivered to a person in Phuthaditjhaba, Free State. Ordinary short
 * English words are exactly the words most likely to sit two edits from
 * a short word in someone's address.
 */
function isDrift(candidate: string, known: string): boolean {
  const c = candidate.toLowerCase();
  const k = known.toLowerCase();
  if (c === k || c.length < 5 || k.length < 6) return false;
  // A word built on the name is not a misspelling of it: "Nigerians",
  // "Sowetans", "Woodstock's", "Gautengers". Only real endings count, so
  // "Sowetto" and "Nairobii" are still corrected.
  if (isDerived(c, k)) return false;
  if (Math.abs(c.length - k.length) > 3) return false;
  const maxLen = Math.max(c.length, k.length);
  const dist = levenshtein(c, k);
  if (dist === 0 || dist > Math.max(2, Math.round(maxLen * 0.4))) return false;
  const prefixLen = Math.min(3, c.length, k.length);
  return c.slice(0, prefixLen) === k.slice(0, prefixLen);
}

/**
 * One slipped word inside a multi-word known phrase ("Hair Stduio" for "Hair
 * Studio"). Much tighter than isDrift, because the other words already
 * anchor it: one edit (a transposition counts as one) on a word of 5+
 * letters, two only on 8+. A 4-letter word is never corrected inside a
 * phrase ("Cape Tonw" is left alone) — "new roof" must never become "New
 * Road", and "free stage" must never become "Free State".
 */
function isSlip(candidate: string, known: string): boolean {
  const c = candidate.toLowerCase();
  const k = known.toLowerCase();
  if (c === k || Math.min(c.length, k.length) < 5 || c[0] !== k[0]) return false;
  // A plural, possessive or other word built on the known one is grammar,
  // not a slip: "office worker" is not "Office workers".
  if (c.startsWith(k) || k.startsWith(c)) return false;
  const dist = osa(c, k);
  return dist === 1 || (dist === 2 && Math.min(c.length, k.length) >= 8);
}

const WORD_RE = /[A-Za-z][A-Za-z'’]*/g;
const normApos = (x: string) => x.replace(/’/g, "'");

/**
 * Each known fact as the units a reply can actually drift on. A fact is
 * split only at real separators (comma, semicolon, brackets, slash), never
 * between the words of a place or a name: "Phuthaditjhaba, Free State"
 * is the unit "Phuthaditjhaba" plus the unit "Free State" — NOT the words
 * "Free" and "State", each of which an ordinary English word can resemble.
 */
function knownUnits(knownFacts: Record<string, string | null | undefined>): { words: string[]; text: string; source: string }[] {
  const out: { words: string[]; text: string; source: string }[] = [];
  const seen = new Set<string>();
  for (const [source, value] of Object.entries(knownFacts)) {
    if (!value) continue;
    // Customer and angle labels ("Busy office workers", "Same-day service")
    // are descriptions in ordinary English, not names: their "near misses"
    // are plurals and verbs in perfectly good sentences. Enforcing them
    // rewrote grammar ("Every busy office worker" -> "Every Busy office
    // workers"). Only names and places are enforced.
    if (/^(goal|rule)_label_/.test(source)) continue;
    for (const part of normApos(value).split(/[,;()\/|]+/)) {
      const words = part.match(WORD_RE) ?? [];
      if (!words.length) continue;
      if (words.length === 1 && STOPWORDS.has(words[0]!.toLowerCase())) continue;
      // The replacement: for one word, that word; for a phrase, the phrase as
      // written ("KwaZulu-Natal") when it is only letters, spaces, hyphens and
      // apostrophes — never extra text like a postcode ("Soweto 1809").
      const asWritten = part.trim().replace(/\s+/g, " ");
      const text = words.length === 1 ? words[0]! : /^[A-Za-z' -]+$/.test(asWritten) ? asWritten : words.join(" ");
      const key = `${text.toLowerCase()}::${source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ words, text, source });
    }
  }
  return out;
}

/**
 * Runs on a reply right before it is sent. Mechanical only: no Jev, no model
 * call — a plain lookup where a lookup will do, which is the entire fix.
 * Finds a word (or a run of words) that reads as a near-miss of a fact
 * Charles already knows exactly, and puts the real spelling back.
 * `knownFacts` is deliberately small and specific — see businessKnownFacts —
 * never the free-text diagnostic answers, which are prose, not exact
 * strings to enforce.
 */
export async function checkNameFidelity(
  message: string,
  knownFacts: Record<string, string | null | undefined>,
  ctx: SafetyCtx = {},
): Promise<{ message: string; flags: string[] }> {
  const units = knownUnits(knownFacts);
  if (!units.length || !message?.trim()) return { message, flags: [] };

  // Matched on a copy with curly apostrophes straightened (same length, so
  // every span maps straight back): a verbatim "Thandi's" typed with a curly
  // apostrophe is not a slip.
  const plain = normApos(message);
  const found = [...plain.matchAll(WORD_RE)].map((m) => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }));
  const capital = (w: string) => /^[A-Z]/.test(w);
  // Mid-sentence: something precedes it on the same line, and it is not the end of a sentence.
  const midSentence = (at: number) => {
    const line = plain.slice(0, at).split("\n").pop()!.trimEnd();
    return line.length > 0 && !/[.!?:]$/.test(line);
  };
  // Replacements as character spans, so a correction never touches text the
  // check did not positively match.
  const spans: { start: number; end: number; from: string; to: string; source: string }[] = [];
  const taken = (a: number, b: number) => spans.some((x) => a < x.end && b > x.start);

  for (const u of units) {
    const n = u.words.length;
    for (let i = 0; i + n <= found.length; i++) {
      const run = found.slice(i, i + n);
      const start = run[0]!.start;
      const end = run[n - 1]!.end;
      if (taken(start, end)) continue;
      // The words must be adjacent in the reply (only spaces between them).
      if (n > 1 && !/^[A-Za-z'’]+( [A-Za-z'’]+)*$/.test(plain.slice(start, end))) continue;

      let hit = false;
      if (n === 1) {
        // A place or business name is written with a capital, mid-sentence.
        // An ordinary word near one ("welcome" ~ "Welkom", "worker" ~
        // "Worcester") is lower-case there, or opens a sentence.
        hit = capital(run[0]!.text) && midSentence(start) && isDrift(run[0]!.text, u.words[0]!);
      } else {
        // Capitalisation has to match the fact wherever the fact is
        // capitalised: "free stage" is ordinary words, "Free Stae" a slip.
        if (run.some((w, j) => capital(u.words[j]!) && !capital(w.text))) continue;
        const exact = run.filter((w, j) => w.text.toLowerCase() === u.words[j]!.toLowerCase()).length;
        const slips = run.filter((w, j) => isSlip(w.text, u.words[j]!)).length;
        // At least one word exactly right anchors it to THIS fact; every
        // other word must be a genuine slip of its counterpart.
        hit = exact >= 1 && slips >= 1 && exact + slips === n;
      }
      if (hit) spans.push({ start, end, from: message.slice(start, end), to: u.text, source: u.source });
    }
  }
  if (!spans.length) return { message, flags: [] };

  let fixed = message;
  for (const sp of [...spans].sort((a, b) => b.start - a.start)) fixed = fixed.slice(0, sp.start) + sp.to + fixed.slice(sp.end);

  const seenDetail = new Set<string>();
  const detail = spans
    .map((c) => `"${c.from}" -> "${c.to}" (${c.source})`)
    .filter((d) => (seenDetail.has(d) ? false : (seenDetail.add(d), true)));
  await recordSafetyEvent({
    businessId: ctx.businessId,
    check: "name_fidelity",
    engine: "none", // mechanical, on purpose — see the header comment above
    outcome: "flag",
    flags: ["name_fidelity"],
    detail: detail.join("; ").slice(0, 300),
  });

  return { message: fixed, flags: ["name_fidelity"] };
}

/**
 * The small set of exact strings this business's replies must never drift
 * on: the person's name and location, their confirmed identity, and the goal
 * and rule labels they actually picked. Loosely typed on purpose —
 * every field is optional and this only ever reads, so any object shaped
 * like a Business (or a slice of one) can be passed straight in.
 */
export function businessKnownFacts(biz: {
  context?: { name?: string | null; location?: string | null } | null;
  identity?: { name?: string | null } | null;
  goal?: { label?: string | null }[] | null;
  rule?: { label?: string | null }[] | null;
}): Record<string, string> {
  const facts: Record<string, string> = {};
  if (biz.context?.name) facts.business_name = biz.context.name;
  if (biz.context?.location) facts.location = biz.context.location;
  if (biz.identity?.name) facts.identity_name = biz.identity.name;
  for (const [i, c] of (biz.goal ?? []).entries()) if (c?.label) facts[`goal_label_${i}`] = c.label;
  for (const [i, a] of (biz.rule ?? []).entries()) if (a?.label) facts[`rule_label_${i}`] = a.label;
  return facts;
}

// ── 9. Tool-help grounding (PRIORITY 4.5) ───────────────────────
//
// checkReply (section 5) already asks whether a stated PRICE is backed by the
// verified tool-costs sheet — but that sheet only covers every candidate tool
// for the whole conversation, and only the price. A "help"/"stuck" reply
// (helpWithStep, which is ALSO the walkthrough's own "I'm stuck" handler —
// see steps.ts's dispatch of ACT.STEP_HELP and ACT.WALK_STUCK to the same
// function) makes plenty of other concrete claims about the ONE tool this
// step is actually about that checkReply's price check never looks at: a
// button or link's exact wording ("tap Manage now"), a timeframe
// ("verification takes up to 5 business days"), or a fee stated in words
// rather than a bare number. Every one of those is something Charles already
// has on file for that specific tool — tools.cost, tools.walkthrough,
// tools.url — so a "help" reply should never tell a person a fact about the
// tool that is not traceable to that stored data. This is a narrower,
// tool-scoped instance of the same invented-fact problem as Priority 2/2b,
// scoped specifically to tool-help replies as the founder's own follow-up
// asked for.
export interface ToolFacts {
  name?: string | null;
  cost?: string | null;
  url?: string | null;
  walkthrough?: string[] | null;
}

function toolFactsSheet(tool: ToolFacts | null): string {
  if (!tool) return "(no tool is linked to this step — nothing here to check a claim against)";
  return [
    tool.name ? `Name: ${tool.name}` : "",
    tool.cost ? `Cost: ${tool.cost}` : "",
    tool.url ? `Link: ${tool.url}` : "",
    tool.walkthrough?.length ? `Walkthrough:\n${tool.walkthrough.map((l, i) => `${i + 1}. ${l}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Runs on a "help"/"stuck" reply, alongside (never instead of) checkReply.
 * Deliberately narrow, like every other check in this file: it does not ask
 * whether the ADVICE is good, only whether a concrete, checkable fact the
 * reply states about the tool is one Charles can actually back with stored
 * data — a fee, a button/link's name, or a timeframe. When there is no tool
 * on this step at all, any such claim is by definition unbacked.
 */
export async function checkToolHelpGrounding(
  message: string,
  tool: ToolFacts | null,
  ctx: SafetyCtx = {},
): Promise<{ message: string; flags: string[]; engine: Engine }> {
  if (!message?.trim()) return { message, flags: [], engine: "none" };

  const { engine, verdicts } = await judge(
    "tool_help_grounding",
    { reply: message, tool_data: toolFactsSheet(tool) },
    {
      ungrounded_claim:
        "TOOL_DATA is everything genuinely known about the one tool/website this reply concerns. Read the reply. Does it state a concrete, checkable fact about that tool or site — a fee/price, a button or link's exact wording, or a timeframe/deadline — that is NOT present in, or a fair restatement of, TOOL_DATA? Answer true only if such a specific fee, button/link name, or timeframe is stated and it does not appear in TOOL_DATA (including when TOOL_DATA says no tool is linked at all).",
    },
    0.65,
    ctx,
  );

  const flags: string[] = [];
  let out = message;
  if (verdicts.ungrounded_claim) {
    flags.push("tool_help_ungrounded");
    out += "\n\n(Double-check that detail on the tool's own site before you rely on it — I want to be sure I've got it exactly right.)";
  }

  if (engine !== "none") {
    await recordSafetyEvent({
      businessId: ctx.businessId,
      check: "tool_help_grounding",
      engine,
      outcome: flags.length ? "flag" : "pass",
      flags,
      detail: flags.length ? message.slice(0, 300) : "",
    });
  }
  return { message: out, flags, engine };
}

/** Which engine would run right now. Surfaced on /api/health. */
export const activeEngine = (): Engine => (jevLive() ? "jev" : modelLive() ? "model" : "none");
