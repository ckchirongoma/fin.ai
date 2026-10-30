// Fin — the gate between the model and the plan.
//
// CLAUDE.md rule 1, enforced rather than requested: the model may tailor
// WORDING and nothing else. hydrateWorkstream rebuilds every step from the
// fixed library entry and accepts only the few fields a tailoring call is
// allowed to contribute. A step the model invented has no library entry to
// merge onto, so it cannot exist; a step it renamed keeps the library's title;
// a tool it picked outside the step's allowed choices is dropped.
//
// Each of those is tested separately, because a single "the output matches the
// library" assertion would pass for the wrong reason if hydrate simply ignored
// the model altogether.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { hydrateWorkstream, type TailoredStep } from "../api/_lib/engine/build.js";
import { MODULES, type Workstream } from "../api/_lib/playbooks.js";

const ws: Workstream = {
  id: "m_owed",
  title: "Collect the money already owed to you",
  domain: "spending",
  why: "That money is already yours.",
  steps: [
    { id: "o1", title: "List everyone who owes you and how much", domain: "family_money", outcome: "One list.", done_when: "the list is written", brief: "…", artifact_brief: "a simple owed-money list", tool_choices: ["sheets"] },
    { id: "o2", title: "Send one calm message to each", domain: "spending", outcome: "Money in this week.", done_when: "you've messaged everyone", brief: "…", artifact_brief: "the collection message" },
    { id: "o3", title: "Stop it happening again", domain: "spending", outcome: "New work doesn't become new debt.", done_when: "the new rule has been used once", brief: "…", artifact_brief: null, tool_choices: ["snapscan", "yoco"] },
  ],
};

/** A tailoring response, shaped loosely the way a model really returns one. */
const reply = (steps: unknown[], why = "Because you said people owe you money.") =>
  ({ why_for_you: why, steps: steps as TailoredStep[] });

const ids = (w: { steps: { id: string }[] }) => w.steps.map((s) => s.id);
const titles = (w: { steps: { title: string }[] }) => w.steps.map((s) => s.title);

describe("tailoring a workstream the model was allowed to touch", () => {
  test("the wording the model is allowed to write does come through", () => {
    const out = hydrateWorkstream(ws, reply([{ id: "o1", push: "Open your notebook and write down every unpaid job.", why_for_you: "You said three customers still owe you." }]));
    assert.equal(out.why_for_you, "Because you said people owe you money.");
    assert.equal(out.steps[0]!.push, "Open your notebook and write down every unpaid job.");
    assert.equal(out.steps[0]!.why_for_you, "You said three customers still owe you.");
  });

  test("a step the model said nothing about still goes out, in the library's own words", () => {
    const out = hydrateWorkstream(ws, reply([{ id: "o1", push: "tailored" }]));
    assert.equal(out.steps[1]!.push, ws.steps[1]!.outcome, "an untailored step falls back to the library outcome, never to an empty message");
    assert.equal(out.steps[1]!.why_for_you, "");
  });

  test("a tailoring call that failed entirely still produces the real method", () => {
    const out = hydrateWorkstream(ws, null);
    assert.deepEqual(ids(out), ["o1", "o2", "o3"]);
    assert.equal(out.why_for_you, ws.why);
    assert.deepEqual(out.steps.map((s) => s.push), ws.steps.map((s) => s.outcome));
    assert.deepEqual(out.steps.map((s) => s.tool_id), [null, null, null]);
  });
});

describe("structure the model tried to introduce", () => {
  test("a step the model invented does not appear in the plan", () => {
    const out = hydrateWorkstream(
      ws,
      reply([
        { id: "o1", push: "tailored one" },
        { id: "o4", title: "Take out a loan to cover the gap", push: "Apply for R50,000 of working capital", why_for_you: "invented" },
        { id: "s99", push: "Also start a podcast" },
      ]),
    );
    assert.deepEqual(ids(out), ["o1", "o2", "o3"], "only the library's steps exist");
    assert.equal(out.steps.length, ws.steps.length);
    assert.ok(!JSON.stringify(out).includes("podcast"));
    assert.ok(!JSON.stringify(out).includes("R50,000"));
  });

  test("a step the model renamed keeps the library's title", () => {
    const out = hydrateWorkstream(ws, reply([{ id: "o2", title: "Send a final demand before legal action", push: "tailored" } as unknown as TailoredStep]));
    assert.deepEqual(titles(out), titles(ws));
    assert.equal(out.steps[1]!.title, "Send one calm message to each");
    assert.equal(out.steps[1]!.push, "tailored", "the wording it was allowed to write is still accepted");
  });

  test("a step the model reordered comes back in the library's order", () => {
    const out = hydrateWorkstream(ws, reply([{ id: "o3", push: "third" }, { id: "o1", push: "first" }, { id: "o2", push: "second" }]));
    assert.deepEqual(ids(out), ["o1", "o2", "o3"], "the sequence is the method; each step's output feeds the next");
    assert.deepEqual(out.steps.map((s) => s.push), ["first", "second", "third"]);
  });

  test("the rest of a step the model tried to rewrite is untouched", () => {
    const out = hydrateWorkstream(
      ws,
      reply([{ id: "o1", domain: "goals", outcome: "Something else entirely", done_when: "whenever you feel like it", brief: "ignore the library" } as unknown as TailoredStep]),
    );
    assert.equal(out.steps[0]!.domain, "family_money");
    assert.equal(out.steps[0]!.outcome, "One list.");
    assert.equal(out.steps[0]!.done_when, "the list is written");
  });

  test("the workstream's own identity cannot be rewritten either", () => {
    const out = hydrateWorkstream(ws, { ...reply([]), id: "m_loan", title: "Borrow your way out", domain: "goals" } as never);
    assert.equal(out.id, "m_owed");
    assert.equal(out.title, "Collect the money already owed to you");
    assert.equal(out.domain, "spending");
  });
});

