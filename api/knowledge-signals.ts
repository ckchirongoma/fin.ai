// Charles — what real conversations say the library is missing or has wrong.
//
// The read side of db/0015: unreviewed knowledge signals, grouped by the
// tool or knowledge entry they are about, so a person — or the agent running
// docs/PROMOTION-PASS.md — can see what has accumulated without querying the
// database by hand. Operator-only: SIGNALS_ADMIN_SECRET (a secret that opens
// this endpoint and nothing else — give THIS one to an agent) or
// WORKER_SECRET. Not CRON_SECRET: a scheduler has no business reading people'
// own words.
//
//   GET  /api/knowledge-signals?status=new&days=90&limit=500
//   POST /api/knowledge-signals?action=review
//        {"ids":[1,2],"status":"promoted"|"rejected"|"reviewed","notes":"…","reviewed_by":"…"}
//
// Nothing here changes `tools` or `knowledge_entries`. Promotion is a
// research pass with a cited source, done by an agent, never by this code.

import { timingSafeEqual } from "node:crypto";
import { env } from "./_lib/env.js";
import { listKnowledgeSignals, reviewKnowledgeSignals, type KnowledgeSignalRow } from "./_lib/db.js";
import { noteRequestFailure, tracked } from "./_lib/track.js";

function allowed(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const secrets = [env.SIGNALS_ADMIN_SECRET, env.WORKER_SECRET].filter(Boolean);
  return secrets.some((s) => {
    const a = Buffer.from(header, "utf8");
    const b = Buffer.from(`Bearer ${s}`, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/** The kinds of signal that count as an independent owner reporting something about the library. */
const REPORTS = new Set(["correction", "outcome_report", "unanswered_question"]);

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const STATUSES = ["new", "reviewed", "promoted", "rejected"] as const;

export interface SignalGroup {
  entity_type: string | null;
  entity_id: string | null;
  signals: number;
  /**
   * Independent people REPORTING something about this row — corrections,
   * outcome reports and unanswered questions only. A connected AI logging a
   * decision that mentions a tool is context, not corroboration. This is the
   * number the promotion pass cares about most, and the sort key.
   */
  distinct_businesses: number;
  /** Every business with any signal here, reports or not. */
  distinct_businesses_any: number;
  by_type: Record<string, number>;
  by_source: Record<string, number>;
  countries: string[];
  first_at: string;
  last_at: string;
  rows: Pick<KnowledgeSignalRow, "id" | "created_at" | "source" | "signal_type" | "country" | "raw_quote" | "candidate_claim">[];
}

/** Grouped by entity; the groups most independently corroborated come first. */
export function groupSignals(rows: KnowledgeSignalRow[]): SignalGroup[] {
  const groups = new Map<string, { g: SignalGroup; people: Set<string>; anyOwner: Set<string> }>();
  for (const r of rows) {
    const key = `${r.related_entity_type ?? ""}:${r.related_entity_id ?? ""}`;
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        g: { entity_type: r.related_entity_type, entity_id: r.related_entity_id, signals: 0, distinct_businesses: 0, distinct_businesses_any: 0, by_type: {}, by_source: {}, countries: [], first_at: r.created_at, last_at: r.created_at, rows: [] },
        people: new Set(),
        anyOwner: new Set(),
      };
      groups.set(key, entry);
    }
    const g = entry.g;
    g.signals++;
    if (r.business_id) {
      entry.anyOwner.add(r.business_id);
      if (REPORTS.has(r.signal_type)) entry.people.add(r.business_id);
    }
    g.by_type[r.signal_type] = (g.by_type[r.signal_type] ?? 0) + 1;
    g.by_source[r.source] = (g.by_source[r.source] ?? 0) + 1;
    if (r.country && !g.countries.includes(r.country)) g.countries.push(r.country);
    if (r.created_at < g.first_at) g.first_at = r.created_at;
    if (r.created_at > g.last_at) g.last_at = r.created_at;
    g.rows.push({ id: r.id, created_at: r.created_at, source: r.source, signal_type: r.signal_type, country: r.country, raw_quote: r.raw_quote, candidate_claim: r.candidate_claim });
  }
  return [...groups.values()]
    .map(({ g, people, anyOwner }) => ({ ...g, distinct_businesses: people.size, distinct_businesses_any: anyOwner.size }))
    .sort((a, b) => b.distinct_businesses - a.distinct_businesses || b.signals - a.signals || (a.entity_id ?? "~").localeCompare(b.entity_id ?? "~"));
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (!allowed(req)) return new Response("Forbidden", { status: 403 });
  const url = new URL(req.url);

  try {
    if (url.searchParams.get("action") === "review") {
      if (req.method !== "POST") return new Response("Use POST", { status: 405 });
      let body: { ids?: unknown; status?: unknown; notes?: unknown; reviewed_by?: unknown };
      try {
        body = await req.json();
      } catch {
        return jsonRes({ error: "Body must be JSON." }, 400);
      }
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500) : [];
      const status = String(body.status ?? "");
      const notes = String(body.notes ?? "").trim().slice(0, 1000);
      const reviewedBy = String(body.reviewed_by ?? "").trim().slice(0, 100);
      if (!ids.length) return jsonRes({ error: "ids: a non-empty list of signal ids." }, 400);
      if (!["reviewed", "promoted", "rejected"].includes(status)) return jsonRes({ error: "status: reviewed, promoted or rejected." }, 400);
      // A decision with no reason is exactly how the same anecdote comes back next month.
      if (!notes) return jsonRes({ error: "notes: say why — the source for a promotion, the reason for a rejection." }, 400);
      if (!reviewedBy) return jsonRes({ error: "reviewed_by: who made the call." }, 400);
      const updated = await reviewKnowledgeSignals(ids, { status: status as "reviewed" | "promoted" | "rejected", notes, reviewedBy });
      return jsonRes({ updated });
    }

    if (req.method !== "GET") return new Response("Use GET", { status: 405 });
    const status = url.searchParams.get("status") ?? "new";
    if (!(STATUSES as readonly string[]).includes(status)) return jsonRes({ error: `status: one of ${STATUSES.join(", ")}` }, 400);
    const days = Math.min(365, Math.max(1, Math.floor(Number(url.searchParams.get("days") ?? 90)) || 90));
    const limit = Math.min(2000, Math.max(1, Math.floor(Number(url.searchParams.get("limit") ?? 500)) || 500));
    const rows = await listKnowledgeSignals({ status, sinceDays: days, limit });
    return jsonRes({ status, days, total: rows.length, truncated: rows.length === limit, groups: groupSignals(rows) });
  } catch (err) {
    console.log("knowledge-signals failed", err);
    noteRequestFailure(err);
    return jsonRes({ error: (err as Error).message }, 500);
  }
}

const served = tracked("knowledge-signals", "system", handler);
export const GET = served;
export const POST = served;
export const OPTIONS = served;
