// Fin — filling in an approved WhatsApp template.
//
// Meta's template placeholders are positional: {{1}}, {{2}}. A template that
// goes out with a placeholder still in it is not a cosmetic problem — it is
// what a real owner reads on their phone at seven in the morning, and it is
// how a number earns the block that ends a pilot.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { fillTemplate } from "../api/_lib/nudges.js";

describe("filling an approved template", () => {
  test("placeholders are filled by position", () => {
    assert.equal(
      fillTemplate("Morning {{1}} — your next step is {{2}}.", { "1": "Thabo", "2": "listing who owes you" }),
      "Morning Thabo — your next step is listing who owes you.",
    );
  });

  test("the same placeholder used twice is filled twice", () => {
    assert.equal(fillTemplate("{{1}}, it's {{1}} again", { "1": "Ada" }), "Ada, it's Ada again");
  });

  test("placeholders out of order are still filled by their own number", () => {
    assert.equal(fillTemplate("{{2}} before {{1}}", { "1": "one", "2": "two" }), "two before one");
  });

  test("a variable nobody supplied leaves nothing behind", () => {
    const out = fillTemplate("Morning {{1}} — your next step is {{2}}.", { "1": "Thabo" });
    assert.ok(!out.includes("{{"), "an owner must never read a raw placeholder");
    assert.ok(!out.includes("}}"));
    assert.equal(out, "Morning Thabo — your next step is .");
  });

  test("no variables at all leaves no placeholders at all", () => {
    assert.equal(fillTemplate("Hi {{1}}, about {{2}} and {{3}}", {}), "Hi , about  and");
  });

  test("a template with no placeholders is passed through", () => {
    assert.equal(fillTemplate("Just checking in.", { "1": "unused" }), "Just checking in.");
  });

  test("surrounding whitespace is trimmed, so a dropped leading variable does not indent the message", () => {
    assert.equal(fillTemplate("  {{1}} how did it go?  ", { "1": "" }), "how did it go?");
  });

  test("a value containing braces is not re-expanded", () => {
    assert.equal(fillTemplate("{{1}}", { "1": "{{2}}", "2": "should not appear" }), "{{2}}");
  });

  test("an empty template stays empty", () => {
    assert.equal(fillTemplate("", { "1": "x" }), "");
  });
});
