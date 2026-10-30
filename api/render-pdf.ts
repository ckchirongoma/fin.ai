// Charles — the one function that carries Chromium.
//
// Isolated on purpose. @sparticuz/chromium ships ~64MB of already-compressed
// binaries and Vercel traces dependencies per entrypoint, so anything importing
// it inherits the whole payload and the bundle-size risk. Keeping it behind one
// endpoint means the webhook and the worker stay small and fast, and a Chromium
// problem degrades the PDF rather than taking the product down.
//
// Internal only: authenticated with WORKER_SECRET, never exposed to people.

import { htmlToPdf } from "./_lib/pdf.js";
import { authorised } from "./worker.js";
import { noteRequestFailure, tracked } from "./_lib/track.js";

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!authorised(req)) return new Response("Forbidden", { status: 403 });

  let html: string;
  try {
    const body = (await req.json()) as { html?: string };
    html = String(body.html ?? "");
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!html.trim()) return new Response("No html", { status: 400 });

  try {
    const pdf = await htmlToPdf(html);
    return new Response(pdf as unknown as BodyInit, {
      status: 200,
      headers: { "Content-Type": "application/pdf", "Content-Length": String(pdf.byteLength) },
    });
  } catch (err) {
    console.log("render-pdf failed", err);
    noteRequestFailure(err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

const served = tracked("render-pdf", "system", handler);
export const POST = served;
export const OPTIONS = served;
