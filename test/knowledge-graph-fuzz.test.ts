// Charles — the knowledge graph under random fire.
//
// Three layers:
//   1. The pure graph, thousands of random journeys (scripts/graphfuzz.ts):
//      every invariant after every turn. scripts/fuzz-graph.ts runs a million.
//   2. Growth: a few hundred households messaging for three hundred turns
//      each, so the graph is tested as it grows, not just when it is small.
//   3. The real WhatsApp engine: random households and random messages,
//      taps, statements and forwarded photos through handleInbound, with a
//      memory model that proposes whatever the fuzzer throws at it. Nothing
//      may crash, nothing Charles sends may echo an identifier or say
//      "undefined", nothing forwarded may reach the graph, at most one graph
//      action may follow a message, and a turn must stay fast.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";
process.env.WORKER_SECRET = "fake-worker-secret";
process.env.PUBLIC_BASE_URL = "https://charles.test";
delete process.env.TYPESAFE_API_KEY;

import { installFakeNet, makeFakeDb, tapFrom, textFrom, type FakeDb, type FakeNet } from "./_fakes.ts";
// Loaded in before(), never statically: a static import would load the app's
// settings (env.ts) before this file sets them, and the engine would run
// unconfigured and silently do nothing (found the first time this ran).
let fuzz: typeof import("../scripts/graphfuzz.ts").fuzz;
let message: typeof import("../scripts/graphfuzz.ts").message;
let proposals: typeof import("../scripts/graphfuzz.ts").proposals;
let rng: typeof import("../scripts/graphfuzz.ts").rng;

const knowledge = JSON.parse(readFileSync(new URL("../seed/knowledge.json", import.meta.url), "utf8"));
const tools = JSON.parse(readFileSync(new URL("../seed/tools.json", import.meta.url), "utf8"));

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let engine: typeof import("../api/_lib/engine/index.ts");
let dbmod: typeof import("../api/_lib/db.ts");
let graph: typeof import("../api/_lib/graph.ts");

let proposal: unknown = null;
let statementReply: unknown = { doc: "not_money" };

