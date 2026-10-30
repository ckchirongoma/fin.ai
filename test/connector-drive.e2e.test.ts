// Fin — round 27: the person drives Fin from their own AI.
//
// The founder: "Fin can work via MCP… fully be controlled via MCP through
// chat… it now needs to start remembering things about the person… if the
// person tries to deviate… they get what they're looking for… make sure the
// quality of information is good… remind them the North Star is the plan…
// empathetic, work with them, explain things." And, mid-round: "we used
// research to get here… let's not regress… test for regression."
//
// So this file drives the real MCP endpoint (api/mcp.ts) the way Claude or
// ChatGPT does, against a fake database and network, and checks:
//   1. every action WhatsApp has, the person's AI has, writing the SAME state;
//   2. memory: notes about the person are kept, recalled, forgotten, and
//      reach the WhatsApp answer prompt too;
//   3. the research-backed rules (one recommendation, grounded facts, free
//      first, stabilising, no "you told me") are in what every market's AI
//      is told, so a host model is held to them as WhatsApp is;
//   4. nothing that changes the plan happens without the person's yes on
//      WhatsApp.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.SESSION_SECRET = "fake-session-secret";
process.env.PUBLIC_BASE_URL = "https://fin.test";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
process.env.WORKER_SECRET = "fake-worker-secret";

import { installFakeNet, makeFakeDb, tapFrom, type FakeDb, type FakeNet } from "./_fakes.ts";

const OWNER = "27809930001";
const MODERN = "2026-07-28";
const net: FakeNet = installFakeNet();
let db: FakeDb;
let restore: (() => void) | undefined;
let token = "";

/** The distress verdict the safety judge gives (flag_hardship's second opinion). */
let inDistress = false;
/** What the change model answers after the person's yes (applyChange). */
let changeReply: Record<string, unknown> = { action: "none", step_id: null, tool_id: null, reason: "", message: "" };

net.onModel(/You are a strict checker/, (prompt) => {
  const ids = [...prompt.matchAll(/- "([a-z_]+)":/g)].map((m) => m[1]!);
  return Object.fromEntries(ids.map((id) => [id, id === "distress" ? inDistress : false]));
});
net.onModel(/has said something about it they want changed/, () => changeReply);
/** What the memory step answers, and the prompt it was given (set per test). */
const NOTHING_NEW = { context_updates: null, map_updates: null, decisions: null, commitments: null, results: null, owner_notes: null };
let memoryReply: Record<string, unknown> = NOTHING_NEW;
let memoryPrompt = "";
net.onModel(/You maintain one person's money memory/, (prompt) => {
  memoryPrompt = prompt;
  return memoryReply;
});

