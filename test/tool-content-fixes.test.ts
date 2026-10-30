// Fin — Priority 4.3.1 CRITICAL DRIFT corrections, fixture-based.
//
// db/0013_tool_content_fixes.sql is what actually corrects the live
// database, and this repo's own pattern (HANDOFF-DEPLOY.md, db/README.md) is
// that nobody but the founder applies a migration to the live project — so
// there is no live DB for a test in this repo to call. What CAN be checked
// without one is the fixture this migration was written against and kept in
// lockstep with: seed/tools.json, the point-in-time mirror `scripts/seed.mjs`
// upserts into Supabase. If a future edit to seed/tools.json accidentally
// reverts one of these corrections (e.g. a careless full-file regeneration),
// this is the test that catches it — the same role schema-drift.test.ts
// plays for the TS models, applied to the tool-content research instead.
//
// This does NOT prove the live Supabase `tools` table has been migrated —
// only the founder applying db/0013 can make that true. It proves the
// corrected facts are the ones this repo will re-seed with going forward.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

interface ToolFixture {
  id: string;
  cost: string;
  fits: string;
  not_when: string;
  url: string;
  setup: string;
  walkthrough: string[];
  verified_on: string;
  needs_verification?: boolean;
}

const tools: ToolFixture[] = JSON.parse(readFileSync(new URL("../seed/tools.json", import.meta.url), "utf8"));

function tool(id: string): ToolFixture {
  const found = tools.find((t) => t.id === id);
  assert.ok(found, `seed/tools.json has no row for '${id}' — has the fixture been renamed or removed?`);
  return found!;
}

describe("every tools row still satisfies the shape the retrieval/PDF code assumes", () => {
  test("every row has a non-empty id, cost and walkthrough — a migration must not leave a row half-written", () => {
    for (const t of tools) {
      assert.ok(t.id, "a tool row is missing its id");
      assert.ok(t.cost && t.cost.length > 0, `${t.id} has an empty cost`);
      assert.ok(Array.isArray(t.walkthrough) && t.walkthrough.length > 0, `${t.id} has no walkthrough steps`);
    }
  });

  test("needs_verification, where present, is a real boolean, not a stray string", () => {
    for (const t of tools) {
      if ("needs_verification" in t) assert.equal(typeof t.needs_verification, "boolean", `${t.id}`);
    }
  });
});
