// Charles — the market, in one place.
//
// Charles carried five markets; Charles starts with one. The shape is kept on
// purpose: a second market (the Philippines is Tyme's other home, with 11
// million customers) is a new row here, its places in location.ts, its money
// forms in grounding.ts, pricestamp.ts, contacts.ts and signals.ts, its ids
// on every plan step that names a tool (playbooks.ts), and a verified
// library. Never a second codebase, and never a row with guessed facts
// (CLAUDE.md rule 10): a market exists here only once its library does.
//
// Every prompt carries `groundingLine()`, so nothing is ever generic by
// accident: the currency, the bodies that regulate credit, tax, grants and
// complaints, and the free help a person in trouble is pointed to.

export interface Country {
  code: string;
  name: string;
  /** International dialling prefix, longest-first matched against the wa_id. */
  prefix: string;
  currency: string;
  /** How the person writes money, e.g. "R350". */
  money: (amount: string) => string;
  /** Two realistic figures for the diagnostic's "what comes in a month" question. */
  incomeExample: string;
  /**
   * The body that regulates credit providers, debt counsellors and the
   * credit bureaus, and takes complaints about them. Named in every answer
   * about a loan, a debt or a credit record.
   */
  registrar: string;
  /** Where to reach it. */
  registrarPortal: string;
  /** The tax authority. */
  tax: string;
  /** What the person calls their tax reference, for plan wording. */
  taxNumber: string;
  /** The social-grant agency, by name. */
  grants: string;
  /**
   * Free, no-obligation help for someone who cannot cover essentials. Named
   * in hardship mode and in the scam warning. Only what a verified library
   * row backs: the NCR's own consumer line (ncr.org.za), through which a
   * registered debt counsellor is found; the first debt-counselling
   * conversation is free to have, and the NCR caps what one may charge.
   */
  advisor: string;
  /** The advisor's name alone, to tell whether a reply already names them. */
  advisorName: string;
  /**
   * The free ombud for a dispute with a bank, lender or insurer, named when
   * someone has been wronged and is about to pay a "removal" service instead.
   */
  ombud: string;
  /** The ombud's short name. */
  ombudName: string;
  /** The data-protection regulator, as the market's library rows name it. */
  dataRegulator: string;
  /** How this market's money is written, to tell whether a figure is already in it. */
  moneyRe: RegExp;
}

export const COUNTRIES: Record<string, Country> = {
  ZA: {
    code: "ZA",
    name: "South Africa",
    prefix: "27",
    currency: "ZAR",
    money: (a) => `R${a}`,
    incomeExample: "for example R3,500, or R12,000",
    registrar: "the National Credit Regulator (NCR)",
    registrarPortal: "ncr.org.za",
    tax: "SARS",
    taxNumber: "tax number",
    grants: "SASSA",
    advisor:
      "the National Credit Regulator's consumer line, 0860 627 627 (ncr.org.za) — they will point you to a registered debt counsellor, the first conversation is free, and nobody there is selling you anything",
    advisorName: "National Credit Regulator",
    ombud: "the National Financial Ombud (nfosa.co.za, WhatsApp 076 574 8055) — free, for any dispute with a bank, lender or insurer",
    ombudName: "National Financial Ombud",
    dataRegulator: "the Information Regulator",
    moneyRe: /\bR\s?\d|\bZAR\b|\brands?\b/i,
  },
};

export const DEFAULT_COUNTRY = "ZA";

const others = (code: string): string =>
  Object.values(COUNTRIES)
    .filter((c) => c.code !== code)
    .map((c) => c.name)
    .join(", ");

export const country = (code: string | null | undefined): Country =>
  COUNTRIES[(code || "").toUpperCase()] ?? COUNTRIES[DEFAULT_COUNTRY]!;

/**
 * A WhatsApp id is a full international number with no leading "+".
 * Longest prefix first, so a three-digit code is tested before a two-digit
 * one once a second market exists.
 */
export function countryFromWaId(waId: string): string {
  return marketOfNumber(waId) ?? DEFAULT_COUNTRY;
}

/**
 * The market a number's country code belongs to, or null for a number from
 * anywhere else. Only a first guess: where the person lives decides
 * (location.ts, engine/index.ts).
 */
export function marketOfNumber(waId: string): string | null {
  const digits = (waId || "").replace(/\D/g, "");
  const byLength = Object.values(COUNTRIES).sort((a, b) => b.prefix.length - a.prefix.length);
  for (const c of byLength) if (digits.startsWith(c.prefix)) return c.code;
  return null;
}

/**
 * The one paragraph every build prompt gets, so nothing is ever generic by
 * accident. `advisor: false` for the conversation (prompts.ts core()): there
 * the advisor is named only where it belongs — real money trouble, or when
 * they ask for a person to talk to — never under an ordinary fee answer.
 */
export function groundingLine(code: string, opts: { advisor?: boolean } = {}): string {
  const c = country(code);
  const elsewhere = others(c.code);
  return (
    `The person lives in ${c.name}. Money is in ${c.currency} — write it the way they would (${c.money("350")}). ` +
    `Credit, debt counselling and the credit bureaus are regulated by ${c.registrar} (${c.registrarPortal}); tax is ${c.tax} and their tax reference is called a ${c.taxNumber}; social grants come from ${c.grants}; ` +
    `a dispute with a bank, lender or insurer goes free to ${c.ombud}. ` +
    (opts.advisor === false ? "" : `The free help to point them to when they cannot cover essentials is ${c.advisor}. `) +
    `Never name an institution, price, rule or scheme from another country${elsewhere ? ` (${elsewhere})` : ""} — only ${c.name}'s.`
  ).trimEnd();
}
