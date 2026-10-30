// Charles — the fixed module library: which modules a diagnosis earns, and the
// shape of the library itself. CLAUDE.md rule 1: the plan is assembled from
// this library, never freestyled; rule 11: nothing in it recommends credit.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MODULES, pickPlaybook, type Signals } from "../api/_lib/playbooks.js";

const noAnswers: Record<string, string> = {};

describe("a household whose answers point at nothing", () => {
  // Load-bearing. Saying "I don't have enough" is a real answer, and the
  // alternative — three modules nobody's diagnosis earned — is the exact
  // generic-advice failure the Kenya RCT found made the weakest worse.
  test("gets no plan at all rather than a generic one", () => {
    assert.equal(pickPlaybook("stretching", {}, noAnswers, []), null);
    assert.equal(pickPlaybook("stretching", undefined, noAnswers, []), null);
    assert.equal(pickPlaybook("surviving", { problem_in_their_words: "things are fine" }, noAnswers, []), null);
  });

  test("a goal alone is not enough to earn a module", () => {
    assert.equal(pickPlaybook("stretching", {}, noAnswers, [{ label: "R1,000 by Christmas", what: "save R1,000" }]), null);
  });

  test("the future module is earned by the stage, not a signal: steady and building only", () => {
    assert.equal(pickPlaybook("surviving", {}, noAnswers, []), null);
    assert.equal(pickPlaybook("steady", {}, noAnswers, [])!.workstreams[0]!.id, "m_future");
    assert.equal(pickPlaybook("building", {}, noAnswers, [])!.workstreams[0]!.id, "m_future");
  });
});

describe("a household with real signals", () => {
  const everything: Signals = {
    owes_any: true,
    owes_mashonisa: true,
    owes_two_plus: true,
    arrears: true,
    month_short: true,
    dont_know_where: true,
    family_pressure: true,
    no_cushion: true,
    no_cover: true,
    fees_pain: true,
    grant_income: true,
    records_weak: true,
    credit_worry: true,
    scam_exposed: true,
    over_indebted: true,
  };

  test("never gets more than three parts, however many things are wrong", () => {
    const plan = pickPlaybook("surviving", everything, noAnswers, [])!;
    assert.ok(plan);
    assert.equal(plan.workstreams.length, 3, "three parts is the cap; one thing done properly beats three half-done");
  });

  test("the thing the person called their biggest problem leads the plan", () => {
    const plan = pickPlaybook("surviving", { ...everything, top_problem: "m_family" }, noAnswers, [])!;
    assert.equal(plan.workstreams[0]!.id, "m_family");
  });

  test("a different stated top problem leads instead — it is their answer that moves it, not a fixed order", () => {
    const plan = pickPlaybook("surviving", { ...everything, top_problem: "m_cover" }, noAnswers, [])!;
    assert.equal(plan.workstreams[0]!.id, "m_cover");
  });

  test("what they said they want ranks the rest", () => {
    const signals: Signals = { credit_worry: true, family_pressure: true };
    const credit = pickPlaybook("stretching", signals, { objective_kind: "Fix my credit record" }, [])!;
    assert.equal(credit.workstreams[0]!.id, "m_credit");
    const family = pickPlaybook("stretching", signals, { objective_kind: "Protect my family" }, [])!;
    assert.equal(family.workstreams[0]!.id, "m_family");
  });

  test("the mashonisa is pulled forward, because it is the money bleeding fastest", () => {
    const plan = pickPlaybook("stretching", { owes_mashonisa: true, no_cushion: true, dont_know_where: true, fees_pain: true }, noAnswers, [])!;
    assert.equal(plan.workstreams[0]!.id, "m_shark");
    assert.match(plan.order_note, /bleeding fastest/);
  });

  test("money already theirs is named as the fastest money when it leads", () => {
    const plan = pickPlaybook("stretching", { unclaimed_benefit: true, no_cushion: true, top_problem: "m_claim" }, noAnswers, [])!;
    assert.equal(plan.workstreams[0]!.id, "m_claim");
    assert.match(plan.order_note, /already yours/);
  });

  test("a single-part plan says why it is a single part instead of padding it out", () => {
    const plan = pickPlaybook("stretching", { no_cushion: true }, noAnswers, [])!;
    assert.equal(plan.workstreams.length, 1);
    assert.match(plan.order_note, /Only one part/);
    assert.match(plan.headline, /^Ninety days on /);
  });

  // CLAUDE.md rule 2: a plan may not claim the person said something they
  // didn't. The order note quotes them only when there is something to quote.
  test("the plan quotes the person's own words only when they gave some", () => {
    const quoted = pickPlaybook("stretching", { no_cushion: true, dont_know_where: true, problem_in_their_words: "the month is finished by the 20th" }, noAnswers, [])!;
    assert.match(quoted.order_note, /"the month is finished by the 20th"/);

    const unquoted = pickPlaybook("stretching", { no_cushion: true, dont_know_where: true }, noAnswers, [])!;
    assert.ok(!unquoted.order_note.includes('"'), "with nothing to quote, nothing is put in quotation marks");
  });

  test("the headline names the parts that are actually in the plan", () => {
    const plan = pickPlaybook("stretching", { owes_any: true, no_cushion: true }, noAnswers, [])!;
    for (const w of plan.workstreams) assert.ok(plan.headline.includes(w.title.toLowerCase()), `${w.title} is missing from the headline`);
  });

  test("a module left out is replaced by the next-best, and the headline is rebuilt", () => {
    const signals: Signals = { owes_mashonisa: true, owes_any: true, no_cushion: true, dont_know_where: true };
    const first = pickPlaybook("stretching", signals, noAnswers, [])!;
    assert.ok(first.workstreams.some((w) => w.id === "m_shark"));
    const without = pickPlaybook("stretching", signals, noAnswers, [], ["m_shark"])!;
    assert.ok(!without.workstreams.some((w) => w.id === "m_shark"));
    assert.ok(without.workstreams.length >= 1);
    assert.doesNotMatch(without.headline, /mashonisa/);
  });
});

