// Charles — tracking: what people do, how the platform performs, what goes wrong.
//
// Founder, 2026-10: "We want to know what our users are trying to do, also how
// our system fails… in-depth." Before this, behaviour lived in the message log,
// performance in free-text safety_events rows and console lines, and most
// failures only in Vercel's logs, which nobody reads until something is
// already on fire. Nothing told anyone anything.
//
// One table (events, db/0024) and three calls:
//   track(name, …)        something happened — a person tapped, a stage was
//                         entered, a model answered in 3.1s.
//   trackFailure(name, …) something broke. Also counted in `incidents`, which
//                         the per-minute tick turns into an email (alerts.ts).
//   trackUnmet(name, …)   a person tried to do something Charles could not.
//                         Counted and emailed the same way.
//
// Rules this file keeps, so no call site has to remember them:
//   - It never throws and never blocks. Events are buffered and written in
//     batches; flushTracking() at the end of a job or request waits for them.
//     A tracking outage is one console line, never a person left waiting.
//   - No phone number is ever stored. The business id is; `internal` says
//     whether the number is one of ours (env INTERNAL_WA_IDS).
//   - A person's own words go only in `excerpt`: 200 characters, numbers,
//     emails and links stripped. "forget my business" wipes it (db/0024).
//   - Who and where come from the turn: handleInbound, the web and the
//     connector open a context (withTrackContext), and every event inside it
//     — however deep, a guardrail's model call included — carries the same
//     business, channel, stage and turn id without anyone passing them.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { db } from "./db.js";

export type EventCategory = "behaviour" | "funnel" | "performance" | "failure" | "unmet_request" | "security" | "ops";
export type Severity = "info" | "warn" | "error" | "critical";
export type Channel = "whatsapp" | "web" | "mcp" | "system";
export type AlertLevel = "none" | "digest" | "immediate";

export interface TrackContext {
  businessId?: string | null;
  channel?: Channel;
  turnId?: string | null;
  stage?: string | null;
  country?: string | null;
  internal?: boolean;
  jobId?: number | null;
  /** What the person said this turn (scrubbed on write): the default excerpt for an unmet request. */
  said?: string | null;
  /** One id for everything a request did when it is not a WhatsApp turn or a job (intel.ts). */
  traceId?: string | null;
  /** Shared by everything under one tracked() request: why it failed, for request_failed. */
  request?: { failure?: string };
}

export interface TrackOptions {
  category?: EventCategory;
  severity?: Severity;
  /** Overrides the context's business (e.g. a cron acting on one owner). */
  businessId?: string | null;
  stage?: string | null;
  channel?: Channel;
  ms?: number | null;
  /** Small, structured, never secret, never a phone number. */
  props?: Record<string, unknown>;
  /** What the person said, if it matters. Scrubbed and cut here. */
  excerpt?: string | null;
  /** Failures and unmet requests: how loudly to tell a human. Defaults by severity. */
  alert?: AlertLevel;
  /** Groups repeats of the same problem into one incident. Defaults to the event name (+ error class). */
  fingerprint?: string;
  /** One line a human reads in the alert email. */
  summary?: string;
  /** Overrides the context's internal flag (e.g. a webhook receipt for one of our own numbers). */
  internal?: boolean;
}

const ctxStore = new AsyncLocalStorage<TrackContext>();

/** Runs `fn` with these facts attached to every event inside it, merged over any outer context. */
export function withTrackContext<T>(ctx: TrackContext, fn: () => Promise<T>): Promise<T> {
  const outer = ctxStore.getStore() ?? {};
  return ctxStore.run({ ...outer, ...ctx }, fn);
}

/** Fills in a fact learned mid-turn (the business found, the stage it is in). */
export function setTrackContext(patch: TrackContext): void {
  const store = ctxStore.getStore();
  if (store) Object.assign(store, patch);
}

export function currentTrackContext(): TrackContext {
  return { ...(ctxStore.getStore() ?? {}) };
}

// ── Scrubbing ────────────────────────────────────────────────────

/**
 * Cut to n UTF-16 units without leaving half an emoji: Postgres rejects a
 * lone surrogate in jsonb/text, and with it the whole batch of events.
 */
