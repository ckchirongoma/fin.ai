// Fin — a date, a law or a waiting time that came from nowhere, taken out.
//
// Rule 10: never invent a price, fee, rule or deadline. Prices have been
// checked mechanically for a long time (grounding.ts, pricestamp.ts); dates
// and laws were left to the prompt and the judge. Round 22, live, KE:
//
//   "Yes, as of my last check it was still KSh 950. It's due to change from
//    1 January when the new Business Laws (Amendment) Act kicks in, but I
//    don't have the new figure yet."
//
// No row in the library mentions that Act or that date. The judge flagged it
// (legal_certainty) and its rewrite kept the claim. GH, the same round: "2
// April 2025", in no row either; KE: "usually in 3 to 7 days", likewise.
//
// So, the same arithmetic as money: every calendar date, every named Act and
// every "N to M days" in a reply is looked for in what this answer was given
// to stand on — the library rows shortlisted for it, the person's own words
// and answers. A sentence carrying a date or a law found in none of them is
// dropped; a waiting time that ends a sentence as a clause of its own is cut
// back to the sentence before it. What is left is still the answer, minus
// the part nobody can stand behind.

import { sentencesOf } from "./grounding.js";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
/** "1 January", "2 April 2025", "1st of March". */
const DAY_MONTH = new RegExp(`\\b${DAY}\\s+(?:of\\s+)?${MON}\\b\\.?(?:,?\\s+(\\d{4}))?`, "g");
/** "January 1", "April 2, 2025". */
const MONTH_DAY = new RegExp(`\\b${MON}\\.?\\s+${DAY}\\b(?:,?\\s+(\\d{4}))?`, "g");
/** "March 2026", "in January 2025". */
const MONTH_YEAR = new RegExp(`\\b${MON}\\.?\\s+(\\d{4})\\b`, "g");
/**
 * "the Business Laws (Amendment) Act", "Nigeria Tax Act 2025", "the Finance
 * Bill": capitalised words (or a bracketed one) running up to Act/Bill.
 */
const LAW = /\b((?:[A-Z][\w'’-]*|\([A-Z][\w'’ -]*\))(?:\s+(?:[A-Z][\w'’-]*|\([A-Z][\w'’ -]*\)|of|and|on))*\s+(?:Act|Bill)\b(?:,?\s*(?:No\.?\s*)?\d{4}\b(?!\d))?)/g;
/** ", usually in 3 to 7 days." / " — within 5-10 working days." at the end of a sentence. */
const WAIT_TAIL = /(?:,|\s[—–-])\s*(?:usually|normally|typically|often|generally|about|roughly|approximately)?\s*(?:in|within|after|takes?)?\s*(?:about\s+)?(\d{1,3})\s*(?:to|-|–)\s*(\d{1,3})\s+(?:working\s+|business\s+|calendar\s+)?(days?|weeks?|hours?|months?)\s*(?=[.!?]?\s*$)/i;

const monthIndex = (m: string): number => MONTHS.findIndex((x) => x.startsWith(m.toLowerCase().slice(0, 3)));
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

interface FoundDate {
  text: string;
  day: number | null;
  month: number;
  year: string | null;
}

/** Each date in a text: "1 January", "April 2, 2025", "March 2026" (a month-and-year inside a full date is that date). */
function datesIn(text: string): FoundDate[] {
  const out: (FoundDate & { at: number; end: number })[] = [];
  const push = (m: RegExpMatchArray, day: string | undefined, mon: string, year: string | undefined) => {
    const month = monthIndex(mon);
    if (month < 0 || (day !== undefined && (Number(day) < 1 || Number(day) > 31))) return;
    out.push({ text: m[0].replace(/\.$/, ""), day: day === undefined ? null : Number(day), month, year: year ?? null, at: m.index!, end: m.index! + m[0].length });
  };
  for (const m of text.matchAll(DAY_MONTH)) push(m, m[1], m[2]!, m[3]);
  for (const m of text.matchAll(MONTH_DAY)) push(m, m[2], m[1]!, m[3]);
  for (const m of text.matchAll(MONTH_YEAR)) if (!out.some((d) => d.day !== null && m.index! >= d.at && m.index! < d.end)) push(m, undefined, m[1]!, m[2]);
  return out;
}

