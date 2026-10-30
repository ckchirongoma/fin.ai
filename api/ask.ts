// Charles — ask your plan a question, on the web, and watch the page answer.
//
// The founder's ask: the plan viewer was a static render of the WhatsApp
// document. This is the interactive half: a person signed in with their
// WhatsApp number (the same sign-in and session as api/plan.ts) types a
// question, and gets the SAME answer WhatsApp would give — same routing,
// same retrieval, same guardrails, one Business Context — plus a `focus`
// that tells the page what to light up: the step they asked about, the area
// of their business map, or the tool.
//
// `focus` is computed here, deterministically, from things the answer
// already carries (the fixed reply schema's tool_id and domain) and from
// plain matching against their own plan. No second schema, and no extra
// model call to decide what to highlight.
//
//   GET  /api/ask?action=state   -> the board: plan steps, map, tools, starter questions
//   POST /api/ask {question}     -> { reply, focus, grounded }

import { waitUntil } from "@vercel/functions";
import { businessForSession, dbError, sessionToken } from "./plan.js";
import { composeAnswer, afterTurn, noteTurnSkipped, timingLine, PROGRESS, type AnswerTiming, type Composed } from "./_lib/engine/qa.js";
import { ASKS_FOR_NEXT_STEP, nextWhileStabilising } from "./_lib/engine/steps.js";
import { db, planFor, recordMessage, toolsFor } from "./_lib/db.js";
import { isStale } from "./_lib/retrieval.js";
import { hashSecret } from "./_lib/crypto.js";
import { aboutTheMoney } from "./_lib/safety.js";
import { withFreeType } from "./_lib/freetype.js";
import { country } from "./_lib/countries.js";
import { DOMAINS, DOMAIN_LABELS, type Business, type PlanStepRow, type Reply, type Stage, type ToolRow } from "./_lib/types.js";
import { flushTracking, noteRequestFailure, setTrackContext, track, trackFailure, trackUnmet, tracked } from "./_lib/track.js";

const MAX_QUESTION = 600;
/** Stages where a plan exists and nothing on WhatsApp is waiting on a specific answer to build it. */
const WITH_A_PLAN: Stage[] = ["plan_ready", "step_pushed", "walking", "outcome_wait", "changing", "confirm_change", "stabilizing"];
const PER_HOUR = 30;

/**
 * How long the web waits for an answer before saying so, measured from the
 * moment the question arrives.
 *
 * Live, 2026-09-23: "How am I doing?" came back as a Vercel gateway 504.
 * Nothing on the answer path has an overall deadline. Each model call has a
 * 90-second fetch timeout and askJSON walks a fallback chain of several
 * models, while this function's maxDuration (vercel.json) is 60 seconds. So
 * one stalled model call (a congested free queue, or a plan build running
 * alongside on the same key) outlived the function, and the person got the
 * gateway's error page instead of a sentence. The page's own fetch also gives
 * up at 45 seconds (public/ask.html). This sits under both, and leaves room
 * to record the reply.
 */
const ANSWER_DEADLINE_MS = 25_000;
/** vercel.json gives this function 300s; past that a late answer cannot land. */
const GIVE_UP_MS = 300_000;
/** A page-generated id for one question, so a reload never asks (or pays) twice. */
const CLIENT_TURN = /^[A-Za-z0-9_-]{16,40}$/;
let answerDeadlineMs = ANSWER_DEADLINE_MS;
/** Tests only: a short deadline, so a slow model can be simulated in milliseconds. Returns the undo. */
export function __setAnswerDeadlineMs(ms: number): () => void {
  answerDeadlineMs = ms;
  return () => {
    answerDeadlineMs = ANSWER_DEADLINE_MS;
  };
}
export const SLOW_MESSAGE = "That one took too long, and I've stopped waiting. Ask it again, or ask me on WhatsApp.";

/**
 * Work that must finish but must not hold the person's answer: learning from
 * the turn (memory and the knowledge-signal check, up to two more model
 * calls). waitUntil keeps the instance alive for it after the response is
 * flushed, as api/whatsapp-webhook.ts does for its drain. Outside Vercel it
 * is a no-op and the promise simply runs. `pending` is only there so tests
 * can wait for it.
 */
