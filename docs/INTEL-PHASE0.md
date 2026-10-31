# Chase Intelligence — Phase 0 for Charles, and what was done

Written 2026-10-31. The same report holds for Charlie (`ckchirongoma/charlie`),
which shares the engine; the differences are noted.

## What was already here

Row counts are not given: this session cannot reach the live Supabase project,
and reading production data needs the founder's word.

| Data | Table | Worth for training |
|---|---|---|
| Every WhatsApp message in and out, as text | `messages` | High: whole conversations, in order. |
| Plans, steps, step outcomes, decisions, commitments | `plans`, `plan_steps`, `outcomes`, `decisions`, `commitments` | High: what was recommended, what was done, how it ended. |
| Plan builds stage by stage, with errors | `plan_builds` | High: failures and retries. |
| Guardrail checks: which, engine, score, outcome | `safety_events` | High: what was checked and corrected. |
| Questions the library could not answer | `retrieval_gaps`, `knowledge_signals` | Medium. |
| Product events with 200-character excerpts | `events`, `event_daily`, `incidents` | Medium, and on a timer (below). |
| Each household's money graph and its actions | `kg_nodes`, `kg_edges`, `kg_triggers` | Medium. Charlie has the business graph. |
| Households (Charles only) | `households`, `household_members` | Low. |
| Model tokens and cost per call | `model_usage` | Low: counts only. |
| Six evaluation result files, the library | `eval/`, `seed/` (in git) | Medium. |

## What was being lost

- **On a timer:** `events` keeps routine rows 180 days and the rest 365, then
  deletes them; only daily counts survive. Finished watchdog jobs go after 7
  days (noise).
- **Never recorded at all:** what each model call was shown and what it
  answered. `model_usage` kept tokens and cost only, so nothing showed what was
  seen, decided and corrected inside a turn. This was the largest gap.
- **Outside the repository:** hosting and OpenRouter logs. Their retention is
  set by those accounts and is not verified from here.

## What was done

- `intel_events` (`db/0041` in Charles, `db/0034` in Charlie) and
  `api/_lib/intel.ts`: every message in and out, every model call whole, every
  guardrail check, every WhatsApp delivery, every call from the person's own
  AI, every queued job and every product event, under one trace id. See
  `docs/INTEL-CONTRACT.md`.
- The migration copies every existing `events` row into `intel_events` once,
  so the timer no longer loses anything; new events arrive as they happen.
- Secrets and identifiers are removed before anything is written and again on
  export (`api/_lib/intelredact.ts`), proved by `test/intel.test.ts`.
- `scripts/intel-export.ts` exports everything, old and new;
  `scripts/intel-trace.ts` reads one task back from one id.
- The first message used to say "Nobody else sees this". With conversations
  recorded for training that was no longer true, so it now says conversations
  are kept to help and to get better at helping, and that "forget my money"
  deletes all of it. Forgetting deletes the captured rows too.

## Owner actions

1. **Run the Supabase prompt** (`docs/SUPABASE-PROMPT.md`) so `intel_events`
   exists. Until it does, capture writes nothing and logs one line saying so;
   nothing else is affected.
2. **Watch the database size.** Full capture keeps every prompt, and a prompt
   is tens of kilobytes; Postgres compresses repeated text, but a busy month
   will outgrow the free tier's database size. Check Supabase → Database →
   size monthly. If it nears the limit, the free choices are `INTEL_CAPTURE=meta`
   or exporting and then deleting old months; anything else costs money and
   needs your decision.
3. **Check your hosting and OpenRouter log retention** if those logs matter;
   they are outside this repository.
