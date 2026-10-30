// Charles — a card, opened from a WhatsApp link.
//
// /c/<token> (vercel.json rewrites it here as ?t=) serves the snapshot the
// token points at (api/_lib/cards.ts). The token is the whole credential: a
// long random string that only the person's chat has, stored as a hash, good
// for sixty days. The page carries no identifier of the person, is marked
// noindex and no-store, and sends no referrer.
//
// /c?demo=<kind> serves Lerato's invented figures: the landing page links
// them so a visitor (or a bank) can play before any pilot. They say so.

import { cardByToken, cardHTML, CARD_KINDS, demoCard, type CardKind } from "./_lib/cards.js";
import { track, tracked } from "./_lib/track.js";

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};

const gone = (title: string, line: string): Response =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} — Charles</title>
<style>body{margin:0;background:#f3f5f4;color:#14181d;font-family:Inter,system-ui,sans-serif;padding:40px 20px;text-align:center}h1{font-family:"Instrument Serif",Georgia,serif;font-weight:400;font-size:2rem;margin:0 0 10px}p{color:#3a4149;max-width:36ch;margin:0 auto}</style></head>
<body><h1>${title}</h1><p>${line}</p></body></html>`,
    { status: 404, headers: HEADERS },
  );

async function handler(req: Request): Promise<Response> {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const url = new URL(req.url);
  const demo = url.searchParams.get("demo");
  const png = url.searchParams.get("png") === "1";

  if (demo) {
    if (!CARD_KINDS.includes(demo as CardKind)) return gone("No such card", "The demo cards are month, debt, map, statement and goal.");
    const kind = demo as CardKind;
    track("card_opened", { category: "behaviour", props: { kind, demo: true } });
    return new Response(cardHTML(kind, demoCard(kind) as never, { demo: true, png }), { status: 200, headers: HEADERS });
  }

  const token = url.searchParams.get("t") ?? "";
  const card = token ? await cardByToken(token) : null;
  if (!card) return gone("This link doesn't open anything", "Ask Charles on WhatsApp for a new one: say \"show me my month\", \"my map\" or \"what I owe\".");
  if (card.expired) return gone("This link has expired", "A card link works for sixty days. Ask Charles on WhatsApp for a fresh one and it comes with today's figures.");
  track("card_opened", { category: "behaviour", businessId: card.business_id, props: { kind: card.kind, demo: false } });
  return new Response(cardHTML(card.kind, card.data as never, { png }), { status: 200, headers: HEADERS });
}

const served = tracked("card", "web", handler);
export const GET = served;
