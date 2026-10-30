// Charles — the tracking dashboard's data (/admin reads this).
//
// Read-only views over `events` and `incidents` (db/0024), plus two actions:
// mark an incident resolved, and send a test email. Authenticated with
// ADMIN_SECRET as a bearer token, compared in constant time; it fails closed
// (no secret configured, nobody gets in), and a wrong secret is itself a
// security event.
//
// Nothing here returns a phone number: people are their business id, shown by
// its first 8 characters, and their words only as the scrubbed excerpt the
// event already holds.

import { timingSafeEqual } from "node:crypto";
import { env } from "./_lib/env.js";
import { db } from "./_lib/db.js";
import { emailConfigured, sendEmail } from "./_lib/email.js";
import { eventsBetween, FUNNEL, ownerRef, summarise, type IncidentRow } from "./_lib/alerts.js";
import { noteRequestFailure, track, tracked } from "./_lib/track.js";

const DAY = 24 * 60 * 60 * 1000;

function authorised(req: Request): boolean {
  if (!env.ADMIN_SECRET) return false;
  const a = Buffer.from(req.headers.get("authorization") ?? "", "utf8");
  const b = Buffer.from(`Bearer ${env.ADMIN_SECRET}`, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const pct = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

/** A short id prefix (from an email or the dashboard) as the range of uuids it covers. */
function uuidRange(prefix: string): [string, string] | null {
  const hex = prefix.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length < 6 || hex.length > 32) return null;
  const fmt = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  return [fmt(hex.padEnd(32, "0")), fmt(hex.padEnd(32, "f"))];
}

function windowFrom(url: URL): { from: Date; to: Date; days: number } {
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") ?? 1)));
  const to = new Date();
  return { from: new Date(to.getTime() - days * DAY), to, days };
}

async function overview(url: URL): Promise<unknown> {
  const { from, to, days } = windowFrom(url);
  const s = await summarise(from, to);
  return { days, email: emailConfigured() ? "on" : "OFF — set RESEND_API_KEY and ALERT_EMAIL_TO", summary: s };
}

/**
 * Where people are and where they stop: for each owner seen in the window,
 * the furthest funnel point they reached, and whether they have gone quiet
 * (nothing from them for 48 hours) — a stop, read across people.
 */
async function funnel(url: URL): Promise<unknown> {
  const { from, to } = windowFrom(url);
  const ev = await eventsBetween(from.toISOString(), to.toISOString(), { max: 100_000 });
  const people = new Map<string, { furthest: number; last: string; stage: string | null }>();
  for (const e of ev) {
    if (!e.business_id) continue;
    const o = people.get(e.business_id) ?? { furthest: -1, last: "1970-01-01T00:00:00.000Z", stage: null };
    const i = FUNNEL.findIndex((f) => f.event === e.name && (!f.where || f.where(e)));
    if (i > o.furthest) o.furthest = i;
    // Only what the person did counts as them being active: Charles's own
    // system work for them (a nudge sweep, a build job) does not.
    if (e.channel !== "system" && e.at > o.last) o.last = e.at;
    if (e.name === "stage_entered") o.stage = String(e.props?.to ?? e.stage ?? "");
    people.set(e.business_id, o);
  }
  const quietCut = Date.now() - 2 * DAY;
  const steps = FUNNEL.map((f, i) => {
    const reached = [...people.values()].filter((o) => o.furthest >= i).length;
    const stoppedHere = [...people.values()].filter((o) => o.furthest === i && new Date(o.last).getTime() < quietCut).length;
    return { label: f.label, event: f.event, reached, stopped_here: stoppedHere };
  });
  const byStage: Record<string, number> = {};
  for (const o of people.values()) if (o.stage) byStage[o.stage] = (byStage[o.stage] ?? 0) + 1;
  return { people: people.size, steps, current_stage: byStage, truncated: Boolean(ev.truncated) };
}

async function unmet(url: URL): Promise<unknown> {
  const { from, to } = windowFrom(url);
  const ev = await eventsBetween(from.toISOString(), to.toISOString(), { categories: ["unmet_request"], internal: url.searchParams.get("internal") === "1" });
  const groups: Record<string, number> = {};
  for (const e of ev) groups[e.name] = (groups[e.name] ?? 0) + 1;
  return {
    total: ev.length,
    by_kind: Object.entries(groups).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    recent: ev.slice(-300).reverse().map((e) => ({ at: e.at, name: e.name, owner: ownerRef(e.business_id), country: e.country, stage: e.stage, channel: e.channel, said: e.excerpt, reply: e.props?.reply ?? null, props: e.props, internal: e.internal })),
  };
}

async function performance(url: URL): Promise<unknown> {
  const { from, to } = windowFrom(url);
  const ev = await eventsBetween(from.toISOString(), to.toISOString(), { names: ["model_call", "turn_handled", "plan_ready", "message_sent", "job_done", "job_retry", "job_dead", "http_request"], internal: true });
  const ms = (rows: typeof ev) => rows.map((e) => e.ms).filter((x): x is number => typeof x === "number");
  const group = (rows: typeof ev, key: (e: (typeof ev)[number]) => string) => {
    const m = new Map<string, typeof ev>();
    for (const e of rows) {
      const k = key(e);
      const bucket = m.get(k);
      if (bucket) bucket.push(e);
      else m.set(k, [e]);
    }
    return [...m.entries()]
      .map(([k, rs]) => ({ key: k, count: rs.length, failed: rs.filter((e) => e.props?.ok === false).length, p50: pct(ms(rs), 50), p95: pct(ms(rs), 95), max: Math.max(0, ...ms(rs)), cost_usd: Math.round(rs.reduce((s, e) => s + (Number(e.props?.cost) || 0), 0) * 10_000) / 10_000, fallbacks: rs.filter((e) => e.props?.fallback === true).length }))
      .sort((a, b) => b.count - a.count);
  };
  const models = ev.filter((e) => e.name === "model_call");
  return {
    models_by_label: group(models, (e) => `${e.props?.role ?? "?"} / ${e.props?.label ?? "?"}`),
    models_by_model: group(models, (e) => `${e.props?.model ?? "FAILED"}${e.props?.provider ? ` via ${e.props.provider}` : ""}`),
    turns_by_path: group(ev.filter((e) => e.name === "turn_handled"), (e) => String(e.props?.handled_as ?? "?")),
    plan_builds: { count: ev.filter((e) => e.name === "plan_ready").length, p50: pct(ms(ev.filter((e) => e.name === "plan_ready")), 50), p95: pct(ms(ev.filter((e) => e.name === "plan_ready")), 95) },
    sends: group(ev.filter((e) => e.name === "message_sent"), (e) => String(e.props?.kind ?? "?")),
    jobs: group(ev.filter((e) => e.name.startsWith("job_")), (e) => `${e.name} ${e.props?.kind ?? ""}${e.props?.stage ? ` (${e.props.stage})` : ""}`),
    functions: group(ev.filter((e) => e.name === "http_request"), (e) => `${e.props?.fn ?? "?"} ${e.props?.path ?? ""}`),
  };
}

async function incidents(url: URL): Promise<unknown> {
  let q = db().from("incidents").select("*").order("last_seen", { ascending: false }).limit(200);
  if (url.searchParams.get("all") !== "1") q = q.is("resolved_at", null);
  const { data, error } = await q;
  if (error) throw error;
  return { incidents: (data as IncidentRow[] | null) ?? [] };
}

async function events(url: URL): Promise<unknown> {
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));
  let q = db().from("events").select("id, at, name, category, severity, business_id, channel, country, stage, turn_id, job_id, ms, props, excerpt, internal").order("at", { ascending: false }).limit(limit);
  for (const k of ["name", "category", "severity", "channel", "country", "stage"]) {
    const v = url.searchParams.get(k);
    if (v) q = q.eq(k, v);
  }
  const before = url.searchParams.get("before");
  if (before) q = q.lt("at", before);
  const ref = url.searchParams.get("owner");
  if (ref) {
    const r = uuidRange(ref);
    if (!r) return { error: "owner must be at least 6 characters of the id" };
    q = q.gte("business_id", r[0]).lte("business_id", r[1]);
  }
  const { data, error } = await q;
  if (error) throw error;
  return { events: ((data as Record<string, unknown>[] | null) ?? []).map((e) => ({ ...e, owner: ownerRef(e.business_id as string | null), business_id: undefined })) };
}

