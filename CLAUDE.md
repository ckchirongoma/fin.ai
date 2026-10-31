# Charles — build brief for Claude Code

> **Read `BEHAVIOR-MATRIX.md` first.** It holds the founder's standing
> instructions for how Claude works here, and it is kept up to date every
> round.

*This file is CLAUDE.md at the repo root; Claude Code reads it automatically.
Stop and ask the founder before anything that spends money, before registering
the production WhatsApp number, before Meta verification, and before touching
production data. Everything else: build it.*

---

## What Charles is

A WhatsApp number that knows your money. A person answers twelve questions
about one household's money, hears it read back and confirms it, picks the one
thing to fix first and the one money rule they will live by, and gets a 90-day
money plan as one document. WhatsApp then pushes them through it one step at a
time and comes back to ask whether each step worked. Their own AI (ChatGPT,
Claude) can connect to the same memory.

South Africa first. Built to pitch to GoTyme Bank (`docs/PITCH.md`), whose
customers are the people the research describes: about half of South African
adults not classed as financially literate, 10.5 million credit-active
consumers with impaired records, a third of surveyed borrowers using a
mashonisa. The next market (the Philippines) is a data migration, not a
rewrite.

Charles is built from Charlie, the small-business coach, and keeps its engine,
guardrails, queue, connector and plan document. `docs/superpowers/specs/2026-10-30-charles-design.md`
is the design; `docs/superpowers/plans/2026-10-30-charles-build-plan.md` the build
order and the vocabulary map (business → household, owner → person, customer →
goal, angle → rule, idea/start/run/grow → surviving/stretching/steady/building,
distress → hardship, "forget my business" → "forget my money").

## Build status, as of this commit

- The whole money journey runs end to end in `test/journey.e2e.test.ts`:
  hello → twelve questions → read-back → goal → rule → plan from the fixed
  library → first step → done → outcome. Hardship mode on both doors is pinned
  in `test/guardrails.e2e.test.ts`, `test/distress-trap.e2e.test.ts` and
  `test/ask.test.ts`; the connector in `test/connector-drive.e2e.test.ts`.
- The South African library: 56 knowledge entries and 30 tools in `seed/`,
  every figure sourced in `docs/kb-sources.md`, measured in
  `docs/kb-gap-analysis.md` (main benchmark 72/72, held-out 31/43, depth
  9.5/10 and 9.9/10), loaded by `db/0034`.
- The plan document prints to PDF in Chromium (`scripts/preview-plan.mjs`,
  `scripts/check-plan-print.ts`).
- The landing page, the plan viewer, the web chat and the pitch are built.
- A bank statement (or a payslip, or a credit report) can be sent at any
  point, by choice: Charles reads it once, says the money back from it,
  answers the income question from it, names its payees under "who do you
  owe", lays the month out as three pots, and carries its figures into the
  plan. `test/statement.test.ts` pins all of it, identifiers included.
- Cards (`api/_lib/cards.ts`, `api/card.ts`, `engine/cards.ts`): five small
  pages a person opens from a WhatsApp link and plays with on their phone,
  each sent with its picture: the month in three pots, when a debt is gone,
  the Money Map, what the statement says, getting to a number. Built in code
  from their own figures, no model, no identifier, a hashed link for sixty
  days (`db/0037`), deleted with the household. "Show me my month" draws
  one; a statement, a budget, a progress question and the hand-over send
  one; the connector has `get_card`. `test/cards.test.ts`.
- Two knowledge graphs (`docs/KNOWLEDGE-GRAPH.md`). The library graph
  (`api/_lib/libgraph.ts`) links entries, tools and plan modules in code and
  adds the strongest neighbour to a shortlist without pushing a keyword row
  out. The household graph (`api/_lib/graph.ts`, `db/0038`) remembers what
  each household's money touches, each line with where it came from (they
  said, a setup answer, their statement, their AI) and when; every answer's
  prompt carries it; the memory step and the connector's `record_fact` add
  to it only what the person's words back; "what do you know about me?"
  draws it as the memory card. `test/knowledge-graph.test.ts`.
  It triggers actions (`api/_lib/graphactions.ts`, `db/0039`): a debt paid
  off, a new mashonisa, a repayment up, money to family up, two funeral
  policies, a new stokvel, a new saving habit, each once, after the reply,
  never in hardship mode, every figure the graph's own and every rule a
  button to the grounded answer engine. It is fuzzed
  (`scripts/graphfuzz.ts`, `test/knowledge-graph-fuzz.test.ts`): random
  journeys through the pure graph, growing graphs, and random households
  through the real engine, with every invariant checked after every turn.
- Households (`api/_lib/household.ts`, `engine/household.ts`, `db/0040`):
  two to six WhatsApp numbers share one household. "Invite someone to my
  household" makes a single-use, hashed, 48-hour code; the person who joins
  sees what is shared and taps Join; the inviter taps Let them in. Each keeps
  their own conversation, plan and memory; the others' shared lines (who
  they support, bills, cover, stokvel, savings, goal) reach every answer
  with their first name, never "you told me". Debts and income stay private
  until a person says "share my debts with my household". Anyone can
  "leave household" and nobody is told. `test/household.test.ts`; fuzzed
  by `scripts/householdfuzz.ts` (`test/household-fuzz.test.ts`), with every
  invariant checked after every step.
- Chase Intelligence (`api/_lib/intel.ts`, `db/0041`, `docs/INTEL-CONTRACT.md`):
  every task recorded whole under one trace id, for Chase's own model: every
  message in and out, every model call (everything it was shown, everything
  it said), every guardrail check, every WhatsApp delivery, every call from
  the person's own AI, every job and every product event. Secrets and
  identifiers removed before the write (`intelredact.ts`); never throws or
  waits; `INTEL_CAPTURE` = full | meta | off; "forget my money" deletes it;
  `scripts/intel-export.ts` exports old and new, `scripts/intel-trace.ts`
  reads one task back. The first message now says conversations are kept.
  `test/intel.test.ts`; Phase 0 and owner actions in `docs/INTEL-PHASE0.md`.
