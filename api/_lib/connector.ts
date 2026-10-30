// Charles — what the person's own AI can see and do.
//
// The point of this is cost as much as capability: deep reasoning runs on the
// owner's own Claude or ChatGPT subscription, against the same business memory
// WhatsApp uses. One database, two front doors.
//
// The safety property that matters most here: an AI connected through this can
// READ everything, LOG things, and record what the person tells it they did (a
// step done or skipped, whether it worked, something about themselves), but it
// cannot silently change a critical fact about the business or the plan's
// steps. propose_change and request_plan_change write a pending row and push a
// yes/no question to WhatsApp. Anything else would mean a person's plan could
// be rewritten by a chat they had on their laptop, with no record and no
// consent.
//
// Round 27: the person can drive Charles entirely from their own AI. Every
// tool below writes the same state the WhatsApp side does, through the same
// functions, so the two doors never disagree about where the person is.

import { env } from "./env.js";
import { hashSecret, mintToken } from "./crypto.js";
import {
  addCommitment,
  addOwnerNote,
  db,
  deleteOwnerNote,
  enqueueForPlan,
  findBusinessById,
  knowledgeFor,
  logDecision,
  logOutcome,
  NOTE_ABOUT,
  NOTE_MAX,
  openCommitments,
  ownerNotes,
  planFor,
  recentDecisions,
  recentMessages,
  recordKnowledgeSignal,
  recordSafetyEvent,
  SECRET_DETAIL,
  signalLibraryFor,
  toolById,
  toolsFor,
  updateBusiness,
} from "./db.js";
import { shortlist, costLine, keywordScore } from "./retrieval.js";
import { connectorInstructions } from "./prompts.js";
import { sendButtons, sendText, withinServiceWindow } from "./wa.js";
import { ACT } from "./actions.js";
import { firstOpenStep, planSummary } from "./engine/context.js";
import { checkArtifact } from "./engine/artifact.js";
import { libraryHowTo } from "./playbooks.js";
import { country } from "./countries.js";
import { checkMessageDistress, saysMoneyTrouble } from "./safety.js";
import { viewToolMeta } from "./appview.js";
import { DOMAIN_LABELS, DOMAINS } from "./types.js";
import type { Business, PlanRow, PlanStepRow, Stage } from "./types.js";
import { matchEntity } from "./signals.js";
import { track, trackFailure, trackUnmet } from "./track.js";

/**
 * An error, safe for trackFailure: a database error becomes its code and
 * message, never `details`. supabase-js hands its errors back as plain
 * objects, which errorText prints whole, and Postgres puts the failing row in
 * `details` — here a proposed change in the person's own words, or a
 * business row with its number. A real Error and a string pass through.
 */
export function dbError(err: unknown): unknown {
  if (err instanceof Error || typeof err === "string") return err;
  const e = (err && typeof err === "object" ? err : {}) as { code?: unknown; message?: unknown };
  return `${e.code ? `${String(e.code)}: ` : ""}${e.message !== undefined ? String(e.message) : "database error"}`.slice(0, 300);
}

/** Facts that reshape the plan. Changing one needs the person's word, on WhatsApp. */
export const CRITICAL_FACTS = [
  "earns",
  "income",
  "owes",
  "depends",
  "cushion",
  "cover",
  "goal",
  "location",
  "records",
] as const;

// ── Tokens ───────────────────────────────────────────────────────

/** True once the person has a working address (an unrevoked token). */
export async function hasLiveConnector(businessId: string): Promise<boolean> {
  const { data, error } = await db().from("connector_tokens").select("token_hash").eq("business_id", businessId).is("revoked_at", null).limit(1);
  if (error) throw error;
  return ((data as unknown[] | null) ?? []).length > 0;
}

/**
 * A new private address for the person's own AI, and every earlier one
 * switched off — "a fresh one" has to mean the old one stops working, or an
 * address the person thinks they replaced (a leaked one, a sold laptop) still
 * reads the business. The new row goes in first and the old ones are revoked
 * after, so a failure part-way can never leave the person with no working
 * address. If the revoke fails, the new one is revoked too and null comes
 * back: nothing changed, and the person is asked to try again. The caller asks
 * before replacing an address that is in use.
 */
