// Charles — the household knowledge graph, pushed hard.
//
// The first file (knowledge-graph.test.ts) proves the graph works. This one
// tries to break it the way real WhatsApp conversations will: two policies
// from two insurers, a loan shark called by three names, "I never borrowed",
// "if I took a loan", "my sister owes the mashonisa", a statement with forty
// debit orders, the same fact said twice, a debt paid off and then taken
// again, a forwarded flyer, and six weeks of one person's messages. And it
// holds the graph to a speed budget, because every answer reads it.

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

const OWNER = "27809930061";
const knowledge = JSON.parse(readFileSync(new URL("../seed/knowledge.json", import.meta.url), "utf8"));
const tools = JSON.parse(readFileSync(new URL("../seed/tools.json", import.meta.url), "utf8"));

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let graph: typeof import("../api/_lib/graph.ts");
let lib: typeof import("../api/_lib/libgraph.ts");
let stmt: typeof import("../api/_lib/statement.ts");
let engine: typeof import("../api/_lib/engine/index.ts");
let dbmod: typeof import("../api/_lib/db.ts");

let memoryReply: Record<string, unknown> = {};
const NULL_MEMORY = { context_updates: null, map_updates: null, decisions: null, commitments: null, results: null, owner_notes: null, graph_updates: null };

