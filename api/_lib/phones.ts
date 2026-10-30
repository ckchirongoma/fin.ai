// Fin — phone numbers in text, told apart from money.
//
// Shared by the contact guard (contacts.ts: a number nobody gave is taken
// out of a reply) and the grounding sets (grounding.ts figuresFrom: a phone
// number is never one of the person's figures — round 23, UG: "my number is
// 0799 … and I charge UGX 45,000" read the phone as a price).
//
// Conservative on purpose: a phone number needs 9-15 digits, so a price
// ("R240", "KSh 2,000", "R1 500"), a date ("2026-09-25"), a percentage or a
// year is never touched, and digits straight after a currency are a price.

const PHONE_RE = /(?<![\w₦₵$€£@/.])\+?\(?\d[\d \u00a0()-]{7,}\d(?![\w%])(?!\.\d)/g;
// What follows the currency counts as the amount only while it is one
// continuous number with at most one trailing separator: "Shs 5,000, 0772 123
// 456" is a fee and then a phone (review, round 23), not one long price.
const CURRENCY_BEFORE_RE = /(?:\bR|\bKShs?|\bKshs?|\bKES|\bUGX|\bUgx|\bugx|\bUShs?|\bUshs?|\bShs?|\bNGN|\bGHS|\bGH₵|\bZAR|\bUSD|₦|₵|\$|€|£)\.?\s?(?:\d+(?:[ ,.]\d+)*[ ,.]?)?$/;
export const digitsOf = (s: string) => s.replace(/\D/g, "");
/** The last nine digits: "0860 103 703", "+27 860 103 703" and "0860103703" are one number. */
export const phoneKey = (s: string) => digitsOf(s).slice(-9);

export function phonesIn(text: string): { raw: string; index: number }[] {
  const out: { raw: string; index: number }[] = [];
  for (const m of text.matchAll(PHONE_RE)) {
    const raw = m[0];
    const n = digitsOf(raw).length;
    if (n < 9 || n > 15) continue;
    // An ISO date, or two run together, is not a phone number.
    if (/^\d{4}-\d{2}-\d{2}\b/.test(raw)) continue;
    if (CURRENCY_BEFORE_RE.test(text.slice(Math.max(0, m.index! - 16), m.index!))) continue;
    // "150 000 000/=": the East African shilling suffix makes it money.
    if (/^\s?\/[=-]/.test(text.slice(m.index! + raw.length))) continue;
    out.push({ raw, index: m.index! });
  }
  return out;
}


/** The text with every phone number in it blanked out (same length, so offsets hold). */
export function withoutPhones(text: string): string {
  let out = text ?? "";
  for (const p of phonesIn(out).reverse()) out = out.slice(0, p.index) + " ".repeat(p.raw.length) + out.slice(p.index + p.raw.length);
  return out;
}
