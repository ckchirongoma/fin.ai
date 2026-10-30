// Fin — nothing an owner reads is cut short with "…".
//
// Founder, 2026-10: a diagnostic button read "Not yet, it's an id…", and the
// first thing Fin sent was a privacy line before it had said hello. The
// audit that followed found the same cut in suggested-reply buttons, link
// labels, nudges and long button messages that lost their closing question.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
delete process.env.TYPESAFE_API_KEY;

import { installFakeNet, makeFakeDb, type FakeDb, type FakeNet } from "./_fakes.ts";

let net: FakeNet;
let db: FakeDb;
let restore: () => void;
let wa: typeof import("../api/_lib/wa.ts");
let engine: typeof import("../api/_lib/engine/index.ts");
let steps: typeof import("../api/_lib/engine/steps.ts");
// Imported in before(): a static import would load env.ts before the env above is set.
let DIAG: typeof import("../api/_lib/diagnostic.ts").DIAG;
let shapeQuestion: typeof import("../api/_lib/diagnostic.ts").shapeQuestion;

before(async () => {
  net = installFakeNet();
  db = makeFakeDb({ model_config: ["router", "wa_reply", "help", "plan_builder", "safety", "voice"].map((role) => ({ role, provider: "openrouter", model: `test/${role}`, fallbacks: [], params: {}, enabled: true })) });
  const dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  wa = await import("../api/_lib/wa.ts");
  engine = await import("../api/_lib/engine/index.ts");
  steps = await import("../api/_lib/engine/steps.ts");
  ({ DIAG, shapeQuestion } = await import("../api/_lib/diagnostic.ts"));
});
after(() => {
  restore?.();
  net?.restore();
});
beforeEach(() => {
  net.sent.length = 0;
});

test("every diagnostic option fits its button or list row whole", () => {
  DIAG.forEach((q, i) => {
    const shape = shapeQuestion(i, "ZA");
    if (shape.kind === "buttons") for (const b of shape.buttons) assert.ok(b.title.length <= wa.WA.buttonTitleChars, b.title);
    if (shape.kind === "list") for (const r of shape.rows) assert.ok(r.title.length <= wa.WA.listRowTitleChars, r.title);
  });
  assert.ok(DIAG.find((q) => q.key === "owes")!.options!.includes("Nobody"));
});

test("no question ends in '…', which reads as a message cut short", () => {
  for (const q of DIAG) assert.doesNotMatch(q.q("ZA"), /…\s*$/, q.key);
});

test("a label made from data is shortened at a word, never mid-word, and never ends on 'to' or 'the'", () => {
  assert.equal(wa.fitLabel("Show me how to register", 20), "Show me how");
  assert.equal(wa.fitLabel("Price the contract version of what you do", 24), "Price the contract");
  assert.equal(wa.fitLabel("Next step", 20), "Next step");
  assert.ok(!wa.fitLabel("Did you manage to call the three guesthouses on Main Road and offer them the menu?", 80).includes("…"));
});

test("a button message over 1024 characters goes out whole: the long part first, the question with the buttons", async () => {
  const reading = "You run a car wash in Soweto with two bays and regulars who come every week. ".repeat(16).trim();
  const body = `${reading}\n\nSo what you're really after: two fleet contracts.\n\nDid I get that right?`;
  assert.ok(body.length > 1024);
  await wa.sendButtons("27809979001", body, [{ id: "a.ok", title: "That's right" }]);
  assert.equal(net.sent.length, 2);
  assert.equal(net.sent[0]!.type, "text");
  assert.equal(net.sent[0]!.body, reading);
  assert.equal(net.sent[1]!.body, "So what you're really after: two fleet contracts.\n\nDid I get that right?");
  assert.ok(!net.sent.some((m) => m.body.includes("…")), "nothing cut");
});

test("a text over 4096 characters is sent as several, split between paragraphs", async () => {
  const para = "A long voice note, transcribed in full. ".repeat(40).trim();
  await wa.sendText("27809979002", [para, para, para].join("\n\n"));
  assert.equal(net.sent.length, 2);
  assert.ok(net.sent.every((m) => m.body.length <= 4096 && !m.body.endsWith("…")));
});

test("under the test suite, anything still cut is an error, not a silent '…'", async () => {
  const was = process.env.WA_STRICT_LIMITS;
  process.env.WA_STRICT_LIMITS = "1";
  try {
    await assert.rejects(wa.sendButtons("27809979003", "Pick one", [{ id: "a.x", title: "Not yet, it's an idea" }]), /button title is 21 characters, over WhatsApp's 20/);
  } finally {
    process.env.WA_STRICT_LIMITS = was;
  }
});

test("a suggested reply that does not fit a button is dropped, and a link's label is not cut", () => {
  const r = steps.tidy({
    message: "Here's how.",
    quick_replies: ["How much?", "Show me how to register", "What's next?"],
    next_tap: { label: "Open the CIPC BizPortal", url: "https://bizportal.gov.za" },
  });
  assert.deepEqual(r.quick_replies, ["How much?", "What's next?"]);
  assert.equal(r.next_tap!.label, "Open the CIPC BizPortal");
});

test("an answer with words to paste puts the buttons last, under the words they are about", async () => {
  await db.client.from("businesses").insert({ id: "b-lab", wa_id: "27809979004", country: "ZA", stage: "plan_ready", answers: {} });
  const biz = (await import("../api/_lib/db.ts")).findBusinessById("b-lab");
  await steps.sendReply((await biz)!, { message: "Send this to your regulars.", artifact: "Hi! Bookings for December are open — reply BOOK.", next_tap: null, quick_replies: [], tool_id: null, domain: null }, [{ id: "a.step.next", title: "Next step" }]);
  assert.deepEqual(net.sent.map((m) => m.type), ["text", "text", "interactive"]);
  assert.match(net.sent[1]!.body, /reply BOOK/);
});

test("a brand-new number that opens with a voice note gets the hello first, not 'I didn't catch that'", async () => {
  await engine.handleInbound({ waMessageId: "wamid.v1", from: "27809979005", timestamp: Date.now(), kind: "audio", text: "", mediaId: "m1", mimeType: "audio/ogg" });
  assert.equal(net.sent.length, 1);
  assert.match(net.sent[0]!.body, /^Hi, I'm Fin\./);
  assert.match(net.sent[0]!.body, /forget my money/);
});
