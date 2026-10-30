#!/usr/bin/env node
// Ad-hoc: drives the "Walk me through" sub-flow end to end (Next x N, one
// "I'm stuck" mid-way, one "Later", resuming, finishing, then Done on the
// parent step) with REAL pauses between sends (not a rapid burst), to get a
// clean read on the step-done bug independent of the message-ordering bug.
import { createHmac } from "node:crypto";
const args = Object.fromEntries(
  process.argv.slice(2).reduce((p, a, i, all) => { if (a.startsWith("--")) p.push([a.slice(2), all[i+1]?.startsWith("--") ? true : all[i+1]]); return p; }, []),
);
const BASE_URL = (args.url || "").replace(/\/$/, "");
const WA_ID = args["wa-id"];
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;
if (!BASE_URL || !WA_ID || !APP_SECRET) { console.error("need --url --wa-id and WHATSAPP_APP_SECRET"); process.exit(1); }
let n = 0;
const nextId = () => `wamid.walk-${Date.now()}.${n++}`;
const sig = (raw) => "sha256=" + createHmac("sha256", APP_SECRET).update(raw, "utf8").digest("hex");
const envelope = (m) => ({ entry: [{ changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "verify" }, messages: [m] } }] }] });
async function post(m, label) {
  const body = JSON.stringify(envelope(m));
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/api/whatsapp-webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig(body) }, body });
  console.log(`  [${new Date().toISOString()}] ack ${res.status} in ${Date.now()-t0}ms — ${label}`);
  if (!res.ok) throw new Error(`rejected ${label}: ${res.status} ${await res.text()}`);
}
const tap = (id, title) => post({ id: nextId(), from: WA_ID, timestamp: String(Math.floor(Date.now()/1000)), type: "interactive", interactive: { type: "button_reply", button_reply: { id, title } } }, `tap: ${id}`);
const text = (t) => post({ id: nextId(), from: WA_ID, timestamp: String(Math.floor(Date.now()/1000)), type: "text", text: { body: t } }, `text: "${t}"`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log(`Driving the walkthrough on ${WA_ID}\n`);
  console.log("1. Next (advance walkthrough step 1 -> 2)"); await tap("a.walk.next", "Next"); await sleep(5000);
  console.log("2. Next (2 -> 3)"); await tap("a.walk.next", "Next"); await sleep(5000);
  console.log("3. I'm stuck ON STEP 3 — should reference step 3's content, not step 1's"); await tap("a.walk.stuck", "I'm stuck"); await sleep(5000);
  console.log("4. Later"); await tap("a.walk.later", "Later"); await sleep(5000);
  console.log("5. Ask for the step again (does Later resume, or restart the walkthrough?)"); await text("walk me through"); await sleep(5000);
  console.log("6-9. Next x4 (push through to the end)");
  for (let i = 0; i < 4; i++) { await tap("a.walk.next", "Next"); await sleep(4000); }
  console.log("10. Real pause, then Done on the actual step (not a burst — isolates the done-bug from the ordering-bug)");
  await sleep(3000);
  await tap("a.step.done", "Done");
  await sleep(4000);
  console.log("\nDone driving. Check WhatsApp on", WA_ID, "and the DB for plan_steps.status.");
}
main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