const pending = new Set<Promise<unknown>>();
function afterResponse(work: Promise<unknown>, label: string): void {
  const p: Promise<void> = work
    .then(
      () => undefined,
      (err) => console.error(`${label} failed`, err),
    )
    .finally(() => pending.delete(p));
  pending.add(p);
  // Events recorded after the response (the late answer, afterTurn) are
  // written before the instance can be frozen, off the person's path.
  waitUntil(p.finally(() => flushTracking()));
}
/** Tests only: resolves once every after-response task has settled. */
export async function __afterResponseSettled(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export type Focus = { kind: "step" | "map" | "tool" | "none"; step_id: string | null; domain: string | null; tool_id: string | null };

// PROGRESS ("How am I doing?") lives in engine/qa.ts now: WhatsApp asks it too,
// and composeAnswer uses it to skip the router for a plain progress question.
const NEXT = /\b(next step|what('?s| is) next|what should i (do|focus on)( now| next| first| this week)?|where do i start)\b/i;
// Words too common to say which step a sentence is about: "Am I doing this
// RIGHT?" is not about "Price it right", and "I don't KNOW what to do" is not
// about "Know your numbers".
const STOP = new Set(["your", "with", "that", "this", "from", "they", "them", "what", "when", "have", "will", "into", "about", "more", "every", "their", "know", "right", "take", "without", "make", "good", "need", "want", "doing", "does", "should", "could", "would", "there", "here", "just", "like", "some", "much", "many", "then", "than", "also", "only", "really", "still", "first", "next", "week", "time", "people", "thing", "things", "work", "working", "help", "done", "start", "sure"]);
const SIGNIFICANT = (t: string) => (t.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w));

/**
 * Which step a question is about, by the step's own words: the step whose
 * title's significant words overlap the question most. At least two words
 * must match (or every one, for a title with only one or two), so one common
 * word never lights up a step. Ties go to the next open step.
 */
export function stepMentioned(text: string, steps: PlanStepRow[]): PlanStepRow | null {
  const words = new Set(SIGNIFICANT(text));
  let best: { s: PlanStepRow; score: number } | null = null;
  for (const s of steps) {
    const title = [...new Set(SIGNIFICANT(s.title ?? ""))];
    if (!title.length) continue;
    const hits = title.filter((w) => words.has(w) || [...words].some((x) => x.length >= 5 && w.length >= 5 && w.startsWith(x.slice(0, 5)))).length;
    if (hits < Math.min(2, title.length)) continue;
    const score = hits / title.length;
    if (score >= 0.5 && (!best || score > best.score || (score === best.score && s.status === "open" && best.s.status !== "open"))) best = { s, score };
  }
  return best?.s ?? null;
}

export function computeFocus(question: string, reply: Pick<Reply, "tool_id" | "domain" | "message">, steps: PlanStepRow[]): Focus {
  const next = steps.find((s) => s.status === "open") ?? null;
  const none: Focus = { kind: "none", step_id: null, domain: reply.domain ?? null, tool_id: reply.tool_id ?? null };

  if (PROGRESS.test(question)) return { kind: "map", step_id: null, domain: reply.domain ?? null, tool_id: null };

  const asked = stepMentioned(question, steps);
  if (asked) return { kind: "step", step_id: asked.id, domain: asked.domain ?? reply.domain ?? null, tool_id: asked.tool_id ?? null };

  if (NEXT.test(question) && next) return { kind: "step", step_id: next.id, domain: next.domain ?? null, tool_id: next.tool_id ?? null };

  if (reply.tool_id) {
    const byTool = steps.filter((s) => s.tool_id === reply.tool_id);
    const s = byTool.find((x) => x.status === "open") ?? byTool[0];
    if (s) return { kind: "step", step_id: s.id, domain: s.domain ?? null, tool_id: reply.tool_id };
    return { kind: "tool", step_id: null, domain: reply.domain ?? null, tool_id: reply.tool_id };
  }

  return none;
}

// The person reads this line directly, so it is the plan document's wording
// (rule 10: a cost past 90 days says "confirm at sign-up"), not the prompt
// wording retrieval's costLine uses to instruct a model.
const toolCard = (t: ToolRow) => ({
  id: t.id,
  name: t.name,
  url: t.url,
  cost_line: `${withFreeType(t.cost, t.free_type)}${isStale(t.verified_on) ? " — confirm at sign-up" : ""}`,
  verified_on: t.verified_on ?? null,
  walkthrough: t.walkthrough ?? [],
});

async function state(biz: Business): Promise<Response> {
  const plan = await planFor(biz.id);
  const steps = plan?.steps ?? [];
  const next = steps.find((s) => s.status === "open") ?? null;
  const tools = await toolsFor(biz.country);
  const used = new Set(steps.map((s) => s.tool_id).filter(Boolean) as string[]);
  const toolMap = Object.fromEntries(tools.filter((t) => used.has(t.id)).map((t) => [t.id, toolCard(t)]));
  const done = steps.filter((s) => s.status === "done").length;

  const now = new Map((biz.map ?? []).map((m) => [m.domain, m]));
  const map = DOMAINS.map((d) => ({ domain: d, label: DOMAIN_LABELS[d] ?? d, status: now.get(d)?.status ?? "red", note: now.get(d)?.note ?? "" }));

  const nextTool = next?.tool_id ? toolMap[next.tool_id] : null;
  const suggestions = [
    next ? `How do I do "${next.title}"?` : null,
    "How am I doing?",
    nextTool ? `What does ${nextTool.name} cost?` : null,
    "What should I focus on this week?",
  ].filter(Boolean) as string[];
  track("plan_viewed", { props: { what: "ask", has_plan: Boolean(plan), done, total: steps.length } });

  return json({
    ok: true,
    business: {
      name: biz.context?.name ?? biz.identity?.name ?? "Your money",
      one_liner: biz.context?.one_liner ?? biz.identity?.one_liner ?? "",
      country: biz.country,
      // Opaque and stable per business: the page scopes its saved chat to it,
      // so a second owner on a shared phone never sees the first one's.
      key: hashSecret(`ask-storage:${biz.id}`).slice(0, 16),
      // The symbol as a person writes it ("R", "KSh", "₦", "GH₵"), from the same formatter every prompt uses.
      currency: country(biz.country).money("").trim(),
    },
    plan: plan
      ? {
          goal: plan.plan.goal ?? "",
          progress: { done, total: steps.length, percent: steps.length ? Math.round((done / steps.length) * 100) : 0 },
          steps: steps.map((s) => ({
            id: s.id,
            title: s.title ?? "",
            workstream: s.workstream_title ?? "",
            domain: s.domain ?? null,
            status: s.status,
            push: s.push ?? "",
            why_for_you: s.why_for_you ?? "",
            done_when: s.done_when ?? "",
            tool_id: s.tool_id ?? null,
            is_next: next?.id === s.id,
          })),
        }
      : null,
    map,
    tools: toolMap,
    suggestions: suggestions.slice(0, 4),
  });
}

const TIMED_OUT = Symbol("timed out");
/** The work's result, or TIMED_OUT once `ms` has passed. Does not cancel the work. */
async function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms));
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const EMPTY_REPLY ={ artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: null };
const NO_FOCUS: Focus = { kind: "none", step_id: null, domain: null, tool_id: null };
/** A fixed notice, recorded like any answer, with nothing lit up. */
async function notice(biz: Business, message: string, status = 200): Promise<Response> {
  await recordMessage(biz.id, "out", message, { kind: "web", meta: { channel: "web" } });
  return json({ ok: status < 400, reply: { message, ...EMPTY_REPLY }, focus: NO_FOCUS, grounded: false }, status);
}

