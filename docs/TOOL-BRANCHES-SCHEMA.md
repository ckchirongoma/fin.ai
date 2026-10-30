# `tool_branches` — a design note, not a migration

> ## Fin addendum (2026-10-30)
>
> This document is Charlie's design record, kept because every decision in it
> still holds for Fin and was earned the hard way. Read it with the
> vocabulary map in `docs/superpowers/plans/2026-10-30-fin-build-plan.md`:
> business → household (one person's money), owner → person, customer → goal,
> angle → rule, idea/start/run/grow → surviving/stretching/steady/building,
> distress → hardship, the eight business areas → the eight money areas
> (income, spending, debt, cushion, credit_record, protection, family_money,
> goals), the five markets → South Africa first. Where this file names a
> business body (CIPC, SARS for a business, SEDFA), Fin names the money ones
> (the NCR consumer line, SASSA, SARS for a person, the National Financial
> Ombud). Two rules were added for Fin: never recommend credit, and never ask
> for an ID number, account number, card number, PIN, OTP or password. The
> design itself is `docs/superpowers/specs/2026-10-30-fin-design.md`.


Priority 4.4 of the 2026-09-22 fix pass asks for "Jev as router": before a
model is ever called for a tool-help question, check whether the owner's
situation matches a known, already-researched branch (starting state, happy
path, failure point, country variation) and serve the verified answer
directly. Priority 4.3 asks for that research, tool by tool — starting-state
branches, the verified happy path, real failure points, country variations,
and what genuinely cannot be scripted — done to the depth of the two worked
examples (`gbp`, `yoco`) in `.FIX-PROMPT-MASTER.txt`.

**This PR does not do that research or populate this table for any of the 53
tools** — that is explicitly out of scope here (see the PR body) and remains
future work for Track4's data corrections plus a dedicated research pass, the
same way `.FIX-PROMPT-MASTER.txt` itself says not to present partial coverage
as complete. What this PR *does* ship is the narrower, single highest-volume
case that needs no new table at all: `helpWithStep` now checks the walkthrough
content already sent (`biz.walk`) before calling a model — see
`api/_lib/engine/steps.ts`. This document sketches the schema that a real 4.3
research pass would populate next, so that work has a landing spot instead of
starting from a blank page.

## Why a new table, not a bigger `tools` row

`tools.walkthrough text[]` is one flat, ordered list — perfect for "the happy
path", wrong shape for "the happy path, PLUS four different failure points,
PLUS three starting-state branches, PLUS a country-specific variant on step 3
for Kenya". Cramming all of that into one text array (or one JSON blob a model
has to re-parse every time, which CLAUDE.md's retrieval design explicitly
warns against) is exactly the "prose buried in one big text field" the fix
prompt calls out in section 4.6. A linked table keeps each branch a separate,
independently matchable row — the same shape `tools` and `knowledge_entries`
already use for retrieval (`keywords text[]`, scored in plain code, no model
call, before anything touches an LLM).

## Proposed schema

```sql
create type tool_branch_type as enum (
  'starting_state',   -- 4.3.A: different states an owner can be in before they start
  'happy_path_step',  -- 4.3.B: one numbered step of the verified happy path
  'failure_point',    -- 4.3.C: a real, specific place owners get stuck
  'country_variation',-- 4.3.D: a fact that differs by country/business type
  'unscriptable'       -- 4.3.E: depends on something only the owner can find out
);

create table tool_branches (
  id uuid primary key default gen_random_uuid(),
  -- tools.id is not globally unique on its own (toolById looks up by
  -- id + country — see api/_lib/db.ts), so this table keys off the same pair.
  tool_id text not null,
  country text not null,
  foreign key (tool_id, country) references tools(id, country),

  branch_type tool_branch_type not null,
  -- Ordering within a type — the happy path's step order, or a display
  -- priority among several failure points for the same tool.
  step_order int not null default 0,

  -- A short label an owner-facing router (or a human reading the table)
  -- can recognise at a glance, e.g. "Listing already claimed by someone else".
  title text not null,

  -- The deterministic match signal — plain-code keyword overlap against the
  -- owner's message, the same scoring `shortlist()` already runs for
  -- knowledge_entries/tools, never a model call. Mirrors tools.keywords.
  match_keywords text[] not null default '{}',

  -- Structured condition for starting-state and country-variation branches,
  -- e.g. {"business_type": ["sole_prop"], "has_google_account": false} or
  -- {"country": ["KE"]}. Matched against fields already on `businesses`
  -- (context, answers, country) — never re-asked of the owner if Charlie
  -- already has the answer.
  applies_when jsonb not null default '{}',

  -- The fixed, verified answer to serve directly when this branch matches
  -- and it CAN be scripted (branch_type <> 'unscriptable'). Numbered,
  -- exact button/link text, written the way 4.3.B/4.1's PDF need it —
  -- not a summary.
  instruction text,

  -- Only set when branch_type = 'unscriptable'. What IS known, so the model
  -- (4.5) can say that much and refuse to assert the rest — never a reason
  -- to invent a plausible-sounding ETA or outcome.
  known_but_unscriptable_context text,

  source_url text,
  verified_on date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tool_branches_lookup on tool_branches (tool_id, country, branch_type);
```

## How 4.4's router would use it

1. On `helpWithStep`, before `askJSON("help", ...)`: score `said` against
   `tool_branches.match_keywords` for this step's `tool_id`/`country`
   (plain keyword overlap, exactly like `shortlist()` — no model call for the
   match itself). Above a threshold with `branch_type <> 'unscriptable'`:
   send `instruction` directly, log which branch matched (its own
   `safety_events`-style row or a `tool_branch_id` on the outbound message),
   zero model calls.
2. No confident keyword match, but the message still needs *classifying*
   rather than *answering* (per 4.4.1's "a model may still be used only to
   phrase the routing/matching decision"): a Jev typed `choice` question over
   the candidate branch titles for this tool — not a generation call.
3. `branch_type = 'unscriptable'` matched, or nothing matched at all: fall
   through to the model, exactly as `helpWithStep` does today — grounded in
   `known_but_unscriptable_context` when present (4.5: say what's known,
   refuse to assert the rest), and still passed through `checkReply`/Jev.

This PR's `biz.walk`-based shortcut is, in effect, one hand-coded row of this
table's `happy_path_step` type (`instruction` = the line already sent) applied
universally without the table existing yet — the cheapest, highest-volume
case first, exactly as `.FIX-PROMPT-MASTER.txt` prioritises. A real 4.3
research pass would add `starting_state`, `failure_point`,
`country_variation`, and `unscriptable` rows on top, tool by tool, starting
with the ones flagged CRITICAL DRIFT and the ones the research session could
not verify at all (`expresspay_gh`, `hubtel`, `ozow`, `speedaf_ghana`,
`veira_pos`, `yango_delivery_ghana`), and weighted by which tools actually
appear most in `plan_steps` in production.
