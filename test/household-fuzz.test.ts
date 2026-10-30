// Charles — households under random fire (scripts/householdfuzz.ts): random
// people inviting, joining, racing for one code, being let in or turned
// away by the right and the wrong person, leaving, sharing debts, being
// forgotten, codes expiring. Every invariant after every step.
// scripts/fuzz-households.ts runs as many as you like.

import { test } from "node:test";
import assert from "node:assert/strict";

test("households: random runs, every invariant after every step, households filled to six", async () => {
  // Loaded here, not statically, so the fuzzer sets the environment first.
  const { fuzzHouseholds } = await import("../scripts/householdfuzz.ts");
  const s = await fuzzHouseholds(Number(process.env.HOUSEHOLD_FUZZ_RUNS ?? 150), 11, 80);
  assert.deepEqual(s.violations, []);
  assert.equal(s.maxMembers, 6, "some household reached six");
  for (const k of ["race:1", "decide:refused", "decide:full", "invite:full", "join:used", "join:expired", "share:true", "leave:true"]) assert.ok((s.outcomes[k] ?? 0) > 0, `the fuzzer reached ${k}`);
  assert.ok(!s.outcomes["race:2"], "one code never lets two people in");
});
