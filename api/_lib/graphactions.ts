// Charles — the knowledge graph triggers actions.
//
// When what Charles knows about a household's money changes in a way that
// matters, Charles does something about it, once, at the moment it matters:
//
//   debt_paid_off    A debt is closed.        "Edgars is paid off. That's R250 a month back in your
//                                              hands" + set up a savings pocket / see my goal.
//   new_mashonisa    A mashonisa appears in   What can they do, and when is it gone at what you pay.
//                    conversation.
//   repayment_up     A repayment went up.     "R300 to R400 a week" + when is it gone / can they.
//   support_up       Money to family went     "R600 to R700 a month" + help agreeing a fixed amount.
//                    up by a fifth or more.
//   double_cover     Two funeral policies.    Both named, and "check what each pays before cancelling
//                                              anything" + do I need both.
//   joined_stokvel   A stokvel, newly said.   The checks that show whether a stokvel is safe.
//   started_saving   Saving, newly said.      What it adds up to over 90 days at that rate + my goal.
//
// The rules, all in code:
//   - Every figure in an action is the graph's own (rule 10): an amount the
//     person typed or a statement showed, or arithmetic on one. Every RULE or
//     fact about the world (what a mashonisa may do, how a stokvel is checked)
//     is never in the action's text: it is a button that asks the grounded
//     answer engine, which answers from the library with its dates.
//   - Nothing recommends credit (rule 11). A debt is never answered with a
//     loan; a freed payment goes to a savings pocket, free and reversible.
//   - Who said it is said honestly (rule 2): "you told me" only for what they
//     said, "your statement shows" for what a statement showed.
//   - Once per thing: a ledger (kg_triggers, db/0039) keys each action on the
//     trigger and the thing, and for a changed amount on the new amount, so
//     the same news is never acted on twice.
//   - At most one action a turn, none within six hours of the last, none in
//     hardship mode (rule 9: nothing but steadying then), none before the plan.
//   - After the reply has gone, never instead of it.

import { db } from "./db.js";
import { classOf, rand, type Edge, type HouseholdGraph } from "./graph.js";
import { track } from "./track.js";
import type { Business } from "./types.js";

export type Trigger = "debt_paid_off" | "new_mashonisa" | "repayment_up" | "support_up" | "double_cover" | "joined_stokvel" | "started_saving";

export interface GraphAction {
  trigger: Trigger;
  /** What the ledger keys it on: the thing, and the amount when the news is an amount. */
  subject: string;
  text: string;
  buttons: { id: string; title: string }[];
}

/** A button that asks the answer engine, in the person's voice (engine/index.ts a.q.). */
const ask = (title: string, question: string) => ({ id: `a.q.k:${question}`.slice(0, 200), title });
/** A button that draws a card (engine/index.ts a.kg.card). */
const card = (title: string, kind: "debt" | "goal" | "month" | "map" | "memory") => ({ id: `a.kg.card:${kind}`, title });

const said = (e: Edge): boolean => e.sources.includes("said") || e.sources.includes("connector");
const onlyFromConversation = (e: Edge): boolean => said(e) && !e.sources.includes("answer") && !e.sources.includes("statement");
const per = (e: Edge): string => (e.per ? ` a ${e.per}` : "");
const pretty = (label: string): string => label.replace(/^(?:a|an|the)\s+/i, "").replace(/^./, (c) => c.toUpperCase());
const lowerFirst = (label: string): string => (/^(?:the|a|an|my)\s/i.test(label) ? label.replace(/^./, (c) => c.toLowerCase()) : label);
const howKnown = (es: Edge[]): string => (es.every((e) => e.sources.includes("statement") && !said(e)) ? "Your statement shows" : es.every(said) ? "You told me about" : "I can see");

/**
 * Every action the graph supports right now, best first. Pure: the ledger,
 * the stage and the timing are decided by runGraphActions.
 */
