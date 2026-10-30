// Fin — typed shortcuts, and the line between a command and a question.
//
// CLAUDE.md rule 7. An early version turned every tap into a chat message and
// re-parsed the text, so a leftover conversational mode could swallow an
// unrelated tap. Ids fixed the tap side; this file guards the other side —
// people also type, and "next" must reach the same code path as tapping
// "Next step" without swallowing "what happens next if I raise my prices?".

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ACT, isActionId, typedShortcut } from "../api/_lib/actions.js";

describe("recognising a typed command", () => {
  test("the short words people actually type map onto the same actions as the buttons", () => {
    const expected: [string, string][] = [
      ["next", ACT.NEXT_STEP],
      ["next step", ACT.NEXT_STEP],
      ["start", ACT.NEXT_STEP],
      ["go", ACT.NEXT_STEP],
      ["done", ACT.STEP_DONE],
      ["sorted", ACT.STEP_DONE],
      ["help", ACT.STEP_HELP],
      ["stuck", ACT.STEP_HELP],
      ["skip", ACT.STEP_SKIP],
      ["my plan", ACT.SEE_PLAN],
      ["menu", ACT.MENU],
      ["connect my ai", ACT.CONNECT_AI],
      ["stop", ACT.PAUSE_NUDGES],
    ];
    for (const [typed, action] of expected) assert.equal(typedShortcut(typed), action, `"${typed}"`);
  });

  test("capitals and stray spaces do not stop it working", () => {
    assert.equal(typedShortcut("  NEXT  "), ACT.NEXT_STEP);
    assert.equal(typedShortcut("Done"), ACT.STEP_DONE);
  });

  // The one that matters. A shortcut that fires here skips the answer engine
  // entirely, so a false positive means a real question is never answered.
  test("a real question containing a command word is a question, not a command", () => {
    const questions = [
      "what happens next if I raise my prices?",
      "next week I'm closed, does that matter",
      "I'm done with the second step, what now",
      "can you help me with the SARS thing",
      "should I stop taking cash",
      "my plan says to post three times, is that a lot",
      "is it worth connecting my ai to this",
      "go and check the price for me please",
    ];
    for (const q of questions) assert.equal(typedShortcut(q), null, `"${q}" must reach the answer engine`);
  });

  test("a command word buried in a longer sentence does not fire", () => {
    assert.equal(typedShortcut("next thing"), null);
    assert.equal(typedShortcut("done and dusted"), null);
    assert.equal(typedShortcut("please skip"), null);
  });

  // The cap was 20 until the step-help phrasings below needed the room
  // ("i need help with this step!" is 27). Every pattern is anchored, so the
  // cap is a backstop rather than the rule — see MAX_SHORTCUT_CHARS.
  test("anything over thirty-two characters is treated as a message, whatever it says", () => {
    assert.equal(typedShortcut("next".padEnd(33, " ") + "x"), null);
    assert.equal(typedShortcut("no more messages"), ACT.PAUSE_NUDGES, "…but a real phrase inside the limit still works");
  });

  // Live test, 2026-09-25: "im stuck" on a business with a finished plan
  // missed the exact-match shortcut, reached the Q&A router, and was read as
  // financial distress. These are the ways people actually type it.
  test("'I'm stuck', however it is typed, is the step-help shortcut", () => {
    const stuck = [
      "im stuck", "I'm stuck", "i am stuck", "I’m stuck", "im stuck!", "I'm stuck.", "stuck on this", "stuck on it",
      "stuck on this step", "I'm stuck on this step", "im stuck on this one", "i am stuck on the step", "stuck here",
      "i need help", "I need help!", "help with this step", "help me with this", "can you help me with this step", "help please",
    ];
    for (const s of stuck) assert.equal(typedShortcut(s), ACT.STEP_HELP, `"${s}"`);
  });

  // The line that keeps the shortcut honest: saying WHAT you are stuck on is
  // a question, and a question must always reach the answer engine.
  test("'stuck on <something real>' is a question, not the shortcut", () => {
    const questions = [
      "I'm stuck on how to price, what should I charge?",
      "stuck on pricing",
      "im stuck on the sars registration form",
      "I need help with pricing",
      "help me with the Yoco machine",
      "i am stuck because nobody is buying",
      "stuck, should I drop my prices?",
    ];
    for (const q of questions) assert.equal(typedShortcut(q), null, `"${q}" must reach the answer engine`);
  });

  test("an empty message is not a command", () => {
    for (const x of ["", "   ", "\n"]) assert.equal(typedShortcut(x), null);
  });
});

describe("recognising an action id that came back from WhatsApp", () => {
  test("every id the product can send is recognised when it comes back", () => {
    for (const id of Object.values(ACT)) assert.equal(isActionId(id), true, id);
  });

  test("anything else is not an action, so it cannot be dispatched on", () => {
    for (const x of ["", null, undefined, "a.step", "a.step.nextt", "A.STEP.NEXT", "d.1.2", "next", "{}"]) {
      assert.equal(isActionId(x), false, JSON.stringify(x));
    }
  });

  test("no two actions share an id, or one tap would run two things", () => {
    const ids = Object.values(ACT);
    assert.equal(new Set(ids).size, ids.length);
  });

  // Ids travel to Meta and back and sit in people's chat history, so they are
  // short and stable by design.
  test("every id fits WhatsApp's button id limit with room to spare", () => {
    for (const id of Object.values(ACT)) assert.ok(id.length <= 32, `${id} is too long to keep stable`);
  });
});
