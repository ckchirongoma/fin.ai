// Charles — retrieval, pass two: search by meaning.
//
// Pass one (retrieval.ts) is keyword scoring in plain code: free, predictable,
// and the default. It fails in one specific way — the person asks in words the
// library's keywords never anticipated ("people keep ghosting me after I quote"
// where the row says "no-shows and deposits"). For exactly that moment, and
// only that moment, this ranks the same rows by meaning.
//
// Three deliberate limits:
//   - It never replaces keywords. It runs only when keywords found NOTHING, so
//     nearly every message pays nothing for it.
//   - It never invents. It returns rows that already exist; the model is still
//     handed only those rows and still told they are the only facts it may use.
//   - It fails open. No key, a bad response, a wrong vector width: the caller
//     gets null and behaves exactly as it did before this file existed.

import { createHash } from "node:crypto";
import { db, recordModelUsage } from "./db.js";
import { env } from "./env.js";
import { EMBEDDING, noteModelCall } from "./models.js";

const EMBED_URL = "https://openrouter.ai/api/v1/embeddings";

/**
 * Below this cosine similarity a row is not a match, it is the nearest of a
 * bad lot. text-embedding-3-small puts an on-topic pair around 0.35-0.6 and an
 * unrelated one under 0.2; 0.30 sits in the gap. It is a constant on purpose:
 * retrieval_gaps.rescued shows how it behaves on real questions.
 */
export const SEMANTIC_MIN = 0.3;

interface Embeddable {
  id: string;
  embedding_hash?: string | null;
  embedding?: unknown;
  [k: string]: unknown;
}

const list = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : "");

/** What a knowledge row is embedded as: the words a person would recognise, not the whole record. */
export function knowledgeText(k: Record<string, unknown>): string {
  return [
    k.title,
    k.owner_summary,
    k.applies_when ? `Applies when: ${k.applies_when}` : "",
    k.not_when ? `Not when: ${k.not_when}` : "",
    list(k.keywords) ? `Topics: ${list(k.keywords)}` : "",
  ]
    .filter(Boolean)
    .join(". ");
}

export function toolText(t: Record<string, unknown>): string {
  return [
    t.name,
    t.why,
    t.fits ? `Fits: ${t.fits}` : "",
    t.not_when ? `Not when: ${t.not_when}` : "",
    list(t.keywords) ? `Topics: ${list(t.keywords)}` : "",
  ]
    .filter(Boolean)
    .join(". ");
}

const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 32);

const EMBED_TIMEOUT_MS = 8_000;

/** One request, many inputs. Null on any failure, including a vector of the wrong width. */
export async function embed(texts: string[]): Promise<number[][] | null> {
  if (!env.OPENROUTER_API_KEY || !texts.length) return null;
  const started = Date.now();
  const out = await embedOnce(texts);
  noteModelCall({ label: "embed", role: "embedding", model: out ? EMBEDDING.model : null, configured: EMBEDDING.model, fallback: false, tries: 1, ms: Date.now() - started, ok: Boolean(out) });
  return out;
}

async function embedOnce(texts: string[]): Promise<number[][] | null> {
  try {
    const res = await fetch(EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
      body: JSON.stringify({ model: EMBEDDING.model, input: texts.map((t) => t.slice(0, 6000)) }),
      // Bounded, because this is on the live answer path (the semantic
      // rescue in shortlist()) and it used to have no timeout at all. A
      // timeout lands in the catch below as null ("could not run"), which
      // every caller already handles.
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const json = (await res.json()) as {
      data?: { index?: number; embedding?: number[] }[];
      usage?: { prompt_tokens?: number; total_tokens?: number; cost?: number };
    };
    const rows = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = rows.map((r) => r.embedding ?? []);
    if (vectors.length !== texts.length || vectors.some((v) => v.length !== EMBEDDING.dims)) {
      console.warn(`embed: expected ${texts.length} vectors of ${EMBEDDING.dims}, got ${vectors.map((v) => v.length).join(",")}`);
      return null;
    }
    void recordModelUsage({
      role: "embedding",
      model: EMBEDDING.model,
      promptTokens: json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? 0,
      completionTokens: 0,
      cost: json.usage?.cost,
    });
    return vectors;
  } catch (err) {
    console.warn("embed failed", err);
    return null;
  }
}

export interface SemanticHit {
  id: string;
  similarity: number;
}

/** Rows ranked by meaning against one question, already cut at SEMANTIC_MIN. Null = could not run. */
export async function semanticRank(text: string, country: string): Promise<{ knowledge: SemanticHit[]; tools: SemanticHit[] } | null> {
  const vectors = await embed([text]);
  if (!vectors) return null;
  const query_embedding = vectors[0]!;
  try {
    const [k, t] = await Promise.all([
      db().rpc("match_knowledge", { query_embedding, match_country: country, match_count: 4 }),
      db().rpc("match_tools", { query_embedding, match_country: country, match_count: 4 }),
    ]);
    if (k.error || t.error) {
      console.warn("semanticRank rpc failed", k.error ?? t.error);
      return null;
    }
    const keep = (rows: unknown): SemanticHit[] =>
      ((rows as SemanticHit[]) ?? []).filter((r) => typeof r.similarity === "number" && r.similarity >= SEMANTIC_MIN);
    return { knowledge: keep(k.data), tools: keep(t.data) };
  } catch (err) {
    console.warn("semanticRank failed", err);
    return null;
  }
}

/**
 * Embeds every row that has no embedding yet, or whose text changed since it
 * was embedded (the hash). Adding a keyword to a row therefore re-embeds it on
 * the next sweep without anyone remembering to. Idempotent and cheap: the whole
 * library is roughly 30,000 tokens, a fraction of a cent.
 */
export async function fillMissingEmbeddings(): Promise<{ knowledge: number; tools: number; failed: number }> {
  const result = { knowledge: 0, tools: 0, failed: 0 };
  for (const [table, textOf, key] of [
    ["knowledge_entries", knowledgeText, "knowledge"],
    ["tools", toolText, "tools"],
  ] as const) {
    const { data, error } = await db().from(table).select("*");
    if (error || !data) {
      console.warn(`fillMissingEmbeddings: cannot read ${table}`, error);
      result.failed++;
      continue;
    }
    const stale = (data as Embeddable[])
      .map((r) => ({ r, text: textOf(r), hash: hashOf(textOf(r)) }))
      .filter((x) => x.text && (!x.r.embedding || x.r.embedding_hash !== x.hash));

    for (let i = 0; i < stale.length; i += 32) {
      const batch = stale.slice(i, i + 32);
      const vectors = await embed(batch.map((b) => b.text));
      if (!vectors) {
        result.failed += batch.length;
        continue;
      }
      for (let j = 0; j < batch.length; j++) {
        const { error: upErr } = await db()
          .from(table)
          .update({ embedding: vectors[j], embedding_hash: batch[j]!.hash })
          .eq("id", batch[j]!.r.id);
        if (upErr) result.failed++;
        else result[key]++;
      }
    }
  }
  return result;
}
