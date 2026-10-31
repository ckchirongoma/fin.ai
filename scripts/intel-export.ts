// Chase Intelligence — export everything (docs/INTEL-CONTRACT.md §5).
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
//   node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/intel-export.ts [folder]
//
// Writes one JSON line per row of every table that holds what people did,
// intel_events raw, traces.jsonl (one line per task, its events in order) and
// manifest.json, into intel-export/<date>/ by default. Redacted again on the
// way out. The folder is in .gitignore: an export never goes into git.

import { join } from "node:path";
import { exportIntel } from "../api/_lib/intelexport.ts";

const dir = process.argv[2] ?? join("intel-export", new Date().toISOString().replace(/[:.]/g, "-"));
const r = await exportIntel(dir);
console.log(`${dir}: ${r.traces} traces, ${r.intel_events} captured events`);
for (const [t, n] of Object.entries(r.tables)) console.log(`  ${t.padEnd(20)} ${n}`);
if (Object.keys(r.errors).length) {
  console.log("Not exported (table missing or unreadable):");
  for (const [t, e] of Object.entries(r.errors)) console.log(`  ${t}: ${e.slice(0, 160)}`);
}
