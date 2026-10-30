# Charlie — running it

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


What to look at, what it means, and what to do about it. Written for the person
on call, which for a while will be the founder.

---

## You don't have to check: alerts and the dashboard

Since 2026-10 Charlie tells you when something goes wrong (docs/TRACKING.md):

- **Immediate email** (within a minute, at most every 5 minutes) for anything
  that left an owner without what they were promised: a job that gave up, a
  plan build that failed, WhatsApp refusing a message, the model provider out
  of key or credit, a function that crashed.
- **Hourly email** of every time an owner tried something Charlie could not
  do — with what they said — and every warning.
- **Daily summary** at 07:00 Johannesburg: owners, the funnel, questions,
  what failed, how fast, what it cost.
- **Dashboard** at `/admin` (paste `ADMIN_SECRET`): the funnel and where owners
  stop, everything they couldn't do, open problems (resolve them there),
  performance by model and job, every event, and one owner's whole story by
  the 8-character id an email gives you.

To switch the emails on: create a free Resend account with the address the
alerts should go to, make an API key, and set `RESEND_API_KEY` and
`ALERT_EMAIL_TO` in Vercel. Then press "Send a test alert email" on `/admin`.
Until then `/api/health` says "ALERT EMAILS ARE OFF" and everything waits in
`incidents` — the first email after the key is set carries it all.

## The one check that matters most

```
curl -H "Authorization: Bearer $WORKER_SECRET" https://<domain>/api/health
```

Three things to read, in order of how much they matter:

**`guardrails_live`.** If this is `false`, Charlie is giving business advice to
small business owners with nothing checking it. That is the one state this
product must never be in unnoticed — the evidence says AI advice makes the
weakest businesses *worse*, and the guardrails are the whole mitigation. Fix by
setting `TYPESAFE_API_KEY` (preferred) or confirming `OPENROUTER_API_KEY` is
valid, then redeploy.

**`safety.unavailable24h`.** How many checks could not run in the last day. It
should be zero. A non-zero number with `guardrails_live: true` usually means a
credential that is set but rejected, or an upstream that is timing out.

**`queue.dead`.** Jobs that exhausted their retries. Each one is an owner who
sent something and got an apology instead of an answer. Investigate before
clearing. `queue.recent_dead` lists the ten most recent: `kind`, `step` (which
plan-build stage died), `created_at`, `died_at`, the first 150 characters of
`last_error` (long digit runs masked), and `business_exists` — `false` means
the owner has since been forgotten, `null` means the job had no owner (a
freshness sweep). No owner text or phone numbers are ever in it.

**`plan_build_times_24h`.** Whole plan builds finished in the last day: count,
median and slowest, in seconds, plus the slowest build's per-stage split
(`total 312s; context 40s; strategy 95s (1 retry); …`). Stage times run from
first enqueue to finish, so queue wait and retries are included; strategy and
workstreams run side by side, so stages do not add up to the total. Each
build's row is a `safety_events` note with `check_name = 'plan_build_timing'`
and `score` = total seconds:

```sql
select created_at, score as seconds, detail from safety_events
 where check_name = 'plan_build_timing' order by created_at desc limit 20;
```

It, `plan_strategy` and `knowledge_signal` are operational notes, not
guardrail checks, and are left out of every guardrail count.

**`whatsapp_link`** (also in the public form). The website's "Message
Charlie" buttons all go through `/wa`, which opens WhatsApp on the bot's own
number as Meta reports it (Graph `display_phone_number` for
`WHATSAPP_PHONE_NUMBER_ID`, cached for an hour; a failed lookup is cached for
five minutes and bounded at three seconds). `WHATSAPP_PUBLIC_NUMBER` is
optional — only needed if you want the site to show a different number from
the bot's; when set it wins and Meta is not asked. `false` means neither
worked, and every button shows a "not switched on yet" page instead of opening
WhatsApp: check `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_ACCESS_TOKEN` (the
function log says `wa-number: Meta lookup ... failed` with the HTTP status,
never the token), or set `WHATSAPP_PUBLIC_NUMBER` — digits, country code
first — and redeploy.

---

## The database questions worth knowing

**Is anything going unchecked?**

```sql
select check_name, engine, outcome, count(*)
  from safety_events
 where created_at > now() - interval '24 hours'
 group by 1,2,3 order by 4 desc;
```

Every `outcome = 'unavailable'` row is advice that went out with that guardrail
off. Every `engine = 'none'` row is the same thing.

