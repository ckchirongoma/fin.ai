// Fin — depth of information, per market, as a test.
//
// The founder, round 23: "add another thing to test for: the quality of the
// responses in terms of depth of information… keep iterating and keep doing
// more research… so that all regions have great quality and depth in
// everything we're trying to cover." kb-coverage.test.ts proves a question
// reaches a row; this file proves the row it reaches lets the owner ACT: the
// local body or brand named, the figure with its date, concrete steps, the
// trap to avoid. scripts/kb-depth.ts is the yardstick (binary parts, so
// padding earns nothing); scripts/eval.ts --judge scores the same thing on
// live answers (DEPTH_LEVELS) and its depth checks run on every reply.
//
// Three kinds of assertion, all ratchets — they can only tighten:
//   1. the scorer itself, on rows built to be shallow and deep;
//   2. floors per market (average depth, deep rows, shallow answers), set
//      to today's measured level, and parity: no market more than a fixed
//      gap behind the best;
//   3. a per-row gate: every row clears a minimum, except a named list of
//      rows still waiting for research — and a row on that list that has
//      been deepened must come off it.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { COUNTRIES, DOMAINS, loadInputs } from "../scripts/kb-coverage.ts";
import { buildLexicon, costDepth, kbDepth, knowledgeDepth, named, toolDepth, type DepthReport } from "../scripts/kb-depth.ts";
import type { KnowledgeRow, ToolRow } from "../api/_lib/types.ts";
import { COUNTRIES as MARKETS } from "../api/_lib/countries.ts";

const AS_OF = new Date("2026-10-30");

