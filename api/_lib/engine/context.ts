// Charles — assembling what the model knows about one person, per message.
//
// Kept small on purpose. The core block is the expensive part of every call, so
// it carries the business, the map, the choices, a compact view of the plan,
// the last few turns, and a SHORTLIST of knowledge and tools — never the whole
// library.

import { core } from "../prompts.js";
import { costLine, shortlist, kSheet, tSheet } from "../retrieval.js";
import { optionAnswersText } from "../safety.js";
import { moneyIn } from "../grounding.js";
import { DISPUTED, ownFigures, pricedRows, type PricedRow } from "../pricestamp.js";
import { knowledgeFor, ownerNotes, planFor, recentMessages, toolsFor, type OwnerNote } from "../db.js";
import type { Business, KnowledgeRow, PlanStepRow } from "../types.js";

export interface CoreBlock {
  text: string;
  toolsSheet: string;
  /**
   * The shortlisted knowledge rows' costs, one compact line each, for the
   * reply guardrail: a fee the model took from KNOWLEDGE is a verified cost
   * too (review, round 21). A row whose own text says a figure is disputed
   * ("published figures differ") is left out, so that figure stays unbacked.
   */
  knowledgeCosts: string;
  /** The figures each shortlisted row carries and when it was checked (pricestamp.ts). */
  priced: PricedRow[];
  /** The shortlisted knowledge rows as the model saw them: what a date or a law in the reply must come from (datecheck.ts). */
  knowledgeSheet: string;
  /** The person's own recent messages: a date they gave a turn ago is theirs to be reminded of (datecheck.ts). */
  ownerTurns: string;
  steps: PlanStepRow[];
  nextOpen: PlanStepRow | null;
  /** The library had something real on this: a keyword match, or a match by meaning. False means "I don't have verified information on this yet". */
  grounded: boolean;
}

/** A compact view of the plan: enough to answer "where am I?" without the prose. */
export function planSummary(steps: PlanStepRow[]): string {
  if (!steps.length) return "";
  const byPart = new Map<string, PlanStepRow[]>();
  for (const s of steps) {
    const k = s.workstream_title ?? "Plan";
    if (!byPart.has(k)) byPart.set(k, []);
    byPart.get(k)!.push(s);
  }
  return [...byPart.entries()]
    .map(([title, rows]) => {
      const lines = rows
        .map((r) => `   [${r.status === "done" ? "x" : r.status === "skipped" ? "-" : " "}] ${r.title}`)
        .join("\n");
      return `${title}\n${lines}`;
    })
    .join("\n");
}

export const firstOpenStep = (steps: PlanStepRow[]): PlanStepRow | null =>
  steps.find((s) => s.status === "open") ?? null;

export interface CoreOptions {
  /** The person's words, used to score the shortlist. */
  query: string;
  domain?: string | null;
  maxKnowledge?: number;
  maxTools?: number;
  /** The person's own words, for a knowledge signal if the library has nothing. See retrieval.ts. */
  quote?: string | null;
  /** The message being answered, for the amounts it asks about (figuresAskedAbout). Answers only. */
  asked?: string;
  /** False: no semantic rescue and no gap logging. See shortlist() in retrieval.ts. */
  semantic?: boolean;
  /**
   * This one turn is answered under the stabilising rules although the
   * business is not in stabilising mode (the router read distress and the
   * evidence check declined the stage flip — see engine/qa.ts). A business
   * whose stage IS stabilizing always gets the rules; no flag needed.
   */
  stabilisingTurn?: boolean;
}

/** The database reads a core block needs. None depends on the router's output. */
export interface CoreData {
  knowledge: Awaited<ReturnType<typeof knowledgeFor>>;
  tools: Awaited<ReturnType<typeof toolsFor>>;
  recent: Awaited<ReturnType<typeof recentMessages>>;
  plan: Awaited<ReturnType<typeof planFor>>;
  /** What Charles remembers about the person (owner_notes), newest first. Empty if none or unreadable. */
  notes: OwnerNote[];
}

/**
 * The five reads, in parallel. Split out of buildCore so a caller can start
 * them before it knows the query (composeAnswer starts them alongside the
 * router call, which they do not depend on) and hand the promise in.
 */
export async function loadCoreData(biz: Pick<Business, "id" | "country">): Promise<CoreData> {
  const [knowledge, tools, recent, plan, notes] = await Promise.all([
    knowledgeFor(biz.country),
    toolsFor(biz.country),
    recentMessages(biz.id, 10),
    planFor(biz.id),
    // Never fails a turn: an unreadable memory is an empty one (db.ts).
    ownerNotes(biz.id, 12).catch(() => [] as OwnerNote[]),
  ]);
  return { knowledge, tools, recent, plan, notes };
}

/** The person notes as the prompts show them: one line each, newest first. */
export function notesSheet(notes: Pick<OwnerNote, "about" | "note">[]): string {
  return notes.map((n) => `- (${n.about}) ${n.note}`).join("\n");
}

/**
 * A follow-up about a fee just given — "is it still the same?", "same
 * price?", "has it gone up?", "is that the current fee?". Not a bare "still"
 * or "same", and not "is it still open?" or "you said I should post daily":
 * only words that are about the figure itself (review, round 22).
 */
const REFERS_BACK =
  /\b(?:is (?:it|that|this) still (?:the same|that|so|right|correct|true|valid|the (?:price|fee|cost|rate|amount))|still the same|(?:the )?same (?:price|fee|cost|amount|rate)|that (?:price|fee|figure|amount|rate|cost)|has (?:it|that|the (?:price|fee|cost|rate)) (?:changed|gone up|increased|gone down)|(?:is|was) (?:that|it) the (?:current|latest|new) (?:price|fee|cost|rate))\b/i;
