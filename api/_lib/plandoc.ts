// Fin — the plan document: three parts, in the order a reader needs them.
//
//   Part I    Where your money stands — the facts as the person gave them,
//             what those answers add up to, and the eight areas with what
//             "sorted" concretely means for each one that is not.
//   Part II   The strategy — the goal they chose, the rule they will keep,
//             what usually happens instead, what they refuse to do, the
//             money logic in their own numbers, what is true at day
//             30/60/90, and what could derail it.
//   Part III  The next 90 days — the steps, from the fixed library.
//
// The first version was Part III with a map stapled to the front, and the
// honest review of it was "no depth". The depth lives in Parts I and II now —
// written by the model, grounded in the diagnostic and the verified library,
// checked before it is stored (see checkStrategy) — while Part III stays
// exactly what rule 1 demands: assembled, never freestyled.
//
// Rendering is still built the way HTML email is built: real <table> layout,
// hard-coded hex, no grid, no flex, no var() (rule 8). A document with no
// strategy (plans built before it existed, or a strategy call that failed)
// renders coherently without Parts I.2, I.4 and most of II — never blocks.
//
// Print behaviour is part of the contract: @page and the page-break guards
// are what let a real browser's print-to-PDF produce something a person can
// keep and show someone they trust. scripts/preview-plan.mjs proves it after
// every change.

import { withFreeType } from "./freetype.js";
import type { HydratedWorkstream, HydratedStep } from "./playbooks.js";
import { DOMAIN_LABELS, type Strategy } from "./types.js";
import { country } from "./countries.js";
import { greenMeans } from "./moneymap.js";
import { checkArtifact, blanks } from "./engine/artifact.js";
export { blanks };
import { libraryHowTo, libraryStep } from "./playbooks.js";

export interface PlanDocData {
  productName: string;
  /** The market — decides which bodies the footer names. */
  countryCode: string;
  ctx: {
    name: string;
    one_liner: string;
    location: string;
    goal: string;
    earns?: string;
    depends?: string;
    income?: string;
    owes?: string;
    cushion?: string;
    cover?: string;
    records?: string;
  };
  stage: string;
  /** What the person actually typed for their aim. The plan's goal is the model's wording of it. */
  ownerWords?: string | null;
  objectiveRead: string;
  goal: { label: string; what: string; why_you: string; worth: string; first_move: string; catch: string }[];
  rule: { rule: string; why_it_works: string; what_it_costs_you: string | null }[];
  alternatives: { name: string; why_people_do_it: string; where_it_leaves_them: string }[];
  map: { domain: string; status: "red" | "amber" | "green"; note: string }[];
  plan: { headline: string; order_note: string; goal?: string; workstreams: HydratedWorkstream[] };
  strategy?: Strategy | null;
  tools: Record<string, { id: string; name: string; url: string; why: string; cost: string; verified_on: string | null; free_type?: string | null; walkthrough?: string[] | null }>;
  /** Set only once the person has actually connected their own AI. */
  connectorUrl?: string | null;
  /** Where this plan can be read on the web. */
  planUrl?: string | null;
  /**
   * The strategy is missing but being written now (a plan repair is queued or
   * running for it: a build handed over at its deadline, or one whose
   * strategy failed). Part II then says so, instead of silently leaving it
   * out. Never set for an old plan nothing is going to fill.
   */
  strategyPending?: boolean;
}

const STAGE_LABELS: Record<string, string> = { surviving: "Surviving", stretching: "Stretching", steady: "Steady", building: "Building" };

const esc = (x: unknown) => String(x ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));

