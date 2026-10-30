// Fin — pass one of retrieval: the shortlist that costs nothing.
//
// CLAUDE.md calls the `keywords` column "the whole retrieval strategy", and
// says the scoring happens "in plain code, no model call, before anything
// touches an LLM". These tests pin the weights and the ordering, because the
// only thing standing between the model and the whole country's corpus is this
// function returning the right four rows.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import { costLine, isStale, kSheet, scoreRow, shortlist, staleDays, tSheet } from "../api/_lib/retrieval.js";
import { __setClient } from "../api/_lib/db.js";
import type { KnowledgeRow, ToolRow } from "../api/_lib/types.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString();

const knowledge = (over: Partial<KnowledgeRow> = {}): KnowledgeRow => ({
  id: "k.base",
  country: "ZA",
  domain: null,
  stages: null,
  keywords: null,
  title: "A knowledge entry",
  owner_summary: "What it means for the owner",
  applies_when: "always",
  not_when: "never",
  steps: ["do the thing"],
  cost: "R99 once-off",
  stakes: null,
  verified_on: daysAgo(1),
  ...over,
});

const tool = (over: Partial<ToolRow> = {}): ToolRow => ({
  id: "t.base",
  country: "ZA",
  domain: null,
  stages: null,
  keywords: null,
  name: "A tool",
  fits: "this situation",
  not_when: "that situation",
  why: "because",
  cost: "R99 a month",
  url: "https://example.com",
  setup: "sign up",
  walkthrough: null,
  verified_on: daysAgo(1),
  ...over,
});

/** A Supabase stand-in that records which tables were touched. */
function spyClient() {
  const tables: string[] = [];
  const fake = {
    from(table: string) {
      tables.push(table);
      return { insert: async () => ({ data: null, error: null }) };
    },
  };
  return { tables, restore: __setClient(fake as unknown as SupabaseClient) };
}

describe("scoring a library row against what the owner actually said", () => {
  test("a word the owner used outweighs the category the row sits in", () => {
    const onKeyword = scoreRow({ keywords: ["deposit"], domain: null, stages: null, cost: "R99" }, { text: "should I take a deposit", stage: "run" });
    const onDomain = scoreRow({ keywords: null, domain: "spending", stages: null, cost: "R99" }, { text: "should I take a deposit", stage: "run", domain: "spending" });
    assert.equal(onKeyword, 3);
    assert.equal(onDomain, 2);
    assert.ok(onKeyword > onDomain, "a keyword hit must beat a category match");
  });

  test("matching the stage the business is at is worth one point", () => {
    assert.equal(scoreRow({ keywords: null, domain: null, stages: ["run", "grow"], cost: "R99" }, { text: "", stage: "run" }), 1);
    assert.equal(scoreRow({ keywords: null, domain: null, stages: ["idea"], cost: "R99" }, { text: "", stage: "run" }), 0);
  });

  // CLAUDE.md rule 9: free and reversible before anything that costs money —
  // enforced all the way down to which row gets shown first.
  test("a free option breaks a tie upward", () => {
    const free = scoreRow({ keywords: null, domain: null, stages: null, cost: "Free" }, { text: "", stage: "run" });
    const paid = scoreRow({ keywords: null, domain: null, stages: null, cost: "R450 a month" }, { text: "", stage: "run" });
    assert.equal(free, 1);
    assert.equal(paid, 0);
  });

  test("the headache named at onboarding keeps counting long after that message", () => {
    const row = { keywords: ["chasing"], domain: null, stages: null, cost: "R99" };
    assert.equal(scoreRow(row, { text: "what should I do today", stage: "run", headache: "always chasing people for money" }), 1);
  });

  test("a row matching on every axis at once scores the sum of them", () => {
    const row = { keywords: ["deposit"], domain: "spending", stages: ["run"], cost: "Free" };
    // keyword 3 + headache 1 + domain 2 + stage 1 + free 1
    assert.equal(scoreRow(row, { text: "how do I ask for a deposit", stage: "run", domain: "spending", headache: "no deposit, then no payment" }), 8);
  });

  test("a row that matches nothing scores zero rather than something small", () => {
    assert.equal(scoreRow({ keywords: ["vat", "sars"], domain: "family_money", stages: ["grow"], cost: "R99" }, { text: "my oven broke", stage: "run", domain: "protection" }), 0);
  });

  test("an unstated stage is read as a trading business, not as no business", () => {
    assert.equal(scoreRow({ keywords: null, domain: null, stages: ["run"], cost: "R99" }, { text: "", stage: "" }), 1);
  });
});

