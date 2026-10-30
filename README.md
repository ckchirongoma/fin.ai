# Charles

A WhatsApp number that knows your money.

A person answers twelve questions about one household's money, hears it read
back and confirms it, picks the one thing to fix first and the one money rule
they will live by, and gets a 90-day money plan as one document. WhatsApp then
pushes them through it one step at a time and comes back to ask whether each
step worked. Their own AI (ChatGPT, Claude) can connect to the same memory.
If they want, they send a bank statement and Charles reads their money back
from the page instead, keeping the totals and never the account number. Ask
for a picture ("show me my month", "when is the mashonisa gone?", "my map")
and Charles sends one into the chat, with a link to a small page to play with
on the phone, every number on it their own.

South Africa first, built so the next market (the Philippines, where the same
bank has 11 million customers) is a data migration, not a rewrite. Built to
pitch to GoTyme Bank; see `docs/PITCH.md`.

Charles is built from [Charlie](https://github.com/ckchirongoma/charlie), the
small-business coach. The engine, the guardrails, the queue, the connector and
the plan document are Charlie's; the domain (one household's money, not one
business), the diagnostic, the module library, the prompts, the Money Map and
the knowledge base are new. `docs/superpowers/specs/2026-10-30-charles-design.md`
is the design to argue with.

## The design rule everything else follows

A field experiment with 640 Kenyan entrepreneurs gave them an AI mentor on
WhatsApp that offered three to five suggestions per question. It had no
average effect: the strongest gained 15–20%, and **the weakest did about 10%
worse**, because they could not tell which suggestion fitted them. Drexler,
Fischer and Schoar (2014) found the opposite works for money: one rule of
thumb, kept, moved people where accounting lessons did nothing.

So Charles does the opposite of the usual chatbot on both counts: **one
recommendation, grounded in this household's own figures, free and reversible
first, never a loan, with a follow-up on whether it actually worked.** Every
guardrail in this repo exists to keep that true under pressure.

## What's in here

| Path | What it is |
|---|---|
| `api/whatsapp-webhook.ts` | Verifies Meta's signature over the raw bytes, de-duplicates on the message id, enqueues, answers in under a second |
| `api/worker.ts` | Catch-up drain for the work queue |
| `api/mcp.ts` | The connector for the person's own AI, speaking both MCP protocol eras |
| `api/_lib/appview.ts` | The in-chat view: the plan, the step and the Money Map drawn inside Claude and ChatGPT |
| `api/plan.ts` | Website sign-in (WhatsApp number, one-time code) and the plan viewer |
| `api/ask.ts` | The web chat, with the same guardrails as WhatsApp |
| `api/render-pdf.ts` | The only function that carries Chromium, deliberately isolated |
| `api/health.ts` | What is configured, and whether the guardrails are actually live |
| `api/sponsor.ts` | The cohort report for a bank or programme: aggregates only, split by baseline tier so harm to the weakest is visible rather than assumed |
| `api/cron/` | The nudge sweep and the knowledge-freshness job |
| `api/_lib/` | Everything shared: the engine, prompts, retrieval, guardrails, the fixed plan library (`playbooks.ts`), the Money Map rubric (`moneymap.ts`), the diagnostic (`diagnostic.ts`) |
| `public/` | The landing page, the plan viewer, the web chat, the sponsor and admin consoles |
| `db/` | Migrations, in order, and `CHARLES-SETUP.sql`, all of them in one paste for a fresh Supabase project (`docs/SUPABASE-SETUP.md` has the paste and the success table). `0001` is the security fix; `0033` renames the columns for the money journey; `0034` is the South African library |
| `seed/` | The library as JSON: 56 knowledge entries and 30 tools, every figure sourced in `docs/kb-sources.md`. `db/0034` is generated from it by `scripts/seed-to-sql.mjs` |
| `test/` | 871 tests, including the whole money journey end to end against in-memory fakes. `npm test` |
| `eval/`, `scripts/eval.ts` | The prompt evaluation harness |
| `scripts/kb-coverage.ts`, `scripts/kb-depth.ts` | The library yardsticks (`docs/kb-gap-analysis.md`) |
| `docs/PITCH.md` | The one-page pitch to the bank |
| `docs/superpowers/` | The design spec and the build plan |
| `docs/ARCHITECTURE.md`, `docs/EXPERIENCE.md`, `docs/PRODUCT-DEFINITION.md`, `docs/OPERATIONS.md` | Charlie's design record, each with a Charles addendum at the top saying what changed |
| `HANDOFF-DEPLOY.md` | The going-live checklist, for a fresh Supabase project |
| `CLAUDE.md` | The build brief: the twelve rules, how to work here |

## How it fits together

```
WhatsApp ──▶ Meta Cloud API ──▶ /api/whatsapp-webhook
                                    │ verify signature over raw bytes
                                    │ dedupe on message id
                                    │ enqueue ──▶ 200 in under a second
                                    ▼
                               jobs (Supabase)
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
            the engine                        /api/worker
   diagnostic → read-back → goal               catch-up sweep
   → rule → plan → step loop
                    │
     ┌──────────────┼──────────────┬─────────────────┐
     ▼              ▼              ▼                 ▼
  OpenRouter    guardrails     Supabase         /api/render-pdf
  (model_config) Jev, or a     library, plans,   Chromium, alone
                 model backstop memory
                                    │
                                    ▼
                    /api/mcp — the person's own Claude or ChatGPT
                    /plan    — the same plan, on the web
```

Every model call goes through OpenRouter, and which model does which job comes
from the `model_config` table, never from code.

## The journey, in one line each

1. Twelve questions: who, how money comes in, where, the aim, what is in the way, who depends on them, what comes in, who they owe, what they could reach tomorrow, what cover they have, how they keep track.
2. Hardship first: if the answers say food, rent or transport cannot be covered, Charles stops planning, protects cash, names the free help (the NCR consumer line, the National Financial Ombud) and keeps a way back.
3. The read-back: one identity object, confirmed or corrected before anything is built on it.
4. Three goals, genuinely different, one picked (or two). Then three rules of thumb, shown against what people in that spot usually do instead; one picked.
5. The plan: at most three of thirteen fixed modules, each earned by the diagnosis, tailored in wording only; the strategy and the Money Map; one document, tables and inline hex, printed to PDF.
6. The step loop: send, do, done, did it help. A "better" moves the map.

## The twelve rules

Charlie's ten (fixed library, never "you told me", one recommendation, collaborative choices, identity once, retries, action ids, tables-and-hex rendering, free and reversible first with a hardship mode, never invent a figure) plus two of Charles's own: **never recommend credit** (no loan, no consolidation, no buy-now-pay-later, however cheap), and **never ask for or store an ID number, account number, card number, PIN, OTP or password**, said out loud in the first message. `CLAUDE.md` has them in full; `test/` pins them.

## Running it locally

```bash
npm install
```

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run eval -- --dry
```

```bash
node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/preview-plan.mjs
```

Node 22.6 or newer: the suite runs TypeScript directly, with no build step.

## Status

No cohort has run. The whole money journey runs end to end in the test suite
and the plan document prints to PDF in Chromium; what cannot be ticked from
inside a repository is a live Meta number and a stranger completing the flow on
it. `HANDOFF-DEPLOY.md` is the list.
