# Chase Intelligence — the capture contract, v1

Every Chase repository writes the same rows, so all of them add up to one
dataset to train Chase's own model on (owner decisions D93 and D94). This file
is the contract as built in Charles (`ckchirongoma/fin.ai`) and Charlie
(`ckchirongoma/charlie`). A repository that adopts it copies this file
unchanged and changes only `app`.

The test it has to pass: for any task anyone did, you can read back exactly
what was asked, what was seen, what was decided, what was run, what was
checked, what was corrected and how it ended, in order, from one id.

## 1. One table: `intel_events`

| Column | Type | What it holds |
|---|---|---|
| `id` | bigint identity | Row number. Export order. |
| `at` | timestamptz | When it happened, to the millisecond. |
| `seq` | bigint | Order within one process, for events in the same millisecond. Sort by `at, seq`. |
| `app` | text | Which product: `charles`, `charlie`, `chase`, `salesflowpro`, … |
| `v` | smallint | Contract version. This file is `1`. |
| `trace_id` | text | **The one id.** Everything one task did shares it. |
| `turn_id` | text | The WhatsApp turn, when there is one (a hash: never the phone number). |
| `job_id` | bigint | The queued job, when the event happened inside one. |
| `business_id` | uuid | Whose it is. No foreign key: rows outlive nothing, and forgetting deletes them. |
| `channel` | text | `whatsapp`, `web`, `mcp`, `system`. |
| `stage` | text | Where in the product the person was. |
| `kind` | text | One of the nine kinds below. |
| `name` | text | What exactly, e.g. `model_call:router`, `check:claims_they_said`, `get_money_map`. |
| `actor` | text | `person`, `app`, `model`, `system`, `their_ai`. |
| `ok` | boolean | Did it work. Null when the question does not apply. |
| `ms` | integer | How long it took. |
| `content_mode` | text | `full` or `meta`. |
| `content` | jsonb | The words and payloads. Null in `meta` mode. |
| `meta` | jsonb | Small facts that are never words: model, role, usage, sizes, statuses, ids. |
| `source_ref` | text unique | For rows copied from an older table (`events:<id>`), so a backfill never doubles. |

## 2. The trace id

One id per task, chosen in this order:

1. The WhatsApp turn id (`t_` + a hash of the message id), which is the same in
   the webhook and in the worker that answers it.
2. `job_<id>` for a queued job that is not a turn.
3. The request's own id (`r_` + 16 hex), set for every HTTP request.

A task that queues a job records `job` / `job_enqueued` with `meta.job_id`;
reading a trace back follows those links and folds the jobs in.

## 3. The nine kinds

| Kind | Actor | Recorded at | `content` | `meta` |
|---|---|---|---|---|
| `ask` | person | Every message in | `text`, `kind` | `chars` |
| `say` | app | Every message out | `text`, `kind` | `chars`, delivery |
| `model` | model | Every model call | `messages` (everything it was shown), `response` (everything it said), `reasoning` settings | `model`, `role`, `served_by`, `provider`, `usage`, `truncated`, `streamed`, `first_token_ms`, `error` |
| `check` | system | Every guardrail check | `detail`, `flags`, `score` | `check`, `engine`, `outcome` |
| `tool` | their_ai | Every call from the person's own AI | `args`, `result` | `tool`, `error` |
| `send` | app | Every WhatsApp delivery | the payload, without the number | `type`, `skipped`, `error`, `code` |
| `job` | system | Every queued job | `payload` | `job_id`, `kind` |
| `track` | system | Every product event | `props`, `said`, `summary` | `category`, `severity` |
| `error` | system | Every failure | as `track` | as `track` |

Corrections show up as events, not edits: a retried model call is a second
`model` row, a guardrail that changed a reply is a `check` with
`outcome: flag` followed by the corrected `say`, and a plan change is a `track`
row (`plan_change_applied`).

## 4. Rules every repository keeps

1. **Additive.** Capture never throws into the code it watches, never waits on
   the request path, and never changes a result, a reply or a timing anyone
   can notice: under 5 ms at p95 per event, pinned by a test. Rows are
   serialised at capture and written in batches after the response.
2. **One switch.** `INTEL_CAPTURE` = `full` (default) | `meta` (no content) |
   `off`. Nothing else changes with it.
3. **No secrets, ever** (`intelredact.ts`, run before the write and again on
   export, proved by tests): this deployment's own keys by value; anything
   shaped like an API key, bearer token, JWT, vendor key, private key,
   connection string, password, cookie or signed link; any value under a
   secret-named JSON key.
4. **No identifiers.** ID, card, account and phone numbers (any run of nine or
   more digits), PINs, OTPs and sign-in codes are removed. Money and dates
   stay. Files and images in a prompt are kept as type and size, never bytes.
   A web sign-in code message is kept as its kind only.
5. **Forgetting wins.** When a person asks to be forgotten, every row about
   them and every trace they were in is deleted, written or still buffered.
6. **The person is told.** The first message says conversations are kept to
   help them and to get better at helping, and how to delete them.
7. **Exports never go into git.** They are written to `intel-export/`, which
   is in `.gitignore`.

## 5. The export

`scripts/intel-export.ts [folder]` writes, into `intel-export/<time>/`:

- `traces.jsonl`: one line per task, `{trace_id, app, v, business_id,
  started_at, ended_at, kinds, events: [...]}` with its events in order.
- `intel_events.jsonl`: every captured row.
- `<table>.jsonl` for every table that already held what people did before
  capture began (conversations, plans, steps, outcomes, decisions, checks,
  gaps, usage, events, jobs, the knowledge graphs, the library).
  Credentials (tokens, codes, sessions) are never exported.
- `manifest.json`: counts per table, number of traces, capture mode, errors.

Every line goes through redaction again. `scripts/intel-trace.ts <id>` prints
one task, in order, from any of its ids.
