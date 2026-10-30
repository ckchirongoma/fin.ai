// Charles — a bank statement the person chose to send: read once, said back
// in code, used for the plan, and never a number that identifies an account.
//
// Three rules this pins:
//   rule 10: every figure said back is the statement's own (plain code, no model);
//   rule 12: the account number never survives, however the model returns it;
//   rule 2:  the plan prompts see the figures under a key that names its source.

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

const OWNER = "27809930031";
const knowledge = JSON.parse(readFileSync(new URL("../seed/knowledge.json", import.meta.url), "utf8"));
const tools = JSON.parse(readFileSync(new URL("../seed/tools.json", import.meta.url), "utf8"));

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let stmt: typeof import("../api/_lib/statement.ts");
let engine: typeof import("../api/_lib/engine/index.ts");
let dbmod: typeof import("../api/_lib/db.ts");

/** What the model returns for Lerato's September statement, WITH the identifiers it was told to leave out. */
const MODEL_STATEMENT = {
  doc: "bank_statement",
  source: "Capitec, account 1234567890123",
  period: "1 Sep 2026 to 30 Sep 2026",
  money_in: [
    { label: "SASSA child support grant", amount: 1060, day: 3, times: 2 },
    { label: "EFT from an employer", amount: 3600, day: 25 },
    { label: "Cash deposit ref 98765432", amount: 160, day: 12 },
  ],
  money_out: [
    { label: "Shoprite", amount: 1480, day: null, kind: "groceries", times: 6 },
    { label: "Mashonisa (cash send)", amount: 800, day: null, kind: "loan", times: 4 },
    { label: "Taxi", amount: 520, day: null, kind: "transport" },
    { label: "Vodacom airtime and data", amount: 310, day: null, kind: "airtime_data" },
    { label: "Old Mutual funeral cover", amount: 120, day: 1, kind: "insurance" },
    { label: "Prepaid electricity", amount: 340, day: null, kind: "electricity" },
    { label: "Edgars account", amount: 250, day: 1, kind: "store_account" },
    { label: "Cash withdrawals", amount: 900, day: null, kind: "cash", times: 3 },
    { label: "Bank fees", amount: 68, day: null, kind: "bank_fees" },
  ],
  totals: { in: 4820, out: 4788, fees: 68, cash: 900, closing: 32 },
  days_below_zero: 2,
  flags: ["Debit order to Edgars returned unpaid on the 2nd", "Card number 5412 3456 7890 1234"],
  unclear: null,
};

let modelDoc: unknown = MODEL_STATEMENT;
let extracted = "";

before(async () => {
  net = installFakeNet();
  const roles = ["router", "wa_reply", "help", "plan_builder", "safety", "voice"].map((role) => ({
    role, provider: "openrouter", model: `test/${role}`, fallbacks: [], params: {}, enabled: true,
  }));
  db = makeFakeDb({ model_config: roles, knowledge_entries: knowledge, tools });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  stmt = await import("../api/_lib/statement.ts");
  engine = await import("../api/_lib/engine/index.ts");

  net.onModel(/Read this money document/, () => modelDoc);
  net.onModel(/Report what is in it/, () => extracted);
  net.onModel(/You are a strict checker/, (prompt) => {
    const ids = [...prompt.matchAll(/- "([a-z_]+)":/g)].map((m) => m[1]!);
    return Object.fromEntries(ids.map((id) => [id, false]));
  });
  net.onModel(/Classify this message from a person to their money assistant/, () => ({
    intent: "forward_file", domain: "spending", tool_need: null, missing_fact: null, risk: [], search_terms: "bank fees",
  }));
  net.onModel(/The person forwarded something/, () => ({
    message: "This flyer asks for a fee before any money is paid out. Don't pay it.",
    artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: null,
  }));
  net.onModel(/You maintain one person's money memory/, () => ({
    context_updates: null, map_updates: null, decisions: null, commitments: null, results: null,
  }));
});

after(() => {
  restore?.();
  net?.restore();
});

beforeEach(() => {
  net.sent.length = 0;
  modelDoc = MODEL_STATEMENT;
});

const allText = () => net.sent.map((m) => m.body).join("\n---\n");
const lastButtons = () => [...net.sent].reverse().find((m) => m.buttons.length)?.buttons ?? [];
const business = () => db.tables.businesses!.find((b) => b.wa_id === OWNER)!;