export async function issueConnectorToken(businessId: string, label = "Owner's AI"): Promise<string | null> {
  if (!env.PUBLIC_BASE_URL || !env.SESSION_SECRET) {
    console.log("connector: PUBLIC_BASE_URL and SESSION_SECRET must both be set to issue a token");
    return null;
  }
  const token = mintToken(32);
  const hash = hashSecret(token);
  const { error } = await db().from("connector_tokens").insert({ token_hash: hash, business_id: businessId, label });
  if (error) {
    console.log("issueConnectorToken failed", error);
    return null;
  }
  const { data: revokedRows, error: revokeError } = await db()
    .from("connector_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .neq("token_hash", hash)
    .is("revoked_at", null)
    .select("token_hash");
  if (revokeError) {
    console.log("issueConnectorToken: could not switch off the old address; withdrawing the new one so nothing changes", revokeError);
    const { error: withdrawError } = await db().from("connector_tokens").update({ revoked_at: new Date().toISOString() }).eq("token_hash", hash);
    if (withdrawError) console.error("issueConnectorToken: the new address could not be withdrawn either (nobody has been sent it)", withdrawError);
    return null;
  }
  // An address switched off is a security fact worth keeping: the person
  // replaced one they had lost or thought someone else had.
  const revoked = ((revokedRows as unknown[] | null) ?? []).length;
  if (revoked) track("connector_revoked", { category: "security", props: { count: revoked, why: "replaced" } });
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/mcp/${token}`;
}

export async function businessForToken(token: string): Promise<Business | null> {
  if (!token) return null;
  const { data, error } = await db()
    .from("connector_tokens")
    .select("business_id, revoked_at")
    .eq("token_hash", hashSecret(token))
    .maybeSingle();
  const row = data as { business_id: string; revoked_at: string | null } | null;
  // Refused here rather than in mcp.ts, which only sees the null: here is
  // where unknown, replaced, forgotten and our own failure can be told apart.
  // Never the token.
  if (error) {
    // The person's AI is told the address is "not valid any more" when it is
    // our database that failed: a person may then replace a working address.
    console.log("businessForToken: token lookup failed", error);
    trackFailure("mcp_auth_failed", dbError(error), {
      severity: "error",
      props: { reason: "lookup_failed" },
      fingerprint: "mcp_auth_failed:lookup_failed",
      summary: "A person's AI was refused because the address lookup failed (it was told the address is no longer valid)",
    });
    return null;
  }
  if (!row || row.revoked_at) {
    const reason = !row ? "unknown_token" : "revoked";
    track("mcp_auth_failed", {
      category: "security",
      severity: "warn",
      alert: "digest",
      businessId: row?.business_id ?? null,
      props: { reason },
      fingerprint: `mcp_auth_failed:${reason}`,
      summary: !row ? "An AI connector used an address Charles does not know" : "A person's AI is still using an address they replaced",
    });
    return null;
  }

  // Best-effort touch; never let it fail a request.
  // A supabase-js builder only runs when awaited or then'd: as a bare `void`
  // this update never ran, so last_used_at was never written. Not awaited:
  // the AI's request does not wait on it.
  void db().from("connector_tokens").update({ last_used_at: new Date().toISOString() }).eq("token_hash", hashSecret(token)).then(
    ({ error }) => void (error && console.warn("connector: last_used_at not recorded", error)),
    (err) => console.warn("connector: last_used_at not recorded", err),
  );
  const biz = await findBusinessById(row.business_id);
  if (!biz) {
    track("mcp_auth_failed", {
      category: "security",
      severity: "info",
      businessId: null,
      props: { reason: "business_gone" },
    });
  }
  return biz;
}

// ── Tool definitions ─────────────────────────────────────────────

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Round 28: a tool whose answer is drawn as a view in Claude and ChatGPT (appview.ts). */
  _meta?: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const TOOLS: ToolDef[] = [
  {
    name: "get_household_context",
    title: "Household context",
    description:
      "Everything Charles knows about this one person's money: where it comes from, where they live, their money stage, the goal they chose, the one rule they live by, their 90-day goal, the step they are on (the north star), their progress, what Charles remembers about them, recent decisions, and the house rules for giving them advice. Call this first, before answering anything.",
    inputSchema: obj({}),
  },
  {
    name: "get_money_map",
    title: "Money map",
    description:
      "The eight areas of the person's money (money in, money out, what they owe, emergency money, credit record, cover, family money, the future) scored red, amber or green against a fixed rubric, each with a note. Use it to see what is already sorted and what is not.",
    inputSchema: obj({}),
    _meta: viewToolMeta("Drawing your money map…", "Your money map"),
  },
  {
    name: "get_plan",
    title: "The 90-day plan",
    description: "The person's current 90-day money plan: the goal, the strategy, every step with what it is for and whether it is done, skipped or still open, their progress, and the link to read it online.",
    inputSchema: obj({}),
    _meta: viewToolMeta("Opening your plan…", "Your 90-day plan"),
  },
  {
    name: "get_current_step",
    title: "The step they are on",
    description:
      "The one step to work on now, in full: what to do, why it matters for this person, when it counts as done, the words already written for them, how to do it, and its tool with the checked cost and set-up steps. Use it whenever they ask what to do next, or have time to work on their money. Set send_to_whatsapp to also send it to their phone.",
    inputSchema: obj({
      send_to_whatsapp: { type: "boolean", description: "Also send this step to the person on WhatsApp, as Charles's 'Next step' does. Only when they ask for it on their phone." },
    }),
    _meta: viewToolMeta("Getting the step you're on…", "The step you're on"),
  },
  {
    name: "complete_step",
    title: "Mark a step done",
    description:
      "Mark a plan step done, ONLY when the person tells you they have done it. Then ask whether it has made a difference yet, and record their answer with report_outcome. Defaults to the step they are on.",
    inputSchema: obj({
      step_id: { type: "string", description: "The step's id, from get_current_step or get_plan. Leave out for the step they are on." },
    }),
  },
  {
    name: "skip_step",
    title: "Skip a step",
    description:
      "Skip a plan step, ONLY when the person decides it does not apply to them or they will not do it, with their reason. A step that is hard is one to help them with, not to skip. Defaults to the step they are on.",
    inputSchema: obj(
      {
        step_id: { type: "string", description: "The step's id. Leave out for the step they are on." },
        reason: { type: "string", description: "Why, in the person's words." },
      },
      ["reason"],
    ),
  },
  {
    name: "report_outcome",
    title: "Record whether a step worked",
    description:
      "Record what the person says a finished step has done for their money: better (it has made a difference), same (no change), or too_early. Only their answer, never your guess. A 'better' can move that area of their money map up.",
    inputSchema: obj(
      {
        step_id: { type: "string", description: "The finished step's id (complete_step returns it)." },
        effect: { type: "string", enum: ["better", "same", "too_early"], description: "What the person said." },
      },
      ["step_id", "effect"],
    ),
  },
  {
    name: "request_plan_change",
    title: "Ask to change the plan's steps",
    description:
      "Pass on a change the person wants to their plan's steps: drop a step that does not apply, swap a step's tool, or move a part earlier. This does NOT change anything: Charles asks the person on WhatsApp, and makes the change only on their yes. Never tell them it has been changed. For a change to a fact about the business (what they sell, their price...), use propose_change instead.",
    inputSchema: obj(
      {
        change: { type: "string", description: "The change, in the person's words, naming the step or part." },
        reason: { type: "string", description: "Why, in one line. The person reads this." },
      },
      ["change"],
    ),
  },
  {
    name: "send_plan_pdf",
    title: "Send the plan document",
    description:
      "Send the person their 90-day plan as a PDF on WhatsApp (it arrives within a minute or two). It also gives the link to read the same plan online.",
    inputSchema: obj({}),
  },
  {
    name: "remember",
    title: "Remember something about the person",
    description:
      "Keep something the person told you about themselves that should shape advice from now on, on WhatsApp and here: the hours they have, who helps them, money they can or cannot put in, how they like to work, what worries them. One line, in their terms. Only what they said, never your guess about them; never an ID, bank, card or password detail. Business facts (what they sell, their prices) are not for this: propose_change.",
    inputSchema: obj(
      {
        note: { type: "string", description: `What to remember, one line, at most ${NOTE_MAX} characters.` },
        about: { type: "string", enum: [...NOTE_ABOUT], description: "What kind of thing it is." },
      },
      ["note"],
    ),
  },
  {
    name: "forget_note",
    title: "Forget something remembered",
    description: "Delete one thing Charles remembers about the person, when they ask you to forget it or it is wrong. The ids are in get_household_context, under remembered.",
    inputSchema: obj({ note_id: { type: "string", description: "The note's id." } }, ["note_id"]),
  },
  {
    name: "flag_hardship",
    title: "Flag real money trouble",
    description:
      "Call when the person describes real money hardship: they cannot cover food, rent, transport, electricity or school fees, a wage or grant has stopped, debt collectors, a garnishee, a loan shark. Charles checks their words and, if it agrees, pauses the plan on WhatsApp too (stabilising mode: protect cash, nothing paid). Not for a slow week or a worry about growth.",
    inputSchema: obj({ what_they_said: { type: "string", description: "The person's own words about it." } }, ["what_they_said"]),
  },
  {
    name: "find_knowledge",
    title: "Find grounded knowledge and tools",
    description:
      "Search Charles's verified library of how-to knowledge and named tools for this country. Every cost comes back with its verification date. Use ONLY what this returns for prices, fees, rules and links — never your own knowledge of them.",
    inputSchema: obj(
      {
        query: { type: "string", description: "What the person needs, in their words." },
        domain: {
          type: "string",
          enum: [...DOMAINS],
          description: "Optional: narrow to one area of their money.",
        },
      },
      ["query"],
    ),
  },
  {
    name: "log_decision",
    title: "Log a decision",
    description:
      "Record something the person has DECIDED, so their WhatsApp assistant knows about it too. Only call this once the person has actually agreed to it — a suggestion is not a decision.",
    inputSchema: obj(
      {
        what: { type: "string", description: "The decision, in one line, in the person's terms." },
        why: { type: "string", description: "Why they decided it." },
      },
      ["what"],
    ),
  },
  {
    name: "add_commitment",
    title: "Add a commitment",
    description:
      "Record something the person said they will do. Charles will follow up on WhatsApp and ask whether it happened. Only for things the person committed to, not things you suggested.",
    inputSchema: obj(
      {
        what: { type: "string", description: "What they will do." },
        due: { type: "string", description: "Due date as YYYY-MM-DD. Defaults to three days from now." },
      },
      ["what"],
    ),
  },
  {
    name: "propose_change",
    title: "Propose changing a critical fact",
    description:
      "Suggest changing a fact that would reshape the plan (where their money comes from, how much comes in, what they owe, who depends on them, their emergency money, their cover, their 90-day goal, where they live, how they keep records). This does NOT change anything: it asks the person to confirm on WhatsApp. Never tell the person the change has been made. For a change to the plan's steps, use request_plan_change.",
    inputSchema: obj(
      {
        fact: { type: "string", enum: [...CRITICAL_FACTS], description: "Which fact." },
        from: { type: "string", description: "What Charles currently believes." },
        to: { type: "string", description: "What it should become." },
        reason: { type: "string", description: "Why, in one line — the person reads this." },
      },
      ["fact", "to", "reason"],
    ),
  },
];

// ── Tool execution ───────────────────────────────────────────────

export interface ToolResult {
  text: string;
  structured?: Record<string, unknown>;
  isError?: boolean;
  /** What happened, as a short label for tracking (mcp_tool_called): never sent to the AI. */
  code?: string;
}

export async function callTool(biz: Business, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case "get_household_context": {
      const [plan, commitments, recent, notes, decisions] = await Promise.all([
        planFor(biz.id),
        openCommitments(biz.id),
        recentMessages(biz.id, 8),
        ownerNotes(biz.id, 30),
        recentDecisions(biz.id, 8),
      ]);
      const steps = plan?.steps ?? [];
      const current = firstOpenStep(steps);
      const structured = {
        instructions: connectorInstructions(biz.country),
        north_star: northStar(biz, plan),
        country: biz.country,
        stage: biz.biz_stage ?? "stretching",
        identity: biz.identity ?? {},
        context: biz.context ?? {},
        objective: biz.objective_read ?? "",
        goal: biz.goal ?? [],
        rule: biz.rule ?? [],
        alternatives: biz.alternatives ?? [],
        plan_goal: plan?.plan.goal ?? null,
        strategy: plan?.plan.strategy ?? null,
        progress: plan ? progressOf(steps) : null,
        current_step: current ? { id: current.id, title: current.title, part: current.workstream_title, position: positionOf(steps, current), done_when: current.done_when } : null,
        paused_for_hardship: biz.stage === "stabilizing",
        on_whatsapp: WHATSAPP_AT[biz.stage] ?? null,
        // What Charles remembers about the person as a person (db/0032): from
        // them, here or on WhatsApp. The ids are for forget_note.
        remembered: notes.map((n) => ({ id: n.id, about: n.about, note: n.note, from: n.source === "connector" ? "their AI" : n.source, on: String(n.created_at ?? "").slice(0, 10) })),
        recent_decisions: decisions.map((d) => ({ what: d.what, why: d.why, on: String(d.created_at ?? "").slice(0, 10) })),
        open_commitments: commitments.map((c) => ({ what: c.what, due: c.due })),
        recent_whatsapp: recent.map((m) => `${m.direction === "in" ? "Person" : "Charles"}: ${m.text}`),
        read_plan_online: await planLink(),
      };
      return { text: JSON.stringify(structured, null, 2), structured };
    }

    case "get_money_map": {
      const { data, error } = await db().from("business_map").select("domain, status, note, updated_at").eq("business_id", biz.id);
      const rows = ((data as { domain: string; status: string; note: string }[]) ?? biz.map ?? []).map((m) => ({ ...m, label: DOMAIN_LABELS[m.domain] ?? m.domain }));
      const structured = { view: "map", business: personName(biz), map: rows };
      if (error) {
        // The AI is handed the copy on the business row instead, which can lag.
        trackFailure("mcp_tool_failed", dbError(error), {
          severity: "warn",
          props: { tool: "get_money_map", reason: "read_failed" },
          fingerprint: "mcp_tool_failed:get_money_map:read_failed",
          summary: "A person's AI asked for the money map and the read failed; it was given the copy on the household row",
        });
        return { text: JSON.stringify(structured, null, 2), structured, code: "read_failed" };
      }
      return { text: JSON.stringify(structured, null, 2), structured };
    }

    case "get_plan": {
      const plan = await planFor(biz.id);
      if (!plan) return { text: "This person does not have a plan yet.", structured: { view: "none", plan: null, message: VIEW_SAYS.noPlan }, code: "no_plan" };
      const structured = {
        view: "plan",
        business: personName(biz),
        current_step_id: firstOpenStep(plan.steps)?.id ?? null,
        plan_url: await planUrlOnly(),
        goal: plan.plan.goal,
        headline: plan.plan.headline,
        progress: progressOf(plan.steps),
        north_star: northStar(biz, plan),
        read_online: await planLink(),
        // The narrative two-thirds of the document: where the business stands,
        // how it wins, the money logic, milestones and risks. The person's own
        // AI reasons from the same strategy the PDF carries — one document,
        // two doors.
        strategy: plan.plan.strategy ?? null,
        outline: planSummary(plan.steps),
        // PRIORITY 5.1's gap, closed: this is the exact fabricated/unfilled
        // content the founder's own MCP session confirmed reaches the
        // owner's connected AI verbatim, since get_plan used to hand back
        // `s.artifact` raw — the same "[Name]"/"[Link to Google profile]"
        // a person's phone got, just through a different door. Same guard,
        // same function, as every other artifact-touching path.
        steps: plan.steps.map((s) => {
          const artifact = checkArtifact(s.artifact, biz);
          return {
            id: s.id,
            part: s.workstream_title,
            title: s.title,
            what_to_do: s.push,
            why_for_you: s.why_for_you,
            done_when: s.done_when,
            artifact: artifact.text ?? artifact.fallback,
            tool_id: s.tool_id,
            status: s.status,
          };
        }),
      };
      return { text: JSON.stringify(structured, null, 2), structured };
    }

    case "find_knowledge": {
      const query = String(args.query ?? "");
      if (!query.trim()) return { text: "find_knowledge needs a query.", isError: true, code: "empty_query" };
      const domain = typeof args.domain === "string" ? args.domain : null;
      const [knowledge, tools] = await Promise.all([knowledgeFor(biz.country), toolsFor(biz.country)]);
      const short = await shortlist(
        knowledge,
        tools,
        { text: query, stage: biz.biz_stage || "stretching", domain, headache: biz.context?.headache ?? null, maxKnowledge: 5, maxTools: 6 },
        { businessId: biz.id, country: biz.country, source: "mcp", quote: query },
      );
      // Only rows the question itself matched. The shortlist fills its slots
      // by area, stage and the onboarding headache too, which a WhatsApp
      // answer can ignore inside its prompt; a person's AI gets them as
      // facts to use. Round 27 (KE, live): every result carried four
      // unrelated rows (a CRM, tenders, chasing payments) after the one or
      // two that fit. A row stays when its own keyword score is at least a
      // third of the best one. Rows found by meaning (no keyword matched)
      // are kept as found.
      const matchQ = { text: query, stage: biz.biz_stage || "stretching" };
      const onTopic = <T extends Parameters<typeof keywordScore>[0]>(rows: T[]): T[] => {
        if (short.semantic) return rows;
        const scored = rows.map((r) => ({ r, k: keywordScore(r, matchQ) }));
        const best = Math.max(0, ...scored.map((x) => x.k));
        return scored.filter((x) => x.k > 0 && x.k * 3 >= best).map((x) => x.r);
      };
      short.knowledge = onTopic(short.knowledge);
      short.tools = onTopic(short.tools);
      const structured = {
        knowledge: short.knowledge.map((k) => ({
          id: k.id,
          title: k.title,
          applies_when: k.applies_when,
          not_when: k.not_when,
          summary: k.owner_summary,
          steps: k.steps ?? [],
          cost: costLine(k.cost, k.verified_on),
          verified_on: k.verified_on,
        })),
        tools: short.tools.map((t) => ({
          id: t.id,
          name: t.name,
          fits: t.fits,
          not_when: t.not_when,
          why: t.why,
          cost: costLine(t.cost, t.verified_on, t.free_type),
          free_type: t.free_type ?? null,
          verified_on: t.verified_on,
          url: t.url,
          setup: t.setup,
          walkthrough: t.walkthrough ?? [],
          informal_business_supported: t.informal_business_supported ?? null,
          ten_minute_action: t.ten_minute_action ?? null,
        })),
        // Who confirms a rule in this country, so a tax, registration or
        // data question names the right body even when no row matched.
        confirm_with: {
          tax: country(biz.country).tax,
          credit: country(biz.country).registrar,
          grants: country(biz.country).grants,
          disputes: country(biz.country).ombud,
          personal_data: country(biz.country).dataRegulator,
          free_advice: country(biz.country).advisor,
        },
        note: short.semantic
          ? "No keyword matched, so these are the closest rows by meaning. Check each one actually fits the question before relying on it, and use only these facts for prices, fees, rules and links."
          : short.topScore === 0
            ? "Nothing in the library matched this. Say so rather than answering from your own knowledge of prices or rules, and for a rule name who confirms it (confirm_with)."
            : "Use only these facts for prices, fees, rules and links. A row's not_when says when it does not fit; check it against this person's situation.",
      };
      // A question the library could not answer is knowledge_gap (retrieval.ts).
      return { text: JSON.stringify(structured, null, 2), structured, code: short.semantic ? "semantic" : short.topScore === 0 ? "no_match" : "matched" };
    }

    case "log_decision": {
      const what = String(args.what ?? "").trim();
      if (!what) return { text: "log_decision needs 'what'.", isError: true, code: "missing_what" };
      await logDecision(biz.id, what, args.why ? String(args.why) : null, "connector");
      // Already structured, so a knowledge signal costs one read and one
      // insert — no model call (db/0015).
      await mcpSignal(biz, "new_fact_candidate", args.why ? `${what} — ${String(args.why)}` : what, "Their AI logged a decision");
      return { text: `Logged: ${what}. Their WhatsApp assistant knows about it now.` };
    }

    case "add_commitment": {
      const what = String(args.what ?? "").trim();
      if (!what) return { text: "add_commitment needs 'what'.", isError: true, code: "missing_what" };
      const due = typeof args.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.due)
        ? args.due
        : new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
      const row = await addCommitment(biz.id, what, due, "connector");
      if (!row) {
        // The person's AI is told, so they know; warn, not error. The cause is
        // addCommitment's own logged error.
        trackFailure("mcp_tool_failed", "the commitment could not be saved", {
          severity: "warn",
          props: { tool: "add_commitment", reason: "save_failed" },
          fingerprint: "mcp_tool_failed:add_commitment:save_failed",
          summary: "A person's AI asked Charles to follow up on a commitment and it could not be saved (the AI was told)",
        });
      }
      return row
        ? { text: `Added. Charles will check in about "${what}" on or after ${due}.` }
        : { text: "Could not save that commitment.", isError: true, code: "save_failed" };
    }

    case "propose_change": {
      const fact = String(args.fact ?? "");
      const to = String(args.to ?? "").trim();
      const reason = String(args.reason ?? "").trim();
      if (!(CRITICAL_FACTS as readonly string[]).includes(fact)) {
        return { text: `"${fact}" is not a critical fact. Use log_decision for anything else.`, isError: true, code: "not_critical_fact" };
      }
      if (!to || !reason) return { text: "propose_change needs 'to' and 'reason'.", isError: true, code: "missing_args" };
      // Round 27: a yes/no dropped into the middle of the setup questions or a
      // build takes WhatsApp out of it, and the build never finishes.
      if (BUILDING_STAGES.has(biz.stage)) {
        return {
          text: `Nothing has changed, and nothing was asked: their plan is being put together on WhatsApp right now (they are ${WHATSAPP_AT[biz.stage] ?? "partway through it"}). They can tell Charles there, in their own words, and it will be used in the plan.`,
          code: "busy_building",
        };
      }

      const from = args.from ? String(args.from) : String((biz.context as Record<string, unknown> | null)?.[fact] ?? "");

      const { data, error } = await db()
        .from("proposed_changes")
        .insert({ business_id: biz.id, fact, from_value: from, to_value: to, reason, status: "pending" })
        .select("id")
        .single();
      if (error) {
        // The AI is told; the person, who may have agreed to it in that chat,
        // is never asked on WhatsApp.
        trackFailure("connector_change_failed", dbError(error), {
          severity: "error",
          props: { fact, phase: "store" },
          fingerprint: "connector_change_failed:store",
          summary: "A person's AI proposed changing a critical fact and the proposal could not be stored, so the person was not asked on WhatsApp",
        });
        return { text: "Could not record that proposal.", isError: true, code: "store_failed" };
      }

      const changeId = (data as { id: string }).id;
      // What the person was in the middle of on WhatsApp, before this question takes it over.
      const stageBefore = biz.stage ?? null;
      const pendingBefore = biz.pending_action?.kind ?? null;
      // About the person's OWN business details, not the library: recorded, but
      // tied to no library row, so it can never count as another business
      // corroborating a claim about a tool.
      await mcpSignal(biz, "new_fact_candidate", `${fact}: "${from}" -> "${to}". Why: ${reason}`, "Their AI proposed a change to their own money details", false);
      await updateBusiness(biz.id, { stage: "confirm_change", pending_action: { kind: "change", change_id: changeId } });
      const asked = await sendButtons(
        biz.wa_id,
        `Your AI suggested a change to your money details.\n\n${fact}: "${from || "(not set)"}" → "${to}"\n\nWhy: ${reason}\n\nShould I update your plan?`,
        [
          { id: ACT.CHANGE_YES, title: "Yes, update it" },
          { id: ACT.CHANGE_NO, title: "No, leave it" },
        ],
        biz.id,
      );
      // stage_before: this question takes over whatever the person was doing
      // (a walkthrough, stabilising mode), so it shows.
      track("connector_change_proposed", {
        category: "behaviour",
        props: { fact, delivered: asked.ok, stage_before: stageBefore, pending_before: pendingBefore },
      });
      if (!asked.ok) {
        // The AI is about to tell the person "you've been asked on WhatsApp".
        // They have not: outside the 24-hour window only a template delivers.
        trackFailure("connector_change_failed", asked.error ?? "the WhatsApp question was not sent", {
          severity: "error",
          props: { fact, phase: "send", window_closed: Boolean(asked.windowClosed), code: asked.code ?? null, skipped: Boolean(asked.skipped) },
          fingerprint: `connector_change_failed:send:${asked.windowClosed ? "window_closed" : (asked.code ?? "other")}`,
          summary: `A person's AI proposed a change and the WhatsApp confirmation did not reach the person${asked.windowClosed ? " (their 24-hour window had closed)" : ""}; the AI was told they had been asked`,
        });
      }

      return {
        text: `Nothing has changed yet. The person has been asked on WhatsApp whether to update "${fact}". Tell them you have suggested it and they will need to confirm on WhatsApp.`,
        code: asked.ok ? "asked" : "ask_not_delivered",
      };
    }

    case "get_current_step":
      return currentStep(biz, args.send_to_whatsapp === true);

    case "complete_step":
      return completeStep(biz, typeof args.step_id === "string" ? args.step_id.trim() : "");

    case "skip_step":
      return skipStepFor(biz, typeof args.step_id === "string" ? args.step_id.trim() : "", String(args.reason ?? "").trim());

    case "report_outcome":
      return reportOutcome(biz, String(args.step_id ?? "").trim(), String(args.effect ?? ""));

    case "request_plan_change":
      return requestPlanChange(biz, String(args.change ?? "").trim(), String(args.reason ?? "").trim());

    case "send_plan_pdf":
      return sendPlanPdfFor(biz);

    case "remember":
      return remember(biz, String(args.note ?? ""), String(args.about ?? "other"));

    case "forget_note": {
      const id = String(args.note_id ?? "").trim();
      if (!id) return { text: "forget_note needs 'note_id' (from get_household_context, under remembered).", isError: true, code: "missing_id" };
      const gone = await deleteOwnerNote(biz.id, id);
      if (gone === "error") return { text: "Could not forget that just now. Try again in a moment.", isError: true, code: "delete_failed" };
      if (!gone) return { text: "There is no note with that id (it may already be forgotten). get_household_context lists what is remembered.", code: "not_found" };
      track("owner_note_forgotten", { props: { source: "connector" } });
      return { text: "Forgotten. Charles will not use it again, here or on WhatsApp.", code: "forgotten" };
    }

    case "flag_hardship":
      return flagHardship(biz, String(args.what_they_said ?? "").trim());

    default:
      return { text: `Unknown tool: ${name}`, isError: true, code: "unknown_tool" };
  }
}

