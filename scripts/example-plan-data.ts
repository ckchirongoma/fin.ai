// Charles — one example household's plan, for the landing page and the print check.
//
// The landing page shows the REAL plan template, filled in for an example
// household and captioned as one. Every tool cost is read from
// seed/tools.json, never typed in here (rule 10); a tool the seed does not
// carry yet renders with no cost line rather than an invented one. The
// household is invented and says so; nothing in it is a real person.
import { readFileSync } from "node:fs";
import type { PlanDocData } from "../api/_lib/plandoc.ts";

const tools = JSON.parse(readFileSync(new URL("../seed/tools.json", import.meta.url), "utf8")).filter((t: any) => t.country === "ZA");
export const T = (id: string, why: string): PlanDocData["tools"][string] => {
  const t = tools.find((x: any) => x.id === id);
  return { id, name: t?.name ?? id.replace(/_/g, " "), url: t?.url ?? "", why, cost: t?.cost ?? "", verified_on: t?.verified_on ?? null, free_type: t?.free_type ?? null, walkthrough: t?.walkthrough ?? null };
};
export const step = (id: string, domain: string, title: string, push: string, done_when: string, tool_id: string | null, artifact: string | null, why_for_you: string) =>
  ({ id, title, domain, outcome: "", done_when, brief: "", artifact_brief: null, tool_choices: tool_id ? [tool_id] : [], push, artifact, why_for_you, tool_id });

