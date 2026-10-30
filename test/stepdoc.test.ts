// Fin — the per-step PDF document (PRIORITY 4.1).
//
// Priority 1 (a sibling track's fix for the Chromium launch crash) governs
// whether this HTML actually renders to bytes on this deployment; that is not
// this file's job and cannot honestly be claimed by a unit test. What CAN be
// verified here, by inspection of the generated HTML itself, is that the
// document contains everything item 4.1 asks for, with no CSS Grid/Flexbox/
// var() (CLAUDE.md rule 8), and — Priority 5.1 — never an unresolved
// "[...]" placeholder, exactly the same guarantee steps.ts enforces for the
// WhatsApp-facing sends.

import { test } from "node:test";
import assert from "node:assert/strict";

import { stepDocHTML, type StepDocData } from "../api/_lib/engine/stepdoc.ts";

const base = (over: Partial<StepDocData> = {}): StepDocData => ({
  productName: "Fin",
  businessName: "Verify Script Test Business",
  stepTitle: "Show up when people search nearby",
  whyForYou: "You said people search nearby before calling.",
  toolName: "Google Business Profile",
  toolUrl: "https://business.google.com",
  costLine: "Free",
  walkthrough: [
    "Go to google.com/business and sign in.",
    "Tap Manage now and enter your business name.",
    "Choose service area or a physical address.",
    "Add at least 5 photos.",
    "Verify by whichever method Google offers you.",
  ],
  artifact: "Hi there, thanks for choosing Verify Script Test Business — could you leave us a review?",
  artifactNote: null,
  doneWhen: "your profile is verified and live",
  ...over,
});

test("contains the step title, the why-for-you line, and every numbered walkthrough step in order", () => {
  const html = stepDocHTML(base());
  assert.match(html, /Show up when people search nearby/);
  assert.match(html, /You said people search nearby before calling\./);
  base().walkthrough.forEach((line, i) => {
    const re = new RegExp(`>${i + 1}<[\\s\\S]{0,400}${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    assert.match(html, re, `step ${i + 1} must be numbered and present`);
  });
});

test("contains the fully-filled artifact, the tool's cost line and url, and done-when", () => {
  const html = stepDocHTML(base());
  assert.match(html, /Hi there, thanks for choosing Verify Script Test Business/);
  assert.match(html, /Free/);
  assert.match(html, /https:\/\/business\.google\.com/);
  assert.match(html, /your profile is verified and live/);
});

test("PRIORITY 5.1: never ships with an unresolved artifact placeholder — a withheld artifact renders as an honest note instead", () => {
  const html = stepDocHTML(
    base({
      artifact: null,
      artifactNote: "There's a ready-to-send message for this one, but part of it is only something you know (name) — write that part yourself rather than send it with the placeholder still in it.",
    }),
  );
  assert.doesNotMatch(html, /\[[a-zA-Z][^[\]]{0,40}\]/, "no bracketed placeholder anywhere in the document");
  assert.match(html, /write that part yourself/);
});

test("no CSS Grid, Flexbox, or var() — CLAUDE.md rule 8, the same rule plandoc.ts follows", () => {
  const html = stepDocHTML(base());
  assert.doesNotMatch(html, /display:\s*flex/i);
  assert.doesNotMatch(html, /display:\s*grid/i);
  assert.doesNotMatch(html, /var\(--/);
});

test("renders coherently with no artifact at all (a step that never had one)", () => {
  const html = stepDocHTML(base({ artifact: null, artifactNote: null }));
  assert.match(html, /Show up when people search nearby/);
  assert.doesNotMatch(html, /undefined|null/);
});