const pdfFrom = (caption = "") => ({
  waMessageId: `wamid.pdf.${Math.random()}`,
  from: OWNER,
  timestamp: Date.now(),
  kind: "document" as const,
  text: caption,
  mediaId: "media-stmt",
  mimeType: "application/pdf",
});

// ── The reader, in code ──────────────────────────────────────────

test("parseStatement keeps the totals and payees and drops every identifier the model let through", () => {
  const read = stmt.parseStatement(MODEL_STATEMENT, "2026-10-30");
  assert.ok(read && read !== "not_money");
  const json = JSON.stringify(read);
  assert.doesNotMatch(json, /1234567890123|98765432|5412 3456 7890 1234/, "an account, reference or card number survived");
  assert.match(read.source!, /Capitec/);
  assert.equal(read.totals.in, 4820);
  assert.equal(read.money_in[0]!.times, 2);
  assert.equal(read.money_out.find((l) => l.label.startsWith("Mashonisa"))!.kind, "loan");
  assert.equal(read.days_below_zero, 2);
  // The card-number flag is nothing once its number is gone, so it is dropped.
  assert.deepEqual(read.flags, ["Debit order to Edgars returned unpaid on the 2nd"]);
});

test("something that is not a money document, or an empty reading, is never a statement", () => {
  assert.equal(stmt.parseStatement({ doc: "not_money" }), "not_money");
  assert.equal(stmt.parseStatement({ doc: "bank_statement", money_in: [], money_out: [], totals: {} }), null);
  assert.equal(stmt.parseStatement({ doc: "receipt" }), null);
  assert.equal(stmt.parseStatement("nonsense"), null);
});

test("totals are filled from the lines when the page gave none", () => {
  const read = stmt.parseStatement({ doc: "bank_statement", money_in: [{ label: "Wages", amount: 3000 }], money_out: [{ label: "Bank fees", amount: 50, kind: "bank_fees" }, { label: "Rent", amount: 1200, kind: "rent" }], totals: {} });
  assert.ok(read && read !== "not_money");
  assert.equal(read.totals.in, 3000);
  assert.equal(read.totals.out, 1250);
  assert.equal(read.totals.fees, 50);
});

