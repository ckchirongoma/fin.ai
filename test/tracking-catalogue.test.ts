// Fin — every event name in the code is in docs/TRACKING.md.
//
// The catalogue is how anyone reading the dashboard or an alert email knows
// what an event means. An event added to the code and not to the catalogue
// is a number nobody can read; this keeps the two together.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

test("every tracked event name is in the catalogue", () => {
  const doc = readFileSync(join(root, "docs/TRACKING.md"), "utf8");
  const documented = new Set([...doc.matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]!));
  const used = new Map<string, string>();
  for (const f of walk(join(root, "api"))) {
    for (const m of readFileSync(f, "utf8").matchAll(/\b(?:track|trackFailure|trackUnmet)\(\s*["`]([a-z0-9_]+)["`]/g)) used.set(m[1]!, f.slice(root.length));
  }
  assert.ok(used.size > 100, `found ${used.size} event names`);
  const missing = [...used].filter(([n]) => !documented.has(n)).map(([n, f]) => `${n} (${f})`);
  assert.deepEqual(missing, [], "add these to docs/TRACKING.md");
});

test("the tables tracking writes are in the migration", () => {
  const sql = readFileSync(join(root, "db/0024_tracking.sql"), "utf8");
  for (const t of ["events", "incidents", "alert_state", "event_daily"]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t}\\b`));
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.bump_incident/);
  assert.match(sql, /BEFORE DELETE ON public\.businesses/);
});
