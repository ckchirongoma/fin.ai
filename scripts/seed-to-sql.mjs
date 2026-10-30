// Charles — write a db/ migration from seed/knowledge.json and seed/tools.json.
//
// The seed is the single source for the South African library; the migration
// must say exactly the same thing, row for row, or the two drift (the founder
// pastes the .sql into Supabase, the tests read the .json). So the .sql is
// generated from the .json, never hand-edited, and regenerated whenever a row
// changes:
//
//   node scripts/seed-to-sql.mjs > db/0034_charles_za_library.sql
//
// Options:
//   --country ZA        only rows of this country (default: every row)
//   --header FILE       a markdown/plain-text file to wrap in the /* … */ header
//                       (default: the built-in Charles header below)
//
// Every row is a whole-row upsert keyed on id (INSERT … ON CONFLICT (id) DO
// UPDATE SET every column), the same shape as db/0029_uganda.sql, so running
// it twice is safe and a corrected row replaces the old one in full.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const country = opt("--country");
const headerFile = opt("--header");

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const knowledge = read("../seed/knowledge.json").filter((r) => !country || r.country === country);
const tools = read("../seed/tools.json").filter((r) => !country || r.country === country);

const KCOLS = ["id", "country", "domain", "stages", "keywords", "title", "owner_summary", "applies_when", "not_when", "steps", "cost", "stakes", "verified_on"];
const TCOLS = ["id", "country", "domain", "stages", "keywords", "name", "fits", "not_when", "why", "cost", "url", "setup", "walkthrough", "verified_on", "informal_business_supported", "free_type", "ten_minute_action"];

const str = (s) => `'${String(s).replace(/'/g, "''")}'`;
const lit = (col, v) => {
  if (v === null || v === undefined) return "NULL";
  if (Array.isArray(v)) return `ARRAY[${v.map(str).join(", ")}]::text[]`;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (col === "verified_on") return `${str(v)}::date`;
  return str(v);
};

function upsert(table, cols, row) {
  const values = cols.map((c) => `  ${lit(c, row[c])}`).join(",\n");
  const set = cols
    .filter((c) => c !== "id")
    .map((c) => `  ${c} = EXCLUDED.${c}`)
    .join(",\n");
  return `-- ${row.id} (${row.country})\nINSERT INTO public.${table} (${cols.join(", ")})\nVALUES (\n${values}\n)\nON CONFLICT (id) DO UPDATE SET\n${set};\n`;
}

const defaultHeader = `# Charles — South Africa, the money library (apply AFTER 0033)

Data only, no schema change, safe to run more than once. It loads the
personal-finance knowledge base Charles runs on: ${knowledge.length} knowledge entries and
${tools.length} tools for South Africa (country 'ZA'), covering all eight areas of the
Money Map (income, spending, debt, cushion, credit_record, protection,
family_money, goals), as whole-row upserts keyed on id. Every id that
api/_lib/playbooks.ts pins (knowledge_ids, tool_choices) is here under exactly
that id. seed/knowledge.json and seed/tools.json carry the same rows; this
file is generated from them by scripts/seed-to-sql.mjs and must not be
hand-edited (regenerate it instead).

Charlie's business rows (k.deposits, yoco, …) are not touched by this file;
removing them is a separate, deliberate step for the founder once the Charles
rows are live (the two sets share no ids).

## How to apply — no SQL needed

  SUPABASE_URL=https://ybfqeaeujsbvdzcpuobe.supabase.co \\
  SUPABASE_SERVICE_ROLE_KEY=<service role key> \\
  node scripts/apply-knowledge.mjs \\
    --knowledge ${knowledge.map((r) => r.id).join(",")} \\
    --tools ${tools.map((r) => r.id).join(",")}

A bare id is a whole-row upsert; nothing here updates part of a row. Add
--dry first to see the request. The key is never printed. Or paste this file
into Supabase → SQL Editor.

## What is in it

Rights and rules a person can act on (the free annual credit report and the
20-business-day dispute, prescribed debt, debt review and its fees, the NCA
caps and reckless lending, mashonisa law, garnishee orders, the NFO and NCR
routes, SASSA grants and the 10% funeral-deduction rule, the SRD grant, UIF,
severance, two-pot, the tax-free savings limits, SARS thresholds, funeral
cover rules, stokvel safety, lay-by rights, scams, free basic electricity,
First Home Finance, the budgeting rules of thumb, the family line, the debt
snowball) and the places a step sends someone (GoTyme EveryDay and GoalSave,
PayShap, DebiCheck, the three bureaus' free reports, the NCR register and
line, the NFO, SAFPS, the FSCA check, SASSA online, office and WhatsApp,
uFiling, SARS eFiling, the fund's two-pot portal, a tax-free account, the
NHFC portal, the municipal indigent office, the Eskom token, the Council for
Debt Collectors, NASASA, the CCMA, Legal Aid SA, a notes-app log, a sheet).

Nothing in it recommends credit. \`tools.informal_business_supported\` keeps
Charlie's column name but now means "works without a payslip" (true: a
person with no formal job can use it; false: it needs an employer, a fund or
a home loan).

## Where the facts come from

Every row was written on 2026-10-30 from web searches; the build environment
could not open any official site directly (nfosa.co.za, sassa.gov.za,
sars.gov.za, transunion.co.za, safps.org.za, fsca.co.za, gotyme.co.za and
the rest all failed to resolve), so every figure was read from search-result
text of the named page. Where sources conflict (debt-review fee caps, grant
amounts, GoalSave tiers, PayShap fees, the SASSA WhatsApp number, the UIF
line) the row says "published figures differ" and names the place to confirm;
where nothing could be confirmed the figure was left out. verified_on is
2026-10-30 on every row. Sources and the verdict for every row are in
docs/kb-sources.md.
`;

const header = headerFile ? readFileSync(headerFile, "utf8") : defaultHeader;

const out = [];
out.push("/*", header.trimEnd(), "*/", "", "BEGIN;", "");
for (const r of knowledge) out.push(upsert("knowledge_entries", KCOLS, r));
for (const r of tools) out.push(upsert("tools", TCOLS, r));
out.push("COMMIT;", "");
process.stdout.write(out.join("\n"));