**What is the guardrail actually catching?**

```sql
select unnest(flags) as flag, count(*)
  from safety_events
 where outcome in ('flag','block') and created_at > now() - interval '7 days'
 group by 1 order by 2 desc;
```

`ungrounded_price` climbing means a prompt has started inventing numbers —
usually after a model change. `claims_they_said` climbing means rule 2 is under
pressure. Both are signals to look at the prompt, not to raise the threshold.

**What is the retrieval missing?**

```sql
select query, country, domain, count(*)
  from retrieval_gaps
 where created_at > now() - interval '30 days'
 group by 1,2,3 having count(*) > 1 order by 4 desc limit 50;
```

This table is the decision record for semantic search. A question that recurs
here is a real owner asking something the keyword list never anticipated. Two
or three of those is a reason to either add keywords to the existing rows (do
this first — it is free) or finally populate the `embedding` columns. An empty
table means the keyword shortlist is doing its job and pgvector would be
infrastructure solving a problem you do not have.

**Is the queue healthy?**

```sql
select status, count(*), min(created_at), max(updated_at) from jobs group by 1;
```

`running` rows older than five minutes are treated as abandoned and become
claimable again automatically — that is the crash-recovery path, not a problem.
Sooner than that, a live job's lock is touched every 30 seconds, and the
per-minute tick puts back any `running` job untouched for 100 seconds
(`job_went_silent`). An attempt still running 20 seconds past its invocation's
hard stop gets its next attempt queued on the spot, to start just after the
platform's kill (`job_overran_hard_stop`); if the late attempt was only slow
and finishes, it closes the job and the copy never runs.
A plan build still running at 6 minutes is handed over with what it has
(round 24, `plan_build_handed_over`, in the daily digest): parts not yet
tailored go out in library wording, a strategy not yet written is marked as
coming, and a `plan_repair` finishes both, using what the build's own calls
deliver late (`plan_build_lane_late`, `plan_repaired.props.adopted`). Many of
these in a day means the model is slow: look at `model_call` times for the
`plan_builder` role. Since round 25 the build's model calls each start
with a whole worker attempt (a deferred one shows as `job_deferred`), and a
part with four or more steps is written as two parallel calls
(`build:ws:<part>:1` and `:2`), and so is the strategy since round 26
(`build:strategy:1` and `:2`), so a late lane should be rare; when one does
fail after the hand-over (`plan_build_lane_late` with `ok: false`), the
repair writes that part itself. A build still going at 8 minutes pages you
(`plan_build_slow`, then every 10 minutes): that is one the hand-over could
not move (stuck before its context, or in writing the plan or the PDF). The
owner is told once, at about 7 minutes, that it is taking longer and nothing
is lost (`plan_build_slow_notice`).

**Is anyone stuck?**

```sql
select wa_id, stage, diag_step, updated_at
  from businesses
 where deleted_at is null and updated_at < now() - interval '2 days'
   and stage not in ('plan_ready','stabilizing')
 order by updated_at;
```

An owner sitting in a transient build stage means a build died in a way the
restart did not catch. Their next message recovers it; if they have gone quiet,
that is what the re-engage nudge is for.

---

## Changing a model

Never in code. One row:

```sql
update model_config set model = 'the/new-slug', updated_at = now() where role = 'plan_builder';
```

Roles: `router` (classification, runs on every message, must be near-free),
`wa_reply` (live answers), `help` ("I'm stuck"), `plan_builder` (the one place
quality matters more than speed — it runs once per business, not per message),
`safety` (the guardrail backstop; small and strict), `voice` (transcription).

Each row also has a `fallbacks` array, tried in order before the built-in chain:

```sql
update model_config set fallbacks = array['provider/model-a','provider/model-b'] where role = 'wa_reply';
```

The change is live within a minute — the backend caches `model_config` briefly
so it is not a round trip per message.

**When a model is deprecated**, which on hosted open-model platforms happens on
a few weeks' notice: update the row. That is the whole procedure. There is no
deploy.

**Streaming.** Every askJSON/askText call is streamed (round 22), so a model
that has stopped writing is noticed and the next model tried: nothing at all
for 60 seconds (not even hidden reasoning), or 30 seconds of silence once it
has started. A plan-build call that is still writing may run to 210 seconds.
`model_call` events carry `first_token_ms` and `stalls`, which say whether a
slow call was a slow model or a dead one. If one model or provider misbehaves
streamed, switch it off for that role without a deploy:

```sql
update model_config set params = params || '{"stream": false}' where role = 'plan_builder';
```