/** One owner's whole story, oldest first: where they are, what they did, what went wrong. */
async function owner(url: URL): Promise<unknown> {
  const r = uuidRange(url.searchParams.get("ref") ?? "");
  if (!r) return { error: "ref must be at least 6 characters of the person's id" };
  const { data: biz } = await db().from("businesses").select("id, country, stage, biz_stage, diag_step, created_at, updated_at, last_inbound_at, current_plan_id").gte("id", r[0]).lte("id", r[1]).limit(2);
  const rows = (biz as Record<string, unknown>[] | null) ?? [];
  if (rows.length > 1) return { error: "more than one owner starts with that — give more characters" };
  const { data: ev } = await db()
    .from("events")
    .select("at, name, category, severity, channel, stage, ms, props, excerpt, internal")
    .gte("business_id", r[0])
    .lte("business_id", r[1])
    // The newest 1,000 (Supabase's row cap), shown oldest first.
    .order("at", { ascending: false })
    .limit(1000);
  const b = rows[0];
  return {
    owner: b ? { ref: ownerRef(String(b.id)), country: b.country, stage: b.stage, biz_stage: b.biz_stage, diag_step: b.diag_step, since: b.created_at, last_message: b.last_inbound_at, has_plan: Boolean(b.current_plan_id) } : null,
    timeline: ((ev as Record<string, unknown>[] | null) ?? []).reverse(),
    truncated: (ev?.length ?? 0) >= 1000,
  };
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (!authorised(req)) {
    if (env.ADMIN_SECRET) track("admin_auth_failed", { category: "security", severity: "warn", alert: "digest", props: { method: req.method } });
    return json({ error: env.ADMIN_SECRET ? "Wrong admin secret." : "ADMIN_SECRET is not set, so the dashboard is closed." }, 403);
  }
  const url = new URL(req.url);
  try {
    if (req.method === "POST") {
      const action = url.searchParams.get("action");
      if (action === "resolve") {
        const fp = url.searchParams.get("fingerprint") ?? "";
        const { error } = await db().from("incidents").update({ resolved_at: new Date().toISOString(), since_email: 0 }).eq("fingerprint", fp);
        if (error) throw error;
        track("incident_resolved", { category: "ops", props: { fingerprint: fp.slice(0, 120) } });
        return json({ ok: true });
      }
      if (action === "test_email") {
        const r = await sendEmail({
          subject: "[Charles] Test alert — email is working",
          text: "This is a test from the Charles dashboard. If you can read it, alert emails will reach you.",
          html: "<p>This is a test from the Charles dashboard. If you can read it, alert emails will reach you.</p>",
        });
        return json(r, r.ok ? 200 : 502);
      }
      return json({ error: "unknown action" }, 400);
    }
    const view = url.searchParams.get("view") ?? "overview";
    const views: Record<string, (u: URL) => Promise<unknown>> = { overview, funnel, unmet, performance, incidents, events, owner };
    const fn = views[view];
    if (!fn) return json({ error: `unknown view "${view}"` }, 400);
    return json(await fn(url));
  } catch (err) {
    console.log("admin view failed", err);
    noteRequestFailure(err);
    return json({ error: (err as Error)?.message ?? String(err) }, 500);
  }
}

const served = tracked("admin", "system", handler);
export const GET = served;
export const POST = served;
export const OPTIONS = served;
