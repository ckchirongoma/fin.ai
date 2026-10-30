// Charles — PRIORITY 4.5: reply-grounding for tool-help replies specifically.
//
// checkReply (safety.ts) already asks whether a stated PRICE is backed by
// the verified tool-costs sheet for the whole conversation — but a
// "help"/"stuck" reply (helpWithStep, which is ALSO the walkthrough's own
// "I'm stuck" handler: steps.ts dispatches both ACT.STEP_HELP and
// ACT.WALK_STUCK to the exact same function) can state plenty of OTHER
// concrete facts about the ONE tool the step is actually about — a
// button/link's wording, a timeframe, a fee in words — that checkReply's
// price check never looks at. checkToolHelpGrounding is the narrower,
// tool-scoped check for exactly that: is a concrete claim traceable to
// tools.cost / tools.walkthrough / tools.url, or invented.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
process.env.WORKER_SECRET = "fake-worker-secret";
delete process.env.TYPESAFE_API_KEY; // no Jev key: judge() falls to the model backstop

import { installFakeNet, makeFakeDb, tapFrom, textFrom, type FakeDb, type FakeNet } from "./_fakes.ts";

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let dbmod: typeof import("../api/_lib/db.ts");
let safety: typeof import("../api/_lib/safety.ts");
let steps: typeof import("../api/_lib/engine/steps.ts");
let engine: typeof import("../api/_lib/engine/index.ts");

const GBP_TOOL = {
  id: "gbp",
  country: "ZA",
  domain: "credit_record",
  stages: ["run"],
  keywords: ["gbp"],
  name: "Google Business Profile",
  fits: "any local business",
  not_when: "online-only",
  why: "shows up when people search nearby",
  cost: "Free",
  url: "https://business.google.com",
  setup: "a few minutes",
  walkthrough: ["Go to google.com/business and sign in.", "Tap Manage now and enter your business name.", "Verify by whichever method Google offers you."],
  verified_on: "2026-08-01",
};

/** Every "You are a strict checker" call, whichever check it is for, in the
 * fixed shape safety.ts's model backstop expects: false for everything
 * unless a test opts a specific id in. */
let checkerAnswers: (ids: string[], prompt: string) => Record<string, boolean>;

/** What the "help" model says, per test. One responder, registered once:
 * the fake gateway answers with the FIRST registered match, so registering a
 * fresh /Unstick them/ responder inside each test silently kept answering
 * with whichever test registered first. */
let helpReply: Record<string, unknown>;

before(async () => {
  net = installFakeNet();
  net.onModel(/You are a strict checker/, (prompt) => {
    const ids = [...prompt.matchAll(/- "([a-z_]+)":/g)].map((m) => m[1]!);
    return checkerAnswers(ids, prompt);
  });
  net.onModel(/Unstick them/, () => helpReply);
  db = makeFakeDb({
    model_config: ["help", "safety"].map((role) => ({ role, provider: "openrouter", model: `test/${role}`, fallbacks: [], params: {}, enabled: true })),
    tools: [GBP_TOOL],
  });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  safety = await import("../api/_lib/safety.ts");
  steps = await import("../api/_lib/engine/steps.ts");
  engine = await import("../api/_lib/engine/index.ts");
});

after(() => {
  restore?.();
  net?.restore();
});

beforeEach(() => {
  net.sent.length = 0;
  db.tables.safety_events = [];
  checkerAnswers = (ids) => Object.fromEntries(ids.map((id) => [id, false]));
  helpReply = { message: "Try the next step on the tool's own page.", artifact: null, next_tap: null, quick_replies: [], tool_id: "gbp", domain: "credit_record" };
});

const helpCalls = () => net.modelCalls.filter((c) => /Unstick them/.test(c.prompt)).length;

// ── Unit: checkToolHelpGrounding itself ─────────────────────────────