export const cutSafe = (s: string, n: number): string => s.slice(0, n).replace(/[\uD800-\uDBFF]$/, "");
const wellFormed = (s: string): string => (typeof (s as { toWellFormed?: () => string }).toWellFormed === "function" ? (s as unknown as { toWellFormed(): string }).toWellFormed() : s);

/** A person's words, safe to keep: no phone numbers, emails, links or ids; 200 characters. */
export function scrubExcerpt(text: string | null | undefined, max = 200): string | null {
  const t = String(text ?? "")
    .replace(/https?:\/\/\S+|www\.\S+/gi, "[link]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[number]")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  return wellFormed(t.length > max ? `${cutSafe(t, max - 1)}…` : t);
}

/** Text for a fingerprint or an email: digits, ids and quoted values flattened, so repeats group. */
export function normaliseForFingerprint(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/"[^"]{0,200}"|'[^']{0,200}'/g, "<v>")
    // Trace ids, message ids, tokens: anything long that mixes letters and digits.
    .replace(/\b(?=[a-z0-9_-]*\d)(?=[a-z0-9_-]*[a-z])[a-z0-9_-]{9,}\b/g, "<id>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** An error's message, safe for an email or a fingerprint: numbers masked, cut short. */
export function errorText(err: unknown): string {
  let raw: string;
  try {
    // A model provider's error body can echo the request (the person's words):
    // only its status and kind are kept (models.ts ModelError).
    if (err instanceof Error && err.name === "ModelError") raw = `ModelError: ${(err as { status?: unknown }).status ?? ""} ${(err as { kind?: unknown }).kind ?? ""} ${err.message.split(":")[0]}`.trim();
    else if (err instanceof Error) raw = `${err.name === "Error" ? "" : `${err.name}: `}${err.message}`;
    else if (typeof err === "string") raw = err;
    else if (err && typeof err === "object") {
      // A Supabase/PostgREST error is a plain object whose `details` and
      // `hint` can quote the failing row — a person's words. Only its code
      // and message are kept (review, 2026-10: a log_error carried "Failing
      // row contains (…)").
      const o = err as { code?: unknown; message?: unknown; status?: unknown };
      raw = [o.code, o.status, o.message].filter((x) => x !== undefined && x !== null && x !== "").map(String).join(" ") || Object.prototype.toString.call(err);
    } else raw = String(err);
  } catch {
    raw = "unreadable error";
  }
  return raw
    .replace(/Failing row contains \(.*?\)/gi, "Failing row contains (…)")
    .replace(/\bwamid\.[A-Za-z0-9+/=_-]+/g, "wamid.<id>")
    .replace(/\+?\d[\d\s-]{7,}\d/g, "[number]")
    .slice(0, 400);
}

/** A WhatsApp message id encodes the phone number, so the turn id is a hash of it. */
export function turnIdFor(waMessageId: string | null | undefined): string | null {
  if (!waMessageId) return null;
  return `t_${createHash("sha256").update(waMessageId).digest("hex").slice(0, 16)}`;
}

// ── Writing ──────────────────────────────────────────────────────

interface EventRow {
  at: string;
  name: string;
  category: EventCategory;
  severity: Severity;
  business_id: string | null;
  channel: Channel | null;
  country: string | null;
  stage: string | null;
  turn_id: string | null;
  job_id: number | null;
  ms: number | null;
  props: Record<string, unknown>;
  excerpt: string | null;
  fingerprint: string | null;
  internal: boolean;
}

const buffer: EventRow[] = [];
const inflight = new Set<Promise<unknown>>();
let timer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_AFTER_MS = 250;
const BATCH = 50;
/** One "tracking is down" console line per process, not one per event. */
let warnedDown = false;

function off(): boolean {
  return process.env.TRACKING_OFF === "1";
}

/** Props are kept small and JSON-safe; anything that is not becomes a string. */
function cleanProps(p: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!p) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    if (v === null || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = wellFormed(v.length > 300 ? `${cutSafe(v, 299)}…` : v);
    else {
      try {
        const s = JSON.stringify(v);
        out[k] = s.length > 1000 ? wellFormed(`${cutSafe(s, 999)}…`) : JSON.parse(s);
      } catch {
        out[k] = String(v);
      }
    }
  }
  return out;
}

