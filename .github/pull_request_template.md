## What changed, and why

<!-- The why matters more than the what. If this came from a real failure,
     say what failed — that is the comment style the rest of the repo uses. -->

## Which of the twelve CLAUDE.md rules does this touch?

<!-- Name them, or write "none". The twelve rules are in CLAUDE.md and each one
     cost real debugging time. Most relevant here:
       1  plan assembled from the fixed module library, never freestyled
       2  no plan claim the person did not actually make
       3  one recommendation, never a menu
       8  plan document: HTML tables + inline hex only
      10  no invented price, fee, rule or deadline
      11  never recommend credit
      12  never ask for an ID number, account number, card, PIN, OTP or password -->

- [ ] None of the twelve rules are affected by this change.

## Guardrails

- [ ] Does not change guardrail behaviour.
- [ ] Changes guardrail behaviour — what a reviewer should check:

<!-- Retrieval grounding, the safety pass, hardship mode, the
     question-vs-answer gate, staleness hedging. If one of these moved, say
     which, and say how you convinced yourself it still holds. -->

## Database

- [ ] No migration needed.
- [ ] Adds a migration: `db/____`
  - [ ] Safe to re-run on a database that already has it applied.
  - [ ] Does not weaken RLS. Owner data stays reachable only through the
        service role, never through an anon key.

## Model configuration

- [ ] No model slug is hardcoded. Which model does which job still comes from
      the `model_config` table.

## Before requesting review

- [ ] `npm run typecheck` is clean.
- [ ] `npm test` passes.
- [ ] Every relative import in `api/` ends in `.js`.
- [ ] No invented product claims: no testimonials, no user counts, no partner
      logos for partners who have not signed.