/**
 * The dates the sources give, so a reply's date can be looked up the way it
 * is written: a day and month given with a year match only that year; a
 * month and year match only that month (review, round 22: any one key used
 * to do, so one "15 Sep 2026" in a source vouched for every September 2026).
 */
function dateIndex(text: string): { dayMonth: Set<string>; dayMonthYear: Set<string>; monthYear: Set<string> } {
  const idx = { dayMonth: new Set<string>(), dayMonthYear: new Set<string>(), monthYear: new Set<string>() };
  for (const d of datesIn(text)) {
    if (d.day !== null && d.year === null) idx.dayMonth.add(`${d.day}-${d.month}`);
    if (d.day !== null && d.year !== null) idx.dayMonthYear.add(`${d.day}-${d.month}-${d.year}`);
    if (d.year !== null) idx.monthYear.add(`${d.month}-${d.year}`);
  }
  return idx;
}

function dateFound(d: FoundDate, idx: ReturnType<typeof dateIndex>): boolean {
  if (d.day !== null && d.year !== null) return idx.dayMonthYear.has(`${d.day}-${d.month}-${d.year}`) || idx.dayMonth.has(`${d.day}-${d.month}`);
  if (d.day !== null) return idx.dayMonth.has(`${d.day}-${d.month}`) || [...idx.dayMonthYear].some((k) => k.startsWith(`${d.day}-${d.month}-`));
  return d.year !== null && idx.monthYear.has(`${d.month}-${d.year}`);
}

/**
 * The calendar's own days: a tip about Christmas stock is not a deadline
 * anyone checked, so "Christmas is 25 December" stands — when the sentence
 * names the day and sets no deadline with it. "Your VAT return is due by 25
 * December" is checked like any date (review, round 22).
 */
const HOLIDAYS: Record<string, RegExp> = { "25-11": /\bChristmas\b/i, "26-11": /\b(?:Boxing Day|Day of Goodwill)\b/i, "14-1": /\bValentine/i };
const DEADLINE_WORDS = /\b(?:due|deadline|by|before|file|submit|pay|paid|levy|fee|tax|return|applies|apply|from|effective|change[sd]?|register|renew)\b/i;
const holiday = (d: FoundDate, sentence: string): boolean =>
  d.day !== null && (HOLIDAYS[`${d.day}-${d.month}`]?.test(sentence) ?? false) && !DEADLINE_WORDS.test(sentence);

export interface DateCheck {
  message: string;
  /** What was taken out, for the record. */
  dropped: string[];
  /**
   * How many dates, Acts and waiting times the check read, kept or not: a
   * check that removed nothing still shows it ran (round 23: zero
   * date_grounding rows could not tell "nothing wrong" from "never ran").
   */
  checked: number;
}

