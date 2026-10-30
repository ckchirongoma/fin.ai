// Charles — one model for everything (Xiaomi MiMo-V2.5), and what that changes:
// per-role reasoning, a real cost meter, and voice notes heard directly.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";

import { installFakeNet, makeFakeDb, type FakeDb, type FakeNet } from "./_fakes.ts";

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let models: typeof import("../api/_lib/models.ts");
let transcribeMod: typeof import("../api/_lib/transcribe.ts");

before(async () => {
  net = installFakeNet();
  db = makeFakeDb({
    model_config: [
      { role: "router", provider: "openrouter", model: "xiaomi/mimo-v2.5", fallbacks: ["xiaomi/mimo-v2.5-pro"], params: { max_tokens: 300, reasoning: { enabled: false } }, enabled: true },
      { role: "plan_builder", provider: "openrouter", model: "xiaomi/mimo-v2.5", fallbacks: ["xiaomi/mimo-v2.5-pro"], params: { max_tokens: 2000, reasoning: { effort: "medium" } }, enabled: true },
      { role: "voice", provider: "openrouter_chat", model: "xiaomi/mimo-v2.5", fallbacks: [], params: {}, enabled: true },
    ],
  });
  const dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  models = await import("../api/_lib/models.ts");
  models.__clearModelCache();
  transcribeMod = await import("../api/_lib/transcribe.ts");
});

after(() => {
  restore?.();
  net?.restore();
});

// ── The model layer ──────────────────────────────────────────────

test("a role's reasoning setting from model_config is sent with the call", async () => {
  net.onModel(/classify this/, () => ({ ok: true }));
  net.modelCalls.length = 0;
  await models.askJSON("router", "classify this", { label: "t" });
  const call = net.modelCalls.at(-1)!;
  assert.equal(call.model, "xiaomi/mimo-v2.5");
  assert.deepEqual(call.payload!.reasoning, { enabled: false });
});

test("the plan builder gets more thinking than the router — same model, different setting", async () => {
  net.onModel(/build the plan/, () => ({ ok: true }));
  await models.askJSON("plan_builder", "build the plan", { label: "t" });
  assert.deepEqual(net.modelCalls.at(-1)!.payload!.reasoning, { effort: "medium" });
});

test("a per-call reasoning override beats the role's own model_config setting", async () => {
  // Added 2026-09-21: reasoning used to be settable only per ROLE, so every
  // plan_builder call paid "medium" reasoning's latency even for a plain
  // classification step that never needed it. A call site must be able to
  // say "not for this one" without a model_config change.
  net.onModel(/mechanical extraction step/, () => ({ ok: true }));
  await models.askJSON("plan_builder", "mechanical extraction step", { label: "t", reasoning: { enabled: false } });
  assert.deepEqual(net.modelCalls.at(-1)!.payload!.reasoning, { enabled: false }, "the per-call override must win, not the role's 'medium'");
});

test("omitting the per-call override still falls back to the role's own setting", async () => {
  net.onModel(/no override given/, () => ({ ok: true }));
  await models.askJSON("plan_builder", "no override given", { label: "t" });
  assert.deepEqual(net.modelCalls.at(-1)!.payload!.reasoning, { effort: "medium" }, "no override means model_config still decides");
});

test("every call asks OpenRouter to report its cost", async () => {
  net.onModel(/cost probe/, () => ({ ok: true }));
  await models.askJSON("router", "cost probe", { label: "t" });
  assert.deepEqual(net.modelCalls.at(-1)!.payload!.usage, { include: true });
});

test("every call is metered into model_usage, tagged with its role", async () => {
  net.onModel(/meter probe/, () => ({ ok: true }));
  const before = db.tables.model_usage?.length ?? 0;
  await models.askJSON("router", "meter probe", { label: "t" });
  await new Promise((r) => setTimeout(r, 20)); // the meter write is fire-and-forget
  const rows = db.tables.model_usage!;
  assert.equal(rows.length, before + 1);
  assert.equal(rows.at(-1)!.role, "router");
  assert.equal(rows.at(-1)!.model, "xiaomi/mimo-v2.5");
  assert.equal(rows.at(-1)!.prompt_tokens, 10);
});

