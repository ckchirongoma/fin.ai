// Fin — telling the team, without anyone having to look.
//
// Runs every minute inside the worker tick (queue.ts cronTick, vercel.json).
// Three emails, all rate-limited, none with a phone number in it:
//
//   Immediate   an error or critical incident (a build failed, WhatsApp
//               refused a send, the model provider ran out of credit, an
//               owner hit a crash). One email lists everything new since the
//               last one; at most one every 5 minutes, and the same problem
//               is not re-sent within 30 minutes unless it is still growing.
//   Hourly      everything else that went wrong (warnings) and every time an
//               owner tried to do something Fin could not, with what they
//               said — scrubbed of numbers and links (ALERT_EMAIL_EXCERPTS=0
//               leaves their words out).
//   Daily       the summary: who came, how far they got, what they asked,
//               what failed, how fast it was, what it cost. Then the day's
//               counts are rolled up (event_daily) and old events pruned.
//
// With email not configured (RESEND_API_KEY + ALERT_EMAIL_TO) nothing is sent
// and nothing is marked sent: incidents keep counting, /admin shows them, and
// the first email after the key is set carries everything that waited.

import { db } from "./db.js";
import { env } from "./env.js";
import { emailConfigured, escHtml, sendEmail } from "./email.js";
import { flushTracking, track, trackFailure } from "./track.js";

const MIN = 60_000;
const IMMEDIATE_GAP_MS = 5 * MIN;
const SAME_PROBLEM_COOLDOWN_MS = 30 * MIN;
/**
 * Resend's free tier sends 100 a day. 24 hourly + 1 daily leaves 75; the
 * immediate emails get 60 of them, so a long outage cannot spend the budget
 * the hourly and daily emails need. Past it, everything still counts in
 * `incidents` and goes out in the next hourly email instead.
 */
const IMMEDIATE_DAILY_MAX = 60;
const DIGEST_EVERY_MS = 60 * MIN;
const INFO_KEEP_DAYS = 180;
const PROBLEM_KEEP_DAYS = 365;

export interface IncidentRow {
  fingerprint: string;
  name: string;
  category: string;
  severity: string;
  alert: string;
  summary: string;
  first_seen: string;
  last_seen: string;
  count: number;
  since_email: number;
  last_props: Record<string, unknown>;
  emailed_at: string | null;
}

interface EventLite {
  at: string;
  name: string;
  category: string;
  severity: string;
  business_id: string | null;
  stage: string | null;
  channel: string | null;
  country: string | null;
  ms: number | null;
  props: Record<string, unknown>;
  excerpt: string | null;
  internal: boolean;
}

export interface AlertsReport {
  immediate: number;
  digest: number;
  daily: boolean;
  skipped?: string;
}

async function stateAt(key: string): Promise<number> {
  const { data } = await db().from("alert_state").select("at").eq("key", key).maybeSingle();
  return data ? new Date((data as { at: string }).at).getTime() : 0;
}

async function setState(key: string, at: Date, detail?: string): Promise<void> {
  const { error } = await db().from("alert_state").upsert({ key, at: at.toISOString(), detail: detail ?? null }, { onConflict: "key" });
  // A rate-limit marker that did not save would let every tick resend.
  if (error) throw error;
}

/** A business, as an email or the dashboard shows it: 8 characters of its id, never a name or number. */
export const ownerRef = (businessId: string | null | undefined): string => (businessId ? businessId.slice(0, 8) : "—");

