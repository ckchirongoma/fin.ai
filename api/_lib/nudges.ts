// Charles — following up, sparingly.
//
// Every message here interrupts someone at work, and outside WhatsApp's
// 24-hour window it also costs money and needs a template Meta approved in
// advance. So the bar is high and "send nothing" is an explicitly good outcome,
// stated in the prompt and enforced in code.
//
// The cap is not decoration: block rates above a few percent drag a number's
// quality rating down, and a bad rating is what stops a pilot growing. Opting
// out is one tap and takes effect immediately.

import { askJSON } from "./models.js";
import { gateNudge } from "./judgement.js";
import { nudgePrompt } from "./prompts.js";
import { graphSheet, householdGraph, moneyDays } from "./graph.js";
import { fitLabel, sendTemplate, sendText, withinServiceWindow } from "./wa.js";
import { db, findBusinessById, openCommitments, planFor, recordMessage } from "./db.js";
import { firstOpenStep } from "./engine/context.js";
import type { Business } from "./types.js";
import { isInternalNumber } from "./env.js";
import { track, trackFailure, withTrackContext } from "./track.js";

const DAY = 864e5;

interface TemplateRow {
  id: string;
  meta_name: string | null;
  language: string;
  body: string;
  variables: string[];
  status: string;
}

/** Businesses that could reasonably be nudged today. Cheap query, run first. */
export async function nudgeCandidates(limit = 200): Promise<Business[]> {
  const { data, error } = await db()
    .from("businesses")
    .select("*")
    .eq("paused", false)
    .not("current_plan_id", "is", null)
    .order("last_outbound_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) console.error("nudgeCandidates failed: nobody is nudged this run", error);
  return (data as Business[]) ?? [];
}

async function recentNudges(businessId: string, days = 7): Promise<{ template_id: string; sent_at: string }[]> {
  const since = new Date(Date.now() - days * DAY).toISOString();
  const { data, error } = await db()
    .from("nudges")
    .select("template_id, sent_at")
    .eq("business_id", businessId)
    .eq("status", "sent")
    .gte("sent_at", since);
  // Read as "none sent", which lets this owner past the weekly cap.
  if (error) console.error("recentNudges failed: the weekly cap could not be checked", error);
  return (data as { template_id: string; sent_at: string }[]) ?? [];
}

async function approvedTemplates(): Promise<TemplateRow[]> {
  const { data, error } = await db().from("wa_templates").select("*");
  if (error) console.error("approvedTemplates failed", error);
  return (data as TemplateRow[]) ?? [];
}

/**
 * An error, safe for trackFailure: a database error becomes its code and
 * message, never `details`, where Postgres puts the failing row (a business
 * row carries the person's number and their own words).
 */
function dbError(err: unknown): unknown {
  if (err instanceof Error || typeof err === "string") return err;
  const e = (err && typeof err === "object" ? err : {}) as { code?: unknown; message?: unknown };
  return `${e.code ? `${String(e.code)}: ` : ""}${e.message !== undefined ? String(e.message) : "database error"}`.slice(0, 300);
}

/** Fill {{1}}, {{2}} … from an ordered list. Meta's placeholders are positional. */
export function fillTemplate(body: string, variables: Record<string, string>): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => variables[n] ?? variables[String(Number(n))] ?? "").trim();
}

export interface NudgeDecision {
  send: boolean;
  templateId: string | null;
  variables: Record<string, string>;
  reason: string;
}

/**
 * "Send nothing" is a good outcome, so it is not a failure — but which reason
 * it was is what tells a cap working from a writer that never says yes, or
 * templates Meta has not approved yet.
 */
function nudgeSkipped(reason: string, props: Record<string, unknown> = {}): void {
  track("nudge_skipped", { category: "behaviour", props: { reason, ...props } });
}

