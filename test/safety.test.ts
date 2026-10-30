// Charles — direct unit tests for safety.ts, which previously had none of its
// own (only indirect coverage via the e2e/journey tests). Two families here
// are new:
//
//   checkTraceability   Priority 2, 2026-09-22: a Jev check for whether a
//                        specific claim (a customer, a price, a value
//                        proposition) is actually traceable to this owner's
//                        diagnostic, identity or chosen customer/angle — or
//                        whether it was invented mid-generation. Feeds the
//                        gate in engine/build.ts's applyContextGuardrails and
//                        the extra pass inside checkStrategy below.
//   checkNameFidelity    Priority 2b, 2026-09-22: the exact "Woodwood" for
//                        "Woodstock" incident. Mechanical only — never Jev,
//                        never a model call — so these tests never touch
//                        net.jev at all for this family.
//
// The rest re-confirms that wiring these into checkReply/checkStepCompliance/
// checkStrategy via SafetyCtx's new optional `answers` / `knownFacts` fields
// is genuinely additive: a caller that omits them gets exactly the old
// behaviour, unchanged.

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.TYPESAFE_API_KEY = "fake-jev-key";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";
process.env.WORKER_SECRET = "fake-worker-secret";

import { installFakeNet, makeFakeDb, type FakeDb, type FakeNet } from "./_fakes.ts";

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let s: typeof import("../api/_lib/safety.ts");
let env: Record<string, string | undefined>;

// What the model backstop answers with, changed per test — registered ONCE
// below, because the fake net's onModel responders stack rather than
// replace each other, so calling onModel again per-test would let an
// earlier test's handler keep winning (net.onModel matches the FIRST
// registered responder, not the last).
let backstop: (prompt: string) => unknown = () => ({});
const allFalse = (prompt: string) => Object.fromEntries([...prompt.matchAll(/- "([a-z_]+)":/g)].map((m) => [m[1]!, false]));

before(async () => {
  net = installFakeNet();
  const roles = ["router", "wa_reply", "help", "plan_builder", "safety"].map((role) => ({
    role, provider: "openrouter", model: "xiaomi/mimo-v2.5", fallbacks: [], params: {}, enabled: true,
  }));
  db = makeFakeDb({ model_config: roles });
  const dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  env = (await import("../api/_lib/env.ts")).env as unknown as Record<string, string | undefined>;
  s = await import("../api/_lib/safety.ts");
  net.onModel(/You are a strict checker/, (p) => backstop(p));
});

after(() => {
  restore?.();
  net?.restore();
});

beforeEach(() => {
  db.tables.safety_events!.length = 0;
  net.jev.calls.length = 0;
  net.jev.handler = null;
  env.TYPESAFE_API_KEY = "fake-jev-key";
  backstop = allFalse;
});

const events = (check: string) => db.tables.safety_events!.filter((e) => e.check_name === check);

// ── checkNameFidelity — Priority 2b, mechanical, never judged ────────

describe("checkNameFidelity — mechanical, no Jev, no model call", () => {
  const facts = { location: "Woodstock, Cape Town" };

  test("the real incident: a wrong word for the business's own city is caught and fixed before send", async () => {
    const reply = "Show up on Google when property managers in Woodwood search for tests in Woodstock.";
    const r = await s.checkNameFidelity(reply, facts, { businessId: "b1" });
    assert.equal(r.message, "Show up on Google when property managers in Woodstock search for tests in Woodstock.");
    assert.deepEqual(r.flags, ["name_fidelity"]);
    assert.equal(net.jev.calls.length, 0, "mechanical — no Jev call at all");
  });

  test("the correct spelling, used correctly, is left alone", async () => {
    const reply = "Property managers in Woodstock will find you on Google.";
    const r = await s.checkNameFidelity(reply, facts, { businessId: "b1" });
    assert.equal(r.message, reply);
    assert.deepEqual(r.flags, []);
  });

  test("nothing to check against: the reply passes through untouched", async () => {
    const r = await s.checkNameFidelity("Any old reply about Woodwood.", {}, { businessId: "b1" });
    assert.equal(r.message, "Any old reply about Woodwood.");
    assert.deepEqual(r.flags, []);
  });

  test("a real, unrelated word is never rewritten just for looking vaguely similar", async () => {
    // "would" and "wood" are both short, common, and nothing to do with a
    // typo of "Woodstock" — the prefix+distance guard must not fire on them.
    const r = await s.checkNameFidelity("I would check that first, if I were you.", facts, {});
    assert.equal(r.message, "I would check that first, if I were you.");
    assert.deepEqual(r.flags, []);
  });

  test("customer and angle labels are descriptions, not names — never rewritten (review of 4e685e5)", async () => {
    // Enforcing labels rewrote ordinary grammar: "Every busy office worker"
    // became "Every Busy office workers". A label's near misses are its own
    // plurals and verbs, so they are not enforced at all.
    for (const [msg, facts] of [
      ["Every busy office worker wants lunch.", { goal_label_0: "Busy office workers" }],
      ["We offer same day services.", { rule_label_0: "Same-day service" }],
      ["Start by reaching out to Guesthauses this week.", { goal_label_0: "Guesthouses" }],
    ] as const) {
      const r = await s.checkNameFidelity(msg, facts, {});
      assert.equal(r.message, msg);
      assert.deepEqual(r.flags, []);
    }
  });

  test("writes its own named row to safety_events, distinct from reply_compliance", async () => {
    await s.checkNameFidelity("Tests in Woodwood.", facts, { businessId: "b1" });
    const rows = events("name_fidelity");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.engine, "none", "mechanical — no engine ran, and none was needed");
    assert.equal(rows[0]!.outcome, "flag");
    assert.match(rows[0]!.detail, /Woodwood.*Woodstock/);
  });

  test("multiple known facts, only the drifted one is touched", async () => {
    const r = await s.checkNameFidelity(
      "Rinse Laundry serves guesthouses near Woodwood.",
      { business_name: "Rinse Laundry", location: "Woodstock" },
      {},
    );
    assert.equal(r.message, "Rinse Laundry serves guesthouses near Woodstock.");
  });
});

