// Fin — the whole conversation, start to finish, with nothing real behind it.
//
// This is the test that would have caught the failures that actually hurt this
// product: a person stranded on a stage nothing handles, a button dispatching
// nowhere, a plan built twice from one message, a message sent with an empty
// body. None of those are visible from a unit test, because every one of them
// is a wiring failure between modules rather than a bug inside one.
//
// So it drives the real engine — real prompts, real playbooks, real guardrail
// logic — against an in-memory database and a scripted model gateway, and
// walks one household from "hello" to a finished first step.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// env.ts snapshots process.env when it is first imported, so everything has to
// be set before the first dynamic import below.
process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.OPENROUTER_API_KEY = "fake-openrouter-key";
process.env.WHATSAPP_ACCESS_TOKEN = "fake-wa-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";
process.env.WHATSAPP_APP_SECRET = "fake-app-secret";
process.env.WORKER_SECRET = "fake-worker-secret";
process.env.SESSION_SECRET = "fake-session-secret";
process.env.PUBLIC_BASE_URL = "https://fin.test";
// Left unset on purpose: with no Jev key the guardrails must fall through to
// the model backstop, which is the configuration most deployments will run.
delete process.env.TYPESAFE_API_KEY;

import { drainJobs, installFakeNet, makeFakeDb, tapFrom, textFrom, type FakeNet, type FakeDb } from "./_fakes.ts";

const OWNER = "27809930001";

const knowledge = JSON.parse(readFileSync(new URL("../seed/knowledge.json", import.meta.url), "utf8"));
const tools = JSON.parse(readFileSync(new URL("../seed/tools.json", import.meta.url), "utf8"));

const MODEL_ROLES = ["router", "wa_reply", "help", "voice", "plan_builder", "safety"].map((role) => ({
  role,
  provider: "openrouter",
  model: `test/${role}`,
  fallbacks: [],
  params: { max_tokens: 900 },
  enabled: true,
}));

let db: FakeDb;
let net: FakeNet;
let engine: typeof import("../api/_lib/engine/index.ts");
let dbmod: typeof import("../api/_lib/db.ts");
let restoreDb: () => void;