async function ask(req: Request, biz: Business): Promise<Response> {
  const started = Date.now();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, message: "Bad request." }, 400);
  }
  const raw = body && typeof body === "object" ? (body as { question?: unknown }).question : undefined;
  if (typeof raw !== "string") return json({ ok: false, message: "Ask me something first." }, 400);
  const question = raw.trim();
  if (!question) {
    trackUnmet("web_question_refused", { severity: "info", props: { reason: "empty", reply: "Ask me something first." }, fingerprint: "web_question_refused:empty" });
    return json({ ok: false, message: "Ask me something first." }, 400);
  }
  // Their words, for every unmet request from here on (trackUnmet scrubs and cuts them).
  setTrackContext({ said: question });
  if (question.length > MAX_QUESTION) {
    trackUnmet("web_question_refused", { severity: "info", props: { reason: "too_long", chars: question.length, reply: `That's a lot — keep it under ${MAX_QUESTION} characters.` }, fingerprint: "web_question_refused:too_long" });
    return json({ ok: false, message: `That's a lot — keep it under ${MAX_QUESTION} characters.` }, 400);
  }
  const ct = (body as { client_turn?: unknown }).client_turn;
  const clientTurn = typeof ct === "string" && CLIENT_TURN.test(ct) ? ct : null;

  // No plan yet (still in the diagnostic, or a plan mid-build): the page has
  // nothing to light up, and the WhatsApp flow is waiting on a specific answer.
  if (!biz.current_plan_id || !WITH_A_PLAN.includes(biz.stage)) {
    trackUnmet("web_question_refused", {
      severity: "info",
      props: { reason: "no_plan", has_plan: Boolean(biz.current_plan_id), reply: "Your plan is still being put together on WhatsApp — finish there first, then come back here." },
      fingerprint: "web_question_refused:no_plan",
    });
    return json({ ok: false, message: "Your plan is still being put together on WhatsApp — finish there first, then come back here." }, 409);
  }

  // Every question costs real model calls. A signed-in owner gets plenty; a
  // stolen session or a stuck script does not get a free model endpoint.
  // Insert first, THEN count (including this one): a count-then-insert let
  // ten parallel requests all read 29 and all go through. And fail CLOSED —
  // a database error must not quietly switch the limit off.
  // The same question sent again (a reload while it was being answered):
  // never a second answer, never a second charge — hand back the first turn.
  if (clientTurn) {
    const earlier = await findTurn(biz, { clientTurn });
    if (earlier === "error") {
      intakeFailed("replay_lookup", "the earlier turn could not be looked up");
      return json({ ok: false, message: "I can't take questions here right now. Try again shortly, or ask me on WhatsApp." }, 503);
    }
    if (earlier) return collectFor(biz, earlier);
  }
  const { data: mine, error: insErr } = await db()
    .from("messages")
    .insert({ business_id: biz.id, direction: "in", text: question.slice(0, 8000), kind: "web", wa_message_id: null, meta: { channel: "web", ...(clientTurn ? { client_turn: clientTurn } : {}) } })
    .select("id");
  if (insErr) {
    intakeFailed("insert", insErr);
    return json({ ok: false, message: "I can't take questions here right now. Try again shortly, or ask me on WhatsApp." }, 503);
  }
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count, error: countErr } = await db()
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("business_id", biz.id)
    .eq("direction", "in")
    .eq("kind", "web")
    .gte("created_at", since);
  if (countErr || count === null || count === undefined || count > PER_HOUR) {
    const id = (mine as { id: unknown }[] | null)?.[0]?.id;
    if (id !== undefined) {
      const { error: kept } = await db().from("messages").delete().eq("id", id);
      // Left behind, a refused question still counts against the hour's limit.
      if (kept) console.warn("ask: a refused question could not be removed", dbError(kept));
    }
    if (countErr || count == null) {
      intakeFailed("count", countErr ?? "no count came back");
      return json({ ok: false, message: "I can't take questions here right now. Try again shortly, or ask me on WhatsApp." }, 503);
    }
    trackUnmet("rate_limited", { props: { where: "ask", limit: PER_HOUR, count, reply: "That's a lot of questions in one hour — give it a little while, or ask me on WhatsApp." }, summary: "A person hit the web's questions-per-hour limit" });
    return json({ ok: false, message: "That's a lot of questions in one hour — give it a little while, or ask me on WhatsApp." }, 429);
  }
  // Accepted: this row is the turn every later event in the request belongs to.
  setTrackContext({ turnId: String((mine as { id: unknown }[] | null)?.[0]?.id ?? "") || null });
  // Their words in `excerpt` (scrubbed), as turn_received keeps them for WhatsApp:
  // the web has no turn_received, and question_asked carries only the reading.
  track("web_question_asked", { excerpt: question, props: { chars: question.length, about_progress: PROGRESS.test(question), stabilising: biz.stage === "stabilizing" } });

  // "What's next?" while stabilising: the stabilising work, never a plan step
  // (round 27: typed, it reached the answer model and got plan step 2).
  if (biz.stage === "stabilizing" && ASKS_FOR_NEXT_STEP.test(question) && !aboutTheMoney(question)) {
    await noteTurnSkipped(biz, "stabilising mode (next step held)");
    track("web_question_answered", { ms: Date.now() - started, props: { outcome: "stabilising_notice", status: 200, held: "typed_next" } });
    return notice(biz, nextWhileStabilising(biz.country, Boolean(biz.current_plan_id)));
  }

  // Stabilising mode holds on every channel (rule 9). A question about the
  // money trouble itself — "should I take a loan to restock?" is exactly the
  // one it exists for — gets the same fixed advice WhatsApp gives, and the
  // web is not a side door to a growth answer. Live test, 2026-09-25: EVERY
  // question got this sentence, on the web as on WhatsApp. An ordinary
  // question falls through to composeAnswer, which puts the stabilising
  // rules in the core block for a business at this stage (buildCore) — the
  // same split handleStabilizing makes in engine/index.ts, with the same
  // test: a question with a pleasantry in front ("I'm fine thanks, how do I
  // register for VAT?") is a question, not news about the money.
  if (biz.stage === "stabilizing" && aboutTheMoney(question)) {
    // Same knowledge_signal note WhatsApp leaves for a turn that never
    // reaches afterTurn (live, 2026-09-23: a turn with no note is a guess).
    await noteTurnSkipped(biz, "stabilising mode");
    track("web_question_answered", { ms: Date.now() - started, props: { outcome: "stabilising_notice", status: 200 } });
    return notice(
      biz,
      "Same advice while it's this tight: food, rent and transport first, no new borrowing, nothing that costs money. When things steady, tell me on WhatsApp and we'll build forward from there.",
    );
  }

  // A question about their own progress is answered from the plan and map
  // already in the core block. It needs no semantic search of the library.
  const turn = String((mine as { id: unknown }[] | null)?.[0]?.id ?? "");
  const finishing = settleTurn(biz, question, turn, started, composeAnswer(biz, question, undefined, { channel: "web", aboutTheirPlan: PROGRESS.test(question) }));
  const out = await withinDeadline(finishing, answerDeadlineMs - (Date.now() - started));
  if (out === TIMED_OUT) {
    // Live, round 3: every web question on production took over 40s (while
    // WhatsApp answered in ~20s), and a hard deadline turned each one into
    // "taking longer than usual" — an answer thrown away for being slow. Now
    // a slow answer is not a failure: it keeps running under waitUntil (the
    // function has 300s, like the worker), is stored against this turn when
    // it lands, and the page collects it with GET ?action=reply&turn=.
    // composeAnswer's distress switch still lands, because it still runs.
    afterResponse(finishing, "ask: late answer");
    return json({ ok: true, pending: true, turn, message: "Still working on it…" }, 202);
  }
  return json(out.body, out.status);
}

