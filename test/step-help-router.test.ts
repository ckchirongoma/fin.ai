// Charles — Jev-as-router, applied to the single highest-volume model call in
// the product (Priority 4.4 of the 2026-09-22 fix pass).
//
// helpWithStep ("I'm stuck") used to always call a model, even when the owner
// is mid-walkthrough and the content that would answer them — the exact tool
// walkthrough line — was already sent seconds ago. That is a known,
// deterministic answer sitting in `tools.walkthrough`; calling a model to
// reproduce it is exactly the unnecessary AI invocation the founder asked to
// be tightened ("AI is only invoked when it's needed"). These tests drive the
// real dispatcher (engine/index.ts -> engine/steps.ts's helpWithStep) end to
// end against the in-memory db and a scripted model gateway, and assert on
// the fake network's own call count — not a mock of helpWithStep itself —
// so a regression that routes around the check would still be caught.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";
process.env.WORKER_SECRET = "fake-worker-secret";
// No Jev key: checkReply must fall through to the "safety" model backstop,
// which is the configuration most deployments run (matches journey.e2e).
delete process.env.TYPESAFE_API_KEY;

import { installFakeNet, makeFakeDb, tapFrom, textFrom, type FakeDb, type FakeNet } from "./_fakes.ts";

const OWNER = "27809970000";
const TOOL_ID = "gbp";

const MODEL_ROLES = ["help", "safety"].map((role) => ({
  role,
  provider: "openrouter",
  model: `test/${role}`,
  fallbacks: [],
  params: { max_tokens: 900 },
  enabled: true,
}));

const TOOL_WALKTHROUGH = [
  "Go to google.com/business and sign in with the account you use for this business.",
  "Tap Manage now, then enter the business name exactly as it appears on your signage.",
  "Choose service area or storefront, add your address, then submit for verification.",
];

let db: FakeDb;
let net: FakeNet;
let engine: typeof import("../api/_lib/engine/index.ts");
let restoreDb: () => void;

/** A fresh business + plan + step + tool, wired the way pushNextStep leaves them. */
function seedBusiness(overrides: Record<string, unknown> = {}) {
  const bizId = "biz-help-router";
  const planId = "plan-help-router";
  const stepId = "step-help-router";

  db.tables.businesses!.push({
    id: bizId,
    wa_id: OWNER,
    country: "ZA",
    stage: "step_pushed",
    answers: {},
    context: { name: "Thandi's Salon", location: "Woodstock, Cape Town", one_liner: "A salon in Woodstock" },
    map: [],
    goal: [],
    rule: [],
    biz_stage: "stretching",
    pending_action: { kind: "step", step_id: stepId },
    walk: null,
    ...overrides,
  });
  db.tables.plans!.push({ id: planId, business_id: bizId, goal: "Get found on Google.", headline: null, strategy: null });
  db.tables.plan_steps!.push({
    id: stepId,
    plan_id: planId,
    workstream_title: "Be findable by people who don't know you",
    domain: "credit_record",
    step_order: 0,
    step_key: "m_found_gbp",
    title: "Show up when people search nearby",
    push: "Claim your Google Business Profile so Woodstock searches find you.",
    artifact: null,
    tool_id: TOOL_ID,
    why_for_you: "Most of your new customers already search on Google before they walk in.",
    done_when: "Your profile shows up when you search the business name.",
    status: "open",
    pushed_at: new Date().toISOString(),
  });
  db.tables.tools!.push({
    id: TOOL_ID,
    country: "ZA",
    domain: "credit_record",
    stages: ["run"],
    keywords: ["google", "gbp"],
    name: "Google Business Profile",
    fits: "Any business people search for nearby.",
    not_when: "",
    why: "Free, and most local search starts here.",
    cost: "Free",
    url: "https://google.com/business",
    setup: "",
    walkthrough: TOOL_WALKTHROUGH,
    verified_on: "2026-09-01",
  });

  return { bizId, planId, stepId };
}

function scriptModels(n: FakeNet): void {
  // The model backstop for checkReply, with no Jev key configured — same
  // pattern as journey.e2e.test.ts. Nothing flagged, so a flag in a test is real.
  n.onModel(/You are a strict checker/, (prompt) => {
    const ids = [...prompt.matchAll(/- "([a-z_]+)":/g)].map((m) => m[1]!);
    return Object.fromEntries(ids.map((id) => [id, false]));
  });

  // helpWithStep's own model call, only reached for a genuinely novel message.
  // Deliberately does not assert on the prompt here — this responder is
  // shared across every test in the file, including the ones that must NOT
  // reach it at all; each test checks what actually reached the model (or
  // that nothing did) from `net.modelCalls` afterwards instead.
  n.onModel(/The person is stuck on one step/, () => ({
    message: "That means someone else claimed this listing already. Request ownership transfer from the Business Profile page instead of creating a new one — Google will email the current owner to approve it.",
    artifact: null,
    next_tap: null,
    quick_replies: [],
    tool_id: TOOL_ID,
    domain: "credit_record",
  }));
}

