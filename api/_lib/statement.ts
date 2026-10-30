// Charles — reading a bank statement (or a payslip, a credit report, a list
// of debit orders) the person CHOSE to send, and saying their money back to
// them from it.
//
// The offer is optional and said plainly: "If you want, send me a bank
// statement and I'll read your money back to you from it." Nobody is asked
// for one; the diagnostic works without it. When one arrives, this file does
// four things, and three of them are plain code with no model in them:
//
//   1. readMoneyDocument — ONE model call, extraction only. The model reports
//      what is on the page as a small fixed JSON: who paid in, who got paid,
//      how much, on what day, the totals, the fees, the days below zero. It is
//      told to leave out the account number, the card number, the ID number,
//      the holder's name and address, and every reference number. Then
//      scrub() strips any long digit run that got through anyway. The file
//      itself is never stored: only this summary is, on the household row.
//   2. explainBack — the read-back, built in code from the summary, so every
//      figure in it is the statement's own and none is invented (rule 10).
//   3. summaryLine — one line under the diagnostic answers, keyed
//      `statement`, so the plan is built on real figures and every prompt
//      says "your statement shows", never "you said" (rule 2).
//   4. budgetFromStatement — the three-pot month, in code, from their lines:
//      what must be paid on the day money lands, food and transport, and
//      what is left. The plan's own m_month module says the same thing.
//
// Rule 12 holds throughout: Charles never asks for an account number and
// never keeps one. A statement carries one; it is dropped before anything
// is written. Rule 11 holds too: a loan line on the statement is named as
// the costliest money, never as something to refinance.

import { attachmentKind, MAX_ATTACHMENT_BYTES } from "./attachments.js";
import { callOpenRouter, getModel } from "./models.js";
import { trackFailure } from "./track.js";

export type MoneyDocKind = "bank_statement" | "payslip" | "credit_report" | "debit_orders";

export type OutKind =
  | "debit_order"
  | "loan"
  | "store_account"
  | "insurance"
  | "rent"
  | "electricity"
  | "school"
  | "stokvel"
  | "family"
  | "airtime_data"
  | "groceries"
  | "transport"
  | "bank_fees"
  | "cash"
  | "transfer"
  | "other";

export interface MoneyLine {
  /** Who paid, or who got paid: a grant, an employer, a shop, a lender. Never a person's full name. */
  label: string;
  amount: number;
  /** Day of the month it happened, when the page says. */
  day: number | null;
  /** Money out only. */
  kind?: OutKind;
  /** More than one payment with this label. */
  times?: number;
}

export interface StatementRead {
  doc: MoneyDocKind;
  /** The bank, employer or bureau, as printed. */
  source: string | null;
  /** The period, as printed ("1 Sep 2026 to 30 Sep 2026"). */
  period: string | null;
  money_in: MoneyLine[];
  money_out: MoneyLine[];
  totals: { in: number | null; out: number | null; fees: number | null; cash: number | null; closing: number | null };
  days_below_zero: number | null;
  /** Things the page shows that a person would want said: a returned debit order, an arrears note. */
  flags: string[];
  unclear: string | null;
  /** ISO date Charles read it. */
  read_on: string;
  /** What the person said when asked: a normal month, or not. */
  normal_month?: boolean | null;
}

const KINDS: MoneyDocKind[] = ["bank_statement", "payslip", "credit_report", "debit_orders"];
const OUT_KINDS: OutKind[] = ["debit_order", "loan", "store_account", "insurance", "rent", "electricity", "school", "stokvel", "family", "airtime_data", "groceries", "transport", "bank_fees", "cash", "transfer", "other"];

export const DOC_LABEL: Record<MoneyDocKind, string> = {
  bank_statement: "bank statement",
  payslip: "payslip",
  credit_report: "credit report",
  debit_orders: "list of debit orders",
};

/** The one line that says what Charles keeps, used wherever the offer is made. */
export const KEEP_LINE = "I keep only the totals and who gets paid, never the account number, and I don't keep the file.";

/** The offer, under the income question and wherever someone asks. */
export const STATEMENT_OFFER = `Or send me a bank statement, a PDF from your banking app or a photo of the pages, and I'll read it back to you. ${KEEP_LINE}`;