type TurnResult = { status: number; body: Record<string, unknown> };

/** The person was told "I can't take questions here right now": the database failed before the question was taken. */
function intakeFailed(step: "replay_lookup" | "insert" | "count", err: unknown): void {
  trackFailure("web_question_failed", dbError(err), {
    props: { reason: "intake", step },
    fingerprint: `web_question_failed:intake:${step}`,
    summary: `A web question was turned away ("I can't take questions here right now"): the database failed at ${step.replace("_", " ")}`,
  });
}

/** A poll for a slow answer could not read the database. Transient: the page polls again. */
function collectFailed(err: unknown): void {
  trackFailure("web_question_failed", dbError(err), { severity: "warn", props: { reason: "collect_error" }, fingerprint: "web_question_failed:collect_error", summary: "A web page could not check on a slow answer: the database read failed (it polls again)" });
}

/**
 * Every turn ends with a stored, final result — never with a page polling
 * into silence (review of round 4). An answer that is still not composed
 * shortly before the function's own lifetime ends, or that throws (route,
 * buildCore, checkReply sit outside composeAnswer's own try), is given up on
 * here: the turn gets its one knowledge_signal note and a final 410 result
 * the page shows at once, instead of polling for five minutes.
 */
async function settleTurn(biz: Business, question: string, turn: string, started: number, composing: Promise<Composed>): Promise<TurnResult> {
  const giveUp = async (why: string): Promise<TurnResult> => {
    await noteTurnSkipped(biz, why).catch(() => {});
    const result: TurnResult = { status: 410, body: { ok: false, final: true, message: SLOW_MESSAGE } };
    await storeResult(biz, SLOW_MESSAGE, turn, Date.now() - started, result, NO_FOCUS, null);
    track("web_question_answered", { ms: Date.now() - started, props: { outcome: "gave_up", status: 410, late: Date.now() - started >= answerDeadlineMs } });
    return result;
  };
  try {
    const c = await withinDeadline(composing, GIVE_UP_MS - 20_000 - (Date.now() - started));
    if (c === TIMED_OUT) {
      composing.catch(() => {});
      trackFailure("web_question_failed", "no answer within the function's lifetime", {
        ms: Date.now() - started,
        props: { reason: "gave_up", why: "timeout" },
        fingerprint: "web_question_failed:gave_up:timeout",
        summary: "A web question was given up on: no answer within the function's lifetime, and the person was told to ask again",
      });
      return await giveUp("gave up: no answer within the function's lifetime");
    }
    return await finishTurn(biz, question, c, turn, started);
  } catch (err) {
    console.log(`ask: turn ${turn} failed`, err);
    trackFailure("web_question_failed", dbError(err), { ms: Date.now() - started, props: { reason: "gave_up", why: "threw" }, summary: "A web question failed before its answer was recorded, and the person was told to ask again" });
    return giveUp("gave up: the answer failed");
  }
}

