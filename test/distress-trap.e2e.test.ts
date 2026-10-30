// Charles — "im stuck" must never cost a person their plan.
//
// Live test, 2026-09-25, on a business WITH a finished plan:
//   1. Typing "im stuck" got the full stabilising-mode message. It missed the
//      exact-match step-help shortcut, went to the Q&A router, the router
//      called it distress, and the code flipped the business into stabilising
//      mode on that word alone.
//   2. It was sticky: every later question, on WhatsApp and on the web, got
//      the one fixed "protect your cash" sentence, because the exit check ran
//      on ALL the answers — the original diagnostic included — and could never
//      conclude "not struggling any more".
//   3. The only way out, "Yes, build it", threw the finished plan away and
//      restarted from customer options.
//
// These tests drive the real dispatcher against the in-memory db and a
// scripted model gateway, with the router scripted to make exactly the
// mistake it made live, and assert on what reached the person and the record.

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
process.env.WORKER_SECRET = "fake-worker-secret";
// No Jev key: every judged check runs on the "safety" model backstop, the
// configuration most deployments run (matches guardrails.e2e.test.ts).
delete process.env.TYPESAFE_API_KEY;

import { installFakeNet, makeFakeDb, tapFrom, textFrom, type FakeDb, type FakeNet } from "./_fakes.ts";

const MODEL_ROLES = ["router", "wa_reply", "help", "plan_builder", "safety"].map((role) => ({
  role, provider: "openrouter", model: `test/${role}`, fallbacks: [], params: {}, enabled: true,
}));

const STABILISING_LINE = /keeping food, a roof and transport covered/i;
const CANNED = /Same advice while it's this tight/;
const ANSWER = "Write down everyone you owe this week, with what each one costs you a month, and put the dearest one at the top.";
const FORWARD = "Verdict on that page: here is what it means for your month.";
const HELD = /Your plan is kept, but it's paused while things are this tight/;
const HELP = "On the NCR page, read the three lines about what a lender may not do and save the number — that is the whole step.";

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let dbmod: typeof import("../api/_lib/db.ts");
let engine: typeof import("../api/_lib/engine/index.ts");
let safety: typeof import("../api/_lib/safety.ts");

/** What the fake safety model says to the "distress" proposition. */
let inDistress = true;
/** The router's verdict for a message, per test — the live misfire is scripted here. */
let routerFor: (message: string) => Record<string, unknown> = () => ({});
/** When set, the distress verdict per prompt (overrides inDistress). */
let distressFor: ((prompt: string) => boolean) | null = null;
/** What the change model answers. */
let changeReply: Record<string, unknown> = { action: "none", step_id: null, tool_id: null, reason: "", message: "Nothing to change." };

before(async () => {
  net = installFakeNet();
  net.onModel(/You are a strict checker/, (prompt) => {
    const ids = [...prompt.matchAll(/- "([a-z_]+)":/g)].map((m) => m[1]!);
    return Object.fromEntries(ids.map((id) => [id, id === "distress" ? (distressFor ? distressFor(prompt) : inDistress) : false]));
  });
  // The change model (review of round 10): what it says is set per test. A
  // money message that reached it would be swallowed as a change request.
  net.onModel(/has said something about it they want changed/, () => changeReply);
  // Call A of the plan build, for the plan-less way out of stabilising mode.
  net.onModel(/Read this person's money back to them/, () => ({
    identity: { name: "Thandi", earns: "a wage from a salon", one_liner: "A salon wage in Woodstock", unsure: null },
    stage: "surviving",
    objective_read: "Get through the month and then start the cushion.",
    reflection: "A salon wage in Woodstock, behind on the rent.",
  }));
  net.onModel(/Classify this message from a person to their money assistant/, (prompt) => {
    const message = /^Message: (.*)$/m.exec(prompt)?.[1] ?? "";
    return { intent: "question", domain: "debt", tool_need: null, missing_fact: null, risk: [], search_terms: "owe list", ...routerFor(message) };
  });
  net.onModel(/ROUTER RESULT/, () => ({ message: ANSWER, artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: "debt" }));
  net.onModel(/The person forwarded something/, () => ({ message: FORWARD, artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: "spending" }));
  net.onModel(/The person is stuck on one step/, () => ({ message: HELP, artifact: null, next_tap: null, quick_replies: [], tool_id: "ncr_complaint", domain: "debt" }));
  net.onModel(/You maintain one person's money memory/, () => ({ context_updates: null, map_updates: null, decisions: null, commitments: null, results: null }));
  // Deliberately NO responder for the goal-options prompt ("THREE
  // genuinely different 90-day goals"): if BUILD_NOW ever rebuilds a household
  // that has a plan, that call fails loudly here.

  db = makeFakeDb({ model_config: MODEL_ROLES, knowledge_entries: [], tools: [] });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  engine = await import("../api/_lib/engine/index.ts");
  safety = await import("../api/_lib/safety.ts");
});

after(() => {
  restore?.();
  net?.restore();
});

beforeEach(() => {
  net.sent.length = 0;
  net.modelCalls.length = 0;
  inDistress = true;
  routerFor = () => ({});
  distressFor = null;
  changeReply = { action: "none", step_id: null, tool_id: null, reason: "", message: "Nothing to change." };
});