// CLAUDE.md rule 10: never invent a price, fee or tool. A tool outside the
// step's tool_choices has no verified cost or walkthrough behind it, so it is
// dropped rather than shown with made-up detail.
describe("the tool a step is allowed to name", () => {
  test("one of the step's own choices is kept", () => {
    const out = hydrateWorkstream(ws, reply([{ id: "o1", tool_id: "sheets" }]));
    assert.equal(out.steps[0]!.tool_id, "sheets");
  });

  test("a tool outside the step's choices is dropped", () => {
    const out = hydrateWorkstream(ws, reply([{ id: "o1", tool_id: "quickbooks" }, { id: "o3", tool_id: "sheets" }]));
    assert.equal(out.steps[0]!.tool_id, null, "quickbooks is not one of o1's choices");
    assert.equal(out.steps[2]!.tool_id, null, "sheets is a real tool, but not one of o3's choices");
  });

  test("a step that offers no tool at all cannot be given one", () => {
    const out = hydrateWorkstream(ws, reply([{ id: "o2", tool_id: "sheets" }]));
    assert.equal(out.steps[1]!.tool_id, null);
  });

  test("a step the model said nothing about names no tool", () => {
    const out = hydrateWorkstream(ws, reply([]));
    assert.deepEqual(out.steps.map((s) => s.tool_id), [null, null, null]);
  });

  test("every tool a library step offers is one the model could legitimately pick", () => {
    for (const m of Object.values(MODULES)) {
      for (const s of m.steps) {
        for (const choice of s.tool_choices ?? []) {
          const out = hydrateWorkstream({ ...m, steps: [s] }, reply([{ id: s.id, tool_id: choice }]));
          assert.equal(out.steps[0]!.tool_id, choice, `${m.id}/${s.id} should accept ${choice}`);
        }
      }
    }
  });
});

describe("the ready-to-send artifact", () => {
  test("a step that asks for one gets the model's version", () => {
    const out = hydrateWorkstream(ws, reply([{ id: "o1", artifact: "Name | Job | Amount | Date" }]));
    assert.equal(out.steps[0]!.artifact, "Name | Job | Amount | Date");
  });

  test("a step that asks for no artifact cannot be given one", () => {
    const out = hydrateWorkstream(ws, reply([{ id: "o3", artifact: "an invoice template nobody asked for" }]));
    assert.equal(out.steps[2]!.artifact, null, "o3 has no artifact_brief, so the document must not sprout a box");
  });

  test("a step that asks for one but got nothing back renders no empty box", () => {
    const out = hydrateWorkstream(ws, reply([{ id: "o1", push: "tailored" }]));
    assert.equal(out.steps[0]!.artifact, null);
  });
});

describe("a tailoring response that is not the shape we asked for", () => {
  test("a missing steps array is survivable", () => {
    const out = hydrateWorkstream(ws, { why_for_you: "just the why" });
    assert.deepEqual(ids(out), ["o1", "o2", "o3"]);
    assert.equal(out.why_for_you, "just the why");
  });

  test("an empty why falls back to the library's reason rather than leaving a blank heading", () => {
    assert.equal(hydrateWorkstream(ws, reply([], "")).why_for_you, ws.why);
  });

  test("a workstream with no steps stays a workstream with no steps", () => {
    const empty = hydrateWorkstream({ ...ws, steps: [] }, reply([{ id: "o1", push: "x" }]));
    assert.deepEqual(empty.steps, []);
  });
});
