// Fin — signal capture: the cheap, automatic half of growing the library.
//
// Real conversations are the best evidence of where the knowledge base is
// wrong or thin — "that's not R699 anymore", "Yoco took three days, not one
// or two". This file notices those moments and writes ONE atomic, dated row
// per moment to `knowledge_signals` (db/0015). It never keeps a transcript,
// never summarises a conversation, and never changes `tools` or
// `knowledge_entries`: promotion to canonical fact is a separate, deliberate,
// agent-run research pass with a cited source (docs/PROMOTION-PASS.md).
//
// Cost discipline, because this runs on ordinary traffic forever:
//   - Which tool or entry a message is about is found by plain string
//     matching against the library's own names. No model.
//   - A deterministic pre-filter decides whether a message could possibly be
//     a correction or an outcome report. Most messages stop there, free.
//   - Only what passes gets ONE typed classification through judge() — the
//     same Jev noul / true-false backstop every guardrail uses. Two yes/no
//     propositions, no free generation, nothing written by a model.
//   - candidate_claim is composed in code from the classification and the
//     matched entity, never generated.

import { judge } from "./safety.js";
import { recordKnowledgeSignal, recordSafetyEvent, type SignalSource } from "./db.js";
import { moneyIn } from "./grounding.js";
import { track } from "./track.js";
import type { KnowledgeRow, ToolRow } from "./types.js";

type Entity = { type: "tool" | "knowledge_entry"; id: string; name: string };

/**
 * A person told us the library is wrong (a correction) or how a product
 * really went for them (an outcome report). A correction is a warning, so it
 * reaches the hourly email: Fin may be quoting a stale price to everyone
 * else. Recorded whether or not the knowledge_signals insert landed (`stored`);
 * the words are on the turn's turn_received, not repeated here.
 */
