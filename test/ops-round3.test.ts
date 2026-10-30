// Charles — three live findings from production, 2026-09-23.
//
// 1. The website's WhatsApp buttons pointed at a placeholder number, because
//    the deploy-time `sed` meant to replace it never ran. They now go through
//    /wa, which redirects to WHATSAPP_PUBLIC_NUMBER at click time.
// 2. /api/health said queue.dead = 8 and nothing else. The authenticated body
//    now says which jobs, when, and why — with no owner text or numbers.
// 3. A plan build took over five minutes and nothing recorded where. A
//    finished build now writes one plan_build_timing row, summarised on
//    /api/health and kept out of every guardrail count.

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.SESSION_SECRET = "fake-session-secret";
process.env.WORKER_SECRET = "fake-worker-secret";
process.env.WHATSAPP_APP_SECRET = "fake-app-secret";
process.env.PUBLIC_BASE_URL = "https://charles.test";
delete process.env.TYPESAFE_API_KEY;
delete process.env.WHATSAPP_PUBLIC_NUMBER;
// The bot's own number is asked of Meta when WHATSAPP_PUBLIC_NUMBER is unset.
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1098765";

import { installFakeNet, makeFakeDb, type FakeDb, type FakeNet } from "./_fakes.ts";

const ADMIN = { Authorization: "Bearer fake-worker-secret" };

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let plan: typeof import("../api/plan.ts");
let health: typeof import("../api/health.ts");
let dbmod: typeof import("../api/_lib/db.ts");
let cohort: typeof import("../api/_lib/cohort.ts");
let wanumber: typeof import("../api/_lib/wanumber.ts");

before(async () => {
  net = installFakeNet();
  db = makeFakeDb();
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  plan = await import("../api/plan.ts");
  health = await import("../api/health.ts");
  cohort = await import("../api/_lib/cohort.ts");
  wanumber = await import("../api/_lib/wanumber.ts");
});

after(() => {
  restore();
  net.restore();
  delete process.env.WHATSAPP_PUBLIC_NUMBER;
});

beforeEach(() => {
  db.reset();
  delete process.env.WHATSAPP_PUBLIC_NUMBER;
  // By default Meta cannot tell us the number (a 400), so "nothing configured" means the honest page.
  wanumber.__resetPublicNumberCache();
  net.phoneNumber.display = null;
  net.phoneNumber.hang = false;
  net.phoneNumber.lookups.length = 0;
});

const wa = (qs: string) => plan.GET(new Request(`https://charles.test/api/plan?action=whatsapp${qs}`));
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

// ── 1. The website's WhatsApp link ───────────────────────────────

test("/wa with no number configured (and Meta unable to say) is an honest page, never a wa.me link to nobody", async () => {
  const res = await wa("&m=start");
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("Location"), null);
  const html = await res.text();
  assert.match(html, /isn't switched on yet/);
  assert.doesNotMatch(html, /wa\.me/);
});

test("/wa treats the old placeholder number as not configured", async () => {
  process.env.WHATSAPP_PUBLIC_NUMBER = "27663129297";
  assert.equal((await wa("&m=start")).status, 503);
});

test("/wa redirects to the configured number, however it was typed, with a fixed preset message", async () => {
  process.env.WHATSAPP_PUBLIC_NUMBER = "+27 80 993-0003";
  const res = await wa("&m=plan");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), `https://wa.me/27809930003?text=${encodeURIComponent("Send me my plan please.")}`);
  assert.equal(res.headers.get("Cache-Control"), "no-store", "a changed number must take effect on the next click");

  // An unknown preset falls back to "start" — the query string never supplies the text.
  const odd = await wa("&m=<script>&text=send%20money");
  assert.equal(odd.headers.get("Location"), `https://wa.me/27809930003?text=${encodeURIComponent("Hi Charles, I want to start.")}`);

  // "ask" opens the chat with nothing prefilled.
  assert.equal((await wa("&m=ask")).headers.get("Location"), "https://wa.me/27809930003");
});

test("health says, publicly, whether the WhatsApp buttons work", async () => {
  let body = await (await health.GET(new Request("https://charles.test/api/health"))).json();
  assert.equal(body.whatsapp_link, false);
  process.env.WHATSAPP_PUBLIC_NUMBER = "27809930003";
  body = await (await health.GET(new Request("https://charles.test/api/health"))).json();
  assert.equal(body.whatsapp_link, true);
});

