// Fin — print the plan document the way production does, and check it.
//
// A stress plan (long name, a long unbroken link inside a
// ready-to-send message, many steps, every optional section filled) is
// rendered by planDocHTML, printed to A4 by real Chromium with the exact
// options api/_lib/pdf.ts uses, and checked for anything wider than the page.
// Rule 8 says the document must survive any renderer; this is the check that
// it survives the one that makes the PDF. It writes the PDF so a person can
// look at it too — the definition of done says "checked in an actual
// browser print-to-PDF, not just on screen".
//
// Usage:
//   CHROME_PATH=/path/to/chrome node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/check-plan-print.ts [out.pdf]
// (defaults: a Playwright Chromium under /opt/pw-browsers if present, out=plan-print-check.pdf)

import { writeFileSync, existsSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { planDocHTML, type PlanDocData } from "../api/_lib/plandoc.ts";
import { EXAMPLE_PLAN, step } from "./example-plan-data.ts";
const L = (s: string, n = 3) => Array(n).fill(s).join(" ");
const longUrl = "https://www.sassa.gov.za/Pages/SRD-Grant.aspx?utm_source=fin&utm_medium=whatsapp&reference=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
// The example household, stressed: a long name and one-liner, a long unbroken
// link inside a ready-to-send message, many steps, every optional section filled.
const d: PlanDocData = {
  ...EXAMPLE_PLAN,
  ctx: { ...EXAMPLE_PLAN.ctx, name: "Lerato Mokoena-Ndlovu (and her mother, some months)", one_liner: L(EXAMPLE_PLAN.ctx.one_liner, 2), goal: L(EXAMPLE_PLAN.ctx.goal, 2) },
  goal: [1, 2, 3].map((i) => ({ ...EXAMPLE_PLAN.goal[0]!, label: `Option ${i}: ${L(EXAMPLE_PLAN.goal[0]!.label, 2)}`, what: L(EXAMPLE_PLAN.goal[0]!.what, 2) })),
  rule: [1, 2].map(() => ({ ...EXAMPLE_PLAN.rule[0]!, rule: L(EXAMPLE_PLAN.rule[0]!.rule, 2) })),
  alternatives: [1, 2, 3].map((i) => ({ ...EXAMPLE_PLAN.alternatives[0]!, name: `Alternative ${i}: ${EXAMPLE_PLAN.alternatives[0]!.name}` })),
  map: EXAMPLE_PLAN.map.map((m) => ({ ...m, note: L(m.note, 2) })),
  plan: {
    ...EXAMPLE_PLAN.plan,
    workstreams: [
      ...(EXAMPLE_PLAN.plan.workstreams as unknown as { steps: unknown[] }[]),
      {
        id: "m_claim", title: L("Claim what you are owed", 1), domain: "income", why: "", why_for_you: L("You said the grant for the younger child was declined once.", 2),
        steps: [1, 2, 3, 4].map((i) =>
          step(i === 2 ? "cl2" : `x${i}`, "income", `Step ${i}: ${L("Check every grant and claim the one you are owed, with the papers in one place", 1)}`, L("Take the children's birth certificates and your ID to the SASSA office and ask what each child qualifies for."), L("you have been told, in writing, what each child qualifies for", 1), i === 1 ? "sassa_office" : null,
            i % 2 ? `Good day. I want to check the child support grant for my child. My reference is [reference]. ${longUrl}` : null, L("A grant you are owed is money that costs nothing to claim.", 2))),
      },
    ] as never,
  },
  strategy: { ...EXAMPLE_PLAN.strategy!, reading: [1, 2, 3].map(() => L(EXAMPLE_PLAN.strategy!.reading[0]!, 2)), risks: [1, 2, 3].map(() => EXAMPLE_PLAN.strategy!.risks[0]!) },
  tools: { ...EXAMPLE_PLAN.tools, sassa_office: { id: "sassa_office", name: "The SASSA office, with a very long name for testing the layout", url: longUrl, why: L("Where a grant is checked and claimed."), cost: "Free", verified_on: "2026-01-01", walkthrough: ["Find your nearest office on sassa.gov.za.", L("Take your ID, the children's birth certificates and proof of address.", 2), `Reference: ${longUrl}`, "Ask for the outcome in writing."] } },
  connectorUrl: "https://fin.example/mcp/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEfGhIjKlMnOp",
};

const html = planDocHTML(d);
const out = process.argv[2] ?? "plan-print-check.pdf";
const guess = ["1243", "1194", "1200", "1208"].flatMap((v) => [`/opt/pw-browsers/chromium-${v}/chrome-linux64/chrome`, `/opt/pw-browsers/chromium-${v}/chrome-linux/chrome`]).find((p) => existsSync(p));
const executablePath = process.env.CHROME_PATH ?? guess;
if (!executablePath) {
  console.error("Set CHROME_PATH to a Chrome or Chromium binary.");
  process.exit(2);
}
const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setJavaScriptEnabled(false);
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true, margin: { top: "0", bottom: "0", left: "0", right: "0" } });
  writeFileSync(out, pdf);

  // The same document at A4's printable width, in print media: nothing may be wider than the page.
  await page.setJavaScriptEnabled(true);
  await page.setViewport({ width: 794, height: 1123 });
  await page.emulateMediaType("print");
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  const wide = (await page.evaluate(`(() => {
    const W = document.documentElement.clientWidth;
    return [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > W + 1)
      .map((el) => el.tagName + ": " + (el.textContent || "").trim().slice(0, 60))
      .slice(0, 10);
  })()`)) as string[];
  const pages = (Buffer.from(pdf).toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  console.log(`wrote ${out} (${pages} pages)`);
  if (wide.length) {
    console.log("FAIL  something is wider than the page:\n  " + wide.join("\n  "));
    process.exitCode = 1;
  } else console.log("PASS  nothing is wider than an A4 page");
} finally {
  await browser.close();
}
