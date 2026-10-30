// Fin — answering whatever the person sends once they have a plan.
//
// Three paths, chosen by a cheap router: a question about their money, a
// forwarded link, letter or message ("is this legit? what does this mean for
// me?"), or something they are telling us that changes what we know. All
// three end the same way: one recommendation, grounded only in the
// shortlist, checked before it is sent, and then the memory is updated from
// what the PERSON said — never from what Fin suggested.

import { askJSON, describeModelCall, traceModelCalls, type ModelCallTrace } from "../models.js";
import { answerPrompt, contextUpdatePrompt, forwardPrompt, routerPrompt } from "../prompts.js";
import { businessKnownFacts, checkMessageDistress, checkReply, saysMoneyTrouble, stabilizingMessage, WRITE_REQUEST } from "../safety.js";
import { scamWarning, scoreScam, withScamAdvisor } from "../judgement.js";
import { guardReplyContacts } from "../contacts.js";
import { country } from "../countries.js";
import { sendText } from "../wa.js";
import type { AttachmentRead } from "../attachments.js";
import { ACT } from "../actions.js";
import { buildCore, contextSummary, dateSources, figuresAskedAbout, loadCoreData } from "./context.js";
import { ARTIFACT_KIND, fitQuickReplies, sendReply, tidy, withoutInventedExamples } from "./steps.js";
import { addCommitment, addOwnerNote, logDecision, logOutcome, openCommitments, recordSafetyEvent, SECRET_DETAIL, signalLibraryFor, updateBusiness, db } from "../db.js";
import { captureConversationSignal } from "../signals.js";
import { trimYesNo } from "../yesno.js";
import { ownFigures, scrubMoneySlots, checkDaysOf, stampLibraryFigures, stripCopiedStamps } from "../pricestamp.js";
import { dropUngroundedDates } from "../datecheck.js";
import { figuresFrom, moneyIn } from "../grounding.js";
import { jobCtx, onLastAttempt } from "../jobctx.js";
import { errorText, normaliseForFingerprint, track, trackFailure, trackUnmet } from "../track.js";
import type { Business, MapEntry, PlanStepRow, Reply } from "../types.js";
import type { SignalSource } from "../db.js";

/**
 * A model-written label (the router's intent, domain and risk, a reply's
 * tool id) as an event prop: kept when it looks like a label, "other" when
 * it does not. The router is asked for enums, but a model that echoed the
 * owner's words into one would otherwise put them in props.
 */
const asLabel = (x: unknown): string | null => (x == null ? null : /^[a-z0-9][a-z0-9_.:-]{0,63}$/i.test(String(x)) ? String(x) : "other");

/** Stages before a plan exists, where a "Next step" button has nothing to push. */
const PRE_PLAN_STAGES: ReadonlySet<string> = new Set(["confirm_identity", "identity_fix", "choose_goal", "choose_rule"]);

export interface RouterResult {
  intent: string;
  domain: string | null;
  tool_need: string | null;
  missing_fact: string | null;
  risk: string[];
  search_terms: string;
}

/**
 * When a second, identical router request goes out, and when the router is
 * given up on. Live tests, rounds 10 and 11: the model ignores
 * `reasoning: { enabled: false }` on about one router call in three, and
 * that call takes 27-42s instead of 2.5-3s. Whether a call reasons is
 * chance, not the prompt — so a second request sent once the first is
 * clearly slow usually answers in ~3s, and the person waits ~9s, not ~40s.
 * The extra request is sent only on slow calls: a few hundred tokens on a
 * third of messages, not a model change.
 */
export const ROUTER_HEDGE_MS = 6_000;
export const ROUTER_GIVE_UP_MS = 20_000;
/** The answer is longer than the router's two words: a clean one takes 5-12s. */
export const ANSWER_HEDGE_MS = 15_000;
export const ANSWER_GIVE_UP_MS = 75_000;

/** Why a second request went out: the first was slow, or it failed fast. */
export type HedgeWhy = "slow" | "first_failed";

/**
 * The first of up to two identical requests to succeed, or a throw once both
 * fail or time runs out. `onHedge` is told when the second one goes out, so
 * the question_asked / question_answered events can say a hedge fired.
 */
export async function hedged<T>(call: () => Promise<T>, hedgeAfterMs: number, giveUpMs: number, onHedge?: (why: HedgeWhy) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let failures = 0;
    let started = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      fn();
    };
    const launch = () => {
      started++;
      call().then(
        (v) => finish(() => resolve(v)),
        (err) => {
          failures++;
          if (failures >= 2 || (failures >= started && started >= 2)) finish(() => reject(err));
          else if (started < 2) {
            // the first failed fast: try the second now
            onHedge?.("first_failed");
            launch();
          }
        },
      );
    };
    launch();
    timers.push(setTimeout(() => {
      if (!settled && started < 2) {
        onHedge?.("slow");
        launch();
      }
    }, hedgeAfterMs));
    timers.push(setTimeout(() => finish(() => reject(new Error(`router gave no answer in ${giveUpMs / 1000}s`))), giveUpMs));
  });
}

/** What route() saw on the way, for the question_asked event. Tracking only: never part of the result the prompts see. */
export interface RouteSeen {
  hedged?: HedgeWhy;
  /** The router gave no usable answer and the message was taken as a question (or distress, on its own words). */
  failed?: boolean;
}

export async function route(biz: Business, message: string, attachments = "", seen: RouteSeen = {}): Promise<RouterResult> {
  const commitments = await openCommitments(biz.id);
  try {
    const prompt = routerPrompt({
      contextSummary: contextSummary(biz),
      openCommitments: commitments.map((c) => c.what).join("; ") || "none",
      message,
      attachments,
    });
    const r = await hedged(() => askJSON("router", prompt, { maxTokens: 300, temperature: 0, label: "router" }), ROUTER_HEDGE_MS, ROUTER_GIVE_UP_MS, (why) => {
      seen.hedged = why;
    });
    return {
      intent: String(r.intent ?? "question"),
      domain: typeof r.domain === "string" ? r.domain : null,
      tool_need: typeof r.tool_need === "string" ? r.tool_need : null,
      missing_fact: typeof r.missing_fact === "string" ? r.missing_fact : null,
      risk: Array.isArray(r.risk) ? (r.risk as string[]) : [],
      search_terms: String(r.search_terms ?? message),
    };
  } catch (err) {
    // A router failure must not swallow the message. Treat it as a question and
    // let the answer engine, which is the stronger model, work it out.
    console.warn("router failed, defaulting to question", err);
    seen.failed = true;
    // The router is not the only thing that can see money trouble: the
    // owner's own words still decide it (saysMoneyTrouble), so a router
    // that timed out never lets a distressed owner be answered in growth mode.
    const distress = saysMoneyTrouble(message);
    return { intent: distress ? "distress" : "question", domain: null, tool_need: null, missing_fact: null, risk: distress ? ["distress"] : [], search_terms: message };
  }
}

// ── Fetching a forwarded link, carefully ─────────────────────────

/**
 * Whether a forwarded link is safe for the server to fetch.
 *
 * This is an SSRF guard on a function that fetches whatever a person pastes
 * into a chat. It was previously written as one anchored alternation, which
 * silently did nothing: `^(...|127\.|169\.254\.|...)$` requires the hostname
 * to BE the literal string "127." rather than to start with it, so 127.0.0.1,
 * 192.168.1.1 and — worst of all — 169.254.169.254, the cloud metadata service
 * on AWS, GCP and Azure, all sailed through.
 *
 * Rewritten to decide numerically for IPv4 and by suffix for names, because
 * that is the only version that can be read and checked at a glance.
 */
const PRIVATE_SUFFIX = /(^|\.)(local|internal|localdomain|home|lan|corp|intranet)$/i;

function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return true; // not a real address
  if (a === 0 || a === 127) return true;                     // this host
  if (a === 10) return true;                                 // private
  if (a === 172 && b >= 16 && b <= 31) return true;          // private
  if (a === 192 && b === 168) return true;                   // private
  if (a === 169 && b === 254) return true;                   // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true;         // carrier-grade NAT
  if (a >= 224) return true;                                 // multicast and reserved
  return false;
}

export function isFetchableUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;

  // URL lowercases the hostname and strips the brackets around an IPv6 literal.
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (PRIVATE_SUFFIX.test(host)) return false;
  if (isPrivateIPv4(host)) return false;

  // IPv6: loopback, link-local (fe80::/10) and unique-local (fc00::/7).
  if (host.includes(":")) {
    const lower = host.toLowerCase();
    if (lower === "::1" || lower === "::") return false;
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return false;
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return false;
    // An IPv4-mapped address smuggles the same ranges through, e.g. ::ffff:127.0.0.1
    const mapped = /::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(lower);
    if (mapped && isPrivateIPv4(mapped[1]!)) return false;
  }

  return true;
}

/**
 * Strips a page down to readable text. Bounded in time, size and — the part
 * that is easy to miss — in WHERE it goes: redirects are followed by hand so
 * the private-address guard runs on every hop. With redirect:"follow", the
 * guard checked only the URL the person pasted, and any public page could 302
 * the request straight to 169.254.169.254 or a box on the internal network.
 */
/** Why a forwarded link could not be read, for the attachment_unreadable event. Tracking only. */
export interface PageSeen {
  reason?: "blocked_address" | "blocked_redirect" | "redirect_without_location" | "too_many_redirects" | "status" | "not_text" | "timeout" | "fetch_failed";
  status?: number;
}

