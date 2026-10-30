// Fin — the WhatsApp webhook.
//
// This endpoint has exactly one job and a hard deadline: prove the request came
// from Meta, write down what arrived, and answer 200 in well under a second.
// Everything slow — model calls, PDF rendering, outbound sends — happens after
// that, driven by the queue.
//
// Why it is built this way, specifically:
//   - Meta RETRIES any webhook it does not get a fast 2xx for, resending the
//     identical message id. The first version awaited the whole plan build
//     before responding, so a slow build guaranteed a redelivery, which
//     guaranteed a second plan for the same owner. Dedupe happens on the wamid,
//     before any work, using a unique constraint rather than a read-then-write.
//   - The signature is computed over the RAW bytes. Meta escapes non-ASCII as
//     \uXXXX; re-serialising the parsed JSON changes the bytes and the digest
//     never matches — which would mean every message containing an accent, an
//     emoji or a non-Latin script silently failing. Read the body once as text,
//     verify that string, then parse that same string.
//   - The function is public by design. Meta authenticates with its own
//     signature, not a login. Without WHATSAPP_APP_SECRET set there is nothing
//     authenticating this endpoint at all, so it refuses to process anything.

import { timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { env, isInternalNumber } from "./_lib/env.js";
import { metaSignature } from "./_lib/crypto.js";
import { parseWebhook } from "./_lib/wa.js";
import { claimInbound, db, enqueue, findBusiness } from "./_lib/db.js";
import { drainQueue } from "./_lib/queue.js";
import { errorText, track, trackFailure, tracked } from "./_lib/track.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Hub-Signature-256",
};

/**
 * An error, safe for trackFailure: a database error becomes its code and
 * message, never `details`, where Postgres puts the failing row — here an
 * owner's message, their number and its wamid (the number, base64'd).
 */
function dbError(err: unknown): unknown {
  if (err instanceof Error || typeof err === "string") return err;
  const e = (err && typeof err === "object" ? err : {}) as { code?: unknown; message?: unknown };
  return `${e.code ? `${String(e.code)}: ` : ""}${e.message !== undefined ? String(e.message) : "database error"}`.slice(0, 300);
}

