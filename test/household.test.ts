// Charles — a household of several WhatsApp numbers: two-sided consent,
// private debts by default, quiet leaving, names never numbers.

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
process.env.SESSION_SECRET = "fake-session-secret";
delete process.env.TYPESAFE_API_KEY;

import { installFakeNet, makeFakeDb, tapFrom, textFrom, type FakeDb, type FakeNet } from "./_fakes.ts";

const NOMSA = "27809930081";
const SIPHO = "27809930082";
const THIRD = "27809930083";
const knowledge = JSON.parse(readFileSync(new URL("../seed/knowledge.json", import.meta.url), "utf8"));
const tools = JSON.parse(readFileSync(new URL("../seed/tools.json", import.meta.url), "utf8"));

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let engine: typeof import("../api/_lib/engine/index.ts");
let dbmod: typeof import("../api/_lib/db.ts");
let hh: typeof import("../api/_lib/household.ts");
let graph: typeof import("../api/_lib/graph.ts");

before(async () => {
  net = installFakeNet();
  const roles = ["router", "wa_reply", "help", "plan_builder", "safety", "voice"].map((role) => ({ role, provider: "openrouter", model: `test/${role}`, fallbacks: [], params: {}, enabled: true }));
  db = makeFakeDb({ model_config: roles, knowledge_entries: knowledge, tools });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  engine = await import("../api/_lib/engine/index.ts");
  hh = await import("../api/_lib/household.ts");
  graph = await import("../api/_lib/graph.ts");
  net.onModel(/You are a strict checker/, (prompt) => Object.fromEntries([...prompt.matchAll(/- "([a-z_]+)":/g)].map((m) => [m[1]!, false])));
  net.onModel(/Classify this message from a person to their money assistant/, () => ({ intent: "question", domain: "spending", tool_need: null, missing_fact: null, risk: [], search_terms: "rent" }));
  net.onModel(/ROUTER RESULT/, () => ({ message: "Since the rent is covered, your R300 can go to the mashonisa first.", artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: "debt" }));
  net.onModel(/You maintain one person's money memory/, () => ({ context_updates: null, map_updates: null, decisions: null, commitments: null, results: null, owner_notes: null, graph_updates: null }));
});

after(() => {
  restore?.();
  net?.restore();
});

beforeEach(() => {
  net.sent.length = 0;
});

const biz = (wa: string) => db.tables.businesses!.find((b) => b.wa_id === wa)!;
const to = (wa: string) => net.sent.filter((m) => m.to === wa);
const textTo = (wa: string) => to(wa).map((m) => m.body).join("\n---\n");
let code = "";

async function planned(wa: string, name: string, answers: Record<string, string>): Promise<void> {
  const b = await dbmod.createBusiness(wa, "ZA");
  await dbmod.updateBusiness(b.id, { stage: "plan_ready", diag_step: 12, consent_at: new Date().toISOString(), answers: { person: name, ...answers }, identity: { name, earns: "x", one_liner: "x", unsure: null }, context: { name } } as never);
}

test("'invite someone to my household' makes a household and a single-use code, and says what is shared", async () => {
  await planned(NOMSA, "Nomsa", { owes: "A mashonisa", objective: "Stop the mashonisa, R300 a week on R1,200", depends: "Children" });
  await engine.handleInbound(textFrom(NOMSA, "Invite my partner to my household"));
  const t = textTo(NOMSA);
  const m = /household code: ([A-Z2-9]{6})\./.exec(t);
  assert.ok(m, t);
  code = m![1]!;
  assert.match(t, /works once, for the next 48 hours/);
  assert.match(t, /Debts and income stay private/);
  assert.match(t, new RegExp(`Message Charles and send: join ${code}`));
  assert.equal(db.tables.households!.length, 1);
  assert.notEqual(db.tables.household_invites![0]!.code_hash, code, "the code is stored as a hash");
  assert.equal(db.tables.household_members![0]!.role, "owner");
});

test("a brand-new number sending 'join <code>' gets the offer with the consent line, then its own question one", async () => {
  await engine.handleInbound(textFrom(SIPHO, `Hi Charles, join household ${code}`));
  const sent = to(SIPHO);
  assert.match(sent[0]!.body, /^Nomsa invited you to share a household on Charles\./);
  assert.match(sent[0]!.body, /leave any time by sending "leave household", and nobody is told/);
  assert.match(sent[0]!.body, /never ask for your ID number, account number, card, PIN or password/);
  assert.deepEqual(sent[0]!.buttons.map((b) => b.title), ["Join", "No thanks"]);
  assert.match(sent.at(-1)!.body, /^Hi, I'm Charles\./, "then the usual hello and question one");
  assert.ok(!db.tables.household_members!.some((m) => m.business_id === biz(SIPHO).id), "nothing shared before they tap Join");
});

test("Join asks the inviter, who lets them in; nothing is shared until both said yes, and no number is ever shown", async () => {
  // Sipho answers question one, so he has a name.
  await dbmod.updateBusiness(biz(SIPHO).id, { identity: { name: "Sipho", earns: "x", one_liner: "x", unsure: null } } as never);
  await engine.handleInbound(tapFrom(SIPHO, `a.hh.join:${code}`, "Join"));
  assert.match(textTo(SIPHO), /I've asked Nomsa to let you in/);
  const ask = to(NOMSA).find((m) => /wants to join your household/.test(m.body))!;
  assert.match(ask.body, /^Sipho used your household code/);
  assert.doesNotMatch(ask.body, /2780993/, "never a number");
  assert.equal(db.tables.household_members!.find((m) => m.business_id === biz(SIPHO).id)!.status, "pending_owner");
  assert.equal(await hh.householdView(biz(SIPHO) as never), null, "pending: nothing shared yet");

  net.sent.length = 0;
  const okId = ask.buttons.find((b) => b.title === "Let them in")!.id;
  await engine.handleInbound(tapFrom(NOMSA, okId, "Let them in"));
  assert.match(textTo(NOMSA), /Done: Sipho is in your household/);
  assert.match(textTo(SIPHO), /You're in Nomsa's household/);

  // The code was single use.
  const third = biz(THIRD) ?? (await dbmod.createBusiness(THIRD, "ZA"));
  const again = await hh.checkCode(third as never, code);
  assert.deepEqual(again, { refused: "used" });
});

test("each sees the other's shared lines by name; debts and income stay private until shared", async () => {
  await dbmod.updateBusiness(biz(SIPHO).id, { stage: "plan_ready", answers: { person: "Sipho", owes: "A bank loan or card", depends: "Children" } } as never);
  await graph.recordFacts(biz(SIPHO).id, graph.graphUpdates([{ relation: "pays", object: "rent", amount: 3000, per: "month" }, { relation: "owes", object: "Capfin", balance: 9000 }], "I pay the rent, R3000 a month. I owe Capfin R9000.", "2026-11-02").kept);

  const nomsaSees = hh.householdSheet(await hh.householdView(biz(NOMSA) as never));
  assert.match(nomsaSees, /- Sipho: Pays rent: R3,000 a month \(Sipho said, \d{4}-\d{2}-\d{2}\)/);
  assert.doesNotMatch(nomsaSees, /Capfin/, "his debt is private");
  const siphoSees = hh.householdSheet(await hh.householdView(biz(SIPHO) as never));
  assert.doesNotMatch(siphoSees, /mashonisa/i, "her debt is private");
  assert.match(siphoSees, /- Nomsa: Supports Children \(Nomsa's setup answer\)/);

  net.sent.length = 0;
  await engine.handleInbound(textFrom(SIPHO, "Share my debts with my household"));
  assert.match(textTo(SIPHO), /your household now sees your debts and income too/);
  assert.match(hh.householdSheet(await hh.householdView(biz(NOMSA) as never)), /- Sipho: Owes Capfin: R9,000 owed \(Sipho said/);
  await engine.handleInbound(textFrom(SIPHO, "stop sharing my debts"));
  assert.doesNotMatch(hh.householdSheet(await hh.householdView(biz(NOMSA) as never)), /Capfin/);
});

test("an answer's prompt carries the household with names and the rule never to say 'you told me' about it", async () => {
  net.modelCalls.length = 0;
  await engine.handleInbound(textFrom(NOMSA, "What should I pay first this month?"));
  const call = net.modelCalls.find((c) => /ROUTER RESULT/.test(c.prompt))!;
  assert.match(call.prompt, /THEIR HOUSEHOLD \(other people/);
  assert.match(call.prompt, /- Sipho: Pays rent: R3,000 a month \(Sipho said/);
  assert.match(call.prompt, /Never say "you told me" about these lines: say "Sipho told me"/);
  assert.match(call.prompt, /never suggest they check up on someone/);
  const checker = net.modelCalls.find((c) => /what_they_told_us_before/.test(c.prompt));
  if (checker) assert.doesNotMatch(checker.prompt.slice(checker.prompt.indexOf("what_they_told_us_before")), /Pays rent: R3,000/, "Sipho's lines are never evidence that Nomsa said them");
});

test("'who is in my household' lists first names; the connector sees the household; codes refuse the wrong cases", async () => {
  net.sent.length = 0;
  await engine.handleInbound(textFrom(NOMSA, "who is in my household?"));
  assert.match(textTo(NOMSA), /In your household: you, Sipho\./);
  const connector = await import("../api/_lib/connector.ts");
  const ctx = await connector.callTool(biz(NOMSA) as never, "get_household_context", {});
  const house = (ctx.structured as { household: { members: string[]; shared: string[] } }).household;
  assert.deepEqual(house.members, ["you", "Sipho"]);
  assert.ok(house.shared.some((l) => /Sipho: Pays rent/.test(l)));

  assert.deepEqual(await hh.checkCode(biz(NOMSA) as never, "ZZZZZZ"), { refused: "unknown" });
  const r = await hh.createInvite(biz(NOMSA) as never);
  assert.ok("code" in r);
  assert.deepEqual(await hh.checkCode(biz(NOMSA) as never, (r as { code: string }).code), { refused: "own" });
  assert.deepEqual(await hh.checkCode(biz(SIPHO) as never, (r as { code: string }).code), { refused: "already_in" });
  db.tables.household_invites!.at(-1)!.expires_at = new Date(Date.now() - 1000).toISOString();
  assert.deepEqual(await hh.checkCode(biz(THIRD) as never, (r as { code: string }).code), { refused: "expired" });
});

test("leaving is quiet: nobody is told, the others stop seeing their lines at once", async () => {
  net.sent.length = 0;
  await engine.handleInbound(textFrom(SIPHO, "leave household"));
  assert.match(textTo(SIPHO), /nobody is sent a message about it/);
  assert.equal(to(NOMSA).length, 0, "Nomsa is not told");
  assert.equal(hh.householdSheet(await hh.householdView(biz(NOMSA) as never)), "");
});

test("'forget my money' by the person who started it passes the household on, and an emptied household goes", async () => {
  // Sipho back in, then Nomsa (the owner) is forgotten.
  const r = await hh.createInvite(biz(NOMSA) as never);
  const c = (r as { code: string }).code;
  const req = await hh.requestToJoin(biz(SIPHO) as never, c);
  assert.ok("member" in req);
  await hh.decideJoin(biz(NOMSA) as never, (req as { member: { id: string } }).member.id, true);
  await engine.handleInbound(textFrom(NOMSA, "forget my money"));
  await engine.handleInbound(textFrom(NOMSA, "YES"));
  const left = db.tables.household_members!;
  assert.equal(left.length, 1);
  assert.equal(left[0]!.business_id, biz(SIPHO).id);
  assert.equal(left[0]!.role, "owner", "the longest-standing member takes it over");
  await engine.handleInbound(textFrom(SIPHO, "forget my money"));
  await engine.handleInbound(textFrom(SIPHO, "YES"));
  assert.equal(db.tables.household_members!.length, 0);
  assert.equal(db.tables.households!.length, 0, "an emptied household goes");
});

test("the typed commands are recognised whole, and real questions are not swallowed", () => {
  for (const s of ["invite someone to my household", "Add my partner", "start a household", "share my plan with my partner", "can I add my mother to my household?"]) assert.ok(hh.INVITE_ASK.test(s), s);
  for (const s of ["join K7P9QX", "Hi Charles, join household K7P9QX", "join my household k7p9qx"]) assert.ok(hh.JOIN_ASK.test(s), s);
  for (const s of ["should I add my partner's debt to my list?", "my partner wants to join a stokvel", "join the stokvel at work?", "how do I leave my household budget behind"]) {
    assert.ok(!hh.INVITE_ASK.test(s) && !hh.JOIN_ASK.test(s) && !hh.LEAVE_ASK.test(s), s);
  }
});
