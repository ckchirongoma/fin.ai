// Charles — the conversation says what it costs and what comes next.
//
// First testers (2026-09-23) liked the questions but wanted the start framed
// (how many, how long, what you get) and the hand-over framed (where the plan
// lives, how the next 90 days work, that questions are welcome).

import { test } from "node:test";
import assert from "node:assert/strict";

test("the opening message says how many questions and how long, and the count is the real one", async () => {
  const { DIAG } = await import("../api/_lib/diagnostic.ts");
  const first = DIAG[0]!.q("ZA");
  assert.match(first, new RegExp(`${DIAG.length} short questions`));
  assert.match(first, /about 5 minutes/);
  assert.match(first, /90-day money plan/);
});

test("a free tool reads 'Free to use', not 'Free to use — free'", async () => {
  const { withFreeType } = await import("../api/_lib/freetype.ts");
  assert.equal(withFreeType("free", "FREE_FOREVER"), "Free to use");
  assert.equal(withFreeType("Free.", "FREE_FOREVER"), "Free to use");
  assert.match(withFreeType("free plan; paid plans monthly", "FREE_TIER"), / — free plan; paid plans monthly$/);
});

// Live, round 6, flagged by the founder: six multi-select questions said "Tap
// all that apply" — and WhatsApp has no multi-select control, so there is
// nothing to tap; three lines later the same message said "reply with the
// numbers". Every multi-select question now carries one true instruction.
test("no multi-select question tells the owner to tap; each says once to type the numbers", async () => {
  const { DIAG, shapeQuestion } = await import("../api/_lib/diagnostic.ts");
  DIAG.forEach((q, step) => {
    if (!q.multi) return;
    const shape = shapeQuestion(step, "ZA");
    assert.equal(shape.kind, "text", q.key);
    const body = (shape as { body: string }).body;
    assert.doesNotMatch(body, /\btap\b/i, `${q.key}: "${body.split("\n")[0]}"`);
    assert.equal((body.match(/Type the numbers of every one that fits/g) ?? []).length, 1, q.key);
  });
  assert.doesNotMatch(DIAG[0]!.q("ZA"), /most are a tap/);
});
