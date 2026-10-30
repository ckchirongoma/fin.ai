// Fin — money figures, grounded mechanically.
//
// Bug 2, live 2026-09-22/23, three times on the deployed fix: a person who
// answered "not sure" (or "1") to "what does a typical customer pay you?"
// was shown "They pay: R800 - R2000 per month" in the customer options, and
// later "that's R2,400 a month ... R6,000" in strategy.money_logic — both as
// plain fact. checkTraceability DID run over money_logic, and hedged a
// different field instead: it is a judgement, and a judgement can miss. A
// rand figure is not a matter of judgement. Either the person said it (or a
// verified tool cost says it), or Fin made it up.
//
// So this is arithmetic, not a model call: pull every money figure out of a
// generated string, and compare it with the figures the person actually gave
// and the verified costs in the library sheet. Anything else is a guess and
// is labelled as one, on every surface that shows it to a person — before
// the plan exists (customer and angle options, the read-back) and after
// (goal, strategy). Plan steps already have their own ungrounded_price
// check, which the live test confirmed works; this does not replace it.

// Every way a model (or a person) writes money in the five markets. The
// alternation order matters: longer spellings before their prefixes.
// Uganda: "UGX 50,000" (URA, MTN and Airtel receipts), "USh"/"UShs", and the
// press's "Shs 50,000" (which Kenyan writing uses too: grounding needs the
// number, never which shilling).
import { withoutPhones } from "./phones.js";

const CUR = "(?:ZAR|KShs?\\.?|KSH|KES\\.?|Kshs?\\.?|NGN|GH[S₵¢C]|GHc|Ghc|(?:UGX|Ugx|ugx)\\.?|UShs?\\.?|Ushs?\\.?|Shs?\\.?|US\\$|USD|R|N|₦|₵|\\$)";
const NUM = "(\\d{1,3}(?:[,\\s]\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)";
/** "k", "m", "million", "bn": a scale, so "R20 million" is twenty million, not twenty. */
const K = "(\\s?(?:[kK]|[mM]|bn|million|billion)\\b)?";
const WORD_CUR = "(?:rands?|cedis?|naira|shillings?|bob)";
/** "R800", "R1,500", "KSh 10 000", "R2k", and the far end of "R800 - R2000" / "R800-2,000" / "R800 to 2000". */
// The far end never starts "0" plus a digit: in "send UGX 50,000 to 0772 123
// 456" that is the MoMo line, not the top of a range.
const MONEY_RE = new RegExp(`(?<![A-Za-z])${CUR}\\s?${NUM}${K}(?:\\s?(?:-|–|to)\\s?(${CUR})?\\s?(?!0\\d)${NUM}${K})?`, "g");
/** "800 rand", "50 cedis", "5,000 naira". */
const WORD_MONEY_RE = new RegExp(`(?<![\\d.,])${NUM}${K}\\s?${WORD_CUR}\\b`, "gi");
/**
 * "rand 800", "cedis 150", "naira 5,000" — the other order. Live test,
 * 2026-09-23: only number-then-word was matched, so a figure written the
 * other way round went out with no hedge at all.
 */
const WORD_FIRST_MONEY_RE = new RegExp(`\\b${WORD_CUR}\\s?${NUM}${K}`, "gi");
const PLAIN_NUM_RE = new RegExp(`${NUM}${K}`, "g");
/** "50,000/=" and "50,000/-": how East Africa writes a whole shilling amount, with no currency word at all. */
const SUFFIX_MONEY_RE = new RegExp(`(?<![\\d.,])${NUM}${K}\\s?\\/[=-]`, "g");
/**
 * "55,000 UGX", "5000 ugx", "5,000 Shs": a currency code after the number, the
 * other common WhatsApp order (review, round 23: only the word forms were
 * read this way). Kept apart from WORD_CUR so "sh 5" chatter in the
 * word-first pattern never becomes money.
 */
