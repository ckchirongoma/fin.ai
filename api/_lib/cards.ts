// Charles — cards: small pages a person opens from a WhatsApp link and plays
// with on their phone, and the picture of each that goes into the chat.
//
// Five kinds, every one built from the person's own figures and nothing else:
//
//   month      Your month in three pots. Move money, stop a line, see what 90
//              days adds up to. From the statement they sent (statement.ts).
//   debt       When is it gone? What they owe and what they pay a week, both
//              editable, and the week the balance hits zero. R50 more a week,
//              and how many weeks sooner.
//   map        The Money Map: eight areas red, amber or green, each with its
//              note and what "sorted" would mean, the steps done, the day of
//              the ninety they are on.
//   statement  What the statement says: in against out, the biggest lines,
//              the fees, the days below zero.
//   goal       R1,000 by Christmas: how much per payday gets there, and when.
//
// Three rules hold the whole file together.
//   1. No model writes a card. Every number on a page is one the person gave,
//      one a statement showed, or arithmetic on those (rule 10). The debt card
//      has an interest field and leaves it EMPTY: Charles never invents a rate.
//   2. Nothing on a card identifies the person. No phone number, no account
//      number (statement.ts already dropped it), no surname. A card link is a
//      long random token, stored as a hash, good for sixty days, and deleted
//      with the household ("forget my money", db.ts forgetBusiness).
//   3. A card never recommends credit (rule 11). The debt card shows how a
//      payment ends a debt; it never shows a loan to end a loan.
//
// The pages are plain HTML with inline CSS and a little script, no library,
// no tracking, no cookies, and they render inside WhatsApp's in-app browser.
// Rule 8 (tables and inline hex) is for the plan document, which has to
// survive a printer and an email client; a card runs in a real browser, so
// it may use flex and a script. The picture is the same page, rendered by the
// same Chromium that makes the PDF (pdf.ts htmlToPng), 420 pixels wide.

import { db } from "./db.js";
import { env } from "./env.js";
import { hashSecret, mintToken } from "./crypto.js";
import { greenMeans } from "./moneymap.js";
import { budgetFromStatement, loanLines, rand, type StatementRead } from "./statement.js";
import { figuresFrom } from "./grounding.js";
import { track } from "./track.js";
import { DOMAIN_LABELS, type Business, type MapEntry, type PlanRow, type PlanStepRow } from "./types.js";

export type CardKind = "month" | "debt" | "map" | "statement" | "goal" | "memory";
export const CARD_KINDS: CardKind[] = ["month", "debt", "map", "statement", "goal", "memory"];

export const CARD_TITLE: Record<CardKind, string> = {
  month: "Your month in three pots",
  debt: "When is it gone?",
  map: "Your Money Map",
  statement: "What your statement says",
  goal: "Getting to the number",
  memory: "What Charles knows",
};

/** How long a link works. The page holds a snapshot; a new link is a new snapshot. */
export const CARD_DAYS = 60;

// ── Data: what each card is built from ───────────────────────────

export interface MonthCard {
  name: string | null;
  period: string | null;
  income: number;
  fixed: { label: string; amount: number }[];
  living: { label: string; amount: number }[];
  loose: { label: string; amount: number }[];
  fees: number;
  left: number;
  putAway: number | null;
  costliest: { label: string; amount: number } | null;
}

export interface DebtCard {
  name: string | null;
  label: string;
  owed: number | null;
  perWeek: number | null;
  /** The rule they chose, if it is about borrowing: printed under the result. */
  rule: string | null;
}

export interface MapCard {
  name: string | null;
  areas: { domain: string; label: string; status: "red" | "amber" | "green"; note: string; green: string }[];
  steps: { done: number; skipped: number; total: number; current: string | null };
  /** Day 1 to 90 of the plan, or null before a plan exists. */
  day: number | null;
  /** Days (1-based) on which a step was marked done. */
  doneDays: number[];
  goal: string | null;
}

export interface StatementCard {
  name: string | null;
  doc: string;
  period: string | null;
  source: string | null;
  in: number | null;
  out: number | null;
  fees: number | null;
  cash: number | null;
  closing: number | null;
  belowZero: number | null;
  inLines: { label: string; amount: number; day: number | null; times?: number }[];
  outLines: { label: string; amount: number; kind: string; times?: number }[];
  flags: string[];
}

export interface GoalCard {
  name: string | null;
  label: string;
  target: number | null;
  perPay: number | null;
  /** How often money lands: 4 a month for weekly pay, 1 for monthly. */
  paysPerMonth: 1 | 2 | 4;
  deadline: string | null;
}

/** The household knowledge graph (graph.ts), as the memory card draws it. */
export interface MemoryCard {
  name: string | null;
  items: { group: string; label: string; line: string; from: string; closed: boolean }[];
}

export type CardData = { month: MonthCard; debt: DebtCard; map: MapCard; statement: StatementCard; goal: GoalCard; memory: MemoryCard };

const first = (name: string | null | undefined): string | null => {
  const n = (name ?? "").trim();
  return n && n.toLowerCase() !== "you" ? n.split(/\s+/)[0]! : null;
};

/** The person's first name, from the identity Charles established (never a surname, never a number). */
export const cardName = (biz: Pick<Business, "identity" | "context" | "answers">): string | null =>
  first(biz.identity?.name ?? biz.context?.name ?? biz.answers?.person?.split(/[,.]/)[0] ?? null);

export function monthCardData(biz: Pick<Business, "identity" | "context" | "answers" | "statement">): MonthCard | null {
  const read = biz.statement;
  if (!read) return null;
  const b = budgetFromStatement(read);
  if (!b) return null;
  const pick = (ls: { label: string; amount: number }[]) => ls.map((l) => ({ label: l.label, amount: l.amount }));
  return {
    name: cardName(biz),
    period: read.period,
    income: b.income,
    fixed: pick(b.fixed.lines),
    living: pick(b.living.lines),
    loose: pick(read.money_out.filter((l) => l.kind === "cash" || l.kind === "transfer" || l.kind === "other")),
    fees: b.fees,
    left: b.left,
    putAway: b.putAway,
    costliest: b.costliest ? { label: b.costliest.label, amount: b.costliest.amount } : null,
  };
}

/**
 * What they owe and what they pay a week, from the statement's loan line
 * when there is one, else from their own words ("R200 a week on R800"): the
 * figure next to "a week" is the payment, the larger of the rest is the
 * debt. Anything not found is left empty for them to type on the page.
 */