test("a fee stated in a help reply that is NOT in the tool's stored cost is flagged", async () => {
  checkerAnswers = (ids) => Object.fromEntries(ids.map((id) => [id, id === "ungrounded_claim"]));

  const r = await safety.checkToolHelpGrounding(
    "Google Business Profile costs R99 a month once you're past the free trial.",
    { name: "Google Business Profile", cost: "Free", url: "https://business.google.com", walkthrough: GBP_TOOL.walkthrough },
    { businessId: "biz-1" },
  );

  assert.ok(r.flags.includes("tool_help_ungrounded"));
  assert.match(r.message, /double-check that detail/i);
  const event = db.tables.safety_events!.at(-1)!;
  assert.equal(event.check_name, "tool_help_grounding");
  assert.equal(event.outcome, "flag");
});

test("a claim that matches the tool's stored data exactly is never flagged", async () => {
  checkerAnswers = (ids) => Object.fromEntries(ids.map((id) => [id, false]));

  const r = await safety.checkToolHelpGrounding(
    "Google Business Profile is free, and the walkthrough already has you covered — tap Manage now.",
    { name: "Google Business Profile", cost: "Free", url: "https://business.google.com", walkthrough: GBP_TOOL.walkthrough },
    { businessId: "biz-1" },
  );

  assert.deepEqual(r.flags, []);
  assert.equal(r.message, "Google Business Profile is free, and the walkthrough already has you covered — tap Manage now.");
});

test("with no tool linked to the step at all, a concrete claim has nothing to be grounded in and is flagged", async () => {
  checkerAnswers = (ids) => Object.fromEntries(ids.map((id) => [id, id === "ungrounded_claim"]));

  const r = await safety.checkToolHelpGrounding("That usually takes about 5 business days to clear.", null, { businessId: "biz-1" });
  assert.ok(r.flags.includes("tool_help_ungrounded"));
});

test("an empty reply is a no-op — nothing to check, no event recorded", async () => {
  const r = await safety.checkToolHelpGrounding("   ", { name: "x", cost: "Free" }, { businessId: "biz-1" });
  assert.deepEqual(r, { message: "   ", flags: [], engine: "none" });
  assert.equal(db.tables.safety_events!.length, 0);
});

// ── Integration: wired into helpWithStep (== the walkthrough's own "I'm stuck") ──

let planCounter = 0;
async function bizWithStep(waId: string) {
  const biz = await dbmod.createBusiness(waId, "ZA");
  const planId = `plan-${++planCounter}`;
  db.tables.plans!.push({ id: planId, business_id: biz.id, goal: "Sign three retainers.", headline: "", strategy: null, created_at: new Date().toISOString() });
  const step = {
    id: `step-${planCounter}`,
    plan_id: planId,
    workstream_title: "Be findable by people who don't know you",
    domain: "credit_record",
    step_order: 1,
    step_key: "f1",
    title: "Show up when people search nearby",
    push: "Claim your Google listing.",
    artifact: null,
    tool_id: "gbp",
    why_for_you: "You said people search nearby.",
    done_when: "your profile is verified",
    status: "open",
    pushed_at: null,
    done_at: null,
    skipped_reason: null,
  };
  db.tables.plan_steps!.push(step);
  await dbmod.updateBusiness(biz.id, { context: { name: "Verify Script Test Business", location: "Woodstock, Cape Town" } } as never);
  const fresh = (await dbmod.findBusiness(waId))!;
  return { biz: fresh, step };
}

test("helpWithStep flags a fee it invented that the tool's own stored cost does not back", async () => {
  helpReply = {
    message: "No problem — Google Business Profile has a small R150 setup fee before you can claim it.",
    artifact: null,
    next_tap: null,
    quick_replies: [],
    tool_id: "gbp",
    domain: "credit_record",
  };
  // reply_compliance's own checks all pass; only the new, narrower
  // tool_help_grounding check is the one that catches this.
  checkerAnswers = (ids) => Object.fromEntries(ids.map((id) => [id, id === "ungrounded_claim"]));

  const { biz } = await bizWithStep("27831000001");
  await steps.helpWithStep(biz, "how do I get started with this?");

  const bodies = net.sent.map((m) => m.body).join("\n---\n");
  assert.match(bodies, /double-check that detail/i, "the invented fee must be flagged, not sent as stated fact");
  const events = db.tables.safety_events!.filter((e) => e.check_name === "tool_help_grounding");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.outcome, "flag");
});

