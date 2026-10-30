// Fin — no dead ends.
//
// A stage with no handler is how an owner gets silently stranded: every
// message from then on falls through to "Got it, I've written that down" and
// the conversation never moves again. That happened to `diag_done` and
// `choosing_angle_pending` in the first version, and it is invisible in
// production because nothing errors.
//
// The dispatcher's switch is private, so this reads the source and asserts
// each stage appears as a case. Crude, but it is exactly the check that would
// have caught the two stages that stranded owners — and it fails the moment
// somebody adds a seventeenth Stage without wiring it up.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ALL_STAGES } from "../api/_lib/types.js";

const enginePath = fileURLToPath(new URL("../api/_lib/engine/index.ts", import.meta.url));
const engineSource = readFileSync(enginePath, "utf8");

describe("the stage machine", () => {
  test("every stage an owner can be parked on has a handler", () => {
    const missing = ALL_STAGES.filter((stage) => !engineSource.includes(`case "${stage}":`));
    assert.deepEqual(missing, [], `these stages would strand an owner: ${missing.join(", ")}`);
  });

  test("the transient build stages are handled too, because that is where people wait", () => {
    for (const stage of ["diag_done", "building_rule", "building_plan"]) {
      assert.ok(engineSource.includes(`case "${stage}":`), `${stage} is where an owner sits while a plan is generated`);
    }
  });

  test("ALL_STAGES is not quietly empty, which would make this whole check pass for free", () => {
    assert.ok(ALL_STAGES.length >= 16);
    assert.equal(new Set(ALL_STAGES).size, ALL_STAGES.length, "a repeated stage means one was renamed and not removed");
  });

  test("the dispatcher does not still handle a stage that no longer exists", () => {
    // Only runStage's own switch — the file has other switches (intents,
    // outcomes) whose cases are not stages.
    const start = engineSource.indexOf("async function runStage(");
    assert.ok(start > 0, "runStage was found, so this test is testing something");
    const end = engineSource.indexOf("\n}", start);
    const body = engineSource.slice(start, end);

    const handled = [...body.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]!);
    assert.ok(handled.length >= ALL_STAGES.length, "every stage is cased, so none is handled by the default arm alone");

    const known = new Set<string>(ALL_STAGES);
    const orphans = handled.filter((c) => !known.has(c));
    assert.deepEqual(orphans, [], `these cases name stages that no longer exist: ${orphans.join(", ")}`);
  });
});