export function debtCardData(biz: Pick<Business, "identity" | "context" | "answers" | "statement" | "rule">): DebtCard {
  const loan = biz.statement ? loanLines(biz.statement).sort((a, b) => b.amount - a.amount)[0] : null;
  const words = `${biz.answers?.objective ?? ""} ${biz.answers?.owes ?? ""} ${biz.context?.owes ?? ""}`;
  const weekly = /R\s?([\d,]+(?:\.\d+)?)\s*(?:a|per|every|each)\s+week/i.exec(words);
  const perWeek = weekly ? Number(weekly[1]!.replace(/,/g, "")) : loan?.times && loan.times >= 2 ? Math.round(loan.amount / loan.times) : null;
  const figures = [...figuresFrom(words)].filter((n) => n !== perWeek && n >= 50).sort((a, b) => b - a);
  const owed = figures[0] ?? null;
  const ruleText = biz.rule?.[0]?.rule ?? null;
  return {
    name: cardName(biz),
    label: loan?.label ?? (/mashonisa/i.test(words) ? "The mashonisa" : "What you owe"),
    owed,
    perWeek,
    rule: ruleText && /borrow|loan|mashonisa|owe/i.test(ruleText) ? ruleText : null,
  };
}

const DAY = 864e5;

export function mapCardData(biz: Pick<Business, "identity" | "context" | "answers" | "map" | "objective_read">, plan: { plan: PlanRow; steps: PlanStepRow[] } | null): MapCard | null {
  const map = (biz.map ?? []) as MapEntry[];
  if (!map.length) return null;
  const steps = plan?.steps ?? [];
  const started = plan?.plan.created_at ? Date.parse(String(plan.plan.created_at)) : NaN;
  const day = Number.isFinite(started) ? Math.max(1, Math.min(90, Math.floor((Date.now() - started) / DAY) + 1)) : null;
  const doneDays = Number.isFinite(started)
    ? [...new Set(steps.filter((s) => s.status === "done" && s.done_at).map((s) => Math.max(1, Math.min(90, Math.floor((Date.parse(String(s.done_at)) - started) / DAY) + 1))))].sort((a, b) => a - b)
    : [];
  const current = steps.find((s) => s.status === "open");
  return {
    name: cardName(biz),
    areas: map.map((m) => ({ domain: m.domain, label: DOMAIN_LABELS[m.domain] ?? m.domain, status: m.status, note: m.note, green: greenMeans(m.domain) })),
    steps: { done: steps.filter((s) => s.status === "done").length, skipped: steps.filter((s) => s.status === "skipped").length, total: steps.length, current: current?.title ?? null },
    day,
    doneDays,
    goal: plan?.plan.goal ?? biz.objective_read ?? null,
  };
}

export function statementCardData(biz: Pick<Business, "identity" | "context" | "answers" | "statement">): StatementCard | null {
  const r = biz.statement;
  if (!r) return null;
  return {
    name: cardName(biz),
    doc: r.doc,
    period: r.period,
    source: r.source,
    in: r.totals.in,
    out: r.totals.out,
    fees: r.totals.fees,
    cash: r.totals.cash,
    closing: r.totals.closing,
    belowZero: r.days_below_zero,
    inLines: r.money_in.map((l) => ({ label: l.label, amount: l.amount, day: l.day, ...(l.times ? { times: l.times } : {}) })),
    outLines: r.money_out.map((l) => ({ label: l.label, amount: l.amount, kind: l.kind ?? "other", ...(l.times ? { times: l.times } : {}) })),
    flags: r.flags,
  };
}

/** The target from the goal they chose ("R1,000 by Christmas") or their own words; empty when no figure was given. */
export function goalCardData(biz: Pick<Business, "identity" | "context" | "answers" | "goal" | "statement">): GoalCard {
  const chosen = biz.goal?.[0];
  const words = `${chosen?.worth ?? ""} ${chosen?.what ?? ""} ${biz.answers?.objective ?? ""}`;
  const target = [...figuresFrom(words)].filter((n) => n >= 100).sort((a, b) => b - a)[0] ?? null;
  const weekly = /\b(week|friday|piece|hustle|domestic)/i.test(`${biz.identity?.earns ?? ""} ${biz.answers?.income_kind ?? ""}`);
  const b = biz.statement ? budgetFromStatement(biz.statement) : null;
  return {
    name: cardName(biz),
    label: chosen?.label ?? "Your goal",
    target,
    perPay: b?.putAway ? (weekly ? Math.max(50, Math.floor(b.putAway / 4 / 10) * 10) : b.putAway) : null,
    paysPerMonth: weekly ? 4 : 1,
    deadline: /christmas|december/i.test(words) ? "Christmas" : null,
  };
}

// ── Links ────────────────────────────────────────────────────────

