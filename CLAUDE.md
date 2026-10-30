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
12. **Never ask for or store an ID number, account number, card number, PIN, OTP or password.** Said in the first message; refused by the memory step, the connector and the guardrails.

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
  `propose_change`. A change to a critical fact never silently updates the
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
