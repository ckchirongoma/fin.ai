# Charles — production architecture

> ## Charles addendum (2026-10-30)
>
> This document is Charlie's design record, kept because every decision in it
> still holds for Charles and was earned the hard way. Read it with the
> vocabulary map in `docs/superpowers/plans/2026-10-30-charles-build-plan.md`:
> business → household (one person's money), owner → person, customer → goal,
> angle → rule, idea/start/run/grow → surviving/stretching/steady/building,
> distress → hardship, the eight business areas → the eight money areas
> (income, spending, debt, cushion, credit_record, protection, family_money,
> goals), the five markets → South Africa first. Where this file names a
> business body (CIPC, SARS for a business, SEDFA), Charles names the money ones
> (the NCR consumer line, SASSA, SARS for a person, the National Financial
> Ombud). Two rules were added for Charles: never recommend credit, and never ask
> for an ID number, account number, card number, PIN, OTP or password. The
> design itself is `docs/superpowers/specs/2026-10-30-charles-design.md`.


> **Addendum, written during the build.** This document is the plan as it was
> designed, and it is still the right shape. Three things changed once it met
> reality, and the code follows the changes rather than this page:
>
> 1. **Every model call goes through OpenRouter**, not to Groq and Anthropic
>    directly. Same two-tier design, same `model_config` table, same argument
>    for never hardcoding a model name — one gateway, one key, and the provider
>    split becomes a row rather than a code path. Part 2's reasoning holds
>    exactly; only the endpoint changed.
> 2. **Voice notes also go through OpenRouter.** It proxies an OpenAI-shaped
>    `/audio/transcriptions` endpoint, which is the open question Part 1 left
>    hanging. No second account. The `voice` row in `model_config` carries a
>    `provider` column, so routing directly to Groq or OpenAI later — which is
>    cheaper per hour and the only way to get per-segment confidence back — is
>    a database change.
> 3. **The webhook does not do the work.** Meta retries anything it does not
>    get a fast 2xx for, and a plan build takes far longer than that, so a slow
>    build guaranteed a redelivery and a duplicate plan. The webhook now
>    verifies, de-duplicates, enqueues and answers; a durable queue does the
>    rest. See `HANDOFF-DEPLOY.md` and `docs/OPERATIONS.md`.
>
> The build sequence in Part 4 is complete through phase 9. What is
> deliberately still not built, and why, is listed in `HANDOFF-DEPLOY.md`
> section 5.

*How the prototype becomes a real WhatsApp number, using the Meta Cloud API, Groq for fast/cheap inference, Claude for the heavy reasoning, and Supabase as the scalable knowledge base. September 2026.*

---

## Two things named "Claude" here — worth separating first

You said "connect it to Claude Code." There are two different connections, and they're not the same thing:

1. **Claude Code is how you *build* this.** It's the coding tool — you run it in a terminal or the desktop app, point it at a repo, and it writes the webhook server, the database schema, the Groq integration, the admin tools. It doesn't run inside the live product. Once Charles is live and an owner messages it, Claude Code isn't involved in answering that message — it's back on your laptop, waiting for the next thing you ask it to build.
2. **The MCP connector is how an owner's *own* Claude (or ChatGPT, or Gemini) talks to Charles.** That's the "take this into any AI" piece already in the plan document — a small server that Claude Code will build for you, but which then runs live, separately, as part of the product.

So: Claude Code builds Charles. The connector is a small piece *of* Charles that Claude Code builds. Two different jobs, same tool.

One more thing worth naming: Claude Code already has a direct line into Supabase. It's the same connector available in this chat — `mcp.supabase.com`. That means the fastest way to start building this isn't to write code from scratch; it's to open Claude Code in a repo, point it at your Supabase project, and start with the schema below.

---

## The shape of the system

```
WhatsApp (owner's phone)
    │
    ▼
Meta Cloud API  ──webhook──▶  Your backend (built by Claude Code)
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              Groq (fast,      Claude API      Supabase
              cheap: router,   (slow, rare:    (Postgres + pgvector:
              replies, help)   plan building)  context, map, plan,
                    │               │           knowledge, tools)
                    └───────────────┴───────────────┘
                                    │
                                    ▼
                    MCP connector (owner's own Claude/ChatGPT/Gemini)
```

One WhatsApp number. Every owner who messages it is a row in the same database. The backend is the thing you don't have yet — everything else (Meta, Groq, Anthropic, Supabase) is a service you connect to, not something you build.

---

## Part 1 — The WhatsApp side

### Direct Cloud API, not a BSP

You have Claude Code and the technical ability to run a webhook server, so go directly through Meta's Cloud API rather than paying a Business Solution Provider (Wati, 360dialog, etc.) a monthly markup to do it for you. A BSP makes sense if you never want to touch infrastructure; it doesn't make sense once you're already building a backend.

### Setup sequence

| Step | What happens | Time |
|---|---|---|
| 1. Meta Business account | Create at business.facebook.com if you don't have one | Minutes |
| 2. Create the app | developers.facebook.com → new app → type "Business" → add the WhatsApp product. Meta gives you a **test number** and a 24-hour token immediately | Minutes |
| 3. Build against the test number | Webhook, message send/receive, buttons — everything in the current prototype, working end to end | Days, in parallel with step 4 |
| 4. Business verification | Submit your registration documents. **Start this on day one** — it's the slow part and everything else can happen while you wait | 2–7 business days |
| 5. Register your production number | Once verified, register the real Charles number. It can't already be active on WhatsApp or the WhatsApp Business app | Same day as approval |
| 6. Permanent token | Test tokens expire in 24 hours. Create a System User in Meta Business Suite, assign WhatsApp permissions, generate a permanent token | Minutes |
| 7. Webhook | An HTTPS endpoint that handles Meta's verification handshake (GET) and receives messages (POST). Subscribe to the `messages` field | Built in step 3 |
| 8. Templates | Any message Charles sends *outside* a 24-hour reply window (the Monday nudge, the commitment check-in) needs a pre-approved template. Submit these early — approval can take a few days the first time | Days |

Plan on roughly two weeks from a standing start to a live production number, most of it waiting on Meta rather than building.

### What this changes from the prototype

The prototype's buttons (reply chips, list menus) map directly to WhatsApp's real **Interactive Messages** — reply buttons (max 3) and list messages (max 10 rows), which is exactly what the prototype was already built against. The eleven-question diagnostic is a strong candidate for a **WhatsApp Flow** — a native multi-screen form — once you're past the pilot; for the first version, the existing one-question-at-a-time WhatsApp thread is faster to ship and easier to change.

### Voice notes

Meta delivers voice notes as an audio file URL in the webhook payload. Download it, send it to **Groq's hosted Whisper endpoint** for transcription (fast, cheap, same API key as everything else on Groq), then run the transcript through the same pipeline as typed text. This is also where the "laundromat heard as lodge" problem lives — Whisper will mishear things the same way any transcription does, which is exactly why the identity-confirmation step in the current design (read it back, let the owner correct it) matters at the infrastructure level too, not just the prompt level.

### Scale headroom

New numbers start at **Tier 1: 1,000 unique contacts per 24 hours**, and move up automatically (10,000 → 100,000 → unlimited) based on volume and a quality rating Meta tracks per number. That easily covers a pilot cohort of a few hundred businesses; you won't think about this again until you're well past it.

---

## Part 2 — The model layer, and why it has to be a config, not code

> **As built:** every model call goes through **OpenRouter**, not to Groq
> directly. Everything below about deprecation risk, the `model_config` table
> and the two-tier split is exactly what was implemented — OpenRouter is the
> gateway, and the table still decides which model does which job. Read
> "Groq" below as "the hosted open-model layer": the argument is unchanged,
> the endpoint is one.

### What Groq is for

Groq doesn't train models — it runs other people's open-weight models (Meta's Llama, OpenAI's open gpt-oss, Alibaba's Qwen) on hardware built for speed. The pitch for Charles: sub-500ms replies even on a 70B-class model, an OpenAI-compatible API (so switching providers later is a config change, not a rewrite), and a free tier generous enough to run the whole pilot on.

### The real risk: Groq's catalog moves under you

As of this September, Groq deprecated `qwen/qwen3-32b` and `meta-llama/llama-4-scout-17b-16e-instruct` in June, and `moonshotai/kimi-k2-instruct-0905` in March — each with a few weeks' notice by email, migrating users toward `openai/gpt-oss-120b`. This isn't a one-off; it's the normal rhythm on every hosted-open-model platform right now. **Never hardcode a Groq model name in the code Claude Code writes.** Put it in a config table:

```sql
create table model_config (
  role text primary key,          -- 'router', 'wa_reply', 'help', 'voice', 'plan_builder'
  provider text not null,         -- 'groq' | 'anthropic'
  model text not null,
  updated_at timestamptz default now()
);
```

The backend reads this table, not a constant. When Groq emails you a deprecation notice, you update one row, not a deployment.

### Which model does which job — carrying the two-tier design forward

This is the same split the prototype already uses (cheap model for structure, strong model for the plan), just pointed at real providers instead of one Claude call doing everything:

| Job | Model | Why |
|---|---|---|
| Router (classify intent, detect risk) | Groq, small (`llama-3.1-8b-instant` or whatever the current fast tier is) | Runs on every message; needs to be near-free |
| WhatsApp replies, grounded in Knowledge + Tools | Groq, mid (`gpt-oss-120b` class) | Fast enough for a live chat, strong enough to follow the grounding rules |
| "I'm stuck" help during a walkthrough | Groq, mid | Same as above — narrow, grounded, frequent |
| Voice transcription | Groq Whisper | Purpose-built, cheap |
| Building the plan from onboarding (Steps 1–4 in the current flow: customer options, angle options, context, workstream tailoring) | **Claude** (Sonnet, via the Anthropic API) | This is the one place quality genuinely matters more than speed — it happens once per business, not on every message, and it's the part you rewrote three times this week because a weaker model kept getting it wrong |
| Safety check before sending | Groq, small | Rule-checking, not creative writing — a small model is fine and it's on the critical path of every message |

Nudges and confirmations stay pre-written wherever possible (the walkthroughs already are), so they cost nothing at all — no model call, just a template fill.

---

## Part 3 — The knowledge base: Supabase, and why pgvector is enough

### You don't need a dedicated vector database

At the scale this actually runs at — thousands, even tens of thousands of businesses, a few dozen knowledge entries and a few dozen tools — a dedicated vector database (Pinecone, Weaviate) is solving a problem you don't have. **Postgres with the pgvector extension**, which Supabase gives you for free, is the right amount of infrastructure. It also means one database for everything: business data, plans, knowledge, and embeddings, queried together instead of stitched across two systems.

### Schema

```sql
-- one row per business
create table businesses (
  id uuid primary key default gen_random_uuid(),
  wa_id text unique not null,          -- WhatsApp phone ID, the actual session key
  country text not null default 'ZA',
  identity jsonb not null,             -- {name, sells, one_liner}
  context jsonb not null,              -- the full Business Context
  stage text not null,                 -- idea | start | run | grow
  customer jsonb,                      -- chosen customer(s), array
  angle jsonb,                         -- chosen angle(s), array
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table business_map (
  business_id uuid references businesses(id),
  domain text not null,                -- foundation, getting_paid, ...
  status text not null,                -- red | amber | green
  note text,
  updated_at timestamptz default now(),
  primary key (business_id, domain)
);

create table plans (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id),
  goal text,
  headline text,
  created_at timestamptz default now()
);

create table plan_steps (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid references plans(id),
  workstream_title text,
  step_order int,
  title text,
  push text,
  artifact text,
  tool_id text,
  status text default 'open',          -- open | done | skipped
  done_when text
);

create table decisions (
  business_id uuid references businesses(id),
  what text,
  source text,                          -- 'whatsapp' | 'connector'
  created_at timestamptz default now()
);

-- the research-once-interpret-many-times library
create extension if not exists vector;

create table knowledge_entries (
  id text primary key,                  -- 'k.deposits'
  country text not null,
  domain text,
  title text,
  owner_summary text,
  applies_when text,
  not_when text,
  steps text[],
  cost text,
  stakes text,                          -- low | medium | high
  verified_on date,
  embedding vector(1536)                -- for semantic retrieval once keyword matching runs out
);

create table tools (
  id text primary key,                  -- 'yoco'
  country text not null,
  domain text,
  name text,
  fits text,
  not_when text,
  why text,
  cost text,
  url text,
  setup text,
  walkthrough text[],
  verified_on date,
  embedding vector(1536)
);
```

### Retrieval: keep the keyword shortlist, add embeddings when it earns its place

The prototype's `shortlist()` function — score by keyword match, domain, stage, headache — works fine at 13 knowledge entries and 23 tools. It'll keep working at 50 and probably 150. The honest trigger for adding pgvector's semantic search isn't a number, it's a symptom: **when you notice a real owner question that should have matched an entry but didn't, because they phrased it in words the keyword list didn't anticipate.** That's the point to add `embedding <=> query_embedding` similarity search as a second pass after the keyword shortlist, not before. Don't build the fancier retrieval before you have evidence you need it.

### Freshness stays a first-class column, not an afterthought

The `verified_on` date and the 90-day staleness rule already in the prototype should be enforced in the database, not just in the prompt — a scheduled Supabase Edge Function that flags any entry past 90 days and excludes it from retrieval until it's re-checked, rather than trusting every prompt to remember to say "confirm at sign-up."

### Multi-country from day one

Every table above already has a `country` column. Adding Kenya was a data migration (new rows in `knowledge_entries` and `tools` with `country: 'KE'`), not a schema change or a new codebase. Uganda, the fifth market, confirmed it: no schema change, but a short code list a new market always needs (money forms, web suffix, plan-step ids, brand words) — see `docs/EXPERIENCE.md` §1.1.

---

## Part 4 — Build sequence

This is the order I'd actually do it in, with Claude Code driving most of it:

| Phase | What | Tool |
|---|---|---|
| 0 | Supabase schema (the tables above) | Claude Code, via the Supabase MCP connector — describe the schema, have it write and run the migration |
| 1 | Meta app + business verification submitted | You, manually — this is the slow clock, start it immediately |
| 2 | Webhook server: receive a message, echo it back | Claude Code — a small Node or Python service |
| 3 | Port the prototype's prompts, knowledge, and tools from the JS arrays into the Supabase tables | Claude Code — this is mostly data migration, not new logic |
| 4 | Wire Groq in for router + replies, Anthropic in for plan-building, both read from `model_config` | Claude Code |
| 5 | Interactive Messages (buttons, lists) replacing the prototype's chip UI | Claude Code |
| 6 | Templates submitted for nudges and check-ins | You, submit; Claude Code, implement once approved |
| 7 | Voice notes via Groq Whisper | Claude Code |
| 8 | The MCP connector for the owner's own AI | Claude Code |
| 9 | Load testing against the messaging tier limits, monitoring, the quarterly price-freshness job | Claude Code |

Phases 2–5 can run in the test-number sandbox while Phase 1's verification is still pending — you lose no time waiting on Meta.

---

## What this deliberately leaves out

- **A dedicated vector database.** Named above — not needed at this scale.
- **A BSP.** You have the technical capacity to go direct; paying a markup to avoid managing a webhook isn't worth it here.
- **Fine-tuning a model.** The two-tier design (grounded small model + occasional strong model) gets you most of the way there without the cost or maintenance of training your own weights. Revisit only once you have thousands of real logged conversations and a specific, measured gap that grounding alone doesn't close.
- **Building the connector before the core product works.** It's Phase 8 for a reason — an owner's own AI is only useful once there's a Business Context worth connecting it to.
