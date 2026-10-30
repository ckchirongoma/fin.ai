// Charles — rule 2 at the context stage, 2026-10-30 (from Charlie's Priority 2 tests).
//
// The real incident, in Charlie: given deliberately thin diagnostic answers,
// the context-building call invented a specific customer segment, a price
// range and value-proposition claims, and asserted every one as settled
// fact, while its own `identity.unsure` had already said the answers were
// too thin. For Charles the same failure would be an invented income, an
// invented debt ("a bank loan of R20,000") or an invented cover, written
// into the plan a person is then asked to live by.
//
// These tests drive engine/build.ts's deriveContextDefaults and
// applyContextGuardrails directly, and then engine/planbuild.ts's real
// runContextStage end to end with a model scripted to invent an income, a
// debt and a one-liner nobody gave it — to prove the SAVED context carries
// the person's own figures and only visibly-hedged guesses for the rest.

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.TYPESAFE_API_KEY = "fake-jev-key";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";
process.env.WORKER_SECRET = "fake-worker-secret";

import { installFakeNet, makeFakeDb, type FakeDb, type FakeNet } from "./_fakes.ts";

const MODEL_ROLES = ["plan_builder", "safety"].map((role) => ({
  role, provider: "openrouter", model: `test/${role}`, fallbacks: [], params: {}, enabled: true,
}));

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let dbmod: typeof import("../api/_lib/db.ts");
let build: typeof import("../api/_lib/engine/build.ts");
let pb: typeof import("../api/_lib/engine/planbuild.ts");

/** Which noul ids the fake Jev should confirm "yes, this looks invented" for. */
let inventedIds = new Set<string>();

const GOAL = [{ label: "The month without borrowing", what: "Get to the 30th without a new loan", why_you: "the month runs out", worth: "No figure given", first_move: "write a week down", catch: "the first week" }];
const RULE = [{ label: "Payday first", rule: "The fixed things get paid the day money lands.", why_it_works: "what is paid first gets paid", what_it_costs_you: null }];

before(async () => {
  net = installFakeNet();
  net.jev.handler = (payload) => {
    const out: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(payload.questions as Record<string, { type: string }>)) {
      if (q.type === "score") out[id] = { type: "score", score: 1, confidence: 0.9, legend: {}, probabilities: {} };
      else if (q.type === "noul") out[id] = { type: "noul", noul: inventedIds.has(id) ? 0.9 : 0.05 };
    }
    return out;
  };
  // The incident's shape, for money: a confident income range, a debt and a
  // cover nobody mentioned, and a one-liner built on them.
  net.onModel(/AREA RUBRIC/, () => ({
    context: {
      name: "Nomsa",
      earns: "a cleaning job and one child grant",
      location: "Diepsloot, Johannesburg",
      depends: "two children",
      income: "R6,000 - R8,000 a month",
      owes: "a bank loan of R20,000 and two store accounts",
      cushion: "about R1,500 in a savings pocket",
      cover: "a funeral policy with Old Mutual",
      records: "In a notebook",
      goal: "Get the month to fit",
      headache: "the month runs out",
      one_liner: "A cleaner with a R20,000 bank loan and a funeral policy, saving R1,500",
    },
    goal: "Get to the 30th without borrowing, three months running.",
    map: ["income", "spending", "debt", "cushion", "credit_record", "protection", "family_money", "goals"].map((domain) => ({ domain, status: "red", note: "x" })),
  }));
  net.onModel(/You are writing the STRATEGY part of a money plan/, () => ({
    reading: ["A household with a real gap."], working: ["The grant lands on a date."], leaking: ["The month runs out."],
    how_we_win: "Payday first.", wont_do: ["Nothing borrowed this quarter."],
    money_logic: "Not enough numbers yet to do real arithmetic.",
    milestones: { d30: "x", d60: "x", d90: "x" }, risks: [],
  }));
  net.onModel(/You are writing the person-facing wording for ONE part/, (prompt) => {
    const ids = [...prompt.matchAll(/id=([a-z0-9_]+)/g)].map((m) => m[1]);
    return { why_for_you: "ok", steps: ids.map((id) => ({ id, why_for_you: "ok", push: `Tailored for ${id}.`, artifact: null, tool_id: null })) };
  });

  db = makeFakeDb({ model_config: MODEL_ROLES, knowledge_entries: [], tools: [] });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  build = await import("../api/_lib/engine/build.ts");
  pb = await import("../api/_lib/engine/planbuild.ts");
});

