// Charles — prove the plan document still prints.
//
// CLAUDE.md rule 8 exists because the first plan document rendered as an
// unstyled, colourless wall of text in some environments: CSS Grid, Flexbox and
// custom properties all failed silently. The document is therefore built like
// HTML email — real <table> layout, hard-coded hex, no var() — and the
// definition of done says it has to be checked in an actual browser's
// print-to-PDF, not just on screen.
//
// This script is that check, runnable by anyone:
//
//   node --experimental-strip-types --import ./scripts/register-ts.mjs \
//        scripts/preview-plan.mjs [outdir]
//
// It renders a realistic fixture — one household, three parts, artifacts, a
// tool with a verified cost — writes plan.html and plan.pdf, and fails loudly if any banned CSS
// construct has crept back in.
//
// Needs a Chromium. It looks for one in the usual places; set CHROME_PATH to
// point it somewhere else.

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { planDocHTML } from "../api/_lib/plandoc.js";
import { ZA } from "./plan-fixtures.mjs";
import { PDF_OPTIONS } from "../api/_lib/pdfpage.js";

const OUT = process.argv[2] ?? "preview";
mkdirSync(OUT, { recursive: true });

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  ...["1243", "1194", "1200", "1208"].flatMap((v) => [`/opt/pw-browsers/chromium-${v}/chrome-linux64/chrome`, `/opt/pw-browsers/chromium-${v}/chrome-linux/chrome`]),
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
const html = planDocHTML(ZA);

writeFileSync(join(OUT, "plan.html"), html);

// The structural half of rule 8. A renderer that silently ignores these would
// show a colourless wall of text, which is exactly the failure being prevented.
const banned = [
  [/display:\s*grid/i, "CSS Grid"],
  [/display:\s*flex/i, "Flexbox"],
  [/var\(--/, "CSS custom properties"],
  [/margin:\s*-/, "negative-margin bleed"],
];
const found = banned.filter(([re]) => re.test(html)).map(([, name]) => name);
if (found.length) {
  console.error(`FAIL: the plan document now uses ${found.join(", ")}. See CLAUDE.md rule 8.`);
  process.exit(1);
}
if (!html.includes('<table role="presentation"')) {
  console.error("FAIL: the plan document is no longer built from presentation tables. See CLAUDE.md rule 8.");
  process.exit(1);
}

if (!CHROME) {
  console.log(`Wrote ${join(OUT, "plan.html")} (${html.length} bytes). No Chromium found, so no PDF — set CHROME_PATH to render one.`);
  process.exit(0);
}

// SERVER_FONTS=1 prints with only the fonts the production renderer has:
// @sparticuz/chromium's Open Sans plus fonts/ (see api/_lib/pdf.ts). That is
// the font set round 17's Nigerian PDF lost every naira sign under.
let env = process.env;
if (process.env.SERVER_FONTS) {
  const conf = join(OUT, "fonts.conf");
  const openSans = process.env.OPEN_SANS_DIR ?? "/tmp/spf/fonts";
  writeFileSync(conf, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${openSans}</dir>${process.env.SERVER_FONTS === "bare" ? "" : `<dir>${join(process.cwd(), "fonts")}</dir>`}<cachedir>${join(OUT, "fc-cache")}</cachedir></fontconfig>`);
  env = { ...process.env, FONTCONFIG_FILE: resolve(conf) };
}
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, env, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: "domcontentloaded" });
const pdf = await page.pdf(PDF_OPTIONS);
writeFileSync(join(OUT, "plan.pdf"), pdf);
await page.setViewport({ width: 800, height: 1400 });
await page.screenshot({ path: join(OUT, "plan-top.png") });
for (const p of await browser.pages()) await p.close();
await browser.close();
console.log(`OK — ${join(OUT, "plan.html")} (${html.length} bytes), ${join(OUT, "plan.pdf")} (${pdf.length} bytes), ${join(OUT, "plan-top.png")}`);
console.log("Rule 8 checks passed: presentation tables only, no grid, no flex, no custom properties.");