/** The reply to "can you read my bank statement?" */
export const HOW_TO_SEND =
  `Yes. Send it here as a PDF from your banking app, or a photo of the pages. A payslip or a credit report works too. I'll read it once and say your money back to you: what came in, what went out and where it went. ${KEEP_LINE}`;

/** "can you read my bank statement", "how do i send my statement", "can i send you my payslip". Whole message, short. */
export const STATEMENT_ASK =
  /^\s*(?:(?:can|could|will|do)\s+(?:you|u|charles)\s+(?:please\s+)?(?:read|look\s+at|check|see|use|take|analy[sz]e|go\s+through)|(?:how|where)\s+(?:do|can|should)\s+i\s+(?:send|share|upload|give)(?:\s+you)?|can\s+i\s+(?:send|share|upload|give)(?:\s+you)?)\s+(?:my|a|the|our)\s+(?:bank\s+)?(?:statements?|payslips?|pay\s+slips?|credit\s+reports?|debit\s+orders?)\b[\s?!.]*$/i;

export function readMoneyDocumentPrompt(caption?: string): string {
  return [
    "Read this money document. A person chose to send it to their money coach so their money can be read back to them. Report what is on the page as JSON. Do not interpret it, judge it or give advice: someone else does that.",
    "",
    "LEAVE OUT, always: the account number, the card number, the ID number, the account holder's name and address, customer and reference numbers, and the full name of any private person who paid in or was paid. For a private person write only what they are (\"a relative\", \"an employer\", \"a client\"). Keep the names of a bank, an employer, a shop, a lender, an insurer, a stokvel, a school, SASSA, SARS, a municipality.",
    "",
    "If this is not a bank statement, a payslip, a credit report or a list of debit orders, reply with exactly: {\"doc\":\"not_money\"}",
    "",
    "Otherwise reply with JSON only, no fences:",
    `{"doc": ${KINDS.map((k) => `"${k}"`).join(" | ")},`,
    ' "source": string | null,   // the bank, employer or bureau, as printed',
    ' "period": string | null,   // the period as printed, e.g. "1 Sep 2026 to 30 Sep 2026", or the pay month',
    ' "money_in": [{"label": string, "amount": number, "day": number | null, "times": number | null}],',
    ` "money_out": [{"label": string, "amount": number, "day": number | null, "kind": ${OUT_KINDS.map((k) => `"${k}"`).join(" | ")}, "times": number | null}],`,
    ' "totals": {"in": number | null, "out": number | null, "fees": number | null, "cash": number | null, "closing": number | null},',
    ' "days_below_zero": number | null,',
    ' "flags": string[],          // things the page itself shows: a returned or unpaid debit order, an arrears note, a judgment, a deduction order on a payslip. As written, no advice.',
    ' "unclear": string | null}   // one line, if part of it could not be read',
    "",
    "Group repeated payments to the same payee into one line with \"times\" (four payments of R200 to the same lender: amount 800, times 4). Amounts are positive numbers in rand with no currency sign. \"amount\" for money_in is what landed. On a payslip, money_in is gross pay and money_out is each deduction (PAYE, UIF, a loan deduction, a garnishee or emolument attachment order, medical, pension). On a credit report, money_out is each account with its balance, kind \"loan\" or \"store_account\", and flags carry arrears, defaults and judgments. If a figure is blurred or cut off, leave it out rather than guess.",
    caption ? `The person's own note, for context only: ${caption.slice(0, 300)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Scrubbing: nothing that identifies an account survives ───────

/** Eight or more digits in a row (an account, card, ID or reference number), with or without spaces. */
const LONG_DIGITS = /\b(?:\d[ -]?){8,}\b/g;
/** Anything the model labelled as the thing it was told to leave out. */
const IDENTIFIER_LABEL = /\b(?:account|acc|acct|a\/c|card|id|identity|reference|ref|customer)\s*(?:no|number|#)?\b\s*[:#-]?\s*[\dx*]{4,}/gi;

/**
 * Drops anything that identifies an account rather than masking it: a label
 * "Cash deposit ref 98765432" becomes "Cash deposit", a source "Capitec,
 * account 1234567890123" becomes "Capitec", and a flag that was only a card
 * number becomes nothing and is dropped by the caller.
 */
export function scrubText(s: string): string {
  return s
    .replace(IDENTIFIER_LABEL, "")
    .replace(LONG_DIGITS, "")
    .replace(/\s+([,;:.)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/[,;:]+\s*(?=[,;:]|$)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;:.-]+|[\s,;:-]+$/g, "")
    .trim();
}

const MAX_LINES_IN = 12;
const MAX_LINES_OUT = 40;
const MAX_FLAGS = 8;
const MAX_LABEL = 60;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null);
const dayOf = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 31 ? v : null);
const timesOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 2 && v <= 99 ? v : undefined);

function line(raw: unknown, out: boolean): MoneyLine | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const amount = num(r.amount);
  const label = scrubText(String(r.label ?? "")).slice(0, MAX_LABEL);
  if (!label || amount === null || amount === 0) return null;
  const l: MoneyLine = { label, amount, day: dayOf(r.day) };
  const times = timesOf(r.times);
  if (times) l.times = times;
  if (out) l.kind = OUT_KINDS.includes(r.kind as OutKind) ? (r.kind as OutKind) : "other";
  return l;
}

/**
 * Turns whatever the model returned into a StatementRead, or null when it is
 * not one. Every string is scrubbed; every list is capped; every number is a
 * finite non-negative rand amount or null.
 */
export function parseStatement(raw: unknown, readOn = new Date().toISOString().slice(0, 10)): StatementRead | "not_money" | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.doc === "not_money") return "not_money";
  if (!KINDS.includes(r.doc as MoneyDocKind)) return null;
  const totalsRaw = (r.totals && typeof r.totals === "object" ? r.totals : {}) as Record<string, unknown>;
  const money_in = (Array.isArray(r.money_in) ? r.money_in : []).map((x) => line(x, false)).filter((x): x is MoneyLine => !!x).slice(0, MAX_LINES_IN);
  const money_out = (Array.isArray(r.money_out) ? r.money_out : []).map((x) => line(x, true)).filter((x): x is MoneyLine => !!x).slice(0, MAX_LINES_OUT);
  const sum = (ls: MoneyLine[]) => Math.round(ls.reduce((a, l) => a + l.amount, 0) * 100) / 100;
  const read: StatementRead = {
    doc: r.doc as MoneyDocKind,
    source: r.source ? scrubText(String(r.source)).slice(0, 40) || null : null,
    period: r.period ? scrubText(String(r.period)).slice(0, 60) || null : null,
    money_in,
    money_out,
    totals: {
      in: num(totalsRaw.in) ?? (money_in.length ? sum(money_in) : null),
      out: num(totalsRaw.out) ?? (money_out.length ? sum(money_out) : null),
      fees: num(totalsRaw.fees) ?? (money_out.some((l) => l.kind === "bank_fees") ? sum(money_out.filter((l) => l.kind === "bank_fees")) : null),
      cash: num(totalsRaw.cash) ?? (money_out.some((l) => l.kind === "cash") ? sum(money_out.filter((l) => l.kind === "cash")) : null),
      closing: typeof totalsRaw.closing === "number" && Number.isFinite(totalsRaw.closing) ? Math.round(totalsRaw.closing * 100) / 100 : null,
    },
    days_below_zero: typeof r.days_below_zero === "number" && Number.isInteger(r.days_below_zero) && r.days_below_zero >= 0 ? Math.min(r.days_below_zero, 31) : null,
    flags: (Array.isArray(r.flags) ? r.flags : [])
      .map((f) => scrubText(String(f ?? "")).slice(0, 140))
      .filter(Boolean)
      .slice(0, MAX_FLAGS),
    unclear: r.unclear ? scrubText(String(r.unclear)).slice(0, 160) || null : null,
    read_on: readOn,
  };
  // A statement with nothing on it is not a reading.
  if (!read.money_in.length && !read.money_out.length && read.totals.in === null && read.totals.out === null) return null;
  return read;
}

/**
 * One model call. Null means "could not read it"; "not_money" means it is
 * something else (a flyer, a quote) and the ordinary forward reader should
 * have it. Never throws.
 */
export async function readMoneyDocument(bytes: Uint8Array, mimeType: string, caption?: string): Promise<StatementRead | "not_money" | null> {
  const kind = attachmentKind(mimeType);
  if (!kind || bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) return null;
  const started = Date.now();
  try {
    const { model } = await getModel("wa_reply");
    const base = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
    const dataUrl = `data:${base};base64,${Buffer.from(bytes).toString("base64")}`;
    const part = kind === "photo" ? { type: "image_url", image_url: { url: dataUrl } } : { type: "file", file: { filename: "document.pdf", file_data: dataUrl } };
    const out = await callOpenRouter(
      model,
      [{ role: "user", content: [{ type: "text", text: readMoneyDocumentPrompt(caption) }, part] }],
      { maxTokens: 2200, temperature: 0, reasoning: { enabled: false }, role: "statement", timeoutMs: 90_000 },
    );
    const text = out.text.trim();
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    if (!json) return null;
    return parseStatement(JSON.parse(json));
  } catch (err) {
    console.log("readMoneyDocument failed:", err);
    trackFailure("statement_read_failed", err, {
      ms: Date.now() - started,
      props: { kind, bytes: bytes.byteLength },
      summary: "A statement, payslip or credit report a person chose to send could not be read; they were told so",
    });
    return null;
  }
}

// ── Saying it back, in code ──────────────────────────────────────

/** R4,820 — never a decimal unless the figure has cents. */
export function rand(n: number): string {
  const whole = Math.round(n * 100) / 100;
  const s = Number.isInteger(whole) ? whole.toLocaleString("en-ZA") : whole.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `R${s.replace(/ |\s/g, ",")}`;
}

const ordinal = (d: number): string => `${d}${d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th"}`;

const lineText = (l: MoneyLine): string =>
  `${l.label} ${rand(l.amount)}${l.times ? ` (${l.times} payments)` : ""}${l.day ? ` on the ${ordinal(l.day)}` : ""}`;

const KIND_LABEL: Record<OutKind, string> = {
  debit_order: "debit orders",
  loan: "loans",
  store_account: "store accounts",
  insurance: "cover",
  rent: "rent",
  electricity: "electricity and water",
  school: "school",
  stokvel: "stokvel",
  family: "money to family",
  airtime_data: "airtime and data",
  groceries: "groceries",
  transport: "transport",
  bank_fees: "bank fees",
  cash: "cash drawn",
  transfer: "transfers",
  other: "other",
};

/** The biggest lines, excluding fees (said on their own line). */
function biggest(read: StatementRead, n: number): MoneyLine[] {
  return [...read.money_out].filter((l) => l.kind !== "bank_fees").sort((a, b) => b.amount - a.amount).slice(0, n);
}

export function loanLines(read: StatementRead): MoneyLine[] {
  return read.money_out.filter((l) => l.kind === "loan" || /mashonisa|loan|lender|cash\s*loan|micro\s*loan|advance/i.test(l.label));
}

/**
 * The read-back. Plain code: every figure is the document's own. Ends with
 * the question the buttons answer ("a normal month?") for a statement, and
 * without it for a payslip or credit report.
 */
export function explainBack(read: StatementRead, personName?: string | null): string {
  const name = (personName ?? "").trim() && personName !== "you" ? `, ${personName!.trim().split(/\s+/)[0]}` : "";
  const where = [read.period, read.source].filter(Boolean).join(", ");
  const head = `Here's what your ${DOC_LABEL[read.doc]} says${name}${where ? ` (${where})` : ""}:`;
  const parts: string[] = [head, ""];

  if (read.doc === "credit_report") {
    const accounts = read.money_out;
    parts.push(accounts.length ? `Accounts on it: ${accounts.map((l) => `${l.label} ${rand(l.amount)}`).join(", ")}.` : "No account balances could be read.");
    if (read.totals.out !== null) parts.push(`Owed altogether: ${rand(read.totals.out)}.`);
  } else {
    if (read.totals.in !== null) {
      const ins = read.money_in.slice(0, 4).map(lineText).join(", ");
      parts.push(`${read.doc === "payslip" ? "Pay before deductions" : "Money in"}: ${rand(read.totals.in)}${ins ? `. ${ins}` : ""}.`);
    }
    if (read.totals.out !== null) {
      const top = biggest(read, 3).map((l) => `${l.label} ${rand(l.amount)}${l.times ? ` (${l.times} payments)` : ""}`).join(", ");
      parts.push(`${read.doc === "payslip" ? "Deductions" : "Money out"}: ${rand(read.totals.out)}${top ? `. The biggest: ${top}` : ""}.`);
    }
    if (read.totals.fees !== null && read.totals.fees > 0) parts.push(`Bank fees: ${rand(read.totals.fees)}.`);
    if (read.totals.cash !== null && read.totals.cash > 0) parts.push(`Cash drawn: ${rand(read.totals.cash)}.`);
    if (read.days_below_zero) parts.push(`Your balance went below zero on ${read.days_below_zero === 1 ? "1 day" : `${read.days_below_zero} days`}.`);
    if (read.totals.closing !== null && read.doc === "bank_statement") parts.push(`${read.totals.closing < 0 ? "Below zero at the end" : "Left at the end"}: ${rand(Math.abs(read.totals.closing))}.`);
    if (read.totals.in !== null && read.totals.out !== null && read.doc === "payslip") parts.push(`Lands in your account: ${rand(Math.max(0, read.totals.in - read.totals.out))}.`);
  }
  for (const f of read.flags.slice(0, 3)) parts.push(`The page also shows: ${f}.`);
  if (read.unclear) parts.push(`One part I couldn't read: ${read.unclear}.`);
  parts.push("", KEEP_LINE);
  if (read.doc === "bank_statement" || read.doc === "payslip") parts.push("", `Does this look like a normal ${read.doc === "payslip" ? "pay month" : "month"} for you?`);
  return parts.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * The one line that joins the diagnostic answers under the key `statement`,
 * so the plan builder, the context and the price grounding all see the real
 * figures. It starts with its source, so no prompt can read it as something
 * the person typed.
 */
export function summaryLine(read: StatementRead): string {
  const where = [read.period, read.source].filter(Boolean).join(", ");
  const bits: string[] = [];
  if (read.totals.in !== null) bits.push(`${read.doc === "payslip" ? "gross pay" : "money in"} ${rand(read.totals.in)}${read.money_in.length ? ` (${read.money_in.slice(0, 5).map(lineText).join("; ")})` : ""}`);
  if (read.totals.out !== null) bits.push(`${read.doc === "credit_report" ? "owed" : read.doc === "payslip" ? "deductions" : "money out"} ${rand(read.totals.out)}${read.money_out.length ? ` (${[...read.money_out].sort((a, b) => b.amount - a.amount).slice(0, 8).map((l) => `${l.label} ${rand(l.amount)}${l.times ? ` x${l.times}` : ""}`).join("; ")})` : ""}`);
  if (read.totals.fees) bits.push(`bank fees ${rand(read.totals.fees)}`);
  if (read.totals.cash) bits.push(`cash drawn ${rand(read.totals.cash)}`);
  if (read.days_below_zero) bits.push(`below zero on ${read.days_below_zero} day${read.days_below_zero === 1 ? "" : "s"}`);
  if (read.totals.closing !== null) bits.push(`${rand(Math.abs(read.totals.closing))} ${read.totals.closing < 0 ? "overdrawn" : "left"} at the end`);
  for (const f of read.flags.slice(0, 3)) bits.push(f);
  const normal = read.normal_month === false ? " They said this was NOT a normal month." : read.normal_month ? " They said this is a normal month." : "";
  return `From the ${DOC_LABEL[read.doc]} they sent (read ${read.read_on}${where ? `, ${where}` : ""}): ${bits.join("; ")}.${normal}`;
}

/** The plan document's one line: figures only, short enough for a table row. */
export function docLine(read: StatementRead): string {
  const where = [read.period, read.source].filter(Boolean).join(", ");
  const bits: string[] = [];
  if (read.totals.in !== null) bits.push(`${read.doc === "payslip" ? "gross pay" : "in"} ${rand(read.totals.in)}`);
  if (read.totals.out !== null) bits.push(`${read.doc === "credit_report" ? "owed" : read.doc === "payslip" ? "deductions" : "out"} ${rand(read.totals.out)}`);
  if (read.totals.fees) bits.push(`bank fees ${rand(read.totals.fees)}`);
  if (read.days_below_zero) bits.push(`below zero on ${read.days_below_zero} day${read.days_below_zero === 1 ? "" : "s"}`);
  return `${DOC_LABEL[read.doc].replace(/^./, (c) => c.toUpperCase())}${where ? ` (${where})` : ""}: ${bits.join(", ")}${read.normal_month === false ? "; not a normal month, they said" : ""}`;
}

// ── The budget, in code ──────────────────────────────────────────

const POT_FIXED = new Set<OutKind>(["debit_order", "loan", "store_account", "insurance", "rent", "electricity", "school", "stokvel", "family"]);
const POT_LIVING = new Set<OutKind>(["groceries", "transport", "airtime_data"]);

export interface Budget {
  income: number;
  fixed: { total: number; lines: MoneyLine[] };
  living: { total: number; lines: MoneyLine[] };
  left: number;
  /** Cash and other spending the statement shows: the pot a plan works on. */
  loose: number;
  fees: number;
  /** The one move: a round amount that could go to a savings pocket on payday, from their own numbers. */
  putAway: number | null;
  costliest: MoneyLine | null;
}

const roundDown50 = (n: number): number => Math.floor(n / 50) * 50;

export function budgetFromStatement(read: StatementRead): Budget | null {
  if (read.doc !== "bank_statement" && read.doc !== "payslip") return null;
  const income = read.totals.in;
  if (income === null || income <= 0) return null;
  const fixedLines = read.money_out.filter((l) => POT_FIXED.has(l.kind ?? "other")).sort((a, b) => b.amount - a.amount);
  const livingLines = read.money_out.filter((l) => POT_LIVING.has(l.kind ?? "other")).sort((a, b) => b.amount - a.amount);
  const sum = (ls: MoneyLine[]) => Math.round(ls.reduce((a, l) => a + l.amount, 0) * 100) / 100;
  const fixed = sum(fixedLines);
  const living = sum(livingLines);
  const fees = read.totals.fees ?? sum(read.money_out.filter((l) => l.kind === "bank_fees"));
  const loose = sum(read.money_out.filter((l) => l.kind === "cash" || l.kind === "transfer" || l.kind === "other"));
  const left = Math.round((income - fixed - living - fees) * 100) / 100;
  const tenth = roundDown50(income * 0.1);
  const putAway = left >= 50 ? Math.max(50, Math.min(tenth, roundDown50(left * 0.5))) : null;
  const costliest = loanLines(read).sort((a, b) => b.amount - a.amount)[0] ?? null;
  return { income, fixed: { total: fixed, lines: fixedLines }, living: { total: living, lines: livingLines }, left, loose, fees, putAway, costliest };
}

/** The budget as the WhatsApp message, from their own lines. */
export function budgetMessage(read: StatementRead, personName?: string | null): string | null {
  const b = budgetFromStatement(read);
  if (!b) return null;
  const name = (personName ?? "").trim() && personName !== "you" ? `${personName!.trim().split(/\s+/)[0]}, h` : "H";
  const list = (ls: MoneyLine[]) => (ls.length ? ` ${ls.slice(0, 6).map((l) => `${l.label} ${rand(l.amount)}`).join(", ")}${ls.length > 6 ? ", and the rest" : ""}.` : " Nothing on the statement fits here.");
  const parts = [
    `${name}ere's your month in three pots, from your ${DOC_LABEL[read.doc]} (${rand(b.income)} in):`,
    "",
    `Pot 1, what must be paid the day money lands: ${rand(b.fixed.total)}.${list(b.fixed.lines)}`,
    `Pot 2, food, transport, airtime: ${rand(b.living.total)}.${list(b.living.lines)}`,
    `Pot 3, what's left after those${b.fees ? ` and ${rand(b.fees)} of bank fees` : ""}: ${b.left >= 0 ? rand(b.left) : `short by ${rand(-b.left)}`}.`,
  ];
  if (b.left < 0) {
    parts.push("", "The month does not fit the money yet: pots 1 and 2 cost more than comes in. That is the first thing to fix, and the plan starts there. Nothing new gets borrowed to close it.");
  } else {
    if (b.loose > 0) parts.push("", `Last month ${rand(b.loose)} of it went to cash and other things. That is the pot the plan works on.`);
    if (b.putAway) parts.push("", `If ${rand(b.putAway)} of pot 3 moved to a savings pocket on the day money lands, it would be out of reach before the month gets to it. Your numbers, your call.`);
  }
  if (b.costliest) parts.push("", `${b.costliest.label} at ${rand(b.costliest.amount)} is the costliest line here. The plan's steps on what you owe are about it.`);
  return parts.join("\n");
}