const adminLink = (): string => (env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/admin` : "/admin");

function incidentLines(rows: IncidentRow[]): { text: string; html: string } {
  const text = rows
    .map((r) => `• [${r.severity.toUpperCase()}] ${r.summary}\n  ${r.since_email} new (${r.count} in total since ${r.first_seen.slice(0, 16).replace("T", " ")} UTC)${r.last_props?.stage ? `, stage ${r.last_props.stage}` : ""}${r.last_props?.country ? `, ${r.last_props.country}` : ""}`)
    .join("\n");
  const colour: Record<string, string> = { critical: "#b42318", error: "#c0392b", warn: "#a8720f", info: "#3c463f" };
  const html = rows
    .map(
      (r) => `<tr><td style="padding:8px 10px 8px 0;vertical-align:top;font-weight:700;color:${colour[r.severity] ?? "#3c463f"};white-space:nowrap">${escHtml(r.severity.toUpperCase())}</td><td style="padding:8px 0;vertical-align:top;color:#171f1a">${escHtml(r.summary)}<div style="color:#6b756e;font-size:12px">${r.since_email} new · ${r.count} total since ${escHtml(r.first_seen.slice(0, 16).replace("T", " "))} UTC${r.last_props?.stage ? ` · stage ${escHtml(r.last_props.stage)}` : ""}${r.last_props?.country ? ` · ${escHtml(r.last_props.country)}` : ""}${r.last_props?.internal ? " · internal" : ""}</div></td></tr>`,
    )
    .join("");
  return { text, html: `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">${html}</table>` };
}

function wrap(title: string, inner: string): string {
  return `<div style="font-family:Helvetica,Arial,sans-serif;color:#171f1a;max-width:680px"><div style="background:#171f1a;color:#fff;padding:14px 18px;font-weight:700">${escHtml(title)}</div><div style="padding:16px 18px;background:#ffffff">${inner}<p style="color:#6b756e;font-size:12px;margin-top:20px">Everything here, and more, is on the dashboard: <a href="${escHtml(adminLink())}" style="color:#155c3a">${escHtml(adminLink())}</a>. No phone numbers are ever included; people are shown by the first 8 characters of their id.</p></div></div>`;
}

/**
 * Marks what an email carried: emailed now, and the count it reported taken
 * off — atomically (db/0024 mark_incident_emailed), so a repeat counted while
 * the email was being sent is still waiting for the next one.
 */
async function markEmailed(rows: { fingerprint: string; sent: number }[], at: Date): Promise<void> {
  for (const r of rows) {
    const { error } = await db().rpc("mark_incident_emailed", { p_fingerprint: r.fingerprint, p_sent: r.sent, p_at: at.toISOString() });
    if (error) throw error;
  }
}

// ── Immediate ────────────────────────────────────────────────────

export async function runImmediate(now: Date): Promise<number> {
  const last = await stateAt("immediate");
  if (now.getTime() - last < IMMEDIATE_GAP_MS) return 0;
  const { data } = await db()
    .from("incidents")
    .select("*")
    .eq("alert", "immediate")
    .gt("since_email", 0)
    .order("last_seen", { ascending: false })
    .limit(50);
  const due = ((data as IncidentRow[] | null) ?? []).filter(
    (r) => !r.emailed_at || now.getTime() - new Date(r.emailed_at).getTime() >= SAME_PROBLEM_COOLDOWN_MS,
  );
  if (!due.length) return 0;
  const today = now.toISOString().slice(0, 10);
  const { data: budget } = await db().from("alert_state").select("detail").eq("key", "immediate_day").maybeSingle();
  const [day, sent] = String((budget as { detail?: string } | null)?.detail ?? "").split(":");
  const sentToday = day === today ? Number(sent) || 0 : 0;
  if (sentToday >= IMMEDIATE_DAILY_MAX) return 0;
  // What this email reports, as read now: repeats counted while it is being
  // sent stay on the incident for the next one.
  const reported = due.map((r) => ({ fingerprint: r.fingerprint, sent: r.since_email }));
  const shown = due.slice(0, 20);
  const worst = shown.some((r) => r.severity === "critical") ? "CRITICAL" : "Error";
  const subject = `[Fin] ${worst}: ${shown[0]!.summary.slice(0, 90)}${shown.length > 1 ? ` (+${shown.length - 1} more)` : ""}`;
  const lines = incidentLines(shown);
  const res = await sendEmail({
    subject,
    text: `Something went wrong in Fin.\n\n${lines.text}\n\n${due.length > shown.length ? `…and ${due.length - shown.length} more.\n\n` : ""}Dashboard: ${adminLink()}`,
    html: wrap("Something went wrong in Fin", `${lines.html}${due.length > shown.length ? `<p>…and ${due.length - shown.length} more.</p>` : ""}`),
  });
  if (!res.ok) {
    if (!res.skipped) trackFailure("alert_email_failed", res.error, { category: "ops", alert: "digest", props: { kind: "immediate" } });
    return 0;
  }
  await markEmailed(reported, now);
  await setState("immediate", now, subject);
  await setState("immediate_day", now, `${today}:${sentToday + 1}`);
  track("alert_email_sent", { category: "ops", props: { kind: "immediate", incidents: due.length } });
  return due.length;
}