/**
 * The reply, recorded with its result so the page can collect it. The
 * insert is checked (supabase-js reports failure as {error}, not a throw): an
 * uncollectable answer left the page polling for five minutes. One retry,
 * then a slimmer row with the result alone.
 */
async function storeResult(biz: Business, text: string, turn: string, ms: number, result: TurnResult, focus: Focus, timing: AnswerTiming | null): Promise<void> {
  // meta.timing: where the answer's time went, phase by phase, and which
  // model served each call (engine/qa.ts AnswerTiming). meta.ms is the whole
  // turn as the person waited for it, measured from the question arriving.
  const row = { business_id: biz.id, direction: "out", text: text.slice(0, 8000), kind: "web", wa_message_id: null, meta: { channel: "web", turn, focus, ms, ...(timing ? { timing } : {}), result } };
  for (let i = 0; i < 2; i++) {
    const { error } = await db().from("messages").insert(row);
    if (!error) {
      console.log(`ask: turn ${turn} answered in ${ms}ms (${result.status})${timing ? `: ${timingLine(timing)}` : ""}`);
      await db().from("businesses").update({ last_outbound_at: new Date().toISOString() }).eq("id", biz.id);
      return;
    }
    console.warn(`ask: storing turn ${turn} failed (attempt ${i + 1})`, error.message ?? error);
  }
  const slim = { ...row, text: "", meta: { channel: "web", turn, ms, ...(timing ? { timing } : {}), result: { status: result.status, body: { ...result.body, reply: undefined } } } };
  const { error } = await db().from("messages").insert(slim);
  if (error) {
    console.log(`ask: turn ${turn} could not be stored at all`, error.message ?? error);
    // The page polls for this turn and finds nothing: after five minutes, "I've stopped waiting".
    trackFailure("web_question_failed", dbError(error), { props: { reason: "unstored", status: result.status }, fingerprint: "web_question_failed:unstored", summary: "A web answer could not be stored, so the page waiting for it will never get it" });
  }
}