// ── The number, asked of Meta when WHATSAPP_PUBLIC_NUMBER is unset ──

describe("/wa resolves the bot's own number from Meta", () => {
  // A failed lookup is logged as a warning now (wa_link_dead is the critical
  // event; round 19 counted these lines as errors): both are captured.
  const captureErrors = async (fn: () => Promise<void>): Promise<string[]> => {
    const errors: string[] = [];
    const orig = console.error;
    const origWarn = console.warn;
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
    console.warn = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
    try {
      await fn();
    } finally {
      console.error = orig;
      console.warn = origWarn;
    }
    return errors;
  };

  test("WHATSAPP_PUBLIC_NUMBER wins, with no Graph call", async () => {
    net.phoneNumber.display = "+1 555-010-9999";
    process.env.WHATSAPP_PUBLIC_NUMBER = "27809930003";
    assert.equal((await wa("&m=ask")).headers.get("Location"), "https://wa.me/27809930003");
    assert.equal(net.phoneNumber.lookups.length, 0);
  });

  test("unset: Meta is asked, the display number is normalised to digits, and a second click is served from the cache", async () => {
    net.phoneNumber.display = "+27 80 993 0003";
    const res = await wa("&m=ask");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), "https://wa.me/27809930003");
    assert.equal(net.phoneNumber.lookups.length, 1);
    const [lookup] = net.phoneNumber.lookups;
    assert.match(lookup!.url, /^https:\/\/graph\.facebook\.com\/v[\d.]+\/1098765\?fields=display_phone_number$/);
    assert.equal(lookup!.auth, "Bearer fake-wa-token");
    assert.doesNotMatch(lookup!.url, /fake-wa-token/, "the token never goes in the URL");

    net.phoneNumber.display = "15550000000"; // even if Meta would now say otherwise
    assert.equal((await wa("&m=ask")).headers.get("Location"), "https://wa.me/27809930003");
    assert.equal(net.phoneNumber.lookups.length, 1, "no second Graph call");

    // Health reads the same cached number.
    const body = await (await health.GET(new Request("https://charles.test/api/health"))).json();
    assert.equal(body.whatsapp_link, true);
    assert.equal(net.phoneNumber.lookups.length, 1);
  });

  test("the placeholder counts as unset: Meta is asked", async () => {
    process.env.WHATSAPP_PUBLIC_NUMBER = "27663129297";
    net.phoneNumber.display = "15551234567";
    assert.equal((await wa("&m=ask")).headers.get("Location"), "https://wa.me/15551234567");
    assert.equal(net.phoneNumber.lookups.length, 1);
  });

  test("a Graph failure is the not-switched-on page, and is remembered briefly rather than retried per click", async () => {
    const errors = await captureErrors(async () => {
      const res = await wa("&m=start");
      assert.equal(res.status, 503);
      assert.match(await res.text(), /isn't switched on yet/);
      net.phoneNumber.display = "27809930003"; // Meta recovers...
      assert.equal((await wa("&m=start")).status, 503, "...but the failure is cached for a few minutes");
      assert.equal(net.phoneNumber.lookups.length, 1);
    });
    assert.ok(errors.some((e) => /HTTP 400/.test(e)));
    assert.ok(errors.every((e) => !/fake-wa-token/.test(e)), "the token is never logged");
  });

  test("a Graph timeout is bounded, and ends in the not-switched-on page", async () => {
    net.phoneNumber.hang = true;
    const errors = await captureErrors(async () => {
      const t0 = Date.now();
      assert.equal(await wanumber.resolvePublicWhatsAppNumber({ timeoutMs: 50 }), null);
      assert.ok(Date.now() - t0 < 1000);
      assert.equal((await wa("&m=start")).status, 503);
      assert.equal(net.phoneNumber.lookups.length, 1, "the timed-out lookup is cached as a failure");
    });
    assert.ok(errors.some((e) => /timed out/.test(e)));
    assert.ok(errors.every((e) => !/fake-wa-token/.test(e)));
  });

  test("normaliseDisplayNumber keeps digits and rejects junk", () => {
    assert.equal(wanumber.normaliseDisplayNumber("+27 80 993 0003"), "27809930003");
    assert.equal(wanumber.normaliseDisplayNumber("15551234567"), "15551234567");
    assert.equal(wanumber.normaliseDisplayNumber("+27 66 312 9297"), null, "the placeholder");
    assert.equal(wanumber.normaliseDisplayNumber("123"), null);
    assert.equal(wanumber.normaliseDisplayNumber(undefined), null);
  });
});