// ── Hourly digest ────────────────────────────────────────────────

/** Events reach the table up to a few seconds after they happen (buffered, batched, other instances). */
const WRITE_LAG_MS = 60_000;

export async function runDigest(now: Date): Promise<number> {
  const last = await stateAt("digest");
  if (now.getTime() - last < DIGEST_EVERY_MS) return 0;
  // A closed window [since, end): `end` is a minute ago, so an event still
  // being written is in the next window, never in neither; and the next
  // window starts exactly where this one ended, so nothing is sent twice.
  const end = new Date(now.getTime() - WRITE_LAG_MS);
  const endIso = end.toISOString();
  const sinceIso = new Date(last ? last - WRITE_LAG_MS : end.getTime() - DIGEST_EVERY_MS).toISOString();

  const { data: inc } = await db().from("incidents").select("*").eq("alert", "digest").gt("since_email", 0).order("count", { ascending: false }).limit(60);
  const incidents = (inc as IncidentRow[] | null) ?? [];
  const reported = incidents.map((r) => ({ fingerprint: r.fingerprint, sent: r.since_email }));
  const { data: ev, count: unmetTotal } = await db()
    .from("events")
    .select("at, name, category, severity, business_id, stage, channel, country, ms, props, excerpt, internal", { count: "exact" })
    .eq("category", "unmet_request")
    .gte("at", sinceIso)
    .lt("at", endIso)
    .order("at", { ascending: true })
    .limit(200);
  // Counted, not emailed: unmet requests recorded with alert "none" (an AI
  // client probing an optional feature) never send an email on their own.
  const unmet = ((ev as EventLite[] | null) ?? []).filter((e) => e.props?.alert !== "none");
  const more = Math.max(0, (unmetTotal ?? 0) - ((ev as unknown[] | null)?.length ?? 0));
  if (!incidents.length && !unmet.length) {
    await setState("digest", now, "nothing to report");
    return 0;
  }

  const unmetText = unmet
    .map((e) => `• ${e.at.slice(11, 16)} UTC ${e.name.replace(/_/g, " ")} — owner ${ownerRef(e.business_id)}${e.country ? ` (${e.country})` : ""}${e.stage ? `, at ${e.stage}` : ""}${e.internal ? ", internal" : ""}${env.ALERT_EMAIL_EXCERPTS && e.excerpt ? `\n  “${e.excerpt}”` : ""}${env.ALERT_EMAIL_EXCERPTS && e.props?.reply ? `\n  Fin said: “${String(e.props.reply).slice(0, 160)}”` : ""}`)
    .join("\n") + (more ? `\n…and ${more} more on the dashboard.` : "");
  const unmetHtml = unmet
    .map(
      (e) => `<tr><td style="padding:7px 10px 7px 0;vertical-align:top;color:#6b756e;white-space:nowrap">${escHtml(e.at.slice(11, 16))}</td><td style="padding:7px 0;vertical-align:top"><b>${escHtml(e.name.replace(/_/g, " "))}</b> · owner ${escHtml(ownerRef(e.business_id))}${e.country ? ` (${escHtml(e.country)})` : ""}${e.stage ? ` · at ${escHtml(e.stage)}` : ""}${e.internal ? " · internal" : ""}${env.ALERT_EMAIL_EXCERPTS && e.excerpt ? `<div style="color:#171f1a">“${escHtml(e.excerpt)}”</div>` : ""}${env.ALERT_EMAIL_EXCERPTS && e.props?.reply ? `<div style="color:#6b756e;font-size:12px">Fin said: “${escHtml(String(e.props.reply).slice(0, 160))}”</div>` : ""}</td></tr>`,
    )
    .join("");
  const lines = incidentLines(incidents);
  const subject = `[Fin] Hourly: ${unmet.length} thing${unmet.length === 1 ? "" : "s"} people couldn't do, ${incidents.length} warning${incidents.length === 1 ? "" : "s"}`;
  const res = await sendEmail({
    subject,
    text: `${unmet.length ? `WHAT OWNERS TRIED AND CHARLIE COULDN'T DO (${unmet.length})\n${unmetText}\n\n` : ""}${incidents.length ? `WARNINGS\n${lines.text}\n\n` : ""}Dashboard: ${adminLink()}`,
    html: wrap(
      "Fin — the last hour",
      `${unmet.length ? `<h3 style="margin:0 0 6px">What people tried and Fin couldn't do (${unmet.length})</h3><table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">${unmetHtml}</table>${more ? `<p style="color:#6b756e">…and ${more} more on the dashboard.</p>` : ""}` : ""}${incidents.length ? `<h3 style="margin:18px 0 6px">Warnings</h3>${lines.html}` : ""}`,
    ),
  });
  if (!res.ok) {
    if (!res.skipped) trackFailure("alert_email_failed", res.error, { category: "ops", alert: "digest", props: { kind: "digest" } });
    return 0;
  }
  await markEmailed(reported, now);
  // The next window starts where this one ended (`end` + the lag added back).
  await setState("digest", now, subject);
  track("alert_email_sent", { category: "ops", props: { kind: "digest", incidents: incidents.length, unmet: unmet.length } });
  return incidents.length + unmet.length;
}

