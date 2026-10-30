// Charles — "ask me anything", on WhatsApp at any point after the plan, and
// on the web where the page itself reacts.
//
// WhatsApp (audit of 2026-09-23): after a plan exists an open question was
// answered properly in plan_ready / step_pushed / outcome_wait — but
//   - mid-walkthrough it was answered as if it were about the sign-up screen,
//   - after "Change something" it was treated as a change request,
//   - while confirming an AI-suggested change, anything but "yes" counted as
//     NO and silently declined it.
// Web: api/ask.ts gives the same answer as WhatsApp (one engine, one
// Business Context) plus a deterministic `focus` for the page.

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
process.env.WORKER_SECRET = "fake-worker-secret";
process.env.SESSION_SECRET = "ask-session-secret";
process.env.TYPESAFE_API_KEY = "fake-jev-key";

import { installFakeNet, makeFakeDb, tapFrom, textFrom, type FakeDb, type FakeNet } from "./_fakes.ts";

const today = new Date().toISOString().slice(0, 10);
const TOOL = (id: string, name: string, domain: string, cost: string) => ({
  id, country: "ZA", domain, stages: ["run"], keywords: [id], name, fits: "x", not_when: "y", why: "z",
  cost, url: `https://${id}.example`, setup: "sign up", walkthrough: ["Open the site.", "Tap Sign up.", "Verify your number."], verified_on: today,
});

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let dbmod: typeof import("../api/_lib/db.ts");
let engine: typeof import("../api/_lib/engine/index.ts");
let steps: typeof import("../api/_lib/engine/steps.ts");
let ask: typeof import("../api/ask.ts");
let crypto: typeof import("../api/_lib/crypto.ts");
let reply: Record<string, unknown> = {};
let routerIntent = "question";
/** How long the answer model and the memory model take to reply, to simulate a slow queue. */
let replyDelayMs = 0;
let memoryDelayMs = 0;
let memoryCallsDone = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  net = installFakeNet();
  const roles = ["router", "wa_reply", "help", "plan_builder", "safety"].map((role) => ({ role, provider: "openrouter", model: "t/m", fallbacks: [], params: {}, enabled: true }));
  db = makeFakeDb({
    model_config: roles,
    tools: [TOOL("gbp", "Google Business Profile", "credit_record", "free"), TOOL("yoco", "Yoco", "spending", "machine from R699; 2.3% per card payment")],
  });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  engine = await import("../api/_lib/engine/index.ts");
  steps = await import("../api/_lib/engine/steps.ts");
  ask = await import("../api/ask.ts");
  crypto = await import("../api/_lib/crypto.ts");
  net.onModel(/Classify this message from a person to their money assistant/, () => ({ intent: routerIntent, domain: "spending", tool_need: null, missing_fact: null, risk: routerIntent === "distress" ? ["distress"] : [], search_terms: "" }));
  net.onModel(/ROUTER RESULT/, async () => {
    if (replyDelayMs) await sleep(replyDelayMs);
    return reply;
  });
  net.onModel(/Unstick them/, () => ({ message: "On the sign-up screen, use the number you registered with.", artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: null }));
  net.onModel(/You maintain one person's money memory/, async () => {
    if (memoryDelayMs) await sleep(memoryDelayMs);
    memoryCallsDone++;
    return { context_updates: null, map_updates: null, decisions: null, commitments: null, results: null };
  });
});
after(() => {
  restore?.();
  net?.restore();
});
beforeEach(() => {
  net.sent.length = 0;
  routerIntent = "question";
  replyDelayMs = 0;
  memoryDelayMs = 0;
  reply = { message: "Offer layaway with a 30% deposit you keep if they cancel.", artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: "spending" };
  net.jev.handler = (payload) => Object.fromEntries(Object.keys(payload.questions).map((id) => [id, { type: "noul", noul: 0.05 }]));
});

let n = 0;
async function planned(wa: string) {
  const biz = await dbmod.createBusiness(wa, "ZA");
  const planId = `plan-ask-${++n}`;
  db.tables.plans!.push({ id: planId, business_id: biz.id, goal: "Take deposits on every booking.", headline: "", strategy: null, created_at: new Date().toISOString() });
  const mk = (i: number, over: Record<string, unknown>) => ({
    id: `s-${n}-${i}`, plan_id: planId, workstream_title: "Get paid", domain: "spending", step_order: i, step_key: null,
    push: "Do it.", artifact: null, why_for_you: "", done_when: "done", status: "open", pushed_at: null, done_at: null, skipped_reason: null, tool_id: null, ...over,
  });
  db.tables.plan_steps!.push(
    mk(1, { title: "Take payment without cash", tool_id: "yoco", step_key: "p1" }),
    mk(2, { title: "Show up when people search nearby", tool_id: "gbp", domain: "credit_record", workstream_title: "Be findable", step_key: "f1" }),
    mk(3, { title: "Write down who has bought from you", domain: "cushion", workstream_title: "Bring them back" }),
  );
  const map = ["income", "spending", "debt", "cushion", "credit_record", "protection", "family_money", "goals"].map((domain) => ({ domain, status: "red", note: `note for ${domain}` }));
  await dbmod.updateBusiness(biz.id, { stage: "plan_ready", context: { name: "Lindi's Braids", location: "Soweto" }, map, current_plan_id: planId } as never);
  const token = `tok-${wa}`;
  db.tables.plan_sessions!.push({ token_hash: crypto.hashSecret(token), business_id: biz.id, expires_at: new Date(Date.now() + 864e5).toISOString() });
  return { biz: (await dbmod.findBusiness(wa))!, token, planId };
}