test("no page in public/ carries a hardcoded WhatsApp number; every button goes through /wa with a real preset", async () => {
  const dir = new URL("../public/", import.meta.url);
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".html"));
  assert.ok(files.includes("index.html") && files.includes("plan.html") && files.includes("ask.html"));
  for (const f of files) {
    const html = await fs.readFile(new URL(f, dir), "utf8");
    assert.doesNotMatch(html, /27663129297/, `${f} still carries the placeholder number`);
    assert.doesNotMatch(html, /https?:\/\/wa\.me\//, `${f} links to wa.me directly instead of through /wa`);
    for (const m of html.matchAll(/\/wa\?m=([a-z]+)/g)) {
      assert.ok(m[1]! in plan.WA_PRESETS, `${f} uses an unknown /wa preset "${m[1]}"`);
    }
  }
  const index = await fs.readFile(new URL("index.html", dir), "utf8");
  assert.ok((index.match(/href="\/wa\?m=start"/g) ?? []).length >= 3, "the landing page's buttons go through /wa");

  const vercel = JSON.parse(await fs.readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.ok(
    vercel.rewrites.some((r: { source: string; destination: string }) => r.source === "/wa" && r.destination === "/api/plan?action=whatsapp"),
    "vercel.json routes /wa to the redirect",
  );
});

// ── 2. Dead jobs, diagnosable ────────────────────────────────────

test("authenticated health lists recent dead jobs: kind, when, why, and whether the owner still exists — no owner number or words", async () => {
  db.tables.businesses!.push(
    { id: "biz-live", wa_id: "27820000001", country: "ZA", deleted_at: null },
    { id: "biz-gone", wa_id: "27820000002", country: "ZA", deleted_at: ago(60) },
  );
  const longError = `model call failed for 27820000001: ${"x".repeat(300)}`;
  db.tables.jobs!.push(
    { id: 1, kind: "plan_build_stage", business_id: "biz-live", wa_id: null, payload: { step: "strategy" }, status: "dead", attempts: 3, max_attempts: 3, last_error: longError, created_at: ago(600), updated_at: ago(300) },
    { id: 2, kind: "inbound", business_id: null, wa_id: "27820000002", payload: { from: "27820000002", text: "my secret business idea" }, status: "dead", attempts: 3, max_attempts: 3, last_error: "boom", created_at: ago(900), updated_at: ago(800) },
    { id: 3, kind: "freshness", business_id: null, wa_id: null, payload: {}, status: "dead", attempts: 3, max_attempts: 3, last_error: null, created_at: ago(1000), updated_at: ago(950) },
    { id: 4, kind: "inbound", business_id: null, wa_id: "27820000001", payload: {}, status: "done", attempts: 1, max_attempts: 3, last_error: null, created_at: ago(10), updated_at: ago(5) },
  );

  const res = await health.GET(new Request("https://charles.test/api/health", { headers: ADMIN }));
  const body = await res.json();
  assert.equal(body.queue.dead, 3);
  const dead = body.queue.recent_dead as import("../api/_lib/db.ts").DeadJobSummary[];
  assert.deepEqual(dead.map((d) => d.id), [1, 2, 3], "most recent death first, done jobs excluded");

  const [build, inbound, fresh] = dead;
  assert.equal(build!.kind, "plan_build_stage");
  assert.equal(build!.step, "strategy");
  assert.equal(build!.business_exists, true);
  assert.equal(build!.last_error!.length, 150);
  assert.match(build!.last_error!, /^model call failed for \[number\]:/);
  assert.equal(inbound!.business_exists, false, "the owner behind an inbound job was since forgotten");
  assert.equal(fresh!.business_exists, null, "a freshness sweep has no owner");

  const raw = JSON.stringify(body.queue);
  assert.doesNotMatch(raw, /2782000000/, "no phone number anywhere in the summary");
  assert.doesNotMatch(raw, /secret business idea/, "no owner text");

  // And the public form still says nothing about the queue.
  const pub = await (await health.GET(new Request("https://charles.test/api/health"))).json();
  assert.equal(pub.queue, undefined);
});

