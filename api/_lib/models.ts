// Charles — the model layer. Every call goes through OpenRouter; which model
// does which job comes from the `model_config` table, never from code.
//
// Why that matters concretely: hosted open-model catalogues retire models with
// a few weeks' notice by email. When that happens the fix is one UPDATE in the
// SQL editor, not a redeploy. The table also carries an ordered `fallbacks`
// list per role, so a congested free queue is routed around without anyone
// being paged.
//
// Two failure modes this file is built around, both seen live:
//   1. Truncation. A response cut off mid-JSON is a SIZE problem, not a format
//      problem, even when what arrived happens to parse. Retry the SAME model
//      with more room.
//   2. Free-tier congestion. Waiting and retrying the same congested model does
//      not help; a DIFFERENT model does. Move down the chain instead of sleeping.

import { AsyncLocalStorage } from "node:async_hooks";
import { db, recordModelUsage } from "./db.js";
import { track, trackFailure } from "./track.js";
import { capture } from "./intel.js";
import { env } from "./env.js";
import { DeadlineError, jobMsLeft, onLastAttempt, retriesOnDeadline } from "./jobctx.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type Role = "router" | "wa_reply" | "help" | "voice" | "plan_builder" | "safety";

export interface ModelConfig {
  role: string;
  provider: string;
  model: string;
  fallbacks: string[];
  params: { max_tokens?: number; temperature?: number; [k: string]: unknown };
  enabled: boolean;
}

/**
 * THIS FILE IS THE ONLY PLACE IN api/ WHERE A MODEL NAME MAY APPEAR AS A
 * LITERAL, and CI enforces that. The rule is that model choices live in the
 * `model_config` table so a retirement is one UPDATE rather than a redeploy —
 * but a fallback that lives in the table cannot help when the table itself is
 * unreadable, which is exactly when it is needed. So the last resorts live
 * here, together, where they can be found and changed in one place.
 *
 * Last-resort chain, used only when a role's own model AND its configured
 * fallbacks have all failed. Spread across different providers on purpose:
 * the failure being routed around is usually one provider's shared queue.
 */
const HARD_FALLBACKS = [
  "xiaomi/mimo-v2.5-pro",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "google/gemma-4-31b-it:free",
  "nex-agi/nex-n2.5-pro:free",
  "thinkingmachines/inkling:free",
];

/**
 * The embedding model. It is a constant here, not a model_config row, for a
 * reason a row cannot express: the `embedding` columns in the database are
 * fixed at 1536 dimensions, so swapping this for a model with a different width
 * would break every search until the whole library were re-embedded. Changing
 * it is a migration, not a setting.
 */
export const EMBEDDING = { model: "openai/text-embedding-3-small", dims: 1536 } as const;

/**
 * Used only when the `voice` row cannot be read at all. See the note above.
 * OpenRouter namespaces Whisper under openai/, not under whichever provider
 * happens to serve it.
 */
export const LAST_RESORT_VOICE = { provider: "openrouter", model: "openai/whisper-1" } as const;

/**
 * The smallest `max_tokens` ever sent to a model, whatever a caller asked for.
 *
 * Live test, 2026-09-25: the production model does not honour
 * `reasoning: { enabled: false }` on OpenRouter. A controlled experiment
 * asked for two short strings; the same visible answer sometimes used 69–320
 * completion tokens and sometimes 1,083–1,243. The difference is hidden
 * reasoning, and it is charged against `max_tokens` BEFORE the answer is
 * written. So the router's 300-token budget (engine/qa.ts) often came back
 * with nothing at all — 30 empty router answers in 13 minutes of Vercel
 * logs, each costing 35–44s in the empty-retry-then-fallback chain below —
 * and the safety judge's 300 (safety.ts) is exposed the same way.
 *
 * `max_tokens` is a cap, not a target: a model that answers in 40 tokens
 * stops at 40 whether the cap is 300 or 2,048, and only the tokens actually
 * written are billed. A cap this high therefore costs nothing on the calls
 * it was sized for, and on the calls that reason first it is the difference
 * between an answer and a 40-second detour. The number is ~1.6x the largest
 * hidden-reasoning spend observed, leaving the visible answer whole room.
 */
export const MIN_ROOM = 2048;

/** A caller's budget with the floor applied. */
export function withRoomFloor(maxTokens: number): number {
  return Math.max(maxTokens, MIN_ROOM);
}

/**
 * The least room an "empty" retry asks for. An empty answer means the whole
 * budget went on hidden reasoning, so the retry must clear that spend with
 * the answer's room to spare; 1.8x of a small base did not (see askJSON).
 */
export const EMPTY_RETRY_ROOM = MIN_ROOM * 2;

/**
 * The least time worth starting a model call with inside a job attempt. The
 * slowest calls that succeed take 60-75s; a call started with less than this
 * left is more likely to be cut off by the platform than to finish.
 */
export const MIN_CALL_MS = 20_000;

/** The per-request timeout, leaving this much for the job to record the result. */
const WRAP_UP_MS = 5_000;

/** A caller's own bounds on one request (AskOptions.maxRequestMs / minRequestMs). */
export interface RequestCaps {
  maxRequestMs?: number;
  minRequestMs?: number;
}

/**
 * How long the next request may run: the caller's cap (90s unless it says
 * otherwise), cut to the job attempt's deadline (jobctx.ts jobMsLeft) less
 * the time the job needs to record the result. Outside a job it is the
 * caller's cap, or undefined for callOpenRouter's own 90s.
 *
 * Throws DeadlineError instead of starting a request that cannot finish:
 * one whose window would be shorter than MIN_CALL_MS, or than the caller's
 * own floor (minRequestMs) — a request cut off part-way is still billed,
 * and the job is retried on a fresh worker with a whole budget.
 */
