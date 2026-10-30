// Charles — the depth yardstick: how much a person can actually DO with what
// the library says, per country and per area.
//
// WHY THIS EXISTS
// kb-coverage.ts answers "did the library have a row for this question?". It
// cannot tell a row that names the agency, the portal, the fee with its date,
// the first step and the trap to avoid from a row that says "register your
// business, it's free". Both count as covered. The founder, round 23: every
// region must have great quality and depth in everything we cover, and we keep
// researching until it does — Uganda included, from its first day. This is
// the measurement, run the same way before and after any content is added, so
// "deeper" is a number and not a feeling.
//
// WHAT IT SCORES (all from seed/*.json — no database, no model, no network).
// Binary thresholds only, so padding a row past them earns nothing: depth is
// not length (prompts.ts REPLY_SCHEMA, "offer depth, don't dump it").
//
//   Knowledge row, 0-10:
//     steps4 / steps5   four and five concrete steps
//     concreteSteps     half the steps carry a number, a name or quoted words
//     summary40w        an owner_summary of 40+ words
//     appliesNotWhen    when it applies and when it does not, 3+ words each
//     costDepth (0-2)   2 a figure (money or %) or a plain "free"; 1 no figure
//                       but who sets the price and where to confirm it; 0 a
//                       vague "check" that leaves the person nowhere to go
//     localName         names a local body, portal or brand (one used in at
//                       most two markets — not a global brand)
//     todayAction       the first step is something to do
//     watchOut          one caution, condition or deadline
//
//   Tool row, 0-10 — the part the model reads (tSheet) and the part the person
//   gets in the walkthrough:
//     walk5, walkConcrete, walkWords80, setup3, tenMin (ten_minute_action),
//     costDepth (0-2), localName, fitNotWhen, informal (informal_business_supported set)
//
//   Per benchmark question (the four sets kb-coverage scores): SHALLOW when
//   every row that answers it scores below 6 (knowledge) / 7 (tool).
//
// Usage:
//   node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/kb-depth.ts [--json] [--country UG] [--shallow]

import { fileURLToPath } from "node:url";
import { COUNTRIES, DOMAINS, loadInputs, type BenchmarkQuestion, type CoverageInput } from "./kb-coverage.ts";
import { keywordScore, scoreRow, shortlist } from "../api/_lib/retrieval.js";
import { moneyIn } from "../api/_lib/grounding.js";
import type { KnowledgeRow, ToolRow } from "../api/_lib/types.js";

const words = (s: string | null | undefined): number => (s ?? "").trim().split(/\s+/).filter(Boolean).length;
const PCT_RE = /\d+(?:\.\d+)?\s?%/g;
/** Money amounts (any of the five currencies) and percentages. */
export const figures = (s: string | null | undefined): number => moneyIn(s ?? "").length + ((s ?? "").match(PCT_RE)?.length ?? 0);
const FREE_LEAD = /^\s*(?:free\b|no (?:setup |registration |sign-?up |monthly |joining )?(?:fees?|charges?|cost)\b|nothing to pay\b|costs? nothing\b)/i;
const HEDGE_RE = /\b(varies|vary|confirm|check|depends?|not (?:clearly )?published|not verified|quote|ask|set by)\b/i;

