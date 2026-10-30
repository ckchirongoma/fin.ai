// Charles — asking the render function for a PDF, without importing Chromium.
//
// See the note at the top of _lib/pdf.ts: Chromium is ~64MB of incompressible
// binaries, traced into every function that imports it. Keeping it behind an
// HTTP call means the webhook and the worker stay small, and a Chromium
// deployment problem degrades one feature instead of taking down the product.
//
// Every PDF a person was promised and did not get is one pdf_failed event,
// recorded here at its cause (render, upload or send), so a caller never
// records it again. `kind` says which document, when the caller passes it.

import { env } from "./env.js";
import { since, trackFailure } from "./track.js";
import { jobMsLeft } from "./jobctx.js";
import { sendDocument, sendText, uploadMedia } from "./wa.js";
import { nextHop } from "./chain.js";

/** Which document a PDF is, for the record. */
export type PdfKind = "plan" | "step";

const kb = (n: number): number => Math.round(n / 1024);

/** The pause before a render's second try. */
let RETRY_AFTER_MS = 3_000;
export function __setRenderRetryMs(ms: number): void {
  RETRY_AFTER_MS = ms;
}

/** Whether a PDF can be rendered at all: without these a retry would fail the same way. */
export const pdfConfigured = (): boolean => Boolean(env.PUBLIC_BASE_URL && env.WORKER_SECRET);

/**
 * A card as a PNG, through the same function (format: "png"). One try, a
 * short timeout and a plain null on failure: the person always has the link,
 * the picture is the nicety.
 */
