// Chase Intelligence — read one task back, in order, from one id.
//
//   node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/intel-trace.ts <trace id | turn id | job_<n> | <n>> [--full]
//
// Prints what was asked, what each model was shown and answered, what was
// checked, sent, run and how it ended, with the jobs it queued folded in.
// Without --full, long content is cut to one line per event.

import { readTrace } from "../api/_lib/intel.ts";

const id = process.argv[2];
if (!id) {
  console.log("usage: intel-trace.ts <trace id | turn id | job_<n> | n> [--full]");
  process.exit(1);
}
const full = process.argv.includes("--full");
const events = await readTrace(id);
if (!events.length) {
  console.log(`nothing recorded under ${id}`);
  process.exit(1);
}
for (const e of events) {
  const head = `${e.at} ${String(e.seq).padStart(6)} ${e.kind.padEnd(5)} ${e.name}${e.ok === false ? " FAILED" : ""}${e.ms != null ? ` ${e.ms}ms` : ""}`;
  console.log(head);
  if (e.content != null) {
    const body = JSON.stringify(e.content, null, full ? 2 : 0);
    console.log(full ? body : `    ${body.slice(0, 220)}${body.length > 220 ? "…" : ""}`);
  }
}
