// Charles — cards: the small pages a person opens from a WhatsApp link.
//
// Pinned here: every page is built in code from the person's own figures;
// nothing on it identifies them; a link is a hashed token that expires and
// goes with the household; the engine sends the right card at the right
// moment with its picture, and the link alone when the picture fails.

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

const OWNER = "27809930041";
const knowledge = JSON.parse(readFileSync(new URL("../seed/knowledge.json", import.meta.url), "utf8"));
const tools = JSON.parse(readFileSync(new URL("../seed/tools.json", import.meta.url), "utf8"));

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let cards: typeof import("../api/_lib/cards.ts");
let stmt: typeof import("../api/_lib/statement.ts");
let engine: typeof import("../api/_lib/engine/index.ts");
let dbmod: typeof import("../api/_lib/db.ts");
let cardApi: typeof import("../api/card.ts");

const MODEL_STATEMENT = {
  doc: "bank_statement", source: "Capitec", period: "1 Sep 2026 to 30 Sep 2026",
  money_in: [{ label: "SASSA child support grant", amount: 1060, day: 3, times: 2 }, { label: "EFT from an employer", amount: 3600, day: 25 }],
  money_out: [
    { label: "Shoprite", amount: 1480, kind: "groceries", times: 6 }, { label: "Mashonisa (cash send)", amount: 800, kind: "loan", times: 4 }, { label: "Taxi", amount: 520, kind: "transport" },
    { label: "Prepaid electricity", amount: 340, kind: "electricity" }, { label: "Cash withdrawals", amount: 900, kind: "cash", times: 3 }, { label: "Bank fees", amount: 68, kind: "bank_fees" },
  ],
  totals: { in: 4660, out: 4108, fees: 68, cash: 900, closing: 552 }, days_below_zero: 0, flags: [], unclear: null,
};