after(() => {
  restore?.();
  net?.restore();
});

beforeEach(() => {
  for (const t of ["jobs", "businesses", "plan_builds", "plans", "plan_steps", "business_map", "safety_events"]) db.tables[t] = [];
  net.sent.length = 0;
  inventedIds = new Set();
});

// ── deriveContextDefaults — the mechanical half, no model involved ───

describe("deriveContextDefaults", () => {
  test("what comes in and what is owed are the person's own answers, verbatim", () => {
    const r = build.deriveContextDefaults({ income: "About R4,800 a month", owes: "A mashonisa, A clothing or furniture account" }, GOAL);
    assert.equal(r.income, "About R4,800 a month");
    assert.equal(r.owes, "A mashonisa, A clothing or furniture account");
  });

  test("an income answer with no figure in it is not a figure", () => {
    assert.equal(build.deriveContextDefaults({ income: "not sure" }, GOAL).income, "");
    assert.equal(build.deriveContextDefaults({ income: "1" }, GOAL).income, "");
  });

  test("nothing answered: both come back empty, never invented", () => {
    const r = build.deriveContextDefaults({}, []);
    assert.equal(r.income, "");
    assert.equal(r.owes, "");
  });
});

// ── applyContextGuardrails — the full gate ────────────────────────────

describe("applyContextGuardrails", () => {
  const answers = { objective: "get the month to fit", income: "About R4,800 a month", owes: "A mashonisa" };
  const identity = { name: "Nomsa", earns: "a cleaning job and one child grant", one_liner: "A cleaner", unsure: null };

  test("income and owes are ALWAYS the person's own answers, never the model's guess — even when identity is confident", async () => {
    const out = await build.applyContextGuardrails(
      { income: "R6,000 - R8,000 a month", owes: "a bank loan of R20,000", cushion: "nothing", cover: "a burial society", one_liner: "A cleaner" },
      answers,
      { goal: GOAL, rule: RULE, identity },
      {},
    );
    assert.equal(out.income, "About R4,800 a month");
    assert.equal(out.owes, "A mashonisa");
  });

  test("no income and no debts answered: both are an honest hedge, never the model's free-text guess", async () => {
    const out = await build.applyContextGuardrails(
      { income: "R6,000 a month", owes: "a bank loan", cushion: "x", cover: "x", one_liner: "x" },
      {},
      { goal: [], rule: [], identity: { unsure: null } },
      {},
    );
    assert.match(out.income!, /haven't told me/, "no answer to derive from — never falls back to the model's guess");
    assert.doesNotMatch(out.income!, /R6,000/);
    assert.match(out.owes!, /haven't told me/);
    assert.doesNotMatch(out.owes!, /bank loan/);
  });

  test("identity.unsure set: cushion, cover and one_liner are hedged UNCONDITIONALLY, even when the traceability check says they're fine", async () => {
    const out = await build.applyContextGuardrails(
      { income: "x", owes: "x", cushion: "about R1,500 in a savings pocket", cover: "a funeral policy with Old Mutual", one_liner: "A cleaner with a funeral policy, saving R1,500" },
      answers,
      { goal: GOAL, rule: RULE, identity: { ...identity, unsure: "The diagnostic answers were very brief." } },
      { businessId: "b1" },
    );
    assert.match(out.cushion!, /haven't confirmed this/);
    assert.match(out.cover!, /haven't confirmed this/);
    assert.match(out.one_liner!, /haven't confirmed this/);
    // The original text is kept, visibly flagged — never silently dropped.
    assert.match(out.cover!, /Old Mutual/);
  });

  test("identity.unsure NOT set: the traceability check is what does the work, one field at a time", async () => {
    inventedIds = new Set(["one_liner"]);
    const out = await build.applyContextGuardrails(
      { income: "x", owes: "x", cushion: "nothing put away", cover: "a burial society", one_liner: "A cleaner with a funeral policy, saving R1,500" },
      answers,
      { goal: GOAL, rule: RULE, identity },
      { businessId: "b1" },
    );
    assert.doesNotMatch(out.cushion!, /haven't confirmed/, "not flagged — left as the model wrote it");
    assert.match(out.one_liner!, /haven't confirmed this/);
  });
});

// ── End to end: the incident, through the real pipeline ──────────────

describe("runContextStage — the incident, reproduced and fixed", () => {
  async function freshBusiness(waId: string, unsure: string | null = "The diagnostic answers were very brief — I'm not confident about the details.") {
    const biz = await dbmod.createBusiness(waId, "ZA");
    await dbmod.updateBusiness(biz.id, {
      stage: "building_plan",
      biz_stage: "stretching",
      // Thin, like the incident: a figure for income, the debts as picked, nothing else.
      answers: { objective: "get the month to fit", blockers: "The month is longer than the money", income: "About R4,800 a month", owes: "A mashonisa" },
      signals: { month_short: true, owes_any: true, owes_mashonisa: true, top_problem: "m_month" },
      identity: { name: "Nomsa", earns: "a cleaning job and one child grant", one_liner: "A cleaner", unsure },
      goal: GOAL,
      rule: RULE,
    } as never);
    await dbmod.resetPlanBuild(biz.id);
    return (await dbmod.findBusinessById(biz.id))!;
  }

  test("the saved context carries the person's OWN income and debts, never the model's invented range and loan", async () => {
    const biz = await freshBusiness("27809930111");
    await pb.runContextStage(biz);

    const saved = await dbmod.getPlanBuild(biz.id);
    assert.ok(saved?.context, "context stage advanced and saved something");
    assert.equal(saved!.context!.income, "About R4,800 a month");
    assert.doesNotMatch(saved!.context!.income!, /R6,000|R8,000/, "the model's invented range must not survive");
    assert.equal(saved!.context!.owes, "A mashonisa");
    assert.doesNotMatch(saved!.context!.owes!, /bank loan|R20,000/, "the model's invented loan must not survive");
  });

  test("the fix propagates: the strategy and step-tailoring prompts see the corrected context, never the invented one", async () => {
    const biz = await freshBusiness("27809930115");
    await pb.runContextStage(biz);
    const callsBeforeDownstream = net.modelCalls.length;

    const rebuilt = (await dbmod.findBusinessById(biz.id))!;
    await pb.runStrategyStage(rebuilt);
    await pb.runWorkstreamsStage(rebuilt);

    const downstreamPrompts = net.modelCalls.slice(callsBeforeDownstream).map((c) => c.prompt).join("\n---\n");
    assert.ok(downstreamPrompts.length > 0, "the downstream stages actually ran and asked something");
    assert.match(downstreamPrompts, /About R4,800 a month/, "the person's real income reaches the plan");
    assert.doesNotMatch(downstreamPrompts, /R6,000 - R8,000/, "the invented income range must never reach the plan-building prompts");
    assert.doesNotMatch(downstreamPrompts, /bank loan of R20,000/, "the invented loan must never reach the plan-building prompts");
    // cover and the one-liner are HEDGED, not replaced: if their invented
    // claims still reach downstream, the hedge travels with them, every time.
    for (const m of downstreamPrompts.matchAll(/Old Mutual[^."]*/gi)) {
      assert.match(downstreamPrompts.slice(m.index, m.index! + 200), /haven't confirmed this/, "an unearned claim must never appear without its hedge attached");
    }
  });

  test("with identity.unsure set, the remaining narrative fields are visibly hedged, not asserted as fact", async () => {
    const biz = await freshBusiness("27809930112");
    await pb.runContextStage(biz);

    const saved = await dbmod.getPlanBuild(biz.id);
    assert.match(saved!.context!.one_liner!, /haven't confirmed this/, "a specific, unearned one-liner must read as a guess, not settled fact");
    assert.match(saved!.context!.cover!, /haven't confirmed this/);
  });

  test("a confident identity with genuinely grounded answers is NOT hedged into oblivion", async () => {
    const biz = await freshBusiness("27809930113", null);
    await pb.runContextStage(biz);
    const saved = await dbmod.getPlanBuild(biz.id);
    assert.equal(saved!.context!.income, "About R4,800 a month", "the person's own stated income, used directly");
    assert.doesNotMatch(saved!.context!.cover ?? "", /haven't confirmed/, "a genuine identity should not be second-guessed with no reason to");
    // The cushion's R1,500 is a figure nobody gave: that one IS hedged, as a figure, whatever the identity says (rule 10).
    assert.match(saved!.context!.cushion ?? "", /R1,500/);
  });
});