const url = "https://charles.example/api/ask";
const collect = (token: string | undefined, turn: string) =>
  ask.GET(new Request(`${url}?action=reply&turn=${encodeURIComponent(turn)}`, { headers: token ? { cookie: `charles_session=${token}` } : {} }));
const get = (token?: string) => ask.GET(new Request(`${url}?action=state`, { headers: token ? { cookie: `charles_session=${token}` } : {} }));
const post = (token: string | undefined, question: unknown) =>
  ask.POST(new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { cookie: `charles_session=${token}` } : {}) }, body: JSON.stringify({ question }) }));

describe("web: /api/ask", () => {
  test("no session, no answer", async () => {
    assert.equal((await get()).status, 401);
    assert.equal((await post(undefined, "hi")).status, 401);
    assert.equal((await post("forged-token", "hi")).status, 401);
  });

  test("state: the board the page draws — steps with the next one marked, all 8 areas, tools with real cost lines, starter questions", async () => {
    const { token } = await planned("27809930001");
    const body = await (await get(token)).json();
    assert.equal(body.business.currency, "R");
    assert.equal(body.plan.steps.length, 3);
    assert.equal(body.plan.steps.filter((s: { is_next: boolean }) => s.is_next).length, 1);
    assert.equal(body.map.length, 8);
    assert.match(body.tools.yoco.cost_line, /R699/);
    assert.deepEqual(body.tools.yoco.walkthrough.length, 3);
    assert.ok(body.suggestions.some((q: string) => /Take payment without cash/.test(q)));
  });

  test("a question about a step focuses THAT step", async () => {
    const { token } = await planned("27809930002");
    const body = await (await post(token, "I'm struggling to show up when people search nearby, what do I do?")).json();
    assert.equal(body.ok, true);
    assert.equal(body.focus.kind, "step");
    assert.match(body.focus.step_id, /-2$/);
  });

  test("'how am I doing?' focuses the map, with the reply's area", async () => {
    const { token } = await planned("27809930003");
    const body = await (await post(token, "How am I doing?")).json();
    assert.equal(body.focus.kind, "map");
    assert.equal(body.focus.domain, "spending");
    assert.equal(body.grounded, true, "a question about their own plan never carries the 'no checked information' note");
  });

  // Live, 2026-09-23: "How am I doing?" → Vercel gateway 504. Nothing on the
  // answer path had an overall deadline shorter than the function's own.
  // Live, round 3: every web question took over 40s on production, and a
  // hard deadline threw each answer away. A slow answer is now collected.
  test("a slow answer is not thrown away: 202 at once, then the page collects the real answer by turn", async () => {
    const { token, biz } = await planned("27809930050");
    const undo = ask.__setAnswerDeadlineMs(80);
    replyDelayMs = 600;
    try {
      const t0 = Date.now();
      const res = await post(token, "How am I doing?");
      assert.equal(res.status, 202);
      assert.ok(Date.now() - t0 < 500, "it does not wait for the slow model");
      const { pending, turn } = await res.json();
      assert.equal(pending, true);
      assert.ok(turn);
      // Still working.
      assert.equal((await collect(token, turn)).status, 202);
      await ask.__afterResponseSettled();
      // Landed: the same body the POST would have returned.
      const done = await collect(token, turn);
      assert.equal(done.status, 200);
      const body = await done.json();
      assert.equal(body.ok, true);
      assert.equal(body.focus.kind, "map");
      assert.ok(body.reply.message.length > 0);
      // The record shows the real answer, with its timing; exactly one note.
      const outs = db.tables.messages!.filter((m) => m.business_id === biz.id && m.kind === "web" && m.direction === "out");
      assert.equal(outs.length, 1);
      assert.equal((outs[0]!.meta as { turn: string }).turn, turn);
      assert.ok((outs[0]!.meta as { ms: number }).ms >= 500);
      const notes = db.tables.safety_events!.filter((e) => e.business_id === biz.id && e.check_name === "knowledge_signal");
      assert.equal(notes.length, 1, "one note for the turn, from the real answer's afterTurn");
    } finally {
      undo();
      replyDelayMs = 0;
    }
  });

  // Review of round 4.
  test("the same question sent again with its client_turn (a reload) is never answered or charged twice", async () => {
    const { token, biz } = await planned("27809930060");
    const ct = "ct_0123456789abcdefXYZ";
    const send = () => ask.POST(new Request(url, { method: "POST", headers: { "Content-Type": "application/json", cookie: `charles_session=${token}` }, body: JSON.stringify({ question: "can I offer layaway?", client_turn: ct }) }));
    net.modelCalls.length = 0;
    const first = await send();
    assert.equal(first.status, 200);
    const calls = net.modelCalls.length;
    const again = await send();
    assert.equal(again.status, 200);
    assert.equal((await again.json()).final, true, "the stored result, handed back");
    assert.equal(net.modelCalls.length, calls, "no second model call");
    assert.equal(db.tables.messages!.filter((m) => m.business_id === biz.id && m.kind === "web" && m.direction === "in").length, 1, "one question row, one charge");
    // And it can be collected by client_turn alone (a reload before the 202 arrived).
    const got = await ask.GET(new Request(`${url}?action=reply&client_turn=${ct}`, { headers: { cookie: `charles_session=${token}` } }));
    assert.equal(got.status, 200);
  });

  test("an answer that throws after the wait still ends its turn: one note, a final 410 the page shows at once", async () => {
    const { token, biz } = await planned("27809930061");
    const undo = ask.__setAnswerDeadlineMs(50);
    replyDelayMs = 300;
    // Reading the plan throws — past the wait, outside composeAnswer's own try.
    const orig = db.client.from.bind(db.client);
    (db.client as { from: unknown }).from = (t: string) => {
      if (t === "plan_steps") throw new Error("plan read exploded");
      return orig(t);
    };
    try {
      const res = await post(token, "can I offer layaway?");
      // Either it fails inside the wait (a final 410 straight away) or after
      // it (202, then the collected final 410) — never a page left polling.
      let final = res;
      if (res.status === 202) {
        const { turn } = await res.json();
        await ask.__afterResponseSettled();
        final = await collect(token, turn);
      }
      assert.equal(final.status, 410);
      assert.equal((await final.json()).final, true);
      const notes = db.tables.safety_events!.filter((e) => e.business_id === biz.id && e.check_name === "knowledge_signal");
      assert.equal(notes.length, 1);
      assert.match(notes[0]!.detail, /gave up: the answer failed/);
    } finally {
      (db.client as { from: unknown }).from = orig;
      undo();
      replyDelayMs = 0;
    }
  });

  test("state carries an opaque storage key, different per business", async () => {
    const a = await planned("27809930062");
    const b = await planned("27809930063");
    const ka = (await (await get(a.token)).json()).business.key;
    const kb = (await (await get(b.token)).json()).business.key;
    assert.match(ka, /^[0-9a-f]{16}$/);
    assert.notEqual(ka, kb);
    assert.ok(!String(ka).includes(a.biz.id));
  });

  test("collecting: unknown turn 404, another owner's turn 404, no session 401", async () => {
    const a = await planned("27809930052");
    const b = await planned("27809930053");
    const res = await post(a.token, "can I offer layaway?");
    assert.equal(res.status, 200);
    const inRow = db.tables.messages!.find((m) => m.business_id === a.biz.id && m.direction === "in" && m.kind === "web")!;
    assert.equal((await collect(a.token, "999999")).status, 404);
    assert.equal((await collect(b.token, String(inRow.id))).status, 404, "a turn id from another business is not found");
    assert.equal((await collect(undefined, String(inRow.id))).status, 401);
    // A fast answer is collectable too (the page may have reloaded).
    assert.equal((await collect(a.token, String(inRow.id))).status, 200);
  });

  // Live, round 3: every web question on production took over 40s, and the
  // hard deadline threw each answer away. Now a slow answer is collected.
  test("a model slower than the deadline gets a quick 202 with a turn, and the answer is collected — not thrown away", async () => {
    const { token, biz } = await planned("27809930054");
    const undo = ask.__setAnswerDeadlineMs(80);
    replyDelayMs = 600;
    const collect = (turn: string) =>
      ask.GET(new Request(`${url}?action=reply&turn=${encodeURIComponent(turn)}`, { headers: { cookie: `charles_session=${token}` } }));
    try {
      const t0 = Date.now();
      const res = await post(token, "How am I doing?");
      const took = Date.now() - t0;
      assert.equal(res.status, 202);
      assert.ok(took < 500, `answered in ${took}ms; it must not wait for the slow model`);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.pending, true);
      assert.ok(typeof body.turn === "string" && body.turn, "a turn id to collect the answer with");

      const early = await collect(body.turn);
      assert.equal(early.status, 202, "still pending while the model works");
      assert.equal((await early.json()).pending, true);
      assert.equal((await collect("no-such-turn")).status, 404);
      assert.equal((await collect("")).status, 400);

      await ask.__afterResponseSettled();
      const late = await collect(body.turn);
      assert.equal(late.status, 200, "the same result the POST would have returned");
      const done = await late.json();
      assert.equal(done.ok, true);
      assert.equal(done.reply.message, reply.message);
      assert.equal(done.focus.kind, "map");
      const outs = db.tables.messages!.filter((m) => m.business_id === biz.id && m.kind === "web" && m.direction === "out");
      assert.deepEqual(outs.map((m) => m.text), [reply.message], "the conversation record shows the real answer, not a timeout");
    } finally {
      undo();
      await ask.__afterResponseSettled();
    }
  });

  test("a turn nothing came back for is given up on after the function's lifetime, with a message the page shows", async () => {
    const { token, biz } = await planned("27809930055");
    const asked = new Date(Date.now() - 301_000).toISOString();
    db.tables.messages!.push({ id: "old-turn", business_id: biz.id, direction: "in", kind: "web", text: "slow one", wa_message_id: null, meta: { channel: "web" }, created_at: asked });
    const res = await ask.GET(new Request(`${url}?action=reply&turn=old-turn`, { headers: { cookie: `charles_session=${token}` } }));
    assert.equal(res.status, 410, "final: the page stops polling");
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.message, ask.SLOW_MESSAGE, "the page shows data.message for a 5xx");
  });

  test("'how am I doing?' is answered from the plan: no semantic search, no false library gap — and the guardrails still run", async () => {
    const { token, biz } = await planned("27809930051");
    let embeds = 0;
    const before = net.embed;
    net.embed = (t) => {
      embeds++;
      return (before ?? (() => new Array(1536).fill(0)))(t);
    };
    try {
      const checks = () => db.tables.safety_events!.filter((e) => e.business_id === biz.id && e.check_name === "reply_compliance").length;
      const gaps = () => (db.tables.retrieval_gaps ?? []).filter((g) => g.business_id === biz.id).length;
      const body = await (await post(token, "How am I doing?")).json();
      assert.equal(body.focus.kind, "map");
      assert.equal(embeds, 0, "no embedding call for a question about their own progress");
      assert.equal(gaps(), 0, "their own progress is not a library gap");
      assert.equal(checks(), 1, "the reply still went through checkReply");

      // An unrelated question with no keyword match still gets the semantic fallback.
      await post(token, "zxq unrelated widget pricing in antarctica");
      assert.equal(embeds, 1, "other questions keep the semantic fallback");
      assert.equal(gaps(), 1);
    } finally {
      net.embed = before;
    }
  });

  test("learning from the turn does not hold the answer", async () => {
    const { token } = await planned("27809930091");
    memoryDelayMs = 400;
    const doneBefore = memoryCallsDone;
    const t0 = Date.now();
    const res = await post(token, "can I offer layaway?");
    const took = Date.now() - t0;
    assert.equal(res.status, 200);
    assert.ok(took < memoryDelayMs, `answered in ${took}ms, before the ${memoryDelayMs}ms memory call finished`);
    assert.equal(memoryCallsDone, doneBefore, "memory is still running after the response");
    await ask.__afterResponseSettled();
    assert.equal(memoryCallsDone, doneBefore + 1, "and it does finish");
  });

  test("an answer that names a tool on the plan focuses the step that uses it; a tool not on the plan focuses the tool", async () => {
    const { token } = await planned("27809930004");
    reply = { ...reply, message: "Yoco is the one for you.", tool_id: "yoco" };
    let body = await (await post(token, "which card machine is cheapest")).json();
    assert.equal(body.focus.kind, "step");
    assert.equal(body.focus.tool_id, "yoco");
    reply = { ...reply, message: "Try it.", tool_id: "sheets" };
    body = await (await post(token, "anything for bookkeeping")).json();
    assert.equal(body.focus.kind, "tool");
  });

  test("the answer is the same engine as WhatsApp: guardrails ran, and the turn is in the same conversation record", async () => {
    const { token, biz } = await planned("27809930005");
    const before = db.tables.safety_events!.filter((e) => e.business_id === biz.id && e.check_name === "reply_compliance").length;
    await post(token, "can I offer layaway?");
    assert.equal(db.tables.safety_events!.filter((e) => e.business_id === biz.id && e.check_name === "reply_compliance").length, before + 1);
    const msgs = db.tables.messages!.filter((m) => m.business_id === biz.id && m.kind === "web");
    assert.deepEqual(msgs.map((m) => m.direction), ["in", "out"]);
  });

  test("grounded: false when the library had nothing on it", async () => {
    const { token } = await planned("27809930006");
    const body = await (await post(token, "zxq unrelated widget pricing in antarctica")).json();
    assert.equal(body.grounded, false);
  });

  test("distress asked on the web is handled exactly like WhatsApp: stabilising mode", async () => {
    const { token, biz } = await planned("27809930007");
    routerIntent = "distress";
    const body = await (await post(token, "I can't pay rent and I'm going under")).json();
    assert.equal((await dbmod.findBusinessById(biz.id))!.stage, "stabilizing");
    assert.equal(body.focus.kind, "none");
    assert.ok(body.reply.message.length > 20);
  });

  test("empty, too long, and the hourly limit", async () => {
    const { token, biz } = await planned("27809930008");
    assert.equal((await post(token, "   ")).status, 400);
    assert.equal((await post(token, "x".repeat(601))).status, 400);
    for (let i = 0; i < 30; i++) db.tables.messages!.push({ id: `m-${i}`, business_id: biz.id, direction: "in", kind: "web", text: "q", created_at: new Date().toISOString() });
    assert.equal((await post(token, "one more?")).status, 429);
  });

  test("a web question can become a knowledge signal, marked source 'web'", async () => {
    const { token, biz } = await planned("27809930009");
    await post(token, "Yoco is not 2.3% anymore, they charged me 2.9% last week");
    // Signal capture runs after the response (waitUntil), not before it.
    await ask.__afterResponseSettled();
    const row = db.tables.knowledge_signals!.find((s) => s.business_id === biz.id && s.signal_type === "correction");
    assert.equal(row?.source, "web");
  });

  test("computeFocus: next-step questions go to the next open step", () => {
    const s = [
      { id: "a", title: "Take payment without cash", status: "done" },
      { id: "b", title: "Show up when people search nearby", status: "open" },
    ] as never;
    assert.equal(ask.computeFocus("what should I do next?", { tool_id: null, domain: null, message: "" }, s).step_id, "b");
  });
});

