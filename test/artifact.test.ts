// Charles — engine/artifact.ts, the PRIORITY 5.1 guard.

import { test } from "node:test";
import assert from "node:assert/strict";

import { checkArtifact } from "../api/_lib/engine/artifact.ts";
import type { Business } from "../api/_lib/types.ts";

const biz = (over: Partial<Business> = {}): Business =>
  ({
    id: "b1",
    wa_id: "27809930005",
    country: "ZA",
    stage: "step_pushed",
    context: { name: "Thandi", location: "Woodstock, Cape Town" },
    ...over,
  }) as Business;

test("null/empty artifact passes through as nothing to send", () => {
  const none = { text: null, fallback: null, draft: null, missing: [] };
  assert.deepEqual(checkArtifact(null, biz()), none);
  assert.deepEqual(checkArtifact("   ", biz()), none);
  // The apology older builds stored over the message (round 18) is not a message.
  assert.deepEqual(checkArtifact("There's a ready-to-send message for this one, but part of it is only something you know (name) — write that part yourself rather than send it with the placeholder still in it.", biz()), none);
});

test("an artifact with no placeholders at all is sent exactly as written", () => {
  const r = checkArtifact("Come back any time — we'd love to see you again.", biz());
  assert.equal(r.text, "Come back any time — we'd love to see you again.");
  assert.equal(r.fallback, null);
});

test("a known fact (the person's own name, location) fills the matching placeholder", () => {
  assert.equal(checkArtifact("Thanks for choosing [Your Name]!", biz()).text, "Thanks for choosing Thandi!");
  assert.equal(checkArtifact("Proudly serving [Location].", biz()).text, "Proudly serving Woodstock, Cape Town.");
  // Case-insensitive, and a couple of the plausible ways a model phrases it.
  assert.equal(checkArtifact("From your friends at [your name].", biz()).text, "From your friends at Thandi.");
  assert.equal(checkArtifact("— [My Name]", biz()).text, "— Thandi");
});

test("an unresolvable placeholder (a future customer's name, a link that does not exist yet) is handed over marked as the owner's to fill, never as ready to send", () => {
  const msg = "Hi [Name], thanks for choosing Thandi — could you review us? [Link to Google profile]";
  const r = checkArtifact(msg, biz());
  assert.equal(r.text, null, "never 'ready to send' as it stands");
  // Round 18: the old fallback replaced the message with an apology, so the
  // owner had nothing to send. Now the message comes, under one line saying
  // exactly which parts are theirs to fill.
  assert.match(r.fallback!, /^Fill in the parts in \[brackets\] \(name, link to Google profile\) before you send this:/);
  assert.ok(r.fallback!.endsWith(msg));
  assert.equal(r.draft, msg);
  assert.deepEqual(r.missing, ["name", "link to google profile"]);
});

test("a number written as a mask is a placeholder, not a number", () => {
  const r = checkArtifact("Call or WhatsApp 0XX XXX XXXX to book.", biz());
  assert.equal(r.text, null);
  assert.equal(r.draft, "Call or WhatsApp [your phone number] to book.");
  assert.equal(checkArtifact("WhatsApp 07XX XXX XXX", biz()).draft, "WhatsApp [your phone number]");
  assert.equal(checkArtifact("Two XL towels for R350.", biz()).text, "Two XL towels for R350.");
});

test("a mix of a known and an unknown placeholder still refuses the whole thing rather than sending it half-filled", () => {
  const r = checkArtifact("Thanks for choosing [Your Name]! See you, [Name].", biz());
  assert.equal(r.text, null);
  assert.match(r.fallback!, /name/i);
});

test("with no business name on file, a your-name placeholder is left unresolved and the artifact is refused rather than guessed", () => {
  const r = checkArtifact("Thanks for choosing [Your Name]!", biz({ context: {}, identity: null }));
  assert.equal(r.text, null);
  assert.match(r.fallback!, /your name/i);
});
