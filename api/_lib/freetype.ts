// Charles — what "free" actually means for a tool.
//
// A flat cost string that starts "free" used to be the only signal, and it
// conflated very different claims: Yoco has no monthly fee but takes a cut of
// every card sale; Zoho Books is genuinely R0, but only while revenue stays
// under R1,000,000; a youth-fund loan has no interest but a 5% fee and must be
// repaid. Telling a person any of those is simply "free" is the kind of
// half-true fact CLAUDE.md rule 10 exists to stop. `tools.free_type`
// (db/0014_tools_ingestion.sql) names which kind of free — or not-free — a
// tool is, and every place a tool's cost reaches a person or a model leads
// with that category before the cost detail.
//
// No imports on purpose: plandoc.ts renders the plan PDF and must stay free of
// the database and retrieval modules.

export const FREE_TYPES = [
  "FREE_FOREVER",
  "FREE_TIER",
  "FREE_TRIAL",
  "FREE_FOR_QUALIFYING_USERS",
  "NO_MONTHLY_FEE",
  "PAY_PER_TRANSACTION",
  "GOVERNMENT_GRANT",
  "UNKNOWN",
] as const;

export type FreeType = (typeof FREE_TYPES)[number];

// Worded so the label never claims more than the stored cost text does: no
// "permanent", no amounts, no limits — those live in `cost`, with their own
// verification date. UNKNOWN has no label: the cost text speaks for itself,
// and a paid subscription (which has no value of its own in this list) is
// UNKNOWN, so it can never be labelled free.
const LABELS: Record<FreeType, string | null> = {
  FREE_FOREVER: "Free to use",
  FREE_TIER: "Free plan with limits; paid plans above it",
  FREE_TRIAL: "Free trial only, then paid",
  FREE_FOR_QUALIFYING_USERS: "Free only if you qualify",
  NO_MONTHLY_FEE: "No monthly fee, but you pay when you use it",
  PAY_PER_TRANSACTION: "You pay a fee each time you use it",
  GOVERNMENT_GRANT: "Public funding you don't repay",
  UNKNOWN: null,
};

export const isFreeType = (v: unknown): v is FreeType => typeof v === "string" && (FREE_TYPES as readonly string[]).includes(v);

export function freeTypeLabel(t: string | null | undefined): string | null {
  return isFreeType(t) ? LABELS[t] : null;
}

/** Genuinely costs the person nothing to start — the "free and reversible first" ranking nudge (CLAUDE.md rule 9). */
export function startsFree(t: FreeType): boolean {
  return t === "FREE_FOREVER" || t === "FREE_TIER" || t === "FREE_FOR_QUALIFYING_USERS" || t === "GOVERNMENT_GRANT";
}

/** The cost as a person or a model should read it: the category first, then the detail. */
export function withFreeType(cost: string, t: string | null | undefined): string {
  const label = freeTypeLabel(t);
  if (!label) return cost;
  // A cost that is only the word "free" adds nothing to "Free to use" — and
  // "Free to use — free" is what every plan printed for the free tools.
  if (/^\s*free\.?\s*$/i.test(cost ?? "")) return label;
  return `${label} — ${cost}`;
}
