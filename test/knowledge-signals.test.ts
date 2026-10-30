// Fin — knowledge signals (db/0015): the cheap, automatic capture half.
//
// What this pins:
//   - a correction-shaped owner message writes a `correction` row, tied to the
//     tool it names, with the owner's words verbatim;
//   - an outcome report writes an `outcome_report` row — typed, or typed in
//     reply to "has it made a difference?" (no classification needed there);
//   - a retrieval gap writes an `unanswered_question` row;
//   - an ordinary message costs NOTHING: no classification call at all;
//   - MCP log_decision / propose_change write a row with no model call and no
//     Jev call;
//   - the classification is typed (true/false propositions), never generation;
//   - the admin endpoint needs the worker secret and returns grouped data;
//   - "forget my money" takes the owner's signals with it.

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
process.env.WORKER_SECRET = "ks-worker-secret";
process.env.TYPESAFE_API_KEY = "fake-jev-key";
delete process.env.CRON_SECRET;

import { installFakeNet, makeFakeDb, tapFrom, textFrom, type FakeDb, type FakeNet } from "./_fakes.ts";

const today = new Date().toISOString().slice(0, 10);
const TOOL = (id: string, name: string, cost: string) => ({
  id, country: "ZA", domain: "spending", stages: ["run"], keywords: [id, "card machine"], name, fits: "x", not_when: "y", why: "z",
  cost, url: `https://${id}.example`, setup: "order online", walkthrough: ["Open it.", "Sign up."], verified_on: today,
});

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let dbmod: typeof import("../api/_lib/db.ts");
let engine: typeof import("../api/_lib/engine/index.ts");
let steps: typeof import("../api/_lib/engine/steps.ts");
let connector: typeof import("../api/_lib/connector.ts");
let signals: typeof import("../api/_lib/signals.ts");
let endpoint: typeof import("../api/knowledge-signals.ts");

/** What the fake Jev says about the knowledge_signal propositions, per test. */
let verdict: { correction: number; outcome_report: number } = { correction: 0.1, outcome_report: 0.1 };
/** Per-test stand-ins for the router and the answer writer; null means the defaults below. */
let routerFor: ((prompt: string) => unknown) | null = null;
let answerFor: ((prompt: string) => unknown) | null = null;
let memoryFor: ((prompt: string) => unknown) | null = null;