// ── Daily summary ────────────────────────────────────────────────

const pct = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const secs = (ms: number | null): string => (ms === null ? "—" : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)}s`);

/** The funnel, in order: each stage's event and what it means to a person. Shared with /admin. */
export const FUNNEL: { event: string; label: string; where?: (e: EventLite) => boolean }[] = [
  { event: "business_created", label: "Said hello" },
  { event: "diag_answered", label: "Answered question 1", where: (e) => Number(e.props?.step) === 0 },
  { event: "diag_completed", label: "Finished the 12 questions" },
  { event: "identity_confirmed", label: "Confirmed the money read-back" },
  { event: "goal_picked", label: "Picked a goal" },
  { event: "rule_picked", label: "Picked why they'd choose them" },
  { event: "plan_ready", label: "Got their plan" },
  { event: "step_pushed", label: "Asked for step 1", where: (e) => Number(e.props?.position) === 1 },
  { event: "step_done", label: "Finished a step" },
];

export interface Summary {
  from: string;
  to: string;
  /** The window held more events than were read: totals are a lower bound. */
  truncated: boolean;
  owners_active: number;
  owners_new: number;
  internal_events: number;
  funnel: { label: string; people: number }[];
  messages_in: number;
  questions: number;
  unmet: { name: string; count: number }[];
  unmet_examples: { name: string; excerpt: string | null; owner: string; stage: string | null }[];
  failures: { name: string; count: number }[];
  plan_build: { built: number; failed: number; p50: number | null; p95: number | null };
  reply: { p50: number | null; p95: number | null; turns: number };
  models: { calls: number; failed: number; p50: number | null; p95: number | null; cost_usd: number; fallbacks: number };
  whatsapp: { sent: number; failed: number };
  incidents_open: IncidentRow[];
}

/** Every event in a window, paged (a busy day can hold tens of thousands). Internal traffic excluded unless asked. */
/**
 * Every event in a window, paged, oldest first, up to `max`. A window bigger
 * than that is marked `truncated` rather than silently cut: the dashboard and
 * the summary say so instead of showing partial totals as whole ones.
 */
export async function eventsBetween(fromIso: string, toIso: string, opts: { internal?: boolean; names?: string[]; categories?: string[]; max?: number } = {}): Promise<EventLite[] & { truncated?: boolean }> {
  const out: EventLite[] & { truncated?: boolean } = [];
  const page = 1000;
  const max = opts.max ?? 50_000;
  for (let off = 0; off < max; off += page) {
    let q = db()
      .from("events")
      .select("at, name, category, severity, business_id, stage, channel, country, ms, props, excerpt, internal")
      .gte("at", fromIso)
      .lt("at", toIso)
      .order("at", { ascending: true })
      .range(off, off + page - 1);
    if (!opts.internal) q = q.eq("internal", false);
    if (opts.names?.length) q = q.in("name", opts.names);
    if (opts.categories?.length) q = q.in("category", opts.categories);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data as EventLite[] | null) ?? [];
    out.push(...rows);
    if (rows.length < page) return out;
  }
  out.truncated = true;
  return out;
}

export async function summarise(from: Date, to: Date): Promise<Summary> {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const ev = await eventsBetween(fromIso, toIso);
  const { count: internalCount } = await db().from("events").select("id", { count: "exact", head: true }).gte("at", fromIso).lt("at", toIso).eq("internal", true);
  const by = (name: string) => ev.filter((e) => e.name === name);
  const people = (rows: EventLite[]) => new Set(rows.map((e) => e.business_id).filter(Boolean)).size;
  const tally = (rows: EventLite[]) =>
    Object.entries(rows.reduce<Record<string, number>>((m, e) => ((m[e.name] = (m[e.name] ?? 0) + 1), m), {}))
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  const models = by("model_call");
  const msOf = (rows: EventLite[]) => rows.map((e) => e.ms).filter((x): x is number => typeof x === "number");
  const builds = by("plan_ready");
  const turns = by("turn_handled").filter((e) => e.channel === "whatsapp");
  const sends = by("message_sent");
  const unmet = ev.filter((e) => e.category === "unmet_request");
  const { data: open } = await db().from("incidents").select("*").is("resolved_at", null).gte("last_seen", fromIso).order("count", { ascending: false }).limit(15);

  return {
    from: fromIso,
    to: toIso,
    truncated: Boolean(ev.truncated),
    // People who did something: Fin's own system work (a nudge sweep, a
    // build job) on their behalf is not activity of theirs.
    owners_active: people(ev.filter((e) => e.channel !== "system")),
    owners_new: by("business_created").length,
    internal_events: internalCount ?? 0,
    funnel: FUNNEL.map((f) => ({ label: f.label, people: people(ev.filter((e) => e.name === f.event && (!f.where || f.where(e)))) })),
    messages_in: by("turn_received").length,
    // A queue retry re-runs the router; its question_asked carries attempt > 1.
    questions: by("question_asked").filter((e) => !(Number(e.props?.attempt) > 1)).length,
    unmet: tally(unmet),
    unmet_examples: unmet.slice(-10).map((e) => ({ name: e.name, excerpt: e.excerpt, owner: ownerRef(e.business_id), stage: e.stage })),
    failures: tally(ev.filter((e) => e.category === "failure")).slice(0, 12),
    plan_build: { built: builds.length, failed: by("plan_build_failed").length, p50: pct(msOf(builds), 50), p95: pct(msOf(builds), 95) },
    reply: { p50: pct(msOf(turns), 50), p95: pct(msOf(turns), 95), turns: turns.length },
    models: {
      calls: models.length,
      failed: models.filter((e) => e.props?.ok === false).length,
      p50: pct(msOf(models), 50),
      p95: pct(msOf(models), 95),
      cost_usd: Math.round(models.reduce((s, e) => s + (Number(e.props?.cost) || 0), 0) * 10_000) / 10_000,
      fallbacks: models.filter((e) => e.props?.fallback === true).length,
    },
    whatsapp: { sent: sends.length, failed: sends.filter((e) => e.props?.ok === false).length },
    incidents_open: (open as IncidentRow[] | null) ?? [],
  };
}

function summaryEmail(s: Summary): { subject: string; text: string; html: string } {
  const day = s.from.slice(0, 10);
  const quiet = s.owners_active === 0;
  const row = (k: string, v: string) => `<tr><td style="padding:4px 14px 4px 0;color:#6b756e">${escHtml(k)}</td><td style="padding:4px 0;font-weight:700">${escHtml(v)}</td></tr>`;
  const funnelHtml = s.funnel.map((f) => row(f.label, String(f.people))).join("");
  const lines = [
    `People active: ${s.owners_active} (new: ${s.owners_new}). Messages in: ${s.messages_in}. Questions asked: ${s.questions}.`,
    `Funnel (people reaching each point in the day): ${s.funnel.map((f) => `${f.label} ${f.people}`).join(" → ")}`,
    `Plans built: ${s.plan_build.built} (median ${secs(s.plan_build.p50)}, slowest 5% ${secs(s.plan_build.p95)}); failed: ${s.plan_build.failed}.`,
    `Reply time on WhatsApp: median ${secs(s.reply.p50)}, slowest 5% ${secs(s.reply.p95)} over ${s.reply.turns} turns.`,
    `Model calls: ${s.models.calls} (failed ${s.models.failed}, fell back ${s.models.fallbacks}); median ${secs(s.models.p50)}, p95 ${secs(s.models.p95)}; cost $${s.models.cost_usd}.`,
    `WhatsApp sends: ${s.whatsapp.sent}, failed ${s.whatsapp.failed}.`,
    `Couldn't do: ${s.unmet.map((u) => `${u.name.replace(/_/g, " ")} ×${u.count}`).join(", ") || "nothing"}.`,
    `Failures: ${s.failures.map((u) => `${u.name.replace(/_/g, " ")} ×${u.count}`).join(", ") || "none"}.`,
    `Internal (founder/tester) events, not counted above: ${s.internal_events}.`,
  ];
  if (s.truncated) lines.unshift("More events than the summary could read: the numbers below are a lower bound. The dashboard has the full picture.");
  const html = wrap(
    `Fin — ${day}${quiet ? " (no owner traffic)" : ""}`,
    `${s.truncated ? `<p style="color:#a8720f">More events than the summary could read: the numbers below are a lower bound. The dashboard has the full picture.</p>` : ""}<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">
      ${row("People active", `${s.owners_active} (new ${s.owners_new})`)}${row("Messages in", String(s.messages_in))}${row("Questions asked", String(s.questions))}
      ${row("Plans built", `${s.plan_build.built} · median ${secs(s.plan_build.p50)} · p95 ${secs(s.plan_build.p95)} · failed ${s.plan_build.failed}`)}
      ${row("WhatsApp reply time", `median ${secs(s.reply.p50)} · p95 ${secs(s.reply.p95)}`)}
      ${row("Model calls", `${s.models.calls} · failed ${s.models.failed} · fallback ${s.models.fallbacks} · $${s.models.cost_usd}`)}
      ${row("WhatsApp sends", `${s.whatsapp.sent} · failed ${s.whatsapp.failed}`)}
      ${row("Internal events (excluded)", String(s.internal_events))}
    </table>
    <h3 style="margin:18px 0 6px">How far people got</h3><table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">${funnelHtml}</table>
    <h3 style="margin:18px 0 6px">What people couldn't do</h3><div style="font-size:14px">${s.unmet.map((u) => `${escHtml(u.name.replace(/_/g, " "))} ×${u.count}`).join("<br>") || "Nothing."}</div>
    ${env.ALERT_EMAIL_EXCERPTS && s.unmet_examples.length ? `<div style="font-size:13px;color:#3c463f;margin-top:8px">${s.unmet_examples.filter((x) => x.excerpt).map((x) => `“${escHtml(x.excerpt)}” <span style="color:#6b756e">— ${escHtml(x.owner)}${x.stage ? `, at ${escHtml(x.stage)}` : ""}</span>`).join("<br>")}</div>` : ""}
    <h3 style="margin:18px 0 6px">What failed</h3><div style="font-size:14px">${s.failures.map((u) => `${escHtml(u.name.replace(/_/g, " "))} ×${u.count}`).join("<br>") || "Nothing."}</div>
    ${s.incidents_open.length ? `<h3 style="margin:18px 0 6px">Open incidents</h3>${incidentLines(s.incidents_open).html}` : ""}`,
  );
  return { subject: `[Fin] Daily, ${day}: ${s.owners_active} people, ${s.plan_build.built} plans, ${s.unmet.reduce((a, u) => a + u.count, 0)} couldn't-do, ${s.failures.reduce((a, u) => a + u.count, 0)} failures`, text: lines.join("\n\n") + `\n\nDashboard: ${adminLink()}`, html };
}

