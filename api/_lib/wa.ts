// Charles — talking to WhatsApp.
//
// Everything Meta's Cloud API can do that this product needs, behind functions
// that already know the platform's real limits, so no caller has to remember
// them. The limits are not advisory: a 21-character button title is a rejected
// message, not a truncated one.
//
// When the WhatsApp credentials are absent the whole layer goes quiet rather
// than throwing. That is deliberate — the entire flow can be exercised against
// the database and the models before a number exists — but every skipped send
// is logged, so "quiet" is never mistaken for "working".

import { env } from "./env.js";
import { recordMessage, stillOwnJob } from "./db.js";
import { jobCtx, JobFencedError } from "./jobctx.js";
import { currentTrackContext, scrubExcerpt, track, trackFailure, trackUnmet } from "./track.js";

/** Meta answers a send in well under a second; this only catches a hung connection. */
const SEND_TIMEOUT_MS = 20_000;
/** Uploading or downloading a PDF, photo or voice note. */
const MEDIA_TIMEOUT_MS = 60_000;

const GRAPH = () => `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}`;

/**
 * Meta error codes worth retrying. Everything else is a permanent failure and
 * retrying it just burns the rate limit that caused it.
 *   4      application request limit
 *   80007  business rate limit
 *   130429 throughput limit
 *   131056 messaging one recipient too fast
 *   135000 generic internal WhatsApp error
 */
const RETRYABLE_CODES = new Set([4, 80007, 130429, 131056, 135000]);
/** 131047: the 24-hour window has closed. Only an approved template will land. */
export const RE_ENGAGEMENT_CODE = 131047;

/** Meta's real interactive-message limits. */
export const WA = {
  buttons: 3,
  buttonTitleChars: 20,
  buttonIdChars: 256,
  bodyChars: 1024,
  /** Plain text messages allow far more, but nobody reads 4096 characters on a phone. */
  textChars: 4096,
  listRows: 10,
  listRowTitleChars: 24,
  listRowDescChars: 72,
  listButtonChars: 20,
  listSectionTitleChars: 24,
  headerChars: 60,
  footerChars: 60,
} as const;

export const clip = (s: string, n: number): string => {
  const t = (s ?? "").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

/**
 * clip() for what a send puts on screen — and nothing should ever need it.
 * Founder, 2026-10: a diagnostic button showed "Not yet, it's an id…". A cut
 * label is a person reading half a word, so every one is logged here; under
 * the test suite (WA_STRICT_LIMITS=1, package.json) it is an error instead,
 * so a label that does not fit fails a test before it reaches a phone.
 * Labels are written to fit, or shortened at a word by fitLabel(); this is
 * the last line, not the plan.
 */
export class WaLimitError extends Error {}
function fit(s: string, n: number, field: string): string {
  const t = (s ?? "").trim();
  if (t.length <= n) return t;
  const msg = `wa: ${field} is ${t.length} characters, over WhatsApp's ${n}; cut to "${clip(t, n)}" (full: "${t.slice(0, 120)}")`;
  if (process.env.WA_STRICT_LIMITS === "1") throw new WaLimitError(msg);
  console.warn(msg);
  return clip(t, n);
}

/**
 * Text longer than `max`, as pieces that each fit, broken between paragraphs,
 * then lines, then sentences, then words — never inside a word.
 */
export function splitText(text: string, max: number): string[] {
  const t = text.trim();
  if (t.length <= max) return t ? [t] : [];
  const out: string[] = [];
  let rest = t;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const at = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! ")) + 1, window.lastIndexOf(" ")].find((i) => i > max * 0.5) ?? max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * A button or list message's text, made to fit its 1024 characters without
 * losing anything: `body` is the closing paragraph(s) that fit (the question
 * the buttons answer is always last), `lead` everything before it, to be sent
 * first as a plain message. Live, 2026-10: the identity read-back, the plan
 * order note and the AI's proposed change all ran past 1024 and lost their
 * last line — the question.
 */
export function splitForInteractive(text: string, max = WA.bodyChars): { lead: string | null; body: string } {
  const t = (text ?? "").trim();
  if (t.length <= max) return { lead: null, body: t };
  const paras = t.split(/\n{2,}/);
  let body = "";
  let i = paras.length - 1;
  for (; i >= 0; i--) {
    const next = body ? `${paras[i]}\n\n${body}` : paras[i]!;
    if (next.length > max) break;
    body = next;
  }
  if (!body) {
    // One last paragraph longer than the limit: its last sentences.
    const pieces = splitText(paras[paras.length - 1]!, max);
    body = pieces.pop()!;
    const lead = [...paras.slice(0, -1), ...pieces].join("\n\n").trim();
    return { lead: lead || null, body };
  }
  const lead = paras.slice(0, i + 1).join("\n\n").trim();
  return { lead: lead || null, body };
}

/**
 * A label that must fit a WhatsApp limit, shortened at a word boundary — no
 * "…", no half word. For labels made from data (a step title, a tool name, a
 * customer segment) where the full text is also shown in the message body or
 * a row description, so nothing is lost. Never use it for the message itself.
 */
export function fitLabel(s: string, n: number): string {
  const t = (s ?? "").trim().replace(/\s+/g, " ");
  if (t.length <= n) return t;
  const words = t.split(" ");
  let out = "";
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > n) break;
    out = next;
  }
  // A first word longer than the limit on its own: the only case a cut is unavoidable.
  out = (out || t.slice(0, n)).replace(/[\s,;:–—-]+$/, "");
  // Never end on a word that leaves the label hanging ("Price the contract of").
  out = out.replace(/\s+(?:a|an|the|of|to|for|and|or|with|in|on|at|your|my|by|from|that|who|is)$/i, "");
  return out;
}

