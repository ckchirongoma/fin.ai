// Charles — the diagnostic, and the platform shape each question has to take.
//
// The property that matters most here is negative: WhatsApp has NO
// multi-select control. A list message lets the owner pick one row and one row
// only. So every multi-select question must go out as numbered plain
// text, and a question that quietly shipped as a list would lose half of what
// the owner meant to say — silently, with no error anywhere.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { DIAG, DIAG_COUNT, diagActionId, parseDiagAction, parseMultiReply, recordAnswer, shapeQuestion } from "../api/_lib/diagnostic.js";
import { WA } from "../api/_lib/wa.js";

const indexOfKey = (key: string) => DIAG.findIndex((q) => q.key === key);

describe("choosing how a question goes out", () => {
  test("an open question is plain text, so a voice note is a valid answer", () => {
    const shape = shapeQuestion(indexOfKey("person"), "ZA");
    assert.equal(shape.kind, "text");
  });

  test("three or fewer single-answer options become reply buttons", () => {
    // No live money question has three or fewer options (the shortest, the
    // cushion, has four), so this asserts the branch itself.
    DIAG.push({ key: "test_only", q: () => "Pick one", options: ["Yes", "No", "Not sure"] });
    try {
      const shape = shapeQuestion(DIAG.length - 1, "ZA");
      assert.equal(shape.kind, "buttons");
      if (shape.kind !== "buttons") return;
      assert.equal(shape.buttons.length, 3);
      for (const b of shape.buttons) {
        assert.ok(b.title.length <= WA.buttonTitleChars, `"${b.title}" must fit WhatsApp's ${WA.buttonTitleChars}-character button`);
        assert.ok(b.id.length > 0, "every button carries an explicit action id (rule 7)");
      }
    } finally {
      DIAG.pop();
    }
  });

  test("more than three single-answer options become a list", () => {
    // No live question has more than three single-answer options yet, so this
    // asserts the branch itself rather than a question that happens to use it.
    DIAG.push({ key: "test_only", q: () => "Pick one", options: Array.from({ length: 12 }, (_v, i) => `Option number ${i + 1}`) });
    try {
      const shape = shapeQuestion(DIAG.length - 1, "ZA");
      assert.equal(shape.kind, "list");
      if (shape.kind !== "list") return;
      assert.equal(shape.rows.length, WA.listRows, "a list is capped at ten rows, not truncated by Meta");
      for (const r of shape.rows) assert.ok(r.title.length <= WA.listRowTitleChars);
    } finally {
      DIAG.pop();
    }
  });

  // The load-bearing one. If any of these ever became a list, the owner could
  // only ever tell us one of their blockers.
  test("every tap-all-that-apply question goes out as numbered plain text, never a list", () => {
    const multi = DIAG.map((q, i) => ({ q, i })).filter(({ q }) => q.multi);
    assert.ok(multi.length >= 5, "the diagnostic really does lean on multi-answer questions");
    for (const { q, i } of multi) {
      const shape = shapeQuestion(i, "ZA");
      assert.equal(shape.kind, "text", `"${q.key}" must not be sent as a control that only accepts one answer`);
      if (shape.kind !== "text") continue;
      for (const [n, opt] of (q.options ?? []).entries()) {
        assert.ok(shape.body.includes(`${n + 1}. ${opt}`), `"${q.key}" must number option "${opt}"`);
      }
      assert.ok(/1, 3/.test(shape.body), `"${q.key}" must show the owner how to answer with several numbers`);
    }
  });

  test("the money question is asked in the person's own currency", () => {
    const za = shapeQuestion(indexOfKey("income"), "ZA");
    assert.match(za.body, /\bR\d/, "a Johannesburg household is asked in rands");
    assert.doesNotMatch(za.body, /KSh|₦|GH₵|USh/);
  });

  test("asking for a question that does not exist fails loudly rather than sending nothing", () => {
    assert.throws(() => shapeQuestion(DIAG_COUNT + 50, "ZA"), /does not exist/);
  });
});

