// Chase Intelligence — record everything a task did, in order, from one id.
// The contract every Chase repository writes is docs/INTEL-CONTRACT.md.
//
// One table (intel_events, db/0041) and one call:
//   capture(kind, { name, content, meta, ok, ms })
// Kinds: ask (what a person sent), say (what Charles sent), model (a model
// call: everything it was shown, everything it answered), check (a guardrail),
// tool (a connector call), send (a WhatsApp delivery), job (a queued job),
// track (every product event track() records, kept here for good), error.
//
// Rules this file keeps, so no call site has to remember them:
//   - Additive. It never throws into the code it watches and never waits on
//     the request path: capture() serialises and buffers (well under 5 ms at
//     p95, pinned in test/intel.test.ts); the write happens in a batch, after
//     the response, through flushTracking().
//   - Nothing secret leaves the process: every row goes through
//     intelredact.ts before it is written, and again on export.
//   - No phone number is stored. Files and images sent in a prompt are kept as
//     their type and size, never their bytes (CLAUDE.md rule 12).
//   - One id per task: the WhatsApp turn id, else the job id, else the
//     request's own id (track.ts withTrackContext carries it everywhere).
//   - INTEL_CAPTURE = full (default) | meta (the shape, no words) | off.
//     TRACKING_OFF=1 turns it off too unless INTEL_CAPTURE says otherwise.
//   - "Forget my money" deletes every row about the person (forgetIntel).

import { db } from "./db.js";
import { currentTrackContext, holdForFlush, onTrack, registerFlusher, type TrackContext } from "./track.js";
import { redactJson } from "./intelredact.js";

export const APP = "charles";
export const CONTRACT_VERSION = 1;

export type IntelKind = "ask" | "say" | "model" | "check" | "tool" | "send" | "job" | "track" | "error";
export type Actor = "person" | "app" | "model" | "system" | "their_ai";

export interface CaptureOptions {
  name: string;
  actor?: Actor;
  ok?: boolean | null;
  ms?: number | null;
  /** The words and payloads: dropped in meta mode, redacted always. */
  content?: unknown;
  /** Small facts that are never words: model, role, sizes, ids, statuses. */
  meta?: Record<string, unknown>;
  businessId?: string | null;
}

interface Pending {
  at: string;
  seq: number;
  trace_id: string;
  turn_id: string | null;
  job_id: number | null;
  business_id: string | null;
  channel: string | null;
  stage: string | null;
  kind: IntelKind;
  name: string;
  actor: Actor;
  ok: boolean | null;
  ms: number | null;
  content_mode: "full" | "meta";
  /** Serialised at capture, so later changes to the object cannot leak in; redacted at write. */
  contentJson: string | null;
  metaJson: string;
}

/** The largest content one event keeps, in characters. Beyond it, the start and a note. */
const MAX_CONTENT = 1_000_000;
const BATCH = 50;
const FLUSH_AFTER_MS = 250;

const buffer: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;
let warnedDown = false;
const processTrace = `p_${Math.random().toString(36).slice(2, 12)}`;

export function captureMode(): "full" | "meta" | "off" {
  const m = (process.env.INTEL_CAPTURE ?? "").trim().toLowerCase();
  if (m === "off" || m === "meta" || m === "full") return m;
  return process.env.TRACKING_OFF === "1" ? "off" : "full";
}

export function traceOf(ctx: TrackContext): string {
  return ctx.turnId ?? (ctx.jobId != null ? `job_${ctx.jobId}` : null) ?? ctx.traceId ?? processTrace;
}

/** File and image bytes in a prompt become their type and size. */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "string" && value.length > 512 && value.startsWith("data:")) {
    const mime = value.slice(5, value.indexOf(";") > 0 ? value.indexOf(";") : 40);
    return `[file ${mime}, ${value.length} characters]`;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `[bytes, ${value.byteLength}]`;
  return value;
}

function serialise(content: unknown): string | null {
  if (content === undefined) return null;
  try {
    const s = JSON.stringify(content, replacer);
    if (s === undefined) return null;
    return s.length > MAX_CONTENT ? JSON.stringify({ truncated: true, chars: s.length, start: s.slice(0, MAX_CONTENT) }) : s;
  } catch {
    return JSON.stringify({ unserialisable: true });
  }
}

const clampMs = (ms: number | null | undefined): number | null => (typeof ms === "number" && Number.isFinite(ms) ? Math.min(Math.max(Math.round(ms), 0), 2_147_483_647) : null);