export interface Button {
  id: string;
  title: string;
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

const configured = (): boolean => Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);

export interface SendResult {
  ok: boolean;
  waMessageId?: string;
  error?: string;
  /** Meta's numeric error code, when it gave one. */
  code?: number;
  /** true when this failure is worth retrying after a backoff. */
  retryable?: boolean;
  /** true when the 24-hour window has closed and only a template will deliver. */
  windowClosed?: boolean;
  /** true when nothing was sent because no number is configured yet. */
  skipped?: boolean;
}

/**
 * Words Charles uses when it cannot do what was asked. Every outbound message
 * that says one of these is an "unmet request" (track.ts): the founder wants
 * to know every time a person tries something Charles can't do, and an
 * apology is where that shows, whatever path produced it.
 */
export const APOLOGY_RE =
  /\b(sorry|apologies|i can'?t|i cannot|i couldn'?t|i could not|i don'?t have|i do not have|i'?m not able|i am not able|not something i can|that'?s my fault|that was my fault|i lost my place|didn'?t come through|went wrong)\b/i;

/**
 * "I don't have verified figures on that", "I don't have a date for the
 * new fee": rule 10 said out loud, not an apology. Nor is a polite off-topic
 * decline that steers back, or "I can't answer that for you". Round 22: those honest
 * answers were counted as apology_sent and filled the warning stream. The
 * library having nothing is knowledge_gap's to record (engine/qa.ts,
 * retrieval.ts), with the question that found the gap.
 */
export const HONEST_GAP_RE = new RegExp(
  [
    String.raw`\bi (?:don'?t|do not) have (?:a |any |the )?(?:verified|published|checked|confirmed|current|exact|official|up-to-date|up to date|new|date)\b[^.!?\n]*`,
    // Round 23: "As at 11 Oct 2026 it was — I don't have anything newer checked."
    String.raw`\bi (?:don'?t|do not) have (?:anything|nothing|any(?:thing)? (?:figure|fee|price|date)s?) (?:newer|more recent|later|more up-to-date|more up to date)\b[^.!?\n]*`,
    // An off-topic decline that steers back to the business is the design
    // working (off_topic_request records it), not something Charles failed
    // at: "I can't help with match predictions. What I can help with is…".
    String.raw`\bi (?:can'?t|cannot) help with [^.!?\n]*[.!?]?(?=[\s\S]{0,120}\b(?:what i can|but i can|i can help(?: you)? with|i'?m here for|i stick to)\b)`,
    // Advice that leaves the person's own judgement to them: "I can't answer
    // that for you — only you know what the stall looks like".
    String.raw`\bi (?:can'?t|cannot) (?:answer|decide|choose|judge|say|know) (?:that|this|it|which)\b[^.!?\n]{0,40}\bfor you\b[^.!?\n]*`,
    // Rule 10 said out loud, round 27 (NG, live): "I can't give you the exact
    // fee — CAC changed them in 2025 and the published figures differ."
    String.raw`\bi (?:can'?t|cannot) (?:give|tell|quote|confirm) (?:you )?(?:the |an |a )?(?:exact|current|latest|precise|official|new|up-to-date|up to date)\b[^.!?\n]*`,
    // Fitting advice to the person's hours, not failing them: "Noted —
    // mornings only, you close at 2, so I won't suggest anything after
    // 1:30" (round 30, KE, live: counted as an apology).
    String.raw`\bi (?:can'?t|cannot|won'?t|will not|don'?t) (?:suggest|recommend|book|plan|schedule|put|send)\b[^.!?\n]{0,40}\b(?:after|before|past|outside|later than|earlier than|on (?:mon|tues|wednes|thurs|fri|satur|sun)days?|in the (?:afternoon|evening|morning))\b[^.!?\n]*`,
    // Sympathy for the person's week, not Charles failing them: "Sorry about
    // that — slow weeks happen" (round 27, KE, live), "sorry to hear it".
    // Not "Sorry about that, I got the price wrong": that one is ours.
    String.raw`\b(?:i'?m |so |really )*sorry (?:to hear(?: that| it| about)?|that happened|you'?re (?:going through|dealing with|having)|about that)\b(?![^.!?\n]*\b(?:i|i'?ve|i'?m|i'?d|my|me|mine)\b)[^.!?\n]*`,
  ].join("|"),
  "gi",
);

