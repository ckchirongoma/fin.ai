// Fin — the step-push loop's WhatsApp-facing wording and buttons.
//
// Covers, each with a real reproduction of the bug it fixes:
//   PRIORITY 3   — "See my plan" renders real *bold* headers and a symbol
//                  WhatsApp actually shows, not literal "[ ]" brackets.
//   PRIORITY 4.2 — the default step push includes the tool's real numbered
//                  walkthrough inline, and a step with a tool offers a fourth
//                  option ("Get this as a PDF") via a list, never by quietly
//                  dropping one of the three reply buttons that were there.
//   PRIORITY 5.1 — an artifact still carrying an unfilled "[...]" placeholder
//                  is never sent verbatim; what Fin actually knows (the
//                  business's own name) is filled in first.
//   PRIORITY 5.2 — a stale "Next" tap from a walkthrough message, sent after
//                  "Later", resumes the walkthrough instead of firing a full
//                  re-send of the main plan step.
//   PRIORITY 5.3 — resuming a PAUSED walkthrough is the SAME shape every
//                  time (one granular step, "N of M" counter) whether the
//                  owner taps the walkthrough's own stale "Next" or the
//                  fresh "Next step" button/typed "next" that "Later" itself
//                  leaves behind — never the condensed, no-counter summary
//                  pushNextStep sends for a step that was never walked.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
process.env.WORKER_SECRET = "fake-worker-secret";
delete process.env.TYPESAFE_API_KEY;

import { installFakeNet, makeFakeDb, tapFrom, textFrom, type FakeDb, type FakeNet } from "./_fakes.ts";

const GBP_WALKTHROUGH = [
  "Go to google.com/business and sign in.",
  "Tap Manage now and enter your business name.",
  "Choose service area or a physical address.",
  "Add at least 5 photos.",
  "Verify by whichever method Google offers you.",
];

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let dbmod: typeof import("../api/_lib/db.ts");
let steps: typeof import("../api/_lib/engine/steps.ts");
let engine: typeof import("../api/_lib/engine/index.ts");

before(async () => {
  net = installFakeNet();
  db = makeFakeDb({
    tools: [
      {
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
        walkthrough: GBP_WALKTHROUGH,
        verified_on: "2026-08-01",
      },
    ],
  });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  steps = await import("../api/_lib/engine/steps.ts");
  engine = await import("../api/_lib/engine/index.ts");
});

after(() => {
  restore?.();
  net?.restore();
});

beforeEach(() => {
  net.sent.length = 0;
});

let planCounter = 0;

/** A business with one open plan step whose tool has a real walkthrough —
 * built directly, the way plan.ts and connector.ts read it back, without
 * running the (unrelated) diagnostic/build pipeline this file has no
 * business exercising. */
async function bizWithStep(waId: string, stepOver: Record<string, unknown> = {}) {
  const biz = await dbmod.createBusiness(waId, "ZA");
  const planId = `plan-${++planCounter}`;
  db.tables.plans!.push({
    id: planId,
    business_id: biz.id,
    goal: "Sign three property managers to monthly retainer agreements within 90 days.",
    headline: "",
    strategy: null,
    created_at: new Date().toISOString(),
  });
  const step = {
    id: `step-${planCounter}`,
    plan_id: planId,
    workstream_title: "Be findable by people who don't know you",
    domain: "credit_record",
    step_order: 1,
    step_key: "f1",
    title: "Show up when people search nearby",
    push: "Claim your Google listing and add photos.",
    artifact: "Hi [Name], thanks for choosing Thandi — could you leave us a review? [Link to Google profile]",
    tool_id: "gbp",
    why_for_you: "You said people search nearby before calling.",
    done_when: "your profile is verified and live",
    status: "open",
    pushed_at: null,
    done_at: null,
    skipped_reason: null,
    ...stepOver,
  };
  db.tables.plan_steps!.push(step);
  await dbmod.updateBusiness(biz.id, { context: { name: "Thandi", location: "Woodstock, Cape Town" } } as never);
  const fresh = (await dbmod.findBusiness(waId))!;
  return { biz: fresh, step };
}

// ── PRIORITY 5.1 ───────────────────────────────────────────────────

test("an artifact with an unresolvable placeholder reaches the phone as the message, under a line saying which parts to fill", async () => {
  const { biz } = await bizWithStep("27809950001");
  await steps.pushNextStep(biz);

  const bodies = net.sent.map((m) => m.body).join("\n---\n");
  // Round 18: the old apology was sent INSTEAD of the message, so the owner
  // had nothing to send. Never as if ready: always under the instruction.
  assert.match(bodies, /Fill in the parts in \[brackets\] \(name, link to Google profile\) before you send this:\n\nHi \[Name\]/);
  assert.doesNotMatch(bodies, /write that part yourself/i);
});

test("a placeholder Fin actually knows — the business's own name — is filled in, not withheld", async () => {
  const { biz } = await bizWithStep("27809950002", { artifact: "Thanks for choosing [Your Name]! Tell your friends." });
  await steps.pushNextStep(biz);

  const bodies = net.sent.map((m) => m.body).join("\n---\n");
  assert.match(bodies, /Thanks for choosing Thandi! Tell your friends\./, "a genuinely known fact is filled in exactly");
  assert.doesNotMatch(bodies, /\[Your Name\]/);
});

