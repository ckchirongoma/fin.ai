// Charles — the scheduled follow-up pass.
//
// Vercel calls this with a GET and an `Authorization: Bearer $CRON_SECRET`
// header. It fails CLOSED: with no secret configured it refuses, because a
// misconfigured deploy must not leave an endpoint that sends WhatsApp messages
// open to anyone who guesses the URL.
//
// Cron schedules are UTC, always. Charles's five markets are UTC+0 (Ghana),
// UTC+1 (Nigeria), UTC+2 (South Africa) and UTC+3 (Kenya, Uganda), and none of them
// observes daylight saving — which is the one thing that makes a single
// morning schedule workable. See vercel.json for the chosen time.
//
// There are no retries and no failure alerts on a missed cron run, on any
// plan. So this job is idempotent and the per-business caps live in the
// database, not in the schedule: running it twice sends nothing twice.

import { authorised } from "../worker.js";
import { runNudgeSweep } from "../_lib/nudges.js";
import { errorText, track, trackFailure, tracked } from "../_lib/track.js";

async function handler(req: Request): Promise<Response> {
  if (!authorised(req)) {
    // Vercel's own call refused means CRON_SECRET is wrong or unset, and no
    // owner is followed up until someone notices. Anyone else is noise.
    track("cron_failed", { category: "security", severity: "warn", alert: "digest", props: { cron: "nudges", reason: "unauthorised" }, fingerprint: "cron_failed:nudges:unauthorised", summary: "The nudges cron was called without the right secret and refused" });
    return new Response("Forbidden", { status: 403 });
  }
  const started = Date.now();
  try {
    const result = await runNudgeSweep(200);
    console.log(`cron/nudges: ${JSON.stringify(result)}`);
    // One row per run, so a run that never happened is visible as a gap.
    // Each owner's skip, send or failure is its own nudge_* event.
    track("cron_ran", { category: "ops", ms: Date.now() - started, props: { cron: "nudges", considered: result.considered, sent: result.sent } });
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.log("cron/nudges failed", err);
    trackFailure("cron_failed", err, { ms: Date.now() - started, props: { cron: "nudges", reason: "threw" }, fingerprint: "cron_failed:nudges", summary: `The daily nudges run failed, so no owner was followed up today: ${errorText(err).slice(0, 140)}` });
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

const served = tracked("cron-nudges", "system", handler);
export const GET = served;
export const POST = served;
