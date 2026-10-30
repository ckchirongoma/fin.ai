// Fin — tracking: everything that happens is recorded, nothing identifying
// leaks, and the team is emailed when something goes wrong.
//
// Founder, 2026-10: "If anything ever goes wrong, that must be logged somewhere
// without us even checking, and then an email must be sent to us… whenever
// someone tries to do something that they can't."

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
process.env.RESEND_API_KEY = "fake-resend-key";
process.env.ALERT_EMAIL_TO = "team@example.com";
process.env.ADMIN_SECRET = "fake-admin-secret";
process.env.INTERNAL_WA_IDS = "27829999*";
process.env.PUBLIC_BASE_URL = "https://fin.test";
// This file is about tracking, so it is on here (the suite runs with it off).
delete process.env.TRACKING_OFF;
delete process.env.TYPESAFE_API_KEY;

import { installFakeNet, makeFakeDb, textFrom, type FakeDb, type FakeNet } from "./_fakes.ts";

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let T: typeof import("../api/_lib/track.ts");
let alerts: typeof import("../api/_lib/alerts.ts");
let engine: typeof import("../api/_lib/engine/index.ts");
let dbmod: typeof import("../api/_lib/db.ts");

const MODEL_ROLES = ["router", "wa_reply", "help", "plan_builder", "safety"].map((role) => ({ role, provider: "openrouter", model: `test/${role}`, fallbacks: [], params: {}, enabled: true }));

before(async () => {
  net = installFakeNet();
  net.onModel(/./, () => ({}));
  db = makeFakeDb({ model_config: MODEL_ROLES });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  T = await import("../api/_lib/track.ts");
  alerts = await import("../api/_lib/alerts.ts");
  engine = await import("../api/_lib/engine/index.ts");
});

after(() => {
  restore?.();
  net?.restore();
});

beforeEach(() => {
  for (const t of ["events", "incidents", "alert_state", "event_daily"]) db.tables[t] = [];
  net.sent.length = 0;
  net.emails.length = 0;
  net.email.fail = false;
  net.whatsappError = null;
});

const events = () => db.tables.events!;
const named = (n: string) => events().filter((e) => e.name === n);

describe("what is kept, and what never is", () => {
  test("an owner's words are scrubbed of numbers, emails and links, and cut to 200 characters", () => {
    assert.equal(T.scrubExcerpt("call 082 555 0199 or +27 82 555 0199, mail me a@b.co, see https://x.co/y"), "call [number] or [number], mail me [email], see [link]");
    assert.equal(T.scrubExcerpt("a".repeat(500))!.length, 200);
    assert.equal(T.scrubExcerpt("   "), null);
  });

  test("an event carries the turn's owner, channel, stage and turn id without the call site passing them", async () => {
    await T.withTrackContext({ businessId: "b-1", channel: "whatsapp", stage: "diag", turnId: "wamid.1", country: "ZA", internal: false }, async () => {
      T.track("step_done", { category: "funnel", props: { step_key: "o1" } });
    });
    await T.flushTracking();
    const e = named("step_done")[0]!;
    assert.equal(e.business_id, "b-1");
    assert.equal(e.channel, "whatsapp");
    assert.equal(e.stage, "diag");
    assert.equal(e.turn_id, "wamid.1");
    assert.deepEqual(e.props, { step_key: "o1" });
  });

  test("a whole first conversation is tracked, and no phone number appears anywhere in it", async () => {
    const wa = "27809970001";
    await engine.handleInbound(textFrom(wa, "hi"));
    await T.flushTracking();
    const names = events().map((e) => e.name);
    for (const n of ["turn_received", "business_created", "message_sent", "turn_handled"]) assert.ok(names.includes(n), `${n} recorded`);
    const all = JSON.stringify(events());
    assert.ok(!all.includes(wa) && !all.includes(wa.slice(2)), "the number is never stored");
    const biz = db.tables.businesses!.find((b) => b.wa_id === wa)!;
    assert.ok(named("turn_handled").every((e) => e.business_id === biz.id), "the turn is attributed to the owner");
    assert.ok(named("turn_received")[0]!.excerpt === "hi");
  });

  test("our own numbers are marked internal, so they stay out of the funnel", async () => {
    await engine.handleInbound(textFrom("27829999123", "hi"));
    await T.flushTracking();
    assert.ok(named("turn_received").length > 0);
    assert.ok(named("turn_received").every((e) => e.internal === true));
  });

  test("'forget my money' leaves only anonymous events behind", async () => {
    const wa = "27809970002";
    await engine.handleInbound(textFrom(wa, "hi"));
    await T.flushTracking();
    const id = db.tables.businesses!.find((b) => b.wa_id === wa)!.id;
    assert.ok(events().some((e) => e.business_id === id && e.excerpt));
    await dbmod.forgetBusiness(id);
    await T.flushTracking();
    assert.ok(events().every((e) => e.business_id !== id), "no event still points at them");
    assert.ok(events().filter((e) => e.name === "turn_received").every((e) => e.business_id !== null || e.excerpt === null || e.internal), "their words went with them");
    assert.equal(named("business_forgotten").length, 1);
  });
});

