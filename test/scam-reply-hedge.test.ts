// Charles — a price hedge only on a price Charles asserts.
//
// Live, 2026-09-23: "Someone from 'SARS Refunds' WhatsApped me saying I
// qualify for a R4,500 tax refund but I need to pay a R350 processing fee
// first via eWallet…" got an excellent scam warning — ending in "Check that
// price at sign-up — it may have changed.", because reply_compliance's
// ungrounded_price flagged the scammer's own figures, quoted back.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
process.env.WORKER_SECRET = "fake-worker-secret";
process.env.TYPESAFE_API_KEY = "fake-jev-key";

import { installFakeNet, makeFakeDb, textFrom, type FakeDb, type FakeNet } from "./_fakes.ts";

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let dbmod: typeof import("../api/_lib/db.ts");
let engine: typeof import("../api/_lib/engine/index.ts");
let safety: typeof import("../api/_lib/safety.ts");
let replyText = "";

const SCAM = "Someone from 'SARS Refunds' WhatsApped me saying I qualify for a R4,500 tax refund but I need to pay a R350 processing fee first via eWallet to release it. Should I pay it?";
const WARNING =
  "This is a scam. SARS will never WhatsApp you about a refund or ask for an eWallet payment. Do not pay the R350. Block the number and delete the message. If you want to check your actual tax status, contact SARS directly or visit sars.gov.za.";

before(async () => {
  net = installFakeNet();
  const roles = ["router", "wa_reply", "help", "plan_builder", "safety"].map((role) => ({ role, provider: "openrouter", model: "t/m", fallbacks: [], params: {}, enabled: true }));
  db = makeFakeDb({ model_config: roles });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  engine = await import("../api/_lib/engine/index.ts");
  safety = await import("../api/_lib/safety.ts");
  net.onModel(/Classify this message from a person to their money assistant/, () => ({ intent: "question", domain: null, tool_need: null, missing_fact: null, risk: [], search_terms: "" }));
  net.onModel(/ROUTER RESULT/, () => ({ message: replyText, artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: null }));
  net.onModel(/You maintain one person's money memory/, () => ({ context_updates: null, map_updates: null, decisions: null, commitments: null, results: null }));
});
after(() => {
  restore?.();
  net?.restore();
});
beforeEach(() => {
  net.sent.length = 0;
  // Exactly what the live judge said: ungrounded_price and generic, nothing else.
  net.jev.handler = (payload) => Object.fromEntries(Object.keys(payload.questions).map((id) => [id, { type: "noul", noul: id === "ungrounded_price" || id === "generic" ? 0.9 : 0.05 }]));
});

async function ready(wa: string) {
  const biz = await dbmod.createBusiness(wa, "ZA");
  await dbmod.updateBusiness(biz.id, { stage: "plan_ready", context: { name: "Mpho's Spaza", location: "Soweto" } } as never);
}

test("the live reproduction: a scam warning quoting the scammer's figures gets no price hedge", async () => {
  await ready("27834440001");
  replyText = WARNING;
  await engine.handleInbound(textFrom("27834440001", SCAM));
  const sent = net.sent.filter((m) => m.to === "27834440001").map((m) => m.body).join("\n");
  assert.match(sent, /This is a scam/);
  assert.doesNotMatch(sent, /Check that price at sign-up/);
  const ev = db.tables.safety_events!.filter((e) => e.check_name === "reply_compliance").at(-1)!;
  assert.ok(ev.flags.includes("ungrounded_price_quoted_only"), `recorded honestly as quoted-only: ${JSON.stringify(ev.flags)}`);
});

test("a price Charles asserts on its own authority still gets the hedge", async () => {
  await ready("27834440002");
  replyText = "Get a card machine — it costs R499 and pays out next day.";
  await engine.handleInbound(textFrom("27834440002", "should I get a card machine?"));
  assert.match(net.sent.filter((m) => m.to === "27834440002").map((m) => m.body).join("\n"), /Check that price at sign-up/);
});

test("assertsAPrice: quoted, verified, invented, and no-figure cases", () => {
  assert.equal(safety.assertsAPrice("Do not pay the R350.", "(none)", SCAM), false);
  assert.equal(safety.assertsAPrice("Yoco's machine is R699.", "yoco | Yoco | cost: machine from R699 once-off", "is yoco good?"), false);
  assert.equal(safety.assertsAPrice("It costs R499.", "(none)", "is yoco good?"), true);
  assert.equal(safety.assertsAPrice("Register within 30 days.", "(none)", "do I register?"), false, "no price in it: no price hedge");
  assert.equal(safety.assertsAPrice("Lenders like that charge 30% a month.", "(none)", "should I borrow?"), true, "an unverified rate still asserts");
  // Live, 2026-09-24: the NSFAS scam warning, no figure in it, got the hedge.
  const NSFAS = "I got an sms: 'Your NSFAS business loan is approved, pay R199 admin fee to 0821234567 via eWallet'. Real?";
  const reply = "That is a scam. NSFAS does not phone or SMS you to approve loans, and they never ask for a fee to release money.\n\nDo not pay anything. Block the number and delete the message. If you sent money, go to the police to open a case.\n\nFor help with money questions, call SEDFA free on 0860 665 232.";
  assert.equal(safety.assertsAPrice(reply, "(none)", NSFAS), false);
});

test("assertsAPrice: the owner's figure counts however they wrote it, and a new rate still asserts", async () => {
  const { assertsAPrice } = await import("../api/_lib/safety.ts");
  assert.equal(assertsAPrice("Don't pay the R500.", "", "they want 500 rand upfront"), false);
  assert.equal(assertsAPrice("Never send KSh 500 to unlock a loan.", "", "asked me for 500 shillings"), false);
  assert.equal(assertsAPrice("Don't send the ₦5,000.", "", "they said pay N5000"), false);
  // Every money figure is theirs, but the 15% is Charles's own claim.
  assert.equal(assertsAPrice("Don't pay the R350. Legit lenders charge 15% interest.", "", "they want R350 first"), true);
  assert.equal(assertsAPrice("Don't pay the R350 — and 2.95% is Yoco's rate.", "Yoco: 2.95% per card sale", "they want R350 first"), false);
});
