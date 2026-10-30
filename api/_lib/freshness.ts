// Charles — keeping the library honest.
//
// Rule 10 says every cost carries a verification date and anything past 90 days
// is hedged automatically. The hedging already happens at read time in
// retrieval.ts, so a stale price can never be stated as fact. This is the other
// half: somebody has to actually go and re-check them, and that only happens if
// something surfaces the list.
//
// Deliberately NOT done: excluding stale entries from retrieval. A hedged real
// price ("R699, last checked 140 days ago, confirm at sign-up") is far more
// useful to a person than no answer at all, and dropping rows would quietly
// hollow out the library for whichever market got least attention.

import { db } from "./db.js";

export interface StaleRow {
  id: string;
  country: string;
  name: string;
  verified_on: string | null;
  days_old: number | null;
}

export interface FreshnessReport {
  ran_at: string;
  stale_knowledge: StaleRow[];
  stale_tools: StaleRow[];
  total_knowledge: number;
  total_tools: number;
}

export async function runFreshnessSweep(): Promise<FreshnessReport> {
  const [{ data: k }, { data: t }] = await Promise.all([
    db().from("knowledge_freshness").select("id, country, title, verified_on, days_old, is_stale"),
    db().from("tools_freshness").select("id, country, name, cost, verified_on, days_old, is_stale"),
  ]);

  const kRows = (k as (StaleRow & { title: string; is_stale: boolean })[]) ?? [];
  const tRows = (t as (StaleRow & { is_stale: boolean })[]) ?? [];

  const staleK = kRows.filter((r) => r.is_stale).map((r) => ({ id: r.id, country: r.country, name: r.title, verified_on: r.verified_on, days_old: r.days_old }));
  const staleT = tRows.filter((r) => r.is_stale).map((r) => ({ id: r.id, country: r.country, name: r.name, verified_on: r.verified_on, days_old: r.days_old }));

  const report: FreshnessReport = {
    ran_at: new Date().toISOString(),
    stale_knowledge: staleK,
    stale_tools: staleT,
    total_knowledge: kRows.length,
    total_tools: tRows.length,
  };

  await db().from("freshness_reports").insert({
    stale_knowledge: staleK.length,
    stale_tools: staleT.length,
    detail: { knowledge: staleK.slice(0, 100), tools: staleT.slice(0, 100) },
  });

  if (staleK.length || staleT.length) {
    console.warn(
      `freshness: ${staleK.length}/${kRows.length} knowledge entries and ${staleT.length}/${tRows.length} tools are past 90 days. ` +
        `Oldest tools: ${staleT
          .sort((a, b) => (b.days_old ?? 0) - (a.days_old ?? 0))
          .slice(0, 5)
          .map((r) => `${r.id} (${r.days_old ?? "never checked"})`)
          .join(", ")}`,
    );
  } else {
    console.log(`freshness: everything inside 90 days (${kRows.length} knowledge, ${tRows.length} tools)`);
  }

  return report;
}
