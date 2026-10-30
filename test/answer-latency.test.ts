// Charles — where an answer's time goes, and the waits that were not needed.
//
// Live, round 4: web answers took 12s, 14s, 10s and once 61s; WhatsApp
// answers 15–20s. Nobody can read production logs, so every answer now
// carries its own per-phase timing (web: messages.meta.timing; WhatsApp: an
// 'answer_timing' safety_events note), including which model served each
// call and whether that was a fallback. And three waits were trimmed:
//   - a plain "How am I doing?" skips the router call (its intent is known),
//     but anything that might be distress still goes to the router;
//   - the core's database reads start alongside the router, not after it;
//   - the web re-read the plan after the answer that had just read it.

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
process.env.WORKER_SECRET = "fake-worker-secret";
process.env.SESSION_SECRET = "latency-session-secret";
process.env.TYPESAFE_API_KEY = "fake-jev-key";

import { installFakeNet, makeFakeDb, type FakeDb, type FakeNet } from "./_fakes.ts";

const today = new Date().toISOString().slice(0, 10);
const TOOL = (id: string, name: string, domain: string, cost: string, keywords: string[]) => ({
  id, country: "ZA", domain, stages: ["run"], keywords, name, fits: "x", not_when: "y", why: "z",
  cost, url: `https://${id}.example`, setup: "sign up", walkthrough: ["Open the site.", "Tap Sign up."], verified_on: today,
});

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let dbmod: typeof import("../api/_lib/db.ts");
let models: typeof import("../api/_lib/models.ts");
let qa: typeof import("../api/_lib/engine/qa.ts");
let context: typeof import("../api/_lib/engine/context.ts");
let prompts: typeof import("../api/_lib/prompts.ts");
let ask: typeof import("../api/ask.ts");
let crypto: typeof import("../api/_lib/crypto.ts");
let routerIntent = "question";
let routerDelayMs = 0;
const REPLY = { message: "Take a 30% deposit on every booking before you start.", artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: "spending" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const roles = () => ["router", "wa_reply", "help", "plan_builder", "safety"].map((role) => ({ role, provider: "openrouter", model: "t/m", fallbacks: [], params: {}, enabled: true }));

before(async () => {
  net = installFakeNet();
  db = makeFakeDb({
    model_config: roles(),
    tools: [TOOL("yoco", "Yoco", "spending", "machine from R699; 2.3% per card payment", ["card", "machine", "deposit", "payment"])],
  });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  models = await import("../api/_lib/models.ts");
  models.__clearModelCache();
  qa = await import("../api/_lib/engine/qa.ts");
  context = await import("../api/_lib/engine/context.ts");
  prompts = await import("../api/_lib/prompts.ts");
  ask = await import("../api/ask.ts");
  crypto = await import("../api/_lib/crypto.ts");
  net.onModel(/Classify this message from a person to their money assistant/, async () => {
    if (routerDelayMs) await sleep(routerDelayMs);
    return { intent: routerIntent, domain: "spending", tool_need: null, missing_fact: null, risk: routerIntent === "distress" ? ["distress"] : [], search_terms: "card payment deposit" };
  });
  net.onModel(/ROUTER RESULT/, () => REPLY);
  net.onModel(/You maintain one person's money memory/, () => ({ context_updates: null, map_updates: null, decisions: null, commitments: null, results: null }));
});
after(() => {
  restore?.();
  net?.restore();
});
beforeEach(() => {
  net.sent.length = 0;
  net.modelCalls.length = 0;
  routerIntent = "question";
  routerDelayMs = 0;
  net.jev.handler = (payload) => Object.fromEntries(Object.keys(payload.questions).map((id) => [id, { type: "noul", noul: 0.05 }]));
});

let n = 0;
async function planned(wa: string) {
  const biz = await dbmod.createBusiness(wa, "ZA");
  const planId = `plan-lat-${++n}`;
  db.tables.plans!.push({ id: planId, business_id: biz.id, goal: "Take deposits on every booking.", headline: "", strategy: null, created_at: new Date().toISOString() });
  db.tables.plan_steps!.push(
    { id: `ls-${n}-1`, plan_id: planId, workstream_title: "Get paid", domain: "spending", step_order: 1, step_key: "p1", title: "Take payment without cash", push: "Do it.", artifact: null, why_for_you: "", done_when: "done", status: "open", tool_id: "yoco" },
    { id: `ls-${n}-2`, plan_id: planId, workstream_title: "Get paid", domain: "spending", step_order: 2, step_key: "p2", title: "Chase what you are owed", push: "Do it.", artifact: null, why_for_you: "", done_when: "done", status: "done", tool_id: null },
  );
  const map = ["income", "spending", "debt", "cushion", "credit_record", "protection", "family_money", "goals"].map((domain) => ({ domain, status: "red", note: `note for ${domain}` }));
  await dbmod.updateBusiness(biz.id, { stage: "plan_ready", context: { name: "Lindi's Braids", location: "Soweto" }, map, current_plan_id: planId } as never);
  const token = `tok-${wa}`;
  db.tables.plan_sessions!.push({ token_hash: crypto.hashSecret(token), business_id: biz.id, expires_at: new Date(Date.now() + 864e5).toISOString() });
  return { biz: (await dbmod.findBusiness(wa))!, token };
}

const routerCalls = () => net.modelCalls.filter((c) => /Classify this message from a person to their money assistant/.test(c.prompt)).length;
const post = (token: string, question: string) =>
  ask.POST(new Request("https://charles.example/api/ask", { method: "POST", headers: { "Content-Type": "application/json", cookie: `charles_session=${token}` }, body: JSON.stringify({ question }) }));

describe("which messages may skip the router", () => {
  test("a plain progress question, alone or with filler", () => {
    for (const t of ["How am I doing?", "how am i doing", "Hey Charles, how am I doing so far?", "Am I on track?", "How's it going with my plan?", "where do I stand right now", "How is my money doing?", "my progress?"]) {
      assert.equal(qa.isPlainProgressQuestion(t), true, t);
    }
  });

  test("anything that could carry distress, or anything more, goes to the router", () => {
    for (const t of [
      "how am I doing, I can't pay rent",
      "How am I doing? Badly",
      "how am I doing, things are really tight",
      "am I on track? I owe the supplier",
      "how am I doing 😞",
      "How am I doing? I might have to close",
      "how am I doing, I'm so stressed",
      "how am I doing, should I take a loan",
      "how am I doing with Yoco and should I buy stock",
      "how am I doing — honestly I want to give up",
      "what should I do next",
      "",
      "how am i doing ".repeat(8),
    ]) {
      assert.equal(qa.isPlainProgressQuestion(t), false, JSON.stringify(t));
    }
  });
});

describe("web: timing on the record, and no router call for a plain progress question", () => {
  test("'How am I doing?' makes no router call, and meta.timing says so, phase by phase", async () => {
    const { biz, token } = await planned("27809950001");
    const res = await post(token, "How am I doing?");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.focus.kind, "map", "unchanged: still the map");
    assert.equal(body.reply.message, REPLY.message);
    assert.equal(routerCalls(), 0, "no router model call");

    const out = db.tables.messages!.find((m) => m.business_id === biz.id && m.kind === "web" && m.direction === "out")!;
    const t = out.meta.timing;
    assert.ok(t, "meta.timing stored next to meta.ms");
    assert.equal(typeof out.meta.ms, "number");
    assert.equal(t.router, "skipped");
    assert.equal(t.route, 0);
    for (const k of ["db", "core", "answer", "check", "total"]) assert.ok(typeof t[k] === "number" && t[k] >= 0, `${k} is a duration`);
    assert.ok(t.total >= t.answer && t.total >= t.check && t.total >= t.core, "no phase outlasts the whole");
    assert.ok(t.total <= out.meta.ms, "composing is part of the turn the owner waited for");
    assert.equal(t.check_engine, "jev");
    // The model trace: the answer call, served by the configured model.
    const answer = t.models.find((m: { label: string }) => m.label === "answer");
    assert.deepEqual({ model: answer.model, configured: answer.configured, fallback: answer.fallback, tries: answer.tries, ok: answer.ok }, { model: "t/m", configured: "t/m", fallback: false, tries: 1, ok: true });
    assert.ok(!t.models.some((m: { label: string }) => m.label === "router"));

    // And the guardrail still ran on it.
    assert.equal(db.tables.safety_events!.filter((e) => e.business_id === biz.id && e.check_name === "reply_compliance").length, 1);
  });

  test("'how am I doing, I can't pay rent' still calls the router — and the router's distress flag still lands", async () => {
    const { biz, token } = await planned("27809950002");
    routerIntent = "distress";
    const body = await (await post(token, "how am I doing, I can't pay rent")).json();
    assert.equal(routerCalls(), 1, "a distress cue always reaches the router");
    assert.match(body.reply.message, /./);
    assert.equal((await dbmod.findBusiness(biz.wa_id))!.stage, "stabilizing");
    const out = db.tables.messages!.find((m) => m.business_id === biz.id && m.kind === "web" && m.direction === "out")!;
    assert.equal(out.meta.timing.router, "model");
    assert.ok(out.meta.timing.route >= 0);
    assert.equal(out.meta.timing.answer, undefined, "the turn ended at the router: no answer phase");
  });

  test("an ordinary question still calls the router, with its time recorded", async () => {
    const { biz, token } = await planned("27809950003");
    routerDelayMs = 30;
    await post(token, "should I take card payments?");
    assert.equal(routerCalls(), 1);
    const out = db.tables.messages!.find((m) => m.business_id === biz.id && m.kind === "web" && m.direction === "out")!;
    assert.equal(out.meta.timing.router, "model");
    assert.ok(out.meta.timing.route >= 25, `route ${out.meta.timing.route}ms covers the router call`);
    assert.ok(out.meta.timing.models.some((m: { label: string }) => m.label === "router"));
  });
});

describe("whatsapp: an answer_timing note, and the same router skip", () => {
  test("'How am I doing?' on WhatsApp: no router call, one answer_timing note that is not a guardrail", async () => {
    const { biz } = await planned("27809950004");
    await qa.answer(biz, "How am I doing?");
    assert.equal(routerCalls(), 0);
    assert.ok(net.sent.some((m) => m.body.includes(REPLY.message)));
    const notes = db.tables.safety_events!.filter((e) => e.business_id === biz.id && e.check_name === "answer_timing");
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.engine, "none");
    assert.equal(notes[0]!.outcome, "pass");
    assert.equal(typeof notes[0]!.score, "number");
    assert.match(notes[0]!.detail, /route 0\.0s; db \d+\.\ds; core \d+\.\ds; answer \d+\.\ds; check \d+\.\ds; send \d+\.\ds; total \d+\.\ds; router skipped; check engine jev; models: answer=t\/m/);
    assert.ok(dbmod.NOT_GUARDRAIL_CHECKS.includes("answer_timing" as never), "guardrail counts leave it out");
  });

  test("with a distress cue, WhatsApp calls the router too, and still notes the timing", async () => {
    const { biz } = await planned("27809950005");
    routerIntent = "distress";
    await qa.answer(biz, "how am I doing, I can't pay rent");
    assert.equal(routerCalls(), 1);
    assert.equal((await dbmod.findBusiness(biz.wa_id))!.stage, "stabilizing");
    const note = db.tables.safety_events!.find((e) => e.business_id === biz.id && e.check_name === "answer_timing")!;
    assert.match(note.detail, /router model/);
  });
});