// ── Driving the plan from the person's own AI ─────────────────────
//
// Round 27: everything the WhatsApp side can do, the person's AI can do too —
// see the step, mark it done or skipped, say whether it worked, ask for a
// change, get the PDF — writing the SAME state through the same functions
// (engine/steps.ts recordStepDone, recordStepSkipped, moveMapOnBetter), so the
// two doors never disagree about where the person is. Nothing here sends a
// WhatsApp message the person did not ask for: they are in their AI's chat,
// and that is where the answer goes. A change to the plan still goes through
// the person, on WhatsApp.

/** What the WhatsApp side is waiting on, in words the person's AI can repeat. */
/** Every entry reads after "they are …" (round 27: "and they are their plan is being built"). */
const WHATSAPP_AT: Partial<Record<Stage, string>> = {
  diag: "answering Charles's setup questions",
  diag_done: "waiting while their plan is built",
  building_rule: "waiting while their plan is built",
  building_plan: "waiting while their plan is built",
  confirm_identity: "confirming the read-back of their money",
  identity_fix: "correcting the read-back of their money",
  choose_goal: "choosing the goal to work towards",
  choose_rule: "choosing the one money rule to live by",
  clarify_objective: "saying what they want from the next 90 days",
  plan_ready: "between steps",
  step_pushed: "on a step",
  walking: "being walked through a tool, line by line",
  outcome_wait: "saying whether their last step made a difference",
  changing: "changing their plan",
  confirm_change: "deciding on a change their AI suggested",
  stabilizing: "on pause, protecting their cash first",
};

