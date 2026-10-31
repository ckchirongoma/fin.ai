// Charles — Chase Intelligence capture (docs/INTEL-CONTRACT.md).
//
// Everything a turn did, in order, from one id: what was asked, what the
// models were shown and said, what was checked, what was sent, what was run,
// how it ended. Capture is additive: it never throws into the code it
// watches, never waits on the request path, never changes a reply, and no
// secret or identifier is ever written. INTEL_CAPTURE = full | meta | off.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key-abcdefghijklmnop";
process.env.OPENROUTER_API_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
process.env.WHATSAPP_ACCESS_TOKEN = "EAAGfakewhatsapptoken0123456789abcdefghij";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";
process.env.WORKER_SECRET = "fake-worker-secret-0123456789";
process.env.PUBLIC_BASE_URL = "https://charles.test";
process.env.SESSION_SECRET = "fake-session-secret-0123456789";
delete process.env.TYPESAFE_API_KEY;
// The suite's strict run sets TRACKING_OFF; this file is about capture, so it is on here.
delete process.env.TRACKING_OFF;
delete process.env.INTEL_CAPTURE;

import { installFakeNet, makeFakeDb, textFrom, type FakeDb, type FakeNet } from "./_fakes.ts";

const WA = "27809930111";
const knowledge = JSON.parse(readFileSync(new URL("../seed/knowledge.json", import.meta.url), "utf8"));
const tools = JSON.parse(readFileSync(new URL("../seed/tools.json", import.meta.url), "utf8"));

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let dbmod: typeof import("../api/_lib/db.ts");
let intel: typeof import("../api/_lib/intel.ts");
let redact: typeof import("../api/_lib/intelredact.ts");
let track: typeof import("../api/_lib/track.ts");
let engine: typeof import("../api/_lib/engine/index.ts");
let exp: typeof import("../api/_lib/intelexport.ts");

before(async () => {
  net = installFakeNet();
  const roles = ["router", "wa_reply", "help", "plan_builder", "safety", "voice"].map((role) => ({ role, provider: "openrouter", model: `test/${role}`, fallbacks: [], params: {}, enabled: true }));
  db = makeFakeDb({ model_config: roles, knowledge_entries: knowledge, tools });
  dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  intel = await import("../api/_lib/intel.ts");
  redact = await import("../api/_lib/intelredact.ts");
  track = await import("../api/_lib/track.ts");
  engine = await import("../api/_lib/engine/index.ts");
  exp = await import("../api/_lib/intelexport.ts");
  net.onModel(/You are a strict checker/, (prompt) => Object.fromEntries([...prompt.matchAll(/- "([a-z_]+)":/g)].map((m) => [m[1]!, false])));
  net.onModel(/Classify this message from a person to their money assistant/, () => ({ intent: "question", domain: "spending", tool_need: null, missing_fact: null, risk: [], search_terms: "rent" }));
  net.onModel(/ROUTER RESULT/, () => ({ message: "Pay the rent first, then the R300 to the mashonisa.", artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: "debt" }));
  net.onModel(/You maintain one person's money memory/, () => ({ context_updates: null, map_updates: null, decisions: null, commitments: null, results: null, owner_notes: null, graph_updates: null }));
});

after(() => {
  restore?.();
  net?.restore();
});

beforeEach(() => {
  delete process.env.INTEL_CAPTURE;
});

const rows = () => (db.tables.intel_events ?? []) as Record<string, any>[];
const all = () => JSON.stringify(rows());

async function planned(wa: string): Promise<import("../api/_lib/types.ts").Business> {
  const b = await dbmod.createBusiness(wa, "ZA");
  await dbmod.updateBusiness(b.id, { stage: "plan_ready", diag_step: 12, consent_at: new Date().toISOString(), answers: { person: "Nomsa", owes: "A mashonisa" }, identity: { name: "Nomsa", earns: "x", one_liner: "x", unsure: null }, context: { name: "Nomsa" } } as never);
  return (await dbmod.findBusiness(wa))!;
}

// ── Redaction ────────────────────────────────────────────────────

test("redaction: every kind of secret goes before anything leaves the process", () => {
  const secrets = [
    process.env.OPENROUTER_API_KEY!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    process.env.WORKER_SECRET!,
    "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345",
    "Bearer abcdefghijklmnopqrstuvwxyz123456",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "EAAGm0PX4ZCpsBAKZCZBtestmetatoken0123456789abcdef",
    "AKIAIOSFODNN7EXAMPLE",
    "ghp_0123456789abcdefghijABCDEFGHIJ0123",
    "re_0123456789abcdefghijABCDEF",
    "AIzaSyA0123456789abcdefghijklmnopqrstuv",
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----",
  ];
  for (const s of secrets) {
    const out = redact.redactText(`before ${s} after`);
    assert.ok(!out.includes(s), `kept: ${s.slice(0, 12)}…`);
    assert.match(out, /^before .* after$/s);
  }
  const conn = redact.redactText("postgres://postgres:hunter2pass@db.example.co:5432/postgres");
  assert.doesNotMatch(conn, /hunter2pass/);
  assert.match(redact.redactText("my password is hunter2!"), /password is \[redacted\]/);
  assert.match(redact.redactText("https://charles.test/api/card?k=abcdef123456&x=1"), /k=\[redacted\]/);
  assert.match(redact.redactText("https://charles.test/mcp/AbCdEf0123456789AbCdEf0123"), /\/mcp\/\[redacted\]/);
  const obj = JSON.parse(redact.redactJson(JSON.stringify({ headers: { Authorization: "Bearer zzzzzzzzzzzzzzzzzzzz", cookie: "sid=abc" }, password: "x", token_hash: "abc", prompt_tokens: 12 })));
  assert.equal(obj.headers.Authorization, "[redacted]");
  assert.equal(obj.headers.cookie, "[redacted]");
  assert.equal(obj.password, "[redacted]");
  assert.equal(obj.token_hash, "[redacted]");
  assert.equal(obj.prompt_tokens, 12, "a count is not a secret");
});

test("redaction: ID, card, account and phone numbers, PINs, OTPs and sign-in codes go; money and dates stay", () => {
  const out = redact.redactText("ID 8001015009087, card 4111 1111 1111 1111, account 62123456789, phone +27 82 123 4567, my pin is 4321, OTP: 908172, Your Charles code is 482913.");
  for (const s of ["8001015009087", "4111 1111 1111 1111", "62123456789", "82 123 4567", "4321", "908172", "482913"]) assert.ok(!out.includes(s), s);
  const keep = redact.redactText("I pay R3,000 rent on 2026-11-01 and owe R12 500; R1200000 is the house.");
  assert.equal(keep, "I pay R3,000 rent on 2026-11-01 and owe R12 500; R1200000 is the house.");
});

// ── Capture ──────────────────────────────────────────────────────

test("capture never throws, never waits, and costs well under 5 ms at p95, even with a big prompt", async () => {
  const big = { messages: [{ role: "user", content: "x".repeat(40_000) }] };
  const times: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const t = performance.now();
    intel.capture("model", { name: "perf_probe", content: big });
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)]!;
  assert.ok(p95 < 5, `p95 ${p95.toFixed(3)}ms`);
  // A database that throws on every write: capture and the flush still return quietly.
  const broken = { from: () => { throw new Error("db down"); }, rpc: () => { throw new Error("db down"); } };
  const back = dbmod.__setClient(broken as never);
  intel.capture("track", { name: "while_down", content: { a: 1 } });
  await track.flushTracking();
  back();
  dbmod.__setClient(db.client);
  intel.__dropBuffered();
});

