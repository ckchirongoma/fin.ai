// Charles — draw the five demo cards at phone width, as a person would see
// them from a WhatsApp link, and report any overflow or script error.
//
//   node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/preview-cards.mts <out-dir>
//
// Writes card-<kind>.html, card-<kind>.png (the whole card at 2x) and
// card-<kind>-site.png (the top of it, lighter) into <out-dir>. The -site
// ones are what public/img/ holds for the landing page: copy them over when
// a card changes. Needs a Chromium: CHROME_PATH, or the Playwright one on this box.

import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

process.env.SUPABASE_URL ??= "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "preview";
process.env.PUBLIC_BASE_URL ??= "https://charles.test";

const { cardHTML, demoCard, CARD_KINDS } = await import("../api/_lib/cards.ts");

const out = process.argv[2] ?? "card-previews";
mkdirSync(out, { recursive: true });
const guess = ["1243", "1194", "1200", "1208"].flatMap((v) => [`/opt/pw-browsers/chromium-${v}/chrome-linux64/chrome`, `/opt/pw-browsers/chromium-${v}/chrome-linux/chrome`]).find((p) => existsSync(p));
const executablePath = process.env.CHROME_PATH ?? guess;
if (!executablePath) {
  console.error("Set CHROME_PATH to a Chrome or Chromium binary.");
  process.exit(2);
}
const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
let bad = 0;
try {
  for (const kind of CARD_KINDS) {
    const html = cardHTML(kind, demoCard(kind) as never, { demo: true });
    writeFileSync(`${out}/card-${kind}.html`, html);
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const errs: string[] = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    await page.setContent(html, { waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 800));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({ path: `${out}/card-${kind}.png`, fullPage: true });
    // The landing page's version: the top of the card, lighter.
    await page.setViewport({ width: 390, height: 760, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true });
    await page.screenshot({ path: `${out}/card-${kind}-site.png`, clip: { x: 0, y: 0, width: 390, height: 760 } });
    console.log(`${kind}: ${height}px tall, overflow ${overflow}px${errs.length ? `, ERRORS: ${errs.join(" | ")}` : ""}`);
    if (overflow > 0 || errs.length) bad++;
    await page.close();
  }
} finally {
  await browser.close();
}
process.exit(bad ? 1 : 0);
