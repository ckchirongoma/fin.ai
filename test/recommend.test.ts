// Charles — the "My pick" line names the number on the card, never the id.
//
// Live test, 2026-09-25: three of five customer-options messages said
// "Start with c" (an internal option id), and one length-experiment message
// said "option 2" while its reasoning described option 1. normaliseRecommend
// runs at display time, with no model call, so every case here is a plain
// input → output pair.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { normaliseRecommend, resolvePick } from "../api/_lib/recommend.js";
import { rulePrompt, goalPrompt, REPLY_SCHEMA } from "../api/_lib/prompts.js";

const labels = ["Saturday regulars", "Guesthouses nearby", "Bridal parties"];

describe("an id letter is mapped to the displayed number", () => {
  test("Start with c", () => {
    assert.equal(
      normaliseRecommend("Start with c — high value per booking and you already know the photographers.", labels),
      "Start with 3 (Bridal parties) — high value per booking and you already know the photographers.",
    );
  });
  test("option b, go with b, pick c, (a)", () => {
    assert.equal(normaliseRecommend("Option b: steady weekly volume.", labels), "Start with 2 (Guesthouses nearby) — steady weekly volume.");
    assert.equal(normaliseRecommend("Go with b, they pay every month.", labels), "Start with 2 (Guesthouses nearby) — they pay every month.");
    assert.equal(normaliseRecommend("Pick c. Seasonal but high value.", labels), "Start with 3 (Bridal parties) — Seasonal but high value.");
    assert.equal(normaliseRecommend("(a) they already trust you.", labels), "Start with 1 (Saturday regulars) — they already trust you.");
  });
  test("a letter past the number of options resolves nothing", () => {
    const t = "Start with d — nobody else serves them.";
    assert.equal(normaliseRecommend(t, labels), t);
  });
});

describe("the English article 'a' is not an option id", () => {
  test("Start with a guesthouse contract is left alone when no option is named", () => {
    const t = "Start with a guesthouse contract — steady money beats walk-ins.";
    assert.equal(resolvePick(t, ["Office workers", "Delivery drivers", "Wedding planners"]), -1);
    assert.equal(normaliseRecommend(t, ["Office workers", "Delivery drivers", "Wedding planners"]), t);
  });
  test("a sentence that merely begins with 'A' is not option 1", () => {
    const t = "A regular contract is worth more than ten walk-ins.";
    assert.equal(normaliseRecommend(t, ["Office workers", "Delivery drivers"]), t);
  });
});

// Review 2026-09-25: the first version let any single label found anywhere in
// the text beat the number, so a reason that compared against or turned down
// another option ("unlike guesthouses…", "you can't be the cheapest…")
// rewrote a correct pick into the one the model rejected. Two tests here used
// to assert that label-anywhere precedence ("Start with 2 — Saturday regulars
// already trust you" → 1, "Start with c — the guesthouses nearby…" → 2); they
// now expect the explicit pick, because a label in the reason is not a pick.
describe("an explicit leading pick is trusted first", () => {
  const segs = ["Guesthouses", "Weekend tourists", "Students"];
  const angles = ["Never wait", "Cheapest", "Same-day"];
  test("a reason that names another option does not override the number", () => {
    assert.equal(
      normaliseRecommend("Start with 2 — tourists pay more than guesthouses and book online.", segs),
      "Start with 2 (Weekend tourists) — tourists pay more than guesthouses and book online.",
    );
    assert.equal(
      normaliseRecommend("Start with 2 — unlike guesthouses, they pay upfront.", segs),
      "Start with 2 (Weekend tourists) — unlike guesthouses, they pay upfront.",
    );
    assert.equal(normaliseRecommend("Start with 2. Guesthouses are slower.", segs), "Start with 2 (Weekend tourists) — Guesthouses are slower.");
    assert.equal(
      normaliseRecommend("Start with 2 — Saturday regulars already trust you and rebook on their own.", labels),
      "Start with 2 (Guesthouses nearby) — Saturday regulars already trust you and rebook on their own.",
    );
  });
  test("an explicit letter is not overridden by a label in the reason", () => {
    assert.equal(
      normaliseRecommend("Start with c — the guesthouses nearby give you standing weekly volume.", labels),
      "Start with 3 (Bridal parties) — the guesthouses nearby give you standing weekly volume.",
    );
  });
  test("short, common angle labels in the reason do not hijack the pick", () => {
    assert.equal(
      normaliseRecommend("Start with 3 — you can't be the cheapest, so compete on speed.", angles),
      "Start with 3 (Same-day) — you can't be the cheapest, so compete on speed.",
    );
    assert.equal(
      normaliseRecommend("Start with 2 — never wait costs too much for you now.", angles),
      "Start with 2 (Cheapest) — never wait costs too much for you now.",
    );
    assert.equal(
      normaliseRecommend("Start with 2 — Never wait is hard to prove; cheapest is easy to copy.", angles),
      "Start with 2 (Cheapest) — Never wait is hard to prove; cheapest is easy to copy.",
    );
  });
  test("with no number or letter, a label turned down in the reason is not the pick", () => {
    const t = "You can't be the cheapest, so compete on speed.";
    assert.equal(resolvePick(t, angles), -1);
    assert.equal(normaliseRecommend(t, angles), t);
  });
  test("a label echoed right beside the number is the pick phrase, and decides a disagreement", () => {
    assert.equal(
      normaliseRecommend("Start with 2 (Saturday regulars) — they already trust you.", labels),
      "Start with 1 (Saturday regulars) — they already trust you.",
    );
  });
  test("a label that IS the pick phrase decides", () => {
    assert.equal(normaliseRecommend("Start with Same-day — cheapest is easy to copy.", angles), "Start with 3 (Same-day) — cheapest is easy to copy.");
  });
  test("labels match regardless of case and hyphenation", () => {
    assert.equal(normaliseRecommend("Own the never-wait promise.", ["Never wait", "Cheapest nearby"]), "Start with 1 (Never wait) — Own the never-wait promise.");
  });
  test("two labels in the text, the number decides", () => {
    assert.equal(
      normaliseRecommend("Start with 3 — bridal parties pay more than Saturday regulars.", labels),
      "Start with 3 (Bridal parties) — bridal parties pay more than Saturday regulars.",
    );
  });
});