test("the switch: off records nothing, meta records the shape without the words, full records it all", async () => {
  process.env.INTEL_CAPTURE = "off";
  const before = rows().length;
  intel.capture("ask", { name: "switch_probe_off", content: { text: "nothing" } });
  await track.flushTracking();
  assert.equal(rows().length, before);

  process.env.INTEL_CAPTURE = "meta";
  intel.capture("ask", { name: "switch_probe_meta", content: { text: "private words here" } });
  await track.flushTracking();
  const meta = rows().find((r) => r.name === "switch_probe_meta")!;
  assert.equal(meta.content, null);
  assert.equal(meta.content_mode, "meta");
  assert.ok(meta.meta.content_chars > 0);
  assert.doesNotMatch(JSON.stringify(meta), /private words/);

  process.env.INTEL_CAPTURE = "full";
  intel.capture("ask", { name: "switch_probe_full", content: { text: "private words here" } });
  await track.flushTracking();
  assert.equal(rows().find((r) => r.name === "switch_probe_full")!.content.text, "private words here");
});

test("one WhatsApp turn reads back in order from one id: asked, seen, decided, checked, sent, how it ended", async () => {
  const biz = await planned(WA);
  await engine.handleInbound(textFrom(WA, "What should I pay first this month?"));
  await track.flushTracking();
  const mine = rows().filter((r) => r.business_id === biz.id && r.turn_id);
  assert.ok(mine.length, "the turn was captured");
  const turnId = mine[0]!.turn_id as string;
  const trace = await intel.readTrace(turnId);
  const kinds = new Set<string>(trace.map((e) => e.kind));
  for (const k of ["ask", "model", "check", "say", "send", "track"]) assert.ok(kinds.has(k), `the trace has ${k}: ${[...kinds].join(",")}`);
  // In order.
  for (let i = 1; i < trace.length; i++) assert.ok(String(trace[i - 1]!.at) + String(trace[i - 1]!.seq).padStart(12, "0") <= String(trace[i]!.at) + String(trace[i]!.seq).padStart(12, "0"));
  // What was asked, word for word; what the model was shown and what it said.
  assert.equal(trace.find((e) => e.kind === "ask")!.content.text, "What should I pay first this month?");
  const router = trace.find((e) => e.kind === "model" && /ROUTER RESULT/.test(JSON.stringify(e.content.messages)))!;
  assert.ok(router, "the router call, with its prompt");
  assert.match(router.content.response, /Pay the rent first/);
  assert.ok(router.meta.model && router.meta.role, "which model, for which job");
  // What reached the person.
  assert.ok(trace.some((e) => e.kind === "say" && /Pay the rent first/.test(e.content.text)));
  // Every row carries the contract's fields.
  for (const e of trace) {
    assert.equal(e.app, "charles");
    assert.equal(e.v, 1);
    assert.equal(e.trace_id, turnId);
    assert.ok(e.kind && e.name && e.at && typeof e.seq === "number");
  }
});