describe("businessKnownFacts — the small set of exact strings a reply must never drift on", () => {
  test("pulls name, location, identity and every chosen label", () => {
    const facts = s.businessKnownFacts({
      context: { name: "Rinse", location: "Woodstock, Cape Town" },
      identity: { name: "Rinse Laundry" },
      goal: [{ label: "Guesthouses" }, { label: "Gyms" }],
      rule: [{ label: "Same day turnaround" }],
    });
    assert.equal(facts.business_name, "Rinse");
    assert.equal(facts.location, "Woodstock, Cape Town");
    assert.equal(facts.identity_name, "Rinse Laundry");
    assert.equal(facts.goal_label_0, "Guesthouses");
    assert.equal(facts.goal_label_1, "Gyms");
    assert.equal(facts.rule_label_0, "Same day turnaround");
  });

  test("missing pieces are simply absent, never a crash", () => {
    assert.deepEqual(s.businessKnownFacts({}), {});
    assert.deepEqual(s.businessKnownFacts({ goal: null, rule: undefined }), {});
  });
});

// ── checkTraceability — Priority 2, a Jev judgement ──────────────────

describe("checkTraceability — is this specific claim actually something the owner said?", () => {
  const labels = { customers: "who buys from them", typical_price: "what they typically charge" };
  const grounding = { diagnostic_answers: { objective: "more customers" } };

  test("Jev confirms it looks invented: the field is hedged, visibly, not silently dropped", async () => {
    net.jev.handler = () => ({ customers: { type: "noul", noul: 0.9 }, typical_price: { type: "noul", noul: 0.1 } });
    const r = await s.checkTraceability(
      { customers: "Property managers doing rental inspections", typical_price: "R2,000 - R5,000 monthly" },
      labels,
      grounding,
      { businessId: "b1" },
    );
    assert.deepEqual(r.flagged, ["customers"]);
    assert.match(r.fields.customers!, /Property managers doing rental inspections/);
    assert.match(r.fields.customers!, /haven't confirmed this/);
    assert.equal(r.fields.typical_price, "R2,000 - R5,000 monthly", "not flagged, so untouched");
  });

  test("Jev confirms it IS traceable: nothing is touched", async () => {
    net.jev.handler = () => ({ customers: { type: "noul", noul: 0.05 }, typical_price: { type: "noul", noul: 0.02 } });
    const r = await s.checkTraceability(
      { customers: "The guesthouses they named", typical_price: "R500, their own stated price" },
      labels,
      grounding,
      {},
    );
    assert.deepEqual(r.flagged, []);
  });

  test("no candidates, no call: an empty/blank field is skipped rather than judged", async () => {
    const r = await s.checkTraceability({ customers: "", typical_price: "   " }, labels, grounding, {});
    assert.equal(r.engine, "none");
    assert.equal(net.jev.calls.length, 0);
  });

  test("no engine at all: fields pass through unchanged — a fail-open check never invents a NEW doubt", async () => {
    env.TYPESAFE_API_KEY = "";
    backstop = () => { throw new Error("down"); };
    const r = await s.checkTraceability({ customers: "Guesthouses" }, labels, grounding, { businessId: "b1" });
    assert.deepEqual(r.flagged, []);
    assert.equal(r.fields.customers, "Guesthouses");
    assert.equal(events("traceability")[0]!.outcome, "unavailable");
  });

  test("Jev down: the model backstop still catches it", async () => {
    backstop = () => ({ customers: true });
    const r = await s.checkTraceability({ customers: "Invented segment" }, labels, grounding, { businessId: "b1" });
    assert.deepEqual(r.flagged, ["customers"]);
    assert.equal(events("traceability")[0]!.engine, "model");
  });

  test("writes its own named row, independent of every other check", async () => {
    net.jev.handler = () => ({ customers: { type: "noul", noul: 0.9 } });
    await s.checkTraceability({ customers: "Made up" }, { customers: "who buys" }, grounding, { businessId: "b1" });
    assert.equal(events("traceability")[0]!.check_name, "traceability");
  });
});

test("hedgeUnknown: a value is kept and visibly flagged; a missing one asks for it plainly", () => {
  assert.equal(s.hedgeUnknown("what they charge", "R2,000 - R5,000 monthly"), "R2,000 - R5,000 monthly — you haven't confirmed this, so treat it as a starting guess.");
  assert.equal(s.hedgeUnknown("what they charge"), "You haven't told me what they charge yet — tell me and I'll fill this in.");
  assert.equal(s.hedgeUnknown("what they charge", ""), "You haven't told me what they charge yet — tell me and I'll fill this in.");
});

// ── The wiring: checkReply / checkStepCompliance / checkStrategy ─────
//
// SafetyCtx's `answers` and `knownFacts` are additive — a caller that omits
// them must get exactly the old behaviour. These prove both halves: the old
// behaviour survives, and providing them actually activates the new checks.

describe("checkReply — Priority 2b wired in via ctx.knownFacts", () => {
  test("omitting knownFacts is the old behaviour: no name-fidelity check runs at all", async () => {
    const r = await s.checkReply("Tests in Woodwood.", "(no tools)", "a laundromat in Woodstock", { businessId: "b1" });
    assert.equal(r.message, "Tests in Woodwood.", "unchanged — no knownFacts means no check");
    assert.equal(events("name_fidelity").length, 0);
  });

  test("providing knownFacts catches the drift on top of the existing compliance pass", async () => {
    const r = await s.checkReply("Tests in Woodwood.", "(no tools)", "a laundromat in Woodstock", {
      businessId: "b1",
      knownFacts: { location: "Woodstock" },
    });
    assert.equal(r.message, "Tests in Woodstock.");
    assert.ok(r.flags.includes("name_fidelity"));
    assert.equal(events("name_fidelity").length, 1);
  });
});

describe("checkStepCompliance — Priority 2b wired in via ctx.knownFacts", () => {
  test("catches a drift in the push AND in the artifact", async () => {
    const r = await s.checkStepCompliance(
      "Ask guesthouses in Woodwood for a review.",
      "Hi, we serve guesthouses in Woodwood — reply if interested.",
      "(no tools)",
      { businessId: "b1", knownFacts: { location: "Woodstock" } },
    );
    assert.equal(r.push, "Ask guesthouses in Woodstock for a review.");
    assert.equal(r.artifact, "Hi, we serve guesthouses in Woodstock — reply if interested.");
    assert.ok(r.flags.includes("name_fidelity"));
  });
});

describe("checkStrategy — Priority 2 traceability + Priority 2b name fidelity, both via ctx", () => {
  const baseFields = () => ({
    reading: "A test business with a real gap.",
    how_we_win: "Property managers in Woodstock choose them for reliability.",
    money_logic: "Between R6,000 and R15,000 a month, once three contracts land.",
    working: "Regulars come back.",
    leaking: "No-shows.",
    wont_do: "Nothing paid this quarter.",
  });

  test("without ctx.answers, no traceability call runs — old behaviour preserved", async () => {
    net.jev.handler = null; // unreachable — would only matter if something tried to call it
    await s.checkStrategy(baseFields(), "(no tools)", "a laundromat", { businessId: "b1" });
    assert.equal(events("traceability").length, 0);
  });

  test("with ctx.answers, an invented money_logic figure is hedged, not asserted", async () => {
    net.jev.handler = (payload) => {
      const out: Record<string, unknown> = {};
      for (const id of Object.keys(payload.questions)) out[id] = { type: "noul", noul: id === "money_logic" ? 0.9 : 0.1 };
      return out;
    };
    const r = await s.checkStrategy(baseFields(), "(no tools)", "a laundromat", {
      businessId: "b1",
      answers: { objective: "more customers", price: "R500 a load" },
    });
    assert.match(r.fields.money_logic!, /haven't confirmed this/);
    assert.ok(r.flags.includes("invented_money_logic"));
    assert.doesNotMatch(r.fields.how_we_win!, /haven't confirmed this/, "not flagged, so untouched");
  });

  test("with ctx.knownFacts, a drifted place name across the whole document is corrected", async () => {
    const fields = { ...baseFields(), how_we_win: "Property managers in Woodwood choose them for reliability." };
    const r = await s.checkStrategy(fields, "(no tools)", "a laundromat", {
      businessId: "b1",
      knownFacts: { location: "Woodstock" },
    });
    assert.equal(r.fields.how_we_win, "Property managers in Woodstock choose them for reliability.");
    assert.ok(r.flags.includes("name_fidelity"));
  });
});
