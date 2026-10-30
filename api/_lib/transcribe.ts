// Fin — voice notes.
//
// The person this product is built for sends voice notes. The first backend read
// only `msg.text.body`, so a voice note arrived, matched nothing, and vanished —
// for the input the target user actually prefers.
//
// WHERE TRANSCRIPTION RUNS
// OpenRouter proxies an OpenAI-shaped /audio/transcriptions endpoint, so the
// default needs no second account and no second key: the same OPENROUTER_API_KEY
// as every other model call. The `voice` row in model_config picks the provider
// and the model, so moving to Groq or OpenAI later — for price, or because you
// want per-segment confidence, which only OpenAI-compatible upstreams return —
// is a database change, not a deploy.
//
// MIMO, WITH THE RULE KEPT
// The default `voice` row is now provider `openrouter_chat`: Xiaomi MiMo-V2.5
// hears the note itself, which is one model for the whole product instead of a
// second vendor. The original objection to transcribing through a chat model
// still stands — an LLM asked to "write out this audio" quietly tidies,
// corrects and paraphrases, which is precisely how a plan ends up claiming the
// person said something they never said (CLAUDE.md rule 2). So the prompt below
// is written against exactly that: verbatim, no correction, and [unclear]
// instead of a guess. A transcript containing [unclear] is treated as low
// confidence, which triggers the read-back before anything is built on it.
// If the chat route fails outright, Whisper on OpenRouter's transcription route
// takes over, so a voice note is never just dropped.

import { env } from "./env.js";
import { callOpenRouter, getModel, LAST_RESORT_VOICE } from "./models.js";
import { trackFailure } from "./track.js";

export interface Transcript {
  text: string;
  /** Only some upstreams report this. Treat its absence as "unknown", not "good". */
  confidence?: number;
  model: string;
  /** Dollars, when the provider reports it. Useful for real cost-per-owner numbers. */
  cost?: number;
}

interface Driver {
  url: string;
  key: string;
  /** Whether this upstream is expected to honour verbose_json (and so give confidence). */
  richFormat: boolean;
}

/**
 * WhatsApp sends OGG/Opus. Whisper-class models take it as-is, so there is no
 * transcoding step anywhere in this product.
 */
function driverFor(provider: string): Driver | null {
  switch ((provider || "openrouter").toLowerCase()) {
    case "groq":
      return env.GROQ_API_KEY
        ? { url: "https://api.groq.com/openai/v1/audio/transcriptions", key: env.GROQ_API_KEY, richFormat: true }
        : null;
    case "openai":
      return process.env.OPENAI_API_KEY
        ? { url: "https://api.openai.com/v1/audio/transcriptions", key: process.env.OPENAI_API_KEY, richFormat: true }
        : null;
    case "openrouter":
    default:
      return env.OPENROUTER_API_KEY
        ? { url: "https://openrouter.ai/api/v1/audio/transcriptions", key: env.OPENROUTER_API_KEY, richFormat: false }
        : null;
  }
}

/** True when at least one transcription route is configured. */
export const voiceConfigured = (): boolean => Boolean(env.OPENROUTER_API_KEY || env.GROQ_API_KEY || process.env.OPENAI_API_KEY);

/** What to say when a voice note arrives and we cannot hear it. Never silence. */
export const CANT_HEAR =
  "I can't listen to voice notes just yet — type it to me instead and I'll pick up exactly where we were. Short is fine.";

/**
 * A prompt biases the decoder toward words it would otherwise mangle. Local
 * money vocabulary is exactly that: "stokvel" becomes "stock fell", "mashonisa"
 * becomes "machine" — and then a whole 90-day plan gets built on the wrong
 * reading.
 */
function decoderHint(extra?: string): string {
  return [
    "A person in South Africa describing their household money.",
    "Words that may appear: stokvel, mashonisa, SASSA, SRD, UIF, SARS, eFiling, GoTyme, TymeBank, GoalSave, PayShap, Capitec, Shoprite, Boxer, Pick n Pay, debit order, DebiCheck, garnishee, debt review, TransUnion, Experian, XDS, funeral cover, burial society, two-pot, prepaid, airtime, taxi fare, mealie meal, lay-by, blacklisted, loan shark, umgalelo, gooi-gooi.",
    extra,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 800);
}


