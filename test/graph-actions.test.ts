// Charles — the knowledge graph triggers actions, once each, at the right moment.

import { test, before, after, beforeEach } from "node:test";
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

const OWNER = "27809930071";
const knowledge = JSON.parse(readFileSync(new URL("../seed/knowledge.json", import.meta.url), "utf8"));
const tools = JSON.parse(readFileSync(new URL("../seed/tools.json", import.meta.url), "utf8"));

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let graph: typeof import("../api/_lib/graph.ts");
let acts: typeof import("../api/_lib/graphactions.ts");
let engine: typeof import("../api/_lib/engine/index.ts");
let dbmod: typeof import("../api/_lib/db.ts");

let memoryReply: Record<string, unknown> = {};
const NULL_MEMORY = { context_updates: null, map_updates: null, decisions: null, commitments: null, results: null, owner_notes: null, graph_updates: null };
let statementReply: unknown = { doc: "not_money" };

before(async () => {
  net = installFakeNet();
  const roles = ["router", "wa_reply", "help", "plan_builder", "safety", "voice"].map((role) => ({ role, provider: "openrouter", model: `test/${role}`, fallbacks: [], params: {}, enabled: true }));
  db = makeFakeDb({ model_config: roles, knowledge_entries: knowledge, tools });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  graph = await import("../api/_lib/graph.ts");
  acts = await import("../api/_lib/graphactions.ts");
  engine = await import("../api/_lib/engine/index.ts");
  net.onModel(/You are a strict checker/, (prompt) => Object.fromEntries([...prompt.matchAll(/- "([a-z_]+)":/g)].map((m) => [m[1]!, false])));
  net.onModel(/Classify this message from a person to their money assistant/, () => ({ intent: "question", domain: "debt", tool_need: null, missing_fact: null, risk: [], search_terms: "debt" }));
  net.onModel(/ROUTER RESULT/, () => ({ message: "Well done. Keep paying on the day the money lands.", artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: "debt" }));
  net.onModel(/Read this money document/, () => statementReply);
  net.onModel(/You maintain one person's money memory/, () => memoryReply);
});

after(() => {
  restore?.();
  net?.restore();
});

beforeEach(() => {
  net.sent.length = 0;
  memoryReply = { ...NULL_MEMORY };
});

const business = () => db.tables.businesses!.find((b) => b.wa_id === OWNER)!;
const edge = (over: Partial<import("../api/_lib/graph.ts").Edge>): import("../api/_lib/graph.ts").Edge => ({
  rel: "owes", label: "Edgars", key: "edgars", kind: "creditor", amount: null, per: null, balance: null, day: null, note: null,
  closed: false, source: "said", sources: ["said"], history: [], on: "2026-11-02", ...over,
});
const CREDIT = /\b(?:loan|consolidat|borrow more|credit card|overdraft|cash advance|buy now)\b/i;

// ── Each trigger, pure ───────────────────────────────────────────

test("a debt paid off frees its payment, to savings, with the graph's own figure", () => {
  const [a] = acts.actionsFor({ name: "Nomsa", edges: [edge({ closed: true, amount: 250, per: "month" })] });
  assert.equal(a!.trigger, "debt_paid_off");
  assert.match(a!.text, /^Edgars is paid off\. That's R250 a month back in your hands\./);
  assert.match(a!.text, /savings pocket on the day money lands/);
  assert.match(a!.text, /Nothing new gets borrowed/);
  assert.deepEqual(a!.buttons.map((b) => b.id), ["a.q.k:How do I set up a savings pocket?", "a.kg.card:goal"]);
  for (const b of a!.buttons) assert.ok(b.title.length <= 20, b.title);
});

test("a repayment that went up, money to family up by a fifth, a new mashonisa, a new stokvel, a new saving habit", () => {
  const g = { name: "Nomsa", edges: [
    edge({ label: "the mashonisa", key: "mashonisa", amount: 400, per: "week", history: [{ amount: 300, per: "week", on: "2026-10-20", source: "said" }] }),
    edge({ rel: "supports", label: "my mom", key: "parents", kind: "dependant", amount: 700, per: "month", history: [{ amount: 500, per: "month", on: "2026-10-01", source: "said" }] }),
    edge({ rel: "member_of", label: "a stokvel at work", key: "stokvel at work", kind: "group", amount: 300, per: "month" }),
    edge({ rel: "saves_in", label: "a GoalSave pocket", key: "goalsave pocket", kind: "savings", amount: 150, per: "week" }),
  ] };
  const by = Object.fromEntries(acts.actionsFor(g).map((a) => [a.trigger, a]));
  assert.match(by.repayment_up!.text, /^Mashonisa went from R300 to R400 a week\./);
  assert.equal(by.repayment_up!.subject, "mashonisa@400");
  assert.match(by.new_mashonisa!.text, /^You told me about the mashonisa at R400 a week\./);
  assert.match(by.support_up!.text, /^What goes to my mom went from R500 to R700 a month\./);
  assert.match(by.joined_stokvel!.text, /^You told me about a stokvel at work, R300 a month\./);
  assert.match(by.started_saving!.text, /^R150 a week into a GoalSave pocket\. Kept up, that is R1,950 by the end of the 90 days\./);
  for (const a of Object.values(by)) assert.doesNotMatch(a!.text, CREDIT, `${a!.trigger} never points at credit`);
  for (const a of Object.values(by)) for (const b of a!.buttons) assert.ok(b.title.length <= 20 && b.id.length <= 200);
});

test("what the graph cannot vouch for is not acted on: a setup-answer mashonisa, a 10% rise, a statement-only stokvel", () => {
  const g = { name: "Nomsa", edges: [
    edge({ label: "The mashonisa", key: "mashonisa", sources: ["answer"], source: "answer" }),
    edge({ rel: "supports", label: "my mom", key: "parents", kind: "dependant", amount: 550, per: "month", history: [{ amount: 500, per: "month", on: "2026-10-01", source: "said" }] }),
    edge({ rel: "member_of", label: "Stokvel contribution", key: "stokvel", kind: "group", amount: 300, sources: ["statement"], source: "statement" }),
    edge({ closed: true, sources: ["statement"], source: "statement" }),
  ] };
  assert.deepEqual(acts.actionsFor(g), []);
});

test("two funeral policies are named with how Charles knows, and nothing is cancelled for them", () => {
  const g = { name: "Nomsa", edges: [
    edge({ rel: "covered_by", label: "Old Mutual funeral cover", key: "old mutual funeral cover", kind: "cover", sources: ["statement"], source: "statement" }),
    edge({ rel: "covered_by", label: "Avbob funeral policy", key: "avbob funeral policy", kind: "cover", sources: ["statement"], source: "statement" }),
  ] };
  const [a] = acts.actionsFor(g);
  assert.equal(a!.trigger, "double_cover");
  assert.match(a!.text, /^Your statement shows two funeral policies: Old Mutual funeral cover and Avbob funeral policy\./);
  assert.match(a!.text, /before you cancel anything/);
});

// ── "Stopped paying" is not "paid off" ───────────────────────────

test("'I stopped paying Edgars' keeps the debt open and says so; only payoff words close a debt", () => {
  const today = "2026-11-02";
  const stopped = graph.graphUpdates([{ relation: "owes", object: "Edgars", closed: true }], "I stopped paying Edgars two months ago.", today).kept[0]!;
  assert.equal(stopped.closed, false);
  assert.equal(stopped.note, "they said they stopped paying");
  assert.equal(graph.graphUpdates([{ relation: "owes", object: "Edgars", closed: true }], "I can't pay Edgars anymore.", today).kept[0]!.closed, false);
  assert.equal(graph.graphUpdates([{ relation: "owes", object: "Edgars", closed: true }], "Edgars is settled.", today).kept[0]!.closed, true);
  assert.equal(graph.graphUpdates([{ relation: "member_of", object: "the stokvel", closed: true }], "I stopped paying into the stokvel.", today).kept[0]!.closed, true, "a stokvel can be stopped");
  assert.equal(acts.actionsFor({ name: null, edges: graph.merge([stopped], []) }).filter((a) => a.trigger === "debt_paid_off").length, 0);
});

// ── Once, spaced, and never in the wrong moment ──────────────────

test("once per news, six hours apart, never before the plan or in hardship, and silent if the ledger is down", async () => {
  const biz = await dbmod.createBusiness(OWNER, "ZA");
  const g = { name: "Nomsa", edges: [edge({ closed: true, amount: 250, per: "month" }), edge({ rel: "saves_in", label: "a pocket", key: "pocket", kind: "savings", amount: 100, per: "week" })] };
  assert.equal(await acts.nextGraphAction({ id: biz.id, stage: "diag" }, g), null);
  assert.equal(await acts.nextGraphAction({ id: biz.id, stage: "stabilizing" }, g), null);
  const first = await acts.nextGraphAction({ id: biz.id, stage: "plan_ready" }, g);
  assert.equal(first!.trigger, "debt_paid_off");
  assert.equal(await acts.nextGraphAction({ id: biz.id, stage: "plan_ready" }, g), null, "six hours before the next");
  for (const r of db.tables.kg_triggers!) r.fired_at = new Date(Date.now() - 7 * 36e5).toISOString();
  const second = await acts.nextGraphAction({ id: biz.id, stage: "step_pushed" }, g);
  assert.equal(second!.trigger, "started_saving", "the paid-off news is never sent twice");
  for (const r of db.tables.kg_triggers!) r.fired_at = new Date(Date.now() - 7 * 36e5).toISOString();
  assert.equal(await acts.nextGraphAction({ id: biz.id, stage: "plan_ready" }, g), null, "nothing new to say");
});

// ── In a conversation ────────────────────────────────────────────

test("'I paid off Edgars, it was R250 a month' gets the reply, then the action, then the card on a tap; never twice", async () => {
  db.tables.kg_triggers!.length = 0;
  await dbmod.updateBusiness(business().id, {
    stage: "plan_ready", consent_at: new Date().toISOString(),
    answers: { owes: "A clothing or furniture account" },
    identity: { name: "Nomsa", earns: "x", one_liner: "x", unsure: null }, context: { name: "Nomsa" },
    goal: [{ label: "R1,000 by Christmas", what: "R1,000 by December", why_you: "", worth: "R1,000", first_move: "", catch: "" }],
  } as never);
  memoryReply = { ...NULL_MEMORY, graph_updates: [{ relation: "owes", object: "Edgars", amount: 250, per: "month", closed: true }] };
  await engine.handleInbound(textFrom(OWNER, "I paid off Edgars! It was R250 a month."));
  const bodies = net.sent.map((m) => m.body);
  const reply = bodies.findIndex((b) => /Well done/.test(b));
  const action = bodies.findIndex((b) => /Edgars is paid off\. That's R250 a month back in your hands/.test(b));
  assert.ok(reply >= 0 && action > reply, "the reply first, then the action");
  assert.deepEqual(net.sent[action]!.buttons.map((b) => b.title), ["Set up a pocket", "See my goal"]);

  net.sent.length = 0;
  await engine.handleInbound(tapFrom(OWNER, "a.kg.card:goal", "See my goal"));
  assert.ok(net.sent.some((m) => /Getting to the number/.test(m.body)), "the goal card");

  net.sent.length = 0;
  for (const r of db.tables.kg_triggers!) r.fired_at = new Date(Date.now() - 7 * 36e5).toISOString();
  memoryReply = { ...NULL_MEMORY, graph_updates: [{ relation: "owes", object: "Edgars", closed: true }] };
  await engine.handleInbound(textFrom(OWNER, "Yes, Edgars is paid off, I'm so happy."));
  assert.ok(!net.sent.some((m) => /is paid off\. That's/.test(m.body)), "the same news is not acted on twice");
});

test("a statement showing two funeral policies, read after the plan, triggers the double-cover check", async () => {
  for (const r of db.tables.kg_triggers!) r.fired_at = new Date(Date.now() - 7 * 36e5).toISOString();
  statementReply = {
    doc: "bank_statement", source: "Capitec", period: "Oct 2026",
    money_in: [{ label: "Wages", amount: 5200, day: 25 }],
    money_out: [{ label: "Old Mutual funeral cover", amount: 120, kind: "insurance" }, { label: "Avbob funeral policy", amount: 95, kind: "insurance" }],
    totals: { in: 5200, out: 215 },
  };
  net.media.mime = "application/pdf";
  net.media.bytes = new Uint8Array([37, 80, 68, 70]);
  await engine.handleInbound({ waMessageId: `wamid.${Math.random()}`, from: OWNER, timestamp: Date.now(), kind: "document" as const, text: "", mediaId: "m1", mimeType: "application/pdf" });
  const a = net.sent.find((m) => /two funeral policies/.test(m.body));
  assert.ok(a, "the double-cover action went out");
  assert.match(a!.body, /^Your statement shows two funeral policies: (?:Old Mutual funeral cover and Avbob funeral policy|Avbob funeral policy and Old Mutual funeral cover)\./);
});

test("in hardship mode the graph learns but acts on nothing", async () => {
  for (const r of db.tables.kg_triggers!) r.fired_at = new Date(Date.now() - 7 * 36e5).toISOString();
  await dbmod.updateBusiness(business().id, { stage: "stabilizing" } as never);
  memoryReply = { ...NULL_MEMORY, graph_updates: [{ relation: "saves_in", object: "a stokvel savings pocket", amount: 50, per: "week" }] };
  await engine.handleInbound(textFrom(OWNER, "I put R50 a week into a stokvel savings pocket."));
  assert.ok(!net.sent.some((m) => /Kept up, that is/.test(m.body)));
  await dbmod.updateBusiness(business().id, { stage: "plan_ready" } as never);
});

// ── Growth ───────────────────────────────────────────────────────

test("a graph that grows for years stays under its cap, and history goes before anything still true", async () => {
  const id = business().id;
  const today = "2026-11-02";
  for (let batch = 0; batch < 15; batch++) {
    const facts = Array.from({ length: 20 }, (_, i) => {
      const n = batch * 20 + i;
      return { rel: "pays" as const, label: `Bill number ${n} zz${n}`, amount: 10 + n, per: "month" as const, closed: n < 60, source: "said" as const, on: today };
    });
    await graph.recordFacts(id, facts);
  }
  const edges = db.tables.kg_edges!.filter((e) => e.business_id === id);
  assert.ok(edges.length <= graph.MAX_EDGES, `${edges.length} edges`);
  assert.ok(edges.filter((e) => e.status === "closed").length < 60, "closed history went first");
  assert.ok(db.tables.kg_nodes!.filter((n) => n.business_id === id).length <= graph.MAX_EDGES + 20, "orphaned nodes go with their edges");
  const g = await graph.householdGraph(business() as never);
  assert.ok(graph.graphSheet(g).length <= 1800);
});

test("'forget my money' takes the action ledger too", async () => {
  assert.ok(db.tables.kg_triggers!.length > 0);
  await engine.handleInbound(textFrom(OWNER, "forget my money"));
  await engine.handleInbound(textFrom(OWNER, "YES"));
  assert.equal(db.tables.kg_triggers!.length, 0);
});
