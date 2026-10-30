// Charles — the connector, against both MCP protocol eras.
//
// This matters because the two eras are live at the same time and a server that
// speaks only one fails to connect to half its clients: Anthropic's hosted
// connector and recent Claude Code send the 2026-07-28 protocol and require
// `server/discover`, while the MCP Inspector and plenty of SDK-based clients
// still send the older `initialize` handshake. The published TypeScript SDK
// only speaks the older one, which is why this is hand-rolled.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.SESSION_SECRET = "fake-session-secret";
process.env.PUBLIC_BASE_URL = "https://charles.test";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1";

import { installFakeNet, makeFakeDb, type FakeDb, type FakeNet } from "./_fakes.ts";

const MODERN = "2026-07-28";
let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let mcp: typeof import("../api/mcp.ts");
let token: string;
let businessId: string;

const call = (body: unknown, headers: Record<string, string> = {}, url = "https://charles.test/api/mcp") =>
  mcp.POST(new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }));

const authed = (body: unknown, headers: Record<string, string> = {}) => call(body, { Authorization: `Bearer ${token}`, ...headers });

const modernMeta = { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientInfo": { name: "Test", version: "1" } } };

before(async () => {
  net = installFakeNet();
  db = makeFakeDb({
    businesses: [{
      id: "biz-1", wa_id: "27809930003", country: "ZA", stage: "plan_ready", biz_stage: "surviving",
      identity: { name: "Thandi", earns: "a salon wage", one_liner: "A salon wage in Woodstock, a mashonisa on it" },
      context: { name: "Thandi", earns: "a salon wage", goal: "Out of the mashonisa's book", one_liner: "A salon wage in Woodstock, a mashonisa on it" },
      goal: [{ label: "Out of the mashonisa's book" }], rule: [{ label: "Payday first", rule: "Payday first" }], map: [],
      deleted_at: null,
    }],
    business_map: [{ business_id: "biz-1", domain: "debt", status: "red", note: "A mashonisa at R200 a week" }],
    knowledge_entries: [{ id: "k.mashonisa_law", country: "ZA", domain: "debt", stages: ["surviving"], keywords: ["mashonisa", "loan shark", "card"], title: "What a mashonisa may not do", owner_summary: "An unregistered lender cannot keep your card or ID.", applies_when: "a mashonisa holds your card", not_when: "a registered lender", steps: ["Ask for the card back"], cost: "Free", verified_on: "2026-10-30" }],
    tools: [{ id: "ncr_complaint", country: "ZA", domain: "debt", stages: ["surviving"], keywords: ["mashonisa", "loan shark", "complaint", "card"], name: "NCR consumer line", fits: "any lender dispute", not_when: "a bank dispute", why: "The regulator, free", cost: "Free", url: "https://www.ncr.org.za", setup: "Call 0860 627 627", walkthrough: ["Call the line"], verified_on: "2026-10-30" }],
  });
  businessId = "biz-1";
  const dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);

  const connector = await import("../api/_lib/connector.ts");
  const url = await connector.issueConnectorToken(businessId);
  assert.ok(url, "a connector address was issued");
  token = url!.split("/").pop()!;

  mcp = await import("../api/mcp.ts");
});

after(() => {
  restore?.();
  net?.restore();
});

test("GET and DELETE are refused with 405 and say what is allowed", async () => {
  for (const method of ["GET", "DELETE"] as const) {
    const res = await mcp[method](new Request("https://charles.test/api/mcp", { method }));
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("Allow"), "POST, OPTIONS");
  }
});

test("no token is a 401 that tells the person how to get one", async () => {
  const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("WWW-Authenticate") ?? "", /Bearer/);
  assert.match((await res.json()).message, /connect/i);
});

test("a revoked or unknown token is a 401, not a silent empty result", async () => {
  const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { Authorization: "Bearer not-a-real-token" });
  assert.equal(res.status, 401);
});

test("the token also works in the URL, which is what most hosts actually accept", async () => {
  const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {}, `https://charles.test/api/mcp?k=${token}`);
  assert.equal(res.status, 200);
  assert.ok((await res.json()).result.tools.length > 0);
});

