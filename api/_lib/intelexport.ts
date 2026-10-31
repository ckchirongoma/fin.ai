// Chase Intelligence — the export (docs/INTEL-CONTRACT.md §5).
//
// Everything captured (intel_events, as one line per trace with its events in
// order) and everything this product already held before capture began, one
// JSON line per row per table. Redacted again on the way out. Written to a
// folder outside git (scripts/intel-export.ts); never committed.

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db.js";
import { redactJson } from "./intelredact.js";
import { APP, CONTRACT_VERSION, captureMode } from "./intel.js";

/**
 * What already held data. Credentials (connector tokens, sign-in codes and
 * sessions, sponsor tokens, household codes), the de-duplication ledger and
 * internal locks are left out on purpose: they are secrets or noise.
 */
export const EXPORT_TABLES = [
  "businesses",
  "messages",
  "plans",
  "plan_steps",
  "business_map",
  "decisions",
  "commitments",
  "outcomes",
  "nudges",
  "proposed_changes",
  "owner_notes",
  "plan_builds",
  "safety_events",
  "retrieval_gaps",
  "knowledge_signals",
  "model_usage",
  "events",
  "event_daily",
  "incidents",
  "jobs",
  "cards",
  "kg_nodes",
  "kg_edges",
  "kg_triggers",
  "households",
  "household_members",
  "forget_log",
  "knowledge_entries",
  "tools",
  "model_config",
] as const;

/** Columns never exported: vectors are large and carry nothing a person did. */
const DROP_COLUMNS = new Set(["embedding", "token_hash", "code_hash"]);
const PAGE = 1000;

export interface ExportReport {
  app: string;
  v: number;
  exported_at: string;
  capture_mode: string;
  tables: Record<string, number>;
  traces: number;
  intel_events: number;
  errors: Record<string, string>;
}

async function page(table: string, from: number, orderBy: string | null): Promise<{ rows: Record<string, unknown>[]; error: string | null }> {
  let q = db().from(table).select("*");
  if (orderBy) q = q.order(orderBy, { ascending: true });
  const { data, error } = await q.range(from, from + PAGE - 1);
  if (error) return { rows: [], error: (error as { message?: string }).message ?? String(error) };
  return { rows: (data as Record<string, unknown>[] | null) ?? [], error: null };
}

/** Every row of one table, in a stable order (id, else created_at, else as stored). */
async function* rowsOf(table: string): AsyncGenerator<Record<string, unknown>, string | null> {
  let orderBy: string | null = "id";
  let from = 0;
  for (;;) {
    let r = await page(table, from, orderBy);
    if (r.error && from === 0 && orderBy === "id") {
      orderBy = "created_at";
      r = await page(table, from, orderBy);
    }
    if (r.error && from === 0 && orderBy === "created_at") {
      orderBy = null;
      r = await page(table, from, orderBy);
    }
    if (r.error) return r.error;
    for (const row of r.rows) yield row;
    if (r.rows.length < PAGE) return null;
    from += PAGE;
  }
}

const line = (row: Record<string, unknown>): string => {
  const clean = Object.fromEntries(Object.entries(row).filter(([k]) => !DROP_COLUMNS.has(k)));
  return redactJson(JSON.stringify(clean)) + "\n";
};

/** Writes the export into `dir` and says what is in it. */
export async function exportIntel(dir: string): Promise<ExportReport> {
  mkdirSync(dir, { recursive: true });
  const report: ExportReport = { app: APP, v: CONTRACT_VERSION, exported_at: new Date().toISOString(), capture_mode: captureMode(), tables: {}, traces: 0, intel_events: 0, errors: {} };

  for (const table of EXPORT_TABLES) {
    const file = join(dir, `${table}.jsonl`);
    writeFileSync(file, "");
    let n = 0;
    const it = rowsOf(table);
    for (;;) {
      const next = await it.next();
      if (next.done) {
        if (next.value) report.errors[table] = next.value;
        break;
      }
      appendFileSync(file, line(next.value));
      n++;
    }
    report.tables[table] = n;
  }

  // The captured stream: raw, and grouped into one line per task, in order.
  const raw = join(dir, "intel_events.jsonl");
  writeFileSync(raw, "");
  const traces = new Map<string, Record<string, unknown>[]>();
  const it = rowsOf("intel_events");
  for (;;) {
    const next = await it.next();
    if (next.done) {
      if (next.value) report.errors.intel_events = next.value;
      break;
    }
    const row = next.value;
    appendFileSync(raw, line(row));
    report.intel_events++;
    const t = String(row.trace_id ?? "none");
    if (!traces.has(t)) traces.set(t, []);
    traces.get(t)!.push(row);
  }
  const out = join(dir, "traces.jsonl");
  writeFileSync(out, "");
  for (const [trace_id, events] of traces) {
    events.sort((a, b) => String(a.at).localeCompare(String(b.at)) || Number(a.seq) - Number(b.seq));
    const first = events[0]!;
    appendFileSync(out, redactJson(JSON.stringify({ trace_id, app: APP, v: CONTRACT_VERSION, business_id: events.find((e) => e.business_id)?.business_id ?? null, started_at: first.at, ended_at: events.at(-1)!.at, kinds: [...new Set(events.map((e) => e.kind))], events })) + "\n");
  }
  report.traces = traces.size;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(report, null, 2));
  return report;
}
