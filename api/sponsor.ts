// Fin — the cohort report a sponsor actually needs, and the one this
// product owes itself.
//
// PRODUCT-DEFINITION 4.8 asks for cohort metrics; section 6.1 asks for
// something harder and more important: outcomes SPLIT BY BASELINE TIER, with
// the commitment that "if below-median businesses trend worse than a comparison
// group, pause and review". That is not a reporting nicety. The evidence this
// whole product is built on — a field experiment where an AI mentor made the
// weakest businesses about 10% worse — says that is the failure mode, and a
// product that cannot see it cannot honour the promise not to cause it.
//
// Two deliberate limits:
//   - AGGREGATES ONLY. No business id, no phone number, no name, no free text
//     a person wrote. Sponsors get counts. An individual profile requires that
//     owner's explicit, per-sponsor opt-in, which is not built and is not
//     something this endpoint could grant.
//   - No gender or age split, which 4.8 lists. Fin does not ask for either,
//     and inferring them from a name or a voice would be worse than not
//     reporting them. Say so rather than quietly omitting it.

import { authorised } from "./worker.js";
import { buildReport, toCsv, suppressSmall, mintSponsorToken, revokeSponsorToken, sponsorForToken } from "./_lib/cohort.js";
import { noteRequestFailure, track, tracked } from "./_lib/track.js";

const bearer = (req: Request): string => {
  const h = req.headers.get("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
};

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  const url = new URL(req.url);
  const admin = authorised(req);

  // Minting and revoking sponsor tokens is the operator's job, and only theirs.
  const action = url.searchParams.get("action");
  if (action === "mint" || action === "revoke") {
    if (!admin) {
      // Somebody without the operator's secret trying to issue or cancel a sponsor key.
      track("sponsor_access_refused", { category: "security", severity: "warn", props: { reason: "not_operator", action }, fingerprint: "sponsor_access_refused:not_operator", summary: `Sponsor keys: a ${action} without the operator's secret was refused` });
      return new Response("Forbidden", { status: 403 });
    }
    if (req.method !== "POST") return new Response("Use POST", { status: 405 });
    const label = url.searchParams.get("label") ?? "";
    if (action === "mint") {
      const out = await mintSponsorToken(label);
      // A key issued is a credential out in the world: on the record by its label, never the key.
      track("sponsor_token_changed", { category: "security", severity: "error" in out ? "warn" : "info", props: { action, label: label.trim().slice(0, 80), ok: !("error" in out), ...("error" in out ? { error: String(out.error ?? "").slice(0, 160) } : {}) } });
      return "error" in out
        ? jsonRes({ error: out.error }, 400)
        : jsonRes({ label, token: out.token, note: "Shown once. Send it to the sponsor; it opens the cohort console and the sponsor MCP tool, and nothing else." });
    }
    const revoked = await revokeSponsorToken(label);
    track("sponsor_token_changed", { category: "security", props: { action, label: label.trim().slice(0, 80), ok: true, revoked } });
    return jsonRes({ label, revoked });
  }

  // Everyone else reads the report: the operator in full, a sponsor's token
  // with small groups suppressed.
  const sponsor = admin ? null : await sponsorForToken(bearer(req));
  if (!admin && !sponsor) {
    // The sponsor console's key form, refused: a mistyped or revoked key, or somebody guessing.
    track("sponsor_access_refused", { category: "security", severity: "warn", props: { reason: bearer(req) ? "bad_key" : "no_key" }, fingerprint: `sponsor_access_refused:${bearer(req) ? "bad_key" : "no_key"}`, summary: "The cohort report was refused: no valid sponsor key" });
    return new Response("Forbidden", { status: 403 });
  }

  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days") ?? 30)));
  try {
    const r = await buildReport(days);
    if (url.searchParams.get("format") === "csv") {
      // The CSV is built from the full report, so it is operator-only.
      if (!admin) {
        track("sponsor_access_refused", { category: "security", props: { reason: "csv_operator_only", label: sponsor?.label ?? null } });
        return new Response("The CSV export is for the operator. The console shows the same numbers.", { status: 403 });
      }
      track("sponsor_report_viewed", { props: { who: "operator", days, format: "csv" } });
      return new Response(toCsv(r), {
        status: 200,
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="fin-cohort-${r.generated_at.slice(0, 10)}.csv"`, "Cache-Control": "no-store" },
      });
    }
    track("sponsor_report_viewed", { props: { who: admin ? "operator" : "sponsor", label: sponsor?.label ?? null, days, format: "json" } });
    return jsonRes(admin ? r : suppressSmall(r));
  } catch (err) {
    // No event of its own: tracked() records the 500 as request_failed (emailed
    // at once), with the cause noted here.
    console.log("sponsor report failed", err);
    noteRequestFailure(err);
    return jsonRes({ error: (err as Error).message }, 500);
  }
}

const served = tracked("sponsor", "web", handler);
export const GET = served;
export const POST = served;
export const OPTIONS = served;