test("legacy clients get the initialize handshake they expect", async () => {
  const res = await authed({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Inspector", version: "1" } } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.result.protocolVersion, "2025-06-18", "a supported version is echoed back unchanged");
  // Advertising capabilities we do not implement makes clients call them and
  // fail. Resources are implemented since round 28: the person's view.
  assert.deepEqual(Object.keys(body.result.capabilities), ["tools", "resources"]);
  assert.ok(body.result.instructions.includes("Charles"));
  assert.equal(body.result.resultType, undefined, "resultType is a modern-era field and must not leak into a legacy reply");
});

test("an unknown legacy protocol version falls back rather than refusing", async () => {
  const res = await authed({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal((await res.json()).result.protocolVersion, "2025-06-18");
});

test("notifications get 202 and no body", async () => {
  const res = await authed({ jsonrpc: "2.0", method: "notifications/initialized" });
  // Returning 200 with a JSON body here is the single most common handshake bug.
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "");
});

test("modern clients get server/discover, with this person's view marked private", async () => {
  const res = await authed({ jsonrpc: "2.0", id: "d1", method: "server/discover", params: { ...modernMeta } }, { "MCP-Protocol-Version": MODERN });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.result.supportedVersions.includes(MODERN));
  assert.equal(body.result.resultType, "complete");
  assert.equal(body.result.cacheScope, "private", "one person's money must never be cached by a shared intermediary");
  assert.ok(body.result._meta["io.modelcontextprotocol/serverInfo"].name);
});

test("a protocol version we do not speak is a 400 with a readable error, never an empty body", async () => {
  const res = await authed(
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } },
    { "MCP-Protocol-Version": "1900-01-01" },
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, -32022);
  // A bare 400 would push a dual-era client back into a legacy handshake.
  assert.ok(Array.isArray(body.error.data.supported));
});

test("a header that disagrees with the declared version is rejected as a mismatch", async () => {
  const res = await authed({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { ...modernMeta } }, { "MCP-Protocol-Version": "2025-06-18" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, -32020);
});

test("tools/list is deterministic and every tool has an object schema", async () => {
  const res = await authed({ jsonrpc: "2.0", id: 4, method: "tools/list" });
  const tools = (await res.json()).result.tools;
  assert.deepEqual([...tools].map((t: any) => t.name), [...tools].map((t: any) => t.name).sort());
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object", `${t.name} must have an object root schema`);
    assert.ok(t.description.length > 40, `${t.name} needs a description the model can act on`);
  }
  const names = tools.map((t: any) => t.name);
  for (const required of ["get_household_context", "get_money_map", "find_knowledge", "log_decision", "add_commitment", "propose_change"]) {
    assert.ok(names.includes(required), `missing ${required}`);
  }
});

test("get_household_context returns the household and the house rules", async () => {
  const res = await authed({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_household_context", arguments: {} } });
  const body = await res.json();
  assert.equal(body.result.isError, false);
  assert.match(body.result.content[0].text, /Thandi/);
  assert.match(body.result.structuredContent.instructions, /one recommended next step/i);
  // Structured content is mirrored as text for clients that only read content.
  assert.ok(body.result.content[0].text.includes("Thandi"));
});

test("find_knowledge returns grounded facts with their verification dates", async () => {
  const res = await authed({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "find_knowledge", arguments: { query: "the mashonisa is holding my card, can he do that" } } });
  const s = (await res.json()).result.structuredContent;
  assert.equal(s.tools[0].id, "ncr_complaint");
  assert.ok(s.tools[0].verified_on);
  assert.match(s.note, /only these facts/i);
});

test("find_knowledge says so when nothing matched, instead of inviting a guess", async () => {
  const res = await authed({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "find_knowledge", arguments: { query: "aircraft maintenance certification" } } });
  assert.match((await res.json()).result.structuredContent.note, /Nothing in the library matched/i);
});

test("log_decision and add_commitment write through to what WhatsApp reads", async () => {
  await authed({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "log_decision", arguments: { what: "Pay the mashonisa every Friday", why: "Payday first" } } });
  await authed({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "add_commitment", arguments: { what: "Set up SnapScan", due: "2026-10-01" } } });

  assert.equal(db.tables.decisions!.at(-1)!.source, "connector");
  const c = db.tables.commitments!.at(-1)!;
  assert.equal(c.what, "Set up SnapScan");
  assert.equal(c.due, "2026-10-01");
  assert.equal(c.status, "open");
});

test("propose_change never edits the plan — it asks the person on WhatsApp", async () => {
  net.sent.length = 0;
  const before = { ...db.tables.businesses![0]!.context };

  const res = await authed({
    jsonrpc: "2.0", id: 10, method: "tools/call",
    params: { name: "propose_change", arguments: { fact: "earns", to: "a salon wage and a weekend piece job", reason: "They mentioned a Saturday job that is now half the income" } },
  });

  const body = await res.json();
  assert.match(body.result.content[0].text, /Nothing has changed yet/i);
  assert.deepEqual(db.tables.businesses![0]!.context, before, "the plan must not move on a connector's say-so");

  const pending = db.tables.proposed_changes!.at(-1)!;
  assert.equal(pending.status, "pending");
  assert.equal(db.tables.businesses![0]!.stage, "confirm_change");

  const buttons = net.sent.flatMap((m) => m.buttons).map((b) => b.id);
  assert.deepEqual(buttons, ["a.chg.yes", "a.chg.no"]);
  assert.match(net.sent.map((m) => m.body).join(" "), /Your AI suggested/i);
});

