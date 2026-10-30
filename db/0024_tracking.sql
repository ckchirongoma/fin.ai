/*
# Charlie — tracking: what owners do, how the platform performs, and every failure (apply AFTER 0023)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once. Code does not depend on it to keep working: until it runs, every
tracking write fails quietly (one console line) and the product carries on.

1. What this is
  - events         one row per thing that happened: an owner's tap, a stage
                   entered, a question answered or not, a model call and how
                   long it took, a WhatsApp send that failed, a job retried,
                   anything logged as an error. api/_lib/track.ts writes it.
  - incidents      one row per distinct problem (a fingerprint), counted:
                   first seen, last seen, how many times, when it was last
                   emailed. The per-minute tick (queue.ts cronTick → alerts.ts)
                   reads it to decide what to email, so one broken thing is one
                   email, not one per minute.
  - alert_state    when each kind of email last went out (rate limits).
  - event_daily    a daily count per event name, kept after events are pruned.

2. Privacy — "forget my business" stays true
An event's business_id and its `excerpt` (at most 200 characters of what the
owner said, phone numbers and links already stripped by the code) are the
only owner data here. When a business is deleted, the trigger below wipes
both from every one of its events BEFORE the row goes, so what is left is
anonymous: an event name, a stage, a time, a number. That keeps the funnel
honest (an owner who leaves still counts as someone who left) without keeping
anything they asked us to forget. api/_lib/db.ts forgetBusiness does the same
scrub explicitly as well, belt and braces, like every other table.
No raw phone number is ever stored here: `internal` marks the founder's and
the testers' own numbers (env INTERNAL_WA_IDS) so they stay out of the funnel.
RLS on, no policies, revoked from anon and authenticated: backend only.

3. Size
Info-level events are pruned after 180 days by the daily pass (alerts.ts);
warn and above are kept a year. event_daily keeps the counts for good.
*/

CREATE TABLE IF NOT EXISTS public.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('behaviour', 'funnel', 'performance', 'failure', 'unmet_request', 'security', 'ops')),
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warn', 'error', 'critical')),
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  channel text CHECK (channel IN ('whatsapp', 'web', 'mcp', 'system')),
  country text,
  stage text,
  turn_id text,
  job_id bigint,
  ms bigint,
  props jsonb NOT NULL DEFAULT '{}'::jsonb,
  excerpt text CHECK (excerpt IS NULL OR length(excerpt) <= 200),
  fingerprint text,
  internal boolean NOT NULL DEFAULT false
);

-- int4 in the first draft: a long gap in ms overflows it and loses the batch.
ALTER TABLE public.events ALTER COLUMN ms TYPE bigint;

CREATE INDEX IF NOT EXISTS events_at_idx ON public.events (at DESC);
CREATE INDEX IF NOT EXISTS events_name_at_idx ON public.events (name, at DESC);
CREATE INDEX IF NOT EXISTS events_business_at_idx ON public.events (business_id, at DESC);
CREATE INDEX IF NOT EXISTS events_problems_idx ON public.events (at DESC) WHERE severity IN ('error', 'critical') OR category IN ('failure', 'unmet_request');

COMMENT ON TABLE public.events IS
  'Everything that happened: owner behaviour, funnel, performance, failures, unmet requests. Written by api/_lib/track.ts. Anonymised (business_id and excerpt cleared) when a business is forgotten.';