before(async () => {
  net = installFakeNet();
  const roles = ["router", "wa_reply", "help", "plan_builder", "safety", "voice"].map((role) => ({ role, provider: "openrouter", model: `test/${role}`, fallbacks: [], params: {}, enabled: true }));
  db = makeFakeDb({ model_config: roles, knowledge_entries: knowledge, tools });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  cards = await import("../api/_lib/cards.ts");
  stmt = await import("../api/_lib/statement.ts");
  engine = await import("../api/_lib/engine/index.ts");
  cardApi = await import("../api/card.ts");
  net.onModel(/Read this money document/, () => MODEL_STATEMENT);
  net.onModel(/You are a strict checker/, (prompt) => Object.fromEntries([...prompt.matchAll(/- "([a-z_]+)":/g)].map((m) => [m[1]!, false])));
  net.onModel(/Classify this message from a person to their money assistant/, () => ({ intent: "question", domain: "spending", tool_need: null, missing_fact: null, risk: [], search_terms: "progress" }));
  net.onModel(/ROUTER RESULT/, () => ({ message: "Two steps done out of seven, and the mashonisa payments have gone on the day both weeks. On track.", artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: "goals" }));
  net.onModel(/You maintain one person's money memory/, () => ({ context_updates: null, map_updates: null, decisions: null, commitments: null, results: null }));
});

after(() => {
  restore?.();
  net?.restore();
});

beforeEach(() => {
  net.sent.length = 0;
  net.pdf.fail = false;
});

const allText = () => net.sent.map((m) => m.body).join("\n---\n");
const business = () => db.tables.businesses!.find((b) => b.wa_id === OWNER)!;
const linksIn = (s: string) => [...s.matchAll(/https:\/\/charles\.test\/c\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);

// ── The pages ────────────────────────────────────────────────────

test("every demo card renders as a self-contained page with its figures, a noindex tag and no library", () => {
  for (const kind of cards.CARD_KINDS) {
    const html = cards.cardHTML(kind, cards.demoCard(kind) as never, { demo: true });
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.match(html, /Every number on it is invented/);
    assert.doesNotMatch(html, /<script src=/, `${kind}: no external script`);
    assert.match(html, /Charles teaches and plans with you/);
  }
  const month = cards.cardHTML("month", cards.demoCard("month") as never);
  assert.match(month, /Lerato's month, in <em>three pots\.<\/em>/);
  assert.match(month, /R4,820 came in/);
  assert.match(month, /Mashonisa \(cash send\)<\/span><span class="n">R800/);
  const debt = cards.cardHTML("debt", cards.demoCard("debt") as never);
  assert.match(debt, /Interest is blank on purpose: Charles never guesses a rate/);
  assert.match(debt, /A loan to end a loan/);
  const map = cards.cardHTML("map", cards.demoCard("map") as never);
  assert.match(map, /0 of 8 areas sorted/);
  assert.match(map, /Sorted would mean/);
  assert.match(map, /Every rand owed is written down with its cost/);
  const statement = cards.cardHTML("statement", cards.demoCard("statement") as never);
  assert.match(statement, /Below zero on 2 days/);
  const goal = cards.cardHTML("goal", cards.demoCard("goal") as never);
  assert.match(goal, /R1,000 by Christmas: getting to <em>the number\.<\/em>/);
});

test("the data on a page is embedded safely: a label that tries to close the script tag cannot", () => {
  const data = { ...(cards.demoCard("month") as import("../api/_lib/cards.ts").MonthCard), fixed: [{ label: "</script><script>alert(1)</script>", amount: 10 }] };
  const html = cards.cardHTML("month", data);
  assert.doesNotMatch(html, /<\/script><script>alert/);
  assert.match(html, /\\u003c\/script>/);
  assert.match(html, /&lt;\/script&gt;/);
});

test("card data is built from the household only, and names are first names", () => {
  const read = stmt.parseStatement(MODEL_STATEMENT, "2026-10-30") as import("../api/_lib/statement.ts").StatementRead;
  const biz = { identity: { name: "Lerato Mokoena", earns: "x", one_liner: "x", unsure: null }, context: null, answers: { objective: "Pay off the mashonisa, R200 a week on R800, and put R1,000 away by Christmas" }, statement: read, rule: [{ label: "x", rule: "I borrow nothing from anyone for 90 days, however small.", why_it_works: "", what_it_costs_you: null }], goal: [{ label: "R1,000 by Christmas", what: "R1,000 in a pocket by December", why_you: "", worth: "R1,000", first_move: "", catch: "" }], map: null, objective_read: null };
  const month = cards.monthCardData(biz as never)!;
  assert.equal(month.name, "Lerato");
  assert.equal(month.income, 4660);
  assert.deepEqual(month.loose.map((l) => l.label), ["Cash withdrawals"]);
  const debt = cards.debtCardData(biz as never);
  assert.equal(debt.label, "Mashonisa (cash send)");
  assert.equal(debt.perWeek, 200);
  assert.equal(debt.owed, 1000, "the largest figure in their words that is not the weekly payment");
  assert.match(debt.rule!, /borrow nothing/);
  const goal = cards.goalCardData(biz as never);
  assert.equal(goal.target, 1000);
  assert.equal(goal.deadline, "Christmas");
  assert.equal(cards.monthCardData({ ...biz, statement: null } as never), null);
  assert.equal(cards.mapCardData({ ...biz, map: [] } as never, null), null);
  const noFigures = cards.debtCardData({ identity: null, context: null, answers: { owes: "A mashonisa" }, statement: null, rule: null } as never);
  assert.equal(noFigures.owed, null, "no figure given, the page's field is left empty, never guessed");
  assert.equal(noFigures.label, "The mashonisa");
});

test("'show me my month' and friends map to a card; a real question does not", () => {
  assert.equal(cards.cardKindAsked("show me my month"), "month");
  assert.equal(cards.cardKindAsked("Can you show me a picture of my budget?"), "month");
  assert.equal(cards.cardKindAsked("draw my map"), "map");
  assert.equal(cards.cardKindAsked("send me a chart of what I owe"), "debt");
  assert.equal(cards.cardKindAsked("show me my statement"), "statement");
  assert.equal(cards.cardKindAsked("show me my goal"), "goal");
  assert.equal(cards.cardKindAsked("show me how to dispute a listing on my credit report"), null);
  assert.equal(cards.cardKindAsked("my map is wrong, the cover line should be green"), null);
});

// ── Links ────────────────────────────────────────────────────────

test("a card link is a hashed token that serves the snapshot, says nothing about who, and expires", async () => {
  const biz = await dbmod.createBusiness(OWNER, "ZA");
  const minted = (await cards.mintCard(biz.id, "goal", cards.demoCard("goal") as never))!;
  assert.match(minted.url, /^https:\/\/charles\.test\/c\/[A-Za-z0-9_-]{30,}$/);
  const row = db.tables.cards![0]!;
  assert.notEqual(row.token_hash, minted.token, "the token itself is never stored");
  assert.doesNotMatch(JSON.stringify(row.data), /27809930041/);

  const res = await cardApi.GET(new Request(minted.url.replace("/c/", "/api/card?t=")));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  const html = await res.text();
  assert.match(html, /getting to <em>the number/);
  assert.doesNotMatch(html, /27809930041|DEMO · INVENTED/);

  const bad = await cardApi.GET(new Request("https://charles.test/api/card?t=nope-nope-nope-nope-nope-nope"));
  assert.equal(bad.status, 404);
  assert.match(await bad.text(), /doesn't open anything/);

  row.expires_at = new Date(Date.now() - 1000).toISOString();
  const old = await cardApi.GET(new Request(minted.url.replace("/c/", "/api/card?t=")));
  assert.equal(old.status, 404);
  assert.match(await old.text(), /expired/);
});

test("the demo pages are served without a token and say they are invented", async () => {
  const res = await cardApi.GET(new Request("https://charles.test/api/card?demo=map"));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Demo · invented/);
  assert.equal((await cardApi.GET(new Request("https://charles.test/api/card?demo=secrets"))).status, 404);
});

// ── In a conversation ────────────────────────────────────────────

test("a statement read mid-diagnostic comes with its picture and a link to the statement card", async () => {
  await dbmod.updateBusiness(business().id, { stage: "diag", diag_step: 5, consent_at: new Date().toISOString(), answers: { person: "Lerato, domestic work" } } as never);
  net.media.mime = "application/pdf";
  net.media.bytes = new Uint8Array([37, 80, 68, 70]);
  await engine.handleInbound({ waMessageId: `wamid.${Math.random()}`, from: OWNER, timestamp: Date.now(), kind: "document" as const, text: "", mediaId: "m1", mimeType: "application/pdf" });
  const image = net.sent.find((m) => m.type === "image");
  assert.ok(image, "the statement card went as a picture");
  assert.match(image!.body, /What your statement says, as a picture/);
  assert.equal(linksIn(image!.body).length, 1);
  const stored = db.tables.cards!.find((c) => c.kind === "statement")!;
  assert.doesNotMatch(JSON.stringify(stored.data), /27809930041/);
  assert.equal(business().stage, "diag");
});

test("'Plan my budget' sends the three pots and then the month card, and the link alone when the picture fails", async () => {
  net.pdf.fail = true;
  await engine.handleInbound(tapFrom(OWNER, "a.stmt.budget", "Plan my budget"));
  const text = allText();
  assert.match(text, /here's your month in three pots/);
  assert.ok(!net.sent.some((m) => m.type === "image"), "no picture when the render fails");
  const link = net.sent.find((m) => /Your month in three pots\. Tap to slide/.test(m.body))!;
  assert.ok(link, "the link still goes out as text");
  assert.equal(linksIn(link.body).length, 1);
  assert.ok(db.tables.cards!.some((c) => c.kind === "month"));
});

test("'show me what I owe' draws the debt card at any stage, and 'my map' before a plan says what is needed", async () => {
  await engine.handleInbound(textFrom(OWNER, "show me what I owe"));
  const image = net.sent.find((m) => m.type === "image");
  assert.ok(image);
  assert.match(image!.body, /When it's gone/);
  net.sent.length = 0;
  await engine.handleInbound(textFrom(OWNER, "show me my map"));
  assert.match(allText(), /drawn once your plan is built/);
  assert.ok(!db.tables.cards!.some((c) => c.kind === "map"));
  assert.equal(business().diag_step, 5, "the diagnostic was not moved by either");
});

test("with a plan, 'how am I doing?' gets the answer and then the map card", async () => {
  const biz = business();
  await dbmod.updateBusiness(biz.id, {
    stage: "plan_ready",
    identity: { name: "Lerato", earns: "domestic work", one_liner: "x", unsure: null },
    context: { name: "Lerato", one_liner: "x" },
    map: [{ domain: "income", status: "amber", note: "Cash on Fridays" }, { domain: "debt", status: "red", note: "A mashonisa" }],
  } as never);
  db.tables.plans!.push({ id: "plan-1", business_id: biz.id, goal: "Pay the mashonisa off", headline: "x", strategy: null, created_at: new Date(Date.now() - 5 * 864e5).toISOString() });
  db.tables.plan_steps!.push(
    { id: "s1", plan_id: "plan-1", step_order: 1, step_key: "sh1", title: "Know the rules", domain: "debt", status: "done", done_at: new Date(Date.now() - 3 * 864e5).toISOString() },
    { id: "s2", plan_id: "plan-1", step_order: 2, step_key: "sh2", title: "Set the pay-down", domain: "debt", status: "open" },
  );
  await engine.handleInbound(textFrom(OWNER, "how am I doing?"));
  assert.match(allText(), /Two steps done out of seven|On track/);
  const image = net.sent.find((m) => m.type === "image")!;
  assert.ok(image, "the map followed the answer");
  assert.match(image.body, /Your Money Map/);
  const card = db.tables.cards!.find((c) => c.kind === "map")!;
  const data = card.data as import("../api/_lib/cards.ts").MapCard;
  assert.equal(data.day, 6);
  assert.deepEqual(data.doneDays, [3]);
  assert.equal(data.steps.current, "Set the pay-down");
  assert.equal(data.areas.length, 2);
});

test("the connector can hand the person's AI a card link, or send the card to their phone", async () => {
  const connector = await import("../api/_lib/connector.ts");
  const biz = business();
  const out = await connector.callTool(biz as never, "get_card", { kind: "goal" });
  assert.match(out.text, /Getting to the number: https:\/\/charles\.test\/c\//);
  net.sent.length = 0;
  const sent = await connector.callTool(biz as never, "get_card", { kind: "debt", send_to_whatsapp: true });
  assert.match(sent.text, /Sent to their WhatsApp/);
  assert.ok(net.sent.some((m) => m.type === "image" && /When it's gone/.test(m.body)));
  const bad = await connector.callTool(biz as never, "get_card", { kind: "selfie" });
  assert.equal(bad.isError, true);
});

test("'forget my money' takes every card with the household", async () => {
  assert.ok(db.tables.cards!.length > 0);
  await engine.handleInbound(textFrom(OWNER, "forget my money"));
  await engine.handleInbound(textFrom(OWNER, "YES"));
  assert.equal(db.tables.cards!.length, 0);
});
