/*
# Charlie — the platform tables (apply AFTER 0001–0004)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once.

1. What this does, in plain terms
Everything the webhook needed but did not have:
- jobs          — a work queue. WhatsApp gets its "received" in under a second;
                  the slow work (models, PDFs) happens after, in a worker.
- wa_inbound    — every WhatsApp message id we have already handled, so Meta's
                  automatic retries can never build a second plan.
- safety_events — every guardrail check that ran, and whether it actually ran.
                  A guardrail that is quietly switched off is now impossible to
                  miss: it writes an 'unavailable' row.
- retrieval_gaps— questions the keyword search could not match. This is the
                  evidence that decides whether semantic search is ever worth
                  turning on.
- commitments / outcomes — what the owner said they would do, and what happened.
- nudges / wa_templates  — the follow-up messages and their approved templates.
- connector_tokens       — lets the owner's own AI (Claude, ChatGPT) read their
                  business, one revocable token each.
- plan_access_codes / plan_sessions — logging in to see the plan on the website,
                  using the owner's WhatsApp number as the identity.
- proposed_changes       — when the owner's AI suggests changing a critical fact,
                  it never silently edits the plan; it waits for a yes on WhatsApp.

2. Security
Every table here is owner data: RLS enabled, no policies, so only the backend
(service role) can read or write. Same lockdown as 0001.
*/

-- ── The work queue ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,                              -- inbound | nudge | freshness
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  wa_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued',           -- queued | running | done | failed | dead
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON public.jobs (status, run_after, id);
CREATE INDEX IF NOT EXISTS jobs_business_idx ON public.jobs (business_id, created_at DESC);