/**
 * Stages where a plan is being put together on WhatsApp: the setup
 * questions, the read-back, the choices, the build, and the "what's changed?"
 * before the next ninety days. During a rebuild the last plan is still in the
 * database (planFor reads the newest row), so without this the AI could push
 * or tick off a step of a plan that is being replaced, and pull WhatsApp out
 * of the build it is in.
 */
const BUILDING_STAGES: ReadonlySet<Stage> = new Set<Stage>([
  "diag",
  "diag_done",
  "confirm_identity",
  "identity_fix",
  "choose_goal",
  "building_rule",
  "choose_rule",
  "building_plan",
  "clarify_objective",
]);

/** Stages where WhatsApp is about one step: a step action from the AI moves them on. */
const STEP_STAGES: ReadonlySet<Stage> = new Set<Stage>(["step_pushed", "walking", "outcome_wait"]);

function progressOf(steps: PlanStepRow[]): { done: number; skipped: number; open: number; total: number } {
  const done = steps.filter((s) => s.status === "done").length;
  const skipped = steps.filter((s) => s.status === "skipped").length;
  return { done, skipped, open: steps.length - done - skipped, total: steps.length };
}

/** "Step 3 of 12": where a step sits, counting by plan order. */
function positionOf(steps: PlanStepRow[], step: PlanStepRow): string {
  return `Step ${steps.indexOf(step) + 1} of ${steps.length}`;
}