/** The visible text of a payload, for the apology check. */
function payloadText(payload: Record<string, unknown>): string {
  const p = payload as { text?: { body?: string }; interactive?: { body?: { text?: string } }; document?: { caption?: string } };
  return p.text?.body ?? p.interactive?.body?.text ?? p.document?.caption ?? "";
}

/** Every send, tracked: what kind, how long WhatsApp took, whether it landed. */
async function post(payload: Record<string, unknown>): Promise<SendResult> {
  const started = Date.now();
  const r = await postRaw(payload);
  try {
    const kind = payload.type === "interactive" ? `interactive_${String((payload.interactive as { type?: string })?.type ?? "")}` : String(payload.type ?? "");
    const facts = { kind, ok: r.ok, ...(r.skipped ? { skipped: true } : {}), ...(r.code ? { code: r.code } : {}), ...(r.windowClosed ? { window_closed: true } : {}) };
    track("message_sent", { category: "behaviour", ms: Date.now() - started, props: facts });
    if (!r.ok) {
      // The person did not get this message. A closed 24-hour window is a
      // known limit (only a template can reopen it); anything else is broken.
      if (r.windowClosed) trackUnmet("wa_window_closed", { props: facts, summary: "A message could not be sent: the person's 24-hour WhatsApp window had closed" });
      else
        trackFailure("wa_send_failed", r.error ?? "unknown", {
          severity: "error",
          alert: "immediate",
          props: facts,
          fingerprint: `wa_send_failed:${r.code ?? 0}`,
          summary: `WhatsApp refused a message (${r.code ?? "no code"}): ${(r.error ?? "").slice(0, 160)}`,
        });
    }
    const text = payloadText(payload);
    if (r.ok && APOLOGY_RE.test(text.replace(HONEST_GAP_RE, "")) && currentTrackContext().channel !== "system") {
      // Charles's reply, scrubbed like a person's words: it can echo them
      // ("I heard: …") or carry a number. What they said is the excerpt.
      const said = currentTrackContext().said?.trim();
      const reply = scrubExcerpt(said && said.length > 3 && text.includes(said) ? text.split(said).join("[their words]") : text);
      trackUnmet("apology_sent", { props: { reply, kind }, excerpt: said ?? null, summary: "Charles told a person it couldn't do something" });
    }
  } catch {
    /* tracking never breaks a send */
  }
  return r;
}

/** Only for the WhatsApp row of the message log: a send that did not land says so. */
const sendMeta = (r: SendResult, meta?: Record<string, unknown>): Record<string, unknown> | undefined =>
  r.ok ? meta : { ...(meta ?? {}), send_failed: true, ...(r.code ? { error_code: r.code } : {}), ...(r.windowClosed ? { window_closed: true } : {}) };

