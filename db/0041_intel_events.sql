/*
# Charles — Chase Intelligence: every task, recorded whole (apply AFTER 0040)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once.

1. What this does, in plain terms
api/_lib/intel.ts records everything a task did, in order, under one id:
what a person sent, everything each model call was shown and what it
answered, every guardrail check, every WhatsApp delivery, every call the
person's own AI made, every queued job, and every product event. It is the
shared Chase Intelligence contract (docs/INTEL-CONTRACT.md), so every Chase
repository's rows add up to one dataset. INTEL_CAPTURE (full | meta | off)
turns it down without touching anything else.

2. The events table's timer stops losing anything
events keeps routine rows 180 days and the rest 365 (alerts.ts). Every row
already in it is copied here once (source_ref = 'events:<id>', so a second
run copies nothing twice), and every new one arrives here as it happens.

3. Locked like every other person table
RLS on, no policies, no grants to the public keys: only the backend's service
role reads or writes. Secrets and identifiers are removed in code before a row
is written (api/_lib/intelredact.ts). "Forget my money" deletes every row
about the person and every task they were in (intel.ts forgetIntel).
*/

CREATE TABLE IF NOT EXISTS public.intel_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  seq bigint NOT NULL DEFAULT 0,
  app text NOT NULL,
  v smallint NOT NULL DEFAULT 1,
  trace_id text NOT NULL,
  turn_id text,
  job_id bigint,
  business_id uuid,
  channel text,
  stage text,
  kind text NOT NULL CHECK (kind IN ('ask', 'say', 'model', 'check', 'tool', 'send', 'job', 'track', 'error')),
  name text NOT NULL,
  actor text NOT NULL CHECK (actor IN ('person', 'app', 'model', 'system', 'their_ai')),
  ok boolean,
  ms integer,
  content_mode text NOT NULL DEFAULT 'full' CHECK (content_mode IN ('full', 'meta')),
  content jsonb,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_ref text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS intel_events_trace_idx ON public.intel_events (trace_id, at, seq);
CREATE INDEX IF NOT EXISTS intel_events_business_idx ON public.intel_events (business_id);
CREATE INDEX IF NOT EXISTS intel_events_at_idx ON public.intel_events (at);
CREATE INDEX IF NOT EXISTS intel_events_kind_idx ON public.intel_events (kind, name);

-- Every product event recorded before capture began, saved from the timer.
INSERT INTO public.intel_events (at, app, v, trace_id, turn_id, job_id, business_id, channel, stage, kind, name, actor, ok, ms, content_mode, content, meta, source_ref)
SELECT e.at, 'charles', 1,
       coalesce(e.turn_id, CASE WHEN e.job_id IS NOT NULL THEN 'job_' || e.job_id END, 'event_' || e.id),
       e.turn_id, e.job_id, e.business_id, e.channel, e.stage,
       CASE WHEN e.category = 'failure' THEN 'error' ELSE 'track' END,
       e.name, 'system',
       CASE WHEN e.category = 'failure' THEN false END,
       e.ms, 'full',
       jsonb_build_object('props', coalesce(e.props, '{}'::jsonb), 'said', e.excerpt),
       jsonb_build_object('category', e.category, 'severity', e.severity, 'country', e.country, 'internal', e.internal, 'backfilled', true),
       'events:' || e.id
FROM public.events e
ON CONFLICT (source_ref) DO NOTHING;

ALTER TABLE public.intel_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_events FROM anon, authenticated;

COMMENT ON TABLE public.intel_events IS 'Chase Intelligence: every task recorded whole, in order, under one trace id (api/_lib/intel.ts, docs/INTEL-CONTRACT.md). Service role only; redacted before write; deleted with the person.';
