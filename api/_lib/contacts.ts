// Charles — contacts the library never gave (safety_events check "unknown_contact").
//
// A distressed owner was handed "SEDFA (0860 665 232, sefa.org.za)": a number
// and a site that were in no row Charles holds. The verified `sedfa` tool row
// says 0860 103 703 and sedfa.org.za. A wrong number sends a person who is
// already struggling to a dead end, or somewhere worse, and no prompt can
// promise a model will not write one from memory.
//
// So owner-facing model text may carry a phone number or a web address only
// if it is in what that call was given: the knowledge and tools rows (the
// core block carries both sheets and the country line, advisor included), or
// what the person sent themselves. Anything else is replaced with a neutral
// phrase — deterministically, no model call — and the replacement is a row
// in safety_events, so a guard that fires is visible, never a silence.
//
// Conservative on purpose: a phone number needs 9-15 digits, so a price
// ("R240", "KSh 2,000", "R1 500"), a date ("2026-09-25"), a percentage or a
// year is never touched, and digits straight after a currency are a price.
// An address needs a scheme, "www." or a known web suffix.

import { recordSafetyEvent } from "./db.js";
import { phoneKey, phonesIn } from "./phones.js";

const URL_LIKE_RE =
  /(?<![@\w.\/-])(?:https?:\/\/[^\s<>"'`)\]]+|www\.[^\s<>"'`)\]]+|[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:(?:go|or|ac|ne|sc)\.(?:ug|ke|za|ng|gh|tz)|com|org|net|gov|edu|info|biz|io|app|africa|co|za|ke|ng|gh|ug)(?:\.(?:za|ke|ng|gh|ug|uk))?(?:\/[^\s<>"'`)\]]*)?)(?![\w@-])/gi;
const TRAIL_RE = /[.,;:!?]+$/;


/** Lowercase, no scheme, no "www.", no trailing punctuation or slash. */
export function normUrl(u: string): string {
  return u.toLowerCase().replace(TRAIL_RE, "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}
export const hostOf = (n: string) => n.split(/[/?#]/)[0]!;

export function urlsIn(text: string): string[] {
  return [...text.matchAll(URL_LIKE_RE)].map((m) => m[0].replace(TRAIL_RE, ""));
}

function allowedSets(allowed: string) {
  const urls = new Set(urlsIn(allowed).map(normUrl));
  return { phones: new Set(phonesIn(allowed).map((p) => phoneKey(p.raw))), urls, hosts: new Set([...urls].map(hostOf)) };
}

export interface ContactGuardResult {
  text: string;
  /** Every phone number or address that was taken out, as written. */
  removed: string[];
}

/**
 * Replace every phone number or web address in `text` that does not appear
 * in `allowed` (everything that call was given, joined). A known site with a
 * page nobody gave is cut back to the site itself; an unknown site or number
 * becomes a neutral phrase. Pure and deterministic.
 */
export function guardContacts(text: string, allowed: string): ContactGuardResult {
  if (!text) return { text, removed: [] };
  const ok = allowedSets(allowed);
  const removed: string[] = [];

  let out = text.replace(URL_LIKE_RE, (match) => {
    const trail = TRAIL_RE.exec(match)?.[0] ?? "";
    const raw = trail ? match.slice(0, -trail.length) : match;
    const n = normUrl(raw);
    if (ok.urls.has(n)) return match;
    const host = hostOf(n);
    if (ok.hosts.has(host)) {
      if (host === n) return match;
      removed.push(raw);
      return host + trail;
    }
    removed.push(raw);
    return "their official website" + trail;
  });

  // Numbers second, on what is left; right to left so the indexes stay true.
  for (const p of phonesIn(out).reverse()) {
    if (ok.phones.has(phoneKey(p.raw))) continue;
    removed.push(p.raw);
    // A number in brackets takes its brackets with it: "Call SARS (0800 00
    // 7277 SARS)" became "Call SARS (their official number SARS)" — and,
    // with the "(" inside the match, "their official number SARS)" (round
    // 17). An aside that was only there to carry the number is dropped whole.
    const group = bracketAround(out, p.index, p.index + p.raw.length);
    if (group) {
      out = out.slice(0, group.start).replace(/[ \u00a0]+$/, "") + out.slice(group.end);
      continue;
    }
    out = out.slice(0, p.index) + "their official number" + out.slice(p.index + p.raw.length);
  }
  return { text: out, removed: removed.reverse() };
}

/**
 * The "( … )" that holds a number at [from, to), when the aside is short and
 * on one line — the brackets may be inside the match itself. Null otherwise.
 */
function bracketAround(text: string, from: number, to: number): { start: number; end: number } | null {
  const open = text.lastIndexOf("(", text[from] === "(" ? from : from - 1);
  if (open < 0 || from - open > 40 || text.slice(open, from).includes(")") || /\n/.test(text.slice(open, from))) return null;
  const close = text.indexOf(")", to - 1 >= 0 && text[to - 1] === ")" ? to - 1 : to);
  if (close < 0 || close - to > 40 || /[\n(]/.test(text.slice(to, close))) return null;
  return { start: open, end: close + 1 };
}

interface Guardable {
  message: string;
  artifact?: string | null;
  next_tap?: { label: string; url: string } | null;
}

/**
 * guardContacts over a reply's message, its ready-to-send artifact and its
 * link button, with one audit row (check "unknown_contact") whenever anything
 * was taken out. A link button whose address nobody gave is dropped, not
 * rewritten. Nothing removed: the reply comes back as it was, and no row.
 */
export async function guardReplyContacts<R extends Guardable>(reply: R, allowed: string, ctx: { businessId?: string | null; call: string }): Promise<R> {
  const msg = guardContacts(reply.message, allowed);
  const art = reply.artifact ? guardContacts(reply.artifact, allowed) : null;
  const removed = [...msg.removed, ...(art?.removed ?? [])];
  let tap = reply.next_tap ?? null;
  if (tap?.url) {
    const ok = allowedSets(allowed);
    const n = normUrl(tap.url);
    if (!ok.urls.has(n) && !ok.hosts.has(hostOf(n))) {
      removed.push(tap.url);
      tap = null;
    }
  }
  if (!removed.length) return reply;
  await recordSafetyEvent({
    businessId: ctx.businessId ?? null,
    check: "unknown_contact",
    engine: "none",
    outcome: "flag",
    flags: ["stripped"],
    detail: `${ctx.call}: removed ${removed.length} contact${removed.length === 1 ? "" : "s"} not in the library or the person's words: ${removed.join(" | ")}`.slice(0, 300),
  });
  return { ...reply, message: msg.text, ...(art ? { artifact: art.text } : {}), ...(reply.next_tap !== undefined ? { next_tap: tap } : {}) };
}
