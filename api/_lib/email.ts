// Charles — sending an email to the team. One function, one provider.
//
// Resend's HTTP API (resend.com, free tier: 3,000 emails a month, 100 a day),
// called with fetch, so there is no SDK to install or keep up to date. The
// alerts (alerts.ts) are rate-limited well under that: at most one immediate
// email every five minutes, one digest an hour and one summary a day.
//
// Nothing here knows what an alert is; it sends what it is given. Without
// RESEND_API_KEY and ALERT_EMAIL_TO it sends nothing and says so — the alerts
// are still recorded in `incidents` and shown on /admin.

import { env } from "./env.js";

export interface EmailResult {
  ok: boolean;
  skipped?: boolean;
  id?: string;
  error?: string;
}

const SEND_TIMEOUT_MS = 10_000;

export function emailConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY && env.ALERT_EMAIL_TO);
}

export function alertRecipients(): string[] {
  return env.ALERT_EMAIL_TO.split(",").map((x) => x.trim()).filter((x) => /.+@.+\..+/.test(x));
}

export async function sendEmail(msg: { subject: string; text: string; html: string }): Promise<EmailResult> {
  if (!emailConfigured()) return { ok: false, skipped: true, error: "RESEND_API_KEY or ALERT_EMAIL_TO not set" };
  const to = alertRecipients();
  if (!to.length) return { ok: false, skipped: true, error: "ALERT_EMAIL_TO has no valid address" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.ALERT_EMAIL_FROM, to, subject: msg.subject.slice(0, 200), text: msg.text, html: msg.html }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const body = await res.text();
    if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${body.slice(0, 300)}` };
    let id: string | undefined;
    try {
      id = (JSON.parse(body) as { id?: string }).id;
    } catch {
      /* a 200 is a send */
    }
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: `Resend unreachable: ${(err as Error)?.message ?? String(err)}` };
  }
}

/** Escape for the HTML half of an email. */
export const escHtml = (x: unknown): string => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