export function callWindow(label: string, caps: RequestCaps = {}): number | undefined {
  const left = jobMsLeft();
  if (left === null) return caps.maxRequestMs;
  if (left - WRAP_UP_MS < Math.max(MIN_CALL_MS, caps.minRequestMs ?? 0)) throw new DeadlineError(`the model call [${label}]`, left);
  return Math.min(caps.maxRequestMs ?? 90_000, left - WRAP_UP_MS);
}

/**
 * Whether a call asks for no hidden reasoning. Live tests, rounds 10-13: the
 * model sometimes reasons anyway (1,100-1,750 hidden tokens, 27-42s). The
 * same model is served by more than one provider behind OpenRouter, and a
 * provider that does not support the switch ignores it. So these calls ask
 * OpenRouter to route only to providers that support every parameter sent
 * (provider.require_parameters). If none does, OpenRouter refuses the call
 * with a 400/404, and askJSON/askText retry once without the requirement —
 * slower at worst, never broken.
 */
export function reasoningOff(reasoning: unknown): boolean {
  return Boolean(reasoning && typeof reasoning === "object" && (reasoning as { enabled?: unknown }).enabled === false);
}

/**
 * Providers skipped on calls that ask for no reasoning. Live test, round 15,
 * 20 answers across four countries: every call that spent hidden reasoning
 * tokens was served via Novita, and every call via Xiaomi or StreamLake spent
 * none. The switch is honoured by everyone but Novita. Override with
 * OPENROUTER_IGNORE_PROVIDERS (comma-separated; empty to skip none) without a
 * deploy. If ignoring leaves no provider, the retry without require_parameters
 * (askJSON/askText) drops this too.
 */
export function ignoredProviders(): string[] {
  const raw = process.env.OPENROUTER_IGNORE_PROVIDERS;
  return (raw === undefined ? "novita" : raw).split(",").map((p) => p.trim()).filter(Boolean);
}

/** " reasoning=N" for a log line, or nothing when the provider did not say. */
function reasoningPart(out: CallResult): string {
  return typeof out.usage.reasoning === "number" ? ` reasoning=${out.usage.reasoning}` : "";
}

// A warm serverless instance handles many messages; re-reading model_config on
// every call would be a round trip per message for data that changes monthly.
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; cfg: ModelConfig }>();

export function __clearModelCache(): void {
  cache.clear();
}

export async function getModel(role: string): Promise<ModelConfig> {
  const hit = cache.get(role);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.cfg;

  const { data, error } = await db().from("model_config").select("*").eq("role", role).maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error(`model_config has no "${role}" row — run db/0002_model_config.sql and db/0005_platform.sql in Supabase.`);
  }
  const row = data as Partial<ModelConfig> & { model: string };
  const cfg: ModelConfig = {
    role,
    provider: row.provider ?? "openrouter",
    model: row.model,
    fallbacks: Array.isArray(row.fallbacks) ? row.fallbacks : [],
    params: (row.params as ModelConfig["params"]) ?? {},
    enabled: row.enabled !== false,
  };
  cache.set(role, { at: Date.now(), cfg });
  return cfg;
}

/**
 * Which model actually served a call, and whether it got there by falling
 * back. Live, round 4: web answers took 10-61s and nobody could read the
 * production logs, so "was it the router, the answer, or a fallback chain?"
 * was a guess. A caller that wants the answer wraps its work in
 * traceModelCalls() and gets one entry per askJSON/askText/embed call made
 * inside it, including calls made deep inside the guardrails, with no
 * change to any signature. Outside a trace this costs one lookup and nothing
 * is kept.
 */
export interface ModelCallTrace {
  label: string;
  role: string;
  /** The model that answered, or null if every candidate failed. */
  model: string | null;
  /** model_config's first choice for the role. */
  configured: string;
  /** True when a model other than the configured one answered (or was the last tried). */
  fallback: boolean;
  /**
   * True only when a request was actually sent to a model other than the
   * configured one. Round 24: "fallback: true" also marks a chain that moved
   * on to the fallback and then refused it for time before sending anything,
   * which read as if a second model had run.
   */
  fallbackStarted?: boolean;
  /** Requests sent, across every model and every retry. */
  tries: number;
  ms: number;
  ok: boolean;
  /**
   * Hidden reasoning tokens the answering call spent, when the provider
   * reports them (OpenRouter: usage.completion_tokens_details.reasoning_tokens).
   * Live test, 2026-09-25: the model reasons even when told not to, and that
   * spend was invisible — it showed up only as empty answers and lost time.
   */
  reasoning?: number;
  /** The provider behind OpenRouter that served the answering call, when reported. */
  provider?: string;
  /** Whether the call was streamed (models.ts streamFor). */
  streamed?: boolean;
  /** Streamed: the answering request's time to its first token. */
  firstTokenMs?: number;
  /** Requests cut off as stalled before an answer (FIRST_TOKEN_MS / IDLE_MS). */
  stalls?: number;
}

/**
 * One trace entry as a log or safety_events phrase:
 * "router=xiaomi/mimo-v2.5 (fallback from x) 3.1s x2 reasoning=1083".
 * Shared by answer_timing (engine/qa.ts) and readback_timing (engine/build.ts)
 * so both show the same facts the same way.
 */
