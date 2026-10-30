#!/usr/bin/env node
// Ad-hoc verification: drives the step-push loop (Done, I'm stuck, outcome
// question, answer) and one ordinary follow-up question, on a household that
// already has a plan. Mirrors verify-live-build.mjs's signing approach.
//
// Usage:
//   WHATSAPP_APP_SECRET=... node scripts/verify-step-loop.mjs --url https://... --wa-id 27...

import { createHmac } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith("--")) pairs.push([arg.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1]]);
    return pairs;
  }, []),
);
const BASE_URL = (args.url || "").replace(/\/$/, "");
const WA_ID = args["wa-id"];
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;
if (!BASE_URL || !WA_ID || !APP_SECRET) {
  console.error("Usage: WHATSAPP_APP_SECRET=... node scripts/verify-step-loop.mjs --url https://... --wa-id 27...");
  process.exit(1);
}

let msgCounter = 0;
const nextId = () => `wamid.steploop-${Date.now()}.${msgCounter++}`;
const sig = (raw) => "sha256=" + createHmac("sha256", APP_SECRET).update(raw, "utf8").digest("hex");
const envelope = (message) => ({
  entry: [{ changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "verify-script" }, messages: [message] } }] }],
});

async function post(message, label) {
  const body = JSON.stringify(envelope(message));
  const started = Date.now();
  const res = await fetch(`${BASE_URL}/api/whatsapp-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig(body) },
    body,
  });
  const ms = Date.now() - started;
  const text = await res.text();
  console.log(`  [${new Date().toISOString()}] ack ${res.status} in ${ms}ms — ${label}`);
  if (!res.ok) throw new Error(`webhook rejected "${label}": ${res.status} ${text}`);
}

const text = (t) => post({ id: nextId(), from: WA_ID, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: t } }, `text: "${t}"`);
const tap = (id, title) =>
  post(
    { id: nextId(), from: WA_ID, timestamp: String(Math.floor(Date.now() / 1000)), type: "interactive", interactive: { type: "button_reply", button_reply: { id, title } } },
    `tap: ${id}`,
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Driving the step loop on ${WA_ID} via ${BASE_URL}\n`);

  console.log("1. Ask for the first step");
  await text("next step");
  await sleep(2000);

  console.log("\n2. Say I'm stuck (help)");
  await tap("a.step.help", "I'm stuck");
  await sleep(2500);

  console.log("\n3. Mark it done");
  await tap("a.step.done", "Done");
  await sleep(2500);

  console.log("\n4. Answer the outcome question");
  await tap("a.out.better", "Yes, noticeably");
  await sleep(2000);

  console.log("\n5. An ordinary follow-up question, unrelated to the step flow");
  await text("should I put my prices up?");
  await sleep(2000);

  console.log("\nDone. Check WhatsApp on", WA_ID, "for the actual wording of every reply above.");
}

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