before(async () => {
  net = installFakeNet();
  scriptModels(net);
  db = makeFakeDb({ model_config: MODEL_ROLES });
  const dbmod = await import("../api/_lib/db.ts");
  restoreDb = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  engine = await import("../api/_lib/engine/index.ts");
});

after(() => {
  restoreDb?.();
  net?.restore();
});

beforeEach(() => {
  // Clear only what each test seeds — not model_config: it is fetched once
  // per role and cached for 60s (models.ts), so wiping it mid-run would make
  // a later test's askJSON call fail on a row that is genuinely still valid.
  for (const t of ["businesses", "plans", "plan_steps", "tools", "commitments", "safety_events", "messages"]) {
    db.tables[t] = [];
  }
  net.sent.length = 0;
  net.modelCalls.length = 0;
});

const allText = () => net.sent.map((m) => m.body).join("\n---\n");
const lastButtons = () => [...net.sent].reverse().find((m) => m.buttons.length)?.buttons ?? [];
const business = () => db.tables.businesses!.find((b) => b.wa_id === OWNER)!;

test("mid-walkthrough, a generic 'I'm stuck' resends the exact line just shown — zero model calls", async () => {
  const { stepId } = seedBusiness({ stage: "walking" });
  db.tables.businesses![0]!.pending_action = { kind: "step", step_id: stepId };
  db.tables.businesses![0]!.walk = { tool_id: TOOL_ID, index: 1, step_id: stepId };

  await engine.handleInbound(tapFrom(OWNER, "a.walk.stuck", "I'm stuck"));

  assert.equal(net.modelCalls.length, 0, "a known, already-shown walkthrough line must not call a model");
  // The exact line at index 1 — the one actually just sent — comes back,
  // not a paraphrase and not a different line.
  assert.match(allText(), /Tap Manage now, then enter the business name/);
  assert.doesNotMatch(allText(), /Go to google\.com\/business and sign in/, "must not resend the WRONG line");

  // Still mid-walkthrough: the buttons offered are the walkthrough's own
  // (Next / I'm stuck / Later), not the post-help (Done now / Skip this one)
  // set — because nothing was answered, the same line was just repeated.
  assert.deepEqual(lastButtons().map((b) => b.id), ["a.walk.next", "a.walk.stuck", "a.walk.later"]);

  // State is untouched: still walking, on the same line, same step.
  const biz = business();
  assert.equal(biz.stage, "walking");
  assert.deepEqual(biz.walk, { tool_id: TOOL_ID, index: 1, step_id: stepId });
});

test("mid-walkthrough, typing a bare 'stuck' gets the same deterministic resend, zero model calls", async () => {
  const { stepId } = seedBusiness({ stage: "walking" });
  db.tables.businesses![0]!.pending_action = { kind: "step", step_id: stepId };
  db.tables.businesses![0]!.walk = { tool_id: TOOL_ID, index: 0, step_id: stepId };

  await engine.handleInbound(textFrom(OWNER, "stuck"));

  assert.equal(net.modelCalls.length, 0);
  assert.match(allText(), /Go to google\.com\/business and sign in/);
});

test("a genuinely novel message mid-walkthrough still reaches the model and gets a grounded reply", async () => {
  const { stepId } = seedBusiness({ stage: "walking" });
  db.tables.businesses![0]!.pending_action = { kind: "step", step_id: stepId };
  db.tables.businesses![0]!.walk = { tool_id: TOOL_ID, index: 1, step_id: stepId };

  await engine.handleInbound(textFrom(OWNER, "it says this business is already listed by someone else"));

  // said.length is meaningfully non-trivial: this is a real question, not a
  // restatement of "I'm stuck", so it must fall through to the model — the
  // whole point is not breaking the case where the owner needs a real answer.
  const helpCalls = net.modelCalls.filter((c) => c.model === "test/help");
  assert.equal(helpCalls.length, 1, "a novel question must reach the help model exactly once");
  assert.match(helpCalls[0]!.prompt, /already listed/i, "the owner's actual words must reach the prompt, not a paraphrase");
  assert.match(allText(), /request ownership transfer/i);

  // Once a real answer was generated, the follow-up buttons are the post-help
  // set, not the walkthrough's own — this matches the existing, unchanged
  // helpWithStep behaviour once it actually answers something.
  assert.deepEqual(lastButtons().map((b) => b.id), ["a.step.done", "a.step.skip"]);
});

test("'I'm stuck' right after a plain step push (no walkthrough shown yet) still calls the model", async () => {
  // Regression guard: the shortcut must only fire once the FULL walkthrough
  // content was actually sent (biz.walk set). A step that was only pushed at
  // its summary level, with "Walk me through" never tapped, has not shown the
  // owner the granular content the shortcut would resend — calling the model
  // here is still the correct, existing behaviour (see journey.e2e.test.ts).
  const { stepId } = seedBusiness({ stage: "step_pushed", walk: null });
  db.tables.businesses![0]!.pending_action = { kind: "step", step_id: stepId };

  await engine.handleInbound(tapFrom(OWNER, "a.step.help", "I'm stuck"));

  assert.equal(net.modelCalls.filter((c) => c.model === "test/help").length, 1);
});
