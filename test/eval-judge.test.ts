// Fin — the eval harness's own judge (docs/EXPERIENCE.md §5.8, "eval
// judging"): Jev's calibrated `score` questions first, a model on the
// original rubric only as a backstop. What matters here is exactly what
// mattered for map_score: the round-half-DOWN convention, engine attribution
// that is honest about which one actually judged, and a clean fall-through
// when Jev cannot answer.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.TYPESAFE_API_KEY = "fake-jev-key";

import { installFakeNet, type FakeNet } from "./_fakes.ts";
import type { Built, Question, JudgeScore, Row } from "../scripts/eval.ts";

let net: FakeNet;
// eval.ts reads OPENROUTER_API_KEY into env.ts's frozen snapshot at module-
// evaluation time, which — for a static import — happens before this file's
// own top-level `process.env` lines run. Importing it dynamically, after
// those lines, is the same fix test/judgement.test.ts already uses for the
// same reason.
let jevJudge: (b: Built, answer: string) => Promise<JudgeScore | null>;
let modelJudge: (model: string, b: Built, answer: string) => Promise<JudgeScore | null>;
let judgeAnswer: (judgeModel: string, b: Built, answer: string) => Promise<JudgeScore | null>;
let report: (rows: Row[], args: { judge: boolean; strict: boolean }) => boolean;

before(async () => {
  net = installFakeNet();
  const mod = await import("../scripts/eval.ts");
  jevJudge = mod.jevJudge;
  modelJudge = mod.modelJudge;
  judgeAnswer = mod.judgeAnswer;
  report = mod.report;
});

after(() => {
  net.restore();
});

beforeEach(() => {
  net.jev.handler = null;
  net.jev.calls.length = 0;
});

const question: Question = {
  id: "test-q",
  country: "ZA",
  stage: "trading",
  domain: "spending",
  message: "Clients no-show on Saturday, what do I do?",
  business_context: { name: "Thandi's Chairs", trade: "hair salon", stage: "trading" } as unknown as Question["business_context"],
  expectations: {},
};

const built = (): Built => ({
  q: question,
  prompt: "irrelevant to the judge — the judge scores the answer, not the prompt",
  knowledgeIds: ["k.za_deposits"],
  toolIds: ["yoco"],
  topScore: 3,
  toolNames: ["Yoco"],
  paidTools: ["Yoco"],
});

const answer = "Take a R100 deposit when they book. Here is the message to send.";

test("jevJudge maps a calibrated score to 1-5 with the round-half-down convention", async () => {
  // 5 levels -> indices 0..4. A raw score of 3.5 sits on a tie between index
  // 3 and 4; round-half-DOWN keeps it at index 3, which is display value 4 —
  // not 5. This is the exact bug class map_score in moneymap.ts guards
  // against, and getting it backwards here would make this eval disagree
  // with the product's own convention about what "calibrated" means.
  net.jev.handler = () => ({
    specific: { type: "score", score: 3.5, confidence: 0.8, legend: {}, probabilities: {} },
    advisor: { type: "score", score: 4.0, confidence: 0.9, legend: {}, probabilities: {} },
    depth: { type: "score", score: 2.5, confidence: 0.8, legend: {}, probabilities: {} },
  });

  const score = await jevJudge(built(), answer);
  assert.ok(score);
  assert.equal(score.specific, 4); // index 3 (tie rounded down) + 1
  assert.equal(score.advisor, 5); // index 4 (clean top score) + 1
  assert.equal(score.depth, 3); // the depth question uses the same convention: 2.5 ties down to index 2
  assert.equal(score.engine, "jev");
  assert.equal(score.why, ""); // Jev cannot write text — never fabricate a rationale
});

test("jevJudge clamps out-of-range scores rather than producing a 6th level", async () => {
  net.jev.handler = () => ({
    specific: { type: "score", score: 4.9, confidence: 0.95, legend: {}, probabilities: {} },
    advisor: { type: "score", score: 0, confidence: 0.7, legend: {}, probabilities: {} },
    depth: { type: "score", score: 9, confidence: 0.7, legend: {}, probabilities: {} },
  });
  const score = await jevJudge(built(), answer);
  assert.ok(score);
  assert.equal(score.specific, 5); // top of a 5-level scale, never 6
  assert.equal(score.advisor, 1); // bottom, never 0
  assert.equal(score.depth, 5);
});

test("jevJudge returns null, not a guess, when TYPESAFE_API_KEY is unset", async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    net.jev.handler = () => ({
      specific: { type: "score", score: 4, confidence: 0.9, legend: {}, probabilities: {} },
      advisor: { type: "score", score: 4, confidence: 0.9, legend: {}, probabilities: {} },
    });
    const score = await jevJudge(built(), answer);
    assert.equal(score, null);
    assert.equal(net.jev.calls.length, 0); // no key means no call, not a call that gets rejected
  } finally {
    process.env.TYPESAFE_API_KEY = saved;
  }
});

test("jevJudge returns null when Jev is unreachable, and never invents a score", async () => {
  net.jev.handler = null; // installFakeNet responds 503 with no handler
  const score = await jevJudge(built(), answer);
  assert.equal(score, null);
});

