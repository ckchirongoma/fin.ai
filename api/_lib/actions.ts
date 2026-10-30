// Charles — every tappable action, as an explicit id.
//
// CLAUDE.md rule 7: "Every button is an action, never re-parsed text." An early
// version turned each tap into a chat message and re-parsed it, so a leftover
// conversational mode could swallow an unrelated tap. WhatsApp gives every
// reply button and list row an `id` field that comes straight back in the
// webhook — that id is what gets dispatched on. The title is for the human.
//
// Ids travel to Meta and back, so keep them short and stable: changing one
// orphans any button already sitting in somebody's chat history.

export const ACT = {
  IDENTITY_OK: "a.id.ok",
  IDENTITY_FIX: "a.id.fix",

  NEXT_STEP: "a.step.next",
  STEP_DONE: "a.step.done",
  STEP_HELP: "a.step.help",
  STEP_SKIP: "a.step.skip",
  STEP_WALK: "a.step.walk",
  /** Priority 4.1: the full step, with the tool's real numbered walkthrough and
   * a fully-filled artifact, as a standalone document. Only offered on a step
   * whose tool actually has a walkthrough (see steps.ts's pushNextStep). */
  STEP_PDF: "a.step.pdf",
  /** The whole plan as a PDF, again (round 22: a failed hand-over PDF left no way to ask). */
  PLAN_PDF: "a.plan.pdf",

  WALK_NEXT: "a.walk.next",
  WALK_STUCK: "a.walk.stuck",
  WALK_LATER: "a.walk.later",

  OUTCOME_BETTER: "a.out.better",
  OUTCOME_EARLY: "a.out.early",
  OUTCOME_NONE: "a.out.none",

  SEE_PLAN: "a.plan.see",
  WHY_ORDER: "a.plan.why",
  CHANGE: "a.plan.change",
  NEVER_MIND: "a.plan.nvm",
  MENU: "a.menu",

  CONNECT_AI: "a.connect",
  /** A person already connected chose to replace their address (the old one stops working). */
  CONNECT_NEW: "a.connect.new",
  /** A person already connected chose to keep the address they have. */
  CONNECT_KEEP: "a.connect.keep",
  PAUSE_NUDGES: "a.nudge.pause",

  CHANGE_YES: "a.chg.yes",
  CHANGE_NO: "a.chg.no",

  CONSENT_OK: "a.consent.ok",
  /** "Yes, that's right" under a voice-note transcript read back mid-diagnostic (engine/index.ts, handleDiagText). */
  VOICE_OK: "a.voice.ok",
  /** Leaving stabilising mode, deliberately, when the person says things have steadied. */
  BUILD_NOW: "a.build.now",
  /** Starting the NEXT ninety days once the current plan is finished. */
  REBUILD: "a.plan.rebuild",
} as const;

export type ActionId = (typeof ACT)[keyof typeof ACT];

const ALL: string[] = Object.values(ACT);
export const isActionId = (x: string | undefined | null): x is ActionId => !!x && ALL.includes(x);

/**
 * "I'm stuck", in the ways people actually type it.
 *
 * Live test, 2026-09-25: a person with a finished plan typed "im stuck" — the
 * ordinary way to say "I'm stuck on this step" — and it missed the old
 * exact-match shortcut (help | stuck | help me). It went to the Q&A router
 * instead, which read it as financial distress, and the person was switched
 * into stabilising mode with no way back that kept their plan.
 *
 * Still narrow on purpose. The only object allowed after "stuck on" / "help
 * with" is a word that points at the step in front of them (this, it, this
 * step...): a closed list, never a wildcard. "I'm stuck on how to price, what
 * should I charge?" says WHAT they are stuck on — that is a real question and
 * must reach the answer engine, so it does not match here.
 */
const STEP_HELP_RE = new RegExp(
  [
    String.raw`^(?:`,
    // "stuck" / "im stuck" / "i'm stuck on this step" / "stuck here"
    String.raw`(?:i'?m\s+|i\s+am\s+|im\s+)?stuck(?:\s+on\s+(?:this|it|this\s+(?:step|one)|the\s+step)|\s+here|\s+with\s+this(?:\s+(?:step|one))?)?`,
    String.raw`|`,
    // "help" / "help me" / "i need help" / "help with this step" / "can you help me with this"
    String.raw`(?:i\s+need\s+|please\s+|can\s+you\s+)?help(?:\s+me)?(?:\s+with\s+(?:this|it|this\s+(?:step|one)|the\s+step))?(?:\s+please)?`,
    String.raw`)[\s!.?]*$`,
  ].join(""),
  "i",
);

/**
 * People type as well as tap. These are the typed shortcuts the prototype
 * supported, mapped to the same action ids — so typing "next" and tapping
 * "Next step" go down one code path, not two.
 *
 * Deliberately narrow: only short, unambiguous messages match. Anything longer
 * is a real message and goes to the answer engine, because "what happens next
 * if I raise my prices?" is a question, not a command.
 */
const TYPED: [RegExp, ActionId][] = [
  [/^(next|next step|start|go)$/i, ACT.NEXT_STEP],
  [/^(done|finished|did it|sorted)$/i, ACT.STEP_DONE],
  [STEP_HELP_RE, ACT.STEP_HELP],
  [/^(skip|not this one)$/i, ACT.STEP_SKIP],
  [/^(my plan|plan|see my plan|show my plan)$/i, ACT.SEE_PLAN],
  [/^(menu|options)$/i, ACT.MENU],
  [/^(connect|connect my ai|connect ai)$/i, ACT.CONNECT_AI],
  // "pdf", "send the pdf", "resend my plan pdf", "my pdf again", "the pdf please".
  [/^(?:(?:please\s+)?(?:re-?send|send|give)(?:\s+me)?\s+)?(?:(?:the|my)\s+)?(?:plan\s+)?pdf(?:\s+again)?(?:\s+please)?[\s!.?]*$/i, ACT.PLAN_PDF],
  [/^(stop|pause|no more messages)$/i, ACT.PAUSE_NUDGES],
];

/**
 * Every pattern above is anchored at both ends, so this cap is a backstop,
 * not the rule. It was 20; "i need help with this step!" is 27 characters,
 * and cutting the step-help phrasings to fit would have put "im stuck" back
 * on the road to stabilising mode (see STEP_HELP_RE).
 */
const MAX_SHORTCUT_CHARS = 32;

export function typedShortcut(text: string): ActionId | null {
  // Phone keyboards type the curly apostrophe: "I’m stuck" is "I'm stuck".
  const t = (text || "").replace(/[’‘]/g, "'").trim();
  if (!t || t.length > MAX_SHORTCUT_CHARS) return null;
  for (const [re, act] of TYPED) if (re.test(t)) return act;
  return null;
}
