// Fin — the example plan the landing page links to, rendered by the real template.
//
//   node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/landing-example-plan.ts public/example-plan.html
import { writeFileSync } from "node:fs";
import { planDocHTML } from "../api/_lib/plandoc.ts";
import { EXAMPLE_PLAN } from "./example-plan-data.ts";
writeFileSync(process.argv[2] ?? "example-plan.html", planDocHTML(EXAMPLE_PLAN));