/** "South Africa's", "Kenya’s": a country's possessive in front of its own law's name. */
const POSSESSIVE = /^[\w-]+['’]s$/;
const FUNCTION_WORD = /^(?:of|and|on)$/i;
/** A bill to pay, not a bill before parliament: "M-Pesa Pay Bill", "Business Pay Bill 222222", "your Kenya Power Bill". */
// Only the word straight before "Bill" decides it (review, round 23: a brand
// anywhere in the name let "The MoMo Agents Bill 2026" through).
const PAYMENT_BILL = /(?:^|\s)(?:Pay|Till|M-?Pesa|Lipa|Goods|Power|Electricity|Water|Phone|Airtime|Utility|Light|Gas|Rent|Hospital|School|KPLC|Eskom|ECG|Umeme|UEDCL|Yaka|NWSC|IKEDC|EKEDC|AEDC|DStv|GOtv|Internet|Wi-?Fi|MoMo|Airtel|MTN)$/i;

/**
 * Whether a law the reply names is one the sources name, word for word.
 * The words before "Act" are tried from the full capture down, so an
 * opening word or a country's possessive in front of the name ("Under
 * Nigeria Tax Act 2025", "South Africa's Consumer Protection Act") does not
 * hide a law the rows carry. A shorter run must still hold at least two
 * real words and start with one ("of goods act" is not "Sale of Goods
 * Act"), and a year given must be the year found: "Finance Bill 2026" is not
 * "Finance Act 2023". Without "Act", only an acronym the sources use as a
 * word counts ("POPIA" stands for "the POPIA Act"); "Kenya's Turnover Tax
 * Act" is not vouched for by a row that says "turnover tax" (review, round 22).
 */
function lawFound(captured: string, givenText: string): boolean {
  const m = /^(.*?)\s+(Act|Bill)\b,?\s*(?:No\.?\s*)?(\d{4})?\s*$/.exec(captured.replace(/^the\s+/i, ""));
  if (!m) return false;
  const kind = m[2]!.toLowerCase();
  const year = m[3] ?? "";
  let words = m[1]!.trim().split(/\s+/);
  const p = words.findIndex((w) => POSSESSIVE.test(w));
  if (p >= 0) words = words.slice(p + 1);
  if (!words.length) return false;
  const hasPhrase = (t: string) => new RegExp(`(?:^| )${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: |$)`).test(givenText);
  const content = (ws: string[]) => ws.filter((w) => !FUNCTION_WORD.test(w)).length;
  const need = Math.min(2, content(words));
  for (let i = 0; i < words.length; i++) {
    const run = words.slice(i);
    if (FUNCTION_WORD.test(run[0]!) || content(run) < need) continue;
    if (hasPhrase(`${norm(run.join(" "))} ${kind}${year ? ` ${year}` : ""}`)) return true;
  }
  const only = words.length === 1 ? words[0]! : "";
  return /^[A-Z0-9]{3,}$/.test(only) && hasPhrase(norm(only));
}

/** A list marker on its own ("2. ", "Step 3) "): kept or dropped with the sentence it numbers. */
const MARKER = /^\s*(?:(?:step|day)\s+)?\(?\d{1,2}[.)]\s*$/i;
const ITEM = /^(\s*(?:(?:step|day)\s+)?\(?)(\d{1,2})([.)]\s)/i;

/**
 * Takes out the dates, laws and waiting times `message` states that none of
 * `grounding` (the rows the answer was given, the person's words) contains;
 * `checkDays`, the rows' check dates, count only as those exact dates.
 * Line breaks and every other sentence are kept as they are; a line left
 * with nothing on it goes, and a numbered list that lost an item is
 * numbered again from where it started.
 */
export function dropUngroundedDates(message: string, grounding: string[], checkDays: string[] = []): DateCheck {
  const given = grounding.filter(Boolean).join("\n");
  const idx = dateIndex(given);
  // A row's own check date ("as of 15 Sep 2026") stands only as that whole
  // date: as ordinary text it would vouch for every day of its month.
  const checked = new Set(datesIn(checkDays.join("\n")).filter((d) => d.day !== null && d.year !== null).map((d) => `${d.day}-${d.month}-${d.year}`));
  const givenText = norm(given);
  const dropped: string[] = [];
  let checkedCount = 0;
  let onlyLaws = true;

  const lines = message.split("\n").map((line) => {
    const kept: string[] = [];
    // A numbered line's marker travels with its sentence.
    const parts = sentencesOf(line).reduce<string[]>((acc, part) => {
      const prev = acc[acc.length - 1];
      if (prev !== undefined && MARKER.test(prev)) acc[acc.length - 1] = prev + part;
      else acc.push(part);
      return acc;
    }, []);
    for (const s of parts) {
      checkedCount += datesIn(s).length + [...s.matchAll(LAW)].length + (WAIT_TAIL.test(s.trimEnd()) ? 1 : 0);
      const dates = datesIn(s).filter((d) => !dateFound(d, idx) && !holiday(d, s) && !(d.day !== null && d.year !== null && checked.has(`${d.day}-${d.month}-${d.year}`)));
      const laws = [...s.matchAll(LAW)]
        .filter((m) => {
          const name = m[1]!.replace(/\s+(?:Act|Bill)\b.*$/, "").trim();
          // One capitalised word before "Act" at the very start of a
          // sentence is a sentence ("Then Act fast"), not a law's name.
          if (!/\s/.test(name) && s.replace(/^\s*(?:(?:step|day)\s+)?\(?\d{1,2}[.)]\s*/i, "").trimStart().startsWith(m[1]!)) return false;
          // A bill to pay is not a bill before parliament.
          // A Bill with a year after it is before parliament, whatever it is called.
          return !(/\bBill\b(?!,?\s*(?:No\.?\s*)?\d{4}\b)/.test(m[1]!) && PAYMENT_BILL.test(name));
        })
        .map((m) => m[1]!)
        .filter((l) => !lawFound(l, givenText));
      if (dates.length || laws.length) {
        if (dates.length) onlyLaws = false;
        dropped.push(...dates.map((d) => d.text), ...laws);
        continue;
      }
      const wait = WAIT_TAIL.exec(s.trimEnd());
      if (wait) {
        const span = new RegExp(`\\b${wait[1]}\\s*(?:to|-|–)\\s*${wait[2]}\\s+(?:working\\s+|business\\s+|calendar\\s+)?${wait[3]!.replace(/s$/, "")}`, "i");
        if (!span.test(given)) {
          onlyLaws = false;
          dropped.push(wait[0].trim().replace(/^[,—–-]\s*/, ""));
          const cut = s.trimEnd().slice(0, wait.index).replace(/[\s,;:—–-]+$/, "");
          const end = /[!?]$/.test(s.trimEnd()) ? s.trimEnd().slice(-1) : ".";
          kept.push(cut && !MARKER.test(cut) ? `${cut.trim()}${end}` : "");
          continue;
        }
      }
      kept.push(s.trim());
    }
    return { was: line, now: kept.filter((x) => x.trim()).join(" ").trim() };
  });

  if (!dropped.length) return { message, dropped, checked: checkedCount };
  const text = renumber(lines).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { message: text || (onlyLaws ? NO_LAW_LINE : NO_DATE_LINE), dropped, checked: checkedCount };
}

/**
 * The lines left, with each numbered list that lost an item numbered again
 * from its own first number. A list runs over blank lines while its numbers
 * keep rising; a "1." or a line of prose starts a new one. Lists that lost
 * nothing are left exactly as they were.
 */
function renumber(lines: { was: string; now: string }[]): string[] {
  type Item = { i: number; n: number; removed: boolean };
  const blocks: Item[][] = [];
  let cur: Item[] | null = null;
  lines.forEach((l, i) => {
    const m = ITEM.exec(l.was);
    if (!m) {
      if (l.was.trim()) cur = null;
      return;
    }
    const n = Number(m[2]);
    if (!cur || n === 1 || n <= cur[cur.length - 1]!.n) {
      cur = [];
      blocks.push(cur);
    }
    cur.push({ i, n, removed: !l.now });
  });
  const out = lines.map((l) => l.now);
  for (const b of blocks) {
    if (!b.some((x) => x.removed)) continue;
    let n = b[0]!.n;
    for (const x of b) {
      if (x.removed) continue;
      out[x.i] = out[x.i]!.replace(ITEM, (_m, a: string, _d: string, c: string) => `${a}${n}${c}`);
      n++;
    }
  }
  // A line that had words and now has none goes; blank lines stay as they were.
  return out.filter((t, i) => !(lines[i]!.was.trim() && !t));
}

/** When every sentence rested on a date nobody checked. */
export const NO_DATE_LINE = "I don't have a checked date for that, so confirm it with the official source before you rely on it.";
/** When every sentence rested on a law nobody checked. */
export const NO_LAW_LINE = "I can't confirm which law covers that from what I have checked, so ask the official regulator before you rely on it.";