describe("WhatsApp: an open question gets a real answer at every point after the plan", () => {
  test("mid-walkthrough, an off-step question is answered as a question — and the walkthrough is kept", async () => {
    const { biz } = await planned("27809930020");
    await dbmod.updateBusiness(biz.id, { stage: "walking", walk: { tool_id: "gbp", index: 1, step_id: `s-${n}-2` } } as never);
    net.modelCalls.length = 0;
    await engine.handleInbound(textFrom(biz.wa_id, "should I hire someone to help on Saturdays?"));
    assert.ok(net.modelCalls.some((c) => /ROUTER RESULT/.test(c.prompt)), "the general answer path ran");
    assert.ok(!net.modelCalls.some((c) => /Unstick them/.test(c.prompt)), "not step help");
    assert.equal((await dbmod.findBusiness(biz.wa_id))!.walk?.index, 1, "walkthrough position kept");
  });

  test("mid-walkthrough, a question about the screen they're on still gets step help", async () => {
    const { biz } = await planned("27809930021");
    await dbmod.updateBusiness(biz.id, { stage: "walking", walk: { tool_id: "gbp", index: 1, step_id: `s-${n}-2` } } as never);
    net.modelCalls.length = 0;
    await engine.handleInbound(textFrom(biz.wa_id, "where do I find the verify button?"));
    assert.ok(net.modelCalls.some((c) => /Unstick them/.test(c.prompt)));
  });

  test("after 'Change something', a question that isn't a change is answered and the change flow let go", async () => {
    const { biz } = await planned("27809930022");
    await dbmod.updateBusiness(biz.id, { stage: "changing", pending_action: { kind: "change" } } as never);
    await engine.handleInbound(textFrom(biz.wa_id, "can I offer layaway?"));
    assert.match(net.sent.map((m) => m.body).join("\n"), /layaway/);
    assert.equal((await dbmod.findBusiness(biz.wa_id))!.stage, "plan_ready");
  });

  test("confirming an AI-suggested change: a question is answered, the change is NOT declined, and yes/no is asked again", async () => {
    const { biz } = await planned("27809930023");
    db.tables.proposed_changes!.push({ id: "chg-1", business_id: biz.id, fact: "cushion", from_value: "walk-ins", to_value: "offices", reason: "r", status: "pending" });
    await dbmod.updateBusiness(biz.id, { stage: "confirm_change", pending_action: { kind: "change", change_id: "chg-1" } } as never);
    await engine.handleInbound(textFrom(biz.wa_id, "what does that mean for my plan?"));
    assert.equal(db.tables.proposed_changes!.find((c) => c.id === "chg-1")!.status, "pending", "not silently declined");
    assert.equal((await dbmod.findBusiness(biz.wa_id))!.stage, "confirm_change");
    assert.ok(net.sent.some((m) => m.buttons.some((b) => b.id === "a.chg.yes")));
    await engine.handleInbound(tapFrom(biz.wa_id, "a.chg.yes", "Yes, update it"));
    assert.equal(db.tables.proposed_changes!.find((c) => c.id === "chg-1")!.status, "accepted");
  });

  test("the answer prompt tells the model to say plainly when the library has nothing", async () => {
    const { answerPrompt } = await import("../api/_lib/prompts.ts");
    assert.match(answerPrompt("CORE", "q", "{}"), /I don't have checked information on that yet/);
  });
});

// Adversarial review round (2026-09-23): each of these was a confirmed break in the first cut.
describe("review regressions", () => {
  test("web: an owner in stabilising mode gets the stabilising advice, never a growth answer", async () => {
    const { token, biz } = await planned("27809930040");
    await dbmod.updateBusiness(biz.id, { stage: "stabilizing" } as never);
    reply = { ...reply, message: "Take a Business Partners loan of R50k to restock." };
    const body = await (await post(token, "should I take a loan to restock?")).json();
    assert.doesNotMatch(body.reply.message, /loan of R50k/);
    assert.match(body.reply.message, /no new borrowing/);
  });

  // Live test, 2026-09-25 (r10/distress): on the web too, EVERY question
  // from a stabilising business got the fixed sentence. Only a question
  // about the money trouble does now (above); an ordinary one is answered,
  // with the stabilising rules in its prompt.
  test("web: an ordinary question from a stabilising business gets a real answer, with the stabilising rules in its prompt", async () => {
    const { token, biz } = await planned("27809930043");
    await dbmod.updateBusiness(biz.id, { stage: "stabilizing" } as never);
    net.modelCalls.length = 0;
    const body = await (await post(token, "how do I get more customers on weekday mornings?")).json();
    assert.equal(body.ok, true);
    assert.equal(body.reply.message, reply.message, "the composed answer, not the fixed sentence");
    assert.doesNotMatch(body.reply.message, /no new borrowing/);
    const answer = net.modelCalls.find((c) => /ROUTER RESULT/.test(c.prompt));
    assert.ok(answer, "the answer path ran");
    assert.match(answer!.prompt, /HARDSHIP MODE/);
    assert.equal((await dbmod.findBusinessById(biz.id))!.stage, "stabilizing", "answering does not leave stabilising mode");
  });

  // Review A (r10/distress): the web split is the same as WhatsApp's — a
  // pleasantry or ordinary vocabulary in front of a question does not turn
  // it into the fixed sentence.
  test("web: a stabilising owner's question with a pleasantry, or a non-money 'borrow', is answered", async () => {
    let i = 0;
    for (const q of [
      "I'm fine thanks, how do I register for VAT?",
      "sales are ok on Fridays but dead on Mondays, what do I do?",
      "can I borrow a friend's card machine for the market?",
    ]) {
      const { token, biz } = await planned(`2780993008${i++}`);
      await dbmod.updateBusiness(biz.id, { stage: "stabilizing" } as never);
      net.modelCalls.length = 0;
      const body = await (await post(token, q)).json();
      assert.equal(body.reply.message, reply.message, `"${q}": the composed answer, not the fixed sentence`);
      const answer = net.modelCalls.find((c) => /ROUTER RESULT/.test(c.prompt));
      assert.ok(answer, `"${q}": the answer path ran`);
      assert.match(answer!.prompt, /HARDSHIP MODE/);
      assert.equal((await dbmod.findBusinessById(biz.id))!.stage, "stabilizing");
    }
  });

  // Round 27 (KE, live): typed "What's next?" while stabilising got plan
  // step 2 from the answer model. Held now, on the web as on WhatsApp.
  test("web: a stabilising owner who types 'What's next?' gets the stabilising work, never a plan step, and no model call", async () => {
    for (const [i, q] of ["What's next?", "what should I do now", "next step"].entries()) {
      const { token, biz } = await planned(`2780993007${i}`);
      await dbmod.updateBusiness(biz.id, { stage: "stabilizing" } as never);
      net.modelCalls.length = 0;
      const body = await (await post(token, q)).json();
      assert.match(body.reply.message, /Right now the next thing isn't a plan step/, q);
      assert.match(body.reply.message, /National Credit Regulator/, `${q}: the free advisor is named`);
      assert.equal(net.modelCalls.length, 0, `${q}: no model was asked`);
      assert.equal((await dbmod.findBusinessById(biz.id))!.stage, "stabilizing");
    }
  });

  test("web: a pasted lender link from a stabilising owner is judged with the stabilising rules in its prompt", async () => {
    const { token, biz } = await planned("27809930090");
    await dbmod.updateBusiness(biz.id, { stage: "stabilizing" } as never);
    net.onModel(/The person forwarded something/, () => ({ message: "Not for you while it's this tight.", artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: null }));
    net.modelCalls.length = 0;
    const body = await (await post(token, "https://quickloans.co.za/apply what do you think?")).json();
    assert.equal(body.ok, true);
    const fwd = net.modelCalls.find((c) => /The person forwarded something/.test(c.prompt));
    assert.ok(fwd, "the forward path ran");
    assert.match(fwd!.prompt, /HARDSHIP MODE/);
  });

  test("web: no plan yet → 409 and no model call; a null or non-string body → 400", async () => {
    const { token, biz } = await planned("27809930041");
    assert.equal((await post(token, null as never)).status, 400);
    assert.equal((await post(token, ["a", "b"])).status, 400);
    assert.equal((await post(token, { q: 1 })).status, 400);
    const nullBody = await ask.POST(new Request(url, { method: "POST", headers: { "Content-Type": "application/json", cookie: `charles_session=${token}` }, body: "null" }));
    assert.equal(nullBody.status, 400);
    await dbmod.updateBusiness(biz.id, { stage: "choose_rule" } as never);
    net.modelCalls.length = 0;
    assert.equal((await post(token, "what's next?")).status, 409);
    assert.equal(net.modelCalls.length, 0);
  });

  test("web: the hourly limit fails closed on a database error", async () => {
    const { token } = await planned("27809930042");
    const orig = db.client.from.bind(db.client);
    (db.client as { from: unknown }).from = (t: string) => {
      const q = orig(t) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (t !== "messages") return q;
      const sel = q.select.bind(q);
      q.select = (cols: string, opts?: { head?: boolean }) => (opts?.head ? { eq: () => ({ eq: () => ({ eq: () => ({ gte: async () => ({ count: null, error: { message: "boom" } }) }) }) }) } : sel(cols, opts)) as never;
      return q;
    };
    try {
      assert.equal((await post(token, "one question")).status, 503);
    } finally {
      (db.client as { from: unknown }).from = orig;
    }
  });

  test("web: 'forget my money' says to do it on WhatsApp and deletes nothing", async () => {
    const { token, biz } = await planned("27809930092");
    routerIntent = "forget_me";
    const body = await (await post(token, "please forget my money and delete everything")).json();
    assert.match(body.reply.message, /on WhatsApp/);
    assert.ok(await dbmod.findBusinessById(biz.id));
  });

  test("focus: one common word never lights up a step", () => {
    const s = [
      { id: "a", title: "Know your numbers", status: "open" },
      { id: "b", title: "Price it right", status: "open" },
      { id: "c", title: "Take payment without cash", status: "open" },
    ] as never;
    const none = { tool_id: null, domain: null, message: "" };
    for (const q of ["I don't know what to do about my landlord", "Am I doing this right?", "should I take a loan without collateral?"]) {
      assert.equal(ask.computeFocus(q, none, s).kind, "none", q);
    }
    assert.equal(ask.computeFocus("overall cost of Yoco?", none, s).kind, "none");
    assert.equal(ask.computeFocus("how do I take payment without cash?", none, s).step_id, "c");
  });

  test("confirm_change: a question that starts with 'okay' or 'no' decides nothing", async () => {
    const { biz } = await planned("27809930044");
    db.tables.proposed_changes!.push({ id: "chg-2", business_id: biz.id, fact: "cushion", from_value: "a", to_value: "b", reason: "r", status: "pending" });
    await dbmod.updateBusiness(biz.id, { stage: "confirm_change", pending_action: { kind: "change", change_id: "chg-2" } } as never);
    for (const t of ["okay but what does that change?", "no idea what that means?", "update me on what that means", "don't know, what does it mean?"]) {
      await engine.handleInbound(textFrom(biz.wa_id, t));
      assert.equal(db.tables.proposed_changes!.find((c) => c.id === "chg-2")!.status, "pending", t);
    }
    await engine.handleInbound(textFrom(biz.wa_id, "no thanks keep it"));
    assert.equal(db.tables.proposed_changes!.find((c) => c.id === "chg-2")!.status, "rejected");
  });

  test("CLEAR_YES / CLEAR_NO", () => {
    for (const t of ["yes", "yes please", "yep", "ok do it", "Sure!", "go ahead", "do it"]) assert.ok(engine.CLEAR_YES.test(t), t);
    for (const t of ["no", "no thanks keep it", "nah", "leave it", "keep it as it is"]) assert.ok(engine.CLEAR_NO.test(t), t);
    for (const t of ["okay but what does that change?", "no idea what that means?", "yes but only for Saturdays"]) {
      assert.ok(!engine.CLEAR_YES.test(t) && !engine.CLEAR_NO.test(t), t);
    }
  });

  test("changing: a reorder phrased as a question is still a change", async () => {
    const { biz } = await planned("27809930045");
    await dbmod.updateBusiness(biz.id, { stage: "changing", pending_action: { kind: "change" } } as never);
    assert.ok(engine.CHANGE_WORDS.test("can I do the Instagram one first?"));
    assert.ok(engine.CHANGE_WORDS.test("could we put Facebook before Yoco?"));
    assert.ok(engine.CHANGE_WORDS.test("can I not do the website?"));
  });

  test("walking: screen-level questions stay step help", async () => {
    const { biz } = await planned("27809930046");
    await dbmod.updateBusiness(biz.id, { stage: "walking", walk: { tool_id: "gbp", index: 2, step_id: `s-${n}-2` } } as never);
    for (const q of ["what category should I pick?", "how long until I'm approved?", "what do I type as my address?"]) {
      assert.equal(await engine.isOffStepQuestion((await dbmod.findBusiness(biz.wa_id))!, q), false, q);
    }
    assert.equal(await engine.isOffStepQuestion((await dbmod.findBusiness(biz.wa_id))!, "Do I need to register for VAT?"), true);
  });
});

// Live, 2026-09-25: real one-time sign-in codes sat in the messages table as
// plain "text" rows, in both the old "Your Charles code is NNNNNN" wording and
// the bare six digits — and that table is the RECENT CONVERSATION every
// prompt carries, the recent_whatsapp the owner's own AI reads, and whatever
// else treats the conversation as memory. The row stays in the table (the
// live verifier signs in by reading it back by kind); it must never travel.
describe("a sign-in code never leaves the messages table", () => {
  const NEW = "483920";
  const OLD_BARE = "117733";
  const OLD_WORDED = "556677";
  const codes = new RegExp(`${NEW}|${OLD_BARE}|${OLD_WORDED}`);

  async function withCodes(wa: string) {
    const p = await planned(wa);
    await dbmod.recordMessage(p.biz.id, "in", "how do I take deposits?");
    await dbmod.recordMessage(p.biz.id, "out", "Ask for 30% when they book.");
    // What the code path writes since this fix …
    await dbmod.recordMessage(p.biz.id, "out", NEW, { kind: "login_code" });
    // … and the rows an older deploy left behind, both wordings.
    await dbmod.recordMessage(p.biz.id, "out", OLD_BARE);
    await dbmod.recordMessage(p.biz.id, "out", `Your Charles code is ${OLD_WORDED}.`);
    // An owner typing six digits is conversation, not a code.
    await dbmod.recordMessage(p.biz.id, "in", "123456");
    return p;
  }

  test("the conversation memory skips the code rows and keeps everything else, at full length", async () => {
    const { biz } = await withCodes("27809930093");
    const memory = await dbmod.recentMessages(biz.id, 3);
    assert.deepEqual(memory.map((m) => m.text), ["how do I take deposits?", "Ask for 30% when they book.", "123456"]);
  });

  test("WhatsApp: the next model call's prompt carries the conversation, without any code", async () => {
    const { biz } = await withCodes("27809930094");
    net.modelCalls.length = 0;
    await engine.handleInbound(textFrom(biz.wa_id, "can I offer layaway?"));
    const core = net.modelCalls.find((c) => /RECENT CONVERSATION/.test(c.prompt));
    assert.ok(core, "the answer prompt carries the recent conversation");
    assert.match(core!.prompt, /Person: how do I take deposits\?/);
    for (const c of net.modelCalls) assert.doesNotMatch(c.prompt, codes, "a login code in a model prompt");
  });

  test("web: the answer's prompt is just as clean, and the page's own record has no code in it", async () => {
    const { biz, token } = await withCodes("27809930095");
    net.modelCalls.length = 0;
    const body = await (await post(token, "can I offer layaway?")).json();
    assert.equal(body.ok, true);
    assert.ok(net.modelCalls.some((c) => /RECENT CONVERSATION/.test(c.prompt)));
    for (const c of net.modelCalls) assert.doesNotMatch(c.prompt, codes, "a login code in a model prompt");
    // The page's turn record only ever reads kind "web" rows.
    const webRows = db.tables.messages!.filter((m) => m.business_id === biz.id && m.kind === "web");
    assert.ok(webRows.length >= 2);
    assert.doesNotMatch(JSON.stringify(webRows), codes);
  });

  test("the owner's own AI (MCP get_household_context) gets the conversation without any code", async () => {
    const { biz } = await withCodes("27809930096");
    const connector = await import("../api/_lib/connector.ts");
    const r = await connector.callTool((await dbmod.findBusiness(biz.wa_id))!, "get_household_context", {});
    const recent = (r.structured as { recent_whatsapp: string[] }).recent_whatsapp;
    assert.ok(recent.includes("Person: how do I take deposits?"));
    assert.ok(recent.includes("Person: 123456"), "an owner's own six digits are conversation");
    assert.doesNotMatch(r.text, codes, "a login code reached the owner's AI");
  });
});