export const EXAMPLE_PLAN: PlanDocData = {
  productName: "Charles",
  countryCode: "ZA",
  ctx: {
    name: "Lerato",
    one_liner: "Domestic work three days a week in Fourways, two child support grants, two children at home in Diepsloot.",
    location: "Diepsloot, Johannesburg",
    goal: "Pay off the mashonisa and have R1,000 put away by Christmas.",
    earns: "Domestic work, three days a week, paid in cash on Fridays; two child support grants on the SASSA card",
    depends: "Two children (9 and 4) and her mother some months",
    income: "About R4,800 a month, most months",
    owes: "A mashonisa (R800, R200 a week on it) and a clothing account (R1,350)",
    cushion: "Nothing put away; the month runs out around the 24th",
    cover: "A burial society, R60 a month",
    records: "In my head, and the SMSes from the bank",
  },
  stage: "surviving",
  objectiveRead: "Stop the mashonisa eating the grant money every week, then put the first R1,000 somewhere the month cannot reach it.",
  goal: [
    {
      label: "Out of the mashonisa's book",
      what: "Pay the R800 down on a fixed day and never borrow it again",
      why_you: "R200 a week on R800 is the most expensive money in your month, and it is the one debt that resets every time the grant lands",
      worth: "R200 a week back in your hands once it is gone — you gave that figure, not me",
      first_move: "Write down the day the next payment is due and what is left after it",
      catch: "The first two weeks are the tightest, before the R200 stops going out",
    },
  ],
  rule: [{ rule: "Payday first: the fixed things get paid the moment money lands, before anything else is bought.", why_it_works: "What you pay first is what gets paid. Everything after that is what is left, and you can see it.", what_it_costs_you: "The first Friday feels poorer, because the money that used to be spent by Tuesday is gone on Friday." }],
  alternatives: [{ name: "Borrowing again when the month runs short", why_people_do_it: "It is quick, it is close, and nobody asks questions", where_it_leaves_them: "Paying R200 a week to stand still, with the card held as security" }],
  map: [
    { domain: "income", status: "amber", note: "Cash on Fridays and the grants on the SASSA card; no payslip, so some months are shorter" },
    { domain: "spending", status: "red", note: "Nothing written down; the month runs out around the 24th" },
    { domain: "debt", status: "red", note: "A mashonisa at R200 a week on R800, plus a clothing account" },
    { domain: "cushion", status: "red", note: "Nothing put away" },
    { domain: "credit_record", status: "amber", note: "The clothing account is on record; nothing checked yet" },
    { domain: "protection", status: "amber", note: "A burial society; no funeral policy, and the children are not named anywhere" },
    { domain: "family_money", status: "amber", note: "Her mother is helped some months; no line agreed" },
    { domain: "goals", status: "red", note: "Christmas and R1,000 named, nowhere to put it yet" },
  ],
  plan: {
    headline: "Ninety days on getting out of the mashonisa's book, then a cushion the month cannot reach.",
    order_note: "The mashonisa first: it is the most expensive rand in the month and the one that undoes everything else.",
    goal: "The mashonisa paid off, the R200 a week staying in your hands, and R1,000 in a place the month cannot reach by Christmas.",
    workstreams: [
      {
        id: "m_shark", title: "Get out of the mashonisa's book", domain: "debt", why: "", why_for_you: "You said R200 a week goes to the mashonisa on R800 owed.", steps: [
          step("sh1", "debt", "Know what a mashonisa can and cannot do to you", "Read the rules once, and save the NCR consumer line in your phone before the next payment is due.", "you have read the rules and saved the number", "ncr_complaint", null, "An unregistered lender cannot keep your card or ID, and cannot take you to court for the interest."),
          step("sh2", "debt", "Set the pay-down, and stop the re-borrowing", "Pay the R200 on Friday, the day the cash lands, and put the receipt in one place.", "two payments have gone on the day you said", "notes_money_log", null, "Paying on the day the money lands is your rule, applied to the debt that costs the most."),
          step("sh3", "debt", "Get your card and ID back, and keep them", "Ask for the card back on the day the last payment is made, and change the PIN that day.", "everything is back in your hands and the PIN is changed", "saps_case", null, "Holding your card is not allowed; once the debt is paid there is no reason left for it."),
        ],
      },
      {
        id: "m_month", title: "Make the month fit the money", domain: "spending", why: "", why_for_you: "You said the month runs out around the 24th.", steps: [
          step("mo1", "spending", "Write down one week of spending, every rand", "For seven days, every rand that leaves your hands goes in the notes app, in the moment.", "seven days are written down", "notes_money_log", null, "You cannot fix a leak you cannot see, and one week is enough to see it."),
          step("mo2", "spending", "Split the money into three pots on payday", "Fixed things, food and transport, and what is left, in that order, the day the money lands.", "the three amounts are written for next month", "sheets_budget", null, "Three pots is the whole budget; nothing more detailed survives a real month."),
        ],
      },
      {
        id: "m_cushion", title: "Build a cushion you can reach", domain: "cushion", why: "", why_for_you: "Once the R200 a week stops going out, it needs somewhere to go.", steps: [
          step("cu1", "cushion", "Open the savings pocket and name it", "Open a savings pocket in the banking app and name it for Christmas, so the money has a job.", "the pocket exists with a name", "gotyme_goalsave", null, "A named pot is harder to raid than a balance."),
          step("cu2", "cushion", "Move the first R200 the week the mashonisa is paid off", "The week the last R200 goes to the mashonisa, the next R200 goes to the pocket instead.", "the first transfer has gone", "gotyme_goalsave", null, "The money is already leaving your hands every Friday; it just changes direction."),
        ],
      },
    ] as never,
  },
  strategy: {
    reading: ["The money comes in. What costs you the month is the R200 a week that goes out to stand still, and the month having no shape until it is gone."],
    working: ["Regular work, three days every week", "The grants land on a date you know", "A burial society already paid"],
    leaking: ["R200 a week to the mashonisa", "The month running out around the 24th"],
    how_we_win: "By paying the fixed things the moment money lands, so the mashonisa is paid down on a day and never needed again.",
    wont_do: ["No new borrowing of any kind, not a card, not a store account, not a loan app"],
    money_logic: "R200 a week is about R800 a month. Once the mashonisa is gone, that is the R1,000 by Christmas, with weeks to spare — on your own figures.",
    milestones: { d30: "Two mashonisa payments made on the day, one week of spending written down.", d60: "The mashonisa paid off, the card back, the three pots set.", d90: "R200 a week going to the named pocket; R1,000 by Christmas on track." },
    risks: [{ risk: "A short month, and the mashonisa is the quick fix", response: "The three pots show what is left before the week starts; the family line is the next part of the plan." }],
  },
  tools: {
    ncr_complaint: T("ncr_complaint", "The regulator's free consumer line, for what a lender may and may not do"),
    notes_money_log: T("notes_money_log", "A money log on the phone you already have"),
    saps_case: T("saps_case", "Where to go if the card or ID is not given back"),
    sheets_budget: T("sheets_budget", "The three pots, written once a month"),
    gotyme_goalsave: T("gotyme_goalsave", "A named savings pocket inside the banking app"),
  },
  planUrl: "https://charles.example/plan",
};