export function actionsFor(g: HouseholdGraph): GraphAction[] {
  const out: GraphAction[] = [];
  const edges = g.edges;

  // A debt paid off: the payment it frees, straight to savings.
  for (const e of edges.filter((x) => x.rel === "owes" && x.closed && said(x))) {
    // Only a debt the person said is paid off (graph.ts PAID_OFF) is ever closed.
    const freed = e.amount != null ? `That's ${rand(e.amount)}${per(e)} back in your hands. ` : "";
    out.push({
      trigger: "debt_paid_off",
      subject: `${e.key}@${e.on}`,
      text: `${pretty(e.label)} is paid off. ${freed}The strongest next move is to send ${e.amount != null ? `that same ${rand(e.amount)}` : "what you were paying"} to a savings pocket on the day money lands, before the month finds it. Nothing new gets borrowed into the space it leaves.`,
      buttons: [ask("Set up a pocket", "How do I set up a savings pocket?"), card("See my goal", "goal")],
    });
  }

  // A repayment that went up.
  for (const e of edges.filter((x) => x.rel === "owes" && !x.closed && x.amount != null)) {
    const last = e.history.at(-1);
    if (!last || last.amount == null || last.amount >= e.amount!) continue;
    out.push({
      trigger: "repayment_up",
      subject: `${e.key}@${e.amount}`,
      text: `${pretty(e.label)} went from ${rand(last.amount)} to ${rand(e.amount!)}${per(e)}. Before you agree to more, it is worth seeing when it is gone at each amount, and asking whether they are allowed to raise it.`,
      buttons: [card("When is it gone?", "debt"), ask("Can they raise it?", `Can ${lowerFirst(e.label)} raise what I pay?`)],
    });
  }

  // A mashonisa, newly told.
  for (const e of edges.filter((x) => x.rel === "owes" && !x.closed && x.key === "mashonisa" && onlyFromConversation(x))) {
    out.push({
      trigger: "new_mashonisa",
      subject: e.key,
      text: `You told me about the mashonisa${e.amount != null ? ` at ${rand(e.amount)}${per(e)}` : ""}. Two things are worth knowing before the next payment: what a mashonisa can and cannot do to you, and when it is gone at what you pay.`,
      buttons: [ask("What can they do?", "What can a mashonisa do to me if I miss a payment?"), card("When is it gone?", "debt")],
    });
  }

  // Money to family, up by a fifth or more.
  for (const e of edges.filter((x) => x.rel === "supports" && !x.closed && x.amount != null)) {
    const last = e.history.at(-1);
    if (!last || last.amount == null || e.amount! < last.amount * 1.2) continue;
    out.push({
      trigger: "support_up",
      subject: `${e.key}@${e.amount}`,
      text: `What goes to ${lowerFirst(e.label)} went from ${rand(last.amount)} to ${rand(e.amount!)}${per(e)}. Family money works best as a fixed line everyone knows. Want help agreeing an amount that fits the month?`,
      buttons: [ask("Agree a fixed amount", "Help me agree a fixed amount with my family")],
    });
  }

  // Two funeral policies: paying twice for the same cover is common.
  const funeral = edges.filter((x) => x.rel === "covered_by" && !x.closed && classOf(x.label) === "funeral policy");
  if (funeral.length >= 2) {
    const two = funeral.slice(0, 2);
    out.push({
      trigger: "double_cover",
      subject: funeral.map((x) => x.key).sort().join("+"),
      text: `${howKnown(two)} two funeral policies: ${two[0]!.label} and ${two[1]!.label}. Paying twice for the same cover is common. Check what each one pays out and who it covers before you cancel anything.`,
      buttons: [ask("Do I need both?", "I have two funeral policies. Do I need both?")],
    });
  }

  // A stokvel, newly told.
  for (const e of edges.filter((x) => x.rel === "member_of" && !x.closed && classOf(x.label) === "stokvel" && onlyFromConversation(x))) {
    out.push({
      trigger: "joined_stokvel",
      subject: e.key,
      text: `You told me about ${lowerFirst(e.label)}${e.amount != null ? `, ${rand(e.amount)}${per(e)}` : ""}. Most stokvels are run well, and a few are not. There are a few checks that show which kind yours is.`,
      buttons: [ask("Is mine safe?", "How do I check that my stokvel is safe?")],
    });
  }

  // Saving, newly told: what it adds up to.
  for (const e of edges.filter((x) => x.rel === "saves_in" && !x.closed && onlyFromConversation(x) && x.amount != null)) {
    const n = e.per === "week" ? 13 : e.per === "month" ? 3 : null;
    if (!n) continue;
    out.push({
      trigger: "started_saving",
      subject: `${e.key}@${e.amount}`,
      text: `${rand(e.amount!)}${per(e)} into ${lowerFirst(e.label)}. Kept up, that is ${rand(e.amount! * n)} by the end of the 90 days.`,
      buttons: [card("See my goal", "goal")],
    });
  }
  return out;
}

const SIX_HOURS = 6 * 36e5;
const QUIET_STAGES = new Set(["plan_ready", "step_pushed"]);

/**
 * Picks the one action worth sending now, if any: the stage allows it, no
 * action went out in the last six hours, and this exact news has not been
 * acted on before. Records it in the ledger. Never throws; a failure costs
 * the person nothing, since the reply has already gone.
 */
export async function nextGraphAction(biz: Pick<Business, "id" | "stage">, g: HouseholdGraph): Promise<GraphAction | null> {
  if (!QUIET_STAGES.has(biz.stage)) return null;
  const candidates = actionsFor(g);
  if (!candidates.length) return null;
  try {
    const { data } = await db().from("kg_triggers").select("trigger, subject, fired_at").eq("business_id", biz.id);
    const fired = (data as { trigger: string; subject: string; fired_at: string }[]) ?? [];
    if (fired.some((f) => Date.now() - Date.parse(f.fired_at) < SIX_HOURS)) return null;
    const fresh = candidates.find((a) => !fired.some((f) => f.trigger === a.trigger && f.subject === a.subject));
    if (!fresh) return null;
    const { error } = await db().from("kg_triggers").insert({ business_id: biz.id, trigger: fresh.trigger, subject: fresh.subject.slice(0, 120), fired_at: new Date().toISOString() });
    // A ledger that cannot be written cannot promise "once": send nothing.
    if (error) return null;
    track("graph_action_fired", { category: "behaviour", props: { trigger: fresh.trigger } });
    return fresh;
  } catch (err) {
    console.warn("nextGraphAction: skipped", err);
    return null;
  }
}
