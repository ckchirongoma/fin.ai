// Charles — the cohort report, and who may read it.
//
// The report itself (aggregates only, split by baseline tier, with the harm
// check PRODUCT-DEFINITION 6.1 commits to) used to live inside the endpoint,
// authorised by the same WORKER_SECRET that runs the job queue and the PDF
// renderer. Handing a funder that secret to open a console would hand them the
// keys to everything, so this adds what a sponsor actually needs: a token that
// can read the cohort report and NOTHING else, that can be revoked on its own,
// and that never shows a group small enough to identify anyone in it.

import { db, NOT_GUARDRAIL_CHECKS } from "./db.js";
import { hashSecret, mintToken } from "./crypto.js";

interface Row {
  id: string;
  country: string;
  biz_stage: string | null;
  baseline_tier: string | null;
  created_at: string;
  current_plan_id: string | null;
  last_inbound_at: string | null;
  paused: boolean | null;
}

const DAY = 864e5;

export type CohortReport = Awaited<ReturnType<typeof buildReport>>;

export async function buildReport(sinceDays: number) {
  const since = new Date(Date.now() - sinceDays * DAY).toISOString();

  const [{ data: bizRaw }, { data: stepsRaw }, { data: outcomesRaw }, { data: commitmentsRaw }, { data: mapRaw }, { data: safetyRaw }] =
    await Promise.all([
      db().from("businesses").select("id, country, biz_stage, baseline_tier, created_at, current_plan_id, last_inbound_at, paused"),
      db().from("plan_steps").select("id, plan_id, domain, status"),
      db().from("outcomes").select("business_id, effect, created_at"),
      db().from("commitments").select("business_id, status"),
      db().from("business_map").select("business_id, domain, status"),
      // Not the operational notes (knowledge_signal, plan_strategy,
      // plan_build_timing): they are not guardrail checks.
      NOT_GUARDRAIL_CHECKS.reduce((q, name) => q.neq("check_name", name), db().from("safety_events").select("check_name, outcome, engine").gte("created_at", since)),
    ]);

  const businesses = (bizRaw as Row[]) ?? [];
  const outcomes = (outcomesRaw as { business_id: string; effect: string; created_at: string }[]) ?? [];
  const commitments = (commitmentsRaw as { business_id: string; status: string }[]) ?? [];
  const maps = (mapRaw as { business_id: string; domain: string; status: string }[]) ?? [];
  const safety = (safetyRaw as { check_name: string; outcome: string; engine: string }[]) ?? [];
  const steps = (stepsRaw as { plan_id: string; domain: string | null; status: string }[]) ?? [];

  const withPlan = businesses.filter((b) => b.current_plan_id);
  const activeWeek = businesses.filter((b) => b.last_inbound_at && Date.now() - new Date(b.last_inbound_at).getTime() < 7 * DAY);
  const activeMonth = businesses.filter((b) => b.last_inbound_at && Date.now() - new Date(b.last_inbound_at).getTime() < 30 * DAY);

  const tierOf = new Map(businesses.map((b) => [b.id, b.baseline_tier ?? "unknown"]));
  const tiers = ["low", "mid", "high", "unknown"];

  const byTier = Object.fromEntries(
    tiers.map((tier) => {
      const ids = new Set(businesses.filter((b) => (b.baseline_tier ?? "unknown") === tier).map((b) => b.id));
      const theirs = outcomes.filter((o) => ids.has(o.business_id));
      const done = commitments.filter((c) => ids.has(c.business_id) && c.status === "done").length;
      const all = commitments.filter((c) => ids.has(c.business_id)).length;
      const greens = maps.filter((m) => ids.has(m.business_id) && m.status === "green").length;
      return [
        tier,
        {
          businesses: ids.size,
          outcomes_reported: theirs.length,
          better: theirs.filter((o) => o.effect === "better").length,
          same: theirs.filter((o) => o.effect === "same").length,
          worse: theirs.filter((o) => o.effect === "worse").length,
          too_early: theirs.filter((o) => o.effect === "too_early").length,
          commitments_done_rate: all ? Number((done / all).toFixed(3)) : null,
          areas_green: greens,
          areas_green_per_business: ids.size ? Number((greens / ids.size).toFixed(2)) : null,
        },
      ];
    }),
  );

  // The number the ethical commitment actually turns on.
  const lowTier = byTier.low as { better: number; worse: number; outcomes_reported: number };
  const highTier = byTier.high as { better: number; worse: number; outcomes_reported: number };
  const rate = (t: { better: number; outcomes_reported: number }) => (t.outcomes_reported ? t.better / t.outcomes_reported : null);
  const lowRate = rate(lowTier);
  const highRate = rate(highTier);

  const harmSignal =
    lowRate === null || highRate === null
      ? "Not enough outcome check-ins yet to compare tiers. This is the number to watch; it needs real pilot traffic before it means anything."
      : lowRate + 0.15 < highRate
        ? `WATCH THIS: weaker businesses report improvement at ${(lowRate * 100).toFixed(0)}% against ${(highRate * 100).toFixed(0)}% for stronger ones. PRODUCT-DEFINITION 6.1 commits to pausing and reviewing if below-median businesses trend worse. Review before growing the cohort.`
        : `Weaker businesses report improvement at ${(lowRate * 100).toFixed(0)}%, stronger at ${(highRate * 100).toFixed(0)}%. No divergence that meets the review threshold.`;

  const byCountry = Object.fromEntries(
    [...new Set(businesses.map((b) => b.country))].map((c) => {
      const theirs = businesses.filter((b) => b.country === c);
      return [c, { onboarded: theirs.length, with_plan: theirs.filter((b) => b.current_plan_id).length }];
    }),
  );

  const unavailableChecks = safety.filter((e) => e.outcome === "unavailable").length;

  return {
    generated_at: new Date().toISOString(),
    window_days: sinceDays,
    cohort: {
      onboarded: businesses.length,
      completed_a_plan: withPlan.length,
      weekly_active: activeWeek.length,
      monthly_active: activeMonth.length,
      opted_out_of_nudges: businesses.filter((b) => b.paused).length,
    },
    progress: {
      steps_total: steps.length,
      steps_done: steps.filter((s) => s.status === "done").length,
      steps_skipped: steps.filter((s) => s.status === "skipped").length,
      commitments_open: commitments.filter((c) => c.status === "open").length,
      commitments_done: commitments.filter((c) => c.status === "done").length,
      areas_green_total: maps.filter((m) => m.status === "green").length,
    },
    by_country: byCountry,
    by_baseline_tier: byTier,
    harm_monitoring: harmSignal,
    guardrails: {
      checks_in_window: safety.length,
      checks_that_could_not_run: unavailableChecks,
      note: unavailableChecks
        ? "Some advice went out with a guardrail switched off. Investigate before reporting these numbers to anyone."
        : "Every check that was asked for ran.",
    },
    omitted_on_purpose: [
      "No business ids, phone numbers, names or anything a person wrote. Aggregates only.",
      "No gender or age split, which PRODUCT-DEFINITION 4.8 asks for: Charles does not collect either, and inferring them would be worse than not reporting them.",
    ],
  };
}