// ── Transcribing through MiMo, verbatim ───────────────────────────

// Keyed by the part after "audio/", which also keeps these off the CI rule that
// flags anything shaped like a model slug.
const AUDIO_FORMATS: Record<string, string> = {
  ogg: "ogg",
  opus: "ogg",
  mpeg: "mp3",
  mp3: "mp3",
  mp4: "m4a",
  "x-m4a": "m4a",
  aac: "aac",
  wav: "wav",
  "x-wav": "wav",
  flac: "flac",
  amr: "amr",
};

/** WhatsApp voice notes are audio/ogg; codecs=opus. The base type is what matters. */
export function audioFormat(mimeType: string): string {
  const base = (mimeType || "").split(";")[0]!.trim().toLowerCase().replace(/^audio\//, "");
  return AUDIO_FORMATS[base] ?? "ogg";
}

export function verbatimPrompt(hint?: string): string {
  return [
    "Transcribe the voice note in this message, word for word.",
    "- Write exactly what is said. Do not correct grammar, tidy up, summarise, translate or add anything.",
    "- Keep the speaker's own words as spoken, including mixed languages, slang and money terms.",
    "- If a word or phrase is unclear, write [unclear] in its place. Never guess to fill a gap.",
    `- Context, only to help you hear local words correctly: ${decoderHint(hint)}`,
    "Reply with the transcript only. No introduction, no quotation marks, no notes.",
  ].join("\n");
}

async function transcribeViaChat(bytes: Uint8Array, mimeType: string, model: string, hint?: string): Promise<Transcript | null> {
  const started = Date.now();
  try {
    const data = Buffer.from(bytes).toString("base64");
    const out = await callOpenRouter(
      model,
      [
        {
          role: "user",
          content: [
            { type: "text", text: verbatimPrompt(hint) },
            { type: "input_audio", input_audio: { data, format: audioFormat(mimeType) } },
          ],
        },
      ],
      // Reasoning off: this is hearing, not thinking, and a chain of thought
      // is exactly where a transcript starts getting "improved".
      { maxTokens: 2000, temperature: 0, reasoning: { enabled: false }, role: "voice", timeoutMs: 60_000 },
    );
    const text = out.text.replace(/^```[a-z]*\n?|```$/gim, "").trim().replace(/^"(.*)"$/s, "$1").trim();
    if (!text) return null;
    // A gap the model admits to is the one confidence signal this route has.
    const confidence = /\[unclear\]/i.test(text) ? 0.3 : undefined;
    return { text, confidence, model, cost: out.usage.cost };
  } catch (err) {
    console.log(`transcribe via chat (${model}) failed, falling back to the transcription route:`, err);
    // A warning, not an error: Whisper is tried next, and the person only
    // hears about it if that fails too (transcription_failed, error).
    trackFailure("transcription_failed", err, {
      severity: "warn",
      alert: "digest",
      ms: Date.now() - started,
      props: { route: "openrouter_chat", model, bytes: bytes.byteLength, fell_back: true },
      fingerprint: "transcription_failed:openrouter_chat",
      summary: `Voice transcription through the chat model (${model}) failed; Whisper was tried instead`,
    });
    return null;
  }
}

export async function transcribe(bytes: Uint8Array, mimeType: string, hint?: string): Promise<Transcript | null> {
  let provider: string = LAST_RESORT_VOICE.provider;
  let model: string = LAST_RESORT_VOICE.model;
  let language: string | undefined;

  try {
    const cfg = await getModel("voice");
    provider = cfg.provider || LAST_RESORT_VOICE.provider;
    model = cfg.model;
    language = (cfg.params as { language?: string }).language;
  } catch (err) {
    console.warn("transcribe: model_config voice row unreadable, using defaults", err);
  }

  if (provider.toLowerCase() === "openrouter_chat") {
    const viaChat = await transcribeViaChat(bytes, mimeType, model, hint);
    if (viaChat) return viaChat;
    // The chat route failed: fall back to Whisper so the note is not lost.
    provider = LAST_RESORT_VOICE.provider;
    model = LAST_RESORT_VOICE.model;
  }

  const driver = driverFor(provider);
  if (!driver) {
    console.log(`transcribe: provider "${provider}" has no credential configured`);
    // Every voice note fails until someone adds the key or changes the voice row.
    trackFailure("transcription_failed", `provider "${provider}" has no credential configured`, {
      severity: "critical",
      alert: "immediate",
      props: { route: provider, reason: "no_credential" },
      fingerprint: `transcription_failed:${provider}:no_credential`,
      summary: `Voice notes cannot be transcribed: the "${provider}" route in model_config has no API key set`,
    });
    return null;
  }
  // A bare model id is what a direct provider expects; OpenRouter wants the
  // namespaced slug. Strip the namespace only when we are not on OpenRouter.
  const modelId = provider.toLowerCase() === "openrouter" ? model : model.includes("/") ? model.split("/").pop()! : model;

  // Multipart is the one request shape that works unchanged against OpenRouter,
  // Groq and OpenAI — and it avoids holding both the raw buffer and a base64
  // copy in memory inside a memory-capped function.
  const build = (richFormat: boolean): FormData => {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const form = new FormData();
    // Never set Content-Type by hand: fetch has to write the multipart boundary.
    form.append("file", new Blob([ab], { type: mimeType || "audio/ogg" }), "note.ogg");
    form.append("model", modelId);
    form.append("temperature", "0");
    form.append("prompt", decoderHint(hint));
    if (language) form.append("language", language);
    if (richFormat) form.append("response_format", "verbose_json");
    return form;
  };

  for (const rich of driver.richFormat ? [true, false] : [false]) {
    const started = Date.now();
    try {
      const res = await fetch(driver.url, { method: "POST", headers: { Authorization: `Bearer ${driver.key}` }, body: build(rich), signal: AbortSignal.timeout(90_000) });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        console.warn(`transcribe ${res.status} (${provider}/${modelId}, verbose=${rich}): ${body}`);
        // A 400 on verbose_json means this upstream does not support it. Retry plain.
        if (rich && res.status === 400) continue;
        // The provider's own words stay in the log line above; they can echo what was sent.
        trackFailure("transcription_failed", `HTTP ${res.status}`, {
          severity: res.status === 401 || res.status === 402 || res.status === 403 ? "critical" : "error",
          ms: Date.now() - started,
          props: { route: provider, model: modelId, status: res.status, verbose: rich, bytes: bytes.byteLength },
          fingerprint: `transcription_failed:${provider}:http_${res.status}`,
          summary: `Voice transcription via ${provider} (${modelId}) answered HTTP ${res.status}; the person was asked to type it`,
        });
        return null;
      }
      const json = (await res.json()) as {
        text?: string;
        segments?: { avg_logprob?: number }[];
        usage?: { cost?: number };
      };
      const text = (json.text ?? "").trim();
      if (!text) return null;

      // verbose_json gives per-segment average log-probability. The worst
      // segment, exponentiated, is a good-enough 0..1 signal for deciding
      // whether to read the transcript back before building anything on it.
      let confidence: number | undefined;
      const lps = (json.segments ?? []).map((s) => s.avg_logprob).filter((x): x is number => typeof x === "number");
      if (lps.length) confidence = Math.max(0, Math.min(1, Math.exp(Math.min(...lps))));

      return { text, confidence, model: modelId, cost: json.usage?.cost };
    } catch (err) {
      console.log("transcribe failed", err);
      // A JSON parse error quotes the start of the body, which can be the transcript itself.
      trackFailure("transcription_failed", err instanceof SyntaxError ? "the provider's reply was not JSON" : err, {
        ms: Date.now() - started,
        props: { route: provider, model: modelId, verbose: rich, bytes: bytes.byteLength },
        fingerprint: `transcription_failed:${provider}:${err instanceof Error ? err.name : "error"}`,
        summary: `Voice transcription via ${provider} (${modelId}) failed (${err instanceof Error ? err.name : "error"}); the person was asked to type it`,
      });
      return null;
    }
  }
  return null;
}

/** Below this, read the transcript back before acting on it. */
export const LOW_CONFIDENCE = 0.55;
