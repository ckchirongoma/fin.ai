// Charles — the quarterly knowledge check, run weekly so nothing drifts far.
//
// Rule 10: every price carries a verification date, and anything past 90 days
// is automatically hedged to "confirm at sign-up". That hedging is already
// structural in retrieval.ts. This is what makes somebody actually go and
// re-check them, by writing the list down where it can be seen.

import { authorised } from "../worker.js";
import { runFreshnessSweep } from "../_lib/freshness.js";
import { fillMissingEmbeddings } from "../_lib/embeddings.js";
import { errorText, track, trackFailure, tracked } from "../_lib/track.js";

async function handler(req: Request): Promise<Response> {
  if (!authorised(req)) {
    track("cron_failed", { category: "security", severity: "warn", alert: "digest", props: { cron: "freshness", reason: "unauthorised" }, fingerprint: "cron_failed:freshness:unauthorised", summary: "The freshness cron was called without the right secret and refused" });
    return new Response("Forbidden", { status: 403 });
  }
  const started = Date.now();
  try {
    const report = await runFreshnessSweep();
    // The same weekly pass keeps meaning-search current: any row with no
    // embedding, or whose text changed, is embedded now. Idempotent.
    const embedded = await fillMissingEmbeddings();
    // The stale list itself is logged by runFreshnessSweep (a warning email);
    // this is the run, with the counts. Rows that could not be embedded make
    // it a warning: meaning-search misses them until next week.
    track("cron_ran", {
      category: "ops",
      severity: embedded.failed ? "warn" : "info",
      alert: "digest",
      ms: Date.now() - started,
      props: {
        cron: "freshness",
        stale_knowledge: report.stale_knowledge.length,
        stale_tools: report.stale_tools.length,
        total_knowledge: report.total_knowledge,
        total_tools: report.total_tools,
        embedded_knowledge: embedded.knowledge,
        embedded_tools: embedded.tools,
        embed_failed: embedded.failed,
      },
      fingerprint: "cron_ran:freshness:embed_failed",
      summary: `The weekly freshness run could not embed ${embedded.failed} library row(s); meaning-search will miss them`,
    });
    return new Response(
      JSON.stringify({
        embedded,
        stale_knowledge: report.stale_knowledge.length,
        stale_tools: report.stale_tools.length,
        total_knowledge: report.total_knowledge,
        total_tools: report.total_tools,
        oldest: [...report.stale_tools, ...report.stale_knowledge].sort((a, b) => (b.days_old ?? 0) - (a.days_old ?? 0)).slice(0, 10),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.log("cron/freshness failed", err);
    trackFailure("cron_failed", err, { ms: Date.now() - started, props: { cron: "freshness", reason: "threw" }, fingerprint: "cron_failed:freshness", summary: `The weekly knowledge freshness run failed: ${errorText(err).slice(0, 140)}` });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

const served = tracked("cron-freshness", "system", handler);
export const GET = served;
export const POST = served;