test("no secret and no phone number is ever written, whatever the person or the model says", async () => {
  const biz = await planned("27809930112");
  await engine.handleInbound(textFrom("27809930112", `My key is ${process.env.OPENROUTER_API_KEY} and my ID is 8001015009087`));
  await track.flushTracking();
  const s = all();
  for (const secret of [process.env.OPENROUTER_API_KEY!, process.env.WHATSAPP_ACCESS_TOKEN!, process.env.SUPABASE_SERVICE_ROLE_KEY!, process.env.WORKER_SECRET!, "8001015009087", "27809930112", "27809930111"]) {
    assert.ok(!s.includes(secret), `written: ${secret.slice(0, 8)}…`);
  }
  assert.ok(rows().some((r) => r.business_id === biz.id && r.kind === "ask"), "the turn itself was still recorded");
});

test("capture changes nothing: the same turn gets the same reply with capture off and on", async () => {
  const reply = async (wa: string) => {
    await planned(wa);
    net.sent.length = 0;
    await engine.handleInbound(textFrom(wa, "What should I pay first this month?"));
    return net.sent.filter((m) => m.to === wa).map((m) => m.body).join("\n");
  };
  process.env.INTEL_CAPTURE = "off";
  const offReply = await reply("27809930113");
  process.env.INTEL_CAPTURE = "full";
  const onReply = await reply("27809930114");
  assert.equal(onReply, offReply);
});

test("a connector tool call and a job are recorded, and the job is linked from the turn that queued it", async () => {
  const biz = (await dbmod.findBusiness(WA))!;
  const connector = await import("../api/_lib/connector.ts");
  await track.withTrackContext({ channel: "mcp", businessId: biz.id, traceId: "r_tooltest" }, async () => {
    await connector.callTool(biz, "get_money_map", {});
    await dbmod.enqueue({ kind: "freshness", payload: {} });
  });
  await track.flushTracking();
  const t = await intel.readTrace("r_tooltest");
  const tool = t.find((e) => e.kind === "tool")!;
  assert.equal(tool.name, "get_money_map");
  assert.ok(tool.content.result, "what the tool returned");
  const queued = t.find((e) => e.name === "job_enqueued")!;
  assert.ok(queued.meta.job_id, "the queued job's id");
});

test("'forget my money' deletes everything captured about the person, written or still buffered", async () => {
  const biz = (await dbmod.findBusiness(WA))!;
  intel.capture("ask", { name: "still_buffered", businessId: biz.id, content: { text: "buffered words" } });
  await dbmod.forgetBusiness(biz.id);
  await track.flushTracking();
  const traces = new Set(rows().filter((r) => r.business_id === biz.id).map((r) => r.trace_id));
  assert.equal(traces.size, 0, "no row names them");
  assert.doesNotMatch(all(), /What should I pay first this month\?.*27809930111|buffered words/s);
});

test("export: every captured trace and every table that already held data, as JSON lines, redacted again", async () => {
  const biz = await planned("27809930115");
  await dbmod.recordMessage(biz.id, "in", `an old message with ${process.env.WORKER_SECRET}`);
  await engine.handleInbound(textFrom("27809930115", "What should I pay first this month?"));
  await track.flushTracking();
  const dir = mkdtempSync(join(tmpdir(), "intel-export-"));
  const report = await exp.exportIntel(dir);
  const files = readdirSync(dir);
  for (const f of ["traces.jsonl", "messages.jsonl", "plans.jsonl", "safety_events.jsonl", "events.jsonl", "manifest.json"]) assert.ok(files.includes(f), `${f} in ${files.join(",")}`);
  const traces = readFileSync(join(dir, "traces.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(traces.length && traces.every((t) => t.trace_id && Array.isArray(t.events) && t.events.length));
  const whole = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  assert.ok(!whole.includes(process.env.WORKER_SECRET!), "no secret in the export");
  assert.ok(report.tables.messages! >= 1 && report.traces >= 1);
});

test("the first message tells the truth about what is kept", async () => {
  const { CONSENT_LINE } = await import("../api/_lib/diagnostic.ts");
  assert.doesNotMatch(CONSENT_LINE, /Nobody else sees/i);
  assert.match(CONSENT_LINE, /conversations/);
  assert.match(CONSENT_LINE, /forget my money/);
});