test("jevJudge returns null when Jev answers the wrong question shape", async () => {
  // A noul instead of a score is a malformed answer for this call, not a
  // value to coerce into a level.
  net.jev.handler = () => ({
    specific: { type: "noul", noul: 0.8 },
    advisor: { type: "score", score: 4, confidence: 0.9, legend: {}, probabilities: {} },
    depth: { type: "score", score: 3, confidence: 0.9, legend: {}, probabilities: {} },
  });
  const score = await jevJudge(built(), answer);
  assert.equal(score, null);
});

// Each test below gives modelJudge's answer its own unique marker and
// matches the fake model on that marker rather than the shared rubric text.
// installFakeNet's onModel responders accumulate for the life of the fake
// (there is no per-test reset) and the fake picks the FIRST registered match,
// so two tests sharing one broad regex would silently score against
// whichever test happened to register first — a test-isolation bug, not a
// product one, but one worth not reintroducing.

test("modelJudge parses the rubric and tags itself as the model engine", async () => {
  const marker = "[[marker-parses-rubric]]";
  net.onModel(marker, () => ({ specific: 4, advisor: 5, depth: 4, why: "Grounded and specific." }));
  const score = await modelJudge("some/model", built(), `${answer} ${marker}`);
  assert.ok(score);
  assert.equal(score.specific, 4);
  assert.equal(score.advisor, 5);
  assert.equal(score.depth, 4);
  assert.equal(score.engine, "model");
  assert.equal(score.why, "Grounded and specific.");
});

test("modelJudge returns null on an unparseable or incomplete reply, rather than a fabricated score", async () => {
  const marker = "[[marker-unparseable]]";
  net.onModel(marker, () => "not json at all");
  const score = await modelJudge("some/model", built(), `${answer} ${marker}`);
  assert.equal(score, null);
});

test("modelJudge keeps a reply that leaves out depth, without a depth score, so the bar can fail on it (review, round 23)", async () => {
  const marker = "[[marker-no-depth]]";
  net.onModel(marker, () => ({ specific: 5, advisor: 5, why: "two of three" }));
  const score = await modelJudge("some/model", built(), `${answer} ${marker}`);
  assert.ok(score);
  assert.equal(score.depth, undefined);
});

test("the judged bar fails on a reply judged without depth, and on an answer the judge could not score; it passes when every answer is judged in full", (t) => {
  t.mock.method(console, "log", () => {});
  const row = (id: string, judge: JudgeScore | null): Row => ({ id, country: "ZA", domain: "spending", topScore: 3, knowledgeIds: [], toolIds: [], promptChars: 0, answer: "x", words: 1, checks: [], judge });
  const full: JudgeScore = { specific: 5, advisor: 5, depth: 5, why: "", engine: "model" };
  const noDepth: JudgeScore = { specific: 5, advisor: 5, why: "", engine: "model" };
  const args = { judge: true, strict: true };
  assert.equal(report([row("a", full), row("b", full)], args), true);
  assert.equal(report([row("a", full), row("b", noDepth)], args), false, "judged without depth");
  assert.equal(report([row("a", full), row("b", null)], args), false, "one answer not judged at all");
  assert.equal(report([row("a", null), row("b", null)], args), false, "every reply unparseable");
  assert.equal(report([row("a", null)], { judge: false, strict: false }), true, "without --judge nothing is judged and that is not a failure");
});

test("judgeAnswer prefers Jev when both engines are available", async () => {
  const marker = "[[marker-prefers-jev]]";
  net.jev.handler = () => ({
    specific: { type: "score", score: 4, confidence: 0.9, legend: {}, probabilities: {} },
    advisor: { type: "score", score: 4, confidence: 0.9, legend: {}, probabilities: {} },
    depth: { type: "score", score: 3, confidence: 0.9, legend: {}, probabilities: {} },
  });
  net.onModel(marker, () => ({ specific: 1, advisor: 1, why: "should never be read" }));

  const score = await judgeAnswer("some/model", built(), `${answer} ${marker}`);
  assert.ok(score);
  assert.equal(score.engine, "jev");
  assert.equal(score.specific, 5);
});

test("judgeAnswer falls through to the model when Jev cannot answer — the same order as every other judgement in this repo", async () => {
  const marker = "[[marker-falls-through]]";
  net.jev.handler = null; // 503
  net.onModel(marker, () => ({ specific: 3, advisor: 2, depth: 2, why: "soft but on-topic" }));

  const score = await judgeAnswer("some/model", built(), `${answer} ${marker}`);
  assert.ok(score);
  assert.equal(score.engine, "model");
  assert.equal(score.specific, 3);
  assert.equal(score.advisor, 2);
});

test("eval questions: every expected name is one the owner did not already type, so an echo cannot pass the depth check", async () => {
  const { readFileSync } = await import("node:fs");
  const raw = JSON.parse(readFileSync(new URL("../eval/questions.json", import.meta.url), "utf8")) as Question[] | { questions: Question[] };
  const qs = Array.isArray(raw) ? raw : raw.questions;
  const says = (text: string, n: string) => new RegExp(`(^|[^A-Za-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`, "i").test(text);
  let n = 0;
  for (const q of qs) {
    for (const name of q.expectations.must_name_any ?? []) {
      n++;
      assert.ok(!says(q.message, name), `${q.id}: "${name}" is already in the owner's message`);
    }
  }
  assert.ok(n >= 20, `only ${n} expected names`);
  for (const cc of ["ZA"]) assert.ok(qs.some((q) => q.country === cc && q.expectations.must_name_any?.length), `${cc} has no question with an expected name`);
});
