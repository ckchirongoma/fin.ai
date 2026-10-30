// Fin — the surfaces: what an owner sees of their own progress, and what a
// sponsor sees of the cohort.
//
// Two rules carry the file. An owner sees only their own business, and typed
// words never become markup. A sponsor sees only aggregates, only in groups big
// enough that no individual can be picked out, and only with a key that opens
// nothing else.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.SESSION_SECRET = "fake-session-secret";
process.env.WORKER_SECRET = "fake-worker-secret";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
process.env.PUBLIC_BASE_URL = "https://fin.test";
delete process.env.TYPESAFE_API_KEY;

import { installFakeNet, makeFakeDb, type FakeDb, type FakeNet } from "./_fakes.ts";

const OWNER = "27809930003";
const ADMIN = { Authorization: "Bearer fake-worker-secret" };

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let plan: typeof import("../api/plan.ts");
let sponsor: typeof import("../api/sponsor.ts");
let mcp: typeof import("../api/mcp.ts");
let build: typeof import("../api/_lib/engine/build.ts");
let crypto: typeof import("../api/_lib/crypto.ts");

before(async () => {
  net = installFakeNet();
  db = makeFakeDb({
    businesses: [
      {
        id: "biz-1", wa_id: OWNER, country: "ZA", stage: "plan_ready", biz_stage: "stretching",
        identity: { name: "<b>Thandi</b>", one_liner: "Braids" },
        context: { name: "<b>Thandi</b>", one_liner: "Braids" },
        map: [{ domain: "spending", status: "amber", note: "Deposits now taken" }, { domain: "debt", status: "red", note: "" }],
        map_first: [{ domain: "spending", status: "red", note: "Cash only" }, { domain: "debt", status: "red", note: "" }],
        baseline_tier: "low", current_plan_id: "plan-1", created_at: "2026-08-01T00:00:00Z",
        last_inbound_at: new Date().toISOString(), paused: false, deleted_at: null,
      },
      {
        id: "biz-2", wa_id: "27820000002", country: "ZA", stage: "plan_ready", biz_stage: "stretching",
        identity: { name: "Other Co" }, context: { name: "Other Co" }, map: [], baseline_tier: "high",
        current_plan_id: "plan-2", last_inbound_at: new Date().toISOString(), paused: false, deleted_at: null,
      },
    ],
    plans: [
      { id: "plan-1", business_id: "biz-1", goal: "Take deposits", headline: "Ninety days" },
      { id: "plan-2", business_id: "biz-2", goal: "Secret other goal", headline: "Other" },
    ],
    plan_steps: [
      { id: "s1", plan_id: "plan-1", workstream_title: "W", domain: "spending", step_order: 0, step_key: "a", title: "First step", push: "p", artifact: "", tool_id: null, why_for_you: "w", done_when: "d", status: "done" },
      { id: "s2", plan_id: "plan-1", workstream_title: "W", domain: "spending", step_order: 1, step_key: "b", title: "Second step", push: "p", artifact: "", tool_id: null, why_for_you: "w", done_when: "d", status: "open" },
      { id: "s3", plan_id: "plan-2", workstream_title: "W", domain: "debt", step_order: 0, step_key: "c", title: "Other owner step", push: "p", artifact: "", tool_id: null, why_for_you: "w", done_when: "d", status: "open" },
    ],
    tools: [],
    commitments: [
      { business_id: "biz-1", what: "Message five clients", due: null, status: "open", created_at: "2026-09-01T00:00:00Z" },
      { business_id: "biz-2", what: "SECRET-OTHER-COMMITMENT", due: null, status: "open", created_at: "2026-09-01T00:00:00Z" },
    ],
    outcomes: [{ business_id: "biz-1", what: "Took a deposit", effect: "better", created_at: "2026-09-10T00:00:00Z" }],
    business_map: [],
    safety_events: [],
    wa_templates: [],
    model_config: [],
  });
  const dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  plan = await import("../api/plan.ts");
  sponsor = await import("../api/sponsor.ts");
  mcp = await import("../api/mcp.ts");
  build = await import("../api/_lib/engine/build.ts");
  crypto = await import("../api/_lib/crypto.ts");
});

after(() => {
  restore?.();
  net?.restore();
});

// A session for the owner, made the way sign-in makes one.
async function ownerCookie(): Promise<string> {
  const token = crypto.mintToken();
  db.tables.plan_sessions = [
    ...(db.tables.plan_sessions ?? []),
    { token_hash: crypto.hashSecret(token), business_id: "biz-1", expires_at: new Date(Date.now() + 3600_000).toISOString() },
  ];
  return `fin_session=${token}`;
}