describe("building the shortlist the model is allowed to see", () => {
  test("the best-scoring rows come first", async () => {
    const rows = [
      knowledge({ id: "k.weak", keywords: ["vat"] }),
      knowledge({ id: "k.strong", keywords: ["deposit", "upfront"] }),
      knowledge({ id: "k.middle", keywords: ["deposit"] }),
    ];
    const out = await shortlist(rows, [], { text: "a deposit upfront please", stage: "run" }, { country: "ZA", log: false });
    assert.deepEqual(out.knowledge.map((k) => k.id), ["k.strong", "k.middle", "k.weak"]);
    assert.equal(out.topScore, 6);
  });

  test("rows on the same score are ordered predictably, so the same question gives the same answer twice", async () => {
    const rows = [knowledge({ id: "k.zebra", keywords: ["deposit"] }), knowledge({ id: "k.aardvark", keywords: ["deposit"] })];
    const out = await shortlist(rows, [], { text: "deposit", stage: "run" }, { country: "ZA", log: false });
    assert.deepEqual(out.knowledge.map((k) => k.id), ["k.aardvark", "k.zebra"]);
  });

  test("a step that names its own knowledge entry always gets it, however badly it scores", async () => {
    const rows = [
      knowledge({ id: "k.deposits", keywords: ["nothing", "relevant"] }),
      knowledge({ id: "k.loud", keywords: ["deposit", "upfront", "payment"] }),
    ];
    const out = await shortlist(rows, [], { text: "deposit upfront payment", stage: "run", pinKnowledge: ["k.deposits"] }, { country: "ZA", log: false });
    assert.equal(out.knowledge[0]!.id, "k.deposits", "a pinned entry leads the shortlist");
    assert.ok(out.knowledge.some((k) => k.id === "k.loud"));
  });

  test("a pinned id that is not in the library is ignored rather than crashing the build", async () => {
    const out = await shortlist([knowledge({ id: "k.real" })], [], { text: "anything", stage: "run", pinKnowledge: ["k.ghost"] }, { country: "ZA", log: false });
    assert.deepEqual(out.knowledge.map((k) => k.id), ["k.real"]);
  });

  test("the shortlist stays short: four knowledge entries and five tools by default", async () => {
    const k = Array.from({ length: 12 }, (_v, i) => knowledge({ id: `k.${i}`, keywords: ["deposit"] }));
    const t = Array.from({ length: 12 }, (_v, i) => tool({ id: `t.${i}`, keywords: ["deposit"] }));
    const out = await shortlist(k, t, { text: "deposit", stage: "run" }, { country: "ZA", log: false });
    assert.equal(out.knowledge.length, 4);
    assert.equal(out.tools.length, 5);
  });

  test("a caller can ask for fewer rows still", async () => {
    const k = Array.from({ length: 12 }, (_v, i) => knowledge({ id: `k.${i}` }));
    const t = Array.from({ length: 12 }, (_v, i) => tool({ id: `t.${i}` }));
    const out = await shortlist(k, t, { text: "x", stage: "run", maxKnowledge: 2, maxTools: 1 }, { country: "ZA", log: false });
    assert.equal(out.knowledge.length, 2);
    assert.equal(out.tools.length, 1);
  });

  test("an empty library gives an empty shortlist and a zero top score", async () => {
    const out = await shortlist([], [], { text: "anything at all", stage: "run" }, { country: "ZA", log: false });
    assert.deepEqual(out, { knowledge: [], tools: [], topScore: 0 });
  });

  // The honest trigger for building pgvector is "a logged gap that recurs",
  // not a hunch. So a question nothing matched has to leave a trace.
  test("a question the library never anticipated is logged as a retrieval gap", async () => {
    const spy = spyClient();
    try {
      await shortlist([knowledge({ keywords: ["vat"] })], [], { text: "can I sell at the taxi rank on a Sunday", stage: "run" }, { country: "ZA" });
      assert.deepEqual(spy.tables.filter((t) => t !== "safety_events"), ["retrieval_gaps"], "no owner words given, so no knowledge signal (db/0015) — only a note saying why");
      spy.tables.length = 0;
      await shortlist([knowledge({ keywords: ["vat"] })], [], { text: "can I sell at the taxi rank on a Sunday", stage: "run" }, { country: "ZA", quote: "can I sell at the taxi rank on a Sunday" });
      assert.deepEqual(spy.tables, ["retrieval_gaps", "knowledge_signals"], "with them, the same event is also a knowledge signal");
    } finally {
      spy.restore();
    }
  });

  test("nothing is logged when the caller asked not to log", async () => {
    const spy = spyClient();
    try {
      await shortlist([knowledge({ keywords: ["vat"] })], [], { text: "can I sell at the taxi rank on a Sunday", stage: "run" }, { country: "ZA", log: false });
      assert.deepEqual(spy.tables, []);
    } finally {
      spy.restore();
    }
  });

  test("a one-word miss is not a gap — it is someone saying hello", async () => {
    const spy = spyClient();
    try {
      await shortlist([knowledge({ keywords: ["vat"] })], [], { text: "hi", stage: "run" }, { country: "ZA" });
      assert.deepEqual(spy.tables, []);
    } finally {
      spy.restore();
    }
  });
});