export function describeModelCall(m: ModelCallTrace): string {
  const s = (n: number) => `${(n / 1000).toFixed(1)}s`;
  return `${m.label}=${m.model ?? "FAILED"}${m.fallback ? ` (fallback from ${m.configured})` : ""} ${s(m.ms)}${m.tries > 1 ? ` x${m.tries}` : ""}${m.reasoning !== undefined ? ` reasoning=${m.reasoning}` : ""}${m.provider ? ` via ${m.provider}` : ""}${m.firstTokenMs !== undefined ? ` first-token=${(m.firstTokenMs / 1000).toFixed(1)}s` : ""}${m.stalls ? ` stalls=${m.stalls}` : ""}`;
}

const traceStore = new AsyncLocalStorage<ModelCallTrace[]>();

/** Runs `fn`, collecting every model call made inside it (however deep) into `into`. */
export function traceModelCalls<T>(into: ModelCallTrace[], fn: () => Promise<T>): Promise<T> {
  return traceStore.run(into, fn);
}

/**
 * One model call (askJSON/askText, all retries and fallbacks included) as a
 * tracking event: how long, which model and provider, whether it fell back,
 * tokens and cost. A call that failed on every candidate is a failure, and
 * one the platform cannot recover from by itself (no key, no credit) is
 * critical — every owner is affected until a human fixes it.
 */
function trackModelCall(t: ModelCallTrace, out?: CallResult, err?: unknown): void {
  const kind = (err as { kind?: string } | undefined)?.kind;
  track("model_call", {
    category: "performance",
    ms: t.ms,
    props: {
      label: t.label,
      role: t.role,
      model: t.model,
      configured: t.configured,
      fallback: t.fallback,
      fallback_started: t.fallbackStarted === true,
      tries: t.tries,
      ok: t.ok,
      ...(t.provider ? { provider: t.provider } : {}),
      ...(t.reasoning !== undefined ? { reasoning: t.reasoning } : {}),
      ...(t.streamed !== undefined ? { streamed: t.streamed } : {}),
      ...(t.firstTokenMs !== undefined ? { first_token_ms: t.firstTokenMs } : {}),
      ...(t.stalls ? { stalls: t.stalls } : {}),
      ...(out ? { in: out.usage.in, out: out.usage.out, ...(out.usage.cost !== undefined ? { cost: out.usage.cost } : {}), truncated: out.truncated } : {}),
      ...(kind ? { error_kind: kind } : {}),
    },
  });
  if (!t.ok) {
    const fatal = kind === "auth" || kind === "credit";
    // Round 22: 17 model_call_failed at error, 14 of them recovered. A plan
    // build stage that runs out of time before a call is not a lost call:
    // the stage hands itself to a fresh worker (rethrowIfRetryable), which is
    // job_retry's to report. Only the last attempt, where the part ships
    // degraded or the build fails, is an error.
    const retried = err instanceof DeadlineError && !onLastAttempt() && retriesOnDeadline();
    // A provider's error body can echo the request — the person's words — so
    // a ModelError is recorded by its status and kind only.
    const safeErr = err instanceof ModelError ? `OpenRouter ${err.status} ${err.kind}${t.model ? ` (${t.model})` : ""}` : (err ?? "no model answered");
    trackFailure("model_call_failed", safeErr, {
      severity: fatal ? "critical" : retried ? "warn" : "error",
      alert: fatal ? "immediate" : retried ? "none" : "digest",
      props: { label: t.label, role: t.role, tries: t.tries, ...(kind ? { error_kind: kind } : {}), ...(retried ? { retried: true } : {}), ...(t.stalls ? { stalls: t.stalls } : {}) },
      fingerprint: `model_call_failed:${t.role}:${retried ? "out_of_time_retried" : (kind ?? "other")}`,
      summary: fatal
        ? `The model provider refused every call (${kind}): ${t.role} cannot run until the OpenRouter key or credit is fixed`
        : retried
          ? `A ${t.role} model call (${t.label}) had no time left in its job attempt; the stage was handed to a fresh worker`
          : `A ${t.role} model call (${t.label}) failed on every model after ${t.tries} tries${kind ? ` (${kind})` : ""}`,
    });
  }
}

/** Adds one entry to the trace in progress, if there is one. */
export function noteModelCall(t: ModelCallTrace): void {
  traceStore.getStore()?.push(t);
}

export interface CallResult {
  text: string;
  truncated: boolean;
  model: string;
  /** Which provider behind OpenRouter served it, when OpenRouter says (round 14: KE answers were slow and nobody could tell why). */
  provider?: string;
  /** `reasoning` is the hidden-reasoning share of `out`, when the provider reports it. */
  usage: { in: number; out: number; cost?: number; reasoning?: number };
  /** Streamed calls: how long the first token (answer or reasoning) took, from the request. */
  firstTokenMs?: number;
  /** True when the answer came as a stream. */
  streamed?: boolean;
}

type FailureKind = "auth" | "credit" | "rate" | "bad_request" | "upstream" | "empty" | "network";

// Written out longhand rather than as constructor parameter properties: those
// are a TypeScript-only runtime construct, and Node's type stripping — which is
// how the tests and the eval harness run these files with no build step —
// refuses them outright.
class ModelError extends Error {
  status: number;
  kind: FailureKind;
  constructor(message: string, status: number, kind: FailureKind) {
    super(message);
    this.name = "ModelError";
    this.status = status;
    this.kind = kind;
  }
}

/**
 * One request to one model, recorded whole for Chase Intelligence (intel.ts):
 * everything the model was shown, everything it said, how long it took, or
 * how it failed. Recording never changes the call or its result.
 */
