// Fin — Jev (TypeSafe System One) client. Adapted from the reference
// client in JEV_INTEGRATION.md, trimmed to what this repo needs.
//
// Jev is not a language model: it takes a `state` and a set of typed
// questions and returns typed answers with calibrated probabilities in
// ~150ms, for near-zero cost. It cannot write text — it's used here as a
// verification/classification layer in FRONT of and BEHIND the generative
// calls, never as a replacement for them.
//
// Load-bearing design rule, straight from the integration notes: a
// judgement can never silence a reply. If Jev is unreachable, misconfigured,
// or answers something unreadable, every caller in this file falls through
// to "let it through" rather than blocking — a needless check is cheap and
// visible, a wrongly-silenced message to a real business owner is not.
//
// Tracking: every failed call is an event here, at its cause, whichever
// caller asked (safety, judgement, the business map, knowledge signals). Out
// of credit is its own critical incident: it is the one Jev failure that
// silently moves every guardrail onto the slower model backstop until a
// human tops the account up.

import { trackFailure } from "./track.js";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-latest";
export const JEV_MAX_CHOICE_OPTIONS = 255;
export const JEV_MIN_SCORE_LEVELS = 2;
export const JEV_MAX_SCORE_LEVELS = 10;
export const JEV_APPROX_TOKEN_BUDGET = 32_000;
const CHARS_PER_TOKEN = 4; // deliberately optimistic — see mistake 9 in the notes

type Entry = string | number | boolean | null | Entry[] | { [k: string]: Entry };

export type JevQuestion =
  | { type: "choice"; instructions: Entry; criteria: Record<string, Entry> }
  | { type: "score"; instructions: Entry; criteria: Entry[] }
  | { type: "noul"; instructions: Entry; criteria?: { true?: Entry; false?: Entry } };

export type JevAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number; legend: Record<string, Entry>; probabilities: Record<string, number> }
  | { type: "noul"; noul: number };

export interface JevOutcome {
  ok: boolean;
  answers?: Record<string, JevAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
  message?: string;
  /** true when the CREDENTIAL failed — the one thing retrying cannot fix. */
  credential?: boolean;
  /** Why it failed, as a short label for tracking. Absent on success. */
  reason?: JevFailure;
}

export type JevFailure = "invalid_request" | "over_budget" | "not_configured" | "timeout" | "unreachable" | "no_credit" | "credential" | "http" | "bad_response";

/** One event per failed call; the caller's fallback is its own event. */
function jevFailed(reason: JevFailure, message: string, opts: { status?: number; ms?: number; severity?: "warn" | "error" | "critical" } = {}): void {
  trackFailure("jev_call_failed", message, {
    severity: opts.severity ?? "warn",
    alert: opts.severity === "critical" ? "immediate" : "digest",
    ms: opts.ms,
    props: { reason, ...(opts.status ? { status: opts.status } : {}) },
    fingerprint: `jev_call_failed:${reason}${opts.status ? `:${opts.status}` : ""}`,
    summary: `Jev (guardrail engine) call failed: ${reason}${opts.status ? ` (HTTP ${opts.status})` : ""}; checks fell back to the model backstop`,
  });
}

function isAnswer(v: unknown): v is JevAnswer {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  if (a.type === "noul") return typeof a.noul === "number";
  if (a.type === "choice") return typeof a.choice === "string" && typeof a.confidence === "number";
  if (a.type === "score") return typeof a.score === "number" && typeof a.confidence === "number";
  return false; // an unknown type is a refusal, not a skip
}

const matches = (q: JevQuestion, a: JevAnswer) => q.type === a.type;

export function questionsProblem(questions: Record<string, JevQuestion>): string | null {
  const ids = Object.keys(questions);
  if (ids.length === 0) return "Jev was asked nothing.";
  for (const id of ids) {
    if (id === "__proto__" || id === "constructor" || id === "prototype") {
      return `Question id "${id}" is a reserved property name.`;
    }
    const q = questions[id];
    if (!q || !["choice", "score", "noul"].includes(q.type)) return `Question "${id}" has no usable type.`;
    if (q.instructions === undefined || q.instructions === null || q.instructions === "") {
      return `Question "${id}" has no instructions.`;
    }
    if (q.type === "choice") {
      const n = Object.keys(q.criteria ?? {}).length;
      if (n < 2) return `Choice question "${id}" needs at least two options.`;
      if (n > JEV_MAX_CHOICE_OPTIONS) return `Choice question "${id}" has too many options.`;
    }
    if (q.type === "score") {
      const n = (q.criteria ?? []).length;
      if (n < JEV_MIN_SCORE_LEVELS || n > JEV_MAX_SCORE_LEVELS) return `Score question "${id}" has an invalid level count.`;
    }
  }
  return null;
}

export function overBudget(state: unknown, questions: unknown): string | null {
  let chars: number;
  try {
    chars = JSON.stringify({ state: state ?? null, questions: questions ?? {} }).length;
  } catch {
    return null;
  }
  const estimate = Math.round(chars / CHARS_PER_TOKEN);
  return estimate <= JEV_APPROX_TOKEN_BUDGET ? null : `About ${estimate} tokens; the shared budget is about ${JEV_APPROX_TOKEN_BUDGET}.`;
}

