// Fin — the shapes every module agrees on.

import type { HydratedWorkstream } from "./playbooks.js";
import type { FreeType } from "./freetype.js";
export type { HydratedWorkstream } from "./playbooks.js";

/**
 * Where the person is in the conversation. This is flow state, kept separate
 * from `biz_stage` (the money stage: surviving | stretching | steady |
 * building), which is where their MONEY is. Overloading one column with both
 * meanings was a bug waiting to happen.
 *
 * Every value here must have a handler in the engine. A stage with no handler
 * is how a person gets silently stranded, and the engine fails a test if any
 * stage is unreachable by the dispatcher.
 */
export type Stage =
  | "diag"
  | "diag_done"
  | "stabilizing"
  | "confirm_identity"
  | "identity_fix"
  | "choose_goal"
  | "building_rule"
  | "choose_rule"
  | "building_plan"
  | "clarify_objective"
  | "plan_ready"
  | "step_pushed"
  | "walking"
  | "outcome_wait"
  | "changing"
  | "confirm_change";

export const ALL_STAGES: Stage[] = [
  "diag",
  "diag_done",
  "stabilizing",
  "confirm_identity",
  "identity_fix",
  "choose_goal",
  "building_rule",
  "choose_rule",
  "building_plan",
  "clarify_objective",
  "plan_ready",
  "step_pushed",
  "walking",
  "outcome_wait",
  "changing",
  "confirm_change",
];

/**
 * The money stage, which decides which playbook applies and how the plan is
 * framed. surviving: cannot make the month; stretching: makes the month with
 * nothing kept; steady: a small cushion and debts under control; building:
 * saving toward something.
 */
export type BizStage = "surviving" | "stretching" | "steady" | "building";
export const MONEY_STAGES: BizStage[] = ["surviving", "stretching", "steady", "building"];

export type MapStatus = "red" | "amber" | "green";

/** The eight areas of the Money Map. */
export const DOMAINS = [
  "income",
  "spending",
  "debt",
  "cushion",
  "credit_record",
  "protection",
  "family_money",
  "goals",
] as const;
export type Domain = (typeof DOMAINS)[number];

export const DOMAIN_LABELS: Record<string, string> = {
  income: "Money in",
  spending: "Money out",
  debt: "What you owe",
  cushion: "Emergency money",
  credit_record: "Credit record",
  protection: "Cover",
  family_money: "Family money",
  goals: "The future",
};

export interface Identity {
  /** What they asked to be called. */
  name?: string;
  /** How money comes in, in their words ("a nurse's aide on a monthly wage, plus a child grant"). */
  earns?: string;
  one_liner?: string;
  /** A doubt about what their situation actually is, phrased as one question. */
  unsure?: string | null;
}

/** One of the 90-day goals offered after the read-back (rule 4). */
export interface GoalOption {
  label: string;
  /** The goal in one line. */
  what: string;
  /** Why it fits this person, from what they said. */
  why_you: string;
  /** What it is worth in their own numbers; never invented. */
  worth: string;
  /** What they could do this week to start it. */
  first_move: string;
  catch: string;
}

/** A money rule of thumb the person will live by for 90 days (Drexler, Fischer and Schoar 2014). */
export interface RuleOption {
  label: string;
  /** The rule as the sentence they would say to themselves. */
  rule: string;
  why_it_works: string;
  what_it_costs_you: string | null;
}

/** What usually happens instead, honestly: borrow again, skip a payment, ask family. */
export interface Alternative {
  name: string;
  why_people_do_it: string;
  where_it_leaves_them: string;
}

export interface MapEntry {
  domain: string;
  status: MapStatus;
  note: string;
}

/** The household's context: the facts as the person gave them, established once. */
export interface HouseholdContext {
  name?: string;
  earns?: string;
  location?: string;
  depends?: string;
  income?: string;
  owes?: string;
  cushion?: string;
  cover?: string;
  records?: string;
  goal?: string;
  headache?: string;
  one_liner?: string;
}

/** What the plan builder read out of the diagnostic. Never inferred beyond it. */
export interface Signals {
  owes_any?: boolean;
  owes_mashonisa?: boolean;
  owes_two_plus?: boolean;
  arrears?: boolean;
  month_short?: boolean;
  dont_know_where?: boolean;
  family_pressure?: boolean;
  no_cushion?: boolean;
  no_cover?: boolean;
  double_cover?: boolean;
  fees_pain?: boolean;
  grant_income?: boolean;
  unclaimed_benefit?: boolean;
  records_weak?: boolean;
  credit_worry?: boolean;
  scam_exposed?: boolean;
  over_indebted?: boolean;
  problem_in_their_words?: string | null;
  top_problem?: string | null;
}