`OPENROUTER_STREAM=0` in Vercel switches it off everywhere (a redeploy is
needed for that one).

---

## Adding a fifth country

By design this is a data migration, not a rewrite:

1. Add a row to `COUNTRIES` in `api/_lib/countries.ts` — currency, how money is
   written (`money`, `moneyRe`), the registrar, the tax authority, the free
   advisor, the dialling prefix, and a realistic price example for the
   diagnostic — and its country name, regions, cities and common suburbs to
   `api/_lib/location.ts`: the location answer, not the number, decides the
   market. A new market's places come out of `OUTSIDE` there too.
2. Insert `knowledge_entries` and `tools` rows with the new country code,
   matching the existing column shape exactly, with an honest `verified_on`.
3. That is it. Retrieval, prompts, plan wording and the plan document all read
   from those two places.

Step 1 is the only code change, and it is a data structure. If you find
yourself editing a prompt to add a country, something has gone wrong — the
country-specific facts belong in `countries.ts` and the two library tables.

---

## Nudges, and why they are capped

Two business-initiated messages a week, by default, per owner. This is not
politeness. Meta scores every business number on how people react to it, and
block rates of a few percent drag that rating down; a bad rating is what stops
a pilot growing. One tap pauses them permanently.

```sql
select date_trunc('day', sent_at) d, status, count(*) from nudges
 where sent_at > now() - interval '30 days' group by 1,2 order by 1 desc;
```

A high `skipped` count is the system working. "Send nothing" is written into
the nudge prompt as an explicitly good outcome.

---

## Keeping prices honest

The weekly job writes to `freshness_reports`:

```sql
select ran_at, stale_knowledge, stale_tools from freshness_reports order by ran_at desc limit 5;
select * from tools_freshness where is_stale order by days_old desc nulls first;
```

Anything past 90 days is already hedged automatically wherever it is shown
("confirm at sign-up") — an owner can never be told a stale price as fact. But
hedged is not the same as correct. Re-check the list, then:

```sql
update tools set cost = '...', verified_on = current_date where id = 'yoco';
```

`seed/*.json` is a snapshot, not the source of truth, and it will drift.

---

## Verbatim facts are checked, not re-generated

Two real incidents on 2026-09-22 looked similar and were not, and the fix for
one would have been the wrong tool for the other:

**Priority 2 — a fact that was never given gets invented.** Given
deliberately generic diagnostic answers, the context-building call invented a
specific customer segment, a specific price range and a specific value
proposition, and asserted every one of them as settled fact — while its own
`identity.unsure` had already said the diagnostic was too thin to be sure of
anything. This is a *judgement* problem: is this specific claim actually
traceable to something the owner said, established, or chose? `checkTraceability`
(`api/_lib/safety.ts`) is the Jev check for it, and `identity.unsure` is now
an actual gate on it (`applyContextGuardrails`, `api/_lib/engine/build.ts`):
whenever it is set, the narrative fields a model still has to write freely
are hedged unconditionally, and the two fields that were actually invented
(`context.customers`, `context.typical_price`) are no longer asked of a
model at all — they are computed from the customer the owner already chose.

**Priority 2b — a fact that WAS given correctly still comes out wrong.** A
real reply read "...property managers in Woodwood search for tests in
Woodstock..." — the business's own city, stored correctly and handed to the
model verbatim on every call. The model paraphrased quickly and wrote the
wrong word for a proper noun, once, mid-sentence. Confirmed *not* a data or
prompt bug, and confirmed the existing guardrail does not catch it: Jev's
`reply_compliance` ran on this exact reply and passed it, because it is a
compliance check, not a spell-checker. This is *arithmetic on two strings*,
not a judgement — `checkNameFidelity` (`api/_lib/safety.ts`) is a plain
Levenshtein-distance lookup against `businessKnownFacts` (name, location,
identity, the chosen customer/angle labels), with no Jev call and no model
call. It runs on every owner-facing reply, step push/artifact and strategy
document, and writes its own `name_fidelity` row to `safety_events`,
distinct from `reply_compliance`.