/*
Claiming a job has to be atomic: two worker instances can wake at the same
moment and must never get the same row. FOR UPDATE SKIP LOCKED is the standard
Postgres answer — the second worker skips the locked row instead of blocking on
it. The CTE form is used rather than a scalar subquery so the row the lock was
taken on is provably the row that gets updated.

A 'running' job whose lock is older than 5 minutes is treated as abandoned —
the function crashed, or the platform killed it at its timeout — and becomes
claimable again. Five minutes is chosen to match the longest maxDuration any
function in vercel.json is given, so a job can never be reclaimed while it is
still legitimately running.

Note this claims a job, not an OWNER. Two messages from the same person are
both claimable; the worker holds the second one back itself (see
otherJobRunningFor in api/_lib/db.ts), because interleaving two turns of one
conversation makes it jump backwards in front of a real person.
*/
CREATE OR REPLACE FUNCTION public.claim_job(p_worker text)
RETURNS SETOF public.jobs
LANGUAGE sql
AS $$
  WITH picked AS (
    SELECT id
      FROM public.jobs
     WHERE (status = 'queued'  AND run_after <= now())
        OR (status = 'running' AND locked_at < now() - interval '5 minutes')
     ORDER BY run_after, id
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  UPDATE public.jobs j
     SET status     = 'running',
         locked_at  = now(),
         locked_by  = p_worker,
         attempts   = j.attempts + 1,
         updated_at = now()
    FROM picked
   WHERE j.id = picked.id
  RETURNING j.*;
$$;

-- ── Meta redelivers. Handle each message exactly once. ───────────
CREATE TABLE IF NOT EXISTS public.wa_inbound (
  wa_message_id text PRIMARY KEY,
  wa_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- ── Message log: richer, and now written in BOTH directions ──────
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS kind text DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS wa_message_id text,
  ADD COLUMN IF NOT EXISTS meta jsonb DEFAULT '{}'::jsonb;

-- ── Guardrails that can be audited ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.safety_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  check_name text NOT NULL,          -- distress | step_compliance | question_gate | selection | map_score
  engine text NOT NULL,              -- jev | model | none
  outcome text NOT NULL,             -- pass | flag | block | unavailable
  score numeric,
  flags text[],
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS safety_events_recent_idx ON public.safety_events (created_at DESC);
CREATE INDEX IF NOT EXISTS safety_events_outcome_idx ON public.safety_events (outcome, created_at DESC);

-- ── Evidence for whether semantic search is ever needed ──────────
CREATE TABLE IF NOT EXISTS public.retrieval_gaps (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  country text,
  query text NOT NULL,
  domain text,
  top_score numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS retrieval_gaps_recent_idx ON public.retrieval_gaps (created_at DESC);

-- ── Follow-through ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  plan_step_id uuid REFERENCES public.plan_steps(id) ON DELETE SET NULL,
  what text NOT NULL,
  due date,
  status text NOT NULL DEFAULT 'open',   -- open | done | stuck | dropped
  source text NOT NULL DEFAULT 'whatsapp',
  nudged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commitments_open_idx ON public.commitments (business_id, status, due);

CREATE TABLE IF NOT EXISTS public.outcomes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  plan_step_id uuid REFERENCES public.plan_steps(id) ON DELETE SET NULL,
  what text,
  effect text,                            -- better | same | worse | too_early
  source text NOT NULL DEFAULT 'whatsapp',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- `decisions` predates this build and had no primary key or reason column.
ALTER TABLE public.decisions
  ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS why text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- ── Nudges, and the templates Meta has to approve first ──────────
CREATE TABLE IF NOT EXISTS public.wa_templates (
  id text PRIMARY KEY,                    -- our id, e.g. 'commitment_check'
  meta_name text,                         -- the name registered with Meta
  language text NOT NULL DEFAULT 'en',
  category text NOT NULL DEFAULT 'UTILITY',
  body text NOT NULL,
  variables text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft',   -- draft | submitted | approved | rejected
  approved_on date,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.nudges (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  template_id text,
  variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  status text NOT NULL DEFAULT 'sent',    -- sent | skipped | failed
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nudges_business_idx ON public.nudges (business_id, sent_at DESC);

-- ── The owner's own AI ───────────────────────────────────────────
-- Only the hash is stored: a leaked database row cannot be replayed as a token.
CREATE TABLE IF NOT EXISTS public.connector_tokens (
  token_hash text PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS connector_tokens_business_idx ON public.connector_tokens (business_id);

CREATE TABLE IF NOT EXISTS public.proposed_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  fact text NOT NULL,
  from_value text,
  to_value text,
  reason text,
  status text NOT NULL DEFAULT 'pending', -- pending | accepted | rejected | expired
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS proposed_changes_pending_idx ON public.proposed_changes (business_id, status);

-- ── Seeing your plan on the website ──────────────────────────────
-- The owner's WhatsApp number is the identity; the one-time code arrives on
-- WhatsApp, so only someone holding that phone can log in. Hashes only.
CREATE TABLE IF NOT EXISTS public.plan_access_codes (
  wa_id text PRIMARY KEY,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.plan_sessions (
  token_hash text PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Columns the rest of the build needs ──────────────────────────
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS language text DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS nudge_prefs jsonb DEFAULT '{"day":"monday","hour":7,"max_per_week":2}'::jsonb,
  ADD COLUMN IF NOT EXISTS paused boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_outbound_at timestamptz,
  ADD COLUMN IF NOT EXISTS pending_action jsonb,
  ADD COLUMN IF NOT EXISTS walk jsonb,
  ADD COLUMN IF NOT EXISTS baseline_tier text,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE public.plan_steps
  ADD COLUMN IF NOT EXISTS pushed_at timestamptz,
  ADD COLUMN IF NOT EXISTS done_at timestamptz,
  ADD COLUMN IF NOT EXISTS skipped_reason text,
  ADD COLUMN IF NOT EXISTS step_key text;      -- the fixed library id, e.g. 'o2'

-- model_config: a role can now name its own ordered fallbacks, so a deprecated
-- model is one UPDATE away from fixed instead of a redeploy.
ALTER TABLE public.model_config
  ADD COLUMN IF NOT EXISTS fallbacks text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notes text;

-- The seeded voice row used "groq/whisper-large-v3", which is not how
-- OpenRouter namespaces Whisper (groq is a provider that serves the model, not
-- the slug namespace). A wrong slug surfaces as a 400 on the first voice note,
-- not at deploy time. OpenRouter proxies an OpenAI-shaped transcription
-- endpoint, so voice needs no second account and no second key.
--   Transcription models are hidden from the default catalogue; list them with
--   https://openrouter.ai/api/v1/models?output_modalities=transcription
-- To move voice to Groq or OpenAI later (cheaper per hour, and the only way to
-- get per-segment confidence back), change provider and model on this one row.
UPDATE public.model_config
   SET provider = 'openrouter',
       model = 'openai/whisper-1',
       notes = 'Transcription via OpenRouter /audio/transcriptions. Set provider to groq or openai (with GROQ_API_KEY / OPENAI_API_KEY) to route direct.'
 WHERE role = 'voice' AND model = 'groq/whisper-large-v3';

-- The safety role did not exist before: the P10 check had no model to run on.
INSERT INTO public.model_config (role, provider, model, params, notes) VALUES
  ('safety', 'openrouter', 'google/gemma-4-31b-it:free', '{"max_tokens": 400, "temperature": 0}'::jsonb,
   'Backstop for the guardrails when Jev is unavailable. Small and strict; never writes owner-facing prose.')
ON CONFLICT (role) DO NOTHING;

-- ── Lock every new table ─────────────────────────────────────────
ALTER TABLE public.jobs              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_inbound        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.safety_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retrieval_gaps    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commitments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outcomes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nudges            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_templates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_tokens  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proposed_changes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_access_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_sessions     ENABLE ROW LEVEL SECURITY;

-- claim_job runs as the caller (service role). Nobody else may execute it.
REVOKE ALL ON FUNCTION public.claim_job(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_job(text) FROM anon, authenticated;
