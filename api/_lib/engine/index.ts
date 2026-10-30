// Charles — the dispatcher. One message in, one conversation forward.
//
// Two rules shape this file, and both came from real failures:
//
//  RULE 7 — a tap is an action id, never re-parsed text, and a message that
//  reads as a question is never stored as the answer to an earlier prompt.
//  Both used to be aspirations; here they are the control flow.
//
//  NO DEAD ENDS — every stage has a handler, including the transient ones a
//  build passes through. A person stranded on a stage nothing handles gets
//  "Got it, I've written that down" forever, which is worse than an error.
//  A test asserts that every value of Stage is reachable here.

import { jobCtx, JobFencedError } from "../jobctx.js";
import { flushTracking, setTrackContext, track, trackFailure, trackUnmet, turnIdFor, withTrackContext } from "../track.js";
import { isInternalNumber } from "../env.js";
import { ACT, isActionId, typedShortcut } from "../actions.js";
import { COUNTRIES, country, countryFromWaId, marketOfNumber } from "../countries.js";
import { justACountry, marketFromLocation, normalisePlace, placeName, type MarketRead } from "../location.js";
import { phonesIn, withoutPhones } from "../phones.js";
import { figuresFrom } from "../grounding.js";
import {
  createBusiness,
  db,
  goalOptionsInFlight,
  findBusiness,
  findBusinessById,
  forgetBusiness,
  getPlanBuild,
  lastOutboundMessage,
  planBuildStageInFlight,
  recordMessage,
  recordSafetyEvent,
  signalTurn,
  updateBusiness,
  type SignalTurn,
} from "../db.js";
import { markRead, sendButtons, sendText } from "../wa.js";
import { CANT_HEAR, LOW_CONFIDENCE, transcribe, voiceConfigured } from "../transcribe.js";
import { attachmentKind, CANT_READ_THAT, MAX_ATTACHMENT_BYTES, NOT_YET_FILES, readAttachment, type AttachmentRead } from "../attachments.js";
import { downloadMedia } from "../wa.js";
import { budgetMessage, DOC_LABEL, explainBack, HOW_TO_SEND, rand as statementRand, readMoneyDocument, STATEMENT_ASK, summaryLine, type StatementRead } from "../statement.js";
import { cardKindAsked } from "../cards.js";
import { sendCard } from "./cards.js";
import { isPlainProgressQuestion } from "./qa.js";
import { readDiagReply, resolveSelection, saysMoneyTrouble } from "../safety.js";
import { DIAG, DIAG_COUNT, matchOptions, parseDiagAction, parseMultiReply, recordAnswer, replyTouchesOptions, shapeQuestion } from "../diagnostic.js";
import { sendList, type ListRow } from "../wa.js";
import { MAX_GOAL_OPTIONS, runRuleStep, runReadbackStep, showGoalOptions } from "./build.js";
import { buildProgressText, resumePlanBuild, startPlanBuild } from "./planbuild.js";
import { minutesPhrase, remainingPhrase, typicalMinutes } from "../eta.js";
import {
  applyChange,
  ASKS_FOR_NEXT_STEP,
  nextWhileStabilising,
  heldChoiceSettles,
  resendHeldChoice,
  askWhatToChange,
  typedPlanChange,
  helpWithStep,
  holdPlanWhileStabilising,
  markStepDone,
  pushNextStep,
  recordStepOutcome,
  moveMapOnBetter,
  sendStepPdf,
  showPlan,
  skipStep,
  startNextPlan,
  startWalk,
  walkLater,
  walkNext,
  whyThisOrder,
} from "./steps.js";
import { answer, noteTurnSkipped, updateMemory } from "./qa.js";
import { dropKeptAnswer, keepQuestion } from "./kept.js";
import { hasLiveConnector, issueConnectorToken } from "../connector.js";
import type { RuleOption, Business, GoalOption, InboundMessage, Stage } from "../types.js";

type GoalOptionList = GoalOption[];
type RuleOptionList = RuleOption[];

const FORGET_RE = /^\s*forget my money\s*$/i;
const CONFIRM_YES_RE = /^\s*yes\b/i;
const BUILDING_STAGES: Stage[] = ["diag_done", "building_rule", "building_plan"];
const STALE_BUILD_MS = 4 * 60 * 1000;

/**
 * Incident, 2026-09-21: a per-owner lock stuck for hours meant every message
 * sent in that window queued up and then replayed, HOURS LATE, once the lock
 * cleared — including a "forget my money" that fired long after the person
 * had moved on and answered several more questions. A message this old is
 * not a live instruction any more; it is stale mail. Rather than try to keep
 * a backlog in perfect chronological order against a queue whose retry
 * timestamps drift under repeated holds, every inbound message this old is
 * simply never acted on as a command — the honest thing is to say so once
 * and move on, not to pretend three-hour-old mail just arrived.
 */
const STALE_MESSAGE_MS = 10 * 60 * 1000;
const STALE_APOLOGY = "Sorry, I was delayed — where were we? Send that again and I'll pick it up properly.";
/** Don't repeat the apology for every message in a backlog — say it once per catch-up. */
const STALE_APOLOGY_COOLDOWN_MS = 5 * 60 * 1000;

/** The single entry point. Everything that can reply to a person comes through here. */
/**
 * What the knowledge_signal fallback needs to know about the turn in flight.
 * `handledAs` is updated as the dispatcher decides where the message goes, so
 * the fallback note names the path that actually took it.
 */
interface InboundTurn extends SignalTurn {
  businessId: string | null;
  handledAs: string;
  /** The business was deleted this turn: writing anything tied to it would un-forget it. */
  forgotten: boolean;
}

/** What each stage's handler takes a typed message for, for the fallback note. */
const STAGE_HANDLED_AS: Partial<Record<Stage, string>> = {
  diag: "a diagnostic answer",
  diag_done: "a message while the plan was building",
  building_rule: "a message while the plan was building",
  building_plan: "a message while the plan was building",
  stabilizing: "stabilising mode",
  confirm_identity: "an identity confirmation",
  identity_fix: "an identity correction",
  choose_goal: "a goal choice",
  choose_rule: "a rule choice",
  clarify_objective: "an objective",
  changing: "a plan change",
  confirm_change: "a yes/no on a proposed change",
  outcome_wait: "an outcome reply",
  walking: "a walkthrough question",
};

/**
 * One owner message in, and — whatever path it takes — exactly one
 * knowledge_signal note out for a typed (or spoken, or forwarded) message.
 *
 * Live, 2026-09-23: a person with a plan sent three messages and only two
 * notes were written. The note was only ever written from afterTurn(), and
 * many paths never reach it: answer()'s own notice/error return, a typed
 * shortcut, a plan change, a walkthrough question, an outcome reply, the
 * diagnostic, stabilising mode. Fixing each path one by one leaves the next
 * one added to fail the same way, so the guarantee lives here, once: if
 * nothing on the way wrote a note, this writes "skipped: handled as <path>".
 * A path that already noted is never noted twice (db.ts signalTurn).
 * A tap is not included — it is Charles's own words, never a signal.
 */
/** The running job's phone number and message, wiped (after a forget). Best effort. */
async function clearCurrentJobIdentity(): Promise<void> {
  const jobId = jobCtx.getStore()?.id;
  if (jobId === undefined || jobId === null) return;
  const { error } = await db().from("jobs").update({ wa_id: null, payload: {} }).eq("id", jobId);
  if (error) console.error("forget: the running job's number could not be cleared", error);
}

export async function handleInbound(inbound: InboundMessage): Promise<void> {
  const turn: InboundTurn = { noted: false, businessId: null, handledAs: "an unrouted message", forgotten: false };
  let failure: unknown = null;
  // Tracking (track.ts): every event in this turn — every send, model call,
  // stage change, however deep — carries the person, the stage and this turn's
  // id. internal = one of our own numbers (INTERNAL_WA_IDS); the number itself
  // is never stored.
  const turnStarted = Date.now();
  const typed = !inbound.actionId && inbound.kind === "text";
  await withTrackContext(
    { channel: "whatsapp", turnId: turnIdFor(inbound.waMessageId), internal: isInternalNumber(inbound.from), country: countryFromWaId(inbound.from), said: typed ? inbound.text : null },
    async () => {
      try {
        await signalTurn.run(turn, () => dispatchInbound(inbound, turn));
      } catch (err) {
        failure = err;
      }
      if (failure instanceof JobFencedError) return;
      if (failure) {
        trackFailure("turn_failed", failure, {
          ms: Date.now() - turnStarted,
          props: { handled_as: turn.handledAs, kind: inbound.kind },
          // The job retries it; job_dead is the immediate alert if it never works.
          alert: "digest",
          fingerprint: `turn_failed:${turn.handledAs}`,
          summary: `A person's message failed while handled as ${turn.handledAs}`,
        });
      } else {
        track("turn_handled", { category: "performance", ms: Date.now() - turnStarted, props: { handled_as: turn.handledAs, kind: inbound.kind, forgotten: turn.forgotten } });
      }
    },
  );
  // A fenced-off attempt did not fail — another worker owns the turn and
  // will note it. Pass the fence straight up to the drain.
  if (failure instanceof JobFencedError) throw failure;
  if (!inbound.actionId && !turn.noted && turn.businessId && !turn.forgotten) {
    if (failure) {
      // The job will be retried; this attempt's note says it did not finish,
      // so a turn that dies on every attempt is still on the record.
      await recordSafetyEvent({
        businessId: turn.businessId,
        check: "knowledge_signal",
        engine: "none",
        outcome: "flag",
        flags: ["turn_failed"],
        detail: `not considered: the turn failed while handled as ${turn.handledAs} (${(failure as Error)?.message ?? String(failure)})`.slice(0, 300),
      });
    } else {
      await noteTurnSkipped({ id: turn.businessId }, turn.handledAs);
    }
  }
  if (failure) throw failure;
}