export async function callOpenRouter(
  model: string,
  messages: { role: string; content: unknown }[],
  opts: CallOptions = { maxTokens: 900 },
): Promise<CallResult> {
  const started = Date.now();
  const facts = { model, role: opts.role ?? null, max_tokens: opts.maxTokens, temperature: opts.temperature ?? null, json_mode: Boolean(opts.jsonMode), stream: Boolean(opts.stream), timeout_ms: opts.timeoutMs ?? null };
  try {
    const r = await callOpenRouterOnce(model, messages, opts);
    capture("model", {
      name: `model_call:${opts.role ?? "unknown"}`,
      ok: !r.truncated,
      ms: Date.now() - started,
      content: { messages, reasoning: opts.reasoning ?? null, response: r.text },
      meta: { ...facts, served_by: r.model, provider: r.provider ?? null, usage: r.usage, truncated: r.truncated, streamed: Boolean(r.streamed), first_token_ms: r.firstTokenMs ?? null },
    });
    return r;
  } catch (err) {
    capture("model", {
      name: `model_call:${opts.role ?? "unknown"}`,
      ok: false,
      ms: Date.now() - started,
      content: { messages, reasoning: opts.reasoning ?? null, response: null },
      meta: { ...facts, error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500), error_kind: err instanceof ModelError ? err.kind : err instanceof Error ? err.name : null, status: err instanceof ModelError ? err.status : null },
    });
    throw err;
  }
}