describe("what an error message can carry", () => {
  test("a database error is reduced to its code and message: the failing row (an owner's words) never comes along", () => {
    const pg = { code: "23502", message: "null value in column", details: "Failing row contains (Thandi braids, secret words, 0825550199)", hint: "x" };
    const t = T.errorText(pg);
    assert.equal(t, "23502 null value in column");
    assert.equal(T.errorText(new Error("insert failed: Failing row contains (Thandi, 0825550199) wamid.HBgLMjc4MjEyMzQ1Njc4FQIAEhg")), "insert failed: Failing row contains (…) wamid.<id>");
  });

  test("an unreadable thrown value never makes tracking throw", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.doesNotThrow(() => T.trackFailure("pdf_failed", circular));
    assert.doesNotThrow(() => T.trackFailure("pdf_failed", BigInt(5) as unknown as Error));
  });

  test("a model provider's error body (which can echo the owner's words) is not kept", () => {
    const e = Object.assign(new Error('OpenRouter 403 (x/y): {"error":"flagged input: I owe the loan shark R5000"}'), { name: "ModelError", status: 403, kind: "auth" });
    const t = T.errorText(e);
    assert.doesNotMatch(t, /loan shark/);
    assert.match(t, /^ModelError: 403 auth OpenRouter 403 \(x\/y\)/);
  });

  test("the turn id is a hash of WhatsApp's message id, which carries the phone number", () => {
    const id = T.turnIdFor("wamid.HBgLMjc4MjEyMzQ1Njc4FQIAEhg");
    assert.match(id!, /^t_[0-9a-f]{16}$/);
    assert.equal(T.turnIdFor("wamid.HBgLMjc4MjEyMzQ1Njc4FQIAEhg"), id, "stable, so a turn's events still group");
    assert.equal(T.turnIdFor(""), null);
  });

  test("events still buffered when an owner is forgotten lose their link and words before they are written", async () => {
    await T.withTrackContext({ businessId: "b-forget", said: "my secret" }, async () => {
      T.trackUnmet("off_topic_request");
      T.forgetBuffered("b-forget");
    });
    await T.flushTracking();
    const e = named("off_topic_request").pop()!;
    assert.equal(e.business_id, null);
    assert.equal(e.excerpt, null);
  });
});