/**
 * Everything after the answer is composed: focus, the conversation record,
 * the learning. The result is also stored on the recorded reply (meta.result,
 * keyed by `turn`), so a page that stopped waiting can still collect it.
 */
async function finishTurn(biz: Business, question: string, c: Composed, turn: string, started: number): Promise<TurnResult> {
  const ms = Date.now() - started;
  // Timing goes on the record (meta.ms), so a slow web answer is a read, not a guess.
  const record = async (text: string, result: TurnResult, focus: Focus = NO_FOCUS) => {
    result.body.final = true;
    await storeResult(biz, text, turn, ms, result, focus, c.timing);
    return result;
  };
  if (c.kind !== "reply") {
    await noteTurnSkipped(biz, c.handledAs);
    const status = c.kind === "error" ? 502 : 200;
    // An "error" is answer_failed at its cause (engine/qa.ts); this is how the web turn ended.
    track("web_question_answered", { ms, props: { outcome: c.kind, status, handled_as: c.handledAs, late: ms >= answerDeadlineMs } });
    return record(c.message, {
      status,
      body: { ok: c.kind !== "error", ...(c.kind === "error" ? { message: c.message } : {}), reply: { message: c.message, ...EMPTY_REPLY }, focus: NO_FOCUS, grounded: false },
    });
  }

  // The steps the answer's core block already read: reading the plan a
  // second time here (two more queries) bought nothing.
  const focus = computeFocus(question, c.reply, c.steps);
  // "grounded" drives the page's "I don't have checked information on this"
  // note. It means the LIBRARY had nothing — which says nothing about a
  // question on their own plan or progress ("How am I doing?" has no library
  // row, and never needs one). The note is for general questions only.
  const result = await record([c.reply.message, c.reply.artifact].filter(Boolean).join("\n\n"), {
    status: 200,
    body: { ok: true, reply: c.reply, focus, grounded: focus.kind === "none" ? c.grounded : true },
  }, focus);
  // late: the page had already been told "Still working on it…" and collects this by polling.
  track("web_question_answered", {
    ms,
    props: {
      outcome: "answered",
      status: 200,
      focus: focus.kind,
      tool_id: focus.tool_id,
      domain: focus.domain,
      grounded: c.grounded,
      stabilising_turn: Boolean(c.stabilisingTurn),
      late: ms >= answerDeadlineMs,
    },
  });
  // Learning from the turn does not hold the answer. The reply above is
  // already checked and recorded, so nothing the person sees depends on it.
  afterResponse(afterTurn(biz, question, c.reply.message, { ownerWords: true, forwarded: Boolean(c.url), source: "web" }), "ask: afterTurn");
  return result;
}

