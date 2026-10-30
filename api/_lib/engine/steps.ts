// Fin — the loop that makes this a product rather than a document.
//
// "Send next step" → do it (with a walkthrough if the step names a tool) →
// "Done" → did it actually work? → next step. The first backend generated a
// plan and then answered every message with "Got it. I've written that down",
// which meant the one thing the evidence says matters — closing the loop and
// learning from the result — never happened.
//
// Everything here dispatches on an explicit action id. Nothing re-parses the
// text of a button.

import { PRODUCT_NAME } from "./build.js";
import { fenceCheck, JobFencedError } from "../jobctx.js";
import { ACT } from "../actions.js";
import { outcomePlausible } from "../judgement.js";
import { askJSON } from "../models.js";
import { helpPrompt, changePrompt, REPLY_SCHEMA } from "../prompts.js";
import { sendButtons, sendList, sendText, WA, fitLabel } from "../wa.js";
import { businessKnownFacts, checkReply, checkToolHelpGrounding } from "../safety.js";
import { buildCore, contextSummary, dateSources, firstOpenStep } from "./context.js";
import { ownFigures, scrubMoneySlots, checkDaysOf, stampLibraryFigures, stripCopiedStamps } from "../pricestamp.js";
import { dropUngroundedDates } from "../datecheck.js";
import { addCommitment, findBusinessById, logDecision, logOutcome, planFor, recordSafetyEvent, toolById, toolsFor, updateBusiness, updateStep, db } from "../db.js";
import { libraryHowTo, libraryToolChoices, problemPhrase } from "../playbooks.js";
import { costLine } from "../retrieval.js";
import { moneyIn } from "../grounding.js";
import { blanks, checkArtifact } from "./artifact.js";
import { guardReplyContacts, hostOf, normUrl, urlsIn } from "../contacts.js";
import { country } from "../countries.js";
import { stepDocHTML } from "./stepdoc.js";
import { renderAndSendPlanPdf } from "../pdfclient.js";
import { errorText, since, track, trackFailure, trackUnmet } from "../track.js";
import type { Business, PlanStepRow, Reply } from "../types.js";

const DAYS = 864e5;

/** Whole minutes since a stored timestamp, for an event's props; null when there is none. */
const minsSince = (iso?: string | null): number | null => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? Math.round((Date.now() - t) / 60_000) : null;
};