/** Yesterday's counts into event_daily, then old events out. */
export async function rollupAndPrune(day: Date): Promise<void> {
  // Counted in the database (db/0024 rollup_event_day), whatever the day's
  // size: a capped read here would lose a busy day's counts for good once
  // its events are pruned.
  const { error } = await db().rpc("rollup_event_day", { p_day: new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())).toISOString().slice(0, 10) });
  if (error) throw error;
  const infoCut = new Date(Date.now() - INFO_KEEP_DAYS * 24 * 60 * MIN).toISOString();
  const allCut = new Date(Date.now() - PROBLEM_KEEP_DAYS * 24 * 60 * MIN).toISOString();
  await db().from("events").delete().lt("at", infoCut).eq("severity", "info");
  await db().from("events").delete().lt("at", allCut);
  // Watchdog rows accumulate every 45s while work is in flight; a done one is history.
  await db().from("jobs").delete().eq("kind", "watchdog").in("status", ["done", "dead"]).lt("updated_at", new Date(Date.now() - 7 * 24 * 60 * MIN).toISOString());
}

/**
 * The daily summary, once a day, retried until it works. A tick claims a
 * five-minute slot by INSERTING its key (alert_state's primary key makes the
 * claim atomic: two ticks cannot both win it); the day is marked done only
 * after the rollup and the email succeed. A transient failure therefore
 * costs five minutes, not the day's email and its counts (review, 2026-10).
 */