const dash = (cookie?: string) =>
  plan.GET(new Request("https://fin.test/api/plan?action=dashboard", { headers: cookie ? { cookie } : {} }));

const sp = (qs: string, headers: Record<string, string> = {}, method = "GET") =>
  sponsor.GET(new Request(`https://fin.test/api/sponsor${qs}`, { method, headers }));
const spPost = (qs: string, headers: Record<string, string> = {}) =>
  sponsor.POST(new Request(`https://fin.test/api/sponsor${qs}`, { method: "POST", headers }));

const rpc = (token: string, method: string, params: unknown = {}) =>
  mcp.POST(new Request("https://fin.test/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }));

// ── The owner's dashboard ────────────────────────────────────────

test("no session, no dashboard", async () => {
  assert.equal((await dash()).status, 401);
});

test("the dashboard shows progress, the map with where it started, and commitments", async () => {
  const res = await dash(await ownerCookie());
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.hasPlan, true);
  assert.deepEqual(d.progress, { done: 1, skipped: 0, total: 2, percent: 50, next_step: "Second step" });
  const gp = d.map.find((m: { domain: string }) => m.domain === "spending");
  assert.equal(gp.status, "amber");
  assert.equal(gp.was, "red", "movement is measured against the day-one map");
  assert.ok(gp.sorted_means.length > 0, "an area not yet green says what green means");
  assert.equal(d.commitments[0].what, "Message five clients");
  assert.equal(d.outcomes[0].effect, "better");
});

test("it is only ever the signed-in owner's business", async () => {
  const raw = JSON.stringify(await (await dash(await ownerCookie())).json());
  assert.doesNotMatch(raw, /SECRET-OTHER-COMMITMENT|Secret other goal|Other owner step|Other Co/);
});

test("the dashboard is JSON, so a business name with markup in it stays text", async () => {
  const res = await dash(await ownerCookie());
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.equal((await res.json()).business.name, "<b>Thandi</b>");
  const fs = await import("node:fs/promises");
  const plan = await fs.readFile(new URL("../public/plan.html", import.meta.url), "utf8");
  const drawing = plan.slice(plan.indexOf("function renderProgress"));
  assert.doesNotMatch(drawing, /innerHTML|insertAdjacentHTML/, "progress is drawn with textContent only");
  const sponsorPage = await fs.readFile(new URL("../public/sponsor.html", import.meta.url), "utf8");
  assert.doesNotMatch(sponsorPage, /innerHTML|insertAdjacentHTML/);
});

// ── Sponsor tokens ───────────────────────────────────────────────

test("only the operator can mint or revoke a sponsor token", async () => {
  assert.equal((await spPost("?action=mint&label=Acme")).status, 403);
  assert.equal((await sp("?action=mint&label=Acme", ADMIN)).status, 405, "minting is POST-only");
});

test("a token needs a label so it can be revoked by name", async () => {
  assert.equal((await spPost("?action=mint&label=%20", ADMIN)).status, 400);
});

let acme = "";
test("minting returns the token once and stores only its hash", async () => {
  const res = await spPost("?action=mint&label=Acme%20Foundation", ADMIN);
  assert.equal(res.status, 200);
  acme = (await res.json()).token;
  assert.match(acme, /^sp_/);
  const stored = db.tables.sponsor_tokens![0]!;
  assert.notEqual(stored.token_hash, acme);
  assert.doesNotMatch(JSON.stringify(db.tables.sponsor_tokens), new RegExp(acme));
});

test("a sponsor token reads the report, with small groups withheld", async () => {
  const res = await sp("", { Authorization: `Bearer ${acme}` });
  assert.equal(res.status, 200);
  const body = await res.json();
  // Two businesses is below the floor of five, so nothing numeric is released.
  assert.equal(body.suppressed, true);
  assert.equal(body.cohort.onboarded, "<5");
  assert.doesNotMatch(JSON.stringify(body), /biz-1|Thandi|27809930003/);
});

test("the operator still sees the full figures", async () => {
  const body = await (await sp("", ADMIN)).json();
  assert.equal(body.cohort.onboarded, 2);
});

test("a sponsor cannot download the CSV", async () => {
  assert.equal((await sp("?format=csv", { Authorization: `Bearer ${acme}` })).status, 403);
});

test("a sponsor token cannot mint more tokens", async () => {
  assert.equal((await spPost("?action=mint&label=Sneaky", { Authorization: `Bearer ${acme}` })).status, 403);
});

test("an owner's MCP address, or a made-up sp_ key, is not a sponsor key", async () => {
  assert.equal((await sp("", { Authorization: "Bearer sp_nonsense" })).status, 403);
  assert.equal((await sp("", { Authorization: "Bearer not-a-sponsor" })).status, 403);
});

// ── Sponsor over MCP ─────────────────────────────────────────────

test("a sponsor sees exactly one tool", async () => {
  const body = await (await rpc(acme, "tools/list")).json();
  assert.deepEqual(body.result.tools.map((t: { name: string }) => t.name), ["get_cohort_report"]);
});

test("the sponsor tool returns the suppressed report", async () => {
  const body = await (await rpc(acme, "tools/call", { name: "get_cohort_report", arguments: { days: 30 } })).json();
  assert.equal(body.result.isError, false);
  assert.equal(body.result.structuredContent.suppressed, true);
});

test("a sponsor cannot call an owner's tool", async () => {
  const res = await rpc(acme, "tools/call", { name: "get_plan", arguments: {} });
  const body = await res.json();
  assert.ok(body.error, "refused as an unknown tool");
});

test("an owner's connector address cannot reach the cohort tool", async () => {
  const ownerToken = crypto.mintToken();
  db.tables.connector_tokens = [{ token_hash: crypto.hashSecret(ownerToken), business_id: "biz-1", revoked_at: null }];
  const list = await (await rpc(ownerToken, "tools/list")).json();
  assert.ok(!list.result.tools.some((t: { name: string }) => t.name === "get_cohort_report"));
  const call = await (await rpc(ownerToken, "tools/call", { name: "get_cohort_report", arguments: {} })).json();
  assert.ok(call.error);
});

// ── Revocation ───────────────────────────────────────────────────

test("revoking by label shuts the token everywhere at once", async () => {
  const res = await spPost("?action=revoke&label=Acme%20Foundation", ADMIN);
  assert.equal((await res.json()).revoked, 1);
  assert.equal((await sp("", { Authorization: `Bearer ${acme}` })).status, 403);
  assert.equal((await rpc(acme, "tools/list")).status, 401);
});

// ── Enough businesses to release numbers ─────────────────────────

test("once a tier has five businesses its numbers are released; a smaller tier stays withheld", async () => {
  const fresh = await (await spPost("?action=mint&label=Big", ADMIN)).json();
  for (let i = 0; i < 6; i++) {
    db.tables.businesses!.push({
      id: `low-${i}`, wa_id: `2782111000${i}`, country: "ZA", stage: "plan_ready", biz_stage: "stretching",
      identity: {}, context: {}, map: [], baseline_tier: "low", current_plan_id: null,
      last_inbound_at: new Date().toISOString(), paused: false, deleted_at: null,
    });
  }
  const body = await (await sp("", { Authorization: `Bearer ${fresh.token}` })).json();
  assert.equal(body.suppressed, undefined);
  assert.ok(body.by_baseline_tier.low.businesses >= 5);
  assert.deepEqual(body.by_baseline_tier.high, { suppressed: true, businesses: "<5" }, "one high-tier business is still one person");
  assert.match(String(body.harm_monitoring), /Not enough businesses/);
});

// ── The starting point is recorded once ──────────────────────────

const M = (s: string) => [{ domain: "spending", status: s, note: "" }] as never;

test("the first plan records the starting tier and map", () => {
  const f = build.dayOneFields({ baseline_tier: null, map_first: null } as never, M("red"));
  assert.ok(f.baseline_tier);
  assert.deepEqual(f.map_first, M("red"));
});

test("a rebuild never replaces where the business started", () => {
  const start = build.dayOneFields({ baseline_tier: null, map_first: null } as never, M("red"));
  const later = build.dayOneFields(start as never, M("green"));
  assert.equal(later.baseline_tier, start.baseline_tier);
  assert.deepEqual(later.map_first, M("red"));
});

// ── Template sends ───────────────────────────────────────────────

test("a one-time-code template carries the code in the body AND the copy-code button", async () => {
  const wa = await import("../api/_lib/wa.ts");
  net.sent.length = 0;
  await wa.sendTemplate(OWNER, "fin_login_code", "en", ["482913"], "biz-1", { otp: true });
  const comps = net.sent[0]!.raw.template.components;
  assert.deepEqual(comps[0], { type: "body", parameters: [{ type: "text", text: "482913" }] });
  assert.deepEqual(comps[1], { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "482913" }] });
  const stored = db.tables.messages?.at(-1);
  assert.doesNotMatch(JSON.stringify(stored ?? {}), /482913/, "the code is not kept in the message log");
});

test("an ordinary template gets body parameters only", async () => {
  const wa = await import("../api/_lib/wa.ts");
  net.sent.length = 0;
  await wa.sendTemplate(OWNER, "fin_monday_focus", "en", ["Lerato", "pay the mashonisa on Friday"], "biz-1");
  assert.equal(net.sent[0]!.raw.template.components.length, 1);
  assert.equal(net.sent[0]!.raw.template.components[0].type, "body");
});