async function planUrlOnly(): Promise<string | null> {
  const { planUrl } = await import("./engine/build.js");
  return planUrl();
}

async function planLink(): Promise<string | null> {
  const url = await planUrlOnly();
  return url ? `${url} (they sign in with their WhatsApp number)` : null;
}

const personName = (biz: Pick<Business, "context" | "identity">): string => biz.context?.name || biz.identity?.name || "Your money";

/**
 * One sentence the person's AI steers by: the goal, and the step that gets
 * them there now. Everything off the plan is measured against it.
 */
export function northStar(biz: Pick<Business, "stage">, plan: { plan: Pick<PlanRow, "goal">; steps: PlanStepRow[] } | null): string {
  if (biz.stage === "stabilizing") {
    return "The plan is paused: the person is in money hardship, so the job right now is keeping food, rent and transport covered: those first, no new borrowing, nothing that costs money, and the free help line for anything a lender or collector is doing. When things steady, they tell Charles on WhatsApp and the plan picks back up.";
  }
  if (!plan || !plan.steps.length) {
    return `No plan yet: on WhatsApp they are ${WHATSAPP_AT[biz.stage] ?? "partway through setting up"}. The 90-day plan is built there. Help with what they ask, and point them back to finishing it on WhatsApp.`;
  }
  if (BUILDING_STAGES.has(biz.stage)) {
    return `A new 90-day plan is being put together on WhatsApp: they are ${WHATSAPP_AT[biz.stage] ?? "partway through it"}. Help with what they ask, and point them back to finishing it there; the steps below are from the plan it replaces.`;
  }
  const current = firstOpenStep(plan.steps);
  const goal = plan.plan.goal ? `The 90-day goal: ${plan.plan.goal}. ` : "";
  if (!current) return `${goal}Every step of this plan is done or skipped. Next: they tell Charles on WhatsApp how the 90 days went, and Charles builds the next plan from where they are now.`;
  return `${goal}Right now: ${positionOf(plan.steps, current)}, "${current.title}"${current.workstream_title ? ` (${current.workstream_title})` : ""}. Done when: ${current.done_when ?? "it's done"}. Everything else is weighed against getting this done.`;
}

