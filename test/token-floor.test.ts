// Fin — the token floor, and hidden reasoning made visible.
//
// Live test, 2026-09-25: the production model reasons even when sent
// `reasoning: { enabled: false }`, and that reasoning is charged against
// `max_tokens` before the answer is written. The same two-string answer
// used 69–320 completion tokens on one run and 1,083–1,243 on another. The
// router's 300-token budget therefore came back EMPTY 30 times in 13
// minutes of Vercel logs, each one a 35–44s empty-retry-then-fallback
// detour. These tests pin the fix (models.ts MIN_ROOM) and the diagnostic
// (reasoning tokens in the log line and the trace).

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
let qa: typeof import("../api/_lib/engine/qa.ts");

before(async () => {
  net = installFakeNet();
  db = makeFakeDb({
    model_config: [
      // The live shapes: a tiny router budget, reasoning "off" (which the model ignores).
      { role: "router", provider: "openrouter", model: "xiaomi/mimo-v2.5", fallbacks: ["xiaomi/mimo-v2.5-pro"], params: { max_tokens: 300, reasoning: { enabled: false } }, enabled: true },
      { role: "safety", provider: "openrouter", model: "xiaomi/mimo-v2.5", fallbacks: [], params: { max_tokens: 300, reasoning: { enabled: false } }, enabled: true },
      { role: "wa_reply", provider: "openrouter", model: "xiaomi/mimo-v2.5", fallbacks: [], params: { max_tokens: 900 }, enabled: true },
    ],
  });
  const dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  models = await import("../api/_lib/models.ts");
  models.__clearModelCache();
  qa = await import("../api/_lib/engine/qa.ts");
});

after(() => {
  restore?.();
  net?.restore();
});

/** Captures console.log lines for the duration of `fn`. */
async function capturingLog<T>(fn: () => Promise<T>): Promise<{ out: T; lines: string[] }> {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    return { out: await fn(), lines };
  } finally {
    console.log = real;
  }
}

// ── The floor ────────────────────────────────────────────────────

test("the floor clears the largest hidden-reasoning spend seen live (1,243 tokens) with room for the answer", () => {
  assert.ok(models.MIN_ROOM >= 2048, `MIN_ROOM is ${models.MIN_ROOM}; the live finding needs at least 2048`);
  assert.equal(models.withRoomFloor(300), models.MIN_ROOM);
  assert.equal(models.withRoomFloor(5000), 5000, "a caller who asked for more than the floor keeps it");
});

test("a router call asking for 300 tokens is sent with max_tokens at or above the floor", async () => {
  net.onModel(/floor probe router/, () => ({ intent: "question" }));
  net.modelCalls.length = 0;
  await models.askJSON("router", "floor probe router", { maxTokens: 300, temperature: 0, label: "router" });
  const call = net.modelCalls.at(-1)!;
  assert.equal(call.model, "xiaomi/mimo-v2.5");
  assert.ok((call.payload!.max_tokens as number) >= models.MIN_ROOM, `sent max_tokens=${call.payload!.max_tokens}, below the floor ${models.MIN_ROOM}`);
});

test("the safety judge's 300 and a model_config max_tokens of 300 are floored the same way", async () => {
  net.onModel(/floor probe safety/, () => ({ verdict: "pass" }));
  await models.askJSON("safety", "floor probe safety", { maxTokens: 300, temperature: 0, label: "safety:t" });
  assert.ok((net.modelCalls.at(-1)!.payload!.max_tokens as number) >= models.MIN_ROOM, "explicit 300");

  net.onModel(/floor probe cfg/, () => ({ ok: true }));
  await models.askJSON("safety", "floor probe cfg", { label: "t" }); // budget from the row: 300
  assert.ok((net.modelCalls.at(-1)!.payload!.max_tokens as number) >= models.MIN_ROOM, "model_config's 300");
});

test("askText is floored too", async () => {
  net.onModel(/floor probe prose/, () => "a short answer");
  const out = await models.askText("wa_reply", "floor probe prose", { maxTokens: 200 });
  assert.equal(out, "a short answer");
  assert.ok((net.modelCalls.at(-1)!.payload!.max_tokens as number) >= models.MIN_ROOM);
});

test("a direct callOpenRouter caller (attachments, transcription, the eval script) gets the floor without opting in", async () => {
  net.onModel(/floor probe direct/, () => "seen");
  const out = await models.callOpenRouter("xiaomi/mimo-v2.5", [{ role: "user", content: "floor probe direct" }], { maxTokens: 300, temperature: 0 });
  assert.equal(out.text, "seen");
  assert.ok((net.modelCalls.at(-1)!.payload!.max_tokens as number) >= models.MIN_ROOM);
});

// ── Empty, then fine ─────────────────────────────────────────────

