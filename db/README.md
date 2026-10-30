# Fin — database setup scripts

These are NOT applied automatically. Nothing watches this folder. They exist so
the SQL is kept, reviewable, and re-runnable.

To apply: Supabase → SQL Editor → New query → paste → Run. **In order.** Every
one of them is safe to run more than once.

Fin is built from Charlie, and the tables keep Charlie's names: a `businesses`
row is one household's money, `business_map` is the Money Map, `owner_notes`
is what Fin remembers about the person. `0033` says why. The market-only data
migrations Charlie carried (Kenya, Nigeria, Ghana, Uganda, and its South
African business library) are gone; `0034` is Fin's library.

| File | What it does |
|---|---|
| `0001_rls_lockdown.sql` | The security fix. Reference tables become public-read; every person-data table becomes reachable only through the backend. Run this first and do not reorder it. |
| `0002_model_config.sql` | One row per job saying which model does it. Hosted model catalogues retire models on a few weeks' notice; when that happens you update a row, not a deployment. |
| `0003_conversation_state.sql` | Where each person is in the conversation, and the message log. |
| `0004_plan_flow_state.sql` | The columns the plan builder writes (renamed for the money journey by `0033`). |
| `0005_platform.sql` | The work queue and its atomic claim function, WhatsApp message de-duplication, the guardrail audit trail, retrieval gaps, commitments and outcomes, nudges, connector tokens, website sign-in, and the `safety` model role. |
| `0006_freshness_and_templates.sql` | The staleness views, the freshness report table, and the six WhatsApp templates as drafts (reworded for Fin by `0035`). |
| `0007_forget_cascades.sql` | "Forget my money": every row of the person's goes with the household row. |
| `0008_strategy.sql` | The plan's strategy column. |
| `0009_mimo_and_usage.sql` | Per-role reasoning settings on `model_config`; `model_usage` cost metering. |
| `0010_vector_search.sql` | pgvector search-by-meaning, the second pass under keywords. |
| `0011_surfaces.sql` | The day-one map snapshot; sponsor tokens. |
| `0012_plan_build_stages.sql` | The `plan_builds` table the resumable per-stage build reads and writes. |
| `0013_claim_job_owner_order.sql` | `claim_job()` never claims a later job for a person while an earlier one of theirs is waiting or running. |
| `0013_tool_content_fixes.sql` | Adds the `needs_verification` flag to `tools`; its Charlie row updates touch nothing here. |
| `0014_tools_ingestion.sql` | Adds `free_type`, `informal_business_supported` (for Fin: works without a payslip) and `ten_minute_action` to `tools`. |
| `0015_knowledge_signals.sql` | The `knowledge_signals` table: dated notes of the library missing something or getting something wrong. |
| `0016_signals_web_source.sql` | A signal may record `web` as its source. |
| `0018_messages_inbound_dedupe_index.sql` | One index for the "is this message already recorded?" check. |
| `0024_tracking.sql` | Tracking: `events`, `incidents`, `alert_state`, `event_daily`, anonymised when a household is forgotten. See docs/TRACKING.md. |
| `0025_alert_levels.sql` | An incident's alert level can come down once it was emailed or resolved. |
| `0026_kept_questions.sql` | `businesses.kept_questions`: a question asked mid-diagnostic is kept and answered after the plan is handed over. |
| `0032_owner_notes.sql` | `owner_notes`: what Fin remembers about the person, read into every answer, deleted with the household. |
| `0033_fin_schema.sql` | **Fin.** Renames the four plan-flow columns (customer → goal, angle → rule, and their pending-options columns) and documents the money stages and the eight money areas. Run after 0032. |
| `0034_fin_za_library.sql` | **Fin's library.** 56 knowledge entries and 30 tools for South Africa, whole-row upserts keyed on id, generated from `seed/` by `scripts/seed-to-sql.mjs`. Sources and verdicts in `docs/kb-sources.md`. Run after 0033. Founder path without SQL: the `node scripts/apply-knowledge.mjs …` command at the top of the file. |
| `0035_fin_templates.sql` | **Fin.** The six WhatsApp templates reworded for a household's money (names `fin_*`); the copy-paste set for Meta is `docs/META-TEMPLATES.md`. Run after 0034. |

## Why two of these are load-bearing

**`0001`** is the difference between "our research is public" and "every
person's private money data is public". Before it, RLS was off on every table.

**`0005`** contains `claim_job`, which uses `FOR UPDATE SKIP LOCKED`. That is
what lets two function instances wake at the same moment and never claim the
same job. Without it, a burst of traffic means the same WhatsApp message
handled twice.

## Checking it worked

```sql
select relname, relrowsecurity from pg_class
 where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname;
```

Every row must say `true`.

## Going live

`HANDOFF-DEPLOY.md` at the repo root is the full checklist: run order, the
deploy, the secrets, pointing Meta at the webhook, and what to check afterwards.
`docs/OPERATIONS.md` is what to look at once it is running.