export async function runDaily(now: Date): Promise<boolean> {
  if (now.getUTCHours() !== env.ALERT_DIGEST_HOUR_UTC) return false;
  const today = now.toISOString().slice(0, 10);
  const doneKey = `daily_done:${today}`;
  const { data: done } = await db().from("alert_state").select("key").eq("key", doneKey).maybeSingle();
  if (done) return false;
  const slot = `daily_try:${today}:${Math.floor(now.getUTCMinutes() / 5)}`;
  const { error: claimErr } = await db().from("alert_state").insert({ key: slot, at: now.toISOString() });
  if (claimErr) return false; // another tick holds this slot
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), env.ALERT_DIGEST_HOUR_UTC));
  const from = new Date(to.getTime() - 24 * 60 * MIN);
  // The counts first, independent of the email.
  await rollupAndPrune(from);
  const s = await summarise(from, to);
  const res = await sendEmail(summaryEmail(s));
  if (!res.ok && !res.skipped) {
    trackFailure("alert_email_failed", res.error, { category: "ops", alert: "digest", props: { kind: "daily" } });
    return false; // the next slot retries
  }
  await setState(doneKey, now, today);
  if (res.ok) track("alert_email_sent", { category: "ops", props: { kind: "daily" } });
  return res.ok;
}

/** The whole pass, every minute. Never throws: alerting must not break the tick that also revives stalled builds. */
export async function runAlerts(now = new Date()): Promise<AlertsReport> {
  const report: AlertsReport = { immediate: 0, digest: 0, daily: false };
  if (!emailConfigured()) report.skipped = "email not configured (RESEND_API_KEY + ALERT_EMAIL_TO)";
  for (const [step, fn] of [
    ["immediate", () => runImmediate(now).then((n) => void (report.immediate = n))],
    ["digest", () => runDigest(now).then((n) => void (report.digest = n))],
    ["daily", () => runDaily(now).then((b) => void (report.daily = b))],
  ] as const) {
    // Without email, nothing is marked sent — the incidents wait for the key.
    // The daily rollup and prune still run.
    if (report.skipped && step !== "daily") continue;
    try {
      await fn();
    } catch (err) {
      trackFailure("alerts_pass_failed", err, { category: "ops", alert: "digest", props: { step } });
    }
  }
  await flushTracking();
  return report;
}