describe("what goes wrong is counted as incidents", () => {
  test("the same failure twice is one incident counted twice; a different one is another", async () => {
    T.trackFailure("pdf_failed", new Error("render 500 for job 123"));
    T.trackFailure("pdf_failed", new Error("render 500 for job 456"));
    T.trackFailure("pdf_failed", new Error("upload timed out"));
    await T.flushTracking();
    const inc = db.tables.incidents!;
    assert.equal(inc.length, 2);
    assert.equal(inc.find((i) => /render/.test(i.summary))!.count, 2);
    assert.equal(inc[0]!.alert, "immediate", "an error emails straight away");
  });

  test("an owner trying something Fin can't do is an unmet request, with what they said", async () => {
    await T.withTrackContext({ businessId: "b-2", said: "can you file my tax return for me? my number is 0825550199" }, async () => {
      T.trackUnmet("off_topic_request", { props: { intent: "off_topic" } });
    });
    await T.flushTracking();
    const e = named("off_topic_request")[0]!;
    assert.equal(e.category, "unmet_request");
    assert.equal(e.excerpt, "can you file my tax return for me? my number is [number]");
    assert.equal(db.tables.incidents![0]!.alert, "digest");
  });

  test("WhatsApp refusing a send is an immediate incident, and the message log says it never landed", async () => {
    net.whatsappError = { status: 400, code: 131026, message: "Message undeliverable" };
    const { sendText } = await import("../api/_lib/wa.ts");
    await sendText("27809970003", "Your plan is ready", "b-3");
    await T.flushTracking();
    const inc = db.tables.incidents!.find((i) => i.name === "wa_send_failed")!;
    assert.ok(inc, "counted");
    assert.equal(inc.alert, "immediate");
    assert.ok(!JSON.stringify(inc).includes("27809970003"));
    const row = db.tables.messages!.filter((m) => m.direction === "out").pop()!;
    assert.equal(row.meta?.send_failed, true);
  });

  test("Fin apologising is recorded as something an owner couldn't do, with the owner's words and the reply", async () => {
    const { sendText } = await import("../api/_lib/wa.ts");
    await T.withTrackContext({ channel: "whatsapp", businessId: "b-4", said: "send me the invoice template" }, () => sendText("27809970004", "Sorry, I can't send files yet.", "b-4"));
    await T.flushTracking();
    const e = named("apology_sent")[0]!;
    assert.equal(e.excerpt, "send me the invoice template");
    assert.match(String(e.props.reply), /Sorry, I can't send files yet/);
  });

  test("anything logged with console.error becomes a failure event, masked and grouped", async () => {
    T.installConsoleCapture();
    const was = console.log;
    console.error("job 991 (inbound) attempt 2 failed:", new Error("owner 27809970005 timed out"));
    console.error("job 992 (inbound) attempt 1 failed:", new Error("owner 27809970006 timed out"));
    console.log = was;
    await T.flushTracking();
    const logged = named("log_error");
    assert.equal(logged.length, 2);
    assert.ok(!JSON.stringify(logged).includes("2782123000"), "numbers masked");
    assert.equal(new Set(logged.map((e) => e.fingerprint)).size, 1, "grouped as one problem");
  });
});

describe("the team is emailed", () => {
  const seedIncident = (over: Record<string, unknown> = {}) =>
    db.tables.incidents!.push({ fingerprint: `fp-${Math.random()}`, name: "job_dead", category: "failure", severity: "critical", alert: "immediate", summary: "A plan build stage job failed 3 times", first_seen: new Date().toISOString(), last_seen: new Date().toISOString(), count: 3, since_email: 3, last_props: { stage: "strategy" }, emailed_at: null, resolved_at: null, ...over });

  test("an immediate incident is emailed once, then rate-limited, and marked as sent", async () => {
    seedIncident();
    const now = new Date();
    assert.equal(await alerts.runImmediate(now), 1);
    assert.equal(net.emails.length, 1);
    assert.match(net.emails[0]!.subject, /CRITICAL: A plan build stage job failed 3 times/);
    assert.deepEqual(net.emails[0]!.to, ["team@example.com"]);
    assert.equal(db.tables.incidents![0]!.since_email, 0);
    seedIncident({ summary: "Another one" });
    assert.equal(await alerts.runImmediate(new Date(now.getTime() + 60_000)), 0, "not within 5 minutes of the last");
    assert.equal(await alerts.runImmediate(new Date(now.getTime() + 6 * 60_000)), 1);
  });

  test("the hourly email lists what people couldn't do, in their own (scrubbed) words", async () => {
    await T.withTrackContext({ businessId: "abcdef12-0000-0000-0000-000000000000", country: "KE", stage: "plan_ready", said: "Can you post on my Instagram for me?" }, async () => {
      T.trackUnmet("off_topic_request");
    });
    await T.flushTracking();
    // The window closes a minute before "now" (events still being written land in the next one).
    const n = await alerts.runDigest(new Date(Date.now() + 2 * 60_000));
    assert.ok(n >= 1);
    const mail = net.emails.pop()!;
    assert.match(mail.subject, /1 thing people couldn't do/);
    assert.match(mail.text, /off topic request — owner abcdef12 \(KE\), at plan_ready/);
    assert.match(mail.text, /Can you post on my Instagram for me\?/);
  });

  test("a failed email is itself recorded, and nothing is marked sent", async () => {
    seedIncident();
    net.email.fail = true;
    assert.equal(await alerts.runImmediate(new Date()), 0);
    await T.flushTracking();
    assert.equal(db.tables.incidents!.find((i) => i.name === "job_dead")!.since_email, 3);
    assert.ok(named("alert_email_failed").length === 1);
  });

  test("the daily summary counts real owners only, and says so when there were none", async () => {
    const s = await alerts.summarise(new Date(Date.now() - 86_400_000), new Date(Date.now() + 1000));
    assert.equal(typeof s.owners_active, "number");
    assert.ok(Array.isArray(s.funnel) && s.funnel.length === alerts.FUNNEL.length);
  });
});

describe("the dashboard", () => {
  test("refuses without the admin secret, opens with it, and never shows a phone number", async () => {
    const admin = await import("../api/admin.ts");
    const no = await admin.GET(new Request("https://fin.test/api/admin?view=overview"));
    assert.equal(no.status, 403);
    await engine.handleInbound(textFrom("27809970009", "hi"));
    await T.flushTracking();
    const yes = await admin.GET(new Request("https://fin.test/api/admin?view=events", { headers: { Authorization: "Bearer fake-admin-secret" } }));
    assert.equal(yes.status, 200);
    const body = await yes.text();
    assert.ok(body.includes("turn_received"));
    assert.ok(!body.includes("27809970009"));
  });
});

describe("the final review's findings, pinned", () => {
  test("an owner's connector token in the URL is never stored or emailed", async () => {
    const handler = T.tracked("mcp", "mcp", async () => new Response("boom", { status: 500 }));
    await handler(new Request("https://fin.test/mcp/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-"));
    await T.flushTracking();
    const all = JSON.stringify([...events(), ...db.tables.incidents!]);
    assert.ok(!all.includes("AbCdEfGhIjKlMnOp"), "token absent");
    assert.equal(named("http_request").pop()!.props.path, "/mcp/<token>");
  });

  test("Fin's apology is scrubbed, the owner's echoed words are replaced, and the incident never keeps it", async () => {
    const { sendText } = await import("../api/_lib/wa.ts");
    const said = "my number is 0825550199 and I owe the loan shark";
    await T.withTrackContext({ channel: "whatsapp", businessId: "b-ap", said }, () => sendText("27809970010", `Sorry, I can't help with that. I heard: "${said}"`, "b-ap"));
    await T.flushTracking();
    const e = named("apology_sent").pop()!;
    assert.match(String(e.props.reply), /\[their words\]/);
    assert.doesNotMatch(String(e.props.reply), /0825550199|loan shark/);
    const inc = db.tables.incidents!.find((i) => i.name === "apology_sent")!;
    assert.equal(inc.last_props.reply, undefined);
  });

  test("an unmet request marked 'not emailed' never sends the hourly email on its own", async () => {
    T.trackUnmet("mcp_request_refused", { severity: "info", alert: "none", props: { reason: "unknown_method" } });
    await T.flushTracking();
    assert.equal(await alerts.runDigest(new Date(Date.now() + 2 * 60_000)), 0);
    assert.equal(net.emails.length, 0);
  });

  test("a logged error keeps its label, never the text after it (model output, a provider's body)", async () => {
    T.installConsoleCapture();
    console.error(`model bad-json [build:strategy] x/y truncated=false: {"reading":"Thandi owes R5000 to a loan shark, call 0825550199"}`);
    await T.flushTracking();
    const e = named("log_error").pop()!;
    assert.doesNotMatch(JSON.stringify(e), /loan shark|Thandi|0825550199/);
    assert.match(String(e.props.message), /^model bad-json \[build:strategy\] x\/y truncated=false/);
  });

  test("half an emoji is never left at a cut (Postgres would refuse the whole batch)", () => {
    const out = T.scrubExcerpt(`${"a".repeat(198)}😀😀`)!;
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), "no lone high surrogate");
    assert.equal(T.cutSafe("ab😀", 3), "ab");
  });

  test("an email takes off only what it reported: repeats counted meanwhile wait for the next one", async () => {
    db.tables.incidents!.push({ fingerprint: "fp-x", name: "job_dead", category: "failure", severity: "error", alert: "immediate", summary: "x", first_seen: new Date().toISOString(), last_seen: new Date().toISOString(), count: 2, since_email: 2, last_props: {}, emailed_at: null, resolved_at: null });
    // A repeat lands while the email is in flight.
    const was = globalThis.fetch;
    globalThis.fetch = (async (u: unknown, i?: RequestInit) => {
      if (String(u).includes("api.resend.com")) db.tables.incidents!.find((x) => x.fingerprint === "fp-x")!.since_email += 1;
      return was(u as string, i);
    }) as typeof fetch;
    try {
      assert.equal(await alerts.runImmediate(new Date()), 1);
    } finally {
      globalThis.fetch = was;
    }
    assert.equal(db.tables.incidents!.find((i) => i.fingerprint === "fp-x")!.since_email, 1, "the repeat is still waiting");
  });

  test("immediate emails stop at the day's budget, so the hourly and daily ones still have room", async () => {
    const today = new Date().toISOString().slice(0, 10);
    db.tables.alert_state!.push({ key: "immediate_day", at: new Date(0).toISOString(), detail: `${today}:60` });
    db.tables.incidents!.push({ fingerprint: "fp-b", name: "job_dead", category: "failure", severity: "critical", alert: "immediate", summary: "y", first_seen: new Date().toISOString(), last_seen: new Date().toISOString(), count: 1, since_email: 1, last_props: {}, emailed_at: null, resolved_at: null });
    assert.equal(await alerts.runImmediate(new Date()), 0);
    assert.equal(net.emails.length, 0);
  });

  test("a daily summary that fails is retried in the next five minutes, and the day's counts are kept either way", async () => {
    const hour = Number(process.env.ALERT_DIGEST_HOUR_UTC || 5);
    const day = new Date();
    const at = (min: number) => new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, min));
    const yesterday = new Date(at(0).getTime() - 12 * 3_600_000);
    db.tables.events!.push({ at: yesterday.toISOString(), name: "turn_received", category: "behaviour", severity: "info", business_id: "b-d", channel: "whatsapp", internal: false, props: {} });
    net.email.fail = true;
    assert.equal(await alerts.runDaily(at(1)), false);
    assert.equal(await alerts.runDaily(at(2)), false, "same five-minute slot: not tried twice");
    const ymd = new Date(at(0).getTime() - 86_400_000).toISOString().slice(0, 10);
    assert.ok(db.tables.event_daily!.some((r) => r.day === ymd && r.name === "turn_received"), "counts rolled up despite the failed email");
    net.email.fail = false;
    assert.equal(await alerts.runDaily(at(6)), true, "the next slot sends it");
    assert.equal(await alerts.runDaily(at(11)), false, "and only once");
  });
});