export async function fetchPageText(url: string, seen: PageSeen = {}): Promise<{ text: string; title: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      if (!isFetchableUrl(current)) {
        // hop > 0: a public page redirected toward a private address.
        seen.reason = hop ? "blocked_redirect" : "blocked_address";
        return null;
      }
      res = await fetch(current, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "User-Agent": "FinBot/1.0 (+personal money assistant)", Accept: "text/html,text/plain,*/*" },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) {
          seen.reason = "redirect_without_location";
          return null;
        }
        current = new URL(location, current).href;
        continue;
      }
      break;
    }
    if (!res || !res.ok) {
      seen.reason = res && res.status >= 300 && res.status < 400 ? "too_many_redirects" : "status";
      seen.status = res?.status;
      return null;
    }
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) {
      seen.reason = "not_text";
      return null;
    }

    const raw = (await res.text()).slice(0, 400_000);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim() ?? "";
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 12_000);
    return { text, title };
  } catch (err) {
    // The host, not the link: console capture copies this line into a
    // log_error event and its alert email, and a path or query can carry a token.
    console.log("fetchPageText failed", hostOf(url) ?? "(not a valid link)", err);
    seen.reason = controller.signal.aborted ? "timeout" : "fetch_failed";
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const URL_RE = /https?:\/\/[^\s]+/i;

/** A link's host alone, for an event: never the path or query, which can carry a token. */
function hostOf(u: string): string | null {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
}

// ── Progress questions: the one intent known without the router ──

/**
 * "How am I doing?" and its close cousins. The web uses this to light up the
 * map and to keep retrieval keyword-only; composeAnswer uses it (through
 * isPlainProgressQuestion, below) to skip the router call.
 */
export const PROGRESS = /\b(how am i doing|how'?s it going|my progress|how far (am i|have i)|where do i stand|am i on track|my map|how is my money( doing)?)\b/i;

/**
 * Anything that could be strain. Deliberately broad: a false hit only costs
 * the router call we would have made anyway, while a miss would skip the
 * distress check. The router is what flags distress mid-conversation, so a
 * message that might carry it must always reach the router.
 */
const DISTRESS_CUE =
  /\b(can'?t|cannot|couldn'?t|won'?t|unable|not able|struggl\w*|behind|owe\w*|owing|debt\w*|loan\w*|rent|broke|bankrupt\w*|clos(e|ed|ing)|shut\w*|evict\w*|collector\w*|stress\w*|worr\w*|scared|afraid|desperate|losing|lost|lose|bad(ly)?|terrible|awful|horrible|failing|fail\w*|help|money|cash|pay\w*|salar\w*|wages?|staff|creditor\w*|arrears|overdraft|repossess\w*|sink\w*|drown\w*|quit\w*|give up|giving up|tired|exhausted|hard|tough|tight|down|slow|dead|nothing|no one|nobody|worse|worst|sad|depress\w*|anxious|panic\w*|crisis|emergency|sick|ill|hospital)\b/i;

/** Words that may sit around a progress phrase without changing what is asked. */
const PROGRESS_FILLER = new Set([
  "hi", "hey", "hello", "fin", "so", "far", "now", "today", "lately", "overall", "generally", "honestly", "really",
  "then", "ok", "okay", "please", "and", "with", "my", "the", "plan", "this", "week", "month", "on", "all", "in", "general",
  "right", "at", "moment", "yet", "tell", "me", "quick", "question", "just", "checking", "wondering", "a", "doing",
]);

/**
 * True only for a short message that is nothing but a progress question:
 * "How am I doing?", "Hey Fin, am I on track so far?". Then the intent is
 * known without a model call. Anything more — a distress cue, an emoji, a
 * second clause, a link — returns false, and the router runs as before.
 * "how am I doing, I can't pay rent" must reach the router: it is the router
 * that switches a business into stabilising mode mid-conversation.
 */
export function isPlainProgressQuestion(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t || t.length > 80) return false;
  if (!PROGRESS.test(t)) return false;
  // The cue is read on what is LEFT once the progress phrase is taken out:
  // "how is my money doing?" is a progress question, not a money-trouble one.
  if (DISTRESS_CUE.test(t.replace(new RegExp(PROGRESS.source, "gi"), " "))) return false;
  // Letters, spaces and ordinary punctuation only: an emoji can carry the mood the words leave out.
  if (/[^A-Za-z'’\s?!.,]/.test(t)) return false;
  const rest = t.replace(new RegExp(PROGRESS.source, "gi"), " ").toLowerCase().replace(/’/g, "'").match(/[a-z']+/g) ?? [];
  return rest.every((w) => PROGRESS_FILLER.has(w));
}

/** What the router would have said for a plain progress question, without asking it. */
export function progressRoute(message: string): RouterResult {
  return { intent: "question", domain: null, tool_need: null, missing_fact: null, risk: [], search_terms: message };
}

// ── Timing ───────────────────────────────────────────────────────

/**
 * Where one answer's time went, in milliseconds. Live, round 4: web answers
 * took 10-61s and WhatsApp 15-20s, and nobody could read production logs, so
 * this is stored with the answer (web: messages.meta.timing; WhatsApp: a
 * safety_events 'answer_timing' note).
 *
 * Each phase is its own wall-clock duration. The core's database reads run
 * alongside the router (and a forwarded link's fetch alongside both), so the
 * phases need not add up to `total`. A phase the turn never reached is absent.
 */
export interface AnswerTiming {
  /** The router: the open-commitments read plus the model call. 0 when skipped. */
  route?: number;
  /** The core's four database reads (library, tools, recent turns, plan), started with the router. */
  db?: number;
  /** After the router: waiting for those reads, the shortlist, any semantic rescue (embed + rpc + gap row), assembly. */
  core?: number;
  /** A forwarded link's page fetch, started with the router. */
  fetch?: number;
  /** The answer (or forward) model call. */
  answer?: number;
  /** checkReply: Jev or the model backstop, plus name fidelity and its audit row. */
  check?: number;
  /** The independent scam score on forwarded content, run alongside checkReply. */
  scam?: number;
  total: number;
  router: "model" | "skipped";
  check_engine?: string;
  /** Every model call made while composing: which model served it, and whether that was a fallback. */
  models: ModelCallTrace[];
}

/** One line for a log or a safety_events detail: "route 3.1s; core 0.4s; ...". */
export function timingLine(t: AnswerTiming, extra: Record<string, number> = {}): string {
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const phases = (["route", "db", "core", "fetch", "answer", "check", "scam"] as const)
    .filter((k) => typeof t[k] === "number")
    .map((k) => `${k} ${s(t[k]!)}`);
  for (const [k, v] of Object.entries(extra)) phases.push(`${k} ${s(v)}`);
  const models = t.models.map(describeModelCall);
  return [
    ...phases,
    `total ${s(t.total)}`,
    `router ${t.router}`,
    ...(t.check_engine ? [`check engine ${t.check_engine}`] : []),
    ...(models.length ? [`models: ${models.join(", ")}`] : []),
  ].join("; ");
}

// ── The main answer path ─────────────────────────────────────────

/**
 * What Fin would say to this message — routed, grounded in the library,
 * checked by the guardrails — WITHOUT sending it anywhere. One product, one
 * Business Context: WhatsApp (answer(), below) and the web (api/ask.ts) both
 * call this, so a question gets the same answer, with the same guardrails,
 * wherever it is asked. The only side effects are the ones that must happen
 * whichever channel it came from: distress switches the business into
 * stabilising mode, and every check leaves its audit row.
 */
export type ComposedBody =
  // `handledAs` says, for the knowledge_signal note, what the turn was taken
  // for instead of a library question (see noteTurnSkipped below).
  | { kind: "notice"; message: string; handledAs: string }
  | { kind: "error"; message: string; handledAs: string }
  | {
      kind: "reply";
      reply: Reply;
      grounded: boolean;
      hardened: boolean;
      url: string | null;
      forwarded: string;
      /** The plan steps the core block was built from, so a caller need not read them again. */
      steps: PlanStepRow[];
      /** Answered under the stabilising rules for this turn only (router distress, stage flip declined). */
      stabilisingTurn?: boolean;
    };
export type Composed = ComposedBody & { timing: AnswerTiming };

/** A quick reply that only confirms or corrects what the reply said they picked ("I meant cash", "Yes, that's right"). */
export const CONFIRM_BUTTON = /^(?:no,? )?i meant\b|^(?:yes,? )?that'?s (?:right|it|correct)\b|^not quite\b|^correct\b|^yes,? (?:both|all)\b/i;

/** A lead ending in a colon, then the words themselves on the next line. */
const WORDS_AFTER_LEAD = /^([^\n]*\b(?:here it is|here's (?:your|the|one)|here is (?:your|the|one)|ready to (?:send|paste|post))[^\n]*:)[ \t]*\n+([\s\S]{20,})$/i;
/** A message they send straight to their customers: not a Status, a post or a flyer. */
const DIRECT_MESSAGE = /\b(?:message|text|sms|broadcast)\b/i;
const NOT_A_MESSAGE = /\b(?:status|post|caption|flyer|poster|tiktok|instagram|facebook|reply to)\b/i;
/** "Here it is", "Here's your message", "Here is the post". */
const LEAD = String.raw`here(?: it is|(?:'s|’s| is) (?:it|your (?:message|post|reply|text)|the (?:message|post|reply|text)))`;
/** The whole message is a lead ("Here it is.", "Here's your message:") and there are no words after it. */
export const bareLead = (r: Pick<Reply, "message" | "artifact">): boolean =>
  !(r.artifact ?? "").trim() && new RegExp(`^\\s*${LEAD}(?:,? ready to (?:send|paste|copy))?\\s*[.!:—-]?\\s*$`, "i").test(r.message);
/** When the words still don't come after one more ask. */
export const NOTHING_WRITTEN = "I didn't get the words written that time. Send your request again and I'll write it out in full.";
/** "Here it is." / "Here it is, but…" at the start of a reply with no words to send. */
// Not before a colon: "Here's your message: Hi! …" introduces the words.
const HERE_IT_IS_LEAD = new RegExp(`^\\s*${LEAD}\\s*(?:[.!]\\s+|,\\s*but\\s+)`, "i");
/** The person asked Fin to write something: a message, a dispute, a complaint, what to say. */
/** They asked for the words again: "send it again", "resend the message". */
const ASKS_AGAIN = /\b(?:again|resend|re-send|once more|one more time)\b|^\s*(?:please\s+)?(?:can you\s+)?send (?:me )?(?:it|that|the (?:message|letter|dispute|complaint|text))\b/i;
const wordsOf = (t: string): Set<string> => new Set(t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
/** The same words to send, give or take a few: at least 85% of the words shared, both ways. */
export function nearlySame(a: string, b: string): boolean {
  const x = wordsOf(a);
  const y = wordsOf(b);
  if (x.size < 6 || y.size < 6) return [...x].join(" ") === [...y].join(" ");
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared) >= 0.85;
}
/** The message once its words to send are gone: a "Here's your message" lead points at the one above. */
const ALREADY_SENT = "The message I sent above is ready to use as it is.";
function withoutLeadPiece(message: string): string {
  const lead = new RegExp(`(^|[.!?]\\s+|\\n)\\s*${LEAD}\\b[^.!?\\n]*(?:[.!?:]|$)`, "i");
  if (!lead.test(message)) return message;
  return message.replace(lead, (_, before: string) => `${before}${ALREADY_SENT}`).trim();
}
/** When every sentence of the message was an aside and the words to send are there. */
const READY_TO_SEND = "Here it is, ready to send:";
/** "Send it again", "resend it", "send the message again please". */
const SEND_AGAIN =
  /^\s*(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:re-?send(?: me)?(?: (?:it|that|this|the (?:message|letter|dispute|complaint|text)))?(?: again)?|send (?:me )?(?:it|that|this|the (?:message|letter|dispute|complaint|text)) (?:again|once more))(?: please)?\s*[.!?]*\s*$/i;
/** The words Fin last wrote for them to send, as they went out (no fill-in note). Null if none, or a PDF went after them. */
export function lastArtifactSent(recent: { direction: string; text: string; kind?: string | null }[]): string | null {
  for (const m of [...recent].reverse()) {
    if (m.direction !== "out") continue;
    if (m.kind === "document") return null;
    if (m.kind === ARTIFACT_KIND) return m.text.replace(/^Fill in the parts? in \[brackets\][^\n]*before you send this:\s*/, "").trim() || null;
  }
  return null;
}

/** Message pieces split at sentence ends, line breaks and a colon before a new sentence; separators at the odd indexes. */
const splitPieces = (message: string): string[] => message.split(/((?<=[.!?]["'”’)]?)[ \t]+|\n+|:[ \t]+(?=[A-Z"“])|(?<=https?:\/\/\S+)[ \t]+(?=[A-Z]))/);
/** Fin talking about the person, to the person: "He confirmed the amount." */
// Not "they": "They confirmed their slots" is their customers.
const NARRATES_OWNER = /^\s*(?:he|she|the person|the user)\s+(?:(?:has|just)\s+)*confirmed\b/i;
/**
 * Second-guessing a special they have decided on, once its words are
 * written: "Worth it to you?" (round 32, ZA, live, under an R200 valet they
 * chose), "If that worries you, drop it lower" (under an R120 they had just
 * confirmed). KEEP IT SAFE: never argue them out of it, never push a cut.
 */
const SECOND_GUESS =
  /\bworth it\b[^.!]*\?|\b(?:are you sure|still want|want to go ahead|happy with (?:that|it)|ok(?:ay)? with (?:that|it)|fine with (?:that|it)|can you afford)\b[^.!]*\?|\b(?:drop it lower|lower it|bring it down|go lower|make it cheaper|cut the price|drop the price|lower the price)\b/i;
/** "One line on the same deal: …", "The downside, in one line: …". */
const PROMPT_ECHO = /^(\s*)(?:one line on [^:.]{0,40}|the downside,? in one line):\s*(\S)/i;
/** "You didn't…", "You haven't…": what they did, said as fact. */
// Not what Fin can see in the chat ("you didn't say what you charge"),
// nor advice ("you never need to register for that").
const YOU_DID_NOT =
  /^(\s*(?:but|and|since|because)\s+)?you\s+(didn['’]?t|did not|haven['’]?t|have not|never|weren['’]?t|were not|wasn['’]?t|was not)\b(?!\s+(?:yet\s+)?(?:say|said|mention|mentioned|name|named|share|shared|answer|answered|reply|replied|specify|specified|need|have to|must|should)\b|\s+(?:yet\s+)?(?:tell|told|give|given|gave|send|sent)\s+(?:me|us)\b)/i;
const NEGATION = /\b(?:didn['’]?t|did not|haven['’]?t|have not|never|not|no|none|nobody)\b/i;
const NOT_CONTENT = new Set(["that", "this", "these", "those", "them", "they", "their", "with", "your", "have", "been", "were", "what", "when", "then", "than", "from", "there", "here", "just", "only", "also", "about", "into", "didn", "haven", "never", "weren", "wasn", "the", "and", "you", "for", "but", "not", "did", "was", "had", "has", "can", "will"]);
const contentWords = (t: string): string[] => (t.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !NOT_CONTENT.has(w));

/**
 * The message as said to the person, about what they actually said (rules 2
 * and 9). `decided`: they gave or confirmed the special and its words are
 * written, so nothing second-guesses it. `ownerText`: everything they said,
 * so "You didn't…" stays only when they said so themselves (round 32, ZA,
 * live: "You didn't do that with these 400" to a person who had said
 * nothing of the kind) — otherwise it becomes "If you didn't…".
 */
export function ownerFacing(message: string, opts: { decided: boolean; ownerText: string; hasWords: boolean }): { message: string; flags: string[] } {
  const parts = splitPieces(message);
  const flags = new Set<string>();
  const ownerNeg = NEGATION.test(opts.ownerText);
  const ownerWordsSet = new Set(contentWords(opts.ownerText));
  const kept: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    let piece = parts[i]!;
    if (NARRATES_OWNER.test(piece)) {
      flags.add("third_person_dropped");
      continue;
    }
    // The prompt's own words said back (round 33, ZA, live: "One line on
    // the same deal: a full valet at R200 is R50 off…").
    if (PROMPT_ECHO.test(piece)) {
      flags.add("prompt_echo_dropped");
      piece = piece.replace(PROMPT_ECHO, (_m, sp: string, c: string) => `${sp}${c.toUpperCase()}`);
    }
    if (opts.decided && SECOND_GUESS.test(piece)) {
      flags.add("second_guess_dropped");
      continue;
    }
    const m = YOU_DID_NOT.exec(piece);
    if (m && !(ownerNeg && contentWords(piece.slice(m[0].length)).some((w) => ownerWordsSet.has(w)))) {
      flags.add("assumed_about_owner");
      const so = /^([^,;:]*?),\s*so\s+(.+)$/s.exec(piece.slice(m[0].length));
      if (!so) continue;
      piece = `If you ${m[2]!.toLowerCase()}${so[1]}, ${so[2]}`;
    }
    kept.push(piece, parts[i + 1] ?? "");
  }
  if (!flags.size) return { message, flags: [] };
  const out = kept.join("").trim().replace(opts.hasWords ? /[,;—–-]\s*$/ : /[:,;—–-]\s*$/, ".");
  return { message: out || (opts.hasWords ? READY_TO_SEND : message), flags: [...flags] };
}

/** The person's own recent messages before this one, newest last. Empty if unreadable. */
async function ownerTurnsBefore(coreData: Promise<{ recent: { direction: string; text: string }[] }>): Promise<string> {
  return coreData.then((d) => d.recent.filter((m) => m.direction === "in").slice(-6).map((m) => m.text).join("\n")).catch(() => "");
}

/** The answer prompt's own words for "the library has nothing on this" (prompts.ts answerPrompt). */
const SAID_NO_INFO = /\b(?:don[’']?t|do not)\s+have\s+(?:any\s+)?(?:verified|checked)\s+information\b/i;

/** Whitespace and case folded, for "is this the same text?" */
const norm = (t: string): string => (t || "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Is `draft` a repeat of `earlier`: identical, or sharing at least 80% of
 * its distinct words with it (over the shorter of the two). Two different
 * questions honestly answered share far less than that; a reply that
 * re-sends the last answer with a word changed shares nearly all of it.
 */
/**
 * A draft that offers several moves instead of one (rule 3): it opens with
 * "Two things, both free", "Three options:", "A few ideas —", or numbers its
 * options. Not "Two things to bring: your ID and your TIN", which is a list
 * of what one move needs.
 */
const MENU_OPENER =
  /^\s*(?:(?:ok(?:ay)?|sure|great|good question)[,.!]?\s*)?(?:here are\s+|there are\s+|you have\s+)?(?:two|three|four|five|2|3|4|5|a few|a couple of|several)\s+(?:things|options|ways|moves|ideas|quick wins|choices|routes|approaches)(?=\s*(?:[,.:;—–-]|both\b|you could\b|you can\b|to try\b|to do (?:it|this|that)\b|worth (?:trying|doing)\b|that (?:would|will|could) help\b))/i;
const NUMBERED_OPTIONS = /\b(?:option|choice)\s+(?:1|one|a)\b[\s\S]*\b(?:option|choice)\s+(?:2|two|b)\b/i;
/** Handing the choice back: round 30 (ZA, live), two messages and "Which do you want to send?". */
const WHICH_DO_YOU_WANT = /\bwhich (?:one |of (?:these|them|the two) )?(?:do|would) you (?:want|prefer|like|rather)(?: to)?(?: (?:send|use|go with|try|pick))?\b/i;
export function offersAMenu(message: string): boolean {
  return MENU_OPENER.test(message) || NUMBERED_OPTIONS.test(message) || WHICH_DO_YOU_WANT.test(message);
}

export function repeatsEarlier(draft: string, earlier: string): boolean {
  const a = norm(draft);
  const b = norm(earlier);
  if (a === b) return true;
  const words = (t: string) => new Set(t.replace(/[^a-z0-9' ]+/g, " ").split(" ").filter((w) => w.length > 2));
  const wa = words(a);
  const wb = words(b);
  if (wa.size < 8 || wb.size < 8) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size) >= 0.8;
}

export async function composeAnswer(
  biz: Business,
  said: string,
  attachment?: AttachmentRead,
  /** ownerWords: false for a tapped quick reply — Fin's own words, which must never become a knowledge signal. */
  opts: {
    ownerWords?: boolean;
    channel?: "whatsapp" | "web";
    /**
     * The question is about their own plan or progress ("How am I doing?").
     * It is answered from the plan summary and map already in the core block,
     * and the library has nothing to add, so retrieval stays keyword-only: no
     * embedding call and no false "gap". Every guardrail still runs, and so
     * does the router unless the message is a plain progress question with
     * no possible distress in it (isPlainProgressQuestion).
     */
    aboutTheirPlan?: boolean;
    /**
     * Fin's own question the person was answering when they asked this
     * (a question kept from the diagnostic, engine/kept.ts). Given to the
     * router, retrieval and the answer as context, labelled as Fin's
     * words — so "what does that mean?" has something to mean — and never
     * mixed into `said`, which stays the person's words alone (memory,
     * knowledge signals and the guardrails read it as theirs).
     */
    askedAt?: string;
    /** What they then answered to that question — an option pick, exact (kept.ts). Context, like askedAt. */
    answeredWith?: string;
  } = {},
): Promise<Composed> {
  const started = Date.now();
  const timing: AnswerTiming = { total: 0, router: "model", models: [] };
  const done = (c: ComposedBody): Composed => {
    timing.total = Date.now() - started;
    return { ...c, timing } as Composed;
  };
  return traceModelCalls(timing.models, async () => done(await composeInner(biz, said, attachment, opts, timing)));
}

async function composeInner(
  biz: Business,
  said: string,
  attachment: AttachmentRead | undefined,
  opts: { ownerWords?: boolean; channel?: "whatsapp" | "web"; aboutTheirPlan?: boolean; askedAt?: string; answeredWith?: string },
  timing: AnswerTiming,
): Promise<ComposedBody> {
  const began = Date.now();
  // Which attempt of a queued turn this is: the queue retries a turn whose
  // answer failed, and the retry routes and answers it all over again.
  const attempt = Number(jobCtx.getStore()?.attempt ?? 1);
  const ownerWords = opts.ownerWords !== false;
  const timed = async <T>(phase: "route" | "db" | "core" | "fetch" | "answer" | "check" | "scam", work: Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      return await work;
    } finally {
      timing[phase] = Date.now() - t;
    }
  };
  // `said` is only ever the person's own words. What a forwarded photo or file
  // says arrives separately in `attachment` and is treated as content to be
  // judged, never as something the person said.
  const url = attachment ? null : (said.match(URL_RE)?.[0] ?? null);
  // What the models read: the person's words, plus — for a question kept from
  // the diagnostic — the question of Fin's they were answering, marked
  // as not theirs. Everything that must be the person's alone keeps `said`.
  const forModel = opts.askedAt
    ? `${said}\n\n(Context, not the person's words: they asked this during the setup questions, while answering Fin's question "${opts.askedAt.slice(0, 400)}".${opts.answeredWith ? ` They then answered that question: "${opts.answeredWith.slice(0, 200)}".` : ""})`
    : said;

  // Started now, awaited later: none of these depends on what the router
  // decides. The core's reads (library, tools, recent turns, plan) and a
  // forwarded link's page used to wait for the router to finish first. On an
  // early return (distress, forget) they are simply not used; the .catch
  // keeps an unused failure from surfacing as an unhandled rejection, while
  // the awaited promise below still throws exactly as before.
  const coreData = timed("db", loadCoreData(biz));
  coreData.catch(() => {});
  const pageSeen: PageSeen = {};
  const page = url ? timed("fetch", fetchPageText(url, pageSeen)) : null;

  // A plain "How am I doing?" has a known intent; the router call (the
  // commitments read plus a model round trip) buys nothing for it. Anything
  // that might carry distress still goes to the router — see
  // isPlainProgressQuestion.
  const skipRouter = !attachment && !url && !opts.askedAt && isPlainProgressQuestion(said);
  timing.router = skipRouter ? "skipped" : "model";
  const routeSeen: RouteSeen = {};
  let r = skipRouter ? progressRoute(said) : await timed("route", route(biz, forModel, attachment ? attachment.kind : url ? "link" : "", routeSeen));
  if (skipRouter) timing.route = 0;
  // A button Fin offered ("Show me the message") follows on from
  // Fin's own last answer: never off-topic. Round 25, ZA: the router read
  // the tapped words alone, filed them off_topic_request, and the reply had
  // to ask which message was meant.
  if (!ownerWords && r.intent === "off_topic") r = { ...r, intent: "question" };

  // What people ask, as the router read it — on WhatsApp and the web alike.
  // The words themselves are already on turn_received; this is the reading.
  const kind = attachment ? attachment.kind : url ? "link" : "text";
  track("question_asked", {
    category: "behaviour",
    ms: timing.route,
    props: {
      intent: asLabel(r.intent),
      domain: asLabel(r.domain),
      risk: r.risk.slice(0, 8).map(asLabel),
      tool_need: Boolean(r.tool_need),
      missing_fact: Boolean(r.missing_fact),
      router: skipRouter ? "skipped" : routeSeen.failed ? "failed" : "model",
      ...(routeSeen.hedged ? { router_hedged: routeSeen.hedged } : {}),
      kind,
      own_words: ownerWords,
      about_plan: Boolean(opts.aboutTheirPlan),
      // A queue retry asks again: count questions on attempt 1 only.
      ...(attempt > 1 ? { attempt } : {}),
    },
  });
  // Nothing routes it anywhere else: the answer model gets it like any
  // question. The request is what is worth seeing.
  if (r.intent === "off_topic") trackUnmet("off_topic_request", { props: { kind, domain: asLabel(r.domain) }, summary: "A person asked for something Fin does not do" });

  if (r.intent === "forget_me") {
    // Handled by the dispatcher — routed here only if the person phrased it
    // as part of a longer message.
    // Nothing was deleted: they were told the exact words to send (or, on
    // the web, to send them on WhatsApp). If they never do, this is the trace.
    trackUnmet("forget_requested", { severity: "info", props: { via: "router", deleted: false }, summary: "A person asked to be forgotten inside a longer message; nothing was deleted and they were told the exact words" });
    return {
      kind: "notice",
      handledAs: "a forget request",
      message:
        opts.channel === "web"
          ? "Deleting what I know is done on WhatsApp, where I can ask you to confirm it: send me exactly \"forget my money\" there. Nothing has been deleted from here."
          : "If you want me to forget everything about your money, send exactly: forget my money. I'll delete what I know and confirm it.",
    };
  }

  // A business already in stabilising mode is not switched into it again:
  // handleStabilizing (engine/index.ts) owns entering and leaving it, and
  // re-entering here would reset the words-since-entering that the exit
  // check reads. Its questions are answered below, with the stabilising rules
  // in the core block every prompt is built from (buildCore).
  const stabilising = biz.stage === "stabilizing";
  // This turn only: the router read distress, the evidence check declined the
  // stage flip, and the answer is still written under the stabilising rules.
  let stabilisingTurn = false;

  if (!stabilising && (r.intent === "distress" || r.risk.includes("distress"))) {
    // Live test, 2026-09-25: the router called "im stuck" distress, and the
    // owner was switched into stabilising mode on that word alone — every
    // later question then got the fixed "protect your cash" reply. A flip
    // that takes the whole product away needs more than the router: money
    // or crisis language in the person's own message (saysMoneyTrouble, free),
    // or — when the words are not on that list — a second opinion on the
    // message itself from the safety judge (the same engine the exit check
    // uses). Either one agreeing flips the stage.
    const words = saysMoneyTrouble(said);
    const second = words ? null : await checkMessageDistress(said, { businessId: biz.id });
    if (words || second === true) {
      // Distress found mid-conversation has to do everything the diagnostic-time
      // check does, or it is theatre: the person gets the stabilising message and
      // then their very next question is answered in ordinary growth mode, which
      // is exactly the moment a loan gets recommended to someone who cannot
      // afford one. Change the state, keep the evidence, and put it on the record.
      //
      // The evidence starts here: what was said since stabilising began is
      // THIS message, not whatever an earlier stint left behind — the exit
      // check (checkStillDistressed) reads only this field.
      const answers = { ...(biz.answers ?? {}), since_stabilising: said.slice(0, 2000) };
      await updateBusiness(biz.id, { stage: "stabilizing", answers, pending_action: null });
      await recordSafetyEvent({
        businessId: biz.id,
        check: "distress",
        engine: "model",
        outcome: "block",
        detail: `router flagged distress mid-conversation (${words ? "money words in the message" : "second opinion agreed"}): ${said.slice(0, 200)}`,
      });
      track("distress_detected", {
        severity: "warn",
        props: { source: "conversation", via: words ? "money_words" : "second_opinion", router: routeSeen.failed ? "failed" : r.intent === "distress" ? "intent" : "risk" },
      });
      return { kind: "notice", handledAs: "distress (stabilising mode)", message: stabilizingMessage(biz.country, biz.context?.name ?? "", Boolean(biz.current_plan_id)) };
    }
    // Both the words and the second opinion disagree with the router: the
    // STAGE stays where it is. The router's reading is not thrown away — the
    // answer model still sees intent "distress" in the router result, this
    // turn's prompt carries the stabilising rules (free and reversible only,
    // nothing paid, no loan), and the reply gets no "Next step" button. The
    // overruling is a row in safety_events rather than a silence: if the
    // guard is wrong often, that is where it will show.
    stabilisingTurn = true;
    await recordSafetyEvent({
      businessId: biz.id,
      check: "distress",
      engine: "model",
      outcome: "pass",
      flags: ["router_overruled"],
      detail: `router flagged distress but the message has no money or crisis language${second === false ? " and the second opinion disagreed" : ""}, so the stage was kept and it was answered under the stabilising rules: ${said.slice(0, 200)}`,
    });
  }

  const cb = await timed(
    "core",
    buildCore(
      biz,
      {
        query: `${said} ${opts.askedAt ?? ""} ${r.search_terms} ${r.tool_need ?? ""} ${attachment ? attachment.text.slice(0, 400) : ""}`.trim(),
        // The person's own question only: not a forwarded page, file or link.
        ...(attachment || url ? {} : { asked: said }),
        domain: r.domain,
        // A knowledge signal carries only what the person typed themselves: never a
        // forwarded document or page, never a tapped suggestion.
        quote: ownerWords && !attachment && !url ? said : null,
        semantic: !opts.aboutTheirPlan,
        stabilisingTurn,
      },
      coreData,
    ),
  );

  // "Send it again": the last words written for them to send, exactly as
  // they went, with no model to rewrite them.
  const recentTurns = await coreData.then((d) => d.recent).catch(() => [] as { direction: string; text: string }[]);
  const lastWords = !attachment && !url && SEND_AGAIN.test(said) ? lastArtifactSent(recentTurns) : null;
  if (lastWords) {
    const reply: Reply = { message: "Here it is again:", artifact: lastWords, next_tap: null, quick_replies: [], tool_id: null, domain: asLabel(r.domain) };
    track("question_answered", { category: "behaviour", ms: Date.now() - began, props: { call: "send_again", intent: asLabel(r.intent), domain: asLabel(r.domain), grounded: cb.grounded } });
    return { kind: "reply", reply, grounded: cb.grounded, hardened: false, url: null, forwarded: "", steps: cb.steps, stabilisingTurn };
  }
  const answerInput = forModel;
  let raw: Record<string, unknown>;
  // What the forwarded thing says, for the independent scam score below.
  let forwarded = "";
  // For question_answered / answer_failed: which call, and whether a second request went out.
  const call = attachment ? "forward:attachment" : url ? "forward" : "answer";
  let answerHedged: HedgeWhy | null = null;
  try {
    if (attachment) {
      forwarded = attachment.text;
      raw = await timed(
        "answer",
        askJSON(
          "wa_reply",
          forwardPrompt(cb.text, {
            source: attachment.kind === "pdf" ? "a document the person forwarded" : "a photo the person forwarded",
            extracted: attachment.text,
            note: said,
          }),
          // 1100 -> 2000, same reason as every plan_builder ceiling in build.ts:
          // db/0009 turned reasoning ("low" effort) on for wa_reply too, and
          // reasoning tokens spend from this same budget before the model
          // writes an answer. This call site was never audited when that
          // migration landed — only plan_builder's call sites were, because
          // that was where the 2026-09-20 incident first surfaced. Same bug
          // class, same fix. reasoning off, per-call: this is a live reply,
          // exactly what "everything fast except the plan builder" means.
          { maxTokens: 2000, label: "forward:attachment", reasoning: { enabled: false } },
        ),
      );
    } else if (url) {
      const got = await page!;
      forwarded = got ? `${got.title}\n\n${got.text}` : "";
      // They forwarded a link to be judged and the page could not be read, or
      // came back with no text (a page built by script): the answer can only
      // say so, or judge it by its title. The host, never the full address.
      const unread = !got ? (pageSeen.reason ?? "unknown") : got.text.trim() ? null : "empty";
      if (unread) {
        trackUnmet("attachment_unreadable", {
          props: { kind: "link", reason: unread, ...(pageSeen.status ? { status: pageSeen.status } : {}), host: hostOf(url) },
          fingerprint: `attachment_unreadable:link:${unread}`,
          summary: `A person forwarded a link that could not be read (${unread})`,
        });
      }
      raw = await timed(
        "answer",
        askJSON(
          "wa_reply",
          forwardPrompt(cb.text, {
            source: url,
            extracted: got ? `${got.title}\n\n${got.text}` : "(the page could not be read)",
            note: said.replace(url, "").trim(),
          }),
          { maxTokens: 2000, label: "forward", reasoning: { enabled: false } },
        ),
      );
    } else {
      // A forwarded message pasted as text (no link, no file) that the router
      // reads as a forward or a likely scam is scored like any forward: round
      // 23's PDM "loan approved, send the processing fee" was pasted, and no
      // scam score ran.
      if (r.intent === "forward_link" || r.risk.includes("scam_suspect")) forwarded = said;
      // see forward:attachment above
      // The same backup request as the router (hedged): a second request
      // once the first is clearly slow — round 13 saw answers of 60-108s.
      raw = await timed(
        "answer",
        hedged(() => askJSON("wa_reply", answerPrompt(cb.text, answerInput, JSON.stringify(r)), { maxTokens: 1800, label: "answer", reasoning: { enabled: false } }), ANSWER_HEDGE_MS, ANSWER_GIVE_UP_MS, (why) => {
          answerHedged = why;
        }),
      );
    }
  } catch (err) {
    console.log("answer failed", err);
    // Inside a queued job with a retry left, answer() tells the person it is
    // still on it and the queue runs the turn again: a warning. Anywhere else
    // (the last attempt, the web) the person is told sorry: an error, at once.
    const retrying = Boolean(jobCtx.getStore()) && !onLastAttempt();
    // Two incidents, not one: an incident's alert never steps down
    // (bump_incident), so a retry sharing a fingerprint with a person told
    // sorry would email at once every time it recurred.
    const errClass = normaliseForFingerprint(err instanceof Error && err.name && err.name !== "Error" ? err.name : errorText(err)).slice(0, 100);
    trackFailure("answer_failed", err, {
      severity: retrying ? "warn" : "error",
      alert: retrying ? "digest" : "immediate",
      ms: timing.answer,
      props: { call, will_retry: retrying, attempt, intent: asLabel(r.intent), ...(answerHedged ? { answer_hedged: answerHedged } : {}) },
      fingerprint: `answer_failed:${retrying ? "will_retry" : "told_sorry"}:${errClass}`,
      summary: retrying ? `An answer (${call}) failed; the queue is retrying the turn` : `A person's question went unanswered: the ${call} call failed and they were told sorry`,
    });
    return { kind: "error", handledAs: "a failed answer (the model call failed)", message: "Sorry, I couldn't finish an answer to that just now. Ask me again in a minute and I'll pick it straight up." };
  }

  // Live test, round 11: "How do I register with CIPC?" came back
  // word-for-word the answer already given to "Do I need to register with
  // CIPC?" two turns earlier — the model answered the conversation, not the
  // new question. A byte-identical repeat of something Fin already sent
  // is never a real answer to a new message: ask once more, pointing at it.
  let repeat: "none" | "reasked" | "reask_failed" = "none";
  if (!attachment && !url) {
    const earlier = await coreData.then((d) => d.recent.filter((m) => m.direction === "out").map((m) => norm(m.text))).catch(() => [] as string[]);
    const draft = norm(tidy(raw).message);
    // A short line ("Yes, you can.") can honestly answer two questions alike.
    // Round 13: "I sent money to the wrong number" got the overpayment-scam
    // warning sent one turn earlier, near word for word but not exactly, so
    // an exact match missed it. Near enough counts (repeatsEarlier).
    if (draft.length >= 60 && earlier.some((e) => repeatsEarlier(draft, e))) {
      console.warn(`answer repeated an earlier reply [${biz.id}]; asking again`);
      repeat = "reasked";
      try {
        raw = await timed(
          "answer",
          askJSON(
            "wa_reply",
            answerPrompt(cb.text, answerInput, JSON.stringify(r)) + `\n\nYOUR FIRST DRAFT REPEATED AN EARLIER ANSWER WORD FOR WORD, OR NEARLY: "${tidy(raw).message}". The person has asked something new. Answer THIS message. If it asks how to do something, give the steps, even if an earlier answer said they don't need to yet.`,
            { maxTokens: 1800, label: "answer:repeat", reasoning: { enabled: false } },
          ),
        );
      } catch (err) {
        console.log("answer re-ask failed; keeping the first draft", err);
        repeat = "reask_failed";
        // The person gets the repeat of an earlier answer, not an answer to what they just asked.
        trackFailure("answer_failed", err, {
          severity: "warn",
          alert: "digest",
          props: { call: "answer:repeat", kept: "first_draft" },
          fingerprint: "answer_failed:answer:repeat",
          summary: "An answer repeated an earlier reply and the re-ask failed; the person got the repeat",
        });
      }
    }
  }

  // Rule 3, in code: round 23, UG, "My salon is quiet Monday to Thursday" got
  // "Two things, both free. First, a Google Business Profile… Second,
  // WhatsApp Status…" — a menu, which the compliance judge did not flag
  // because the reply ranked them. A draft that opens with several moves is
  // asked once more for the single best one.
  let oneRec: "ok" | "reasked" | "reask_failed" = "ok";
  if (!attachment && !url && offersAMenu(tidy(raw).message)) {
    oneRec = "reasked";
    try {
      raw = await timed(
        "answer",
        askJSON(
          "wa_reply",
          answerPrompt(cb.text, answerInput, JSON.stringify(r)) + `\n\nYOUR FIRST DRAFT OFFERED SEVERAL MOVES: "${tidy(raw).message}". Rule 2 is ONE recommendation. Keep the single best move for THIS person now, why it fits them, and its first step. Mention another only as what the choice would depend on. If they asked you to write something, write the one they asked for, as they asked for it, never a second version for them to choose between.`,
          { maxTokens: 1800, label: "answer:one", reasoning: { enabled: false } },
        ),
      );
    } catch (err) {
      console.log("one-recommendation re-ask failed; keeping the first draft", err);
      oneRec = "reask_failed";
    }
  }

  // "Here it is." and nothing after it (round 30, UG, live): the words to
  // send never made it into the draft. Asked once more; if they still don't
  // come, the person is told so plainly, never handed an empty lead.
  if (!attachment && !url && bareLead(tidy(raw))) {
    try {
      raw = await timed(
        "answer",
        askJSON(
          "wa_reply",
          answerPrompt(cb.text, answerInput, JSON.stringify(r)) + `\n\nYOUR FIRST DRAFT SAID "${tidy(raw).message}" BUT GAVE NOTHING AFTER IT: the artifact was empty. Put the full words they asked for in artifact, ready to send.`,
          { maxTokens: 1800, label: "answer:empty", reasoning: { enabled: false } },
        ),
      );
    } catch (err) {
      console.log("empty-lead re-ask failed", err);
    }
    const gaveUp = bareLead(tidy(raw));
    if (gaveUp) raw = { ...raw, message: NOTHING_WRITTEN, artifact: null, quick_replies: [] };
    await recordSafetyEvent({ businessId: biz.id, check: "reply_compliance", engine: "none", outcome: "flag", flags: ["empty_lead"], detail: gaveUp ? "a bare 'Here it is.' with no words, twice: the person was told so" : "a bare 'Here it is.' with no words: asked once more, and the words came" });
  }

  let reply = tidy(raw);
  // A writing turn: they asked for a message, a dispute, a complaint, what to say.
  const writing = !attachment && !url && WRITE_REQUEST.test(said);
  // The words to send written into the message itself, after a lead
  // ("Here it is, ready to send:\n…"): no check saw them. They are the words
  // to send, and are treated so.
  if (writing && !reply.artifact) {
    const lead = WORDS_AFTER_LEAD.exec(reply.message);
    if (lead) reply = { ...reply, message: lead[1]!.trim(), artifact: lead[2]!.trim() };
  }
  // Words to send that already went out, under an answer to something else.
  // Not when they ask for it again, or ask for something written.
  if (reply.artifact && !writing && !attachment && !url && !ASKS_AGAIN.test(said)) {
    const sentBefore = await coreData.then((d) => d.recent.filter((m) => m.direction === "out").map((m) => m.text)).catch(() => [] as string[]);
    if (sentBefore.some((e) => nearlySame(reply.artifact!, e))) {
      reply = { ...reply, artifact: null, message: withoutLeadPiece(reply.message) };
      await recordSafetyEvent({ businessId: biz.id, check: "reply_compliance", engine: "none", outcome: "flag", flags: ["repeated_message_dropped"], detail: "the words to send were the same as a message already sent; not sent again" });
    }
  }
  // Said to the person, about what they said: no "he confirmed", no "you
  // didn't" they never said (rules 2 and 9).
  {
    const ownerText = [said, await ownerTurnsBefore(coreData), ...Object.values(biz.answers ?? {}).map((v) => String(v ?? ""))].join("\n");
    const faced = ownerFacing(reply.message, { decided: Boolean(reply.artifact) && writing, ownerText, hasWords: Boolean(reply.artifact) });
    if (faced.flags.length) {
      reply = { ...reply, message: faced.message };
      await recordSafetyEvent({ businessId: biz.id, check: "reply_compliance", engine: "none", outcome: "flag", flags: faced.flags, detail: `said to the person: ${faced.flags.join(", ")}` });
    }
  }
  // A [slot] left in Fin's own advice, not one in the words to send: that
  // sentence goes; the person never sees a blank.
  {
    const slots = new Set([...(reply.artifact ?? "").matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!.trim().toLowerCase()));
    const blank = (piece: string) => [...piece.matchAll(/\[([^\]]+)\]/g)].some((m) => !slots.has(m[1]!.trim().toLowerCase()) && !/^brackets?$/i.test(m[1]!.trim()));
    const parts = splitPieces(reply.message);
    if (parts.some((p, i) => i % 2 === 0 && blank(p))) {
      const kept: string[] = [];
      for (let i = 0; i < parts.length; i += 2) if (!blank(parts[i]!)) kept.push(parts[i]!, parts[i + 1] ?? "");
      const message = kept.join("").trim().replace(reply.artifact ? /[,;—–-]\s*$/ : /[:,;—–-]\s*$/, ".");
      if (message || reply.artifact) {
        reply = { ...reply, message: message || READY_TO_SEND };
        await recordSafetyEvent({ businessId: biz.id, check: "reply_compliance", engine: "none", outcome: "flag", flags: ["unfilled_slot_dropped"], detail: "a [slot] in Fin's own advice, with nothing to fill it: that sentence was taken out" });
      }
    }
  }
  // "Here it is." with nothing after it.
  if (!reply.artifact && HERE_IT_IS_LEAD.test(reply.message)) {
    const rest = reply.message.replace(HERE_IT_IS_LEAD, "").trim();
    if (rest) reply.message = rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  // "R[amount]" in the message: a slot where the model had no checked
  // figure. Out before any check reads it; the artifact keeps its brackets
  // (pricestamp.ts scrubMoneySlots).
  const slots = scrubMoneySlots(reply.message);
  if (slots.count) {
    reply.message = slots.text;
    await recordSafetyEvent({ businessId: biz.id, check: "price_grounding", engine: "none", outcome: "flag", flags: ["money_placeholder"], detail: `answer: ${slots.count} money placeholder(s) in the message` });
  }
  // Check the reply's proper nouns against what Fin already knows exactly
  // for this person before anything else touches it.
  //
  // The forward prompt already asks the writer to check for a scam, but a
  // check that depends on the writer being checked is not independent. A
  // separate judgement scores how the forwarded content itself reads, and at
  // level 2 (advance-fee markers) the person gets a pre-written warning
  // regardless of what the writer concluded. The two judge different text
  // (the reply; the forwarded content) and neither reads the other's result,
  // so they run side by side: the scam override is applied after both land,
  // exactly as when they ran one after the other.
  const [checked, level] = await Promise.all([
    timed(
      "check",
      checkReply(reply.message, [cb.toolsSheet, cb.knowledgeCosts].filter(Boolean).join("\n"), contextSummary(biz), {
        businessId: biz.id,
        knownFacts: businessKnownFacts(biz),
        ownerMessage: [said, attachment?.text ?? "", forwarded].join("\n"),
        ownerEarlier: await ownerTurnsBefore(coreData),
        country: biz.country,
        writing,
        ...(biz.answers ? { answers: biz.answers } : {}),
      }),
    ),
    forwarded ? timed("scam", scoreScam(forwarded, { businessId: biz.id })) : Promise.resolve(null),
  ]);
  timing.check_engine = checked.engine;

  // No phone number or web address that this call was not given (contacts.ts):
  // the core block (knowledge and tools sheets, the country line), the
  // country's advisor, and what the person sent are the only sources. After
  // checkReply, so it reads the text the person would actually get.
  const contactSafe = await guardReplyContacts(
    {
      ...reply,
      message: checked.message,
      // A claim about what they picked was taken out or completed: a button
      // that asks them to confirm or correct it ("I meant cash") would ask
      // about a sentence that is no longer there (round 21, live).
      quick_replies: checked.attributionEdited ? reply.quick_replies.filter((q) => !CONFIRM_BUTTON.test(q)) : reply.quick_replies,
    },
    [cb.text, country(biz.country).advisor, said, attachment?.text ?? "", forwarded, url ?? ""].join("\n"),
    { businessId: biz.id, call: attachment || url ? "forward" : "answer" },
  );
  // A phone number or address the model wrote and nobody gave it (the
  // unknown_contact row has which); the reply comes back changed only then.
  const contactsRemoved =
    contactSafe.message !== checked.message ||
    (contactSafe.artifact ?? null) !== (reply.artifact ?? null) ||
    (contactSafe.next_tap ?? null) !== (reply.next_tap ?? null);

  let hardened = false;
  let advisorAdded = false;
  // A pasted scam the writer already warned about keeps its specifics with
  // the free help added; a link, a file, or a reply that does not warn gets
  // the pre-written warning instead.
  const pasted = Boolean(forwarded) && !attachment && !url;
  const warned = pasted && (level === 2 || r.risk.includes("scam_suspect")) ? withScamAdvisor(contactSafe.message, biz.country) : null;
  if (warned !== null) {
    advisorAdded = warned !== contactSafe.message;
    contactSafe.message = warned;
  } else if (level === 2) {
    contactSafe.message = scamWarning(biz.country);
    hardened = true;
  }

  // Rule 10 for dates and laws (datecheck.ts): a date, an Act or a waiting
  // time that none of the rows this answer stood on, nor the person, gave is
  // taken out.
  // A "last checked" line copied from an earlier reply comes out first: it is
  // stampLibraryFigures' to write, from the data, not the date check's to
  // judge (review, round 22: it took the fee sentence with it).
  const days = checkDaysOf(cb.priced);
  const dated = hardened ? null : dropUngroundedDates(stripCopiedStamps(contactSafe.message, days), dateSources(cb, biz, [said, attachment?.text ?? "", forwarded]), days);
  if (dated?.dropped.length) {
    contactSafe.message = dated.message;
    await recordSafetyEvent({ businessId: biz.id, check: "date_grounding", engine: "none", outcome: "flag", flags: ["ungrounded_date"], detail: `answer: took out ${dated.dropped.map((d) => `"${d}"`).join(", ")}`.slice(0, 500) });
  }

  const finalReply = { ...contactSafe, ...(hardened ? { artifact: null, next_tap: null } : {}) };
  // A plain yes/no question gets its answer in a line or two, the detail
  // one tap away (yesno.ts). Not for a forwarded page or file.
  const trimmed = hardened || attachment || url ? finalReply : trimYesNo(said, finalReply);
  // Every library figure carries when it was checked (rule 10, pricestamp.ts)
  // — after the trim, so the line is never cut and a figure the trim took out
  // is never dated. Not on a forward or a scam warning.
  // The person's own figures — their income, their answers, what they just
  // wrote — are theirs, never dated as ours.
  const own = ownFigures(biz, ownerWords ? said : "");
  // A pasted message's figures are its sender's, not the library's: "Send
  // R150 processing fee" quoted back in a warning is never dated as a fee
  // Fin checked. And a scam warning gets no date line at all.
  for (const v of moneyIn(forwarded ?? "")) own.money.add(v);
  const about = ownerWords ? figuresAskedAbout(said, own.money, await coreData.then((d) => d.recent.slice(-4)).catch(() => [])) : [];
  const stamp = hardened || attachment || url || warned !== null ? null : stampLibraryFigures(trimmed.message, cb.priced, own.money, { notLibraryRates: own.rates, toolId: trimmed.tool_id, about });
  const stamped = stamp && stamp.message !== trimmed.message ? { ...trimmed, message: stamp.message } : trimmed;
  // A suggested reply is the person's words when they tap it: never a figure
  // they did not give, and never "Show me the message" under a message that
  // is already written.
  const owned = new Set([...own.money, ...moneyIn(await ownerTurnsBefore(coreData)), ...figuresFrom(said)]);
  const known = new Set([...owned, ...moneyIn([cb.toolsSheet, cb.knowledgeCosts].join("\n"))]);
  const sent = {
    ...stamped,
    message: withoutInventedExamples(stamped.message, known),
    artifact: stamped.artifact ? withoutInventedExamples(stamped.artifact, known) : null,
    quick_replies: fitQuickReplies(stamped, owned),
  };

  const saidNoInfo = SAID_NO_INFO.test(reply.message);
  track("question_answered", {
    category: "behaviour",
    ms: Date.now() - began,
    props: {
      call,
      intent: asLabel(r.intent),
      domain: asLabel(r.domain),
      grounded: cb.grounded,
      said_no_info: saidNoInfo,
      tool_id: asLabel(sent.tool_id),
      repeat,
      ...(oneRec !== "ok" ? { one_recommendation: oneRec } : {}),
      trimmed: trimmed !== finalReply,
      price_stamp: stamp?.kind ?? "none",
      ...(dated?.dropped.length ? { dates_dropped: dated.dropped.length } : {}),
      // Dates, Acts and waiting times the date check read in the reply, kept
      // or dropped: zero date_grounding rows then still shows it ran.
      ...(dated?.checked ? { dates_checked: dated.checked } : {}),
      ...(slots.count ? { money_placeholders: slots.count } : {}),
      contacts_removed: contactsRemoved,
      check: checked.engine,
      check_rewrote: checked.message !== reply.message,
      ...(level !== null ? { scam_level: level } : {}),
      scam_warning: hardened,
      ...(advisorAdded ? { scam_advisor_added: true } : {}),
      stabilising_turn: stabilisingTurn,
      ...(answerHedged ? { answer_hedged: answerHedged } : {}),
      // Answered on the queue's retry of a turn whose first answer failed.
      ...(attempt > 1 ? { attempt } : {}),
      answer_ms: timing.answer,
      quick_replies: sent.quick_replies.length,
      ...(sent.quick_replies.length !== stamped.quick_replies.length ? { quick_replies_dropped: stamped.quick_replies.length - sent.quick_replies.length } : {}),
      artifact: Boolean(sent.artifact),
    },
  });
  // The library matched something, just not this: the answer says it has no
  // verified information. retrieval.ts records the gap when nothing matched
  // at all; this is the one it cannot see.
  if (saidNoInfo && cb.grounded) {
    trackUnmet("knowledge_gap", {
      props: { reason: "answer_said_no_info", call, domain: asLabel(r.domain) },
      fingerprint: "knowledge_gap:answer_said_no_info",
      summary: "A person asked something the library only half-matched; the answer said it had no checked information",
    });
  }

  return {
    kind: "reply",
    reply: sent,
    grounded: cb.grounded,
    hardened,
    url,
    forwarded,
    steps: cb.steps,
    stabilisingTurn,
  };
}

/**
 * After a turn, on either channel: learn from it (memory), and notice
 * whether the person was telling us the LIBRARY is wrong. Their own words
 * only — never a forwarded page or photo, never a tapped suggestion.
 */
export async function afterTurn(
  biz: Business,
  said: string,
  finSaid: string,
  opts: { ownerWords: boolean; forwarded: boolean; source: SignalSource },
): Promise<void> {
  // Learning happens here, after the turn, on a cheap model. updateMemory
  // swallows its own errors today, but the capture below must not depend on
  // that staying true: a throw here used to mean the turn left no
  // knowledge_signal note at all (live, 2026-09-23).
  try {
    // Notes about the person come only from words they typed: never a tapped
    // suggestion (Fin's own words) or a forwarded page or photo.
    await updateMemory(biz, said, finSaid, opts.ownerWords && !opts.forwarded ? (opts.source === "web" ? "web" : "whatsapp") : null);
  } catch (err) {
    console.error("afterTurn: updateMemory threw", err);
  }

  // Usually decided free by a pre-filter; at most one typed check.
  if (!opts.ownerWords || opts.forwarded) {
    await recordSafetyEvent({ businessId: biz.id, check: "knowledge_signal", engine: "none", outcome: "pass", detail: `skipped: ${opts.forwarded ? "forwarded content" : "a tapped suggestion"}, not the person's own words` });
    return;
  }
  // captureConversationSignal notes its own failures, but loading the library
  // happens before it and would otherwise throw past it with no note.
  try {
    const { tools, knowledge } = await signalLibraryFor(biz.country);
    await captureConversationSignal({
      text: said,
      source: opts.source,
      businessId: biz.id,
      country: biz.country,
      tools,
      knowledge,
      libraryFact: (e) => {
        const t = tools.find((x) => x.id === e.id);
        if (t) return `cost: ${t.cost} | setup: ${t.setup}`;
        const k = knowledge.find((x) => x.id === e.id);
        return k ? `${k.owner_summary} | cost: ${k.cost}` : null;
      },
    });
  } catch (err) {
    console.warn("afterTurn: capture could not start", err);
    await recordSafetyEvent({ businessId: biz.id, check: "knowledge_signal", engine: "none", outcome: "flag", flags: ["capture_failed"], detail: `not considered: the library could not be loaded (${(err as Error)?.message ?? String(err)})`.slice(0, 300) });
  }
}

/**
 * The knowledge_signal note for a turn answered by something other than the
 * library path: a notice, a failed answer, a plan change, a walkthrough
 * question. Live, 2026-09-23: a person's three messages left two notes,
 * because each of those paths returned before afterTurn and wrote nothing —
 * so "why was nothing captured?" was a guess again for that turn.
 */
export async function noteTurnSkipped(biz: Pick<Business, "id">, handledAs: string): Promise<void> {
  await recordSafetyEvent({ businessId: biz.id, check: "knowledge_signal", engine: "none", outcome: "pass", detail: `skipped: handled as ${handledAs}, not a library question`.slice(0, 300) });
}

/** Whether a real answer went out, or what the turn was taken for instead. */
export interface AnswerOutcome {
  replied: boolean;
  handledAs: string;
}

export async function answer(
  biz: Business,
  said: string,
  attachment?: AttachmentRead,
  /** False when `said` is not the person's own typing — a tapped quick reply is Fin's own words. */
  opts: { ownerWords?: boolean } = {},
): Promise<void> {
  await answerTurn(biz, said, attachment, opts);
}

/** answer(), saying whether a real answer went out (engine/kept.ts counts only those). */
export async function answerTurn(
  biz: Business,
  said: string,
  attachment?: AttachmentRead,
  /**
   * ownerWords: false when `said` is not the person's own typing — a tapped
   * quick reply is Fin's own words. askedAt: see composeAnswer.
   */
  opts: { ownerWords?: boolean; askedAt?: string; answeredWith?: string } = {},
): Promise<AnswerOutcome> {
  const ownerWords = opts.ownerWords !== false;
  // The same "How am I doing?" the web page offers, asked here: answered from
  // the plan and map, keyword-only retrieval, and no router call when it is a
  // plain progress question (see isPlainProgressQuestion).
  const c = await composeAnswer(biz, said, attachment, {
    ownerWords,
    channel: "whatsapp",
    aboutTheirPlan: !attachment && !opts.askedAt && PROGRESS.test(said),
    ...(opts.askedAt ? { askedAt: opts.askedAt } : {}),
    ...(opts.answeredWith ? { answeredWith: opts.answeredWith } : {}),
  });
  const sendStarted = Date.now();
  // Live test, round 14: a KE answer call failed (both requests slow, gave
  // up at 75s) and the person was told "That didn't come through on my side.
  // Send it again?" — their message had come through; ours hadn't. Inside a
  // queued job with a retry left, say what is true, once, and let the queue
  // retry the turn itself: the person never has to resend.
  if (c.kind === "error" && jobCtx.getStore() && !onLastAttempt()) {
    if (Number(jobCtx.getStore()!.attempt ?? 1) <= 1) await sendText(biz.wa_id, "This one's taking me longer than usual. I'm still on it; no need to send it again.", biz.id);
    await recordAnswerTiming(biz, c.timing, Date.now() - sendStarted);
    throw new Error(`answer failed; the queue will retry this turn (${c.handledAs})`);
  }
  if (c.kind !== "reply") {
    await sendText(biz.wa_id, c.message, biz.id);
    await recordAnswerTiming(biz, c.timing, Date.now() - sendStarted);
    // The one early return on this path, and the hole behind the live
    // 2026-09-23 gap: a distress flag or a failed model call replied to the
    // owner and returned without a note.
    await noteTurnSkipped(biz, c.handledAs);
    return { replied: false, handledAs: c.handledAs };
  }

  // The id carries the label so the tap dispatches as if they had typed it.
  // WhatsApp caps an id at 256 characters and a title at 20, so both are cut.
  const buttons = c.reply.quick_replies.length
    ? c.reply.quick_replies.slice(0, 2).map((q, i) => ({ id: `a.q.${i}:${q}`.slice(0, 200), title: q }))
    : [];
  // Not while stabilising: "Next step" would push a plan step (or, with no
  // plan, restart the diagnostic — see staleTap in engine/index.ts) and drop
  // stabilising mode by the back door. The way forward is the person saying
  // things have steadied, which handleStabilizing reads.
  // Nor on a turn the router read as distress and the evidence check kept
  // out of stabilising mode: that answer was written under the stabilising
  // rules, and a growth-plan button under it would undo them.
  // Nor before there is a plan (a question asked while the goal options are
  // on their way): with no plan, "Next step" restarts the build from the
  // read-back and throws the options away.
  if (biz.stage !== "stabilizing" && !c.stabilisingTurn && !PRE_PLAN_STAGES.has(biz.stage)) buttons.push({ id: ACT.NEXT_STEP, title: "Next step" });

  await sendReply(biz, c.reply, buttons);
  // Before afterTurn: the learning happens after the person has their answer,
  // so it is not part of the time they waited.
  await recordAnswerTiming(biz, c.timing, Date.now() - sendStarted);
  await afterTurn(biz, said, c.reply.message, { ownerWords, forwarded: Boolean(attachment || c.url), source: "whatsapp" });
  return { replied: true, handledAs: "answer" };
}

/**
 * Where a WhatsApp answer's time went, as a safety_events note (check
 * 'answer_timing', one of NOT_GUARDRAIL_CHECKS, so no guardrail count sees
 * it). The outbound message rows are written deep inside wa.ts, with no clean
 * way to carry this; a note needs no migration and sits next to the
 * guardrail rows for the same turn. `score` is the total in seconds,
 * including the send. Best effort: timing never fails a turn.
 */
export async function recordAnswerTiming(biz: Pick<Business, "id">, t: AnswerTiming, sendMs: number): Promise<void> {
  try {
    const line = timingLine(t, { send: sendMs });
    console.log(`answer timing [${biz.id}]: ${line}`);
    await recordSafetyEvent({
      businessId: biz.id,
      check: "answer_timing",
      engine: "none",
      outcome: "pass",
      score: Math.round((t.total + sendMs) / 100) / 10,
      detail: line,
    });
  } catch (err) {
    console.warn("recordAnswerTiming failed", err);
  }
}

// ── Learning from the turn ───────────────────────────────────────

/** Shaped like a question: ends in "?" or opens with a question word. */
const QUESTION_SHAPED = (t: string): boolean => /\?\s*$/.test(t) || /^(?:how|what|when|where|why|who|which|can|could|should|would|do|does|did|is|are|will|am|may|must|shall)\b/i.test(t);
/** First person: the person talking about themselves. */
const FIRST_PERSON = /\b(?:i|i'm|im|i've|i'd|i'll|my|me|myself|we|we're|we've|our|us)\b/i;
/** Words for a feeling: a "worry" note needs one the person used. */
const FEELING = /\b(?:worr\w*|scared|afraid|fear\w*|nervous|anxious|stress\w*|panic\w*|concern\w*|overwhelm\w*|struggl\w*|can'?t sleep|unsure|doubt\w*|frustrat\w*|tired|exhausted)\b/i;
const NOTE_STOP = new Set(["that", "this", "with", "they", "them", "their", "have", "about", "from", "will", "would", "wants", "want", "worried", "person", "money", "because", "only", "some", "more", "when", "what"]);

/** Words that read as "after a preposition or at the end": "call her", "with him." */
const OBJECT_AFTER = /^(?:[.,;:!?)]|$|\s+(?:to|for|at|on|in|about|with|and|or|but|if|when|so|because|before|after|until)\b)/i;

/**
 * A note written about the person says "they", never a "she" or "he" they did
 * not use themselves. Round 28 (ZA, live): "I only work mornings, I fetch my
 * kids at 2" was kept as "must stop by 2pm to fetch her kids" — a gender
 * nobody gave. Possessives become "their", subjects "they" (with the verb
 * after it agreeing), objects "them".
 */
export function neutralPronouns(note: string, statements = ""): string {
  if (/\b(?:she|he|her|him|his|hers|herself|himself)\b/i.test(statements)) return note;
  const verb: Record<string, string> = { is: "are", was: "were", has: "have", does: "do", "doesn't": "don't", "isn't": "aren't", "wasn't": "weren't", "hasn't": "haven't" };
  return note
    .replace(/\b(?:her|him)self\b/gi, "themselves")
    .replace(/\b(she|he)'s\b/gi, (m) => (m[0] === m[0]!.toUpperCase() ? "They're" : "they're"))
    .replace(/\b(she|he)\s+(\w+(?:n't)?)/gi, (_m, p: string, v: string) => {
      const lower = v.toLowerCase();
      const fixed = verb[lower] ?? (/(?:ss|sh|ch|x|o)es$/.test(lower) ? v.slice(0, -2) : /[^s]s$/.test(lower) && !/(?:us|is)$/.test(lower) ? v.slice(0, -1) : v);
      return `${p[0] === p[0]!.toUpperCase() ? "They" : "they"} ${fixed}`;
    })
    .replace(/\bhis\b/gi, (m) => (m[0] === "H" ? "Their" : "their"))
    .replace(/\bhers\b/gi, "theirs")
    .replace(/\bhim\b/gi, "them")
    .replace(/\bher\b(?=(.*))/gi, (m, rest: string) => (OBJECT_AFTER.test(rest) ? "them" : m[0] === "H" ? "Their" : "their"));
}

/** The sentences of the person's message that are statements about themselves (not questions). */
export function ownStatements(said: string): string {
  return (said || "")
    // A question tacked on after a comma is its own clause: "My sister helps
    // on Fridays, what should I post?" still says something about them.
    .split(/(?<=[.!?])\s+|\n+|[,;]\s*(?=(?:so\s+|and\s+|but\s+)?(?:how|what|when|where|why|who|which|can|could|should|would|do|does|is|are|will)\b)/i)
    .map((x) => x.trim())
    .filter((x) => x && !QUESTION_SHAPED(x) && FIRST_PERSON.test(x))
    .join(" ");
}

/**
 * A note the memory model proposed, kept only when the person said it.
 * Round 27 (KE, live): the plain question "Do I have to register anywhere to
 * keep my customers' phone numbers?" became the note "Worried about whether
 * keeping customer phone numbers requires registering anywhere" — read
 * back to their AI as something about them. A question tells us what they
 * asked, not who they are. So a note needs a first-person statement in the
 * message, sharing a real word with it; a worry needs a feeling word.
 */
export function noteBacked(note: string, about: string, statements: string): boolean {
  if (!statements.trim()) return false;
  if (about === "worry" && !FEELING.test(statements)) return false;
  const stem = (w: string) => w.toLowerCase().replace(/[^a-z]/g, "").slice(0, 5);
  const words = (t: string) => new Set((t.toLowerCase().match(/[a-z']{4,}/g) ?? []).filter((w) => !NOTE_STOP.has(w)).map(stem));
  const theirs = words(statements);
  return [...words(note)].some((w) => theirs.has(w));
}

export async function updateMemory(
  biz: Business,
  ownerMessage: string,
  finMessage: string,
  /** Where a note about the person came from; null keeps none (a tap, a forward). */
  notesFrom: "whatsapp" | "web" | null = "whatsapp",
): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const r = await askJSON("router", contextUpdatePrompt(biz.context ?? {}, ownerMessage, finMessage, today), {
      maxTokens: 600,
      temperature: 0,
      label: "memory",
    });

    const patch: Record<string, unknown> = {};

    if (r.context_updates && typeof r.context_updates === "object") {
      patch.context = { ...(biz.context ?? {}), ...(r.context_updates as Record<string, unknown>) };
    }

    if (Array.isArray(r.map_updates) && Array.isArray(biz.map)) {
      const rank = { red: 0, amber: 1, green: 2 } as const;
      const updates = r.map_updates as { domain: string; status: MapEntry["status"]; note: string; evidence?: string }[];
      const next = biz.map.map((m) => {
        const u = updates.find((x) => x.domain === m.domain);
        if (!u || !u.evidence) return m;
        // A status only ever moves UP here, and only with a quoted reason. The
        // owner saying something stopped working is a separate, explicit path.
        if (rank[u.status] <= rank[m.status]) return m;
        return { ...m, status: u.status, note: u.note || m.note };
      });
      patch.map = next;
      const up = await db()
        .from("business_map")
        .upsert(
          next.map((m) => ({ business_id: biz.id, domain: m.domain, status: m.status, note: m.note, updated_at: new Date().toISOString() })),
          { onConflict: "business_id,domain" },
        );
      // supabase-js reports a failed write in { error } rather than throwing.
      if (up?.error) console.error("updateMemory: business_map upsert failed", up.error.message ?? up.error);
    }

    if (Object.keys(patch).length) await updateBusiness(biz.id, patch);

    for (const d of (r.decisions as { what: string; why: string }[]) ?? []) {
      if (d?.what) await logDecision(biz.id, d.what, d.why ?? null);
    }
    for (const c of (r.commitments as { what: string; due: string }[]) ?? []) {
      if (c?.what) await addCommitment(biz.id, c.what, c.due ?? null);
    }
    for (const o of (r.results as { what: string; effect: string }[]) ?? []) {
      if (o?.what) await logOutcome(biz.id, o.what, o.effect ?? "same");
    }
    // About the person, not the money facts (owner_notes). At most two a turn,
    // only from words they typed, never anything that looks like a secret,
    // and only what they STATED about themselves (noteBacked).
    const notes = notesFrom && Array.isArray(r.owner_notes) ? (r.owner_notes as { about?: string; note?: string }[]) : [];
    const statements = ownStatements(ownerMessage);
    for (const n of notes.slice(0, 2)) {
      const note = typeof n?.note === "string" ? n.note.trim() : "";
      if (!note || SECRET_DETAIL.test(note)) continue;
      if (!noteBacked(note, String(n.about ?? "other"), statements)) {
        trackUnmet("owner_note_refused", { severity: "info", props: { reason: "not_stated", about: String(n.about ?? "other").slice(0, 20), source: notesFrom } });
        continue;
      }
      const kept = await addOwnerNote(biz.id, String(n.about ?? "other"), neutralPronouns(note, statements), notesFrom!);
      if (kept?.fresh) track("owner_note_kept", { props: { about: kept.note.about, source: notesFrom, chars: kept.note.note.length } });
    }
  } catch (err) {
    // Memory is an improvement, not a dependency. A failure here must never
    // cost the person the answer they already received.
    console.error("updateMemory failed", err);
  }
}