export async function decideNudge(biz: Business): Promise<NudgeDecision> {
  const prefs = biz.nudge_prefs ?? { day: "monday", hour: 7, max_per_week: 2 };
  const sent = await recentNudges(biz.id);

  // Hard caps first, so a model can never talk its way past them.
  if (sent.length >= (prefs.max_per_week ?? 2)) {
    nudgeSkipped("weekly_cap", { sent_this_week: sent.length });
    return { send: false, templateId: null, variables: {}, reason: "weekly cap already reached" };
  }
  if (biz.last_outbound_at && Date.now() - new Date(biz.last_outbound_at).getTime() < 2 * DAY) {
    nudgeSkipped("spoke_recently");
    return { send: false, templateId: null, variables: {}, reason: "we spoke in the last two days" };
  }

  const [templates, commitments, plan, g] = await Promise.all([approvedTemplates(), openCommitments(biz.id), planFor(biz.id), householdGraph(biz)]);
  const days = moneyDays(g);
  const usable = templates.filter((t) => t.status === "approved" && t.meta_name);
  if (!usable.length) {
    nudgeSkipped("no_templates", { templates: templates.length });
    return { send: false, templateId: null, variables: {}, reason: "no approved templates yet" };
  }

  const next = plan ? firstOpenStep(plan.steps) : null;
  const now = new Date();

  try {
    const r = await askJSON(
      "wa_reply",
      nudgePrompt({
        countryCode: biz.country,
        ctx: biz.context ?? biz.identity ?? {},
        today: now.toISOString().slice(0, 10),
        weekday: now.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }),
        lastActive: biz.last_inbound_at ?? "never",
        openCommitments: commitments.map((c) => `${c.what} (due ${c.due ?? "no date"})`).join("; ") || "none",
        recentNudges: sent.map((s) => s.template_id).join(", ") || "none",
        prefs: JSON.stringify(prefs),
        templates: usable.map((t) => `${t.id}: "${t.body}" variables: ${t.variables.join(", ") || "none"}`).join("\n"),
        nextStep: next ? `${next.title} — ${next.push ?? ""}`.slice(0, 300) : "",
        memoryGraph: graphSheet(g, 10, 900),
        moneyLands: days.lands,
        moneyGoes: days.goes,
      }),
      // 400 -> 900: wa_reply with "low" reasoning (db/0009), same missed-
      // audit as every other call site fixed in the 2026-09-20 incident.
      // reasoning off: choosing which template fits is a classification, not
      // prose generation — the templates' own wording is fixed by Meta.
      { maxTokens: 900, temperature: 0.2, label: "nudge", reasoning: { enabled: false } },
    );

    const templateId = typeof r.template_id === "string" ? r.template_id : null;
    const chosen = usable.find((t) => t.id === templateId) ?? null;
    if (r.send !== true || !chosen) {
      // The writer's own reason is model prose: not kept here.
      nudgeSkipped(r.send === true ? "unknown_template" : "writer_declined");
      return { send: false, templateId: null, variables: {}, reason: String(r.reason ?? "nothing worth sending") };
    }
    const vars: Record<string, string> = {};
    // Shortened at a word, never inside one: a 60-character cut sent "…and
    // offer them the m?" (audit, 2026-10). The prompt asks for under 60.
    for (const [k, v] of Object.entries((r.variables as Record<string, unknown>) ?? {})) vars[k] = fitLabel(String(v), 80);

    // The gate: the writer wants to send; would it help, or repeat itself?
    const gate = await gateNudge(
      fillTemplate(chosen.body, vars),
      {
        business: biz.context ?? biz.identity ?? {},
        daysSinceLastMessage: biz.last_inbound_at ? Math.floor((Date.now() - new Date(biz.last_inbound_at).getTime()) / DAY) : null,
        openCommitments: commitments.map((c) => c.what).join("; ") || "none",
        recentNudges: sent.map((s) => s.template_id).join(", ") || "none",
      },
      { businessId: biz.id },
    );
    if (gate.skip) {
      nudgeSkipped("gate", { template_id: chosen.id });
      return { send: false, templateId: null, variables: {}, reason: gate.reason };
    }

    return { send: true, templateId: chosen.id, variables: vars, reason: String(r.reason ?? "") };
  } catch (err) {
    console.log("decideNudge failed", err);
    nudgeSkipped("writer_failed");
    trackFailure("nudge_failed", dbError(err), { severity: "warn", props: { phase: "writer" }, summary: "The nudge writer failed, so a person due a follow-up got none" });
    return { send: false, templateId: null, variables: {}, reason: "nudge writer unavailable" };
  }
}