test("an empty-then-ok sequence still succeeds on the same model, and the retry jumps to a generous room", async () => {
  let calls = 0;
  net.onModel(/empty then ok/, () => (++calls === 1 ? "" : { intent: "question" }));
  const before = net.modelCalls.length;

  const out = await models.askJSON("router", "empty then ok", { maxTokens: 300, temperature: 0, label: "router" });

  assert.equal(out.intent, "question");
  const attempts = net.modelCalls.slice(before);
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every((c) => c.model === "xiaomi/mimo-v2.5"), "no fallback for a room problem");
  const rooms = attempts.map((c) => c.payload!.max_tokens as number);
  assert.ok(rooms[0]! >= models.MIN_ROOM);
  assert.ok(rooms[1]! > rooms[0]!, `retry asked for ${rooms[1]}, no more than the first try's ${rooms[0]}`);
  // Live, 2026-09-25: 1.8x of a 300-token base (540) was nowhere near enough
  // for a model that spent 1,243 tokens thinking. The first retry is the one
  // that has to land, so it goes straight to EMPTY_RETRY_ROOM.
  assert.ok(rooms[1]! >= models.EMPTY_RETRY_ROOM, `retry asked for ${rooms[1]}, below EMPTY_RETRY_ROOM ${models.EMPTY_RETRY_ROOM}`);
});

test("an empty answer's error names the reasoning spend, so the 'model fail' log line says what happened", async () => {
  net.usage.reasoningTokens = 1243;
  try {
    net.onModel(/empty with reasoning/, () => "");
    await assert.rejects(
      () => models.callOpenRouter("xiaomi/mimo-v2.5", [{ role: "user", content: "empty with reasoning" }], { maxTokens: 300 }),
      (err: Error) => {
        assert.match(err.message, /empty content/);
        assert.match(err.message, /reasoning=1243/);
        return true;
      },
    );
  } finally {
    net.usage.reasoningTokens = null;
  }
});

// ── Hidden reasoning made visible ────────────────────────────────

test("reasoning tokens reported by the provider reach the 'model ok' log line and the trace", async () => {
  net.usage.reasoningTokens = 1083;
  try {
    net.onModel(/reasoning visible json/, () => ({ intent: "question" }));
    const trace: import("../api/_lib/models.ts").ModelCallTrace[] = [];
    const { lines } = await capturingLog(() =>
      models.traceModelCalls(trace, () => models.askJSON("router", "reasoning visible json", { maxTokens: 300, label: "router" })),
    );

    const ok = lines.find((l) => l.startsWith("model ok [router]"));
    assert.ok(ok, `no 'model ok' line in ${JSON.stringify(lines)}`);
    assert.match(ok!, /reasoning=1083/);
    assert.equal(trace.length, 1);
    assert.equal(trace[0]!.reasoning, 1083);
    assert.equal(trace[0]!.ok, true);
  } finally {
    net.usage.reasoningTokens = null;
  }
});

test("askText carries reasoning tokens into the trace the same way", async () => {
  net.usage.reasoningTokens = 320;
  try {
    net.onModel(/reasoning visible prose/, () => "prose");
    const trace: import("../api/_lib/models.ts").ModelCallTrace[] = [];
    await models.traceModelCalls(trace, () => models.askText("wa_reply", "reasoning visible prose", { maxTokens: 300 }));
    assert.equal(trace[0]!.reasoning, 320);
  } finally {
    net.usage.reasoningTokens = null;
  }
});

test("when the provider reports no reasoning, neither the log line nor the trace invents a figure", async () => {
  net.onModel(/reasoning absent/, () => ({ ok: true }));
  const trace: import("../api/_lib/models.ts").ModelCallTrace[] = [];
  const { lines } = await capturingLog(() => models.traceModelCalls(trace, () => models.askJSON("router", "reasoning absent", { label: "router" })));
  assert.ok(!lines.some((l) => /reasoning=/.test(l)));
  assert.equal(trace[0]!.reasoning, undefined);
});

test("answer_timing and readback_timing details show the reasoning figure per model call", () => {
  const call = { label: "router", role: "router", model: "xiaomi/mimo-v2.5", configured: "xiaomi/mimo-v2.5", fallback: false, tries: 2, ms: 3100, ok: true, reasoning: 1083 };
  assert.equal(models.describeModelCall(call), "router=xiaomi/mimo-v2.5 3.1s x2 reasoning=1083");
  assert.equal(models.describeModelCall({ ...call, reasoning: undefined, tries: 1 }), "router=xiaomi/mimo-v2.5 3.1s");
  // The answer_timing line (engine/qa.ts) is built from the same phrase.
  const line = qa.timingLine({ total: 4000, router: "model", models: [call] });
  assert.match(line, /models: router=xiaomi\/mimo-v2\.5 3\.1s x2 reasoning=1083/);
});