/** The plan, or why there is none, as a result the AI can act on. */
async function planOrWhy(biz: Business): Promise<{ plan: { plan: PlanRow; steps: PlanStepRow[] } } | { result: ToolResult }> {
  if (BUILDING_STAGES.has(biz.stage)) {
    const text = `There is no plan to work on right now: a plan is being put together on WhatsApp, and they are ${WHATSAPP_AT[biz.stage] ?? "partway through it"}. Point them back to finishing it there.`;
    return { result: { text, structured: { view: "none", plan: null, on_whatsapp: WHATSAPP_AT[biz.stage] ?? null, message: VIEW_SAYS.noPlan }, code: "building" } };
  }
  const plan = await planFor(biz.id);
  if (!plan || !plan.steps.length) {
    return { result: { text: `There is no plan yet. ${northStar(biz, null)}`, structured: { view: "none", plan: null, on_whatsapp: WHATSAPP_AT[biz.stage] ?? null, message: VIEW_SAYS.noPlan }, code: "no_plan" } };
  }
  return { plan };
}

/** A step by id, or the one they are on. */
function pickStep(steps: PlanStepRow[], stepId: string): PlanStepRow | null {
  return stepId ? (steps.find((s) => String(s.id) === stepId) ?? null) : firstOpenStep(steps);
}

/** WhatsApp was waiting on this step: it is not any more. Any other flow (a question, a change, the diagnostic) is left alone. */
async function releaseStep(biz: Business, stepId: string): Promise<void> {
  const held = String(biz.pending_action?.step_id ?? biz.walk?.step_id ?? "");
  if (!STEP_STAGES.has(biz.stage) || held !== stepId) return;
  await updateBusiness(biz.id, { stage: "plan_ready", pending_action: null, walk: null });
}

/**
 * What the view (appview.ts) shows the OWNER, in their own words, when there
 * is no step to show. The tool's text is for their AI ("they tell Charles");
 * the view is read by the person (round 28).
 */
const VIEW_SAYS = {
  paused: (cc: string) =>
    `Your plan is paused while money is this tight. Food, rent and transport first; don't borrow to cover the rest; and nothing that costs money. When things steady, tell Charles on WhatsApp and you'll pick the plan back up. Free help with this: ${country(cc).advisor}.`,
  noPlan: "Your 90-day plan is put together on WhatsApp. Finish it there, and it will show here.",
  done: "Every step of this plan is done or skipped. Tell Charles on WhatsApp how the 90 days went, and you'll build the next plan from where you are now.",
};

const STABILISING_HOLD =
  "The plan is paused: the person is in money hardship, so no new plan steps for now. Food, rent and transport first, no new borrowing, nothing that costs money. When things steady, they tell Charles on WhatsApp and the plan picks back up.";

async function currentStep(biz: Business, toWhatsApp: boolean): Promise<ToolResult> {
  // Rule 9 holds on every door: no growth step while stabilising.
  if (biz.stage === "stabilizing") {
    return { text: STABILISING_HOLD, structured: { view: "paused", paused_for_hardship: true, advisor: country(biz.country).advisor, message: VIEW_SAYS.paused(biz.country) }, code: "stabilising" };
  }
  const got = await planOrWhy(biz);
  if ("result" in got) return got.result;
  const { steps, plan } = got.plan;
  const step = firstOpenStep(steps);
  if (!step) {
    return { text: northStar(biz, got.plan), structured: { view: "done", progress: progressOf(steps), current_step: null, message: VIEW_SAYS.done }, code: "plan_complete" };
  }
  const tool = step.tool_id ? await toolById(step.tool_id, biz.country) : null;
  // Same guard as every other artifact path: never "[Name]" handed over as ready.
  const artifact = checkArtifact(step.artifact, biz);
  const after = steps.slice(steps.indexOf(step) + 1).find((s) => s.status === "open") ?? null;
  const structured: Record<string, unknown> = {
    view: "step",
    business: personName(biz),
    id: step.id,
    position: positionOf(steps, step),
    part: step.workstream_title,
    title: step.title,
    what_to_do: step.push,
    why_for_you: step.why_for_you,
    done_when: step.done_when,
    // Ready only when nothing is left to fill in; otherwise the draft, with
    // the blanks the person fills named (engine/artifact.ts).
    words_ready_to_send: artifact.text ?? null,
    words_to_fill_in: artifact.text ? null : (artifact.fallback ?? null),
    how_to: libraryHowTo(step.step_key),
    tool: tool
      ? {
          id: tool.id,
          name: tool.name,
          url: tool.url,
          // Rule 10: the cost comes from the library with its check date, never a model.
          cost: costLine(tool.cost, tool.verified_on, tool.free_type),
          verified_on: tool.verified_on,
          set_up: tool.walkthrough ?? [],
          ten_minute_action: tool.ten_minute_action ?? null,
        }
      : null,
    after_this: after ? after.title : null,
    goal: plan.goal ?? null,
    progress: progressOf(steps),
  };
  let sent: "sent" | "window_closed" | null = null;
  if (toWhatsApp) {
    // Outside Meta's 24-hour window only a template gets through, and a
    // step is several free messages: say so rather than send into nothing.
    if (!withinServiceWindow(biz.last_inbound_at)) {
      sent = "window_closed";
    } else {
      const { pushNextStep } = await import("./engine/steps.js");
      await pushNextStep(biz);
      sent = "sent";
    }
    track("connector_step_sent", { props: { delivered: sent === "sent", step_key: step.step_key } });
  }
  structured.sent_to_whatsapp = sent;
  const note =
    sent === "sent"
      ? "\n\nSent to their WhatsApp too."
      : sent === "window_closed"
        ? "\n\nNot sent to WhatsApp: WhatsApp only lets Charles message them within 24 hours of their last message there. If they send Charles any message on WhatsApp, it can be sent."
        : "";
  return { text: `${JSON.stringify(structured, null, 2)}${note}`, structured, code: sent ?? "shown" };
}

