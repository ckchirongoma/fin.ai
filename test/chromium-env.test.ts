// Charles — regression test for the PRIORITY 1 production crash (2026-09-22):
// every /api/render-pdf call failing with "Failed to launch the browser
// process! ... libnss3.so: cannot open shared object file".
//
// The root cause (confirmed by reading @sparticuz/chromium's own published
// source for both the old pinned version and the new one — see
// api/_lib/chromium-env.ts's header comment for the full trail) is that
// @sparticuz/chromium decides whether to extract its libnss3.so-and-friends
// bundle by checking a handful of environment variables, and Vercel's Node
// 22 runtime does not reliably populate the one the library checks for it
// (`VERCEL`) unless a dashboard setting we cannot see is on. This test
// exercises the actual decision logic our own code adds (ensureLambdaRuntimeEnvSet),
// with a fake env object rather than mutating the real process.env, so it is
// a real assertion on real behaviour, not a mock standing in for one — the
// same function this file imports is the one pdf.ts runs before touching
// @sparticuz/chromium at all.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ensureLambdaRuntimeEnvSet } from "../api/_lib/chromium-env.ts";

describe("api/_lib/chromium-env.ts", () => {
  test("sets AWS_LAMBDA_JS_RUNTIME from the real Node major version when nothing else signals the runtime", () => {
    const env = {} as NodeJS.ProcessEnv;
    ensureLambdaRuntimeEnvSet(env);
    const expectedMajor = process.versions.node.split(".")[0];
    assert.equal(env.AWS_LAMBDA_JS_RUNTIME, `nodejs${expectedMajor}.x`);
  });

  test("does nothing when AWS_EXECUTION_ENV already identifies a real Lambda runtime", () => {
    const env = { AWS_EXECUTION_ENV: "AWS_Lambda_nodejs22.x" } as NodeJS.ProcessEnv;
    ensureLambdaRuntimeEnvSet(env);
    assert.equal(env.AWS_LAMBDA_JS_RUNTIME, undefined, "should not add a redundant/conflicting signal next to a genuine one");
  });

  test("never clobbers an already-set AWS_LAMBDA_JS_RUNTIME (e.g. a platform-provided value)", () => {
    const env = { AWS_LAMBDA_JS_RUNTIME: "nodejs20.x" } as NodeJS.ProcessEnv;
    ensureLambdaRuntimeEnvSet(env);
    assert.equal(env.AWS_LAMBDA_JS_RUNTIME, "nodejs20.x");
  });

  test("the value it sets is one @sparticuz/chromium's own detection actually matches", () => {
    // This is the literal condition read out of the installed package's
    // build/esm/helper.js (isRunningInAmazonLinux2023): it treats
    // AWS_LAMBDA_JS_RUNTIME as a match only if it contains "20.x", "22.x" or
    // "24.x". Node 22.x is what this project's package.json engines field
    // and vercel.json both require, so the produced string must contain
    // "22.x" whenever the host is actually running Node 22.
    const env = {} as NodeJS.ProcessEnv;
    ensureLambdaRuntimeEnvSet(env);
    const nodeMajor = process.versions.node.split(".")[0];
    if (nodeMajor === "22") {
      assert.ok(env.AWS_LAMBDA_JS_RUNTIME?.includes("22.x"));
    }
  });
});
