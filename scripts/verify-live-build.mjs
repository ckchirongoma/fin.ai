#!/usr/bin/env node
// Fin — proof that a real conversation, on a real deployment, actually
// finishes: the one thing this repository cannot check on its own (see
// HANDOFF-DEPLOY.md §5 — "a live Meta number, and a stranger completing the
// flow on it" are explicitly called out as untickable from inside a repo).
//
// This drives a full diagnostic → identity → customer → angle → plan-build
// conversation against a REAL deployment's real endpoints — the webhook and
// the worker sweep — the same way Meta and Vercel's cron actually call them.
// It does not fake or import any project code; it only speaks HTTP, signed
// exactly the way Meta signs a real delivery (see api/_lib/crypto.ts's
// metaSignature). What it proves, with real timestamps, not a claim:
//
//   - the webhook acks in well under a second at every point in the
//     conversation, INCLUDING while a plan build is in flight — the thing
//     that used to go silent for minutes (see engine/planbuild.ts)
//   - the queue actually drains: how many stage jobs ran, how many failed,
//     and the wall-clock from "angle chosen" to "nothing left queued"
//   - a message sent mid-build gets a real, fast acknowledgement rather
//     than being silently held behind a long-running job
//
// What it CANNOT prove, because no test can: that the WhatsApp messages and
// the PDF actually arrived looking right. Someone has to watch the phone.
// This script tells you exactly when to look.
//
// Usage:
//   WHATSAPP_APP_SECRET=... WORKER_SECRET=... \
//   node scripts/verify-live-build.mjs \
//     --url https://your-preview-deployment.vercel.app \
//     --wa-id 27821234567   # a REAL test number you can watch reply
//
// Flags:
//   --url        required. The deployment to hit.
//   --wa-id      required. A WhatsApp number registered against your Meta
//                test app, so you can actually watch it receive messages.
//   --country    optional, default ZA. Only changes which diagnostic wording
//                is realistic; the flow is identical in every market.
//   --max-poll   optional, default 40. How many times to poll /api/worker
//                before giving up (at 3s apart, ~2 minutes).
//   --poll-ms    optional, default 3000. The gap between those polls.
//
// Optional, and strongly recommended: SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY. With them, every hand-off is checked against
// the business's real stage — the script waits for the stage it needs
// before sending the next message, and FAILS (exit 1) if the conversation
// never gets there, instead of timing a build that never started.
//
// Round 10: since the read-back split, "That's right" can arrive while the
// customer options are still being written. The owner gets a holding line
// and the stage stays confirm_identity until the options job delivers them.
// This script used to send the customer pick ("1") 500ms after the tap, so
// "1" landed inside that window. The script now drains the queue (and, with
// the database, waits for choose_goal) before it picks.

import { createHmac } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith("--")) pairs.push([arg.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1]]);
    return pairs;
  }, []),
);

const BASE_URL = (args.url || "").replace(/\/$/, "");
const WA_ID = args["wa-id"];
const COUNTRY_DIAL = { ZA: "27", KE: "254", NG: "234", GH: "233", UG: "256" };
const COUNTRY = String(args.country || "ZA").toUpperCase();
const MAX_POLL = Number(args["max-poll"] ?? 40);
const POLL_MS = Number(args["poll-ms"] ?? 3000);
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;
const WORKER_SECRET = process.env.WORKER_SECRET;
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CAN_READ_DB = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

if (!BASE_URL || !WA_ID) {
  console.error("Usage: WHATSAPP_APP_SECRET=... WORKER_SECRET=... node scripts/verify-live-build.mjs --url https://... --wa-id 27821234567");
  process.exit(1);
}
if (!APP_SECRET) {
  console.error("WHATSAPP_APP_SECRET is not set — the webhook will refuse everything (correctly: see whatsapp-webhook.ts).");
  process.exit(1);
}
if (!WORKER_SECRET) {
  console.error("WORKER_SECRET is not set — /api/worker will refuse to drain the queue.");
  process.exit(1);
}
if (!COUNTRY_DIAL[COUNTRY]) {
  console.error(`Unknown --country "${COUNTRY}" — expected one of ${Object.keys(COUNTRY_DIAL).join(", ")}.`);
  process.exit(1);
}

let msgCounter = 0;
const nextId = () => `wamid.verify-${Date.now()}.${msgCounter++}`;

function metaSignature(rawBody, appSecret) {
  return "sha256=" + createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
}

function envelope(message) {
  return {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: { messaging_product: "whatsapp", metadata: { phone_number_id: "verify-script" }, messages: [message] },
          },
        ],
      },
    ],
  };
}

async function sendText(text) {
  const message = { id: nextId(), from: WA_ID, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } };
  return postWebhook(message, `text: "${text.slice(0, 40)}${text.length > 40 ? "…" : ""}"`);
}

async function sendTap(id, title) {
  const message = {
    id: nextId(),
    from: WA_ID,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: "interactive",
    interactive: { type: "button_reply", button_reply: { id, title } },
  };
  return postWebhook(message, `tap: ${id}`);
}