async function completeStep(biz: Business, stepId: string): Promise<ToolResult> {
  const got = await planOrWhy(biz);
  if ("result" in got) return got.result;
  const { steps } = got.plan;
  const step = pickStep(steps, stepId);
  if (!step) {
    return stepId
      ? { text: "There is no step with that id in their current plan. get_plan lists the steps and their ids.", isError: true, code: "step_not_found" }
      : { text: northStar(biz, got.plan), code: "plan_complete" };
  }
  if (step.status === "done") return { text: `"${step.title}" is already marked done.`, structured: { step_id: step.id }, code: "already_done" };
  const { recordStepDone } = await import("./engine/steps.js");
  await recordStepDone(biz, steps, step, "connector");
  await releaseStep(biz, String(step.id));
  const now = steps.map((s) => (s.id === step.id ? { ...s, status: "done" as const } : s));
  const next = firstOpenStep(now);
  const progress = progressOf(now);
  return {
    text:
      `Marked done: "${step.title}" (${progress.done} of ${progress.total} done). ` +
      `Ask them now whether it has made any difference yet, and record their answer with report_outcome (step_id ${step.id}). ` +
      (next ? `The next step is "${next.title}".` : "That was the last open step of this plan."),
    structured: { step_id: step.id, progress, next_step: next ? { id: next.id, title: next.title } : null },
    code: "done",
  };
}

async function skipStepFor(biz: Business, stepId: string, reason: string): Promise<ToolResult> {
  if (!reason) return { text: "skip_step needs the person's reason.", isError: true, code: "missing_reason" };
  const got = await planOrWhy(biz);
  if ("result" in got) return got.result;
  const { steps } = got.plan;
  const step = pickStep(steps, stepId);
  if (!step) {
    return stepId
      ? { text: "There is no step with that id in their current plan. get_plan lists the steps and their ids.", isError: true, code: "step_not_found" }
      : { text: northStar(biz, got.plan), code: "plan_complete" };
  }
  if (step.status === "done") return { text: `"${step.title}" is already done, so there is nothing to skip.`, code: "already_done" };
  if (step.status === "skipped") return { text: `"${step.title}" is already skipped.`, code: "already_skipped" };
  const { recordStepSkipped } = await import("./engine/steps.js");
  await recordStepSkipped(String(step.id), reason.slice(0, 500), "connector");
  await releaseStep(biz, String(step.id));
  const next = firstOpenStep(steps.map((s) => (s.id === step.id ? { ...s, status: "skipped" as const } : s)));
  return {
    text: `Skipped: "${step.title}". Charles will bring it back later if it still matters. ${next ? `The next step is "${next.title}".` : "That was the last open step of this plan."}`,
    structured: { step_id: step.id, next_step: next ? { id: next.id, title: next.title } : null },
    code: "skipped",
  };
}

const OUTCOME_LINE: Record<string, string> = {
  better: "Noted: it has made a difference. That's the point of it.",
  same: "Noted: no change yet. If it is still flat in a couple of weeks, change the approach rather than doing more of the same.",
  too_early: "Noted: too early to say. Most of these take a week or two to show.",
};

async function reportOutcome(biz: Business, stepId: string, effect: string): Promise<ToolResult> {
  if (!(effect in OUTCOME_LINE)) return { text: "report_outcome needs effect: better, same or too_early.", isError: true, code: "bad_effect" };
  if (!stepId) return { text: "report_outcome needs the finished step's id (complete_step returns it).", isError: true, code: "missing_step" };
  const got = await planOrWhy(biz);
  if ("result" in got) return got.result;
  const step = got.plan.steps.find((s) => String(s.id) === stepId) ?? null;
  if (!step) return { text: "There is no step with that id in their current plan.", isError: true, code: "step_not_found" };
  // Live, 2026-09-22 (engine/steps.ts recordStepOutcome): an outcome on a
  // step only ever SHOWN moved the map with "done and working". Only a
  // finished step has an outcome.
  if (step.status !== "done") {
    return { text: `"${step.title}" is not marked done yet. If they have done it, call complete_step first; then ask how it went.`, code: "step_not_done" };
  }
  const { data: already } = await db().from("outcomes").select("id").eq("plan_step_id", step.id).limit(1);
  if (((already as unknown[] | null) ?? []).length) return { text: `How "${step.title}" went is already recorded.`, code: "outcome_recorded" };
  await logOutcome(biz.id, step.title ?? "a step", effect, step.id, "connector");
  track("outcome_reported", { props: { verdict: effect, how: "connector", late: false, step_key: step.step_key } });
  const { moveMapOnBetter } = await import("./engine/steps.js");
  await moveMapOnBetter(biz, step, effect);
  // WhatsApp's "has it made a difference?" for this step is answered.
  if (biz.stage === "outcome_wait" && String(biz.pending_action?.step_id ?? "") === stepId) await updateBusiness(biz.id, { stage: "plan_ready", pending_action: null });
  return { text: OUTCOME_LINE[effect]!, structured: { step_id: step.id, effect }, code: effect };
}

/** What a plan-step change is stored as in proposed_changes: not a business fact, so never written into context. */
export const PLAN_STEPS_FACT = "plan_steps";

async function requestPlanChange(biz: Business, change: string, reason: string): Promise<ToolResult> {
  if (!change) return { text: "request_plan_change needs 'change', in the person's words.", isError: true, code: "missing_args" };
  if (biz.stage === "stabilizing") return { text: `${STABILISING_HOLD} The plan can be changed once it picks back up.`, code: "stabilising" };
  const got = await planOrWhy(biz);
  if ("result" in got) return got.result;
  // A question the person never sees is worse than none: outside the window
  // the yes/no cannot reach them, and WhatsApp would sit waiting on it.
  if (!withinServiceWindow(biz.last_inbound_at)) {
    trackUnmet("connector_change_refused", { severity: "info", props: { what: "plan_steps", reason: "window_closed" }, fingerprint: "connector_change_refused:window_closed" });
    return {
      text: "Nothing has changed. Charles can only ask them on WhatsApp within 24 hours of their last message there. Ask them to send Charles any message on WhatsApp (or tap \"Change my plan\" there), then try again.",
      code: "window_closed",
    };
  }
  const { data, error } = await db()
    .from("proposed_changes")
    .insert({ business_id: biz.id, fact: PLAN_STEPS_FACT, from_value: "", to_value: change.slice(0, 600), reason: reason.slice(0, 300) || null, status: "pending" })
    .select("id")
    .single();
  if (error) {
    trackFailure("connector_change_failed", dbError(error), {
      severity: "error",
      props: { fact: PLAN_STEPS_FACT, phase: "store" },
      fingerprint: "connector_change_failed:store",
      summary: "A person's AI passed on a change to the plan's steps and it could not be stored, so the person was not asked on WhatsApp",
    });
    return { text: "Could not record that request.", isError: true, code: "store_failed" };
  }
  const changeId = (data as { id: string }).id;
  const stageBefore = biz.stage ?? null;
  await updateBusiness(biz.id, { stage: "confirm_change", pending_action: { kind: "change", change_id: changeId } });
  const asked = await sendButtons(
    biz.wa_id,
    `Your AI passed on a change you want to your plan:\n\n"${change.slice(0, 600)}"${reason ? `\n\nWhy: ${reason.slice(0, 300)}` : ""}\n\nShall I make it?`,
    [
      { id: ACT.CHANGE_YES, title: "Yes, change it" },
      { id: ACT.CHANGE_NO, title: "No, leave it" },
    ],
    biz.id,
  );
  track("connector_change_proposed", { category: "behaviour", props: { fact: PLAN_STEPS_FACT, delivered: asked.ok, stage_before: stageBefore } });
  if (!asked.ok) {
    trackFailure("connector_change_failed", asked.error ?? "the WhatsApp question was not sent", {
      severity: "error",
      props: { fact: PLAN_STEPS_FACT, phase: "send", window_closed: Boolean(asked.windowClosed), code: asked.code ?? null },
      fingerprint: `connector_change_failed:send:${asked.windowClosed ? "window_closed" : (asked.code ?? "other")}`,
      summary: "A person's AI passed on a plan change and the WhatsApp question did not reach the person",
    });
    return { text: "Nothing has changed, and the question did not reach them on WhatsApp just now. Ask them to tap \"Change my plan\" on WhatsApp instead.", code: "ask_not_delivered" };
  }
  return {
    text: "Nothing has changed yet. Charles has asked them on WhatsApp whether to make this change; it happens only if they say yes there. Tell them to look on WhatsApp.",
    code: "asked",
  };
}