export function toCsv(report: CohortReport): string {
  const lines: string[] = ["metric,segment,value"];
  const add = (metric: string, segment: string, value: unknown) => lines.push(`${metric},${segment},${value ?? ""}`);
  for (const [k, v] of Object.entries(report.cohort)) add(k, "all", v);
  for (const [k, v] of Object.entries(report.progress)) add(k, "all", v);
  for (const [country, v] of Object.entries(report.by_country)) {
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) add(k, country, n);
  }
  for (const [tier, v] of Object.entries(report.by_baseline_tier)) {
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) add(k, `baseline_${tier}`, n);
  }
  return lines.join("\n");
}


// ── Small numbers identify people ────────────────────────────────

/**
 * Below this many businesses in a cell, "one weak-tier business reported no
 * change" is not an aggregate, it is a person. Admins see everything; sponsors
 * see this.
 */
export const MIN_CELL = 5;

const SUPPRESSED = { suppressed: true, businesses: `<${MIN_CELL}` } as const;

export function suppressSmall(report: CohortReport, min = MIN_CELL): Record<string, unknown> {
  if (report.cohort.onboarded < min) {
    return {
      generated_at: report.generated_at,
      window_days: report.window_days,
      cohort: { onboarded: `<${min}` },
      suppressed: true,
      note: `Fewer than ${min} businesses so far. Numbers are withheld until a group is large enough that no individual can be picked out of it.`,
    };
  }
  const tiers = report.by_baseline_tier as Record<string, { businesses: number }>;
  const countries = report.by_country as Record<string, { onboarded: number }>;
  const tierOk = (t: string) => (tiers[t]?.businesses ?? 0) >= min;

  return {
    ...report,
    by_baseline_tier: Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k, v.businesses >= min ? v : SUPPRESSED])),
    by_country: Object.fromEntries(Object.entries(countries).map(([k, v]) => [k, v.onboarded >= min ? v : SUPPRESSED])),
    // The comparison is only safe to state when both ends are big enough.
    harm_monitoring: tierOk("low") && tierOk("high")
      ? report.harm_monitoring
      : `Not enough businesses in each starting tier (at least ${min}) to compare them without singling out individuals. Ask the operator for the full figure.`,
    withheld_for_privacy: `Any group of fewer than ${min} businesses is shown as suppressed.`,
  };
}

// ── Sponsor tokens ───────────────────────────────────────────────

export const SPONSOR_PREFIX = "sp_";

/** The token is shown once, at minting. Only its hash is stored. */
export async function mintSponsorToken(label: string): Promise<{ token: string } | { error: string }> {
  const clean = label.trim().slice(0, 80);
  if (!clean) return { error: "A sponsor token needs a label so it can be revoked by name." };
  const token = `${SPONSOR_PREFIX}${mintToken()}`;
  const { error } = await db().from("sponsor_tokens").insert({ token_hash: hashSecret(token), label: clean });
  if (error) return { error: error.message };
  return { token };
}

export async function revokeSponsorToken(label: string): Promise<number> {
  const { data, error } = await db()
    .from("sponsor_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("label", label.trim())
    .is("revoked_at", null)
    .select("token_hash");
  if (error) throw error;
  return (data ?? []).length;
}

export async function sponsorForToken(token: string): Promise<{ label: string } | null> {
  if (!token || !token.startsWith(SPONSOR_PREFIX)) return null;
  const { data } = await db().from("sponsor_tokens").select("label, revoked_at").eq("token_hash", hashSecret(token)).maybeSingle();
  const row = data as { label: string; revoked_at: string | null } | null;
  if (!row || row.revoked_at) return null;
  // Then'd so it actually runs (a bare `void` builder never sends).
  void db().from("sponsor_tokens").update({ last_used_at: new Date().toISOString() }).eq("token_hash", hashSecret(token)).then(
    ({ error }) => void (error && console.warn("sponsor: last_used_at not recorded", error)),
    (err) => console.warn("sponsor: last_used_at not recorded", err),
  );
  return { label: row.label };
}
