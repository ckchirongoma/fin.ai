// Charles — retrieval, pass one: no model call at all.
//
// CLAUDE.md calls the `keywords` column "the whole retrieval strategy": score
// every knowledge entry and tool in plain code, hand the model only the few
// rows that scored, and tell it those rows are the only facts it may use. The
// first backend port defined this function and then never called it — every
// prompt carried the entire country's corpus, which is both expensive and a
// worse grounding signal, because a model given fifty rows will find something
// to say about the wrong one.
//
// Pass two (embeddings.ts) ranks by meaning, and runs ONLY when this pass found
// nothing at all. The trigger for building it was a logged gap that recurs — a
// real question that should have matched and didn't — so every empty shortlist
// still writes a row to `retrieval_gaps`, now marked `rescued` when meaning
// found what keywords missed. That flag is the to-do list for better keywords.

import { recordRetrievalGap } from "./db.js";
import { moneyIn } from "./grounding.js";
import { semanticRank } from "./embeddings.js";
import { isFreeType, startsFree, withFreeType } from "./freetype.js";
import { trackUnmet } from "./track.js";
import type { KnowledgeRow, ToolRow } from "./types.js";

export interface Shortlist {
  knowledge: KnowledgeRow[];
  tools: ToolRow[];
  /** True when these rows came from the meaning-based second pass, not from keywords. */
  semantic?: boolean;
  /**
   * The best KEYWORD score seen — deliberately not the best overall score.
   *
   * Ordering uses the full score, which includes small bonuses for matching the
   * business's stage and for being free. Relevance must not: a row that matched
   * none of the person's words still picks up those bonuses, so using the total
   * here would report a confident match for a question the library has nothing
   * to say about. That would both hide the gap from `retrieval_gaps` and tell
   * the person's own AI it had grounding it does not have.
   */
  topScore: number;
}

interface Scorable {
  keywords: string[] | null;
  domain: string | null;
  stages: string[] | null;
  cost: string;
  /** Tools only (db/0014). When set it replaces the cost-text guess below. */
  free_type?: string | null;
}

export interface ShortlistQuery {
  /** The person's words: their message, or the step brief being tailored. */
  text: string;
  stage: string;
  /** Which of the 8 areas this is about, when we already know. */
  domain?: string | null;
  /** The headache they named at onboarding. A lasting hint, not just this message. */
  headache?: string | null;
  /**
   * Amounts the person is asking about (not stating as theirs): a row whose
   * cost carries one scores as if they had named it (figureHits). Only the
   * answer path passes these (engine/context.ts); shortlist() keeps only
   * amounts a few rows carry, since a common figure says nothing.
   */
  figures?: number[];
  /** Ids that MUST appear, whatever they score — a step naming its own knowledge entry. */
  pinKnowledge?: string[];
  pinTools?: string[];
  maxKnowledge?: number;
  maxTools?: number;
}

/**
 * Words that carry no signal on their own. Without this list, a keyword like
 * "how much tax" would match any sentence containing "how".
 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "at", "by", "is", "it", "my", "me",
  "you", "your", "i", "do", "does", "how", "what", "when", "where", "who", "why", "can", "should",
  "will", "be", "am", "are", "was", "with", "from", "that", "this", "get", "got", "have", "has",
]);

const significantTokens = (phrase: string): string[] =>
  phrase
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

/**
 * The same word written two ways, made one: a hyphen inside a word goes
 * ("M-Pesa" is "mpesa", "e-Citizen" is "ecitizen"), and so does the space
 * in "m pesa". Applied to the person's words and to every keyword alike.
 * Round 22, live: "what does an M-Pesa till cost me per payment?" matched
 * nothing of mpesa_till ("mpesa till", "lipa na mpesa"), so the answer said
 * there were no verified figures while the library had the till's rate.
 */
export const foldWords = (t: string): string =>
  t
    .toLowerCase()
    .replace(/([a-z])-(?=[a-z])/g, "$1")
    .replace(/\bm\s+pesa\b/g, "mpesa");