describe("the parallelised paths give the same result", () => {
  test("buildCore with its reads started early is identical to buildCore on its own", async () => {
    const { biz } = await planned("27809950006");
    const opts = { query: "card machine deposit", domain: "spending", quote: null, semantic: false };
    const plain = await context.buildCore(biz, opts);
    const early = await context.buildCore(biz, opts, context.loadCoreData(biz));
    assert.deepEqual(early, plain);
  });

  test("the answer prompt composeAnswer sends is exactly the one the sequential path built", async () => {
    const { biz } = await planned("27809950007");
    const said = "should I get a card machine?";
    const routed = await qa.route(biz, said);
    const cb = await context.buildCore(biz, { query: `${said} ${routed.search_terms} ${routed.tool_need ?? ""}`.trim(), domain: routed.domain, quote: said, semantic: true });
    const expected = prompts.answerPrompt(cb.text, said, JSON.stringify(routed));
    net.modelCalls.length = 0;

    const c = await qa.composeAnswer(biz, said);
    assert.equal(c.kind, "reply");
    const sent = net.modelCalls.find((m) => /ROUTER RESULT/.test(m.prompt))!;
    assert.equal(sent.prompt, expected);
    if (c.kind === "reply") {
      assert.equal(c.grounded, cb.grounded);
      assert.deepEqual(c.steps, cb.steps, "the steps handed back are the ones the core read");
      assert.equal(c.reply.message, REPLY.message);
    }
  });

  test("a read that fails still fails the answer, even when started early", async () => {
    const { biz } = await planned("27809950008");
    const orig = db.client.from.bind(db.client);
    (db.client as { from: unknown }).from = (t: string) => {
      if (t === "plan_steps") throw new Error("plan read exploded");
      return orig(t);
    };
    try {
      await assert.rejects(qa.composeAnswer(biz, "should I get a card machine?"), /plan read exploded/);
    } finally {
      (db.client as { from: unknown }).from = orig;
    }
  });

  test("an early read that fails on a distress turn is not an unhandled rejection", async () => {
    const { biz } = await planned("27809950009");
    routerIntent = "distress";
    const orig = db.client.from.bind(db.client);
    (db.client as { from: unknown }).from = (t: string) => {
      if (t === "plan_steps") throw new Error("plan read exploded");
      return orig(t);
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const c = await qa.composeAnswer(biz, "how am I doing, I can't pay rent");
      assert.equal(c.kind, "notice");
      await sleep(20);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      (db.client as { from: unknown }).from = orig;
    }
  });
});

describe("the model trace reports a fallback", () => {
  test("a configured model that fails shows up as a fallback in timing.models", async () => {
    const { biz } = await planned("27809950010");
    const row = db.tables.model_config!.find((r) => r.role === "wa_reply")!;
    row.model = "broken/m";
    row.fallbacks = ["t/m"];
    models.__clearModelCache();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (String(input).includes("openrouter.ai") && body.includes('"model":"broken/m"')) return new Response("overloaded", { status: 503 });
      return realFetch(input as never, init);
    }) as typeof fetch;
    try {
      const c = await qa.composeAnswer(biz, "How am I doing?", undefined, { aboutTheirPlan: true });
      const answer = c.timing.models.find((m) => m.label === "answer")!;
      assert.equal(answer.model, "t/m");
      assert.equal(answer.configured, "broken/m");
      assert.equal(answer.fallback, true);
      assert.equal(answer.tries, 2);
      assert.match(qa.timingLine(c.timing), /answer=t\/m \(fallback from broken\/m\) \d+\.\ds x2/);
    } finally {
      globalThis.fetch = realFetch;
      row.model = "t/m";
      row.fallbacks = [];
      models.__clearModelCache();
    }
  });
});