/** A web question row by its id or by the page's own client_turn. "error" on a database failure. */
async function findTurn(biz: Business, by: { turn?: string; clientTurn?: string }): Promise<{ id: string; created_at: string } | null | "error"> {
  if (by.turn) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(by.turn)) return null;
    const { data, error } = await db().from("messages").select("id, created_at").eq("id", by.turn).eq("business_id", biz.id).eq("kind", "web").eq("direction", "in").maybeSingle();
    // A non-numeric id is a Postgres cast error, not an outage: treat it as not found.
    if (error) return /invalid input syntax|22P02/.test(`${error.message ?? ""} ${(error as { code?: string }).code ?? ""}`) ? null : "error";
    const r = data as { id: unknown; created_at: string } | null;
    return r ? { id: String(r.id), created_at: r.created_at } : null;
  }
  const since = new Date(Date.now() - GIVE_UP_MS).toISOString();
  const { data, error } = await db()
    .from("messages")
    .select("id, created_at, meta")
    .eq("business_id", biz.id)
    .eq("kind", "web")
    .eq("direction", "in")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) return "error";
  const r = ((data as { id: unknown; created_at: string; meta: { client_turn?: string } | null }[]) ?? []).find((m) => m.meta?.client_turn === by.clientTurn);
  return r ? { id: String(r.id), created_at: r.created_at } : null;
}