describe("every module's condition", () => {
  test("survives an empty diagnosis without throwing", () => {
    for (const [key, m] of Object.entries(MODULES)) {
      assert.doesNotThrow(() => m.needs({}), `${key}.needs({}) threw`);
      assert.equal(typeof m.needs({}), "boolean", `${key}.needs({}) did not answer yes or no`);
    }
  });

  test("survives missing answers and a missing goal list", () => {
    for (const [key, m] of Object.entries(MODULES)) {
      assert.doesNotThrow(() => m.needs({}, undefined, undefined), `${key}`);
      assert.doesNotThrow(() => m.needs({}, {}, []), `${key}`);
    }
  });

  test("gives the same answer every time it is asked", () => {
    const signals: Signals = { owes_any: true, no_cushion: true, fees_pain: true };
    const goals = [{ label: "R1,000 by Christmas", what: "save R1,000" }];
    for (const [key, m] of Object.entries(MODULES)) {
      const first = m.needs(signals, {}, goals, "stretching");
      for (let i = 0; i < 5; i++) assert.equal(m.needs(signals, {}, goals, "stretching"), first, `${key} is not deterministic`);
    }
  });

  test("no module fires on an empty diagnosis at the surviving or stretching stage, which is what makes the null plan possible", () => {
    for (const stage of ["surviving", "stretching"]) {
      assert.deepEqual(Object.entries(MODULES).filter(([, m]) => m.needs({}, {}, [], stage)).map(([k]) => k), [], stage);
    }
  });
});

describe("the shape of the fixed library itself", () => {
  test("thirteen modules, each with a unique id, or two parts would collide in the plan", () => {
    const ids = Object.values(MODULES).map((m) => m.id);
    assert.equal(ids.length, 13);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("every module has steps, and every step is uniquely identified across the whole library", () => {
    const all: string[] = [];
    for (const [key, m] of Object.entries(MODULES)) {
      assert.ok(m.steps.length > 0, `${key} has no steps`);
      all.push(...m.steps.map((s) => s.id));
    }
    assert.equal(new Set(all).size, all.length, "a step id is shared between two modules");
  });

  test("every step says what done looks like, carries a brief to tailor, and how-to lines the person can follow", () => {
    for (const m of Object.values(MODULES)) {
      for (const s of m.steps) {
        assert.ok(s.done_when.trim().length > 0, `${m.id}/${s.id} has no done_when`);
        assert.ok(s.brief.trim().length > 0, `${m.id}/${s.id} has no brief for the model to tailor`);
        // How-to lines, or a named tool whose walkthrough says it all.
        assert.ok((s.how_to ?? []).length >= 3 || (s.tool_choices ?? []).length > 0, `${m.id}/${s.id} has neither how-to lines nor a tool`);
      }
    }
  });

  test("every module says who it serves, so the person's objective can rank it", () => {
    for (const [key, m] of Object.entries(MODULES)) {
      assert.ok(m.serves.length > 0, `${key} serves nothing, so it can never be ranked`);
    }
  });

  // Rule 10: a how-to line never carries a figure of its own; figures come
  // from the library rows a step names, with their check dates.
  test("no how-to line states a rand amount or a percentage", () => {
    for (const m of Object.values(MODULES)) {
      for (const s of m.steps) {
        for (const line of s.how_to ?? []) assert.doesNotMatch(line, /\bR\s?\d|\d+(?:\.\d+)?\s?%/, `${m.id}/${s.id}: "${line}"`);
      }
    }
  });

  // Rule 11: never credit.
  test("no module, step or how-to line recommends borrowing", () => {
    const credit = /\b(?:take|get|apply for|consider)\s+(?:a\s+|an\s+|another\s+)?(?:loan|credit card|overdraft|cash advance|consolidation loan|payday loan)\b/i;
    for (const m of Object.values(MODULES)) {
      assert.doesNotMatch(`${m.title} ${m.why}`, credit, m.id);
      for (const s of m.steps) {
        assert.doesNotMatch(`${s.title} ${s.outcome} ${s.brief} ${(s.how_to ?? []).join(" ")}`, credit, `${m.id}/${s.id}`);
      }
    }
  });
});
