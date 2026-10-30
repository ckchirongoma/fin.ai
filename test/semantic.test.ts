// Charles — search by meaning, as the second pass under keywords.
//
// The properties that matter, in order: it never runs when keywords already
// found something (cost), it never returns a row below the similarity floor
// (invention), and it fails open to exactly the old behaviour (safety).

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";

import { installFakeNet, makeFakeDb, type FakeDb, type FakeNet } from "./_fakes.ts";

let db: FakeDb;
let net: FakeNet;
let restore: () => void;
let emb: typeof import("../api/_lib/embeddings.ts");
let retr: typeof import("../api/_lib/retrieval.ts");
let env: Record<string, string | undefined>;

const DIMS = 1536;
const unit = (i: number, j?: number, jw = 0): number[] => {
  const v = new Array(DIMS).fill(0);
  v[i] = 1 - jw;
  if (j !== undefined) v[j] = jw;
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  return v.map((x) => x / n);
};

// Three topics as three directions. "deposits" and "pricing" are the two rows
// worth finding; "payments" is unrelated to either question.
const topicOf = (text: string): number =>
  /deposit|no-show|no show|ghost/i.test(text) ? 0 : /pric|quote|cost/i.test(text) ? 1 : 2;
const embedder = (text: string): number[] => {
  // The owner's question is about being ghosted after sending an estimate: mostly the
  // deposits direction, a little of pricing — nowhere near "payments".
  if (/ghosting/i.test(text)) return unit(0, 1, 0.3);
  return unit(topicOf(text));
};

const KNOWLEDGE = [
  { id: "k.deposits", country: "ZA", domain: "spending", stages: ["run"], title: "Take a deposit", owner_summary: "Ask for a deposit so no-shows cost you nothing.", applies_when: "people book and don't arrive", not_when: "", steps: [], cost: "free", keywords: ["deposit", "no-show", "no show"], verified_on: "2026-09-01", embedding: null, embedding_hash: null },
  { id: "k.pricing", country: "ZA", domain: "debt", stages: ["run"], title: "Price it properly", owner_summary: "Work out your real cost before you quote.", applies_when: "you're guessing prices", not_when: "", steps: [], cost: "free", keywords: ["pricing", "quote"], verified_on: "2026-09-01", embedding: null, embedding_hash: null },
  { id: "k.cards", country: "ZA", domain: "spending", stages: ["run"], title: "Take card payments", owner_summary: "A card machine so nobody says 'I'll EFT you'.", applies_when: "cash only", not_when: "", steps: [], cost: "from R699", keywords: ["card machine"], verified_on: "2026-09-01", embedding: null, embedding_hash: null },
];

before(async () => {
  net = installFakeNet();
  db = makeFakeDb({ knowledge_entries: KNOWLEDGE, tools: [] });
  const dbmod = await import("../api/_lib/db.ts");
  restore = dbmod.__setClient(db.client);
  env = (await import("../api/_lib/env.ts")).env as unknown as Record<string, string | undefined>;
  emb = await import("../api/_lib/embeddings.ts");
  retr = await import("../api/_lib/retrieval.ts");
});

after(() => {
  restore?.();
  net?.restore();
});

let embedCalls = 0;
beforeEach(() => {
  env.OPENROUTER_API_KEY = "fake-openrouter-key";
  db.tables.retrieval_gaps!.length = 0;
  embedCalls = 0;
  net.embed = (t) => {
    embedCalls++;
    return embedder(t);
  };
});

const rows = () => db.tables.knowledge_entries! as never;

// ── What gets embedded ───────────────────────────────────────────