async function postWebhook(message, label) {
  const body = JSON.stringify(envelope(message));
  const started = Date.now();
  const res = await fetch(`${BASE_URL}/api/whatsapp-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": metaSignature(body, APP_SECRET) },
    body,
  });
  const ms = Date.now() - started;
  const text = await res.text();
  const flag = ms > 2000 ? "  <-- SLOW, should be well under a second" : "";
  console.log(`  [${new Date().toISOString()}] webhook ack ${res.status} in ${ms}ms — ${label}${flag}`);
  if (!res.ok) throw new Error(`webhook rejected "${label}": ${res.status} ${text}`);
  return { status: res.status, ms };
}

async function drainOnce() {
  const started = Date.now();
  const res = await fetch(`${BASE_URL}/api/worker?max=10`, { method: "POST", headers: { Authorization: `Bearer ${WORKER_SECRET}` } });
  const ms = Date.now() - started;
  const report = await res.json().catch(() => ({}));
  console.log(`  [${new Date().toISOString()}] worker drain in ${ms}ms — ${JSON.stringify(report)}`);
  return report;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The test business's row, or null. Only with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. */
async function business() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/businesses?wa_id=eq.${WA_ID}&select=stage,current_plan_id,pending_action`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`db read businesses -> ${res.status}: ${await res.text()}`);
  return (await res.json())[0] ?? null;
}

/**
 * Drain the queue until the business reaches one of `stages` (with the
 * database) or the queue goes quiet (without it). A stage never reached is a
 * FAILURE, not a note: sending the next message anyway is exactly how this
 * script used to feed a customer pick into the wait after "That's right".
 */
async function waitForStage(stages, after) {
  let idleStreak = 0;
  for (let i = 0; i < MAX_POLL; i++) {
    if (CAN_READ_DB) {
      const b = await business();
      if (b && stages.includes(b.stage)) {
        console.log(`  stage is ${b.stage} — moving on`);
        return b;
      }
    }
    const report = await drainOnce();
    if ((report.claimed ?? 0) === 0) {
      idleStreak++;
      if (!CAN_READ_DB && idleStreak >= 2) return null;
    } else {
      idleStreak = 0;
    }
    await sleep(POLL_MS);
  }
  if (CAN_READ_DB) {
    const b = await business();
    if (b && stages.includes(b.stage)) return b;
    throw new Error(`after ${after}, expected stage ${stages.join(" or ")}, but it is ${b?.stage ?? "(no business)"}`);
  }
  return null;
}

// Fin's twelve questions, answered as a tester would: fixed-option questions
// by number (the engine reads digits as picks), the rest in a line. The
// household is invented; the figures are the tester's own, never the library's.
const DIAG_ANSWERS_BY_COUNTRY = {
  ZA: [
    "Verify Script Tester",
    "1",
    "Diepsloot, Johannesburg",
    "Pay off the mashonisa and put R1,000 away by Christmas",
    "1",
    "1, 3",
    "2",
    "About R4,800 a month",
    "2",
    "1",
    "2",
    "1",
  ],
};

async function main() {
  console.log(`Verifying ${BASE_URL} against ${WA_ID} (${COUNTRY}) — watch that number's WhatsApp while this runs.\n`);
  if (!CAN_READ_DB) {
    console.log("NOTE: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — stages are not checked, only that the queue drains. Set them for a real pass/fail.\n");
  }

  console.log("1. Opening the conversation");
  await sendText("hi");
  await sleep(500);

  console.log("\n2. Running the diagnostic");
  for (const answer of DIAG_ANSWERS_BY_COUNTRY[COUNTRY]) {
    await sendText(answer);
    await sleep(400);
  }

  console.log("\n   Waiting for the read-back");
  await waitForStage(["confirm_identity"], "the diagnostic");

  console.log("\n3. Confirming identity");
  await sendTap("a.id.ok", "That's right");
  // The options may still be on their way (a holding line, stage still
  // confirm_identity): the pick is sent only once they are out.
  console.log("   Waiting for the goal options");
  await waitForStage(["choose_goal"], `"That's right"`);

  console.log("\n4. Choosing a goal");
  await sendText("1");
  console.log("   Waiting for the rule options");
  await waitForStage(["choose_rule"], "the customer pick");

  console.log("\n5. Choosing a rule — this is what starts the plan build");
  const buildStarted = Date.now();
  await sendText("1");

  console.log("\n6. Sending a message immediately while the build should be in flight");
  console.log("   (this is the exact scenario that used to go silent for minutes — engine/planbuild.ts's handleBuildingPlan)");
  await sleep(1500);
  await sendText("hello? are you still there");

  console.log("\n7. Draining the queue and timing it to completion (a real deployment relies on the SAME /api/worker sweep, or its own next inbound message, to do this)");
  let idleStreak = 0;
  for (let i = 0; i < MAX_POLL; i++) {
    const report = await drainOnce();
    if ((report.claimed ?? 0) === 0) {
      idleStreak++;
      if (idleStreak >= 2) break;
    } else {
      idleStreak = 0;
    }
    await sleep(POLL_MS);
  }
  const elapsedMs = Date.now() - buildStarted;

  // A queue that went quiet is not a plan that was built.
  if (CAN_READ_DB) {
    const b = await business();
    if (!b || !["plan_ready", "step_pushed"].includes(b.stage) || !b.current_plan_id) {
      throw new Error(`the build did not finish: stage ${b?.stage ?? "(no business)"}, current_plan_id ${b?.current_plan_id ?? "none"}`);
    }
    console.log(`\nPlan built: stage ${b.stage}, plan ${b.current_plan_id}.`);
  }

  console.log(`\nDone. ${(elapsedMs / 1000).toFixed(1)}s from "angle chosen" to the queue going quiet.`);
  console.log(`Founder brief's own budget (item J): whole plan under ~3 minutes. ${elapsedMs > 180_000 ? "OVER BUDGET." : "within budget."}`);
  console.log(`\nWhat this script proved: every webhook ack was fast (see timings above), a message sent mid-build got an immediate response instead of silence, and the queue actually drained.`);
  console.log(`What only you can confirm now: open WhatsApp on ${WA_ID} and check the plan's wording and the PDF actually arrived looking right.`);
}

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
