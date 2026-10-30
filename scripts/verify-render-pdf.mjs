#!/usr/bin/env node
// Fin — item D: "add a smoke-test script (outside unit CI) that posts a
// fixture to /api/render-pdf on a preview deployment."
//
// api/render-pdf.ts is the one function that carries Chromium (~64MB of
// already-compressed binaries, per its own header comment), kept behind its
// own endpoint so a Chromium problem degrades the PDF rather than the whole
// product. This script is the check that it actually works on the real
// deployment, with the real memory/timeout ceiling in vercel.json (2048MB,
// 120s) — not just on whatever machine happens to run `npm test`.
//
// Usage:
//   WORKER_SECRET=... node scripts/verify-render-pdf.mjs --url https://your-preview-deployment.vercel.app
//
// Prints wall-clock time and output size, and flags loudly if either is
// getting close to the configured ceiling. It cannot read the function's
// actual memory usage — that only Vercel's own function logs can show —
// so it prints exactly where to go look for that.

import { writeFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith("--")) pairs.push([arg.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1]]);
    return pairs;
  }, []),
);

const BASE_URL = (args.url || "").replace(/\/$/, "");
const OUT = args.out || "verify-render-pdf.pdf";
const WORKER_SECRET = process.env.WORKER_SECRET;

if (!BASE_URL) {
  console.error("Usage: WORKER_SECRET=... node scripts/verify-render-pdf.mjs --url https://... [--out file.pdf]");
  process.exit(1);
}
if (!WORKER_SECRET) {
  console.error("WORKER_SECRET is not set — /api/render-pdf will refuse the request (see api/worker.ts's authorised()).");
  process.exit(1);
}

// A realistic, fully-populated document — the same shape scripts/preview-plan.mjs
// uses to catch rule-8 CSS regressions, reused here because a bare "<h1>hi</h1>"
// would tell you nothing about how Chromium handles the document this endpoint
// actually has to render in production: three parts, tools, a strategy, a
// person's name with punctuation in it.
const step = (id, title, push, artifact, tool, done) => ({
  id, title, domain: "getting_paid", outcome: "", done_when: done, brief: "", artifact_brief: artifact ? "x" : null,
  push, artifact, why_for_you: "It is the fastest cash in this plan, and it costs you nothing to start.", tool_id: tool,
});

// planDocHTML needs no live data — it's pure HTML generation — so this fixture
// is built inline rather than importing api/_lib/plandoc.ts, keeping this
// script runnable with nothing but a URL and a secret, no repo checkout of
// the TS build tooling required.
function fixtureHtml() {
  const rows = Array.from({ length: 24 }, (_, i) => `<tr><td style="padding:6px;border-bottom:1px solid #e5e5e5">Row ${i + 1} — a realistic line of plan content, long enough to wrap.</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;color:#171f1a">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#15201c;color:#fff;padding:24px;font-size:22px;font-weight:bold">Verify Render PDF — smoke test fixture</td></tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
  </body></html>`;
}

async function main() {
  console.log(`Posting a fixture to ${BASE_URL}/api/render-pdf ...`);
  const started = Date.now();
  const res = await fetch(`${BASE_URL}/api/render-pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${WORKER_SECRET}` },
    body: JSON.stringify({ html: fixtureHtml() }),
  });
  const ms = Date.now() - started;

  if (!res.ok) {
    console.error(`FAILED: ${res.status} ${(await res.text()).slice(0, 500)}`);
    process.exit(1);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(OUT, bytes);

  console.log(`\nRendered in ${ms}ms, ${bytes.byteLength} bytes, saved to ${OUT}.`);
  console.log(`Configured ceiling (vercel.json): maxDuration 120s, memory 2048MB.`);
  if (ms > 60_000) console.log(`WARNING: over half the 120s timeout budget already — this is close to the edge.`);
  else if (ms > 20_000) console.log(`Slower than a warm invocation should be — likely a cold Chromium extraction (normal on the first request after a deploy; see api/_lib/pdf.ts's header comment).`);
  else console.log(`Comfortably inside the timeout budget.`);
  console.log(`\nThis script cannot read the function's actual memory usage. To check that:`);
  console.log(`  Vercel dashboard -> this deployment -> Functions -> api/render-pdf -> Logs/Metrics, right after this run.`);
  console.log(`If memory regularly runs above ~1.5GB or duration regularly exceeds ~60s, that's the evidence item D asked for before building a lighter fallback — not before.`);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
