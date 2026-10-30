// Charles — the fixed plan-step library.
// Steps are FIXED and sequenced; each one's output feeds the next. The model
// may only tailor wording to this person — it may never invent, add, drop
// or reorder a step (CLAUDE.md rule 1).
//
// Every module here is a thing the evidence says moves a household's money:
// a list of what is owed before anything else (you cannot pay down what you
// cannot see), the smallest debt first (the snowball keeps people going —
// Gal and McShane 2012), one rule of thumb kept for 90 days (Drexler, Fischer
// and Schoar 2014), money put aside on the day it lands rather than at the
// end of the month, and the free rights most people never use: the free
// credit report, the dispute, prescribed debt, the ombud. Nothing here
// recommends credit, ever (rule 11).

import { BLOCKER_OPTIONS, OBJECTIVE_KIND_OPTIONS, splitPicks } from "./diagoptions.js";

export interface PlaybookStep {
  id: string;
  title: string;
  domain: string;
  outcome: string;
  done_when: string;
  brief: string;
  artifact_brief: string | null;
  tool_choices?: string[];
  /**
   * How to actually do it, for a step that names no tool (and so has no
   * tools.walkthrough to show): 3-5 short, fixed, imperative lines. Written
   * here, never by a model — same as the step itself (rule 1). No prices,
   * fees, rules or deadlines (rule 10), and nothing that claims the person
   * said something (rule 2). Read back by step_key at push and render time
   * (libraryHowTo), so no plan_steps column carries it.
   */
  how_to?: string[];
  /**
   * The knowledge entries this step pins, AT MOST ONE PER COUNTRY. The plan
   * build only ever sees the person's own country's rows, so the pin keeps
   * the local one and the rest find nothing (stepKnowledgePins). A country
   * with no equivalent row is simply absent — never pin a row that covers a
   * different topic just to fill the slot (CLAUDE.md rule 10).
   */
  knowledge_ids?: string[];
}

/**
 * Every knowledge id the given steps pin that exists as a row in `country`,
 * deduplicated, in step order. A step's other countries' ids drop out here.
 */
export function stepKnowledgePins(
  steps: readonly Pick<PlaybookStep, "knowledge_ids">[],
  rows: readonly { id: string; country: string }[],
  country: string,
): string[] {
  const local = new Set(rows.filter((r) => r.country === country).map((r) => r.id));
  return [...new Set(steps.flatMap((s) => s.knowledge_ids ?? []))].filter((id) => local.has(id));
}

export interface Workstream {
  id: string;
  title: string;
  domain: string;
  why: string;
  steps: PlaybookStep[];
}

export interface Module extends Workstream {
  needs: (sg: Signals, answers?: Record<string, string>, goals?: { label: string; what: string }[], stage?: string) => boolean;
  serves: string[];
}

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

export interface Plan {
  headline: string;
  order_note: string;
  workstreams: Workstream[];
}

// What a workstream/step look like AFTER the model has tailored the fixed
// method to this person (see hydrateWorkstream in engine/build.ts).
export interface HydratedStep extends PlaybookStep {
  push: string;
  artifact: string | null;
  why_for_you: string;
  tool_id: string | null;
}
export interface HydratedWorkstream extends Omit<Workstream, "steps"> {
  steps: HydratedStep[];
  why_for_you: string;
  /** Tailoring failed and the part is in library wording. The hand-over says so, and a plan repair redoes it. */
  untailored?: boolean;
  /** The same part tailored by its own lane after the build was handed over at its deadline in library wording. */
  late?: HydratedWorkstream;
}

/**
 * The person's own sentence, ready to sit inside quotes mid-sentence: no
 * closing full stop of its own, and no outer quotes of its own.
 */
export function quoteOf(words: string): string {
  let s = words.trim();
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/[.;:,\s]+$/, "");
    if (/^["“'‘]/.test(s) && /["”'’]$/.test(s) && s.length > 1) s = s.slice(1, -1).trim();
  }
  return s;
}

/**
 * The option labels a "problem in their words" is made of, when it is only
 * labels they tapped ("Repayments eat my pay, Family needs money from me"):
 * matched whole against the real options, longest first. Null when any of
 * it is their own words.
 */
function pickedLabels(quote: string): { label: string; aim: boolean }[] | null {
  const known = [...BLOCKER_OPTIONS.map((label) => ({ label, aim: false })), ...OBJECTIVE_KIND_OPTIONS.map((label) => ({ label, aim: true }))].sort((x, y) => y.label.length - x.label.length);
  const out: { label: string; aim: boolean }[] = [];
  let rest = quote.trim();
  while (rest) {
    const hit = known.find((k) => rest.toLowerCase().startsWith(k.label.toLowerCase()) && /^(?:\s*,\s*|\s*$)/.test(rest.slice(k.label.length)));
    if (!hit) return null;
    out.push(hit);
    rest = rest.slice(hit.label.length).replace(/^\s*,\s*/, "");
  }
  return out.length ? out : null;
}

/**
 * Why the first part comes first, in the person's terms — or null, for the
 * caller's own plain line. Their own sentence is quoted; but when the
 * "problem in their words" is only option labels they tapped, quoting it
 * reads as a form, not as something they said. It is then said as what they
 * picked, in plain words.
 */