before(async () => {
  net = installFakeNet();
  const roles = ["router", "wa_reply", "help", "plan_builder", "safety"].map((role) => ({
    role, provider: "openrouter", model: "test/model", fallbacks: [], params: {}, enabled: true,
  }));
  db = makeFakeDb({
    model_config: roles,
    tools: [TOOL("yoco", "Yoco", "machine from R699; 2.3% per card payment"), TOOL("yoco_capital", "Yoco Capital", "fixed fee")],
  });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  engine = await import("../api/_lib/engine/index.ts");
  steps = await import("../api/_lib/engine/steps.ts");
  connector = await import("../api/_lib/connector.ts");
  signals = await import("../api/_lib/signals.ts");
  endpoint = await import("../api/knowledge-signals.ts");

  net.onModel(/Classify this message from a person to their money assistant/, (p) => routerFor?.(p) ?? ({
    intent: "question", domain: "spending", tool_need: null, missing_fact: null, risk: [], search_terms: "card machine",
  }));
  net.onModel(/ROUTER RESULT/, (p) => answerFor?.(p) ?? ({ message: "Thanks — worth checking your statement.", artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: "spending" }));
  net.onModel(/You maintain one person's money memory/, (p) => memoryFor?.(p) ?? ({ context_updates: null, map_updates: null, decisions: null, commitments: null, results: null }));
});

after(() => {
  restore?.();
  net?.restore();
});

beforeEach(() => {
  net.sent.length = 0;
  net.jev.calls.length = 0;
  verdict = { correction: 0.1, outcome_report: 0.1 };
  routerFor = null;
  answerFor = null;
  memoryFor = null;
  // Every judged check passes, except the two knowledge-signal propositions, which say what `verdict` says.
  net.jev.handler = (payload) => {
    const out: Record<string, unknown> = {};
    for (const id of Object.keys(payload.questions)) {
      out[id] = { type: "noul", noul: id === "correction" ? verdict.correction : id === "outcome_report" ? verdict.outcome_report : 0.05 };
    }
    return out;
  };
});

const signalCalls = () => net.jev.calls.filter((c) => "correction" in c.questions && "outcome_report" in c.questions);
const signalsFor = (bizId: string) => db.tables.knowledge_signals!.filter((s) => s.business_id === bizId);

let n = 0;
async function readyBiz(wa: string) {
  const biz = await dbmod.createBusiness(wa, "ZA");
  const planId = `plan-ks-${++n}`;
  db.tables.plans!.push({ id: planId, business_id: biz.id, goal: "g", headline: "", strategy: null, created_at: new Date().toISOString() });
  db.tables.plan_steps!.push({
    id: `step-ks-${n}`, plan_id: planId, workstream_title: "Get paid", domain: "spending", step_order: 1, step_key: "p1",
    title: "Take payment without cash", push: "Get a card machine.", artifact: null, tool_id: "yoco", why_for_you: "",
    done_when: "one card payment taken", status: "open", pushed_at: null, done_at: null, skipped_reason: null,
  });
  await dbmod.updateBusiness(biz.id, { stage: "plan_ready", context: { name: "Lindi's Braids", location: "Soweto" } } as never);
  return (await dbmod.findBusiness(wa))!;
}

describe("capture from the owner's own WhatsApp messages", () => {
  test("a correction of a stored fact writes one `correction` row, tied to the tool, quote verbatim", async () => {
    const biz = await readyBiz("27809940001");
    verdict = { correction: 0.9, outcome_report: 0.2 };
    const said = "Yoco is not 2.3% anymore, they charged me 2.9% on every card sale last week";
    await engine.handleInbound(textFrom(biz.wa_id, said));

    const rows = signalsFor(biz.id).filter((s) => s.signal_type === "correction");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.source, "whatsapp");
    assert.equal(rows[0]!.related_entity_type, "tool");
    assert.equal(rows[0]!.related_entity_id, "yoco", "the longest matching name wins, and 'Yoco' is not 'Yoco Capital'");
    assert.equal(rows[0]!.raw_quote, said);
    assert.equal(rows[0]!.status, "new");
    assert.equal(rows[0]!.country, "ZA");
    assert.match(rows[0]!.candidate_claim, /stored fact is wrong.*Yoco/);

    // Unmistakable (a named product, "not … anymore", a percentage its row
    // doesn't have), so it is caught by rule — no judgement call spent.
    assert.equal(signalCalls().length, 0);
    assert.match(rows[0]!.candidate_claim, /a figure the library doesn't have/);
  });

  test("an outcome report writes one `outcome_report` row", async () => {
    const biz = await readyBiz("27809940002");
    verdict = { correction: 0.2, outcome_report: 0.9 };
    await engine.handleInbound(textFrom(biz.wa_id, "I tried Yoco and the money took 3 days to reach my bank, not 1-2"));
    const rows = signalsFor(biz.id).filter((s) => s.signal_type === "outcome_report");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.related_entity_id, "yoco");
  });

  test("the classification is typed: two true/false propositions, nothing generated", async () => {
    const biz = await readyBiz("27809940003");
    await engine.handleInbound(textFrom(biz.wa_id, "Yoco charged me R50 more than I expected this week"));
    const call = signalCalls().at(-1);
    assert.ok(call, "the one classification ran");
    for (const q of Object.values(call!.questions)) assert.equal((q as { type: string }).type, "noul");
    assert.deepEqual(Object.keys(call!.questions).sort(), ["correction", "outcome_report"]);
  });

  test("when the classifier says neither, nothing is written", async () => {
    const biz = await readyBiz("27809940004");
    await engine.handleInbound(textFrom(biz.wa_id, "Yoco charged me R50 more than I expected this week"));
    assert.equal(signalsFor(biz.id).filter((s) => s.signal_type !== "unanswered_question").length, 0);
  });

  test("an ordinary message costs nothing: no classification call at all", async () => {
    const biz = await readyBiz("27809940005");
    await engine.handleInbound(textFrom(biz.wa_id, "should I put my prices up?"));
    assert.equal(signalCalls().length, 0);
    assert.equal(signalsFor(biz.id).filter((s) => s.signal_type !== "unanswered_question").length, 0);
  });

  test("a sentence typed in reply to 'has it made a difference?' is an outcome report, with no classification", async () => {
    const biz = await readyBiz("27809940006");
    await steps.pushNextStep(biz);
    await engine.handleInbound(tapFrom(biz.wa_id, "a.step.done", "Done"));
    net.jev.calls.length = 0;
    await engine.handleInbound(textFrom(biz.wa_id, "customers love tapping, but the payout took three days"));
    const rows = signalsFor(biz.id).filter((s) => s.signal_type === "outcome_report");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.related_entity_id, "yoco", "tied to the step's own tool");
    assert.equal(signalCalls().length, 0);
  });

  test("a bare 'yes' to that question is not a signal", async () => {
    const biz = await readyBiz("27809940007");
    await steps.pushNextStep(biz);
    await engine.handleInbound(tapFrom(biz.wa_id, "a.step.done", "Done"));
    await engine.handleInbound(textFrom(biz.wa_id, "yes"));
    assert.equal(signalsFor(biz.id).length, 0);
  });
});