// ── 3. Plan build timing ─────────────────────────────────────────

test("a finished build records its total and per-stage timings as a plan_build_timing note", async () => {
  const now = Date.now();
  const at = (s: number) => new Date(now - s * 1000).toISOString();
  db.tables.plan_builds!.push({ business_id: "biz-t", stage: "done", created_at: at(312) });
  db.tables.jobs!.push(
    { kind: "plan_build_stage", business_id: "biz-t", payload: { step: "context" }, status: "done", attempts: 1, created_at: at(312), updated_at: at(272) },
    { kind: "plan_build_stage", business_id: "biz-t", payload: { step: "strategy" }, status: "done", attempts: 2, created_at: at(272), updated_at: at(177) },
    { kind: "plan_build_stage", business_id: "biz-t", payload: { step: "workstreams" }, status: "done", attempts: 1, created_at: at(272), updated_at: at(60) },
    { kind: "plan_build_stage", business_id: "biz-t", payload: { step: "finalize" }, status: "done", attempts: 1, created_at: at(60), updated_at: at(50) },
    { kind: "plan_build_stage", business_id: "biz-t", payload: { step: "pdf" }, status: "running", attempts: 1, created_at: at(50), updated_at: null },
    // A job from an EARLIER attempt of this build must not be counted.
    { kind: "plan_build_stage", business_id: "biz-t", payload: { step: "context" }, status: "dead", attempts: 3, created_at: at(4000), updated_at: at(3900) },
  );

  await dbmod.recordPlanBuildTiming("biz-t", now);
  const row = db.tables.safety_events!.find((e) => e.check_name === "plan_build_timing");
  assert.ok(row, "a timing row was written");
  assert.equal(row!.engine, "none");
  assert.equal(row!.outcome, "pass");
  assert.equal(row!.score, 312);
  assert.equal(row!.detail, "total 312s; context 40s; strategy 95s (1 retry); workstreams 212s; finalize 10s; pdf 50s; v2");
});

test("a build that was interrupted on the way is marked, so the owner estimate leaves it out", async () => {
  const now = Date.now();
  db.tables.plan_builds!.push({ business_id: "biz-i", stage: "done", created_at: new Date(now - 900_000).toISOString(), last_error: "[auto-retried] revived" });
  await dbmod.recordPlanBuildTiming("biz-i", now);
  const row = db.tables.safety_events!.find((e) => e.check_name === "plan_build_timing" && e.business_id === "biz-i")!;
  assert.match(row.detail, /; v2; interrupted$/);
});

test("resetPlanBuild restarts the build clock, so a rebuild is timed from its own start", async () => {
  db.tables.plan_builds!.push({ business_id: "biz-r", stage: "failed", created_at: ago(99999) });
  await dbmod.resetPlanBuild("biz-r");
  const pb = db.tables.plan_builds!.find((r) => r.business_id === "biz-r")!;
  assert.ok(Date.now() - new Date(pb.created_at).getTime() < 5000);
});

test("timing is best effort: with no plan_builds row it writes nothing and does not throw", async () => {
  await dbmod.recordPlanBuildTiming("nobody");
  assert.equal(db.tables.safety_events!.length, 0);
});

test("health reports p50/max build time over 24h, and timing/strategy notes never count as guardrail checks", async () => {
  const recent = ago(60);
  db.tables.safety_events!.push(
    { check_name: "plan_build_timing", engine: "none", outcome: "pass", score: 100, detail: "total 100s", created_at: recent },
    { check_name: "plan_build_timing", engine: "none", outcome: "pass", score: 200, detail: "total 200s", created_at: recent },
    { check_name: "plan_build_timing", engine: "none", outcome: "pass", score: 312, detail: "total 312s; strategy 95s", created_at: recent },
    { check_name: "plan_build_timing", engine: "none", outcome: "pass", score: 9999, detail: "old", created_at: ago(3 * 864e2) },
    { check_name: "plan_strategy", engine: "none", outcome: "flag", created_at: recent },
    { check_name: "knowledge_signal", engine: "none", outcome: "pass", created_at: recent },
    { check_name: "distress", engine: "model", outcome: "pass", created_at: recent },
  );

  const body = await (await health.GET(new Request("https://charles.test/api/health", { headers: ADMIN }))).json();
  assert.deepEqual(body.plan_build_times_24h, { builds: 3, p50_seconds: 200, max_seconds: 312, slowest: "total 312s; strategy 95s" });
  assert.equal(body.safety.checks24h, 1, "only the distress check is a guardrail check");
  assert.equal(body.plans_without_strategy_24h, 1);

  const report = await cohort.buildReport(30);
  assert.equal(report.guardrails.checks_in_window, 1, "the sponsor report counts the same way");
});

