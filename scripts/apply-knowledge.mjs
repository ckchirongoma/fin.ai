// Charles — load a few named seed rows into Supabase, with no SQL.
//
// The founder does not run SQL, and a tester without a SQL path could not
// load db/0019 at all in round 10. This upserts rows straight from
// seed/knowledge.json and seed/tools.json through PostgREST, so the migration
// file and this command carry the same content by construction.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node scripts/apply-knowledge.mjs --knowledge k.za_vat_registration,k.ke_vat_registration --tools turnover_tax:keywords+not_when [--dry]
//
// What it writes, exactly:
//   - A bare id (`k.za_vat_registration`) is a WHOLE-ROW upsert: every column
//     of that row is overwritten from the seed file, verified_on included.
//     All bare ids in a table go in one POST with on_conflict=id and
//     Prefer: resolution=merge-duplicates (PostgREST's upsert).
//   - An id with columns (`turnover_tax:keywords+not_when`) writes ONLY those
//     columns: one PATCH per row, filtered by id and country. It never
//     inserts, so a row missing live is an error, not a new row, and every
//     other column (verified_on, cost, walkthrough…) keeps its live value.
//     This is how a migration's keyed UPDATE is reproduced.
// Unlike scripts/seed.mjs it touches only the ids you name - but a bare id
// DOES roll that row back to the snapshot, so name columns whenever the
// migration you are reproducing updates only some. Both forms are safe to
// run twice.
//
// The key is read once, sent only in headers, and never written to stdout or
// stderr: error bodies from PostgREST are printed after scrubbing it out.

import { readFileSync } from "node:fs";

const SEED = {
  knowledge_entries: new URL("../seed/knowledge.json", import.meta.url),
  tools: new URL("../seed/tools.json", import.meta.url),
};

/** Pick the named rows out of a seed file, failing loudly on an id it does not have. */
export function selectRows(rows, ids) {
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) throw new Error(`not in the seed: ${missing.join(", ")}`);
  // The embedding column is runtime-generated and not in the seed; strip it if
  // it ever appears so a stale vector is never written back.
  return ids.map((id) => {
    const { embedding, ...rest } = rows.find((r) => r.id === id);
    return rest;
  });
}

const KEYS = new Set(["id", "country"]);

/** "turnover_tax:keywords+not_when" → { id: "turnover_tax", columns: ["keywords", "not_when"] }; a bare id → columns null. */
export function parseSpec(spec) {
  const [id, cols, ...extra] = spec.split(":");
  if (!id || extra.length) throw new Error(`bad row spec ${spec}`);
  if (cols === undefined) return { id, columns: null };
  const columns = cols.split("+").map((c) => c.trim()).filter(Boolean);
  if (!columns.length) throw new Error(`no columns in ${spec}`);
  const keyCol = columns.find((c) => KEYS.has(c) || c === "embedding");
  if (keyCol) throw new Error(`${spec}: ${keyCol} cannot be patched`);
  return { id, columns };
}

/**
 * Every request the script would send, without sending any. Whole-row ids
 * become one upsert per table; column-limited ids become one PATCH each,
 * carrying only those columns.
 */