export interface Business {
  id: string;
  wa_id: string;
  country: string;
  stage: Stage;
  biz_stage?: BizStage | null;
  language?: string | null;
  answers?: Record<string, string> | null;
  diag_step?: number | null;
  identity?: Identity | null;
  signals?: Signals | null;
  objective_read?: string | null;
  /**
   * The goal options for the read-back the person is looking at. `token` is
   * minted when that read-back is sent (engine/build.ts): the options job may
   * store its options only while the token is unchanged, and any correction
   * replaces or clears it, so options written for a reading the person has
   * since corrected are thrown away. Empty `options` with a token = the
   * read-back is out and its options are still on their way.
   */
  pending_goal_options?: { options: GoalOption[]; recommend: string; token?: string } | null;
  goal?: GoalOption[] | null;
  pending_rule_options?: { options: RuleOption[]; recommend: string } | null;
  rule?: RuleOption[] | null;
  alternatives?: Alternative[] | null;
  context?: HouseholdContext | null;
  map?: MapEntry[] | null;
  current_plan_id?: string | null;
  consent_at?: string | null;
  nudge_prefs?: { day?: string; hour?: number; max_per_week?: number } | null;
  paused?: boolean | null;
  last_inbound_at?: string | null;
  last_outbound_at?: string | null;
  /** What the last question we asked was waiting for, so a reply has a home. */
  pending_action?: { kind: string; step_id?: string; change_id?: string; [k: string]: unknown } | null;
  /** Position inside a tool walkthrough: which tool, which line. */
  walk?: { tool_id: string; index: number; step_id?: string } | null;
  baseline_tier?: string | null;
  /** The eight-area map as it stood on day one. Written once, never overwritten. */
  map_first?: MapEntry[] | null;
  /**
   * Questions the person asked during the diagnostic, kept to be answered
   * once the plan is handed over (engine/kept.ts). Never diagnostic answers,
   * and never read by a prompt as if they were.
   */
  kept_questions?: KeptQuestion[] | null;
  deleted_at?: string | null;
  created_at?: string;
}

/** A question asked mid-diagnostic, in the person's words, and when. */
export interface KeptQuestion {
  text: string;
  /** The diagnostic question (0-based) it was asked at. */
  step: number;
  at: string;
}

/**
 * The narrative two-thirds of the plan document. Prose, not structure: the
 * fixed step library still decides what is IN the plan (rule 1); this is the
 * thinking around it — where their money stands, how the goal is won, and
 * what would count as winning. Every string in here is grounded in the
 * diagnostic, the chosen goal and rule, and the verified library, and is
 * checked before it is stored.
 */
export interface Strategy {
  /** What the person's answers add up to. Two or three short paragraphs. */
  reading: string[];
  /** Already going for them. Grounded in what they actually said. */
  working: string[];
  /** Where money is leaking. Same grounding rule. */
  leaking: string[];
  /** One paragraph tying the chosen goal, the rule and what usually happens instead together. */
  how_we_win: string;
  /** Deliberate refusals, each with its reason. A money plan is also what you will not do. */
  wont_do: string[];
  /** The arithmetic of the plan in the person's own numbers — never invented ones. */
  money_logic: string;
  /** What should be TRUE at each mark, not what should have been attempted. */
  milestones: { d30: string; d60: string; d90: string };
  risks: { risk: string; response: string }[];
}

export interface PlanRow {
  id: string;
  business_id: string;
  goal: string | null;
  headline: string | null;
  strategy?: Strategy | null;
  created_at?: string;
}

export interface PlanStepRow {
  id: string;
  plan_id: string;
  workstream_title: string | null;
  domain: string | null;
  step_order: number;
  step_key: string | null;
  title: string | null;
  push: string | null;
  artifact: string | null;
  tool_id: string | null;
  why_for_you: string | null;
  done_when: string | null;
  status: "open" | "done" | "skipped";
  pushed_at?: string | null;
  done_at?: string | null;
  skipped_reason?: string | null;
}

export interface KnowledgeRow {
  id: string;
  country: string;
  domain: string | null;
  stages: string[] | null;
  keywords: string[] | null;
  title: string;
  owner_summary: string;
  applies_when: string;
  not_when: string;
  steps: string[] | null;
  cost: string;
  stakes: string | null;
  verified_on: string | null;
}

