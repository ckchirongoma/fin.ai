// Charles — a single step's own PDF: everything needed to execute it without
// coming back to WhatsApp.
//
// PRIORITY 4.1. Built for the SAME render path as the full plan document —
// api/_lib/pdf.ts, api/render-pdf.ts, api/_lib/pdfclient.ts are untouched
// here; this file only produces the HTML string those hand to Chromium
// (renderAndSendPlanPdf in pdfclient.ts, called from steps.ts's
// sendStepPdf). Same visual language as plandoc.ts — real <table> layout,
// hardcoded hex, no grid/flex/var() — so the two documents read as one
// product (CLAUDE.md rule 8).

const esc = (x: unknown): string => String(x ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);

export interface StepDocData {
  productName: string;
  businessName: string;
  stepTitle: string;
  whyForYou: string;
  toolName: string;
  toolUrl: string;
  /** costLine()'s output — already carries its own staleness hedge. */
  costLine: string;
  /** The tool's full, curated walkthrough (tools.walkthrough), in order. */
  walkthrough: string[];
  /**
   * Fully resolved — this must never carry an unfilled "[...]" placeholder
   * (Priority 5.1: the same bug that reached WhatsApp must not reach a
   * document meant to be a final, standalone reference). Pass the result of
   * engine/artifact.ts's checkArtifact(), never the raw stored artifact.
   */
  artifact: string | null;
  /** Set only when the artifact had to be withheld; explains why, honestly. */
  artifactNote: string | null;
  doneWhen: string;
}

export function stepDocHTML(d: StepDocData): string {
  const INK = "#171f1a";
  const INK2 = "#3c463f";
  const MUTE = "#6b756e";
  const LINE = "#dfe3de";
  const LEAF = "#1f7a4d";
  const LEAFD = "#155c3a";
  const MIST = "#f2f4f0";
  const PAPER = "#ffffff";
  const dt = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  const steps = (d.walkthrough || [])
    .map(
      (line, i) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 12px"><tr>
      <td width="24" height="24" style="background:${LEAF};color:#ffffff;font-size:10.5px;font-weight:700;text-align:center;vertical-align:middle;border-radius:12px">${i + 1}</td>
      <td style="padding-left:12px;border-left:2px solid ${LINE};vertical-align:top;font-size:12px;color:${INK2};line-height:1.55">${esc(line)}</td>
    </tr></table>`,
    )
    .join("");

  const artifactBlock = d.artifact
    ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${MIST};margin:18px 0 0"><tr><td style="padding:13px 16px">
      <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:${LEAFD};margin:0 0 4px">Ready to send</div>
      <div style="font-size:11.5px;color:${INK2};font-style:italic;line-height:1.5">${esc(d.artifact)}</div>
    </td></tr></table>`
    : d.artifactNote
      ? `<div style="font-size:10.5px;color:${MUTE};margin:18px 0 0;font-style:italic">${esc(d.artifactNote)}</div>`
      : "";

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(d.stepTitle)}</title></head>
<body style="margin:0;padding:0;background:${PAPER};font-family:Helvetica,Arial,sans-serif;color:${INK};font-size:12.5px;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact">
<div style="max-width:640px;margin:0 auto">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td style="background:${INK};padding:28px 32px 18px">
  <div style="font-size:9.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#8fd6ae;margin:0 0 8px">One step, in full &middot; ${esc(d.businessName)}</div>
  <div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;color:#ffffff;line-height:1.25">${esc(d.stepTitle)}</div>
</td></tr></table>

<div style="padding:22px 32px 32px">

${
  d.whyForYou
    ? `<div style="margin:0 0 20px">
  <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:${LEAFD};margin:0 0 5px">Why this, for you</div>
  <div style="font-size:12px;color:${INK2};line-height:1.6">${esc(d.whyForYou)}</div>
</div>`
    : ""
}

<div style="margin:0 0 0">
  <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:${LEAFD};margin:0 0 10px">Exactly how, step by step &middot; ${esc(d.toolName)}</div>
  ${steps}
</div>

${artifactBlock}

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:20px 0 0;border-top:1px solid ${LINE};border-bottom:1px solid ${LINE}"><tr>
  <td style="padding:10px 0;font-size:11px;color:${MUTE}"><b style="color:${INK2}">${esc(d.toolName)}</b> &middot; ${esc(d.costLine)} &middot; <a href="${esc(d.toolUrl)}" style="color:${LEAFD};font-weight:700;text-decoration:none">${esc(d.toolUrl)}</a></td>
</tr></table>

<div style="margin:16px 0 0;font-size:11.5px;color:${INK2}"><b style="color:${INK}">Done when:</b> ${esc(d.doneWhen)}</div>

<div style="margin:26px 0 0;font-size:9.5px;color:${MUTE}">Prepared ${dt} by ${esc(d.productName)}. Correct when checked; confirm anything unusual against the tool's own site.</div>

</div>
</div>
</body></html>`;
}
