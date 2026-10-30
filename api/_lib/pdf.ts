// Charles — turning the plan HTML into a real PDF.
//
// This module is imported by EXACTLY ONE function (api/render-pdf.ts), and that
// is deliberate. Vercel traces dependencies per entrypoint, and
// @sparticuz/chromium's bin directory is ~64MB of already-Brotli-compressed
// binaries that the deployment zip cannot shrink. Any function importing this
// carries all of it and risks blowing the bundle-size limit — so the worker,
// the webhook and the connector must never import it directly. They go through
// _lib/pdfclient.ts, which is a fetch call.
//
// Chromium is also the most likely thing here to fail outright: cold starts,
// memory ceilings, platform changes. Every caller is written so that a failed
// PDF costs the person nothing — they already have the plan outline in chat and
// the full document on the website.

// Must come before the @sparticuz/chromium import: it decides, at its own
// module-load time, whether this is an Amazon-Linux-2023-compatible runtime
// (and therefore needs its extra libnss3.so-and-friends bundle) by reading
// env vars this file sets. See chromium-env.ts for the full story of why
// that decision was going wrong on Vercel's Node 22 runtime.
import "./chromium-env.js";
import { PDF_OPTIONS } from "./pdfpage.js";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// @sparticuz/chromium dropped its `defaultViewport` static getter after
// 133.0.0 (it is not present in the 147.0.0 this project now pins — verified
// against the package's own published build output, not assumed). This is
// the same viewport it used to return, kept identical so switching versions
// does not silently change how the PDF renders.
const VIEWPORT = {
  deviceScaleFactor: 1,
  hasTouch: false,
  height: 1080,
  isLandscape: true,
  isMobile: false,
  width: 1920,
};

// The only font @sparticuz/chromium ships is Open Sans, and Open Sans has no
// naira or cedi sign, no arrow and no status dot: round 17's Nigerian PDF
// printed 0 of its 96 naira signs and the Ghanaian one 0 of 69. fonts/ holds
// a small symbols-only cut of DejaVu Sans ("Charles Symbols": currency signs,
// arrows, bullets, shapes — no letters, so the text itself stays Open Sans
// exactly as before). Chromium's fontconfig reads /tmp/fonts, so the files are
// copied there before launch; /var/task/fonts, where Vercel puts the
// includeFiles copy, is on fontconfig's list too.
const EXTRA_FONTS = ["CharlesSymbols.ttf", "CharlesSymbols-Bold.ttf"];
export function installExtraFonts(): number {
  const here = dirname(fileURLToPath(import.meta.url));
  const from = [join(process.cwd(), "fonts"), join(here, "..", "..", "fonts")].find((d) => existsSync(join(d, EXTRA_FONTS[0]!)));
  if (!from) {
    console.error("pdf: fonts/ not found — currency signs and arrows will be missing from the PDF");
    return 0;
  }
  const to = join(tmpdir(), "fonts", "charles");
  mkdirSync(to, { recursive: true });
  let n = 0;
  for (const f of EXTRA_FONTS) {
    if (!existsSync(join(to, f))) copyFileSync(join(from, f), join(to, f));
    n += 1;
  }
  return n;
}

/**
 * Round 24, live: two renders arrived together on a cold instance, both
 * unpacked Chromium into /tmp, and the second tried to start the binary
 * while the first was still writing it: "spawn ETXTBSY", a 500, and an
 * immediate alert for something that worked 3s later. One unpacking per
 * instance now, shared by every render that arrives while it runs (a failed
 * one is tried again by the next render, not remembered).
 */
let unpacking: Promise<string> | null = null;
export function sharedExecutablePath(unpack: () => Promise<string> = () => chromium.executablePath()): Promise<string> {
  unpacking ??= unpack().catch((err) => {
    unpacking = null;
    throw err;
  });
  return unpacking;
}
/** Tests only. */
export function __resetExecutablePath(): void {
  unpacking = null;
}

/** "Text file busy" and its kin: the binary is still being written. Worth a moment and another try; nothing else is. */
const BUSY_RE = /\b(?:ETXTBSY|EBUSY)\b|text file busy/i;

/** Starts the browser, waiting out a binary still being written (up to two more tries). */
export async function launchWithRetry<T>(launch: () => Promise<T>, waitMs = 400): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await launch();
    } catch (err) {
      if (i >= 2 || !BUSY_RE.test(String((err as Error)?.message ?? err))) throw err;
      console.warn(`pdf: Chromium was still being unpacked (${String((err as Error)?.message ?? err).slice(0, 80)}); trying again`);
      await new Promise((r) => setTimeout(r, waitMs * (i + 1)));
    }
  }
}

export async function htmlToPdf(html: string): Promise<Uint8Array> {
  const executablePath = await sharedExecutablePath();
  installExtraFonts();
  const browser = await launchWithRetry(() =>
    puppeteer.launch({
      args: chromium.args,
      defaultViewport: VIEWPORT,
      executablePath,
      headless: true,
    }),
  );
  try {
    const page = await browser.newPage();
    // The document is tables and inline styles by design (rule 8): no scripts,
    // no webfonts, no remote anything. Turning JavaScript off makes that a
    // property of the renderer rather than a hope about the input — even if an
    // escaping bug ever let owner text smuggle markup in, it renders inert.
    await page.setJavaScriptEnabled(false);
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const pdf = await page.pdf(PDF_OPTIONS);
    return new Uint8Array(pdf);
  } finally {
    await closeQuietly(browser as never);
  }
}

/**
 * Closing the browser can hang while pages are still open, and a hang inside a
 * serverless function is a full-duration timeout rather than an error. Close
 * every page first.
 */
export async function closeQuietly(browser: { pages: () => Promise<{ close: () => Promise<void> }[]>; close: () => Promise<void> }): Promise<void> {
  try {
    for (const page of await browser.pages()) await page.close().catch(() => undefined);
  } catch {
    /* nothing useful to do */
  }
  await browser.close().catch(() => undefined);
}