async function postRaw(payload: Record<string, unknown>): Promise<SendResult> {
  // Fencing (see jobctx.ts): an attempt whose job was reclaimed and re-run
  // must not send — the person would get two different answers to one question.
  const job = jobCtx.getStore();
  if (job && (!job.checkedAt || Date.now() - job.checkedAt > 5_000)) {
    if (!(await stillOwnJob(job.id, job.worker))) throw new JobFencedError(job.id);
    job.checkedAt = Date.now();
  }
  if (!configured()) {
    console.log("wa: not configured, nothing sent —", JSON.stringify(payload).slice(0, 300));
    return { ok: true, skipped: true };
  }
  let res: Response;
  try {
    res = await fetch(`${GRAPH()}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
      // Round 13: a call with no timeout that hangs holds its job "running"
      // until the platform kills the whole function, and nothing records why.
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    console.log("wa send unreachable", err);
    return { ok: false, error: String(err) };
  }
  const bodyText = await res.text();
  if (!res.ok) {
    // {"error":{"message","type","code","error_data":{"details"},"error_subcode","fbtrace_id"}}
    let code = 0;
    let details = "";
    let trace = "";
    try {
      const e = (JSON.parse(bodyText) as { error?: { code?: number; error_data?: { details?: string }; message?: string; fbtrace_id?: string } }).error;
      code = e?.code ?? 0;
      details = e?.error_data?.details ?? e?.message ?? "";
      trace = e?.fbtrace_id ?? "";
    } catch {
      /* a non-JSON error body is still an error */
    }
    console.log(`wa send ${res.status} code=${code} trace=${trace}: ${details || bodyText.slice(0, 300)}`);
    return {
      ok: false,
      code,
      error: `${res.status}/${code}: ${details || bodyText.slice(0, 200)}`,
      retryable: RETRYABLE_CODES.has(code) || res.status === 429 || res.status >= 500,
      windowClosed: code === RE_ENGAGEMENT_CODE,
    };
  }
  let id: string | undefined;
  try {
    id = (JSON.parse(bodyText) as { messages?: { id: string }[] }).messages?.[0]?.id;
  } catch {
    /* a 200 with an unreadable body is still a send */
  }
  return { ok: true, waMessageId: id };
}

// ── The sends ────────────────────────────────────────────────────

/**
 * `opts.kind` is how the conversation log labels this row. Every ordinary
 * text is "text"; the one exception is the web sign-in code, which api/plan.ts
 * records as "login_code" so db.ts can keep it out of every prompt, the
 * owner's own AI and the web (live, 2026-09-25: real one-time codes sat in
 * the messages table as plain "text" rows, feeding RECENT CONVERSATION).
 */
export async function sendText(to: string, text: string, businessId?: string | null, opts: { kind?: string } = {}): Promise<SendResult> {
  // Longer than one WhatsApp text: sent as several, split between paragraphs
  // (or sentences), never cut. Rare — a very long voice-note read-back.
  const parts = splitText((text ?? "").trim(), WA.textChars);
  if (parts.length > 1) {
    let last: SendResult = { ok: true };
    for (const p of parts) last = await sendText(to, p, businessId, opts);
    return last;
  }
  const body = fit(text, WA.textChars, "text body");
  const r = await post({ to, type: "text", text: { preview_url: false, body } });
  await recordMessage(businessId ?? null, "out", body, { kind: opts.kind ?? "text", waMessageId: r.waMessageId, meta: sendMeta(r) });
  return r;
}

/**
 * Up to three reply buttons. Each carries an explicit action id that comes
 * straight back in the webhook — which is why nothing in this product ever
 * dispatches on the button's visible title.
 */
export async function sendButtons(to: string, text: string, buttons: Button[], businessId?: string | null, footer?: string): Promise<SendResult> {
  // A button message holds 1024 characters; the end — usually the question
  // the buttons answer — is what a cut would lose. So the long part goes
  // first as a plain message and the buttons carry the closing paragraph(s).
  const { lead, body: tail } = splitForInteractive(text);
  if (lead) await sendText(to, lead, businessId);
  const body = fit(tail, WA.bodyChars, "button message body");
  const picked = buttons.slice(0, WA.buttons).map((b) => ({
    type: "reply",
    reply: { id: clip(b.id, WA.buttonIdChars), title: fit(b.title, WA.buttonTitleChars, "button title") },
  }));
  const r = await post({
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      ...(footer ? { footer: { text: fit(footer, WA.footerChars, "footer") } } : {}),
      action: { buttons: picked },
    },
  });
  await recordMessage(businessId ?? null, "out", body, {
    kind: "buttons",
    waMessageId: r.waMessageId,
    meta: sendMeta(r, { buttons: picked.map((b) => b.reply.id) }),
  });
  return r;
}

/**
 * A list message: up to ten rows across sections, one pick only. Used where
 * there are more than three options and the person must choose exactly one.
 * Multi-select is NOT possible on WhatsApp — that is why the multi-answer
 * diagnostic questions go out as numbered text instead.
 */
export async function sendList(
  to: string,
  text: string,
  buttonLabel: string,
  sections: { title: string; rows: ListRow[] }[],
  businessId?: string | null,
): Promise<SendResult> {
  const { lead, body: tail } = splitForInteractive(text);
  if (lead) await sendText(to, lead, businessId);
  const body = fit(tail, WA.bodyChars, "list message body");
  let budget = WA.listRows;
  const cleaned = sections
    .map((s) => {
      const rows = s.rows.slice(0, Math.max(0, budget)).map((r) => ({
        id: clip(r.id, WA.buttonIdChars),
        title: fit(r.title, WA.listRowTitleChars, "list row title"),
        ...(r.description ? { description: fit(r.description, WA.listRowDescChars, "list row description") } : {}),
      }));
      budget -= rows.length;
      return { title: fit(s.title, WA.listSectionTitleChars, "list section title"), rows };
    })
    .filter((s) => s.rows.length);

  const r = await post({
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body },
      action: { button: fit(buttonLabel, WA.listButtonChars, "list button"), sections: cleaned },
    },
  });
  await recordMessage(businessId ?? null, "out", body, { kind: "list", waMessageId: r.waMessageId, meta: sendMeta(r) });
  return r;
}

/** Outside the 24-hour window, only an approved template may open a conversation. */
export async function sendTemplate(
  to: string,
  templateName: string,
  language: string,
  bodyParams: string[],
  businessId?: string | null,
  /**
   * An AUTHENTICATION template carries its code twice: in the body, and again
   * in the copy-code button. Meta refuses the send if the button parameter is
   * missing, so a one-time-code template must pass `otp: true`.
   */
  opts: { otp?: boolean } = {},
): Promise<SendResult> {
  const components: unknown[] = [];
  if (bodyParams.length) components.push({ type: "body", parameters: bodyParams.map((t) => ({ type: "text", text: clip(t, 300) })) });
  if (opts.otp && bodyParams[0]) {
    components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: clip(bodyParams[0], 15) }] });
  }
  const r = await post({
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: language || "en" },
      ...(components.length ? { components } : {}),
    },
  });
  await recordMessage(businessId ?? null, "out", opts.otp ? `[template ${templateName}] (one-time code)` : `[template ${templateName}] ${bodyParams.join(" | ")}`, {
    kind: "template",
    waMessageId: r.waMessageId,
    meta: sendMeta(r, { template: templateName }),
  });
  return r;
}

/** A picture in the chat (a card, cards.ts), with its caption carrying the link. */
export async function sendImage(to: string, mediaId: string, caption: string, businessId?: string | null): Promise<SendResult> {
  const r = await post({ to, type: "image", image: { id: mediaId, caption: fit(caption, 1024, "image caption") } });
  await recordMessage(businessId ?? null, "out", `[image] ${caption}`, { kind: "image", waMessageId: r.waMessageId, meta: sendMeta(r) });
  return r;
}

export async function sendDocument(
  to: string,
  mediaId: string,
  filename: string,
  caption: string,
  businessId?: string | null,
): Promise<SendResult> {
  const r = await post({ to, type: "document", document: { id: mediaId, filename, caption: fit(caption, 1024, "document caption") } });
  await recordMessage(businessId ?? null, "out", `[document ${filename}] ${caption}`, { kind: "document", waMessageId: r.waMessageId, meta: sendMeta(r) });
  return r;
}

/**
 * Tells WhatsApp to show the blue ticks. Cheap, and it is the difference
 * between "it's thinking" and "it's broken" while a plan is being built.
 */
export async function markRead(waMessageId: string, typing = true): Promise<void> {
  if (!configured() || !waMessageId) return;
  try {
    await fetch(`${GRAPH()}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: waMessageId,
        // Building a plan takes seconds. Without this the person watches nothing
        // happen and assumes it broke.
        ...(typing ? { typing_indicator: { type: "text" } } : {}),
      }),
    });
  } catch (err) {
    console.warn("markRead failed", err);
  }
}

