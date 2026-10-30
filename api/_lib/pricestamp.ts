// Charles — every library figure in an answer says when it was checked.
//
// CLAUDE.md rule 10: every cost comes from knowledge_entries or tools,
// carries a verified_on date, and anything past 90 days is hedged to "confirm
// at sign-up". The sheets the model reads only carried the date once a row
// was stale (retrieval.ts costLine), so a fresh fee went out bare. Round 21
// (live): ZA's R175/R125, KE's KSh 950 and GH's GH₵130 all reached people
// with neither a date nor a confirm line.
//
// So it is done in code, after the answer is written: a figure in the reply
// that a SHORTLISTED row carries gets that row's date. Nothing else is
// touched — a reply with no figure is byte-identical, a figure no row carries
// (the person's own income, or one checkReply already hedged) is left to
// checkReply, and a placeholder ("₦[amount]") is not a figure. A row that
// itself says its figure is not settled ("published figures differ…
// confirm on the portal") never earns a bare date (review, round 21).
//
// Rates are dated too ("1.5% on M-Pesa", "2.3% per card payment") — the
// commonest fee answers are rates. The person's own figures (their price, what
// they just wrote, their answers) are never dated as ours.

import { allSentences, figuresFrom, moneyIn, percentsIn, PRICE_HEDGE } from "./grounding.js";
import { isStale, staleDays } from "./retrieval.js";
import type { Business, KnowledgeRow, ToolRow } from "./types.js";

export interface PricedRow {
  id: string;
  verified_on: string | null;
  /** Money figures the row carries… */
  figures: number[];
  /** …and the ones its own words say are not settled ("published figures differ"). */
  disputed: number[];
  /** …and the ones it says to confirm ("… - confirm at sign-up"). */
  confirm: number[];
  /** The same three, for percentages (a fee rate: "1.5% on M-Pesa"). */
  rates: number[];
  disputedRates: number[];
  confirmRates: number[];
}

/** A clause that says its own figure is not settled. Not "as reported" or "confirm at sign-up": those are ordinary care, not doubt. */
export const DISPUTED = /sources (?:quote|differ|conflict|disagree)|figures differ|not verified|unverified/i;

/**
 * The figures each shortlisted row carries, and when the row was checked —
 * judged clause by clause: one row can hold a settled figure and a disputed
 * one ("KES 950 business name; … annual return fee … sources disagree").
 */
export function pricedRows(knowledge: KnowledgeRow[], tools: ToolRow[]): PricedRow[] {
  return [
    ...knowledge.map((k) => ({ id: k.id, verified_on: k.verified_on, text: [k.cost, k.owner_summary, ...(k.steps ?? [])].join("\n") })),
    ...tools.map((t) => ({ id: t.id, verified_on: t.verified_on, text: t.cost ?? "" })),
  ]
    .map((r) => {
      const row: PricedRow = { id: r.id, verified_on: r.verified_on, figures: [], disputed: [], confirm: [], rates: [], disputedRates: [], confirmRates: [] };
      for (const clause of (r.text ?? "").split(/;|\n/)) {
        const figs = moneyIn(clause);
        const pcts = percentsIn(clause).filter((p) => p < 100);
        row.figures.push(...figs);
        row.rates.push(...pcts);
        if (DISPUTED.test(clause)) {
          row.disputed.push(...figs);
          row.disputedRates.push(...pcts);
        } else if (/\bconfirm\b/i.test(clause)) {
          row.confirm.push(...figs);
          row.confirmRates.push(...pcts);
        }
      }
      return row;
    })
    .filter((r) => r.figures.length || r.rates.length);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "15 Sep 2026", in UTC: the date a row says, never shifted a day by the server's zone. */
export function fmtDay(iso: string): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
  return Number.isFinite(d.getTime()) ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : iso;
}

const DATE = String.raw`\d{1,2} [A-Za-z]{3,9} \d{4}`;
/**
 * A stamp the model copied from an earlier answer (it reads its own past
 * replies) is taken out — leaving exactly one date, the one written from the
 * data below. First every line this module writes, whole, with each of its
 * own endings; then a stamp clause anywhere in a sentence, keeping whatever
 * advice or figures follow it ("That rate was last checked on 27 Sep 2026 at
 * 0.55% per payment" -> "0.55% per payment"); then a bracketed one. A dot
 * inside "safaricom.co.ke" or "0.55" is never mistaken for a sentence end
 * (review, round 21).
 */