/** Words that make a short message about what something costs. */
const ABOUT_A_FEE = /\b(?:cost|costs|fee|fees|price|prices|charge|charges|charged|rate|rates|how much|still|same|pay)\b/i;

/**
 * The amounts a person is asking about, for retrieval (ShortlistQuery.figures).
 * From their own short question about a cost — never a long message (a
 * pasted scam names amounts too, and must not pull a fee row in and get it
 * dated), never an amount that is theirs (their price, a loan they want:
 * pricestamp.ts ownFigures), never one in a message that is not about a cost.
 * Or, when the message refers back to a fee without naming it, the amounts
 * Charles's last reply gave. Round 22, live: "is it still KSh 950?"
 * retrieved nothing, so its answer could only be dated from the model's
 * memory of the turn before — and once it was not.
 */
export function figuresAskedAbout(said: string, own: Set<number>, recent: { direction: string; text: string }[]): number[] {
  const words = said.trim().split(/\s+/).filter(Boolean).length;
  if (!words || words > 20) return [];
  if (moneyIn(said).length) return ABOUT_A_FEE.test(said) ? moneyIn(said).filter((n) => !own.has(n)) : [];
  if (!REFERS_BACK.test(said)) return [];
  const last = [...recent].reverse().find((m) => m.direction === "out" && moneyIn(m.text).length);
  return last ? [...new Set(moneyIn(last.text))].filter((n) => !own.has(n)).slice(0, 6) : [];
}

export async function buildCore(biz: Business, opts: CoreOptions, preloaded?: Promise<CoreData>): Promise<CoreBlock> {
  const { knowledge, tools, recent, plan, notes } = await (preloaded ?? loadCoreData(biz));

  const short = await shortlist(
    knowledge,
    tools,
    {
      text: opts.query,
      // Only for a question in the person's own turn: a plan step's help or a
      // build never matches rows by figure.
      ...(opts.asked !== undefined ? { figures: figuresAskedAbout(opts.asked, ownFigures(biz, opts.asked).money, recent.slice(-4)) } : {}),
      stage: biz.biz_stage || "stretching",
      domain: opts.domain ?? null,
      headache: biz.context?.headache || biz.answers?.objective || null,
      maxKnowledge: opts.maxKnowledge ?? 4,
      maxTools: opts.maxTools ?? 5,
    },
    { businessId: biz.id, country: biz.country, quote: opts.quote ?? null, semantic: opts.semantic },
  );

  const steps = plan?.steps ?? [];
  const toolsSheet = tSheet(short.tools);
  const priced = pricedRows(short.knowledge, short.tools);
  const knowledgeCosts = knowledgeCostsOf(short.knowledge);
  const knowledgeSheet = kSheet(short.knowledge);

  return {
    text: core({
      countryCode: biz.country,
      ctx: biz.context ?? biz.identity ?? {},
      map: biz.map ?? [],
      bizStage: biz.biz_stage || "stretching",
      goal: biz.goal ?? [],
      rule: biz.rule ?? [],
      knowledgeSheet,
      toolsSheet,
      recent,
      planSummary: planSummary(steps),
      // Rule 9 lives in the core, so every prompt built from it — an answer,
      // a forwarded link or file, step help — carries it.
      stabilising: biz.stage === "stabilizing" ? "mode" : opts.stabilisingTurn ? "turn" : null,
      setupAnswers: optionAnswersText(biz.answers),
      ownerNotes: notesSheet(notes ?? []),
    }),
    toolsSheet,
    knowledgeCosts,
    priced,
    knowledgeSheet,
    ownerTurns: recent.filter((m) => m.direction === "in").map((m) => m.text).join("\n"),
    steps,
    nextOpen: firstOpenStep(steps),
    grounded: short.topScore > 0 || Boolean(short.semantic),
  };
}

/**
 * The knowledge rows' costs, one compact line each, for the reply guardrail —
 * clause by clause, like pricedRows: a row's settled fees count, its disputed
 * clause does not (review, round 21: dropping the whole row lost a settled
 * KES 950 because another clause said "sources disagree").
 */
export function knowledgeCostsOf(rows: KnowledgeRow[]): string {
  return rows
    .map((k) => ({ k, settled: (k.cost ?? "").split(";").filter((c) => !DISPUTED.test(c)).map((c) => c.trim()).filter(Boolean).join("; ") }))
    .filter(({ settled }) => settled)
    .map(({ k, settled }) => `${k.id} | ${k.title} | cost: ${costLine(settled, k.verified_on)}`)
    .join("\n");
}

/**
 * What a date, a law or a waiting time in a reply may come from
 * (datecheck.ts): the rows the reply was given, the person's answers and
 * business context, and their own recent messages. (The rows' check dates
 * go separately, as exact dates only: checkDaysOf, pricestamp.ts.) Never Charles's earlier replies:
 * a date one of them invented would vouch for itself.
 */
export function dateSources(cb: CoreBlock, biz: Pick<Business, "answers" | "context">, extra: string[] = []): string[] {
  return [cb.knowledgeSheet, cb.toolsSheet, cb.ownerTurns, JSON.stringify(biz.answers ?? {}), JSON.stringify(biz.context ?? {}), ...extra];
}

/** One line for the router, which must stay cheap. */
export function contextSummary(biz: Business): string {
  const c = biz.context;
  if (!c) return biz.identity?.one_liner || biz.answers?.person || "a person and their household's money";
  return [
    c.name,
    c.earns,
    c.location,
    `stage ${biz.biz_stage || "stretching"}`,
    c.owes ? `owes: ${c.owes}` : "",
    c.depends ? `supports: ${c.depends}` : "",
    c.goal ? `goal: ${c.goal}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}