describe("how old a fact is allowed to be", () => {
  test("a fact checked today is not stale", () => {
    assert.equal(staleDays(daysAgo(0)), 0);
    assert.equal(isStale(daysAgo(0)), false);
  });

  test("ninety days old is still inside the window", () => {
    assert.equal(staleDays(daysAgo(90)), 90);
    assert.equal(isStale(daysAgo(90)), false, "90 days is the boundary, and the boundary is fresh");
  });

  test("ninety-one days old is stale", () => {
    assert.equal(staleDays(daysAgo(91)), 91);
    assert.equal(isStale(daysAgo(91)), true);
  });

  test("a fact with no verification date is treated as the oldest thing we have", () => {
    assert.equal(staleDays(null), Number.POSITIVE_INFINITY);
    assert.equal(staleDays(undefined), Number.POSITIVE_INFINITY);
    assert.equal(isStale(null), true);
  });

  test("an unparseable date is treated as unverified rather than as today", () => {
    assert.equal(staleDays("not a date"), Number.POSITIVE_INFINITY);
    assert.equal(isStale("not a date"), true);
  });
});

// CLAUDE.md rule 10: never invent a price, and anything past 90 days gets
// hedged automatically. The hedge is attached to the string the model is given
// so that even a model ignoring its instructions can only copy a hedged price.
describe("the hedge attached to every price", () => {
  test("a freshly checked price is passed through untouched", () => {
    assert.equal(costLine("R475 once-off", daysAgo(10)), "R475 once-off");
  });

  test("a price checked ninety days ago is still passed through untouched", () => {
    assert.equal(costLine("R475 once-off", daysAgo(90)), "R475 once-off");
  });

  test("a stale price carries its age and the instruction to confirm it", () => {
    const line = costLine("R475 once-off", daysAgo(120));
    assert.ok(line.startsWith("R475 once-off — last checked 120 days ago"));
    assert.ok(line.includes("confirm the price at sign-up"));
  });

  test("a price we never verified says so plainly rather than guessing an age", () => {
    const line = costLine("R475 once-off", null);
    assert.ok(line.includes("we do not know when"));
    assert.ok(line.includes("confirm the price at sign-up"));
  });
});