const OWN_LINE = new RegExp(
  String.raw`(^|(?<=[.!?])[ \t]+)(?:(?:(?:That|This) (?:figure|price|fee|rate|amount) was|(?:Those|These) (?:figures|prices|fees|rates|amounts) were) last checked on ${DATE}(?:(?:\.| — confirm at sign-up\.| — confirm it before you rely on it\.| — confirm the exact amount before you pay\.|, so confirm at sign-up — it may have changed\.|, so confirm it before you rely on it — it may have changed\.)(?=\s|$)|(?=[ \t]*$))|I don't have a date for (?:that figure|those figures)(?:\.|, so confirm it at sign-up\.|, so confirm it before you rely on it\.)(?=\s|$)|Published figures for that differ(?: \(last checked on ${DATE}\))?, so confirm the exact amount(?: at sign-up)? before you pay\.(?=\s|$)|Published figures for that differ; they were last checked on ${DATE}\.(?=\s|$))`,
  "gm",
);
const STAMP_PAREN = new RegExp(String.raw`[ \t]*\((?:(?:that|this|those|these) [^)]*?)?(?:last )?checked (?:on )?${DATE}[^)]*\)`, "gi");
const STAMP_CLAUSE = new RegExp(
  String.raw`(^|(?<=[.!?])[ \t]+|[ \t]*[—–-][ \t]*|,[ \t]*)((?:that|this|those|these) (?:figures?|prices?|fees?|rates?|amounts?) (?:was|were) |(?:when |as |and )?(?:prices? )?)last checked (?:on )?${DATE}(?:[ \t]*(—|–|,|at|so)[ \t]*)?`,
  "gim",
);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * "As of 15 Sep 2026, …", "Yes — as of 15 Sep 2026 it was…", "GH₵130 as of
 * my last check on 15 Sep 2026": a row's own check date the model copied,
 * said another way. Only for those exact dates (`checkDays`), and only where
 * taking it out leaves a sentence: any other "as of <date>" is a claim about
 * when something applies, and goes to the date check (review, round 22).
 */
function stripAsOf(text: string, checkDays: string[]): string {
  if (!checkDays.length) return text;
  const D = `(?:${checkDays.map(escapeRe).join("|")})`;
  return text
    .replace(new RegExp(String.raw`(^|(?<=[.!?])[ \t]+)as of (?:my last check(?: on)? )?${D},?[ \t]*(?=\S)`, "gim"), "$1")
    .replace(new RegExp(String.raw`([ \t]*[—–-][ \t]*|,[ \t]*)as of (?:my last check(?: on)? )?${D}(?=[ \t]+[a-z])`, "gi"), "$1")
    .replace(new RegExp(String.raw`(?<!\b(?:are|is|was|were|be))[ \t]+as of my last check(?: on)? ${D}(?=[ \t]*(?:[.,!?]|$))`, "gim"), "");
}

/** The rows' check dates as a stamp writes them ("15 Sep 2026"). */
export const checkDaysOf = (rows: Pick<PricedRow, "verified_on">[]): string[] => [...new Set(rows.map((r) => (r.verified_on ? fmtDay(r.verified_on) : "")).filter(Boolean))];

/**
 * Takes out "last checked" lines and clauses the model copied from an
 * earlier reply; stampLibraryFigures writes the true one. `checkDays`: the
 * shortlisted rows' check dates, as fmtDay writes them, for "as of …".
 */
