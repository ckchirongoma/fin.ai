// Charles — the plan document as it is stored now, and the PDF of it on request.
//
// The plan's web page (api/plan.ts) has always rebuilt the document from the
// stored rows: the plan, its steps in order, as the person has since worked
// them. A PDF sent after the build — asked for with "Send the PDF", or the
// retry of a hand-over PDF that did not render — must be that same document,
// so both read it from here.
//
// Round 22, live: one hand-over PDF failed (the render function answered
// 508 in 23ms), the job was closed as done after that one try, and the person
// had no way to ask for the file again.

import { ACT } from "../actions.js";
import { db, findBusinessById, planFor, strategyRepairPending, toolsFor } from "../db.js";
import { planDocHTML } from "../plandoc.js";
import { deliverRenderedPdf, renderPdf } from "../pdfclient.js";
import { sendButtons, sendText } from "../wa.js";
import { since, track } from "../track.js";
import { existingConnectorUrl, planUrl, PRODUCT_NAME } from "./build.js";
import type { Business, HydratedLike, JobRow, PlanRow, PlanStepRow } from "../types.js";

/** The parts of a stored plan, rebuilt from its step rows in order. */
export function storedParts(steps: PlanStepRow[]): HydratedLike[] {
  const byPart = new Map<string, HydratedLike>();
  for (const s of steps) {
    const key = s.workstream_title ?? "Your 90 days";
    if (!byPart.has(key)) byPart.set(key, { id: key, title: key, domain: s.domain ?? "goals", why: "", why_for_you: "", steps: [] });
    byPart.get(key)!.steps.push({
      id: s.step_key ?? s.id,
      title: s.title ?? "",
      domain: s.domain ?? "goals",
      outcome: "",
      done_when: s.done_when ?? "",
      brief: "",
      artifact_brief: null,
      push: s.push ?? "",
      artifact: s.artifact,
      why_for_you: s.why_for_you ?? "",
      tool_id: s.tool_id,
      status: s.status,
    });
  }
  return [...byPart.values()];
}

/**
 * The plan document from the stored rows. `connectorUrl` is the marker
 * planDocHTML prints the "your own AI is connected" box from; `link` is the
 * "read it online" address, which the web page leaves out (it is that page).
 */
export function storedPlanHTML(
  biz: Business,
  plan: { plan: PlanRow; steps: PlanStepRow[] },
  toolsById: Record<string, unknown>,
  opts: { connectorUrl: string | null; link: string | null; strategyPending?: boolean },
): string {
  return planDocHTML({
    productName: PRODUCT_NAME,
    countryCode: biz.country,
    ownerWords: biz.answers?.objective ?? null,
    ctx: {
      name: biz.context?.name ?? biz.identity?.name ?? "You",
      one_liner: biz.context?.one_liner ?? biz.identity?.one_liner ?? "",
      location: biz.context?.location ?? "",
      goal: plan.plan.goal ?? "",
      earns: biz.context?.earns,
      depends: biz.context?.depends,
      income: biz.context?.income,
      owes: biz.context?.owes,
      cushion: biz.context?.cushion,
      cover: biz.context?.cover,
      records: biz.context?.records,
    },
    strategy: plan.plan.strategy ?? null,
    stage: biz.biz_stage ?? "stretching",
    objectiveRead: biz.objective_read ?? "",
    goal: biz.goal ?? [],
    rule: biz.rule ?? [],
    alternatives: biz.alternatives ?? [],
    map: biz.map ?? [],
    plan: {
      headline: plan.plan.headline ?? "",
      order_note: "",
      goal: plan.plan.goal ?? "",
      workstreams: storedParts(plan.steps) as never,
    },
    tools: toolsById as never,
    connectorUrl: opts.connectorUrl,
    ...(opts.link ? { planUrl: opts.link } : {}),
    strategyPending: opts.strategyPending === true,
  });
}

export const planPdfName = (biz: Pick<Business, "context" | "identity">): string =>
  `${(biz.context?.name || biz.identity?.name || "my").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "my"}-90-day-money-plan.pdf`;

/** The button that asks for it again. */
export const SEND_PDF_BUTTON = { id: ACT.PLAN_PDF, title: "Send the PDF" } as const;

export class PdfNotRenderedError extends Error {
  constructor(what = "the plan PDF did not render") {
    super(what);
    this.name = "PdfNotRenderedError";
  }
}