const MODEL_ROLES = ["router", "wa_reply", "help", "plan_builder", "safety"].map((role) => ({
  role,
  provider: "openrouter",
  model: `test/${role}`,
  fallbacks: [],
  params: {},
  enabled: true,
}));

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function seed(over: Record<string, unknown> = {}): FakeDb {
  return makeFakeDb({
    businesses: [
      {
        id: "biz-27",
        wa_id: OWNER,
        country: "ZA",
        stage: "step_pushed",
        biz_stage: "surviving",
        pending_action: { kind: "step", step_id: "s1" },
        walk: null,
        last_inbound_at: minutesAgo(30),
        identity: { name: "Thandi", earns: "a salon wage and one child grant", one_liner: "A salon wage in Woodstock, a mashonisa on it" },
        context: { name: "Thandi", earns: "a salon wage and one child grant", location: "Woodstock, Cape Town", goal: "Out of the mashonisa's book by day 60" },
        goal: [{ label: "Out of the mashonisa's book" }],
        rule: [{ label: "Payday first", rule: "The moment money lands, the fixed things get paid first." }],
        map: [
          { domain: "debt", status: "red", note: "A mashonisa at R200 a week" },
          { domain: "cushion", status: "amber", note: "R150 in a tin" },
        ],
        current_plan_id: "plan-27",
        deleted_at: null,
        ...over,
      },
    ],
    business_map: [
      { business_id: "biz-27", domain: "debt", status: "red", note: "A mashonisa at R200 a week" },
      { business_id: "biz-27", domain: "cushion", status: "amber", note: "R150 in a tin" },
    ],
    plans: [{ id: "plan-27", business_id: "biz-27", goal: "Out of the mashonisa's book by day 60", headline: "Ninety days on the money bleeding fastest", created_at: minutesAgo(600) }],
    plan_steps: [
      {
        id: "s1", plan_id: "plan-27", step_order: 0, step_key: "sh1", workstream_title: "Get out of the mashonisa's book", domain: "debt",
        title: "Know what a mashonisa can and cannot do to you", push: "Read the three rules on the NCR page and save the consumer line in your phone.",
        why_for_you: "He is holding your card, and he may not.", done_when: "you have read the rules and saved the number",
        artifact: "I have paid R200 today. Please write it in your book and show me what is left.",
        tool_id: "ncr_complaint", status: "open", pushed_at: minutesAgo(10),
      },
      {
        id: "s2", plan_id: "plan-27", step_order: 1, step_key: "o1", workstream_title: "See every rand you owe", domain: "debt",
        title: "Write down everyone you owe, and what each one costs you", push: "One line each: who, how much is left, what you pay a month, the interest or fee.",
        why_for_you: "The dearest one is rarely the biggest.", done_when: "the list is written, with a cost next to each debt", artifact: null, tool_id: null, status: "open",
      },
      {
        id: "s3", plan_id: "plan-27", step_order: 2, step_key: "cu1", workstream_title: "Build a cushion", domain: "cushion",
        title: "Open the savings pocket and name it", push: "Open a savings pocket in the banking app and name it.",
        why_for_you: "A named pot is harder to raid.", done_when: "the pocket exists with a name", artifact: null, tool_id: "gotyme_goalsave", status: "open",
      },
    ],
    commitments: [{ id: "c1", business_id: "biz-27", plan_step_id: "s1", what: "Know what a mashonisa can and cannot do to you", due: "2026-11-15", status: "open", source: "whatsapp" }],
    tools: [
      { id: "ncr_complaint", country: "ZA", domain: "debt", stages: ["surviving", "stretching"], keywords: ["mashonisa", "loan shark", "card", "complaint", "lender"], name: "NCR consumer line", fits: "any lender dispute", not_when: "a dispute with a bank", why: "The regulator, free, nobody selling anything", cost: "Free", url: "https://www.ncr.org.za", setup: "Call 0860 627 627", walkthrough: ["Call 0860 627 627 from any phone", "Say the lender's name and what they did", "Write down the reference number"], verified_on: new Date().toISOString().slice(0, 10) },
      { id: "gotyme_goalsave", country: "ZA", domain: "cushion", stages: ["surviving", "stretching"], keywords: ["save", "pocket", "goalsave"], name: "GoTyme GoalSave", fits: "a named pot", not_when: "no GoTyme account", why: "A pot the month cannot reach", cost: "Free to open — confirm the rate in the GoTyme app", url: "https://www.gotyme.co.za", setup: "Open the app", walkthrough: ["Open the GoTyme app"], verified_on: new Date().toISOString().slice(0, 10) },
    ],
    model_config: MODEL_ROLES,
    knowledge_entries: [{ id: "k.mashonisa_law", country: "ZA", domain: "debt", stages: ["surviving"], keywords: ["mashonisa", "loan shark", "card", "id"], title: "What a mashonisa may not do", owner_summary: "An unregistered lender cannot keep your card or ID.", applies_when: "a mashonisa holds your card", not_when: "a registered lender", steps: ["Ask for the card back"], cost: "Free", verified_on: new Date().toISOString().slice(0, 10) }],
  });
}

beforeEach(async () => {
  inDistress = false;
  changeReply = { action: "none", step_id: null, tool_id: null, reason: "", message: "" };
  memoryReply = NOTHING_NEW;
  memoryPrompt = "";
  net.sent.length = 0;
  restore?.();
  db = seed();
  const dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  const connector = await import("../api/_lib/connector.ts");
  token = (await connector.issueConnectorToken("biz-27"))!.split("/").pop()!;
});

after(() => {
  restore?.();
  net.restore();
});

let rpcId = 0;
async function call(name: string, args: Record<string, unknown> = {}, modern = false): Promise<{ text: string; isError: boolean; structured: any }> {
  const mcp = await import("../api/mcp.ts");
  const meta = modern ? { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientInfo": { name: "Test", version: "1" } } } : {};
  const res = await mcp.POST(
    new Request(`https://fin.test/api/mcp?k=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(modern ? { "MCP-Protocol-Version": MODERN } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args, ...meta } }),
    }),
  );
  assert.equal(res.status, 200, `${name} answered`);
  const body = await res.json();
  assert.ok(body.result, `${name} returned a result, not a protocol error: ${JSON.stringify(body.error ?? {})}`);
  return { text: body.result.content[0].text, isError: body.result.isError, structured: body.result.structuredContent };
}

const biz = () => db.tables.businesses![0]!;
const step = (id: string) => db.tables.plan_steps!.find((s) => s.id === id)!;
const allSent = () => net.sent.map((m) => m.body).join("\n---\n");

// ── 1. The whole surface ─────────────────────────────────────────

const ALL_TOOLS = [
  "add_commitment", "complete_step", "find_knowledge", "flag_hardship", "forget_note", "get_current_step", "get_household_context", "get_money_map",
  "get_plan", "log_decision", "propose_change", "remember", "report_outcome", "request_plan_change", "send_plan_pdf", "skip_step",
];

test("the person's AI can do everything WhatsApp can: sixteen tools, each with an object schema and a description it can act on", async () => {
  const mcp = await import("../api/mcp.ts");
  for (const modern of [false, true]) {
    const res = await mcp.POST(new Request(`https://fin.test/api/mcp?k=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(modern ? { "MCP-Protocol-Version": MODERN } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: modern ? { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } } : {} }),
    }));
    const tools = (await res.json()).result.tools as { name: string; description: string; inputSchema: { type: string; additionalProperties: boolean } }[];
    assert.deepEqual(tools.map((t) => t.name), ALL_TOOLS, "every tool, in a stable order");
    for (const t of tools) {
      assert.equal(t.inputSchema.type, "object");
      assert.equal(t.inputSchema.additionalProperties, false, `${t.name} refuses arguments it does not know`);
      assert.ok(t.description.length > 60, `${t.name} says when to use it`);
    }
  }
});