describe("the sheets handed to the model", () => {
  test("an empty knowledge shortlist says the library had nothing, so the model cannot fill the silence", () => {
    assert.equal(kSheet([]), "(nothing in the library matched this question)");
  });

  test("an empty tool shortlist tells the model to say so rather than name a tool", () => {
    assert.ok(tSheet([]).includes("say so rather than naming one"));
  });

  test("every price on the knowledge sheet arrives already hedged when it is old", () => {
    const sheet = kSheet([knowledge({ id: "k.cipc", cost: "R175", verified_on: daysAgo(400) })]);
    assert.ok(sheet.includes("confirm the price at sign-up"));
  });

  test("every price on the tools sheet arrives already hedged when it is old", () => {
    const sheet = tSheet([tool({ id: "t.yoco", cost: "R1,499 for the reader", verified_on: null })]);
    assert.ok(sheet.includes("confirm the price at sign-up"));
  });

  test("one row per line, so a shortlist of three reads as three facts", () => {
    const sheet = kSheet([knowledge({ id: "k.a" }), knowledge({ id: "k.b" }), knowledge({ id: "k.c" })]);
    assert.equal(sheet.split("\n").length, 3);
  });
});

// ── Matching a phrase nobody types verbatim ──────────────────────
//
// 57% of the library's keywords are multi-word phrases, and an owner almost
// never types one word for word. Matching only the whole phrase left real
// questions scoring zero against the exact entry they needed — "at what point
// must I register for VAT?" against a row keyed on "when register for vat",
// "vat threshold" and "vat ghana". Measured on the eval set, tiered matching
// took the unmatched count from 15 of 40 to 12, and most of what remains is
// off-topic or distress, where zero is the right answer.

describe("keyword matching across the three tiers", () => {
  const row = (keywords: string[]) => ({ keywords, domain: null, stages: null, cost: "" });
  const q = (text: string) => ({ text, stage: "run" });

  test("the whole phrase, typed as written, scores highest", () => {
    assert.equal(scoreRow(row(["vat threshold"]), q("what is the vat threshold in ghana")), 3);
  });

  test("every meaningful word present, in any order, scores nearly as high", () => {
    // "when register for vat" -> significant tokens: register, vat
    assert.equal(scoreRow(row(["when register for vat"]), q("at what point must I register for VAT?")), 2);
  });

  test("a partial overlap counts for a little", () => {
    // "small company tax nigeria" -> small, company, tax, nigeria: 3 of 4.
    assert.equal(scoreRow(row(["small company tax nigeria"]), q("how much company tax does a small business pay")), 1);
  });

  test("one word short of most of the phrase scores nothing", () => {
    assert.equal(scoreRow(row(["gra modified taxation"]), q("who is the gra")), 0);
  });

  test("a single-word keyword matches on a word boundary, not a substring", () => {
    assert.equal(scoreRow(row(["vat"]), q("do I need to charge vat")), 3);
    assert.equal(scoreRow(row(["vat"]), q("this is a private matter"), ), 0, "'private' contains 'vat' and must not match");
  });

  test("a keyword made only of stopwords cannot match everything", () => {
    assert.equal(scoreRow(row(["how much should"]), q("what is the weather like today")), 0);
  });

  test("the headache named at onboarding still counts, and counts for less", () => {
    const item = row(["no show"]);
    assert.equal(scoreRow(item, { text: "unrelated question", stage: "run", headache: "people book and no show" }), 1);
    assert.equal(scoreRow(item, { text: "they no show every saturday", stage: "run" }), 3);
  });
});
