// Charles — fuzz the knowledge graph for as many journeys as you like.
//
//   node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/fuzz-graph.ts [journeys=100000] [seed=1] [turns=12]
//
// Prints what was kept and refused, the actions triggered, the largest graph
// and prompt block seen, the speed, and every invariant broken (with the seed
// and turn to reproduce it). Exits 1 on any violation.

import { fuzz } from "./graphfuzz.ts";

const journeys = Number(process.argv[2] ?? 100_000);
const seed = Number(process.argv[3] ?? 1);
const turns = Number(process.argv[4] ?? 12);
const s = fuzz(journeys, seed, turns);
console.log(`journeys ${s.journeys.toLocaleString()}  turns ${s.turns.toLocaleString()}  facts kept ${s.kept.toLocaleString()}  in ${(s.ms / 1000).toFixed(1)}s (${((s.ms * 1000) / Math.max(s.turns, 1)).toFixed(1)}µs a turn)`);
console.log("refused:", JSON.stringify(s.refused));
console.log("actions:", JSON.stringify(s.actions));
console.log(`largest graph ${s.maxEdges} edges, largest prompt block ${s.maxSheet} characters`);
if (s.violations.length) {
  console.log(`\n${s.violations.length} VIOLATION(S):`);
  for (const v of s.violations) console.log(` - ${v}`);
  process.exit(1);
}
console.log("no invariant broken");
