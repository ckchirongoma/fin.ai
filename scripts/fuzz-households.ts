// Charles — fuzz households for as many runs as you like.
//
//   node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/fuzz-households.ts [runs=2000] [seed=1] [steps=60]
//
// Prints every operation and outcome counted, the largest household seen, the
// speed, and every invariant broken (with the run and step). Exits 1 on any.

import { fuzzHouseholds } from "./householdfuzz.ts";

const s = await fuzzHouseholds(Number(process.argv[2] ?? 2000), Number(process.argv[3] ?? 1), Number(process.argv[4] ?? 60));
console.log(`runs ${s.runs.toLocaleString()}  steps ${s.steps.toLocaleString()}  in ${(s.ms / 1000).toFixed(1)}s (${((s.ms * 1000) / Math.max(s.steps, 1)).toFixed(0)}µs a step)`);
console.log("ops:", JSON.stringify(s.ops));
console.log("outcomes:", JSON.stringify(s.outcomes));
console.log(`largest household ${s.maxMembers} people`);
if (s.violations.length) {
  console.log(`\n${s.violations.length} VIOLATION(S):`);
  for (const v of s.violations) console.log(` - ${v}`);
  process.exit(1);
}
console.log("no invariant broken");