**The rule going forward:** anything Charlie already knows exactly — a name,
a place, a price, a chosen label — is checked against the stored value
directly, cheaply, mechanically. Only a claim that must be *judged* — is
this invented, is this the right recommendation — goes through Jev. Reach
for a Jev call where a plain lookup would do, and you have solved the wrong
half of the problem; the founder has said as much directly ("AI is only
invoked when it's needed").

```sql
select check_name, engine, outcome, count(*)
from safety_events
where check_name in ('traceability', 'name_fidelity')
group by 1, 2, 3
order by 1, 3 desc;
```

`engine = 'none'` on a `name_fidelity` row is not a guardrail that is off —
it is the design: nothing ran because nothing needed to.

---

## The owner's own AI (Claude, ChatGPT)

Since round 27 an owner can run Charlie entirely from their own AI. They send
**connect** to Charlie on WhatsApp, get a private address, and add it as a
custom connector (Claude: Settings → Connectors → Add custom connector;
ChatGPT: Settings → Apps & Connectors, which may ask for developer mode
and a paid plan; the WhatsApp message spells both out). The address is a secret:
anyone holding it can read that business. Never paste one into a ticket or a
chat; "connect" again replaces it and switches the old one off.

What the AI can then do is the whole WhatsApp loop: see the step they are on,
send it to their phone, mark it done or skipped, say whether it worked, get
the plan PDF, ask for a plan or fact change (the owner confirms on WhatsApp
before anything changes), flag real money trouble (stabilising mode on both
doors), and remember things about the person. What it is told is in
`connectorInstructions` (`api/_lib/prompts.ts`): the 90-day plan is the north
star, off-plan questions get a real grounded answer and then a kind nudge back,
and Charlie's research-backed rules hold. Change that text only with
`test/round27-mcp.e2e.test.ts` passing: it pins those rules for every market.

Three things only the WhatsApp side can do, on purpose: start or rebuild a
plan (the AI is told to point them back to WhatsApp), leave stabilising mode
(the owner says things have steadied, on WhatsApp, where the evidence check
lives), and send anything outside Meta's 24-hour window (the AI is told to ask
the owner to message Charlie first).

**Drawn in the chat (round 28).** Where the app supports MCP Apps — Claude
on the web and desktop, and ChatGPT — `get_plan`, `get_current_step` and
`get_business_map` are drawn as a small view under the AI's answer: the
plan with "You're here", the step with its words ready to copy and its tool,
the map's eight areas. Its buttons ("I've done it", how it went, "Next step",
"Send to my phone") call the same connector tools the AI calls, so nothing
new can change the plan. The page is `api/_lib/appview.ts`: one static file,
no owner data in it, nothing fetched from anywhere, built with tables and
inline colours like the plan document (rule 8). An app that cannot draw it
shows the text, as before. Nothing to set up: the owner's existing address
gets it. `mcp_view_read` in `/admin` shows how often a view was drawn.

Memory needs `db/0032_owner_notes.sql`. Until it runs, nothing about the
person is kept and an `owner_notes_failed` alert says which file to run.
What the owners' AIs do shows in `/admin` as `mcp_tool_called` (by tool and
result), with `step_done` / `step_skipped` carrying `via: connector`.

## When someone says "forget my money"

It is handled automatically, in any stage, and confirmed in one message: the
business row is soft-deleted, the context and answers are cleared, and the
message log, connector tokens and web sessions are deleted outright. The soft
delete is so an accidental send is recoverable; hard-delete the row if the
owner asks for that specifically.

---

## The number nobody else will ask you for

```
curl -H "Authorization: Bearer $WORKER_SECRET" https://<domain>/api/sponsor | jq .harm_monitoring
```

Every business is given a baseline tier the moment its plan is created, from
its Business Map on day one, and never updated. The report compares how often
the weakest third report an improvement against how often the strongest third
do.

This exists because of a specific piece of evidence: in a field experiment with
640 Kenyan entrepreneurs, an AI business mentor had no average effect, and the
weakest businesses came out about 10% *worse*. PRODUCT-DEFINITION 6.1 commits
this product to pausing and reviewing if the same thing shows up here. That
commitment is only real if somebody looks, and this is where you look.

It needs genuine pilot traffic before it means anything, and it says so when it
has too little. Do not report cohort numbers to a sponsor without reading it
first, and do not read it without also checking
`guardrails.checks_that_could_not_run`.

---

## Cost, and where it actually goes

The expensive calls are the plan build (several calls, once per business) and
the live answer path. The cheap ones are the router, the memory updater and the
guardrails. The free ones are the walkthroughs and the deterministic shortlist,
which is the point of doing retrieval in plain code.

Before quoting anyone a per-seat price, measure it: cost per active owner per
month, from real pilot traffic, not from an estimate. The comparison a sponsor
will make is against a training programme costing hundreds per participant.