/**
 * Amounts asked about that a row's own cost names. Round 22, live: "is it
 * still KSh 950?" matched no keyword at all, so the registration row was not
 * in front of the model and its answer could not be dated from it. A fee is
 * as specific as a keyword: KSh 950 is the eCitizen business-name fee.
 * Only the amounts the caller passes (ShortlistQuery.figures): a fee the
 * owner asks about, never their own price ("I charge GH₵300…" pulled a
 * procurement portal to the top — review, round 22).
 */
function figureHits(item: Scorable, figures: number[] | undefined): number {
  if (!figures?.length) return 0;
  const has = new Set(moneyIn(item.cost ?? ""));
  return figures.some((n) => has.has(n)) ? 3 : 0;
}

/** Whole-word presence, so "vat" does not match "private". */
const hasWord = (text: string, word: string): boolean =>
  new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(text);

/**
 * How well this row's own keywords match what the person actually said. This is
 * the relevance signal on its own, so that "did the library have anything to
 * say about this?" can be answered honestly.
 *
 * Three tiers, because 57% of the library's keywords are multi-word phrases and
 * a person almost never types one verbatim. Matching only the whole phrase left
 * real questions unmatched — "at what point must I register for VAT?" scored
 * zero against a row keyed on "when register for vat", "vat threshold" and
 * "vat ghana", which is exactly the entry it needed. Whole-phrase still scores
 * highest; a phrase whose meaningful words all appear scores close behind; a
 * partial overlap counts for a little.
 */
/** One keyword against one form of the text: 3 (they said it), 2 (all its words), 1 (most), 0. */
function tierScore(k: string, text: string): number {
  if (!k) return 0;
  // Tier 1: they said it. A multi-word phrase is specific enough to match as
  // a substring; a single word is not — "vat" appears inside "private", and
  // "pos" inside "possible".
  const isPhrase = k.includes(" ");
  if (isPhrase ? text.includes(k) : hasWord(text, k)) return 3;
  const tokens = significantTokens(k);
  if (!tokens.length) return 0;
  const present = tokens.filter((t) => hasWord(text, t)).length;
  // Tier 2: every meaningful word of the phrase is in there somewhere.
  if (present === tokens.length) return tokens.length === 1 ? 3 : 2;
  // Tier 3: most of it is.
  if (present >= 2 && present / tokens.length >= 0.6) return 1;
  return 0;
}

export function keywordScore(item: Scorable, q: ShortlistQuery): number {
  // Two readings of the person's words, each keyword scored against both and
  // the better kept: folded ("M-Pesa" is "mpesa"), and as typed, where a
  // hyphen is a word break ("cash-flow" still matches "cash flow"; review,
  // round 22).
  const raw = (q.text || "").toLowerCase();
  const folded = foldWords(raw);
  const headache = (q.headache || "").toLowerCase();
  const headacheFolded = foldWords(headache);
  let s = figureHits(item, q.figures);

  const spaced = raw.replace(/-/g, " ");
  for (const kw of item.keywords ?? []) {
    const k = String(kw).toLowerCase().trim();
    if (!k) continue;
    // A hyphenated keyword is one thing: matched folded ("noshow"), or whole
    // with its hyphen read as a space — never by its pieces, or "no-show"
    // would match any "show me how" (review, round 22).
    s += k.includes("-")
      ? Math.max(tierScore(foldWords(k), folded), spaced.includes(k.replace(/-/g, " ")) ? 3 : 0)
      : Math.max(tierScore(foldWords(k), folded), tierScore(k, raw));
  }

  // The headache they named at onboarding is a standing hint, worth less than
  // what they just said but worth something on every question they ask.
  if (headache) {
    for (const kw of item.keywords ?? []) {
      const k = String(kw).toLowerCase().trim();
      if (k && (headache.includes(k) || headacheFolded.includes(foldWords(k)))) s += 1;
    }
  }

  return s;
}

/**
 * Ported from the prototype's shortlist(), same weights: a keyword hit is worth
 * far more than a category match, and a free option breaks a tie upward
 * (principle 3 — free and reversible first, all the way down to ordering).
 *
 * "Free" used to mean "the cost text starts with the word free", which could
 * not tell a genuinely free tool from one that is free until you use it. A
 * tool with a `free_type` is judged by that instead; only a row without one
 * (every knowledge entry, and any tool not yet backfilled) falls back to the
 * text.
 */