export async function askJev(opts: {
  apiKey: string;
  state: unknown;
  questions: Record<string, JevQuestion>;
  model?: string;
  timeoutMs?: number;
}): Promise<JevOutcome> {
  const problem = questionsProblem(opts.questions ?? {});
  if (problem) {
    // A malformed question is a bug in our code, not Jev's.
    jevFailed("invalid_request", problem, { severity: "error" });
    return { ok: false, message: problem, reason: "invalid_request" };
  }

  const tooBig = overBudget(opts.state, opts.questions);
  if (tooBig) {
    jevFailed("over_budget", tooBig);
    return { ok: false, message: tooBig, reason: "over_budget" };
  }

  // No key is a deployment choice (/api/health shows it), not an incident.
  if (!opts.apiKey?.trim()) return { ok: false, credential: true, message: "Jev is not configured: no API key.", reason: "not_configured" };

  // The timer covers the body as well as the headers: it is cleared in the
  // outer finally, after the last read. Round 21, live: the model gateway
  // sent its headers early and then stalled the body with no timer running
  // (models.ts callOpenRouter); this call had the same shape, so a stalled
  // Jev body would have held a guardrail check — and the person's turn or the
  // plan-build stage behind it — until the platform killed the function.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    return await askJevOnce(opts, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** An abort: AbortError from controller.abort(), TimeoutError from AbortSignal.timeout(). */
const isAbort = (error: unknown): boolean => error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

/** askJev's request and its reading, under askJev's timer (`signal`). */
async function askJevOnce(
  opts: { apiKey: string; state: unknown; questions: Record<string, JevQuestion>; model?: string },
  signal: AbortSignal,
): Promise<JevOutcome> {
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state: opts.state ?? null, model: opts.model ?? JEV_DEFAULT_MODEL, questions: opts.questions }),
      signal,
    });
  } catch (error) {
    const aborted = isAbort(error);
    const message = aborted ? "Jev did not answer in time." : `Jev could not be reached: ${error}`;
    jevFailed(aborted ? "timeout" : "unreachable", message, { ms: Date.now() - started });
    return { ok: false, message, reason: aborted ? "timeout" : "unreachable" };
  }

  if (!response.ok) {
    const credential = response.status === 401 || response.status === 403;
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 500);
    } catch {
      /* not a second failure */
    }
    // Out of credit: 402, or a refusal that says so. Never the response body
    // in the event — a 4xx can echo back the state, which carries owner text.
    const noCredit = response.status === 402 || ([401, 403, 429].includes(response.status) && /credit|balance|billing|payment|insufficient funds|quota/i.test(detail));
    const ms = Date.now() - started;
    if (noCredit) {
      trackFailure("guardrails_jev_no_credit", `Jev responded ${response.status}`, {
        severity: "critical",
        alert: "immediate",
        ms,
        props: { status: response.status },
        fingerprint: "guardrails_jev_no_credit",
        summary: "Jev (TypeSafe) is out of credit: every guardrail check is running on the slower model backstop, or not at all if that is down, until the account is topped up",
      });
    } else if (credential) {
      jevFailed("credential", `Jev responded ${response.status}`, { status: response.status, ms, severity: "critical" });
    } else {
      // 5xx and 429 are Jev's weather; any other 4xx is our request.
      jevFailed("http", `Jev responded ${response.status}`, { status: response.status, ms, severity: response.status >= 500 || response.status === 429 ? "warn" : "error" });
    }
    // The body goes to the log only (console.log is not captured into
    // events): a 4xx can echo the state, which carries owner text, and every
    // caller passes `message` on into console.error and safety_events.
    if (detail) console.log(`jev: HTTP ${response.status} body: ${detail}`);
    return {
      ok: false,
      credential,
      message: credential ? "Jev rejected the credential." : `Jev responded ${response.status}.`,
      reason: noCredit ? "no_credit" : credential ? "credential" : "http",
    };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    // Headers came, then the body stalled until the timer cut it: a timeout,
    // not a malformed answer.
    if (isAbort(error)) {
      jevFailed("timeout", "Jev did not finish its answer in time.", { ms: Date.now() - started });
      return { ok: false, message: "Jev did not finish its answer in time.", reason: "timeout" };
    }
    jevFailed("bad_response", "Jev answered with something that is not JSON.", { ms: Date.now() - started });
    return { ok: false, message: "Jev answered with something that is not JSON.", reason: "bad_response" };
  }

  const raw = (parsed as { answers?: unknown })?.answers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    jevFailed("bad_response", "Jev answered without an `answers` object.", { ms: Date.now() - started });
    return { ok: false, message: "Jev answered without an `answers` object.", reason: "bad_response" };
  }

  const answers: Record<string, JevAnswer> = Object.create(null);
  const unreadable: string[] = [];
  const wrongType: string[] = [];
  for (const asked of Object.keys(opts.questions)) {
    const a = (raw as Record<string, unknown>)[asked];
    if (!isAnswer(a)) {
      unreadable.push(asked);
      continue;
    }
    if (!matches(opts.questions[asked], a)) {
      wrongType.push(asked);
      continue;
    }
    answers[asked] = a;
  }
  if (unreadable.length || wrongType.length) {
    const message = `Jev gave no readable answer for [${unreadable}] / wrong type for [${wrongType}].`;
    jevFailed("bad_response", message, { ms: Date.now() - started });
    return { ok: false, message, reason: "bad_response" };
  }

  return { ok: true, answers, usage: (parsed as any).usage };
}

export const noulConfidenceIn = (a: Extract<JevAnswer, { type: "noul" }>, expected: boolean) => (expected ? a.noul : 1 - a.noul);
