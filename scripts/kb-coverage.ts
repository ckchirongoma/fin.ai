// Charles — the knowledge-base yardstick.
//
// WHY THIS EXISTS
// South Africa had four times the content of Kenya, Nigeria or Ghana, and three
// of the eight plan areas had no knowledge entry at all outside ZA. Nobody saw
// it because nothing measured it. This script is the measurement, run the same
// way before and after any content is added, so "closed the gap" is a number
// and not a feeling. docs/kb-gap-analysis.md records the baseline it produced.
//
// WHAT IT MEASURES, per country (all from seed/*.json and the playbooks — no
// database, no model, no network):
//   a. rows per domain and per stage, for knowledge entries and tools;
//   b. plan-step tool coverage: every playbook step that names tool_choices,
//      and whether at least one of those ids exists as a tool in the country
//      (forCountry() in engine/build.ts drops the rest, so an uncovered step
//      reaches that owner with no tool at all);
//   c. a question benchmark (test/fixtures/kb-benchmark.json), and the same
//      scoring over the held-out set (test/fixtures/kb-benchmark-holdout.json,
//      written blind and never tuned to): the real
//      shortlist() from api/_lib/retrieval.ts over that country's rows, with
//      the semantic rescue switched off. A question is ANSWERED when the top 3
//      knowledge+tool rows include one from that country, in the question's
//      domain, whose own keywords overlap the question (keywordScore > 0). A
//      domain bonus alone does not count — the domain is not passed in, which
//      is how a free-typed WhatsApp question actually arrives;
//   d. freshness: rows whose verified_on is more than 90 days old (or missing).
//
// Usage:
//   node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/kb-coverage.ts [--json] [--as-of YYYY-MM-DD]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MODULES, type Workstream } from "../api/_lib/playbooks.js";
import { keywordScore, scoreRow, shortlist } from "../api/_lib/retrieval.js";
import type { KnowledgeRow, ToolRow } from "../api/_lib/types.js";

export const COUNTRIES = ["ZA"] as const;
import { DOMAINS } from "../api/_lib/types.js";
export { DOMAINS };
export const STAGES = ["surviving", "stretching", "steady", "building"] as const;
const FRESH_DAYS = 90;
const TOP_N = 3;

export interface BenchmarkQuestion {
  id: string;
  domain: string;
  stage: string;
  question: string;
}

export interface CoverageInput {
  knowledge: KnowledgeRow[];
  tools: ToolRow[];
  questions: BenchmarkQuestion[];
  /** The held-out set (test/fixtures/kb-benchmark-holdout.json), scored by the
   * same rule. Written blind — nobody tuned keywords to it. */
  holdout?: BenchmarkQuestion[];
  /** The getting-paid blind set (test/fixtures/kb-benchmark-getting-paid.json), written before round 13's content. */
  /** Freshness reference date. Defaults to today. */
  asOf?: Date;
}

type Counts = Record<string, number>;

export interface StepCoverage {
  total: number;
  covered: number;
  pct: number;
  uncovered: { module: string; step: string; title: string; domain: string; tool_choices: string[] }[];
}

export interface BenchmarkResult {
  total: number;
  answered: number;
  pct: number;
  byDomain: Record<string, { total: number; answered: number; pct: number }>;
  missed: { id: string; question: string; domain: string; top: string[] }[];
}

export interface CountryCoverage {
  knowledge: { total: number; byDomain: Counts; byStage: Counts };
  tools: { total: number; byDomain: Counts; byStage: Counts };
  /** Domains with no knowledge entry and domains with no tool. */
  emptyDomains: { knowledge: string[]; tools: string[] };
  planSteps: StepCoverage;
  benchmark: BenchmarkResult;
  /** Present when the input carried a held-out set. */
  holdout?: BenchmarkResult;
  freshness: { stale: number; staleIds: string[]; oldestVerifiedOn: string | null };
}

export interface CoverageReport {
  asOf: string;
  questions: number;
  holdoutQuestions: number;
  countries: Record<string, CountryCoverage>;
}

const pct = (a: number, b: number): number => (b ? Math.round((a / b) * 1000) / 10 : 0);

function tally<T extends { domain: string | null; stages: string[] | null }>(rows: T[]): { total: number; byDomain: Counts; byStage: Counts } {
  const byDomain: Counts = Object.fromEntries(DOMAINS.map((d) => [d, 0]));
  const byStage: Counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const r of rows) {
    const d = r.domain ?? "(none)";
    byDomain[d] = (byDomain[d] ?? 0) + 1;
    for (const s of r.stages ?? []) byStage[s] = (byStage[s] ?? 0) + 1;
  }
  return { total: rows.length, byDomain, byStage };
}

