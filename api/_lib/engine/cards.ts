// Charles — sending a card: the link, and the picture of it, into the chat.
//
// A card (../cards.ts) is built here from the household row, stored as a
// snapshot behind a link, drawn as a PNG by the same Chromium that makes the
// PDF, and sent as an image whose caption carries the link. When the picture
// cannot be made (no Chromium, a timeout, a refused upload) the link goes on
// its own: the page is the thing, the picture is the nicety. When the card
// cannot be built at all (no statement yet, no map yet) the person is told
// what would make it possible, in one line.

import { cardName, CARD_CAPTION, CARD_TITLE, debtCardData, goalCardData, mapCardData, mintCard, monthCardData, statementCardData, cardHTML, type CardKind } from "../cards.js";
import { planFor } from "../db.js";
import { pdfConfigured, renderPng } from "../pdfclient.js";
import { track } from "../track.js";
import { sendImage, sendText, uploadMedia } from "../wa.js";
import type { Business } from "../types.js";

/** What is missing, when a card cannot be built from this household yet. */
export const CARD_NEEDS: Record<CardKind, string> = {
  month: "I draw your month from a bank statement. Send one here (a PDF from your banking app, or a photo of the pages) and I'll lay it out in three pots you can play with.",
  statement: "I can draw that once you've sent a statement: a PDF from your banking app, or a photo of the pages.",
  map: "Your Money Map is drawn once your plan is built. We're nearly there.",
  debt: "",
  goal: "",
};

export async function buildCard(biz: Business, kind: CardKind): Promise<{ data: unknown } | { needs: string }> {
  switch (kind) {
    case "month": {
      const data = monthCardData(biz);
      return data ? { data } : { needs: CARD_NEEDS.month };
    }
    case "statement": {
      const data = statementCardData(biz);
      return data ? { data } : { needs: CARD_NEEDS.statement };
    }
    case "map": {
      const data = mapCardData(biz, await planFor(biz.id));
      return data ? { data } : { needs: CARD_NEEDS.map };
    }
    case "debt":
      return { data: debtCardData(biz) };
    case "goal":
      return { data: goalCardData(biz) };
  }
}

/**
 * Sends one card. Returns true when a link went out. `image: false` sends
 * the link alone (the plan hand-over, where time is already spent).
 */
export async function sendCard(biz: Business, kind: CardKind, opts: { image?: boolean; lead?: string } = {}): Promise<boolean> {
  const built = await buildCard(biz, kind);
  if ("needs" in built) {
    await sendText(biz.wa_id, built.needs, biz.id);
    track("card_unavailable", { category: "unmet_request", severity: "info", props: { kind, stage: biz.stage }, fingerprint: `card_unavailable:${kind}` });
    return false;
  }
  const minted = await mintCard(biz.id, kind, built.data as never);
  if (!minted) {
    // No public address (or the table is missing): the page cannot exist.
    // Nothing is said about a page that cannot be opened.
    return false;
  }
  const caption = `${opts.lead ? `${opts.lead} ` : ""}${CARD_CAPTION[kind]} ${minted.url}`;
  let image = false;
  if (opts.image !== false && pdfConfigured()) {
    const started = Date.now();
    const png = await renderPng(cardHTML(kind, built.data as never, { png: true }));
    const mediaId = png ? await uploadMedia(png, "image/png", `${kind}.png`) : null;
    if (mediaId) {
      const sent = await sendImage(biz.wa_id, mediaId, caption, biz.id);
      image = sent.ok;
    }
    if (!image) track("card_image_failed", { category: "failure", ms: Date.now() - started, props: { kind, phase: !png ? "render" : !mediaId ? "upload" : "send" }, fingerprint: `card_image_failed:${kind}` });
  }
  if (!image) await sendText(biz.wa_id, caption, biz.id);
  track("card_sent", { category: "behaviour", props: { kind, image, stage: biz.stage, named: Boolean(cardName(biz)) } });
  return true;
}

/** The link alone, for a message someone else composes (the hand-over, the connector). */
export async function cardLink(biz: Business, kind: CardKind): Promise<{ url: string; title: string } | null> {
  const built = await buildCard(biz, kind);
  if ("needs" in built) return null;
  const minted = await mintCard(biz.id, kind, built.data as never);
  return minted ? { url: minted.url, title: CARD_TITLE[kind] } : null;
}