before(async () => {
  net = installFakeNet();
  const roles = ["router", "wa_reply", "help", "plan_builder", "safety", "voice"].map((role) => ({ role, provider: "openrouter", model: `test/${role}`, fallbacks: [], params: {}, enabled: true }));
  db = makeFakeDb({ model_config: roles, knowledge_entries: knowledge, tools });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  graph = await import("../api/_lib/graph.ts");
  lib = await import("../api/_lib/libgraph.ts");
  stmt = await import("../api/_lib/statement.ts");
  engine = await import("../api/_lib/engine/index.ts");
  net.onModel(/You are a strict checker/, (prompt) => Object.fromEntries([...prompt.matchAll(/- "([a-z_]+)":/g)].map((m) => [m[1]!, false])));
  net.onModel(/Classify this message from a person to their money assistant/, () => ({ intent: "question", domain: "debt", tool_need: null, missing_fact: null, risk: [], search_terms: "debt" }));
  net.onModel(/ROUTER RESULT/, () => ({ message: "Noted. Pay the dearest one first, on the day the money lands.", artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: "debt" }));
  net.onModel(/The person forwarded something/, () => ({ message: "That flyer asks for a fee up front. Don't pay it.", artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: null }));
  net.onModel(/Report what is in it/, () => "WHAT IT IS: a loan flyer\nWHAT IT SAYS: You owe Wonga R5,000. Pay R500 now.");
  net.onModel(/Read this money document/, () => ({ doc: "not_money" }));
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
const today = "2026-11-02";
const keep = (raw: unknown[], said: string) => graph.graphUpdates(raw, said, today);

// ── Names: one node per thing, two nodes for two things ──────────

test("one thing called many names is one node; two named things of one kind stay two", () => {
  const k = (label: string, rel: import("../api/_lib/graph.ts").Rel = "owes") => graph.keyOf(label, graph.REL_KIND[rel]);
  assert.equal(k("the mashonisa"), "mashonisa");
  assert.equal(k("a loan shark"), "mashonisa");
  assert.equal(k("Mashonisa (cash send)"), "mashonisa");
  assert.equal(k("The mashonisa"), "mashonisa");
  assert.equal(k("SASSA child support grant", "earns_from"), "sassa grant");
  assert.equal(k("A SASSA grant", "earns_from"), "sassa grant");
  assert.equal(k("my mom", "supports"), "parents");
  assert.equal(k("Parents or elders", "supports"), "parents");
  assert.equal(k("My two children", "supports"), "children");
  assert.equal(k("Edgars account"), "edgars");
  assert.equal(k("Edgars"), "edgars");
  // Two insurers are two policies, never one.
  assert.equal(k("Old Mutual funeral cover", "covered_by"), "old mutual funeral cover");
  assert.equal(k("Avbob funeral policy", "covered_by"), "avbob funeral policy");
  assert.equal(k("A funeral policy", "covered_by"), "funeral policy");
});

test("two funeral policies show as two lines, and the generic setup answer gives way to the named ones", () => {
  const read = stmt.parseStatement({
    doc: "bank_statement", source: "Capitec", period: "Oct 2026",
    money_in: [{ label: "Wages", amount: 5200 }],
    money_out: [{ label: "Old Mutual funeral cover", amount: 120, kind: "insurance" }, { label: "Avbob funeral policy", amount: 95, kind: "insurance" }],
    totals: { in: 5200, out: 215 },
  }, "2026-11-01") as import("../api/_lib/statement.ts").StatementRead;
  const edges = graph.merge(graph.derive({ answers: { cover: "Funeral policy" }, statement: read, created_at: "2026-10-01" } as never), []);
  const cover = edges.filter((e) => e.rel === "covered_by").map((e) => e.label).sort();
  assert.deepEqual(cover, ["Avbob funeral policy", "Old Mutual funeral cover"]);
});

// ── What is not a fact ───────────────────────────────────────────

test("negated, hypothetical and someone else's money are refused; paying off is not mistaken for a negation", () => {
  const cases: [unknown, string, string | null][] = [
    [{ relation: "owes", object: "a mashonisa" }, "I never borrowed from a mashonisa in my life.", "negated"],
    [{ relation: "covered_by", object: "a funeral policy" }, "I don't have a funeral policy.", "negated"],
    [{ relation: "owes", object: "Capfin", balance: 5000 }, "If I took R5000 from Capfin, how much would it cost?", "hypothetical"],
    [{ relation: "member_of", object: "a stokvel" }, "I'm thinking of joining a stokvel at church.", "hypothetical"],
    [{ relation: "owes", object: "the mashonisa", amount: 500 }, "My sister owes the mashonisa R500 and he keeps calling me.", "someone_else"],
    [{ relation: "owes", object: "Edgars", closed: true }, "I don't owe Edgars anymore, it's done.", null],
    [{ relation: "owes", object: "Edgars", closed: true }, "I paid off Edgars last week.", null],
    [{ relation: "member_of", object: "the stokvel", closed: true }, "I'm no longer in the stokvel.", null],
    [{ relation: "supports", object: "my sister", amount: 400, per: "month" }, "My sister gets R400 a month from me.", null],
    [{ relation: "owes", object: "the mashonisa", amount: 250, per: "week" }, "Now I pay the mashonisa R250 every week.", null],
  ];
  for (const [raw, said, reason] of cases) {
    const r = keep([raw], said);
    if (reason) assert.equal(r.refused[0]?.reason, reason, `${said} → ${reason}`);
    else assert.equal(r.kept.length, 1, `${said} should be kept (refused: ${JSON.stringify(r.refused)})`);
  }
  assert.equal(keep([{ relation: "owes", object: "Edgars", closed: true }], "I don't owe Edgars anymore, it's done.").kept[0]!.closed, true);
  assert.equal(keep([{ relation: "supports", object: "my sister", amount: 400, per: "month" }], "My sister gets R400 a month from me.").kept[0]!.amount, 400);
});

test("figures are kept only as typed, in any of the ways people type them", () => {
  const typed = (said: string, amount: number) => keep([{ relation: "pays", object: "rent", amount, per: "month" }], said).kept[0]?.amount ?? null;
  assert.equal(typed("My rent is R1 500 a month.", 1500), 1500);
  assert.equal(typed("My rent is R1,500 a month.", 1500), 1500);
  assert.equal(typed("I pay 1500 rand rent a month.", 1500), 1500);
  assert.equal(typed("My rent went up.", 1500), null, "a figure they did not type is dropped");
  assert.equal(typed("Rent is R1,500 a month.", 15000), null, "a figure off by a digit is dropped");
});

// ── Writing: the same fact twice, a debt paid and taken again ─────

async function freshPerson(): Promise<string> {
  const biz = await dbmod.createBusiness(OWNER, "ZA");
  await dbmod.updateBusiness(biz.id, {
    stage: "plan_ready",
    consent_at: new Date().toISOString(),
    answers: { person: "Nomsa, I clean offices", owes: "A mashonisa, A clothing or furniture account", depends: "Children", cover: "Funeral policy", income_kind: "Salary or wage", objective: "Stop the mashonisa, R300 a week on R1,200" },
    identity: { name: "Nomsa", earns: "cleaning offices", one_liner: "x", unsure: null },
    context: { name: "Nomsa" },
  } as never);
  return biz.id;
}

test("the same fact twice is one edge and no new history; three round trips for many facts", async () => {
  const id = await freshPerson();
  const facts = keep([
    { relation: "owes", object: "the mashonisa", amount: 300, per: "week" },
    { relation: "supports", object: "my mother", amount: 500, per: "month" },
    { relation: "pays", object: "rent", amount: 1800, per: "month" },
    { relation: "member_of", object: "the stokvel", amount: 200, per: "month" },
  ], "I pay the mashonisa R300 a week. I send my mother R500 a month. Rent is R1800 a month. The stokvel is R200 a month.").kept;
  assert.equal(facts.length, 4);
  const before = db.log.length;
  assert.equal(await graph.recordFacts(id, facts), 4);
  const trips = db.log.slice(before).filter((l) => l.startsWith("kg_"));
  assert.equal(trips.length, 3, `writes for four facts: ${trips.join(" | ")}`);
  const edges = db.tables.kg_edges!.length;
  assert.equal(await graph.recordFacts(id, facts), 0, "nothing changed the second time");
  assert.equal(db.tables.kg_edges!.length, edges);
  assert.ok(db.tables.kg_edges!.every((e) => (e.history as unknown[]).length === 0));
});

test("a debt paid off and then taken again is active again, with its history", async () => {
  const id = business().id;
  await graph.recordFacts(id, keep([{ relation: "owes", object: "the mashonisa", closed: true }], "I paid off the mashonisa!").kept);
  let shark = (await graph.householdGraph(business() as never)).edges.find((e) => e.key === "mashonisa")!;
  assert.equal(shark.closed, true);
  await graph.recordFacts(id, keep([{ relation: "owes", object: "the mashonisa", amount: 400, per: "week" }], "I had to go back to the mashonisa, R400 a week now.").kept);
  shark = (await graph.householdGraph(business() as never)).edges.find((e) => e.key === "mashonisa")!;
  assert.equal(shark.closed, false);
  assert.equal(shark.amount, 400);
  assert.match(graph.edgeLine(shark), /was R300 a week until \d{4}-\d{2}-\d{2}/);
});

// ── Reading: bounded, and honest about who said what ─────────────

test("a statement with forty debit orders cannot crowd the prompt: six bills, the rest summed, under the cap", () => {
  const money_out = Array.from({ length: 40 }, (_, i) => ({ label: `Debit order ${String.fromCharCode(65 + (i % 26))}${i}`, amount: 50 + i, kind: "debit_order" }));
  const read = stmt.parseStatement({ doc: "bank_statement", source: "Capitec", period: "Oct 2026", money_in: [{ label: "Wages", amount: 9000 }], money_out, totals: { in: 9000 } }, "2026-11-01") as import("../api/_lib/statement.ts").StatementRead;
  const g = { name: "Nomsa", edges: graph.merge(graph.derive({ answers: {}, statement: read, created_at: "2026-10-01" } as never), []) };
  const sheet = graph.graphSheet(g);
  assert.ok(sheet.length <= 1800, `sheet is ${sheet.length} characters`);
  assert.equal((sheet.match(/^- Pays Debit order/gm) ?? []).length, 6);
  assert.match(sheet, /- Pays 34 other bills too, about R[\d,]+ a month together \(their statement\)/);
});

test("the 'you told me' evidence holds what they said and their setup answers, never the statement or their AI", () => {
  const read = stmt.parseStatement({ doc: "bank_statement", source: "Capitec", money_in: [{ label: "Wages", amount: 5200 }], money_out: [{ label: "Edgars account", amount: 250, kind: "store_account" }], totals: { in: 5200 } }, "2026-11-01") as import("../api/_lib/statement.ts").StatementRead;
  const said = keep([{ relation: "supports", object: "my mother", amount: 500, per: "month" }], "I send my mother R500 a month.").kept;
  const ai = graph.graphUpdates([{ relation: "saves_in", object: "a GoalSave pocket", amount: 100, per: "week" }], "she puts R100 a week in a GoalSave pocket", today, "connector").kept;
  const g = { name: "Nomsa", edges: graph.merge([...graph.derive({ answers: { owes: "A mashonisa" }, statement: read, created_at: "2026-10-01" } as never), ...said, ...ai], []) };
  const told = graph.saidSheet(g);
  assert.match(told, /Supports my mother: R500 a month \(they said/);
  assert.match(told, /Owes The mashonisa \(setup answer\)/);
  assert.doesNotMatch(told, /Wages|GoalSave|their statement|their AI/);
});

// ── Speed ────────────────────────────────────────────────────────

test("speed: the household graph and the library graph stay far inside a WhatsApp reply's budget", () => {
  const money_out = Array.from({ length: 40 }, (_, i) => ({ label: `Payee ${i}`, amount: 100 + i, kind: i % 3 ? "debit_order" : "store_account" }));
  const read = stmt.parseStatement({ doc: "bank_statement", source: "Capitec", money_in: [{ label: "Wages", amount: 9000 }, { label: "SASSA grant", amount: 560 }], money_out, totals: { in: 9560 } }, "2026-11-01") as import("../api/_lib/statement.ts").StatementRead;
  const stored = graph.merge(Array.from({ length: 30 }, (_, i) => ({ rel: "pays" as const, label: `Stored ${i}`, amount: i + 1, per: "month" as const, source: "said" as const, on: today })), []);
  const biz = { answers: { owes: "A mashonisa, A bank loan or card", depends: "Children, Parents or elders", cover: "Funeral policy, Burial society", income_kind: "Salary or wage, SASSA grant" }, statement: read, created_at: "2026-10-01" };
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) {
    const g = { name: "Nomsa", edges: graph.merge(graph.derive(biz as never), stored) };
    graph.graphSheet(g);
    graph.saidSheet(g);
    graph.graphTerms(g);
  }
  const perTurn = (performance.now() - t0) / 200;
  assert.ok(perTurn < 5, `household graph per turn: ${perTurn.toFixed(2)}ms`);

  const t1 = performance.now();
  lib.buildLibraryGraph(knowledge, tools, "ZA");
  const build = performance.now() - t1;
  assert.ok(build < 150, `library graph build: ${build.toFixed(1)}ms`);
  lib.libraryGraph(knowledge, tools, "ZA");
  const t2 = performance.now();
  for (let i = 0; i < 1000; i++) lib.libraryGraph(knowledge, tools, "ZA");
  const cached = (performance.now() - t2) / 1000;
  assert.ok(cached < 0.5, `library graph, cached: ${cached.toFixed(3)}ms`);
});

// ── In a conversation ────────────────────────────────────────────

test("a forwarded flyer that says 'you owe Wonga R5,000' never enters the graph", async () => {
  const before = db.tables.kg_edges!.length;
  memoryReply = { ...NULL_MEMORY, graph_updates: [{ relation: "owes", object: "Wonga", balance: 5000 }] };
  net.media.mime = "image/jpeg";
  net.media.bytes = new Uint8Array([255, 216, 255, 224]);
  await engine.handleInbound({ waMessageId: `wamid.${Math.random()}`, from: OWNER, timestamp: Date.now(), kind: "image" as const, text: "is this real?", mediaId: "m1", mimeType: "image/jpeg" });
  assert.equal(db.tables.kg_edges!.length, before);
  assert.ok(!db.tables.kg_nodes!.some((n) => /wonga/i.test(String(n.label))));
});

test("six weeks of one person's messages: the graph ends true, and the next answer is built on it", async () => {
  const turns: [string, unknown[]][] = [
    ["Hi Charles, quick update. I now send my mom R600 a month.", [{ relation: "supports", object: "my mom", amount: 600, per: "month" }]],
    ["My sister owes the mashonisa R2000 and she asked me to help.", [{ relation: "owes", object: "the mashonisa", balance: 2000 }]],
    ["I joined a stokvel at work, R300 a month.", [{ relation: "member_of", object: "a stokvel at work", amount: 300, per: "month" }]],
    ["Should I take a Capfin loan to clear Edgars?", [{ relation: "owes", object: "Capfin" }]],
    ["Edgars is paid off! Finished paying it on Friday.", [{ relation: "owes", object: "Edgars", closed: true }]],
    ["I opened a GoalSave pocket and put R150 in every Friday.", [{ relation: "saves_in", object: "a GoalSave pocket", amount: 150, per: "week" }]],
    ["Actually it's R700 a month to my mom now, prices went up.", [{ relation: "supports", object: "my mom", amount: 700, per: "month" }]],
  ];
  for (const [said, updates] of turns) {
    memoryReply = { ...NULL_MEMORY, graph_updates: updates };
    await engine.handleInbound(textFrom(OWNER, said));
  }
  const g = await graph.householdGraph(business() as never);
  const by = (rel: string, key: string) => g.edges.find((e) => e.rel === rel && e.key === key);
  assert.equal(by("supports", "parents")!.amount, 700);
  assert.match(graph.edgeLine(by("supports", "parents")!), /was R600 a month until/);
  assert.equal(by("owes", "mashonisa")!.amount, 400, "her sister's debt did not land on her");
  assert.equal(by("owes", "mashonisa")!.balance ?? null, 1200, "the R2,000 was her sister's; her own R1,200 stands");
  assert.ok(!g.edges.some((e) => e.key === "capfin"), "a loan she asked about is not a loan she has");
  assert.equal(by("owes", "edgars")!.closed, true);
  assert.equal(by("member_of", "stokvel at work")!.amount, 300);
  assert.equal(by("saves_in", "goalsave pocket")!.amount, 150);

  net.modelCalls.length = 0;
  memoryReply = { ...NULL_MEMORY };
  await engine.handleInbound(textFrom(OWNER, "What should I do with the R150 a week now?"));
  const answer = net.modelCalls.find((c) => /ROUTER RESULT/.test(c.prompt))!;
  assert.match(answer.prompt, /Supports my mom: R700 a month, was R600 a month until/);
  assert.match(answer.prompt, /Saves in a GoalSave pocket: R150 a week/);
  assert.match(answer.prompt, /Paid off or stopped: Edgars/);
  const checker = net.modelCalls.find((c) => /You are a strict checker/.test(c.prompt) && /what_they_told_us_before/.test(c.prompt));
  assert.ok(checker, "the reply checker was given what they told Charles before");
  assert.match(checker!.prompt, /my mom: R700 a month/);
});