- Supabase changes for the founder come as one paste-ready prompt with a
  success-criteria table (`docs/SUPABASE-PROMPT.md`, BEHAVIOR-MATRIX rule 21).
- **Not done, and cannot be from inside a repository:** a fresh Supabase
  project with the migrations run, a Meta test number, and a stranger
  completing the flow on it. `HANDOFF-DEPLOY.md` is the list.
- **No cohort has run.** Nothing anywhere may imply otherwise.

## The knowledge base

Supabase is the source of truth once the founder has created the project and
run `db/` in order; until then `seed/knowledge.json` and `seed/tools.json` are
the library and `db/0034_charles_za_library.sql` is generated from them
(`node scripts/seed-to-sql.mjs > db/0034_charles_za_library.sql`). Never hand-edit
the SQL. Every row has `country`, `domain` (one of the eight money areas),
`stages` (a subset of the four money stages), `keywords`, and `verified_on`.
The `keywords` column is the whole first-pass retrieval: keyword overlap in
plain code, no model call, then a model grounded only in the shortlist.
pgvector is the second pass, used only when the keyword pass finds nothing.

Keep researching to fill gaps, in the same shape, with `verified_on` set
honestly and sources in `docs/kb-sources.md`. The held-out misses in
`docs/kb-gap-analysis.md` are the next round. Never add a keyword for a
held-out phrasing.

## Rules that came from real failures. Do not relearn these.

1. **The plan is assembled from a fixed module library, never freestyled.** Thirteen modules in `api/_lib/playbooks.ts`, each with a `needs()` condition on the diagnostic's signals. The model's only job is picking which modules the diagnosis earned and tailoring their wording.
2. **Nothing in the plan may claim the person said something they didn't.** No "you told me", "the debt you mentioned", unless it is in the answers.
3. **One recommendation, never a menu.** The HBS Kenya field experiment (640 entrepreneurs, three to five suggestions per question): no average effect, the weakest did about 10% worse.
4. **Collaborative, not one-shot.** Three genuinely different goals to choose from, then three rules of thumb against what usually happens instead, then the plan.
5. **The person's money is read back once, confirmed, then reused.** Voice notes mishear ("stokvel" → "stock fell"); the first call produces one identity object the person confirms or corrects.
6. **Retries with backoff on every model call.** Truncated JSON is retried with more output tokens.
7. **Every button is an action, never re-parsed text.** A message that reads as a question is never an answer to an earlier prompt.
8. **The plan document renders with plain HTML tables and inline hex colours.** Never Grid, Flexbox, `var()` or negative-margin bleed. Built like HTML email.
9. **Free and reversible before anything that costs money**, and a hardship mode: if someone cannot cover food, rent or transport, Charles stops planning, protects cash, names the free help (the NCR consumer line, the National Financial Ombud) and keeps a way back.
10. **Never invent a price, fee, rule, deadline or grant amount.** Every figure comes from the library with its `verified_on`; past 90 days it is hedged; where sources differ, the row says so.
11. **Never recommend credit.** No loan, consolidation, buy-now-pay-later, cash advance or overdraft, however cheap. A free, reversible bank product (a savings pocket, an instant payment) may be named; a loan may only be explained, downside first.
12. **Never ask for or store an ID number, account number, card number, PIN, OTP or password.** Said in the first message; refused by the memory step, the connector and the guardrails. A bank statement, payslip or credit report is read only when the person chooses to send one (`api/_lib/statement.ts`): one extraction call told to leave identifiers out, scrubbed again in code, the file never stored, and only the totals and payees kept (`db/0036`). What is said back and the budget are built in code from those figures, never by a model.

## Retrieval and the output schema

Two passes: a deterministic keyword shortlist (no model), then a model call
grounded only in the shortlisted rows, told to say plainly when the shortlist
has nothing. The output schema from every WhatsApp-facing call is fixed and
small (`message`, `artifact`, `next_tap`, `quick_replies`, `tool_id`,
`domain`); small models are far more reliable at a schema they see repeated.

## The doors

- **WhatsApp**, direct Meta Cloud API, not a BSP. Interactive messages within
  Meta's limits (three reply buttons, ten list rows, 20-character labels).
- **The web**: sign in with the WhatsApp number, read the same plan, ask with
  the same guardrails.
- **The connector**: `get_household_context`, `get_money_map`, `get_plan`,
  `get_current_step`, `complete_step`, `skip_step`, `report_outcome`,
  `request_plan_change`, `send_plan_pdf`, `remember`, `forget_note`,
  `flag_hardship`, `find_knowledge`, `log_decision`, `add_commitment`,
  `propose_change`, `get_card`, `record_fact`. A change to a critical fact never silently updates the
  plan: WhatsApp asks first.

## Definition of done for a first pilot-ready version

- RLS on with real policies (`db/0001`), on a fresh Supabase project.
- A real WhatsApp test number where a stranger can complete the whole money
  journey, entirely by chat.
- The plan generated from the fixed library, grounded only in shortlisted
  knowledge, never freestyled; every claim truthful to what was said.
- One full "Send next step" → walkthrough → "Done" → outcome loop end to end.
- The plan document prints correctly from a real browser.
- Every model choice from `model_config`, not hardcoded.
- The web plan viewer shows the same plan WhatsApp generated.
- A landing page with a working link to the test number.

Ask the founder before spending money, before registering the production
WhatsApp number, and before submitting for Meta business verification.
Everything else: build it.