test("a row is embedded as the words an owner would recognise, keywords included", () => {
  const t = emb.knowledgeText(KNOWLEDGE[0]!);
  assert.match(t, /Take a deposit/);
  assert.match(t, /no-shows cost you nothing/);
  assert.match(t, /Applies when: people book and don't arrive/);
  assert.match(t, /Topics: deposit, no-show, no show/);
});

// ── The embedding call ───────────────────────────────────────────

test("no key means no embedding and no crash", async () => {
  env.OPENROUTER_API_KEY = "";
  assert.equal(await emb.embed(["anything"]), null);
});

test("a vector of the wrong width is refused, not stored", async () => {
  net.embed = () => [0.1, 0.2, 0.3];
  assert.equal(await emb.embed(["anything"]), null);
});

test("vectors come back in the order the inputs went in", async () => {
  const v = await emb.embed(["deposit", "pricing"]);
  assert.equal(v!.length, 2);
  assert.equal(v![0]![0], 1);
  assert.equal(v![1]![1], 1);
});

// ── Filling the library ──────────────────────────────────────────

test("every row without an embedding is embedded, with a hash of the text it was embedded from", async () => {
  const r = await emb.fillMissingEmbeddings();
  assert.equal(r.knowledge, 3);
  assert.equal(r.failed, 0);
  for (const row of db.tables.knowledge_entries!) {
    assert.equal(row.embedding.length, DIMS);
    assert.equal(row.embedding_hash.length, 32);
  }
});

test("running it again changes nothing and costs nothing", async () => {
  embedCalls = 0;
  const r = await emb.fillMissingEmbeddings();
  assert.equal(r.knowledge, 0);
  assert.equal(embedCalls, 0);
});

test("a row whose keywords were edited is re-embedded on the next sweep", async () => {
  const row = db.tables.knowledge_entries!.find((r) => r.id === "k.cards")!;
  const before = row.embedding_hash;
  row.keywords = [...row.keywords, "tap to pay", "yoco"];
  const r = await emb.fillMissingEmbeddings();
  assert.equal(r.knowledge, 1, "only the edited row");
  assert.notEqual(row.embedding_hash, before);
});

test("if the embedding service is down, the sweep reports failures and stores nothing wrong", async () => {
  db.tables.knowledge_entries!.push({ ...KNOWLEDGE[0]!, id: "k.new", embedding: null, embedding_hash: null });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/embeddings")) return new Response("down", { status: 503 });
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const r = await emb.fillMissingEmbeddings();
    assert.equal(r.knowledge, 0);
    assert.ok(r.failed >= 1);
    assert.equal(db.tables.knowledge_entries!.find((x) => x.id === "k.new")!.embedding, null);
  } finally {
    globalThis.fetch = realFetch;
    db.tables.knowledge_entries!.pop();
  }
});

// ── Retrieval: the second pass ───────────────────────────────────

// No word in this question is a keyword on any row, so keywords score zero.
const GHOSTED = "clients keep ghosting me after I send my estimate and then vanish";

const ask = (text: string, extra: object = {}) =>
  retr.shortlist(rows(), [] as never, { text, stage: "run", ...extra }, { country: "ZA", businessId: null });

test("keywords found nothing, meaning finds the deposits row — the point of the whole thing", async () => {
  const s = await ask(GHOSTED);
  assert.equal(s.semantic, true);
  assert.equal(s.knowledge[0]!.id, "k.deposits");
});

test("the unrelated row is not returned just because it is the nearest of a bad lot", async () => {
  const s = await ask(GHOSTED);
  assert.ok(!s.knowledge.some((k) => k.id === "k.cards"), "payments is nothing like this question");
});

test("a rescued question is still logged, marked rescued — that is the keywords to-do list", async () => {
  await ask(GHOSTED);
  const gap = db.tables.retrieval_gaps![0]!;
  assert.equal(gap.rescued, true);
  assert.equal(gap.top_score, 0);
});

test("when keywords DO match, meaning is never asked — no call, no cost", async () => {
  embedCalls = 0;
  const s = await ask("do I need a deposit for bookings");
  assert.equal(embedCalls, 0);
  assert.equal(s.semantic, undefined);
  assert.ok(s.topScore > 0);
});

test("nothing close by meaning either: a real gap, logged as not rescued", async () => {
  net.embed = () => unit(5); // no row in the library sits in this direction
  const s = await ask("what is the weather like in Durban this weekend");
  assert.equal(s.semantic, undefined);
  assert.equal(db.tables.retrieval_gaps![0]!.rescued, false);
});

test("a pinned row still leads, even on a rescued shortlist", async () => {
  const s = await ask(GHOSTED, { pinKnowledge: ["k.pricing"] });
  assert.equal(s.knowledge[0]!.id, "k.pricing");
  assert.ok(s.knowledge.some((k) => k.id === "k.deposits"));
});

test("no key: exactly the old behaviour, nothing thrown", async () => {
  env.OPENROUTER_API_KEY = "";
  const s = await ask(GHOSTED);
  assert.equal(s.semantic, undefined);
  assert.equal(s.topScore, 0);
  assert.ok(s.knowledge.length > 0, "the keyword shortlist is still returned as before");
});

test("a failing vector lookup falls back to the old behaviour", async () => {
  const client = db.client as unknown as { rpc: (...a: unknown[]) => Promise<unknown> };
  const realRpc = client.rpc;
  client.rpc = async () => ({ data: null, error: { message: "function does not exist" } });
  try {
    const s = await ask(GHOSTED);
    assert.equal(s.semantic, undefined);
  } finally {
    client.rpc = realRpc;
  }
});