describe("retrieval gaps", () => {
  test("a question the library can't match writes an `unanswered_question` row next to its retrieval_gaps row", async () => {
    const { shortlist } = await import("../api/_lib/retrieval.ts");
    const before = db.tables.knowledge_signals!.length;
    await shortlist([], [], { text: "can I sell at the taxi rank on a Sunday deposit", stage: "run" }, { businessId: "b-gap", country: "ZA", quote: "can I sell at the taxi rank on a Sunday" });
    const row = db.tables.knowledge_signals!.slice(before).find((s) => s.signal_type === "unanswered_question");
    assert.ok(row);
    assert.equal(row!.raw_quote, "can I sell at the taxi rank on a Sunday");
    assert.equal(row!.source, "whatsapp");
    assert.equal(row!.related_entity_id, null);
  });
});

describe("the MCP connector", () => {
  test("log_decision and propose_change each write a signal with no model call and no Jev call", async () => {
    const biz = await readyBiz("27809940010");
    const models = net.modelCalls.length;
    const jev = net.jev.calls.length;

    await connector.callTool(biz, "log_decision", { what: "Switched from Yoco to cash-only on weekends", why: "the fee ate the margin" });
    await connector.callTool(biz, "propose_change", { fact: "cushion", to: "R500 in a savings pocket", reason: "they opened one last week" });

    assert.equal(net.modelCalls.length, models, "no model call");
    assert.equal(net.jev.calls.length, jev, "no Jev call");
    const rows = signalsFor(biz.id).filter((s) => s.source === "mcp");
    assert.equal(rows.length, 2);
    const decision = rows.find((r) => /Switched from Yoco/.test(r.raw_quote))!;
    assert.equal(decision.related_entity_id, "yoco");
    assert.match(decision.raw_quote, /Switched from Yoco.*the fee ate the margin/);
    const change = rows.find((r) => /cushion: /.test(r.raw_quote))!;
    assert.match(change.raw_quote, /cushion: .* -> "R500 in a savings pocket"/);
    assert.equal(change.signal_type, "new_fact_candidate", "a change to their OWN business details is not a library correction");
    assert.equal(change.related_entity_id, null, "and is tied to no library row, so it can't count as corroboration");
  });

  test("a find_knowledge miss is a gap with source 'mcp'", async () => {
    const biz = await readyBiz("27809940011");
    await connector.callTool(biz, "find_knowledge", { query: "can I sell at the taxi rank on a Sunday" });
    const row = signalsFor(biz.id).find((s) => s.signal_type === "unanswered_question");
    assert.ok(row);
    assert.equal(row!.source, "mcp");
  });
});