/** The stored final result for a turn, 202 while it is still running, 410 once nothing more can come. */
async function collectFor(biz: Business, q: { id: string; created_at: string }): Promise<Response> {
  const { data: outs, error } = await db()
    .from("messages")
    .select("meta, created_at")
    .eq("business_id", biz.id)
    .eq("kind", "web")
    .eq("direction", "out")
    .gte("created_at", q.created_at)
    .order("created_at", { ascending: true })
    .limit(30);
  // Transient: no `final`, so the page retries the poll rather than ending the turn.
  if (error) {
    collectFailed(error);
    return json({ ok: false, message: "Couldn't check on that answer just now — still trying." }, 503);
  }
  const hit = ((outs as { meta: { turn?: string; result?: TurnResult } | null }[]) ?? []).find((m) => m.meta?.turn === q.id && m.meta?.result);
  if (hit) return json({ ...hit.meta!.result!.body, final: true }, hit.meta!.result!.status);
  // Past the function's own lifetime nothing more is coming: say so, finally.
  if (Date.now() - new Date(q.created_at).getTime() > GIVE_UP_MS) {
    // settleTurn always stores a result, so none at all means the function died mid-answer.
    trackFailure("web_question_failed", "no result was ever stored for the turn", {
      ms: Date.now() - new Date(q.created_at).getTime(),
      props: { reason: "lost" },
      fingerprint: "web_question_failed:lost",
      summary: "A web question's answer never arrived: nothing was stored for the turn, and the person was told to ask again",
    });
    return json({ ok: false, final: true, message: SLOW_MESSAGE, reply: { message: SLOW_MESSAGE, ...EMPTY_REPLY }, focus: NO_FOCUS, grounded: false }, 410);
  }
  return json({ ok: true, pending: true, turn: q.id }, 202);
}

/** The page collecting a slow answer, by turn id or by its own client_turn. */
async function collect(biz: Business, turn: string, clientTurn: string): Promise<Response> {
  if (!turn && !(clientTurn && CLIENT_TURN.test(clientTurn))) return json({ ok: false, message: "Bad request." }, 400);
  const q = await findTurn(biz, turn ? { turn } : { clientTurn });
  if (q === "error") {
    collectFailed("the turn could not be looked up");
    return json({ ok: false, message: "Couldn't check on that answer just now — still trying." }, 503);
  }
  if (!q) {
    // The page shows "I lost track of that answer. Ask it again."
    trackFailure("web_question_failed", "the page asked for a turn that is not there", { severity: "warn", props: { reason: "turn_not_found", by: turn ? "turn" : "client_turn" }, fingerprint: "web_question_failed:turn_not_found", summary: "A web page polled for an answer that is not there, and the person was told to ask again" });
    return json({ ok: false, final: true, message: "Not found." }, 404);
  }
  return collectFor(biz, q);
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  const biz = await businessForSession(sessionToken(req), "ask");
  if (!biz) return json({ ok: false, message: "Sign in with your WhatsApp number first." }, 401);

  const url = new URL(req.url);
  try {
    if (req.method === "GET" && url.searchParams.get("action") === "state") return await state(biz);
    if (req.method === "GET" && url.searchParams.get("action") === "reply") return await collect(biz, url.searchParams.get("turn") ?? "", url.searchParams.get("client_turn") ?? "");
    if (req.method === "POST") return await ask(req, biz);
    return json({ ok: false, message: "Not found." }, 404);
  } catch (err) {
    console.log("ask failed", err);
    noteRequestFailure(err);
    return json({ ok: false, message: "Something went wrong on my side. Try again in a moment." }, 500);
  }
}

const served = tracked("ask", "web", handler);
export const GET = served;
export const POST = served;
export const OPTIONS = served;