const allText = () => net.sent.map((m) => m.body).join("\n---\n");
const allButtons = () => net.sent.flatMap((m) => m.buttons).map((b) => b.id);
const calls = (re: RegExp) => net.modelCalls.filter((c) => re.test(c.prompt));
const routerCalls = () => calls(/Classify this message from a person to their money assistant/);
const helpCalls = () => calls(/The person is stuck on one step/);
const answerCalls = () => calls(/ROUTER RESULT/);
const forwardCalls = () => calls(/The person forwarded something/);
const secondOpinions = () => calls(/one message from a person to their money coach/);
const distressEvents = (bizId: string) => db.tables.safety_events!.filter((e) => e.business_id === bizId && e.check_name === "distress");

let n = 0;
/** A business with a finished nine-step plan, one step pushed — the live shape. */
async function withPlan(stage: "step_pushed" | "plan_ready" = "step_pushed") {
  const wa = `2780993${String(++n).padStart(4, "0")}`;
  const biz = await dbmod.createBusiness(wa, "ZA");
  const planId = `plan-trap-${n}`;
  db.tables.plans!.push({ id: planId, business_id: biz.id, goal: "Out of the mashonisa's book by day 60.", headline: "", strategy: null, created_at: new Date().toISOString() });
  for (let i = 1; i <= 9; i++) {
    db.tables.plan_steps!.push({
      id: `s-${n}-${i}`, plan_id: planId, workstream_title: "Get out of the mashonisa's book", domain: "debt", step_order: i, step_key: `k${i}`,
      title: i === 1 ? "Know what a mashonisa can and cannot do to you" : `Step ${i}`, push: "Do it.", artifact: null, tool_id: i === 1 ? "ncr_complaint" : null,
      why_for_you: "", done_when: "done", status: "open", pushed_at: i === 1 ? new Date().toISOString() : null, done_at: null, skipped_reason: null,
    });
  }
  await dbmod.updateBusiness(biz.id, {
    stage,
    current_plan_id: planId,
    pending_action: stage === "step_pushed" ? { kind: "step", step_id: `s-${n}-1` } : null,
    context: { name: "Thandi", location: "Woodstock, Cape Town", one_liner: "A salon wage in Woodstock" },
    // The original diagnostic, with the "cash is tight" kind of blocker most
    // people name: this must never be what the exit check reads.
    answers: { person: "Thandi, I work at a salon", location: "Woodstock", blockers: "cash is tight and the admin piles up", objective: "more weekday shifts" },
    map: [],
  } as never);
  return { biz: (await dbmod.findBusiness(wa))!, planId, stepId: `s-${n}-1` };
}

const business = (wa: string) => db.tables.businesses!.find((b) => b.wa_id === wa)!;

// ── (a) "im stuck" is step help, never the router ─────────────────

describe("'im stuck' on a business with a plan", () => {
  test("the live message: step help, not the stabilising message, and the router never sees it", async () => {
    const { biz, stepId } = await withPlan();
    // The router as it behaved live: anything with "stuck" in it is distress.
    routerFor = (m) => (/stuck/i.test(m) ? { intent: "distress", risk: ["distress"] } : {});

    await engine.handleInbound(textFrom(biz.wa_id, "im stuck"));

    assert.equal(routerCalls().length, 0, "a typed 'im stuck' is the step-help shortcut; the router must not get a say");
    assert.equal(helpCalls().length, 1, "step help ran, once");
    assert.match(helpCalls()[0]!.prompt, /Know what a mashonisa can and cannot do to you/, "for the step that was pushed");
    assert.match(allText(), new RegExp(HELP.slice(0, 40)));
    assert.doesNotMatch(allText(), STABILISING_LINE);
    const b = business(biz.wa_id);
    assert.equal(b.stage, "step_pushed");
    assert.equal(b.pending_action?.step_id, stepId);
    assert.equal(distressEvents(biz.id).filter((e) => e.outcome === "block").length, 0, "nothing on the record says distress");
  });

  test("the other ways people type it go the same way, with or without a pushed step", async () => {
    for (const [said, stage] of [
      ["I'm stuck on this step", "step_pushed"],
      ["i need help", "step_pushed"],
      ["I am stuck!", "plan_ready"],
      ["help with this step", "plan_ready"],
    ] as const) {
      const { biz } = await withPlan(stage);
      routerFor = () => ({ intent: "distress", risk: ["distress"] });
      net.modelCalls.length = 0;
      net.sent.length = 0;
      await engine.handleInbound(textFrom(biz.wa_id, said));
      assert.equal(routerCalls().length, 0, `"${said}" never reaches the router`);
      assert.equal(helpCalls().length, 1, `"${said}" is step help`);
      assert.notEqual(business(biz.wa_id).stage, "stabilizing", `"${said}" must not flip the stage`);
    }
  });

  test("but a real question that starts with 'I'm stuck' still gets a real answer", async () => {
    const { biz } = await withPlan();
    await engine.handleInbound(textFrom(biz.wa_id, "I'm stuck on how to price, what should I charge?"));
    assert.equal(helpCalls().length, 0, "not the step-help shortcut");
    assert.equal(answerCalls().length, 1, "answered as the question it is");
    assert.match(answerCalls()[0]!.prompt, /what should I charge/);
  });
});

// ── (b) the router's word alone never flips the stage ──────────────