/** Every playbook step, labelled by the module that owns it. */
export function allSteps(): { module: string; ws: Workstream }[] {
  return Object.values(MODULES).map((ws) => ({ module: ws.id, ws }));
}

function planStepCoverage(countryToolIds: ReadonlySet<string>): StepCoverage {
  const out: StepCoverage = { total: 0, covered: 0, pct: 0, uncovered: [] };
  for (const { module, ws } of allSteps()) {
    for (const s of ws.steps) {
      if (!s.tool_choices?.length) continue;
      out.total++;
      if (s.tool_choices.some((id) => countryToolIds.has(id))) out.covered++;
      else out.uncovered.push({ module, step: s.id, title: s.title, domain: s.domain, tool_choices: s.tool_choices });
    }
  }
  out.pct = pct(out.covered, out.total);
  return out;
}

async function benchmark(country: string, knowledge: KnowledgeRow[], tools: ToolRow[], questions: BenchmarkQuestion[]): Promise<BenchmarkResult> {
  const byDomain: BenchmarkResult["byDomain"] = Object.fromEntries(DOMAINS.map((d) => [d, { total: 0, answered: 0, pct: 0 }]));
  const missed: BenchmarkResult["missed"] = [];
  let answered = 0;

  for (const q of questions) {
    const query = { text: q.question, stage: q.stage };
    // semantic:false — keywords only, no embedding call and no gap row written.
    const sl = await shortlist(knowledge, tools, query, { country, semantic: false, log: false });
    // shortlist() returns knowledge and tools as separate ranked lists; merge
    // them on the same score it ranked by and take the top 3 overall.
    const merged = [
      ...sl.knowledge.map((r) => ({ id: r.id, country: r.country, domain: r.domain, s: scoreRow(r, query), k: keywordScore(r, query) })),
      ...sl.tools.map((r) => ({ id: r.id, country: r.country, domain: r.domain, s: scoreRow(r, query), k: keywordScore(r, query) })),
    ]
      .sort((a, b) => b.s - a.s || b.k - a.k || a.id.localeCompare(b.id))
      .slice(0, TOP_N);
    const hit = merged.some((r) => r.country === country && r.domain === q.domain && r.k > 0);

    const d = (byDomain[q.domain] ??= { total: 0, answered: 0, pct: 0 });
    d.total++;
    if (hit) {
      d.answered++;
      answered++;
    } else {
      missed.push({ id: q.id, question: q.question, domain: q.domain, top: merged.map((r) => `${r.id}(${r.domain},kw=${r.k})`) });
    }
  }
  for (const d of Object.values(byDomain)) d.pct = pct(d.answered, d.total);
  return { total: questions.length, answered, pct: pct(answered, questions.length), byDomain, missed };
}

function freshness(rows: { id: string; verified_on: string | null }[], asOf: Date): CountryCoverage["freshness"] {
  const staleIds: string[] = [];
  let oldest: string | null = null;
  for (const r of rows) {
    const t = r.verified_on ? new Date(r.verified_on).getTime() : NaN;
    if (!Number.isFinite(t) || (asOf.getTime() - t) / 864e5 > FRESH_DAYS) staleIds.push(r.id);
    if (r.verified_on && (!oldest || r.verified_on < oldest)) oldest = r.verified_on;
  }
  return { stale: staleIds.length, staleIds, oldestVerifiedOn: oldest };
}

/** The core: pure over its inputs apart from shortlist()'s async signature. */
export async function kbCoverage(input: CoverageInput): Promise<CoverageReport> {
  const asOf = input.asOf ?? new Date();
  const countries: Record<string, CountryCoverage> = {};
  for (const c of COUNTRIES) {
    const k = input.knowledge.filter((r) => r.country === c);
    const t = input.tools.filter((r) => r.country === c);
    const kt = tally(k);
    const tt = tally(t);
    countries[c] = {
      knowledge: kt,
      tools: tt,
      emptyDomains: {
        knowledge: DOMAINS.filter((d) => !kt.byDomain[d]),
        tools: DOMAINS.filter((d) => !tt.byDomain[d]),
      },
      planSteps: planStepCoverage(new Set(t.map((r) => r.id))),
      benchmark: await benchmark(c, k, t, input.questions),
      ...(input.holdout?.length ? { holdout: await benchmark(c, k, t, input.holdout) } : {}),
      freshness: freshness([...k, ...t], asOf),
    };
  }
  return { asOf: asOf.toISOString().slice(0, 10), questions: input.questions.length, holdoutQuestions: input.holdout?.length ?? 0, countries };
}

