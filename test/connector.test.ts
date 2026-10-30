// Fin — the MCP connector's get_plan, and PRIORITY 5.1's guard.
//
// PR #22 (track1) built engine/artifact.ts's checkArtifact() as the single
// choke point that stops an unfilled "[Name]"/"[Link to Google profile]"
// placeholder reaching a phone — but its own body flagged explicitly that
// connector.ts was never touched, and get_plan handed `s.artifact` straight
// back raw. Live-verified elsewhere in the same incident: an MCP session's
// get_plan returns data identical to what WhatsApp sent, so the exact same
// fabricated/unfilled content reaches the owner's own connected AI too, just
// through a different door. This is that guard, closed.

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

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let mcp: typeof import("../api/mcp.ts");
let crypto: typeof import("../api/_lib/crypto.ts");

before(async () => {
  net = installFakeNet();
  db = makeFakeDb({
    businesses: [
      {
        id: "biz-1",
        wa_id: "27821110000",
        country: "ZA",
        stage: "plan_ready",
        biz_stage: "stretching",
        context: { name: "Thandi", location: "Woodstock, Cape Town" },
        current_plan_id: "plan-1",
        paused: false,
        deleted_at: null,
      },
    ],
    plans: [{ id: "plan-1", business_id: "biz-1", goal: "Sign three property managers to monthly retainers.", headline: "Ninety days" }],
    plan_steps: [
      {
        id: "s1",
        plan_id: "plan-1",
        workstream_title: "Be findable by people who don't know you",
        domain: "credit_record",
        step_order: 0,
        step_key: "f1",
        title: "Ask for a review",
        push: "Ask five regulars for a review.",
        artifact: "Hi [Name], thanks for choosing Thandi — could you leave us a review? [Link to Google profile]",
        tool_id: null,
        why_for_you: "w",
        done_when: "d",
        status: "open",
      },
    ],
    model_config: [],
  });
  const dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  mcp = await import("../api/mcp.ts");
  crypto = await import("../api/_lib/crypto.ts");
});

after(() => {
  restore?.();
  net?.restore();
});

const rpc = (token: string, method: string, params: unknown = {}) =>
  mcp.POST(
    new Request("https://fin.test/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );

function ownerToken(): string {
  const token = crypto.mintToken();
  db.tables.connector_tokens = [{ token_hash: crypto.hashSecret(token), business_id: "biz-1", revoked_at: null }];
  return token;
}

test("get_plan never hands the owner's connected AI a step artifact with an unresolved placeholder as if it were ready", async () => {
  const res = await rpc(ownerToken(), "tools/call", { name: "get_plan", arguments: {} });
  const body = await res.json();
  const raw = JSON.stringify(body);

  assert.match(raw, /Fill in the parts? in \[brackets\]/i, "the message, marked as the owner's to fill — the same thing the WhatsApp path sends");
});

test("get_plan fills a placeholder Fin actually knows, same as every other artifact-touching path", async () => {
  db.tables.plan_steps![0]!.artifact = "Thanks for choosing [Your Name]! See you soon.";

  const res = await rpc(ownerToken(), "tools/call", { name: "get_plan", arguments: {} });
  const raw = JSON.stringify(await res.json());

  assert.match(raw, /Thanks for choosing Thandi! See you soon\./);
  assert.doesNotMatch(raw, /\[Your Name\]/);
});

test("a step with no artifact at all still comes through as null, not a stray guard message", async () => {
  db.tables.plan_steps![0]!.artifact = null;

  const res = await rpc(ownerToken(), "tools/call", { name: "get_plan", arguments: {} });
  const body = await res.json();
  const step = body.result.structuredContent.steps[0];

  assert.equal(step.artifact, null);
});