export async function renderPng(html: string, width = 420): Promise<Uint8Array | null> {
  if (!env.PUBLIC_BASE_URL || !env.WORKER_SECRET) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(`${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/render-pdf?hop=${nextHop()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.WORKER_SECRET}` },
      body: JSON.stringify({ html, format: "png", width }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.log(`renderPng ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.byteLength ? bytes : null;
  } catch (err) {
    console.log("renderPng failed", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Renders via the dedicated function. Returns null on any failure. */
export async function renderPdf(html: string, kind?: PdfKind): Promise<Uint8Array | null> {
  const started = Date.now();
  if (!env.PUBLIC_BASE_URL || !env.WORKER_SECRET) {
    console.log("renderPdf: PUBLIC_BASE_URL and WORKER_SECRET are both required");
    trackFailure("pdf_failed", new Error("PUBLIC_BASE_URL or WORKER_SECRET is not set"), {
      severity: "critical",
      props: { kind, phase: "config" },
      fingerprint: "pdf_failed:config",
      summary: "No PDF can be rendered: PUBLIC_BASE_URL or WORKER_SECRET is not set",
    });
    return null;
  }
  // Two tries. Round 22, live: the render function answered 508 in 23ms —
  // refused before it ran, which says nothing about whether the next request
  // would be — and the plan went out with no PDF and no second try. A
  // render that took its whole two minutes is not tried again: the function
  // ran, and the person has waited long enough.
  let last: { err: unknown; props: Record<string, unknown> } | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) {
      // Inside a job, a second try that could not finish before the
      // attempt's hard stop is not started (jobctx.ts): the plan_pdf retry
      // and the "Send the PDF" button are there for it.
      const left = jobMsLeft();
      if (left !== null && left < RETRY_AFTER_MS + 130_000) break;
      await new Promise((r) => setTimeout(r, RETRY_AFTER_MS));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const tryStarted = Date.now();
    try {
      // The render is one more call to this deployment: it carries its depth
      // (chain.ts), and the depth goes on any failure below.
      const res = await fetch(`${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/render-pdf?hop=${nextHop()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.WORKER_SECRET}` },
        body: JSON.stringify({ html }),
        signal: controller.signal,
      });
      if (res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (attempt > 1) console.warn(`renderPdf: rendered on try ${attempt} after ${JSON.stringify(last?.props ?? {})}`);
        return bytes;
      }
      // Vercel says which of its own refusals it was (x-vercel-error, e.g.
      // INFINITE_LOOP_DETECTED for a 508): the fact that tells a platform
      // refusal from our renderer failing.
      const platform = res.headers.get("x-vercel-error");
      console.log(`renderPdf ${res.status}${platform ? ` ${platform}` : ""}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      last = { err: new Error(`the render function answered ${res.status}${platform ? ` (${platform})` : ""}`), props: { status: res.status, ...(platform ? { platform_error: platform } : {}) } };
      // A 4xx is ours to fix (a bad secret, a bad request): the same request
      // fails the same way. A 5xx that took a minute means the renderer ran
      // and failed: not tried again either (review, round 22).
      if (res.status < 500 || Date.now() - tryStarted > 60_000) break;
    } catch (err) {
      console.log("renderPdf failed", err);
      const timedOut = controller.signal.aborted;
      last = { err, props: { timed_out: timedOut } };
      if (timedOut || Date.now() - tryStarted > 60_000) break;
    } finally {
      clearTimeout(timer);
    }
  }
  trackFailure("pdf_failed", last?.err ?? new Error("the render failed"), {
    ms: since(started),
    props: { kind, phase: "render", html_kb: kb(html.length), hop: nextHop(), ...(last?.props ?? {}) },
  });
  return null;
}

/**
 * Renders, uploads and sends. Returns false when the person did not get a file,
 * so the caller can say something true about it rather than going quiet.
 */
export async function renderAndSendPlanPdf(
  html: string,
  to: string,
  filename: string,
  caption: string,
  businessId?: string | null,
  planUrl?: string | null,
  kind?: PdfKind,
): Promise<boolean> {
  const bytes = await renderPdf(html, kind);
  if (!bytes) {
    await sendText(
      to,
      `The PDF didn't come out just then — that's on me, not on your plan. Everything above is saved.${planUrl ? ` You can read the whole thing here any time: ${planUrl}` : ""} Tell me when you want the first step.`,
      businessId,
    );
    return false;
  }

  const delivered = await sendRenderedPdf(bytes, to, filename, caption, businessId, kind);
  // Rendered but not delivered (upload or send failed): one true line rather
  // than silence. The step's own messages above still hold everything in it.
  if (!delivered) {
    await sendText(to, `The PDF didn't come through on WhatsApp just then — everything in it is in the messages above.${planUrl ? ` The whole plan is also here: ${planUrl}` : ""}`, businessId);
  }
  return delivered;
}

/** Uploads and sends a PDF that is already rendered. False when the person did not get it. */
export async function sendRenderedPdf(bytes: Uint8Array, to: string, filename: string, caption: string, businessId?: string | null, kind?: PdfKind): Promise<boolean> {
  return (await deliverRenderedPdf(bytes, to, filename, caption, businessId, kind)).ok;
}

/** What became of a rendered PDF: sent, or which step stopped it (and whether the 24-hour window had closed). */
export interface PdfDelivery {
  ok: boolean;
  phase?: "upload" | "send";
  windowClosed?: boolean;
}

/** sendRenderedPdf, saying which step failed — for a caller that retries (engine/planpdf.ts). */
export async function deliverRenderedPdf(bytes: Uint8Array, to: string, filename: string, caption: string, businessId?: string | null, kind?: PdfKind): Promise<PdfDelivery> {
  const mediaId = await uploadMedia(bytes, "application/pdf", filename);
  if (!mediaId) {
    console.log(`pdf rendered (${bytes.byteLength} bytes) but not sent: no media id`);
    // Only a console.log before: a rendered PDF that never reached the person left no failure anywhere.
    trackFailure("pdf_failed", new Error("WhatsApp's media upload gave no media id"), {
      props: { kind, phase: "upload", pdf_kb: kb(bytes.byteLength) },
      summary: "A rendered PDF could not be uploaded to WhatsApp, so the person did not get it",
    });
    return { ok: false, phase: "upload" };
  }
  const sent = await sendDocument(to, mediaId, filename, caption, businessId);
  if (!sent.ok) {
    // WhatsApp's refusal is already its own immediate incident (wa_send_failed);
    // this one names the document, hourly.
    trackFailure("pdf_failed", new Error(`the document send failed${sent.code ? ` (code ${sent.code})` : ""}`), {
      alert: "digest",
      props: { kind, phase: "send", code: sent.code ?? null, window_closed: sent.windowClosed === true, pdf_kb: kb(bytes.byteLength) },
    });
  }
  return sent.ok ? { ok: true } : { ok: false, phase: "send", windowClosed: sent.windowClosed === true };
}
