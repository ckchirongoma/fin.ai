// Fin — a yes/no question gets a yes/no answer, in a line or two.
//
// The reply prompt already says it (prompts.ts REPLY_SCHEMA, "YES OR NO"):
// the first word is the answer, the whole message is one or two short lines,
// and the detail goes behind a quick reply. Live test, round 10 (2026-09-26):
// the first half held 5 times out of 5; the second failed 3 times out of 5.
// "Do I need to register with CIPC to start?" got "Not yet." followed by 429
// characters of explanation — with a "Show me how" button underneath that
// the explanation had already made pointless.
//
// So the second half is enforced here, after the model, the way the first
// half never needed to be. Only when both sides are unmistakable: the person
// asked a plain yes/no question (not "how" or "why"), and the reply really
// does open with the answer. The rest is not lost: a quick reply offers it,
// and tapping it asks for exactly that detail.

import { moneyIn } from "./grounding.js";

/** A question that can be answered yes or no, and nothing more. */
const YES_NO_QUESTION = /^\s*(do|does|did|is|are|am|was|were|can|could|should|shall|must|will|would|have|has|may|need)\b[^?]*\?\s*$/i;
/** Asking for the detail in the same breath: then the detail is the answer. */
const WANTS_DETAIL = /\b(how|why|what|which|where|when|who|explain|steps|walk me|tell me|list)\b|\band\b[^?]*\?/i;
/** The reply opens with the answer. */
const OPENS_WITH_ANSWER = /^\s*(yes|no|not yet|not really|it depends|probably|probably not|usually|only if|not unless)\b/i;

/**
 * A sentence naming who confirms a tax or legal answer. "confirming" too:
 * round 28 (ZA, live), the guardrail's own "Worth confirming that part with
 * the Information Regulator…" did not match \bconfirm\b and was cut from
 * every yes/no POPIA answer, the one wording the brief used three rounds
 * running.
 */
const WHO_CONFIRMS = /\b(confirm\w*|check with|ask (the|your)|verify\w*)\b/i;
/** The guardrail's own confirm line (safety.ts checkReply): kept whatever the length. */
const GUARDRAIL_CONFIRM = /^Worth confirming that part with\b/;

/** A sentence telling them to confirm a price. */
const PRICE_HEDGE = /at sign-up|may have changed|confirm the amount/i;

/** The most a yes/no answer keeps. Round 10's passes were 214 and 226 characters. */
export const YES_NO_MAX_CHARS = 220;
/**
 * The most it keeps when the reason carries the figure the answer rests on
 * (a threshold, a fee). Round 29 (UG, live): "Not yet." lost its reason —
 * "once your taxable sales pass UGX 150 million…", one long sentence — and
 * kept "That number is what tells you where you stand", about a number that
 * was no longer there.
 */
export const YES_NO_FIGURE_MAX_CHARS = 380;
/** A sentence that only makes sense after the one before it: "That number…", "This means…". */
const POINTS_BACK = /^\s*(?:that|this|these|those|it|which|such|so)\b/i;
/** A figure an answer can rest on: money, a percentage, or a number with a unit. */
const CARRIES_FIGURE = /\d/;
/** The button that brings the cut detail back. */
export const MORE_LABEL = "Tell me more";

export function isYesNoQuestion(question: string): boolean {
  const q = question.trim();
  return YES_NO_QUESTION.test(q) && !WANTS_DETAIL.test(q.replace(/^\s*\S+/, ""));
}

function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The reply cut to its answer: at most two sentences within YES_NO_MAX_CHARS
 * (always at least the first), with a "Tell me more" quick reply whenever
 * something was cut and no quick reply already offers more. Returns the
 * reply untouched when the question or the answer is not plainly yes/no.
 */
export function trimYesNo<R extends { message: string; quick_replies: string[] }>(question: string, reply: R): R {
  if (!isYesNoQuestion(question) || !OPENS_WITH_ANSWER.test(reply.message)) return reply;
  const all = sentences(reply.message);
  if (all.length <= 1 || reply.message.length <= YES_NO_MAX_CHARS) return reply;

  const kept = [all[0]!];
  const len = () => kept.join(" ").length;
  // The reason after the yes or no, when it fits — or when it carries the
  // figure the answer rests on, a little longer.
  if (all[1] && (len() + 1 + all[1].length <= YES_NO_MAX_CHARS || (CARRIES_FIGURE.test(all[1]) && !CARRIES_FIGURE.test(all[0]!) && len() + 1 + all[1].length <= YES_NO_FIGURE_MAX_CHARS))) kept.push(all[1]);
  // A tax or legal answer never loses the line that says who confirms it
  // (prompts.ts KEEP IT SAFE), even at a few characters over. One that
  // points back ("That number…") only follows the sentence it points to.
  const rest = all.slice(kept.length);
  const follows = (x: string) => !POINTS_BACK.test(x) || kept.includes(all[all.indexOf(x) - 1] ?? "");
  const confirm = rest.find((x) => GUARDRAIL_CONFIRM.test(x)) ?? rest.find((x) => WHO_CONFIRMS.test(x) && follows(x));
  if (confirm && (GUARDRAIL_CONFIRM.test(confirm) || len() + 1 + confirm.length <= YES_NO_MAX_CHARS + 120)) kept.push(confirm);
  // Nor the line that says to confirm a price it kept (rule 10): the
  // guardrail's "Check that price at sign-up…" used to be cut here while
  // the price stayed (review, round 21).
  const hedge = all.slice(1).find((x) => PRICE_HEDGE.test(x) && !kept.includes(x));
  if (hedge && moneyIn(kept.join(" ")).length) kept.push(hedge);
  if (kept.length === all.length) return reply;

  const quick = reply.quick_replies.length ? reply.quick_replies : [MORE_LABEL];
  return { ...reply, message: kept.join(" "), quick_replies: quick };
}