test("the read-back is the statement's own figures, in plain words, and ends on the question the buttons answer", () => {
  const read = stmt.parseStatement(MODEL_STATEMENT, "2026-10-30") as import("../api/_lib/statement.ts").StatementRead;
  const text = stmt.explainBack(read, "Lerato");
  assert.match(text, /^Here's what your bank statement says, Lerato \(1 Sep 2026 to 30 Sep 2026, Capitec\):/);
  assert.match(text, /Money in: R4,820\. SASSA child support grant R1,060 \(2 payments\) on the 3rd/);
  assert.match(text, /Money out: R4,788\. The biggest: Shoprite R1,480 \(6 payments\), Cash withdrawals R900 \(3 payments\), Mashonisa \(cash send\) R800 \(4 payments\)/);
  assert.match(text, /Bank fees: R68\./);
  assert.match(text, /below zero on 2 days/);
  assert.match(text, /Left at the end: R32\./);
  assert.match(text, /The page also shows: Debit order to Edgars returned unpaid on the 2nd/);
  assert.match(text, /I keep only the totals and who gets paid, never the account number/);
  assert.match(text, /Does this look like a normal month for you\?$/);
  assert.doesNotMatch(text, /\d{8,}/, "no long number in what is said back");
});

test("a payslip and a credit report are said back in their own terms, with no month question for a credit report", () => {
  const pay = stmt.parseStatement({ doc: "payslip", source: "Shoprite Checkers", period: "September 2026", money_in: [{ label: "Basic pay", amount: 6200 }], money_out: [{ label: "PAYE", amount: 310, kind: "other" }, { label: "UIF", amount: 62, kind: "other" }, { label: "Garnishee order", amount: 450, kind: "loan" }], totals: { in: 6200, out: 822 }, flags: ["Emolument attachment order in force"] }) as import("../api/_lib/statement.ts").StatementRead;
  const payText = stmt.explainBack(pay, "Thabo");
  assert.match(payText, /Pay before deductions: R6,200/);
  assert.match(payText, /Deductions: R822/);
  assert.match(payText, /Lands in your account: R5,378/);
  assert.match(payText, /normal pay month for you\?$/);

  const credit = stmt.parseStatement({ doc: "credit_report", source: "TransUnion", period: null, money_in: [], money_out: [{ label: "Capfin loan", amount: 4100, kind: "loan" }, { label: "Edgars account", amount: 1900, kind: "store_account" }], totals: { out: 6000 }, flags: ["Capfin: 3 months in arrears"] }) as import("../api/_lib/statement.ts").StatementRead;
  const creditText = stmt.explainBack(credit, null);
  assert.match(creditText, /Accounts on it: Capfin loan R4,100, Edgars account R1,900\./);
  assert.match(creditText, /Owed altogether: R6,000\./);
  assert.doesNotMatch(creditText, /normal month/);
});

test("the summary line names its source first, so no prompt can read it as something the person typed", () => {
  const read = stmt.parseStatement(MODEL_STATEMENT, "2026-10-30") as import("../api/_lib/statement.ts").StatementRead;
  const line = stmt.summaryLine(read);
  assert.match(line, /^From the bank statement they sent \(read 2026-10-30, 1 Sep 2026 to 30 Sep 2026, Capitec\): money in R4,820/);
  assert.match(line, /money out R4,788 \(Shoprite R1,480 x6; Cash withdrawals R900 x3; Mashonisa \(cash send\) R800 x4/);
  assert.match(line, /below zero on 2 days; R32 left at the end/);
  assert.match(stmt.summaryLine({ ...read, normal_month: false }), /NOT a normal month/);
  assert.match(stmt.docLine(read), /^Bank statement \(1 Sep 2026 to 30 Sep 2026, Capitec\): in R4,820, out R4,788, bank fees R68, below zero on 2 days$/);
});

test("the budget is three pots from their own lines, and the one move is a round amount from their own numbers", () => {
  const read = stmt.parseStatement(MODEL_STATEMENT, "2026-10-30") as import("../api/_lib/statement.ts").StatementRead;
  const b = stmt.budgetFromStatement(read)!;
  assert.equal(b.income, 4820);
  // loan 800 + insurance 120 + electricity 340 + store account 250
  assert.equal(b.fixed.total, 1510);
  // groceries 1480 + transport 520 + airtime 310
  assert.equal(b.living.total, 2310);
  assert.equal(b.fees, 68);
  assert.equal(b.left, 4820 - 1510 - 2310 - 68);
  assert.equal(b.loose, 900);
  // the smaller of 10% of income (R450, rounded down to R50s) and half of what is left (R466 → R450)
  assert.equal(b.putAway, 450);
  assert.equal(b.costliest!.label, "Mashonisa (cash send)");

  const text = stmt.budgetMessage(read, "Lerato")!;
  assert.match(text, /^Lerato, here's your month in three pots, from your bank statement \(R4,820 in\):/);
  assert.match(text, /Pot 1, what must be paid the day money lands: R1,510\. Mashonisa \(cash send\) R800, Prepaid electricity R340, Edgars account R250, Old Mutual funeral cover R120\./);
  assert.match(text, /Pot 2, food, transport, airtime: R2,310\./);
  assert.match(text, /Pot 3, what's left after those and R68 of bank fees: R932\./);
  assert.match(text, /Last month R900 of it went to cash and other things/);
  assert.match(text, /If R450 of pot 3 moved to a savings pocket on the day money lands/);
  assert.match(text, /Mashonisa \(cash send\) at R800 is the costliest line here/);
  // Rule 11: the costliest loan is named as the costliest money, never as something to refinance.
  assert.doesNotMatch(text, /consolidat|refinanc|cheaper loan/i);
});

test("a month that does not fit the money says so, and never closes the gap with borrowing", () => {
  const read = stmt.parseStatement({ doc: "bank_statement", money_in: [{ label: "Wages", amount: 3000 }], money_out: [{ label: "Rent", amount: 2000, kind: "rent" }, { label: "Food", amount: 1400, kind: "groceries" }], totals: {} }) as import("../api/_lib/statement.ts").StatementRead;
  const text = stmt.budgetMessage(read)!;
  assert.match(text, /short by R400/);
  assert.match(text, /Nothing new gets borrowed to close it/);
  assert.equal(stmt.budgetFromStatement({ ...read, doc: "credit_report" }), null);
});

test("the typed question is recognised whole, and a real question that merely mentions a statement is not", () => {
  for (const s of ["Can you read my bank statement?", "how do i send you my statement", "can I send my payslip", "could you look at my credit report"]) assert.ok(stmt.STATEMENT_ASK.test(s), s);
  for (const s of ["my statement shows a debit order I don't know, what is it?", "can you read my mind", "statement"]) assert.ok(!stmt.STATEMENT_ASK.test(s), s);
});

// ── In a conversation ────────────────────────────────────────────

async function personMidDiagnostic(): Promise<void> {
  const biz = await dbmod.createBusiness(OWNER, "ZA");
  await dbmod.updateBusiness(biz.id, {
    stage: "diag",
    diag_step: 5,
    consent_at: new Date().toISOString(),
    answers: {
      person: "Lerato, I do domestic work three days a week and get two child grants",
      income_kind: "Piece jobs or hustle",
      location: "Diepsloot, Johannesburg",
      objective: "Pay off the mashonisa",
      objective_kind: "Pay something off",
    },
  } as never);
}

test("mid-diagnostic, a statement is read, said back with its three buttons, and stored without an identifier", async () => {
  await personMidDiagnostic();
  net.media.mime = "application/pdf";
  net.media.bytes = new Uint8Array([37, 80, 68, 70, 45]);
  await engine.handleInbound(pdfFrom());

  const text = allText();
  assert.match(text, /Here's what your bank statement says, Lerato/);
  assert.match(text, /Money in: R4,820/);
  assert.deepEqual(lastButtons().map((b) => b.title), ["Normal month", "Not a normal month", "Plan my budget"]);

  const biz = business();
  assert.equal(biz.stage, "diag", "the diagnostic is untouched");
  assert.equal(biz.diag_step, 5);
  assert.equal(biz.statement.doc, "bank_statement");
  assert.doesNotMatch(JSON.stringify(biz.statement), /1234567890123|98765432|5412/);
  assert.match(biz.answers.statement, /^From the bank statement they sent/);
  const inbound = db.tables.messages!.filter((m) => m.direction === "in").map((m) => String(m.text));
  assert.ok(inbound.some((t) => t === "[bank statement sent]"), "the inbound is recorded as a statement, never its contents");
  // Nothing the model was shown is in what was said or stored.
  assert.doesNotMatch(text, /\d{8,}/);
});

test("'Normal month' resumes the question that was open; the income question is then answered from the statement, and 'who do you owe' names its payees", async () => {
  await engine.handleInbound(tapFrom(OWNER, "a.stmt.normal", "Normal month"));
  assert.equal(business().statement.normal_month, true);
  assert.match(business().answers.statement, /They said this is a normal month/);
  assert.match(allText(), /What's getting in the way right now\?/);

  // blockers → depends → income (from the statement, said out loud) → owes (with the payees named)
  net.sent.length = 0;
  await engine.handleInbound(textFrom(OWNER, "1"));
  await engine.handleInbound(textFrom(OWNER, "3"));
  const text = allText();
  assert.match(text, /What comes in: I'll take it from your bank statement, about R4,820 a month/);
  assert.match(business().answers.income, /^About R4,820 a month \(from the bank statement they sent, 1 Sep 2026 to 30 Sep 2026\)$/);
  assert.equal(business().diag_step, 8, "straight on to 'who do you owe'");
  assert.match(text, /Your bank statement shows payments to Mashonisa \(cash send\), Edgars account\. Count those in below\./);
  assert.match(text, /Who do you owe money to right now\?/);
});

test("'Plan my budget' mid-diagnostic sends the three pots and then asks the open question again", async () => {
  await engine.handleInbound(tapFrom(OWNER, "a.stmt.budget", "Plan my budget"));
  const text = allText();
  assert.match(text, /here's your month in three pots/);
  assert.match(text, /Pot 1, what must be paid the day money lands: R1,510/);
  assert.match(text, /Who do you owe money to right now\?/);
  assert.equal(business().diag_step, 8);
});

test("'Not a normal month' is remembered on the statement line, and the income question is asked instead of answered from it", async () => {
  await engine.handleInbound(tapFrom(OWNER, "a.stmt.odd", "Not a normal month"));
  assert.equal(business().statement.normal_month, false);
  assert.match(business().answers.statement, /NOT a normal month/);
  assert.match(allText(), /Tell me in a line what was different/);
  // A fresh person at the income question with an odd-month statement is asked, not answered for.
  const other = "27809930032";
  const b = await dbmod.createBusiness(other, "ZA");
  await dbmod.updateBusiness(b.id, { stage: "diag", diag_step: 6, consent_at: new Date().toISOString(), answers: { person: "Nomsa" }, statement: { ...business().statement, normal_month: false } } as never);
  net.sent.length = 0;
  await engine.handleInbound({ ...textFrom(other, "2"), from: other });
  assert.match(allText(), /Roughly, what comes in a month/);
  assert.equal(db.tables.businesses!.find((x) => x.wa_id === other)!.diag_step, 7);
});

test("the typed question gets the how-to, at any stage, and nothing is stored as an answer", async () => {
  const before = { ...business().answers };
  await engine.handleInbound(textFrom(OWNER, "Can you read my bank statement?"));
  assert.match(allText(), /Send it here as a PDF from your banking app, or a photo of the pages/);
  assert.deepEqual(business().answers, before);
});

test("after the plan, a flyer still goes to the forward reader, and an unreadable statement says so", async () => {
  const biz = business();
  await dbmod.updateBusiness(biz.id, { stage: "plan_ready", identity: { name: "Lerato", earns: "domestic work", one_liner: "x", unsure: null }, context: { name: "Lerato" } } as never);
  modelDoc = { doc: "not_money" };
  extracted = "WHAT IT IS: a loan flyer\nWHAT IT SAYS: Pay R500 to release your R50 000 loan";
  net.media.mime = "image/jpeg";
  net.media.bytes = new Uint8Array([255, 216, 255, 224]);
  await engine.handleInbound({ ...pdfFrom("is this real?"), kind: "image" as const, mimeType: "image/jpeg" });
  assert.match(allText(), /fee before any money/);

  net.sent.length = 0;
  modelDoc = { doc: "not_money" };
  extracted = "UNREADABLE";
  await engine.handleInbound({ ...pdfFrom(""), kind: "image" as const, mimeType: "image/jpeg" });
  assert.match(allText(), /couldn't read that one/);
});

test("after the plan, 'Normal month' offers the budget, and the budget is built from the stored statement", async () => {
  net.media.mime = "application/pdf";
  net.media.bytes = new Uint8Array([37, 80, 68, 70, 45]);
  await engine.handleInbound(pdfFrom());
  assert.deepEqual(lastButtons().map((b) => b.title), ["Normal month", "Not a normal month", "Plan my budget"]);
  net.sent.length = 0;
  await engine.handleInbound(tapFrom(OWNER, "a.stmt.normal", "Normal month"));
  assert.match(allText(), /Want the month laid out as a budget/);
  assert.deepEqual(lastButtons().map((b) => b.title), ["Plan my budget", "Next step"]);
  net.sent.length = 0;
  await engine.handleInbound(tapFrom(OWNER, "a.stmt.budget", "Plan my budget"));
  assert.match(allText(), /Pot 3, what's left/);
});

test("the plan context carries the statement line, in code, and the plan document prints it as a fact row", async () => {
  const build = await import("../api/_lib/engine/build.ts");
  const read = business().statement as import("../api/_lib/statement.ts").StatementRead;
  const ctx = await build.applyContextGuardrails(
    { name: "Lerato", earns: "domestic work", cushion: "nothing", cover: "a burial society", one_liner: "x" },
    { income: "About R4,820 a month", owes: "a mashonisa", statement: stmt.summaryLine(read) },
    { goal: null, rule: null, identity: { name: "Lerato", earns: "domestic work", one_liner: "x", unsure: null }, statement: read },
  );
  assert.match(ctx.statement!, /^Bank statement \(1 Sep 2026 to 30 Sep 2026, Capitec\): in R4,820, out R4,788/);

  const { planDocHTML } = await import("../api/_lib/plandoc.ts");
  const { EXAMPLE_PLAN } = await import("../scripts/example-plan-data.ts");
  const html = planDocHTML({ ...EXAMPLE_PLAN, ctx: { ...EXAMPLE_PLAN.ctx, statement: ctx.statement } });
  assert.match(html, /From your bank statement<\/td>\s*<td[^>]*>Bank statement \(1 Sep 2026 to 30 Sep 2026, Capitec\): in R4,820/);
});

test("the connector's household context carries the statement, and the forget cascade takes it with the household", async () => {
  const connector = await import("../api/_lib/connector.ts");
  const biz = business();
  const out = await connector.callTool(biz as never, "get_household_context", {});
  const structured = out.structured as { statement: { doc: string } };
  assert.equal(structured.statement.doc, "bank_statement");
  assert.doesNotMatch(JSON.stringify(structured.statement), /1234567890123/);
  await engine.handleInbound(textFrom(OWNER, "forget my money"));
  await engine.handleInbound(textFrom(OWNER, "YES"));
  assert.ok(!db.tables.businesses!.some((b) => b.wa_id === OWNER && !b.deleted_at), "the household, statement included, is gone");
});