// ── PRIORITY 4.2 ───────────────────────────────────────────────────

test("the default step push includes the tool's real numbered walkthrough inline", async () => {
  const { biz } = await bizWithStep("27809950003");
  await steps.pushNextStep(biz);

  const bodies = net.sent.map((m) => m.body).join("\n---\n");
  GBP_WALKTHROUGH.forEach((line, i) => {
    assert.match(bodies, new RegExp(`${i + 1}\\. ${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), `walkthrough line ${i + 1} must be in the default message, not gated behind "Walk me through"`);
  });
});

test("a step whose tool has a walkthrough offers Done / Walk me through / Get this as a PDF / I'm stuck as a list, dropping none of them", async () => {
  const { biz } = await bizWithStep("27809950004");
  await steps.pushNextStep(biz);

  const last = net.sent.at(-1)!;
  assert.equal(last.raw.interactive?.type, "list", "four real options need a list, not WhatsApp's 3-button reply cap");
  const rowIds = (last.raw.interactive.action.sections as { rows: { id: string }[] }[]).flatMap((s) => s.rows.map((r) => r.id));
  assert.deepEqual(rowIds, ["a.step.done", "a.step.walk", "a.step.pdf", "a.step.help"]);
});

test("'Get this as a PDF' degrades honestly when the render path is unavailable, exactly like the plan PDF already does", async () => {
  // PUBLIC_BASE_URL is deliberately unset in this file's env — renderPdf()
  // (pdfclient.ts, a sibling track's file, untouched here) refuses to call
  // out without it, which is exactly the situation Priority 1's own Chromium
  // crash produces. This is what proves sendStepPdf is wired to the SAME
  // render path and the SAME honest degradation message, without this
  // environment being able to claim it actually saw a PDF render.
  const { biz, step } = await bizWithStep("27809950009");
  await steps.sendStepPdf(biz, step.id);

  const body = net.sent.at(-1)!.body;
  assert.match(body, /didn't come out just then/i, "the same graceful-degradation message the plan PDF uses, not silence");
});

test("a step with no tool still gets the plain 2-button Done/I'm stuck message", async () => {
  const { biz } = await bizWithStep("27809950005", { tool_id: null });
  await steps.pushNextStep(biz);

  const last = net.sent.at(-1)!;
  assert.equal(last.type, "interactive");
  assert.deepEqual(last.buttons.map((b) => b.id), ["a.step.done", "a.step.help"]);
});

// ── PRIORITY 3 ─────────────────────────────────────────────────────

test("See my plan renders *bold* workstream headers and real symbols instead of literal [ ] brackets", async () => {
  const { biz, step } = await bizWithStep("27809950006");
  db.tables.plan_steps!.push({
    ...step,
    id: "step-done-1",
    step_key: "f2",
    title: "Say the same thing everywhere",
    status: "done",
    artifact: null,
  });

  await steps.showPlan(biz);

  const body = net.sent.at(-1)!.body;
  assert.doesNotMatch(body, /\[ \]/, "no literal open-bracket-space-close-bracket clutter");
  assert.doesNotMatch(body, /\[x\]/i, "no literal ASCII 'done' checkbox either");
  assert.match(body, /\*Be findable by people who don't know you\*/, "workstream headers are real WhatsApp *bold*, not a plain title");
  assert.match(body, /•\s*Show up when people search nearby/, "an open step gets a bullet WhatsApp actually renders");
  assert.match(body, /✅\s*Say the same thing everywhere/, "a done step gets a check mark, not '[x]'");
});

// ── PRIORITY 5.2 ───────────────────────────────────────────────────

test("a stale 'Next' tap from the walkthrough, sent after 'Later', resumes the walkthrough instead of re-sending the main step", async () => {
  const { biz: biz0, step } = await bizWithStep("27809950007");
  await steps.startWalk(biz0, "gbp", step.id);

  let biz = (await dbmod.findBusiness("27809950007"))!;
  assert.equal(biz.stage, "walking");
  assert.deepEqual(biz.walk, { tool_id: "gbp", index: 0, step_id: step.id });

  // Tap "Later".
  await steps.walkLater(biz);
  biz = (await dbmod.findBusiness("27809950007"))!;
  assert.equal(biz.stage, "plan_ready");
  // The actual fix: walk position must survive "Later" so a stale "Next" tap
  // from the walkthrough's own earlier message has something to resume.
  assert.deepEqual(biz.walk, { tool_id: "gbp", index: 0, step_id: step.id }, "walk position must survive Later");

  net.sent.length = 0;
  // The stale "Next" button — from the walkthrough message sent BEFORE
  // "Later" — is still sitting in the chat. WhatsApp buttons stay tappable
  // forever, so this really does arrive after Later.
  await steps.walkNext(biz);
  biz = (await dbmod.findBusiness("27809950007"))!;

  const bodies = net.sent.map((m) => m.body).join("\n---\n");
  assert.doesNotMatch(bodies, /Show up when people search nearby/, "must not fire a full re-send of the main plan step");
  assert.match(bodies, /2 of 5/, "must resume the walkthrough at the next line instead");
  assert.equal(biz.stage, "walking", "stage re-syncs to 'walking' on resume");
  assert.equal(biz.walk?.index, 1);
});

// ── PRIORITY 5.3 ───────────────────────────────────────────────────

test("'Next step' after 'Later' resumes the walkthrough with a granular, counted step — never the condensed summary", async () => {
  const { biz: biz0, step } = await bizWithStep("27809950010");
  await steps.startWalk(biz0, "gbp", step.id);

  let biz = (await dbmod.findBusiness("27809950010"))!;
  assert.equal(biz.stage, "walking");

  // Tap "Later" — its own reply offers exactly one button, "Next step"
  // (a.step.next), a DIFFERENT action id from the walkthrough's own stale
  // "Next" (a.walk.next, covered by the Priority 5.2 test above).
  await steps.walkLater(biz);
  biz = (await dbmod.findBusiness("27809950010"))!;
  assert.equal(biz.stage, "plan_ready");
  assert.deepEqual(biz.walk, { tool_id: "gbp", index: 0, step_id: step.id }, "walk position must survive Later");

  net.sent.length = 0;
  // Before this fix, ACT.NEXT_STEP always meant pushNextStep — a full
  // re-send of the main step PLUS the entire walkthrough dumped as one
  // condensed, no-counter message ("Exactly how, step by step: 1. ... 2.
  // ..."), regardless of the paused walkthrough sitting in `biz.walk`.
  await engine.handleInbound(tapFrom("27809950010", "a.step.next", "Next step"));
  biz = (await dbmod.findBusiness("27809950010"))!;

  const bodies = net.sent.map((m) => m.body).join("\n---\n");
  assert.doesNotMatch(bodies, /Show up when people search nearby/, "must not re-send the main plan step");
  assert.doesNotMatch(bodies, /Exactly how, step by step/i, "must not send the condensed, no-counter walkthrough dump");
  GBP_WALKTHROUGH.slice(2).forEach((line) => assert.doesNotMatch(bodies, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "a condensed dump would leak lines far past the paused position; a resume must not"));
  assert.match(bodies, /Google Business Profile — 2 of 5/, "must resume the walkthrough at the next granular line, with its own counter — the exact format Priority 5.2's stale-Next path already produces");
  assert.equal(biz.stage, "walking", "stage re-syncs to 'walking' on resume");
  assert.equal(biz.walk?.index, 1);
});

test("typing 'next' after 'Later' resumes the walkthrough exactly the same way tapping the button does", async () => {
  const { biz: biz0, step } = await bizWithStep("27809950011");
  await steps.startWalk(biz0, "gbp", step.id);
  let biz = (await dbmod.findBusiness("27809950011"))!;
  await steps.walkLater(biz);
  biz = (await dbmod.findBusiness("27809950011"))!;

  net.sent.length = 0;
  // typedShortcut maps a bare "next" to the SAME a.step.next action id a tap
  // on "Next step" would — so this exercises the exact same, previously
  // buggy, dispatch path via a different trigger.
  await engine.handleInbound(textFrom("27809950011", "next"));
  biz = (await dbmod.findBusiness("27809950011"))!;

  const bodies = net.sent.map((m) => m.body).join("\n---\n");
  assert.doesNotMatch(bodies, /Exactly how, step by step/i, "typed 'next' must not fire the condensed summary either");
  assert.match(bodies, /Google Business Profile — 2 of 5/, "typed 'next' resumes the walkthrough with its counter, same as the button");
  assert.equal(biz.walk?.index, 1);
});

test("once a walkthrough genuinely finishes, a later stray 'next' does not re-trigger it a second time", async () => {
  // Regression guard for this fix's own edge case: markStepDone() never used
  // to clear `walk`, so a walkthrough that had already run to completion
  // left `biz.walk` pointing at its last line — and this fix's new
  // `if (biz.walk) return walkNext(biz)` would otherwise read that leftover
  // state as "still resuming" and call markStepDone a second time.
  const { biz: biz0, step } = await bizWithStep("27809950012");
  await steps.startWalk(biz0, "gbp", step.id);
  let biz = (await dbmod.findBusiness("27809950012"))!;
  for (let i = 0; i < GBP_WALKTHROUGH.length - 1; i++) {
    await steps.walkNext(biz);
    biz = (await dbmod.findBusiness("27809950012"))!;
  }
  // The last "Next" tap on the final line marks the step done and clears `walk`.
  await steps.walkNext(biz);
  biz = (await dbmod.findBusiness("27809950012"))!;
  assert.equal(biz.stage, "outcome_wait");
  assert.equal(biz.walk, null, "walk must not survive the walkthrough's own completion");

  net.sent.length = 0;
  await engine.handleInbound(textFrom("27809950012", "next"));

  const bodies = net.sent.map((m) => m.body).join("\n---\n");
  assert.doesNotMatch(bodies, /has it made any difference yet/i, "must not re-run markStepDone's own outcome prompt a second time");
});