describe("entering stabilising mode mid-conversation", () => {
  // Review A (r10/distress): this test used to assert that the overruled
  // turn was answered as intent "question", with "distress" stripped from the
  // router result and no stabilising rules in the prompt — i.e. that the
  // router's reading was thrown away, not just kept from flipping the stage.
  // The regex gates the STAGE only; the answer still honours the router.
  test("router says distress, no money words, second opinion disagrees: stage kept, but the answer is written under the stabilising rules", async () => {
    const { biz } = await withPlan();
    routerFor = () => ({ intent: "distress", risk: ["distress"] });
    inDistress = false; // the second opinion on the message itself

    await engine.handleInbound(textFrom(biz.wa_id, "I'm stuck on how to price, what should I charge?"));

    assert.equal(business(biz.wa_id).stage, "step_pushed", "the stage did not move");
    assert.equal(secondOpinions().length, 1, "a second opinion on the message itself was asked for");
    assert.match(secondOpinions()[0]!.prompt, /what should I charge/);
    assert.equal(answerCalls().length, 1, "the message got a real answer");
    assert.match(allText(), new RegExp(ANSWER.slice(0, 30)));
    assert.doesNotMatch(allText(), STABILISING_LINE);
    // The router's reading reaches the answer model intact, with the rules.
    const prompt = answerCalls()[0]!.prompt;
    const routed = JSON.parse(/ROUTER RESULT: (\{.*\})/.exec(prompt)![1]!);
    assert.equal(routed.intent, "distress");
    assert.ok(routed.risk.includes("distress"));
    assert.match(prompt, /THIS MESSAGE MAY SIGNAL HARDSHIP/);
    assert.match(prompt, /nothing that costs money, no borrowing of any kind/);
    assert.ok(!allButtons().includes("a.step.next"), "no 'Next step' button on a turn answered under the stabilising rules");
    // Observable: the second opinion and the overruling are both rows.
    const events = distressEvents(biz.id);
    const overruled = events.filter((e) => (e.flags ?? []).includes("router_overruled"));
    assert.equal(overruled.length, 1);
    assert.equal(overruled[0]!.outcome, "pass");
    assert.match(overruled[0]!.detail, /no money or crisis language and the second opinion disagreed/);
    assert.equal(events.filter((e) => (e.flags ?? []).includes("second_opinion") && e.outcome === "pass").length, 1);
    assert.equal(events.filter((e) => e.outcome === "block").length, 0);
  });

  test("router says distress, no money words, but the second opinion agrees: stabilising", async () => {
    const { biz } = await withPlan();
    routerFor = () => ({ intent: "distress", risk: ["distress"] });
    inDistress = true;
    const said = "this month has been the worst ever, I honestly don't see the doors staying open";
    assert.equal(safety.saysMoneyTrouble(said), false, "the phrasing is outside the word list on purpose");

    await engine.handleInbound(textFrom(biz.wa_id, said));

    assert.equal(secondOpinions().length, 1);
    const b = business(biz.wa_id);
    assert.equal(b.stage, "stabilizing");
    assert.equal(b.answers.since_stabilising, said);
    assert.match(allText(), STABILISING_LINE);
    assert.equal(answerCalls().length, 0);
    assert.match(distressEvents(biz.id).at(-1)!.detail, /second opinion agreed/);
  });

  test("the reviewer's missed money phrasings now flip the stage on the words alone, with no second opinion spent", async () => {
    for (const said of [
      "nobody is buying, i dont know how i will pay the rent",
      "my staff have not been paid",
      "we have not sold anything in three weeks",
    ]) {
      const { biz } = await withPlan();
      routerFor = () => ({ intent: "distress", risk: ["distress"] });
      inDistress = false; // would overrule, if it were asked
      net.modelCalls.length = 0;
      net.sent.length = 0;
      await engine.handleInbound(textFrom(biz.wa_id, said));
      assert.equal(business(biz.wa_id).stage, "stabilizing", `"${said}"`);
      assert.equal(secondOpinions().length, 0, `"${said}": the words were enough`);
      assert.ok(!allButtons().includes("a.step.next"));
    }
  });

  test("router says distress AND the person named the money trouble: stabilising, with the evidence starting at that message", async () => {
    const { biz } = await withPlan();
    routerFor = () => ({ intent: "distress", risk: ["distress"] });
    const said = "I can't pay the rent this month and the landlord is locking me out on Friday";

    await engine.handleInbound(textFrom(biz.wa_id, said));

    const b = business(biz.wa_id);
    assert.equal(b.stage, "stabilizing");
    assert.equal(b.answers.since_stabilising, said, "what was said since entering is THIS message, nothing older");
    assert.match(allText(), STABILISING_LINE);
    assert.equal(distressEvents(biz.id).at(-1)!.outcome, "block");
  });
});

// ── (c) stabilising is not a canned-reply trap ─────────────────────

