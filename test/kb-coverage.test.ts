// Charles — the knowledge-base yardstick produces the shape the gap analysis
// reads, and pins the levels the South African money library reached so a
// regression fails here.
//
// The floors are the levels measured on the day the library landed
// (2026-10-30). They are floors, not targets: adding rows or questions that
// raise a number is fine; losing a row, a keyword or a plan-step wiring that
// drops one fails. Raise a floor when a later batch lifts it. Never lower one
// to make a change pass: find out what was lost instead.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { COUNTRIES, DOMAINS, STAGES, kbCoverage, loadInputs, renderText } from "../scripts/kb-coverage.ts";
import { COUNTRIES as MARKETS } from "../api/_lib/countries.ts";

const AS_OF = new Date("2026-10-30");

describe("kb-coverage", () => {
  test("the scorer measures exactly the markets the product serves", () => {
    // A market added to api/_lib/countries.ts without coverage floors fails here.
    assert.deepEqual([...COUNTRIES].sort(), Object.keys(MARKETS).sort());
  });

  test("benchmark fixture has at least 60 questions across all 8 areas and 4 stages, with no country or brand in them", () => {
    const { questions } = loadInputs();
    assert.ok(questions.length >= 60);
    for (const d of DOMAINS) assert.ok(questions.some((q) => q.domain === d), `no question for ${d}`);
    for (const s of STAGES) assert.ok(questions.some((q) => q.stage === s), `no question at stage ${s}`);
    for (const q of questions) assert.doesNotMatch(q.question, /south africa|gotyme|tymebank|capitec|fnb|absa|nedbank|standard bank/i, q.question);
  });

  test("held-out fixture: at least 40 questions across all 8 areas and 4 stages, none copied from the main benchmark", () => {
    const { questions, holdout } = loadInputs();
    assert.ok(holdout && holdout.length >= 40);
    for (const d of DOMAINS) assert.ok(holdout.some((q) => q.domain === d), `no held-out question for ${d}`);
    for (const s of STAGES) assert.ok(holdout.some((q) => q.stage === s), `no held-out question at stage ${s}`);
    const main = new Set(questions.map((q) => q.question.toLowerCase().trim()));
    const ids = new Set(questions.map((q) => q.id));
    for (const q of holdout) {
      assert.ok(!main.has(q.question.toLowerCase().trim()), `held-out ${q.id} duplicates a main question`);
      assert.ok(!ids.has(q.id), `held-out id ${q.id} collides with a main id`);
    }
  });

  test("reports every country with counts, plan-step coverage, benchmark and freshness", async () => {
    const r = await kbCoverage(loadInputs(AS_OF));
    assert.equal(r.asOf, "2026-10-30");
    for (const c of COUNTRIES) {
      const x = r.countries[c];
      assert.ok(x, `missing ${c}`);
      for (const d of DOMAINS) {
        assert.equal(typeof x.knowledge.byDomain[d], "number");
        assert.equal(typeof x.tools.byDomain[d], "number");
        assert.equal(typeof x.benchmark.byDomain[d]?.pct, "number");
      }
      for (const s of STAGES) {
        assert.equal(typeof x.knowledge.byStage[s], "number");
        assert.equal(typeof x.tools.byStage[s], "number");
      }
      assert.ok(Array.isArray(x.emptyDomains.knowledge) && Array.isArray(x.emptyDomains.tools));
      assert.ok(x.planSteps.total > 0);
      assert.equal(x.planSteps.covered + x.planSteps.uncovered.length, x.planSteps.total);
      assert.ok(x.planSteps.pct >= 0 && x.planSteps.pct <= 100);
      assert.equal(x.benchmark.total, r.questions);
      assert.equal(x.benchmark.answered + x.benchmark.missed.length, x.benchmark.total);
      assert.equal(x.holdout?.total, r.holdoutQuestions);
      assert.equal(x.holdout!.answered + x.holdout!.missed.length, x.holdout!.total);
      assert.equal(typeof x.freshness.stale, "number");
      assert.equal(x.freshness.staleIds.length, x.freshness.stale);
    }
    assert.match(renderText(r), /plan-step tool cov\./);
  });
});

// ── The levels of 2026-10-30, as floors ──────────────────────────────────

