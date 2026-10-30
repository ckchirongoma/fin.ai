// Charles — load the knowledge base into a fresh environment.
//
// Supabase is the source of truth; seed/*.json is a point-in-time mirror of it,
// kept so the research is versioned somewhere durable and so a new environment
// can be brought up without database access first. The two WILL drift, and that
// is expected — this script only ever writes INTO the database, never back out.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/seed.mjs [--dry]
//
// Upsert on id, so running it twice is safe and running it against a live
// project only fills gaps — but note that it will overwrite an entry a human
// has since re-verified in Supabase with the older snapshot value. Check
// --dry output before running it against anything real.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const dry = process.argv.includes("--dry");
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const knowledge = JSON.parse(readFileSync(new URL("../seed/knowledge.json", import.meta.url), "utf8"));
const tools = JSON.parse(readFileSync(new URL("../seed/tools.json", import.meta.url), "utf8"));

const byCountry = (rows) =>
  Object.entries(
    rows.reduce((acc, r) => {
      acc[r.country] = (acc[r.country] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .map(([c, n]) => `${c} ${n}`)
    .join(", ");

console.log(`knowledge_entries: ${knowledge.length} (${byCountry(knowledge)})`);
console.log(`tools:             ${tools.length} (${byCountry(tools)})`);

// Rule 10 lives or dies on this column, so say something about it up front.
const stale = [...knowledge, ...tools].filter((r) => {
  if (!r.verified_on) return true;
  return (Date.now() - new Date(r.verified_on).getTime()) / 864e5 > 90;
});
if (stale.length) {
  console.log(`\n${stale.length} of these are already past 90 days or have no verified_on:`);
  for (const r of stale.slice(0, 20)) console.log(`  ${r.id} (${r.country}) — ${r.verified_on ?? "never checked"}`);
  console.log("They will still be used, hedged to \"confirm at sign-up\" wherever they are shown. Re-check them when you can.");
}

if (dry) {
  console.log("\n--dry: nothing written.");
  process.exit(0);
}

if (!url || !key) {
  console.error("\nSet SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or pass --dry.");
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });

// The embedding column is left alone: it is runtime-generated, empty at this
// stage, and deliberately not part of the retrieval path yet.
const strip = (r) => {
  const { embedding, ...rest } = r;
  return rest;
};

for (const [table, rows] of [
  ["knowledge_entries", knowledge],
  ["tools", tools],
]) {
  const { error } = await db.from(table).upsert(rows.map(strip), { onConflict: "id" });
  if (error) {
    console.error(`\n${table}: ${error.message}`);
    process.exit(1);
  }
  console.log(`\n${table}: ${rows.length} rows upserted.`);
}

console.log("\nDone. Supabase is the source of truth from here — seed/ will drift from it.");