describe("entity matching and the free pre-filter", () => {
  test("whole names only, longest first", () => {
    const tools = [{ id: "yoco", name: "Yoco" }, { id: "yoco_capital", name: "Yoco Capital" }, { id: "sourcefin", name: "Sourcefin (purchase order funding)" }];
    assert.equal(signals.matchEntity("Yoco Capital said no", tools)?.id, "yoco_capital");
    assert.equal(signals.matchEntity("my yoco machine", tools)?.id, "yoco");
    assert.equal(signals.matchEntity("Sourcefin wanted R250k minimum", tools)?.id, "sourcefin");
    assert.equal(signals.matchEntity("yocoshop is different", tools), null);
  });

  test("the pre-filter lets through only what could be a correction or report", () => {
    const e = { type: "tool" as const, id: "yoco", name: "Yoco" };
    assert.equal(signals.mightBeSignal("hi", null), false);
    assert.equal(signals.mightBeSignal("how do I get more customers", null), false);
    assert.equal(signals.mightBeSignal("Yoco took three days to pay", e), true);
    assert.equal(signals.mightBeSignal("the CIPC fee is R200 now, not R175", null), true);
  });
});

describe("the admin endpoint", () => {
  const url = "https://fin.example/api/knowledge-signals";
  const auth = { Authorization: "Bearer ks-worker-secret" };

  test("refuses without the worker secret", async () => {
    assert.equal((await endpoint.GET(new Request(url))).status, 403);
    assert.equal((await endpoint.GET(new Request(url, { headers: { Authorization: "Bearer nope" } }))).status, 403);
  });

  test("returns real grouped data, most independently corroborated first", async () => {
    for (const wa of ["27809940020", "27809940021"]) {
      const b = await readyBiz(wa);
      await dbmod.recordKnowledgeSignal({ source: "whatsapp", businessId: b.id, country: "ZA", type: "correction", entity: { type: "tool", id: "yoco_capital" }, rawQuote: "Yoco Capital fee went up" });
    }
    const res = await endpoint.GET(new Request(`${url}?status=new`, { headers: auth }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.total >= 2);
    const g = body.groups.find((x: { entity_id: string }) => x.entity_id === "yoco_capital");
    assert.equal(g.distinct_businesses, 2);
    assert.equal(g.by_type.correction, 2);
    assert.equal(body.groups[0].distinct_businesses >= g.distinct_businesses, true);
    assert.ok(!("business_id" in g.rows[0]), "rows never carry the business id");
  });

  test("review marks signals, and refuses a decision without a reason", async () => {
    // Postgres ids are bigints; the fake mints strings, so give these real-shaped ones.
    const rows = db.tables.knowledge_signals!.filter((s) => s.related_entity_id === "yoco_capital");
    rows.forEach((r, i) => (r.id = 900001 + i));
    const ids = rows.map((s) => s.id as number);
    const post = (body: unknown) => endpoint.POST(new Request(`${url}?action=review`, { method: "POST", headers: auth, body: JSON.stringify(body) }));
    assert.equal((await post({ ids, status: "rejected", reviewed_by: "agent" })).status, 400, "no notes");
    assert.equal((await post({ ids, status: "deleted", notes: "x", reviewed_by: "agent" })).status, 400, "bad status");
    const ok = await post({ ids, status: "rejected", notes: "Yoco's own pricing page (checked 2026-09-23) shows no change.", reviewed_by: "promotion-pass" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).updated, ids.length);
    const row = db.tables.knowledge_signals!.find((s) => s.id === ids[0])!;
    assert.equal(row.status, "rejected");
    assert.equal(row.reviewed_by, "promotion-pass");
    assert.ok(row.reviewed_at);
  });
});

describe("privacy and cost", () => {
  test("forget my money deletes the owner's signals", async () => {
    const biz = await readyBiz("27809940030");
    await dbmod.recordKnowledgeSignal({ source: "whatsapp", businessId: biz.id, country: "ZA", type: "correction", rawQuote: "my own words" });
    assert.equal(signalsFor(biz.id).length, 1);
    await dbmod.forgetBusiness(biz.id);
    assert.equal(signalsFor(biz.id).length, 0);
  });

  test("the model-backstop checker prompt puts its fixed text first and the per-call material last, so it can be prefix-cached", async () => {
    const { judge } = await import("../api/_lib/safety.ts");
    const env = (await import("../api/_lib/env.ts")).env as unknown as Record<string, string | undefined>;
    env.TYPESAFE_API_KEY = "";
    let prompt = "";
    net.onModel(/You are a strict checker/, (p) => ((prompt = p), { a: false }));
    try {
      await judge("cache_shape", { per_call: "UNIQUE-MATERIAL-123" }, { a: "Is it so?" }, 0.7, {});
    } finally {
      env.TYPESAFE_API_KEY = "fake-jev-key";
    }
    assert.ok(prompt.indexOf("QUESTIONS") < prompt.indexOf("UNIQUE-MATERIAL-123"));
    assert.ok(prompt.trimEnd().endsWith("}"), "the material is the last thing in the prompt");
  });
});

// ── Findings from the independent review of 3aad635 ──

describe("review round 2", () => {
  test("a forwarded document's text and the router's terms never reach raw_quote", async () => {
    const biz = await readyBiz("27809940040");
    net.onModel(/a document the owner forwarded|a photo the owner forwarded/, () => ({ message: "That looks like an invoice.", artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: null }));
    const { answer } = await import("../api/_lib/engine/qa.ts");
    await answer(biz, "what is this qqqq", { kind: "image", text: "INVOICE from Thabo Mokoena ID 8001015009087, call 0821234567" } as never);
    for (const r of signalsFor(biz.id)) assert.doesNotMatch(r.raw_quote, /8001015009087|Mokoena|0821234567/);
    assert.equal(signalsFor(biz.id).length, 0, "no signal at all from forwarded content");
  });

  test("a tapped quick reply (Fin's own words) is never captured as the owner's", async () => {
    const biz = await readyBiz("27809940041");
    verdict = { correction: 0.95, outcome_report: 0.1 };
    await engine.handleInbound(tapFrom(biz.wa_id, "a.q.0:Is Yoco still R699 now", "Is Yoco still R699 now"));
    assert.equal(signalCalls().length, 0);
    assert.equal(signalsFor(biz.id).length, 0);
  });


  test("questions never cost a classification; with no product named, a money amount is required", () => {
    const e = { type: "tool" as const, id: "yoco", name: "Yoco" };
    for (const q of ["how much does Yoco cost per month now?", "what's a good price for a 2 hour session", "do I need a business bank account now or later", "is 5% too much"]) {
      assert.equal(signals.mightBeSignal(q, q.includes("Yoco") ? e : null), false, q);
    }
    assert.equal(signals.mightBeSignal("I have 3 kids and the shop is busy now", null), false, "a digit is not a money amount");
    assert.equal(signals.mightBeSignal("the CIPC fee is R200 now, not R175", null), true);
  });

  test("a connected AI's decision mentioning a tool does not count as an owner corroborating a claim about it", () => {
    const row = (id: number, biz: string, type: string) => ({ id, created_at: "2026-09-23T00:00:00Z", source: "mcp", business_id: biz, country: "ZA", signal_type: type, related_entity_type: "tool", related_entity_id: "yoco", raw_quote: "x", candidate_claim: null, status: "new", reviewed_at: null, reviewed_by: null, notes: null });
    const [g] = endpoint.groupSignals([row(1, "a", "new_fact_candidate"), row(2, "b", "new_fact_candidate"), row(3, "c", "correction")] as never);
    assert.equal(g!.distinct_businesses, 1, "only the correction counts");
    assert.equal(g!.distinct_businesses_any, 3);
  });

  test("a second review appends to the notes instead of erasing the cited source", async () => {
    const b = await readyBiz("27809940042");
    await dbmod.recordKnowledgeSignal({ source: "whatsapp", businessId: b.id, country: "ZA", type: "correction", rawQuote: "fee changed" });
    const row = signalsFor(b.id)[0]!;
    row.id = 910001;
    await dbmod.reviewKnowledgeSignals([910001], { status: "promoted", reviewedBy: "pass-1", notes: "source: yoco.com/za/pricing (checked 2026-10-01); PR #99" });
    await dbmod.reviewKnowledgeSignals([910001], { status: "reviewed", reviewedBy: "pass-2", notes: "PR #99 not merged" });
    assert.match(row.notes, /yoco\.com\/za\/pricing[\s\S]*PR #99 not merged/);
    assert.equal(row.status, "reviewed");
  });

  test("the endpoint opens with SIGNALS_ADMIN_SECRET, and never with CRON_SECRET", async () => {
    const env = (await import("../api/_lib/env.ts")).env as unknown as Record<string, string>;
    env.SIGNALS_ADMIN_SECRET = "signals-only";
    env.CRON_SECRET = "cron-secret";
    try {
      const url = "https://fin.example/api/knowledge-signals";
      assert.equal((await endpoint.GET(new Request(url, { headers: { Authorization: "Bearer signals-only" } }))).status, 200);
      assert.equal((await endpoint.GET(new Request(url, { headers: { Authorization: "Bearer cron-secret" } }))).status, 403);
    } finally {
      env.SIGNALS_ADMIN_SECRET = "";
      env.CRON_SECRET = "";
    }
  });

  test("a quote cut at 2,000 characters never splits an emoji", async () => {
    const b = await readyBiz("27809940043");
    await dbmod.recordKnowledgeSignal({ source: "whatsapp", businessId: b.id, country: "ZA", type: "correction", rawQuote: "a".repeat(1999) + "😀😀" });
    const q = signalsFor(b.id)[0]!.raw_quote as string;
    assert.equal(Array.from(q).length, 2000);
    assert.ok(!/[\uD800-\uDBFF]$/.test(q), "no lone high surrogate at the end");
  });

  test("with no engine at all, capture raises no guardrails-down alarm", async () => {
    const env = (await import("../api/_lib/env.ts")).env as unknown as Record<string, string>;
    const saved = { j: env.TYPESAFE_API_KEY, o: env.OPENROUTER_API_KEY };
    env.TYPESAFE_API_KEY = "";
    env.OPENROUTER_API_KEY = "";
    try {
      const before = db.tables.safety_events!.filter((e) => e.outcome === "unavailable").length;
      await signals.captureConversationSignal({ text: "Yoco charged me R50 more this week", source: "whatsapp", businessId: null, country: "ZA", tools: [{ id: "yoco", name: "Yoco" }] });
      assert.equal(db.tables.safety_events!.filter((e) => e.outcome === "unavailable").length, before);
    } finally {
      env.TYPESAFE_API_KEY = saved.j;
      env.OPENROUTER_API_KEY = saved.o;
    }
  });
});

// ── Live finding 2026-09-23: zero signals, and no way to tell why ──

describe("every capture decision is on the record", () => {
  const notes = (bizId: string) => db.tables.safety_events!.filter((e) => e.business_id === bizId && e.check_name === "knowledge_signal").map((e) => e.detail as string);

  test("a skipped message says why it was skipped", async () => {
    const biz = await readyBiz("27809940050");
    await engine.handleInbound(textFrom(biz.wa_id, "should I put my prices up?"));
    assert.ok(notes(biz.id).some((d) => /^skipped: /.test(d)), JSON.stringify(notes(biz.id)));
  });

  test("a judged message records the scores, captured or not", async () => {
    const biz = await readyBiz("27809940051");
    verdict = { correction: 0.4, outcome_report: 0.3 };
    await engine.handleInbound(textFrom(biz.wa_id, "I used Yoco last week and it worked fine"));
    assert.ok(notes(biz.id).some((d) => /judged neither \(correction=0\.4 outcome_report=0\.3; needs > 0\.7\)/.test(d)), JSON.stringify(notes(biz.id)));
  });

  test("a failed insert is on the record, not only in the function log", async () => {
    const biz = await readyBiz("27809940052");
    const saved = db.tables.knowledge_signals;
    delete (db.tables as Record<string, unknown>).knowledge_signals; // as if db/0015 had not been applied
    try {
      const client = db.client as unknown as { from: (t: string) => unknown };
      const orig = client.from.bind(client);
      client.from = (t: string) => (t === "knowledge_signals" ? { insert: async () => ({ data: null, error: { message: "relation \"knowledge_signals\" does not exist" } }) } : orig(t));
      await dbmod.recordKnowledgeSignal({ source: "whatsapp", businessId: biz.id, country: "ZA", type: "correction", rawQuote: "x changed" });
      client.from = orig;
    } finally {
      db.tables.knowledge_signals = saved;
    }
    const row = db.tables.safety_events!.find((e) => e.business_id === biz.id && (e.flags as string[]).includes("write_failed"));
    assert.ok(row, "the failure left a row");
    assert.match(row!.detail, /does not exist/);
    assert.notEqual(row!.outcome, "unavailable", "not a guardrail outage, so no health alarm");
  });

  test("the rule only fires on a changed figure of the kind the library states", () => {
    const e = { type: "tool" as const, id: "yoco", name: "Yoco" };
    const lib = "cost: machine from R699; 2.3% per card payment";
    assert.equal(signals.obviousCorrection("Yoco is not 2.3% anymore, they charged me 2.9%", e, lib), true);
    assert.equal(signals.obviousCorrection("the Yoco machine is R899 now, not R699", e, lib), true);
    assert.equal(signals.obviousCorrection("I tried Yoco and it took 3 days, not 1-2", e, lib), false, "days are not a price");
    assert.equal(signals.obviousCorrection("Yoco is still 2.3%", e, lib), false, "same figure, no change");
    assert.equal(signals.obviousCorrection("Yoco charged 2.9%", e, lib), false, "no word saying it changed");
  });
});

// ── Live, 2026-09-23 (later): three messages, two notes ──
//
// An owner with a plan sent a Yoco correction, "can I sell at the taxi rank
// on a Sunday", and "should I put my prices up?" — each after the previous
// reply — and only two knowledge_signal notes were written. The note used to
// be written only from afterTurn(), and answer()'s notice/error return (and
// every non-answer path in the dispatcher) never reached it.

describe("every owner turn leaves exactly one knowledge_signal note", () => {
  const notes = (bizId: string) => db.tables.safety_events!.filter((e) => e.business_id === bizId && e.check_name === "knowledge_signal").map((e) => e.detail as string);
  const PRICES_UP = "should I put my prices up?";

  test("the live sequence: a correction, a question, and a pricing question the router takes elsewhere — three notes", async () => {
    const biz = await readyBiz("27809940060");
    // The third message routes away from the library answer: here, the
    // router reads it as strain. Before the fix this path replied and
    // returned with no note.
    //
    // Live test, 2026-09-25 (r10/distress): the router's word alone no longer
    // switches a business into stabilising mode — the message has to carry
    // money or crisis language itself (safety.ts saysMoneyTrouble). A bare
    // "should I put my prices up?" would now be overruled and answered from
    // the library, so the message says why: this test is about the distress
    // path leaving its note, and the path must actually be taken.
    routerFor = (p) => (p.includes(PRICES_UP) ? { intent: "question", domain: "family_money", tool_need: null, missing_fact: null, risk: ["distress"], search_terms: "raise prices" } : null);
    for (const said of [
      "Yoco is not 2.3% anymore, they charged me 2.9% on every card sale last week",
      "can I sell at the taxi rank on a Sunday",
      `I can't pay the rent this month — ${PRICES_UP}`,
    ]) {
      await assert.doesNotReject(engine.handleInbound(textFrom(biz.wa_id, said)));
    }
    const n = notes(biz.id);
    assert.equal(n.length, 3, JSON.stringify(n));
    assert.match(n[0]!, /^captured: correction .*\[yoco\]$/);
    assert.match(n[1]!, /^skipped: names no product and states no money amount$/);
    assert.match(n[2]!, /^skipped: handled as distress \(stabilising mode\), not a library question$/);
  });

  test("a failed answer leaves a note too", async () => {
    const biz = await readyBiz("27809940061");
    answerFor = () => "not json at all"; // askJSON gives up without backoff
    await engine.handleInbound(textFrom(biz.wa_id, PRICES_UP));
    assert.match(net.sent.at(-1)!.body, /couldn't finish an answer to that just now/);
    assert.deepEqual(notes(biz.id), ["skipped: handled as a failed answer (the model call failed), not a library question"]);
  });

  test("a typed shortcut and a plan change each leave one note, named for the path that took them", async () => {
    const biz = await readyBiz("27809940062");
    await engine.handleInbound(textFrom(biz.wa_id, "next"));
    assert.deepEqual(notes(biz.id), ["skipped: handled as a typed shortcut (a.step.next), not a library question"]);

    // No model is scripted for the change classifier: applyChange handles
    // its own failure, and the path is what this test is about.
    await dbmod.updateBusiness(biz.id, { stage: "changing" } as never);
    await engine.handleInbound(textFrom(biz.wa_id, "swap the card machine step for something cheaper"));
    const n = notes(biz.id);
    assert.equal(n.length, 2, JSON.stringify(n));
    assert.equal(n[1], "skipped: handled as a plan change, not a library question");
  });

  test("an answered turn is noted once, not again by the dispatcher's fallback", async () => {
    const biz = await readyBiz("27809940063");
    await engine.handleInbound(textFrom(biz.wa_id, PRICES_UP));
    assert.deepEqual(notes(biz.id), ["skipped: names no product and states no money amount"]);
  });

  test("updateMemory throwing still leaves a note, and the turn does not fail", async () => {
    const biz = await readyBiz("27809940064");
    // updateMemory catches its own errors and logs them; make that log throw,
    // which is the one way an error escapes it today — the capture after it
    // must not depend on updateMemory never throwing.
    memoryFor = () => "not json";
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      if (args[0] === "updateMemory failed") throw new Error("memory exploded");
      realError(...args);
    };
    try {
      await assert.doesNotReject(engine.handleInbound(textFrom(biz.wa_id, "Yoco is not 2.3% anymore, they charged me 2.9% on every card sale last week")));
    } finally {
      console.error = realError;
    }
    const n = notes(biz.id);
    assert.equal(n.length, 1, JSON.stringify(n));
    assert.match(n[0]!, /^captured: correction/);
  });
});

test("obviousCorrection: ordinary chatter about a product is not a correction; a changed rate is", async () => {
  const { obviousCorrection, mightBeSignal } = await import("../api/_lib/signals.ts");
  const yoco = { type: "tool" as const, id: "yoco", name: "Yoco" };
  const row = "Yoco: card machine from R499; 2.95% per card payment";
  for (const t of [
    "I use Yoco now and sold R1200 today",
    "Yoco actually worked, I made R3,000 this week",
    "I'm not sure Yoco is right, I only make R800 a day now",
    "I paid R50 not R40 last time for Yoco — no wait it was R40",
  ]) assert.equal(obviousCorrection(t, yoco as never, row), false, t);
  assert.equal(obviousCorrection("Yoco went up to 3.2% on every card sale", yoco as never, row), true);
  assert.equal(obviousCorrection("the Yoco machine is now R599, it changed", yoco as never, row), true);
  // And the pre-filter lets a plain "went up to 3.2%" through to the rule.
  assert.equal(mightBeSignal("Yoco went up to 3.2%", yoco as never), true);
});