async function callOpenRouterOnce(
  model: string,
  messages: { role: string; content: unknown }[],
  opts: CallOptions,
): Promise<CallResult> {
  if (!env.OPENROUTER_API_KEY) throw new ModelError("OPENROUTER_API_KEY is not set", 401, "auth");

  // The timer covers the WHOLE request — headers AND body — and is cleared
  // only in the outer finally below. Round 21, live: it used to be cleared as
  // soon as fetch() resolved, which is when the HEADERS arrive. OpenRouter
  // sends 200 headers early on a non-streaming request and holds the
  // connection open while the upstream provider works, so a stalled provider
  // left res.json() waiting with no timer at all: two KE build stages sat
  // "running" with no model_call event for seven minutes until Vercel killed
  // the function at 300s, and two NG calls took 204s and 282s. Neither this
  // timeout, the per-request cap (callWindow) nor the job's hard stop could
  // end a body read that never finished.
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await requestOnce(model, messages, opts, controller, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

/** One request's options. `stream` and the two waits are askJSON/askText's (see readStream). */
export interface CallOptions {
  maxTokens: number;
  temperature?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
  reasoning?: unknown;
  role?: string;
  requireParams?: boolean;
  /** Ask for the answer as a stream, so a stalled provider shows as silence (see readStream). */
  stream?: boolean;
  /** Streaming only: the longest wait for the first token (answer or reasoning). */
  firstTokenMs?: number;
  /** Streaming only: the longest silence between tokens once they have started. */
  idleMs?: number;
}

/**
 * The waits a streamed call is allowed before it is called stalled.
 *
 * Round 22, live: a failed plan-build attempt cost about four minutes — the
 * primary model held the request until the 150s cap, the fallback then had
 * what was left and timed out too, and the job went to a fresh worker. Two
 * of those and a build passed eight minutes. A non-streamed request cannot
 * tell a model that is slowly writing a long answer from one that will never
 * answer: both are an open connection with nothing in it until the end. A
 * streamed one can. OpenRouter sends each token (and each hidden-reasoning
 * token, as delta.reasoning) as it is made, and only ": OPENROUTER
 * PROCESSING" comments while the request waits upstream — so silence means
 * nothing is being written. A call that has sent nothing for FIRST_TOKEN_MS,
 * or gone quiet for IDLE_MS mid-answer, is cut there and the next model is
 * tried with the time that is left, instead of after 150s.
 *
 * 60s for the first token: hidden reasoning before the answer (1,100-1,750
 * tokens live, rounds 10-13) and a queue upstream both come before it, and
 * the plan builds' slowest calls that succeeded took 60-125s in total. 30s
 * between tokens: a model that is writing sends several a second.
 */
export const FIRST_TOKEN_MS = 60_000;
export const IDLE_MS = 30_000;

/**
 * Whether askJSON/askText stream a role's calls. On unless the role's
 * model_config params say `"stream": false` (one UPDATE, no deploy, if a
 * model or provider behaves badly streamed) or OPENROUTER_STREAM=0 turns it
 * off everywhere.
 */
export function streamFor(cfg: Pick<ModelConfig, "params">): boolean {
  if (process.env.OPENROUTER_STREAM === "0") return false;
  return cfg.params.stream !== false;
}

/** An abort: AbortError from controller.abort(), TimeoutError from AbortSignal.timeout(). */
const isAbort = (err: unknown): boolean => err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");

/** callOpenRouter's request and its reading, under the caller's timer (`signal`). */
async function requestOnce(
  model: string,
  messages: { role: string; content: unknown }[],
  opts: CallOptions,
  controller: AbortController,
  timeoutMs: number,
): Promise<CallResult> {
  const signal = controller.signal;
  const started = Date.now();
  // Streamed: nothing at all (not even the headers) within the first-token
  // wait is a stall too. The reader below takes the watch over once the
  // headers are in.
  const stall: Stall = { why: null };
  const firstTokenMs = Math.min(opts.firstTokenMs ?? FIRST_TOKEN_MS, timeoutMs);
  const headersWatch = opts.stream ? setTimeout(() => stallAbort(controller, stall, "first", firstTokenMs), firstTokenMs) : undefined;
  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        // OpenRouter attributes usage with these; harmless if the URL is blank.
        "HTTP-Referer": env.PUBLIC_BASE_URL || "https://github.com/ckchirongoma/fin.ai",
        "X-Title": "Charles",
      },
      body: JSON.stringify({
        model,
        messages,
        // Floored here, for every caller (attachments, transcription, the eval
        // script), so a small budget can never starve a reasoning model of the
        // room to answer. askJSON/askText floor their own room too, so their
        // escalation multiplies from the floor rather than from a tiny base.
        max_tokens: withRoomFloor(opts.maxTokens),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
        // Per-role, from model_config.params: off for a yes/no, more for the plan.
        ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
        // Asks OpenRouter to report what the call cost, for model_usage.
        usage: { include: true },
        // Only route to a provider that supports every parameter sent — above
        // all the reasoning switch (see reasoningOff).
        ...(opts.requireParams ? { provider: { require_parameters: true, ignore: ignoredProviders() } } : {}),
        ...(opts.stream ? { stream: true } : {}),
      }),
      signal,
    });
  } catch (err) {
    if (stall.why) throw stallError(model, stall);
    throw new ModelError(isAbort(err) ? `${model} did not answer in time (${Math.round(timeoutMs / 1000)}s, headers)` : `${model} unreachable: ${err}`, 0, "network");
  } finally {
    clearTimeout(headersWatch);
  }

  if (!res.ok) {
    // Still under the timer: a stalled error body is cut off and read as "".
    // The status is the failure and decides the kind — a 402 whose body
    // stalled is still out of credit, not a network blip.
    const body = (await res.text().catch(() => "")).slice(0, 400);
    const kind =
      res.status === 401 || res.status === 403
        ? "auth"
        : res.status === 402
          ? "credit"
          : res.status === 429
            ? "rate"
            : res.status === 400 || res.status === 404
              ? "bad_request"
              : "upstream";
    throw new ModelError(`OpenRouter ${res.status} (${model}): ${body}`, res.status, kind);
  }

  type Body = {
    choices?: { message?: { content?: unknown }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; completion_tokens_details?: { reasoning_tokens?: number } };
    provider?: string;
    error?: { message?: string; code?: number };
  };
  // A streamed answer. Anything else — a provider (or a test) that answered
  // with one JSON body although a stream was asked for — is read as before.
  if (opts.stream && /text\/event-stream/i.test(res.headers.get("content-type") ?? "")) {
    return readStream(model, res, opts, controller, stall, { started, timeoutMs, firstTokenMs });
  }

  let json: Body;
  try {
    json = (await res.json()) as Body;
  } catch (err) {
    // The round-21 stall: 200 headers, then a body that never finished.
    // Network, like a request that never answered at all (askJSON moves to
    // the next model). Anything else — a body that is not JSON — is thrown
    // as it always was, so model_call_failed keeps its fingerprints.
    if (isAbort(err)) throw new ModelError(`${model} did not answer in time (${Math.round(timeoutMs / 1000)}s, body)`, 0, "network");
    throw err;
  }

  // OpenRouter can return HTTP 200 with a top-level error object.
  if (json.error) {
    const code = json.error.code ?? 0;
    throw new ModelError(`OpenRouter error (${model}): ${json.error.message ?? "unknown"}`, code, code === 429 ? "rate" : "upstream");
  }

  const choice = json.choices?.[0];
  const content = choice?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? (content as { text?: string }[]).map((c) => c?.text ?? "").join("") : "";
  const reasoning = json.usage?.completion_tokens_details?.reasoning_tokens;
  // An empty answer that spent its budget on reasoning is a room problem, not
  // a model problem; say so in the error so the "model fail" log line shows it.
  if (!text) {
    const why = typeof reasoning === "number" ? ` (reasoning=${reasoning} of max_tokens ${withRoomFloor(opts.maxTokens)})` : "";
    throw new ModelError(`${model} returned empty content${why}`, 200, "empty");
  }

  const usage = { in: json.usage?.prompt_tokens ?? 0, out: json.usage?.completion_tokens ?? 0, cost: json.usage?.cost, ...(typeof reasoning === "number" ? { reasoning } : {}) };
  void recordModelUsage({ role: opts.role, model, promptTokens: usage.in, completionTokens: usage.out, cost: usage.cost });
  return { text, truncated: choice?.finish_reason === "length", model, usage, ...(typeof json.provider === "string" ? { provider: json.provider } : {}) };
}

/** Why a streamed call was cut short, when it was: set just before the abort. */
interface Stall {
  why: "first" | "idle" | null;
  waitedMs?: number;
}

function stallAbort(controller: AbortController, stall: Stall, why: "first" | "idle", waitedMs: number): void {
  if (controller.signal.aborted) return;
  stall.why = why;
  stall.waitedMs = waitedMs;
  controller.abort();
}

/** A stall is "network", like a request that never answered: askJSON/askText move to the next model. */
function stallError(model: string, stall: Stall): ModelError {
  const s = Math.round((stall.waitedMs ?? 0) / 1000);
  return new ModelError(
    stall.why === "first" ? `${model} stalled: no token in ${s}s (first token)` : `${model} stalled: no token for ${s}s (mid-answer)`,
    0,
    "network",
  );
}

/** One server-sent chunk of a streamed chat completion, as OpenRouter sends it. */
interface StreamChunk {
  choices?: { delta?: { content?: unknown; reasoning?: unknown; reasoning_details?: unknown }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; completion_tokens_details?: { reasoning_tokens?: number } };
  provider?: string;
  error?: { message?: string; code?: number };
}