/** Everything the scripted gateway needs to answer, keyed on the real prompts. */
function scriptModels(n: FakeNet): void {
  n.onModel(/THREE genuinely different 90-day goals|Read this person's money back to them/, () => ({
    identity: { name: "Lerato", earns: "domestic work three days a week and two child support grants", one_liner: "Domestic work and two grants, two children, a mashonisa on the grant money", unsure: null },
    stage: "surviving",
    signals: { owes_any: true, owes_mashonisa: true, owes_two_plus: true, month_short: true, dont_know_where: true, no_cushion: true, grant_income: true, records_weak: true, problem_in_their_words: "the mashonisa takes R200 every week", top_problem: "m_shark" },
    objective_read: "Pay the mashonisa's R800 down and put R1,000 away by Christmas.",
    reflection: "Three days of work and two grants, with R200 a week going to the mashonisa: surviving, and the month runs out around the 24th.",
    // Live test, 2026-09-25: the model's pick names its own id letter.
    recommend: "Start with a — it is the most expensive rand in your month.",
    options: [
      { id: "a", label: "Out of the mashonisa's book", what: "Pay the R800 down on a fixed day and never borrow it again", why_you: "R200 a week on R800 is the dearest money you have", worth: "R200 a week back in your hands", first_move: "Write down the day the next payment is due", catch: "The first two weeks are the tightest" },
      { id: "b", label: "The month without borrowing", what: "Get to the 30th without a new loan from anyone", why_you: "The month runs out around the 24th", worth: "No figure given", first_move: "Write down one week of spending", catch: "It needs the three pots on payday" },
      { id: "c", label: "R1,000 by Christmas", what: "R1,000 in a place the month cannot reach by December", why_you: "You named it", worth: "R1,000", first_move: "Open a named savings pocket", catch: "Nothing goes in while the mashonisa is paid" },
      { id: "d", label: "Fix the credit record", what: "Check the free report", why_you: "The clothing account is on record", worth: "No figure given", first_move: "Request the free report", catch: "Slow" },
    ],
  }));

  n.onModel(/THREE different money rules/, () => ({
    alternatives: [
      { name: "Borrowing again from the mashonisa", why_people_do_it: "It is quick and close", where_it_leaves_them: "Paying R200 a week to stand still" },
      { name: "Skipping the clothing account", why_people_do_it: "Nobody knocks straight away", where_it_leaves_them: "Listed, and the fees grow" },
      { name: "Asking family", why_people_do_it: "No interest", where_it_leaves_them: "Owing the people who depend on you" },
    ],
    recommend: "Payday first, every Friday.",
    options: [
      { label: "Payday first", rule: "The moment money lands, the fixed things get paid before anything else is bought.", why_it_works: "What you pay first is what gets paid.", what_it_costs_you: "The first Friday feels poorer." },
      { label: "Nothing new borrowed", rule: "I borrow nothing from anyone for 90 days, however small.", why_it_works: "No new R200 a week can start.", what_it_costs_you: "A short week stays short." },
      { label: "Every rand written", rule: "Every rand that leaves my hand is written down the same day.", why_it_works: "You said you don't know where it goes.", what_it_costs_you: "Thirty seconds, every time." },
    ],
  }));

  n.onModel(/AREA RUBRIC/, () => ({
    context: {
      name: "Lerato", earns: "domestic work three days a week and two child support grants", location: "Diepsloot, Johannesburg",
      depends: "two children", income: "about R4,800 a month", owes: "a mashonisa (R800) and a clothing account",
      cushion: "nothing", cover: "a burial society", records: "in my head",
      goal: "Pay the mashonisa off and keep the R200 a week", headache: "the mashonisa takes R200 every week",
      one_liner: "Domestic work and two grants, paying the mashonisa first until it is gone",
    },
    goal: "Pay the R800 mashonisa off by day 60 and put the first R200 a week into a named pocket after that.",
    map: [
      { domain: "income", status: "amber", note: "Cash on Fridays and two grants, no payslip" },
      { domain: "spending", status: "red", note: "Nothing written; month runs out on the 24th" },
      { domain: "debt", status: "red", note: "A mashonisa and a clothing account" },
      { domain: "cushion", status: "red", note: "Nothing put away" },
      { domain: "credit_record", status: "amber", note: "The clothing account is on record" },
      { domain: "protection", status: "amber", note: "A burial society, children not named" },
      { domain: "family_money", status: "amber", note: "Mother helped some months" },
      { domain: "goals", status: "red", note: "R1,000 named, nowhere to put it" },
    ],
  }));

  // The workstream tailoring call has to echo back exactly the step ids it was
  // given — that constraint is the whole point of the fixed library.
  n.onModel(/You are writing the person-facing wording for ONE part/, (prompt) => {
    const ids = [...prompt.matchAll(/id=([a-z0-9_]+)/g)].map((m) => m[1]);
    return {
      why_for_you: "This is the fastest cash in your plan.",
      steps: ids.map((id) => ({
        id,
        title: "ignored — the library title wins",
        why_for_you: "It serves getting out of the mashonisa's book directly.",
        push: `Do the thing for step ${id}. It costs you nothing. Start this evening.`,
        artifact: `Ready-to-send words for ${id}.`,
        tool_id: null,
      })),
    };
  });

  n.onModel(/You are writing the STRATEGY part of a money plan/, () => ({
    reading: [
      "Three days of work and two grants, every month, so the money comes in — the income is not the problem.",
      "The leak is R200 a week to the mashonisa on R800, and a month with no shape until it is gone.",
    ],
    working: ["Regular work, three days every week", "The grants land on a date you know"],
    leaking: ["R200 a week to the mashonisa", "The month running out around the 24th"],
    how_we_win: "Pay the fixed things the moment money lands, so the mashonisa is paid down on a day and never needed again.",
    wont_do: ["No new borrowing of any kind for 90 days"],
    money_logic: "R200 a week is about R800 a month on your own figures; once the mashonisa is gone that is the R1,000 by Christmas.",
    milestones: { d30: "Two mashonisa payments made on the day", d60: "The mashonisa paid off and the card back", d90: "R200 a week going to the named pocket" },
    risks: [{ risk: "A short month, and the mashonisa is the quick fix", response: "The three pots show what is left before the week starts." }],
  }));

  n.onModel(/You are scoring one household's money life against a fixed rubric/, () => ({
    income: "amber", spending: "red", debt: "red", cushion: "red",
    credit_record: "amber", protection: "amber", family_money: "amber", goals: "red",
  }));

  // The guardrail backstop: nothing flagged, so any flag in a test is real.
  n.onModel(/You are a strict checker/, (prompt) => {
    const ids = [...prompt.matchAll(/- "([a-z_]+)":/g)].map((m) => m[1]!);
    return Object.fromEntries(ids.map((id) => [id, false]));
  });

  n.onModel(/Classify this message from a person to their money assistant/, () => ({
    intent: "question", domain: "debt", tool_need: null, missing_fact: null, risk: [], search_terms: "mashonisa card rights",
  }));

  n.onModel(/ROUTER RESULT/, () => ({
    message: "Pay the R200 on Friday, the day the cash lands, and ask for the card back the day the last payment is made. It costs you nothing and it is the one thing that stops the R200 a week.",
    artifact: "I have paid R200 today. Please write it in your book and show me what is left.",
    next_tap: null, quick_replies: ["What if they refuse?"], tool_id: null, domain: "debt",
  }));

  n.onModel(/You maintain one person's money memory/, () => ({
    context_updates: null, map_updates: null, decisions: null, commitments: null, results: null,
  }));

  n.onModel(/The person is stuck on one step/, () => ({
    message: "Most people stall on reading the rules. Open the NCR page, read the three lines about what a lender may not do, and save the number — that is the whole job.",
    artifact: null, next_tap: null, quick_replies: [], tool_id: null, domain: "debt",
  }));
}

