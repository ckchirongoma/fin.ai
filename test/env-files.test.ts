// Charles — the two env files name every variable the code reads, and hold no secret.
//
// .env.vercel is pasted into Vercel's dashboard; .env.example is copied for
// local work. A variable the code reads that neither file names is one the
// founder cannot know to set. A value in either that looks like a real key
// is a leak. Both are checked here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const names = (file: string): Map<string, string> =>
  new Map(
    readFileSync(join(root, file), "utf8")
      .split("\n")
      .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()] as [string, string]),
  );

/** Set by the platform, the test runner or a local script; never by the founder. */
const PLATFORM = new Set(["VERCEL", "VERCEL_URL", "VERCEL_REGION", "VERCEL_GIT_COMMIT_SHA", "TRACKING_OFF", "WA_STRICT_LIMITS", "CHROME_PATH", "EVAL_MODEL", "EVAL_JUDGE_MODEL", "OPEN_SANS_DIR", "SERVER_FONTS", "INLINE_WORKER", "NODE_ENV"]);

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|mjs)$/.test(f) ? [p] : [];
  });

test("every variable the code reads is in .env.vercel and .env.example, unless the platform sets it", () => {
  const used = new Set<string>();
  for (const f of walk(join(root, "api"))) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\bread\("([A-Z][A-Z0-9_]*)"\)/g)) used.add(m[1]!);
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) used.add(m[1]!);
  }
  const vercel = names(".env.vercel");
  const example = names(".env.example");
  const missing = [...used].filter((n) => !PLATFORM.has(n) && (!vercel.has(n) || !example.has(n)));
  assert.deepEqual(missing, [], "add these to .env.vercel and .env.example");
});

test(".env.vercel is paste-ready: only comments and KEY=value lines, required ones first, blanks or safe defaults, no secret", () => {
  const lines = readFileSync(join(root, ".env.vercel"), "utf8").split("\n");
  for (const l of lines) assert.ok(l === "" || l.startsWith("#") || /^[A-Z][A-Z0-9_]*=.*$/.test(l), `not a .env line: ${l}`);
  const vercel = names(".env.vercel");
  const order = [...vercel.keys()];
  assert.deepEqual(order.slice(0, 6), ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENROUTER_API_KEY", "WHATSAPP_APP_SECRET", "WORKER_SECRET", "PUBLIC_BASE_URL"]);
  for (const [k, v] of vercel) {
    assert.ok(v === "" || ["charles-verify", "v21.0", "5", "0"].includes(v), `${k} carries a value that is not a safe default: ${v}`);
    assert.doesNotMatch(v, /sk-or-v1-|EAA[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}|re_[A-Za-z0-9]{20,}/, `${k} looks like a real key`);
  }
  // The founder's address lives only in the ALERT_EMAIL_TO setting, never in a file.
  assert.doesNotMatch(readFileSync(join(root, ".env.vercel"), "utf8"), /@(?:outlook|gmail|yahoo)\.com/i);
});

test("the README deploy button names exactly the required variables, and points at .env.vercel for the rest", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const m = /vercel\.com\/new\/clone\?[^)]*env=([A-Z_,]+)/.exec(readme);
  assert.ok(m, "no deploy button");
  assert.deepEqual(m![1]!.split(","), ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENROUTER_API_KEY", "WHATSAPP_APP_SECRET", "WORKER_SECRET", "SESSION_SECRET", "CRON_SECRET", "WHATSAPP_VERIFY_TOKEN"]);
  assert.match(readme, /envLink=https%3A%2F%2Fgithub\.com%2Fckchirongoma%2Ffin\.ai%2Fblob%2Fmain%2F\.env\.vercel/);
});