describe("already-normalised forms are never prefixed twice", () => {
  const segs = ["Guesthouses", "Weekend tourists", "Local families"];
  const cases: Array<[string, string]> = [
    ["Start with 1 (Guesthouses) — they rebook.", "Start with 1 (Guesthouses) — they rebook."],
    ['Start with "Weekend tourists" — they pay more.', "Start with 2 (Weekend tourists) — they pay more."],
    ["Start with 1 over 3 — they rebook.", "Start with 1 (Guesthouses) — they rebook."],
    ["Start with Guesthouses (1) — they rebook.", "Start with 1 (Guesthouses) — they rebook."],
    ["1 (Guesthouses) — they rebook.", "Start with 1 (Guesthouses) — they rebook."],
    ["Start with 1: Guesthouses — they rebook.", "Start with 1 (Guesthouses) — they rebook."],
    ["My pick: 2 (Weekend tourists) — they pay more.", "Start with 2 (Weekend tourists) — they pay more."],
    ["Start with 1 (Guesthouses)", "Start with 1 (Guesthouses)"],
  ];
  for (const [input, want] of cases) {
    test(input, () => assert.equal(normaliseRecommend(input, segs), want));
  }
});

describe("normalising is idempotent", () => {
  const sets: Record<string, string[]> = {
    labels,
    segs: ["Guesthouses", "Weekend tourists", "Students"],
    angles: ["Never wait", "Cheapest", "Same-day"],
  };
  const inputs: Array<[string, string]> = [
    ["labels", "Start with c — high value per booking and you already know the photographers."],
    ["labels", "Option b: steady weekly volume."],
    ["labels", "Go with b, they pay every month."],
    ["labels", "Pick c. Seasonal but high value."],
    ["labels", "(a) they already trust you."],
    ["labels", "Start with 2 — Saturday regulars already trust you and rebook on their own."],
    ["labels", "Start with 3 — bridal parties pay more than Saturday regulars."],
    ["labels", "Start with b — R4,000 a month is worth chasing (a guess — check it)."],
    ["labels", "Start with the Saturday regulars."],
    ["labels", "Start with 2 because they pay every month."],
    ["labels", "Whichever you can reach this week."],
    ["segs", "Start with 2 — tourists pay more than guesthouses and book online."],
    ["segs", "Start with 2 — unlike guesthouses, they pay upfront."],
    ["segs", "Start with 2. Guesthouses are slower."],
    ["segs", "Start with 1 (Guesthouses) — they rebook."],
    ["segs", 'Start with "Weekend tourists" — they pay more.'],
    ["segs", "Start with 1 over 3 — they rebook."],
    ["segs", "Start with Guesthouses (1) — they rebook."],
    ["segs", "Start with 1: Guesthouses — they rebook."],
    ["segs", "Guesthouses — standing weekly volume beats one-off walk-ins."],
    ["angles", "Start with 3 — you can't be the cheapest, so compete on speed."],
    ["angles", "Start with 2 — Never wait is hard to prove; cheapest is easy to copy."],
    ["angles", "Own the never-wait promise."],
  ];
  for (const [set, input] of inputs) {
    test(input, () => {
      const once = normaliseRecommend(input, sets[set]);
      assert.equal(normaliseRecommend(once, sets[set]), once);
      assert.ok(!/Start with \d+ \([^)]*\) — Start with/.test(once), `double prefix: ${once}`);
    });
  }
});