export interface ToolRow {
  id: string;
  country: string;
  domain: string | null;
  stages: string[] | null;
  keywords: string[] | null;
  name: string;
  fits: string;
  not_when: string;
  why: string;
  cost: string;
  url: string;
  setup: string;
  walkthrough: string[] | null;
  verified_on: string | null;
  /** True when this tool's own step-by-step could not be confirmed against a real source. */
  needs_verification?: boolean;
  /**
   * Can a person with no payslip and no formal job use this? null means
   * nobody checked — never read it as "no". (The column keeps Fin's
   * name so the schema is shared.)
   */
  informal_business_supported?: boolean | null;
  /** WHICH kind of free (or not) this is — see freetype.ts. Every cost line leads with it. */
  free_type?: FreeType | null;
  /** The one thing a person can do in the next ten minutes to start. */
  ten_minute_action?: string | null;
}

export interface CommitmentRow {
  id: string;
  business_id: string;
  plan_step_id: string | null;
  what: string;
  due: string | null;
  status: "open" | "done" | "stuck" | "dropped";
  source: string;
  nudged_at: string | null;
  created_at: string;
}

export interface JobRow {
  id: number;
  kind: "inbound" | "nudge" | "freshness" | "plan_build_stage" | "goal_options" | "watchdog" | "kept_question" | "plan_repair" | "plan_pdf";
  business_id: string | null;
  wa_id: string | null;
  payload: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed" | "dead";
  attempts: number;
  max_attempts: number;
  last_error: string | null;
}

/** One phase of a plan build, e.g. "context" or "workstreams". */
export type PlanBuildStep = "context" | "strategy" | "workstreams" | "finalize" | "pdf";

/**
 * Durable progress of one plan build. `stage` is the coarse phase the row is
 * in; "building" covers strategy and the workstreams running independently,
 * distinguished from each other by `strategy_done` and `pending_workstreams`
 * rather than by a stage value each, since both can be in flight at once.
 */
export interface PlanBuildRow {
  business_id: string;
  stage: "context" | "building" | "finalize" | "pdf" | "done" | "failed";
  goal: string | null;
  context: HouseholdContext | null;
  map: MapEntry[] | null;
  dropped_modules: string[];
  strategy: Strategy | null;
  strategy_done: boolean;
  workstreams: HydratedWorkstream[];
  pending_workstreams: string[];
  plan_id: string | null;
  last_error: string | null;
  heartbeat_at: string;
  /** Set by resetPlanBuild at the start of every build attempt. */
  created_at?: string;
  /** Changed by every write that carries the build forward (not the heartbeat). */
  updated_at?: string;
}

/** What arrives from WhatsApp, normalised. Buttons carry an id, never re-parsed text. */
export interface InboundMessage {
  waMessageId: string;
  from: string;
  timestamp: number;
  kind: "text" | "button" | "list" | "audio" | "image" | "document" | "unsupported";
  /** Free text, or the transcript of a voice note. */
  text: string;
  /** The explicit action id carried by a tapped button or list row. */
  actionId?: string;
  /** The label shown on the button, for the message log only — never dispatched on. */
  actionLabel?: string;
  mediaId?: string;
  mimeType?: string;
  /** The bot's own number as Meta's webhook metadata states it (display_phone_number), and its phone number id. */
  toNumber?: string;
  toPhoneId?: string;
}

/** The fixed reply shape every person-facing model call returns. */
export interface Reply {
  message: string;
  artifact: string | null;
  next_tap: { label: string; url: string } | null;
  quick_replies: string[];
  tool_id: string | null;
  domain: string | null;
}

/**
 * A plan rebuilt from stored rows for the web viewer. The same shape the PDF
 * renderer takes, minus the library fields that only matter while building.
 */
export interface HydratedLike {
  id: string;
  title: string;
  domain: string;
  why: string;
  why_for_you: string;
  steps: {
    id: string;
    title: string;
    domain: string;
    outcome: string;
    done_when: string;
    brief: string;
    artifact_brief: string | null;
    push: string;
    artifact: string | null;
    why_for_you: string;
    tool_id: string | null;
    status?: string;
  }[];
}

export interface PlanBundle {
  plan: PlanRow;
  steps: PlanStepRow[];
  workstreams: HydratedWorkstream[];
}