describe("while stabilising", () => {
  /** A business with a plan that a real money message put into stabilising mode. */
  async function stabilising() {
    const seeded = await withPlan();
    routerFor = () => ({ intent: "distress", risk: ["distress"] });
    await engine.handleInbound(textFrom(seeded.biz.wa_id, "I can't pay the rent this month and the landlord is locking me out on Friday"));
    assert.equal(business(seeded.biz.wa_id).stage, "stabilizing");
    routerFor = () => ({});
    net.sent.length = 0;
    net.modelCalls.length = 0;
    return seeded;
  }

  test("an ordinary question gets a real answer, with the stabilising rules in its prompt and no 'Next step' button", async () => {
    const { biz } = await stabilising();

    await engine.handleInbound(textFrom(biz.wa_id, "how do I get my credit report"));

    assert.equal(answerCalls().length, 1, "the answer path ran");
    assert.match(answerCalls()[0]!.prompt, /HARDSHIP MODE/, "rule 9 travels in the prompt, whatever the router said");
    assert.match(answerCalls()[0]!.prompt, /how do I get my credit report/);
    assert.match(allText(), new RegExp(ANSWER.slice(0, 30)), "the person got the answer");
    assert.doesNotMatch(allText(), CANNED);
    assert.doesNotMatch(allText(), STABILISING_LINE);
    assert.ok(!allButtons().includes("a.step.next"), "no plan button while stabilising");
    const b = business(biz.wa_id);
    assert.equal(b.stage, "stabilizing", "answering a question does not leave stabilising mode");
    assert.match(b.answers.since_stabilising, /how do I get my credit report/, "still kept as words since entering");
    // No exit judgement was spent on a question that is not about the money.
    assert.equal(calls(/said_since_stabilising_began/).length, 0);
  });

  test("a message about the money trouble itself gets the fixed sentence while it is still tight", async () => {
    const { biz } = await stabilising();
    inDistress = true;

    await engine.handleInbound(textFrom(biz.wa_id, "still can't pay the rent, he gave me till Monday"));

    assert.match(allText(), CANNED);
    assert.equal(answerCalls().length, 0);
    assert.equal(business(biz.wa_id).stage, "stabilizing");
  });

  test("'things are fine now': the exit is offered, judged on the words since entering — never the diagnostic", async () => {
    const { biz } = await stabilising();
    inDistress = false;

    await engine.handleInbound(textFrom(biz.wa_id, "things are fine now"));

    assert.match(allText(), /steadier/i);
    assert.ok(allButtons().includes("a.build.now"), "the way out is offered");
    assert.equal(business(biz.wa_id).stage, "stabilizing", "asked, not assumed");
    const exitCheck = calls(/said_since_stabilising_began/);
    assert.equal(exitCheck.length, 1, "one exit judgement");
    assert.match(exitCheck[0]!.prompt, /things are fine now/);
    assert.match(exitCheck[0]!.prompt, /can't pay the rent/, "the message that started it is part of the evidence");
    assert.doesNotMatch(exitCheck[0]!.prompt, /admin piles up/, "the original diagnostic answers are NOT");
    assert.doesNotMatch(exitCheck[0]!.prompt, /more weekday shifts/);
  });

  // Review A: a pleasantry in front of a question is a question.
  test("a question with a pleasantry in front gets a real answer, never the exit check", async () => {
    for (const [said, steady] of [
      ["I'm fine thanks, how do I get my free credit report?", false],
      ["we are good at saving in the stokvel, how do I check it is safe?", false],
      ["the grant is ok but the month is dead by the 20th, what do I do?", true],
      ["I'm ok now, how do I claim UIF?", false],
    ] as const) {
      const { biz } = await stabilising();
      inDistress = steady;
      await engine.handleInbound(textFrom(biz.wa_id, said));
      assert.equal(answerCalls().length, 1, `"${said}" is answered`);
      assert.match(answerCalls()[0]!.prompt, /HARDSHIP MODE/);
      assert.doesNotMatch(allText(), CANNED, `"${said}"`);
      assert.doesNotMatch(allText(), /steadier/i, `"${said}": no plan offer on a pleasantry`);
      assert.ok(!allButtons().includes("a.build.now"), `"${said}"`);
      assert.equal(calls(/said_since_stabilising_began/).length, 0, `"${said}": no exit check`);
      assert.equal(business(biz.wa_id).stage, "stabilizing");
    }
  });

  // Review A: ordinary vocabulary is not money trouble.
  test("'borrow a card machine' or 'customers bouncing' is a question, not the fixed sentence", async () => {
    for (const said of [
      "can I borrow a friend's card machine for the market?",
      "how do I stop customers bouncing between me and the salon next door?",
      "a customer is sinking my ratings with bad reviews, what do I do?",
    ]) {
      const { biz } = await stabilising();
      await engine.handleInbound(textFrom(biz.wa_id, said));
      assert.equal(answerCalls().length, 1, `"${said}" is answered`);
      assert.doesNotMatch(allText(), CANNED, `"${said}"`);
      assert.equal(business(biz.wa_id).stage, "stabilizing");
    }
  });

  test("but 'should I take a loan to restock?' is about the money: the fixed sentence, no answer call", async () => {
    const { biz } = await stabilising();
    inDistress = true;
    await engine.handleInbound(textFrom(biz.wa_id, "should I take a loan to restock?"));
    assert.match(allText(), CANNED);
    assert.equal(answerCalls().length, 0);
  });

  // Review A: the rules live in the core, so a forwarded link sees them too.
  test("a forwarded lender link is judged with the stabilising rules in its prompt", async () => {
    const { biz } = await stabilising();
    const said = "https://quickloans.co.za/apply what do you think?";
    assert.equal(safety.saysMoneyTrouble(said), false);

    await engine.handleInbound(textFrom(biz.wa_id, said));

    assert.equal(forwardCalls().length, 1, "the forward path ran, once");
    assert.match(forwardCalls()[0]!.prompt, /HARDSHIP MODE/);
    assert.match(forwardCalls()[0]!.prompt, /no borrowing of any kind/);
    assert.match(allText(), new RegExp(FORWARD.slice(0, 20)), "the reply is still delivered");
    assert.equal(business(biz.wa_id).stage, "stabilizing");
    assert.ok(!allButtons().includes("a.step.next"));
  });

  test("every prompt built for a stabilising business carries the rules: the core block itself", async () => {
    const { biz } = await stabilising();
    const { buildCore } = await import("../api/_lib/engine/context.ts");
    const stab = await buildCore(business(biz.wa_id) as never, { query: "anything" });
    assert.match(stab.text, /HARDSHIP MODE/);
    const { helpPrompt, forwardPrompt, answerPrompt } = await import("../api/_lib/prompts.ts");
    for (const p of [
      helpPrompt(stab.text, { title: "t", push: "p", done_when: "d" }, "stuck"),
      forwardPrompt(stab.text, { source: "a document the person forwarded", extracted: "x", note: "" }),
      answerPrompt(stab.text, "q", "{}"),
    ]) assert.match(p, /HARDSHIP MODE/);
    const normal = await buildCore({ ...business(biz.wa_id), stage: "step_pushed" } as never, { query: "anything" });
    assert.doesNotMatch(normal.text, /HARDSHIP MODE|MAY SIGNAL HARDSHIP/);
    const turn = await buildCore({ ...business(biz.wa_id), stage: "step_pushed" } as never, { query: "anything", stabilisingTurn: true });
    assert.match(turn.text, /THIS MESSAGE MAY SIGNAL HARDSHIP/);
  });

  // Review A: old plan buttons are held, not a silent exit.
  test("old plan buttons tapped while stabilising keep the stage, say so once, and leave a row", async () => {
    for (const tap of ["a.step.help", "a.step.next", "a.step.done", "a.walk.stuck", "a.step.skip", "a.walk.next", "a.step.walk", "a.step.pdf", "a.walk.later", "a.out.better:STEP"]) {
      const { biz, stepId } = await stabilising();
      const before = business(biz.wa_id).answers.since_stabilising;
      const eventsBefore = distressEvents(biz.id).length;
      await engine.handleInbound(tapFrom(biz.wa_id, tap.replace("STEP", stepId), "tap"));
      const b = business(biz.wa_id);
      assert.equal(b.stage, "stabilizing", `${tap}: stage kept`);
      assert.equal(b.answers.since_stabilising, before, `${tap}: evidence untouched`);
      assert.equal(b.pending_action, null, `${tap}: no step pushed`);
      assert.equal(helpCalls().length, 0, `${tap}: no step help`);
      assert.equal(net.modelCalls.length, 0, `${tap}: no model call at all`);
      assert.equal(net.sent.length, 1, `${tap}: one reply`);
      assert.match(allText(), HELD, tap);
      assert.ok(!allButtons().includes("a.step.next"), tap);
      const held = distressEvents(biz.id).slice(eventsBefore);
      assert.equal(held.length, 1, tap);
      assert.equal(held[0]!.outcome, "block");
      assert.deepEqual(held[0]!.flags, ["plan_held"]);
      assert.match(held[0]!.detail, new RegExp(tap.split(":")[0]!.replace(/\./g, "\\.")));
      assert.equal(db.tables.plan_steps!.find((s) => s.id === stepId)!.status, "open", `${tap}: the step is untouched`);
    }
  });

  // ── (d) the way out keeps the plan ──
  test("'Yes, build it' on a business that has a plan keeps the plan and goes back to it", async () => {
    const { biz, planId } = await stabilising();
    inDistress = false;
    await engine.handleInbound(textFrom(biz.wa_id, "I paid the rent, things are fine now"));
    assert.ok(allButtons().includes("a.build.now"));
    // Live, round 11: with a plan already built, the offer said it would
    // "build you the 90-day plan". It says what the tap really does.
    assert.match(allText(), /pick your 90-day plan back up/);
    assert.doesNotMatch(allText(), /build you the 90-day plan/);
    assert.ok(net.sent.flatMap((m) => m.buttons).some((b) => b.id === "a.build.now" && b.title === "Back to my plan"));
    net.sent.length = 0;
    net.modelCalls.length = 0;

    await engine.handleInbound(tapFrom(biz.wa_id, "a.build.now", "Back to my plan"));

    const b = business(biz.wa_id);
    assert.equal(b.stage, "plan_ready");
    assert.equal(b.current_plan_id, planId, "the same plan");
    assert.equal(b.pending_action, null);
    assert.equal(db.tables.plans!.filter((p) => p.business_id === biz.id).length, 1, "no second plan");
    assert.equal(db.tables.plan_builds!.filter((p) => p.business_id === biz.id).length, 0, "no build started");
    assert.equal(net.modelCalls.length, 0, "no goal-options call, no model call at all");
    assert.match(allText(), /your plan is still here/i);
    assert.ok(allButtons().includes("a.step.next"));

    // And the loop is closed: "im stuck" now is step help again.
    net.sent.length = 0;
    net.modelCalls.length = 0;
    routerFor = () => ({ intent: "distress", risk: ["distress"] });
    await engine.handleInbound(textFrom(biz.wa_id, "im stuck"));
    assert.equal(helpCalls().length, 1);
    assert.equal(business(biz.wa_id).stage, "step_pushed");
  });
});

// ── Review of round 10: the holes the integration review found ──

describe("round 10 integration: stabilising holds every plan door, and money trouble is never a change request", () => {
  /** A business with a plan that a real money message put into stabilising mode. */
  async function stabilisingWithPlan() {
    const seeded = await withPlan("plan_ready");
    routerFor = () => ({ intent: "distress", risk: ["distress"] });
    await engine.handleInbound(textFrom(seeded.biz.wa_id, "I can't pay the rent this month and the landlord is locking me out on Friday"));
    assert.equal(business(seeded.biz.wa_id).stage, "stabilizing");
    routerFor = () => ({});
    net.sent.length = 0;
    net.modelCalls.length = 0;
    return seeded;
  }

  /** The "which step do you mean?" list, waiting for its answer. */
  async function heldChangeList() {
    const seeded = await withPlan("plan_ready");
    const ids = db.tables.plan_steps!.filter((s) => s.plan_id === seeded.planId).map((s) => s.id);
    await dbmod.updateBusiness(seeded.biz.id, {
      stage: "changing",
      pending_action: { kind: "change", awaiting: "step", asked: "drop that one", intent: "drop_step", options: [ids[0], ids[1]], count: 0 },
    } as never);
    return { ...seeded, ids };
  }

  const stepStatuses = (planId: string) => db.tables.plan_steps!.filter((s) => s.plan_id === planId).map((s) => s.status);

  // Findings 2 and 6: the gate held PLAN_TAPS only.
  test("every other plan or build button tapped while stabilising is held too: stage kept, one line, a plan_held row", async () => {
    for (const tap of ["a.plan.change", "a.plan.nvm", "a.chg.yes", "a.chg.no", "a.plan.rebuild", "a.plan.why", "a.id.fix", "a.id.ok"]) {
      const { biz, planId } = await stabilisingWithPlan();
      const eventsBefore = distressEvents(biz.id).length;
      await engine.handleInbound(tapFrom(biz.wa_id, tap, "tap"));
      const b = business(biz.wa_id);
      assert.equal(b.stage, "stabilizing", `${tap}: stage kept`);
      assert.equal(b.pending_action, null, `${tap}: nothing left waiting`);
      assert.equal(net.sent.length, 1, `${tap}: one reply`);
      assert.match(allText(), HELD, tap);
      assert.ok(!allButtons().includes("a.step.next") && !allButtons().includes("a.plan.change"), `${tap}: no plan buttons`);
      const held = distressEvents(biz.id).slice(eventsBefore);
      assert.equal(held.length, 1, tap);
      assert.deepEqual(held[0]!.flags, ["plan_held"]);
      assert.match(held[0]!.detail, new RegExp(tap.replace(/\./g, "\\.")));
      assert.ok(stepStatuses(planId).every((st) => st === "open"), `${tap}: no step touched`);
      assert.equal(db.tables.plan_builds!.filter((p) => p.business_id === biz.id).length, 0, `${tap}: no build started`);
      net.sent.length = 0;
    }
  });

  test("Menu and See my plan while stabilising offer no Next step and no Change my plan", async () => {
    for (const tap of ["a.menu", "a.plan.see"]) {
      const { biz } = await stabilisingWithPlan();
      await engine.handleInbound(tapFrom(biz.wa_id, tap, "tap"));
      assert.equal(business(biz.wa_id).stage, "stabilizing", tap);
      assert.ok(net.sent.length >= 1, tap);
      assert.ok(!allButtons().includes("a.step.next"), `${tap}: no Next step`);
      assert.ok(!allButtons().includes("a.plan.change"), `${tap}: no Change my plan`);
      net.sent.length = 0;
    }
  });

  test("an old 'Not quite' tapped long after the read-back is a stale tap: the plan and the stage are kept", async () => {
    const { biz, planId } = await withPlan("plan_ready");
    await engine.handleInbound(tapFrom(biz.wa_id, "a.id.fix", "Not quite"));
    const b = business(biz.wa_id);
    assert.equal(b.stage, "plan_ready");
    assert.equal(b.current_plan_id, planId);
    assert.doesNotMatch(allText(), /tell me in a few words where your money actually comes from/);
    assert.match(allText(), /earlier message|well past it/);
  });

  // Findings 1 and 5a: the list was re-sent from the stale business.
  test("a money question while 'which step?' is waiting: the stabilising message, and the plan list is NOT sent after it", async () => {
    const { biz, planId } = await heldChangeList();
    routerFor = () => ({ intent: "distress", risk: ["distress"] });
    await engine.handleInbound(textFrom(biz.wa_id, "How do I keep going when I can't pay rent this month?"));
    assert.match(allText(), STABILISING_LINE);
    assert.doesNotMatch(allText(), /And the change you asked for/, "no plan list after the stabilising message (rule 9)");
    const b = business(biz.wa_id);
    assert.equal(b.stage, "stabilizing");
    assert.equal(b.pending_action, null);

    // "2" now is not a pick from a list nothing is waiting on.
    net.sent.length = 0;
    routerFor = () => ({});
    await engine.handleInbound(textFrom(biz.wa_id, "2"));
    assert.ok(stepStatuses(planId).every((st) => st === "open"), "no step dropped");
    assert.equal(business(biz.wa_id).stage, "stabilizing");
  });

  test("an ordinary question while 'which step?' is waiting still gets the list again (the hold is kept)", async () => {
    const { biz } = await heldChangeList();
    await engine.handleInbound(textFrom(biz.wa_id, "which one is the NCR one?"));
    assert.match(allText(), new RegExp(ANSWER.slice(0, 30)));
    assert.match(allText(), /And the change you asked for — which step do you mean\?/);
    assert.equal(business(biz.wa_id).stage, "changing");
  });

  // Finding 5b: a money statement went to applyChange.
  test("a money statement while a change is waiting — held list or not — is never a change request: distress is checked and stabilising applies", async () => {
    for (const held of [true, false]) {
      const seeded = held ? await heldChangeList() : await withPlan("plan_ready");
      if (!held) await dbmod.updateBusiness(seeded.biz.id, { stage: "changing", pending_action: { kind: "change" } } as never);
      const ids = db.tables.plan_steps!.filter((s) => s.plan_id === seeded.planId).map((s) => s.id);
      changeReply = { action: "drop_step", step_id: ids[1], tool_id: null, reason: "r", message: "Dropped it." };
      routerFor = () => ({ intent: "distress", risk: ["distress"] });
      net.sent.length = 0;
      net.modelCalls.length = 0;
      await engine.handleInbound(textFrom(seeded.biz.wa_id, "I can't pay rent, collectors are calling"));
      const b = business(seeded.biz.wa_id);
      assert.equal(b.stage, "stabilizing", `held=${held}: distress detected`);
      assert.equal(b.pending_action, null, `held=${held}: the change hold is cleared`);
      assert.match(allText(), STABILISING_LINE, `held=${held}`);
      assert.equal(calls(/has said something about it they want changed/).length, 0, `held=${held}: never sent to the change model`);
      assert.ok(stepStatuses(seeded.planId).every((st) => st === "open"), `held=${held}: no step dropped`);
      assert.ok(!allButtons().includes("a.step.next"), `held=${held}: no Next step`);
    }
  });

  test("a money question at 'should I update your plan?': the stabilising message, and the yes/no is NOT asked again", async () => {
    const { biz } = await withPlan("plan_ready");
    await dbmod.updateBusiness(biz.id, { stage: "confirm_change", pending_action: { kind: "change", change_id: "chg-1" } } as never);
    routerFor = () => ({ intent: "distress", risk: ["distress"] });
    await engine.handleInbound(textFrom(biz.wa_id, "how will I pay the rent, the collectors are calling?"));
    assert.match(allText(), STABILISING_LINE);
    assert.doesNotMatch(allText(), /should I update your plan/);
    assert.ok(!allButtons().includes("a.chg.yes"));
    assert.equal(business(biz.wa_id).stage, "stabilizing");
  });

  // Finding 4: offered the plan, then refused it, forever.
  test("plan-less: steadier, then 'Yes, build it' builds — the diagnostic-wide gate does not send them straight back, and the skip is on the record", async () => {
    const wa = `2780993${String(++n).padStart(4, "0")}`;
    const biz = await dbmod.createBusiness(wa, "ZA");
    await dbmod.updateBusiness(biz.id, {
      stage: "stabilizing",
      pending_action: null,
      answers: { person: "Thandi", location: "Woodstock", blockers: "I can't pay rent and the landlord is locking me out, collectors are calling", objective: "survive" },
      map: [],
    } as never);
    // A judge that reads the diagnostic as distress, and the words since as steadier.
    distressFor = (p) => (/said_since_stabilising_began/.test(p) ? false : /landlord is locking/.test(p));

    await engine.handleInbound(textFrom(wa, "I paid the rent, things are fine now"));
    assert.ok(allButtons().includes("a.build.now"), "the way out is offered");
    assert.match(allText(), /build you the 90-day plan now/, "with no plan yet, the offer is to build one");
    net.sent.length = 0;

    await engine.handleInbound(tapFrom(wa, "a.build.now", "Yes, build it"));
    assert.doesNotMatch(allText(), STABILISING_LINE, "not sent straight back to stabilising");
    assert.ok(allButtons().includes("a.id.ok"), "the read-back arrives");
    const b = business(wa);
    assert.equal(b.stage, "confirm_identity");
    const cleared = distressEvents(biz.id).filter((e) => (e.flags ?? []).includes("stabilising_exit_confirmed"));
    assert.equal(cleared.length, 1, "the bypass is a row on the record");
  });

  test("plan-less: an old 'Yes, build it' after the offer was withdrawn does not carry the clearance, and a business put back into stabilising keeps no building marker", async () => {
    const wa = `2780993${String(++n).padStart(4, "0")}`;
    const biz = await dbmod.createBusiness(wa, "ZA");
    await dbmod.updateBusiness(biz.id, {
      stage: "stabilizing",
      pending_action: null,
      answers: { person: "Thandi", location: "Woodstock", blockers: "I can't pay rent and the landlord is locking me out, collectors are calling", objective: "survive" },
      map: [],
    } as never);
    distressFor = () => true;
    await engine.handleInbound(textFrom(wa, "still can't pay the rent"));
    assert.match(allText(), CANNED);
    net.sent.length = 0;

    await engine.handleInbound(tapFrom(wa, "a.build.now", "Yes, build it"));
    assert.match(allText(), STABILISING_LINE, "the diagnostic-wide gate still applies without a confirmed exit");
    const b = business(wa);
    assert.equal(b.stage, "stabilizing");
    assert.equal(b.pending_action, null, "no stale {kind:'building'} left behind");
    assert.equal(distressEvents(biz.id).filter((e) => (e.flags ?? []).includes("stabilising_exit_confirmed")).length, 0);
  });
});

// ── The two regexes, on the words people in these markets actually use ──

describe("saysMoneyTrouble", () => {
  test("money and crisis language", () => {
    for (const t of [
      "I can't pay rent",
      "I cannot afford a generator and the landlord wants rent on Friday",
      "the landlord says he will lock me out on Friday",
      "the landlord gave me a week",
      "I owe my supplier KSh 18,000 and rent is due next week",
      "I owe three suppliers, I have not paid my boy for two months",
      "I am thinking of closing the shop before it gets worse",
      "I have no money to restock, I owe rent and my supplier wants paying. I am finished",
      "Sales have been dead since June",
      "I took a loan to buy stock and the debit order is eating everything. Should I take another one or must I close?",
      "the debt collectors are calling every day",
      "a loan shark is after me",
      "I'm broke",
      "cash is tight",
      "the money is finished",
      "we are going under",
      "bankrupt",
      "closing down next month",
      "behind on the rent",
      "I can't buy stock",
      "should I take a loan to restock?",
      "my stock is finished and there is nothing to sell",
      "I’m drowning in debt",
      // Review A: real phrasings the first list missed.
      "nobody is buying, i dont know how i will pay the rent",
      "my staff have not been paid",
      "the bank is taking my car and I had to send the staff home",
      "we have not sold anything in three weeks",
      "I dont know how I will pay my workers",
      "we havent made a sale in 2 weeks and the supplier wants his money",
      "i had to send everyone home, there is nothing coming in",
      "the electricity got cut off",
      "I haven't sold anything in three weeks and I don't know how I will pay my workers",
      "customers stopped coming, I can't keep the lights on",
      "the bank is taking my car next week",
      "I have not made one sale this month",
      "I had to send my staff home, I cannot keep them",
      "I don't know how I will pay rent on Friday",
      // The scoped money nouns still match in a money phrase.
      "I'm in debt",
      "I'm stuck with a loan I can't repay",
      "my loan repayment is due",
      "payments keep bouncing",
      "my debit orders bounced",
      "the business is sinking",
      "I borrowed money from the mashonisa",
      "the collectors came to the shop",
      // Charles: a household's hardship in so many words.
      "I can't buy food for the kids this week",
      "the electricity got cut off and I have no money for prepaid",
      "my grant was stopped and I don't know how I will pay rent",
      "the mashonisa is holding my SASSA card",
      "there is a garnishee on my salary",
      "I was retrenched last month",
      "I lost my job and the rent is behind",
    ]) assert.equal(safety.saysMoneyTrouble(t), true, `"${t}"`);
  });

  test("being stuck, worried or busy is not money trouble", () => {
    for (const t of [
      "im stuck",
      "I'm stuck",
      "I'm stuck on how to price, what should I charge?",
      "how do I get more customers",
      "should I put my prices up?",
      "I'm struggling to find time for admin",
      "things are fine now",
      "I paid the rent, two guesthouses signed up weekly",
      "customers owe me money, how do I collect?",
      "how do I chase customers who haven't paid?",
      "I rent a chair at the salon, is that a problem?",
      "should I take card payments?",
      "help",
      "I'm worried nobody will come on Saturdays",
      "",
      // Review A: ordinary vocabulary, not money trouble.
      "how do I stop customers bouncing between me and the salon next door?",
      "a customer is sinking my ratings with bad reviews, what do I do?",
      "can I borrow a friend's card machine for the market?",
      "can I borrow my sister's phone for WhatsApp Business?",
      "where do I find my loan application form?",
      "the ball bounced off the sign",
      "I have a debt-free business idea",
      "https://quickloans.co.za/apply what do you think?",
    ]) assert.equal(safety.saysMoneyTrouble(t), false, `"${t}"`);
  });
});

describe("saysSteadied", () => {
  test("recovery language, and the invitation the stabilising message extends", () => {
    for (const t of [
      "things are fine now",
      "it's better now, things have settled",
      "I paid the rent",
      "I have paid the rent and two guesthouses signed up weekly",
      "the debt is cleared",
      "rent is sorted",
      "we're back on track",
      "I'm ready to build",
      "let's build the plan",
      "start",
      "ready",
      "ok, build it",
      "no longer struggling",
      "cash flow has picked up",
      "I'm fine now",
      "sales are picking up again",
      "everything's ok now",
      "we are ok again",
    ]) assert.equal(safety.saysSteadied(t), true, `"${t}"`);
  });

  test("questions and bad news are not recovery", () => {
    for (const t of [
      "how do I get more customers",
      "im stuck",
      "still can't pay the rent",
      "the landlord gave me a week",
      "I want to build a website",
      "things are not fine",
      "it is better to take cash or card?",
      "",
      // Review A: pleasantries and "X is ok/good but ..." are not recovery.
      "I'm fine thanks, how do I register for VAT?",
      "we are good at fixing phones, how do I get found on google?",
      "I am ok, what is a tax number?",
      "hi, I'm good. how do I price my haircuts?",
      "we are better at cakes than bread, should I focus on cakes?",
      "sales are ok on Fridays but dead on Mondays, what do I do?",
      "I'm good at braids but nobody knows, how do I get found?",
      "are we ok to sell food without a permit?",
      "I'm fine with cash only, but should I get a card machine?",
      "the business is good but I need more weekday customers",
      "I think I better start posting on Facebook, how?",
      "let's go with WhatsApp status then, how do I set it up?",
    ]) assert.equal(safety.saysSteadied(t), false, `"${t}"`);
  });
});

describe("aboutTheMoney (the stabilising split, WhatsApp and web)", () => {
  test("a question wins over a pleasantry; money words and asking to build always count", () => {
    for (const t of ["I'm ok now, how do I register for VAT?", "things are better now, what should I post this week?", "how do I get more customers"])
      assert.equal(safety.aboutTheMoney(t), false, `"${t}"`);
    for (const t of ["things are fine now", "I paid the rent", "should I take a loan to restock?", "can we build the plan now?", "still can't pay the rent"])
      assert.equal(safety.aboutTheMoney(t), true, `"${t}"`);
  });
});