describe("the reason is kept and the pick words are stripped", () => {
  test("a plain number", () => {
    assert.equal(normaliseRecommend("Start with 1 — they already trust you.", labels), "Start with 1 (Saturday regulars) — they already trust you.");
    assert.equal(normaliseRecommend("2: standing weekly volume.", labels), "Start with 2 (Guesthouses nearby) — standing weekly volume.");
  });
  test("a label used as the pick word", () => {
    assert.equal(
      normaliseRecommend("Guesthouses — standing weekly volume beats one-off walk-ins.", ["Nearby flats", "Guesthouses", "Gym-goers"]),
      "Start with 2 (Guesthouses) — standing weekly volume beats one-off walk-ins.",
    );
    assert.equal(normaliseRecommend("Start with the Saturday regulars.", labels), "Start with 1 (Saturday regulars)");
    assert.equal(normaliseRecommend("Go after guesthouses first.", ["Guesthouses"]), "Start with 1 (Guesthouses)");
  });
  test("a hedge appended by price grounding survives", () => {
    assert.equal(
      normaliseRecommend("Start with b — R4,000 a month is worth chasing (a guess — check it).", labels),
      "Start with 2 (Guesthouses nearby) — R4,000 a month is worth chasing (a guess — check it).",
    );
  });
});

describe("nothing to resolve means nothing changes", () => {
  test("no option named, numbered or lettered", () => {
    const t = "Whichever you can reach this week.";
    assert.equal(normaliseRecommend(t, labels), t);
  });
  test("a number past the options", () => {
    assert.equal(normaliseRecommend("Start with 4 — fills quiet hours.", labels), "Start with 4 — fills quiet hours.");
  });
  test("empty text and empty labels", () => {
    assert.equal(normaliseRecommend("", labels), "");
    assert.equal(normaliseRecommend("Start with 1 — x", []), "Start with 1 — x");
  });
});

// The prompts ask for the displayed number, and the reply schema keeps a
// yes/no answer to a line or two — the belt to the normaliser's braces.
describe("the prompts behind the pick and the reply", () => {
  test("goalPrompt asks for the displayed number, never the id letter", () => {
    const p = goalPrompt({ objective: "more customers" }, { name: "Rinse" }, "run", "ZA");
    assert.match(p, /"Start with 1 — \.\.\."\. The number is the option's position in the list as the person sees it \(1, 2 or 3\) — never the "id" letter/);
  });
  test("rulePrompt asks for the displayed number too", () => {
    const p = rulePrompt({ objective: "more customers" }, "run", [{ label: "Guesthouses", what: "x" }], { name: "Rinse" }, "ZA");
    assert.match(p, /"Start with 2 — \.\.\."\. The number is the option's position in the list as the person sees it \(1, 2 or 3\)/);
    assert.doesNotMatch(p, /"Go with 2/);
  });
  // Live test, 2026-09-25: "Do I need to register with CIPC..." got five
  // lines and 476 characters. The rule is now concrete: first word is the
  // answer, one or two lines, detail behind a quick reply.
  test("REPLY_SCHEMA makes the yes/no rule concrete", () => {
    assert.match(REPLY_SCHEMA, /- YES OR NO: when the question can be answered yes or no .* the first word of the message is the answer — Yes \/ No \/ Not yet \/ It depends on X — and the whole message is one or two short lines, unless they asked how or why\. The detail goes in a quick_reply \("Show me how"\)/);
    assert.match(REPLY_SCHEMA, /- HOW LONG: as long as it takes to be useful/);
    assert.match(REPLY_SCHEMA, /- OFFER DEPTH, DON'T DUMP IT/);
  });
});
