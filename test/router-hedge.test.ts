// Fin — the router is not left waiting on a call that decided to reason.
//
// Live tests, rounds 10 and 11: about one router call in three ignored
// `reasoning: { enabled: false }` and took 27-42s instead of ~3s. Whether a
// call reasons is chance, so a second identical request, sent once the
// first is clearly slow, usually lands in ~3s (qa.ts hedged).

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";

const { hedged, ROUTER_HEDGE_MS, ROUTER_GIVE_UP_MS } = await import("../api/_lib/engine/qa.ts");

const after = <T>(ms: number, v: T, fail = false) => new Promise<T>((res, rej) => setTimeout(() => (fail ? rej(new Error(String(v))) : res(v)), ms));

test("a fast first answer is used, and no second request is sent", async () => {
  let calls = 0;
  const v = await hedged(() => (calls++, after(10, "first")), 50, 500);
  assert.equal(v, "first");
  await after(80, null);
  assert.equal(calls, 1);
});

test("a slow first call: the second request goes out at the hedge point and its answer wins", async () => {
  let calls = 0;
  const started = Date.now();
  const v = await hedged(() => (++calls === 1 ? after(400, "slow reasoning call") : after(20, "second")), 50, 1000);
  assert.equal(v, "second");
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 200, "answered at ~hedge + second call, not at the slow call's pace");
});

test("a first call that fails at once is retried at once, not after the hedge wait", async () => {
  let calls = 0;
  const started = Date.now();
  const v = await hedged(() => (++calls === 1 ? after(5, "boom", true) : after(10, "ok")), 300, 1000);
  assert.equal(v, "ok");
  assert.ok(Date.now() - started < 150);
});

test("both failing, or neither answering in time, throws — and the router's caller falls back", async () => {
  await assert.rejects(hedged(() => after(5, "boom", true), 20, 500), /boom/);
  await assert.rejects(hedged(() => after(1000, "never"), 20, 100), /no answer in/);
});

test("one failure while the other is still running waits for the other", async () => {
  let calls = 0;
  const v = await hedged(() => (++calls === 1 ? after(150, "first, late") : after(10, "second fails", true)), 30, 1000);
  assert.equal(v, "first, late");
});

test("the production settings: hedge at 6s, give up at 20s", () => {
  assert.equal(ROUTER_HEDGE_MS, 6_000);
  assert.equal(ROUTER_GIVE_UP_MS, 20_000);
});

test("a router that gives no usable answer still lets the owner's own money words mark distress", async () => {
  const { installFakeNet, makeFakeDb } = await import("./_fakes.ts");
  const net = installFakeNet();
  const db = makeFakeDb({ model_config: [{ role: "router", provider: "openrouter", model: "test/router", fallbacks: [], params: {}, enabled: true }] });
  const dbmod = await import("../api/_lib/db.ts");
  const restore = dbmod.__setClient(db.client);
  (await import("../api/_lib/models.ts")).__clearModelCache();
  try {
    net.onModel(/Classify this message from a person to their money assistant/, () => "not json at all");
    const { route } = await import("../api/_lib/engine/qa.ts");
    const biz = await dbmod.createBusiness("27821250001", "ZA");
    const money = await route(biz as never, "I can't pay rent this month and the landlord wants to lock me out");
    assert.equal(money.intent, "distress");
    assert.deepEqual(money.risk, ["distress"]);
    const plain = await route(biz as never, "how do I get more customers");
    assert.equal(plain.intent, "question");
  } finally {
    restore();
    net.restore();
  }
});