export function loadInputs(asOf?: Date): CoverageInput {
  const read = <T>(rel: string): T => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as T;
  return {
    knowledge: read<KnowledgeRow[]>("../seed/knowledge.json"),
    tools: read<ToolRow[]>("../seed/tools.json"),
    questions: read<{ questions: BenchmarkQuestion[] }>("../test/fixtures/kb-benchmark.json").questions,
    holdout: read<{ questions: BenchmarkQuestion[] }>("../test/fixtures/kb-benchmark-holdout.json").questions,
    asOf,
  };
}

// ── Text report ────────────────────────────────────────────────────

function table(head: string[], rows: (string | number)[][]): string {
  const cells = [head, ...rows.map((r) => r.map(String))];
  const w = head.map((_, i) => Math.max(...cells.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(w[i])).join("  ");
  return [line(head), w.map((n) => "-".repeat(n)).join("  "), ...cells.slice(1).map(line)].join("\n");
}

export function renderText(r: CoverageReport): string {
  const C = COUNTRIES as readonly string[];
  const out: string[] = [`Knowledge-base coverage — as of ${r.asOf}, ${r.questions} benchmark questions`, ""];
  out.push(
    table(
      ["country", "knowledge", "tools", "plan-step tool cov.", "benchmark answered", "stale >90d"],
      C.map((c) => {
        const x = r.countries[c];
        return [c, x.knowledge.total, x.tools.total, `${x.planSteps.covered}/${x.planSteps.total} (${x.planSteps.pct}%)`, `${x.benchmark.answered}/${x.benchmark.total} (${x.benchmark.pct}%)`, x.freshness.stale];
      }),
    ),
  );
  for (const [label, key] of [["Knowledge entries per domain", "knowledge"], ["Tools per domain", "tools"]] as const) {
    out.push("", label, table(["domain", ...C], DOMAINS.map((d) => [d, ...C.map((c) => r.countries[c][key].byDomain[d] ?? 0)])));
  }
  for (const [label, key] of [["Knowledge entries per stage", "knowledge"], ["Tools per stage", "tools"]] as const) {
    out.push("", label, table(["stage", ...C], STAGES.map((s) => [s, ...C.map((c) => r.countries[c][key].byStage[s] ?? 0)])));
  }
  out.push("", "Benchmark % answered per domain", table(["domain", ...C], DOMAINS.map((d) => [d, ...C.map((c) => `${r.countries[c].benchmark.byDomain[d]?.pct ?? 0}%`)])));
  if (r.holdoutQuestions) {
    const h = (c: string) => r.countries[c].holdout!;
    out.push(
      "",
      `Held-out benchmark (${r.holdoutQuestions} questions written blind; never tune keywords to these)`,
      table(["country", "answered", "main benchmark"], C.map((c) => [c, `${h(c).answered}/${h(c).total} (${h(c).pct}%)`, `${r.countries[c].benchmark.pct}%`])),
      "",
      "Held-out % answered per domain",
      table(["domain", ...C], DOMAINS.map((d) => [d, ...C.map((c) => { const x = h(c).byDomain[d]; return `${x?.answered ?? 0}/${x?.total ?? 0}`; })])),
    );
    for (const c of C) {
      out.push("", `${c} — held-out misses (${h(c).missed.length})`);
      for (const m of h(c).missed) out.push(`  ${m.id} [${m.domain}] ${m.question}  — top: ${m.top.join(", ") || "(nothing)"}`);
    }
  }
  for (const c of C) {
    const x = r.countries[c];
    out.push("", `${c} — plan steps with no local tool (${x.planSteps.uncovered.length})`);
    for (const u of x.planSteps.uncovered) out.push(`  ${u.module}/${u.step}  [${u.domain}]  ${u.title}  — needs one of: ${u.tool_choices.join(", ")}`);
    if (x.freshness.stale) out.push(`  stale rows: ${x.freshness.staleIds.join(", ")}`);
  }
  return out.join("\n");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--as-of");
  const asOf = i >= 0 && args[i + 1] ? new Date(args[i + 1]) : undefined;
  const report = await kbCoverage(loadInputs(asOf));
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : renderText(report));
}