function signatureValid(rawBody: string, header: string | null): boolean {
  if (!env.WHATSAPP_APP_SECRET) return false;
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = metaSignature(rawBody, env.WHATSAPP_APP_SECRET);
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  // ── Meta's verification handshake ──
  // The challenge must come back as RAW text. Wrapping it in JSON is the most
  // common reason the dashboard reports "verification failed".
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token && token === env.WHATSAPP_VERIFY_TOKEN) {
      return new Response(challenge ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return new Response("Forbidden", { status: 403, headers: cors });
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

  // Read the body ONCE, as text. It is a stream and cannot be consumed twice,
  // and the HMAC needs exactly these bytes.
  let raw: string;
  try {
    raw = await req.text();
  } catch (err) {
    trackFailure("webhook_accept_failed", err, { severity: "warn", alert: "digest", props: { phase: "read_body" }, fingerprint: "webhook_accept_failed:read_body" });
    return new Response("Bad request", { status: 400, headers: cors });
  }

  if (!env.WHATSAPP_APP_SECRET) {
    // Refusing is the only safe behaviour: without the app secret anyone who
    // finds this URL could write owner data and spend model credits. Meta will
    // retry, so nothing is lost once the secret is set.
    console.log("webhook refused: WHATSAPP_APP_SECRET is not set, so the request cannot be authenticated");
    // Every owner's message is being turned away (a 503 is not request_failed).
    track("webhook_signature_invalid", {
      category: "failure",
      severity: "critical",
      alert: "immediate",
      props: { reason: "no_secret" },
      fingerprint: "webhook_signature_invalid:no_secret",
      summary: "WHATSAPP_APP_SECRET is not set, so every WhatsApp message is refused; Meta retries for a while, then drops them",
    });
    return new Response("Webhook not configured", { status: 503, headers: cors });
  }

  const signature = req.headers.get("x-hub-signature-256");
  if (!signatureValid(raw, signature)) {
    console.log("webhook refused: bad or missing X-Hub-Signature-256");
    // No header at all is usually someone probing the URL. A wrong one is
    // either tampering or a rotated app secret refusing every real message.
    const reason = signature ? "mismatch" : "missing";
    track("webhook_signature_invalid", {
      category: "security",
      severity: signature ? "error" : "warn",
      alert: signature ? "immediate" : "digest",
      props: { reason, body_bytes: raw.length },
      fingerprint: `webhook_signature_invalid:${reason}`,
      summary: signature
        ? "A webhook call carried a WhatsApp signature that does not match: tampering, or WHATSAPP_APP_SECRET no longer matches the app (every real message refused)"
        : "A webhook call with no WhatsApp signature was refused",
    });
    return new Response("Forbidden", { status: 403, headers: cors });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    // Signed by Meta, so it really came from them: whatever was in it is lost.
    // Not the parser's message: it quotes the body, which is people' words.
    trackFailure("webhook_accept_failed", "the signed body is not valid JSON", { severity: "warn", alert: "digest", props: { phase: "parse", body_bytes: raw.length }, fingerprint: "webhook_accept_failed:parse" });
    return new Response("EVENT_RECEIVED", { status: 200, headers: cors });
  }

  // Everything below is best-effort. Meta must see a 200 either way: returning
  // 500 for an application error we have already accepted only guarantees a
  // redelivery of the thing that just failed.
  let queued = 0;
  try {
    queued = await accept(body);
  } catch (err) {
    console.log("webhook accept failed", err);
    // Meta has its 200 regardless, so it will not redeliver: anything in this
    // delivery not yet queued is lost.
    trackFailure("webhook_accept_failed", dbError(err), {
      severity: "critical",
      props: { phase: "batch" },
      summary: `A WhatsApp delivery could not be written down and Meta will not resend it; people' messages may be lost: ${errorText(dbError(err)).slice(0, 140)}`,
    });
  }

  // Drain in the same invocation, AFTER the response is decided. Meta has its
  // 200 in milliseconds either way; maxDuration governs how long this
  // invocation may keep working afterwards, which is why it is set to the
  // maximum in vercel.json rather than to something that looks like a webhook
  // timeout — a plan build takes minutes, not seconds.
  //
  // waitUntil, not a bare fire-and-forget promise: Vercel's Node runtime is
  // free to freeze or tear down the function the instant the response is
  // flushed, and an un-awaited promise with no waitUntil has no claim on
  // staying alive past that point. Without this, every job here gets claimed
  // (locked "running") and then simply stops — no error, no log line, because
  // the process is gone before it can write one. That is exactly the failure
  // this project hit in production: three inbound messages claimed, none
  // ever answered. waitUntil is the documented way to tell Vercel "the
  // response can go now, but keep this instance alive until this promise
  // settles" — up to maxDuration, same budget as before.
  //
  // The queue row is already durable, so if this instance IS killed anyway
  // (a real crash, not this response-flush freeze) the work survives: the
  // sweep endpoint, or simply the person's next message, picks it up once the
  // five-minute abandoned-lock window passes.
  const work = queued > 0 ? drainQueue({ maxJobs: 4, label: "webhook" }) : null;

  const res = new Response("EVENT_RECEIVED", { status: 200, headers: cors });
  if (work) waitUntil(work.catch((err) => console.error("inline drain failed", err)));
  return res;
}

/** Writes everything durable, returns how many jobs are now waiting. */
async function accept(body: unknown): Promise<number> {
  const { messages, statuses } = parseWebhook(body);

  // Delivery receipts are not messages. They do carry the authoritative end of
  // the 24-hour window, which decides whether a nudge may be free-form or must
  // be a template — and they are where a send that returned 200 tells us it
  // actually failed.
  for (const s of statuses) {
    if (s.status === "failed") {
      // console.log, not error: delivery_failed below is the record, and a
      // logged error would be a second incident for the same thing.
      console.log(`wa delivery failed to ${s.recipient}: code=${s.errorCode} ${s.errorDetail ?? ""}`);
      // The send was accepted (message_sent says it landed); the person never
      // got it. Not attributed to a person: that needs a lookup by number,
      // and a wamid carries the number inside it, so neither goes in an event.
      // 131026 "Message Undeliverable" is the recipient's side (no WhatsApp on
      // that number, an old app, a block): hourly, not a page. Round 19: 191
      // of them from the testers' synthetic numbers would each have paged.
      const undeliverable = Number(s.errorCode) === 131026;
      const internal = isInternalNumber(s.recipient);
      trackFailure("delivery_failed", `Meta code ${s.errorCode ?? "none"}: ${s.errorDetail ?? ""}`, {
        severity: undeliverable || internal ? "warn" : "error",
        alert: undeliverable || internal ? "digest" : "immediate",
        internal,
        props: { code: s.errorCode ?? null, detail: errorText(s.errorDetail ?? "").slice(0, 160) },
        fingerprint: `delivery_failed:${s.errorCode ?? "none"}`,
        summary: `WhatsApp could not deliver a message Fin sent (Meta code ${s.errorCode ?? "none"}: ${errorText(s.errorDetail ?? "").slice(0, 120)})`,
      });
    }
    if (s.windowExpiresAt && s.recipient) {
      const biz = await findBusiness(s.recipient).catch((err) => {
        // Same harm as the update below failing: the window goes unrecorded.
        console.warn("webhook: the 24-hour window could not be recorded (owner lookup failed)", err);
        return null;
      });
      if (biz) {
        const { error } = await db()
          .from("businesses")
          .update({ last_inbound_at: new Date(s.windowExpiresAt - 24 * 3600 * 1000).toISOString() })
          .eq("id", biz.id);
        // The window decides whether a nudge may be free-form or must be a template.
        if (error) console.warn("webhook: the 24-hour window could not be recorded", error);
      }
    }
  }

  let queued = 0;
  for (const msg of messages) {
    // Dedupe BEFORE any work. A unique insert is atomic; a read-then-write
    // loses the race against Meta's retry.
    const isNew = await claimInbound(msg.waMessageId, msg.from).catch((err) => {
      console.log("claimInbound failed", err);
      trackFailure("webhook_accept_failed", dbError(err), { severity: "warn", alert: "digest", props: { phase: "dedupe", kind: msg.kind }, fingerprint: "webhook_accept_failed:dedupe", summary: "A WhatsApp message could not be checked for duplicates and was processed anyway (it may be answered twice)" });
      return true; // better to risk a duplicate than to drop a real message
    });
    if (!isNew) {
      console.log(`webhook: ${msg.waMessageId} already handled, skipping`);
      // Meta resending what we already have: a rising count means it is not
      // getting its 200 fast enough.
      track("webhook_duplicate_dropped", { category: "performance", props: { kind: msg.kind, secs_late: msg.timestamp ? Math.round((Date.now() - msg.timestamp) / 1000) : null } });
      continue;
    }
    try {
      await enqueue({ kind: "inbound", waId: msg.from, payload: msg as unknown as Record<string, unknown> });
      queued++;
    } catch (err) {
      // The dedupe row is already written, so without this the message would be
      // remembered as handled and never queued — and Meta's retry, the one
      // mechanism that could recover it, would be turned away at the door.
      // Give the retry its door back.
      // The wamid goes to the log only: a console.error is also an event, and a
      // wamid is the person's number, base64'd.
      console.log(`enqueue failed for ${msg.waMessageId}`);
      console.log("enqueue failed, releasing the dedupe row so Meta's retry can land", err);
      const { error: releaseError } = await db().from("wa_inbound").delete().eq("wa_message_id", msg.waMessageId);
      if (releaseError) console.log("could not release the dedupe row: a redelivery of this message will be turned away", releaseError);
      // A person's message that is not queued is not answered. If the release
      // failed too, Meta's retry is refused as a duplicate and it is gone.
      trackFailure("webhook_accept_failed", dbError(err), {
        severity: "critical",
        props: { phase: "enqueue", kind: msg.kind, released: !releaseError },
        fingerprint: "webhook_accept_failed:enqueue",
        summary: releaseError
          ? "A person's WhatsApp message could not be queued and its dedupe row could not be released: it is lost"
          : "A person's WhatsApp message could not be queued; it is not answered unless Meta delivers it again",
      });
    }
  }
  return queued;
}

// Vercel's Node runtime dispatches on NAMED method exports for the web-standard
// (Request) => Response signature. A bare default export is treated as the
// legacy (req, res) form, its returned Response is discarded, res.end() is
// never called, and every request hangs until it times out with a 504. Do not
// "tidy" these into a default export.
const served = tracked("whatsapp-webhook", "whatsapp", handler);
export const GET = served;
export const POST = served;
export const OPTIONS = served;