// The walkthrough's "I'm stuck" (a.walk.stuck) and step help (a.step.help)
// both dispatch to helpWithStep — see index.ts. helpWithStep then has two
// paths, and both have to be safe:
//   - a bare "I'm stuck" on the line just shown resends that STORED line
//     (tools.walkthrough) with no model call at all — main's fast path. The
//     stored line is the grounding data itself, so nothing ungrounded can be
//     sent, and there is no model output for the grounding check to inspect.
//   - anything more specific (typed mid-walkthrough, which the "walking"
//     stage also routes to helpWithStep) reaches the model, and that reply
//     must go through the same grounding check as a.step.help's does.

test("a bare 'I'm stuck' tap mid-walkthrough resends the stored line — no model call, so nothing ungrounded can reach the owner", async () => {
  helpReply = {
    message: "Verification for Google Business Profile always takes exactly 30 days, no exceptions.",
    artifact: null,
    next_tap: null,
    quick_replies: [],
    tool_id: "gbp",
    domain: "credit_record",
  };
  checkerAnswers = (ids) => Object.fromEntries(ids.map((id) => [id, id === "ungrounded_claim"]));

  const { biz, step } = await bizWithStep("27831000002");
  await steps.startWalk(biz, "gbp", step.id);
  const callsBefore = helpCalls();
  net.sent.length = 0;

  await engine.handleInbound(tapFrom("27831000002", "a.walk.stuck", "I'm stuck"));

  const bodies = net.sent.map((m) => m.body).join("\n---\n");
  assert.equal(helpCalls(), callsBefore, "the help model was never called");
  assert.match(bodies, /here's that step again/i);
  assert.match(bodies, /Go to google\.com\/business and sign in\./, "the stored walkthrough line itself was resent");
  assert.doesNotMatch(bodies, /30 days/, "the model's invented claim never had a chance to be sent");
});

test("a specific question typed mid-walkthrough reaches the model through the same helpWithStep path, and its invented claim is flagged", async () => {
  helpReply = {
    message: "Verification for Google Business Profile always takes exactly 30 days, no exceptions.",
    artifact: null,
    next_tap: null,
    quick_replies: [],
    tool_id: "gbp",
    domain: "credit_record",
  };
  checkerAnswers = (ids) => Object.fromEntries(ids.map((id) => [id, id === "ungrounded_claim"]));

  const { biz, step } = await bizWithStep("27831000004");
  await steps.startWalk(biz, "gbp", step.id);
  const callsBefore = helpCalls();
  net.sent.length = 0;

  await engine.handleInbound(textFrom("27831000004", "it wants a verification code — how long until that arrives?"));

  const bodies = net.sent.map((m) => m.body).join("\n---\n");
  assert.equal(helpCalls(), callsBefore + 1, "a specific question goes to the model, not the fast path");
  assert.match(bodies, /double-check that detail/i, "the walkthrough's stuck path is the same helpWithStep, so its model reply is grounding-checked too");
  const events = db.tables.safety_events!.filter((e) => e.check_name === "tool_help_grounding");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.outcome, "flag");
});

test("a help reply that only restates the tool's real, stored facts is never flagged", async () => {
  helpReply = {
    message: "Google Business Profile is free — tap Manage now on business.google.com to get started.",
    artifact: null,
    next_tap: null,
    quick_replies: [],
    tool_id: "gbp",
    domain: "credit_record",
  };
  checkerAnswers = (ids) => Object.fromEntries(ids.map((id) => [id, false]));

  const { biz } = await bizWithStep("27831000003");
  await steps.helpWithStep(biz, "is this free?");

  const bodies = net.sent.map((m) => m.body).join("\n---\n");
  assert.doesNotMatch(bodies, /double-check that detail/i);
  assert.equal(db.tables.safety_events!.filter((e) => e.check_name === "tool_help_grounding" && e.outcome === "flag").length, 0);
});