test("the paid Pro model is tried before any free model when a role's own model fails", async () => {
  // Script the first model to fail by giving it no responder, the second to succeed.
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("chat/completions")) {
      const model = JSON.parse(String(init!.body)).model;
      calls.push(model);
      if (model === "xiaomi/mimo-v2.5") return new Response("overloaded", { status: 503 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: {} }), { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const out = await models.askJSON("router", "fallback probe", { label: "t" });
    assert.equal(out.ok, true);
    assert.deepEqual(calls.slice(0, 2), ["xiaomi/mimo-v2.5", "xiaomi/mimo-v2.5-pro"]);
    assert.ok(!calls[1]!.endsWith(":free"), "the second try must be the paid Pro model, not a free queue");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── Retrying "empty" with more room, not just once ──────────────────
//
// Production incident, 2026-09-20: plan_builder's reasoning ("medium",
// db/0009) spent the whole max_tokens budget thinking, leaving nothing for
// the answer. The old retry escalated room ONCE, at 1.5x — not enough to
// recover a systematic reasoning-token deficit. These prove the new policy
// (models.ts: up to 3 tries, 1.8x each) without asserting the exact
// multiplier as a magic number — what matters is that it tries more than
// once and eventually gives the model enough room to answer.

test("askJSON keeps giving the SAME model more room across multiple attempts on 'empty', not just once", async () => {
  net.onModel(/room escalation probe/, () => {
    // The fake fetch records the call (with its max_tokens) before invoking
    // this responder, so this is really asking "how much room did THIS
    // attempt get" — exactly what a reasoning model's own token accounting
    // would gate on.
    const requestedRoom = net.modelCalls.at(-1)!.payload!.max_tokens as number;
    return requestedRoom >= 3000 ? { ok: true, room: requestedRoom } : "";
  });
  const before = net.modelCalls.length;

  const out = await models.askJSON("plan_builder", "room escalation probe", { maxTokens: 1600, label: "t" });

  assert.equal(out.ok, true);
  const attempts = net.modelCalls.slice(before);
  assert.ok(attempts.length >= 2, `expected more than one attempt on the same model, got ${attempts.length}`);
  assert.ok(attempts.every((c) => c.model === "xiaomi/mimo-v2.5"), "escalation must stay on the same model, not fall to a weaker fallback");
  // Each attempt asked for strictly more room than the last.
  const rooms = attempts.map((c) => c.payload!.max_tokens as number);
  for (let i = 1; i < rooms.length; i++) assert.ok(rooms[i]! > rooms[i - 1]!, `attempt ${i} asked for ${rooms[i]}, no more than attempt ${i - 1}'s ${rooms[i - 1]}`);
});

test("askJSON gives up and moves to the next model if 'empty' persists past the retry ceiling", async () => {
  net.onModel(/never enough room/, () => ""); // always empty, whatever room it gets
  await assert.rejects(() => models.askJSON("plan_builder", "never enough room", { maxTokens: 100, label: "t" }), /empty/i);
});

test("askText — which never retried an 'empty' answer at all before this incident — now does the same escalation", async () => {
  net.onModel(/prose escalation probe/, () => {
    const requestedRoom = net.modelCalls.at(-1)!.payload!.max_tokens as number;
    // Above MIN_ROOM (2026-09-25, token-floor.test.ts): a threshold the
    // floored first attempt would clear on its own proves nothing about the retry.
    return requestedRoom >= 3000 ? "here is the actual answer" : "";
  });
  const before = net.modelCalls.length;

  const out = await models.askText("plan_builder", "prose escalation probe", { maxTokens: 600 });

  assert.equal(out, "here is the actual answer");
  const attempts = net.modelCalls.slice(before);
  assert.ok(attempts.length >= 2, "askText must retry the same model with more room, not just take the first empty answer");
  assert.ok(attempts.every((c) => c.model === "xiaomi/mimo-v2.5"));
});

// ── Voice notes ──────────────────────────────────────────────────

// One responder, changed per test: the fake network answers with the FIRST match.
let voiceReply = "";
const OGG = new Uint8Array([79, 103, 103, 83, 0, 2, 0, 0]);

test("audio format is read from the mime type, codecs parameter and all", () => {
  assert.equal(transcribeMod.audioFormat("audio/ogg; codecs=opus"), "ogg");
  assert.equal(transcribeMod.audioFormat("audio/mpeg"), "mp3");
  assert.equal(transcribeMod.audioFormat("audio/mp4"), "m4a");
  assert.equal(transcribeMod.audioFormat("application/octet-stream"), "ogg");
});

test("the transcription prompt forbids tidying and demands [unclear] instead of a guess", () => {
  const p = transcribeMod.verbatimPrompt("laundry in Woodstock");
  assert.match(p, /word for word/i);
  assert.match(p, /Do not correct/i);
  assert.match(p, /\[unclear\]/);
  assert.match(p, /Never guess/i);
  assert.match(p, /stokvel/, "the local-vocabulary hint must be in the prompt");
});

test("MiMo hears the voice note directly: audio goes in as an input_audio part", async () => {
  net.onModel(/word for word/, () => voiceReply);
  voiceReply = "I wash and fold clothes for guesthouses";
  const t = await transcribeMod.transcribe(OGG, "audio/ogg; codecs=opus", "laundry");
  assert.equal(t?.text, "I wash and fold clothes for guesthouses");
  const call = net.modelCalls.at(-1)!;
  assert.equal(call.model, "xiaomi/mimo-v2.5");
  const content = call.payload!.messages[0].content as { type: string; input_audio?: { format: string; data: string } }[];
  const audio = content.find((p) => p.type === "input_audio")!;
  assert.equal(audio.input_audio!.format, "ogg");
  assert.equal(audio.input_audio!.data, Buffer.from(OGG).toString("base64"));
  assert.deepEqual(call.payload!.reasoning, { enabled: false }, "hearing, not thinking");
  assert.equal(call.payload!.temperature, 0);
});

test("a transcript that admits a gap is low confidence, so it gets read back", async () => {
  voiceReply = "I run a [unclear] on the corner";
  const t = await transcribeMod.transcribe(OGG, "audio/ogg", "");
  assert.ok(t!.confidence! < transcribeMod.LOW_CONFIDENCE);
});

test("a clean transcript carries no invented confidence number", async () => {
  voiceReply = "I sell airtime";
  const t = await transcribeMod.transcribe(OGG, "audio/ogg", "");
  assert.equal(t!.confidence, undefined);
});

test("if the chat route fails, Whisper takes over — the note is not dropped", async () => {
  const realFetch = globalThis.fetch;
  net.transcription.text = "spaza shop in Khayelitsha";
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("chat/completions")) return new Response("boom", { status: 500 });
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const t = await transcribeMod.transcribe(OGG, "audio/ogg", "");
    assert.equal(t?.text, "spaza shop in Khayelitsha");
    assert.equal(t?.model, "openai/whisper-1");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("if both routes fail, transcribe says so with null rather than throwing", async () => {
  const realFetch = globalThis.fetch;
  net.transcription.text = null;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("chat/completions")) return new Response("boom", { status: 500 });
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    assert.equal(await transcribeMod.transcribe(OGG, "audio/ogg", ""), null);
  } finally {
    globalThis.fetch = realFetch;
    net.transcription.text = "hello from a voice note";
  }
});