const CODE_AFTER_MONEY_RE = new RegExp(`(?<![\\d.,])${NUM}${K}\\s?(?:UGX|UShs?|Ushs?|Shs?|KES|KShs?|Kshs?|GHS|NGN|ZAR)\\b`, "gi");

const value = (digits: string | undefined, k: string | undefined): number | null => {
  if (!digits) return null;
  const n = Number(digits.replace(/[,\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  const scale = (k ?? "").trim().toLowerCase();
  if (!scale) return n;
  if (scale === "k") return n * 1000;
  if (scale === "m" || scale === "million") return n * 1e6;
  return n * 1e9;
};

/** Every money amount in a string, as numbers (a range gives both ends). */
export function moneyIn(text: string): number[] {
  const t = text || "";
  const out: number[] = [];
  const spans: [number, number][] = [];
  for (const m of t.matchAll(MONEY_RE)) {
    spans.push([m.index!, m.index! + m[0].length]);
    const a = value(m[1], m[2]);
    const b = value(m[4], m[5]);
    if (a !== null) out.push(a);
    // A head count after "to" ("UGX 5,000 to 10 customers") is not the top of
    // a range: a far end with no currency of its own counts only when it is
    // at least a tenth of the near end. A price cut ("R500 to R450", "UGX
    // 2,000 to 1,500") still counts both.
    if (b !== null && (m[3] || a === null || b * 10 >= a)) out.push(b);
  }
  for (const re of [WORD_MONEY_RE, WORD_FIRST_MONEY_RE, CODE_AFTER_MONEY_RE]) {
    for (const m of t.matchAll(re)) {
      if (spans.some(([s, e]) => m.index! >= s && m.index! < e)) continue;
      spans.push([m.index!, m.index! + m[0].length]);
      const a = value(m[1], m[2]);
      if (a !== null) out.push(a);
    }
  }
  // "Shs 50,000/=" was already read by its prefix: the suffix only adds a
  // figure no other pattern read.
  for (const m of t.matchAll(SUFFIX_MONEY_RE)) {
    if (spans.some(([s, e]) => m.index! >= s && m.index! < e)) continue;
    const a = value(m[1], m[2]);
    if (a !== null) out.push(a);
  }
  return out;
}

/**
 * The amounts a person actually gave, anywhere in their answers — with or
 * without a currency sign ("about 350 to 900" counts). Single digits don't:
 * "1" typed at the price question is a menu reflex, not a price.
 */
export function figuresFrom(...texts: unknown[]): Set<number> {
  const set = new Set<number>();
  for (const t of texts) {
    const s = typeof t === "string" ? t : t == null ? "" : JSON.stringify(t);
    // A phone number is never one of their figures (round 23, UG: "my number
    // is 0799 … and I charge UGX 45,000" gave [799…, 45000], and a number
    // alone counted as "owner gave a price").
    for (const m of withoutPhones(s).matchAll(PLAIN_NUM_RE)) {
      const v = value(m[1], m[2]);
      if (v !== null && v >= 10) set.add(v);
    }
  }
  return set;
}

/**
 * What counts as grounded. Three sources, and they are not equal:
 *
 * - `owner`: the figures in what the person said their PRICE is (the
 *   diagnostic's `price` answer, or the one message being answered). Honest
 *   arithmetic on these is allowed, below.
 * - `library`: money amounts written as money anywhere else the person spoke,
 *   and the verified amounts in the library sheets the call was given —
 *   EXACTLY, never multiplied. "About 100 households" or a postcode is not a
 *   price, and letting its multiples through grounded "R800 - R2000 per
 *   month" (100 × 8, 100 × 20) — the very string Bug 2 was about.
 *
 * `owner` may be the diagnostic answers object, or a plain string (a message).
 */
export interface Grounding {
  owner: Set<number>;
  library: Set<number>;
}

export function groundingFrom(owner: unknown, libraryTexts: string[] = []): Grounding {
  const answers = owner && typeof owner === "object" && !Array.isArray(owner) ? (owner as Record<string, unknown>) : null;
  const priceText = answers ? [answers.income, answers.owes, answers.cushion].filter(Boolean).join(" | ") : owner;
  const rest = answers ? Object.entries(answers).filter(([k]) => !["income", "owes", "cushion"].includes(k)).map(([, v]) => (typeof v === "string" ? v : JSON.stringify(v ?? ""))) : [];
  return {
    owner: figuresFrom(priceText),
    library: new Set([...rest, ...libraryTexts].flatMap((t) => moneyIn(t))),
  };
}

/** Did the person give any real money figure at all? (Decides which label a guess gets.) */
export const ownerGavePrice = (g: Grounding): boolean => g.owner.size > 0;

const asGrounding = (g: Set<number> | Grounding): Grounding => (g instanceof Set ? { owner: g, library: new Set() } : g);

/**
 * Honest arithmetic on a given figure is not an invention: R350 a visit is
 * R1,400 for four visits, or R18,200 over a year of weekly visits. A figure
 * counts as grounded if it is a given one, or a given one times a few
 * visits (2-4), or times 12 / 52 (a month of weeks is the 4 already).
 *
 * Live test, round 11 (2026-09-27): the multipliers used to run 2-10, 20
 * and 30. With three owner prices (KSh 500, 1,500, 3,000) that made almost
 * any round figure "arithmetic" — 5,000 is 500 x 10, 30,000 is 1,500 x 20 —
 * so "Monthly value: KSh 5000 to 30000" went out as fact, unhedged. A wide
 * net of multipliers is a net that catches guesses.
 */
const HONEST_MULTIPLES = [2, 3, 4, 12, 52];
function grounded(v: number, given: Set<number>): boolean {
  for (const g of given) {
    if (Math.abs(v - g) < 0.5) return true;
    for (const k of HONEST_MULTIPLES) if (Math.abs(v - g * k) < 0.5) return true;
  }
  return false;
}

/** Money figures in `text` that nothing the person said (or the library verified) backs. */
export function ungroundedMoney(text: string, given: Set<number> | Grounding): number[] {
  const g = asGrounding(given);
  return moneyIn(text).filter((v) => !grounded(v, g.owner) && !g.library.has(v));
}

export const GUESS_TAG = "(a guess — you haven't told me your figures yet)";
/** When they DID give a price, and this figure isn't it (or honest arithmetic on it). */
export const ESTIMATE_TAG = "(my estimate — not a figure you gave me)";
export const GUESS_SUFFIX = "— you haven't confirmed this, so treat it as a starting guess.";
const alreadyHedged = (t: string) =>
  t.includes(GUESS_TAG) || t.includes(ESTIMATE_TAG) || t.includes(GUESS_SUFFIX) || /haven't confirmed this|confirm any price|at sign-up/i.test(t);

/** An inline field (an option's "They pay"): a short tag right after it. */
export function tagIfGuess(text: string, given: Set<number> | Grounding): { text: string; hedged: boolean } {
  if (!text || alreadyHedged(text) || !ungroundedMoney(text, given).length) return { text, hedged: false };
  const tag = ownerGavePrice(asGrounding(given)) ? ESTIMATE_TAG : GUESS_TAG;
  return { text: `${text.trim()} ${tag}`, hedged: true };
}

/**
 * A sentence or paragraph (strategy, goal): the same suffix the traceability
 * check uses, attached to the last sentence rather than after its full stop
 * ("…R6,000 — you haven't confirmed this…", never "…R6,000. — you…").
 */
export function hedgeIfGuess(text: string, given: Set<number> | Grounding): { text: string; hedged: boolean } {
  if (!text || alreadyHedged(text) || !ungroundedMoney(text, given).length) return { text, hedged: false };
  return { text: `${text.trim().replace(/[.!]+$/, "")} ${GUESS_SUFFIX}`, hedged: true };
}

// ── Rates, and the line that says to confirm a price ─────────────

/** Every percentage in a text, as numbers. */
export const percentsIn = (t: string): number[] => (t.match(/\d+(?:\.\d+)?\s?%/g) ?? []).map((x) => parseFloat(x));
/** Rate words: a percentage within a few words of one of these is a price. */
const RATE_NEAR =
  /\b(?:fee|fees|charge[sd]?|interest|duty|vat|tax|levy|commission|rate|takes?|costs?|pays?|per (?:[\w-]+ ){0,2}(?:payment|sale|transaction|swipe|withdrawal|deposit|month|year)|on (?:each |every )?(?:m-?pesa|momo|mobile money|airtel money|cards?|local|international|pos)|of (?:each|every) (?:payment|sale)|a (?:month|year)|monthly|annually|deduct(?:ed|s)?|markup|discount)\b/i;
/** Percentages that are rates: next to a rate word in their own sentence, and never 100% ("you can do it 100% online"). */
export function ratesIn(t: string): number[] {
  const out: number[] = [];
  for (const m of t.matchAll(/\d+(?:\.\d+)?\s?%/g)) {
    const v = parseFloat(m[0]);
    if (v >= 100) continue;
    const at = m.index ?? 0;
    const from = Math.max(0, at - 40, ...[...t.slice(0, at).matchAll(/[.!?]\s/g)].map((x) => (x.index ?? 0) + 1));
    const tail = t.slice(at + m[0].length, at + m[0].length + 40);
    const end = tail.search(/[.!?](?:\s|$)/);
    if (RATE_NEAR.test(t.slice(from, at + m[0].length + (end === -1 ? tail.length : end)))) out.push(v);
  }
  return out;
}

/**
 * A sentence that tells the person to confirm a PRICE — the guardrail's own
 * lines, pricestamp's, or the model's — not "have your ID ready at sign-up".
 * One test for safety.ts and pricestamp.ts, so they cannot drift apart
 * (review, round 21: a bare "at sign-up" about documents let an invented
 * price through unhedged, and kept a real fee's date off).
 */
export const PRICE_HEDGE =
  /(?:confirm|check)\b[^.!?\n]{0,30}\b(?:price|fee|amount|figure|rate|cost)s?\b[^.!?\n]{0,25}(?:at sign-up|on the (?:portal|site)|with the provider|before you (?:pay|rely))|(?:confirm|check) (?:it|that)\s+(?:at sign-up|on the (?:portal|site)|with the provider|before you (?:pay|rely))|\b(?:price|fee|cost|amount|figure|rate)s?\b[^.!?\n]{0,60}(?:may have changed|differ\b|confirm at sign-up)|confirm the (?:exact )?amount/i;

// ── Sentences ────────────────────────────────────────────────────

/**
 * One line cut into sentences, each keeping the whitespace after it, so the
 * line rejoins byte for byte. Cut where terminal punctuation is followed by
 * whitespace and then anything but a lowercase word — so a digit ("3 columns
 * are enough") and a camel-cased name ("eCitizen", "iKhokha", "iTax") start a
 * sentence — but never after "e.g.", "Mr." and the like, never inside "Shop
 * No. 4", and never inside "R1.50" or a link. Review, round 21: a stricter
 * rule glued the advice after a claim to the claim, and both were dropped.
 */
export const sentencesOf = (line: string): string[] =>
  line.split(/(?<=(?<!\b(?:e\.g|i\.e|etc|Mr|Mrs|Ms|Dr|St|Rd|Ave|vs|approx|Pty|Ltd|Co))[.!?]["'”’)\]]*[ \t]+)(?!(?<=\b(?:No|Nr)\.[ \t]+)\d)(?=[^\sa-z]|[a-z]+[A-Z])/);

/** Every sentence of a text, trimmed, across its lines. */
export const allSentences = (text: string): string[] => text.split("\n").flatMap((line) => sentencesOf(line)).map((x) => x.trim()).filter(Boolean);
