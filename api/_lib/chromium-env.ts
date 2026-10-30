// Fin — makes @sparticuz/chromium correctly detect Vercel's Node 22
// runtime as Amazon-Linux-2023-based, without depending on a Vercel
// dashboard setting this repo cannot see or control.
//
// THE BUG THIS FIXES (2026-09-22, live production, every /api/render-pdf
// call): "Failed to launch the browser process! ... /tmp/chromium: error
// while loading shared libraries: libnss3.so: cannot open shared object
// file". Read directly from @sparticuz/chromium's own published source:
//
// - Node 20+ on AWS Lambda (and on Vercel, which runs Node Functions on a
//   similar Firecracker/Lambda-style base) moved from Amazon Linux 2 to
//   Amazon Linux 2023, which does NOT ship libnss3.so / libnspr4.so / etc.
//   in the base image the way AL2 did.
// - @sparticuz/chromium ships an extra `al2023.tar.br` bundle containing
//   exactly those missing shared libraries, but only extracts it (and only
//   points LD_LIBRARY_PATH at it) when its own `isRunningInAmazonLinux2023()`
//   check returns true.
// - That check (build/esm/helper.js in the package) looks for
//   AWS_EXECUTION_ENV, AWS_LAMBDA_JS_RUNTIME or CODEBUILD_BUILD_IMAGE
//   containing "20.x"/"22.x"/"24.x", OR — as of @sparticuz/chromium
//   133.0.0 — `process.env.VERCEL` together with Node >=20.
// - The version this project had pinned (131.0.1) predates that Vercel
//   fallback entirely: its equivalent function (`isRunningInAwsLambdaNode20`)
//   only recognised AWS_EXECUTION_ENV / AWS_LAMBDA_JS_RUNTIME /
//   CODEBUILD_BUILD_IMAGE, with no Vercel-specific case at all. On real AWS
//   Lambda, AWS_EXECUTION_ENV is set automatically, so this was invisible
//   there — it only ever broke on Vercel. package.json now pins
//   @sparticuz/chromium to 147.0.0 (the newest release whose own package.json
//   still declares "engines": {"node": ">=20.11.0"} rather than the >=22.17.0
//   that 147.0.1+ requires — stricter than this project's own ">=22.6", and
//   not something this repo can confirm Vercel's configured Node 22 patch
//   satisfies), which restores correct Vercel detection. But Vercel's own
//   `VERCEL` runtime variable is only populated at runtime when the project
//   has "Enable access to System Environment Variables" turned on (Project
//   Settings -> Environment Variables) —
//   https://vercel.com/docs/environment-variables/system-environment-variables.
//   Nothing in this repository can see or change that dashboard setting.
//
// So: rather than depend on the version bump AND a dashboard checkbox we
// cannot verify, set AWS_LAMBDA_JS_RUNTIME ourselves, derived from the Node
// version actually running. This is the exact variable Vercel's own support
// team tells customers to set by hand for this exact failure
// (community.vercel.com/t/puppeteer-on-node-22-x-missing-libnspr4-so/23372,
// "Vercel Support's Official Fix") — the only difference is we do it in code,
// so the fix travels with the repo instead of living in a dashboard setting
// someone has to remember to keep in sync with whatever Node version this
// project runs next.
//
// Never overrides a value the platform already set: real AWS Lambda sets
// AWS_EXECUTION_ENV itself, and if AWS_LAMBDA_JS_RUNTIME is already present
// (Netlify, or a future Vercel change) that is trusted as-is.
export function ensureLambdaRuntimeEnvSet(env: NodeJS.ProcessEnv = process.env): void {
  if (env.AWS_EXECUTION_ENV || env.AWS_LAMBDA_JS_RUNTIME) return;
  const nodeMajor = process.versions.node.split(".")[0];
  env.AWS_LAMBDA_JS_RUNTIME = `nodejs${nodeMajor}.x`;
}

// Run it now, at import time. @sparticuz/chromium reads these env vars both
// at its own module-evaluation time and again inside executablePath(), so
// this must be imported before "@sparticuz/chromium" — see pdf.ts, which
// imports this file first for exactly that reason.
ensureLambdaRuntimeEnvSet();