test("propose_change refuses a fact that is not critical", async () => {
  const res = await authed({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "propose_change", arguments: { fact: "favourite_colour", to: "green", reason: "why not" } } });
  assert.equal((await res.json()).result.isError, true);
});

test("an unknown tool is a protocol error, and 404 for a modern client", async () => {
  const legacy = await authed({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "delete_everything", arguments: {} } });
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json()).error.code, -32602);

  const modern = await authed({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "delete_everything", arguments: {}, ...modernMeta } }, { "MCP-Protocol-Version": MODERN });
  assert.equal(modern.status, 404);
});

test("an unknown method is -32601, 404 under the modern era", async () => {
  const modern = await authed({ jsonrpc: "2.0", id: 14, method: "resources/subscribe", params: { ...modernMeta } }, { "MCP-Protocol-Version": MODERN });
  assert.equal(modern.status, 404);
  assert.equal((await modern.json()).error.code, -32601);
});

test("a malformed body is a parse error, not a crash", async () => {
  const res = await mcp.POST(new Request(`https://charles.test/api/mcp?k=${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, -32700);
});

// "Send 'connect' again any time for a fresh one" has to be true: the person
// replacing an address they think leaked must switch the old one off.
test("a fresh address switches the old one off, and the new one works", async () => {
  const before = await authed({ jsonrpc: "2.0", id: 90, method: "tools/list", params: {} });
  assert.equal(before.status, 200, "the current address works");
  const connector = await import("../api/_lib/connector.ts");
  const fresh = (await connector.issueConnectorToken(businessId))!.split("/").pop()!;
  const old = await authed({ jsonrpc: "2.0", id: 91, method: "tools/list", params: {} });
  assert.equal(old.status, 401, "the replaced address no longer reads the household");
  token = fresh;
  const now = await authed({ jsonrpc: "2.0", id: 92, method: "tools/list", params: {} });
  assert.equal(now.status, 200);
  assert.equal(db.tables.connector_tokens!.filter((r) => r.business_id === businessId && !r.revoked_at).length, 1);
});

// Review, 2026-09-24: the hand-over and plan document are read by people who
// are ALREADY connected. "connect" must not switch their working address off
// unless they choose to replace it.
test("a connected owner who sends 'connect' keeps their address unless they choose a new one", async () => {
  const { tapFrom, textFrom } = await import("./_fakes.ts");
  const engine = await import("../api/_lib/engine/index.ts");
  const working = token;
  net.sent.length = 0;
  await engine.handleInbound(textFrom("27809930003", "connect"));
  assert.equal((await authed({ jsonrpc: "2.0", id: 93, method: "tools/list", params: {} })).status, 200, "still working after 'connect'");
  const choice = net.sent.find((m) => m.buttons.some((b) => b.id === "a.connect.new"))!;
  assert.ok(choice, "offered a choice");
  assert.deepEqual(choice.buttons.map((b) => b.title), ["Keep mine", "New address"]);
  assert.ok(!net.sent.some((m) => /\/mcp\//.test(m.body)), "no new address issued yet");

  await engine.handleInbound(tapFrom("27809930003", "a.connect.keep", "Keep mine"));
  assert.equal((await authed({ jsonrpc: "2.0", id: 94, method: "tools/list", params: {} })).status, 200, "kept");

  net.sent.length = 0;
  await engine.handleInbound(tapFrom("27809930003", "a.connect.new", "New address"));
  const msg = net.sent.find((m) => /Your new private address:/.test(m.body))!;
  assert.match(msg.body, /Your old address has stopped working/);
  token = msg.body.match(/\/mcp\/([A-Za-z0-9_-]+)/)![1]!;
  assert.notEqual(token, working);
  assert.equal((await call({ jsonrpc: "2.0", id: 95, method: "tools/list", params: {} }, { Authorization: `Bearer ${working}` })).status, 401, "the replaced one is off");
  assert.equal((await authed({ jsonrpc: "2.0", id: 96, method: "tools/list", params: {} })).status, 200, "the new one works");
});

test("'Keep mine' never claims a connection that isn't there", async () => {
  const { tapFrom } = await import("./_fakes.ts");
  const engine = await import("../api/_lib/engine/index.ts");
  for (const r of db.tables.connector_tokens!) r.revoked_at = new Date().toISOString();
  net.sent.length = 0;
  await engine.handleInbound(tapFrom("27809930003", "a.connect.keep", "Keep mine"));
  const all = net.sent.map((m) => m.body).join("\n---\n");
  assert.doesNotMatch(all, /Your AI stays connected/);
  assert.match(all, /You don't have a working address right now/);
  assert.match(all, /Your private address:/);
  token = all.match(/\/mcp\/([A-Za-z0-9_-]+)/)![1]!;
  assert.equal((await authed({ jsonrpc: "2.0", id: 97, method: "tools/list", params: {} })).status, 200);
});