function schedule(): void {
  if (buffer.length >= BATCH) {
    void writeBatch();
    return;
  }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void writeBatch();
  }, FLUSH_AFTER_MS);
  timer.unref?.();
}

function writeBatch(): Promise<unknown> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!buffer.length) return Promise.resolve();
  const rows = buffer.splice(0, buffer.length);
  const p = (async () => {
    try {
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const { error } = await db().from("events").insert(batch);
        // 23503: a person in the batch was deleted (forgotten) before it was
        // written. Keep the events, anonymised, rather than lose the batch.
        if (error && (error as { code?: string }).code === "23503") {
          // Only the forgotten owner's rows lose their link — not every
          // other owner's events that happened to share the batch.
          const anon = (r: EventRow) => ({ ...r, business_id: null, excerpt: null, turn_id: null });
          const ids = [...new Set(batch.map((r) => r.business_id).filter((x): x is string => Boolean(x)))];
          const { data: alive } = await db().from("businesses").select("id").in("id", ids);
          const keep = new Set(((alive as { id: string }[] | null) ?? []).map((b) => b.id));
          let { error: again } = await db().from("events").insert(batch.map((r) => (r.business_id && !keep.has(r.business_id) ? anon(r) : r)));
          // Another owner deleted in between: anonymise the lot rather than lose it.
          if (again && (again as { code?: string }).code === "23503") ({ error: again } = await db().from("events").insert(batch.map(anon)));
          if (again) throw again;
        } else if (error) throw error;
      }
    } catch (err) {
      if (!warnedDown) {
        warnedDown = true;
        console.warn(`track: events could not be written (${errorText(err)}) — is db/0024 applied? Further failures are not logged.`);
      }
    }
  })();
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
  return p;
}