describe("the depth scorer", () => {
  const shallowK = {
    id: "k.x_shallow", country: "UG", domain: "income", stages: ["start"], keywords: ["register"], title: "Register",
    owner_summary: "Register your business. It is a good idea.", applies_when: "always", not_when: "never",
    steps: ["Think about it", "Register"], cost: "check", stakes: "low", verified_on: "2026-10-11",
  } as unknown as KnowledgeRow;
  const deepK = {
    id: "k.x_deep", country: "UG", domain: "income", stages: ["start", "run"], keywords: ["ursb"], title: "Registering with URSB",
    owner_summary: "Register a business name with URSB on its online system before you open a bank account or bid for a contract. A name costs UGX 25,000 at URSB plus stamp duty, paid by mobile money with a PRN. Never pay an agent who calls you first: URSB does not call owners. Keep the certificate with your TIN, because banks ask for both.",
    applies_when: "you trade under a name other than your own", not_when: "you are only testing the idea with friends",
    steps: ["Search the name on ursb.go.ug", "Reserve it and pay with the PRN at any bank or by MoMo", "Fill the business name form with your NIN", "Download the certificate", "Take it with your TIN to the bank"],
    cost: "UGX 25,000 plus stamp duty (checked 2026-10-11)", stakes: "medium", verified_on: "2026-10-11",
  } as unknown as KnowledgeRow;

  test("a vague row scores low, a row an owner can act on scores high", () => {
    const lex = buildLexicon([deepK], []);
    const s = knowledgeDepth(shallowK, lex);
    const d = knowledgeDepth(deepK, lex);
    assert.ok(s.score <= 3, `shallow scored ${s.score}: ${JSON.stringify(s.parts)}`);
    assert.ok(d.score >= 9, `deep scored ${d.score}: ${JSON.stringify(d.parts)}`);
  });

  test("padding is not depth: four times the words, no new facts, no new points", () => {
    const lex = buildLexicon([deepK], []);
    const padded = { ...shallowK, owner_summary: Array(12).fill("Registering is a good idea and it helps you grow your business over time.").join(" ") };
    const s = knowledgeDepth(shallowK, lex).score;
    const p = knowledgeDepth(padded as KnowledgeRow, lex).score;
    assert.ok(p - s <= 1, `padding added ${p - s} points`);
  });

  test("cost: a figure or a plain free beats who-to-ask, which beats a vague check", () => {
    assert.equal(costDepth("UGX 50,000 a year (checked 2026-10-11)"), 2);
    assert.equal(costDepth("Shs 20,000/="), 2, "the Ugandan suffix form is a figure");
    assert.equal(costDepth("0.5% of the amount withdrawn"), 2);
    assert.equal(costDepth("free"), 2);
    assert.equal(costDepth("set by each council - ask the revenue office"), 1);
    assert.equal(costDepth("varies, check"), 0);
  });

  test("local names: South African bodies, portals and USSD codes count; WhatsApp and Google do not", () => {
    const n = named("Register on ursb.go.ug | pay URA with a PRN | dial *165# | open WhatsApp | search Google");
    for (const want of ["ursb.go.ug", "URA", "PRN", "*165#"]) assert.ok(n.includes(want), `${want} in ${n.join(", ")}`);
    assert.ok(!n.includes("WhatsApp") && !n.includes("Google"));
  });

  test("a country, a month or a menu word is not a local name (review, round 23)", () => {
    const n = named("sell in Nigeria | buyers in Uganda | due by 31 Oct | tap Accept | open Settings | name it Owed | sell in South Africa | many South African owners");
    for (const not of ["Nigeria", "Uganda", "Oct", "Accept", "Settings", "Owed", "South Africa", "South African"]) assert.ok(!n.includes(not), `${not} counted as a local name: ${n.join(", ")}`);
    assert.ok(named("pay on the Hustler Fund app").includes("Hustler Fund"), "a real programme after a lower-case word still counts");
  });

  test("a tool with a full walkthrough, setup chain, ten-minute action and a figure scores high", () => {
    const t = {
      id: "x_tool", country: "UG", domain: "spending", stages: ["run"], keywords: ["momo pay"], name: "MoMoPay",
      fits: "you take MTN mobile money at a shop or stall", not_when: "you only sell on credit to companies", why: "customers pay a merchant code, not your personal line",
      cost: "no fee to register; customers pay nothing to pay you (checked 2026-10-11)", url: "https://www.mtn.co.ug/momopay/",
      setup: "dial *165# → choose MoMoPay → register with your NIN → get your merchant code",
      walkthrough: [
        "Dial *165# from the MTN line you will use for the shop, and choose the MoMoPay option.",
        "Register with your National ID number; a registered business also gives its URSB certificate.",
        "Write the merchant code on a card at the counter, with the business name customers will see.",
        "Ask each customer to pay to the code, then check the payment in your own balance before handing over goods.",
        "Each evening, dial *165# again and read the day's statement against your sales book.",
      ],
      verified_on: "2026-10-11", informal_business_supported: true, free_type: "NO_MONTHLY_FEE",
      ten_minute_action: "Dial *165# now from the shop's MTN line, open the MoMoPay menu and read what it asks for, so you know which documents to bring.",
    } as unknown as ToolRow;
    const r = toolDepth(t, buildLexicon([], [t]));
    assert.ok(r.score >= 9, `${r.score}: ${JSON.stringify(r.parts)}`);
  });
});

// ── 2. Floors and parity per market ──────────────────────────────────────
//
// Measured 2026-10-11, after db/0029 (Uganda) and db/0030 (every shallow
// row deepened, South Africa's missing topics added), with the corrected
// scorer: review found country names, months and menu words ("sell in
// Nigeria", "tap Accept", "in South Africa") counted as local names, so the first floors were
// set on inflated scores. They were re-set once, from the corrected scorer.
// Raise a floor when content improves; never lower one to make a change pass.
// FLOOR_MARK: measured by `node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/kb-depth.ts` on the day the library landed.
const FLOORS: Record<string, { kAvg: number; tAvg: number; kDeep: number; tDeep: number; shallowMain: number }> = {
  ZA: { kAvg: 9.5, tAvg: 9.9, kDeep: 56, tDeep: 30, shallowMain: 0 },
};

// No market's average may sit more than this far behind the best market's.
const PARITY_GAP = 1.1;