// ── Media ────────────────────────────────────────────────────────

/**
 * Inbound media is a two-step fetch: the id resolves to a short-lived URL, and
 * that URL still needs the bearer token. Fetching it without the token returns
 * a 401 that looks like a broken link.
 */
const META_MEDIA_HOSTS = /(^|\.)(fbsbx\.com|facebook\.com|fbcdn\.net|whatsapp\.net)$/i;

export function isMetaMediaHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && META_MEDIA_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

export async function downloadMedia(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  if (!configured()) return null;
  try {
    const metaRes = await fetch(`${GRAPH()}/${mediaId}`, { headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    if (!metaRes.ok) {
      console.error(`downloadMedia lookup ${metaRes.status}`);
      return null;
    }
    const info = (await metaRes.json()) as { url?: string; mime_type?: string; file_size?: number };
    if (!info.url) return null;

    // The second request carries our access token. Check the host is Meta's
    // first: a poisoned metadata response would otherwise send the token
    // wherever it asked.
    if (!isMetaMediaHost(info.url)) {
      console.error("downloadMedia: refusing to send the token to", info.url.slice(0, 80));
      return null;
    }
    if ((info.file_size ?? 0) > 20 * 1024 * 1024) {
      console.warn("downloadMedia: file over 20MB, refusing");
      return null;
    }
    const fileRes = await fetch(info.url, { headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
    if (!fileRes.ok) {
      console.error(`downloadMedia fetch ${fileRes.status}`);
      return null;
    }
    return { bytes: new Uint8Array(await fileRes.arrayBuffer()), mimeType: info.mime_type ?? "application/octet-stream" };
  } catch (err) {
    console.error("downloadMedia failed", err);
    return null;
  }
}

/** Upload a file and get back the media id a document message references. */
export async function uploadMedia(bytes: Uint8Array, mimeType: string, filename: string): Promise<string | null> {
  if (!configured()) return null;
  try {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    // Copy into a plain ArrayBuffer: a Uint8Array view can sit on a shared or
    // offset buffer, and Blob would then carry the wrong bytes.
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    // Never set Content-Type by hand here: fetch has to write the multipart
    // boundary itself, and overriding the header silently corrupts the body.
    form.append("file", new Blob([ab], { type: mimeType }), filename);

    const res = await fetch(`${GRAPH()}/${env.WHATSAPP_PHONE_NUMBER_ID}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
      body: form,
    });
    if (!res.ok) {
      console.log(`uploadMedia ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    return ((await res.json()) as { id?: string }).id ?? null;
  } catch (err) {
    console.log("uploadMedia failed", err);
    return null;
  }
}

// ── Reading what arrives ─────────────────────────────────────────

import type { InboundMessage } from "./types.js";

export interface StatusUpdate {
  waMessageId: string;
  recipient: string;
  status: "sent" | "delivered" | "read" | "failed";
  /** Meta's authoritative end of the 24-hour window, when it tells us. */
  windowExpiresAt: number | null;
  errorCode?: number;
  errorDetail?: string;
}

interface ParsedWebhook {
  messages: InboundMessage[];
  statuses: StatusUpdate[];
}

/**
 * Normalises one webhook body into every message and status it carries.
 *
 * Three things here are load-bearing, and each was a real bug in the first
 * version:
 *   - Meta BATCHES. Three voice notes in a row can arrive as one POST with
 *     three entries. Reading only [0] silently drops the rest.
 *   - `statuses` entries (sent / delivered / read / failed) are NOT messages.
 *     Every outbound message generates several, on the same `messages` field.
 *     Treating one as a message replies to a person who said nothing — and, if
 *     it flows into an upsert, creates a junk business row.
 *   - A tapped button or list row carries its own id. That id is the action.
 *     The first version read `button_reply` only, so every list tap arrived as
 *     empty text and fell through to the diagnostic's text parser.
 */
export function parseWebhook(body: unknown): ParsedWebhook {
  const out: ParsedWebhook = { messages: [], statuses: [] };
  const entries = (body as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] } | null)?.changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      const ch = (change ?? {}) as { field?: string; value?: Record<string, unknown> };
      // The same URL also receives template approvals, quality updates and
      // account changes once those fields are subscribed. A malformed entry
      // must skip only itself: throwing here would discard every other message
      // Meta batched into the same delivery.
      if (ch.field !== "messages" || !ch.value) continue;

      for (const raw of ((ch.value.statuses as Record<string, unknown>[]) ?? []).filter(Boolean)) {
        const errors = raw.errors as { code?: number; error_data?: { details?: string }; title?: string }[] | undefined;
        const conversation = raw.conversation as { expiration_timestamp?: string } | undefined;
        const expiry = conversation?.expiration_timestamp ? Number(conversation.expiration_timestamp) * 1000 : null;
        out.statuses.push({
          waMessageId: String(raw.id ?? ""),
          recipient: String(raw.recipient_id ?? ""),
          status: String(raw.status ?? "sent") as StatusUpdate["status"],
          windowExpiresAt: Number.isFinite(expiry) ? expiry : null,
          errorCode: errors?.[0]?.code,
          errorDetail: errors?.[0]?.error_data?.details ?? errors?.[0]?.title,
        });
      }

      // Every message carries the number it was SENT TO — the bot's own. Kept
      // on the message, it is how the website's WhatsApp button finds the
      // number when Meta's phone-number lookup answers without one (live,
      // rounds 4–6: 200 with no display_phone_number; /wa dead in production).
      const meta = (ch.value.metadata ?? {}) as { display_phone_number?: unknown; phone_number_id?: unknown };
      for (const raw of ((ch.value.messages as Record<string, unknown>[]) ?? []).filter(Boolean)) {
        const msg = normaliseMessage(raw);
        if (msg) {
          if (typeof meta.display_phone_number === "string") msg.toNumber = meta.display_phone_number;
          if (typeof meta.phone_number_id === "string") msg.toPhoneId = meta.phone_number_id;
          out.messages.push(msg);
        }
      }
    }
  }
  return out;
}

function normaliseMessage(msg: Record<string, unknown>): InboundMessage | null {
  const waMessageId = String(msg.id ?? "");
  const from = String(msg.from ?? "");
  if (!waMessageId || !from) return null;
  // Meta sends the timestamp as a string of Unix SECONDS.
  const common = { waMessageId, from, timestamp: Number(msg.timestamp ?? 0) * 1000 };
  const type = String(msg.type ?? "");

  if (type === "text") {
    return { ...common, kind: "text", text: String((msg.text as { body?: string })?.body ?? "") };
  }

  if (type === "interactive") {
    const inter = msg.interactive as {
      type?: string;
      button_reply?: { id: string; title: string };
      list_reply?: { id: string; title: string };
      nfm_reply?: { response_json?: string };
    };
    const reply = inter?.button_reply ?? inter?.list_reply;
    if (reply) {
      return {
        ...common,
        kind: inter?.button_reply ? "button" : "list",
        text: "",
        actionId: reply.id,
        actionLabel: reply.title,
      };
    }
    // A WhatsApp Flow submission. Not used yet; carry the payload as text so
    // it is at least visible rather than silently dropped.
    if (inter?.nfm_reply?.response_json) {
      return { ...common, kind: "text", text: inter.nfm_reply.response_json.slice(0, 2000) };
    }
  }

  // A tap on a template's quick-reply button arrives as its own type.
  if (type === "button") {
    const b = msg.button as { payload?: string; text?: string };
    return { ...common, kind: "button", text: "", actionId: b?.payload ?? "", actionLabel: b?.text ?? "" };
  }

  if (type === "audio" || type === "voice") {
    // `voice: true` means it was recorded with the mic rather than attached.
    const a = msg.audio as { id?: string; mime_type?: string; voice?: boolean };
    return { ...common, kind: "audio", text: "", mediaId: a?.id, mimeType: a?.mime_type };
  }

  if (type === "image") {
    const i = msg.image as { id?: string; mime_type?: string; caption?: string };
    return { ...common, kind: "image", text: i?.caption ?? "", mediaId: i?.id, mimeType: i?.mime_type };
  }

  if (type === "document") {
    const d = msg.document as { id?: string; mime_type?: string; caption?: string; filename?: string };
    return { ...common, kind: "document", text: d?.caption ?? d?.filename ?? "", mediaId: d?.id, mimeType: d?.mime_type };
  }

  return { ...common, kind: "unsupported", text: "" };
}

/** Meta's own 24-hour customer service window. Outside it, only templates. */
export function withinServiceWindow(lastInboundAt: string | null | undefined): boolean {
  if (!lastInboundAt) return false;
  const t = new Date(lastInboundAt).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < 24 * 60 * 60 * 1000;
}