// CLAUDE.md rule 7: a tap carries an explicit action id and is dispatched on
// that id. The step number travels inside it so a tap on a stale message from
// three questions ago cannot be written into the current answer.
describe("the id a diagnostic tap carries", () => {
  test("an action id round-trips back to the question and option it came from", () => {
    for (const [step, option] of [[0, 0], [4, 2], [11, 9]] as const) {
      assert.deepEqual(parseDiagAction(diagActionId(step, option)), { step, option });
    }
  });

  test("a diagnostic id stays inside WhatsApp's id limit", () => {
    assert.ok(diagActionId(11, 9).length <= WA.buttonIdChars);
  });

  test("anything that is not a diagnostic id is rejected rather than guessed at", () => {
    for (const bad of ["", "a.step.next", "d.1", "d.1.2.3", "d.a.b", "next", "D.1.2"]) {
      assert.equal(parseDiagAction(bad), null, `"${bad}" is not a diagnostic option`);
    }
  });
});

describe("reading a tap-all-that-apply answer", () => {
  const options = ["Cash", "Bank transfer", "Card machine", "Mobile money or QR", "On account / invoice"];

  test("numbers separated by commas", () => {
    assert.deepEqual(parseMultiReply("1, 3", options), ["Cash", "Card machine"]);
  });

  test("numbers written the way a person writes them", () => {
    assert.deepEqual(parseMultiReply("1 and 3", options), ["Cash", "Card machine"]);
    assert.deepEqual(parseMultiReply("mostly 1, sometimes 2 and 5", options), ["Cash", "Bank transfer", "On account / invoice"]);
  });

  test("the same number twice counts once", () => {
    assert.deepEqual(parseMultiReply("1, 1, 2", options), ["Cash", "Bank transfer"]);
  });

  test("the option words themselves, when they typed instead of counting", () => {
    assert.deepEqual(parseMultiReply("card machine and cash", options), ["Cash", "Card machine"]);
  });

  test("a number nobody offered is not silently turned into an option", () => {
    const out = parseMultiReply("9", options);
    assert.ok(!out.some((o) => options.includes(o)), "an out-of-range number must not pick a real option");
    assert.deepEqual(out, ["9"]);
  });

  test("zero is not the first option", () => {
    assert.deepEqual(parseMultiReply("0", options), ["0"]);
  });

  // CLAUDE.md rule 2: nothing may claim the owner said something they didn't —
  // and the same respect works the other way. What they actually wrote is kept.
  test("an answer that fits no option keeps the owner's own words rather than being dropped", () => {
    assert.deepEqual(parseMultiReply("depends who is asking, honestly", options), ["depends who is asking, honestly"]);
  });

  test("an empty answer produces nothing at all, not an empty-string answer", () => {
    assert.deepEqual(parseMultiReply("   ", options), []);
    assert.deepEqual(parseMultiReply("", options), []);
  });
});

describe("storing an answer", () => {
  const blockers = indexOfKey("blockers");

  test("a multi-answer question is stored as the options they picked", () => {
    const out = recordAnswer({}, blockers, "1, 3");
    assert.equal(out.blockers, "Repayments eat my pay, The month is longer than the money");
  });

  test("an open answer is stored as written, trimmed", () => {
    const out = recordAnswer({}, indexOfKey("person"), "  Thabo, I do piece jobs  ");
    assert.equal(out.person, "Thabo, I do piece jobs");
  });

  test("earlier answers survive a later one", () => {
    const first = recordAnswer({}, indexOfKey("person"), "Thabo");
    const second = recordAnswer(first, indexOfKey("location"), "Soweto, Johannesburg");
    assert.deepEqual(second, { person: "Thabo", location: "Soweto, Johannesburg" });
    assert.deepEqual(first, { person: "Thabo" }, "recording an answer does not mutate what was passed in");
  });

  test("an empty reply is not recorded as an answer", () => {
    assert.deepEqual(recordAnswer({ person: "Thabo" }, indexOfKey("location"), "   "), { person: "Thabo" });
  });

  test("a reply to a question that does not exist changes nothing", () => {
    assert.deepEqual(recordAnswer({ person: "x" }, 999, "hello"), { person: "x" });
  });
});

describe("the shape of the diagnostic itself", () => {
  test("every question has a unique key, because the key is what the plan builder reads", () => {
    assert.equal(new Set(DIAG.map((q) => q.key)).size, DIAG.length);
  });

  test("DIAG_COUNT is the number of questions actually asked", () => {
    assert.equal(DIAG_COUNT, DIAG.length);
  });

  test("no question offers an option list a person could not answer", () => {
    for (const q of DIAG) {
      if (!q.options) continue;
      assert.ok(q.options.length >= 2, `"${q.key}" offers a single option, which is not a question`);
      assert.equal(new Set(q.options).size, q.options.length, `"${q.key}" repeats an option`);
    }
  });
});