// ── 2. The research-backed rules, in every market (regression) ──

test("every market's AI is told Fin's research-backed rules, the north star, and to bring the person back to the plan", async () => {
  const { connectorInstructions } = await import("../api/_lib/prompts.ts");
  const { COUNTRIES } = await import("../api/_lib/countries.ts");
  assert.deepEqual(Object.keys(COUNTRIES).sort(), ["ZA"], "every market is checked");
  for (const cc of Object.keys(COUNTRIES)) {
    const c = COUNTRIES[cc]!;
    const t = connectorInstructions(cc);
    // Rule 3, with the research behind it (HBS field experiment, 640 Kenyan entrepreneurs).
    assert.match(t, /One recommendation, never a menu/);
    assert.match(t, /640 Kenyan entrepreneurs/);
    assert.match(t, /weakest did worse/);
    assert.match(t, /one recommended next step/i);
    // Rule 10: grounded facts only, never from memory.
    assert.match(t, /call find_knowledge first and use only what it returns/);
    assert.match(t, /never fill the gap/);
    assert.match(t, /Where a cost says to confirm, say so/);
    // Rule 9: free first, and stabilising with the country's own free advisor.
    assert.match(t, /Free and reversible before anything that costs money/);
    assert.ok(t.includes(c.advisor), `${cc}: the free advisor is named`);
    assert.match(t, /flag_hardship/);
    // Tax and legal go to this country's own bodies.
    for (const body of [c.tax, c.registrar, c.dataRegulator, c.ombud]) assert.ok(t.includes(body), `${cc}: names ${body}`);
    assert.match(t, /Never state a legal, tax or credit conclusion as certain/);
    // The north star, deviations answered then brought back, kindly.
    assert.match(t, /THE NORTH STAR IS THE 90-DAY PLAN/);
    assert.match(t, /give them what they came for, properly/);
    assert.match(t, /bring it back/);
    assert.match(t, /Never guilt them, never refuse a question for being off the plan/);
    // Empathy and the why.
    assert.match(t, /stressed, stuck or ashamed/);
    // Rule 11: never credit.
    assert.match(t, /Never recommend borrowing of any kind/);
    assert.match(t, /no loan, no consolidation, no buy-now-pay-later/);
    assert.match(t, /Explain the why in plain words, with their own figures/);
    // Rule 8 of the artifact guard: never an invented detail.
    assert.match(t, /Leave a \[bracket\] only for what only they know/);
    // Rule 2 and consent: changes go through the person.
    assert.match(t, /Never tell them a change has been made/);
    assert.match(t, /do not recite it back/);
    assert.match(t, /never an ID, account, card, PIN or password/);
    assert.match(t, /Never ask for an ID number, account number, card number, PIN, OTP or password/);
    assert.ok(t.includes(c.name), `${cc}: the country is named`);
    // Rule 13 of the behaviour matrix.
    assert.doesNotMatch(t, /\b[a-z][\w-]*\/[\w.-]+/i, `${cc}: no provider/model identifier`);
  }
});