/**
 * Reads a streamed answer to the end, cutting it off when it stalls (see
 * FIRST_TOKEN_MS). Every data line counts as the model being alive;
 * OpenRouter's keep-alive comments (": OPENROUTER PROCESSING") do not —
 * they are sent precisely while nothing is being written. The whole-request
 * timer in callOpenRouter still applies on top.
 */
async function readStream(
  model: string,
  res: Response,
  opts: CallOptions,
  controller: AbortController,
  stall: Stall,
  t: { started: number; timeoutMs: number; firstTokenMs: number },
): Promise<CallResult> {
  const idleMs = opts.idleMs ?? IDLE_MS;
  let watch: ReturnType<typeof setTimeout> | undefined;
  const arm = (why: "first" | "idle", ms: number) => {
    clearTimeout(watch);
    watch = setTimeout(() => stallAbort(controller, stall, why, why === "first" ? t.firstTokenMs : ms), Math.max(0, ms));
  };
  // The first-token wait runs from the request, not from the headers.
  arm("first", t.firstTokenMs - (Date.now() - t.started));

  let text = "";
  let finish: string | null = null;
  let usage: StreamChunk["usage"];
  let provider: string | undefined;
  let firstAt: number | null = null;
  let chunks = 0;
  const reader = res.body?.getReader();
  if (!reader) throw new ModelError(`${model} sent a stream with no body`, 200, "empty");
  const decoder = new TextDecoder();
  let buf = "";
  let done = false;
  try {
    while (!done) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue; // a comment (keep-alive), a blank line, an event name
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          done = true;
          break;
        }
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(data) as StreamChunk;
        } catch {
          continue; // a line split oddly is not worth failing the call over
        }
        chunks++;
        if (firstAt === null) firstAt = Date.now();
        arm("idle", idleMs);
        if (chunk.error) {
          const code = chunk.error.code ?? 0;
          throw new ModelError(`OpenRouter error mid-stream (${model}): ${chunk.error.message ?? "unknown"}`, code, code === 429 ? "rate" : "upstream");
        }
        if (typeof chunk.provider === "string") provider = chunk.provider;
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        const c = choice?.delta?.content;
        if (typeof c === "string") text += c;
        else if (Array.isArray(c)) text += (c as { text?: string }[]).map((x) => x?.text ?? "").join("");
        if (choice?.finish_reason) finish = choice.finish_reason;
      }
    }
  } catch (err) {
    if (stall.why) throw stallError(model, stall);
    if (isAbort(err)) throw new ModelError(`${model} did not answer in time (${Math.round(t.timeoutMs / 1000)}s, body)`, 0, "network");
    throw err;
  } finally {
    clearTimeout(watch);
    reader.cancel().catch(() => {});
  }

  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  if (!text) {
    const why = typeof reasoning === "number" ? ` (reasoning=${reasoning} of max_tokens ${withRoomFloor(opts.maxTokens)})` : "";
    throw new ModelError(`${model} returned empty content${why}`, 200, "empty");
  }
  const u = { in: usage?.prompt_tokens ?? 0, out: usage?.completion_tokens ?? 0, cost: usage?.cost, ...(typeof reasoning === "number" ? { reasoning } : {}) };
  void recordModelUsage({ role: opts.role, model, promptTokens: u.in, completionTokens: u.out, cost: u.cost });
  return {
    text,
    // A stream that ended with no finish reason was cut off somewhere upstream: treated like a length cut.
    truncated: finish === "length" || (!done && finish === null),
    model,
    usage: u,
    ...(provider ? { provider } : {}),
    ...(firstAt !== null ? { firstTokenMs: firstAt - t.started } : {}),
    streamed: true,
  };
}

/** Pull the JSON object out of a reply that may be fenced or chatty. */
export function extractJSON(text: string): unknown | null {
  const clean = text.replace(/```json/gi, "").replace(/```/g, "");
  const first = clean.indexOf("{");
  const last = clean.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    return JSON.parse(clean.slice(first, last + 1));
  } catch {
    return null;
  }
}

function candidatesFor(cfg: ModelConfig): string[] {
  const seen = new Set<string>();
  return [cfg.model, ...cfg.fallbacks, ...HARD_FALLBACKS].filter((m) => m && !seen.has(m) && seen.add(m));
}

export interface AskOptions {
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider to enforce JSON. Dropped automatically if it 400s. */
  jsonMode?: boolean;
  /** Logged so a slow or failing role can be found in the Vercel logs. */
  label?: string;
  /**
   * Overrides model_config's role-wide reasoning setting for THIS call only.
   * Added 2026-09-21: reasoning was a per-ROLE setting only, so every call a
   * role made paid the same "thinking" latency whether or not that call
   * benefited from it — a plain classification (which customer segment did
   * they pick?) got the same deliberation budget as the one genuinely
   * generative step (writing the strategy). Pass `{ enabled: false }` for a
   * mechanical extraction call regardless of what the role's own config
   * says; omit this to fall back to model_config, unchanged.
   */
  reasoning?: unknown;
  /**
   * The longest one request may run (default 90s), headers and body. Inside
   * a job it is cut further to what the attempt has left (callWindow).
   */
  maxRequestMs?: number;
  /**
   * Inside a job: do not start a request whose window (what the attempt has
   * left, less the wrap-up) would be shorter than this — never shorter than
   * MIN_CALL_MS either way. It throws DeadlineError instead, and the job is
   * retried on a fresh worker.
   */
  minRequestMs?: number;
  /**
   * Streamed calls: the longest one request may run, in place of
   * maxRequestMs. A streamed call that stalls is cut by the first-token and
   * idle waits, so the whole-request cap only has to stop one that is
   * still writing — which is worth letting finish.
   */
  maxStreamMs?: number;
  /** Streamed calls: the longest wait for the first token (default FIRST_TOKEN_MS). */
  firstTokenMs?: number;
  /** Streamed calls: the longest silence once tokens have started (default IDLE_MS). */
  idleMs?: number;
}

