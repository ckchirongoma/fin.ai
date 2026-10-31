# Behaviour matrix — how Claude works on Charles

The founder's standing instructions to Claude, in one place, carried over from
Charlie and kept current. **Read this before doing anything in this
repository.** Every new instruction the founder gives is added here the same
turn it is given, and the file is committed with that round's work. Where a
rule here and a tool default disagree, this file wins.

| # | Rule | Since | What it means in practice |
|---|------|-------|---------------------------|
| 1 | **At most two agents, and only when the founder says so.** | 2026-10-30 (Charles round 1) | Charlie's rule was "no agents, ever". On 2026-10-30 the founder allowed two for the Charles build ("just two"). That is the ceiling until they say otherwise: at most two, each briefed with the rules below, never for review of the lead's own work, and the lead reads and checks what comes back. |
| 2 | **Keep this matrix up to date, constantly.** | 2026-10-11 | A new instruction is added the turn it arrives; a changed one is edited, not duplicated. |
| 3 | **Fix everything a report finds, without back-and-forth.** | earlier rounds | Every tester finding is fixed or, if it truly cannot be, explained. Don't ask what to do; do it. |
| 4 | **Read the evidence first.** | 2026-10-11 | When the tester's evidence is in the repo, read it before changing code, and fix from what it shows. |
| 5 | **Open a PR only when asked; never merge it.** | earlier rounds | The founder merges. Work is pushed to the designated branch. |
| 6 | **Reply briefly, in the chat.** | earlier rounds | What changed, the founder's steps, and one combined tester prompt. The founder reads in a browser, so everything they need is in the reply itself. |
| 7 | **Don't make the PDFs look worse — make them better.** | earlier rounds | Any change touching the plan document is printed to PDF in a real browser and looked at. CLAUDE.md rule 8 (tables, inline hex) always holds. |
| 8 | **Never print a secret.** | earlier rounds | No tokens, keys, login codes or connector addresses in replies, commits, logs or files. |
| 9 | **Ask first** before spending money, registering the production WhatsApp number, submitting Meta verification, or touching production data. | CLAUDE.md | Paid model runs (for example `eval.ts --judge`) wait for the founder. |
| 10 | **Synthetic numbers only** in tests and tester prompts. | earlier rounds | Prefix 2780993\* (the other markets' prefixes are kept for when they return). Never read, change or delete pre-existing rows. |
| 11 | **Never invent a price, fee, rule, deadline or fact.** | CLAUDE.md rule 10 | Every figure comes from the library with its check date; research is fact-checked and hedged where sources differ (`docs/kb-sources.md`). |
| 12 | **No invented traction.** | CLAUDE.md | No fake testimonials, user counts, partner logos or pilot results. The landing page says out loud that no cohort has run. |
| 13 | **No model identifiers in anything pushed.** | earlier rounds | Not in commits, PR text, code comments or docs. |
| 14 | **The founder's email lives only in the `ALERT_EMAIL_TO` setting.** | earlier rounds | Never in code, docs or commits. |
| 15 | **One market at full depth before the next.** | 2026-10-30 | South Africa is the market. The depth and coverage tests are the yardstick and only ratchet up; a second market (the Philippines first) is added as data plus the small code list in `docs/EXPERIENCE.md` §1.1, never by guessing its rules. |
| 16 | **Commit and push before stopping.** | session hook | Nothing is left uncommitted at the end of a turn. Commit messages end with the session's attribution lines. |
| 17 | **No regression. Test for it here and everywhere else.** | 2026-10-12 | The rules Charles talks by came from research (one recommendation, not a menu; grounded facts only; free first; hardship mode; no "you told me"; never credit; never an ID, card, PIN or OTP) and must hold on every door — WhatsApp, the web, and the person's own AI. A guard is tested through the whole path it lives in. Before every push: the full suite in both modes (normal and `WA_STRICT_LIMITS=1`), the typecheck, `eval.ts --dry`, and the library depth and coverage scripts. |
| 18 | **Check for drift every round.** | 2026-10-12 | Before each push, audit the round's work against this matrix and CLAUDE.md's twelve rules, and say in the reply what had drifted and what was put back. |
| 19 | **Never recommend credit.** | 2026-10-30 (Charles) | No loan, consolidation, buy-now-pay-later, cash advance or overdraft is ever the recommendation, however cheap, in any prompt, row or step. A bank product that is free and reversible (a savings pocket, an instant payment) may be named where it fits; a loan may only be explained, downside first. |
| 20 | **Never ask for or store an ID number, account number, card number, PIN, OTP or password.** | 2026-10-30 (Charles) | Said in the first message; refused by the memory step, the connector and the guardrails. Anything that needs one happens inside the bank's own app or at the counter. A statement the person chooses to send is read once with identifiers left out and scrubbed, the file is never stored, and only totals and payees are kept (`api/_lib/statement.ts`, `db/0036`). |
| 21 | **Supabase changes come as one paste-ready prompt, with a success-criteria table at the bottom.** | 2026-10-30 | The founder pastes into Supabase themselves. Each change is one prompt in `docs/SUPABASE-PROMPT.md`: a precheck that it is the right project, the SQL exactly as the migration has it, one check query that prints found against expected, then a table of every check, its expected value and what it means. The prompt is generated from the migration files and run twice on a local database before it is handed over. Claude does not apply it to a live project. |
| 22 | **Track everything.** | 2026-10-31 | Chase trains its own model on how its products are used. Every task is recorded whole under one id (`docs/INTEL-CONTRACT.md`): what was asked, what each model was shown and said, what was checked, sent and run, and how it ended. Capture never changes what the product does, never holds a secret or an identifier, and "forget my money" still deletes everything about a person. The first message tells people their conversations are kept. |
