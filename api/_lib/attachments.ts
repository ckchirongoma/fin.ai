// Fin — reading what a person forwards: a photographed supplier quote, a
// flyer, a screenshot of a grant broadcast, a PDF.
//
// People forward things to friends and ask "is this legit? is this for me?"
// (PRODUCT-DEFINITION 4.5). Until now a photo got an honest "I can't read
// pictures yet". MiMo-V2.5 reads images natively, so it can now.
//
// TWO RULES THIS FILE IS BUILT AROUND
// 1. Extraction is not interpretation. The model is told to report what is
//    there — every price, name, number and date, as written — and to give no
//    advice and no verdict. The verdict is the forward prompt's job, run
//    afterwards, grounded and checked like every other answer.
// 2. What a photo SAYS is not what the person SAID. The extracted text is data
//    about a stranger's document. It never joins the person's own words: it is
//    not searched for commands ("forget my business" printed on a flyer must not
//    delete anything), and it is never written to memory as a person statement.

import { callOpenRouter, getModel } from "./models.js";
import { trackFailure } from "./track.js";

export type AttachmentKind = "photo" | "pdf";

export interface AttachmentRead {
  kind: AttachmentKind;
  /** What the thing is and what it says, as written. Untrusted content. */
  text: string;
}

/** Big enough for a phone photo or a multi-page quote; small enough for a function's memory. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 4000;

const IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

export function attachmentKind(mimeType: string | undefined): AttachmentKind | null {
  const base = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  if (IMAGE_TYPES.has(base)) return "photo";
  if (base === "application/pdf") return "pdf";
  return null;
}

export const CANT_READ_THAT =
  "I couldn't read that one. Tell me in a line what it says and I'll tell you what it means for your money.";

export const NOT_YET_FILES =
  "I can read pictures and files once your plan is built. For now, type your answer and we'll keep going.";

export function readPrompt(kind: AttachmentKind, caption?: string): string {
  return [
    `A small business owner forwarded you ${kind === "pdf" ? "a document" : "a photo"}. Report what is in it. Do not interpret it, judge it or give advice — someone else does that.`,
    "First line: WHAT IT IS — one short phrase (a supplier quote, a flyer, a price list, a grant or loan message, a bank message, a contract, a screenshot of a chat, something else).",
    "Then: WHAT IT SAYS — write out the readable text as it appears. Keep every price, amount, name, phone number, web address, date and deadline exactly as written, including any fee or payment being asked for.",
    "If something is blurred or cut off, write [unclear] instead of guessing.",
    "If nothing in it is legible at all, reply with exactly the single word UNREADABLE.",
    caption ? `The person's own note, for context only: ${caption.slice(0, 300)}` : "",
    "Plain text only. No headings, no commentary.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Null means "could not read it" — the caller says so honestly. It never
 * throws: a bad photo must not take a conversation down.
 */
export async function readAttachment(bytes: Uint8Array, mimeType: string, caption?: string): Promise<AttachmentRead | null> {
  const kind = attachmentKind(mimeType);
  if (!kind || bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) return null;

  const started = Date.now();
  try {
    // The model that answers live replies is the one that sees: with MiMo that is
    // a multimodal model. If someone points wa_reply at a text-only model the
    // call fails and this returns null — an honest "couldn't read it".
    const { model } = await getModel("wa_reply");
    const base = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
    const dataUrl = `data:${base};base64,${Buffer.from(bytes).toString("base64")}`;
    const part =
      kind === "photo"
        ? { type: "image_url", image_url: { url: dataUrl } }
        : { type: "file", file: { filename: "document.pdf", file_data: dataUrl } };

    const out = await callOpenRouter(
      model,
      [{ role: "user", content: [{ type: "text", text: readPrompt(kind, caption) }, part] }],
      { maxTokens: 1800, temperature: 0, reasoning: { enabled: false }, role: "attachment", timeoutMs: 60_000 },
    );

    const text = out.text.trim();
    if (!text || /^UNREADABLE\.?$/i.test(text)) return null;
    return { kind, text: text.slice(0, MAX_EXTRACTED_CHARS) };
  } catch (err) {
    console.log("readAttachment failed:", err);
    // The person is told "I couldn't read that one" (engine: attachment_unreadable).
    // This is why: a text-only wa_reply model, a timeout, the provider.
    trackFailure("attachment_read_failed", err, {
      ms: Date.now() - started,
      props: { kind, bytes: bytes.byteLength },
      summary: `A ${kind === "pdf" ? "PDF" : "photo"} a person sent could not be read by the model; they were told so, or their caption went on without it`,
    });
    return null;
  }
}