function bump(row: EventRow, alert: AlertLevel, summary: string): void {
  const p = (async () => {
    try {
      const { error } = await db().rpc("bump_incident", {
        p_fingerprint: row.fingerprint,
        p_name: row.name,
        p_category: row.category,
        p_severity: row.severity,
        p_alert: alert,
        p_summary: summary,
        // Charles's own words (apology_sent's reply) stay on the event, never on
        // the incident row that outlives it.
        p_props: { ...Object.fromEntries(Object.entries(row.props).filter(([k]) => k !== "reply")), stage: row.stage, channel: row.channel, country: row.country, internal: row.internal },
      });
      if (error) throw error;
    } catch (err) {
      if (!warnedDown) {
        warnedDown = true;
        console.warn(`track: incident could not be counted (${errorText(err)}) — is db/0024 applied?`);
      }
    }
  })();
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

const RANK: Record<Severity, number> = { info: 0, warn: 1, error: 2, critical: 3 };

/**
 * Unauthenticated noise (a scanner posting to the webhook, a wrong admin
 * secret) is one event per kind per instance per minute, not one per request:
 * each would otherwise cost database writes on a path anyone can hit.
 */
const lastSecurity = new Map<string, number>();
const SECURITY_EVERY_MS = 60_000;

// ── Listeners and flushers (Chase Intelligence, intel.ts) ────────
// Every event is also handed to whoever listens (intel.ts records it in
// full, for good), and flushTracking() waits for their writes too. Neither
// can throw into track() or hold it up.

type TrackListener = (name: string, opts: TrackOptions, ctx: TrackContext) => void;
type Flusher = { flush: () => Promise<unknown> | void; pending: () => boolean };

// Held on globalThis, reached through a hoisted function: a listener can
// register while this module is still loading (db.ts → intel.ts → here is an
// import cycle), when a module-level const would not exist yet.
function registry(): { listeners: TrackListener[]; flushers: Flusher[] } {
  const g = globalThis as { __chaseTrackRegistry?: { listeners: TrackListener[]; flushers: Flusher[] } };
  return (g.__chaseTrackRegistry ??= { listeners: [], flushers: [] });
}

export function onTrack(fn: TrackListener): void {
  registry().listeners.push(fn);
}

export function registerFlusher(f: Flusher): void {
  registry().flushers.push(f);
}

/** For a listener's own writes: flushTracking() waits for them like its own. */
export function holdForFlush(p: Promise<unknown>): void {
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

const pendingElsewhere = (): boolean => registry().flushers.some((f) => {
  try {
    return f.pending();
  } catch {
    return false;
  }
});

/** Something happened. Never throws, never waits. */
export function track(name: string, opts: TrackOptions = {}): void {
  for (const l of registry().listeners) {
    try {
      l(name, opts, ctxStore.getStore() ?? {});
    } catch {
      // A listener is never the reason an event, or a turn, fails.
    }
  }
  if (off()) return;
  try {
    const ctx = ctxStore.getStore() ?? {};
    const category = opts.category ?? "behaviour";
    const severity = opts.severity ?? (category === "failure" ? "error" : category === "unmet_request" ? "warn" : "info");
    const isProblem = category === "failure" || category === "unmet_request" || RANK[severity] >= RANK.warn;
    const fingerprint = isProblem ? (opts.fingerprint ?? name).slice(0, 200) : null;
    if (category === "security") {
      const key = fingerprint ?? name;
      const now = Date.now();
      if (now - (lastSecurity.get(key) ?? 0) < SECURITY_EVERY_MS) return;
      lastSecurity.set(key, now);
    }
    const row: EventRow = {
      at: new Date().toISOString(),
      name: name.slice(0, 80),
      category,
      severity,
      business_id: opts.businessId !== undefined ? opts.businessId : (ctx.businessId ?? null),
      channel: opts.channel ?? ctx.channel ?? null,
      country: ctx.country ?? null,
      stage: (opts.stage !== undefined ? opts.stage : ctx.stage) ?? null,
      turn_id: ctx.turnId ?? null,
      job_id: ctx.jobId ?? null,
      // Clamped to the column (int4): one out-of-range value would lose the batch.
      ms: typeof opts.ms === "number" && Number.isFinite(opts.ms) ? Math.min(Math.max(Math.round(opts.ms), 0), 2_147_483_647) : null,
      // An unmet request marked "not emailed" says so on the row: the hourly
      // digest reads rows, not incidents (review, 2026-10: an AI client's
      // probe for an optional method sent an hourly email on its own).
      props: cleanProps(category === "unmet_request" && opts.alert === "none" ? { ...opts.props, alert: "none" } : opts.props),
      excerpt: scrubExcerpt(opts.excerpt),
      fingerprint,
      internal: opts.internal ?? Boolean(ctx.internal),
    };
    buffer.push(row);
    schedule();
    if (isProblem) {
      // Our own numbers (INTERNAL_WA_IDS) are tracked, but never page anyone.
      const wanted: AlertLevel = opts.alert ?? (RANK[severity] >= RANK.error ? "immediate" : "digest");
      const alert: AlertLevel = row.internal && wanted === "immediate" ? "digest" : wanted;
      if (alert !== "none" || category === "failure") bump(row, alert, opts.summary ?? name.replace(/_/g, " "));
    }
  } catch (err) {
    // Tracking must never be the reason a turn fails.
    if (!warnedDown) {
      warnedDown = true;
      console.warn(`track: ${name} not recorded (${errorText(err)})`);
    }
  }
}

/**
 * Something broke. `err` becomes a masked message in props and, with the
 * event name, the incident fingerprint — so "OpenRouter 402" and "OpenRouter
 * timeout" are two incidents, but the same timeout a hundred times is one.
 */
export function trackFailure(name: string, err: unknown, opts: TrackOptions = {}): void {
  const message = errorText(err);
  const kind = err instanceof Error && err.name && err.name !== "Error" ? err.name : "";
  track(name, {
    ...opts,
    category: opts.category ?? "failure",
    severity: opts.severity ?? "error",
    props: { error: message, ...(kind ? { error_kind: kind } : {}), ...(opts.props ?? {}) },
    fingerprint: opts.fingerprint ?? `${name}:${normaliseForFingerprint(kind || message).slice(0, 120)}`,
    summary: opts.summary ?? `${name.replace(/_/g, " ")}: ${message.slice(0, 200)}`,
  });
}

/** A person tried to do something Charles could not. */
export function trackUnmet(name: string, opts: TrackOptions = {}): void {
  const said = opts.excerpt !== undefined ? opts.excerpt : (ctxStore.getStore()?.said ?? null);
  track(name, { alert: "digest", ...opts, excerpt: said, category: "unmet_request", severity: opts.severity ?? "warn" });
}

/** Wait for every buffered event to be written (end of a job, a request, a cron). Bounded. */
export async function flushTracking(timeoutMs = 4000): Promise<void> {
  void writeBatch();
  for (const f of registry().flushers) {
    try {
      const p = f.flush();
      if (p) holdForFlush(p);
    } catch {
      // never
    }
  }
  if (!inflight.size) return;
  let done = false;
  const all = (async () => {
    while (inflight.size) await Promise.allSettled([...inflight]);
    done = true;
  })();
  await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs).unref?.())]);
  if (!done) console.warn(`track: ${inflight.size} write(s) still pending after ${timeoutMs}ms`);
}