/** A model sentence that starts lowercase ("if you…") is capitalised for print. */
export function sentenceCase(x: string | null | undefined): string {
  const t = String(x ?? "").trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

const FRESH_DAYS = 90;
function staleDays(verifiedOn: string | null): number {
  if (!verifiedOn) return Infinity;
  return Math.floor((Date.now() - new Date(verifiedOn).getTime()) / 864e5);
}
function costLine(cost: string, verifiedOn: string | null, freeType?: string | null): string {
  const line = withFreeType(cost, freeType);
  return staleDays(verifiedOn) > FRESH_DAYS ? `${line} — confirm at sign-up` : line;
}

export function planDocHTML(d: PlanDocData): string {
  const co = country(d.countryCode);
  const dt = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const st = d.strategy ?? null;

  const usedToolIds = [...new Set((d.plan.workstreams || []).flatMap((w) => w.steps.map((s) => s.tool_id).filter(Boolean)))] as string[];
  const tools = usedToolIds.map((id) => d.tools[id]).filter(Boolean);
  const totalSteps = (d.plan.workstreams || []).reduce((n, w) => n + w.steps.length, 0);
  const greens = (d.map || []).filter((m) => m.status === "green").length;

  const INK = "#14181d", INK2 = "#3a4149", MUTE = "#6b737c", LINE = "#dfe3e8", LEAF = "#0f766e", LEAFD = "#0b5a54", MIST = "#f1f5f4", PAPER = "#ffffff";
  const RAG: Record<string, string> = { red: "#c0392b", amber: "#a8720f", green: "#1f7a4d" };
  const RAGWORD: Record<string, string> = { red: "Not sorted", amber: "In progress", green: "Sorted" };
  const DOT = "&#9679;";

  // Sections number themselves so optional ones can drop out without leaving holes.
  let sectionNo = 0;
  const sectionHead = (title: string) => {
    sectionNo += 1;
    return `
    <table role="presentation" class="keepnext" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-bottom:2px solid ${INK};margin:0 0 13px"><tr>
      <td style="padding:0 0 6px;font-family:Georgia,'Times New Roman','Open Sans','Fin Symbols',serif;font-size:16px;font-weight:700;color:${INK}">${title}</td>
    </tr></table>`;
  };

  const partDivider = (roman: string, title: string, sub: string, breakBefore: boolean) => `
    <table role="presentation" class="keepnext${breakBefore ? " pagebreak" : ""}" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:30px 0 20px"><tr>
      <td style="background:${INK};padding:16px 20px">
        <div style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#8fd6ae;margin:0 0 4px">Part ${roman}</div>
        <div style="font-family:Georgia,'Times New Roman','Open Sans','Fin Symbols',serif;font-size:19px;font-weight:700;color:#ffffff">${title}</div>
        <div style="font-size:11px;color:#aeb8b1;margin-top:3px">${sub}</div>
      </td>
    </tr></table>`;

  const para = (text: string, last = false) =>
    `<div style="font-size:12.5px;color:${INK2};line-height:1.65;margin:0 0 ${last ? 0 : 11}px">${esc(text)}</div>`;

  const bulletList = (items: string[], accent = LEAF) =>
    items
      .map(
        (x) => `
      <table role="presentation" class="keep" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 7px"><tr>
        <td width="8" style="vertical-align:top;padding-top:7px"><div style="width:6px;height:6px;background:${accent};border-radius:3px;font-size:1px">&nbsp;</div></td>
        <td style="padding-left:9px;font-size:11.5px;color:${INK2};line-height:1.55">${esc(x)}</td>
      </tr></table>`,
      )
      .join("");

  // ── Part I building blocks ─────────────────────────────────────

  const factRows: [string, string | undefined][] = [
    ["How money comes in", d.ctx.earns],
    ["Where", d.ctx.location],
    ["Stage", STAGE_LABELS[d.stage] || d.stage],
    ["What comes in a month", d.ctx.income],
    ["Who depends on it", d.ctx.depends],
    ["What is owed", d.ctx.owes],
    ["Reachable in an emergency", d.ctx.cushion],
    ["Cover", d.ctx.cover],
    ["How it is tracked", d.ctx.records],
  ];
  // Two tables, so Part I can start on the cover: its banner, heading and
  // first three facts travel together; the rest follow with the caption.
  // Round 18's covers were half empty because the whole block had to fit.
  const factLines = factRows
    .filter(([, v]) => v && String(v).trim())
    .map(
      ([k, v]) => `<tr>
        <td width="170" style="padding:6px 12px 6px 0;border-bottom:1px solid ${LINE};color:${MUTE};font-weight:700;vertical-align:top;white-space:nowrap">${k}</td>
        <td style="padding:6px 0;border-bottom:1px solid ${LINE};color:${INK2}">${esc(v)}</td>
      </tr>`,
    );
  const factTable = (rows: string[]) => (rows.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:11.5px">${rows.join("")}</table>` : "");
  const factsHead = factTable(factLines.slice(0, 3));
  const factsRest = `<div class="keep">${factTable(factLines.slice(3))}
    <div style="font-size:10px;color:${MUTE};margin-top:6px">As you described it to ${esc(d.productName)}. If a line here is wrong, say so on WhatsApp and the plan updates with it.</div></div>`;

  const mapRows: PlanDocData["map"][] = [];
  for (let i = 0; i < (d.map || []).length; i += 4) mapRows.push(d.map.slice(i, i + 4));
  const mapTable = mapRows
    .map(
      (row) =>
        `<tr>${row
          .map(
            (m) => `
    <td width="25%" style="padding:10px 10px;vertical-align:top;border:1px solid ${LINE};border-left:4px solid ${RAG[m.status] || MUTE}">
      <div style="font-family:Georgia,'Times New Roman','Open Sans','Fin Symbols',serif;font-size:12.5px;font-weight:700;color:${INK}">${esc(DOMAIN_LABELS[m.domain] || m.domain)}</div>
      <div style="font-size:10px;font-weight:700;color:${RAG[m.status] || MUTE};margin:3px 0 5px">${DOT} ${RAGWORD[m.status] || ""}</div>
      <div style="font-size:10.5px;color:${MUTE};line-height:1.4">${esc(m.note)}</div>
    </td>`,
          )
          .join("")}${row.length < 4 ? `<td colspan="${4 - row.length}" style="border:0"></td>` : ""}</tr>`,
    )
    .join("");

  // Every area that is not green gets the rubric's own definition of sorted —
  // deterministic text, so the destination is always stated even when the
  // model wrote nothing.
  const notGreen = (d.map || []).filter((m) => m.status !== "green" && greenMeans(m.domain));
  const sortedMeans = notGreen.length
    ? `
    <div class="keep">
    <div style="font-size:11px;font-weight:700;color:${INK};margin:14px 0 8px">What &ldquo;sorted&rdquo; means, area by area</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:11px">
      ${notGreen
        .map(
          (m) => `<tr class="keep">
        <td width="130" style="padding:6px 12px 6px 0;border-bottom:1px solid ${LINE};vertical-align:top;white-space:nowrap"><span style="color:${RAG[m.status]};font-weight:700">${DOT}</span> <b style="color:${INK2}">${esc(DOMAIN_LABELS[m.domain] || m.domain)}</b></td>
        <td style="padding:6px 0;border-bottom:1px solid ${LINE};color:${INK2};line-height:1.5">${esc(greenMeans(m.domain))}</td>
      </tr>`,
        )
        .join("")}
    </table>
    </div>`
    : "";

  const workingLeaking = st
    ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
      <td width="48%" style="vertical-align:top;padding-right:12px">
        <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${LEAFD};margin:0 0 8px">Already working for you</div>
        ${bulletList(st.working, LEAF)}
      </td>
      <td width="4%" style="font-size:1px">&nbsp;</td>
      <td width="48%" style="vertical-align:top">
        <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${RAG.red};margin:0 0 8px">Where it's leaking</div>
        ${bulletList(st.leaking, RAG.red)}
      </td>
    </tr></table>`
    : "";

  // ── Part II building blocks ────────────────────────────────────

  const goalCardList = (d.goal || [])
    .map(
      (c) => `
    <table role="presentation" class="keep" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid ${LINE};margin:0 0 10px">
      <tr><td style="padding:13px 16px">
        <div style="font-family:Georgia,'Times New Roman','Open Sans','Fin Symbols',serif;font-size:14px;font-weight:700;color:${INK};margin:0 0 7px">${esc(c.label)}</div>
        <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:11px;line-height:1.5">
          <tr><td style="padding:2px 10px 2px 0;color:${MUTE};font-weight:700;white-space:nowrap;vertical-align:top">What it is</td><td style="padding:2px 0;color:${INK2}">${esc(c.what)}</td></tr>
          <tr><td style="padding:2px 10px 2px 0;color:${MUTE};font-weight:700;white-space:nowrap;vertical-align:top">Why it fits you</td><td style="padding:2px 0;color:${INK2}">${esc(c.why_you)}</td></tr>
          <tr><td style="padding:2px 10px 2px 0;color:${MUTE};font-weight:700;white-space:nowrap;vertical-align:top">What it's worth</td><td style="padding:2px 0;color:${INK2}">${esc(c.worth)}</td></tr>
          <tr><td style="padding:2px 10px 2px 0;color:${MUTE};font-weight:700;white-space:nowrap;vertical-align:top">First move</td><td style="padding:2px 0;color:${INK2}">${esc(c.first_move)}</td></tr>
          <tr><td style="padding:2px 10px 2px 0;color:#8a5a10;font-weight:700;white-space:nowrap;vertical-align:top">The catch</td><td style="padding:2px 0;color:#8a5a10">${esc(c.catch)}</td></tr>
        </table>
      </td></tr>
    </table>`,
    )
    ;

  const ruleBlocks = (d.rule || [])
    .map(
      (x) => `
    <table role="presentation" class="keep" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${MIST};margin:0 0 8px"><tr><td style="padding:14px 17px;border-left:4px solid ${LEAF}">
      <div style="font-family:Georgia,'Times New Roman','Open Sans','Fin Symbols',serif;font-size:15px;font-weight:700;color:${INK};font-style:italic;margin:0 0 4px">&ldquo;${esc(x.rule)}&rdquo;</div>
      <div style="font-size:11.5px;color:${MUTE}">${esc(x.why_it_works)}</div>
      ${x.what_it_costs_you ? `<div style="font-size:11px;color:#8a5a10;margin-top:3px">Costs you: ${esc(x.what_it_costs_you)}</div>` : ""}
    </td></tr></table>`,
    )
    .join("");

  const altTable = (d.alternatives || []).length
    ? `
    <table role="presentation" ${(d.alternatives || []).length <= 4 ? 'class="keep" ' : ""}width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:11px;margin-top:6px">
      <thead><tr>${["What usually happens instead", "Why people do it", "Where it leaves you"].map((h) => `<td style="padding:5px 10px 6px 0;border-bottom:2px solid ${INK};font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:${MUTE}">${h}</td>`).join("")}</tr></thead>
      ${d.alternatives
        .map(
          (z) => `<tr>
        <td style="padding:8px 10px 8px 0;border-bottom:1px solid ${LINE};vertical-align:top;font-weight:600;color:${INK2}">${esc(z.name)}</td>
        <td style="padding:8px 10px 8px 0;border-bottom:1px solid ${LINE};vertical-align:top;color:${INK2}">${esc(z.why_people_do_it)}</td>
        <td style="padding:8px 0 8px 0;border-bottom:1px solid ${LINE};vertical-align:top;color:${INK2}">${esc(z.where_it_leaves_them)}</td>
      </tr>`,
        )
        .join("")}
    </table>`
    : "";

  // Only marks the strategy actually filled. Round 17's ZA document printed
  // three empty "Day 30/60/90" boxes when the strategy came back without them.
  const marks = st ? (["d30", "d60", "d90"] as const).filter((k) => String(st.milestones?.[k] ?? "").trim()) : [];
  const milestones = marks.length
    ? `
    <table role="presentation" class="keep" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
      ${marks
        .map(
          (k, i) => `
      <td width="${Math.floor(100 / marks.length)}%" style="vertical-align:top;padding:12px 14px;border:1px solid ${LINE};${i < marks.length - 1 ? "border-right:0;" : ""}border-top:3px solid ${LEAF}">
        <div style="font-size:9.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${LEAFD};margin:0 0 5px">Day ${k.slice(1)}</div>
        <div style="font-size:11.5px;color:${INK2};line-height:1.5">${esc(sentenceCase(st!.milestones[k]))}</div>
      </td>`,
        )
        .join("")}
    </tr></table>
    <div style="font-size:10px;color:${MUTE};margin-top:6px">Each one describes what is TRUE at that mark, not what was attempted. If day 30 arrives and its line isn't true, that's a conversation to have with ${esc(d.productName)}, not a failure to hide.</div>`
    : "";

  const risksTable = st?.risks.length
    ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:11px">
      <thead><tr>${["What could derail this", "What to do when it shows up"].map((h) => `<td style="padding:5px 10px 6px 0;border-bottom:2px solid ${INK};font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:${MUTE}">${h}</td>`).join("")}</tr></thead>
      ${st.risks
        .map(
          (r) => `<tr class="keep">
        <td width="42%" style="padding:8px 12px 8px 0;border-bottom:1px solid ${LINE};vertical-align:top;font-weight:600;color:${INK2}">${esc(r.risk)}</td>
        <td style="padding:8px 0;border-bottom:1px solid ${LINE};vertical-align:top;color:${INK2}">${esc(r.response)}</td>
      </tr>`,
        )
        .join("")}
    </table>`
    : "";

  // ── Part III building blocks ───────────────────────────────────

  // Steps are numbered once, 1 to N, across the whole plan — the same number
  // WhatsApp says ("Step 3 of 9"). Round 17's document restarted at 1 in every
  // group, so "step 1" meant three different things.
  const stepNo = new Map<HydratedStep, number>();
  for (const w of d.plan.workstreams || []) for (const stp of w.steps) stepNo.set(stp, stepNo.size + 1);
  // A tool's walkthrough is how to SET THE TOOL UP, so it prints once, on the
  // first step that uses it; later steps point back. Printed under every step,
  // a sheet's "name it Stock or Prices" sat under a debtors list (round 17).
  const toolFirstStep = new Map<string, number>();
  for (const w of d.plan.workstreams || []) for (const stp of w.steps) if (stp.tool_id && !toolFirstStep.has(stp.tool_id)) toolFirstStep.set(stp.tool_id, stepNo.get(stp)!);

  // One column on the left (the number, then a rule), the step on the right —
  // as several small tables rather than one tall row, so a long step can carry
  // on over a page instead of leaving half a page blank to stay whole.
  const stepPiece = (badge: string, body: string, cls = "keep", last = false) => `
    <table role="presentation" class="${cls}" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;margin:0">
      <tr>
        <td width="24" style="width:24px;vertical-align:top;padding:0">${badge}</td>
        <td style="padding:0 0 ${last ? 0 : 7}px 12px;border-left:2px solid ${LINE};vertical-align:top">${body}</td>
      </tr>
    </table>`;

  const label = (t: string) => `<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:${LEAFD};margin:0 0 3px">${esc(t)}</div>`;

  const stepRow = (stp: HydratedStep) => {
    const n = stepNo.get(stp)!;
    const tool = stp.tool_id ? d.tools[stp.tool_id] : null;
    // PRIORITY 5.1's gap, closed: a document meant to be a durable, standalone
    // reference cannot ship with an unfilled "[Name]"/"[Link to Google
    // profile]" bracket in it any more than a WhatsApp message can — and this
    // one function renders BOTH the full-plan PDF (planbuild.ts's
    // runPdfStage) and the plan webpage (api/plan.ts), so guarding here
    // covers both at once, with the same checkArtifact every other
    // artifact-touching path uses. `d.ctx` has no full Business to hand it,
    // just the exact two facts it can ever fill. On paper an unfilled part is
    // a line to write on, named — never the WhatsApp apology in its place.
    const artifact = checkArtifact(stp.artifact, { context: { name: d.ctx.name, location: d.ctx.location } });
    const artifactText = artifact.text ?? (artifact.draft ? blanks(artifact.draft) : null);
    // How to actually do it: the step's own fixed lines first; a tool's set-up
    // walkthrough once per document (see toolFirstStep).
    const howTo = stp.how_to?.length ? stp.how_to : libraryHowTo(stp.id);
    const firstUse = tool ? toolFirstStep.get(stp.tool_id!) === n : false;
    const walk = tool?.walkthrough?.length && firstUse ? tool.walkthrough : [];
    const lines = (items: readonly string[], numbered: boolean) =>
      items
        .map(
          (l, k) =>
            `<tr><td width="16" style="width:16px;vertical-align:top;padding:0 0 2px;font-size:10.5px;color:${LEAFD};font-weight:700">${numbered ? `${k + 1}.` : "&bull;"}</td><td style="vertical-align:top;padding:0 0 2px;font-size:10.5px;color:${INK2};line-height:1.45">${esc(l)}</td></tr>`,
        )
        .join("");
    const howBlock = (title: string, items: readonly string[], numbered: boolean) =>
      items.length ? `${label(title)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${lines(items, numbered)}</table>` : "";
    const badge = `<div style="width:24px;height:24px;line-height:24px;background:${LEAF};color:#ffffff;font-size:10.5px;font-weight:700;text-align:center;border-radius:12px">${n}</div>`;

    const pieces: string[] = [];
    pieces.push(
      stepPiece(
        badge,
        `<div style="font-size:13px;font-weight:700;color:${INK};margin:0 0 4px">${esc(stp.title)}${tool ? `<span style="display:inline-block;background:${MIST};color:${INK2};font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;border-radius:4px;padding:2px 7px;margin:2px 0 0 7px;line-height:1.4">${esc(tool.name)}</span>` : ""}</div>
          <div style="font-size:11.5px;color:${INK2};line-height:1.55">${esc(sentenceCase(stp.push))}</div>`,
        "keep keepnext",
      ),
    );
    // "Done when" rides with the last block above it, so it is never alone
    // at the top of a page (round 18).
    const bodies: string[] = [];
    if (howTo.length) bodies.push(howBlock("How to do it", howTo, false));
    if (walk.length) bodies.push(howBlock(`Setting up ${tool!.name}`, walk, true));
    else if (tool?.walkthrough?.length && !firstUse) bodies.push(`<div style="font-size:10.5px;color:${MUTE}">${esc(tool.name)}: set it up as shown in step ${toolFirstStep.get(stp.tool_id!)}.</div>`);
    if (artifactText) bodies.push(artifactBlock(artifactText, artifactKind(stp, artifactText)));
    const doneWhen = `<div style="font-size:10.5px;color:${MUTE};margin:7px 0 0"><b style="color:${INK2}">Done when:</b> ${esc(stp.done_when)}</div>`;
    if (bodies.length) bodies[bodies.length - 1] += doneWhen;
    else pieces[0] = pieces[0]!.replace(/<\/div>\s*<\/td>\s*<\/tr>\s*<\/table>\s*$/, `</div>${doneWhen}</td></tr></table>`);
    bodies.forEach((b, k) => pieces.push(stepPiece("", b, "keep", k === bodies.length - 1)));
    return { head: pieces[0]!, rest: `${pieces.slice(1).join("")}<div style="height:16px;font-size:1px">&nbsp;</div>` };
  };

  // What the box under a step is, said plainly: a message to send, words to
  // say, or a sheet to fill in. Round 17 labelled a debtors worksheet "Ready
  // to send". Decided from the fixed library's own brief for the step, and
  // from the shape of the text — never from a model.
  type ArtifactKind = "message" | "script" | "sheet" | "post" | "paste" | "keep";
  function artifactKind(stp: HydratedStep, text: string): ArtifactKind {
    if (sheetParts(text)) return "sheet";
    const brief = ((stp.artifact_brief && stp.artifact_brief !== "x" ? stp.artifact_brief : "") + " " + (libraryStep(stp.id)?.artifact_brief ?? "")).toLowerCase();
    if (/\b(post|posts|caption|captions|status)\b/.test(brief)) return "post";
    if (/\b(goal sentence|sentence, ready|offer line)\b/.test(brief)) return "paste";
    if (/what to say|the reply|the questions to ask|out loud|the one line/.test(brief)) return "script";
    if (/\b(message|dispute|complaint)\b/.test(brief)) return "message";
    if (/\b(sheet|tally|list|breakdown|layout|plan with|log|checklist|schedule|steps|columns)\b/.test(brief)) return "keep";
    return "message";
  }
  const KIND_LABEL: Record<ArtifactKind, string> = {
    message: "Ready to send",
    script: "What to say",
    sheet: "Your sheet: copy these columns",
    post: "Ready to post",
    paste: "Ready to paste",
    keep: "To keep and use",
  };

  /**
   * A sheet: the first line with two or more "|"-separated columns is the
   * header; any lines above it are its title; "|" lines below are its rows.
   * Round 18's sheets opened with a title line, so the old first-line test
   * missed every one of them.
   */
  function sheetParts(text: string): { title: string[]; cols: string[]; rows: string[][] } | null {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const at = lines.findIndex((l) => l.split("|").map((c) => c.trim()).filter(Boolean).length >= 2);
    if (at < 0 || at > 2) return null;
    const cols = lines[at]!.split("|").map((c) => c.trim()).filter(Boolean);
    const rows = lines
      .slice(at + 1)
      .filter((l) => l.includes("|") && !/^[|:\s]*-[|:\s-]*$/.test(l)) // "---|---" is markdown, not a row
      .map((l) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    return { title: lines.slice(0, at), cols, rows };
  }

  function artifactBlock(text: string, kind: ArtifactKind): string {
    const sheet = kind === "sheet" ? sheetParts(text)! : null;
    let body: string;
    if (sheet) {
      const filled = sheet.rows.filter((r) => r.some(Boolean));
      const blankRows = Math.max(3, Math.min(8, sheet.rows.length - filled.length));
      const cells = (r: string[]) => sheet.cols.map((_, k) => `<td style="padding:5px 6px;border:1px solid ${LINE};color:${INK2};height:14px">${esc(r[k] ?? "")}</td>`).join("");
      body = `${sheet.title.map((t) => `<div style="font-size:11px;font-weight:700;color:${INK2};margin:0 0 5px">${esc(t)}</div>`).join("")}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;font-size:10px;background:${PAPER}">
          <tr>${sheet.cols.map((c) => `<td style="padding:5px 6px;border:1px solid ${LINE};font-weight:700;color:${INK2};background:${MIST}">${esc(c)}</td>`).join("")}</tr>
          ${[...filled, ...Array.from({ length: blankRows }, () => [] as string[])].map((r) => `<tr>${cells(r)}</tr>`).join("")}
        </table>`;
    } else {
      body = `<div style="font-size:11px;color:${INK2};${kind === "keep" ? "" : "font-style:italic;"}line-height:1.5">${esc(text).replace(/\n/g, "<br>")}</div>`;
    }
    const fill = /________ \(/.test(text) ? `<div style="font-size:9.5px;color:${MUTE};margin:5px 0 0">Fill in the blanks before you use it.</div>` : "";
    return `<table role="presentation" class="keep" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${MIST}"><tr><td style="padding:9px 12px">
            ${label(KIND_LABEL[kind])}
            ${body}
            ${fill}
          </td></tr></table>`;
  }

  // The group's heading, its "why" and its first step's opening travel
  // together: a heading alone at the foot of a page was what a long plan
  // printed like. "Focus", not "Part": the document's own parts are I-III.
  const partBlock = (w: HydratedWorkstream, i: number, lead = "") => {
    const rows = w.steps.map(stepRow);
    return `
    <div class="keep">${lead}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:${i === 0 ? 0 : "24px"} 0 0"><tr><td style="padding:0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 10px"><tr>
      <td width="76" style="vertical-align:middle;background:${INK};color:#ffffff;font-size:10px;font-weight:700;padding:6px 10px;white-space:nowrap">FOCUS ${i + 1}</td>
      <td style="vertical-align:middle;padding-left:10px;background:${PAPER}"><div style="font-family:Georgia,'Times New Roman','Open Sans','Fin Symbols',serif;font-size:14.5px;font-weight:700;color:${INK}">${esc(w.title)}</div></td>
      <td style="vertical-align:middle;text-align:right;font-size:10px;color:${MUTE};white-space:nowrap">${stepRange(w)}</td>
    </tr></table>
    <div style="font-size:11px;color:${MUTE};margin:0 0 12px">${esc(sentenceCase(w.why_for_you))}</div>
    </td></tr></table>
    ${rows[0]?.head ?? ""}
    </div>
    ${rows[0]?.rest ?? ""}
    ${rows.slice(1).map((r) => r.head + r.rest).join("")}`;
  };
  const stepRange = (w: HydratedWorkstream) => {
    const ns = w.steps.map((x) => stepNo.get(x)!);
    if (!ns.length) return "";
    return ns.length === 1 ? `Step ${ns[0]}` : `Steps ${ns[0]}&ndash;${ns[ns.length - 1]}`;
  };

  const toolsTable = tools.length
    ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:11px">
      <thead><tr>${["Tool", "What it's for", "What it costs"].map((h) => `<td style="padding:5px 10px 6px 0;border-bottom:2px solid ${INK};font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:${MUTE}">${h}</td>`).join("")}</tr></thead>
      ${tools
        .map(
          (t) => `<tr>
        <td width="22%" style="padding:8px 10px 8px 0;border-bottom:1px solid ${LINE};vertical-align:top"><a href="${esc(t.url)}" style="color:${LEAFD};font-weight:700;text-decoration:none">${esc(t.name)}</a></td>
        <td width="32%" style="padding:8px 10px 8px 0;border-bottom:1px solid ${LINE};vertical-align:top;color:${INK2}">${esc(t.why)}</td>
        <td style="padding:8px 0 8px 0;border-bottom:1px solid ${LINE};vertical-align:top;color:${INK2}">${esc(costLine(t.cost, t.verified_on, t.free_type))}</td>
      </tr>`,
        )
        .join("")}
    </table>`
    : "";

  const extrasRows: string[] = [];
  if (d.planUrl) {
    extrasRows.push(
      `<div style="font-size:11.5px;color:${INK2};line-height:1.55;margin:0 0 8px"><b style="color:${INK}">Read it online.</b> The same document, always current, at <a href="${esc(d.planUrl)}" style="color:${LEAFD};font-weight:700">${esc(d.planUrl)}</a>. You sign in with the WhatsApp number you used here.</div>`,
    );
  }
  if (d.connectorUrl) {
    extrasRows.push(
      // Only connected people see this, and only the hash of their address is
      // stored — so there is no address to print, and telling them to send
      // "connect" for one would switch off the one they use. Say it is live.
      `<div style="font-size:11.5px;color:${INK2};line-height:1.55"><b style="color:${INK}">Your own AI is connected.</b> Wherever you added your private address — Claude, ChatGPT or both — it reads your money picture, this strategy and this plan live, so there is nothing to update. Lost the address, or think someone else has it? Send "connect" on WhatsApp and choose a new one; the old one then stops working.</div>`,
    );
  }
  // Lazy on purpose: sectionHead numbers sections in document order, and this
  // block renders LAST. Calling it while the helpers are being set up would
  // hand it section 01 and shift every real section off by one.
  const extras = () =>
    extrasRows.length
      ? `<div style="margin:26px 0 0">${sectionHead("Carrying this with you")}<table role="presentation" class="keep" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${MIST}"><tr><td style="padding:15px 18px;border-left:4px solid ${LEAF}">${extrasRows.join("")}</td></tr></table></div>`
      : "";

  const printCSS = `
  @page { size: A4; margin: 14mm 0; }
  @media print {
    .pagebreak { page-break-before: always; }
    .keep { page-break-inside: avoid; }
    a { text-decoration: none; }
  }
  .keep { page-break-inside: avoid; break-inside: avoid; }
  /* A heading is never the last thing on a page, and a table row is never cut in half. */
  .keepnext { page-break-after: avoid; break-after: avoid; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; break-inside: avoid; }
  div { orphans: 3; widows: 3; }`;

  const contents = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:18px 0 0;border:1px solid ${LINE}"><tr>
    ${[
      ["I", "Where your money stands", "The facts, and what they add up to"],
      ["II", "The strategy", "The goal, the rule, what it's worth"],
      ["III", "The next 90 days", "The steps, one at a time on WhatsApp"],
    ]
      .map(
        ([n, t, sub], i) => `
    <td width="33%" style="vertical-align:top;padding:11px 14px;${i < 2 ? `border-right:1px solid ${LINE};` : ""}">
      <div style="font-size:9.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${LEAFD}">Part ${n}</div>
      <div style="font-size:12px;font-weight:700;color:${INK};margin:2px 0 2px">${t}</div>
      <div style="font-size:10px;color:${MUTE};line-height:1.4">${sub}</div>
    </td>`,
      )
      .join("")}
  </tr></table>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(d.ctx.name)} — 90-day money plan</title><style>${printCSS}</style></head>
<body style="margin:0;padding:0;background:${PAPER};font-family:Helvetica,Arial,'Open Sans','Fin Symbols',sans-serif;color:${INK};font-size:12.5px;line-height:1.55;word-break:break-word;overflow-wrap:anywhere;-webkit-print-color-adjust:exact;print-color-adjust:exact">
<div style="max-width:720px;margin:0 auto">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td style="background:${INK};padding:34px 40px 22px">
  <div style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#8fd6ae;margin:0 0 9px">Money plan &middot; the next 90 days</div>
  <div style="font-family:Georgia,'Times New Roman','Open Sans','Fin Symbols',serif;font-size:28px;font-weight:700;color:#ffffff;line-height:1.15;margin:0 0 7px">${esc(d.ctx.name)}</div>
  <div style="font-size:13px;color:#cdd5cf;margin:0 0 12px;max-width:520px">${esc(d.ctx.one_liner)}</div>
  <div style="font-size:10.5px;color:#8b968f">${esc(d.ctx.location)} &nbsp;&middot;&nbsp; prepared ${dt} by ${esc(d.productName)}</div>
</td></tr></table>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
  <td width="33%" style="background:${LEAFD};padding:11px 16px;border-right:1px solid rgba(255,255,255,.18)"><div style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#a9e0c3;margin:0 0 2px">Stage</div><div style="font-size:12.5px;font-weight:700;color:#fff">${esc(STAGE_LABELS[d.stage] || d.stage)}</div></td>
  <td width="34%" style="background:${LEAFD};padding:11px 16px;border-right:1px solid rgba(255,255,255,.18)"><div style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#a9e0c3;margin:0 0 2px">Where things stand</div><div style="font-size:12.5px;font-weight:700;color:#fff">${greens} of 8 areas sorted</div></td>
  <td width="33%" style="background:${LEAFD};padding:11px 16px"><div style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#a9e0c3;margin:0 0 2px">The plan</div><div style="font-size:12.5px;font-weight:700;color:#fff">${totalSteps} steps &middot; ${(d.plan.workstreams || []).length} focus area${(d.plan.workstreams || []).length === 1 ? "" : "s"}</div></td>
</tr></table>

<div style="padding:0 40px">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:22px 0 0">
  <tr><td style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${LEAFD};padding:0 0 6px 4px">The problem we're solving</td></tr>
  <tr><td style="background:${MIST};padding:15px 18px;border-left:4px solid ${LEAF}">
    <div style="font-family:Georgia,'Times New Roman','Open Sans','Fin Symbols',serif;font-size:15px;font-weight:700;color:${INK};line-height:1.35;margin:0 0 4px">${esc(d.objectiveRead || d.ctx.goal)}</div>
    <div style="font-size:11.5px;color:${MUTE}">${
      // "In your words" quotes only what the person said. Round 18 printed
      // the model's goal there, with a "20 packs a day" nobody had said.
      d.ownerWords?.trim() ? `In your words: &ldquo;${esc(d.ownerWords.trim())}&rdquo;` : `The 90-day goal: ${esc(d.ctx.goal)}`
    }</div>
  </td></tr>
</table>

${contents}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-top:1px solid ${LINE};margin:14px 0 0"><tr>
  <td style="padding:10px 0 0;font-size:9.5px;color:${MUTE}">Confirm any credit or debt point with ${esc(co.registrar)}, any grant with ${esc(co.grants)}, and any tax point with ${esc(co.tax)}. Fees and rates were correct when checked and can move. Nothing here is a loan recommendation.</td>
  <td style="padding:10px 0 0;font-size:9.5px;color:${MUTE};text-align:right;white-space:nowrap;vertical-align:top">Prepared by ${esc(d.productName)}</td>
</tr></table>

<div class="keep">
${partDivider("I", "Where your money stands", "The facts as you gave them, and what they add up to.", false)}
  ${sectionHead("Your money, on paper")}
  ${factsHead}
</div>
${factsRest}

${
  st
    ? `<div style="margin:26px 0 0">
  ${sectionHead("What your answers add up to")}
  ${st.reading.map((x, i) => para(x, i === st.reading.length - 1)).join("")}
</div>`
    : ""
}

<div style="margin:26px 0 0">
  ${sectionHead("The eight areas")}
  <div class="keep"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${mapTable}</table>
  <div style="font-size:10px;color:${MUTE};margin-top:6px"><span style="color:${RAG.red};font-weight:700">${DOT}</span> Not sorted &nbsp;&nbsp; <span style="color:${RAG.amber};font-weight:700">${DOT}</span> In progress &nbsp;&nbsp; <span style="color:${RAG.green};font-weight:700">${DOT}</span> Sorted</div></div>
  ${sortedMeans}
</div>

${
  st
    ? `<div style="margin:26px 0 0">
  ${sectionHead("Working, and leaking")}
  ${workingLeaking}
</div>`
    : ""
}

<div style="margin:0">
  <div class="keep">
  ${partDivider("II", "The strategy", "The goal you chose, the rule you'll keep, and what winning is worth.", false)}
  ${sectionHead("The one thing to fix first")}
  ${goalCardList[0] ?? ""}
  </div>
  ${goalCardList.slice(1).join("")}
</div>

<div style="margin:26px 0 0">
  ${sectionHead("The rule you live by")}
  ${ruleBlocks}
  ${altTable}
  ${st ? `<div style="margin-top:14px">${para(st.how_we_win, true)}</div>` : ""}
</div>
${
  !st && d.strategyPending
    ? `<div style="margin:22px 0 0">
  <table role="presentation" class="keep" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${MIST}"><tr><td style="padding:14px 17px;border-left:4px solid ${LEAF}">
    <div style="font-size:12px;font-weight:700;color:${INK};margin:0 0 4px">The rest of the strategy is still being written</div>
    <div style="font-size:11.5px;color:${INK2};line-height:1.6">How you win, what you won&rsquo;t do, the money logic, the risks and what success looks like at 30, 60 and 90 days are being written for you now. Fin sends a message on WhatsApp when they are done, and they are added here. Your steps below don&rsquo;t depend on them: start whenever you&rsquo;re ready.</div>
  </td></tr></table>
</div>`
    : ""
}

${
  st?.wont_do.length
    ? `<div style="margin:26px 0 0">
  ${sectionHead("What we deliberately won't do")}
  <div style="font-size:10.5px;color:${MUTE};margin:0 0 9px">A money plan is also what it refuses. These protect the ninety days from the things that usually eat them.</div>
  ${bulletList(st.wont_do, "#8a5a10")}
</div>`
    : ""
}

${
  st?.money_logic
    ? `<div style="margin:26px 0 0">
  ${sectionHead("The money logic")}
  <table role="presentation" class="keep" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${MIST}"><tr><td style="padding:14px 17px;border-left:4px solid ${LEAF}">
    <div style="font-size:12px;color:${INK2};line-height:1.6">${esc(st.money_logic)}</div>
  </td></tr></table>
  <div style="font-size:10px;color:${MUTE};margin-top:6px">${/estimate|my guess|starting guess/i.test(st.money_logic) ? "Your own figures are used wherever you gave them. Anything marked as an estimate is Fin&rsquo;s working, not a fact — check it against your real numbers." : "Every number above is yours or carries a verification date — nothing is estimated on your behalf."}</div>
</div>`
    : ""
}

${
  milestones
    ? `<div style="margin:26px 0 0">
  ${sectionHead("What success looks like")}
  ${milestones}
</div>`
    : ""
}

${
  st?.risks.length
    ? `<div style="margin:26px 0 0">
  ${sectionHead("What could derail it")}
  ${risksTable}
</div>`
    : ""
}

<div style="margin:0">
  ${(d.plan.workstreams || [])
    .map((w, i) =>
      partBlock(
        w,
        i,
        // The Part III banner, "The steps" and the goal never sit alone at
        // the foot of a page: they travel with the first focus and its first
        // step (round 18 stranded them on p6 of all four plans).
        i === 0
          ? `${partDivider("III", "The next 90 days", `${esc(d.plan.headline)} ${esc(d.plan.order_note)}`, false)}${sectionHead("The steps")}<div style="font-size:12px;font-weight:700;color:${INK2};margin:0 0 16px">${esc(d.plan.goal)}</div>`
          : "",
      ),
    )
    .join("")}
</div>

${tools.length ? `<div style="margin:26px 0 0">${sectionHead("The tools this plan uses")}${toolsTable}</div>` : ""}

${extras()}



</div>
</div>
</body></html>`;
}