export function scoreRow(item: Scorable, q: ShortlistQuery): number {
  let s = keywordScore(item, q);
  if (q.domain && item.domain === q.domain) s += 2;
  if ((item.stages ?? []).includes(q.stage || "run")) s += 1;
  const free = isFreeType(item.free_type) ? startsFree(item.free_type) : /^free/i.test(item.cost ?? "");
  if (free) s += 1;
  return s;
}

function pick<T extends Scorable & { id: string }>(rows: T[], q: ShortlistQuery, limit: number, pins: string[]): { picked: T[]; top: number } {
  const scored = rows
    .map((r) => ({ r, s: scoreRow(r, q), k: keywordScore(r, q) }))
    .sort((a, b) => b.s - a.s || a.r.id.localeCompare(b.r.id));
  const top = scored.reduce((best, x) => Math.max(best, x.k), 0);

  // Pinned rows go first and do not consume a "best scoring" slot unfairly:
  // a step that names k.deposits gets k.deposits, full stop.
  const pinned = pins.map((id) => rows.find((r) => r.id === id)).filter((x): x is T => Boolean(x));
  const rest = scored.map((x) => x.r).filter((r) => !pinned.some((p) => p.id === r.id));
  return { picked: [...pinned, ...rest].slice(0, limit), top };
}

export async function shortlist(
  knowledge: KnowledgeRow[],
  tools: ToolRow[],
  q: ShortlistQuery,
  ctx?: {
    businessId?: string | null;
    country: string;
    log?: boolean;
    source?: "whatsapp" | "mcp";
    /**
     * The asker's OWN words, if a miss here should also become a knowledge
     * signal. Never the full query: that can carry router terms and
     * forwarded third-party text. Omitted or null: the gap is still logged,
     * no signal is written.
     */
    quote?: string | null;
    /**
     * False: keywords only. No semantic rescue and no retrieval gap logged.
     * Used for a question about the person's OWN plan or progress ("How am I
     * doing?"), which the library does not answer: missing a match there is
     * not a gap, and the embedding call it would set off buys nothing.
     */
    semantic?: boolean;
  },
): Promise<Shortlist> {
  // A figure is as specific as a keyword only while few rows carry it.
  if (q.figures?.length) {
    const carriers = (n: number) => [...knowledge, ...tools].filter((r) => moneyIn(r.cost ?? "").includes(n)).length;
    q = { ...q, figures: q.figures.filter((n) => n >= 10 && carriers(n) <= 3) };
  }
  const k = pick(knowledge, q, q.maxKnowledge ?? 4, q.pinKnowledge ?? []);
  const t = pick(tools, q, q.maxTools ?? 5, q.pinTools ?? []);
  const topScore = Math.max(k.top, t.top);

  // Nothing matched on keywords at all: the person asked in words the library
  // never anticipated. Try meaning before giving up.
  if (topScore === 0 && ctx?.semantic !== false && (q.text || "").trim().length > 8) {
    const hits = await semanticRank(q.text, ctx?.country ?? "ZA");
    const byId = <T extends { id: string }>(rows: T[], ids: { id: string }[], limit: number): T[] =>
      ids.map((h) => rows.find((r) => r.id === h.id)).filter((r): r is T => Boolean(r)).slice(0, limit);
    const rescuedK = hits ? byId(knowledge, hits.knowledge, q.maxKnowledge ?? 4) : [];
    const rescuedT = hits ? byId(tools, hits.tools, q.maxTools ?? 5) : [];
    const rescued = rescuedK.length > 0 || rescuedT.length > 0;

    if (ctx?.log !== false) {
      await recordRetrievalGap({
        businessId: ctx?.businessId ?? null,
        country: ctx?.country ?? "ZA",
        query: q.text,
        domain: q.domain ?? null,
        topScore,
        rescued,
        source: ctx?.source,
        quote: ctx?.quote ?? null,
      });
      // Keywords and meaning both found nothing: whatever the person asked,
      // the library has no answer to it. Their words come from the turn. A
      // rescued gap is not a dead end (the answer had rows to stand on); it
      // stays in retrieval_gaps as the to-do list for better keywords.
      if (!rescued) {
        trackUnmet("knowledge_gap", {
          props: {
            reason: "no_match",
            // A label, or "other": the connector passes whatever domain the person's AI sent.
            domain: q.domain ? (/^[a-z_]{1,32}$/.test(q.domain) ? q.domain : "other") : null,
            semantic: hits ? "searched" : "unavailable",
            source: ctx?.source ?? null,
            own_words: Boolean(ctx?.quote),
          },
          fingerprint: "knowledge_gap:no_match",
          summary: ctx?.source === "mcp" ? "A person's AI asked the library something it has nothing on" : "A person asked something the library has nothing on",
        });
      }
    }
    if (rescued) {
      // Pinned rows (a step naming its own knowledge entry) still lead.
      const pinnedK = k.picked.filter((r) => (q.pinKnowledge ?? []).includes(r.id));
      const pinnedT = t.picked.filter((r) => (q.pinTools ?? []).includes(r.id));
      const dedupe = <T extends { id: string }>(rows: T[]): T[] => rows.filter((r, i) => rows.findIndex((x) => x.id === r.id) === i);
      return {
        knowledge: dedupe([...pinnedK, ...rescuedK]).slice(0, q.maxKnowledge ?? 4),
        tools: dedupe([...pinnedT, ...rescuedT]).slice(0, q.maxTools ?? 5),
        topScore,
        semantic: true,
      };
    }
  }

  return { knowledge: k.picked, tools: t.picked, topScore };
}

