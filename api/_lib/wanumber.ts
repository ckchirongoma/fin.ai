// Fin — which number the website's WhatsApp buttons open.
//
// The number people message is already known to Meta: the app holds
// WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN to send from it, and the
// Graph API answers GET /<PHONE_NUMBER_ID>?fields=display_phone_number with
// the real number. So WHATSAPP_PUBLIC_NUMBER is optional: it wins when set
// (for a site that should show a different number from the bot's), and
// otherwise the number is asked of Meta.
//
// Asked rarely. A found number is kept in module memory for an hour; a failed
// lookup is remembered for five minutes, so a Meta outage costs one call per
// warm instance every five minutes rather than one per click. A lookup is
// bounded at three seconds, and every failure ends in the honest "not
// switched on yet" page — never a wa.me link to nobody.
//
// The access token goes in a header and nowhere else: no log line here
// includes it, the URL, or Meta's response body.

import { env, PLACEHOLDER_WA_NUMBER, publicWhatsAppNumber } from "./env.js";
import { track } from "./track.js";

const OK_TTL_MS = 60 * 60 * 1000;
const FAIL_TTL_MS = 5 * 60 * 1000;
export const LOOKUP_TIMEOUT_MS = 3000;

let cache: { number: string | null; until: number } | null = null;
let inFlight: Promise<string | null> | null = null;

const read = (name: string): string => (process.env[name] ?? "").trim();

/** Digits only, 8–15 of them, and never the old placeholder; otherwise null. */
export function normaliseDisplayNumber(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  if (!/^\d{8,15}$/.test(digits) || digits === PLACEHOLDER_WA_NUMBER) return null;
  return digits;
}

/** What Meta's lookup found, and why not when it found nothing. */
interface Lookup {
  number: string | null;
  status: number | null;
  reason: string | null;
}

async function lookup(timeoutMs: number): Promise<Lookup> {
  const id = read("WHATSAPP_PHONE_NUMBER_ID");
  const token = read("WHATSAPP_ACCESS_TOKEN");
  if (!id || !token) return { number: null, status: null, reason: "not_configured" };
  const version = read("WHATSAPP_API_VERSION") || env.WHATSAPP_API_VERSION;
  // A plain timer rather than AbortSignal.timeout(): that one is unref'd, so
  // a hung request would not keep the function (or a test) alive to see it abort.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException(`timed out after ${timeoutMs}ms`, "TimeoutError")), timeoutMs);
  try {
    const res = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(id)}?fields=display_phone_number`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctl.signal,
    });
    if (!res.ok) {
      console.warn(`wa-number: Meta lookup of the phone number failed with HTTP ${res.status}`);
      return { number: null, status: res.status, reason: "http_error" };
    }
    const body = (await res.json().catch(() => null)) as { display_phone_number?: unknown } | null;
    const number = normaliseDisplayNumber(body?.display_phone_number);
    if (!number) console.warn("wa-number: Meta's answer had no usable display_phone_number");
    return { number, status: res.status, reason: number ? null : "no_number_in_answer" };
  } catch (err) {
    const name = err instanceof Error ? err.name : "error";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    console.warn(`wa-number: Meta lookup of the phone number failed (${timedOut ? `timed out after ${timeoutMs}ms` : name})`);
    return { number: null, status: null, reason: timedOut ? "timeout" : name.slice(0, 40) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The number the website's WhatsApp buttons open, digits only, or null.
 * WHATSAPP_PUBLIC_NUMBER wins with no network call; otherwise Meta is asked,
 * through the cache.
 */
/**
 * The fallback when Meta's lookup gives no number: the number people'
 * messages were actually sent to, from the webhook metadata stored on recent
 * inbound jobs — for THIS phone number id, so a number the bot has since
 * moved off is never shown.
 */
async function fromRecentInbound(): Promise<string | null> {
  try {
    const { db } = await import("./db.js");
    const { data } = await db().from("jobs").select("payload").eq("kind", "inbound").order("created_at", { ascending: false }).limit(50);
    const want = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "";
    for (const row of (data as { payload: { toNumber?: unknown; toPhoneId?: unknown } | null }[]) ?? []) {
      const p = row.payload;
      if (!p?.toNumber) continue;
      if (want && p.toPhoneId && String(p.toPhoneId) !== want) continue;
      const n = normaliseDisplayNumber(p.toNumber);
      if (n) return n;
    }
  } catch (err) {
    console.warn("wa-number: reading recent inbound metadata failed", err instanceof Error ? err.message : err);
  }
  return null;
}

export async function resolvePublicWhatsAppNumber(opts: { timeoutMs?: number } = {}): Promise<string | null> {
  const configured = publicWhatsAppNumber();
  if (configured) return configured;
  const now = Date.now();
  if (cache && cache.until > now) return cache.number;
  if (!inFlight) {
    inFlight = lookup(opts.timeoutMs ?? LOOKUP_TIMEOUT_MS)
      .then(async (found) => {
        if (found.number) return found.number;
        const fallback = await fromRecentInbound();
        // Recorded only when nothing worked, with the reason the log lines
        // above cannot carry into tracking (the capture keeps a line's label
        // only, and skips these). Round 20: whatsapp_link false and no way to
        // see why. Not when the inbound fallback found the number: Meta's
        // ordinary answer has no display number, and the site is fine.
        if (!fallback) {
          track("wa_number_lookup_failed", {
            category: "failure",
            severity: "warn",
            alert: "digest",
            props: { status: found.status, reason: found.reason },
            fingerprint: `wa_number_lookup_failed:${found.reason}${found.status ? `:${found.status}` : ""}`,
            summary: `The website's WhatsApp buttons have no number to open: Meta's lookup gave none (${found.status ? `HTTP ${found.status}, ` : ""}${found.reason}) and no recent message says which number people write to. Set WHATSAPP_PUBLIC_NUMBER to fix it outright`,
          });
        }
        return fallback;
      })
      .then((number) => {
        cache = { number, until: Date.now() + (number ? OK_TTL_MS : FAIL_TTL_MS) };
        return number;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Where the number comes from, for the health notes. */
export function publicNumberSource(): "env" | "meta" {
  return publicWhatsAppNumber() ? "env" : "meta";
}

/** Tests only: forget what was looked up. */
export function __resetPublicNumberCache(): void {
  cache = null;
  inFlight = null;
}
