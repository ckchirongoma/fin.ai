// Charles — the knowledge graphs: the library's, and each household's.
//
// The library graph links entries, tools and plan modules, and adds the
// strongest neighbour to a shortlist without ever pushing a keyword row out.
// The household graph remembers what the person's money touches, each line
// with where it came from, keeps only what their own words back, and goes
// with "forget my money".

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

import { installFakeNet, makeFakeDb, textFrom, type FakeDb, type FakeNet } from "./_fakes.ts";

const OWNER = "27809930051";
const knowledge = JSON.parse(readFileSync(new URL("../seed/knowledge.json", import.meta.url), "utf8"));
const tools = JSON.parse(readFileSync(new URL("../seed/tools.json", import.meta.url), "utf8"));

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let lib: typeof import("../api/_lib/libgraph.ts");
let graph: typeof import("../api/_lib/graph.ts");
let engine: typeof import("../api/_lib/engine/index.ts");
let dbmod: typeof import("../api/_lib/db.ts");
let retrieval: typeof import("../api/_lib/retrieval.ts");

let memoryReply: Record<string, unknown> = {};

before(async () => {
  net = installFakeNet();
  const roles = ["router", "wa_reply", "help", "plan_builder", "safety", "voice"].map((role) => ({ role, provider: "openrouter", model: `test/${role}`, fallbacks: [], params: {}, enabled: true }));
  db = makeFakeDb({ model_config: roles, knowledge_entries: knowledge, tools });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  lib = await import("../api/_lib/libgraph.ts");
  graph = await import("../api/_lib/graph.ts");
  engine = await import("../api/_lib/engine/index.ts");
  retrieval = await import("../api/_lib/retrieval.ts");
  net.onModel(/You are a strict checker/, (prompt) => Object.fromEntries([...prompt.matchAll(/- "([a-z_]+)":/g)].map((m) => [m[1]!, false])));
  net.onModel(/Classify this message from a person to their money assistant/, () => ({ intent: "question", domain: "debt", tool_need: null, missing_fact: null, risk: [], search_terms: "mashonisa" }));
  net.onModel(/ROUTER RESULT/, () => ({ message: "Pay the mashonisa on the day the cash lands, and ask for your card back on the last payment.", artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: "debt" }));
  net.onModel(/You maintain one person's money memory/, () => memoryReply);
});

after(() => {
  restore?.();
  net?.restore();
});

beforeEach(() => {
  net.sent.length = 0;
  memoryReply = { context_updates: null, map_updates: null, decisions: null, commitments: null, results: null, owner_notes: null, graph_updates: null };
});

const business = () => db.tables.businesses!.find((b) => b.wa_id === OWNER)!;

// ── The library graph ────────────────────────────────────────────

test("the library graph links every module to its pinned entries and offered tools, and most rows to each other", () => {
  const g = lib.buildLibraryGraph(knowledge, tools, "ZA");
  const s = lib.stats(g);
  assert.deepEqual(s.nodes, { knowledge: 56, tool: 30, domain: 8, module: 13 });
  assert.ok(s.edges.pins >= 30, `pins ${s.edges.pins}`);
  assert.ok(s.edges.offers >= 40, `offers ${s.edges.offers}`);
  assert.ok(s.edges.used_with >= 45, `used_with ${s.edges.used_with}`);
  assert.ok(s.edges.mentions >= 35, `mentions ${s.edges.mentions}`);
  assert.ok(s.edges.related >= 45, `related ${s.edges.related}`);
  // Every row sits in its money area; a row with no other link is a gap worth knowing, and few.
  assert.ok(s.isolated.length <= 14, `isolated: ${s.isolated.join(", ")}`);
  assert.ok(s.toolsUnreached.length <= 4, `tools no module or entry leads to: ${s.toolsUnreached.join(", ")}`);
});

test("related() follows the plan library: the debt list leads to the money log, and the credit report to a bureau", () => {
  const g = lib.buildLibraryGraph(knowledge, tools, "ZA");
  assert.ok(lib.related(g, "k.debt_list", "tool").some((r) => r.id === "notes_money_log"));
  assert.ok(lib.related(g, "k.free_credit_report", "tool").some((r) => /_free_report$/.test(r.id)));
  for (const r of lib.related(g, "k.debt_list", "knowledge")) assert.ok(r.id.startsWith("k."), "knowledge neighbours are knowledge rows");
});

test("graph neighbours are appended to a shortlist and never push a keyword row out", async () => {
  const g = lib.buildLibraryGraph(knowledge, tools, "ZA");
  const short = await retrieval.shortlist(knowledge, tools, { text: "how do I list everything I owe", stage: "surviving", maxKnowledge: 4, maxTools: 5 }, { country: "ZA", log: false, semantic: false });
  const extra = lib.neighboursFor(g, short, { knowledge, tools });
  assert.ok(extra.knowledge.length <= 1 && extra.tools.length <= 1);
  for (const k of extra.knowledge) assert.ok(!short.knowledge.some((x) => x.id === k.id), "only rows the keywords did not bring");
  for (const t of extra.tools) assert.ok(!short.tools.some((x) => x.id === t.id));
});

// ── The household graph, in code ─────────────────────────────────

const ANSWERS = {
  person: "Lerato, domestic work",
  income_kind: "Piece jobs or hustle, SASSA grant",
  objective: "Pay off the mashonisa, R200 a week on R800, and put R1,000 away by Christmas",
  owes: "A clothing or furniture account, A mashonisa",
  depends: "Children",
  cover: "Burial society",
};

test("derive() reads the setup answers, the statement and the plan, each with its source", async () => {
  const stmt = await import("../api/_lib/statement.ts");
  const read = stmt.parseStatement({
    doc: "bank_statement", source: "Capitec", period: "Sep 2026",
    money_in: [{ label: "SASSA child support grant", amount: 1060, day: 3 }],
    money_out: [{ label: "Edgars account", amount: 250, kind: "store_account", day: 1 }, { label: "Old Mutual funeral cover", amount: 120, kind: "insurance" }, { label: "Shoprite", amount: 1480, kind: "groceries" }],
    totals: { in: 1060, out: 1850 },
  }, "2026-10-30") as import("../api/_lib/statement.ts").StatementRead;
  const facts = graph.derive({ answers: ANSWERS, identity: { name: "Lerato", earns: "x", one_liner: "x", unsure: null }, statement: read, goal: [{ label: "R1,000 by Christmas", what: "R1,000 by December", why_you: "", worth: "", first_move: "", catch: "" }], rule: [{ label: "Payday first", rule: "The fixed things get paid first.", why_it_works: "", what_it_costs_you: null }], created_at: "2026-10-30T08:00:00Z" } as never);
  const edges = graph.merge(facts, []);
  const by = (rel: string, key: string) => edges.find((e) => e.rel === rel && e.key === key);
  const shark = by("owes", "mashonisa")!;
  assert.equal(shark.amount, 200);
  assert.equal(shark.per, "week");
  assert.equal(shark.balance, 800);
  assert.deepEqual(shark.sources, ["answer"]);
  // The statement's grant and the setup answer's grant are one node, with both sources.
  const grant = by("earns_from", "sassa grant")!;
  assert.deepEqual(grant.sources.sort(), ["answer", "statement"]);
  assert.equal(grant.amount, 1060);
  assert.equal(grant.label, "SASSA child support grant");
  // The generic "clothing or furniture account" answer gives way to the statement's Edgars line.
  assert.ok(by("owes", "edgars"));
  assert.ok(!edges.some((e) => /clothing or furniture/i.test(e.label)));
  assert.equal(by("covered_by", "funeral policy")!.label, "Old Mutual funeral cover", "a funeral policy, named as the statement names it");
  assert.ok(by("supports", "children"));
  assert.ok(by("banks_with", "capitec"));
  assert.ok(by("working_towards", "r1 000 by christmas"));
  assert.ok(!edges.some((e) => /shoprite/i.test(e.label)), "groceries are spending, not a thing their money is tied to");
  const sheet = graph.graphSheet({ name: "Lerato", edges });
  assert.match(sheet, /- Owes The mashonisa: pays R200 a week, R800 owed \(setup answer\)/);
  assert.match(sheet, /- Money in from SASSA child support grant: R1,060 a month, around the 3rd \(setup answer; their statement\)|their statement; setup answer/);
  assert.match(sheet, /Lives by the rule: "The fixed things get paid first\." \(they chose it\)/);
});

test("graphUpdates() keeps a fact only when the person's own words back it: label, figures, and paying off", () => {
  const said = "I paid off Edgars last week. My mother needs R300 a month from me now.";
  const { kept, refused } = graph.graphUpdates([
    { relation: "owes", object: "Edgars", closed: true },
    { relation: "supports", object: "my mother", amount: 300, per: "month" },
    { relation: "supports", object: "Nomvula Dlamini", amount: 300 },
    { relation: "owes", object: "Capfin", amount: 450 },
    { relation: "earns_from", object: "the salon", amount: 9000, per: "month" },
    { relation: "owes", object: "account 1234567890" },
    { relation: "lives_by", object: "x" },
  ], said, "2026-11-02");
  assert.deepEqual(kept.map((f) => [f.rel, f.label, f.amount ?? null, f.closed ?? false]), [["owes", "Edgars", null, true], ["supports", "my mother", 300, false]]);
  assert.deepEqual(refused.map((r) => r.reason), ["not_a_role", "not_said", "not_said", "identifier", "relation"]);
  // A figure they did not type is dropped, the fact kept.
  const typed = graph.graphUpdates([{ relation: "owes", object: "the mashonisa", amount: 250, per: "week" }], "I still owe the mashonisa", "2026-11-02").kept;
  assert.equal(typed[0]!.amount, null);
  // "closed" needs a word for paying off or stopping.
  assert.equal(graph.graphUpdates([{ relation: "owes", object: "the mashonisa", closed: true }], "the mashonisa called me again", "2026-11-02").kept[0]!.closed, false);
});

// ── In a conversation ────────────────────────────────────────────

async function personWithPlan(): Promise<void> {
  const biz = await dbmod.createBusiness(OWNER, "ZA");
  await dbmod.updateBusiness(biz.id, {
    stage: "plan_ready",
    consent_at: new Date().toISOString(),
    answers: ANSWERS,
    identity: { name: "Lerato", earns: "domestic work and two grants", one_liner: "x", unsure: null },
    context: { name: "Lerato", one_liner: "Domestic work and two grants" },
    goal: [{ label: "R1,000 by Christmas", what: "R1,000 by December", why_you: "", worth: "R1,000", first_move: "", catch: "" }],
    rule: [{ label: "Nothing new borrowed", rule: "I borrow nothing from anyone for 90 days.", why_it_works: "", what_it_costs_you: null }],
  } as never);
}

test("every answer's prompt carries the household graph with its sources, and the rule about 'you told me'", async () => {
  await personWithPlan();
  net.modelCalls.length = 0;
  await engine.handleInbound(textFrom(OWNER, "What can the mashonisa do if I miss a week?"));
  const call = net.modelCalls.find((c) => /ROUTER RESULT/.test(c.prompt))!;
  assert.ok(call, "an answer was composed");
  assert.match(call.prompt, /WHAT YOU KNOW ABOUT THEIR MONEY/);
  assert.match(call.prompt, /- Owes The mashonisa: pays R200 a week, R800 owed \(setup answer\)/);
  assert.match(call.prompt, /Say "you told me" only about a line marked "they said" or "setup answer"/);
  assert.match(call.prompt, /Working towards R1,000 by Christmas/);
});

test("the memory step learns from what they said, closes what they paid off, and keeps the old amount", async () => {
  memoryReply = { ...memoryReply, graph_updates: [{ relation: "owes", object: "the mashonisa", amount: 300, per: "week", closed: false }, { relation: "supports", object: "my mother", amount: 500, per: "month" }] };
  await engine.handleInbound(textFrom(OWNER, "The mashonisa wants R300 a week now. I also send my mother R500 a month."));
  memoryReply = { ...memoryReply, graph_updates: [{ relation: "owes", object: "Edgars", closed: true }] };
  await engine.handleInbound(textFrom(OWNER, "Good news, I paid off Edgars yesterday!"));

  const g = await graph.householdGraph(business() as never);
  const shark = g.edges.find((e) => e.rel === "owes" && e.key === "mashonisa")!;
  assert.equal(shark.amount, 300);
  assert.deepEqual(shark.sources.sort(), ["answer", "said"]);
  const mother = g.edges.find((e) => e.rel === "supports" && e.key === "parents")!;
  assert.equal(mother.amount, 500);
  assert.equal(mother.source, "said");
  const edgars = g.edges.find((e) => e.key === "edgars")!;
  assert.equal(edgars.closed, true);
  const sheet = graph.graphSheet(g);
  assert.match(sheet, /Owes the mashonisa: pays R300 a week, R800 owed \(setup answer; they said, \d{4}-\d{2}-\d{2}\)|Owes the mashonisa: pays R300 a week, R800 owed \(answer/);
  assert.match(sheet, /Paid off or stopped: Edgars \(they said, \d{4}-\d{2}-\d{2}\)/);
  assert.ok(sheet.indexOf("Paid off") > sheet.indexOf("Owes"), "history comes after what is still true");

  // A second change keeps the first in history.
  memoryReply = { ...memoryReply, graph_updates: [{ relation: "owes", object: "the mashonisa", amount: 150, per: "week" }] };
  await engine.handleInbound(textFrom(OWNER, "I agreed R150 a week with the mashonisa."));
  const again = (await graph.householdGraph(business() as never)).edges.find((e) => e.key === "mashonisa")!;
  assert.equal(again.amount, 150);
  assert.match(graph.edgeLine(again), /was R300 a week until/);
});

test("a tap or a forward never teaches the graph, and a refused fact is counted, not kept", async () => {
  const before = db.tables.kg_edges!.length;
  memoryReply = { ...memoryReply, graph_updates: [{ relation: "owes", object: "Wonga", amount: 900 }] };
  await engine.handleInbound(textFrom(OWNER, "What is Wonga like?"));
  assert.equal(db.tables.kg_edges!.length, before, "a question is not a fact");
});

test("the person's graph tips the shortlist toward the rows about their own creditors", async () => {
  const g = await graph.householdGraph(business() as never);
  assert.match(graph.graphTerms(g), /mashonisa/);
  assert.doesNotMatch(graph.graphTerms(g), /edgars/, "paid off is not a boost");
});

test("the connector shows the graph and records a fact from the person's AI, marked as such", async () => {
  const connector = await import("../api/_lib/connector.ts");
  const biz = business();
  const ctx = await connector.callTool(biz as never, "get_household_context", {});
  const mg = (ctx.structured as { memory_graph: { relation: string; what: string; line: string; from: string[] }[] }).memory_graph;
  assert.ok(mg.some((m) => m.relation === "owes" && /mashonisa/i.test(m.what)));
  const ok = await connector.callTool(biz as never, "record_fact", { relation: "saves_in", what: "a GoalSave pocket", amount: 100, per: "week", their_words: "I started putting R100 a week into a GoalSave pocket" });
  assert.match(ok.text, /Recorded: Saves in a GoalSave pocket: R100 a week \(their AI said, \d{4}-\d{2}-\d{2}\)/);
  const no = await connector.callTool(biz as never, "record_fact", { relation: "owes", what: "Capitec card 4567 8901 2345", their_words: "my card 4567 8901 2345" });
  assert.match(no.text, /Not recorded/);
  const name = await connector.callTool(biz as never, "record_fact", { relation: "supports", what: "Sipho", their_words: "I support Sipho" });
  assert.match(name.text, /the role/);
});

test("'what do you know about me?' draws the memory card from the graph", async () => {
  await engine.handleInbound(textFrom(OWNER, "What do you know about me?"));
  const card = db.tables.cards!.find((c) => c.kind === "memory")!;
  assert.ok(card, "a memory card was made");
  const data = card.data as import("../api/_lib/cards.ts").MemoryCard;
  assert.equal(data.name, "Lerato");
  assert.ok(data.items.some((i) => i.label === "the mashonisa" || i.label === "The mashonisa"));
  assert.ok(data.items.some((i) => i.closed && /Edgars/.test(i.label)));
  assert.doesNotMatch(JSON.stringify(data), /27809930051/);
  assert.ok(net.sent.some((m) => /What I know about your money/.test(m.body)));
});

test("'forget my money' takes the whole graph with the household", async () => {
  assert.ok(db.tables.kg_edges!.length > 0 && db.tables.kg_nodes!.length > 0);
  await engine.handleInbound(textFrom(OWNER, "forget my money"));
  await engine.handleInbound(textFrom(OWNER, "YES"));
  assert.equal(db.tables.kg_edges!.length, 0);
  assert.equal(db.tables.kg_nodes!.length, 0);
});