/** Milliseconds since `started`, for `ms`. */
export const since = (started: number): number => Date.now() - started;

// ── Catch-alls ───────────────────────────────────────────────────

let consoleHooked = false;

/**
 * Every console.error in the codebase becomes a failure event, and every
 * console.warn a warning — so a failure nobody wrote an event for is still on
 * the record and still reaches an email. Installed once per process (by the
 * entrypoints). The message is masked and grouped by its first words; the
 * original console call still happens exactly as before.
 *
 * So which one a line uses decides what reaches the founder (round 20, all
 * 148 sites audited, each change checked by a second reader):
 *   console.error  failed, NOT recovered, and nothing else records it at error
 *   console.warn   failed but recovered here (a retry follows, a fallback is
 *                  used, a best-effort side task) — still in the hourly email
 *   console.log    already recorded by its own event (model_call_failed,
 *                  wa_send_failed, job_retry/job_dead, pdf_failed,
 *                  request_failed…), or not a failure at all
 * A failure that later recovers is never an error: round 20's "model fail
 * [memory]" was one, though the fallback model answered seconds later.
 */
export function installConsoleCapture(): void {
  if (consoleHooked || off()) return;
  consoleHooked = true;
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  let inside = false;
  const capture = (severity: Severity, args: unknown[]) => {
    if (inside) return;
    inside = true;
    try {
      // Only the label of a formatted line ("model bad-json [build:strategy]")
      // and the sanitised error objects: the free text after a colon can be
      // model output or a provider's error body — a person's words — and an
      // incident outlives "forget my business" (review, 2026-10).
      const first = typeof args[0] === "string" ? (args[0] as string) : "";
      if (first.startsWith("track:")) return; // our own "tracking is down" line
      // Expected, already-tracked noise is not a second incident.
      if (/^wa: .* over WhatsApp's/.test(first) || /^webhook refused: bad or missing/.test(first)) return;
      // Recorded as wa_number_lookup_failed, with the HTTP status this label would lose.
      if (/^wa-number: Meta/.test(first)) return;
      // The runtime's own warnings ("(node:6) ExperimentalWarning…") are not Charles's failures.
      if (/^\(node:\d+\)/.test(first)) return;
      const label = first.split(/:\s|\n/)[0]!.trim().slice(0, 120);
      const objects = args.slice(first ? 1 : 0).filter((a) => typeof a !== "string").map((a) => errorText(a));
      const text = [label, ...objects].filter(Boolean).join(" — ") || "log";
      // Leading punctuation off first: a line starting "(" or ":" used to leave
      // the fingerprint empty, so unrelated lines all became "log_error:log"
      // (round 20: Node's own warning, filed under that name four times).
      const lead = text.replace(/^\s*\(([^)]{0,60})\)\s*/, "$1 ").replace(/^[\s([{:'"`—–-]+/, "");
      const head = normaliseForFingerprint(lead.split(/[:\n(]/)[0] ?? lead).slice(0, 60) || "log";
      track(severity === "warn" ? "log_warning" : "log_error", {
        category: "failure",
        severity,
        props: { message: errorText(text) },
        fingerprint: `log_${severity}:${head}`,
        summary: `${severity === "warn" ? "Warning" : "Error"} logged: ${errorText(text).slice(0, 200)}`,
        // Hourly, not immediate: many logged errors are a step that was then
        // retried or fell back. Failures that reached a person have their own
        // events (job_dead, wa_send_failed, model_call_failed…) and those email
        // straight away.
        alert: "digest",
      });
    } catch {
      /* never */
    } finally {
      inside = false;
    }
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    capture("error", args);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    capture("warn", args);
  };
  process.on("unhandledRejection", (reason) => {
    trackFailure("unhandled_rejection", reason, { severity: "critical", alert: "immediate" });
  });
}

/**
 * "forget my business": events still in this process's buffer for that owner
 * lose their link and their words before they are written, or the batch
 * would point at a business that no longer exists (and the foreign key
 * would refuse the whole batch).
 */
export function forgetBuffered(businessId: string): void {
  for (const r of buffer) {
    if (r.business_id === businessId) {
      r.business_id = null;
      r.excerpt = null;
      r.turn_id = null;
    }
  }
}

/** Test helper: what is buffered and not yet written. */
export function __pendingEvents(): readonly EventRow[] {
  return buffer;
}

// ── Entry points ─────────────────────────────────────────────────

/**
 * Every Vercel function's handler goes through this: console capture on, a
 * channel for its events, one http_request event (not for health checks or
 * CORS preflights), a crash or a 5xx as a failure, and the buffered events
 * written before the function can be frozen.
 */
/**
 * Why this request is about to answer 500, for its request_failed event. An
 * endpoint's catch-all logs with console.log (request_failed is the record),
 * so without this the email said only "ask answered 500" (review, round 20).
 */
export function noteRequestFailure(err: unknown): void {
  const request = ctxStore.getStore()?.request;
  if (request) request.failure = errorText(err).slice(0, 300);
}

export function tracked(fn: string, channel: Channel, handler: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  installConsoleCapture();
  return async (req: Request) => {
    const started = Date.now();
    // Health checks, preflights and the queue's own self-calls (the per-minute
    // tick, hand-ons, the watch runner) are not traffic worth an event each.
    const quiet = req.method === "OPTIONS" || fn === "health" || /[?&](tick|watch|async)=1\b/.test(req.url);
    // One object, shared by reference with every context nested inside.
    const request: { failure?: string } = {};
    return withTrackContext({ channel, request, traceId: `r_${randomUUID().replace(/-/g, "").slice(0, 16)}` }, async () => {
      let status = 0;
      try {
        const res = await handler(req);
        status = res.status;
        return res;
      } catch (err) {
        status = 500;
        trackFailure("request_crashed", err, { severity: "critical", alert: "immediate", props: { fn, method: req.method }, fingerprint: `request_crashed:${fn}` });
        throw err;
      } finally {
        const path = (() => {
          try {
            const u = new URL(req.url);
            // Which view or action, never a token or code in the query string.
            const q = ["action", "view", "watch", "tick", "async"].filter((k) => u.searchParams.has(k)).map((k) => `${k}=${(u.searchParams.get(k) ?? "").slice(0, 20)}`);
            // A person's connector token is part of its URL (/mcp/<token>, and
            // ?k= on the rewrite): never stored, never emailed (review, 2026-10).
            const pathname = u.pathname.replace(/^\/mcp\/[^/]+/, "/mcp/<token>").replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, "/<token>");
            return `${pathname}${q.length ? `?${q.join("&")}` : ""}`;
          } catch {
            return "";
          }
        })();
        if (!quiet) track("http_request", { category: "performance", ms: Date.now() - started, props: { fn, method: req.method, status, path } });
        if (status >= 500 && status !== 503) {
          track("request_failed", {
            category: "failure",
            severity: "error",
            alert: "immediate",
            props: { fn, method: req.method, status, path, ...(request.failure ? { error: request.failure } : {}) },
            fingerprint: `request_failed:${fn}:${status}`,
            summary: `${fn} answered ${status} (${path})${request.failure ? `: ${request.failure.slice(0, 160)}` : ""}`,
          });
        }
        // Written after the response, not before it: Meta wants its 200
        // fast, and a person's page should not wait on our bookkeeping.
        if (buffer.length || inflight.size || pendingElsewhere()) waitUntil(flushTracking(2500));
      }
    });
  };
}