// ── Review of round 3 ────────────────────────────────────────────

test("/wa: prototype keys never reach the link text", async () => {
  process.env.WHATSAPP_PUBLIC_NUMBER = "27809930003";
  const start = decodeURIComponent((await wa("&m=start")).headers.get("Location") ?? "");
  for (const m of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    const loc = decodeURIComponent((await wa(`&m=${m}`)).headers.get("Location") ?? "");
    assert.equal(loc, start, m);
    assert.doesNotMatch(loc, /\[object Object\]|native code/);
  }
});

test("recordRetrievalGap without the owner's words writes no note of its own (the turn writes its one note)", async () => {
  await dbmod.recordRetrievalGap({ businessId: "b-gap", country: "ZA", query: "qqzx", topScore: 0, quote: null });
  assert.equal(db.tables.safety_events!.filter((e) => e.check_name === "knowledge_signal").length, 0);
  assert.equal(db.tables.retrieval_gaps!.length, 1);
});

test("dead-job errors mask formatted phone numbers too", async () => {
  db.tables.jobs!.push({ id: 991, kind: "inbound", status: "dead", attempts: 5, wa_id: null, business_id: null, payload: {}, last_error: "send to +27 66 312 9297 failed; also 0809930003", created_at: ago(60), updated_at: ago(30) });
  const dead = await dbmod.recentDeadJobs();
  const row = dead.find((d) => /send to/.test(d.last_error ?? ""))!;
  assert.doesNotMatch(row.last_error!, /312|0809930003/);
});

// ── A failed plan build resumes from its saved work, and is retried once on its own ──
describe("failed plan builds", () => {
  const failedRow = (business_id: string, over: Record<string, unknown> = {}) => ({
    business_id, stage: "failed", goal: "g", context: { name: "X" }, map: [], dropped_modules: [], strategy: { how_we_win: "w" }, strategy_done: true,
    workstreams: [{ id: "m_owed" }], pending_workstreams: ["m_price"], plan_id: null, last_error: "stage workstreams: model timeout",
    heartbeat_at: ago(900), updated_at: ago(900), created_at: ago(1200), ...over,
  });
  const steps = (id: string) => db.tables.jobs!.filter((j) => j.business_id === id && j.kind === "plan_build_stage").map((j) => (j.payload as { step: string }).step);

  test("resumePointFor reads how far it got", () => {
    assert.equal(dbmod.resumePointFor(failedRow("a", { context: null }) as never), null);
    assert.equal(dbmod.resumePointFor(failedRow("a") as never), "building");
    assert.equal(dbmod.resumePointFor(failedRow("a", { pending_workstreams: [] }) as never), "finalize");
    assert.equal(dbmod.resumePointFor(failedRow("a", { plan_id: "p1" }) as never), "pdf");
  });

  test("an owner's message revives a failed build where it stopped — the strategy and finished parts are kept", async () => {
    const pb = await import("../api/_lib/engine/planbuild.ts");
    const biz = await dbmod.createBusiness("27809950301", "ZA");
    db.tables.plan_builds!.push(failedRow(biz.id));
    await pb.resumePlanBuild({ ...biz, stage: "building_plan" } as never);
    const row = db.tables.plan_builds!.find((r) => r.business_id === biz.id)!;
    assert.equal(row.stage, "building");
    assert.deepEqual(row.strategy, { how_we_win: "w" }, "strategy kept");
    assert.equal((row.workstreams as unknown[]).length, 1, "finished part kept");
    assert.deepEqual(steps(biz.id), ["workstreams"], "only the unfinished lane runs; no context, no strategy");
  });

  test("an owner who never writes back gets ONE automatic retry, and a second failure is not retried again", async () => {
    const pb = await import("../api/_lib/engine/planbuild.ts");
    const biz = await dbmod.createBusiness("27809950302", "ZA");
    await dbmod.updateBusiness(biz.id, { stage: "building_plan" } as never);
    db.tables.plan_builds!.push(failedRow(biz.id));
    assert.equal(await pb.autoRetryFailedBuilds(), 1);
    const row = db.tables.plan_builds!.find((r) => r.business_id === biz.id)!;
    assert.equal(row.stage, "building");
    assert.match(String(row.last_error), /\[auto-retried\]/);
    // It fails again; the marker survives, and the sweep leaves it alone.
    await dbmod.failPlanBuild(biz.id, "stage workstreams: model timeout again");
    row.updated_at = ago(900);
    assert.match(String(row.last_error), /\[auto-retried\]/);
    assert.equal(await pb.autoRetryFailedBuilds(), 0);
  });

  test("a build ended on purpose (no playbook fits; owner asked to clarify) is never auto-retried", async () => {
    const pb = await import("../api/_lib/engine/planbuild.ts");
    const biz = await dbmod.createBusiness("27809950303", "ZA");
    await dbmod.updateBusiness(biz.id, { stage: "clarify_objective" } as never);
    db.tables.plan_builds!.push(failedRow(biz.id, { context: null }));
    assert.equal(await pb.autoRetryFailedBuilds(), 0);
    assert.equal(db.tables.plan_builds!.find((r) => r.business_id === biz.id)!.stage, "failed");
  });

  test("a recent failure waits: the owner gets the first chance to reply", async () => {
    const pb = await import("../api/_lib/engine/planbuild.ts");
    const biz = await dbmod.createBusiness("27809950304", "ZA");
    await dbmod.updateBusiness(biz.id, { stage: "building_plan" } as never);
    db.tables.plan_builds!.push(failedRow(biz.id, { updated_at: ago(60) }));
    assert.equal(await pb.autoRetryFailedBuilds(), 0);
  });
});