async function sendPlanPdfFor(biz: Business): Promise<ToolResult> {
  const got = await planOrWhy(biz);
  if ("result" in got) return got.result;
  const online = await planLink();
  if (!withinServiceWindow(biz.last_inbound_at)) {
    track("connector_pdf_requested", { props: { queued: false, reason: "window_closed" } });
    return {
      text: `Not sent: WhatsApp only lets Charles send them a document within 24 hours of their last message there. If they send Charles any message on WhatsApp, ask again.${online ? ` The same plan is online at ${online}.` : ""}`,
      code: "window_closed",
    };
  }
  // Rendering takes longer than an AI's tool call should wait: queued, and
  // sent the way a "Send the PDF" tap is (engine/planpdf.ts, mode "asked").
  await enqueueForPlan("plan_pdf", biz.id, String(got.plan.plan.id), { mode: "asked" }, 0);
  track("connector_pdf_requested", { props: { queued: true } });
  return { text: `On its way to their WhatsApp, usually within a minute or two.${online ? ` The same plan is online at ${online}.` : ""}`, code: "queued" };
}

async function remember(biz: Business, raw: string, about: string): Promise<ToolResult> {
  const note = raw.replace(/\s+/g, " ").trim();
  if (!note) return { text: "remember needs a 'note'.", isError: true, code: "missing_note" };
  if (SECRET_DETAIL.test(note)) {
    trackUnmet("owner_note_refused", { severity: "info", props: { reason: "secret_detail" }, fingerprint: "owner_note_refused:secret_detail" });
    return { text: "Not kept: it looks like an ID, account, card or phone number, or a password or PIN. Charles never stores those. Keep the note to what it means for their money.", isError: true, code: "secret_detail" };
  }
  if (note.length > NOTE_MAX) return { text: `Keep it to one line (at most ${NOTE_MAX} characters).`, isError: true, code: "too_long" };
  const kept = await addOwnerNote(biz.id, about, note, "connector");
  if (!kept) return { text: "Could not save that just now.", isError: true, code: "save_failed" };
  if (!kept.fresh) return { text: "Already remembered.", structured: { id: kept.note.id }, code: "already_kept" };
  track("owner_note_kept", { props: { about: kept.note.about, source: "connector", chars: kept.note.note.length } });
  return { text: "Remembered. Charles will use it here and on WhatsApp.", structured: { id: kept.note.id, about: kept.note.about }, code: "kept" };
}

/**
 * The person told their AI about real money trouble. Rule 9 holds on every
 * door: the same evidence test as a WhatsApp message (their words, or the
 * safety judge's second opinion on them, engine/qa.ts), and if it agrees,
 * the same switch into stabilising mode, so WhatsApp stops pushing growth
 * steps. The AI is told what to say either way.
 */
async function flagHardship(biz: Business, said: string): Promise<ToolResult> {
  if (!said) return { text: "flag_hardship needs what they said, in their words.", isError: true, code: "missing_words" };
  const c = country(biz.country);
  const guidance = `Food, rent and transport first; no new borrowing, not from a lender, a card or a mashonisa; nothing that costs money; and if a lender or collector is threatening them, they have rights. For free help working through it, with nobody selling anything: ${c.advisor}.`;
  if (biz.stage === "stabilizing") return { text: `The plan is already paused for this. ${guidance}`, structured: { paused_for_hardship: true }, code: "already_paused" };
  const words = saysMoneyTrouble(said);
  const second = words ? null : await checkMessageDistress(said, { businessId: biz.id });
  if (!words && second !== true) {
    await recordSafetyEvent({
      businessId: biz.id,
      check: "distress",
      engine: "model",
      outcome: "pass",
      flags: ["connector_not_confirmed"],
      detail: `their AI flagged hardship; no money or crisis language and the second opinion ${second === false ? "disagreed" : "could not decide"}, so the plan was kept: ${said.slice(0, 200)}`,
    });
    return {
      text: `Charles's check did not read this as the person being in money hardship, so the plan stays as it is. Still answer carefully: nothing paid, no new debt. If it is serious (food, rent, transport or debts they cannot cover), they can tell Charles on WhatsApp in their own words.`,
      structured: { paused_for_hardship: false },
      code: "not_confirmed",
    };
  }
  // The evidence starts here, as in engine/qa.ts: the exit check reads only
  // what was said since stabilising began.
  const answers = { ...(biz.answers ?? {}), since_stabilising: said.slice(0, 2000) };
  await updateBusiness(biz.id, { stage: "stabilizing", answers, pending_action: null, walk: null });
  await recordSafetyEvent({
    businessId: biz.id,
    check: "distress",
    engine: "model",
    outcome: "block",
    detail: `their AI flagged hardship (${words ? "money words in what they said" : "second opinion agreed"}): ${said.slice(0, 200)}`,
  });
  track("distress_detected", { severity: "warn", props: { source: "connector", via: words ? "money_words" : "second_opinion" } });
  // One line on WhatsApp, so the pause is not a surprise there; only inside
  // the window, where a free message can reach them.
  if (withinServiceWindow(biz.last_inbound_at)) {
    await sendText(
      biz.wa_id,
      "Your AI told me things are tight right now, so I've paused your plan: no new steps, nothing that costs money. Protect your cash and collect what's owed. When it steadies, tell me here and we'll pick it up.",
      biz.id,
    );
  }
  return {
    text: `The growth plan is paused, here and on WhatsApp. ${guidance} When things steady, they tell Charles on WhatsApp and the plan picks back up.`,
    structured: { paused_for_hardship: true, advisor: c.advisor },
    code: "paused",
  };
}

/** A connector call, recorded as a knowledge signal. Structured already, so no model call. */
async function mcpSignal(biz: Business, type: "new_fact_candidate", rawQuote: string, claim: string, linkEntity = true): Promise<void> {
  let entity: ReturnType<typeof matchEntity> = null;
  if (linkEntity) {
    const { tools, knowledge } = await signalLibraryFor(biz.country);
    entity = matchEntity(rawQuote, tools, knowledge);
  }
  await recordKnowledgeSignal({
    source: "mcp",
    businessId: biz.id,
    country: biz.country,
    type,
    entity: entity ? { type: entity.type, id: entity.id } : null,
    rawQuote,
    candidateClaim: claim,
  });
}