export const cardUrl = (token: string): string | null => (env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/c/${token}` : null);

/** Stores a snapshot and returns the link. Null when no public address is configured or the write failed. */
export async function mintCard<K extends CardKind>(businessId: string, kind: K, data: CardData[K]): Promise<{ url: string; token: string } | null> {
  if (!env.PUBLIC_BASE_URL) return null;
  const token = mintToken(24);
  const { error } = await db().from("cards").insert({
    business_id: businessId,
    kind,
    token_hash: hashSecret(token),
    data,
    expires_at: new Date(Date.now() + CARD_DAYS * DAY).toISOString(),
  });
  if (error) {
    console.warn("mintCard failed", error);
    track("card_failed", { category: "failure", props: { kind, phase: "mint" } });
    return null;
  }
  track("card_minted", { category: "behaviour", props: { kind } });
  return { url: cardUrl(token)!, token };
}

export interface StoredCard {
  kind: CardKind;
  data: unknown;
  business_id: string;
  expired: boolean;
}

export async function cardByToken(token: string): Promise<StoredCard | null> {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const { data } = await db().from("cards").select("kind, data, business_id, expires_at").eq("token_hash", hashSecret(token)).maybeSingle();
  const row = data as { kind: CardKind; data: unknown; business_id: string; expires_at: string } | null;
  if (!row) return null;
  const expired = Date.parse(row.expires_at) < Date.now();
  if (!expired) {
    void db()
      .from("cards")
      .update({ opened_at: new Date().toISOString() })
      .eq("token_hash", hashSecret(token))
      .then(({ error }) => void (error && console.warn("card: opened_at not recorded", error)), (err) => console.warn("card: opened_at not recorded", err));
  }
  return { kind: row.kind, data: row.data, business_id: row.business_id, expired };
}

// ── Demo data: Lerato, invented ──────────────────────────────────

export function demoCard(kind: CardKind): CardData[CardKind] {
  const name = "Lerato";
  switch (kind) {
    case "month":
      return {
        name, period: "1 Sep 2026 to 30 Sep 2026", income: 4820,
        fixed: [{ label: "Mashonisa (cash send)", amount: 800 }, { label: "Prepaid electricity", amount: 340 }, { label: "Edgars account", amount: 250 }, { label: "Old Mutual funeral cover", amount: 120 }],
        living: [{ label: "Shoprite", amount: 1480 }, { label: "Taxi", amount: 520 }, { label: "Vodacom airtime and data", amount: 310 }],
        loose: [{ label: "Cash withdrawals", amount: 900 }],
        fees: 68, left: 932, putAway: 450, costliest: { label: "Mashonisa (cash send)", amount: 800 },
      } satisfies MonthCard;
    case "debt":
      return { name, label: "The mashonisa", owed: 800, perWeek: 200, rule: "I borrow nothing from anyone for 90 days, however small." } satisfies DebtCard;
    case "map":
      return {
        name,
        areas: ([
          ["income", "amber", "Cash on Fridays and two grants, no payslip"],
          ["spending", "red", "Nothing written; month runs out on the 24th"],
          ["debt", "red", "A mashonisa and a clothing account"],
          ["cushion", "red", "Nothing put away"],
          ["credit_record", "amber", "The clothing account is on record"],
          ["protection", "amber", "A burial society, children not named"],
          ["family_money", "amber", "Mother helped some months"],
          ["goals", "red", "R1,000 named, nowhere to put it"],
        ] as [string, "red" | "amber" | "green", string][]).map(([domain, status, note]) => ({ domain, label: DOMAIN_LABELS[domain]!, status, note, green: greenMeans(domain) })),
        steps: { done: 2, skipped: 0, total: 7, current: "Get your card and ID back, and keep them" },
        day: 23,
        doneDays: [3, 11],
        goal: "Pay the R800 mashonisa off by day 60 and put the first R200 a week into a named pocket after that.",
      } satisfies MapCard;
    case "statement":
      return {
        name, doc: "bank_statement", period: "1 Sep 2026 to 30 Sep 2026", source: "Capitec",
        in: 4820, out: 4788, fees: 68, cash: 900, closing: 32, belowZero: 2,
        inLines: [{ label: "SASSA child support grant", amount: 1060, day: 3, times: 2 }, { label: "EFT from an employer", amount: 3600, day: 25 }, { label: "Cash deposit", amount: 160, day: 12 }],
        outLines: [
          { label: "Shoprite", amount: 1480, kind: "groceries", times: 6 }, { label: "Cash withdrawals", amount: 900, kind: "cash", times: 3 }, { label: "Mashonisa (cash send)", amount: 800, kind: "loan", times: 4 },
          { label: "Taxi", amount: 520, kind: "transport" }, { label: "Prepaid electricity", amount: 340, kind: "electricity" }, { label: "Vodacom airtime and data", amount: 310, kind: "airtime_data" },
          { label: "Edgars account", amount: 250, kind: "store_account" }, { label: "Old Mutual funeral cover", amount: 120, kind: "insurance" }, { label: "Bank fees", amount: 68, kind: "bank_fees" },
        ],
        flags: ["Debit order to Edgars returned unpaid on the 2nd"],
      } satisfies StatementCard;
    case "goal":
      return { name, label: "R1,000 by Christmas", target: 1000, perPay: 110, paysPerMonth: 4, deadline: "Christmas" } satisfies GoalCard;
    case "memory":
      return {
        name,
        items: [
          { group: "owes", label: "The mashonisa", line: "R200 a week, R800 owed", from: "you said, 30 Oct", closed: false },
          { group: "owes", label: "Edgars account", line: "R250 a month", from: "your statement", closed: false },
          { group: "earns_from", label: "SASSA child support grant", line: "R1,060 a month", from: "your statement", closed: false },
          { group: "earns_from", label: "EFT from an employer", line: "R3,600 a month", from: "your statement", closed: false },
          { group: "supports", label: "Children", line: "Supports", from: "setup answer", closed: false },
          { group: "supports", label: "My mother", line: "R300 a month", from: "you said, 2 Nov", closed: false },
          { group: "covered_by", label: "Old Mutual funeral cover", line: "R120 a month", from: "your statement", closed: false },
          { group: "member_of", label: "Burial society", line: "Member of", from: "setup answer", closed: false },
          { group: "banks_with", label: "Capitec", line: "Banks with", from: "your statement", closed: false },
          { group: "working_towards", label: "R1,000 by Christmas", line: "R1,000 in a place the month cannot reach", from: "you chose it", closed: false },
          { group: "owes", label: "Cellphone contract", line: "Paid off", from: "you said, 28 Oct", closed: true },
        ],
      } satisfies MemoryCard;
  }
}

// ── The page ─────────────────────────────────────────────────────

const esc = (s: unknown): string => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** JSON inside a <script>: no "</" can close the tag, no U+2028/2029 can break a line. */
const jsonForScript = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const CSS = `
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:#f3f5f4;color:#14181d;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,"Open Sans","Charles Symbols",sans-serif;font-size:16px;line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:440px;margin:0 auto;padding:14px 14px 28px}
.top{display:flex;align-items:center;gap:8px;margin:2px 0 14px}
.top .mark{display:inline-flex;align-items:center;gap:7px;text-decoration:none;color:#14181d}
.top .mark b{font-family:"Instrument Serif",Georgia,"Times New Roman",serif;font-weight:400;font-size:1.3rem;line-height:1}
.top .kind{margin-left:auto;font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:#0f766e;font-weight:600}
h1{font-family:"Instrument Serif",Georgia,"Times New Roman",serif;font-weight:400;font-size:2rem;line-height:1.02;letter-spacing:-.01em;margin:0 0 6px}
h1 em{font-style:italic;color:#0f766e}
h2{font-family:"Instrument Serif",Georgia,serif;font-weight:400;font-size:1.3rem;line-height:1.1;margin:0 0 8px}
.sub{color:#3a4149;font-size:.95rem;margin:0 0 14px}
.card{background:#fff;border:1px solid #dfe3e8;border-radius:18px;padding:16px;margin:0 0 12px}
.big{font-family:"Instrument Serif",Georgia,serif;font-size:2.6rem;line-height:1;letter-spacing:-.01em}
.big small{font-family:Inter,system-ui,sans-serif;font-size:.9rem;color:#6b737c;letter-spacing:0;margin-left:6px}
.row{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid #eef1f0;font-size:.93rem}
.row:first-child{border-top:0}
.row .l{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .n{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}
.bar{height:10px;border-radius:999px;background:#eef1f0;overflow:hidden;position:relative}
.bar i{display:block;height:100%;border-radius:999px;background:#0f766e;transition:width .25s ease}
.stack{display:flex;height:22px;border-radius:999px;overflow:hidden;margin:10px 0 8px;background:#eef1f0}
.stack span{display:block;height:100%;min-width:0;transition:width .25s ease}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:.8rem;color:#3a4149;margin:0 0 6px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.chip{display:inline-block;font-size:.78rem;font-weight:600;padding:4px 10px;border-radius:999px;background:#e6f2f0;color:#0b5a54;margin:0 6px 6px 0}
.chip.red{background:#fbe9e7;color:#8f1d16}.chip.amber{background:#fdf1e3;color:#8a4a0b}.chip.green{background:#e4f5ea;color:#145c35}
label.f{display:block;font-size:.8rem;color:#6b737c;margin:8px 0 4px}
input[type=number],input[type=text]{width:100%;font:inherit;font-size:1.05rem;padding:10px 12px;border:1px solid #cfd5da;border-radius:12px;background:#fff;color:#14181d}
input[type=range]{width:100%;accent-color:#0f766e;margin:6px 0}
.hint{font-size:.82rem;color:#6b737c;margin:6px 0 0}
.toggle{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid #eef1f0;font-size:.93rem}
.toggle input{width:20px;height:20px;accent-color:#0f766e;flex:none}
.toggle .l{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.toggle .n{font-variant-numeric:tabular-nums;font-weight:600}
.toggle.off .l,.toggle.off .n{text-decoration:line-through;color:#9aa3ac}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.tile{border:1px solid #dfe3e8;border-radius:14px;padding:12px 12px 10px;background:#fff;cursor:pointer;-webkit-tap-highlight-color:transparent}
.tile .d{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:7px;vertical-align:-1px}
.tile b{display:block;font-family:"Instrument Serif",Georgia,serif;font-weight:400;font-size:1.15rem;line-height:1.1;margin:0 0 4px}
.tile p{margin:0;font-size:.8rem;color:#3a4149;line-height:1.35}
.tile .more{display:none;margin-top:8px;padding-top:8px;border-top:1px dashed #dfe3e8;font-size:.78rem;color:#0b5a54}
.tile.open .more{display:block}
.tile.open{grid-column:1 / -1}
[data-i].on rect{fill:#e6f2f0}
.ring{display:flex;align-items:center;gap:14px}
.ring svg{flex:none}
.strip{display:grid;grid-template-columns:repeat(15,1fr);gap:3px;margin-top:10px}
.strip i{display:block;aspect-ratio:1;border-radius:3px;background:#eef1f0;border:1px solid #e3e7ea}
.strip i.d{background:#0f766e;border-color:#0f766e}
.strip i.t{background:#fff;border:2px solid #14181d}
.strip i.p{background:#dfe3e8}
.note{background:#fdf8ea;border-left:4px solid #ffd166;border-radius:10px;padding:10px 12px;font-size:.9rem;margin:10px 0 0}
.good{background:#e6f2f0;border-left:4px solid #0f766e;border-radius:10px;padding:10px 12px;font-size:.9rem;margin:10px 0 0}
.foot{font-size:.78rem;color:#6b737c;line-height:1.45;margin-top:14px}
.foot b{color:#3a4149;font-weight:600}
.btn{display:inline-block;background:#0f766e;color:#fff;text-decoration:none;font-weight:600;padding:12px 18px;border-radius:999px;font-size:.95rem;margin-top:8px}
.tap{font-size:.78rem;color:#6b737c;margin:6px 0 0}
svg text{font-family:Inter,system-ui,sans-serif}
.png .btn,.png .tap,.png input[type=range]{display:none}
`;

const DOT: Record<string, string> = { red: "#b3261e", amber: "#b45309", green: "#1f9d55" };
const WORD: Record<string, string> = { red: "Not sorted", amber: "Getting there", green: "Sorted" };

function shell(kind: CardKind, body: string, data: unknown, opts: { png?: boolean; demo?: boolean }): string {
  return `<!doctype html>
<html lang="en"${opts.png ? ' class="png"' : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#f3f5f4">
<title>${esc(CARD_TITLE[kind])} — Charles</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <a class="mark" href="/"><svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#0f766e"/><rect x="9" y="8" width="14" height="3" fill="#fff"/><rect x="9" y="15" width="10" height="3" fill="#fff"/><rect x="9" y="22" width="3" height="3" fill="#fff"/></svg><b>Charles</b></a>
    <span class="kind">${opts.demo ? "Demo · invented" : "Your figures"}</span>
  </div>
${body}
  <p class="foot"><b>Built from your own figures.</b> Charles teaches and plans with you: this is financial education, not financial advice, and nothing here is a loan recommendation. This page keeps nothing you type${opts.demo ? ". Every number on it is invented" : ""}.</p>
</div>
<script>var DATA=${jsonForScript(data)};var PNG=${opts.png ? "true" : "false"};</script>
<script>${SCRIPT[kind]}</script>
</body>
</html>`;
}

/** rand() in the browser: R4,820, R1,234.50. */
const JS_RAND = `function R(n){n=Math.round(n*100)/100;var neg=n<0;n=Math.abs(n);var w=Math.floor(n),c=Math.round((n-w)*100);var s=String(w).replace(/\\B(?=(\\d{3})+(?!\\d))/g,",");if(c)s+="."+(c<10?"0":"")+c;return (neg?"-":"")+"R"+s}
function $(id){return document.getElementById(id)}function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}`;

const SCRIPT: Record<CardKind, string> = {
  month: `${JS_RAND}
(function(){
  var d=DATA;var income=d.income;var fees=d.fees||0;
  var fixedT=d.fixed.reduce(function(a,l){return a+l.amount},0);
  var livingT=d.living.reduce(function(a,l){return a+l.amount},0);
  var stopped={};var put=d.putAway||0;
  function looseKept(){return d.loose.reduce(function(a,l,i){return a+(stopped[i]?0:l.amount)},0)}
  function looseStopped(){return d.loose.reduce(function(a,l,i){return a+(stopped[i]?l.amount:0)},0)}
  function render(){
    var left=income-fixedT-livingT-fees;var free=left+looseStopped();
    var pct=function(n){return Math.max(0,Math.min(100,n/income*100))+"%"};
    $("s-fixed").style.width=pct(fixedT);$("s-living").style.width=pct(livingT);$("s-fees").style.width=pct(fees);$("s-left").style.width=pct(Math.max(0,left));
    $("n-left").textContent=left>=0?R(left):"short by "+R(-left);
    var maxPut=Math.max(0,Math.floor(free/50)*50);var r=$("put");r.max=maxPut;if(put>maxPut)put=maxPut;r.value=put;
    $("n-put").textContent=R(put);$("n-90").textContent=R(put*3);$("n-after").textContent=R(Math.max(0,free-put));
    $("n-stopped").textContent=looseStopped()?("+ "+R(looseStopped())+" freed"):"";
    $("n-maxput").textContent=maxPut?("up to "+R(maxPut)):"nothing spare yet";
  }
  var r=$("put");r.addEventListener("input",function(){put=Number(r.value);render()});
  document.querySelectorAll(".toggle input").forEach(function(cb){cb.addEventListener("change",function(){var i=Number(cb.dataset.i);stopped[i]=!cb.checked;cb.closest(".toggle").classList.toggle("off",!cb.checked);render()})});
  render();
})();`,
  debt: `${JS_RAND}
(function(){
  var d=DATA;var owed=$("owed"),pay=$("pay"),rate=$("rate");
  if(d.owed!=null)owed.value=d.owed;if(d.perWeek!=null)pay.value=d.perWeek;
  function weeks(o,p,r){if(!(o>0)||!(p>0))return null;var bal=o,w=0,hist=[o];while(bal>0&&w<520){w++;if(r>0&&w%4===0){bal+=bal*r/100}bal-=p;hist.push(Math.max(0,bal))}return bal>0?{never:true,hist:hist}:{weeks:w,hist:hist,paid:w*p}}
  function render(){
    var o=Number(owed.value),p=Number(pay.value),r=Number(rate.value)||0;var out=weeks(o,p,r);
    var big=$("n-weeks"),when=$("n-when"),cost=$("n-cost"),more=$("n-more"),svg=$("chart");
    if(!out){big.textContent="—";when.textContent="Type what you owe and what you pay a week.";cost.textContent="";more.style.display="none";svg.innerHTML="";return}
    if(out.never){big.textContent="Never";when.textContent="At "+R(p)+" a week against "+r+"% a month, the balance never reaches zero. The payment has to be bigger than the interest.";cost.textContent="";more.style.display="none";svg.innerHTML="";return}
    var w=out.weeks;big.textContent=w+(w===1?" week":" weeks");
    var dt=new Date();dt.setDate(dt.getDate()+w*7);when.textContent="Gone by about "+dt.toLocaleDateString("en-ZA",{day:"numeric",month:"long",year:"numeric"})+" at "+R(p)+" a week.";
    cost.textContent=r>0?("You will have paid "+R(out.paid)+" in all, so "+R(out.paid-o)+" of it is interest."):"Interest is left blank, so this counts only what you pay. If you know the rate, type it and the picture changes.";
    var alt=weeks(o,p+50,r);var mt=alt&&!alt.never&&alt.weeks<w?("R50 more a week ("+R(p+50)+") and it is gone in "+alt.weeks+" weeks, "+(w-alt.weeks)+" sooner."):"";more.textContent=mt;more.style.display=mt?"block":"none";
    var W=380,H=110,PAD=6,n=out.hist.length,max=Math.max.apply(null,out.hist)||1;var pts=out.hist.map(function(v,i){return [PAD+(i/(n-1||1))*(W-2*PAD), 4+(1-v/max)*(H-8)]});
    var path="M"+pts.map(function(p){return p[0].toFixed(1)+","+p[1].toFixed(1)}).join(" L");
    svg.innerHTML='<path d="'+path+' L'+pts[pts.length-1][0]+','+H+' L'+PAD+','+H+' Z" fill="#e6f2f0"/><path d="'+path+'" fill="none" stroke="#0f766e" stroke-width="2.5" stroke-linejoin="round"/><circle cx="'+pts[0][0]+'" cy="'+pts[0][1]+'" r="4" fill="#14181d"/><circle cx="'+pts[pts.length-1][0]+'" cy="'+pts[pts.length-1][1]+'" r="4" fill="#0f766e"/><text x="'+PAD+'" y="'+(H+16)+'" font-size="11" fill="#6b737c">today · '+R(o)+'</text><text x="'+(W-PAD)+'" y="'+(H+16)+'" font-size="11" fill="#6b737c" text-anchor="end">week '+w+' · R0</text>';
  }
  [owed,pay,rate].forEach(function(i){i.addEventListener("input",render)});render();
})();`,
  map: `${JS_RAND}
(function(){
  document.querySelectorAll(".tile").forEach(function(t){t.addEventListener("click",function(){var open=t.classList.contains("open");document.querySelectorAll(".tile.open").forEach(function(o){o.classList.remove("open")});if(!open)t.classList.add("open")})});
})();`,
  statement: `${JS_RAND}
(function(){
  document.querySelectorAll(".row[data-detail]").forEach(function(r){r.addEventListener("click",function(){var el=r.nextElementSibling;if(el&&el.classList.contains("detail"))el.style.display=el.style.display==="block"?"none":"block"})});
})();`,
  goal: `${JS_RAND}
(function(){
  var d=DATA;var target=$("target"),per=$("per"),freq=$("freq");
  if(d.target!=null)target.value=d.target;if(d.perPay!=null)per.value=d.perPay;freq.value=String(d.paysPerMonth||1);
  function render(){
    var t=Number(target.value),p=Number(per.value),f=Number(freq.value)||1;var big=$("n-pays"),when=$("n-when"),jar=$("jar");
    if(!(t>0)||!(p>0)){big.textContent="—";when.textContent="Type the number and what you could put away each payday.";jar.style.height="0%";return}
    var n=Math.ceil(t/p);big.textContent=n+(n===1?" payday":" paydays");
    var dt=new Date();dt.setDate(dt.getDate()+Math.round(n*(30/f)));
    var line=R(p)+" each payday gets to "+R(t)+" by about "+dt.toLocaleDateString("en-ZA",{day:"numeric",month:"long",year:"numeric"})+".";
    if(d.deadline==="Christmas"){var now=new Date(),xmas=new Date(now.getFullYear(),11,25);if(xmas<now)xmas.setFullYear(xmas.getFullYear()+1);var paysLeft=Math.max(1,Math.floor((xmas-now)/864e5/(30/f)));var need=Math.ceil(t/paysLeft/10)*10;line+=dt>xmas?(" That is after Christmas. To be there by 25 December it needs about "+R(need)+" each payday, with "+paysLeft+" paydays left."):" That is before Christmas, which you named."}
    when.textContent=line;
    var pct=Math.min(100,(p*1)/t*100);jar.style.height=Math.max(8,pct)+"%";$("n-first").textContent="The first payday puts in "+Math.round(pct)+"% of it.";
  }
  [target,per,freq].forEach(function(i){i.addEventListener("input",render);i.addEventListener("change",render)});render();
})();`,
  memory: `${JS_RAND}
(function(){
  var det=$("detail");
  document.querySelectorAll("[data-i]").forEach(function(n){n.addEventListener("click",function(){var it=DATA.items[Number(n.getAttribute("data-i"))];if(!it)return;det.innerHTML='<b>'+esc(it.label)+'</b><br>'+esc(it.line)+'<br><span class="hint" style="display:inline">From '+esc(it.from)+(it.closed?' · paid off or stopped':'')+'</span>';det.style.display="block";document.querySelectorAll("[data-i]").forEach(function(o){o.classList.remove("on")});n.classList.add("on")})});
})();`,
};

const who = (name: string | null, fallback = "Your"): string => (name ? `${esc(name)}'s` : fallback);

function monthBody(d: MonthCard): string {
  const lines = (ls: { label: string; amount: number }[]) => ls.map((l) => `<div class="row"><span class="l">${esc(l.label)}</span><span class="n">${esc(rand(l.amount))}</span></div>`).join("");
  const loose = d.loose.length
    ? d.loose.map((l, i) => `<label class="toggle"><input type="checkbox" checked data-i="${i}"><span class="l">${esc(l.label)}</span><span class="n">${esc(rand(l.amount))}</span></label>`).join("")
    : `<p class="hint">The statement shows nothing loose: everything went to the first two pots.</p>`;
  return `
  <h1>${who(d.name)} month, in <em>three pots.</em></h1>
  <p class="sub">${esc(rand(d.income))} came in${d.period ? ` (${esc(d.period)})` : ""}. Every number here is from the statement. Slide, untick, and watch what is left.</p>
  <div class="card">
    <div class="stack"><span id="s-fixed" style="background:#14181d"></span><span id="s-living" style="background:#0f766e"></span><span id="s-fees" style="background:#b45309"></span><span id="s-left" style="background:#ffd166"></span></div>
    <div class="legend"><span><i style="background:#14181d"></i>Pot 1, must pay</span><span><i style="background:#0f766e"></i>Pot 2, food, transport, airtime</span><span><i style="background:#b45309"></i>Bank fees</span><span><i style="background:#ffd166"></i>What's left</span></div>
    <div class="big" id="n-left"></div><div class="hint">left after pots 1 and 2${d.fees ? ` and ${esc(rand(d.fees))} of fees` : ""}</div>
  </div>
  <div class="card">
    <h2>Pot 3: what could be put away on payday</h2>
    <input type="range" id="put" min="0" step="50" value="${d.putAway ?? 0}">
    <div class="row"><span class="l">Each payday</span><span class="n" id="n-put"></span></div>
    <div class="row"><span class="l">After 90 days (three months)</span><span class="n" id="n-90"></span></div>
    <div class="row"><span class="l">Still free in the month</span><span class="n" id="n-after"></span></div>
    <p class="hint">Slide it: <span id="n-maxput"></span>. <span id="n-stopped"></span></p>
    <p class="tap">Moved on the day money lands, it is out of reach before the month gets to it.</p>
  </div>
  <div class="card">
    <h2>Pot 1: paid the day money lands</h2>${lines(d.fixed) || `<p class="hint">Nothing fixed on the statement.</p>`}
    ${d.costliest ? `<div class="note"><b>${esc(d.costliest.label)}</b> at ${esc(rand(d.costliest.amount))} is the costliest line here. The plan's steps on what you owe are about it.</div>` : ""}
  </div>
  <div class="card">
    <h2>Pot 2: food, transport, airtime</h2>${lines(d.living) || `<p class="hint">Nothing here on the statement.</p>`}
  </div>
  <div class="card">
    <h2>Loose: cash and other</h2>
    <p class="hint" style="margin:0 0 6px">Untick a line to see what stopping it would free.</p>${loose}
  </div>`;
}

function debtBody(d: DebtCard): string {
  return `
  <h1>${esc(d.label)}: when is it <em>gone?</em></h1>
  <p class="sub">Change either number and the week moves. Interest is blank on purpose: Charles never guesses a rate. If the lender told you one, type it.</p>
  <div class="card">
    <label class="f" for="owed">What you owe now (R)</label><input type="number" id="owed" inputmode="decimal" min="0" step="10" placeholder="800">
    <label class="f" for="pay">What you pay a week (R)</label><input type="number" id="pay" inputmode="decimal" min="0" step="10" placeholder="200">
    <label class="f" for="rate">Interest a month, if you know it (%)</label><input type="number" id="rate" inputmode="decimal" min="0" step="1" placeholder="leave blank if not sure">
  </div>
  <div class="card">
    <div class="big" id="n-weeks"></div>
    <p class="sub" id="n-when" style="margin-top:6px"></p>
    <svg id="chart" viewBox="0 0 380 130" width="100%" height="130" aria-label="The balance falling week by week" style="display:block;margin:8px 0 4px"></svg>
    <p class="hint" id="n-cost"></p>
    <div class="good" id="n-more" style="display:none"></div>
    ${d.rule ? `<div class="note">Your rule: <b>${esc(d.rule)}</b></div>` : ""}
  </div>
  <div class="card"><h2>What this never shows</h2><p class="hint" style="margin:0">A loan to end a loan. The way out of a debt is the payment on the day money lands, and nothing new borrowed. An unregistered lender cannot keep your card or ID, and cannot take you to court for the interest; the NCR consumer line is 0860 627 627.</p></div>`;
}

function mapBody(d: MapCard): string {
  const tiles = d.areas
    .map(
      (a) => `<div class="tile" role="button" tabindex="0"><span class="d" style="background:${DOT[a.status]}"></span><span class="chip ${a.status}" style="margin:0 0 6px">${WORD[a.status]}</span><b>${esc(a.label)}</b><p>${esc(a.note)}</p><div class="more"><b style="font-family:Inter,system-ui,sans-serif;font-size:.78rem;display:block;margin-bottom:3px">Sorted would mean</b>${esc(a.green)}</div></div>`,
    )
    .join("");
  const pct = d.steps.total ? Math.round((d.steps.done / d.steps.total) * 100) : 0;
  const r = 30, c = 2 * Math.PI * r;
  const ring = `<svg width="78" height="78" viewBox="0 0 78 78" aria-label="${pct}% of steps done"><circle cx="39" cy="39" r="${r}" fill="none" stroke="#eef1f0" stroke-width="9"/><circle cx="39" cy="39" r="${r}" fill="none" stroke="#0f766e" stroke-width="9" stroke-linecap="round" stroke-dasharray="${(c * pct) / 100} ${c}" transform="rotate(-90 39 39)"/><text x="39" y="44" text-anchor="middle" font-size="16" font-weight="600" fill="#14181d">${pct}%</text></svg>`;
  const done = new Set(d.doneDays);
  const strip = d.day
    ? `<div class="strip" aria-label="Ninety days">${Array.from({ length: 90 }, (_, i) => {
        const day = i + 1;
        const cls = done.has(day) ? "d" : day === d.day ? "t" : day < d.day! ? "p" : "";
        return `<i class="${cls}"></i>`;
      }).join("")}</div><p class="hint">Day ${d.day} of 90. Teal: a day a step got done. Outlined: today.</p>`
    : `<p class="hint">The ninety days start when the plan does.</p>`;
  const greens = d.areas.filter((a) => a.status === "green").length;
  return `
  <h1>${who(d.name)} Money <em>Map.</em></h1>
  <p class="sub">${greens} of 8 areas sorted. An area only moves when you show Charles it moved. Tap one to see what sorted would mean.</p>
  <div class="card ring">${ring}<div><div class="big">${d.steps.done}<small>of ${d.steps.total} steps done</small></div>${d.steps.current ? `<p class="hint" style="margin:4px 0 0">Now: ${esc(d.steps.current)}</p>` : ""}${d.steps.skipped ? `<p class="hint">${d.steps.skipped} skipped</p>` : ""}</div></div>
  <div class="grid">${tiles}</div>
  <div class="card" style="margin-top:12px"><h2>The ninety days</h2>${strip}${d.goal ? `<div class="good">${esc(d.goal)}</div>` : ""}</div>`;
}

const KIND_WORD: Record<string, string> = {
  debit_order: "debit order", loan: "loan", store_account: "store account", insurance: "cover", rent: "rent", electricity: "electricity", school: "school",
  stokvel: "stokvel", family: "family", airtime_data: "airtime and data", groceries: "groceries", transport: "transport", bank_fees: "bank fees", cash: "cash", transfer: "transfer", other: "other",
};
const KIND_COLOUR: Record<string, string> = { loan: "#b3261e", store_account: "#b3261e", bank_fees: "#b45309", cash: "#6b737c", groceries: "#0f766e", transport: "#0f766e", airtime_data: "#0f766e" };

function statementBody(d: StatementCard): string {
  const max = Math.max(d.in ?? 0, d.out ?? 0, 1);
  const bar = (n: number | null, colour: string) => `<div class="bar"><i style="width:${Math.round(((n ?? 0) / max) * 100)}%;background:${colour}"></i></div>`;
  const outMax = Math.max(...d.outLines.map((l) => l.amount), 1);
  const outs = [...d.outLines]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10)
    .map(
      (l) => `<div class="row" data-detail="1" style="display:block;cursor:pointer"><div style="display:flex;gap:10px"><span class="l">${esc(l.label)}${l.times ? ` <span class="hint" style="display:inline">×${l.times}</span>` : ""}</span><span class="n">${esc(rand(l.amount))}</span></div><div class="bar" style="margin-top:6px"><i style="width:${Math.round((l.amount / outMax) * 100)}%;background:${KIND_COLOUR[l.kind] ?? "#3a4149"}"></i></div></div><div class="detail hint" style="display:none;padding:2px 0 8px">${esc(KIND_WORD[l.kind] ?? l.kind)}${l.times ? `, ${l.times} payments of about ${esc(rand(l.amount / l.times))}` : ""}. ${Math.round((l.amount / (d.out || l.amount)) * 100)}% of what went out.</div>`,
    )
    .join("");
  const ins = d.inLines.map((l) => `<div class="row"><span class="l">${esc(l.label)}${l.times ? ` ×${l.times}` : ""}${l.day ? ` <span class="hint" style="display:inline">· day ${l.day}</span>` : ""}</span><span class="n">${esc(rand(l.amount))}</span></div>`).join("");
  const chips = [
    d.fees ? `<span class="chip amber">Bank fees ${esc(rand(d.fees))}</span>` : "",
    d.cash ? `<span class="chip">Cash drawn ${esc(rand(d.cash))}</span>` : "",
    d.belowZero ? `<span class="chip red">Below zero on ${d.belowZero} day${d.belowZero === 1 ? "" : "s"}</span>` : "",
    d.closing !== null ? `<span class="chip ${d.closing < 0 ? "red" : "green"}">${d.closing < 0 ? "Overdrawn" : "Left"} at the end ${esc(rand(Math.abs(d.closing)))}</span>` : "",
  ].join("");
  return `
  <h1>What ${d.name ? `${esc(d.name)}'s` : "your"} ${esc(d.doc.replace(/_/g, " "))} <em>says.</em></h1>
  <p class="sub">${[d.period, d.source].filter(Boolean).map(esc).join(", ") || "As read from the page"}. Tap a line to see its share.</p>
  <div class="card">
    <div class="row"><span class="l">In</span><span class="n">${d.in !== null ? esc(rand(d.in)) : "—"}</span></div>${bar(d.in, "#0f766e")}
    <div class="row"><span class="l">Out</span><span class="n">${d.out !== null ? esc(rand(d.out)) : "—"}</span></div>${bar(d.out, "#14181d")}
    <div style="margin-top:12px">${chips}</div>
  </div>
  <div class="card"><h2>Where it went</h2>${outs || `<p class="hint">No lines could be read.</p>`}</div>
  <div class="card"><h2>Where it came from</h2>${ins || `<p class="hint">No lines could be read.</p>`}</div>
  ${d.flags.length ? `<div class="card"><h2>The page also shows</h2>${d.flags.map((f) => `<div class="note">${esc(f)}</div>`).join("")}</div>` : ""}`;
}

function goalBody(d: GoalCard): string {
  return `
  <h1>${esc(d.label)}: getting to <em>the number.</em></h1>
  <p class="sub">What you put away each payday decides the date. Change either and watch the jar.</p>
  <div class="card" style="display:flex;gap:14px;align-items:center">
    <div style="flex:none;width:64px;height:92px;border:3px solid #14181d;border-top-width:6px;border-radius:8px 8px 14px 14px;position:relative;overflow:hidden;background:#fff"><div id="jar" style="position:absolute;left:0;right:0;bottom:0;height:0%;background:#0f766e;transition:height .3s ease"></div></div>
    <div><div class="big" id="n-pays"></div><p class="hint" id="n-first" style="margin:4px 0 0"></p></div>
  </div>
  <div class="card">
    <label class="f" for="target">The number (R)</label><input type="number" id="target" inputmode="decimal" min="0" step="50" placeholder="1000">
    <label class="f" for="per">Put away each payday (R)</label><input type="number" id="per" inputmode="decimal" min="0" step="10" placeholder="100">
    <label class="f" for="freq">How often money lands</label>
    <select id="freq" style="width:100%;font:inherit;font-size:1.05rem;padding:10px 12px;border:1px solid #cfd5da;border-radius:12px;background:#fff"><option value="4">Every week</option><option value="2">Twice a month</option><option value="1">Once a month</option></select>
    <p class="sub" id="n-when" style="margin:12px 0 0"></p>
  </div>
  <div class="card"><h2>Where it goes</h2><p class="hint" style="margin:0">Somewhere the month cannot reach: a named savings pocket in your bank's own app costs nothing and can be undone. Moved on the day money lands, before anything else is bought.</p></div>`;
}

const GROUP: Record<string, { title: string; colour: string }> = {
  owes: { title: "Owes", colour: "#b3261e" },
  earns_from: { title: "Money in", colour: "#0f766e" },
  supports: { title: "Supports", colour: "#7c3aed" },
  pays: { title: "Pays", colour: "#3a4149" },
  covered_by: { title: "Cover", colour: "#1d4ed8" },
  member_of: { title: "Belongs to", colour: "#b45309" },
  saves_in: { title: "Saves in", colour: "#15803d" },
  banks_with: { title: "Banks with", colour: "#14181d" },
  working_towards: { title: "Working towards", colour: "#0b5a54" },
  lives_by: { title: "Lives by", colour: "#0b5a54" },
};

/** The person in the middle, everything their money touches around them, a line to each. */
function memoryBody(d: MemoryCard): string {
  const items = d.items.slice(0, 14);
  // An ellipse taller than it is wide, with neighbours alternating between an
  // outer and an inner ring, so up to fourteen pills never touch on a phone.
  const W = 400, H = 470, cx = W / 2, cy = H / 2;
  const nodes = items
    .map((it, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(items.length, 1);
      const ring = items.length > 7 && i % 2 === 1 ? 0.7 : 1;
      const x = cx + 138 * (ring === 1 ? 1 : 0.88) * Math.cos(a), y = cy + 200 * ring * Math.sin(a);
      const g = GROUP[it.group] ?? { title: it.group, colour: "#3a4149" };
      const words = it.label.length > 16 ? `${it.label.slice(0, 15)}…` : it.label;
      const w = Math.max(60, Math.min(118, words.length * 6.4 + 18));
      const bx = Math.max(2, Math.min(W - w - 2, x - w / 2));
      return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${it.closed ? "#cfd5da" : g.colour}" stroke-width="${it.closed ? 1.2 : 2}"${it.closed ? ' stroke-dasharray="4 4"' : ""} opacity=".55"/>
<g data-i="${i}" style="cursor:pointer" role="button" tabindex="0" aria-label="${esc(it.label)}"><rect x="${bx.toFixed(1)}" y="${(y - 15).toFixed(1)}" width="${w.toFixed(1)}" height="30" rx="15" fill="#fff" stroke="${it.closed ? "#cfd5da" : g.colour}" stroke-width="2"/><text x="${(bx + w / 2).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="600" fill="${it.closed ? "#9aa3ac" : "#14181d"}"${it.closed ? ' text-decoration="line-through"' : ""}>${esc(words)}</text></g>`;
    })
    .join("");
  const centre = `<circle cx="${cx}" cy="${cy}" r="44" fill="#14181d"/><text x="${cx}" y="${cy + 6}" text-anchor="middle" font-size="17" font-weight="600" fill="#fff">${esc(d.name ?? "You")}</text>`;
  const groups = [...new Set(items.map((i) => i.group))];
  const legend = groups.map((g) => `<span><i style="background:${(GROUP[g] ?? { colour: "#3a4149" }).colour}"></i>${esc((GROUP[g] ?? { title: g }).title)}</span>`).join("");
  const list = groups
    .map(
      (g) =>
        `<div class="card"><h2>${esc((GROUP[g] ?? { title: g }).title)}</h2>${items
          .filter((i) => i.group === g)
          .map(
            (i) =>
              `<div class="row" style="display:block"><div style="display:flex;gap:10px"><span class="l"${i.closed ? ' style="text-decoration:line-through;color:#9aa3ac"' : ""}>${esc(i.label)}</span><span class="hint" style="margin:0;white-space:nowrap">${esc(i.from)}</span></div><div class="hint" style="margin:2px 0 0">${esc(i.line)}${i.closed ? " · paid off or stopped" : ""}</div></div>`,
          )
          .join("")}</div>`,
    )
    .join("");
  return `
  <h1>What Charles knows about ${d.name ? `${esc(d.name)}'s` : "your"} <em>money.</em></h1>
  <p class="sub">Everything your money touches, and where each thing came from: something you said, a setup answer, your statement, or your own AI. Tap one.</p>
  <div class="card" style="padding:10px 8px">
    <svg viewBox="0 0 ${W} ${H}" width="100%" aria-label="${esc(d.name ?? "You")} in the middle, linked to everything their money touches">${nodes}${centre}</svg>
    <div class="legend" style="padding:0 8px">${legend}</div>
    <div id="detail" class="good" style="display:none;margin:8px"></div>
  </div>
  ${list}
  <div class="card"><h2>If something is wrong</h2><p class="hint" style="margin:0">Tell Charles on WhatsApp in your own words ("I paid off Edgars", "it's R300 a week now") and the picture changes. Charles never keeps an ID, account or card number, and "forget my money" deletes all of it.</p></div>`;
}

/** The page for one card. `png` hides the controls so the picture is the state at load. */
export function cardHTML<K extends CardKind>(kind: K, data: CardData[K], opts: { png?: boolean; demo?: boolean } = {}): string {
  const body =
    kind === "month" ? monthBody(data as MonthCard)
    : kind === "debt" ? debtBody(data as DebtCard)
    : kind === "map" ? mapBody(data as MapCard)
    : kind === "statement" ? statementBody(data as StatementCard)
    : kind === "memory" ? memoryBody(data as MemoryCard)
    : goalBody(data as GoalCard);
  return shell(kind, body, data, opts);
}

/** "show me my map", "a picture of my month", "chart of what I owe": which card, if any. Whole message, short. */
export const CARD_ASK = /^\s*(?:(?:can|could|will)\s+(?:you|u)\s+)?(?:please\s+)?(?:show|draw|send|give|make)\s+(?:me\s+)?(?:a\s+|the\s+|my\s+)?(?:picture|pic|image|chart|graph|page|card|visual|drawing)?\s*(?:of\s+)?(?:my\s+|the\s+)?(month|budget|pots|map|money\s+map|progress|debt|what\s+i\s+owe|mashonisa|loan|statement|goal|savings|target)\b[\s?!.]*$/i;

/** "What do you know about me?", "show me what you know", "my memory". */
export const MEMORY_ASK = /^\s*(?:(?:so\s+)?what\s+do\s+you\s+(?:know|remember)\s+about\s+(?:me|my\s+money|us)|(?:can\s+you\s+)?(?:show|tell)\s+me\s+what\s+you\s+(?:know|remember)(?:\s+about\s+(?:me|my\s+money))?|(?:show\s+me\s+)?(?:my\s+)?memory(?:\s+(?:map|graph|card))?|what\s+have\s+you\s+got\s+on\s+me)[\s?!.]*$/i;

export function cardKindAsked(said: string): CardKind | null {
  if (MEMORY_ASK.test(said)) return "memory";
  const m = CARD_ASK.exec(said);
  if (!m) return null;
  const w = m[1]!.toLowerCase().replace(/\s+/g, " ");
  if (/^(month|budget|pots)$/.test(w)) return "month";
  if (/^(map|money map|progress)$/.test(w)) return "map";
  if (/^(debt|what i owe|mashonisa|loan)$/.test(w)) return "debt";
  if (w === "statement") return "statement";
  return "goal";
}

/** What the WhatsApp line under a card says. */
export const CARD_CAPTION: Record<CardKind, string> = {
  month: "Your month in three pots. Tap to slide money between them and see what 90 days adds up to:",
  debt: "When it's gone. Change what you pay a week and watch the week move:",
  map: "Your Money Map. Tap an area to see what sorted would mean:",
  statement: "What your statement says, as a picture. Tap a line for its share:",
  goal: "Getting to the number. Change what you put away each payday and watch the date:",
  memory: "What I know about your money, and where each thing came from. Tap one for the detail, and tell me here if anything is wrong:",
};
