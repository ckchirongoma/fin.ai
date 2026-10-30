// Fin — api/render-pdf.ts, which had zero test coverage before this file.
//
// Item D of the founder's incident brief: "decouple and verify the PDF
// generation path." The generation itself (api/_lib/pdf.ts, real Chromium)
// is exercised end to end here too, on a platform that can actually run it —
// @sparticuz/chromium's binary is Linux-only (its own README FAQ says so),
// so the one test below that actually launches it is skipped on any other
// OS rather than failing with a bare `spawn ENOEXEC` that has nothing to do
// with whatever change triggered `npm test` on a contributor's Mac or
// Windows laptop. CI (.github/workflows/ci.yml) runs on ubuntu-latest, so it
// always gets the real thing: a real render, not a mock standing in for one.
// What's NOT testable even there is Vercel's actual memory ceiling, its
// cold-start extraction time, and whether @sparticuz/chromium correctly
// detects that specific runtime as Amazon-Linux-2023-compatible (Vercel's
// own env vars aren't present in CI either) — that's what
// scripts/verify-render-pdf.mjs is for, against a live deployment, and what
// api/_lib/chromium-env.ts's own header comment and test/chromium-env.test.ts
// cover for the detection logic itself.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.WORKER_SECRET = "test-worker-secret";
delete process.env.CRON_SECRET;
delete process.env.SUPABASE_URL; // render-pdf.ts touches neither Supabase nor OpenRouter

// env.ts snapshots process.env on first import, and a static `import` is
// hoisted above the assignments above regardless of where it's written — so
// this has to be a dynamic import, the same way every other test file here
// that sets env vars first does it.
const renderPdf: typeof import("../api/render-pdf.ts") = await import("../api/render-pdf.ts");

const url = "https://fin.example/api/render-pdf";
const auth = { Authorization: "Bearer test-worker-secret" };

describe("api/render-pdf.ts", () => {
  test("OPTIONS is a plain 204, no auth required", async () => {
    const res = await renderPdf.OPTIONS(new Request(url, { method: "OPTIONS" }));
    assert.equal(res.status, 204);
  });

  test("GET is refused — this endpoint only accepts POST", async () => {
    const res = await renderPdf.POST(new Request(url, { method: "GET" }));
    assert.equal(res.status, 405);
  });

  test("no Authorization header at all is refused", async () => {
    const res = await renderPdf.POST(new Request(url, { method: "POST", body: JSON.stringify({ html: "<p>x</p>" }) }));
    assert.equal(res.status, 403);
  });

  test("the wrong bearer token is refused", async () => {
    const res = await renderPdf.POST(
      new Request(url, { method: "POST", headers: { Authorization: "Bearer not-the-secret" }, body: JSON.stringify({ html: "<p>x</p>" }) }),
    );
    assert.equal(res.status, 403);
  });

  test("a body that isn't JSON is a 400, not a 500", async () => {
    const res = await renderPdf.POST(new Request(url, { method: "POST", headers: auth, body: "not json at all" }));
    assert.equal(res.status, 400);
  });

  test("empty html is refused before Chromium is ever touched", async () => {
    const res = await renderPdf.POST(new Request(url, { method: "POST", headers: auth, body: JSON.stringify({ html: "   " }) }));
    assert.equal(res.status, 400);
  });

  const linuxOnly = process.platform !== "linux" ? `@sparticuz/chromium's binary only runs on Linux (host platform: ${process.platform})` : false;

  test("a real document renders to a real PDF", { skip: linuxOnly }, async () => {
    const html = `<!doctype html><html><body>
      <table role="presentation" width="100%"><tr><td style="background:#15201c;color:#fff;padding:20px">Fin</td></tr></table>
      <p>A plan document, the way rule 8 requires: tables and inline styles, nothing else.</p>
    </body></html>`;
    const res = await renderPdf.POST(new Request(url, { method: "POST", headers: auth, body: JSON.stringify({ html }) }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "application/pdf");

    const bytes = new Uint8Array(await res.arrayBuffer());
    // "%PDF" is the file's own magic number — proof this is a real, valid
    // PDF and not just any 200 with the right header.
    assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "%PDF");
    assert.ok(bytes.byteLength > 500, "a one-paragraph real render should be more than a stub-sized response");
  });
});
