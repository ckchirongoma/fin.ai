// Fin — is this thing actually working?
//
// The specific failure this exists to prevent: shipping with a guardrail
// switched off and no way to tell. The first version's safety checks all keyed
// off an environment variable that appeared in no deploy document, so "every
// check passing" and "no check running" looked identical from outside.
//
// So this endpoint answers three questions plainly: what is configured, is at
// least one guardrail engine live, and has anything gone unchecked recently.
// The public form is a boolean summary; the detailed form needs the worker
// secret, because a list of which subsystems are missing is a map for anyone
// looking for a way in.

import { env, missingRequired, readiness } from "./_lib/env.js";
import { publicNumberSource, resolvePublicWhatsAppNumber } from "./_lib/wanumber.js";
import { activeEngine } from "./_lib/safety.js";
import { db, NOT_GUARDRAIL_CHECKS, recentDeadJobs, type DeadJobSummary } from "./_lib/db.js";
import { authorised } from "./worker.js";
import { tracked } from "./_lib/track.js";
import { emailConfigured } from "./_lib/email.js";

async function recentSafetyPicture(): Promise<{ unavailable24h: number; checks24h: number; lastUnavailable: string | null }> {
  const since = new Date(Date.now() - 864e5).toISOString();
  // knowledge_signal / plan_strategy / plan_build_timing rows are operational
  // notes, not guardrail checks — counting them would inflate this number.
  let checksQuery = db().from("safety_events").select("id", { count: "exact", head: true }).gte("created_at", since);
  for (const name of NOT_GUARDRAIL_CHECKS) checksQuery = checksQuery.neq("check_name", name);
  const [{ count: checks }, { data: gaps, count: unavailable }] = await Promise.all([
    checksQuery,
    db()
      .from("safety_events")
      .select("created_at", { count: "exact" })
      .eq("outcome", "unavailable")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  return {
    checks24h: checks ?? 0,
    unavailable24h: unavailable ?? 0,
    lastUnavailable: (gaps as { created_at: string }[] | null)?.[0]?.created_at ?? null,
  };
}

/** Plans that finished without their strategy, in the last day (db safety_events, check plan_strategy). */
async function strategyMissing24h(): Promise<number> {
  const since = new Date(Date.now() - 864e5).toISOString();
  const { count } = await db().from("safety_events").select("id", { count: "exact", head: true }).eq("check_name", "plan_strategy").gte("created_at", since);
  return count ?? 0;
}

async function queueDepth(): Promise<{ queued: number; dead: number; recent_dead: DeadJobSummary[]; stale_running: number; watchdog_queued: boolean }> {
  const staleCutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const [{ count: queued }, { count: dead }, recentDead, { count: stale }, { count: watchdogs }] = await Promise.all([
    db().from("jobs").select("id", { count: "exact", head: true }).eq("status", "queued"),
    db().from("jobs").select("id", { count: "exact", head: true }).eq("status", "dead"),
    recentDeadJobs(10),
    // Round 13/14: a stage whose function died sat "running" for 9-47
    // minutes, visible only by querying the table. Anything running with a
    // lock untouched for 5 minutes is dead; the watchdog should reclaim it.
    db().from("jobs").select("id", { count: "exact", head: true }).eq("status", "running").lt("locked_at", staleCutoff),
    db().from("jobs").select("id", { count: "exact", head: true }).eq("kind", "watchdog").eq("status", "queued"),
  ]);
  return { queued: queued ?? 0, dead: dead ?? 0, recent_dead: recentDead, stale_running: stale ?? 0, watchdog_queued: (watchdogs ?? 0) > 0 };
}

/** Whole plan builds in the last day, from plan_build_timing rows (score = total seconds). */
export async function planBuildTimes24h(): Promise<{ builds: number; p50_seconds: number | null; max_seconds: number | null; slowest: string | null }> {
  const since = new Date(Date.now() - 864e5).toISOString();
  const { data } = await db().from("safety_events").select("score, detail").eq("check_name", "plan_build_timing").gte("created_at", since);
  const rows = ((data as { score: number | string | null; detail: string | null }[]) ?? [])
    .map((r) => ({ s: Number(r.score), detail: r.detail }))
    .filter((r) => Number.isFinite(r.s))
    .sort((a, b) => a.s - b.s);
  if (!rows.length) return { builds: 0, p50_seconds: null, max_seconds: null, slowest: null };
  const mid = Math.floor(rows.length / 2);
  const p50 = rows.length % 2 ? rows[mid]!.s : (rows[mid - 1]!.s + rows[mid]!.s) / 2;
  const last = rows[rows.length - 1]!;
  return { builds: rows.length, p50_seconds: Math.round(p50), max_seconds: Math.round(last.s), slowest: last.detail };
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  const missing = missingRequired();
  const engine = activeEngine();
  const detailed = authorised(req);
  // Cached for an hour (five minutes after a failure) and bounded at 2s, so
  // the public health check stays fast even while Meta is down.
  const waNumber = await resolvePublicWhatsAppNumber({ timeoutMs: 2000 });

  const summary: Record<string, unknown> = {
    ok: missing.length === 0 && engine !== "none",
    guardrails: engine,
    guardrails_live: engine !== "none",
    required_missing: missing.length,
    // Public: whether the website's WhatsApp buttons open a chat. Anyone can
    // click one and find out, so saying it here gives nothing away — and it
    // is the one-glance check after deploying. True when WHATSAPP_PUBLIC_NUMBER
    // is set or Meta told us the bot's number. Not part of `ok`: a missing
    // link is a broken website, not unsafe advice.
    whatsapp_link: waNumber !== null,
  };

  if (!detailed) {
    return new Response(JSON.stringify(summary), {
      status: summary.ok ? 200 : 503,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  let safety: unknown = "database unreachable";
  let queue: unknown = "database unreachable";
  let plansWithoutStrategy24h: unknown = "database unreachable";
  let planBuildTimes: unknown = "database unreachable";
  let tracking: unknown = "database unreachable";
  try {
    [safety, queue, plansWithoutStrategy24h, planBuildTimes, tracking] = await Promise.all([recentSafetyPicture(), queueDepth(), strategyMissing24h(), planBuildTimes24h(), trackingPicture()]);
  } catch (err) {
    console.warn("health: database checks failed", err);
  }

  const body = {
    ...summary,
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
    region: process.env.VERCEL_REGION ?? "local",
    whatsapp_api: env.WHATSAPP_API_VERSION,
    subsystems: readiness().map((r) => (r.subsystem === "whatsapp_link" ? { ...r, ready: waNumber !== null } : r)),
    safety,
    queue,
    plans_without_strategy_24h: plansWithoutStrategy24h,
    plan_build_times_24h: planBuildTimes,
    tracking,
    notes: [
      emailConfigured()
        ? "Alert emails are on (RESEND_API_KEY + ALERT_EMAIL_TO)."
        : "ALERT EMAILS ARE OFF: set RESEND_API_KEY and ALERT_EMAIL_TO. Failures and unmet requests are still recorded and shown on /admin, but nobody is told.",
      waNumber
        ? publicNumberSource() === "env"
          ? "Website WhatsApp buttons (/wa) open the number in WHATSAPP_PUBLIC_NUMBER."
          : "Website WhatsApp buttons (/wa) open the bot's own number, as Meta reports it."
        : "WEBSITE WHATSAPP BUTTONS ARE DEAD: WHATSAPP_PUBLIC_NUMBER is unset and Meta could not be asked for the bot's number (check WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN). Every 'Message Fin' button shows a 'not switched on yet' page.",
      engine === "none"
        ? "NO GUARDRAIL ENGINE IS LIVE. Fin is giving money advice with nothing checking it. Set TYPESAFE_API_KEY or OPENROUTER_API_KEY."
        : `Guardrails running on the ${engine} engine.`,
      missing.length ? `Required subsystems not configured: ${missing.join(", ")}.` : "All required subsystems configured.",
    ],
  };

  return new Response(JSON.stringify(body, null, 2), {
    status: summary.ok ? 200 : 503,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Is tracking writing, and is anything waiting to be emailed? A table that
 * does not exist means db/0024 has not been applied: said plainly.
 */
async function trackingPicture(): Promise<unknown> {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const [ev, open, pending, last] = await Promise.all([
    db().from("events").select("id", { count: "exact", head: true }).gte("at", hourAgo),
    db().from("incidents").select("fingerprint", { count: "exact", head: true }).is("resolved_at", null),
    db().from("incidents").select("fingerprint", { count: "exact", head: true }).gt("since_email", 0).neq("alert", "none"),
    db().from("alert_state").select("key, at").order("at", { ascending: false }).limit(3),
  ]);
  if (ev.error) return { ok: false, detail: `events table unreadable (${ev.error.message}) — is db/0024_tracking.sql applied?` };
  return {
    ok: true,
    events_last_hour: ev.count ?? 0,
    open_incidents: open.count ?? 0,
    waiting_to_be_emailed: pending.count ?? 0,
    email: emailConfigured() ? "on" : "off",
    last_alert_passes: last.data ?? [],
  };
}

const served = tracked("health", "system", handler);
export const GET = served;
export const OPTIONS = served;