export async function sendOneNudge(businessId: string): Promise<boolean> {
  const biz = await findBusinessById(businessId);
  if (!biz || biz.paused) return false;
  // From the daily cron this runs for one owner after another: every event
  // inside (the writer's model call, the gate, the send) is this owner's.
  return withTrackContext({ businessId: biz.id, stage: biz.stage, country: biz.country, internal: isInternalNumber(biz.wa_id) }, () => nudgeOwner(biz));
}

async function nudgeOwner(biz: Business): Promise<boolean> {
  const decision = await decideNudge(biz);
  if (!decision.send || !decision.templateId) {
    const { error } = await db().from("nudges").insert({ business_id: biz.id, template_id: decision.templateId, status: "skipped", reason: decision.reason });
    if (error) console.warn("nudge skip could not be recorded", error);
    return false;
  }

  const templates = await approvedTemplates();
  const t = templates.find((x) => x.id === decision.templateId);
  if (!t?.meta_name) {
    // Chosen a moment ago from the approved list, gone now: nothing is sent and no row says why.
    trackFailure("nudge_failed", "the chosen template has no Meta name any more", { severity: "warn", props: { phase: "template", template_id: decision.templateId } });
    return false;
  }

  const ordered = t.variables.map((_v, i) => decision.variables[String(i + 1)] ?? "");

  // Inside the 24-hour window a free-form message is allowed, costs nothing and
  // reads better. Outside it, only the approved template will deliver at all.
  const inWindow = withinServiceWindow(biz.last_inbound_at);
  const result = inWindow
    ? await sendText(biz.wa_id, fillTemplate(t.body, decision.variables), biz.id)
    : await sendTemplate(biz.wa_id, t.meta_name, t.language, ordered, biz.id);

  const { error: recordError } = await db().from("nudges").insert({
    business_id: biz.id,
    template_id: t.id,
    variables: decision.variables,
    reason: decision.reason,
    status: result.ok ? "sent" : "failed",
  });
  // A sent nudge with no row does not count toward the weekly cap.
  if (recordError) console.error("nudge could not be recorded", recordError);

  if (result.ok) {
    track("nudge_sent", {
      category: "behaviour",
      props: {
        template_id: t.id,
        how: inWindow ? "free_form" : "template",
        days_quiet: biz.last_inbound_at ? Math.floor((Date.now() - new Date(biz.last_inbound_at).getTime()) / DAY) : null,
      },
    });
    const { error: markError } = await db().from("businesses").update({ last_outbound_at: new Date().toISOString() }).eq("id", biz.id);
    if (markError) console.warn("nudge sent but last_outbound_at not updated", markError);
    const { error: nudgedError } = await db().from("commitments").update({ nudged_at: new Date().toISOString() }).eq("business_id", biz.id).eq("status", "open");
    if (nudgedError) console.warn("nudge sent but commitments not marked nudged", nudgedError);
  } else {
    // WhatsApp's refusal is wa_send_failed (immediate) and a closed window
    // wa_window_closed, both from wa.ts; this is the nudge that did not land.
    trackFailure("nudge_failed", result.error ?? "the send did not land", {
      severity: "error",
      alert: "digest",
      props: { phase: "send", template_id: t.id, in_window: inWindow, window_closed: Boolean(result.windowClosed), code: result.code ?? null, skipped: Boolean(result.skipped) },
      fingerprint: `nudge_failed:send:${result.windowClosed ? "window_closed" : (result.code ?? "other")}`,
      summary: `A follow-up nudge did not reach a person${result.windowClosed ? ": a free-form message was tried after their 24-hour window had closed" : ""}`,
    });
    if (result.windowClosed) {
      console.log(`nudge to ${biz.wa_id} needed a template but a free-form message was attempted`);
    }
  }
  return result.ok;
}

/** One pass over everyone due. Idempotent: safe to run more than once a day. */
export async function runNudgeSweep(limit = 200): Promise<{ considered: number; sent: number }> {
  const candidates = await nudgeCandidates(limit);
  let sent = 0;
  for (const biz of candidates) {
    try {
      if (await sendOneNudge(biz.id)) sent++;
    } catch (err) {
      console.log("nudge failed for", biz.wa_id, err);
      trackFailure("nudge_failed", dbError(err), { businessId: biz.id, props: { phase: "sweep" } });
    }
  }
  return { considered: candidates.length, sent };
}
