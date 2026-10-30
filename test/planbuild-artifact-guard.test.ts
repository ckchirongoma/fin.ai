// Fin — engine/planbuild.ts's runFinalizeStage, and PRIORITY 5.1's guard.
//
// PR #22 (track1) built engine/artifact.ts's checkArtifact() as the choke
// point for the WhatsApp send path and the per-step PDF, and flagged
// explicitly in its own body that planbuild.ts was never touched: this is
// the exact function that writes `plan_steps.artifact` into the database in
// the first place, straight from whatever the tailoring model call
// produced — unresolved "[...]" placeholders included, the same pattern
// that reached WhatsApp verbatim three times live. This is a separate file
// from test/planbuild.test.ts deliberately: that file's shared model mocks
// script every step's artifact identically across many tests, and this one
// needs its own mock that deliberately injects a placeholder.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
delete process.env.TYPESAFE_API_KEY; // auditModules short-circuits to [] with no Jev key — see judgement.ts

import { installFakeNet, makeFakeDb, type FakeDb, type FakeNet } from "./_fakes.ts";

const MODEL_ROLES = ["plan_builder", "safety"].map((role) => ({
  role, provider: "openrouter", model: `test/${role}`, fallbacks: [], params: {}, enabled: true,
}));

let db: FakeDb;
let net: FakeNet;
let dbmod: typeof import("../api/_lib/db.ts");
let pb: typeof import("../api/_lib/engine/planbuild.ts");
let queue: typeof import("../api/_lib/queue.ts");
let restore: () => void;

function scriptModels(n: FakeNet): void {
  n.onModel(/AREA RUBRIC/, () => ({
    context: { name: "Verify Script Test Business", earns: "a wage", location: "Nowhere", one_liner: "things, in Nowhere" },
    goal: "Take deposits on every booking.",
    map: [
      { domain: "income", status: "red", note: "x" },
      { domain: "spending", status: "red", note: "x" },
      { domain: "debt", status: "amber", note: "x" },
      { domain: "cushion", status: "amber", note: "x" },
      { domain: "credit_record", status: "red", note: "x" },
      { domain: "protection", status: "red", note: "x" },
      { domain: "family_money", status: "red", note: "x" },
      { domain: "goals", status: "red", note: "x" },
    ],
  }));
  n.onModel(/You are scoring one household's money life against a fixed rubric/, () => ({
    income: "red", spending: "red", debt: "amber", cushion: "amber",
    credit_record: "red", protection: "red", family_money: "red", goals: "red",
  }));
  n.onModel(/You are writing the STRATEGY part of a money plan/, () => ({
    reading: ["A test business with a real gap."],
    working: ["Regulars come back"],
    leaking: ["No-shows"],
    how_we_win: "Charge for the certainty they already want.",
    wont_do: ["Nothing paid this quarter"],
    money_logic: "One saved slot a month pays for this, and it costs nothing to start.",
    milestones: { d30: "Asked once", d60: "Deposits standard", d90: "No-shows rare" },
    risks: [],
  }));
  // The tailoring call: exactly the pattern that reached WhatsApp verbatim
  // three times live — a genuine future-customer name and a link that does
  // not exist yet, both left as unresolved brackets.
  n.onModel(/You are writing the person-facing wording for ONE part/, (prompt) => {
    const ids = [...prompt.matchAll(/id=([a-z0-9_]+)/g)].map((m) => m[1]);
    return {
      why_for_you: "This fits your Saturdays.",
      steps: ids.map((id) => ({
        id,
        why_for_you: "Because of what you told me.",
        push: `Do it for ${id}.`,
        artifact: "Hi [Name], thanks for choosing Verify Script Test Business — could you leave us a review? [Link to Google profile]",
        tool_id: null,
      })),
    };
  });
  n.onModel(/You are a strict checker/, (prompt) => {
    const ids = [...prompt.matchAll(/- "([a-z_]+)":/g)].map((m) => m[1]!);
    return Object.fromEntries(ids.map((id) => [id, false]));
  });
}

before(async () => {
  net = installFakeNet();
  scriptModels(net);
  db = makeFakeDb({ model_config: MODEL_ROLES, knowledge_entries: [], tools: [] });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  pb = await import("../api/_lib/engine/planbuild.ts");
  queue = await import("../api/_lib/queue.ts");
});

after(() => {
  restore?.();
  net?.restore();
});

async function freshBusiness(waId: string) {
  const biz = await dbmod.createBusiness(waId, "ZA");
  await dbmod.updateBusiness(biz.id, {
    stage: "building_plan",
    biz_stage: "stretching",
    answers: { objective: "grow", blockers: "cash is tight", income: "R5,000" },
    signals: { owes_any: true, top_problem: "m_owed" },
    identity: { name: "Verify Script Test Business", earns: "a wage", one_liner: "things, in Nowhere", unsure: null },
    goal: [{ label: "Out of debt", what: "Clear the account", why_you: "it costs the most", worth: "No figure given", first_move: "list it", catch: "none" }],
    rule: [{ label: "Payday first", rule: "Payday first.", why_it_works: "What is paid first gets paid.", what_it_costs_you: null }],
  } as never);
  return (await dbmod.findBusinessById(biz.id))!;
}

test("runFinalizeStage stores the message itself, with what only the owner knows still in brackets — never the old apology in its place", async () => {
  const biz = await freshBusiness("27000000101");
  await pb.startPlanBuild(biz);
  await queue.drainQueue({ maxJobs: 10 });

  const finished = await dbmod.findBusinessById(biz.id);
  assert.equal(finished?.stage, "plan_ready");
  const rows = db.tables.plan_steps!.filter((s) => s.plan_id === finished?.current_plan_id);
  assert.ok(rows.length >= 1, "the build actually produced steps to check");

  for (const row of rows) {
    // Every reader runs the row through checkArtifact again (steps.ts,
    // plandoc.ts, stepdoc.ts, connector.ts), so the brackets are what tell
    // each of them which parts are the owner's to fill.
    if (!row.artifact) continue;
    assert.doesNotMatch(String(row.artifact), /write that part yourself/i, "round 18: the apology stored over the message left nothing to send or print");
    assert.doesNotMatch(String(row.artifact), /\[Business Name\]/i, "what Fin knows is filled in");
  }
});