describe("depth floors and parity, per market", async () => {
  const r: DepthReport = await kbDepth(loadInputs(AS_OF));

  test("every market the product serves is measured", () => {
    // Against the product's own list, not the scorer's: a market added to
    // api/_lib/countries.ts without a depth floor fails here.
    assert.deepEqual(Object.keys(r.countries).sort(), Object.keys(MARKETS).sort());
    for (const c of COUNTRIES) assert.ok(FLOORS[c], `no depth floor for ${c}`);
  });

  for (const c of COUNTRIES) {
    test(`${c}: average depth, deep rows and shallow answers hold their floor`, () => {
      const x = r.countries[c]!;
      const f = FLOORS[c]!;
      assert.ok(x.knowledge.avg >= f.kAvg, `${c} knowledge depth ${x.knowledge.avg.toFixed(2)} < ${f.kAvg}`);
      assert.ok(x.tools.avg >= f.tAvg, `${c} tool depth ${x.tools.avg.toFixed(2)} < ${f.tAvg}`);
      assert.ok(x.knowledge.deep >= f.kDeep, `${c} deep knowledge rows ${x.knowledge.deep} < ${f.kDeep}`);
      assert.ok(x.tools.deep >= f.tDeep, `${c} deep tool rows ${x.tools.deep} < ${f.tDeep}`);
      assert.ok(x.shallowAnswers.main!.shallow <= f.shallowMain, `${c}: ${x.shallowAnswers.main!.shallow} benchmark questions are answered only by shallow rows (${x.shallowAnswers.main!.ids.join(", ")})`);
    });
  }

  test(`no market is more than ${PARITY_GAP} points of average depth behind the best`, () => {
    for (const kind of ["knowledge", "tools"] as const) {
      const best = Math.max(...COUNTRIES.map((c) => r.countries[c]![kind].avg));
      for (const c of COUNTRIES) assert.ok(best - r.countries[c]![kind].avg <= PARITY_GAP, `${c} ${kind} ${r.countries[c]![kind].avg.toFixed(2)} vs best ${best.toFixed(2)}`);
    }
  });

  // Areas a market still has no deep knowledge row in. Only shrinks.
  const AREA_GAPS: Record<string, string[]> = {};
  test("every market has at least one deep knowledge row in every plan area, bar its listed gaps", () => {
    for (const c of COUNTRIES) {
      for (const d of DOMAINS) {
        const deep = r.countries[c]!.knowledge.byDomain[d]!.deep;
        if ((AREA_GAPS[c] ?? []).includes(d)) assert.equal(deep, 0, `${c} ${d} now has a deep row: take it off AREA_GAPS`);
        else assert.ok(deep >= 1, `${c} has no deep knowledge row in ${d}`);
      }
    }
  });

});

// ── 3. The per-row gate ──────────────────────────────────────────────────
//
// Every knowledge row scores at least K_MIN and every tool T_MIN, except the
// rows below, which are the research to-do list. A listed row that has since
// been deepened fails the last test until it is taken off: the list only
// shrinks.
const K_MIN = 6;
const T_MIN = 7;
// Emptied by db/0030: every row that was on it was researched and deepened.
const KNOWN_SHALLOW = new Set<string>([]);

describe("every row clears the depth gate", async () => {
  const { knowledge, tools } = loadInputs(AS_OF);
  const r: DepthReport = await kbDepth(loadInputs(AS_OF));

  test(`every knowledge row scores ${K_MIN}+ and every tool ${T_MIN}+, or is on the research list`, () => {
    const low = [
      ...r.rows.knowledge.filter((x) => x.score < K_MIN && !KNOWN_SHALLOW.has(x.id)),
      ...r.rows.tools.filter((x) => x.score < T_MIN && !KNOWN_SHALLOW.has(x.id)),
    ];
    assert.deepEqual(low.map((x) => `${x.id} ${x.score}: missing ${Object.entries(x.parts).filter(([, v]) => !v).map(([k]) => k).join(", ")}`), []);
  });

  test("the research list holds only rows that are still shallow, and that exist", () => {
    const score = new Map<string, { s: number; min: number }>([...r.rows.knowledge.map((x) => [x.id, { s: x.score, min: K_MIN }] as const), ...r.rows.tools.map((x) => [x.id, { s: x.score, min: T_MIN }] as const)]);
    for (const id of KNOWN_SHALLOW) {
      const x = score.get(id);
      assert.ok(x, `${id} is on the research list but not in the library`);
      assert.ok(x!.s < x!.min, `${id} now scores ${x!.s}: take it off KNOWN_SHALLOW and let the gate hold it`);
    }
    assert.ok(KNOWN_SHALLOW.size <= 0, "the research list may only shrink");
  });

});