export function problemPhrase(problem: string, _answers: Record<string, string> = {}): string | null {
  const quote = quoteOf(problem);
  if (!quote) return null;
  const picks = pickedLabels(quote);
  if (!picks) return `it goes straight at what you told me: "${quote}"`;
  const named = picks.filter((p) => p.label !== "Nothing major, I want to get ahead" && p.label !== "Something else");
  if (!named.length) return null;
  const lower = named.map((p) => (/^I(?:['’ ]|$)/.test(p.label) ? p.label : p.label.replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase())));
  const list = lower.length > 1 ? `${lower.slice(0, -1).join(", ")} and ${lower[lower.length - 1]}` : lower[0];
  const what = named.every((p) => p.aim) ? "your aim" : named.some((p) => p.aim) ? "what matters most" : "the problem";
  return `it goes straight at what you picked as ${what}: ${list}`;
}

// The tools a step may name. One library, one market for now: a second
// market's ids are appended to the same lists (engine/build.ts forCountry
// keeps only the ids the person's own country has).
const LOG = ["notes_money_log", "sheets_budget"];
const BUREAUS = ["transunion_free_report", "experian_free_report", "xds_free_report"];
const SAVE = ["gotyme_goalsave"];

export const MODULES: Record<string, Module> = {
  owed: {
    id: "m_owed",
    title: "See every rand you owe",
    domain: "debt",
    why: "You cannot pay down what you cannot see. Most people are paying whoever shouts loudest, and the one that costs the most is quietly growing. One list changes that in an afternoon.",
    needs: (sg) => Boolean(sg.owes_any),
    serves: ["Get out of debt", "Fix my credit record", "Make the month fit"],
    steps: [
      {
        id: "o1",
        title: "Write down everyone you owe, and what each one costs you",
        domain: "debt",
        outcome: "One list: who, how much, what you pay a month, and what it costs you to owe them. Most people owe more than they think, and the most expensive one is rarely the biggest.",
        done_when: "the list is written, with a cost next to each debt",
        tool_choices: LOG,
        knowledge_ids: ["k.debt_list"],
        brief: "Have them list every debt: bank, store accounts, cellphone, mashonisa, family, stokvel. For each: the amount owed, the monthly payment, and the interest or fee they are charged. Say plainly that a mashonisa's cost goes at the top even when the amount is small. Use only their own numbers.",
        artifact_brief: "the owed list with their columns, ready to fill in",
        how_to: [
          "Go through your messages, statements and the papers in the drawer for everything you owe.",
          "Write one line each: who, how much is left, what you pay a month, and the interest or fee.",
          "Put the one with the highest interest or fee at the top, even if the amount is small.",
          "Add up what you pay out to all of them in a month.",
          "Keep the list where you will see it on payday.",
        ],
      },
      {
        id: "o2",
        title: "Get your free credit report and read it",
        domain: "credit_record",
        outcome: "You see what the lenders see: every account, every late payment, anything listed in your name that should not be.",
        done_when: "you have the report in front of you",
        tool_choices: BUREAUS,
        knowledge_ids: ["k.free_credit_report"],
        brief: "Point them to one bureau's free report (their own name, their own ID, on the bureau's site — never sent to Charles). Say what to look for: an account they do not recognise, a debt older than three years, a judgment that was paid. Say they are entitled to this.",
        artifact_brief: null,
      },
      {
        id: "o3",
        title: "Pick the one debt to kill first, and tell the others",
        domain: "debt",
        outcome: "One debt gets everything spare; the rest get the minimum and a message, so nobody is chasing you by surprise.",
        done_when: "you have sent the message to every creditor on the list",
        knowledge_ids: ["k.debt_snowball"],
        brief: "Pick the first target from THEIR list: the mashonisa if there is one, else the smallest balance. Explain why smallest first keeps people going. Give the calm message to send the other creditors asking for an arrangement on the minimum. Never suggest a consolidation loan.",
        artifact_brief: "the message to a creditor asking for a payment arrangement, in their voice, with their amount",
        how_to: [
          "Take your list. If a mashonisa is on it, that one is first. If not, the smallest balance is first.",
          "Everyone else gets the minimum payment, on time, every month.",
          "Send each of the others one short message saying what you can pay and on which day.",
          "Everything spare goes to the first one until it is gone.",
          "Cross it off the list when it is paid, and keep the letter that says so.",
        ],
      },
    ],
  },
  shark: {
    id: "m_shark",
    title: "Get out of the mashonisa's book",
    domain: "debt",
    why: "A mashonisa's interest is the most expensive money in the country, and much of what they do to collect it is against the law. This part gets you out, and makes sure you never go back in.",
    needs: (sg) => Boolean(sg.owes_mashonisa),
    serves: ["Get out of debt", "Make the month fit", "Protect my family"],
    steps: [
      {
        id: "sh1",
        title: "Know what a mashonisa can and cannot do to you",
        domain: "debt",
        outcome: "You know which of their threats are real and which are crimes, and who to call.",
        done_when: "you have read the rules and saved the number",
        tool_choices: ["ncr_complaint"],
        knowledge_ids: ["k.mashonisa_law"],
        brief: "Give them the rules from the knowledge row only: an unregistered lender, what the law says about the debt, and that holding a card, ID or PIN is a crime. Name who to report to. No bravado — they still live near this person.",
        artifact_brief: null,
      },
      {
        id: "sh2",
        title: "Set the pay-down, and stop the re-borrowing",
        domain: "debt",
        outcome: "A fixed amount on a fixed day until it is gone, and nothing new borrowed from anyone while you do it.",
        done_when: "two payments have gone on the day you said",
        knowledge_ids: ["k.mashonisa_law"],
        brief: "From their income and their list, set a fixed payment and a day for it. Say plainly that the only way this works is nothing new borrowed from anyone, and what to say when the mashonisa offers more. Use their numbers only.",
        artifact_brief: "what to say to the mashonisa when you pay: the amount, the day, and that there will be no new loan",
        how_to: [
          "Choose the amount you can pay every time without borrowing to do it.",
          "Choose the day, straight after the money lands.",
          "Pay it in a way that leaves a record, and ask for the balance each time.",
          "If they offer a new loan, say no and leave.",
          "Write down each payment and what is left.",
        ],
      },
      {
        id: "sh3",
        title: "Get your card and ID back, and keep them",
        domain: "protection",
        outcome: "Nobody but you holds your bank card, your SASSA card, your ID or your PIN.",
        done_when: "everything is back in your hands and the PIN is changed",
        tool_choices: ["saps_case", "ncr_complaint"],
        knowledge_ids: ["k.mashonisa_law"],
        brief: "If they handed over a card, ID or PIN, say how to get it back: ask once, then report. Say what to do the moment it is back (change the PIN, check the account). If nothing was handed over, make this a rule for the future.",
        artifact_brief: null,
      },
    ],
  },
  snowball: {
    id: "m_snowball",
    title: "Kill the smallest debt first",
    domain: "debt",
    why: "Paying a little to everyone keeps you in debt for years. Paying the minimum to all and everything spare to the smallest one clears a debt in weeks, and that first win is what keeps people going.",
    needs: (sg) => Boolean(sg.owes_two_plus),
    serves: ["Get out of debt", "Fix my credit record"],
    steps: [
      {
        id: "sn1",
        title: "Line them up, smallest first",
        domain: "debt",
        outcome: "An order. You know exactly which debt is next and why.",
        done_when: "the order is written",
        tool_choices: LOG,
        knowledge_ids: ["k.debt_snowball"],
        brief: "Order their list by balance, smallest first, except that a mashonisa always goes first. Say why this order and not highest-interest first, honestly: the evidence is about keeping going, not arithmetic.",
        artifact_brief: null,
        how_to: [
          "Take your owed list and write the balances in order, smallest at the top.",
          "If a mashonisa is on the list, move it to the very top whatever its size.",
          "Next to each one write the minimum payment.",
          "Circle the top one. That is the only one that gets extra money.",
        ],
      },
      {
        id: "sn2",
        title: "Minimum on all, everything spare on the first",
        domain: "debt",
        outcome: "Every account stays current, and the first one shrinks fast.",
        done_when: "one month has gone this way",
        tool_choices: ["debicheck"],
        knowledge_ids: ["k.debt_snowball"],
        brief: "Work out from their month plan what is spare after the minimums, and send it to the first debt on payday. Say how to make sure the minimums cannot bounce. Never suggest skipping a minimum to pay more on the target.",
        artifact_brief: null,
        how_to: [
          "On payday, pay every minimum first.",
          "Whatever is spare after that goes to the top debt the same day.",
          "Do not touch the order, even when another one feels more urgent.",
          "At the end of the month, write what is left on the top debt.",
        ],
      },
      {
        id: "sn3",
        title: "When one dies, roll its payment into the next",
        domain: "debt",
        outcome: "Each cleared debt makes the next one faster. Settled accounts are closed properly, with the letter to prove it.",
        done_when: "the first debt is settled and its letter is in your hands",
        knowledge_ids: ["k.settled_account"],
        brief: "When the first debt is paid: ask for the settlement or paid-up letter, cancel any credit life or insurance tied to it, and add its whole payment to the next debt. Say what to check on the credit report afterwards.",
        artifact_brief: "the message asking a lender for a paid-up letter and to close the account",
        how_to: [
          "When the top debt is paid, ask for a paid-up letter and keep it.",
          "Cancel any insurance that was tied to that account.",
          "Add the payment you were making on it to the next debt on the list.",
          "Check your credit report later to see it marked as settled.",
        ],
      },
    ],
  },
  month: {
    id: "m_month",
    title: "Make the month fit the money",
    domain: "spending",
    why: "The month is not too long; it is unplanned. A week of writing down every rand, then one plan made on payday, is how people who earn what you earn stop running out on the 20th.",
    needs: (sg) => Boolean(sg.month_short || sg.dont_know_where),
    serves: ["Make the month fit", "Have something saved", "Get out of debt"],
    steps: [
      {
        id: "mo1",
        title: "Write down a week of spending, every rand",
        domain: "spending",
        outcome: "You see where it actually goes. It is almost never where you think.",
        done_when: "seven days are written down",
        tool_choices: LOG,
        knowledge_ids: ["k.week_spend_log"],
        brief: "Set up the simplest possible log for their phone: one line per spend, the amount and what it was. Say to include airtime, taxis, the small things. No judgement about what they spend on.",
        artifact_brief: "the seven-day log, with their likely lines already written in",
        how_to: [
          "Each time money leaves your hands, write one line: what it was and how much.",
          "Include airtime, data, taxi fare, electricity and the small things.",
          "Do it the same day, before you forget.",
          "After seven days, add it up and circle the three biggest lines.",
        ],
      },
      {
        id: "mo2",
        title: "Build the month plan on payday: bills first, then the rest",
        domain: "spending",
        outcome: "A plan for the month that adds up to what actually comes in, made before any of it is spent.",
        done_when: "the plan is written and it adds up",
        tool_choices: ["sheets_budget", "notes_money_log"],
        knowledge_ids: ["k.three_pots_budget"],
        brief: "Using their income and the week's log, split the month into three: the bills that must be paid, the money put aside, and everything else. Use their numbers. Where the bills already exceed the income, say so plainly and point at the owed list rather than inventing savings.",
        artifact_brief: "the month plan with their real lines and amounts, laid out to fill in on payday",
        how_to: [
          "On payday, before anything is spent, write what came in at the top of a page.",
          "Under it, list the bills and debts that must be paid, with the day each is due.",
          "Take those off the top. What is left is for the month.",
          "Decide what goes aside, and what is for food, transport and the rest.",
          "Check the plan against the real spending after two weeks and fix what did not fit.",
        ],
      },
      {
        id: "mo3",
        title: "Pay the bills the day the money lands",
        domain: "spending",
        outcome: "Nothing bounces, nothing is late, and no fee is paid for a payment that failed.",
        done_when: "every bill in the plan has been paid on the day you said",
        tool_choices: ["debicheck", "payshap"],
        knowledge_ids: ["k.bank_fees_audit"],
        brief: "Set up the order of payments for payday from their plan, so the essentials go first and nothing bounces. Say what a failed debit order costs them in fees, from the knowledge row only, and how to time debit orders to the day money lands.",
        artifact_brief: null,
      },
    ],
  },
  cushion: {
    id: "m_cushion",
    title: "Build a cushion you can reach",
    domain: "cushion",
    why: "Every mashonisa loan starts with a surprise: a funeral, a school letter, a broken phone. A small amount you can reach, kept apart from the everyday money, is what makes the next surprise a nuisance instead of a crisis.",
    needs: (sg) => Boolean(sg.no_cushion),
    serves: ["Have something saved", "Make the month fit", "Protect my family"],
    steps: [
      {
        id: "cu1",
        title: "Name the number",
        domain: "cushion",
        outcome: "A target you can say out loud: the amount that would cover the surprises that actually happen to you.",
        done_when: "the number is written down",
        knowledge_ids: ["k.cushion_target"],
        brief: "Help them pick a first target from their own life: the cost of the last surprise, or a week of essentials from their month plan. Small on purpose. Never a generic rule like three months of salary for someone who cannot make one month.",
        artifact_brief: null,
        how_to: [
          "Think of the last three surprises that cost you money, and write what each one cost.",
          "Pick the smallest of them, or one week of your essentials, as the first target.",
          "Write the number somewhere you will see it on payday.",
          "When you reach it, pick the next number.",
        ],
      },
      {
        id: "cu2",
        title: "Open a separate place for it and move the first amount today",
        domain: "cushion",
        outcome: "The cushion lives somewhere the everyday money cannot quietly eat it.",
        done_when: "the first amount is in it",
        tool_choices: SAVE,
        knowledge_ids: ["k.separate_money"],
        brief: "Point them to a separate savings pocket in the bank they already use, and say to move a small first amount now, today, however small. Say why separate matters more than the amount. Interest is a bonus, not the point.",
        artifact_brief: null,
      },
      {
        id: "cu3",
        title: "Make it automatic on payday",
        domain: "cushion",
        outcome: "The cushion grows without you deciding each month, because the money moves before you see it.",
        done_when: "it has moved by itself on two paydays",
        tool_choices: SAVE,
        knowledge_ids: ["k.payday_first"],
        brief: "Set the amount from their month plan, and the day as the day money lands. Say what to do in a month when it cannot be afforded: pause it, never borrow to keep it going.",
        artifact_brief: null,
      },
    ],
  },
  credit: {
    id: "m_credit",
    title: "Fix your credit record",
    domain: "credit_record",
    why: "Your record decides what everything costs you, from a phone contract to a home. Most of what fixes it is free and takes an afternoon: see it, dispute what is wrong, and then pay on time until the record shows it.",
    needs: (sg) => Boolean(sg.credit_worry || sg.arrears),
    serves: ["Fix my credit record", "Get out of debt"],
    steps: [
      {
        id: "cr1",
        title: "Get your free report from each bureau",
        domain: "credit_record",
        outcome: "You have the reports, and you know what is on them.",
        done_when: "you have read at least one report",
        tool_choices: BUREAUS,
        knowledge_ids: ["k.free_credit_report"],
        brief: "Point them to the free report, on the bureau's own site with their own ID (never sent to Charles). Say what to look for first: anything they do not recognise, anything older than three years with no payment, anything paid that still shows as owing.",
        artifact_brief: null,
      },
      {
        id: "cr2",
        title: "Dispute what is wrong, and have the old debt removed",
        domain: "credit_record",
        outcome: "Wrong listings are challenged in writing, and prescribed debt comes off.",
        done_when: "the dispute has been sent",
        tool_choices: ["nfo_complaint", ...BUREAUS],
        knowledge_ids: ["k.dispute_credit_listing"],
        brief: "Give them the dispute as a message, using only the rules in the knowledge rows: what the bureau must do, and what never to do with an old debt (never acknowledge it, never pay a cent toward it before checking). Name who to complain to if the bureau ignores it.",
        artifact_brief: "the dispute message to the bureau, with slots for the account and what is wrong",
      },
      {
        id: "cr3",
        title: "Three months of on-time, set up so you cannot miss",
        domain: "credit_record",
        outcome: "Every account paid on the day, every month, until the record shows a clean run.",
        done_when: "three months of on-time payments are done",
        tool_choices: ["debicheck"],
        knowledge_ids: ["k.credit_score_moves"],
        brief: "Set every payment to the day money lands, in the order from their month plan. Say what moves a score and what does not, from the knowledge row only. Never suggest taking new credit to build a record.",
        artifact_brief: null,
      },
    ],
  },
  family: {
    id: "m_family",
    title: "Set the family line",
    domain: "family_money",
    why: "Helping family is not the problem. Helping without a number is: it is the line in your month that changes every time the phone rings. One fixed amount, said once, protects both the family and you.",
    needs: (sg) => Boolean(sg.family_pressure),
    serves: ["Make the month fit", "Protect my family", "Have something saved"],
    steps: [
      {
        id: "fa1",
        title: "Decide the number, from your month plan",
        domain: "family_money",
        outcome: "One amount for family each month that the month can actually carry.",
        done_when: "the number is written in the plan",
        knowledge_ids: ["k.family_line"],
        brief: "From their income and bills, help them land on a fixed family amount, honestly. If the month cannot carry what they currently give, say so, with their numbers. Never guilt, never suggest cutting people off.",
        artifact_brief: null,
        how_to: [
          "Look at what you gave family in each of the last three months.",
          "Look at what your month plan can carry after bills and the money put aside.",
          "Pick one amount that fits, and the day it is sent.",
          "Write it into the month plan as its own line.",
        ],
      },
      {
        id: "fa2",
        title: "Say it once, kindly, and stick to it",
        domain: "family_money",
        outcome: "The people who ask know the number and the day, so the asking stops being a surprise.",
        done_when: "you have had the conversation",
        knowledge_ids: ["k.family_line"],
        brief: "Write the words for the conversation, in their voice, respectful of their family: the amount, the day, and that it is fixed so it can be relied on. Give the one line for when an extra request comes.",
        artifact_brief: "what to say to family about the fixed amount, and the one line for an extra request",
        how_to: [
          "Choose a calm moment, not the moment someone asks.",
          "Say the amount and the day, and that it will come every month.",
          "Say that extra requests will have to wait for the next month.",
          "Send the same amount on the same day, so people can plan around it.",
        ],
      },
      {
        id: "fa3",
        title: "Check the stokvel or society you pay into",
        domain: "family_money",
        outcome: "You know the group's rules, who holds the money, and that it is what it says it is.",
        done_when: "you have seen the constitution and the books",
        tool_choices: ["nasasa_stokvel"],
        knowledge_ids: ["k.stokvel_safety"],
        brief: "Give the questions to ask any stokvel or burial society: written rules, who holds the money and where, how payouts are decided, whether it is registered. Say what a scheme that promises returns looks like. If they belong to none, say this step is a check for the future.",
        artifact_brief: null,
      },
    ],
  },
  cover: {
    id: "m_cover",
    title: "Cover the people who depend on you",
    domain: "protection",
    why: "A funeral is the surprise that sends more households to a mashonisa than any other. One policy that fits, with the right people named on it, is the cheapest protection there is. Two policies for the same thing is money thrown away every month.",
    needs: (sg) => Boolean(sg.no_cover || sg.double_cover),
    serves: ["Protect my family", "Make the month fit"],
    steps: [
      {
        id: "co1",
        title: "List every policy and what each one actually pays",
        domain: "protection",
        outcome: "One page: each policy, what it costs a month, what it pays out, for whom, and its waiting period.",
        done_when: "every policy is on the page",
        tool_choices: LOG,
        knowledge_ids: ["k.funeral_cover_rules"],
        brief: "Have them list every policy, society and plan they pay for, including ones deducted from a grant or a salary. For each: the premium, the payout, who is covered, the waiting period. Say what to ask the insurer. If they have none, this page has one line: who would need covering.",
        artifact_brief: "the policy list with the columns to fill in",
      },
      {
        id: "co2",
        title: "Keep one policy that fits; cancel the doubles or start the one you need",
        domain: "protection",
        outcome: "One policy covers the people who depend on you, at a premium the month can carry, and nothing is paid twice.",
        done_when: "the doubles are cancelled, or the one policy is in place",
        knowledge_ids: ["k.double_cover"],
        brief: "From their list, say which to keep and which to cancel, with the reason (payout per rand of premium, waiting period already served). If they have none, say what a fitting policy looks like for the people they named, and the free things to check before signing. Never name a premium that is not in the knowledge rows.",
        artifact_brief: "the cancellation message for a doubled policy, or the questions to ask before taking one",
        how_to: [
          "Put your policies side by side: who is covered, what it pays out, what it costs a month, and how long the waiting period has left.",
          "Keep the one that covers the people you named at the lowest cost per rand of payout, and that has already served its waiting period.",
          "Cancel the doubles in writing to the insurer, and keep the reply; stop the debit order only once the cancellation is confirmed.",
          "If you have none, ask three questions before you sign anything: who exactly is covered, what the waiting period is, and what makes a claim fail.",
          "Never take a policy sold at the door or over the phone on the spot; take the paper home and read it first.",
        ],
      },
      {
        id: "co3",
        title: "Name who gets it, and tell them where the papers are",
        domain: "protection",
        outcome: "The right person is the beneficiary, and they know it and can find the policy.",
        done_when: "the beneficiary is named and told",
        knowledge_ids: ["k.beneficiary_nomination"],
        brief: "Say how to check and change the beneficiary with the insurer, why the named person matters, and the two things to tell them: that the policy exists and where the papers are.",
        artifact_brief: null,
        how_to: [
          "Check who is named on each policy as the person who gets paid.",
          "If it is the wrong person, or nobody, change it with the insurer.",
          "Tell that person the policy exists and who to call.",
          "Keep the papers and the policy number in one place they know.",
        ],
      },
    ],
  },
  fees: {
    id: "m_fees",
    title: "Stop paying to use your own money",
    domain: "spending",
    why: "Bank fees, failed debit orders, airtime bought in small pieces and electricity at the wrong rate are a leak that nobody notices because each one is small. Together they are a bill.",
    needs: (sg) => Boolean(sg.fees_pain),
    serves: ["Make the month fit", "Have something saved"],
    steps: [
      {
        id: "fe1",
        title: "Find every fee on last month's statement",
        domain: "spending",
        outcome: "A number: what you paid last month just to move your own money.",
        done_when: "the fees are added up",
        tool_choices: ["gotyme_everyday", "notes_money_log"],
        knowledge_ids: ["k.bank_fees_audit"],
        brief: "Tell them where to find the fees on their statement or in their bank app, which lines to look for (withdrawals, declined debit orders, monthly fees, airtime markups), and to add them up. Their own statement is the source; never quote a fee that is not in the knowledge rows.",
        artifact_brief: null,
      },
      {
        id: "fe2",
        title: "Switch the expensive habits",
        domain: "spending",
        outcome: "Money moves the free way: instant payments to a number, cash from the till, airtime and data in bundles.",
        done_when: "you have made one payment and one withdrawal the cheaper way",
        tool_choices: ["payshap", "gotyme_everyday"],
        knowledge_ids: ["k.payshap_free_rule"],
        brief: "Pick the one habit on their statement that costs the most and give the free replacement for it, using only the knowledge and tool rows. One change this week, not a list.",
        artifact_brief: null,
      },
      {
        id: "fe3",
        title: "Check the free electricity and the indigent register",
        domain: "income",
        outcome: "You know whether your household qualifies for free basic electricity or water, and have applied if it does.",
        done_when: "you have asked the municipality",
        tool_choices: ["municipal_indigent_register"],
        knowledge_ids: ["k.indigent_register"],
        brief: "Say what the indigent register and free basic electricity are, who usually qualifies, and the one place to ask. Only what the knowledge row states; the municipality decides.",
        artifact_brief: null,
      },
    ],
  },
  claim: {
    id: "m_claim",
    title: "Claim what you are owed",
    domain: "income",
    why: "A grant you qualify for, a UIF payout after losing work, a tax refund sitting at SARS: money that is already yours, waiting for a form. It is the fastest money in this plan because nobody has to be paid back.",
    needs: (sg) => Boolean(sg.grant_income || sg.unclaimed_benefit),
    serves: ["Make the month fit", "Have something saved", "Protect my family"],
    steps: [
      {
        id: "cl1",
        title: "Check every grant, benefit and refund you might qualify for",
        domain: "income",
        outcome: "A short list of what you may be owed, and what each one needs.",
        done_when: "the list is written",
        tool_choices: ["sassa_office", "sars_efiling", "ufiling_uif"],
        knowledge_ids: ["k.sassa_grants_overview"],
        brief: "From their situation (children, age, work history, income), say which grants or benefits the knowledge rows suggest they may qualify for, with the rule each one depends on. Say who decides. Never state an amount that is not in the rows.",
        artifact_brief: null,
      },
      {
        id: "cl2",
        title: "Apply, with the papers ready",
        domain: "income",
        outcome: "The application is in, and you know how to check its status.",
        done_when: "you have applied for the first one",
        tool_choices: ["sassa_srd_online", "sassa_office", "ufiling_uif", "sars_efiling"],
        knowledge_ids: ["k.uif_claim"],
        brief: "Pick the one claim worth most to them and walk them to it: the papers to bring, where to go, how to check status. Say the honest timing only where a knowledge row gives it.",
        artifact_brief: null,
      },
      {
        id: "cl3",
        title: "Stop the deductions that should not be there",
        domain: "income",
        outcome: "Nothing comes off your grant or pay that you did not agree to, and anything that did is disputed.",
        done_when: "you have checked the deductions and disputed any that are wrong",
        tool_choices: ["sassa_office", "nfo_complaint"],
        knowledge_ids: ["k.sassa_deductions_rule"],
        brief: "Say what may lawfully be deducted from a grant and what may not, from the knowledge row, and how to dispute one. For a salary, the same for loan deductions and garnishee orders, from the rows only.",
        artifact_brief: "the dispute message for a deduction they did not agree to",
      },
    ],
  },
  safe: {
    id: "m_safe",
    title: "Make your money hard to steal",
    domain: "protection",
    why: "Most money stolen from bank accounts is not hacked; it is talked out of people by someone pretending to be the bank. Three free settings and one habit close almost all of it.",
    needs: (sg) => Boolean(sg.scam_exposed),
    serves: ["Protect my family", "Have something saved"],
    steps: [
      {
        id: "sa1",
        title: "Lock the app and the SIM",
        domain: "protection",
        outcome: "Your banking app, your SIM and your cards have the protections switched on, and you know the signs of a SIM swap.",
        done_when: "the settings are on",
        tool_choices: ["bank_fraud_report"],
        knowledge_ids: ["k.sim_swap_signs"],
        brief: "List the settings to switch on in their bank app and with their network, from the knowledge row only, and the one rule: the bank never asks for a PIN, OTP or app approval to stop fraud. Give the signs of a SIM swap and the first call to make.",
        artifact_brief: null,
      },
      {
        id: "sa2",
        title: "Register with the fraud-prevention service, free",
        domain: "protection",
        outcome: "Anyone trying to open credit in your name triggers a check.",
        done_when: "you are registered",
        tool_choices: ["safps_protective_registration"],
        knowledge_ids: ["k.safps_protective_reg"],
        brief: "Point them to the protective registration and say what it does and does not do. Free; say so.",
        artifact_brief: null,
      },
      {
        id: "sa3",
        title: "Check any investment or job offer before a cent moves",
        domain: "protection",
        outcome: "You can tell a real offer from a scheme in two minutes, and you know where to check a licence.",
        done_when: "you have checked one offer this way",
        tool_choices: ["fsca_check"],
        knowledge_ids: ["k.ponzi_signs"],
        brief: "Give the signs from the knowledge row (guaranteed returns, recruit others, pay to get paid, a job that asks for a fee) and the licence check. One rule: nothing is sent before the check.",
        artifact_brief: null,
      },
    ],
  },
  review: {
    id: "m_review",
    title: "Get legal protection from your creditors",
    domain: "debt",
    why: "When the repayments are more than the money, there is a legal process that stops the calls, protects your pay and restructures what you owe. Most people who need it never use it, and many pay a scam for a worse version of it instead.",
    needs: (sg) => Boolean(sg.over_indebted),
    serves: ["Get out of debt", "Protect my family", "Make the month fit"],
    steps: [
      {
        id: "rv1",
        title: "Understand what debt review does, and what it costs you",
        domain: "debt",
        outcome: "You know what it protects, what it stops you doing, what it costs, and how it ends.",
        done_when: "you have read it and decided whether to find out more",
        knowledge_ids: ["k.debt_review_what_it_is"],
        brief: "Explain debt review plainly from the knowledge rows: what it does, the one thing it stops (new credit), the fee rules, and how it ends with a clearance certificate. Honest about the downside. The decision is theirs.",
        artifact_brief: null,
        how_to: [
          "Read what debt review does: a registered debt counsellor works out one payment you can afford and the creditors are bound by it.",
          "Read what it stops: no new credit of any kind until it ends, which is the point and the price.",
          "Read how it ends: when the debts are paid under the plan, a clearance certificate takes the listing off your record.",
          "Write down the one question you still have, and ask it of a registered counsellor, never of a company that promises to remove debt.",
        ],
      },
      {
        id: "rv2",
        title: "Find a registered debt counsellor, never a removal company",
        domain: "debt",
        outcome: "A registered counsellor's number, and the questions to ask before signing anything.",
        done_when: "you have spoken to one",
        tool_choices: ["ncr_debt_counsellor"],
        knowledge_ids: ["k.debt_counselling_vs_removal_scams"],
        brief: "Say how to find a registered counsellor, how to check the registration, and what a debt-removal or credit-clearance company is (and why not). Give the first-call questions.",
        artifact_brief: null,
      },
      {
        id: "rv3",
        title: "If a lender or collector has wronged you, complain for free",
        domain: "debt",
        outcome: "A complaint lodged with the right body, at no cost, with your evidence attached.",
        done_when: "the complaint is sent",
        tool_choices: ["nfo_complaint", "ncr_complaint", "cdc_register"],
        knowledge_ids: ["k.debt_collectors_rights"],
        brief: "From what they have described, say which body takes which complaint (ombud, regulator, the collectors' council) and what to attach. Free, always; say so.",
        artifact_brief: "the complaint, in plain words, with slots for the dates and amounts",
      },
    ],
  },
  future: {
    id: "m_future",
    title: "Put a name on the bigger goal",
    domain: "goals",
    why: "Once the month fits and the surprises are covered, money without a destination drifts back into the month. A written goal with a number, a date and a vehicle is what turns steady into building.",
    needs: (_sg, _answers, _goals, stage) => stage === "steady" || stage === "building",
    serves: ["Have something saved", "Protect my family"],
    steps: [
      {
        id: "fu1",
        title: "Write the goal with a number and a date",
        domain: "goals",
        outcome: "One sentence: what, how much, by when.",
        done_when: "the sentence is written",
        knowledge_ids: ["k.goal_vehicle"],
        brief: "Turn their goal into one measurable sentence in their numbers. If they gave no number, help them find the real one (a quote, a school's fees, a deposit) rather than inventing it.",
        artifact_brief: "the goal sentence, ready to pin somewhere",
        how_to: [
          "Write what the goal is, in one line.",
          "Find the real cost of it, from a quote or a letter, not a guess.",
          "Choose the date you want it by.",
          "Divide the cost by the months until then. That is the monthly number.",
        ],
      },
      {
        id: "fu2",
        title: "Pick the vehicle that fits the goal",
        domain: "goals",
        outcome: "The money goes somewhere built for this goal: a tax-free account, a home subsidy, or the retirement savings you already have.",
        done_when: "the account exists or the application is in",
        tool_choices: ["tfsa_account", "nhfc_first_home_finance", "gotyme_goalsave"],
        knowledge_ids: ["k.tfsa_rules"],
        brief: "Match the goal to one vehicle from the tool rows: a tax-free account for a goal years away, the home subsidy for a first home, a savings pocket for a goal within the year. Say why that one and the catch, from the rows only. Never suggest withdrawing retirement savings for a goal.",
        artifact_brief: null,
      },
      {
        id: "fu3",
        title: "Automate it on payday",
        domain: "goals",
        outcome: "The monthly number moves by itself the day money lands.",
        done_when: "it has moved by itself twice",
        tool_choices: ["gotyme_goalsave", "tfsa_account"],
        knowledge_ids: ["k.payday_first"],
        brief: "Set the amount and the day from their month plan, and say what to do in a month it cannot be afforded: pause, never borrow.",
        artifact_brief: null,
      },
    ],
  },
};

// Only modules whose condition the diagnosis actually met, ranked by how
// directly each serves what the person said they want. No mandatory slots —
// if the diagnosis matched nothing, there is no plan to give (return null
// rather than inventing one).
export function pickPlaybook(
  stage: string,
  signals: Signals | undefined,
  answers: Record<string, string>,
  goals: { label: string; what: string }[],
  /** Module ids to leave out — the module audit uses this to swap in the next-best. */
  exclude: string[] = [],
): Plan | null {
  const sg = signals || {};
  const kinds = splitPicks(String(answers.objective_kind || ""), OBJECTIVE_KIND_OPTIONS);
  const all = Object.values(MODULES);

  const eligible = all.filter((m) => {
    if (exclude.includes(m.id)) return false;
    try {
      return m.needs(sg, answers, goals, stage);
    } catch {
      return false;
    }
  });

  const scored = eligible
    .map((m) => {
      let score = 0;
      if (kinds.some((k) => m.serves.includes(k))) score += 3;
      if (sg.top_problem && m.id === sg.top_problem) score += 4;
      // The money bleeding fastest comes first: a mashonisa, then the owed list.
      if (m.id === "m_shark") score += 3;
      if (m.id === "m_owed") score += 2;
      if (m.id === "m_review" && sg.over_indebted) score += 2;
      return { m, score };
    })
    .sort((a, b) => b.score - a.score);

  const chosen = scored.slice(0, 3).map((x) => x.m);
  if (!chosen.length) return null;

  const why0 =
    chosen[0].id === "m_shark" || chosen[0].id === "m_owed"
      ? "that is the money bleeding fastest, and stopping it costs nothing"
      : chosen[0].id === "m_claim"
        ? "that money is already yours, so it's the fastest money in this plan"
        : sg.problem_in_their_words
          ? (problemPhrase(sg.problem_in_their_words, answers) ?? "that's what's standing between you and what you said you want")
          : "that's what's standing between you and what you said you want";
  const note =
    chosen.length === 1
      ? "Only one part, because only one thing in your answers actually needs fixing. One thing done properly beats three half-done."
      : `First up: ${chosen[0].title.toLowerCase()}, because ${why0}.`;

  return {
    headline: chosen.length === 1 ? `Ninety days on ${chosen[0].title.toLowerCase()}.` : `Ninety days: ${chosen.map((c) => c.title.toLowerCase()).join(", then ")}.`,
    order_note: note,
    workstreams: chosen,
  };
}

/**
 * The tools a library step may name, by the step's own key ("o1", "cu2").
 * The single source for "which tool is this step allowed to use", shared by
 * the plan build and by a later "swap that tool" request, so a swap can only
 * ever land on a tool the fixed method already allows for that step.
 */
export function libraryToolChoices(stepKey: string | null | undefined): string[] {
  return libraryStep(stepKey)?.tool_choices ?? [];
}

/** The fixed library step a stored plan step came from, by its step_key. */
export function libraryStep(stepKey: string | null | undefined): PlaybookStep | null {
  if (!stepKey) return null;
  for (const ws of Object.values(MODULES)) {
    const st = ws.steps.find((x) => x.id === stepKey);
    if (st) return st;
  }
  return null;
}

/**
 * The step's fixed "How to do it" lines, looked up by step_key — so a plan
 * built before the lines existed shows them too, and nothing is migrated.
 * Empty for a step with no key, or a step whose tool walkthrough says it all.
 */
export function libraryHowTo(stepKey: string | null | undefined): string[] {
  return libraryStep(stepKey)?.how_to ?? [];
}
