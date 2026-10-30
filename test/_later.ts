// Fin — which columns a LATER migration updates, for tests that pin an
// earlier migration to the seed.
//
// The seed is always the newest state. A test that says "db/0020 and the
// seed carry the same rows" stays true only until a later migration updates
// some of those rows by (id, country) — db/0021 adds keywords to rows 0020
// inserted, and corrects a fee. Those columns are then checked against the
// later migration instead, never silently dropped: laterUpdates() reads the
// UPDATE statements of every migration numbered after the one under test.

import { readdirSync, readFileSync } from "node:fs";

const DB = new URL("../db/", import.meta.url);

/** "table:id" → the columns later migrations UPDATE on that row. */
export function laterUpdates(after: number): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const f of readdirSync(DB).filter((n) => /^\d{4}_.*\.sql$/.test(n) && Number(n.slice(0, 4)) > after).sort()) {
    const sql = readFileSync(new URL(f, DB), "utf8");
    for (const m of sql.matchAll(/UPDATE public\.(\w+) SET\n([\s\S]*?)\nWHERE id = '([^']+)'/g)) {
      const key = `${m[1]}:${m[3]}`;
      const cols = out.get(key) ?? new Set<string>();
      for (const c of m[2]!.matchAll(/^ {2}(\w+) = /gm)) cols.add(c[1]!);
      out.set(key, cols);
    }
  }
  return out;
}