/**
 * Ask for JSON and get a parsed object, or throw.
 *
 * Retry policy, in order of cost:
 *   truncated        → same model, 1.6x the room (up to 3 tries)
 *   empty            → same model, 1.8x the room (up to 3 tries)
 *   rate / upstream  → next model in the chain immediately
 *   unparseable      → next model in the chain (a genuine format problem)
 *   auth / credit    → stop. Retrying a bad key just burns time.
 *
 * "Empty" used to escalate once, at 1.5x. Production incident, 2026-09-20:
 * a reasoning-enabled role (`plan_builder`, MiMo's "medium" effort) spends
 * part of its `max_tokens` budget on reasoning before it ever writes an
 * answer, so a room sized for a non-reasoning model came back empty at
 * 1,600 tokens, then again at 2,400 (one escalation, exhausted) — the calls
 * that did succeed needed 2,400–3,700. One retry at 1.5x was sized for a
 * truncation, not for a model that can spend its whole budget thinking
 * before producing a single token of the answer. Three tries at 1.8x gives
 * a 1,600-token call up to ~5,180 before giving up — comfortably above what
 * was actually observed — without touching how much a role is allowed to
 * reason, which is a quality choice made in `model_config`, not a bug here.
 *
 * Live test, 2026-09-25: the first attempt now starts at MIN_ROOM, never at
 * the caller's own figure, because the model reasons even when told not to
 * and a 300-token router budget was coming back empty 30 times in 13
 * minutes. And an "empty" retry jumps straight to EMPTY_RETRY_ROOM if 1.8x
 * would fall short of it: the second try is the one that has to land, since
 * the third is the last before a weaker fallback model. With the floor in
 * place this is mostly moot (1.8x of 2,048 is 3,687; the jump makes it
 * 4,096) — it is kept so that the retry after an empty answer never
 * depends on what the base happened to be, should the floor ever move.
 */
export async function askJSON(role: string, prompt: string, opts: AskOptions = {}): Promise<Record<string, unknown>> {
  const cfg = await getModel(role);
  if (!cfg.enabled) throw new Error(`model_config role "${role}" is disabled`);

  const baseMax = withRoomFloor(opts.maxTokens ?? cfg.params.max_tokens ?? 900);
  const temperature = opts.temperature ?? cfg.params.temperature;
  const messages = [{ role: "user", content: prompt }];
  const label = opts.label ?? role;

  let lastErr: unknown = null;
  let jsonMode = opts.jsonMode ?? true;
  let requireParams = reasoningOff(opts.reasoning ?? cfg.params.reasoning);
  const started = Date.now();
  let tries = 0;
  let lastModel = cfg.model;
  let fallbackStarted = false;
  const stream = streamFor(cfg);
  // The answering call's time to first token, and how many requests were
  // cut off as stalled on the way (round 22): the facts that say whether a
  // slow call was a slow model or a dead one.
  let firstTokenMs: number | undefined;
  let stalls = 0;
  const note = (model: string | null, ok: boolean, out?: CallResult, err?: unknown) => {
    const t: ModelCallTrace = { label, role, model, configured: cfg.model, fallback: (model ?? lastModel) !== cfg.model, fallbackStarted, tries, ms: Date.now() - started, ok, ...(out?.usage.reasoning !== undefined ? { reasoning: out.usage.reasoning } : {}), ...(out?.provider ? { provider: out.provider } : {}), streamed: stream, ...(ok && firstTokenMs !== undefined ? { firstTokenMs } : {}), stalls };
    noteModelCall(t);
    trackModelCall(t, out, err);
  };

  for (const model of candidatesFor(cfg)) {
    let room = baseMax;
    lastModel = model;
    for (let attempt = 0; attempt < 3; attempt++) {
      let timeoutMs: number | undefined;
      try {
        timeoutMs = callWindow(label, stream && opts.maxStreamMs ? { ...opts, maxRequestMs: opts.maxStreamMs } : opts);
      } catch (err) {
        console.log(`model skipped [${label}] ${(err as Error).message}`);
        note(null, false, undefined, err);
        throw err;
      }
      try {
        tries++;
        if (model !== cfg.model) fallbackStarted = true;
        const out = await callOpenRouter(model, messages, { maxTokens: room, temperature, timeoutMs, jsonMode, reasoning: opts.reasoning ?? cfg.params.reasoning, role, requireParams, stream, firstTokenMs: opts.firstTokenMs, idleMs: opts.idleMs });
        if (out.firstTokenMs !== undefined) firstTokenMs = out.firstTokenMs;
        const parsed = out.truncated ? null : extractJSON(out.text);
        if (parsed && typeof parsed === "object") {
          console.log(`model ok [${label}] ${model} in=${out.usage.in} out=${out.usage.out}${reasoningPart(out)}${out.provider ? ` provider=${out.provider}` : ""} ms=${Date.now() - started} tries=${tries}${model !== cfg.model ? ` fallback-from=${cfg.model}` : ""}`);
          note(model, true, out);
          return parsed as Record<string, unknown>;
        }
        if (out.truncated && attempt < 2) {
          room = Math.ceil(room * 1.6);
          continue;
        }
        console.warn(`model bad-json [${label}] ${model} truncated=${out.truncated}: ${out.text.slice(0, 400)}`);
        lastErr = new Error(`${model} did not return parseable JSON`);
        break;
      } catch (err) {
        lastErr = err;
        const e = err as ModelError;
        if (e.kind === "network" && /\bstalled:/.test(e.message ?? "")) stalls++;
        if (e.kind === "auth" || e.kind === "credit") {
          console.log(`model fatal [${label}] ${e.message}`);
          note(null, false, undefined, err);
          throw err;
        }
        if (e.kind === "bad_request" && requireParams) {
          // No provider supports every parameter: go without the requirement.
          console.warn(`model [${label}] ${model}: no provider takes every parameter; retrying without require_parameters`);
          requireParams = false;
          continue;
        }
        if (e.kind === "bad_request" && jsonMode) {
          // The model does not support response_format. Drop it and retry once.
          jsonMode = false;
          continue;
        }
        if (e.kind === "empty" && attempt < 2) {
          room = Math.max(Math.ceil(room * 1.8), EMPTY_RETRY_ROOM);
          continue;
        }
        console.warn(`model fail [${label}] ${e.message ?? err}`);
        break;
      }
    }
  }
  note(null, false, undefined, lastErr);
  throw lastErr instanceof Error ? lastErr : new Error(`askJSON(${role}) failed on every candidate model`);
}