/**
 * Renders the stored plan and sends it. `asked`: the person tapped "Send the
 * PDF" or typed it, and is told the truth either way. `retry`: the
 * hand-over's own PDF did not render; a render failure throws
 * PdfNotRenderedError so the queue tries again (plan_pdf job), and the person
 * hears only when the file arrives — or, on the last try, that it did not.
 */
export async function sendPlanPdf(biz: Business, mode: "asked" | "retry"): Promise<boolean> {
  const started = Date.now();
  const plan = await planFor(biz.id);
  if (!plan || !plan.steps.length) {
    // The retry only runs for a plan that exists (runPlanPdfJob): reading
    // none is a failed read, tried again — never a promise quietly dropped.
    if (mode === "retry") throw new PdfNotRenderedError("the plan could not be read for its PDF");
    await sendText(biz.wa_id, "You don't have a plan yet, so there's no PDF to send. Once your plan is built, it comes as a PDF on its own.", biz.id);
    return false;
  }
  const [tools, connectorUrl, strategyPending] = await Promise.all([
    toolsFor(biz.country),
    existingConnectorUrl(biz.id),
    plan.plan.strategy ? false : strategyRepairPending(biz.id, plan.plan.id).catch(() => false),
  ]);
  const html = storedPlanHTML(biz, plan, Object.fromEntries(tools.map((t) => [t.id, t])), { connectorUrl, link: planUrl(), strategyPending });
  const bytes = await renderPdf(html, "plan");
  const online = planUrl();
  if (!bytes) {
    // A failed render is already pdf_failed, recorded at its cause (pdfclient.ts).
    if (mode === "retry") throw new PdfNotRenderedError();
    await sendButtons(
      biz.wa_id,
      `The PDF didn't come out just then — that's on me.${online ? ` Your whole plan is online at ${online}.` : ""} Tap below to try again in a minute.`,
      [SEND_PDF_BUTTON],
      biz.id,
    );
    return false;
  }
  const sent = await deliverRenderedPdf(bytes, biz.wa_id, planPdfName(biz), mode === "retry" ? "Your 90-day money plan, as promised." : "Your 90-day money plan.", biz.id, "plan");
  if (sent.ok) {
    track("plan_pdf_sent", { ms: since(started), props: { kb: Math.round(bytes.byteLength / 1024), steps: plan.steps.length, via: mode } });
    // The person has the file: a retry still waiting would send it twice.
    if (mode === "asked") await standDownRetries(biz.id);
    return true;
  }
  // Rendered, not delivered (pdfclient.ts records which step, as pdf_failed).
  // An upload that failed reached nobody: the retry tries again. A send
  // WhatsApp refused may still have been delivered (a timeout after Meta took
  // it), so it is said once with the button rather than sent again — and a
  // closed 24-hour window no message can reach.
  if (mode === "retry") {
    if (sent.phase === "upload") throw new PdfNotRenderedError("the plan PDF rendered but could not be uploaded to WhatsApp");
    if (sent.windowClosed) return false;
  }
  await sendButtons(biz.wa_id, `The document didn't come through on WhatsApp just then.${online ? ` The whole plan is online at ${online}.` : ""} Tap below to try again.`, [SEND_PDF_BUTTON], biz.id);
  return false;
}

/** Closes any queued plan_pdf retry for this business: the person already has the file. */
async function standDownRetries(businessId: string): Promise<void> {
  const { error } = await db()
    .from("jobs")
    .update({ status: "done", last_error: "stood down: the person asked for the PDF and got it", updated_at: new Date().toISOString() })
    .eq("kind", "plan_pdf")
    .eq("business_id", businessId)
    .eq("status", "queued");
  if (error) console.warn("plan-pdf: could not stand down a queued retry", error.message);
}

/**
 * The plan_pdf job: the hand-over's PDF, tried again (see runPdfStage), or
 * one the person's own AI asked for (connector.ts send_plan_pdf, payload.mode
 * "asked"): rendered off the AI's request, which cannot wait for Chromium,
 * and the person told on WhatsApp either way, like a "Send the PDF" tap.
 */
export async function runPlanPdfJob(job: JobRow): Promise<void> {
  const biz = job.business_id ? await findBusinessById(job.business_id) : null;
  if (!biz || biz.deleted_at) return;
  // A newer plan replaced the one whose PDF failed: that one came with its own.
  if (job.payload?.plan_id && biz.current_plan_id !== job.payload.plan_id) return;
  await sendPlanPdf(biz, job.payload?.mode === "asked" ? "asked" : "retry");
}