before(async () => {
  net = installFakeNet();
  const roles = ["router", "wa_reply", "help", "plan_builder", "safety", "voice"].map((role) => ({ role, provider: "openrouter", model: `test/${role}`, fallbacks: [], params: {}, enabled: true }));
  db = makeFakeDb({ model_config: roles, knowledge_entries: knowledge, tools });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  engine = await import("../api/_lib/engine/index.ts");
  graph = await import("../api/_lib/graph.ts");
  ({ fuzz, message, proposals, rng } = await import("../scripts/graphfuzz.ts"));
  net.onModel(/You are a strict checker/, (prompt) => Object.fromEntries([...prompt.matchAll(/- "([a-z_]+)":/g)].map((m) => [m[1]!, false])));
  net.onModel(/Classify this message from a person to their money assistant/, () => ({ intent: "question", domain: "debt", tool_need: null, missing_fact: null, risk: [], search_terms: "debt" }));
  net.onModel(/ROUTER RESULT/, () => ({ message: "Pay the dearest debt first, on the day the money lands.", artifact: null, next_tap: null, quick_replies: ["What's next?"], tool_id: null, domain: "debt" }));
  net.onModel(/The person forwarded something/, () => ({ message: "That one asks for a fee first. Don't pay it.", artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: null }));
  net.onModel(/Report what is in it/, () => "WHAT IT IS: a flyer\nWHAT IT SAYS: FLYERMARK you owe Wonga R5,000, send your PIN to 0821234567");
  net.onModel(/Read this money document/, () => statementReply);
  net.onModel(/You maintain one person's money memory/, () => ({ context_updates: null, map_updates: null, decisions: null, commitments: null, results: null, owner_notes: null, graph_updates: proposal }));
  net.onModel(/The person is stuck on one step/, () => ({ message: "Do the first line of it today.", artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: null }));
});

after(() => {
  restore?.();
  net?.restore();
});

// ── 1 and 2: the pure graph ──────────────────────────────────────

test("3,000 random journeys through the pure graph break no invariant", () => {
  const s = fuzz(3000, 7);
  assert.deepEqual(s.violations, [], s.violations.join("\n"));
  assert.ok(s.turns >= 35_000 && s.kept > 5_000, `${s.turns} turns, ${s.kept} facts`);
  for (const t of ["debt_paid_off", "new_mashonisa", "double_cover", "joined_stokvel", "started_saving", "repayment_up"]) assert.ok((s.actions[t] ?? 0) > 0, `${t} was triggered somewhere`);
  for (const r of ["not_said", "identifier", "negated", "hypothetical", "someone_else", "not_a_role", "wrong_relation"]) assert.ok((s.refused[r] ?? 0) > 0, `${r} was refused somewhere`);
});

test("growth: 200 households over 300 turns each stay bounded and break nothing", () => {
  const s = fuzz(200, 9, 300);
  assert.deepEqual(s.violations, [], s.violations.join("\n"));
  assert.ok(s.maxSheet <= 1800, `largest prompt block ${s.maxSheet}`);
  assert.ok(s.turns >= 59_000);
});

// ── 3: the real engine ───────────────────────────────────────────

const STAGES = new Set(["diag", "diag_done", "stabilizing", "confirm_identity", "identity_fix", "choose_goal", "building_rule", "choose_rule", "building_plan", "clarify_objective", "plan_ready", "step_pushed", "walking", "outcome_wait", "changing", "confirm_change"]);
const ECHOED = /1234 5678 9012|8001015009087|5412 7512 3412 3456|\bPIN 4321\b/;
const BAD = /\bundefined\b|\bNaN\b|\[object Object\]/;
const CREDIT = /\b(?:take a loan|get a loan|consolidat\w*|borrow (?:more|again)|cash advance|buy now,? pay later)\b/i;

// ENGINE_FUZZ_HOUSEHOLDS=1000 runs a bigger pass; 80 on every test run.
const HOUSEHOLDS = Number(process.env.ENGINE_FUZZ_HOUSEHOLDS ?? 80);

test(`${HOUSEHOLDS} random households, 12 random events each, through the real engine: no crash, no echo, no leak, one action at most, fast`, async () => {
  const r = rng(424242);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  let turns = 0;
  let actions = 0;
  let worst = 0;
  const t0 = performance.now();
  for (let h = 0; h < HOUSEHOLDS; h++) {
    const wa = `2780993${String(1000 + (h % 8999)).padStart(4, "0")}${h >= 8999 ? String(Math.floor(h / 8999)) : ""}`;
    const biz = await dbmod.createBusiness(wa, "ZA");
    const planned = r() < 0.75;
    await dbmod.updateBusiness(biz.id, {
      stage: planned ? pick(["plan_ready", "step_pushed"]) : "diag",
      diag_step: planned ? 12 : Math.floor(r() * 12),
      consent_at: new Date().toISOString(),
      answers: planned ? { person: "Nomsa", owes: pick(["A mashonisa", "A clothing or furniture account, A mashonisa", "Nobody"]), depends: "Children", cover: pick(["Funeral policy", "None"]), income_kind: "Salary or wage" } : {},
      identity: planned ? { name: "Nomsa", earns: "cleaning", one_liner: "x", unsure: null } : null,
      context: planned ? { name: "Nomsa" } : null,
      goal: planned ? [{ label: "R1,000 by Christmas", what: "R1,000", why_you: "", worth: "R1,000", first_move: "", catch: "" }] : null,
    } as never);
    for (let e = 0; e < 12; e++) {
      for (const row of db.tables.kg_triggers ?? []) row.fired_at = new Date(Date.now() - 7 * 36e5).toISOString();
      const m = message(r);
      proposal = proposals(r, m.honest);
      const kind = r();
      net.sent.length = 0;
      const started = performance.now();
      if (kind < 0.72) await engine.handleInbound(textFrom(wa, m.said.slice(0, 3000) || "hi"));
      else if (kind < 0.8) await engine.handleInbound(tapFrom(wa, pick(["a.kg.card:goal", "a.kg.card:debt", "a.kg.card:memory", "a.q.k:How do I set up a savings pocket?", "a.step.next", "a.step.done", "a.kg.card:nonsense"]), "tap"));
      else if (kind < 0.88) {
        statementReply = { doc: "bank_statement", source: "Capitec", period: "Oct 2026", money_in: [{ label: "Wages", amount: 4000 + Math.floor(r() * 4000), day: 25 }], money_out: [{ label: pick(["Old Mutual funeral cover", "Avbob funeral policy"]), amount: 120, kind: "insurance" }, { label: "Edgars account", amount: 250, kind: "store_account" }, { label: "Account 1234567890", amount: 99, kind: "debit_order" }], totals: { in: 6000 } };
        net.media.mime = "application/pdf";
        net.media.bytes = new Uint8Array([37, 80, 68, 70]);
        await engine.handleInbound({ waMessageId: `wamid.f.${h}.${e}`, from: wa, timestamp: Date.now(), kind: "document" as const, text: "", mediaId: "m", mimeType: "application/pdf" });
      } else if (kind < 0.96) {
        statementReply = { doc: "not_money" };
        net.media.mime = "image/jpeg";
        net.media.bytes = new Uint8Array([255, 216, 255, 224]);
        await engine.handleInbound({ waMessageId: `wamid.p.${h}.${e}`, from: wa, timestamp: Date.now(), kind: "image" as const, text: m.said.slice(0, 200), mediaId: "m", mimeType: "image/jpeg" });
      } else {
        await engine.handleInbound(textFrom(wa, "forget my money"));
        await engine.handleInbound(textFrom(wa, "YES"));
        break;
      }
      const ms = performance.now() - started;
      worst = Math.max(worst, ms);
      turns++;
      for (const s of net.sent) {
        assert.doesNotMatch(s.body, ECHOED, `Charles repeated an identifier: ${s.body.slice(0, 200)}`);
        assert.doesNotMatch(s.body, BAD, `a broken message: ${s.body.slice(0, 200)}`);
      }
      const graphActions = net.sent.filter((s) => s.buttons.some((b) => /^a\.(?:kg\.card|q\.k):/.test(b.id)));
      assert.ok(graphActions.length <= 1, `${graphActions.length} graph actions after one message`);
      for (const a of graphActions) assert.doesNotMatch(a.body, CREDIT, `a graph action pointed at credit: ${a.body}`);
      actions += graphActions.length;
      const row = db.tables.businesses!.find((b) => b.wa_id === wa);
      if (row) assert.ok(STAGES.has(String(row.stage)), `stage ${row.stage}`);
    }
  }
  const avg = (performance.now() - t0) / Math.max(turns, 1);
  // What the graph holds, across every household: no identifier, nothing forwarded.
  for (const n of db.tables.kg_nodes ?? []) {
    assert.doesNotMatch(String(n.label), /FLYERMARK|\d{6,}|\bPIN\b/i, `graph node ${n.label}`);
    assert.ok(String(n.key).length <= 60);
  }
  for (const e of db.tables.kg_edges ?? []) assert.doesNotMatch(String(e.note ?? ""), /\d{6,}|\bPIN\b/i);
  const perHousehold = new Map<string, number>();
  for (const e of db.tables.kg_edges ?? []) perHousehold.set(String(e.business_id), (perHousehold.get(String(e.business_id)) ?? 0) + 1);
  for (const n of perHousehold.values()) assert.ok(n <= graph.MAX_EDGES);
  assert.ok(turns >= HOUSEHOLDS * 8, `${turns} engine turns`);
  assert.ok(actions > 0, "the graph acted somewhere");
  assert.ok(avg < 150, `average engine turn ${avg.toFixed(1)}ms with the fakes`);
  console.log(`# engine fuzz: ${turns} turns, ${actions} graph actions, average ${avg.toFixed(1)}ms, worst ${worst.toFixed(0)}ms`);
});