/** Record one thing that happened. Never throws, never waits. */
export function capture(kind: IntelKind, opts: CaptureOptions): void {
  try {
    const mode = captureMode();
    if (mode === "off") return;
    const ctx = currentTrackContext();
    const contentJson = serialise(opts.content);
    const meta = { ...(opts.meta ?? {}), ...(mode === "meta" && contentJson ? { content_chars: contentJson.length } : {}) };
    buffer.push({
      at: new Date().toISOString(),
      seq: ++seq,
      trace_id: traceOf(ctx),
      turn_id: ctx.turnId ?? null,
      job_id: ctx.jobId ?? null,
      business_id: opts.businessId !== undefined ? opts.businessId : (ctx.businessId ?? null),
      channel: ctx.channel ?? null,
      stage: ctx.stage ?? null,
      kind,
      name: String(opts.name).slice(0, 120),
      actor: opts.actor ?? defaultActor(kind),
      ok: opts.ok ?? null,
      ms: clampMs(opts.ms),
      content_mode: mode,
      contentJson: mode === "full" ? contentJson : null,
      metaJson: serialise(meta) ?? "{}",
    });
    schedule();
  } catch (err) {
    if (!warnedDown) {
      warnedDown = true;
      console.warn(`intel: ${opts?.name} not captured (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}

function defaultActor(kind: IntelKind): Actor {
  return kind === "ask" ? "person" : kind === "model" ? "model" : kind === "say" || kind === "send" ? "app" : "system";
}

function schedule(): void {
  if (buffer.length >= BATCH) {
    void write();
    return;
  }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void write();
  }, FLUSH_AFTER_MS);
  timer.unref?.();
}

function parse(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(redactJson(json));
  } catch {
    return { unreadable: true };
  }
}

function toRow(p: Pending): Record<string, unknown> {
  return {
    at: p.at,
    seq: p.seq,
    app: APP,
    v: CONTRACT_VERSION,
    trace_id: p.trace_id,
    turn_id: p.turn_id,
    job_id: p.job_id,
    business_id: p.business_id,
    channel: p.channel,
    stage: p.stage,
    kind: p.kind,
    name: p.name,
    actor: p.actor,
    ok: p.ok,
    ms: p.ms,
    content_mode: p.content_mode,
    content: parse(p.contentJson),
    meta: parse(p.metaJson) ?? {},
  };
}

function write(): Promise<unknown> | void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!buffer.length) return;
  const pending = buffer.splice(0, buffer.length);
  const p = (async () => {
    try {
      // Redaction happens here, off the request path.
      const rows = pending.map(toRow);
      for (let i = 0; i < rows.length; i += BATCH) {
        const { error } = await db().from("intel_events").insert(rows.slice(i, i + BATCH));
        if (error) throw error;
      }
    } catch (err) {
      if (!warnedDown) {
        warnedDown = true;
        console.warn(`intel: events could not be written (${err instanceof Error ? err.message : (err as { message?: string })?.message ?? String(err)}) — is db/0041 applied? Further failures are not logged.`);
      }
    }
  })();
  holdForFlush(p);
  return p;
}

registerFlusher({ flush: write, pending: () => buffer.length > 0 });

// Every product event, kept for good (the events table prunes after 180 days).
onTrack((name, opts) => {
  capture(opts.category === "failure" ? "error" : "track", {
    name,
    businessId: opts.businessId,
    ms: opts.ms ?? null,
    ok: opts.category === "failure" ? false : null,
    content: { props: opts.props ?? {}, ...(opts.excerpt ? { said: opts.excerpt } : {}), ...(opts.summary ? { summary: opts.summary } : {}) },
    meta: { category: opts.category ?? "behaviour", severity: opts.severity ?? null },
  });
});

// ── Reading back and forgetting ──────────────────────────────────

export interface IntelRow {
  at: string;
  seq: number;
  app: string;
  v: number;
  trace_id: string;
  turn_id: string | null;
  job_id: number | null;
  business_id: string | null;
  kind: IntelKind;
  name: string;
  actor: Actor;
  ok: boolean | null;
  ms: number | null;
  content: any;
  meta: any;
}

const byOrder = (a: IntelRow, b: IntelRow) => String(a.at).localeCompare(String(b.at)) || a.seq - b.seq;

/**
 * Everything one task did, in order, from any one id: a trace id, a turn id,
 * "job_<n>" or a job number. Jobs the task queued are followed and folded in.
 */
export async function readTrace(id: string, depth = 0): Promise<IntelRow[]> {
  const traceId = /^\d+$/.test(id) ? `job_${id}` : id;
  const { data } = await db().from("intel_events").select("*").eq("trace_id", traceId).order("at", { ascending: true }).limit(10_000);
  const own = ((data as IntelRow[] | null) ?? []).sort(byOrder);
  if (depth >= 3) return own;
  const queued = own.filter((e) => e.name === "job_enqueued" && e.meta?.job_id != null).map((e) => String(e.meta.job_id));
  const children = (await Promise.all([...new Set(queued)].map((j) => readTrace(`job_${j}`, depth + 1)))).flat();
  return [...own, ...children].sort(byOrder);
}

/** Every row about a person, written or still buffered, and every trace they were in. */
export async function forgetIntel(businessId: string): Promise<void> {
  const buffered = new Set(buffer.filter((r) => r.business_id === businessId).map((r) => r.trace_id));
  for (let i = buffer.length - 1; i >= 0; i--) if (buffer[i]!.business_id === businessId || buffered.has(buffer[i]!.trace_id)) buffer.splice(i, 1);
  try {
    const { data } = await db().from("intel_events").select("trace_id").eq("business_id", businessId).limit(50_000);
    const traces = [...new Set([...buffered, ...((data as { trace_id: string }[] | null) ?? []).map((r) => r.trace_id)])].filter((t) => !t.startsWith("p_"));
    await db().from("intel_events").delete().eq("business_id", businessId);
    for (let i = 0; i < traces.length; i += 200) await db().from("intel_events").delete().in("trace_id", traces.slice(i, i + 200));
  } catch (err) {
    console.error("forgetIntel failed", err);
  }
}

/** Test helper. */
export function __dropBuffered(): void {
  buffer.length = 0;
}