type Floor = {
  knowledge: number;
  tools: number;
  benchmark: number;
  knowledgeByDomain: Record<string, number>;
  toolsByDomain: Record<string, number>;
  benchmarkByDomain: Record<string, number>;
};

// [income, spending, debt, cushion, credit_record, protection, family_money, goals]
const byDomain = (n: number[]): Record<string, number> => Object.fromEntries(DOMAINS.map((d, i) => [d, n[i]!]));

// FLOOR_MARK: measured by `node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/kb-coverage.ts` on the day the library landed.
const FLOORS: Record<string, Floor> = {
  ZA: { knowledge: 56, tools: 30, benchmark: 72, knowledgeByDomain: byDomain([8, 7, 12, 5, 5, 7, 7, 5]), toolsByDomain: byDomain([8, 5, 5, 1, 3, 4, 1, 3]), benchmarkByDomain: byDomain([11, 9, 12, 6, 7, 9, 9, 9]) },
};

// Held-out benchmark: answered, overall and per area. Never add a keyword to
// lift these questions; new content written for real questions may raise it,
// then raise the floor.
const HOLDOUT_FLOORS: Record<string, { total: number; byDomain: Record<string, number> }> = {
  ZA: { total: 31, byDomain: byDomain([5, 4, 5, 3, 4, 4, 4, 2]) },
};

describe("kb-coverage floors (the levels of 2026-10-30)", async () => {
  const r = await kbCoverage(loadInputs(AS_OF));

  for (const c of COUNTRIES) {
    const x = r.countries[c]!;
    const f = FLOORS[c]!;

    test(`${c}: row counts per area stay at or above the floor, and no area is empty`, () => {
      assert.ok(x.knowledge.total >= f.knowledge, `${c} knowledge ${x.knowledge.total} < ${f.knowledge}`);
      assert.ok(x.tools.total >= f.tools, `${c} tools ${x.tools.total} < ${f.tools}`);
      for (const d of DOMAINS) {
        assert.ok(x.knowledge.byDomain[d]! >= f.knowledgeByDomain[d]!, `${c} ${d} knowledge ${x.knowledge.byDomain[d]} < ${f.knowledgeByDomain[d]}`);
        assert.ok(x.tools.byDomain[d]! >= f.toolsByDomain[d]!, `${c} ${d} tools ${x.tools.byDomain[d]} < ${f.toolsByDomain[d]}`);
      }
      assert.deepEqual(x.emptyDomains, { knowledge: [], tools: [] }, `${c} has an empty money area`);
    });

    test(`${c}: every plan step that names tools offers at least one local tool`, () => {
      assert.equal(x.planSteps.covered, x.planSteps.total, `${c} uncovered: ${x.planSteps.uncovered.map((u) => `${u.module}/${u.step}`).join(", ")}`);
    });

    test(`${c}: benchmark answered stays at or above the floor, overall and per area`, () => {
      assert.ok(x.benchmark.answered >= f.benchmark, `${c} benchmark ${x.benchmark.answered}/${x.benchmark.total} < ${f.benchmark}; now missed: ${x.benchmark.missed.map((m) => m.id).join(", ")}`);
      for (const d of DOMAINS) {
        assert.ok(x.benchmark.byDomain[d]!.answered >= f.benchmarkByDomain[d]!, `${c} ${d} benchmark ${x.benchmark.byDomain[d]!.answered} < ${f.benchmarkByDomain[d]}`);
      }
    });

    test(`${c}: held-out benchmark stays at or above the floor, overall and per area`, () => {
      const h = x.holdout!;
      const f2 = HOLDOUT_FLOORS[c]!;
      assert.ok(h.answered >= f2.total, `${c} held-out ${h.answered}/${h.total} < ${f2.total}; missed: ${h.missed.map((m) => m.id).join(", ")}`);
      for (const d of DOMAINS) assert.ok(h.byDomain[d]!.answered >= f2.byDomain[d]!, `${c} ${d} held-out ${h.byDomain[d]!.answered} < ${f2.byDomain[d]}`);
    });

    test(`${c}: no row is past 90 days on 2026-10-30`, () => {
      assert.deepEqual(x.freshness.staleIds, [], c);
    });
  }
});