/** Normalises whatever a person-facing model call returned into the fixed shape. */
export function tidy(raw: Record<string, unknown>): Reply {
  const banned = /\b(APR|liquidity|leverage|KPI|amortis[a-z]*|compound interest|net worth|portfolio|diversif[a-z]*)\b/gi;
  const swap: Record<string, string> = {
    apr: "yearly interest rate",
    liquidity: "money you can get at",
    leverage: "borrowing",
    kpi: "number to watch",
    "net worth": "what you own minus what you owe",
    portfolio: "savings",
    "compound interest": "interest on interest",
  };
  // A newline the model escaped twice arrives as the two characters "\n"
  // and was shown to a ZA owner as is (round 22). No owner-facing text
  // ever means a literal backslash-n.
  const unescape = (t: string): string => t.replace(/\\r\\n|\\n/g, "\n");
  const message = unescape(String(raw.message ?? ""))
    .replace(/^\s*[#*•\-]\s?/gm, "")
    .replace(/\*\*/g, "")
    .replace(banned, (m) => swap[m.toLowerCase()] ?? swap[Object.keys(swap).find((k) => m.toLowerCase().startsWith(k)) ?? ""] ?? m)
    // A doubled full stop, never an ellipsis: round 23, KE: "As far as I
    // know, yes.. The final say is the invoice".
    .replace(/(?<!\.)\.\.(?!\.)/g, ".")
    .trim();

  const tap = raw.next_tap as { label?: string; url?: string } | null | undefined;
  const rawArtifact = typeof raw.artifact === "string" && raw.artifact.trim() ? undoubled(unescape(raw.artifact).trim()) : null;
  // A line for the person inside the words their customers will read (round
  // 34, ZA, live: "Send it to your walk-ins and any delivery companies you
  // wash." sat in the paste-ready text, before "Reply STOP"): it moves to the
  // message, where it is advice.
  const { words: artifact, forOwner } = ownerLinesOut(rawArtifact);
  return {
    message: withoutRepeatOf(ownerWords([undoubled(message), ...forOwner].filter(Boolean).join("\n\n")), artifact),
    artifact,
    // The link's label sits in the message text, not on a button, so it has
    // no 20-character limit: cutting it printed "Open the CIPC BizPo…: https://…".
    next_tap: tap?.url ? { label: linkLabel(String(tap.label || "Open"), tap.url), url: tap.url } : null,
    // A suggested reply that does not fit a button whole is dropped, never
    // cut: "Show me how to regi…" was a button a person could not read. So
    // is one with a slot in it: a tap sends the button's words as they are,
    // and "It's UGX [rent]" (round 24, live) can never be the person's answer.
    quick_replies: Array.isArray(raw.quick_replies)
      ? (raw.quick_replies as unknown[])
          .map((q) => String(q ?? "").trim())
          .filter((q) => q && q.length <= WA.buttonTitleChars && !/[[\]{}<>]|\bX{3,}\b|_{3,}/.test(q))
          .slice(0, WA.buttons)
      : [],
    tool_id: typeof raw.tool_id === "string" ? raw.tool_id : null,
    domain: typeof raw.domain === "string" ? raw.domain : null,
  };
}

/** "Show me the message", "See the post", "Write the caption": a button asking for words. */
const ASKS_FOR_WORDS = /\b(?:show|see|send|write|give|draft|get)\b(?:\s+\w+){0,3}\s+(?:message|text|draft|caption|captions|post|words|wording|reply|script)\b/i;
/** A reply that says its words are already there. */
const WORDS_ALREADY_THERE = /\b(?:already written|written (?:it )?(?:above|below|for you)|(?:here(?:'s| is)|below is|above is) (?:the|your) (?:message|text|caption|post|draft|reply))\b/i;

/**
 * The quick replies a person can tap, as their own words. A tap sends the
 * button's text as theirs, so a button never carries a price they did not
 * give (round 27, live: "What's the special?" came with "R120 basic wash",
 * a price the person had not chosen), and never asks for words the reply has
 * already written (round 27: "The message is already written above" with a
 * "Show me the message" button under it). `owned`: the person's own figures.
 */
export function fitQuickReplies(reply: Pick<Reply, "message" | "artifact" | "quick_replies">, owned: Set<number>): string[] {
  const wordsThere = Boolean(reply.artifact?.trim()) || WORDS_ALREADY_THERE.test(reply.message);
  return reply.quick_replies.filter((q) => {
    const figures = moneyIn(q);
    if (figures.some((v) => !owned.has(v))) return false;
    // Their own figure, only to confirm it ("R120 is right"): round 28 (ZA,
    // live), "2-for-R80 wash" put a deal nobody proposed on a button, with
    // the person's own R80 in it.
    if (figures.length && !CONFIRMS_A_FIGURE.test(q)) return false;
    if (wordsThere && ASKS_FOR_WORDS.test(q)) return false;
    // A tap that cuts their price is Fin pushing one (KEEP IT SAFE:
    // never push a price cut). Round 32 (ZA, live): "Lower the price" under
    // a price the person had just confirmed, "Make it cheaper" under a
    // discount they had already chosen; round 33, "Change the price". They
    // can still type it.
    if (PRICE_CUT_TAP.test(q)) return false;
    return true;
  });
}
/** A small word said twice: "one written monthly price per per vehicle" (round 34, KE, live). */
export const undoubled = (t: string): string => t.replace(/\b(per|the|a|an|to|of|and|for|on|in|is|at|your|you|it)\s+\1\b/gi, "$1");
/** A sentence telling the person what to do with the words: "Send it to your walk-ins…", "Post it on Friday…". */
const FOR_THE_OWNER = /^\s*(?:send|post|share|forward|pin|put) (?:it|this|these|them) (?:to|on|in|at|before|after|every|each|tonight|today|tomorrow)\b|^\s*(?:fill in|remember to|make sure you)\b/i;
export function ownerLinesOut(words: string | null): { words: string | null; forOwner: string[] } {
  if (!words) return { words, forOwner: [] };
  const parts = words.split(/((?<=[.!?])[ \t]+|\n+)/);
  const forOwner: string[] = [];
  const kept: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (FOR_THE_OWNER.test(parts[i]!)) forOwner.push(parts[i]!.trim());
    else kept.push(parts[i]!, parts[i + 1] ?? "");
  }
  const out = kept.join("").trim();
  return out && forOwner.length ? { words: out, forOwner } : { words, forOwner: [] };
}
/** "Lower the price", "Make it cheaper", "Drop it lower", "Cut the price", "Go lower". */
// Round 33 (ZA, live): "Change the price" under the R120 they had just
// confirmed: the same second guess under another name.
// Round 34 (KE, live): "Why not half price?" under the half-price week they
// asked for, and "Shorten it to 3 days", a different deal.
const PRICE_CUT_TAP = /\b(?:lower|cheaper|reduce|discount\w*|knock\w* off)\b|\b(?:cut|drop|bring down|change|adjust|rethink|reconsider|different|new)\b[^?]*\b(?:price|cost)\b|\bdrop it\b|^\s*why not\b|\b(?:shorten|cut|limit|keep) (?:it|the deal|the offer) to \d+\b/i;
/** An example clause: ", e.g. braids at UGX 35,000 instead of UGX 45,000", up to a closing bracket or the line's end. */
const EXAMPLE_CLAUSE = /,?\s*\b(?:e\.g\.?|eg\b|for example|for instance)[,:]?\s*[^)\]\n]*/gi;

/**
 * An example that carries a price nobody gave is taken out, the rest kept.
 * Round 29 (UG, live): the fill-in hint read "(name, special, e.g. braids at
 * ugx 35,000 instead of ugx 45,000)" — UGX 35,000 was nobody's price, and an
 * owner who pastes it fast sends it. `known`: the person's own figures and the
 * library's.
 */
export function withoutInventedExamples(text: string, known: Set<number>): string {
  return text.replace(EXAMPLE_CLAUSE, (m) => (moneyIn(m).some((v) => !known.has(v)) ? "" : m));
}

const CONFIRMS_A_FIGURE = /\b(?:is right|is correct|that'?s right|that'?s it|that'?s correct|yes|correct|confirm\w*|i meant)\b/i;

/**
 * "artifact" is the reply schema's field name, never a word for the person.
 * Round 28 (UG, live): "Here's a shorter one in the artifact."
 */
export function ownerWords(message: string): string {
  return message
    .replace(/\bin (?:the |your )?artifact\b/gi, "below")
    .replace(/\b(see|check) (?:the |your )?artifact\b/gi, (_m, v: string) => `${v} below`)
    .replace(/\b(?:the|your|this) artifact(?=\s+(?:below|above)\b)/gi, "the message")
    .replace(/\b(?:the|your|this) artifact\b/gi, "the message below")
    .replace(/\bartifacts?\b/gi, "message");
}

/** Lower-case words of four letters or more, for "is this the same text?" */
const wordSet = (t: string): Set<string> => new Set((t.toLowerCase().match(/[\p{L}\p{N}']{4,}/gu) ?? []));

/**
 * The message without a paragraph that only repeats the words in the
 * artifact. Round 28 (UG, live): the message to send was given twice, once
 * inside the advice and once on its own. A paragraph goes when it holds the
 * artifact whole, or shares at least 80% of its words with it; the advice
 * around it stays. If nothing would be left, one short line introduces it.
 */
export function withoutRepeatOf(message: string, artifact: string | null): string {
  if (!artifact) return message;
  const flat = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
  const art = flat(artifact);
  const artWords = wordSet(artifact);
  const paras = message.split(/\n{2,}/);
  const kept = paras.filter((p) => {
    const f = flat(p);
    if (!f) return false;
    if (art.length >= 20 && f.includes(art)) return false;
    const w = wordSet(p);
    if (w.size < 8 || artWords.size < 8) return true;
    let shared = 0;
    for (const x of w) if (artWords.has(x)) shared++;
    return shared / Math.min(w.size, artWords.size) < 0.8;
  });
  if (kept.length === paras.length) return message;
  return kept.join("\n\n").trim() || "Here it is, ready to send:";
}

/**
 * A link's label, true to where it goes. Round 22, live: answers ended
 * "Start step 1: https://…/plan" — the label promised the first step and
 * the link opened the plan page. A link to the person's plan says so.
 */
export function linkLabel(label: string, url: string): string {
  const fitted = fitLabel(label, 60) || "Open";
  let path = "";
  try {
    path = new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    return fitted;
  }
  return path === "/plan" && /\bstep\b|\bstart\b|\bnext\b/i.test(fitted) ? "Your plan" : fitted;
}

/** Whether `text` already gives the address `url` points to: the same page, or the same site when the link is the site itself. */
export function alreadyLinked(text: string, url: string): boolean {
  const tap = normUrl(url);
  const given = urlsIn(text).map(normUrl);
  return given.includes(tap) || (hostOf(tap) === tap && given.some((u) => hostOf(u) === tap));
}

/**
 * An artifact goes out as its OWN message. On a phone that is the difference
 * between "press and hold to copy the whole thing" and picking a paragraph out
 * of a longer message by hand.
 */
export async function sendReply(biz: Business, r: Reply, buttons?: { id: string; title: string }[]): Promise<void> {
  // The link once: an answer that already gives the address in its text —
  // however it is written: "bizportal.gov.za", "www.…", "https://…/" — does
  // not get it again underneath (round 22, ZA: BizPortal twice).
  const linked = r.next_tap && !alreadyLinked(r.message, r.next_tap.url);
  const body = r.next_tap && linked ? `${r.message}\n\n${r.next_tap.label}: ${r.next_tap.url}` : r.message;
  // PRIORITY 5.1: never forward a model-written artifact that still has an
  // unfilled "[...]" in it — see engine/artifact.ts for why this cannot be
  // fixed by prompting alone.
  const artifact = checkArtifact(r.artifact, biz);
  const artifactText = artifact.text ?? artifact.fallback;
  // Buttons always come last, under everything they are about: an answer
  // with words to paste went out as [answer + buttons] then [words], so the
  // buttons sat above the thing they offered (audit, 2026-10).
  if (buttons?.length && (body.length > WA.bodyChars || artifactText)) {
    // A button message's body stops at 1024 characters, and sendButtons clips
    // it with "…" — the end of the answer, usually the next step, would be
    // lost. Answers have no word cap any more (they are as long as they need
    // to be), so a long one goes out whole as text, then the words to paste
    // it points at, and the buttons come last.
    await sendText(biz.wa_id, body, biz.id);
    if (artifactText) await sendText(biz.wa_id, artifactText, biz.id, { kind: ARTIFACT_KIND });
    await sendButtons(biz.wa_id, "What next?", buttons.slice(0, WA.buttons), biz.id);
    return;
  }
  if (buttons?.length) await sendButtons(biz.wa_id, body, buttons.slice(0, WA.buttons), biz.id);
  else await sendText(biz.wa_id, body, biz.id);
  if (artifactText) await sendText(biz.wa_id, artifactText, biz.id, { kind: ARTIFACT_KIND });
}

/**
 * The conversation-log kind of words written for the person to send (a
 * promo, a post): "send it again" resends exactly these (engine/qa.ts).
 */
export const ARTIFACT_KIND = "artifact";

// ── Holding the plan while stabilising ───────────────────────────

/**
 * Every button that moves the growth plan: the step card's, the
 * walkthrough's, and the outcome check-in's (those carry ":<stepId>" and are
 * matched by prefix in engine/index.ts).
 */
export const PLAN_TAPS: ReadonlySet<string> = new Set([
  ACT.NEXT_STEP,
  ACT.STEP_DONE,
  ACT.STEP_HELP,
  ACT.STEP_SKIP,
  ACT.STEP_WALK,
  ACT.STEP_PDF,
  ACT.WALK_NEXT,
  ACT.WALK_STUCK,
  ACT.WALK_LATER,
  ACT.OUTCOME_BETTER,
  ACT.OUTCOME_EARLY,
  ACT.OUTCOME_NONE,
]);

export const PLAN_HELD_WHILE_STABILISING =
  "Your plan is kept, but it's paused while things are this tight — I'll pick it up with you the moment you tell me things have steadied. If you're stuck on something right now, tell me what and I'll give you the free way to do it.";

export const NO_PLAN_WHILE_STABILISING =
  "Building a plan is paused while things are this tight — I'll build it with you the moment you tell me things have steadied. If you're stuck on something right now, tell me what and I'll give you the free way to do it.";

/**
 * A typed ask for the next step, the whole message: "What's next?", "What
 * should I do now?", "next step", "where do I start?". Not "What should I do
 * about the landlord?" — that is a question, and gets a real answer. Round 27
 * (KE, live): in stabilising mode the button held, but the same ask TYPED
 * went to the answer model, which handed out plan step 2 ("Next is the free
 * bit that brings them back…") to a person who could not pay rent.
 */
export const ASKS_FOR_NEXT_STEP =
  /^\s*(?:(?:ok(?:ay)?|so|right|alright|and|then)[,!.]?\s+)?(?:what(?:'?s|\s+is)\s+(?:my\s+|the\s+)?next(?:\s+step)?|what\s+next|(?:my\s+|the\s+)?next\s+step|next|what\s+(?:should|do|can|must)\s+i\s+do(?:\s+(?:next|now|today|first|this\s+week))?|what\s+now|where\s+do\s+i\s+start)(?:\s+(?:then|now|today|please))?\s*[?!.]*\s*$/i;

/** What a stabilising owner who asks "what's next?" is told: the stabilising work, never a plan step (rule 9). */
export function nextWhileStabilising(countryCode: string, hasPlan: boolean): string {
  return (
    `Right now the next thing isn't a plan step. It's keeping food, rent and transport covered: those first, no new borrowing from anyone, and nothing that costs money.\n\n` +
    `${hasPlan ? "Your plan is kept and paused" : "Building your plan is paused"} — tell me when things have steadied and we'll pick it up. For free help working through it: ${country(countryCode).advisor}.`
  );
}

/**
 * A stabilising owner tapped a plan button from an older message. Rule 9:
 * the plan does not move and the stage does not change (nothing here writes
 * `stage` or `pending_action`). One honest line, and a row on the record.
 */
export async function holdPlanWhileStabilising(biz: Business, what: string): Promise<void> {
  // Held by design (rule 9), but still something the person tried and did not
  // get. `what` is an action id (its ":<stepId>" dropped) or the caller's name.
  trackUnmet("plan_held_stabilising", { severity: "info", props: { what: what.split(":")[0], has_plan: Boolean(biz.current_plan_id) } });
  // "Your plan is kept" is only true of a person who has one: one flagged
  // during the diagnostic has none yet (rule 2 — say only what is true).
  await sendText(biz.wa_id, biz.current_plan_id ? PLAN_HELD_WHILE_STABILISING : NO_PLAN_WHILE_STABILISING, biz.id);
  await recordSafetyEvent({
    businessId: biz.id,
    check: "distress",
    engine: "none",
    outcome: "block",
    flags: ["plan_held"],
    detail: `plan button tapped while stabilising (${what}); plan held, stage kept`.slice(0, 300),
  });
}

// ── Pushing the next step ────────────────────────────────────────

/**
 * The step message with its fixed "How to do it" lines folded in — the same
 * message, never an extra one. A step that names no tool has no walkthrough
 * to follow it, so without these it said WHAT to do and never how. Fixed
 * library text (playbooks.ts how_to), never a model's. The lines are short
 * and few, so this stays far under a text message's limit; the whole message
 * is still kept inside WA.textChars, and if it ever would not fit, the
 * step's own text goes out unchanged rather than half a list.
 */
export function withHowTo(body: string, howTo: readonly string[]): string {
  if (!howTo.length) return body;
  const full = `${body}\n\nHow to do it:\n${howTo.map((l) => `• ${l}`).join("\n")}`;
  return full.length <= WA.textChars ? full : body;
}

export async function pushNextStep(biz: Business): Promise<void> {
  // Belt and braces: several paths reach here, and none of them may take a
  // stabilising business back onto the growth plan by the back door.
  if (biz.stage === "stabilizing") return holdPlanWhileStabilising(biz, "pushNextStep");
  const plan = await planFor(biz.id);
  if (!plan) {
    // Never answer with the instruction that produced the answer. Work out
    // where they actually are and move them one step forward from there.
    const answered = Object.keys(biz.answers ?? {}).length;
    if (answered >= 12) {
      // The questions are done; the build did not finish. Pick it back up.
      // Only the person asking for a step noticed — or this is an old "Next
      // step" (or a typed "next") arriving while a build runs, which starts a
      // second one. Either way the team should know.
      trackFailure("build_restarted", "next step asked for with no plan after the questions", {
        severity: "warn",
        alert: "digest",
        // runReadbackStep starts again at the read-back, as index.ts's restarts do.
        props: { phase: "readback", reason: "no_plan", answered, building: biz.pending_action?.kind === "building" },
        fingerprint: "build_restarted:no_plan",
        summary: "A person asked for their next step after finishing the questions, had no plan, and the build was started again",
      });
      const { runReadbackStep } = await import("./build.js");
      await sendText(biz.wa_id, "Let me pick your plan back up. I'll message you the moment the next part is ready.", biz.id);
      await updateBusiness(biz.id, { stage: "diag_done", pending_action: { kind: "building", since: new Date().toISOString() } });
      return runReadbackStep({ ...biz, stage: "diag_done" });
    }
    // Asked for a step before there is a plan: sent back to the questions.
    trackUnmet("step_unavailable", { severity: "info", props: { what: "next_step", reason: "no_plan", answered } });
    const { askDiagQuestion } = await import("./index.js");
    await sendText(
      biz.wa_id,
      answered
        ? "We're partway through the questions — a few more and I can build your plan."
        : "We haven't built your plan yet. A few short questions first — about 10 minutes — and then I build it.",
      biz.id,
    );
    await updateBusiness(biz.id, { stage: "diag" });
    return askDiagQuestion({ ...biz, stage: "diag" }, Math.min(answered, 11));
  }

  const step = firstOpenStep(plan.steps);
  if (!step) {
    await planComplete(biz, plan.steps);
    return;
  }

  // "Next step" sits on almost every message this product sends, so a person
  // scrolling back and tapping an older one is ordinary behaviour — as is
  // double-tapping when the first send was slow. Re-sending three messages and
  // opening a second commitment for the same step is not.
  const pushedAt = step.pushed_at ? new Date(step.pushed_at).getTime() : 0;
  if (Date.now() - pushedAt < 90_000) {
    // Not a step_pushed: the funnel counts steps that went out, and this one
    // did not go out again. Many of these means sends are slow, or the person
    // wanted a different step than the one in front of them.
    track("step_push_repeated", { props: { step_key: step.step_key, secs: Math.round((Date.now() - pushedAt) / 1000) } });
    await updateBusiness(biz.id, { stage: "step_pushed", pending_action: { kind: "step", step_id: step.id } });
    await sendButtons(
      biz.wa_id,
      `That's the one you're on: ${step.title}.`,
      [
        { id: ACT.STEP_DONE, title: "Done" },
        { id: ACT.STEP_HELP, title: "I'm stuck" },
      ],
      biz.id,
    );
    return;
  }

  await updateStep(step.id, { pushed_at: new Date().toISOString() });
  await updateBusiness(biz.id, { stage: "step_pushed", pending_action: { kind: "step", step_id: step.id }, walk: null });

  const position = plan.steps.filter((s) => s.status !== "open").length + 1;
  const header = `Step ${position} of ${plan.steps.length} — ${step.workstream_title ?? ""}`.trim();
  const body = [header, "", step.title, "", step.push ?? "", step.why_for_you ? `\nWhy this, for you: ${step.why_for_you}` : ""]
    .join("\n")
    .trim();

  await sendText(biz.wa_id, withHowTo(body, libraryHowTo(step.step_key)), biz.id);

  // PRIORITY 5.1: an artifact still carrying an unfilled "[...]" placeholder
  // must never reach the phone verbatim — see engine/artifact.ts.
  const artifact = checkArtifact(step.artifact, biz);
  if (artifact.text) await sendText(biz.wa_id, artifact.text, biz.id);
  else if (artifact.fallback) await sendText(biz.wa_id, artifact.fallback, biz.id);

  // The tool link and its real cost go out as their own line: rule 10 says the
  // number comes from the library with its verification date, never from a model.
  const tool = step.tool_id ? await toolById(step.tool_id, biz.country) : null;
  if (!tool && step.tool_id) {
    // The step names a tool this country's library does not have: it goes
    // out with no link, no cost and no set-up steps, and nothing else says so.
    trackFailure("tool_not_found", `tool ${step.tool_id} is not in the ${biz.country} library`, {
      severity: "warn",
      alert: "digest",
      props: { where: "step", tool_id: step.tool_id, step_key: step.step_key },
      fingerprint: `tool_not_found:step:${step.tool_id}`,
      summary: `A step went out without its tool: "${step.tool_id}" is not in the ${biz.country} library`,
    });
  }

  // PRIORITY 4.2: the real, numbered steps used to be gated behind a second
  // tap ("Walk me through") — the founder's own complaint, against a real
  // conversation, was that this is backwards: a person reading this message
  // already should not have to know to ask for the actual instructions.
  // Every tool that carries a curated walkthrough (tools.walkthrough — a real
  // text[] column, already written per tool) now gets it inline, for free,
  // exactly as stored. Nothing here is hand-written per tool.
  //
  // A walkthrough is how to set the TOOL up, so it goes out on the first step
  // that uses that tool; a later step using the same one says so in a line.
  // Round 17: the same sheet set-up ("name it Stock or Prices") arrived under
  // a debtors list and again under every later step that used a sheet.
  //
  // The tool's name, real cost and link (rule 10: the number comes from the
  // library with its verification date, never from a model) and its set-up
  // travel as ONE message. They were two, and a step could arrive as five
  // bubbles in a row (audit, 2026-10). A long one is split, never cut (wa.ts).
  const here = plan.steps.indexOf(step);
  const earlier = tool ? plan.steps.slice(0, here).find((s) => s.tool_id === step.tool_id && s.pushed_at) : undefined;
  if (tool) {
    const toolLine = `${tool.name}\n${costLine(tool.cost, tool.verified_on, tool.free_type)}\n${tool.url}`;
    const setUp = !tool.walkthrough?.length
      ? ""
      : earlier
        ? `${tool.name} is the one you set up for "${earlier.title}" — same app, nothing new to install. Tap "Walk me through" below if you want the set-up steps again.`
        : `Setting up ${tool.name}, step by step:\n${tool.walkthrough.map((line, i) => `${i + 1}. ${line}`).join("\n")}`;
    await sendText(biz.wa_id, setUp ? `${toolLine}\n\n${setUp}` : toolLine, biz.id);
  }

  const doneWhenBody = `Done when: ${step.done_when ?? "you've done it"}`;
  if (tool?.walkthrough?.length) {
    // Four real options now that the PDF exists (Priority 4.1) — one more
    // than WhatsApp's 3-button reply cap (WA.buttons), so this uses a list
    // instead of dropping one of the three that were already there.
    await sendList(
      biz.wa_id,
      doneWhenBody,
      "Choose",
      [
        {
          title: "What next",
          rows: [
            { id: ACT.STEP_DONE, title: "Done" },
            { id: ACT.STEP_WALK, title: "Walk me through" },
            { id: ACT.STEP_PDF, title: "Get this as a PDF" },
            { id: ACT.STEP_HELP, title: "I'm stuck" },
          ],
        },
      ],
      biz.id,
    );
  } else {
    await sendButtons(
      biz.wa_id,
      doneWhenBody,
      [
        { id: ACT.STEP_DONE, title: "Done" },
        { id: ACT.STEP_HELP, title: "I'm stuck" },
      ],
      biz.id,
    );
  }

  // `repush`: this step went out before (over 90 seconds ago) and is open
  // still — a person coming back to it. `mins_since_done`: the gap since the
  // last step they finished, which is how the pace of a plan shows.
  const lastDone = plan.steps.map((s) => s.done_at ?? "").filter(Boolean).sort().at(-1);
  track("step_pushed", {
    category: "funnel",
    props: {
      position,
      total: plan.steps.length,
      step_key: step.step_key,
      tool_id: step.tool_id,
      walkthrough: !tool?.walkthrough?.length ? "none" : earlier ? "again" : "inline",
      artifact: artifact.text ? "ready" : artifact.fallback ? "blanks" : "none",
      repush: pushedAt > 0,
      mins_since_done: minsSince(lastDone),
    },
  });

  // A pushed step is a commitment. Three days is the default the nudge writer
  // then works from — that is what makes the follow-up real rather than generic.
  // One per step: a re-push must not stack them up.
  const { data: existing } = await db().from("commitments").select("id").eq("plan_step_id", step.id).eq("status", "open").limit(1);
  if (!((existing as unknown[]) ?? []).length) {
    await addCommitment(biz.id, step.title ?? "the next step", new Date(Date.now() + 3 * DAYS).toISOString().slice(0, 10), "whatsapp", step.id);
  }
}

async function planComplete(biz: Business, steps: PlanStepRow[]): Promise<void> {
  const done = steps.filter((s) => s.status === "done").length;
  const skipped = steps.filter((s) => s.status === "skipped").length;
  // Recorded each time "Next step" finds nothing open; the funnel counts people.
  track("plan_completed", { category: "funnel", props: { done, skipped, total: steps.length } });
  await updateBusiness(biz.id, { stage: "plan_ready", pending_action: null });
  await sendButtons(
    biz.wa_id,
    `That's the whole plan done — ${done} step${done === 1 ? "" : "s"} finished${skipped ? `, ${skipped} skipped` : ""}.\n\nTell me how the last 90 days actually went and what's changed, and I'll build the next plan from where you really are now.`,
    [
      { id: ACT.SEE_PLAN, title: "See what I did" },
      // Its own action. Wired to NEXT_STEP, this button re-entered
      // pushNextStep, found no open step, and printed this same message again —
      // for a person who had just finished ninety days of work.
      { id: ACT.REBUILD, title: "Build the next 90" },
    ],
    biz.id,
  );
}

/**
 * The next ninety days, built from where the business actually is now rather
 * than from where it was three months ago. The map, the customer and the angle
 * all carry over as the starting point; what changed is the thing worth asking
 * about, so we ask, and the answer feeds the same builder the first plan came
 * from.
 */
export async function startNextPlan(biz: Business, said?: string): Promise<void> {
  // Belt and braces, as pushNextStep: never a new growth plan by the back door.
  if (biz.stage === "stabilizing") return holdPlanWhileStabilising(biz, "startNextPlan");
  const plan = await planFor(biz.id);
  const done = plan?.steps.filter((s) => s.status === "done").map((s) => s.title).join("; ") ?? "";
  // `open` above zero: "Build the next 90" from an older message, with steps
  // of this plan still to do — the new plan replaces them.
  const open = plan?.steps.filter((s) => s.status === "open").length ?? 0;

  if (!said?.trim()) {
    track("next_plan_requested", { category: "funnel", props: { phase: "asked", done: plan?.steps.filter((s) => s.status === "done").length ?? 0, open } });
    await updateBusiness(biz.id, { stage: "clarify_objective", pending_action: { kind: "rebuild" } });
    await sendText(
      biz.wa_id,
      `Good. Before I build the next ninety days: what's changed since we started, and what's the one thing you want different by the end of it?\n\nTell me in your own words — that's what the whole plan gets built around.`,
      biz.id,
    );
    return;
  }

  // Their answer to "what's changed?": the next build starts from it.
  track("next_plan_requested", { category: "funnel", props: { phase: "objective", chars: said.trim().length, open } });
  const answers = {
    ...(biz.answers ?? {}),
    objective: said,
    previously_completed: done.slice(0, 1500),
  };
  await updateBusiness(biz.id, {
    answers,
    stage: "diag_done",
    pending_action: { kind: "building", since: new Date().toISOString() },
    // The last plan is finished; the next one gets its own row.
    current_plan_id: null,
  });
  const { runReadbackStep } = await import("./build.js");
  await sendText(biz.wa_id, "Right. First I'll read your money back as it is now, then we build the next ninety days from there. I'll message you the moment the read-back is ready.", biz.id);
  return runReadbackStep({ ...biz, answers, stage: "diag_done" });
}

// ── Done, and whether it worked ──────────────────────────────────

export async function markStepDone(biz: Business, stepId: string): Promise<void> {
  const plan = await planFor(biz.id);
  const step = plan?.steps.find((s) => s.id === stepId) ?? null;
  if (!step) {
    // "Done" on a step that is no longer in the plan (an older plan's
    // button, or a walkthrough left over from one): nothing is marked.
    trackUnmet("stale_tap", { severity: "info", props: { what: "done", reason: "step_gone" }, fingerprint: "stale_tap:step_gone" });
    return pushNextStep(biz);
  }

  await recordStepDone(biz, plan!.steps, step);

  // The Kenya mentor gave advice and never learned whether it worked. This is
  // the question that makes the difference, and it is asked every time.
  //
  // `walk: null` here matters more than it looks: walkNext() reaches this
  // function when a walkthrough's last line is confirmed, but never clears
  // `walk` itself (markStepDone owns the state from here). Left set, a
  // stray "next" typed during outcome_wait — or any other stale NEXT_STEP —
  // would read PRIORITY 5.3's `if (biz.walk) return walkNext(biz)` as "still
  // resuming" and call this function a second time for the same step.
  await updateBusiness(biz.id, { stage: "outcome_wait", pending_action: { kind: "outcome", step_id: step.id }, walk: null });
  await sendButtons(
    biz.wa_id,
    `Good. That's "${step.title}" done.\n\nHas it made any difference yet?`,
    [
      { id: `${ACT.OUTCOME_BETTER}:${step.id}`, title: "Yes, already" },
      { id: `${ACT.OUTCOME_EARLY}:${step.id}`, title: "Too early to say" },
      { id: `${ACT.OUTCOME_NONE}:${step.id}`, title: "No change" },
    ],
    biz.id,
  );
}

/**
 * A step marked done, as every door records it: WhatsApp's "Done" (above)
 * and the person's own AI (connector.ts complete_step). State only; nothing
 * is sent, so each door says it its own way. `via` is set only off WhatsApp,
 * so the funnel can tell the doors apart without changing WhatsApp's event.
 */
export async function recordStepDone(biz: Business, steps: PlanStepRow[], step: PlanStepRow, via?: "connector"): Promise<void> {
  const again = step.status === "done";
  await updateStep(step.id, { status: "done", done_at: new Date().toISOString() });
  // An open commitment on a finished step keeps the nudges coming about it.
  const closed = await db().from("commitments").update({ status: "done" }).eq("plan_step_id", step.id).eq("status", "open");
  if (closed?.error) console.error("markStepDone: commitment not closed", closed.error.message);
  await logDecision(biz.id, `Completed: ${step.title}`, step.why_for_you ?? null, via ?? "whatsapp");
  // `again`: a second "Done" on a step already done (the outcome is asked again).
  // `walkthrough`: they reached it from the walkthrough's last line, or mid-way.
  track("step_done", {
    category: "funnel",
    props: {
      step_key: step.step_key,
      tool_id: step.tool_id,
      done: steps.filter((s) => s.status === "done" && s.id !== step.id).length + 1,
      total: steps.length,
      mins_since_pushed: minsSince(step.pushed_at),
      walkthrough: biz.walk?.step_id === step.id,
      again,
      ...(via ? { via } : {}),
    },
  });
}

/** A map area only moves up on something the person said: a completed step plus a reported improvement. */
export async function moveMapOnBetter(biz: Business, step: PlanStepRow, effect: string): Promise<void> {
  const plausible =
    effect === "better" && step
      ? await outcomePlausible(
          { title: step.title ?? "", domain: step.domain ?? "", done_when: step.done_when ?? "", outcome: step.why_for_you ?? "" },
          { minutesSinceDone: step.done_at ? (Date.now() - new Date(step.done_at).getTime()) / 60000 : 0 },
          { businessId: biz.id },
        )
      : true;
  if (effect === "better" && plausible && step?.domain && Array.isArray(biz.map)) {
    // Read before the write: whether an area actually moves (map_area_moved below).
    const moved = biz.map.some((m) => m.domain === step.domain && m.status === "red");
    const next = biz.map.map((m) =>
      m.domain === step.domain && m.status === "red" ? { ...m, status: "amber" as const, note: `${step.title} done and working` } : m,
    );
    await updateBusiness(biz.id, { map: next });
    const saved = await db()
      .from("business_map")
      .upsert(
        next.map((m) => ({ business_id: biz.id, domain: m.domain, status: m.status, note: m.note, updated_at: new Date().toISOString() })),
        { onConflict: "business_id,domain" },
      );
    if (saved?.error) console.error("moveMapOnBetter: business_map not saved", saved.error.message);
    // The only record that an area moved: the map itself is overwritten in place.
    if (moved) track("map_area_moved", { props: { domain: step.domain, from: "red", to: "amber" } });
  }
}

export async function recordStepOutcome(biz: Business, actionId: string, buttonStepId?: string): Promise<void> {
  const pendingStepId = (biz.pending_action?.step_id as string | undefined) ?? null;
  const stepId = buttonStepId ?? pendingStepId;
  const effect = actionId === ACT.OUTCOME_BETTER ? "better" : actionId === ACT.OUTCOME_NONE ? "same" : "too_early";
  const plan = await planFor(biz.id);
  const step = plan?.steps.find((s) => s.id === stepId) ?? null;

  // Live, 2026-09-22: a "Yes, already" tap on a step that was only ever
  // SHOWN, never marked done, wrote an outcome row and moved the map area
  // red -> amber with the note "... done and working" — a claim the
  // plan_steps row contradicted in the same second. pending_action carries a
  // step_id both after a push ({kind:"step"}) and after markStepDone
  // ({kind:"outcome"}); only the second means the step was finished. So an
  // outcome counts only when BOTH say so: the conversation is waiting for an
  // outcome, and the step itself is done. A stale button, a replayed
  // webhook or a tap mid-walkthrough changes nothing.
  // A button from an earlier step, tapped later: record it against its own
  // step if that step is done and has no outcome yet, and leave whatever the
  // owner is doing now untouched.
  if (buttonStepId && !(biz.pending_action?.kind === "outcome" && pendingStepId === buttonStepId)) {
    const { data: already } = await db().from("outcomes").select("id").eq("plan_step_id", buttonStepId).limit(1);
    if (!step || step.status !== "done" || ((already as unknown[]) ?? []).length) {
      const reason = !step ? "step_gone" : ((already as unknown[]) ?? []).length ? "outcome_recorded" : "step_not_done";
      trackUnmet("stale_tap", { severity: "info", props: { what: "outcome", verdict: effect, reason }, fingerprint: `stale_tap:${reason}` });
      await sendText(biz.wa_id, step ? `I've already got how "${step.title}" went — nothing more to record.` : "That step isn't in your plan any more, so I haven't recorded anything.", biz.id);
      return;
    }
    await logOutcome(biz.id, step.title ?? "a step", effect, step.id);
    // `late`: from an earlier step's check-in, answered after moving on.
    track("outcome_reported", { props: { verdict: effect, how: "tap", late: true, step_key: step.step_key, mins_since_done: minsSince(step.done_at) } });
    await moveMapOnBetter(biz, step, effect);
    await sendText(biz.wa_id, `Noted for "${step.title}".`, biz.id);
    return;
  }

  if (biz.pending_action?.kind !== "outcome" || !step || step.status !== "done") {
    const shown = biz.pending_action?.kind === "step" && step && step.status !== "done";
    // Nothing recorded: the step is not finished, or no step is waiting for its outcome.
    trackUnmet("stale_tap", {
      severity: "info",
      props: { what: "outcome", verdict: effect, reason: shown ? "step_not_done" : "no_step_waiting" },
      fingerprint: `stale_tap:${shown ? "step_not_done" : "no_step_waiting"}`,
    });
    await sendButtons(
      biz.wa_id,
      shown
        ? `That's for after a step is finished — "${step!.title}" isn't marked done yet. Tap Done once you've done it, and then tell me how it went.`
        : "I'm not sure which step that's about, so I haven't recorded anything.",
      shown
        ? [
            { id: ACT.STEP_DONE, title: "Done" },
            { id: ACT.STEP_HELP, title: "I'm stuck" },
          ]
        : [
            { id: ACT.NEXT_STEP, title: "Next step" },
            { id: ACT.SEE_PLAN, title: "See my plan" },
          ],
      biz.id,
    );
    return;
  }

  await logOutcome(biz.id, step.title ?? "a step", effect, stepId);
  track("outcome_reported", { props: { verdict: effect, how: "tap", late: false, step_key: step.step_key, mins_since_done: minsSince(step.done_at) } });

  await moveMapOnBetter(biz, step, effect);

  const line =
    effect === "better"
      ? "That's the point of it. Noted."
      : effect === "same"
        ? "Noted. If it's still flat in a couple of weeks, tell me and we'll change the approach rather than doing more of it."
        : "Fair. Most of these take a week or two to show.";

  await updateBusiness(biz.id, { stage: "plan_ready", pending_action: null });
  await sendButtons(biz.wa_id, `${line}\n\nReady for the next one?`, [
    { id: ACT.NEXT_STEP, title: "Next step" },
    { id: ACT.SEE_PLAN, title: "See my plan" },
  ], biz.id);
}

/** A step skipped, as every door records it (skipStep below; connector.ts skip_step). State only. */
export async function recordStepSkipped(stepId: string, reason?: string, via?: "connector"): Promise<void> {
  await updateStep(stepId, { status: "skipped", skipped_reason: reason ?? "person skipped" });
  const dropped = await db().from("commitments").update({ status: "dropped" }).eq("plan_step_id", stepId).eq("status", "open");
  if (dropped?.error) console.error("skipStep: commitment not dropped", dropped.error.message);
  // No plan read here, so the step goes by its row id (plan_steps.step_key
  // is one join away); its reason is free text and stays out.
  track("step_skipped", { props: { step_id: stepId, with_reason: Boolean(reason), ...(via ? { via } : {}) } });
}

export async function skipStep(biz: Business, stepId: string, reason?: string): Promise<void> {
  await recordStepSkipped(stepId, reason);
  await updateBusiness(biz.id, { stage: "plan_ready", pending_action: null });
  await sendButtons(biz.wa_id, "Skipped. I'll bring it back later if it still matters.", [{ id: ACT.NEXT_STEP, title: "Next step" }], biz.id);
}

// ── Priority 4.1: one step, as its own standalone PDF ─────────────

/**
 * Same render path as the full plan document (pdfclient.ts's
 * renderAndSendPlanPdf, which already carries the honest "the PDF didn't
 * come out just then" degradation message from Priority 1) — this only
 * builds the HTML. Only offered on a step whose tool has a walkthrough
 * (see the "Get this as a PDF" list row in pushNextStep), so a missing tool
 * or walkthrough here means the button itself was tapped from a stale
 * message rather than a real gap in this step.
 */
export async function sendStepPdf(biz: Business, stepId?: string | null): Promise<void> {
  const plan = await planFor(biz.id);
  const step = plan?.steps.find((s) => s.id === stepId) ?? (plan ? firstOpenStep(plan.steps) : null);
  if (!step) {
    trackUnmet("step_unavailable", { severity: "info", props: { what: "pdf", reason: plan ? "no_step" : "no_plan" } });
    await sendText(biz.wa_id, "I don't have a step to put in a PDF right now — ask me for the next step first.", biz.id);
    return;
  }
  const tool = step.tool_id ? await toolById(step.tool_id, biz.country) : null;
  if (!tool?.walkthrough?.length) {
    trackUnmet("step_unavailable", {
      severity: "info",
      props: { what: "pdf", reason: step.tool_id && !tool ? "tool_missing" : "no_walkthrough", step_key: step.step_key, tool_id: step.tool_id },
    });
    await sendText(biz.wa_id, "This step doesn't have a walkthrough to put in a PDF — tell me where you're stuck instead and I'll help directly.", biz.id);
    return;
  }

  // Same guard as every other artifact send (Priority 5.1) — a document meant
  // to be the final, standalone reference cannot ship with brackets in it
  // any more than a WhatsApp message can.
  const artifact = checkArtifact(step.artifact, biz);
  const html = stepDocHTML({
    productName: PRODUCT_NAME,
    businessName: biz.context?.name || biz.identity?.name || "Your money",
    stepTitle: step.title ?? "",
    whyForYou: step.why_for_you ?? "",
    toolName: tool.name,
    toolUrl: tool.url,
    costLine: costLine(tool.cost, tool.verified_on, tool.free_type),
    walkthrough: tool.walkthrough,
    artifact: artifact.text ?? (artifact.draft ? blanks(artifact.draft) : null),
    artifactNote: artifact.draft ? "Fill in the blanks before you send it." : null,
    doneWhen: step.done_when ?? "",
  });

  const filename = `${(step.title ?? "step").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "step"}.pdf`;
  const started = Date.now();
  const sent = await renderAndSendPlanPdf(html, biz.wa_id, filename, `${step.title ?? "This step"} — the full instructions`, biz.id, null, "step");
  // A PDF that did not arrive is pdf_failed, recorded once in pdfclient.ts at its cause.
  if (sent) track("step_pdf_sent", { ms: since(started), props: { step_key: step.step_key, tool_id: step.tool_id } });
}

// ── Walkthroughs ─────────────────────────────────────────────────

/**
 * Every tool row carries a full step-by-step walkthrough; none are link-only.
 * These are pre-written, so a walkthrough costs nothing to send — no model call
 * at all. That is why "take them to the door" is affordable on every step.
 */
export async function startWalk(biz: Business, toolId: string, stepId?: string): Promise<void> {
  const tool = await toolById(toolId, biz.country);
  if (!tool?.walkthrough?.length) {
    trackUnmet("step_unavailable", { severity: "info", props: { what: "walkthrough", reason: tool ? "no_walkthrough" : "tool_missing", tool_id: toolId } });
    await sendText(biz.wa_id, "I don't have a walkthrough for that one. Tell me where you're stuck and I'll help directly.", biz.id);
    return;
  }
  // `restarted`: this walkthrough was already under way (read before the write replaces it).
  const restarted = biz.walk?.tool_id === toolId;
  await updateBusiness(biz.id, { stage: "walking", walk: { tool_id: toolId, index: 0, step_id: stepId } });
  track("walkthrough_started", { props: { tool_id: toolId, lines: tool.walkthrough.length, restarted } });
  await sendWalkLine(biz, tool.name, tool.walkthrough, 0);
}

async function sendWalkLine(biz: Business, toolName: string, lines: string[], index: number): Promise<void> {
  const line = lines[index];
  if (!line) return;
  const last = index === lines.length - 1;
  await sendButtons(
    biz.wa_id,
    `${toolName} — ${index + 1} of ${lines.length}\n\n${line}`,
    last
      ? [
          { id: ACT.STEP_DONE, title: "All done" },
          { id: ACT.WALK_STUCK, title: "I'm stuck" },
        ]
      : [
          { id: ACT.WALK_NEXT, title: "Next" },
          { id: ACT.WALK_STUCK, title: "I'm stuck" },
          { id: ACT.WALK_LATER, title: "Later" },
        ],
    biz.id,
  );
}

export async function walkNext(biz: Business): Promise<void> {
  const walk = biz.walk;
  if (!walk) return pushNextStep(biz);

  const tool = await toolById(walk.tool_id, biz.country);
  const lines = tool?.walkthrough ?? [];

  // An empty list is NOT the end of the walkthrough — it is a tool row we could
  // not read. Treating the two the same marked the step done and asked the
  // owner whether it had made a difference yet, about something they had not
  // finished doing.
  if (!lines.length) {
    console.log(`walkNext: no walkthrough for tool "${walk.tool_id}" in ${biz.country}`);
    // The person is told "that's my fault": a walkthrough in progress lost.
    trackFailure("tool_not_found", `no walkthrough for tool ${walk.tool_id} in ${biz.country}`, {
      props: { where: "walkthrough", tool_id: walk.tool_id, tool_found: Boolean(tool), line: walk.index + 1 },
      fingerprint: `tool_not_found:walkthrough:${walk.tool_id}`,
      summary: `A person mid-walkthrough was told "I've lost my place": tool "${walk.tool_id}" has no walkthrough in ${biz.country}`,
    });
    await updateBusiness(biz.id, { stage: "step_pushed", walk: null, pending_action: walk.step_id ? { kind: "step", step_id: walk.step_id } : null });
    await sendButtons(
      biz.wa_id,
      "I've lost my place in that walkthrough — that's my fault, not yours. Tell me where you got to and I'll take it from there.",
      [
        { id: ACT.STEP_DONE, title: "It's done" },
        { id: ACT.STEP_HELP, title: "I'm stuck" },
      ],
      biz.id,
    );
    return;
  }

  const next = walk.index + 1;
  if (next >= lines.length) {
    const stepId = walk.step_id;
    // Past the last line: the step is marked done (step_done follows) when the walkthrough came from one.
    track("walkthrough_finished", { props: { tool_id: walk.tool_id, lines: lines.length, marks_done: Boolean(stepId) } });
    if (stepId) return markStepDone(biz, stepId);
    await updateBusiness(biz.id, { stage: "plan_ready", walk: null });
    return;
  }
  // Re-asserted on every advance, not just at startWalk: walkLater() below
  // deliberately leaves `walk` in place across a "Later" pause, and this is
  // what re-syncs `stage` back to "walking" once the person actually resumes,
  // rather than leaving it on whatever walkLater() set it to.
  // `resumed`: the first line after a "Later" (the stage had moved off walking),
  // read before the write below sets it back.
  const resumed = biz.stage !== "walking";
  await updateBusiness(biz.id, { walk: { ...walk, index: next }, stage: "walking" });
  // One per line reached: where people stop is where a walkthrough loses them.
  track("walkthrough_line", { props: { tool_id: walk.tool_id, line: next + 1, of: lines.length, resumed } });
  await sendWalkLine(biz, tool?.name ?? walk.tool_id, lines, next);
}

export async function walkLater(biz: Business): Promise<void> {
  // PRIORITY 5.2, reproduced twice live: WhatsApp buttons stay tappable
  // forever, so the walkthrough's own "Next" button — the one on the message
  // sent just before this "Later" tap — is still sitting in the chat
  // afterwards. Clearing `walk` here (the old behaviour) meant that exact
  // stale tap fell through walkNext()'s `if (!walk) return pushNextStep(biz)`
  // and fired a full re-send of the MAIN plan step instead of resuming the
  // walkthrough — the action-id collision the bug report pointed at. Leaving
  // `walk` in place (only the STAGE changes, so ordinary messages route
  // normally while paused) means that same stale tap now correctly resumes
  // from the next line, which is also plainly the right reading of tapping
  // "Next" after "Later": the person wants to carry on, not start over.
  // pushNextStep already clears `walk: null` the moment it genuinely pushes a
  // new step, so nothing here can leak into an unrelated later step.
  track("walkthrough_paused", { props: { tool_id: biz.walk?.tool_id ?? null, line: biz.walk ? biz.walk.index + 1 : null } });
  await updateBusiness(biz.id, { stage: "plan_ready", pending_action: null });
  await sendButtons(biz.wa_id, "No problem — it'll be here when you are.", [{ id: ACT.NEXT_STEP, title: "Next step" }], biz.id);
}

// ── Stuck ────────────────────────────────────────────────────────

/**
 * "I'm stuck" / "help" / "stuck" and nothing more. Deliberately as narrow as
 * actions.ts's own typedShortcut for the same words: anything that says
 * something concrete beyond "I don't know what to do" must always reach the
 * model below, because that is a real, possibly novel question, and a
 * scripted resend would be actively unhelpful for it.
 */
const GENERIC_STUCK_RE = /^\s*(i'?m\s*stuck|help(\s*me)?|stuck|i'?m\s*lost|i\s*don'?t\s*(know|understand)(\s*what\s*to\s*do)?|what\s*(do|now)\??)[.!?]*\s*$/i;

function isGenericStuck(said: string): boolean {
  return GENERIC_STUCK_RE.test((said || "").trim());
}

export async function helpWithStep(biz: Business, said: string): Promise<void> {
  // Same guard as pushNextStep: help writes stage 'step_pushed' below.
  if (biz.stage === "stabilizing") return holdPlanWhileStabilising(biz, "helpWithStep");
  const plan = await planFor(biz.id);
  const stepId = (biz.pending_action?.step_id as string | undefined) ?? biz.walk?.step_id;
  const step = plan?.steps.find((s) => s.id === stepId) ?? (plan ? firstOpenStep(plan.steps) : null);
  if (!step) {
    trackUnmet("step_unavailable", { severity: "info", props: { what: "help", reason: plan ? "no_step" : "no_plan" } });
    await sendText(biz.wa_id, "Tell me what you're stuck on and I'll help.", biz.id);
    return;
  }

  // Router principle, applied to the highest-volume model call in the
  // product: check for a known, deterministic answer before calling a model
  // at all. A person mid-walkthrough who taps or types nothing more than
  // "I'm stuck" is, overwhelmingly, asking to see the instruction they were
  // just sent again, not asking something new. That instruction is fixed,
  // pre-written, already-verified content (tools.walkthrough — see
  // startWalk's own comment above); it was proven correct the moment it was
  // sent, so resending it costs nothing and needs no model call, no
  // retrieval, and no reply_compliance check (there is nothing to check —
  // it's the same stored string, unchanged).
  //
  // `biz.walk` is updated synchronously on every sendWalkLine call, so
  // "biz.walk.step_id === step.id" IS "this exact line was shown moments
  // ago" — there is no separate timestamp to check. Both conditions must
  // hold: the person is still on that walkthrough line for THIS step, still
  // open (guards against a stale walk left over once a step is done — walk
  // is not cleared by markStepDone, see walkNext), and their message is
  // generic. Anything more specific always falls through to the model below.
  if (biz.walk && biz.walk.step_id === step.id && step.status === "open" && isGenericStuck(said)) {
    const tool = await toolById(biz.walk.tool_id, biz.country);
    const line = tool?.walkthrough?.[biz.walk.index];
    if (tool && line) {
      track("step_stuck", { props: { step_key: step.step_key, tool_id: tool.id, answered: "line_again", line: biz.walk.index + 1 } });
      await sendText(biz.wa_id, "No problem — here's that step again.", biz.id);
      await sendWalkLine(biz, tool.name, tool.walkthrough!, biz.walk.index);
      return;
    }
    // No line to resend (a stale/out-of-range walk row) — fall through
    // rather than send nothing.
  }

  const walkContext = biz.walk
    ? await (async () => {
        const t = await toolById(biz.walk!.tool_id, biz.country);
        const line = t?.walkthrough?.[biz.walk!.index];
        return line ? `\nThey are partway through setting up ${t?.name}, on this instruction: "${line}"` : "";
      })()
    : "";

  // Remember which step we are helping with. The reply carries "Done now" and
  // "Skip this one", and both read pending_action — so without this they were
  // buttons that did nothing but re-send the step.
  await updateBusiness(biz.id, { stage: "step_pushed", pending_action: { kind: "step", step_id: step.id } });

  // One step_stuck per "I'm stuck", however it was answered; `ms` is the wait for a written answer.
  const started = Date.now();
  const stuckFacts = { step_key: step.step_key, tool_id: step.tool_id, in_walkthrough: Boolean(walkContext), generic: isGenericStuck(said) };
  const cb = await buildCore(biz, {
    query: `${step.title} ${step.push} ${said}`.trim(),
    domain: step.domain,
    maxKnowledge: 4,
    maxTools: 4,
  });

  try {
    const raw = await askJSON(
      "help",
      helpPrompt(
        cb.text + walkContext,
        { title: step.title ?? "", push: step.push ?? "", done_when: step.done_when ?? "", tool_id: step.tool_id },
        said,
      ),
      // 900 -> 1800: same audit as qa.ts's wa_reply calls and build.ts's
      // plan_builder calls (2026-09-20 incident) — "help" also got reasoning
      // ("low" effort, db/0009) and this call site was never checked when
      // that migration landed. reasoning off, per-call: this is a live
      // conversational reply, exactly the kind of exchange the founder said
      // must be fast — "the only thing that must take time must be the plan
      // builder."
      { maxTokens: 1800, label: "help", reasoning: { enabled: false } },
    );
    const reply = tidy(raw);
    // The same floor as an answer (qa.ts): no "₦[amount]" in the message.
    const slots = scrubMoneySlots(reply.message);
    if (slots.count) reply.message = slots.text;
    // Priority 2b, 2026-09-22: this exact call site ("help", reasoning off
    // for speed) is where a real reply wrote "Woodwood" for the business's
    // own "Woodstock" while paraphrasing quickly — reply_compliance ran and
    // passed it, because it's a compliance check, not a spell-checker.
    const checked = await checkReply(reply.message, [cb.toolsSheet, cb.knowledgeCosts].filter(Boolean).join("\n"), contextSummary(biz), {
      businessId: biz.id,
      knownFacts: businessKnownFacts(biz),
      ownerMessage: said,
      ...(biz.answers ? { answers: biz.answers } : {}),
    });
    // PRIORITY 4.5: checkReply's own price check only covers a bare number
    // against the whole conversation's candidate-tools sheet — it says
    // nothing about a button/link name or a timeframe, and nothing is scoped
    // to the ONE tool this step is actually about. This is that narrower,
    // tool-specific pass, run on every "help"/"stuck" reply — which, via
    // index.ts's ACT.STEP_HELP / ACT.WALK_STUCK dispatch, is both the "I'm
    // stuck" handler and the walkthrough's own stuck handler, the same code
    // path. It runs on checkReply's output, so the name-fidelity fix above is
    // already applied to the text it checks.
    const tool = step.tool_id ? await toolById(step.tool_id, biz.country) : null;
    const grounded = await checkToolHelpGrounding(checked.message, tool, { businessId: biz.id });
    // No phone number or address this call was not given (contacts.ts).
    const guarded = await guardReplyContacts(
      { ...reply, message: grounded.message },
      [cb.text, walkContext, tool ? [tool.url, ...(tool.walkthrough ?? [])].join("\n") : "", country(biz.country).advisor, said].join("\n"),
      { businessId: biz.id, call: "help" },
    );
    // A date, a law or a waiting time from nowhere comes out (datecheck.ts),
    // the same as in an answer.
    const days = checkDaysOf(cb.priced);
    const dated = dropUngroundedDates(
      stripCopiedStamps(guarded.message, days),
      dateSources(cb, biz, [walkContext, tool ? [tool.cost, ...(tool.walkthrough ?? [])].join("\n") : "", `${step.title ?? ""} ${step.push ?? ""} ${step.done_when ?? ""}`, said]),
      days,
    );
    if (dated.dropped.length) {
      guarded.message = dated.message;
      await recordSafetyEvent({ businessId: biz.id, check: "date_grounding", engine: "none", outcome: "flag", flags: ["ungrounded_date"], detail: `help: took out ${dated.dropped.map((d) => `"${d}"`).join(", ")}`.slice(0, 500) });
    }
    // Every library figure says when it was checked (rule 10, pricestamp.ts).
    const own = ownFigures(biz, said);
    const stamp = stampLibraryFigures(guarded.message, cb.priced, own.money, { notLibraryRates: own.rates, toolId: step.tool_id ?? null });
    const safe = stamp.message === guarded.message ? guarded : { ...guarded, message: stamp.message };
    await sendReply(biz, safe, [
      { id: ACT.STEP_DONE, title: "Done now" },
      { id: ACT.STEP_SKIP, title: "Skip this one" },
    ]);
    track("step_stuck", { ms: since(started), props: { ...stuckFacts, answered: "model" } });
  } catch (err) {
    // A fenced-off attempt (jobctx.ts) must not write fallback state over the live one.
    if (err instanceof JobFencedError) throw err;
    await fenceCheck();
    console.log("helpWithStep failed", err);
    track("step_stuck", { ms: since(started), props: { ...stuckFacts, answered: "failed" } });
    trackFailure("step_help_failed", err, {
      ms: since(started),
      props: { step_key: step.step_key, tool_id: step.tool_id },
      summary: `A person stuck on a step got "That didn't come through" instead of help: ${errorText(err).slice(0, 140)}`,
    });
    await sendText(biz.wa_id, "That didn't come through. Tell me again what's blocking you on this step.", biz.id);
  }
}

// ── Looking at the plan, and changing it ─────────────────────────

/**
 * PRIORITY 3, the founder's own words: "very ugly... just has the title, no
 * bold or anything... shows brackets, open and close brackets." WhatsApp
 * DOES render `*bold*` (used elsewhere in this codebase's own test fixtures)
 * — it just was not being used for workstream headers here, and the literal
 * ASCII `[ ]`/`[x]` is not a checkbox to WhatsApp, just clutter.
 *
 * This is the WhatsApp-facing rendering only. context.ts's planSummary()
 * stays exactly as it is — a model reading `[ ]`/`[x]` needs no styling at
 * all, and that block also feeds the core prompt, not just this message.
 */
function planSummaryForWa(steps: PlanStepRow[]): string {
  if (!steps.length) return "";
  const byPart = new Map<string, PlanStepRow[]>();
  for (const s of steps) {
    const k = s.workstream_title ?? "Plan";
    if (!byPart.has(k)) byPart.set(k, []);
    byPart.get(k)!.push(s);
  }
  return [...byPart.entries()]
    .map(([title, rows]) => {
      const lines = rows.map((r) => `${r.status === "done" ? "✅" : r.status === "skipped" ? "➖" : "•"} ${r.title}`).join("\n");
      return `*${title}*\n${lines}`;
    })
    .join("\n\n");
}

export async function showPlan(biz: Business): Promise<void> {
  const plan = await planFor(biz.id);
  if (!plan) return pushNextStep(biz);
  const done = plan.steps.filter((s) => s.status === "done").length;
  const goal = plan.plan.goal ? `*${plan.plan.goal}*` : "";
  const body = `${goal}\n\n${planSummaryForWa(plan.steps)}\n\n${done} of ${plan.steps.length} done.`.trim();
  // The same event as the website's plan viewer; the channel tells them apart.
  track("plan_viewed", { props: { what: "summary", done, total: plan.steps.length, paused: biz.stage === "stabilizing" } });
  // While stabilising the plan can be looked at, not moved (rule 9): no
  // Next step, no Change my plan — both would only be held.
  if (biz.stage === "stabilizing") {
    await sendText(biz.wa_id, `${body}\n\n(Paused while things are this tight — tell me when it steadies and we'll pick it up.)`, biz.id);
    return;
  }
  await sendButtons(
    biz.wa_id,
    body,
    [
      { id: ACT.NEXT_STEP, title: "Next step" },
      { id: ACT.CHANGE, title: "Change my plan" },
    ],
    biz.id,
  );
}

export async function whyThisOrder(biz: Business): Promise<void> {
  const plan = await planFor(biz.id);
  const first = plan?.steps[0];
  const problem = biz.signals?.problem_in_their_words;
  const phrase = problem ? problemPhrase(problem, biz.answers ?? {}) : null;
  const body =
    `Why your 90-day plan goes in this order: it follows what you told me. ${first?.workstream_title ? `"${first.workstream_title}" comes first ` : "The first part comes first "}` +
    `because ${phrase ?? "it's what stands between you and what you said you want"}.` +
    `\n\nEach part feeds the next one, so doing them out of order means doing some of them twice.`;
  track("plan_viewed", { props: { what: "why_order", has_plan: Boolean(plan), quoted_problem: Boolean(phrase), paused: biz.stage === "stabilizing" } });
  // No "Start step 1" while stabilising (rule 9): it would only be held.
  if (biz.stage === "stabilizing") {
    await sendText(biz.wa_id, body, biz.id);
    return;
  }
  await sendButtons(biz.wa_id, body, [{ id: ACT.NEXT_STEP, title: "Start step 1" }], biz.id);
}

export async function askWhatToChange(biz: Business): Promise<void> {
  if (biz.stage === "stabilizing") return holdPlanWhileStabilising(biz, "askWhatToChange");
  // The step in front of them when they tapped "Change my plan" — pushed or
  // being walked — rides along, so "drop this step" can mean exactly that
  // (stepClearlyMeant). Under its own key: pending_action.step_id is what
  // the Done / Skip / Walk handlers read, and the change flow is not a step.
  const onStep = biz.walk?.step_id ?? (biz.pending_action?.kind === "step" ? (biz.pending_action.step_id as string | undefined) : undefined);
  await updateBusiness(biz.id, { stage: "changing", pending_action: { kind: "change", ...(onStep ? { on_step: onStep } : {}) } });
  // "Change my plan", tapped or typed with nothing named yet: what they want follows in their next message.
  track("plan_change_requested", { props: { phase: "opened", on_step: Boolean(onStep) } });
  await sendButtons(
    biz.wa_id,
    "What in your 90-day plan doesn't fit? Tell me in your own words. I can swap the tool on a step, drop a step that genuinely doesn't apply to you, or move a part earlier. If it's just uncomfortable rather than wrong, I'll say so.",
    [{ id: ACT.NEVER_MIND, title: "Never mind" }],
    biz.id,
  );
}

/** A model's own words, when they claim the plan changed. Used only when nothing was written. */
// Only a claim that something WAS (or is being) changed — past tense or a
// first-person promise. Bare verbs are fine: "there isn't another tool I
// can swap in" is an honest "none" (review of 3aad635).
const CLAIMS_CHANGE = /\b(swapped|switched|replaced|dropped|removed|taken (it |that )?out|moved (it|that|the)|now uses|i'?ve (changed|updated|swapped|switched|replaced|dropped|removed|moved)|we'?ve (changed|updated|swapped|switched|replaced|dropped|removed|moved)|i have (changed|updated|swapped|switched|replaced|dropped|removed|moved)|(we|i)'?ll (swap|switch|replace|drop|remove|move|change)|(we|i) will (swap|switch|replace|drop|remove|move|change))\b/i;

export async function applyChange(biz: Business, said: string): Promise<void> {
  const plan = await planFor(biz.id);
  if (!plan) {
    // A change asked for with no plan to change: they are shown where they are instead.
    trackUnmet("plan_change_refused", { props: { reason: "no_plan" } });
    return showPlan(biz);
  }

  // Every step's line carries the tools it is ALLOWED to switch to — the
  // library's own choices for that step, in this country. The live incident
  // (a swap to an invented "local directory listing") happened because the
  // model was told to pick an allowed tool and never shown any.
  const countryTools = await toolsFor(biz.country);
  // A step with no step_key (a plan built before step keys existed) falls
  // back to this country's tools in the step's own area.
  const allowedFor = (s: PlanStepRow) =>
    (s.step_key ? libraryToolChoices(s.step_key) : countryTools.filter((t) => t.domain && t.domain === s.domain).map((t) => t.id)).filter((id) =>
      countryTools.some((t) => t.id === id),
    );
  const line = (s: PlanStepRow) => `${s.id} | ${s.workstream_title} | ${s.title} | tool: ${s.tool_id ?? "none"} | allowed tools: ${allowedFor(s).join(", ") || "none"}`;

  // Live test, 2026-09-25: after "Change my plan", the person typed "drop that
  // one". Those words name no step. The model guessed one — "Decide whether
  // to register", which nobody had mentioned — and it was dropped and
  // confirmed while the step they meant stayed put; nothing was asked and
  // nothing was stored. So the step a change lands on is settled HERE, from
  // the person's own words (stepClearlyMeant), before the model is asked
  // anything, and the model's pick is never a substitute for that. When
  // their words do not settle it, the flow asks which step — the open ones,
  // numbered — and holds the request (pending_action.awaiting = "step") for
  // the answer: a number, a title, or words the model reads against ONLY the
  // steps that were offered. The model classifies what they want; it does
  // not choose the step.
  const pending = biz.pending_action?.kind === "change" ? biz.pending_action : null;
  const askedBefore = pending ? String(pending.asked ?? "") : "";
  const listed =
    pending?.awaiting === "step" && Array.isArray(pending.options)
      ? (pending.options as unknown[]).map((id) => plan.steps.find((s) => s.id === id)).filter((s): s is PlanStepRow => Boolean(s))
      : [];
  // After "Which part should come first?" — the parts that were offered, in that order.
  const partsListed =
    pending?.awaiting === "part" && Array.isArray(pending.options)
      ? (pending.options as unknown[]).map(String).filter((t) => plan.steps.some((s) => s.workstream_title === t))
      : [];
  const onStep = pending?.on_step ? (plan.steps.find((s) => s.id === pending.on_step) ?? null) : null;
  const meant = partsListed.length ? null : stepClearlyMeant({ said, askedBefore, steps: plan.steps, listed, onStep, tools: countryTools });
  // A part named NOW beats one named in the message before (review r10-B #1).
  const partMeant = partsListed.length
    ? (partClearlyMeant(said, partsListed) ?? "")
    : (partNamedIn(said, plan.steps) ?? (askedBefore ? partNamedIn(askedBefore, plan.steps) : null) ?? meant?.workstream_title ?? "");
  // What they asked for, classified when they asked it — when this message
  // answers "which step?" or "which part?".
  const intent = listed.length || partsListed.length ? String(pending?.intent ?? "") : "";
  // Asked something once already: never hold a person in this flow for a
  // second question.
  const retried = Number(pending?.count ?? 0) >= 1;
  // On every change event: what this message was answering, and whether it is the last try.
  const answering = listed.length ? "step" : partsListed.length ? "part" : null;

  try {
    let action: string;
    let step: PlanStepRow | undefined = meant ?? undefined;
    let wanted = "";
    let reason = "";
    let title = partMeant;
    let modelSaid = "";
    // For the record: the model's step pick overruled by the person's words,
    // and a drop_step turned back into a swap.
    let modelOverruled = false;
    let dropOverruled = false;

    if ((meant && (intent === "drop_step" || intent === "move_part")) || (partsListed.length && partMeant && intent === "move_part")) {
      // Their answer settled the step, and the request itself was classified
      // when they made it. Nothing is left for a model to decide.
      action = intent;
      reason = String(pending?.reason ?? "") || askedBefore;
    } else {
      // 800 -> 2400: this is plan_builder with "medium" reasoning (db/0009) —
      // the same role and the same reasoning effort as the build.ts call sites
      // that failed empty in production, at 1600-2400. 800 is smaller than any
      // of those were, and this call site was missed entirely because it lives
      // in steps.ts, not build.ts, when that incident was first audited.
      // reasoning off: this is a classification (which action did they mean?),
      // not the generative strategy/workstream writing — and it is live-reply
      // latency, not the one-time build.
      const offered = listed.length > 0 && !meant;
      const r = await askJSON(
        "plan_builder",
        changePrompt({
          countryCode: biz.country,
          ctx: biz.context,
          // After "which step?", the model reads the answer against the steps
          // that were offered, and no others.
          planSummary: (offered ? listed : plan.steps).map(line).join("\n"),
          said,
          askedBefore,
          offered,
          stepTitle: meant?.title ?? null,
        }),
        { maxTokens: 2400, label: "change", reasoning: { enabled: false } },
      );
      action = String(r.action ?? "none");
      const picked = typeof r.step_id === "string" ? plan.steps.find((s) => s.id === r.step_id) : undefined;
      reason = String(r.reason ?? "");
      wanted = typeof r.tool_id === "string" ? r.tool_id : "";
      modelSaid = String(r.message ?? "").trim();
      // move_part: the model's workstream_title counts only when it is, exactly,
      // one of this plan's real part titles — after "which part?", one of the
      // parts that were offered (rule 1: picked from the plan, never freestyled).
      if (action === "move_part" && !title && typeof r.workstream_title === "string") {
        const parts = partsListed.length ? partsListed : [...new Set(plan.steps.map((s) => s.workstream_title))];
        if (parts.includes(r.workstream_title)) title = r.workstream_title;
      }

      if (meant) {
        // Live, 2026-09-24: "For 'Show up when people search nearby' can you
        // swap the tool…" changed the tool on a DIFFERENT step ("Post where
        // your customers actually look"), and confirmed it — the model picked
        // the step, and nothing checked it against what the person actually
        // typed. Their words decide. The model's tool was chosen for the other
        // step; for this one, take the library's own next allowed choice
        // (rule 1: never a freestyled tool).
        if (picked && picked.id !== meant.id) {
          console.log(`change: owner meant "${meant.title}"; model picked "${picked.title}" — using the person's step`);
          modelOverruled = true;
          if (action === "swap_tool" && !allowedFor(meant).includes(wanted)) wanted = allowedFor(meant).find((id) => id !== meant.tool_id) ?? "";
        }
      } else if (offered && picked && listed.some((s) => s.id === picked.id)) {
        // The one place the model's pick is used: as its reading of an answer
        // to "which step?", and only from the list that was sent.
        step = picked;
      }
      // After "which step?", the request is the one they made; only the step
      // was open. "none" stays: the model's honest "no listed tool fits".
      if (intent && action !== "none") action = intent;
      // Live, round 13: "drop that one" typed at a finished plan came back as
      // action "none" with the model's own prose question ("the one about
      // posting where customers look, the one about collecting money owed, or
      // another?"). No numbers, no hold — so the "2" that followed was
      // answered as a new question and nothing was dropped. When the person's
      // own words plainly ask for a change and no step is settled, what they
      // asked for is read from those words, and the flow asks with the
      // numbered list below, never with the model's prose.
      // A removal asked in plain words always gets the list. A swap or a move
      // only when the model's own reply is itself a question back (it could
      // not tell which): its honest "no other tool fits" stays as it is.
      if (action === "none" && !step && !offered) {
        const fromWords = changeIntentFromWords(`${askedBefore} ${said}`);
        if (fromWords === "drop_step" || (fromWords && /\?\s*$/.test(modelSaid))) action = fromWords;
      }
    }
    if (action === "move_part" && !title && !partsListed.length) title = step?.workstream_title ?? "";

    // Live, round 6: "swap the tool on 'Show up when people search nearby'"
    // — a step whose only allowed tool is Google Business Profile — came
    // back as drop_step, and the whole step was removed and confirmed. A
    // step comes out only when the person's own words ask for that; a swap
    // with nowhere to go is the honest decline, never a deletion.
    // Across a follow-up ("drop that one" → "which?" → "the google listing
    // one"), the removal was asked in the first message: read both.
    if (action === "drop_step" && !ASKS_TO_REMOVE.test(`${askedBefore} ${said}`)) {
      console.log(`change: drop_step refused — the person asked "${said.slice(0, 80)}", not to remove a step`);
      action = "swap_tool";
      wanted = "";
      dropOverruled = true;
    }

    // The step — for a move, the part — has to come from the person's own
    // words. When it does not, ask which, once, and hold the request. The
    // list is the open steps in plan order; the reply's number is read
    // against exactly this list (pending_action.options), not recounted.
    const unsettled = action === "swap_tool" || action === "drop_step" ? !step : action === "move_part" ? !title : false;
    const open = plan.steps.filter((s) => s.status === "open").slice(0, WA.listRows);
    // A part move asks which PART, from the parts that still have open steps —
    // never a step list for a part move (review r10-B #4).
    const openParts = [...new Set(plan.steps.filter((s) => s.status === "open").map((s) => s.workstream_title).filter((t): t is string => Boolean(t)))].slice(0, WA.listRows);
    if (unsettled && action === "move_part" && openParts.length && !retried) {
      await updateBusiness(biz.id, {
        stage: "changing",
        pending_action: {
          kind: "change",
          count: 1,
          asked: `${askedBefore} ${said}`.trim().slice(0, 300),
          awaiting: "part",
          options: openParts,
          intent: action,
          reason,
          ...(onStep ? { on_step: onStep.id } : {}),
        },
      });
      // Held, not refused: their words named no part, so they are asked which.
      track("plan_change_requested", { props: { phase: "which_part", action, options: openParts.length, answering } });
      await sendText(biz.wa_id, whichPartText(openParts), biz.id);
      return;
    }
    if (unsettled && action !== "move_part" && open.length && !retried) {
      await updateBusiness(biz.id, {
        stage: "changing",
        pending_action: {
          kind: "change",
          count: 1,
          asked: `${askedBefore} ${said}`.trim().slice(0, 300),
          awaiting: "step",
          options: open.map((s) => s.id),
          intent: action,
          reason,
          ...(onStep ? { on_step: onStep.id } : {}),
        },
      });
      track("plan_change_requested", { props: { phase: "which_step", action, options: open.length, model_overruled: modelOverruled, drop_overruled: dropOverruled, answering } });
      await sendText(biz.wa_id, whichStepText(open), biz.id);
      return;
    }

    // Live, 2026-09-22: asked to swap Google Business Profile for "something
    // else", the model answered action "swap_tool" with a tool that does not
    // exist ("a local directory listing"), so nothing was written — and the
    // owner was told "We'll swap that step for using a local directory
    // listing instead" anyway, because the model's own message was sent
    // whether or not the change happened. The action and the words come from
    // the same model call; only the database knows which one is true. So:
    // every confirmation is worded from what was actually written, and the
    // model's own words are used only when no change was asked for — and
    // even then never when they claim one.
    let message: string;
    let wrote = false;
    let askedBack = false;
    // Why nothing was written, when nothing was (plan_change_refused).
    let refusal = "";
    const changeFacts = { action, settled_by: meant ? "owner_words" : step ? "list_read" : null, model_overruled: modelOverruled, drop_overruled: dropOverruled, answering, retried };

    if (action === "swap_tool") {
      const allowed = step ? allowedFor(step) : [];
      const tool = step && allowed.includes(wanted) ? await toolById(wanted, biz.country) : null;
      if (step && tool && tool.id !== step.tool_id) {
        const fromTool = step.tool_id;
        await updateStep(step.id, { tool_id: tool.id });
        await logDecision(biz.id, `Swapped the tool on "${step.title}" to ${tool.name}`, reason);
        track("plan_change_applied", { props: { ...changeFacts, source: "owner", step_key: step.step_key, from_tool: fromTool, to_tool: tool.id } });
        message = `Done — "${step.title}" now uses ${tool.name} instead.`;
        wrote = true;
      } else if (step && tool) {
        message = `"${step.title}" already uses ${tool.name}, so I've left it as it is.`;
        refusal = "already_uses";
      } else if (step) {
        message = `I couldn't find a good alternative to that tool for "${step.title}" in what I know, so I've left it as it is. Tell me more about what you'd prefer and I'll look again.`;
        askedBack = true;
        refusal = "no_alternative_tool";
      } else {
        message = "I couldn't tell which step you meant, so I haven't changed anything. Which step is it?";
        askedBack = true;
        refusal = "step_unclear";
      }
    } else if (action === "drop_step") {
      if (step) {
        await updateStep(step.id, { status: "skipped", skipped_reason: reason });
        await logDecision(biz.id, `Dropped "${step.title}"`, reason);
        track("plan_change_applied", { props: { ...changeFacts, source: "owner", step_key: step.step_key } });
        message = `Done — I've taken "${step.title}" out of your plan.`;
        wrote = true;
      } else {
        message = "I couldn't tell which step you meant, so I haven't changed anything. Which one should come out?";
        askedBack = true;
        refusal = "step_unclear";
      }
    } else if (action === "move_part") {
      // Re-order by rewriting step_order: the named part moves to the front.
      const inPart = plan.steps.filter((s) => s.workstream_title === title);
      if (inPart.length) {
        await Promise.all(inPart.map((s, i) => updateStep(s.id, { step_order: -1000 + i })));
        await logDecision(biz.id, `Moved "${title}" to the front of the plan`, reason);
        // The part's title is the plan's tailored wording: its step keys say which part it was.
        track("plan_change_applied", { props: { ...changeFacts, settled_by: partMeant ? "owner_words" : "model", source: "owner", steps: inPart.length, step_keys: inPart.map((s) => s.step_key) } });
        message = `Done — "${title}" comes first now.`;
        wrote = true;
      } else {
        message = "I couldn't tell which part of the plan you meant, so I haven't changed anything. Which part should come first?";
        askedBack = true;
        refusal = "part_unclear";
      }
    } else if (action === "none") {
      message = modelSaid && !CLAIMS_CHANGE.test(modelSaid) ? modelSaid : "I haven't changed your plan. Tell me which step doesn't fit and what you'd rather do, and I'll look at it.";
      refusal = "declined";
    } else {
      message = "I haven't changed anything in your plan. Tell me which step doesn't fit and what you'd rather do.";
      askedBack = true;
      refusal = "unknown_action";
    }

    // Every message in the change flow that changed nothing. `asked_back`: they
    // get one more message to say which (info); otherwise this was the answer.
    if (!wrote) {
      trackUnmet("plan_change_refused", {
        severity: askedBack && !retried ? "info" : "warn",
        props: { ...changeFacts, reason: refusal, asked_back: askedBack && !retried, model_reply: action === "none" && Boolean(modelSaid) && !CLAIMS_CHANGE.test(modelSaid) },
        fingerprint: `plan_change_refused:${refusal}`,
      });
    }

    // A reply that asks them something has to be able to hear the answer:
    // stay in the change flow for ONE more message, then let go, so a person
    // is never stuck in it.
    if (!wrote && askedBack && !retried) {
      await updateBusiness(biz.id, { stage: "changing", pending_action: { kind: "change", count: 1, asked: `${askedBefore} ${said}`.trim().slice(0, 300) } });
      await sendText(biz.wa_id, message, biz.id);
      return;
    }

    await updateBusiness(biz.id, { stage: "plan_ready", pending_action: null });
    await sendButtons(biz.wa_id, message, [
      { id: ACT.SEE_PLAN, title: "See my plan" },
      { id: ACT.NEXT_STEP, title: "Next step" },
    ], biz.id);
  } catch (err) {
    // A fenced-off attempt (jobctx.ts) must not write fallback state over the live one.
    if (err instanceof JobFencedError) throw err;
    await fenceCheck();
    console.log("applyChange failed", err);
    trackFailure("plan_change_failed", err, {
      props: { source: "owner", answering, retried },
      summary: `A person's plan change got "That didn't come through" and nothing was changed: ${errorText(err).slice(0, 140)}`,
    });
    await updateBusiness(biz.id, { stage: "plan_ready", pending_action: null });
    await sendText(biz.wa_id, "That didn't come through. Say again what doesn't fit.", biz.id);
  }
}

/** The person's own words asking for a step to go — the only thing that lets drop_step through. */
export const ASKS_TO_REMOVE = /\b(remove|drop|delete|skip|cut|get rid of|take (?:it|that|this|[\w'" ]{1,60}) out|leave (?:it|that|this) out|doesn'?t apply|does not apply|don'?t need|do not need|not relevant|not for me|won'?t do|can'?t do)\b/i;

/**
 * What a change request asks for, from the person's words alone: removing a
 * step, swapping its tool, or moving a part. Null when the words don't say.
 */
export function changeIntentFromWords(said: string): "drop_step" | "swap_tool" | "move_part" | null {
  if (ASKS_TO_REMOVE.test(said)) return "drop_step";
  if (/\b(swap|replace|switch|different tool|another tool|the tool|that tool|this tool)\b/i.test(said)) return "swap_tool";
  if (/\b(move|reorder|earlier|first|sooner|before)\b/i.test(said)) return "move_part";
  return null;
}

/**
 * A change request typed straight into the chat, outside the "Change my
 * plan" button. Live test, round 11: "drop that one", typed at a finished
 * plan, was answered as a question ("that plan is still here when you want
 * it") because only the stage after the button ever read words as a change.
 * Conservative on purpose: a change verb aimed at the plan ("drop that one",
 * "swap step 3", "move that part earlier"), or a removal word next to a step
 * named by its title. Never a question that opens with how/why/what ("how do
 * I change my prices?"), and never "skip", which means "not today" to an
 * owner looking at one step. Returns "ask" when they named nothing to change
 * ("change my plan"), "apply" when there is something to act on.
 */
const CHANGE_VERB = String.raw`(?:drop|remove|delete|cut|swap|change|move|replace|reorder|take\s+out)`;
const PLAN_ONLY = String.raw`(?:the|my|this|that)\s+(?:90[- ]day\s+)?plan`;
const PLAN_THING = String.raw`(?:that one|this one|that step|this step|the step|a step|steps?\s*#?\d+|part\s*#?\d+|that part|this part|the order|the tool|that tool|this tool)`;
const TYPED_CHANGE_THING = new RegExp(String.raw`\b${CHANGE_VERB}\b[^.?!]{0,40}?\b${PLAN_THING}\b|\b${PLAN_THING}\b[^.?!]{0,20}?\b${CHANGE_VERB}\b`, "i");
const TYPED_CHANGE_PLAN = new RegExp(String.raw`\b${CHANGE_VERB}\b[^.?!]{0,20}?\b${PLAN_ONLY}\b`, "i");
const OPENS_AS_QUESTION = /^\s*(how|why|what|when|where|who|which)\b/i;

export function typedPlanChange(said: string, steps: Pick<PlanStepRow, "title">[] = []): "apply" | "ask" | null {
  if (!said || OPENS_AS_QUESTION.test(said)) return null;
  if (TYPED_CHANGE_THING.test(said)) return "apply";
  if (ASKS_TO_REMOVE.test(said) && !/\bskip\b/i.test(said) && stepNamedIn(said, steps as PlanStepRow[])) return "apply";
  if (TYPED_CHANGE_PLAN.test(said)) return "ask";
  return null;
}

/**
 * The step a person named by its title ("For 'Show up when people search
 * nearby' can you…"), if any: the longest step title that appears in what
 * they wrote, ignoring case, quotes and punctuation. Deterministic — the
 * model's own pick is checked against this, never the other way round.
 */
export function stepNamedIn(said: string, steps: PlanStepRow[]): PlanStepRow | null {
  const text = normWords(said);
  let best: PlanStepRow | null = null;
  for (const s of steps) {
    const t = normWords(s.title ?? "");
    if (t.trim().split(" ").length < 2) continue; // a one-word title is not a name
    if (text.includes(t) && (!best || t.length > normWords(best.title ?? "").length)) best = s;
  }
  return best;
}

/** The part of the plan a person named by its title ("put 'Make it a real business' first"), by the same rule as stepNamedIn. */
export function partNamedIn(said: string, steps: PlanStepRow[]): string | null {
  const text = normWords(said);
  let best: string | null = null;
  for (const title of new Set(steps.map((s) => s.workstream_title ?? ""))) {
    const t = normWords(title);
    if (t.trim().split(" ").length < 2) continue;
    if (text.includes(t) && (!best || t.length > normWords(best).length)) best = title;
  }
  return best;
}

const normWords = (t: string) => ` ${(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/**
 * Words that can only mean the step in front of them right now. Deliberately
 * not "it", "this one" or "that one": "drop that one" is what the live owner
 * typed (2026-09-25), and it turned out to mean a step that was not the one
 * on screen.
 */
const THIS_STEP = /\b(this step|the (current|latest|last) step|the (step|one) (i'?m|i am) on|the (step|one) you('ve| have)? (just )?(sent|pushed|gave)( me)?)\b/i;

/** A reply that is nothing but a number — an answer to a numbered list. "2?" counts: WhatsApp people answer like that. */
const NUMBER_REPLY = /^\s*(?:(?:is it|it'?s|its|maybe|i think)\s+)?(?:(?:step|part|number|no\.?|option|the)\s*)?#?(\d{1,2})(?:st|nd|rd|th)?\s*(?:one)?\s*[.)!?]*\s*(?:please|pls|thanks|thank you)?\s*[.!?]*\s*$/i;

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
/** "the second one", "is it the last one?" — an ordinal answer to a numbered list, and nothing else. */
const ORDINAL_REPLY = new RegExp(
  `^\\s*(?:(?:is it|it'?s|its|maybe|i think)\\s+)?(?:the\\s+)?(${ORDINALS.join("|")}|last)(?:\\s+(?:one|step|part))?\\s*[.!?]*\\s*(?:please|pls|thanks|thank you)?\\s*[.!?]*\\s*$`,
  "i",
);

/** The 1-based position a reply picks from a numbered list of `size`, or null. */
function listPick(said: string, size: number): number | null {
  if (!size) return null;
  const num = NUMBER_REPLY.exec(said);
  if (num) {
    const n = Number(num[1]);
    return n >= 1 && n <= size ? n : null;
  }
  const ord = ORDINAL_REPLY.exec(said);
  if (ord) {
    const w = ord[1]!.toLowerCase();
    const n = w === "last" ? size : ORDINALS.indexOf(w) + 1;
    return n >= 1 && n <= size ? n : null;
  }
  return null;
}

/** The "which step?" question, the open steps numbered. */
export function whichStepText(open: Pick<PlanStepRow, "title">[]): string {
  return `Which step do you mean? Reply with its number:\n${open.map((s, i) => `${i + 1}. ${s.title}`).join("\n")}`;
}

/** The "which part?" question, the parts with open steps numbered. */
export function whichPartText(parts: string[]): string {
  return `Which part should come first? Reply with its number:\n${parts.map((t, i) => `${i + 1}. ${t}`).join("\n")}`;
}

/** After "which part?": a number, an ordinal, or a verbatim title — read against the parts that were offered, nothing else. */
export function partClearlyMeant(said: string, offered: string[]): string | null {
  const n = listPick(said, offered.length);
  if (n) return offered[n - 1]!;
  const text = normWords(said);
  let best: string | null = null;
  for (const title of offered) {
    const t = normWords(title);
    if (t.trim().split(" ").length < 2) continue;
    if (text.includes(t) && (!best || t.length > normWords(best).length)) best = title;
  }
  return best;
}

/**
 * The tools named in some text, by id. A name that only appears inside a
 * longer matched name ("Google" inside "Google Business Profile") does not
 * count separately.
 */
function toolsNamedIn(text: string, tools: { id: string; name: string }[]): { id: string; name: string }[] {
  const hits = tools.filter((t) => {
    const name = normWords(t.name);
    return name.trim().length >= 4 && text.includes(name);
  });
  const distinct = hits.filter((t) => !hits.some((o) => o !== t && normWords(o.name).length > normWords(t.name).length && normWords(o.name).includes(normWords(t.name))));
  return [...new Map(distinct.map((t) => [normWords(t.name), t])).values()];
}

/**
 * The ONE step the person's own words identify, or null. Deterministic, and
 * deliberately narrow: the model's pick is never a substitute for it (live
 * test, 2026-09-25 — "drop that one" dropped "Decide whether to register", a
 * step nobody had named). Their words identify a step when they
 *   - name it by title (stepNamedIn);
 *   - name ONE tool, and exactly one open step uses it. A message naming two
 *     tools ("swap Google Sheets for Google Business Profile") settles
 *     nothing by tool: the second is where they want to go, not the step
 *     (review r10-B #2);
 *   - answer the numbered list this flow sent — "2", "2?", "step 2", "the
 *     second one" — read against the list that was actually sent, never a
 *     recount;
 *   - say "this step" while a step is in front of them (askWhatToChange
 *     carries it as pending_action.on_step).
 * THIS message is read first; the message before it (askedBefore) is a
 * fallback only, so a step named now beats a different one named earlier
 * (review r10-B #1). Anything else — "it", "that one", "the google one" —
 * is null: ask, or let the model read it against the offered list.
 */
export function stepClearlyMeant(args: {
  said: string;
  askedBefore?: string;
  steps: PlanStepRow[];
  /** The steps the person was shown numbered, in that order — only after "which step?". */
  listed?: PlanStepRow[];
  /** The step in front of them when they entered the change flow. */
  onStep?: PlanStepRow | null;
  tools?: { id: string; name: string }[];
}): PlanStepRow | null {
  const { said, askedBefore = "", steps, listed = [], onStep = null, tools = [] } = args;
  const open = steps.filter((s) => s.status === "open");

  /** undefined: the text names no tool at all; null: it names tools but settles nothing. */
  const byTool = (text: string): PlanStepRow | null | undefined => {
    const named = toolsNamedIn(normWords(text), tools);
    if (!named.length) return undefined;
    if (named.length > 1) return null;
    const using = open.filter((s) => s.tool_id === named[0]!.id);
    return using.length === 1 ? using[0]! : null;
  };

  const named = stepNamedIn(said, steps);
  if (named) return named;

  const n = listPick(said, listed.length);
  if (n) return listed[n - 1]!;

  const toolNow = byTool(said);
  if (toolNow) return toolNow;

  if (onStep && THIS_STEP.test(said)) return onStep;

  if (askedBefore) {
    const namedBefore = stepNamedIn(askedBefore, steps);
    if (namedBefore) return namedBefore;
    // Only when this message names no tool of its own.
    if (toolNow === undefined) {
      const toolBefore = byTool(askedBefore);
      if (toolBefore) return toolBefore;
    }
  }
  return null;
}

/**
 * While a "which step?" / "which part?" list is waiting for its answer:
 * does this reply settle it, with no model call? "2?", "the second one?"
 * and a title do; "which is the google one?" does not.
 */
export async function heldChoiceSettles(biz: Business, said: string): Promise<boolean> {
  const pending = biz.pending_action?.kind === "change" ? biz.pending_action : null;
  if (!pending || !Array.isArray(pending.options)) return false;
  const plan = await planFor(biz.id);
  if (!plan) return false;
  if (pending.awaiting === "part") return partClearlyMeant(said, (pending.options as unknown[]).map(String)) !== null;
  if (pending.awaiting !== "step") return false;
  const listed = (pending.options as unknown[]).map((id) => plan.steps.find((s) => s.id === id)).filter((s): s is PlanStepRow => Boolean(s));
  const onStep = pending.on_step ? (plan.steps.find((s) => s.id === pending.on_step) ?? null) : null;
  return stepClearlyMeant({ said, steps: plan.steps, listed, onStep, tools: await toolsFor(biz.country) }) !== null;
}

/**
 * Re-send the numbered list that is still waiting for its answer, after a
 * question asked in the middle of it was answered. pending_action is left
 * exactly as it is — count included — so the next reply that settles
 * nothing still gives up honestly.
 */
export async function resendHeldChoice(biz: Business): Promise<void> {
  // Read fresh, never trust the caller's copy: the question answered in the
  // middle of the list can itself have moved the business — into
  // stabilising mode, most importantly (review of round 10) — and a plan
  // list sent after the stabilising message invites a distressed owner to
  // edit the growth plan (rule 9) with a reply nothing is waiting for.
  const fresh = await findBusinessById(biz.id);
  if (!fresh || fresh.stage !== "changing") return;
  biz = fresh;
  const pending = biz.pending_action?.kind === "change" ? biz.pending_action : null;
  if (pending?.awaiting !== "step" && pending?.awaiting !== "part") return;
  const plan = await planFor(biz.id);
  if (!pending || !plan || !Array.isArray(pending.options)) return;
  if (pending.awaiting === "part") {
    await sendText(biz.wa_id, `And the change you asked for — ${lowerFirst(whichPartText((pending.options as unknown[]).map(String)))}`, biz.id);
    return;
  }
  const listed = (pending.options as unknown[]).map((id) => plan.steps.find((s) => s.id === id)).filter((s): s is PlanStepRow => Boolean(s));
  await sendText(biz.wa_id, `And the change you asked for — ${lowerFirst(whichStepText(listed))}`, biz.id);
}

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

export { REPLY_SCHEMA };