CREATE TABLE IF NOT EXISTS public.incidents (
  fingerprint text PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warn', 'error', 'critical')),
  alert text NOT NULL DEFAULT 'digest' CHECK (alert IN ('none', 'digest', 'immediate')),
  summary text NOT NULL DEFAULT '',
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  count integer NOT NULL DEFAULT 1,
  since_email integer NOT NULL DEFAULT 1,
  last_props jsonb NOT NULL DEFAULT '{}'::jsonb,
  emailed_at timestamptz,
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS incidents_pending_idx ON public.incidents (last_seen DESC) WHERE since_email > 0;

COMMENT ON TABLE public.incidents IS
  'One row per distinct problem, counted. Read every minute by alerts.ts to decide what to email. Never holds owner text or phone numbers.';

-- One atomic upsert-and-count, so two workers reporting the same problem in
-- the same second add up instead of overwriting each other.
CREATE OR REPLACE FUNCTION public.bump_incident(
  p_fingerprint text,
  p_name text,
  p_category text,
  p_severity text,
  p_alert text,
  p_summary text,
  p_props jsonb
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.incidents AS i (fingerprint, name, category, severity, alert, summary, last_props)
  VALUES (p_fingerprint, p_name, p_category, p_severity, p_alert, left(p_summary, 500), coalesce(p_props, '{}'::jsonb))
  ON CONFLICT (fingerprint) DO UPDATE SET
    last_seen = now(),
    count = i.count + 1,
    since_email = i.since_email + 1,
    -- The worst it has ever been, so one critical repeat is never downgraded.
    severity = CASE
      WHEN array_position(ARRAY['info','warn','error','critical'], EXCLUDED.severity) > array_position(ARRAY['info','warn','error','critical'], i.severity) THEN EXCLUDED.severity
      ELSE i.severity END,
    alert = CASE WHEN EXCLUDED.alert = 'immediate' OR i.alert = 'immediate' THEN 'immediate' WHEN EXCLUDED.alert = 'digest' OR i.alert = 'digest' THEN 'digest' ELSE 'none' END,
    summary = left(EXCLUDED.summary, 500),
    last_props = EXCLUDED.last_props,
    resolved_at = NULL;
$$;

-- What an email carried is taken off, not zeroed: a repeat counted while the
-- email was being sent is still waiting for the next one.
CREATE OR REPLACE FUNCTION public.mark_incident_emailed(p_fingerprint text, p_sent integer, p_at timestamptz) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.incidents SET emailed_at = p_at, since_email = GREATEST(since_email - p_sent, 0) WHERE fingerprint = p_fingerprint;
$$;

CREATE TABLE IF NOT EXISTS public.alert_state (
  key text PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  detail text
);

CREATE TABLE IF NOT EXISTS public.event_daily (
  day date NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  internal boolean NOT NULL DEFAULT false,
  count integer NOT NULL,
  businesses integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name, internal)
);

-- One UTC day's counts per event name, counted in the database whatever the
-- day's size, so nothing is lost when its events are pruned. Re-runnable.
CREATE OR REPLACE FUNCTION public.rollup_event_day(p_day date) RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH r AS (
    INSERT INTO public.event_daily (day, name, category, internal, count, businesses)
    SELECT p_day, name, min(category), internal, count(*)::int, count(DISTINCT business_id)::int
    FROM public.events
    WHERE at >= (p_day::timestamp AT TIME ZONE 'UTC') AND at < ((p_day + 1)::timestamp AT TIME ZONE 'UTC')
    GROUP BY name, internal
    ON CONFLICT (day, name, internal) DO UPDATE SET count = EXCLUDED.count, businesses = EXCLUDED.businesses, category = EXCLUDED.category
    RETURNING 1
  )
  SELECT count(*)::int FROM r;
$$;

COMMENT ON TABLE public.event_daily IS 'Daily counts per event name, rolled up by alerts.ts before events are pruned. Nothing identifying.';

-- "forget my business": wipe the owner's words and the link to them from
-- their events before the business row is deleted (the FK then has nothing
-- left to set null). db.ts forgetBusiness does the same explicitly.
CREATE OR REPLACE FUNCTION public.scrub_events_on_forget() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.events SET business_id = NULL, excerpt = NULL, turn_id = NULL WHERE business_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS scrub_events_on_forget ON public.businesses;
CREATE TRIGGER scrub_events_on_forget BEFORE DELETE ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.scrub_events_on_forget();

-- Done and dead inbound jobs kept the owner's phone number and words in
-- payload after a forget (forgetBusiness only cleared queued ones). The code
-- now deletes every one that is not running, and the forget request's own
-- (running) job has its number and payload cleared once the forget succeeds.

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.events FROM anon, authenticated;
REVOKE ALL ON public.incidents FROM anon, authenticated;
REVOKE ALL ON public.alert_state FROM anon, authenticated;
REVOKE ALL ON public.event_daily FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_incident(text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.scrub_events_on_forget() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_incident_emailed(text, integer, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rollup_event_day(date) FROM PUBLIC, anon, authenticated;
