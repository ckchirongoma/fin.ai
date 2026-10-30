// Fin — the database is not the fake in test/_fakes.ts.
//
// A production plan build failed outright because `businesses.biz_stage` did
// not exist on the live database, even though every unit test passed: the
// fake DB in-process happily accepts a write to any field, real Postgres does
// not. The fake is right to exist — it makes the rest of this suite fast and
// deterministic — but it is structurally incapable of catching drift between
// what the TypeScript models assume a row looks like and what a migration
// actually created. This file is the check that can: it parses every
// `db/*.sql` migration for the columns it adds, and asserts every field the
// Business / PlanRow / PlanStepRow models read or write is accounted for.
//
// Five tables (`businesses`, `plans`, `plan_steps`, `business_map`,
// `decisions`) predate this repository's migrations entirely — CLAUDE.md
// describes them as "schema ready" before any WhatsApp traffic existed, and
// `db/0001_rls_lockdown.sql` only ever enables RLS on them, never creates
// them. A field with no covering `ADD COLUMN` is not automatically a bug: it
// may be one of those baseline columns. BASELINE below is the explicit,
// reviewed list of which fields that applies to, so a field arriving on an
// interface with no migration AND no baseline entry fails loudly instead of
// shipping on the strength of an assumption — which is exactly how
// `biz_stage` shipped the first time (the migration existed; it had simply
// never been run against the live project).
//
// Everything in BASELINE.plan_steps and BASELINE.business_map is UNVERIFIED
// against the live database as of this writing — plans and plan_steps have
// never actually been written to in production, so there has been no chance
// to find out the hard way. Confirm these columns exist on the live project
// before the next real plan build, the same way `biz_stage` should have been
// confirmed before it shipped.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dbDir = fileURLToPath(new URL("../db", import.meta.url));
const typesPath = fileURLToPath(new URL("../api/_lib/types.ts", import.meta.url));

const migrationSql = readdirSync(dbDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(`${dbDir}/${f}`, "utf8"))
  .join("\n");

/** Every column any migration adds to a table, keyed by table name. */
function columnsAddedByMigrations(sql: string): Map<string, Set<string>> {
  const byTable = new Map<string, Set<string>>();
  const alterBlockRe = /ALTER TABLE\s+public\.(\w+)\s+([\s\S]*?);/g;
  for (const [, table, body] of sql.matchAll(alterBlockRe)) {
    const set = byTable.get(table!) ?? new Set<string>();
    for (const [, col] of body!.matchAll(/ADD COLUMN IF NOT EXISTS\s+(\w+)/g)) set.add(col!);
    byTable.set(table!, set);
  }
  return byTable;
}

/** Top-level field names of a single-nesting-level `export interface Name { ... }`. */
function interfaceFields(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`);
  assert.ok(start >= 0, `interface ${name} was found, so this test is testing something`);
  const end = source.indexOf("\n}", start);
  const body = source.slice(start, end);
  return [...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]!);
}

const added = columnsAddedByMigrations(migrationSql);
const typesSource = readFileSync(typesPath, "utf8");

// Columns that predate every migration in db/ — reviewed against CLAUDE.md's
// description of the pre-existing schema and against db/0001's own comment
// that these five tables are RLS-only, never CREATE-d, here. See file header
// for which of these are confirmed vs. still owed a live check.
const BASELINE: Record<string, string[]> = {
  businesses: ["id", "wa_id", "country", "stage", "created_at"],
  plans: ["id", "business_id", "goal", "created_at"],
  // UNVERIFIED against the live database (see file header).
  plan_steps: ["id", "plan_id", "workstream_title", "step_order", "title", "push", "tool_id", "status"],
  // UNVERIFIED against the live database (see file header).
  business_map: ["business_id", "domain", "status", "note", "updated_at"],
  // Verified live when CLAUDE.md was written: the 55 rows were loaded with
  // exactly these columns. Everything newer arrives by migration (needs_
  // verification in db/0013, free_type and friends in db/0014).
  tools: ["id", "country", "domain", "stages", "keywords", "name", "fits", "not_when", "why", "cost", "url", "setup", "walkthrough", "verified_on"],
};

function assertCovered(table: string, fields: string[], skip: Set<string> = new Set()) {
  const migrated = added.get(table) ?? new Set<string>();
  const baseline = new Set(BASELINE[table] ?? []);
  const missing = fields.filter((f) => !skip.has(f) && !migrated.has(f) && !baseline.has(f));
  assert.deepEqual(
    missing,
    [],
    `${table}: these fields are on the TS model but neither a migration nor BASELINE accounts for them — ` +
      `add a migration, or add them to BASELINE in this file with a reason: ${missing.join(", ")}`,
  );
}

describe("schema drift between the TS models and db/*.sql", () => {
  test("every Business field is covered by a migration or the reviewed baseline", () => {
    const fields = interfaceFields(typesSource, "Business");
    assert.ok(fields.length >= 20, "the Business interface was actually parsed, not matched empty");
    assertCovered("businesses", fields);
  });

  test("every PlanRow field is covered by a migration or the reviewed baseline", () => {
    const fields = interfaceFields(typesSource, "PlanRow");
    assertCovered("plans", fields);
  });

  test("every PlanStepRow field is covered by a migration or the reviewed baseline", () => {
    const fields = interfaceFields(typesSource, "PlanStepRow");
    assertCovered("plan_steps", fields);
  });

  test("business_map's written columns are covered by a migration or the reviewed baseline", () => {
    // MapEntry itself only models the wire shape (domain/status/note); the
    // extra columns build.ts actually upserts (business_id, updated_at) are
    // asserted directly here rather than through the interface.
    assertCovered("business_map", ["business_id", "domain", "status", "note", "updated_at"]);
  });

  test("every ToolRow field is covered by a migration or the reviewed baseline", () => {
    const fields = interfaceFields(typesSource, "ToolRow");
    assert.ok(fields.includes("free_type"), "the ToolRow interface was actually parsed");
    assertCovered("tools", fields);
  });

  test("a new field on Business with no migration and no baseline entry is caught", () => {
    const fields = ["wa_id", "totally_new_field_nobody_migrated"];
    assert.throws(() => assertCovered("businesses", fields), /totally_new_field_nobody_migrated/);
  });

  test("BASELINE itself is not silently empty, which would make every check above pass for free", () => {
    for (const table of ["businesses", "plans", "plan_steps", "business_map", "tools"]) {
      assert.ok((BASELINE[table]?.length ?? 0) > 0, `${table} has no baseline columns listed`);
    }
  });
});