const ACR_STOP = new Set(["AND", "NOT", "STATE", "STOP", "BEST", "UPDATED", "LOCAL", "INDIVIDUAL", "SUPPLIER", "REGISTRATION", "TOP", "NEW", "IT", "US", "OR", "THE", "FREE", "NO", "YES", "ID", "QR", "SMS", "PDF", "OK", "POS", "ATM", "PIN", "CV", "FAQ", "API", "CRM", "URL", "USD", "GBP", "EUR", "KES", "NGN", "GHS", "ZAR", "UGX", "VAT", "TIN", "LPO", "SME", "SMEs", "MSME", "B2B", "EFT", "DM", "DMs", "TV", "AM", "PM", "NB", "II", "III"]);
// Country names, demonyms, months and the menu and column words a walkthrough
// quotes are not local names: "sell in Nigeria" or "tap Accept" names nothing an
// owner could look up (review, round 23: 18 rows were scored local on them).
const GEO_UI_STOP = ["Nigeria", "Nigerian", "Nigerians", "Ghana", "Ghanaian", "Ghanaians", "Kenya", "Kenyan", "Kenyans", "Uganda", "Ugandan", "Ugandans", "South", "Africa", "African", "Africans", "Canadian", "Canada", "Australia", "Australian", "Netherlands", "Dutch", "America", "American", "Europe", "European", "Rand", "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov", "Dec", "Accept", "Owed", "Prices", "Price", "Name", "Item", "Items", "Professional", "Year", "Paid", "Pay", "Type", "Get", "Create", "Request", "Shop", "Buy", "Sign", "Download", "Publish", "Connect", "Payment", "Payments", "Sales", "Start", "Cash", "Transfer", "Stats", "Other", "Manager", "Help", "Bill", "Money", "Form", "Settings", "Add", "New", "Open", "Tap", "Choose", "Select", "Enter", "Send", "Confirm", "Submit", "Search", "Menu", "Home", "Account", "Business"];
const NAME_STOP = new Set([...GEO_UI_STOP, "WhatsApp", "Status", "Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December", "Business", "Pro", "Free", "Basic", "Starter", "Growth", "Settings", "Tools", "Save", "Done", "Next", "Home", "Profile", "Instagram", "Facebook", "TikTok", "Google", "Excel", "Android", "iPhone", "English"]);

/**
 * Names a person could look up: acronyms (URSB, KRA, CIPC), CamelCase brands
 * (eCitizen, MoMoPay, M-Pesa), domains (ura.go.ug), USSD codes (*165#), and a
 * capitalised run straight after a lower-case word ("on Jiji", "the Hustler
 * Fund"). Fields must be joined with " | ": joined with spaces, every step's
 * first word ("Stop", "Pick") reads as a proper noun.
 */