before(async () => {
  net = installFakeNet();
  scriptModels(net);
  db = makeFakeDb({ model_config: MODEL_ROLES, knowledge_entries: knowledge, tools });
  dbmod = await import("../api/_lib/db.ts");
  restoreDb = dbmod.__setClient(db.client);
  const models = await import("../api/_lib/models.ts");
  models.__clearModelCache();
  engine = await import("../api/_lib/engine/index.ts");
});

after(() => {
  restoreDb?.();
  net?.restore();
});

beforeEach(() => {
  net.sent.length = 0;
});

const lastButtons = () => [...net.sent].reverse().find((m) => m.buttons.length)?.buttons ?? [];
const allText = () => net.sent.map((m) => m.body).join("\n---\n");
const business = () => db.tables.businesses![0]!;

test("a first message is a greeting, not an answer to a question nobody asked", async () => {
  await engine.handleInbound(textFrom(OWNER, "hi"));

  assert.equal(db.tables.businesses!.length, 1);
  assert.equal(business().stage, "diag");
  assert.equal(business().diag_step, 0);
  // ONE message, in the order a person says it: hello and who Fin is,
  // then the consent line, then question one. The consent line used to go
  // out first, on its own, before Fin had said hello (founder, 2026-10).
  assert.equal(net.sent.length, 1, "one message, not a disclaimer and then a hello");
  const first = net.sent[0]!.body;
  assert.match(first, /^Hi, I'm Fin\./);
  assert.ok(first.indexOf("Hi, I'm Fin") < first.indexOf("forget my money"), "hello before the consent line");
  assert.ok(first.indexOf("forget my money") < first.indexOf("what should I call you"), "consent before question one");
  // Rule 12, said out loud before a single answer is given.
  assert.match(first, /never ask for your ID number, account number, card, PIN or password/);
  // Nothing was stored as an answer.
  assert.deepEqual(business().answers, {});
});

test("a question asked mid-diagnostic is answered as a question, never stored as the answer", async () => {
  const before = { ...business().answers };
  await engine.handleInbound(textFrom(OWNER, "what does a garnishee even mean?"));

  assert.deepEqual(business().answers, before, "the question must not be recorded as an answer");
  assert.equal(business().diag_step, 0, "and the diagnostic must not advance");
  assert.match(allText(), /Good question/i);
  // CLAUDE.md rule 7. It had no enforcement anywhere before this.
});

/** Lerato's twelve answers, in the order Fin asks: fixed-option questions by number, the rest in her words. */
export const LERATO = [
  "Lerato, I do domestic work three days a week and get two child grants",
  "2",
  "Diepsloot, Johannesburg",
  "Pay off the mashonisa, R200 a week on R800, and put R1,000 away by Christmas",
  "1, 2",
  "3, 4",
  "3",
  "About R4,800 a month",
  "2, 4",
  "1",
  "2",
  "1",
];

test("the diagnostic runs to the end and then builds the read-back, goals, rule and the plan", async () => {
  for (const a of LERATO) await engine.handleInbound(textFrom(OWNER, a));

  const biz = business();
  assert.equal(biz.stage, "confirm_identity", "the person confirms the read-back before anything is built on it");
  assert.equal(Object.keys(biz.answers).length, 12);
  assert.equal(biz.identity.name, "Lerato");
  assert.equal(biz.biz_stage, "surviving");

  // Multi-select answers are stored as the option labels, not as raw digits.
  assert.match(biz.answers.blockers, /The month is longer than the money/);
  assert.match(biz.answers.blockers, /A mashonisa or loan shark/);
  assert.match(biz.answers.owes, /A clothing or furniture account/);
  assert.match(biz.answers.owes, /A mashonisa/);
  assert.equal(biz.answers.income_kind, "Piece jobs or hustle");
  // Rule 12: nothing that looks like an ID, account or card number was asked for.
  assert.doesNotMatch(allText(), /ID number\?|account number\?|card number\?|your PIN/);

  const buttons = lastButtons();
  assert.deepEqual(buttons.map((b) => b.id), ["a.id.ok", "a.id.fix"]);
});

test("confirming the read-back offers three goal cards, never more, each with all five fields labelled", async () => {
  // The goal options are a queue job of their own since the read-back
  // split (engine/build.ts, 2026-09-25). Draining it first means the tap
  // finds the options already stored (the common case in production).
  await drainJobs();
  await engine.handleInbound(tapFrom(OWNER, "a.id.ok", "That's right"));

  assert.equal(business().stage, "choose_goal");
  const text = allText();
  for (const label of ["Out of the mashonisa's book", "The month without borrowing", "R1,000 by Christmas"]) {
    assert.match(text, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  // Founder, 2026-09-24: four cards was too much to read, so a fourth option
  // from the model is dropped. Three cards, all five fields under plain
  // labels, the pick first.
  assert.doesNotMatch(text, /Fix the credit record/);
  assert.equal(business().pending_goal_options.options.length, 3);
  // Live test, 2026-09-25: the pick showed an internal id ("c") instead of
  // the number on the card. The person sees the displayed number and the label.
  assert.match(text, /My pick: Start with 1 \(Out of the mashonisa's book\) — it is the most expensive rand in your month\./);
  assert.doesNotMatch(text, /Start with a —/);
  assert.match(text, /You know your month better than I do/);
  // Say up front that the focus is deliberate and not forever.
  assert.match(text, /A 90-day plan works best aimed at one thing, so we start there — it's not forever\. Once that's steady, you can change the plan or add more\./);
  assert.ok(text.indexOf("My pick") < text.indexOf("1. Out of the mashonisa's book"), "the pick comes first");
  const cards = text.slice(text.indexOf("1. Out of the mashonisa's book"), text.indexOf("Reply with the numbers")).trim().split("\n\n");
  assert.equal(cards.length, 3);
  for (const c of cards) {
    assert.equal(c.split("\n").length, 6, c);
    assert.match(c, /\nWhat it is: .+\nWhy it fits you: .+\nWhat it's worth: .+\nFirst move this week: .+\nThe catch: .+$/, c);
  }
  // Rule 11: no goal card recommends borrowing.
  assert.doesNotMatch(text, /take (?:a|out a) loan|consolidat/i);
});

test("picking more than one goal is respected, and the rule step follows", async () => {
  await engine.handleInbound(textFrom(OWNER, "1 and 2"));

  const biz = business();
  assert.equal(biz.goal.length, 2, "multi-select means multi-select");
  assert.equal(biz.goal[0].label, "Out of the mashonisa's book");
  assert.equal(biz.goal[1].label, "The month without borrowing");
  assert.equal(biz.stage, "choose_rule");
  // What usually happens instead is shown without judgement, and the rule
  // step says one thing about how many to pick.
  assert.match(allText(), /What usually happens instead, for someone in your spot:\n• Borrowing again from the mashonisa — It is quick and close\. Where it leaves you: Paying R200 a week to stand still\./);
  assert.match(allText(), /Two numbers only if you can truly keep both/);
  // The rule pick is normalised the same way as the goal pick.
  assert.match(allText(), /My pick: Start with 1 \(Payday first\)/);
});

test("choosing the rule builds a plan from the fixed library and never invents structure", async () => {
  const from = net.sent.length;
  await engine.handleInbound(textFrom(OWNER, "1"));
  // Choosing the angle only starts the build now — see engine/planbuild.ts —
  // the same way a real webhook call would, one short job per phase.
  await drainJobs();

  // Founder, 2026-09-24: one honest message when the line is chosen, then
  // nothing until the plan itself — no "Won't be long" in between.
  const after = net.sent.slice(from).filter((m) => m.to === OWNER).map((m) => m.body);
  assert.match(after[0]!, /^That's your rule, then:\n\n"The moment money lands, the fixed things get paid before anything else is bought\."/);
  assert.match(after[0]!, /Now I'm writing your full 90-day money plan\. It takes a few minutes\. I'll send it here the moment it's ready/);
  assert.match(after[1]!, /^Your 90-day money plan is ready\./, `the next message is the plan itself, got: ${after[1]}`);
  assert.match(after[1]!, /The full document is right below\.$/);
  assert.ok(!after.some((b) => /Won't be long|^Right\. |Sending the whole thing/.test(b)));
  assert.ok(after.some((b) => /It's focused on one thing on purpose: .+ Get that steady first — after that, we can change the plan or add other things\./.test(b)), "the hand-over frames the focus");

  // The read-back left its own timing row, model calls included (eta.ts reads
  // these). Since the split (2026-09-25) it covers the read-back call only —
  // what the owner actually waits for — and the options call has its own row.
  const rb = db.tables.safety_events!.filter((e) => e.check_name === "readback_timing");
  assert.equal(rb.length, 1);
  assert.match(rb[0]!.detail, /^total \d+\.\ds; sent; models: .*build:readback=/);
  assert.doesNotMatch(rb[0]!.detail, /build:goal=/, "the options call is not part of what the person waited for");
  const ot = db.tables.safety_events!.filter((e) => e.check_name === "goal_options_timing");
  assert.equal(ot.length, 1);
  assert.match(ot[0]!.detail, /^total \d+\.\ds; stored; models: .*build:goal=/);

  const biz = business();
  assert.equal(biz.stage, "plan_ready");
  assert.equal(biz.rule.length, 1);

  const plan = db.tables.plans![0]!;
  assert.ok(plan, "a plan row was written");
  const steps = db.tables.plan_steps!.filter((s) => s.plan_id === plan.id);
  assert.ok(steps.length >= 3, `expected a real plan, got ${steps.length} steps`);

  // Every stored step must come from the library, not from the model. The
  // scripted model deliberately returned a bogus title for each step.
  for (const s of steps) {
    assert.notEqual(s.title, "ignored — the library title wins");
    assert.ok(s.step_key, "each step keeps its library id");
    assert.equal(s.status, "open");
  }

  // Signals said owes_mashonisa, and top_problem was m_shark, so getting out
  // of the mashonisa's book has to lead: the money bleeding fastest, first.
  assert.match(steps[0]!.workstream_title, /mashonisa/i);
  // Rule 11, mechanically: no step of the fixed library recommends credit.
  for (const s of steps) assert.doesNotMatch(`${s.title} ${s.push ?? ""}`, /take (?:a|out a) loan|consolidation loan|credit card|overdraft/i);

  // At most three parts. A plan is a plan because it is short.
  assert.ok(new Set(steps.map((s) => s.workstream_title)).size <= 3);

  // And it is offered as a first step, not left as a document.
  assert.ok(lastButtons().map((b) => b.id).includes("a.step.next"), "there has to be a way to actually start");

  // The map was written to its own table, which is what the connector and any
  // sponsor reporting read from.
  assert.equal(db.tables.business_map!.length, 8);

  // The strategy — the narrative two-thirds of the document — is stored with
  // the plan, so the PDF, the website and the owner's own AI all read the
  // same one. And it went through the guardrails like everything else.
  const strategy = db.tables.plans![0]!.strategy;
  assert.ok(strategy, "the plan carries its strategy");
  assert.ok(strategy.reading.length >= 2);
  assert.match(strategy.money_logic, /R200/);
  assert.ok(db.tables.safety_events!.some((e) => e.check_name === "strategy_compliance"), "the strategy was checked before it was stored");

  // The guardrail ran on every generated step, on the model backstop, and said so.
  const checks = db.tables.safety_events!.filter((e) => e.check_name === "step_compliance");
  assert.equal(checks.length, steps.length);
  assert.ok(checks.every((c) => c.engine === "model"), "with no Jev key, the model backstop must run — not nothing");
});

test("the step-push loop: next step, walkthrough, done, and did it work", async () => {
  await engine.handleInbound(tapFrom(OWNER, "a.step.next", "First step"));

  let biz = business();
  assert.equal(biz.stage, "step_pushed");
  assert.ok(biz.pending_action?.step_id, "the engine remembers which step it is waiting on");
  assert.match(allText(), /Step 1 of/);
  assert.match(allText(), /Done when:/);

  // A pushed step becomes a commitment, which is what the follow-up works from.
  assert.equal(db.tables.commitments!.filter((c) => c.status === "open").length, 1);

  // Getting stuck must produce help about THIS step, not a generic answer.
  net.sent.length = 0;
  await engine.handleInbound(tapFrom(OWNER, "a.step.help", "I'm stuck"));
  assert.match(allText(), /read the three lines about what a lender may not do/);

  // Done → the outcome question. This is the loop the Kenya mentor never closed.
  net.sent.length = 0;
  await engine.handleInbound(tapFrom(OWNER, "a.step.done", "Done"));
  biz = business();
  assert.equal(biz.stage, "outcome_wait");
  assert.match(allText(), /made any difference/i);
  // Each outcome button carries the step it is about, so an old one can never be applied to a later step.
  assert.deepEqual(lastButtons().map((b) => b.id.split(":")[0]), ["a.out.better", "a.out.early", "a.out.none"]);
  assert.ok(lastButtons().every((b) => b.id.split(":")[1] === db.tables.plan_steps!.find((s) => s.status === "done")!.id), "and the step id is the one just done");

  const doneStep = db.tables.plan_steps!.find((s) => s.status === "done");
  assert.ok(doneStep, "the step is marked done");
  assert.equal(db.tables.commitments!.filter((c) => c.status === "done").length, 1);

  // Reporting an improvement moves a red map area up — and only then.
  net.sent.length = 0;
  await engine.handleInbound(tapFrom(OWNER, "a.out.better", "Yes, already"));
  biz = business();
  assert.equal(biz.stage, "plan_ready");
  assert.equal(db.tables.outcomes!.length, 1);
  assert.equal(db.tables.outcomes![0]!.effect, "better");

  const moved = biz.map.find((m: any) => m.domain === doneStep!.domain);
  if (doneStep!.domain) assert.notEqual(moved.status, "red", "a completed step that worked moves the area off red");
});

test("an ordinary question after the plan gets one grounded recommendation", async () => {
  await engine.handleInbound(textFrom(OWNER, "can the mashonisa keep my card until I pay?"));

  assert.match(allText(), /ask for the card back/);
  const reply = db.tables.safety_events!.filter((e) => e.check_name === "reply_compliance");
  assert.ok(reply.length >= 1, "live replies are checked too, not just plan steps");
});

test("forget my money asks for a fresh YES before it deletes anything", async () => {
  // Incident, 2026-09-21: an old "forget my money", replayed hours late
  // from behind a stuck per-person lock, deleted a real row well after
  // the person had moved on and answered several more questions. A single
  // message — however fresh — must never be enough on its own for something
  // this irreversible.
  const id = business().id;
  net.sent.length = 0;
  await engine.handleInbound(textFrom(OWNER, "forget my money"));

  assert.equal(db.tables.businesses!.filter((b) => b.id === id).length, 1, "nothing is deleted yet");
  assert.match(allText(), /reply yes/i);
  assert.equal(business().pending_action?.kind, "confirm_forget");
});

test("anything other than YES cancels the forget and changes nothing", async () => {
  const id = business().id;
  net.sent.length = 0;
  await engine.handleInbound(textFrom(OWNER, "actually no"));

  assert.equal(db.tables.businesses!.filter((b) => b.id === id).length, 1, "still there");
  assert.equal(business().pending_action, null);
  assert.match(allText(), /nothing's changed/i);
});

test("forget my money, confirmed with YES, deletes it in any stage and says so", async () => {
  await engine.handleInbound(textFrom(OWNER, "forget my money"));
  const id = business().id;
  net.sent.length = 0;
  await engine.handleInbound(textFrom(OWNER, "YES"));

  // A real deletion, not a flag. `wa_id` is UNIQUE, so anything that leaves the
  // row behind leaves the person's number permanently taken and they can never
  // come back — and the promise made to them was that it would all be gone.
  assert.equal(db.tables.businesses!.filter((b) => b.id === id).length, 0, "the household row is gone");
  assert.equal(db.tables.messages!.length, 0, "the message log goes with it");
  assert.equal(db.tables.plans!.filter((p) => p.business_id === id).length, 0, "and the plan");
  assert.equal(db.tables.plan_steps!.length, 0, "and every step of it");
  assert.equal(db.tables.commitments!.filter((c) => c.business_id === id).length, 0);
  assert.equal(db.tables.business_map!.filter((m) => m.business_id === id).length, 0);
  assert.match(allText(), /deleted/i);

  // A count survives, with nothing in it that could identify anyone.
  assert.equal(db.tables.forget_log!.length, 1);
  assert.equal(JSON.stringify(db.tables.forget_log![0]).includes(OWNER), false);
});

test("a person who changes their mind can come straight back", async () => {
  // This is the half that the previous soft delete made impossible: the number
  // stayed taken, so creating the row failed on a unique constraint the
  // person could neither see nor clear.
  net.sent.length = 0;
  await engine.handleInbound(textFrom(OWNER, "hello again"));

  assert.equal(db.tables.businesses!.length, 1, "a fresh row, on the same number");
  assert.equal(business().stage, "diag");
  assert.equal(business().diag_step, 0);
  assert.match(allText(), /forget my money/i, "and the consent line is shown again");
});

test("no message is ever sent with an empty body", () => {
  // Cheap, and it catches the class of bug where a template string quietly
  // resolves to nothing and the person receives a blank bubble.
  for (const m of net.sent) {
    if (m.type === "text" || m.type === "interactive") {
      assert.ok(m.body.trim().length > 0, `empty ${m.type} message: ${JSON.stringify(m.raw).slice(0, 200)}`);
    }
  }
});

// ── Taps that arrive out of time ─────────────────────────────────
//
// WhatsApp keeps every old message tappable forever. Both of these were real
// bugs: the first re-ran the whole plan build (several expensive model calls
// and a bewildering second plan), and the second sent nothing at all.

test("a diagnostic button tapped long after the plan exists does not rebuild anything", async () => {
  // Rebuild a household, since the previous test deleted this one.
  await engine.handleInbound(textFrom(OWNER, "hi"));
  for (const a of LERATO) await engine.handleInbound(textFrom(OWNER, a));
  // The goal options are a queue job of their own since the read-back
  // split (engine/build.ts, 2026-09-25). Draining it first means the tap
  // finds the options already stored (the common case in production).
  await drainJobs();
  await engine.handleInbound(tapFrom(OWNER, "a.id.ok", "That's right"));
  await engine.handleInbound(textFrom(OWNER, "1"));
  await engine.handleInbound(textFrom(OWNER, "1"));
  await drainJobs();
  assert.equal(business().stage, "plan_ready");

  const plansBefore = db.tables.plans!.length;
  const callsBefore = net.modelCalls.length;
  net.sent.length = 0;

  // A tap on question two of the onboarding, weeks later.
  await engine.handleInbound(tapFrom(OWNER, "d.1.0", "Salary or wage"));

  assert.equal(db.tables.plans!.length, plansBefore, "no second plan");
  assert.equal(net.modelCalls.length, callsBefore, "and not a single model call spent");
  assert.equal(business().stage, "plan_ready");
  assert.match(allText(), /well past it/i);
  assert.ok(net.sent.length > 0, "and the person still hears something back");
});

test("confirming a change that is no longer pending says so instead of going quiet", async () => {
  net.sent.length = 0;
  await engine.handleInbound(tapFrom(OWNER, "a.chg.yes", "Yes, update it"));

  assert.ok(net.sent.length > 0, "silence is indistinguishable from being broken");
  assert.match(allText(), /nothing waiting/i);
  assert.equal(business().stage, "plan_ready");
});