export function planRequests({ url, key }, seeds, args) {
  const base = url.replace(/\/$/, "");
  const headers = (prefer) => ({ apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: prefer });
  const out = [];
  for (const table of ["knowledge_entries", "tools"]) {
    const specs = (args[table] ?? []).map(parseSpec);
    if (!specs.length) continue;
    const whole = specs.filter((s) => !s.columns);
    if (whole.length) {
      const rows = selectRows(seeds[table], whole.map((s) => s.id));
      out.push({
        table, kind: "upsert", ids: rows.map((r) => r.id),
        url: `${base}/rest/v1/${table}?on_conflict=id`,
        init: { method: "POST", headers: headers("resolution=merge-duplicates,return=minimal"), body: JSON.stringify(rows) },
      });
    }
    for (const s of specs.filter((s) => s.columns)) {
      const [row] = selectRows(seeds[table], [s.id]);
      const missing = s.columns.filter((c) => !(c in row));
      if (missing.length) throw new Error(`${s.id} has no ${missing.join(", ")} in the seed`);
      const body = Object.fromEntries(s.columns.map((c) => [c, row[c]]));
      out.push({
        table, kind: "patch", ids: [row.id], columns: s.columns,
        url: `${base}/rest/v1/${table}?id=eq.${encodeURIComponent(row.id)}&country=eq.${encodeURIComponent(row.country)}`,
        // return=representation so a filter that matched nothing is visible.
        init: { method: "PATCH", headers: headers("return=representation"), body: JSON.stringify(body) },
      });
    }
  }
  return out;
}

/** Send one planned request; a PATCH that matched no live row is an error, never an insert. */
export async function sendRequest(fetchImpl, key, req) {
  const res = await fetchImpl(req.url, req.init);
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`${req.table}: HTTP ${res.status} ${text.split(key).join("[redacted]")}`.trim());
  }
  if (req.kind === "patch") {
    let n = 0;
    try { n = JSON.parse(text).length ?? 0; } catch { n = 0; }
    if (n !== 1) throw new Error(`${req.table}: ${req.ids[0]} matched ${n} live rows - nothing to update (the PATCH never inserts)`);
  }
  return req.ids.length;
}

/**
 * One whole-row PostgREST upsert for one table. `fetchImpl` is injectable so
 * the test can see exactly what is sent without a network.
 */
export async function upsertRows(fetchImpl, { url, key }, table, rows) {
  const res = await fetchImpl(`${url.replace(/\/$/, "")}/rest/v1/${table}?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).split(key).join("[redacted]");
    throw new Error(`${table}: HTTP ${res.status} ${body}`.trim());
  }
  return rows.length;
}

/** --knowledge a,b --tools c:col1+col2 --dry → { knowledge_entries: [a, b], tools: ["c:col1+col2"], dry } (specs; see parseSpec) */
export function parseArgs(argv) {
  const out = { knowledge_entries: [], tools: [], dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry") out.dry = true;
    else if (a === "--knowledge" || a === "--tools") {
      const ids = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      out[a === "--knowledge" ? "knowledge_entries" : "tools"].push(...ids);
    } else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.knowledge_entries.length && !args.tools.length) {
    console.error("Name at least one row: --knowledge id[,id…] and/or --tools id[,id…]. Add --dry to only look.");
    process.exit(1);
  }

  const seeds = {};
  for (const table of ["knowledge_entries", "tools"]) {
    if (!args[table].length) continue;
    seeds[table] = JSON.parse(readFileSync(SEED[table], "utf8"));
    for (const spec of args[table].map(parseSpec)) {
      const [r] = selectRows(seeds[table], [spec.id]);
      console.log(
        spec.columns
          ? `${table}: ${r.id} (${r.country}) — only ${spec.columns.join(", ")}; verified_on and every other column left as they are live`
          : `${table}: ${r.id} (${r.country}) — whole row, verified ${r.verified_on ?? "never"}`,
      );
    }
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Plan even on --dry, so a bad column name fails before anything is sent.
  const plan = planRequests({ url: url || "https://dry.invalid", key: key || "" }, seeds, args);

  if (args.dry) {
    console.log("\n--dry: nothing written.");
    return;
  }

  if (!url || !key) {
    console.error("\nSet SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or pass --dry.");
    process.exit(1);
  }

  for (const req of plan) {
    const n = await sendRequest(fetch, key, req);
    console.log(`\n${req.table}: ${n} row${n === 1 ? "" : "s"} ${req.kind === "patch" ? `updated (${req.columns.join(", ")} only)` : "upserted"}.`);
  }
  console.log("\nDone.");
}

// Run only when invoked directly, so the test can import the pieces.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
}