// ── Freshness: rule 10, enforced in code rather than remembered in a prompt ──

const FRESH_DAYS = 90;

export function staleDays(verifiedOn: string | null | undefined): number {
  if (!verifiedOn) return Number.POSITIVE_INFINITY;
  const t = new Date(verifiedOn).getTime();
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - t) / 864e5);
}

export const isStale = (verifiedOn: string | null | undefined): boolean => staleDays(verifiedOn) > FRESH_DAYS;

/**
 * Every cost the model is allowed to see carries its own hedge. The model is
 * also told never to invent one, but this makes the hedge structural: even a
 * model that ignores the instruction can only copy a string that already says
 * "confirm at sign-up".
 *
 * A tool's `free_type` leads the line ("No monthly fee, but you pay when you
 * use it — …"), so the one word a person remembers is the right one.
 */
export function costLine(cost: string, verifiedOn: string | null | undefined, freeType?: string | null): string {
  const line = withFreeType(cost, freeType);
  if (!isStale(verifiedOn)) return line;
  const d = staleDays(verifiedOn);
  const age = Number.isFinite(d) ? `${d} days ago` : "we do not know when";
  return `${line} — last checked ${age}, so tell them to confirm the price at sign-up`;
}

/** What a tool row says about an unregistered owner, and the first thing to do — only when the row actually says it. */
function toolExtras(t: ToolRow): string {
  const out: string[] = [];
  if (t.informal_business_supported === true) out.push("works without a payslip or formal job: yes");
  else if (t.informal_business_supported === false) out.push("works without a payslip or formal job: no, needs a payslip or formal income");
  if (t.ten_minute_action) out.push(`first ten minutes: ${t.ten_minute_action}`);
  return out.length ? ` | ${out.join(" | ")}` : "";
}

// ── The sheets handed to the model ───────────────────────────────

export function kSheet(rows: KnowledgeRow[]): string {
  if (!rows.length) return "(nothing in the library matched this question)";
  return rows
    .map(
      (k) =>
        `${k.id} | ${k.title} | applies when: ${k.applies_when} | not when: ${k.not_when} | summary: ${k.owner_summary} | steps: ${(k.steps || []).join("; ")} | cost: ${costLine(k.cost, k.verified_on)}`,
    )
    .join("\n");
}

export function tSheet(rows: ToolRow[]): string {
  if (!rows.length) return "(no tool in the library fits this — say so rather than naming one)";
  return rows
    .map(
      (t) =>
        `${t.id} | ${t.name} | fits: ${t.fits} | not when: ${t.not_when} | why: ${t.why} | cost: ${costLine(t.cost, t.verified_on, t.free_type)} | url: ${t.url} | setup: ${t.setup}${toolExtras(t)}`,
    )
    .join("\n");
}