function trackSignal(type: "correction" | "outcome_report", entity: Entity | null, how: "rule" | "judged", engine: string, stored: boolean): void {
  track("knowledge_signal", {
    category: "behaviour",
    severity: type === "correction" ? "warn" : "info",
    props: { type, entity_type: entity?.type ?? null, entity_id: entity?.id ?? null, how, engine, stored },
    ...(type === "correction"
      ? {
          fingerprint: `knowledge_signal:correction:${entity?.id ?? "none"}`,
          summary: `A person says the library is wrong or out of date${entity ? ` about ${entity.name} (${entity.id})` : ""}`,
        }
      : {}),
  });
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What people actually call a tool, when that is not its catalogue name.
 * Whole-word, case-insensitive. Kept to brand names and unambiguous
 * phrases — never a common word like "till", "card" or "status".
 */
const TOOL_ALIASES: Record<string, string[]> = {
  gotyme_goalsave: ["goalsave", "goal save", "gotyme goalsave", "tyme goalsave"],
  gotyme_everyday: ["everyday account", "gotyme everyday", "gotyme account", "tymebank account", "tyme account"],
  payshap: ["payshap", "pay shap", "shap id", "shapid"],
  debicheck: ["debicheck", "debi check", "debit order"],
  transunion_free_report: ["transunion", "trans union"],
  experian_free_report: ["experian", "my credit check", "mycreditcheck"],
  xds_free_report: ["xds", "splendi"],
  ncr_debt_counsellor: ["debt counsellor", "debt counselor", "debt review", "ncr register"],
  ncr_complaint: ["ncr", "national credit regulator"],
  nfo_complaint: ["nfo", "ombud", "ombudsman", "national financial ombud"],
  safps_protective_registration: ["safps", "protective registration"],
  fsca_check: ["fsca", "licence check", "license check"],
  sassa_srd_online: ["srd", "srd grant", "r370", "r350", "sassa online"],
  sassa_office: ["sassa", "sassa office", "grant office"],
  ufiling_uif: ["uif", "ufiling", "u-filing", "unemployment fund"],
  sars_efiling: ["sars", "efiling", "e-filing", "sars mobiapp", "tax return"],
  tfsa_account: ["tfsa", "tax-free savings", "tax free savings"],
  nhfc_first_home_finance: ["flisp", "first home finance", "nhfc"],
  municipal_indigent_register: ["indigent", "indigent register", "free basic electricity"],
  cdc_register: ["council for debt collectors", "debt collector register"],
  nasasa_stokvel: ["nasasa", "stokvel"],
  bank_fraud_report: ["fraud line", "fraud desk", "report fraud"],
  saps_case: ["saps", "police case", "case number"],
  notes_money_log: ["notes app", "money log", "spend log"],
  sheets_budget: ["google sheets", "budget sheet", "spreadsheet"],
};

/** Catalogue names that are also ordinary English: only a capitalised mention counts. */
const COMMON_WORD_NAMES = new Set(["buffer", "sheets", "lovable", "canva", "pargo", "swoove", "kwik"]);

/**
 * The library row a message names, by its catalogue name, a known alias, or
 * a multi-word id ("yoco_capital"), whole-word. Tools first: people name
 * products ("Yoco"), rarely knowledge entries. Longest name wins, so "Yoco
 * Capital" beats "Yoco".
 */
export function matchEntity(text: string, tools: Pick<ToolRow, "id" | "name">[], knowledge: Pick<KnowledgeRow, "id" | "title">[] = []): Entity | null {
  const raw = ` ${text || ""} `;
  const t = raw.toLowerCase();
  const names: (Entity & { caseSensitive: boolean })[] = [];
  for (const tool of tools) {
    // "Sourcefin (purchase order funding)" is found by "Sourcefin"; "Google Sheets" by "Google Sheets".
    const base = tool.name.replace(/\s*\(.*\)\s*$/, "").trim();
    const candidates = new Set([base, ...(TOOL_ALIASES[tool.id] ?? [])]);
    if (tool.id.includes("_")) candidates.add(tool.id.replace(/_/g, " "));
    for (const n of candidates) {
      if (n.length < 3) continue;
      names.push({ type: "tool", id: tool.id, name: n, caseSensitive: COMMON_WORD_NAMES.has(n.toLowerCase()) });
    }
  }
  for (const k of knowledge) if (k.title && k.title.length >= 6) names.push({ type: "knowledge_entry", id: k.id, name: k.title, caseSensitive: false });
  names.sort((a, b) => b.name.length - a.name.length);
  for (const e of names) {
    const hay = e.caseSensitive ? raw : t;
    const needle = e.caseSensitive ? e.name[0]!.toUpperCase() + e.name.slice(1) : e.name.toLowerCase();
    if (new RegExp(`(^|[^A-Za-z0-9])${esc(needle)}([^A-Za-z0-9]|$)`).test(hay)) return { type: e.type, id: e.id, name: e.name };
  }
  return null;
}

const QUESTION = /\?\s*$|^\s*(how|what|when|where|why|who|which|can|could|should|do|does|did|is|are|will|would)\b/i;

/**
 * Could this possibly be a correction or an outcome report? It only decides
 * whether the one cheap classification runs, but every false yes is a paid
 * call. A question is never either (the classifier's own wording says so).
 * With no library row named, it needs a real money amount — "the CIPC fee
 * is R200 now" — not just any digit.
 */
const CUES = /\b(not|no longer|anymore|any more|actually|wrong|changed|now|charged|charges?|fees?|price|costs?|took|takes|days?|weeks?|hours?|worked|didn'?t|doesn'?t|won'?t|failed|rejected|approved|declined|tried|used|signed up|closed|shut|went up|gone up|goes up|increased|raised|dropped|went down|gone down|cut)\b|\d\s?%/i;
const MONEY = /\b(R|KShs?|KES|Kshs?|UGX|Ugx|ugx|UShs?|Ushs?|Shs?|NGN|GHS)\.?\s?\d|(₦|GH₵|\$)\s?\d|\d\/[=-]|\d\s?(?:UGX|ugx|Ushs?|UShs?|KES|GHS|NGN)\b/;
export function mightBeSignal(text: string, entity: Entity | null): boolean {
  const t = (text || "").trim();
  if (t.length < 12 || QUESTION.test(t)) return false;
  if (!entity) return MONEY.test(t) && CUES.test(t);
  return CUES.test(t) || MONEY.test(t);
}

/**
 * An unmistakable correction, with no judgement needed: a named product,
 * words that say something changed ("not … anymore", "went up", "now"),
 * and a percentage or money amount that the library's own row for that
 * product does not contain. "Yoco is not 2.3%
 * anymore, they charged me 2.9%" is exactly this: 2.9 is not in Yoco's row.
 */
// Only words that say a FACT moved. "now", "not" and "actually" were here
// and turned "I use Yoco now and sold R1200 today" into a correction: they
// belong to ordinary chatter, and anything that subtle is the judge's call.
const CHANGED = /\b(no longer|anymore|any more|changed|went up|gone up|goes up|increased|raised|dropped|went down|gone down|is now|are now|now charges?|now costs?)\b/i;
const PCT = /(\d+(?:[.,]\d+)?)\s?%/g;
const pcts = (x: string) => [...x.matchAll(PCT)].map((m) => Number(m[1]!.replace(",", ".")));
/** A money amount the person says the PRODUCT costs — not what they sold, made or paid for stock. */
const PRICED = /\b(fee|fees|charge[sd]?|charging|costs?|price[sd]?|subscription|rate|per month|a month|monthly|is now|are now)\b/i;
/**
 * Only figures of a kind the library row itself states can contradict it:
 * a percentage against its percentages, and a money amount against its money
 * amounts only when the sentence says it is a price. "took 3 days, not 1-2"
 * is an outcome report, and "sold R1200 today" is a sale — neither is a
 * correction of the row.
 */
export function obviousCorrection(text: string, entity: Entity | null, libraryFact: string | null): boolean {
  if (!entity || !libraryFact) return false;
  const libPct = new Set(pcts(libraryFact));
  const libMoney = new Set(moneyIn(libraryFact));
  // "…is R899 now, not R699" — negating the library's OWN figure is a
  // contradiction of the row in so many words.
  const negated = [...text.matchAll(/\bnot\s+(?:the\s+)?([^\s,;]+)/gi)].map((m) => m[1]!.replace(/[.]+$/, ""));
  const contradicts = negated.some((x) => moneyIn(x).some((m) => libMoney.has(m)) || pcts(x).some((p) => libPct.has(p)));
  if (!contradicts && !CHANGED.test(text)) return false;
  const newPct = pcts(text).some((p) => libPct.size > 0 && !libPct.has(p));
  const newMoney = (contradicts || PRICED.test(text)) && moneyIn(text).some((m) => libMoney.size > 0 && !libMoney.has(m));
  return newPct || newMoney;
}

/**
 * Runs AFTER the person has had their reply (never adds latency), on their
 * own words only. At most one typed judge() call; usually none.
 */
export async function captureConversationSignal(args: {
  text: string;
  source: SignalSource;
  businessId: string | null;
  country: string;
  tools: Pick<ToolRow, "id" | "name">[];
  knowledge?: Pick<KnowledgeRow, "id" | "title">[];
  /** What the library currently says about the matched row, so "is this a correction" has something to compare with. */
  libraryFact?: (entity: Entity) => string | null;
}): Promise<"correction" | "outcome_report" | null> {
  try {
    const entity = matchEntity(args.text, args.tools, args.knowledge ?? []);
    // Every decision leaves a row, so "why was nothing captured?" is a read,
    // not a guess (it was a guess on 2026-09-23: two live runs, zero signals,
    // and nothing on record to say whether anything was even considered).
    const note = (outcome: "pass" | "flag", detail: string, engine: "jev" | "model" | "none" = "none", score: number | null = null) =>
      recordSafetyEvent({ businessId: args.businessId, check: "knowledge_signal", engine, outcome, score, detail: `${detail}${entity ? ` [${entity.id}]` : ""}`.slice(0, 300) });

    if (!mightBeSignal(args.text, entity)) {
      await note("pass", entity ? "skipped: a question, or no sign of a change or a result" : "skipped: names no product and states no money amount");
      return null;
    }

    const stored = entity && args.libraryFact ? args.libraryFact(entity) : null;
    if (obviousCorrection(args.text, entity, stored)) {
      const wrote = await recordKnowledgeSignal({
        source: args.source,
        businessId: args.businessId,
        country: args.country,
        type: "correction",
        entity: { type: entity!.type, id: entity!.id },
        rawQuote: args.text,
        candidateClaim: `Says a stored fact is wrong or out of date — about ${entity!.name} (a figure the library doesn't have)`,
      });
      trackSignal("correction", entity, "rule", "none", wrote);
      await note("flag", `${wrote ? "captured" : "NOT captured (insert failed — see write_failed)"}: correction (rule: a changed figure for a named product; no judgement call)`);
      return wrote ? "correction" : null;
    }

    const { engine, verdicts, scores } = await judge(
      "knowledge_signal",
      { owner_message: args.text, library_row: entity ? { name: entity.name, what_the_library_says: stored } : null },
      {
        correction:
          "Does the person's message say that a specific, checkable fact about a named product, service, fee, rule or process is different from what is stated (or from what they were told) — a price, fee, timeframe, requirement or step that is wrong, changed or out of date? Opinions, questions and complaints are not corrections.",
        outcome_report:
          "Does the person's message report what actually happened when THEY used a specific product, service or step — how long it really took, what it really cost them, whether it worked or failed for them? Plans, intentions and questions are not reports.",
      },
      0.7,
      // Not a guardrail: if neither engine answers, that is not "advice went
      // out unchecked", so it must not raise the guardrails-down alarm.
      { businessId: args.businessId, notAGuardrail: true },
    );
    if (engine === "none") {
      await note("pass", "not judged: neither Jev nor the model backstop answered");
      return null;
    }
    const type = verdicts.correction ? "correction" : verdicts.outcome_report ? "outcome_report" : null;
    const detailScores = `correction=${scores.correction ?? (verdicts.correction ? "yes" : "no")} outcome_report=${scores.outcome_report ?? (verdicts.outcome_report ? "yes" : "no")}`;
    if (!type) {
      await note("pass", `judged neither (${detailScores}; needs > 0.7)`, engine, scores.correction ?? null);
      return null;
    }

    const wrote = await recordKnowledgeSignal({
      source: args.source,
      businessId: args.businessId,
      country: args.country,
      type,
      entity: entity ? { type: entity.type, id: entity.id } : null,
      rawQuote: args.text,
      candidateClaim: `${type === "correction" ? "Says a stored fact is wrong or out of date" : "Reports how it actually went"}${entity ? ` — about ${entity.name}` : ""}`,
    });
    trackSignal(type, entity, "judged", engine, wrote);
    await note("flag", `${wrote ? "captured" : "NOT captured (insert failed — see write_failed)"}: ${type} (${detailScores})`, engine, scores.correction ?? null);
    return wrote ? type : null;
  } catch (err) {
    console.warn("captureConversationSignal failed", err);
    await recordSafetyEvent({ businessId: args.businessId, check: "knowledge_signal", engine: "none", outcome: "flag", flags: ["capture_failed"], detail: `capture threw: ${(err as Error)?.message ?? String(err)}`.slice(0, 300) });
    return null;
  }
}