/**
 * Same chain, plain prose out. Used where the answer is not structured.
 *
 * Same "empty" retry as askJSON, same reason: a reasoning-enabled role can
 * spend its whole `max_tokens` budget thinking and hand back nothing, and
 * that is a room problem on THIS model, not a reason to burn through the
 * fallback chain. This function had no same-model retry at all until the
 * 2026-09-20 incident — every "empty" went straight to the next, weaker
 * model. Truncation is not retried here yet (askText has no JSON to detect
 * truncation against the way askJSON does via `out.truncated`); a truncated
 * answer is returned as-is, silently short. Known gap, not this incident.
 */
export async function askText(role: string, prompt: string, opts: AskOptions = {}): Promise<string> {
  const cfg = await getModel(role);
  // Same floor and same "empty" jump as askJSON, same 2026-09-25 finding.
  const baseMax = withRoomFloor(opts.maxTokens ?? cfg.params.max_tokens ?? 600);
  const temperature = opts.temperature ?? cfg.params.temperature;
  const messages = [{ role: "user", content: prompt }];
  let lastErr: unknown = null;
  let requireParams = reasoningOff(opts.reasoning ?? cfg.params.reasoning);
  const label = opts.label ?? role;
  const started = Date.now();
  let tries = 0;
  let lastModel = cfg.model;
  let fallbackStarted = false;
  const stream = streamFor(cfg);
  // The answering call's time to first token, and how many requests were
  // cut off as stalled on the way (round 22): the facts that say whether a
  // slow call was a slow model or a dead one.
  let firstTokenMs: number | undefined;
  let stalls = 0;
  const note = (model: string | null, ok: boolean, out?: CallResult, err?: unknown) => {
    const t: ModelCallTrace = { label, role, model, configured: cfg.model, fallback: (model ?? lastModel) !== cfg.model, fallbackStarted, tries, ms: Date.now() - started, ok, ...(out?.usage.reasoning !== undefined ? { reasoning: out.usage.reasoning } : {}), ...(out?.provider ? { provider: out.provider } : {}), streamed: stream, ...(ok && firstTokenMs !== undefined ? { firstTokenMs } : {}), stalls };
    noteModelCall(t);
    trackModelCall(t, out, err);
  };
  for (const model of candidatesFor(cfg)) {
    let room = baseMax;
    lastModel = model;
    for (let attempt = 0; attempt < 3; attempt++) {
      let timeoutMs: number | undefined;
      try {
        timeoutMs = callWindow(label, stream && opts.maxStreamMs ? { ...opts, maxRequestMs: opts.maxStreamMs } : opts);
      } catch (err) {
        console.log(`model skipped [${label}] ${(err as Error).message}`);
        note(null, false, undefined, err);
        throw err;
      }
      try {
        tries++;
        if (model !== cfg.model) fallbackStarted = true;
        const out = await callOpenRouter(model, messages, { maxTokens: room, temperature, timeoutMs, jsonMode: false, reasoning: opts.reasoning ?? cfg.params.reasoning, role, requireParams, stream, firstTokenMs: opts.firstTokenMs, idleMs: opts.idleMs });
        if (out.firstTokenMs !== undefined) firstTokenMs = out.firstTokenMs;
        console.log(`model ok [${label}] ${model} in=${out.usage.in} out=${out.usage.out}${reasoningPart(out)}${out.provider ? ` provider=${out.provider}` : ""} ms=${Date.now() - started} tries=${tries}${model !== cfg.model ? ` fallback-from=${cfg.model}` : ""}`);
        note(model, true, out);
        return out.text.trim();
      } catch (err) {
        lastErr = err;
        const e = err as ModelError;
        if (e.kind === "network" && /\bstalled:/.test(e.message ?? "")) stalls++;
        if (e.kind === "auth" || e.kind === "credit") {
          note(null, false, undefined, err);
          throw err;
        }
        if (e.kind === "bad_request" && requireParams) {
          console.warn(`model [${label}] ${model}: no provider takes every parameter; retrying without require_parameters`);
          requireParams = false;
          continue;
        }
        if (e.kind === "empty" && attempt < 2) {
          room = Math.max(Math.ceil(room * 1.8), EMPTY_RETRY_ROOM);
          continue;
        }
        break;
      }
    }
  }
  note(null, false, undefined, lastErr);
  throw lastErr instanceof Error ? lastErr : new Error(`askText(${role}) failed on every candidate model`);
}