async function dispatchInbound(inbound: InboundMessage, turn: InboundTurn): Promise<void> {
  const waId = inbound.from;
  void markRead(inbound.waMessageId);

  let biz = await findBusiness(waId);
  const isNew = !biz;
  if (!biz) biz = await createBusiness(waId, countryFromWaId(waId));
  turn.businessId = biz.id;
  setTrackContext({ businessId: biz.id, stage: biz.stage, country: biz.country });
  // Once the person is known, so their words are attributed to them (and go
  // when they ask to be forgotten).
  const typed = !inbound.actionId && inbound.kind === "text";
  track("turn_received", {
    category: "behaviour",
    props: {
      kind: inbound.kind,
      ...(inbound.actionId ? { action: inbound.actionId.split(":")[0], label: inbound.actionLabel ?? null } : {}),
      ...(typed ? { chars: inbound.text.length } : {}),
      late_ms: Math.max(0, Date.now() - inbound.timestamp),
      ...(isNew ? { first_contact: true } : {}),
    },
    excerpt: typed ? inbound.text : null,
  });

  // ── Stale mail: never treat an old message as a live instruction ──
  // Checked before resolveContent so a stale voice note or photo is never
  // transcribed/read at all — that work would be thrown away regardless.
  // Skipped for a brand-new number: there is no earlier conversation for a
  // first contact to be "late" against, however delayed the webhook was.
  if (!isNew && Date.now() - inbound.timestamp > STALE_MESSAGE_MS) {
    turn.handledAs = "a stale message (dropped unread)";
    const last = await lastOutboundMessage(biz.id);
    const apologisedRecently =
      last?.text === STALE_APOLOGY && Date.now() - new Date(last.createdAt).getTime() < STALE_APOLOGY_COOLDOWN_MS;
    await recordMessage(biz.id, "in", inbound.text || `[${inbound.kind}]`, {
      kind: inbound.kind,
      waMessageId: inbound.waMessageId,
      meta: { droppedAsStale: true },
    });
    if (!apologisedRecently) await sendText(waId, STALE_APOLOGY, biz.id);
    // Meta stamps a message when its server receives it, so ten minutes late
    // means our webhook or queue fell behind — and the person's message was
    // not acted on. A backlog is one incident, counted.
    trackUnmet("stale_message_dropped", {
      severity: "error",
      alert: "immediate",
      props: { kind: inbound.kind, late_ms: Date.now() - inbound.timestamp, apologised: !apologisedRecently, ...(inbound.actionId ? { action: inbound.actionId.split(":")[0] } : {}) },
      summary: "A person's message reached Charles more than 10 minutes late and was dropped unread; they were asked to send it again",
    });
    return;
  }

  // ── A brand-new number that opened with a voice note, photo, file or tap ──
  // Still a hello. It used to be read first, so a voice note with transcription
  // off made Charles's very first words "I didn't catch that one" — before it
  // had said hello (audit, 2026-10). Nothing in it is used yet either way.
  if (isNew && inbound.kind !== "text") {
    turn.handledAs = "a first message (a hello, before any questions)";
    await recordMessage(biz.id, "in", inbound.text ? `${inbound.text} [${inbound.kind}]` : `[${inbound.kind}]`, { kind: inbound.kind, waMessageId: inbound.waMessageId });
    await updateBusiness(biz.id, { last_inbound_at: new Date().toISOString() });
    await askDiagQuestion(biz, 0);
    return;
  }

  // ── Turn whatever arrived into words ──
  turn.handledAs = `a ${inbound.kind} message that could not be read`;
  const resolved = await resolveContent(biz, inbound);
  if (resolved === null) return; // already replied (e.g. "I can't hear voice notes yet")
  turn.handledAs = "an unrouted message";
  const said = resolved.text;
  // A voice note's transcript, or a photo's caption, is the person's own words
  // too: any unmet request later in this turn carries them (scrubbed).
  if (said && !typed) setTrackContext({ said });
  const attachment = resolved.attachment;
  const actionId = inbound.actionId;

  await recordMessage(biz.id, "in", actionId ? `[${inbound.actionLabel ?? actionId}]` : attachment ? `${said ? `${said} ` : ""}[${attachment.kind} sent]` : said, {
    kind: inbound.kind,
    waMessageId: inbound.waMessageId,
    meta: actionId ? { actionId } : {},
  });
  // Only the inbound marker moves. A person who asked for no more check-ins and
  // then sends a message has not asked for them back — resuming nudges off the
  // back of ordinary conversation is exactly how a number earns a block.
  await updateBusiness(biz.id, { last_inbound_at: new Date().toISOString() });
  biz = { ...biz, last_inbound_at: new Date().toISOString() };

  // ── Things that work in any stage ──
  //
  // Deleting a business is never one message away, however fresh that message
  // is. It used to be — and a "forget my business" the person sent hours
  // earlier, replayed late from behind a stuck per-owner lock, deleted a real
  // business well after the person had moved on and answered several more
  // questions. The staleness gate above now stops a truly old message from
  // reaching here at all, but a confirm step is the right shape for a
  // destructive command on its own merits, independent of that incident: a
  // single accidental or misread tap should never be irreversible.
  if (biz.pending_action?.kind === "confirm_forget") {
    if (CONFIRM_YES_RE.test(said)) {
      turn.forgotten = true;
      const where = forgetFacts(biz);
      // This turn's buffered events (turn_received…) still carry the business
      // id. Written after the row is deleted, they would break the events
      // foreign key and the whole batch, other people' events with it, would
      // be lost. Sent now, they land first and forgetBusiness scrubs them.
      // Not awaited: the forget never waits on tracking.
      void flushTracking();
      await forgetBusiness(biz.id);
      // After the forget, so it is anonymous like everything they leave behind:
      // where they were when they left, never who they were.
      track("forget_confirmed", { category: "behaviour", businessId: null, excerpt: null, props: where });
      await sendText(
        waId,
        "Done — everything I knew about your money is deleted. If you ever want to start again, just message me.",
        null,
      );
      // This very message's job is still running, so forgetBusiness left it:
      // it would keep their number and their "yes" after everything else went
      // (review, 2026-10). Cleared now the forget has succeeded.
      await clearCurrentJobIdentity();
      return;
    }
    // Put back whatever the confirm prompt interrupted (a pending outcome
    // question, a walkthrough step), so "nothing's changed" is true.
    const resume = (biz.pending_action.resume as Business["pending_action"]) ?? null;
    await updateBusiness(biz.id, { pending_action: resume });
    biz = { ...biz, pending_action: resume };
    await sendText(waId, "Okay, nothing's changed.", biz.id);
    turn.handledAs = "a reply to the delete confirmation";
    // A short "no" / "wait" / "cancel" is an answer to the confirm prompt and
    // nothing else — dispatched on, "no wait" was read as "no change" by the
    // outcome question it had interrupted.
    // Only a bare cancel: "no, I'm in Soweto" is a real answer and goes on.
    if (!actionId && /^\s*(no|nope|nah|cancel|wait|no wait|no thanks|never ?mind|not now|leave it|don'?t|do not)[\s!.]*$/i.test(said)) return;
    // Falls through deliberately: their reply may have been a real message,
    // not an answer to the confirm prompt at all, and it deserves a real
    // dispatch rather than being swallowed by a prompt they never meant to
    // answer with anything but "yes".
  } else if (FORGET_RE.test(said)) {
    turn.handledAs = "a forget request";
    await updateBusiness(biz.id, { pending_action: { kind: "confirm_forget", resume: biz.pending_action ?? null } });
    await sendText(
      waId,
      "If you're sure, reply YES and I'll delete everything I know about your money — for good, with nothing kept. Anything else and nothing changes.",
      biz.id,
    );
    track("forget_requested", { category: "behaviour", props: forgetFacts(biz) });
    return;
  }

  if (actionId === ACT.PAUSE_NUDGES || typedShortcut(said) === ACT.PAUSE_NUDGES) {
    turn.handledAs = "a request to pause check-ins";
    await updateBusiness(biz.id, { paused: true });
    await sendText(waId, "No more check-ins from me. Message any time and we pick straight back up.", biz.id);
    // "Not yet" under the stabilising exit offer is this same action.
    track("nudges_paused", {
      category: "behaviour",
      props: { how: actionId === ACT.PAUSE_NUDGES ? "tap" : "typed", already_paused: Boolean(biz.paused), from_stabilising_offer: biz.pending_action?.kind === STABILISING_EXIT_OFFERED },
    });
    return;
  }

  if (actionId === ACT.CONNECT_AI || typedShortcut(said) === ACT.CONNECT_AI) {
    turn.handledAs = "a request to connect their AI";
    await sendConnectorLink(biz);
    return;
  }
  if (actionId === ACT.CONNECT_NEW && !isNew) {
    turn.handledAs = "a request to replace their AI's address";
    await sendConnectorLink(biz, { replace: true });
    return;
  }
  if (actionId === ACT.CONNECT_KEEP && !isNew) {
    turn.handledAs = "keeping their AI's address";
    // Only say it is still connected if it is (a forget, or a replacement
    // that failed, can leave none).
    // Fails closed (as connected), and said nothing: the person can be told
    // their AI "stays connected" without anyone being able to check it.
    const stillLive = await hasLiveConnector(biz.id).catch((err) => {
      trackFailure("connector_link_failed", err, {
        severity: "warn",
        alert: "digest",
        props: { reason: "lookup_failed", via: "keep" },
        fingerprint: "connector_link_failed:lookup_failed:keep",
        summary: "A person tapped Keep mine and whether their AI's address still works could not be checked; they were told it stays connected",
      });
      return true;
    });
    if (stillLive) {
      await sendText(biz.wa_id, "Kept — nothing changes. Your AI stays connected.", biz.id);
    } else {
      await sendText(biz.wa_id, "You don't have a working address right now, so here's a new one.", biz.id);
      await sendConnectorLink(biz);
    }
    return;
  }

  // ── A brand-new number: hello, the consent line, question one — one message ──
  // Their first message is a hello, not an answer to a question nobody asked.
  // Question one's own text carries the introduction and the consent line
  // (diagnostic.ts CONSENT_LINE), in that order.
  if (isNew) {
    turn.handledAs = "a first message (a hello, before any questions)";
    await askDiagQuestion(biz, 0);
    return;
  }

  // ── A tap ──
  if (actionId) {
    const handled = await dispatchAction(biz, actionId, inbound.actionLabel ?? "");
    if (handled) return;
    // An id nothing here knows (a button retired since it was sent): the tap
    // goes on to the stage machine with no words in it.
    trackUnmet("stale_tap", { props: { action: actionId.split(":")[0], reason: "unknown_action" }, fingerprint: "stale_tap:unknown_action", summary: "A person tapped a button whose action id Charles no longer knows" });
  }

  // ── Typed shortcuts, only where they make sense ──
  //
  // Not during the diagnostic, where "next" is a plausible answer rather than a
  // command. And not in stabilising mode, where "start" is the word the
  // stabilising message itself invites — routing it to the plan pusher gave a
  // struggling owner "You don't have a plan yet. Say 'start'", which is the
  // instruction that produced it. Their words belong to handleStabilizing,
  // which can read them as evidence that things have changed.
  const shortcut = typedShortcut(said);
  if (shortcut && !isDiagnosticStage(biz.stage) && biz.stage !== "stabilizing") {
    turn.handledAs = `a typed shortcut (${shortcut})`;
    const handled = await dispatchAction(biz, shortcut, said);
    if (handled) return;
  }

  // ── The stage machine ──
  turn.handledAs = STAGE_HANDLED_AS[biz.stage] ?? `a message at stage ${biz.stage}`;
  return runStage(biz, said, resolved.lowConfidence, attachment, resolved.voice === true);
}

function isDiagnosticStage(stage: Stage): boolean {
  return stage === "diag";
}

/** Where a person was when they asked to be forgotten (the stage comes with the turn). No words, no number. */
function forgetFacts(biz: Business): Record<string, unknown> {
  const created = biz.created_at ? Date.parse(biz.created_at) : NaN;
  return {
    has_plan: Boolean(biz.current_plan_id),
    ...(biz.stage === "diag" ? { diag_step: biz.diag_step ?? 0 } : {}),
    ...(Number.isFinite(created) ? { days_known: Math.floor((Date.now() - created) / 86_400_000) } : {}),
  };
}

// ── Getting words out of whatever arrived ────────────────────────

async function resolveContent(
  biz: Business,
  inbound: InboundMessage,
): Promise<{ text: string; lowConfidence: boolean; attachment?: AttachmentRead; voice?: boolean } | null> {
  if (inbound.kind === "audio") {
    if (!voiceConfigured()) {
      await sendText(biz.wa_id, CANT_HEAR, biz.id);
      trackUnmet("voice_unavailable", {
        props: { reason: "not_configured" },
        fingerprint: "voice_unavailable:not_configured",
        summary: "A person sent a voice note and no transcription route is configured; they were asked to type it",
      });
      return null;
    }
    const media = inbound.mediaId ? await downloadMedia(inbound.mediaId) : null;
    if (!media) {
      await sendText(biz.wa_id, "That voice note didn't come through. Send it again, or type it — whichever's easier.", biz.id);
      // A failed download is ours, not theirs (an expired token, Meta's media
      // host refused): every voice note fails the same way until it is fixed,
      // and wa.ts only logs it. So it is emailed at once, like transcription_failed.
      const why = inbound.mediaId ? "download_failed" : "no_media";
      trackUnmet("voice_unavailable", {
        ...(why === "download_failed" ? { severity: "error" as const, alert: "immediate" as const } : {}),
        props: { reason: why },
        fingerprint: `voice_unavailable:${why}`,
        summary: "A person's voice note could not be fetched from WhatsApp; they were asked to send it again",
      });
      return null;
    }
    const hearing = Date.now();
    const t = await transcribe(media.bytes, media.mimeType, biz.identity?.earns ?? biz.answers?.person);
    if (!t?.text) {
      await sendText(biz.wa_id, "I couldn't make that one out. Try again somewhere quieter, or type it.", biz.id);
      // The person's side of it. Why, when something broke, is transcription_failed (transcribe.ts).
      trackUnmet("voice_unavailable", {
        ms: Date.now() - hearing,
        props: { reason: "not_transcribed", bytes: media.bytes.byteLength, mime: baseMime(media.mimeType) },
        fingerprint: "voice_unavailable:not_transcribed",
        summary: "A person's voice note could not be transcribed; they were asked to try again or type it",
      });
      return null;
    }
    return { text: t.text, lowConfidence: (t.confidence ?? 1) < LOW_CONFIDENCE, voice: true };
  }

  if (inbound.kind === "image" || inbound.kind === "document") {
    // A bank statement, a payslip or a credit report is read at ANY stage:
    // the person chose to send it, and it is the one file that makes the
    // diagnostic and the plan better (statement.ts). One model call says
    // whether this is one; if it is, the read-back goes out here and the
    // turn ends. The file itself is never kept.
    const supported = Boolean(inbound.mediaId && attachmentKind(inbound.mimeType));
    const media = supported ? await downloadMedia(inbound.mediaId!) : null;
    if (media && media.bytes.byteLength > 0 && media.bytes.byteLength <= MAX_ATTACHMENT_BYTES) {
      const stmt = await readMoneyDocument(media.bytes, media.mimeType || inbound.mimeType || "", inbound.text);
      if (stmt && stmt !== "not_money") {
        await handleStatement(biz, stmt, inbound);
        return null;
      }
    }
    // Other pictures and files are for after the plan exists: that is when a
    // person forwards a quote or a grant notice and asks what it means. Before
    // that they have nowhere to go, so say so and keep the diagnostic moving.
    // A caption, if there is one, is still just a message.
    const canRead = biz.stage === "plan_ready" || biz.stage === "step_pushed";
    if (!canRead) {
      // By design, but still something they tried: with a caption, the caption
      // goes on as the message and the file itself is never looked at.
      trackUnmet("attachment_unreadable", {
        severity: "info",
        props: { kind: inbound.kind, reason: "before_plan", has_caption: Boolean(inbound.text), mime: baseMime(inbound.mimeType) },
        excerpt: inbound.text || null,
        fingerprint: "attachment_unreadable:before_plan",
        summary: "A person sent a photo or file before their plan was built; it was not read",
      });
      if (!inbound.text) {
        await sendText(biz.wa_id, NOT_YET_FILES, biz.id);
        return null;
      }
      return { text: inbound.text, lowConfidence: false };
    }

    const read = media ? await readAttachment(media.bytes, media.mimeType || inbound.mimeType || "", inbound.text) : null;
    if (!read) {
      // Why, in the order readAttachment gives up. "not_read" is the model
      // seeing nothing legible, or failing (attachment_read_failed says which).
      const mime = media?.mimeType || inbound.mimeType || "";
      const reason = !attachmentKind(inbound.mimeType) || !attachmentKind(mime)
        ? "unsupported_type"
        : !inbound.mediaId
          ? "no_media"
          : !media
            ? "download_failed"
            : media.bytes.byteLength === 0
              ? "empty"
              : media.bytes.byteLength > MAX_ATTACHMENT_BYTES
                ? "too_large"
                : "not_read";
      trackUnmet("attachment_unreadable", {
        props: { kind: inbound.kind, reason, has_caption: Boolean(inbound.text), mime: baseMime(mime), ...(media ? { bytes: media.bytes.byteLength } : {}) },
        excerpt: inbound.text || null,
        fingerprint: `attachment_unreadable:${reason}`,
        summary: `A person sent a ${inbound.kind === "document" ? "file" : "photo"} Charles could not read (${reason.replace(/_/g, " ")})`,
      });
      if (!inbound.text) {
        await sendText(biz.wa_id, CANT_READ_THAT, biz.id);
        return null;
      }
      return { text: inbound.text, lowConfidence: false };
    }
    // The person's words (the caption) and what the picture says are kept apart
    // on purpose. Only `text` is ever searched for commands or written to memory.
    return { text: inbound.text ?? "", lowConfidence: false, attachment: read };
  }

  if (inbound.kind === "unsupported") {
    await sendText(biz.wa_id, "I didn't catch that one. Send it as a message and I'll pick it up.", biz.id);
    trackUnmet("unsupported_message", {
      props: { kind: inbound.kind },
      summary: "A person sent something Charles cannot read (a sticker, location, contact, video or reaction)",
    });
    return null;
  }

  return { text: inbound.text ?? "", lowConfidence: false };
}

/** "audio/ogg; codecs=opus" → "audio/ogg": the kind of file, nothing more. */
function baseMime(mimeType: string | undefined): string | null {
  return mimeType ? mimeType.split(";")[0]!.trim().toLowerCase() || null : null;
}

// ── Actions ──────────────────────────────────────────────────────

/**
 * The only actions that run while a business is stabilising. Everything else
 * that moves the plan or the stage is held (holdPlanWhileStabilising), so a
 * new plan button added later is held by default instead of reopening the
 * silent exit from stabilising mode (rule 9). BUILD_NOW is the deliberate
 * way out; the rest cannot move the plan or the stage.
 */
const STABILISING_ALLOWED: ReadonlySet<string> = new Set([
  ACT.BUILD_NOW,
  ACT.SEE_PLAN,
  ACT.PLAN_PDF,
  ACT.MENU,
  ACT.CONNECT_AI,
  ACT.CONNECT_KEEP,
  ACT.CONNECT_NEW,
  ACT.PAUSE_NUDGES,
  ACT.CONSENT_OK,
  ACT.VOICE_OK,
  // A statement read-back's buttons move nothing in the plan; a budget from
  // their own lines is "protect cash", which is what stabilising is for.
  ACT.STMT_NORMAL,
  ACT.STMT_ODD,
  ACT.STMT_BUDGET,
]);

/** Returns true when the action was handled, false to fall through to text. */
async function dispatchAction(biz: Business, actionId: string, label: string): Promise<boolean> {
  // A diagnostic option carries the step it belongs to, so a tap on a stale
  // message from three questions ago cannot corrupt the current answer.
  const diag = parseDiagAction(actionId);
  if (diag) {
    // Old messages stay tappable in WhatsApp forever. A tap on a question from
    // the onboarding, weeks later, must not re-enter the diagnostic — it used
    // to re-run finishDiagnostic and build a second plan, which is several
    // expensive model calls and a bewildering thing to receive.
    if (biz.stage !== "diag") {
      await staleTap(biz, actionId);
      return true;
    }
    if (diag.step !== (biz.diag_step ?? 0)) {
      await sendText(biz.wa_id, "That was for an earlier question — let's finish this one first.", biz.id);
      await askDiagQuestion(biz, biz.diag_step ?? 0);
      trackUnmet("stale_tap", { severity: "info", props: { action: actionId, reason: "earlier_question", tapped_step: diag.step, current_step: biz.diag_step ?? 0 }, fingerprint: "stale_tap:earlier_question" });
      return true;
    }
    const option = DIAG[diag.step]?.options?.[diag.option];
    await advanceDiagnostic(biz, option ?? label, "tap");
    return true;
  }

  // A quick reply we generated: the label IS the message the person meant.
  if (actionId.startsWith("a.q.")) {
    const text = actionId.slice(actionId.indexOf(":") + 1) || label;
    await answer(biz, text, undefined, { ownerWords: false });
    return true;
  }

  // An outcome button carries the step it was asked about ("a.out.better:<stepId>"),
  // so an old one from a previous step is recorded against THAT step, never
  // against whichever step happens to be current.
  const outcome = /^(a\.out\.(?:better|early|none)):(.+)$/.exec(actionId);
  if (outcome && biz.stage === "stabilizing") {
    await holdPlanWhileStabilising(biz, actionId);
    return true;
  }
  if (outcome) {
    await recordStepOutcome(biz, outcome[1]!, outcome[2]!);
    return true;
  }

  // Which country the business is in, picked from the list (askMarket).
  const market = /^a\.mk\.([A-Z]{2}|other|list)$/.exec(actionId);
  if (market) {
    await chooseMarket(biz, market[1]!, actionId);
    return true;
  }

  if (!isActionId(actionId)) return false;

  // Old plan buttons stay tappable in WhatsApp forever, and while stabilising
  // the step card is often the message directly above the stabilising reply.
  // Tapping "I'm stuck", "Next step" or "Done" on it used to push the plan
  // again and write stage 'step_pushed' — a silent exit from stabilising mode
  // (rule 9) that nothing recorded. Typed shortcuts are already held back
  // while stabilising (handleInbound); taps are held the same way.
  //
  // Review of round 10: holding only PLAN_TAPS left Change my plan, Never
  // mind, Yes/No on a change, Build the next 90, Why this order and an old
  // "Not quite" free to write a new stage — the same unrecorded exit through
  // another door. So the gate is an allowlist now: while stabilising, only
  // the buttons that cannot move the plan or the stage (and BUILD_NOW, the
  // intended way out) run; every other action is held, with no stage write.
  if (biz.stage === "stabilizing" && !STABILISING_ALLOWED.has(actionId)) {
    await holdPlanWhileStabilising(biz, actionId);
    return true;
  }

  switch (actionId) {
    case ACT.CONSENT_OK:
      // askDiagQuestion writes stage 'diag': an old consent tap from any
      // later stage (stabilising included) must not reopen the diagnostic.
      if (biz.stage !== "diag") {
        await staleTap(biz, actionId);
        return true;
      }
      await askDiagQuestion(biz, biz.diag_step ?? 0);
      return true;

    case ACT.VOICE_OK: {
      // Keeps the transcript read back for THIS question only. A tap on an
      // old read-back (a later question is open, or the diagnostic is over)
      // must not store stale words against whatever is current.
      const pending = biz.pending_action;
      if (biz.stage === "diag" && pending?.kind === "voice_check" && pending.step === (biz.diag_step ?? 0)) {
        await updateBusiness(biz.id, { pending_action: null });
        await advanceDiagnostic({ ...biz, pending_action: null }, String(pending.heard ?? ""), "voice", { readback: "confirmed" });
        return true;
      }
      if (biz.stage === "diag") {
        await sendText(biz.wa_id, "That was for an earlier question — let's finish this one first.", biz.id);
        await askDiagQuestion(biz, biz.diag_step ?? 0);
        trackUnmet("stale_tap", { severity: "info", props: { action: actionId, reason: "earlier_question", current_step: biz.diag_step ?? 0 }, fingerprint: "stale_tap:earlier_question" });
        return true;
      }
      await staleTap(biz, actionId);
      return true;
    }

    case ACT.BUILD_NOW: {
      // Live test, 2026-09-25: a business that went into stabilising mode
      // mid-conversation already HAD a plan, and the only way out rebuilt
      // from diag_done — customer options again, the finished plan thrown
      // away. A plan that exists is kept: back to plan_ready, and say so.
      // Only a business with no plan (stabilising since the diagnostic)
      // builds one.
      const { planFor } = await import("../db.js");
      if (await planFor(biz.id)) {
        await updateBusiness(biz.id, { stage: "plan_ready", pending_action: null });
        await sendButtons(
          biz.wa_id,
          "Good — your plan is still here. Tap Next step when you're ready.",
          [
            { id: ACT.NEXT_STEP, title: "Next step" },
            { id: ACT.SEE_PLAN, title: "See my plan" },
          ],
          biz.id,
        );
        return true;
      }
      // No plan: the person was flagged in distress during the diagnostic.
      // The exit check (handleStabilizing) read what they have said SINCE
      // and offered the plan; this tap is them accepting it. Re-running the
      // diagnostic-wide distress check here (readbackStep) read the same old
      // answers and sent them straight back to stabilising — offered, then
      // refused, forever (review of round 10). So the exit that was offered
      // and confirmed skips that gate, and the skip is on the record. An old
      // "Yes, build it" from an offer since withdrawn (they said it had got
      // tight again) does not carry the clearance.
      const cleared = biz.stage === "stabilizing" && biz.pending_action?.kind === STABILISING_EXIT_OFFERED;
      if (cleared) {
        await recordSafetyEvent({
          businessId: biz.id,
          check: "distress",
          engine: "none",
          outcome: "pass",
          flags: ["stabilising_exit_confirmed"],
          detail: "owner confirmed 'Yes, build it' after the exit check read things as steadier; diagnostic-wide distress gate skipped for this build",
        });
      }
      const building = { kind: "building", since: new Date().toISOString(), ...(cleared ? { distress_cleared: true } : {}) };
      await updateBusiness(biz.id, { stage: "diag_done", pending_action: building });
      await runReadbackStep({ ...biz, stage: "diag_done", pending_action: building }, undefined, { distressCleared: cleared });
      return true;
    }

    case ACT.IDENTITY_OK: {
      // Counted once: a second "That's right" while the options are on their
      // way, or an old one from a later stage (showGoalOptions says so),
      // is not another confirmation.
      const confirming = biz.stage === "confirm_identity" && biz.pending_action?.kind !== "goal_options_wait";
      await showGoalOptions(biz);
      if (confirming) track("identity_confirmed", { category: "funnel", props: { how: "tap" } });
      return true;
    }

    case ACT.IDENTITY_FIX:
      // Only while the read-back it sat under is the one being confirmed. An
      // old "Not quite", tapped once the person has moved on, would otherwise
      // throw away the customer choice — or a finished plan — and rebuild.
      if (biz.stage !== "confirm_identity" && biz.stage !== "identity_fix") {
        await staleTap(biz, actionId);
        return true;
      }
      // Handled the moment it arrives — the options job does not hold the
      // owner's queue (engine/build.ts) — and clearing the options token
      // here is what throws away options still being written for the
      // business the person has just said this is not.
      await updateBusiness(biz.id, { stage: "identity_fix", pending_goal_options: null, pending_action: null });
      await sendText(biz.wa_id, "Fair enough — tell me in a few words where your money actually comes from, and I'll build from that.", biz.id);
      return true;

    case ACT.NEXT_STEP:
      // PRIORITY 5.3: this fires for THREE different taps/typed shortcuts —
      // "Next step" from the plan itself, the SAME button walkLater() leaves
      // behind ("it'll be here when you are"), and typed "next" (actions.ts's
      // TYPED) — and until now it always meant pushNextStep, unconditionally.
      // That was fine for the first case, but wrong for the other two: a
      // walkthrough walkLater() paused (it deliberately leaves `walk` in
      // place — see its own comment) has a person who has NOT finished it,
      // and pushNextStep's full re-send dumps the ENTIRE condensed
      // walkthrough as one no-counter message ("Exactly how, step by step:
      // 1. ... 2. ... 3. ..."), while the walkthrough's own stale "Next"
      // button (WALK_NEXT) correctly resumes one granular line at a time
      // with its "N of M" counter. Same feature, two different shapes,
      // depending only on which button happened to still be on screen. Now
      // every resume path is the one behaviour: a genuinely paused
      // walkthrough resumes exactly like WALK_NEXT would, never
      // pushNextStep's summary.
      if (biz.walk) await walkNext(biz);
      else await pushNextStep(biz);
      return true;

    case ACT.STEP_DONE: {
      const stepId = (biz.pending_action?.step_id as string | undefined) ?? biz.walk?.step_id;
      if (stepId) await markStepDone(biz, stepId);
      else {
        // An old "Done" with no step waiting: nothing is marked, the next step goes out instead.
        trackUnmet("stale_tap", { severity: "info", props: { what: "done", reason: "no_step_waiting" }, fingerprint: "stale_tap:no_step_waiting" });
        await pushNextStep(biz);
      }
      return true;
    }

    case ACT.STEP_HELP:
    case ACT.WALK_STUCK:
      await helpWithStep(biz, label);
      return true;

    case ACT.STEP_SKIP: {
      const stepId = biz.pending_action?.step_id as string | undefined;
      if (stepId) await skipStep(biz, stepId);
      else {
        trackUnmet("stale_tap", { severity: "info", props: { what: "skip", reason: "no_step_waiting" }, fingerprint: "stale_tap:no_step_waiting" });
        await pushNextStep(biz);
      }
      return true;
    }

    case ACT.STEP_WALK: {
      const stepId = biz.pending_action?.step_id as string | undefined;
      const { planFor } = await import("../db.js");
      const plan = await planFor(biz.id);
      const step = plan?.steps.find((s) => s.id === stepId) ?? null;
      if (step?.tool_id) await startWalk(biz, step.tool_id, step.id);
      else {
        // "Walk me through" is only offered on a step with a walkthrough, so
        // this is an old button: written help instead of the walkthrough.
        // With no plan at all, helpWithStep records it (step_unavailable, help).
        if (plan) trackUnmet("step_unavailable", { severity: "info", props: { what: "walkthrough", reason: step ? "no_walkthrough" : "no_step" } });
        await helpWithStep(biz, label);
      }
      return true;
    }

    case ACT.STEP_PDF: {
      const stepId = biz.pending_action?.step_id as string | undefined;
      await sendStepPdf(biz, stepId);
      return true;
    }

    case ACT.PLAN_PDF: {
      // The whole plan as it stands, from the stored rows (engine/planpdf.ts).
      const { sendPlanPdf } = await import("./planpdf.js");
      await sendPlanPdf(biz, "asked");
      return true;
    }

    case ACT.WALK_NEXT:
      await walkNext(biz);
      return true;

    case ACT.WALK_LATER:
      await walkLater(biz);
      return true;

    case ACT.OUTCOME_BETTER:
    case ACT.OUTCOME_EARLY:
    case ACT.OUTCOME_NONE:
      await recordStepOutcome(biz, actionId);
      return true;

    case ACT.SEE_PLAN:
      await showPlan(biz);
      return true;

    case ACT.REBUILD:
      await startNextPlan(biz);
      return true;

    case ACT.WHY_ORDER:
      await whyThisOrder(biz);
      return true;

    case ACT.CHANGE:
      await askWhatToChange(biz);
      return true;

    case ACT.NEVER_MIND:
      await updateBusiness(biz.id, { stage: "plan_ready", pending_action: null });
      await sendButtons(biz.wa_id, "Fine as it is, then.", [{ id: ACT.NEXT_STEP, title: "Next step" }], biz.id);
      return true;

    case ACT.STMT_NORMAL:
    case ACT.STMT_ODD:
    case ACT.STMT_BUDGET:
      await statementTap(biz, actionId);
      return true;

    case ACT.MENU:
      // While stabilising, no button that moves the growth plan (rule 9):
      // they would only be held, and offering them says the plan is on.
      await sendButtons(
        biz.wa_id,
        "What do you need?",
        biz.stage === "stabilizing"
          ? [{ id: ACT.SEE_PLAN, title: "See my plan" }]
          : [
              { id: ACT.NEXT_STEP, title: "Next step" },
              { id: ACT.SEE_PLAN, title: "See my plan" },
              { id: ACT.CHANGE, title: "Change my plan" },
            ],
        biz.id,
      );
      return true;

    case ACT.CHANGE_YES:
    case ACT.CHANGE_NO:
      await decideProposedChange(biz, actionId === ACT.CHANGE_YES, "tap");
      return true;

    default:
      return false;
  }
}

// ── A bank statement, read once, said back ───────────────────────
//
// The person chose to send it (the offer sits under the income question and
// in the answer to "can you read my statement?"). statement.ts read it with
// one model call and kept only the totals and payees; everything said here
// is built in code from that, so no figure is invented and no account number
// exists to repeat. The file is gone the moment this returns.

async function handleStatement(biz: Business, read: StatementRead, inbound: InboundMessage): Promise<void> {
  const label = DOC_LABEL[read.doc];
  await recordMessage(biz.id, "in", `${inbound.text ? `${inbound.text} ` : ""}[${label} sent]`, { kind: inbound.kind, waMessageId: inbound.waMessageId, meta: {} });
  // The diagnostic's own line for it: every plan prompt and the price
  // grounding read `answers.statement`, and its first words say what it is.
  const answers = { ...(biz.answers ?? {}), statement: summaryLine(read) };
  await updateBusiness(biz.id, { statement: read, answers, pending_action: biz.stage === "diag" ? biz.pending_action : null });
  const name = biz.identity?.name ?? biz.answers?.person?.split(/[,.]/)[0] ?? null;
  const text = explainBack(read, name);
  const canBudget = (read.doc === "bank_statement" || read.doc === "payslip") && read.totals.in !== null && read.totals.in > 0;
  if (read.doc === "bank_statement" || read.doc === "payslip") {
    await sendButtons(
      biz.wa_id,
      text,
      [
        { id: ACT.STMT_NORMAL, title: "Normal month" },
        { id: ACT.STMT_ODD, title: "Not a normal month" },
        ...(canBudget ? [{ id: ACT.STMT_BUDGET, title: "Plan my budget" }] : []),
      ],
      biz.id,
    );
  } else {
    await sendText(biz.wa_id, text, biz.id);
  }
  // The same figures as a picture, with a link to the page. Built from the
  // row as just written, so the card sees the statement.
  await sendCard({ ...biz, statement: read, answers }, "statement");
  if (read.doc === "credit_report" && biz.stage === "diag") await askDiagQuestion(biz, biz.diag_step ?? 0);
  track("statement_read", {
    category: "funnel",
    props: { doc: read.doc, stage: biz.stage, lines_in: read.money_in.length, lines_out: read.money_out.length, has_totals: read.totals.in !== null && read.totals.out !== null, flags: read.flags.length, unclear: Boolean(read.unclear) },
  });
}

/**
 * What a statement already read says at a diagnostic question. `answer` is
 * given as the answer (with its source in the words); `say` alone is a line
 * put above the question.
 */
function statementAnswer(biz: Business, key: string | undefined): { say: string; answer?: string } | null {
  const read = biz.statement;
  if (!read || !key) return null;
  if (key === "income" && (read.doc === "bank_statement" || read.doc === "payslip") && read.totals.in !== null && read.totals.in > 0 && read.normal_month !== false) {
    const figure = statementRand(read.totals.in);
    return {
      say: `What comes in: I'll take it from your ${DOC_LABEL[read.doc]}, about ${figure} a month. If that's not a usual month, tell me the usual figure later and I'll use that.`,
      answer: `About ${figure} a month (from the ${DOC_LABEL[read.doc]} they sent, ${read.period ?? "period not shown"})`,
    };
  }
  if (key === "owes") {
    const payees = read.money_out.filter((l) => l.kind === "loan" || l.kind === "store_account" || /mashonisa|loan|lender|account|edgars|jet|ackermans|truworths|foschini|capfin|finchoice/i.test(l.label)).map((l) => l.label);
    if (payees.length) return { say: `Your ${DOC_LABEL[read.doc]} shows payments to ${[...new Set(payees)].slice(0, 5).join(", ")}. Count those in below.` };
  }
  return null;
}

async function statementTap(biz: Business, actionId: string): Promise<void> {
  const read = biz.statement;
  if (!read) {
    await staleTap(biz, actionId);
    return;
  }
  const name = biz.identity?.name ?? biz.answers?.person?.split(/[,.]/)[0] ?? null;
  if (actionId === ACT.STMT_BUDGET) {
    const text = budgetMessage(read, name);
    if (!text) {
      await sendText(biz.wa_id, `I can only build a budget from a bank statement or a payslip with money in on it. Send one of those and I'll do it from your own lines.`, biz.id);
      return;
    }
    await sendText(biz.wa_id, text, biz.id);
    track("statement_budget", { category: "behaviour", props: { doc: read.doc, stage: biz.stage } });
    await sendCard(biz, "month");
    if (biz.stage === "diag") await askDiagQuestion(biz, biz.diag_step ?? 0);
    return;
  }
  const normal = actionId === ACT.STMT_NORMAL;
  const updated: StatementRead = { ...read, normal_month: normal };
  const answers = { ...(biz.answers ?? {}), statement: summaryLine(updated) };
  await updateBusiness(biz.id, { statement: updated, answers });
  track("statement_month", { category: "behaviour", props: { doc: read.doc, normal, stage: biz.stage } });
  if (!normal) {
    await sendText(biz.wa_id, "Noted: not a normal month. Tell me in a line what was different, and I'll keep that in mind when we use the figures.", biz.id);
    if (biz.stage === "diag") await askDiagQuestion({ ...biz, statement: updated, answers }, biz.diag_step ?? 0);
    return;
  }
  if (biz.stage === "diag") {
    await askDiagQuestion({ ...biz, statement: updated, answers }, biz.diag_step ?? 0);
    return;
  }
  await sendButtons(
    biz.wa_id,
    "Good, then those are the figures we work with. Want the month laid out as a budget from them?",
    [{ id: ACT.STMT_BUDGET, title: "Plan my budget" }, { id: ACT.NEXT_STEP, title: "Next step" }],
    biz.id,
  );
}

// ── The stage machine ────────────────────────────────────────────

async function runStage(biz: Business, said: string, lowConfidence: boolean, attachment?: AttachmentRead, voice = false): Promise<void> {
  // "Can you read my bank statement?" is the same short question at every
  // stage, and the answer is how to send one. Whole message only, so a real
  // question that mentions a statement still reaches the answer engine.
  if (!attachment && STATEMENT_ASK.test(said)) {
    await sendText(biz.wa_id, HOW_TO_SEND, biz.id);
    track("statement_asked", { category: "behaviour", props: { stage: biz.stage } });
    return;
  }
  // "Show me my month", "a picture of what I owe", "my map": a card, drawn
  // from their own figures (engine/cards.ts), at any stage. Whole message
  // only, so a real question still reaches the answer engine.
  const asked = attachment ? null : cardKindAsked(said);
  if (asked) {
    track("card_asked", { category: "behaviour", props: { kind: asked, stage: biz.stage } });
    await sendCard(biz, asked);
    return;
  }
  // "How am I doing?" with a plan: the answer, then the map as a picture.
  const planStage = biz.stage === "plan_ready" || biz.stage === "step_pushed";
  if (planStage && !attachment && !biz.pending_action && isPlainProgressQuestion(said) && biz.map?.length) {
    await answer(biz, said, attachment);
    await sendCard(biz, "map");
    return;
  }
  switch (biz.stage) {
    case "diag":
      return handleDiagText(biz, said, voice ? { lowConfidence } : undefined);

    // Transient build stages. A message arriving here means the person is
    // waiting — so say something true, and restart if the build has stalled.
    case "diag_done":
    case "building_rule":
    case "building_plan":
      return handleBuilding(biz);

    case "stabilizing":
      return handleStabilizing(biz, said);

    case "confirm_identity": {
      // "That's right" already tapped, the options still on their way: the
      // owner has confirmed, and nothing but a clear correction undoes that.
      if (biz.pending_action?.kind === "goal_options_wait") return handleOptionsWait(biz, said, attachment);
      // They typed instead of tapping. A short yes is a yes; anything else is
      // a correction, which is the safer reading of an ambiguous reply.
      if (/^\s*(yes|yep|yeah|correct|that'?s right|right|ok|okay|sharp|exactly)\b/i.test(said)) {
        await showGoalOptions(biz);
        track("identity_confirmed", { category: "funnel", props: { how: voice ? "voice" : "typed" } });
        return;
      }
      // A correction invalidates any options still being written for the
      // old reading (engine/build.ts: the options token).
      await updateBusiness(biz.id, { stage: "identity_fix", pending_goal_options: null, pending_action: null });
      return handleIdentityFix({ ...biz, stage: "identity_fix", pending_goal_options: null }, said, "typed_instead");
    }

    case "identity_fix":
      return handleIdentityFix(biz, said, "after_not_quite");

    case "choose_goal":
      return handleChooseGoal(biz, said);

    case "choose_rule":
      return handleChooseRule(biz, said);

    case "clarify_objective": {
      // Two things land here: a person sharpening their objective after a build
      // could not find enough to work with, and a person starting their NEXT
      // ninety days once the first plan is finished.
      if (biz.pending_action?.kind === "rebuild") return startNextPlan(biz, said);

      const answers = { ...(biz.answers ?? {}), objective: said };
      await updateBusiness(biz.id, {
        answers,
        stage: "diag_done",
        pending_action: { kind: "building", since: new Date().toISOString() },
      });
      return runReadbackStep({ ...biz, answers, stage: "diag_done" });
    }

    case "changing": {
      // A numbered "Which step do you mean?" / "Which part should come
      // first?" is waiting for its answer. "2?", "the second one?" and a
      // title ARE the answer, question mark or not. A genuine question in the
      // middle of it ("which is the google one?") is answered, and the same
      // list is sent again with the held request untouched — never dropped
      // silently (review r10-B #3).
      //
      // Money trouble comes first, held list or not (review of round 10).
      // "I can't pay rent, collectors are calling" is not a change request:
      // sent to applyChange it was swallowed — a step dropped, the person put
      // back on the growth plan, distress never checked (rule 9). The change
      // hold is cleared and the message goes through the ordinary answer
      // path, which owns the distress check and the switch to stabilising.
      if (saysMoneyTrouble(said)) {
        await updateBusiness(biz.id, { stage: "plan_ready", pending_action: null });
        return answer({ ...biz, stage: "plan_ready", pending_action: null }, said, attachment);
      }
      const held = biz.pending_action?.kind === "change" && (biz.pending_action.awaiting === "step" || biz.pending_action.awaiting === "part");
      if (held) {
        if (await heldChoiceSettles(biz, said)) return applyChange(biz, said);
        if (readsAsQuestion(said) && !CHANGE_WORDS.test(said)) {
          await answer(biz, said, attachment);
          // Only if the answer left the list waiting: it can have switched the
          // business into stabilising mode, and a plan list after the
          // stabilising message is an invitation to edit the growth plan.
          const fresh = await findBusinessById(biz.id);
          if (fresh?.stage === "changing" && sameHold(fresh.pending_action, biz.pending_action)) return resendHeldChoice(fresh);
          return;
        }
        return applyChange(biz, said);
      }
      // After "Change something", a question that isn't about changing the
      // plan ("can I offer layaway?") is a question: answer it, and leave the
      // change flow rather than defending the plan against it.
      if (readsAsQuestion(said) && !CHANGE_WORDS.test(said)) {
        await updateBusiness(biz.id, { stage: "plan_ready", pending_action: null });
        return answer({ ...biz, stage: "plan_ready", pending_action: null }, said, attachment);
      }
      return applyChange(biz, said);
    }

    case "confirm_change": {
      // Only a clear yes or a clear no decides. Anything else — "what does
      // that mean?" — used to count as NO and silently decline the change.
      // Now it is answered, and the yes/no question is asked again.
      // And the WHOLE message has to be the yes or the no: "okay but what
      // does that change?" starts with "okay", and "no idea what that
      // means?" starts with "no" — both are questions, not decisions.
      if (CLEAR_YES.test(said)) return decideProposedChange(biz, true, "typed");
      if (CLEAR_NO.test(said)) return decideProposedChange(biz, false, "typed");
      await answer(biz, said, attachment);
      // The yes/no again only if the answer left it waiting (it can have
      // switched the business into stabilising mode — rule 9).
      const fresh = await findBusinessById(biz.id);
      if (fresh?.stage !== "confirm_change" || !sameHold(fresh.pending_action, biz.pending_action)) return;
      await sendButtons(biz.wa_id, "And the change your AI suggested — should I update your plan?", [
        { id: ACT.CHANGE_YES, title: "Yes, update it" },
        { id: ACT.CHANGE_NO, title: "No, leave it" },
      ], biz.id);
      return;
    }

    case "outcome_wait": {
      // They wrote about how it went instead of tapping. That is better data
      // — but only if it IS about how it went, for a step that is done
      // (the same precondition as the buttons; see recordStepOutcome).
      const { logOutcome, planFor, recordKnowledgeSignal } = await import("../db.js");
      const waiting = biz.pending_action?.kind === "outcome" ? (biz.pending_action.step_id as string) : null;
      const step = waiting ? ((await planFor(biz.id))?.steps.find((s) => s.id === waiting) ?? null) : null;
      // A question is a question, not an outcome: answer it and keep waiting.
      const question = /\?\s*$/.test(said.trim()) || /^(how|what|when|where|why|who|which|can|could|should|do|does|is|are|will)\b/i.test(said.trim());
      if (!step || step.status !== "done" || question) return answer(biz, said, attachment);

      const effect = typedOutcome(said);
      await logOutcome(biz.id, said.slice(0, 300), effect, step.id);
      // The tap's twin is in steps.ts recordStepOutcome; this is the written answer.
      const doneAt = step.done_at ? Date.parse(step.done_at) : NaN;
      track("outcome_reported", {
        props: { verdict: effect, how: voice ? "voice" : "typed", late: false, step_key: step.step_key, mins_since_done: Number.isFinite(doneAt) ? Math.round((Date.now() - doneAt) / 60_000) : null },
      });
      // They were asked exactly this, so a real sentence here IS an outcome
      // report — no classification needed. A bare "yes" carries nothing the
      // library could learn from.
      // A plain "too early to tell" teaches the library nothing; anything else with substance does.
      if (said.trim().length >= 12 && !/\b(too early|not yet|early days|too soon)\b/i.test(said)) {
        const wrote = await recordKnowledgeSignal({
          source: "whatsapp",
          businessId: biz.id,
          country: biz.country,
          type: "outcome_report",
          entity: step.tool_id ? { type: "tool", id: step.tool_id } : null,
          rawQuote: said,
          candidateClaim: `How "${step.title}" went (${effect})`,
        });
        // Same shape as signals.ts trackSignal; their words are on turn_received.
        track("knowledge_signal", {
          props: { type: "outcome_report", entity_type: step.tool_id ? "tool" : null, entity_id: step.tool_id ?? null, how: "rule", engine: "none", stored: wrote },
        });
        // Its own note, so the dispatcher's fallback doesn't record a real
        // capture as "skipped".
        await recordSafetyEvent({
          businessId: biz.id,
          check: "knowledge_signal",
          engine: "none",
          outcome: "flag",
          detail: `${wrote ? "captured" : "NOT captured (insert failed — see write_failed)"}: outcome_report (typed reply to "has it made a difference?"; no judgement call)${step.tool_id ? ` [${step.tool_id}]` : ""}`,
        });
      }
      // A typed "it's better" moves the map exactly as the button does.
      await moveMapOnBetter(biz, step, effect);
      await updateBusiness(biz.id, { stage: "plan_ready", pending_action: null });
      await sendButtons(biz.wa_id, "Noted — that's useful.", [{ id: ACT.NEXT_STEP, title: "Next step" }], biz.id);
      return;
    }

    case "walking": {
      // Mid-walkthrough, a message is usually someone stuck on the current
      // line. But not always: "should I hire someone?" typed mid-walkthrough
      // used to be answered as if it were about the sign-up screen in front
      // of them. An open question that isn't about this step gets a real
      // answer — and the walkthrough stays exactly where it was ("Next step"
      // resumes it).
      if (await isOffStepQuestion(biz, said)) return answer(biz, said, attachment);
      return helpWithStep(biz, said);
    }

    case "step_pushed":
    case "plan_ready": {
      // A change request typed without tapping "Change my plan" (live, round
      // 11: "drop that one" was answered as a question). Money trouble is
      // never a change request: it goes to the answer path, which owns the
      // distress check. A voice note we are unsure of is read back instead.
      if (!lowConfidence && !saysMoneyTrouble(said)) {
        const plan = await (await import("../db.js")).planFor(biz.id);
        const kind = plan ? typedPlanChange(said, plan.steps) : null;
        if (kind === "ask") return askWhatToChange(biz);
        if (kind === "apply") {
          const onStep = biz.walk?.step_id ?? (biz.pending_action?.kind === "step" ? (biz.pending_action.step_id as string | undefined) : undefined);
          const pending_action = { kind: "change", ...(onStep ? { on_step: onStep } : {}) };
          await updateBusiness(biz.id, { stage: "changing", pending_action });
          return applyChange({ ...biz, stage: "changing", pending_action } as Business, said);
        }
      }
      if (lowConfidence) {
        await sendText(biz.wa_id, `I heard: "${said}"\n\nIf that's not right, type it and I'll use what you type.`, biz.id);
      }
      return answer(biz, said, attachment);
    }

    default: {
      // Unreachable if Stage and this switch stay in step; the test suite
      // enforces that. If it ever happens, do the useful thing.
      console.error(`unhandled stage "${biz.stage}" for ${biz.wa_id}`);
      return answer(biz, said);
    }
  }
}

// ── The diagnostic ───────────────────────────────────────────────

export async function askDiagQuestion(biz: Business, step: number): Promise<void> {
  // Only ever finishes a diagnostic that is actually in progress. Reached with
  // an out-of-range step from anywhere else, this would silently start a plan
  // build for a business that already has one.
  if (step >= DIAG_COUNT) {
    if (biz.stage !== "diag") return;
    return finishDiagnostic(biz);
  }
  await updateBusiness(biz.id, { diag_step: step, stage: "diag" });
  const shape = shapeQuestion(step, biz.country);
  // A statement already read answers the income question with its own
  // figure, said out loud so they can correct it; under "who do you owe"
  // the payees it shows are named so nobody is left off by accident.
  const fromStatement = statementAnswer(biz, DIAG[step]?.key);
  if (fromStatement?.answer) {
    await sendText(biz.wa_id, fromStatement.say, biz.id);
    return advanceDiagnostic({ ...biz, diag_step: step, stage: "diag" }, fromStatement.answer, "statement");
  }
  if (fromStatement?.say) shape.body = `${fromStatement.say}\n\n${shape.body}`;
  if (shape.kind === "text") await sendText(biz.wa_id, shape.body, biz.id);
  else if (shape.kind === "buttons") await sendButtons(biz.wa_id, shape.body, shape.buttons, biz.id);
  else await sendList(biz.wa_id, shape.body, shape.buttonLabel, [{ title: "Pick one", rows: shape.rows }], biz.id);
}

/**
 * A reply with no letters or digits in it at all: "👍", "🙏🏾", "...", "?!".
 * Verification of 2026-09-24 (test/untested-areas.test.ts, 3a): at a
 * free-text question the question gate always counts a non-question as an
 * answer, so "👍" was stored as the business's name; at a multi-select
 * question it was re-asked once and then stored on the second send, because
 * a second send is taken at the person's word. Neither is an answer in any
 * language, so this is decided in code, before any judge runs, every time.
 */
const NO_WORDS = (said: string): boolean => !/[\p{L}\p{N}]/u.test(said);

/**
 * A message that is nothing but a hello. Verification of 2026-09-24
 * (test/untested-areas.test.ts, 3d): a person who went quiet mid-diagnostic
 * and came back with "hi" had "hi" stored as the answer to whatever question
 * was open — their location became "hi" — and was moved on to the next one.
 * No diagnostic question has a greeting for an answer, so a greeting-only
 * message resumes the same question instead. Whole-message only: "Hillbrow,
 * Johannesburg" and "Hi-Tech Motors" are answers.
 */
const GREETING_ONLY =
  /^(?:(?:hi|hii+|hey|heyy+|hello|helo|hallo|hola|howzit|heita|sawubona|molo|dumela|habari|mambo|jambo|sasa|niaje|sannu|bawo|kedu|ete sen|akwaaba|oli otya|osiibye otya|wasuze otya|gyebale(?:\s?ko)?|agandi|good (?:morning|afternoon|evening|day)|morning|evening|afternoon|greetings|yo)(?:\s+(?:again|there|charles|all|sir|madam|boss|ssebo|sebo|nnyabo|nyabo))*|i'?m back|back again|it'?s me|it'?s me again)[\s!?.,👋🙂😊]*$/iu;

/**
 * An old button tapped long after its moment. Plan buttons only when there is
 * a plan to step through: review of round 5 — offered to a person in
 * stabilising mode (or mid-build), "Next step" with no plan reset them to the
 * start of the diagnostic and silently dropped stabilising mode (rule 9).
 */
async function staleTap(biz: Business, action: string): Promise<void> {
  // Nothing was done for the tap. Which old buttons people still press, and from where.
  trackUnmet("stale_tap", { severity: "info", props: { action: action.split(":")[0], reason: "old_message", has_plan: Boolean(biz.current_plan_id) } });
  if (["plan_ready", "step_pushed", "outcome_wait", "walking"].includes(biz.stage) && biz.current_plan_id) {
    await sendButtons(biz.wa_id, "That was from when we first met — you're well past it now.", [
      { id: ACT.NEXT_STEP, title: "Next step" },
      { id: ACT.SEE_PLAN, title: "See my plan" },
    ], biz.id);
    return;
  }
  await sendText(biz.wa_id, "That button was for an earlier message — nothing's changed.", biz.id);
}

/** Anything but a whole-message yes is not a yes: "yes but it's spelt…" is a correction. */
const VOICE_YES = /^\s*(?:yes|yep|yeah|yup|correct|that'?s right|right|ok|okay|exactly|sharp|👍|👌|✅)[\s!.👍🏻🏼🏽🏾🏿]*$/iu;

async function handleDiagText(biz: Business, said: string, voice?: { lowConfidence: boolean }): Promise<void> {
  const step = biz.diag_step ?? 0;
  const q = DIAG[step];

  // A "yes" (typed, or a spoken one) to a voice note read back (below) keeps what was heard.
  // Anything else typed is their own words for the answer, and goes through
  // exactly as any typed answer would — it replaces the transcript.
  const heard = biz.pending_action?.kind === "voice_check" && biz.pending_action.step === step ? String(biz.pending_action.heard ?? "") : null;
  if (heard && VOICE_YES.test(said)) {
    await updateBusiness(biz.id, { pending_action: null });
    return advanceDiagnostic({ ...biz, pending_action: null }, heard, "voice", { readback: "confirmed" });
  }
  const how: AnswerHow = voice ? "voice" : "typed";
  const reask = (reason: string) => track("diag_reasked", { category: "behaviour", props: { step, key: q?.key, reason, how } });

  // The country list is open (askMarket) and they typed the country instead
  // of tapping it: "Uganda" answers it. Anything else is read as a new answer
  // to where they are, below, like any answer.
  const marketCheck = biz.pending_action?.kind === "market_check" && biz.pending_action.step === step ? biz.pending_action : null;
  // "yes" to "is the business in Uganda?" (the one-tap confirm) is that country.
  const guessed = marketCheck && typeof marketCheck.guess === "string" ? marketCheck.guess : null;
  const typedMarket = marketCheck ? (justACountry(said) ?? (guessed && VOICE_YES.test(said) ? guessed : null)) : null;
  if (marketCheck && guessed && /^\s*(?:no|nope|not really|another(?: country)?|somewhere else)\b/i.test(said)) {
    return marketList(biz, "Which country do you live in? I ask so the rules, grants and help lines I give you are the right ones.");
  }
  if (marketCheck && typedMarket) {
    await updateBusiness(biz.id, { pending_action: null });
    const moved = await setMarket({ ...biz, pending_action: null }, typedMarket, "typed", "country");
    return advanceDiagnostic(moved, withCountryName(String(marketCheck.location ?? ""), typedMarket), how, { market: "typed" });
  }

  if (NO_WORDS(said)) {
    reask("no_words");
    await sendText(biz.wa_id, "I need that one in words (or numbers, where there's a list) — here it is again:", biz.id);
    return askDiagQuestion(biz, step);
  }

  // Review of round 5: "Akwaaba", "Jambo", "Mambo" are greetings AND common
  // business names in Ghana and Kenya — with no way out, such a person could
  // never answer the name question. A greeting sent again, identically, at
  // the same question is taken at the person's word, like any other re-ask.
  const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  // With a voice read-back pending, the greeting is remembered on the
  // read-back itself (review, round 23: "Agandi" typed to correct a misheard
  // name was greeted forever and never taken).
  const pa = biz.pending_action;
  const greetedBefore =
    (pa?.kind === "diag_greeting" && pa.step === step && norm(String(pa.said ?? "")) === norm(said)) ||
    (pa?.kind === "voice_check" && pa.greeted != null && norm(String(pa.greeted)) === norm(said));
  if (GREETING_ONLY.test(said.trim()) && !greetedBefore) {
    reask("greeting");
    // A pending voice read-back is kept: "hi" is not an answer to it either.
    await updateBusiness(biz.id, { pending_action: biz.pending_action?.kind === "voice_check" ? { ...biz.pending_action, greeted: said } : { kind: "diag_greeting", step, said } });
    await sendText(
      biz.wa_id,
      step === 0
        ? "Hello! (If that's what you want me to call you, just send it again and I'll take it.)"
        : `Welcome back. We were on question ${step + 1} of ${DIAG_COUNT} — picking up right there. (If "${said.trim().slice(0, 40)}" was your answer, send it again.)`,
      biz.id,
    );
    return askDiagQuestion(biz, step);
  }

  // A multi-select reply that clearly picks options (numbers, "one and
  // three", "all", the option's words, "mpesa") is an answer: take it, no
  // model call at all.
  if (q?.multi && q.options && matchOptions(said, q.options).length) {
    await updateBusiness(biz.id, { pending_action: null });
    return advanceDiagnostic({ ...biz, pending_action: null }, said, how);
  }

  // A price answered with a phone number and no amount (round 24, UGp6):
  // the number is never read as money (phones.ts), and nothing else was
  // given to build on. Asked once more; sent again, it is taken as theirs.
  const pricePending = (biz.pending_action?.kind === "diag_bounce" || biz.pending_action?.kind === "diag_unmatched") && biz.pending_action?.step === step;
  if (q?.key === "price" && !pricePending && phonesIn(said).length && !figuresFrom(withoutPhones(said)).size) {
    reask("phone_number");
    const pending = { kind: "diag_unmatched", step, count: 1 };
    await updateBusiness(biz.id, { pending_action: pending });
    await sendText(biz.wa_id, "That looks like a phone number, not a price. (If it really is your answer, just send it again.)", biz.id);
    return askDiagQuestion({ ...biz, pending_action: pending }, step);
  }

  // Rule 7: a question is never an answer. And a reply to a multi-select
  // question that is not an answer at all ("xqzz flibber nonsense 99", live
  // 2026-09-22 — stored verbatim, diagnostic moved on) is not one either.
  // Both get the question asked again — but ONCE per question between them:
  // "how do I get more customers?" is a perfectly good answer to "what are
  // you trying to fix?", and a person answering in words nothing here
  // recognises has still answered. A second send is taken at their word.
  // (The two re-asks used to keep separate counters that reset each other,
  // which could hold a person on one question forever.)
  const reasked =
    (biz.pending_action?.kind === "diag_bounce" || biz.pending_action?.kind === "diag_unmatched") && biz.pending_action?.step === step;

  if (q && said && !reasked) {
    const options = q.multi && q.options ? q.options : null;
    const read = await readDiagReply(said, q.q(biz.country), options, options ? replyTouchesOptions(said, options) : true, { businessId: biz.id });
    if (read.question || !read.answer) {
      const pending = { kind: read.question ? "diag_bounce" : "diag_unmatched", step, count: 1 };
      await updateBusiness(biz.id, { pending_action: pending });
      // Kept, and answered once the plan is handed over (engine/kept.ts) —
      // round 20: "ask me it again" lost the question unless the person
      // remembered. Only a promise the code keeps is made: if it could not
      // be kept, the person is asked to send it again, as before.
      const kept = read.question ? await keepQuestion(biz, said, step) : false;
      await sendText(
        biz.wa_id,
        read.question
          ? kept
            ? "Good question — I've kept it, and I'll answer it as soon as your plan is ready, when I know your money. For now, this one (and if that WAS your answer, just send it again):"
            : "Good question — ask me it again once we're through these questions (about a minute away) and I'll answer it for your money. For now, this one (and if that WAS your answer, just send it again):"
          : "I couldn't match that to any of these. Reply with the numbers that fit (like 1, 3) — or if none of them do, say it in your own words and send it again:",
        biz.id,
      );
      await askDiagQuestion({ ...biz, pending_action: pending }, step);
      reask(read.question ? "question" : "unmatched");
      if (read.question && kept) {
        track("diag_question_kept", { props: { step, key: q.key, how }, excerpt: said });
      } else if (read.question) {
        // Not kept: the person was asked to send it again. Recorded so it is seen how often.
        trackUnmet("diag_question_deferred", {
          props: { step, key: q.key, how },
          excerpt: said,
          summary: "A person asked a question mid-diagnostic; it could not be kept, so they were asked to send it again later",
        });
      }
      return;
    }
  }

  // A voice note answering an open question is read back before it is kept.
  // Verification of 2026-09-24 (test/untested-areas.test.ts, 3e): a voice
  // note at "what's the business called?" was transcribed and stored with
  // nothing shown to the person — CLAUDE.md rule 5's own example is exactly
  // this ("laundromat" heard as "lodge"). The identity check after the
  // diagnostic catches a wrong summary, but by then a misheard NAME has
  // already fed every question since. So: always for the name (a proper noun
  // is what transcription gets wrong), and for any other open question when
  // the transcriber itself was unsure. Multi-select answers are left alone:
  // they are matched to fixed options, not kept as heard.
  if (voice && !q?.options && (step === 0 || voice.lowConfidence)) {
    await updateBusiness(biz.id, { pending_action: { kind: "voice_check", step, heard: said } });
    await sendButtons(
      biz.wa_id,
      // The whole transcript, then the question: a body over 1024 characters
      // now goes out as the transcript first and the question with the button
      // (wa.ts splitForInteractive), so nothing they said is cut to "…".
      `I heard: "${said}"\n\nIs this right? If not, type it and I'll use what you type.`,
      [{ id: ACT.VOICE_OK, title: "Yes, that's right" }],
      biz.id,
    );
    return;
  }

  await updateBusiness(biz.id, { pending_action: null });
  // A transcript read back and then answered with something else: the
  // transcription got it wrong (rule 5's "laundromat" heard as "lodge").
  await advanceDiagnostic({ ...biz, pending_action: null }, said, how, heard !== null ? { readback: "replaced" } : {});
}

type AnswerHow = "tap" | "typed" | "voice" | "statement";

/**
 * diag_answered's facts. For a fixed-choice question, the option labels it
 * picked — our own library's words, never the person's. For an open question,
 * only its length.
 */
function answerFacts(step: number, said: string): Record<string, unknown> {
  const q = DIAG[step];
  if (!q?.options) return { chars: said.trim().length };
  const t = said.trim().toLowerCase().replace(/[.!]+$/, "");
  const exact = q.options.find((o) => o.toLowerCase() === t);
  const picked = exact ? [exact] : (q.multi ? parseMultiReply(said, q.options) : matchOptions(said, q.options)).filter((o) => q.options!.includes(o));
  return picked.length ? { options: picked } : { options: [], own_words: true };
}

async function advanceDiagnostic(biz: Business, said: string, how: AnswerHow = "typed", extra: Record<string, unknown> = {}): Promise<void> {
  const step = biz.diag_step ?? 0;
  // A "question" kept at this step and now sent again is the person's answer
  // after all: off the kept list, or it is quoted back to them after the plan.
  await dropKeptAnswer(biz, step, said);
  // Where the business is decides its market, not the phone number (round
  // 24). Read in code; asked when unclear; said honestly when it is outside
  // the five. Not again for a country they picked or typed from the list.
  if (DIAG[step]?.key === "location" && !extra.market) {
    const read = marketFromLocation(said);
    if (read.outside) return outsideMarkets(biz, read.outside);
    if (!read.code) return askMarket(biz, said, read);
    biz = await setMarket(biz, read.code, "location", read.by);
  }
  const answers = recordAnswer(biz.answers ?? {}, step, said);
  // The next question not yet answered: the next one, on a first pass; on a
  // market change, only the ones asked again (reaskForMarket).
  const next = nextUnanswered(answers, step);
  const answered = () => track("diag_answered", { category: "funnel", props: { step, key: DIAG[step]?.key, how, ...answerFacts(step, said), ...extra } });

  if (next < DIAG_COUNT) {
    await updateBusiness(biz.id, { answers, diag_step: next });
    answered();
    return askDiagQuestion({ ...biz, answers, diag_step: next }, next);
  }

  await updateBusiness(biz.id, { answers, diag_step: DIAG_COUNT });
  answered();
  return finishDiagnostic({ ...biz, answers });
}

async function finishDiagnostic(biz: Business): Promise<void> {
  // A location that puts the business in another market than the one it is
  // stamped with (a diagnostic already past the location question when the
  // market began to follow it): the questions asked in the wrong market's
  // terms are asked again first.
  const placed = marketFromLocation(biz.answers?.location ?? "");
  if (placed.code && placed.code !== biz.country) return reaskForMarket(biz, placed.code, "location_check");
  await updateBusiness(biz.id, { stage: "diag_done", pending_action: { kind: "building", since: new Date().toISOString() } });
  // "Give me a moment" was followed by several minutes of silence (founder,
  // 2026-09-24). Say how long it really takes, from how long it has taken.
  const minutes = await typicalMinutes("readback_timing");
  await sendText(
    biz.wa_id,
    `Thanks — that's all the questions. I'm reading your money back to you now — ${minutes === null ? "it can take a few minutes" : `it usually takes ${minutesPhrase(minutes)}`}. Then we'll agree what you're really working towards.`,
    biz.id,
  );
  // ms is first contact to the last answer: how long the diagnostic really takes.
  const began = biz.created_at ? Date.parse(biz.created_at) : NaN;
  track("diag_completed", { category: "funnel", ms: Number.isFinite(began) ? Date.now() - began : null, props: { quoted_minutes: minutes } });
  return runReadbackStep(biz);
}

// ── The market: where the business is, not the phone number ─────
//
// Round 23, live: the market was the phone number's country code, fixed at
// the first message. A South African number with a salon in Kampala was asked
// its price "for example R150" and whether it was registered with CIPC. The
// prefix is now only the first guess, for the two questions before "Where
// are you based?"; that answer decides (location.ts), before the price and
// registration questions are asked. Everything after (answers, the plan, the
// PDF, the web page, the connector) reads businesses.country.

const MARKET_NAMES = Object.values(COUNTRIES).map((c) => c.name);
const FIVE = MARKET_NAMES.length === 1 ? MARKET_NAMES[0]! : `${MARKET_NAMES.slice(0, -1).join(", ")} and ${MARKET_NAMES.at(-1)}`;

/** The first not-yet-answered question after `step`, or DIAG_COUNT when there is none. */
function nextUnanswered(answers: Record<string, string>, step: number): number {
  for (let i = step + 1; i < DIAG_COUNT; i++) if (!(DIAG[i]!.key in answers)) return i;
  return DIAG_COUNT;
}

/** "Mamelodi" + Uganda → "Mamelodi, Uganda"; left alone when it already says so. */
function withCountryName(location: string, code: string): string {
  const name = country(code).name;
  const loc = location.trim();
  if (!loc) return name;
  return ` ${normalisePlace(loc)} `.includes(` ${normalisePlace(name)} `) ? loc : `${loc}, ${name}`;
}

/** The market this business is in, stamped on it. Every later question, answer, plan and PDF uses it. */
async function setMarket(biz: Business, code: string, via: "location" | "chosen" | "typed" | "identity_fix" | "location_check", by: string | null = null): Promise<Business> {
  const from = biz.country;
  if (code !== from) {
    await updateBusiness(biz.id, { country: code });
    setTrackContext({ country: code });
  }
  // One per business normally: how often the number and the place disagree.
  track("market_set", { category: "funnel", props: { from, to: code, changed: code !== from, via, by } });
  return { ...biz, country: code };
}

/** The five markets as list rows, the phone number's country first (a guess offered, never assumed). */
function marketRows(first: string): ListRow[] {
  const codes = Object.keys(COUNTRIES).sort((a, b) => Number(b === first) - Number(a === first));
  return [...codes.map((c) => ({ id: `a.mk.${c}`, title: COUNTRIES[c]!.name })), { id: "a.mk.other", title: "Somewhere else" }];
}

/**
 * Where they are named no place on the lists ("Town centre", a small town),
 * or places in two markets: they say, Charles never guesses. One tap when
 * the number's own country is one of the five ("Yes, Uganda"); the list of
 * the five otherwise, or when they say it is another.
 */
async function askMarket(biz: Business, location: string, read: MarketRead): Promise<void> {
  const step = biz.diag_step ?? 0;
  const guess = read.conflicting ? null : marketOfNumber(biz.wa_id);
  await updateBusiness(biz.id, { pending_action: { kind: "market_check", step, location, guess } });
  track("market_asked", { category: "behaviour", props: { reason: read.conflicting ? "two_markets" : "unclear", phone_country: marketOfNumber(biz.wa_id), shown: guess ? "confirm" : "list" } });
  const why = "I ask so the rules, grants and help lines I give you are the right ones.";
  if (guess) {
    await sendButtons(biz.wa_id, `Just to check: do you live in ${country(guess).name}? ${why}`, [
      { id: `a.mk.${guess}`, title: `Yes, ${country(guess).name}` },
      { id: "a.mk.list", title: "Another country" },
    ], biz.id);
    return;
  }
  await marketList(biz, read.conflicting ? `You've named places in more than one country. Which country do you live in? ${why}` : `Which country is that in? ${why}`);
}

async function marketList(biz: Business, body: string): Promise<void> {
  await sendList(biz.wa_id, body, "Choose country", [{ title: "Countries", rows: marketRows(marketOfNumber(biz.wa_id) ?? "") }], biz.id);
}

/**
 * A business outside the five markets is told so, once per answer, and the
 * question stays open: a place in one of the five carries on from here.
 * Nothing about fees, registration or tax there would be grounded in the
 * library (rule 10), so no plan is built on a guess.
 */
async function outsideMarkets(biz: Business, place: string | null): Promise<void> {
  await updateBusiness(biz.id, { pending_action: null });
  // Demand for a market not yet covered: what a sixth one would be.
  trackUnmet("market_outside", {
    props: { place, phone_country: biz.country },
    summary: `A person lives ${place ? `in ${placeName(place)}` : "somewhere"} outside the markets Charles knows; Charles said so and kept the location question open`,
  });
  await sendText(
    biz.wa_id,
    `${place ? `Thanks. ${placeName(place)} isn't` : "Thanks for telling me. That isn't"} one of the places I know yet. I only know the rules, grants, fees and help lines for ${FIVE}, and anything I told you about money anywhere else would be a guess. I don't guess with your money.\n\nIf you live in ${FIVE}, tell me the area and city and we'll carry on from here.`,
    biz.id,
  );
}

/** A country picked from askMarket's list. */
async function chooseMarket(biz: Business, pick: string, actionId: string): Promise<void> {
  const pending = biz.pending_action;
  if (biz.stage !== "diag" || pending?.kind !== "market_check" || pending.step !== (biz.diag_step ?? 0)) {
    if (biz.stage !== "diag") return staleTap(biz, actionId);
    await sendText(biz.wa_id, "That was for an earlier question — let's finish this one first.", biz.id);
    await askDiagQuestion(biz, biz.diag_step ?? 0);
    trackUnmet("stale_tap", { severity: "info", props: { action: actionId, reason: "earlier_question", current_step: biz.diag_step ?? 0 }, fingerprint: "stale_tap:earlier_question" });
    return;
  }
  // "Another country": the list, the question still open.
  if (pick === "list") return marketList(biz, "Which country do you live in? I ask so the rules, grants and help lines I give you are the right ones.");
  const cleared = { ...biz, pending_action: null };
  await updateBusiness(biz.id, { pending_action: null });
  if (!COUNTRIES[pick]) return outsideMarkets(cleared, null);
  const moved = await setMarket(cleared, pick, "chosen");
  return advanceDiagnostic(moved, withCountryName(String(pending.location ?? ""), pick), "tap", { market: "chosen" });
}

/** A correction that says where the person lives ("I'm in Soweto"), not only what they earn. */
function placedIn(text: string, read: MarketRead): boolean {
  const t = ` ${normalisePlace(text)} `;
  return read.places.some((p) => new RegExp(` (?:in|at|near|around|based in|located in|operating in|we are in|were in|im in|i am in) (?:the )?${p} `).test(t));
}

/**
 * The market moved after the questions whose wording depends on it were
 * asked: re-stamped, and the registration question asked again in the new
 * market's terms ("registered with URSB?", not CIPC), with the price
 * question too unless the price they gave is already in its currency. Then
 * the read-back runs again, as after any diagnostic.
 */
async function reaskForMarket(biz: Business, code: string, via: "identity_fix" | "location_check", location?: string): Promise<void> {
  const was = country(biz.country);
  const now = country(code);
  const answers = { ...(biz.answers ?? {}) };
  if (location) answers.location = location;
  const again: string[] = [];
  // Money answers given in another currency are asked again in this one.
  for (const key of ["income", "owes", "cushion"]) {
    if (key in answers && !now.moneyRe.test(answers[key] ?? "")) {
      delete answers[key];
      again.push(key);
    }
  }
  const moved = await setMarket(biz, code, via);
  const first = DIAG.findIndex((q) => !(q.key in answers));
  track("market_reasked", { category: "funnel", props: { from: was.code, to: now.code, via, again } });
  if (first < 0) {
    await updateBusiness(biz.id, { answers });
    return finishDiagnostic({ ...moved, answers });
  }
  await updateBusiness(biz.id, { answers, stage: "diag", diag_step: first, pending_action: null, pending_goal_options: null });
  const n = DIAG.filter((q) => !(q.key in answers)).length;
  await sendText(
    biz.wa_id,
    `Got it: you live in ${now.name}, not ${was.name}. That changes the rules, grants and help lines I'll give you, so ${n === 1 ? "one question" : n === 2 ? "two questions" : `${n} questions`} again, for ${now.name}:`,
    biz.id,
  );
  return askDiagQuestion({ ...moved, answers, stage: "diag", diag_step: first, pending_action: null }, first);
}

// ── The transient build stages ───────────────────────────────────

async function handleBuilding(biz: Business): Promise<void> {
  // The plan build has its own, finer-grained resume logic below — see
  // handleBuildingPlan for why STALE_BUILD_MS's flat restart-from-scratch is
  // wrong for it specifically.
  if (biz.stage === "building_plan") return handleBuildingPlan(biz);

  const since = biz.pending_action?.since as string | undefined;
  const age = since ? Date.now() - new Date(since).getTime() : Number.POSITIVE_INFINITY;

  if (age < STALE_BUILD_MS) {
    // Not "one minute": nobody knows that. The read-back's own history does.
    const left = biz.stage === "diag_done" ? await remainingPhrase("readback_timing", since) : null;
    await sendText(biz.wa_id, `Still on it${left ? ` — ${left}` : ""}. I'll message you the moment it's ready.`, biz.id);
    return;
  }

  // The build died. Pick it up from where it stopped rather than stranding them.
  console.log(`build stalled at stage ${biz.stage} for ${biz.wa_id}, restarting`);
  // A build confirmed on the way out of stabilising mode keeps that clearance.
  await updateBusiness(biz.id, {
    pending_action: { kind: "building", since: new Date().toISOString(), ...(biz.pending_action?.distress_cleared === true ? { distress_cleared: true } : {}) },
  });
  // Only the person's own message noticed: they had been waiting on a build
  // that was dead. The dead job is its own alert (job_dead); the plan build's
  // equivalent is plan_build_resumed (planbuild.ts).
  trackFailure("build_restarted", `build stalled at ${biz.stage}`, {
    severity: "warn",
    alert: "digest",
    ms: Number.isFinite(age) ? age : null,
    props: { phase: biz.stage === "building_rule" ? "angle" : "readback", reason: "stalled" },
    fingerprint: `build_restarted:stalled:${biz.stage}`,
    summary: `A person's ${biz.stage === "building_rule" ? "rule options" : "read-back"} build had stalled for over ${Math.round(STALE_BUILD_MS / 60_000)} minutes and was restarted when they messaged`,
  });
  if (biz.stage === "building_rule") return runRuleStep(biz);
  return runReadbackStep(biz);
}

/**
 * Incident, 2026-09-22: the plan build used to be one function call doing
 * five or six model calls back to back, so "stalled" only ever had one
 * remedy — redo the whole thing. It is now a resumable state machine
 * (engine/planbuild.ts, db/0012_plan_build_stages.sql): `plan_builds` knows
 * exactly which phase actually finished, so a message arriving mid-build
 * checks THAT instead of the flat pending_action.since clock. A fresh
 * heartbeat means a stage is genuinely in flight somewhere — say so
 * honestly, touch nothing. A stale or missing one means resume from
 * wherever it actually got to, never from "context" again.
 */
const RECENT_HEARTBEAT_MS = 60_000;

async function handleBuildingPlan(biz: Business): Promise<void> {
  const pb = await getPlanBuild(biz.id);
  // A failed build is not "still going", however fresh its heartbeat
  // (failPlanBuild touches it): pick it back up from its saved work.
  if (pb?.stage === "failed") {
    await sendText(biz.wa_id, "Picking that back up now.", biz.id);
    return resumePlanBuild(biz);
  }
  const inFlight =
    pb !== null &&
    pb.stage !== "done" &&
    (Date.now() - new Date(pb.heartbeat_at).getTime() < RECENT_HEARTBEAT_MS || (await planBuildStageInFlight(biz.id).catch(() => false)));
  if (inFlight) {
    const left = await remainingPhrase("plan_build_timing", pb.created_at);
    await sendText(biz.wa_id, `Still putting it together — ${buildProgressText(pb)}.${left ? ` ${left[0]!.toUpperCase()}${left.slice(1)}.` : ""}`, biz.id);
    return;
  }
  console.log(`plan build stalled at plan_builds.stage=${pb?.stage ?? "(none)"} for ${biz.wa_id}, resuming`);
  await sendText(biz.wa_id, "Picking that back up now.", biz.id);
  await resumePlanBuild(biz);
}

// ── Stabilising mode, which must have a way out ──────────────────

/**
 * The first version re-ran the distress check against the SAME stored
 * diagnostic answers on every message, so the verdict could never change and
 * a struggling owner was locked out of the product permanently. What they say
 * now is new evidence, and it is treated as such.
 *
 * Live test, 2026-09-25, the same trap from two more directions. The check
 * was still handed ALL of biz.answers — the diagnostic included, with its
 * "cash is tight" blocker — so "not struggling any more" was near enough
 * unreachable; and EVERY message, "how do I get more customers" included,
 * got the one fixed sentence. Now: a message that is not about the money
 * situation at all is an ordinary question and gets a real answer (with the
 * stabilising rules in its prompt — see buildCore); a message that is
 * about it goes to the exit check, which reads only the words said since
 * stabilising began. The fixed sentence is for a message that is itself
 * about the money trouble, and nothing else.
 */
/** pending_action while the "sounds steadier — build the plan now?" offer is open. */
const STABILISING_EXIT_OFFERED = "stabilising_exit_offered";

async function handleStabilizing(biz: Business, said: string): Promise<void> {
  // Keep the NEWEST words, not the oldest. Appending and then slicing from the
  // front meant that once the accumulated text passed 2000 characters, what the
  // owner had just said was cut off — including "I've paid the rent, the debt
  // is cleared, I want the plan now". The check then ran forever on a frozen
  // blob from the worst week of their year, and stabilising mode had no exit.
  const history = [biz.answers?.since_stabilising, said].filter(Boolean).join(" | ");
  const answers = {
    ...(biz.answers ?? {}),
    since_stabilising: history.length > 2000 ? `…${history.slice(-2000)}` : history,
  };
  await updateBusiness(biz.id, { answers });

  const { checkStillDistressed, aboutTheMoney } = await import("../safety.js");

  // "What's next?" typed is the "Next step" button in words (rule 7), and
  // the button is held while stabilising (rule 9). Round 27 (KE, live): the
  // typed ask went to the answer model and got plan step 2. Now it gets the
  // stabilising work instead, from fixed words, never a plan step.
  if (ASKS_FOR_NEXT_STEP.test(said) && !aboutTheMoney(said)) {
    trackUnmet("plan_held_stabilising", { severity: "info", props: { what: "typed_next", has_plan: Boolean(biz.current_plan_id) } });
    await sendText(biz.wa_id, nextWhileStabilising(biz.country, Boolean(biz.current_plan_id)), biz.id);
    await recordSafetyEvent({ businessId: biz.id, check: "distress", engine: "none", outcome: "block", flags: ["plan_held", "typed_next"], detail: `typed next-step ask while stabilising; plan held: ${said.slice(0, 120)}` });
    return;
  }

  // Decided in code, before any model: only the person's own money or
  // recovery language makes a message about the money situation. A question
  // with a pleasantry in front ("I'm fine thanks, how do I register for
  // VAT?") is a question, and gets a real answer under the stabilising rules;
  // only a message that is itself about the money, or about recovery, goes
  // to the exit check (aboutTheMoney in safety.ts).
  if (!aboutTheMoney(said)) {
    return answer({ ...biz, answers }, said);
  }

  const stillStruggling = await checkStillDistressed(answers.since_stabilising, said, { businessId: biz.id });

  if (stillStruggling) {
    // Any exit offered earlier is withdrawn: an old "Yes, build it" tapped
    // now must not carry the clearance that offer gave.
    if (biz.pending_action?.kind === STABILISING_EXIT_OFFERED) await updateBusiness(biz.id, { pending_action: null });
    await sendText(
      biz.wa_id,
      "Understood. Same advice while it's this tight: food, rent and transport first, no new borrowing, nothing that costs money. I'm here — tell me when it steadies and we'll build forward.",
      biz.id,
    );
    await updateMemory({ ...biz, answers }, said, "stabilising");
    // The exit check's verdict, each time a person in stabilising mode talks about the money.
    track("stabilising_checked", { category: "behaviour", props: { steadier: false, offer_withdrawn: biz.pending_action?.kind === STABILISING_EXIT_OFFERED } });
    return;
  }

  // Ask, and then actually wait for the answer. Asking and building in the same
  // breath would make the question decorative, and this is precisely the person
  // who should not be pushed into anything. The marker is what lets their
  // "Yes, build it" skip the diagnostic-wide distress gate (ACT.BUILD_NOW).
  await updateBusiness(biz.id, { pending_action: { kind: STABILISING_EXIT_OFFERED, at: new Date().toISOString() } });
  // Live test, round 11: a person who went into stabilising mode with a plan
  // already built was offered "build you the 90-day plan now?". The tap did
  // the right thing (ACT.BUILD_NOW keeps an existing plan), but the offer
  // said it would build a new one. Say what will actually happen.
  const hasPlan = Boolean(await (await import("../db.js")).planFor(biz.id));
  await sendButtons(
    biz.wa_id,
    hasPlan
      ? "That sounds steadier than when we last spoke. Want to pick your 90-day plan back up where you left it?"
      : "That sounds steadier than when we last spoke. Want me to build you the 90-day plan now?",
    [
      { id: ACT.BUILD_NOW, title: hasPlan ? "Back to my plan" : "Yes, build it" },
      { id: ACT.PAUSE_NUDGES, title: "Not yet" },
    ],
    biz.id,
  );
  // The way out offered. Taking it is stage_entered (stabilizing → plan_ready or diag_done).
  track("stabilising_checked", { category: "behaviour", props: { steadier: true, has_plan: hasPlan } });
}

// ── Identity, customers, angle ───────────────────────────────────

// ── The wait between "That's right" and the customer options ────

/**
 * Explicit correction language — the only typed thing that undoes a
 * "That's right" while the options are on their way. A leading no (not "no
 * worries"), "not quite", "wrong", "actually", "it's actually …", or the person
 * restating what they run or sell.
 */
const CORRECTS_IDENTITY = new RegExp(
  [
    String.raw`^\s*(?:no|nope|nah)\b(?!\s*(?:worries|problem|probs|stress|rush|hurry|pressure|biggie)\b)`,
    String.raw`^\s*(?:not\s+(?:quite|really|right|exactly|correct)|wrong|incorrect|that'?s\s+(?:not|wrong)|that\s+is\s+(?:not|wrong)|actually)\b`,
    String.raw`\b(?:it'?s|it\s+is|we'?re|we\s+are|i'?m|i\s+am)\s+actually\b`,
    String.raw`^\s*(?:i|we)\s+(?:run|own|sell|make|fix|repair)\s+(?:a|an|the)?\s*\w`,
    // naming a different trade: "it's a laundromat, not a salon"
    String.raw`^\s*(?:it'?s|it\s+is|we'?re|we\s+are)\s+(?:a|an)\s+[\w' -]+?,?\s+not\s+(?:a|an)\s+\w`,
    String.raw`\bnot\s+(?:a|an)\s+[\w'-]+\s*(?:,|;|—|-|\.)\s*(?:it'?s|we'?re|i'?m|i\s+run|we\s+run)\b`,
  ].join("|"),
  "i",
);

/** A question about the wait itself — answered by the wait's own progress line. */
const ABOUT_THE_WAIT = /\b(how\s+long|when|ready|still|wait|waiting|done\s+yet|nearly|taking|finished|coming)\b/i;

const STILL_ON_IT = "Still on it — who you could aim at is nearly ready. I'll send it here the moment it's done.";

/**
 * Review of round 10: the person tapped "That's right" while the options job
 * was still running, got the holding line ("I'll send it here the moment
 * it's done"), and typed what that line invites — "thanks", "1", "how long
 * will it take?". Every one of those was taken as an identity correction:
 * written into answers.business and identity.sells, the confirmed read-back
 * thrown away, and the options in flight discarded on the cleared token.
 *
 * They have ALREADY confirmed. So: options stored → deliver them. A clear
 * correction → the identity-fix path, as a "Not quite" would. A question →
 * a real answer, then the short holding line (a question about the wait is
 * answered by the holding line itself). Anything else — yes, ok, thanks, a
 * number — gets the short line, never written anywhere.
 */
async function handleOptionsWait(biz: Business, said: string, attachment?: AttachmentRead): Promise<void> {
  if (biz.pending_goal_options?.token && biz.pending_goal_options.options?.length) return showGoalOptions(biz);

  if (CORRECTS_IDENTITY.test(said)) {
    await updateBusiness(biz.id, { stage: "identity_fix", pending_goal_options: null, pending_action: null });
    return handleIdentityFix({ ...biz, stage: "identity_fix", pending_goal_options: null, pending_action: null }, said, "while_options_wait");
  }

  if (readsAsQuestion(said) && !ABOUT_THE_WAIT.test(said)) {
    await answer(biz, said, attachment);
    // The answer can have moved the business (into stabilising mode, say);
    // only a business still waiting hears about the options.
    const fresh = await findBusinessById(biz.id);
    if (!fresh || fresh.stage !== "confirm_identity" || fresh.pending_action?.kind !== "goal_options_wait") return;
    return nudgeOptionsWait(fresh);
  }
  return nudgeOptionsWait(biz);
}

async function nudgeOptionsWait(biz: Business): Promise<void> {
  const pending = biz.pending_goal_options ?? null;
  if (pending?.token && pending.options?.length) return showGoalOptions(biz);
  // The job is gone and nothing cleared the marker: the person has already
  // confirmed, so redo the options here (showGoalOptions does it inline).
  if (!pending?.token || !(await goalOptionsInFlight(biz.id, pending.token).catch(() => true))) {
    await updateBusiness(biz.id, { pending_action: null });
    // A dead job is its own alert (job_dead); this is the person still waiting on it.
    trackFailure("build_restarted", "goal options job gone while the person waited", {
      severity: "warn",
      alert: "digest",
      props: { phase: "goal_options", reason: pending?.token ? "job_gone" : "no_token" },
      fingerprint: `build_restarted:goal_options:${pending?.token ? "job_gone" : "no_token"}`,
      summary: "A person had confirmed their read-back but the customer options job was gone; the options were redone inline",
    });
    return showGoalOptions({ ...biz, pending_action: null });
  }
  await sendText(biz.wa_id, STILL_ON_IT, biz.id);
}

/** Is the pending_action after an answer still the hold that was waiting before it? */
function sameHold(now: Business["pending_action"], before: Business["pending_action"]): boolean {
  if (!now || !before || now.kind !== before.kind) return false;
  if (before.change_id !== undefined && now.change_id !== before.change_id) return false;
  if (before.awaiting !== undefined && now.awaiting !== before.awaiting) return false;
  return JSON.stringify(now.options ?? null) === JSON.stringify(before.options ?? null);
}

/** How a correction to the read-back arrived: after "Not quite", typed in place of a tap, or after "That's right". */
type CorrectedVia = "after_not_quite" | "typed_instead" | "while_options_wait";

async function handleIdentityFix(biz: Business, said: string, via: CorrectedVia): Promise<void> {
  const identity = { ...(biz.identity ?? {}), earns: said, one_liner: said, unsure: null };
  const answers = { ...(biz.answers ?? {}), income_kind: said };
  // "I'm in Durban, not Joburg": the correction moves the person to another
  // market. Only a place said AS where they live ("in", "based in").
  const read = marketFromLocation(said);
  if (read.code && read.code !== biz.country && placedIn(said, read)) {
    await updateBusiness(biz.id, { identity });
    track("identity_corrected", { category: "funnel", props: { via, chars: said.trim().length, market_moved: true } });
    const where = read.places.find((p) => !["south africa", "rsa", "mzansi"].includes(p));
    return reaskForMarket({ ...biz, identity, answers }, read.code, "identity_fix", withCountryName(where ? placeName(where) : "", read.code));
  }
  await updateBusiness(biz.id, { identity, answers, stage: "diag_done", pending_action: { kind: "building", since: new Date().toISOString() } });
  track("identity_corrected", { category: "funnel", props: { via, chars: said.trim().length } });
  return runReadbackStep({ ...biz, identity, answers }, said);
}

/** Facts for goal_picked / rule_picked: 1-based positions, never the labels. */
function pickFacts(picked: number[], count: number): Record<string, unknown> {
  const valid = picked.filter((i) => i >= 0 && i < count);
  return { count, picked: valid.map((i) => i + 1), n_picked: valid.length };
}

async function handleChooseGoal(biz: Business, said: string): Promise<void> {
  const options = (biz.pending_goal_options?.options ?? []).slice(0, MAX_GOAL_OPTIONS);
  if (!options.length) {
    trackFailure("build_restarted", "no goal options stored at choose_goal", {
      severity: "warn",
      alert: "digest",
      props: { phase: "goal_options", reason: "options_missing" },
      fingerprint: "build_restarted:goal_options:options_missing",
      summary: "A person answered a goal choice whose options were missing; the goal step was run again",
    });
    return runReadbackStep(biz);
  }

  const labels = options.map((o) => o.label);
  const picked = await pickOptions(biz, said, labels);
  // Never default to the first option. The goal the person is working
  // towards is the single decision the whole plan is built on — guessing it
  // wrong and carrying on is worse than asking twice.
  if (!picked) return askAgain(biz, "goal", labels);

  const goal = picked.map((i) => options[i]).filter(Boolean) as GoalOptionList;
  if (!goal.length) return askAgain(biz, "goal", labels);

  await updateBusiness(biz.id, { goal, stage: "building_rule", pending_action: { kind: "building", since: new Date().toISOString() } });
  track("goal_picked", { category: "funnel", props: pickFacts(picked, options.length) });
  return runRuleStep({ ...biz, goal, stage: "building_rule" });
}

async function handleChooseRule(biz: Business, said: string): Promise<void> {
  const options = biz.pending_rule_options?.options ?? [];
  if (!options.length) {
    trackFailure("build_restarted", "no rule options stored at choose_rule", {
      severity: "warn",
      alert: "digest",
      props: { phase: "rule", reason: "options_missing" },
      fingerprint: "build_restarted:rule:options_missing",
      summary: "A person answered a rule choice whose options were missing; the rule step was run again",
    });
    return runRuleStep(biz);
  }

  const labels = options.map((o) => o.label);
  const picked = await pickOptions(biz, said, labels);
  if (!picked) return askAgain(biz, "rule", labels);

  const rule = picked.map((i) => options[i]).filter(Boolean) as RuleOptionList;
  if (!rule.length) return askAgain(biz, "rule", labels);

  await updateBusiness(biz.id, { rule, stage: "building_plan", pending_action: { kind: "building", since: new Date().toISOString() } });
  track("rule_picked", { category: "funnel", props: pickFacts(picked, options.length) });
  // Founder, 2026-09-24: "a minute or two", then "Won't be long", then a long
  // wait, was anticlimactic. One message, the honest wait from recent builds
  // (eta.ts), and nothing else until the plan itself arrives.
  const minutes = await typicalMinutes("plan_build_timing");
  await sendText(
    biz.wa_id,
    `That's your rule, then:\n\n${rule.map((o) => `"${o.rule}"`).join("\n")}\n\n` +
      `Now I'm writing your full 90-day money plan. ${minutes === null ? "It takes a few minutes" : `It usually takes ${minutesPhrase(minutes)}`}. I'll send it here the moment it's ready — there's nothing you need to do until then.`,
    biz.id,
  );
  return startPlanBuild({ ...biz, rule, stage: "building_plan" });
}

/**
 * Read a selection the way a person writes one.
 *
 * `null` back means nobody chose anything and we should ask again rather than
 * guess. The distinction between "the judge ran and found no choice" and "no
 * judge was available" is load-bearing: only in the second case is it safe to
 * grep numerals out of the message, because in the first the numeral is
 * probably part of a question about the options.
 */
async function pickOptions(biz: Business, said: string, labels: string[]): Promise<number[] | null> {
  const judged = await resolveSelection(said, labels, { businessId: biz.id });
  if (judged !== null) return judged.length ? judged : null;

  // No engine available: fall back to digits, but only when the reply reads as
  // a choice rather than as a sentence containing a number.
  const looksLikeAChoice = said.trim().length <= 40 && !/\?/.test(said);
  if (!looksLikeAChoice) return null;
  const digits = [...said.matchAll(/\d+/g)]
    .map((m) => parseInt(m[0]!, 10) - 1)
    .filter((i) => i >= 0 && i < labels.length);
  return digits.length ? [...new Set(digits)] : null;
}

/** When we genuinely could not tell, say so instead of choosing for them. */
async function askAgain(biz: Business, what: string, labels: string[]): Promise<void> {
  await sendText(
    biz.wa_id,
    `I didn't catch which ${what} you meant. Reply with the number — or the numbers, if more than one fits:\n\n${labels.map((l, i) => `${i + 1}. ${l}`).join("\n")}`,
    biz.id,
  );
  trackUnmet("choice_unclear", { props: { what, count: labels.length }, fingerprint: `choice_unclear:${what}`, summary: `A person's reply could not be read as a ${what} choice; the list was sent again` });
}

// ── The person's own AI ───────────────────────────────────────────

/**
 * Founder, 2026-09-24: most people have never heard of a connector, so say
 * what it does before how, and send the address on its own so it copies
 * cleanly. Menu names in both apps move, so the steps say what to look for.
 */
function howToConnect(address: "the address I'm about to send" | "your private address"): string {
  return (
    "Here's what this does: it lets ChatGPT or Claude read your money picture and your 90-day plan — what comes in, what you owe, your goal, your rule, your steps and how far you've got. Then you can ask it anything and it already knows your situation.\n\n" +
    "You can work through your plan there too: it can show you the step you're on, tick it off when you've done it, note a decision or a reminder, and remember things you tell it about how you work, so I know them here as well. It can't change your plan on its own — if it suggests a change, I ask you here first.\n\n" +
    "How to add it (on a computer is easiest):\n\n" +
    `In Claude: Settings → Connectors → Add custom connector. Name it Charles, paste ${address}, and save. In a new chat, switch Charles on and ask "What do you know about my money?"\n\n` +
    `In ChatGPT: Settings → Apps & Connectors, and add a custom connector (ChatGPT may ask you to turn on developer mode first, and may need a paid plan). Name it Charles and paste ${address}.\n\n` +
    "The menus change names now and then — if yours look different, look for \"connectors\" in Settings."
  );
}

/**
 * "connect". A person with no address gets the how-to and a fresh one. An
 * owner who already has one is NOT given a new one on the spot: a new
 * address switches the old one off in every app it was added to, and the
 * hand-over and plan document are read by connected people too. They get the
 * how-to and a choice; only "New address" replaces it.
 */
async function sendConnectorLink(biz: Business, opts: { replace?: boolean } = {}): Promise<void> {
  const { env } = await import("../env.js");
  if (!env.PUBLIC_BASE_URL || !env.SESSION_SECRET) {
    // No "I'll tell you the moment it is": nothing would. The team is told
    // (connector_link_failed, emailed at once).
    await sendText(biz.wa_id, "That isn't switched on yet — I've let the team know. Try \"connect\" again in a day or two.", biz.id);
    // Nothing tells them later, so the promise rests on someone reading this.
    trackFailure("connector_link_failed", `${!env.PUBLIC_BASE_URL ? "PUBLIC_BASE_URL" : "SESSION_SECRET"} is not set`, {
      props: { reason: "not_configured", replace: Boolean(opts.replace) },
      fingerprint: "connector_link_failed:not_configured",
      summary: "A person asked to connect their AI, but PUBLIC_BASE_URL or SESSION_SECRET is not set; they were told it isn't switched on yet",
    });
    return;
  }
  // Fail closed: if we can't tell whether they are connected, never risk
  // switching off an address they are using.
  let live: boolean;
  try {
    live = opts.replace ? true : await hasLiveConnector(biz.id);
  } catch (err) {
    console.log("sendConnectorLink: could not check for a live address", err);
    await sendText(biz.wa_id, "That didn't come through on my side. Send \"connect\" again in a minute.", biz.id);
    trackFailure("connector_link_failed", err, {
      props: { reason: "lookup_failed", replace: Boolean(opts.replace) },
      fingerprint: "connector_link_failed:lookup_failed",
      summary: "A person asked to connect their AI, but whether they already had an address could not be checked; no address was sent",
    });
    return;
  }
  if (live && !opts.replace) {
    await sendText(biz.wa_id, howToConnect("your private address"), biz.id);
    await sendButtons(
      biz.wa_id,
      "You already have a private address, and it's working: whatever you've added it to reads your money picture and plan live, so there's nothing to update.\n\n" +
        "Adding it to another app? It's in our chat — search this chat for \"private address\" and use the most recent one.\n\n" +
        "Only get a new one if you've lost it or think someone else has it. The old one stops working everywhere, straight away.",
      [
        { id: ACT.CONNECT_KEEP, title: "Keep mine" },
        { id: ACT.CONNECT_NEW, title: "New address" },
      ],
      biz.id,
    );
    return;
  }
  const url = await issueConnectorToken(biz.id);
  if (!url) {
    await sendText(biz.wa_id, "That didn't come through on my side. Send \"connect\" again in a minute.", biz.id);
    // Why is logged where it happened (connector.ts); this is the person left without one.
    trackFailure("connector_link_failed", "no address could be issued", {
      props: { reason: "issue_failed", replace: live },
      fingerprint: "connector_link_failed:issue_failed",
      summary: "A person asked for an address for their AI and none could be issued; they were asked to try again",
    });
    return;
  }
  if (!live) await sendText(biz.wa_id, howToConnect("the address I'm about to send"), biz.id);
  await sendText(
    biz.wa_id,
    live
      ? `Your new private address:\n\n${url}\n\nYour old address has stopped working. Paste this one wherever you had it — Claude, ChatGPT or both. Treat it like a password: anyone who has it can read your money picture.`
      : `Your private address:\n\n${url}\n\nTreat it like a password — anyone who has it can read your money picture. Using Claude and ChatGPT both? Paste this same address into each. Lost it, or think someone else has it? Send "connect" and I'll replace it.`,
    biz.id,
  );
  // The address itself is a secret and never goes in an event.
  track("connector_linked", { category: "behaviour", props: { replaced: live } });
}

/**
 * A critical fact suggested by the person's own AI never silently changes the
 * plan. It waits here for a yes.
 */
async function decideProposedChange(biz: Business, accept: boolean, how: "tap" | "typed"): Promise<void> {
  const changeId = biz.pending_action?.change_id as string | undefined;
  const { db } = await import("../db.js");
  if (!changeId) {
    // The proposal expired, or this is a tap on an old card. Saying so is the
    // minimum: going silent is indistinguishable from being broken.
    await updateBusiness(biz.id, { stage: "plan_ready", pending_action: null });
    await sendButtons(
      biz.wa_id,
      "There's nothing waiting for a yes or no right now — that one's already been dealt with.",
      [{ id: ACT.NEXT_STEP, title: "Next step" }],
      biz.id,
    );
    trackUnmet("stale_tap", { severity: "info", props: { action: accept ? ACT.CHANGE_YES : ACT.CHANGE_NO, reason: "no_change_waiting", how }, fingerprint: "stale_tap:no_change_waiting" });
    return;
  }

  const { data, error: readError } = await db().from("proposed_changes").select("*").eq("id", changeId).maybeSingle();
  if (readError) console.warn("decideProposedChange: could not read the proposed change", readError);
  const change = data as { fact: string; to_value: string; from_value: string } | null;

  const { error: decideError } = await db()
    .from("proposed_changes")
    .update({ status: accept ? "accepted" : "rejected", decided_at: new Date().toISOString() })
    .eq("id", changeId);
  if (decideError) console.error("decideProposedChange: could not record the decision", decideError);

  // A change to the plan's STEPS the person asked their AI for (connector.ts
  // request_plan_change), now said yes to here: applied exactly as if they
  // had typed it after "Change my plan", so the same checks hold (only the
  // library's own tools, the step settled from their words, a question when
  // it is not clear). Never written into the business facts.
  if (accept && change?.fact === "plan_steps") {
    const pending = { kind: "change" };
    await updateBusiness(biz.id, { stage: "changing", pending_action: pending });
    track("plan_change_requested", { props: { phase: "from_connector", how } });
    return applyChange({ ...biz, stage: "changing", pending_action: pending }, change.to_value);
  }

  if (accept && change) {
    const context = { ...(biz.context ?? {}), [change.fact]: change.to_value };
    await updateBusiness(biz.id, { context });
    const { logDecision } = await import("../db.js");
    await logDecision(biz.id, `Changed ${change.fact} from "${change.from_value}" to "${change.to_value}"`, "confirmed on WhatsApp", "connector");
    // The fact's name (what they sell, the pricing model…), never its value.
    track("plan_change_applied", { category: "behaviour", props: { source: "connector", fact: change.fact, how } });
  }

  await updateBusiness(biz.id, { stage: "plan_ready", pending_action: null });
  await sendButtons(
    biz.wa_id,
    accept ? "Updated. I'll use that from now on." : "Left as it was.",
    [{ id: ACT.NEXT_STEP, title: "Next step" }],
    biz.id,
  );
  // A yes with no change behind it is still answered "Updated" — and nothing was.
  if (accept && !change) {
    trackFailure("plan_change_failed", readError ?? "the proposed change was not found", {
      props: { source: "connector", reason: readError ? "read_failed" : "not_found", how },
      fingerprint: `plan_change_failed:connector:${readError ? "read_failed" : "not_found"}`,
      summary: "A person said yes to a change their AI suggested, was told it was updated, and nothing was changed (the proposal could not be read)",
    });
  }
}

/**
 * How a typed reply to "has it made a difference?" reads. Order matters:
 * "too early" first ("not yet, too early to tell"), then the positives that
 * contain a negative word ("not bad at all", "no complaints"), then plain
 * negatives ("no, nothing more yet" contains "more"), then positives.
 */
export function typedOutcome(said: string): "better" | "same" | "too_early" {
  const t = said.toLowerCase();
  if (/\b(too early|not yet|early days|too soon|give it time|wait and see)\b/.test(t)) return "too_early";
  if (/\b(not bad|no complaints|no problems?|can'?t complain|never better)\b/.test(t)) return "better";
  if (/\b(no|not|nothing|same|worse|didn'?t|hasn'?t|haven'?t|no change)\b/.test(t)) return "same";
  if (/\b(better|more|up|working|worked|yes|busier|improved|great|good)\b/.test(t)) return "better";
  return "too_early";
}

/** Shaped like a question: ends in "?" or opens with a question word. */
export function readsAsQuestion(said: string): boolean {
  const t = (said || "").trim();
  return /\?\s*$/.test(t) || /^(how|what|when|where|why|who|which|can|could|should|would|do|does|did|is|are|will|am)\b/i.test(t);
}

export const CHANGE_WORDS = /\b(swap|chang|drop|remov|move|skip|replac|instead|different|order|tool|step|part|plan|first|before|after|later|earlier|rather|prefer|not do|don'?t (want|do)|leave out|cut)\w*/i;

/** A reply that is nothing BUT a yes (a few polite words allowed). */
export const CLEAR_YES = /^\s*(yes|yep|yeah|yup|ok|okay|sure|do it|go ahead|go for it|please do|update it|correct|that'?s right)([\s,!.]+(please|thanks|thank you|do it|update it|go ahead|yes))*[\s!.]*$/i;
/** A reply that is nothing BUT a no. */
export const CLEAR_NO = /^\s*(no|nope|nah|leave it|don'?t|do not|keep it|cancel|no thanks)([\s,!.]+(thanks|thank you|keep it|leave it|leave it as it is|as it is|don'?t|no))*[\s!.]*$/i;

/** Words that tie a message to the screen or line someone is on right now. */
const ON_STEP = /\b(this|that|it|here|step|line|screen|button|page|form|field|box|option|menu|tab|code|otp|sign[ -]?(in|up)|log[ -]?in|password|verify|verification|upload|app|link|next|category|address|approv\w*|photo|picture|type|enter|fill|pick|choose|select|click|tap|profile|account|email|username|number)\b/i;

/**
 * An open question typed mid-walkthrough that is NOT about the step being
 * walked through: question-shaped, no word that points at the current
 * screen, and nothing from the step's title or its tool's name.
 */
export async function isOffStepQuestion(biz: Business, said: string): Promise<boolean> {
  if (!readsAsQuestion(said) || ON_STEP.test(said)) return false;
  const { planFor, toolById } = await import("../db.js");
  const stepId = biz.walk?.step_id ?? (biz.pending_action?.step_id as string | undefined);
  const step = stepId ? (await planFor(biz.id))?.steps.find((s) => s.id === stepId) : undefined;
  const tool = biz.walk?.tool_id ? await toolById(biz.walk.tool_id, biz.country) : null;
  const lower = said.toLowerCase();
  // The walkthrough line they are looking at counts too: "how long until
  // I'm verified?" is about THAT line, whatever the step is called.
  const line = tool?.walkthrough?.[biz.walk?.index ?? 0] ?? "";
  const stepWords = `${step?.title ?? ""} ${tool?.name ?? ""} ${line}`.toLowerCase().match(/[a-z]{5,}/g) ?? [];
  const common = new Set(["business", "about", "their", "there", "which", "would", "could", "should", "where", "while", "until", "after", "before"]);
  return !stepWords.some((w) => !common.has(w) && lower.includes(w));
}