export function stripCopiedStamps(text: string, checkDays: string[] = []): string {
  return stripAsOf(text, checkDays)
    .replace(OWN_LINE, "")
    .replace(STAMP_PAREN, "")
    // A clause between a dash or comma and more of the sentence leaves a
    // joiner, never two words glued together ("2.95%so").
    .replace(STAMP_CLAUSE, (m: string, lead: string, _p: string, trail: string | undefined, off: number, str: string) => {
      if (!/^[ \t]*[—–,-]/.test(lead)) return lead;
      const after = str.slice(off + m.length);
      if (!trail || !after.trim() || /^[.!?]/.test(after)) return "";
      return trail === "so" ? ", so " : trail === "," ? ", " : " ";
    })
    .replace(/(^[ \t]*|[.!?][ \t]+)([a-z])(?=[a-z]* )/gm, (_m, a: string, b: string) => a + b.toUpperCase())
    .replace(/[ \t]+([.,;!?])/g, "$1")
    .replace(/(\S)[ \t]{2,}/g, "$1 ")
    .replace(/,([.,;!?])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The person's own money figures and rates — their income, what they owe,
 * their cushion, every setup answer, and what they state as theirs in the
 * message ("I pay R300 a week for transport") — so none is ever dated as a library figure (review, round 21). A
 * figure they ask about ("is it still KSh 950?", "I heard Yoco takes 2.3%")
 * is not theirs: it keeps its date, and its confirm line when stale.
 */
export function ownFigures(biz: Pick<Business, "answers" | "context">, said: string): { money: Set<number>; rates: Set<number> } {
  const stated = (said ?? "")
    .split(/(?<=[?])|[,;.!](?=\s|$)|\s(?:and|but)\s/i)
    .filter((c) => !/\?\s*$/.test(c) && /\b(?:I|I'm|I've|we|we're|my|our)\b/i.test(c) && !/\b(?:still|is (?:it|that|this)|right|true|correct|how much|heard|read|saw|told|says?)\b/i.test(c));
  const theirs = [...stated, ...Object.values(biz.answers ?? {}).map((v) => String(v ?? "")), String(biz.context?.income ?? ""), String(biz.context?.owes ?? ""), String(biz.context?.cushion ?? "")];
  return {
    money: new Set([...figuresFrom(biz.answers?.income, biz.answers?.owes, biz.answers?.cushion, biz.context?.income, biz.context?.owes, biz.context?.cushion), ...theirs.flatMap((t) => moneyIn(t))]),
    rates: new Set(theirs.flatMap((t) => percentsIn(t))),
  };
}

export interface Stamp {
  message: string;
  /** The rows whose figures were stamped. */
  ids: string[];
  kind: "none" | "fresh" | "stale" | "unconfirmed";
}

/**
 * Adds one line under a reply that quotes library figures or rates: when
 * they were checked — and, when that was over 90 days ago, unknown, or the
 * row asks for it, to confirm at sign-up. A figure every carrying row calls
 * disputed gets "published figures differ" instead of a date; when the rows
 * disagree, the settled row's date with a plain confirm. The date is written
 * even when the reply already says to confirm a price; only the confirm
 * suffix is then left off. `notLibrary` / `notLibraryRates`: the person's own
 * figures, never dated as ours. `toolId`: the tool the reply recommends —
 * its row speaks for a figure it carries (review, round 21: an unrelated
 * disputed NGN 10,000 had overruled a settled ₦10,000 caution fee).
 * `about`: the figures a follow-up refers back to ("is that still the
 * same?"), dated when the reply itself restates none — round 23, KE: "As far
 * as I know, yes." about KSh 950 went out with no date.
 */
export function stampLibraryFigures(
  message: string,
  rows: PricedRow[],
  notLibrary: Set<number> = new Set(),
  opts: { notLibraryRates?: Set<number>; toolId?: string | null; about?: number[] } = {},
): Stamp {
  const clean = stripCopiedStamps(message, checkDaysOf(rows));
  const none: Stamp = { message: clean, ids: [], kind: "none" };
  const asked = [
    ...[...new Set(moneyIn(clean))].filter((v) => !notLibrary.has(v)).map((v) => ({ v, money: true })),
    // Any percentage: a shortlisted row has to carry that exact rate before it
    // is dated, so "1.5% on M-Pesa" counts however it is phrased (review,
    // round 21), and "100% online" never does.
    ...[...new Set(percentsIn(clean))].filter((v) => v > 0 && v < 100 && !opts.notLibraryRates?.has(v)).map((v) => ({ v, money: false })),
  ];
  // A follow-up answered without restating the figure ("yes, as far as I
  // know") is dated for the figure it refers back to.
  if (!asked.length) asked.push(...[...new Set(opts.about ?? [])].filter((v) => !notLibrary.has(v)).map((v) => ({ v, money: true })));
  if (!asked.length) return none;
  // A figure counts as already hedged only when its own sentence, or the next
  // one, tells them to confirm a price of its kind — not "check that the name
  // is free on the portal", and not the guardrail's line about another
  // figure (review, round 21).
  const sents = allSentences(clean);
  const hedgedFigure = (v: number, money: boolean): boolean =>
    sents.some((x, i) => {
      if (!(money ? moneyIn(x) : percentsIn(x)).includes(v)) return false;
      return [x, sents[i + 1] ?? ""].some((h) => PRICE_HEDGE.test(h) && !(money ? /^Check that rate with the provider/ : /^Check that price at sign-up/).test(h));
    });
  let hedgedAll = true;
  const dated: PricedRow[] = []; // settled rows: they can date a figure
  const disputedOnly: PricedRow[] = []; // figures only disputed rows carry
  let disagree = false;
  let askConfirm = false;
  for (const { v, money } of asked) {
    const has = (r: PricedRow) => (money ? r.figures : r.rates).includes(v);
    const disputes = (r: PricedRow) => (money ? r.disputed : r.disputedRates).includes(v);
    const carrying = rows.filter(has);
    if (!carrying.length) continue;
    if (!hedgedFigure(v, money)) hedgedAll = false;
    const own = opts.toolId ? carrying.find((r) => r.id === opts.toolId) : undefined;
    const settled = (own ? [own] : carrying).filter((r) => !disputes(r));
    if (!settled.length) {
      disputedOnly.push(own ?? carrying[0]!);
      continue;
    }
    if (!own && settled.length < carrying.length) disagree = true;
    const newest = [...settled].sort((a, b) => staleDays(a.verified_on) - staleDays(b.verified_on))[0]!;
    if ((money ? newest.confirm : newest.confirmRates).includes(v)) askConfirm = true;
    dated.push(newest);
  }
  if (!dated.length && !disputedOnly.length) return none;
  const hedged = hedgedAll;
  const ids = [...new Set([...dated, ...disputedOnly].map((r) => r.id))];
  // "At sign-up" only where there is something to sign up for: a tool's
  // price. A tax band, a wage or a registration threshold (a knowledge row,
  // "k.…") is confirmed before it is relied on (round 24: ZA UIF, GH VAT and
  // NG tax answers ended "— confirm at sign-up").
  const signUp = ids.some((id) => !id.startsWith("k."));
  if (!dated.length) {
    // Only disputed rows carry it: no date makes it settled, but the person
    // still learns when the disagreeing figures were read (rule 10; round
    // 23, UG: the MoMoPay 1% or 2% answer had no date at all).
    const read = [...disputedOnly].sort((a, b) => staleDays(b.verified_on) - staleDays(a.verified_on))[0]?.verified_on;
    const when = read && Number.isFinite(staleDays(read)) ? fmtDay(read) : null;
    if (hedged) return when ? { message: `${clean}\n\nPublished figures for that differ; they were last checked on ${when}.`, ids, kind: "unconfirmed" } : none;
    return { message: `${clean}\n\nPublished figures for that differ${when ? ` (last checked on ${when})` : ""}, so confirm the exact amount${signUp ? " at sign-up" : ""} before you pay.`, ids, kind: "unconfirmed" };
  }
  const oldest = dated.reduce((a, b) => (staleDays(b.verified_on) > staleDays(a.verified_on) ? b : a));
  const stale = isStale(oldest.verified_on);
  const plural = dated.length + disputedOnly.length > 1;
  const those = plural ? "Those figures were" : "That figure was";
  const when = oldest.verified_on && Number.isFinite(staleDays(oldest.verified_on)) ? `last checked on ${fmtDay(oldest.verified_on)}` : null;
  const line = !when
    ? `I don't have a date for ${plural ? "those figures" : "that figure"}${hedged ? "." : signUp ? ", so confirm it at sign-up." : ", so confirm it before you rely on it."}`
    : stale
      ? `${those} ${when}${hedged ? "." : signUp ? ", so confirm at sign-up — it may have changed." : ", so confirm it before you rely on it — it may have changed."}`
      : disagree || disputedOnly.length
        ? `${those} ${when}${hedged ? "." : " — confirm the exact amount before you pay."}`
        : askConfirm
          ? `${those} ${when}${hedged ? "." : signUp ? " — confirm at sign-up." : " — confirm it before you rely on it."}`
          : `${those} ${when}.`;
  return { message: `${clean}\n\n${line}`, ids, kind: stale || !when ? "stale" : "fresh" };
}

// ── A template slot where a figure should be ─────────────────────

/**
 * Case-sensitive, and only as a word of its own: an "r" at the end of
 * "number" is not a rand sign (review, round 21: "till number [xxxxxx]"
 * became "till numbea fee").
 */
const SLOT_CUR = "(?<![A-Za-z])(?:R|KShs?|Kshs?|KSH|KES|UGX|Ugx|ugx|UShs?|Ushs?|Shs?|₦|NGN|GH₵|GH¢|GHS|₵|\\$|USD)\\.?";
const SLOT_WORD = "\\[(?:[Aa]mount|AMOUNT|[Ff]ee|FEE|[Cc]ost|COST|[Ff]igure|[Pp]rice|PRICE|[xX]+|\\.\\.\\.|…)\\]";
const MONEY_SLOT = new RegExp(`${SLOT_CUR}\\s?${SLOT_WORD}(?:\\s?(?:-|–|to)\\s?(?:${SLOT_CUR}\\s?)?${SLOT_WORD})?`, "g");
export const NO_FIGURE_LINE = "I don't have a checked figure for that, so confirm the amount before you pay.";

/**
 * "₦[amount]" in the MESSAGE: a slot the model wrote where it had no checked
 * figure (round 21, NG — its library rows disagree on the fee). The person
 * would have seen the bracket. Only a currency sign straight before a bracket
 * holding a bare word is touched: "R[your price]" is the person's own figure
 * to fill in, and an ARTIFACT's brackets are the round-18 design (a template
 * they complete) — this never sees an artifact.
 */
export function scrubMoneySlots(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(MONEY_SLOT, () => {
    count++;
    return "a fee";
  });
  return count ? { text: `${out.trimEnd()}\n\n${NO_FIGURE_LINE}`, count } : { text, count };
}