// ── Round 6: Meta answers 200 with no number (live, rounds 4–6) ──
describe("/wa when Meta's lookup has no number: the number owners actually wrote to", () => {
  test("the webhook keeps the bot's own number on each message", async () => {
    const { parseWebhook } = await import("../api/_lib/wa.ts");
    const parsed = parseWebhook({ entry: [{ changes: [{ field: "messages", value: { metadata: { display_phone_number: "+27 82 555 0100", phone_number_id: "PNID-1" }, messages: [{ id: "wamid.x", from: "27809950999", timestamp: "1700000000", type: "text", text: { body: "hi" } }] } }] }] });
    assert.equal(parsed.messages[0]!.toNumber, "+27 82 555 0100");
    assert.equal(parsed.messages[0]!.toPhoneId, "PNID-1");
  });

  test("Graph 200 without display_phone_number → /wa uses the number from recent inbound metadata for this phone id", async () => {
    const { __resetPublicNumberCache } = await import("../api/_lib/wanumber.ts");
    __resetPublicNumberCache();
    const was = process.env.WHATSAPP_PHONE_NUMBER_ID;
    process.env.WHATSAPP_PHONE_NUMBER_ID = "PNID-1";
    net.phoneNumber.display = "";
    try {
      await dbmod.enqueue({ kind: "inbound", waId: "27809950998", payload: { waMessageId: "a", from: "27809950998", toNumber: "15551234567", toPhoneId: "OLD-NUMBER" } });
      await dbmod.enqueue({ kind: "inbound", waId: "27809950999", payload: { waMessageId: "b", from: "27809950999", toNumber: "+27 82 555 0100", toPhoneId: "PNID-1" } });
      const res = await wa("&m=start");
      assert.equal(res.status, 302);
      assert.match(res.headers.get("Location") ?? "", /^https:\/\/wa\.me\/27825550100\?/);
    } finally {
      process.env.WHATSAPP_PHONE_NUMBER_ID = was;
      net.phoneNumber.display = null;
      __resetPublicNumberCache();
    }
  });

  test("…and with no inbound metadata either, still the honest not-switched-on page", async () => {
    const { __resetPublicNumberCache } = await import("../api/_lib/wanumber.ts");
    __resetPublicNumberCache();
    net.phoneNumber.display = "";
    try {
      assert.equal((await wa("&m=start")).status, 503);
    } finally {
      net.phoneNumber.display = null;
      __resetPublicNumberCache();
    }
  });
});