test("the instructions reach the host three ways: initialize, server/discover and get_household_context", async () => {
  const mcp = await import("../api/mcp.ts");
  const legacy = await (await mcp.POST(new Request(`https://fin.test/api/mcp?k=${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) }))).json();
  const modern = await (await mcp.POST(new Request(`https://fin.test/api/mcp?k=${token}`, { method: "POST", headers: { "Content-Type": "application/json", "MCP-Protocol-Version": MODERN }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } } }) }))).json();
  const ctx = await call("get_household_context");
  for (const t of [legacy.result.instructions, modern.result.instructions, ctx.structured.instructions]) {
    assert.match(t, /THE NORTH STAR IS THE 90-DAY PLAN/);
    assert.match(t, /South Africa/);
  }
});

// ── 3. Context: the north star, progress, memory ─────────────────

test("get_household_context leads with the north star: the goal and the step they are on, with progress and the online link", async () => {
  const { structured } = await call("get_household_context");
  assert.match(structured.north_star, /Out of the mashonisa's book by day 60/);
  assert.match(structured.north_star, /Step 1 of 3, "Know what a mashonisa can and cannot do to you"/);
  assert.match(structured.north_star, /Done when: you have read the rules and saved the number/);
  assert.deepEqual(structured.progress, { done: 0, skipped: 0, open: 3, total: 3 });
  assert.equal(structured.current_step.id, "s1");
  assert.equal(structured.on_whatsapp, "on a step");
  assert.equal(structured.paused_for_hardship, false);
  assert.match(structured.read_plan_online, /^https:\/\/fin\.test\/plan \(they sign in with their WhatsApp number\)$/);
  assert.deepEqual(structured.remembered, []);
});

test("remember keeps a note about the person once, recalls it, refuses secrets, and forget_note deletes it", async () => {
  const kept = await call("remember", { note: "Paid on Fridays; her sister helps with the children on Saturdays", about: "situation" });
  assert.equal(kept.isError, false);
  assert.match(kept.text, /Remembered/);
  assert.equal(db.tables.owner_notes!.length, 1);
  assert.equal(db.tables.owner_notes![0]!.source, "connector");

  const again = await call("remember", { note: "paid on fridays — her sister helps with the children on Saturdays", about: "situation" });
  assert.match(again.text, /Already remembered/);
  assert.equal(db.tables.owner_notes!.length, 1, "the same note twice is one row");

  for (const secret of ["Her bank PIN is 4471", "ID number 8001015009087", "Her password is braids123", "OTP 482913"]) {
    const no = await call("remember", { note: secret });
    assert.equal(no.isError, true, `refused: ${secret}`);
    assert.match(no.text, /never stores/);
  }
  assert.equal(db.tables.owner_notes!.length, 1, "no secret was stored");

  const ctx = await call("get_household_context");
  assert.equal(ctx.structured.remembered.length, 1);
  assert.equal(ctx.structured.remembered[0].note, "Paid on Fridays; her sister helps with the children on Saturdays");
  assert.equal(ctx.structured.remembered[0].from, "their AI");

  const gone = await call("forget_note", { note_id: ctx.structured.remembered[0].id });
  assert.match(gone.text, /Forgotten/);
  assert.equal(db.tables.owner_notes!.length, 0);
  const missing = await call("forget_note", { note_id: "no-such-note" });
  assert.equal(missing.isError, false);
  assert.match(missing.text, /no note with that id/);
});

test("what the AI remembered reaches WhatsApp's answers too, as background — and with nothing remembered the prompt is unchanged", async () => {
  const context = await import("../api/_lib/engine/context.ts");
  const dbmod = await import("../api/_lib/db.ts");
  const without = await context.buildCore(biz() as any, { query: "mashonisa" });
  assert.doesNotMatch(without.text, /WHAT YOU KNOW ABOUT THEM/, "no notes, no section: the answer prompt is as it was");

  await dbmod.addOwnerNote("biz-27", "worry", "Worried the mashonisa will come to the house if she pays less", "connector");
  const withNote = await context.buildCore(biz() as any, { query: "mashonisa" });
  assert.match(withNote.text, /WHAT YOU KNOW ABOUT THEM/);
  assert.match(withNote.text, /- \(worry\) Worried the mashonisa will come to the house if she pays less/);
  // Rule 2: never quoted as "you told me".
  assert.match(withNote.text, /never say they told you something from this list unless it is also in RECENT CONVERSATION/);
  // Rule 1 asks for the fit only when there is something to fit to.
  assert.match(withNote.text, /1\. Start from their money and their life\. Every answer fits WHAT YOU KNOW ABOUT THEM below/);
  assert.match(without.text, /1\. Start from their money\. If a fact you need is missing/);
  // Everything else in the prompt is the same prompt.
  const rule1 = /1\. Start from their money[^\n]*/;
  assert.equal(withNote.text.replace(/WHAT YOU KNOW ABOUT THEM \(from them[\s\S]*?\n(?=[A-Z]{3,}|\n)/, "").replace(rule1, ""), without.text.replace(rule1, ""));
});

test("WhatsApp's memory step keeps what the person says about themselves, at most two a turn, never a secret", async () => {
  const qa = await import("../api/_lib/engine/qa.ts");
  memoryReply = {
    ...NOTHING_NEW,
    owner_notes: [
      { about: "constraint", note: "Only works mornings; collects her kids at 2" },
      { about: "other", note: "Her card PIN is 1234" },
      { about: "worry", note: "a third note that is never kept" },
    ],
  };
  await qa.updateMemory(biz() as any, "I only work mornings because I fetch my kids at 2. My card pin is 1234", "Noted.");
  assert.match(memoryPrompt, /"owner_notes" is about the PERSON, not the money facts/);
  assert.match(memoryPrompt, /Never record an ID number, account number, card number, PIN, OTP or password/, "the old rules are all still there");
  assert.match(memoryPrompt, /Only record what the PERSON said or confirmed/);
  const notes = db.tables.owner_notes ?? [];
  // Round 29: kept in neutral words — the person never said "her" (round 28, live).
  assert.deepEqual(notes.map((n) => [n.about, n.note, n.source]), [["constraint", "Only works mornings; collects their kids at 2", "whatsapp"]]);
});

test("a tapped suggestion or a forwarded page never becomes a note about the person", async () => {
  const qa = await import("../api/_lib/engine/qa.ts");
  memoryReply = { ...NOTHING_NEW, owner_notes: [{ about: "preference", note: "Wants step-by-step help" }] };
  await qa.afterTurn(biz() as any, "Show me the steps", "Here they are.", { ownerWords: false, forwarded: false, source: "whatsapp" });
  await qa.afterTurn(biz() as any, "check this page", "That page is a scam.", { ownerWords: true, forwarded: true, source: "whatsapp" });
  assert.equal((db.tables.owner_notes ?? []).length, 0);
  await qa.afterTurn(biz() as any, "I like step-by-step help, I'm not techy", "Noted.", { ownerWords: true, forwarded: false, source: "web" });
  assert.deepEqual((db.tables.owner_notes ?? []).map((n) => [n.note, n.source]), [["Wants step-by-step help", "web"]]);
});

test("forgetting the household forgets what Fin remembered about the person", async () => {
  const dbmod = await import("../api/_lib/db.ts");
  await dbmod.addOwnerNote("biz-27", "person", "Prefers voice notes", "connector");
  await dbmod.forgetBusiness("biz-27");
  assert.equal((db.tables.owner_notes ?? []).filter((n) => n.business_id === "biz-27").length, 0);
});

// ── 4. Driving the plan ──────────────────────────────────────────

test("get_current_step hands over the whole step: the words ready to send, how to do it, and the tool's checked cost", async () => {
  const { structured, text } = await call("get_current_step");
  assert.equal(structured.id, "s1");
  assert.equal(structured.position, "Step 1 of 3");
  assert.match(structured.words_ready_to_send, /I have paid R200 today/);
  assert.ok(Array.isArray(structured.how_to), "the library's own how-to lines, when the step has them");
  assert.equal(structured.words_to_fill_in, null);
  assert.equal(structured.tool.name, "NCR consumer line");
  // Rule 10: the cost is the library's, with its check date.
  assert.match(structured.tool.cost, /Free/);
  assert.ok(structured.tool.verified_on);
  assert.deepEqual(structured.tool.set_up.slice(0, 1), ["Call 0860 627 627 from any phone"]);
  assert.equal(structured.after_this, "Write down everyone you owe, and what each one costs you");
  assert.equal(structured.sent_to_whatsapp, null);
  assert.doesNotMatch(text, /Sent to their WhatsApp/);
  assert.equal(net.sent.length, 0, "looking at a step sends nothing to WhatsApp");
});

test("get_current_step never hands over a placeholder as ready to send, and the next step brings its how-to", async () => {
  step("s1").artifact = "Hi, I have paid [amount] today, on [the day]. Please write it in your book.";
  const { structured } = await call("get_current_step");
  assert.equal(structured.words_ready_to_send, null, "blanks are never 'ready'");
  assert.match(structured.words_to_fill_in, /^Fill in the parts in \[brackets\]/);

  await call("complete_step", { step_id: "s1" });
  const next = await call("get_current_step");
  assert.equal(next.structured.id, "s2");
  assert.equal(next.structured.position, "Step 2 of 3");
  assert.ok(next.structured.how_to.length > 0, "the library's own how-to lines for a step with no tool");
  assert.equal(next.structured.tool, null);
});

test("send_to_whatsapp sends the step to their phone inside the 24-hour window, and says why not outside it", async () => {
  step("s1").pushed_at = minutesAgo(30);
  const sent = await call("get_current_step", { send_to_whatsapp: true });
  assert.equal(sent.structured.sent_to_whatsapp, "sent");
  assert.match(allSent(), /Know what a mashonisa can and cannot do to you/);

  net.sent.length = 0;
  biz().last_inbound_at = minutesAgo(60 * 30);
  const closed = await call("get_current_step", { send_to_whatsapp: true });
  assert.equal(closed.structured.sent_to_whatsapp, "window_closed");
  assert.match(closed.text, /within 24 hours of their last message/);
  assert.equal(net.sent.length, 0);
});

test("complete_step marks the step done exactly as WhatsApp's Done does, frees WhatsApp, and asks the AI to ask how it went", async () => {
  const out = await call("complete_step", {});
  assert.equal(out.isError, false);
  assert.match(out.text, /Marked done: "Know what a mashonisa can and cannot do to you" \(1 of 3 done\)/);
  assert.match(out.text, /report_outcome \(step_id s1\)/);
  assert.match(out.text, /The next step is "Write down everyone you owe, and what each one costs you"/);
  assert.equal(step("s1").status, "done");
  assert.ok(step("s1").done_at);
  assert.equal(db.tables.commitments!.find((c) => c.id === "c1")!.status, "done", "no more nudges about a finished step");
  const decision = db.tables.decisions!.at(-1)!;
  assert.equal(decision.what, "Completed: Know what a mashonisa can and cannot do to you");
  assert.equal(decision.source, "connector");
  assert.equal(biz().stage, "plan_ready", "WhatsApp is no longer waiting on that step");
  assert.equal(biz().pending_action, null);
  assert.equal(net.sent.length, 0, "the person is in their AI's chat: nothing extra on WhatsApp");

  const twice = await call("complete_step", { step_id: "s1" });
  assert.match(twice.text, /already marked done/);
  const unknown = await call("complete_step", { step_id: "s99" });
  assert.equal(unknown.isError, true);
});

test("complete_step leaves another WhatsApp flow alone (a question waiting for a yes or no)", async () => {
  biz().stage = "confirm_change";
  biz().pending_action = { kind: "change", change_id: "x" };
  await call("complete_step", { step_id: "s2" });
  assert.equal(step("s2").status, "done");
  assert.equal(biz().stage, "confirm_change");
  assert.deepEqual(biz().pending_action, { kind: "change", change_id: "x" });
});

test("report_outcome records only the person's answer for a finished step, and a 'better' moves the map up", async () => {
  const early = await call("report_outcome", { step_id: "s1", effect: "better" });
  assert.match(early.text, /not marked done yet/, "never an outcome for a step only shown");
  assert.equal((db.tables.outcomes ?? []).length, 0);

  await call("complete_step", { step_id: "s1" });
  const out = await call("report_outcome", { step_id: "s1", effect: "better" });
  assert.match(out.text, /made a difference/);
  const row = db.tables.outcomes!.at(-1)!;
  assert.equal(row.effect, "better");
  assert.equal(row.source, "connector");
  assert.equal(row.plan_step_id, "s1");
  assert.equal(biz().map.find((m: any) => m.domain === "debt").status, "amber", "red -> amber on a reported improvement");

  const again = await call("report_outcome", { step_id: "s1", effect: "same" });
  assert.match(again.text, /already recorded/);
  const bad = await call("report_outcome", { step_id: "s1", effect: "amazing" });
  assert.equal(bad.isError, true);
});

test("skip_step needs the person's reason, drops the step's follow-up, and never skips a finished step", async () => {
  const none = await call("skip_step", {});
  assert.equal(none.isError, true);
  const out = await call("skip_step", { reason: "I paid the mashonisa off last week" });
  assert.match(out.text, /Skipped: "Know what a mashonisa can and cannot do to you"/);
  assert.equal(step("s1").status, "skipped");
  assert.equal(step("s1").skipped_reason, "I paid the mashonisa off last week");
  assert.equal(db.tables.commitments!.find((c) => c.id === "c1")!.status, "dropped");
  await call("complete_step", { step_id: "s2" });
  const done = await call("skip_step", { step_id: "s2", reason: "changed my mind" });
  assert.match(done.text, /already done/);
  assert.equal(step("s2").status, "done");
});

test("request_plan_change changes nothing until the person says yes on WhatsApp — then it goes through the same change flow", async () => {
  const out = await call("request_plan_change", { change: "Drop the step 'Open the savings pocket and name it', I already have a GoalSave pocket", reason: "They opened one last year" });
  assert.equal(out.isError, false);
  assert.match(out.text, /Nothing has changed yet/);
  assert.equal(step("s3").status, "open", "the plan does not move on the AI's say-so");
  const pending = db.tables.proposed_changes!.at(-1)!;
  assert.equal(pending.fact, "plan_steps");
  assert.equal(pending.status, "pending");
  assert.equal(biz().stage, "confirm_change");
  assert.deepEqual(net.sent.flatMap((m) => m.buttons).map((b) => b.id), ["a.chg.yes", "a.chg.no"]);
  assert.match(allSent(), /Your AI passed on a change you want to your plan/);
  assert.equal(biz().context.plan_steps, undefined, "never written into the business facts");

  // The owner says yes on WhatsApp: the change model is asked, and the step comes out.
  changeReply = { action: "drop_step", step_id: "s3", tool_id: null, reason: "already has a savings pocket", message: "Done — dropped." };
  net.sent.length = 0;
  const engine = await import("../api/_lib/engine/index.ts");
  await engine.handleInbound(tapFrom(OWNER, "a.chg.yes", "Yes, change it"));
  assert.equal(db.tables.proposed_changes!.at(-1)!.status, "accepted");
  assert.notEqual(step("s3").status, "open", "dropped on the person's yes");
  assert.ok(net.sent.length > 0, "the person is told what changed");
  assert.equal(biz().context.plan_steps, undefined);
});

test("request_plan_change: a 'no' leaves the plan as it was; outside the window nothing is stored or asked", async () => {
  await call("request_plan_change", { change: "Move 'Build a cushion' first" });
  const engine = await import("../api/_lib/engine/index.ts");
  await engine.handleInbound(tapFrom(OWNER, "a.chg.no", "No, leave it"));
  assert.equal(db.tables.proposed_changes!.at(-1)!.status, "rejected");
  assert.deepEqual(db.tables.plan_steps!.map((s) => [s.id, s.status]), [["s1", "open"], ["s2", "open"], ["s3", "open"]]);

  const before = db.tables.proposed_changes!.length;
  net.sent.length = 0;
  biz().last_inbound_at = minutesAgo(60 * 30);
  biz().stage = "plan_ready";
  const closed = await call("request_plan_change", { change: "Drop the list step" });
  assert.match(closed.text, /Nothing has changed/);
  assert.match(closed.text, /within 24 hours/);
  assert.equal(db.tables.proposed_changes!.length, before, "no question the person can never see");
  assert.equal(biz().stage, "plan_ready", "WhatsApp is not left waiting on it");
  assert.equal(net.sent.length, 0);
});

test("send_plan_pdf queues the plan document for WhatsApp, once, and gives the online link either way", async () => {
  const out = await call("send_plan_pdf");
  assert.match(out.text, /On its way to their WhatsApp/);
  assert.match(out.text, /fin\.test\/plan/);
  const jobs = db.tables.jobs!.filter((j) => j.kind === "plan_pdf");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.payload.mode, "asked");
  assert.equal(jobs[0]!.payload.plan_id, "plan-27");
  await call("send_plan_pdf");
  assert.equal(db.tables.jobs!.filter((j) => j.kind === "plan_pdf").length, 1, "asked twice, sent once");

  biz().last_inbound_at = minutesAgo(60 * 30);
  db.tables.jobs = [];
  const closed = await call("send_plan_pdf");
  assert.match(closed.text, /Not sent/);
  assert.match(closed.text, /fin\.test\/plan/);
  assert.equal(db.tables.jobs.length, 0);
});

test("the queued PDF job sends the document the way a 'Send the PDF' tap does", async () => {
  await call("send_plan_pdf");
  const job = db.tables.jobs!.find((j) => j.kind === "plan_pdf")!;
  const { runPlanPdfJob } = await import("../api/_lib/engine/planpdf.ts");
  net.sent.length = 0;
  await runPlanPdfJob(job as any);
  assert.ok(net.sent.some((m) => m.type === "document"), "the plan arrives as a document");
});

// ── 5. Rule 9 on this door too ───────────────────────────────────

test("flag_hardship: real money trouble pauses the plan on WhatsApp too, and the AI is given the stabilising advice", async () => {
  const out = await call("flag_hardship", { what_they_said: "I can't pay rent this month and the landlord says he will lock us out" });
  assert.match(out.text, /plan is paused/);
  assert.match(out.text, /National Credit Regulator/);
  assert.doesNotMatch(out.text, /loan app|consolidat/i);
  assert.equal(biz().stage, "stabilizing");
  assert.match(biz().answers.since_stabilising, /can't pay rent/);
  assert.ok(db.tables.safety_events!.some((e) => e.check_name === "distress" && e.outcome === "block"));
  assert.match(allSent(), /paused your plan/);

  const next = await call("get_current_step");
  assert.equal(next.structured.paused_for_hardship, true, "no plan step while stabilising");
  assert.doesNotMatch(next.text, /mashonisa can and cannot/);
  const change = await call("request_plan_change", { change: "Add a step to apply for a loan" });
  assert.match(change.text, /paused/);
  const ctx = await call("get_household_context");
  assert.match(ctx.structured.north_star, /paused/);
  assert.equal(ctx.structured.paused_for_hardship, true);
});

test("flag_hardship: a slow week is not a crisis — the judge is asked, and the plan stays", async () => {
  inDistress = false;
  const out = await call("flag_hardship", { what_they_said: "The week was a bit tight" });
  assert.match(out.text, /plan stays as it is/);
  assert.equal(biz().stage, "step_pushed");
  assert.ok(db.tables.safety_events!.some((e) => e.check_name === "distress" && e.outcome === "pass"), "the overruling is a row, not a silence");
});

// ── 6. No plan yet ───────────────────────────────────────────────

test("before there is a plan, every step tool says where they are on WhatsApp instead of failing", async () => {
  db.tables.plans = [];
  db.tables.plan_steps = [];
  biz().stage = "choose_goal";
  biz().current_plan_id = null;
  for (const name of ["get_current_step", "complete_step", "send_plan_pdf"]) {
    const out = await call(name);
    assert.equal(out.isError, false, name);
    assert.match(out.text, /no plan/i, name);
    assert.match(out.text, /choosing the goal to work towards/, name);
  }
  const ctx = await call("get_household_context");
  assert.match(ctx.structured.north_star, /No plan yet/);
  assert.equal(ctx.structured.current_step, null);
});

// ── 7. find_knowledge still grounds, and names who confirms ──────

test("find_knowledge returns the library's facts with check dates and names who confirms a rule in this country", async () => {
  const hit = await call("find_knowledge", { query: "the mashonisa is holding my card, can he do that" });
  assert.equal(hit.structured.tools[0].id, "ncr_complaint");
  assert.match(hit.structured.note, /only these facts/i);
  assert.equal(hit.structured.confirm_with.tax, "SARS");
  assert.equal(hit.structured.confirm_with.personal_data, "the Information Regulator");
  assert.match(hit.structured.confirm_with.disputes, /National Financial Ombud/);
  const miss = await call("find_knowledge", { query: "aircraft maintenance certification" });
  assert.match(miss.structured.note, /Nothing in the library matched this/);
  assert.match(miss.structured.note, /confirm_with/);
});

test("the modern protocol era drives the same tools", async () => {
  const out = await call("get_current_step", {}, true);
  assert.equal(out.structured.id, "s1");
});

// ── 8. Regressions found reviewing this round ────────────────────

test("during a rebuild the old plan is not worked: no step pushed, ticked or asked about, and WhatsApp stays in the build", async () => {
  // "Build the next 90": the last plan is still the newest row while the next is put together.
  biz().stage = "clarify_objective";
  biz().pending_action = { kind: "rebuild" };
  biz().current_plan_id = null;
  step("s1").pushed_at = minutesAgo(30);
  for (const [name, args] of [["get_current_step", { send_to_whatsapp: true }], ["complete_step", {}], ["skip_step", { reason: "x" }], ["send_plan_pdf", {}], ["request_plan_change", { change: "drop the list step" }]] as const) {
    const out = await call(name, args as Record<string, unknown>);
    assert.match(out.text, /being put together on WhatsApp/, name);
  }
  const fact = await call("propose_change", { fact: "earns", to: "a salon wage and a weekend piece job", reason: "the Saturday job is half the income now" });
  assert.match(fact.text, /Nothing has changed, and nothing was asked/);
  assert.deepEqual(db.tables.plan_steps!.map((x) => x.status), ["open", "open", "open"]);
  assert.equal(biz().stage, "clarify_objective", "the build is not interrupted");
  assert.deepEqual(biz().pending_action, { kind: "rebuild" });
  assert.equal((db.tables.proposed_changes ?? []).length, 0);
  assert.equal(net.sent.length, 0);
  const ctx = await call("get_household_context");
  assert.match(ctx.structured.north_star, /A new 90-day plan is being put together on WhatsApp/);
});

test("before db/0032 runs, answers carry on with no memory, the failure says which file to run, and the table is not asked again every turn", async () => {
  const dbmod = await import("../api/_lib/db.ts");
  const context = await import("../api/_lib/engine/context.ts");
  const track = await import("../api/_lib/track.ts");
  dbmod.__resetNotesBackoff();
  const client = db.client as unknown as { from: (t: string) => unknown };
  const orig = client.from.bind(client);
  let asked = 0;
  const missing = { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.owner_notes' in the schema cache" } };
  const chain: any = new Proxy({}, {
    get: (_t, prop) => (prop === "then" ? (ok: (v: unknown) => void) => ok(missing) : () => chain),
  });
  client.from = (t: string) => (t === "owner_notes" ? (asked++, chain) : orig(t));
  try {
    const core = await context.buildCore(biz() as any, { query: "mashonisa" });
    assert.doesNotMatch(core.text, /WHAT YOU KNOW ABOUT THEM/);
    assert.match(core.text, /KNOWLEDGE/, "the answer prompt is whole");
    await context.buildCore(biz() as any, { query: "mashonisa" });
    assert.equal(asked, 1, "found missing once, then left alone for a while");
    const kept = await call("remember", { note: "Prefers voice notes" });
    assert.equal(kept.isError, true);
    assert.match(kept.text, /Could not save/);
    if (process.env.TRACKING_OFF !== "1") {
      const failed = [...track.__pendingEvents(), ...((db.tables.events ?? []) as any[])].filter((e) => e.name === "owner_notes_failed");
      assert.ok(failed.some((e) => e.fingerprint === "owner_notes_failed:read:missing_table" && e.props.missing_table === true), "filed as the missing table");
    }
    // The alert's own words name the file to run.
    const { readFileSync } = await import("node:fs");
    assert.match(readFileSync(new URL("../api/_lib/db.ts", import.meta.url), "utf8"), /the owner_notes table is missing \(run db\/0032_owner_notes\.sql\)/);
  } finally {
    client.from = orig;
    dbmod.__resetNotesBackoff();
  }
});

test("the WhatsApp 'connect' message tells the person truthfully what their AI can now do, and that changes still come back to them", async () => {
  const { textFrom } = await import("./_fakes.ts");
  const engine = await import("../api/_lib/engine/index.ts");
  db.tables.connector_tokens = [];
  net.sent.length = 0;
  await engine.handleInbound(textFrom(OWNER, "connect"));
  const all = allSent();
  assert.match(all, /tick it off when you've done it/);
  assert.match(all, /remember things you tell it about how you work/);
  assert.match(all, /It can't change your plan on its own — if it suggests a change, I ask you here first/);
  for (const m of net.sent) assert.ok(m.body.length <= 4096, "within WhatsApp's text limit");
});