export function named(s: string): string[] {
  const out = new Set<string>();
  for (const m of s.matchAll(/\b[A-Z][A-Z0-9&]{1,}[a-z]?\b/g)) if (!ACR_STOP.has(m[0]) && !/^[A-Z]\d+$/.test(m[0])) out.add(m[0]);
  for (const m of s.matchAll(/\b(?:[a-z]+[A-Z][A-Za-z]*|[A-Z][a-z]+[A-Z][A-Za-z]*|[A-Z]-[A-Z][a-z]+)\b/g)) if (m[0] !== "WhatsApp") out.add(m[0]);
  for (const m of s.matchAll(/\b[a-z0-9-]+\.(?:go\.ke|co\.ke|or\.ke|gov\.ng|com\.ng|gov\.gh|org\.gh|com\.gh|gov\.za|org\.za|co\.za|go\.ug|co\.ug|or\.ug|com|org|ng|gh|ke|ug|io|me)\b/g)) out.add(m[0]);
  for (const m of s.matchAll(/\*\d{2,4}(?:\*\d{1,4})*#/g)) out.add(m[0]);
  // A run made only of stop words ("South Africa", "South African") names
  // nothing local either (review, round 23).
  for (const m of s.matchAll(/(?<=[a-z0-9]\s)[A-Z][a-z]{2,}\b(?:\s(?:of|la|na)\s[A-Z][a-z]+\b|\s[A-Z][a-z]+\b)*/g)) if (!m[0].split(/\s+/).every((w) => NAME_STOP.has(w) || /^(?:of|la|na)$/.test(w))) out.add(m[0]);
  return [...out];
}

const IMPERATIVE = new Set(
  "ask pick write open go register send check take say list put call keep decide work count set start download add choose get make log find visit dial read use sign fill tell create post note apply collect gather compare search look print save record agree stop hold request pay book reply share type buy plan test try follow raise file confirm contact text upload prepare draft join separate move charge quote give label answer turn price photograph snap install update clear name match greet offer cut track sort mark settle reverse report screenshot block forward hand walk ring phone switch fix tally copy paste map spend split cover budget withdraw deposit before after don't never only first today tonight this".split(" "),
);
const imperative = (s: string | undefined): boolean => IMPERATIVE.has((s ?? "").trim().split(/[\s,:]+/)[0]?.toLowerCase().replace(/[^a-z'-]/g, "") ?? "");
const specific = (s: string): boolean => /\d/.test(s) || named(s).length > 0 || /["“'‘][^"”'’]{6,}["”'’]/.test(s);
const WATCH_RE = /\b(never|don'?t|do not|scam|fake|fraud|penalt(?:y|ies)|fine[sd]?|late|interest|careful|watch|risk|avoid|warning|unless|only if|before you|deadline|by the \d|within \d+)\b/i;

/** Which countries use each name: "local" means this country's and at most one other's. */
export type Lexicon = Map<string, Set<string>>;
export function buildLexicon(knowledge: KnowledgeRow[], tools: ToolRow[]): Lexicon {
  const lex: Lexicon = new Map();
  const add = (n: string, c: string) => (lex.get(n) ?? lex.set(n, new Set()).get(n)!).add(c);
  for (const r of knowledge) for (const n of named([r.title, r.owner_summary, ...(r.steps ?? []), r.cost].join(" | "))) add(n, r.country);
  for (const r of tools) for (const n of named([r.name, r.why, r.setup, ...(r.walkthrough ?? []), r.cost, r.ten_minute_action ?? ""].join(" | "))) add(n, r.country);
  return lex;
}
const isLocal = (lex: Lexicon, n: string, c: string): boolean => (lex.get(n)?.has(c) ?? false) && lex.get(n)!.size <= 2;

/** 2 a figure or a plain "free"; 1 who sets the price and where to confirm it; 0 a vague hedge. */
export function costDepth(cost: string, freeType: string | null = null): number {
  if (figures(cost) > 0) return 2;
  if (/^\s*free(?: to (?:start|ask|use|chase|work out|file|invoice|request a reversal))?\.?\s*$/i.test(cost) || freeType === "FREE_FOREVER") return 2;
  // "free", "no fee to register", "costs nothing": a plain free, unless what
  // follows the lead says something is charged after all.
  const lead = FREE_LEAD.exec(cost);
  if (lead && !HEDGE_RE.test(cost) && !/\b(charges?|fees?|paid|apply)\b/i.test(cost.slice(lead[0].length))) return 2;
  if (named(cost).length || /\b(bank|branch|court|registry|insurer|assembly|county|council|district|network|lender|provider|app|website|portal|office|government|state|notice|programme|entry|offer|commission|agency|sacco|in writing)\b/i.test(cost)) return 1;
  return 0;
}

export interface RowDepth {
  id: string;
  country: string;
  domain: string;
  score: number;
  parts: Record<string, number>;
}

export function knowledgeDepth(r: KnowledgeRow, lex: Lexicon): RowDepth {
  const steps = r.steps ?? [];
  const nm = named([r.owner_summary, ...steps, r.cost].join(" | "));
  const parts: Record<string, number> = {
    steps4: steps.length >= 4 ? 1 : 0,
    steps5: steps.length >= 5 ? 1 : 0,
    concreteSteps: steps.length && steps.filter(specific).length / steps.length >= 0.5 ? 1 : 0,
    summary40w: words(r.owner_summary) >= 40 ? 1 : 0,
    appliesNotWhen: words(r.applies_when) >= 3 && words(r.not_when) >= 3 ? 1 : 0,
    costDepth: costDepth(r.cost ?? ""),
    localName: nm.some((n) => isLocal(lex, n, r.country)) ? 1 : 0,
    todayAction: imperative(steps[0]) ? 1 : 0,
    watchOut: WATCH_RE.test([r.owner_summary, ...steps].join(" | ")) ? 1 : 0,
  };
  return { id: r.id, country: r.country, domain: r.domain ?? "(none)", parts, score: Object.values(parts).reduce((a, b) => a + b, 0) };
}

export function toolDepth(r: ToolRow, lex: Lexicon): RowDepth {
  const walk = r.walkthrough ?? [];
  const nm = named([r.why, r.setup, ...walk, r.cost, r.ten_minute_action ?? ""].join(" | "));
  const parts: Record<string, number> = {
    walk5: walk.length >= 5 ? 1 : 0,
    walkConcrete: walk.length && walk.filter(specific).length / walk.length >= 0.5 ? 1 : 0,
    walkWords80: walk.reduce((s, x) => s + words(x), 0) >= 80 ? 1 : 0,
    setup3: (r.setup ?? "").split(/→|->/).filter((x) => x.trim()).length >= 3 ? 1 : 0,
    tenMin: (r.ten_minute_action ?? "").trim().length > 20 ? 1 : 0,
    costDepth: costDepth(r.cost ?? "", r.free_type ?? null),
    localName: nm.some((n) => isLocal(lex, n, r.country)) ? 1 : 0,
    fitNotWhen: words(r.fits) >= 5 && words(r.not_when) >= 3 ? 1 : 0,
    informal: r.informal_business_supported === true || r.informal_business_supported === false ? 1 : 0,
  };
  return { id: r.id, country: r.country, domain: r.domain ?? "(none)", parts, score: Object.values(parts).reduce((a, b) => a + b, 0) };
}

export interface CellDepth {
  n: number;
  avg: number;
  min: number;
  /** Rows scoring 7 or more. */
  deep: number;
}

export interface CountryDepth {
  knowledge: CellDepth & { byDomain: Record<string, CellDepth>; atLeast8: number };
  tools: CellDepth & { byDomain: Record<string, CellDepth>; atLeast8: number };
  /** Benchmark questions answered only by shallow rows, per set (main, holdout). */
  shallowAnswers: Record<string, { answered: number; shallow: number; ids: string[] }>;
  shallowRows: { knowledge: RowDepth[]; tools: RowDepth[] };
}

export interface DepthReport {
  asOf: string;
  countries: Record<string, CountryDepth>;
  rows: { knowledge: RowDepth[]; tools: RowDepth[] };
}

const cell = (rows: RowDepth[]): CellDepth => ({
  n: rows.length,
  avg: rows.length ? rows.reduce((s, r) => s + r.score, 0) / rows.length : 0,
  min: rows.length ? Math.min(...rows.map((r) => r.score)) : 0,
  deep: rows.filter((r) => r.score >= 7).length,
});

const SHALLOW_K = 6;
const SHALLOW_T = 7;

export async function kbDepth(input: CoverageInput): Promise<DepthReport> {
  const lex = buildLexicon(input.knowledge, input.tools);
  const K = input.knowledge.map((r) => knowledgeDepth(r, lex));
  const T = input.tools.map((r) => toolDepth(r, lex));
  const kById = new Map(K.map((x) => [x.id, x]));
  const tById = new Map(T.map((x) => [x.id, x]));
  const sets: [string, BenchmarkQuestion[]][] = [
    ["main", input.questions],
    ["holdout", input.holdout ?? []],
  ];
  const countries: Record<string, CountryDepth> = {};
  for (const c of COUNTRIES) {
    const k = K.filter((x) => x.country === c);
    const t = T.filter((x) => x.country === c);
    const byDomain = (rows: RowDepth[]) => Object.fromEntries(DOMAINS.map((d) => [d, cell(rows.filter((x) => x.domain === d))]));
    const shallowAnswers: CountryDepth["shallowAnswers"] = {};
    const kRows = input.knowledge.filter((r) => r.country === c);
    const tRows = input.tools.filter((r) => r.country === c);
    for (const [set, qs] of sets) {
      const res = { answered: 0, shallow: 0, ids: [] as string[] };
      for (const q of qs) {
        // The same rule as kb-coverage's benchmark(): the top three rows, of
        // this country, in the question's domain, that its words reach.
        const query = { text: q.question, stage: q.stage };
        const sl = await shortlist(kRows, tRows, query, { country: c, semantic: false, log: false });
        const merged = [
          ...sl.knowledge.map((r) => ({ id: r.id, kind: "k" as const, country: r.country, domain: r.domain, s: scoreRow(r, query), kw: keywordScore(r, query) })),
          ...sl.tools.map((r) => ({ id: r.id, kind: "t" as const, country: r.country, domain: r.domain, s: scoreRow(r, query), kw: keywordScore(r, query) })),
        ]
          .sort((a, b) => b.s - a.s || b.kw - a.kw || a.id.localeCompare(b.id))
          .slice(0, 3);
        const hits = merged.filter((r) => r.country === c && r.domain === q.domain && r.kw > 0);
        if (!hits.length) continue;
        res.answered++;
        const shallow = hits.every((h) => (h.kind === "k" ? kById.get(h.id)!.score < SHALLOW_K : tById.get(h.id)!.score < SHALLOW_T));
        if (shallow) {
          res.shallow++;
          res.ids.push(q.id);
        }
      }
      shallowAnswers[set] = res;
    }
    countries[c] = {
      knowledge: { ...cell(k), byDomain: byDomain(k), atLeast8: k.filter((x) => x.score >= 8).length },
      tools: { ...cell(t), byDomain: byDomain(t), atLeast8: t.filter((x) => x.score >= 8).length },
      shallowAnswers,
      shallowRows: { knowledge: k.filter((x) => x.score < SHALLOW_K).sort((a, b) => a.score - b.score), tools: t.filter((x) => x.score < SHALLOW_T).sort((a, b) => a.score - b.score) },
    };
  }
  return { asOf: (input.asOf ?? new Date()).toISOString().slice(0, 10), countries, rows: { knowledge: K, tools: T } };
}

const f1 = (n: number): string => (Math.round(n * 10) / 10).toFixed(1);

export function renderDepthText(r: DepthReport, opts: { country?: string; shallow?: boolean } = {}): string {
  const C = (COUNTRIES as readonly string[]).filter((c) => !opts.country || c === opts.country);
  const table = (head: string[], rows: string[][]): string => {
    const all = [head, ...rows];
    const w = head.map((_, i) => Math.max(...all.map((x) => x[i]!.length)));
    const line = (x: string[]) => "| " + x.map((v, i) => v.padEnd(w[i]!)).join(" | ") + " |";
    return [line(head), "|" + w.map((n) => "-".repeat(n + 2)).join("|") + "|", ...rows.map(line)].join("\n");
  };
  const out: string[] = [`# Knowledge-base depth, as of ${r.asOf}`, ""];
  out.push(
    table(
      ["", ...C],
      [
        ["knowledge rows", ...C.map((c) => String(r.countries[c]!.knowledge.n))],
        ["knowledge depth avg /10", ...C.map((c) => f1(r.countries[c]!.knowledge.avg))],
        ["knowledge depth min", ...C.map((c) => String(r.countries[c]!.knowledge.min))],
        ["knowledge rows ≥8", ...C.map((c) => `${r.countries[c]!.knowledge.atLeast8}/${r.countries[c]!.knowledge.n}`)],
        ["tool rows", ...C.map((c) => String(r.countries[c]!.tools.n))],
        ["tool depth avg /10", ...C.map((c) => f1(r.countries[c]!.tools.avg))],
        ["tool depth min", ...C.map((c) => String(r.countries[c]!.tools.min))],
        ["tool rows ≥8", ...C.map((c) => `${r.countries[c]!.tools.atLeast8}/${r.countries[c]!.tools.n}`)],
        ...["main", "holdout"].map((s) => [`shallow answers (${s})`, ...C.map((c) => `${r.countries[c]!.shallowAnswers[s]!.shallow}/${r.countries[c]!.shallowAnswers[s]!.answered}`)]),
      ],
    ),
  );
  out.push("", "## Knowledge depth by area: avg / deep rows (≥7) / rows");
  out.push(table(["area", ...C], DOMAINS.map((d) => [d, ...C.map((c) => { const x = r.countries[c]!.knowledge.byDomain[d]!; return x.n ? `${f1(x.avg)} / ${x.deep} / ${x.n}` : "— / 0 / 0"; })])));
  out.push("", "## Tool depth by area: avg / deep rows (≥7) / rows");
  out.push(table(["area", ...C], DOMAINS.map((d) => [d, ...C.map((c) => { const x = r.countries[c]!.tools.byDomain[d]!; return x.n ? `${f1(x.avg)} / ${x.deep} / ${x.n}` : "— / 0 / 0"; })])));
  if (opts.shallow) {
    out.push("", "## Shallow rows — the research to-do list");
    for (const c of C) {
      const s = r.countries[c]!.shallowRows;
      for (const x of [...s.knowledge, ...s.tools]) out.push(`  ${c} ${x.domain} ${x.id} ${x.score}/10 — missing: ${Object.entries(x.parts).filter(([, v]) => !v).map(([k]) => k).join(", ")}`);
    }
  }
  return out.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const asOfArg = process.argv.indexOf("--as-of");
  const asOf = asOfArg > 0 ? new Date(process.argv[asOfArg + 1]!) : new Date();
  const countryArg = process.argv.indexOf("--country");
  const r = await kbDepth(loadInputs(asOf));
  if (process.argv.includes("--json")) console.log(JSON.stringify(r, null, 1));
  else console.log(renderDepthText(r, { country: countryArg > 0 ? process.argv[countryArg + 1] : undefined, shallow: process.argv.includes("--shallow") }));
}
