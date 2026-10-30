/*
# Charlie — alert levels that can come down (apply AFTER 0024)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once.

1. Why
0024's bump_incident kept the worst severity and the loudest alert an
incident had EVER had. So when the code decides a problem is quieter than it
first thought, the incident never hears it: round 19's
`delivery_failed:131026` (an undeliverable number — the recipient's side, now
an hourly warning) was stored as "immediate" and would have kept paging for
good. Now an incident takes the level of its latest occurrence once what came
before has been dealt with: emailed (nothing pending) or resolved. While
something louder is still waiting to be emailed it is never quietened — a
critical repeat is never lost to a warning that came after it.

2. The incidents round 19 filed wrongly, put right once
  - delivery_failed:131026  → warn, hourly (it was error, immediate)
  - "Error logged" lines that were not failures, resolved: the guardrail's own
    flags (safety[step_compliance] — it caught something, as designed), the
    log line of a delivery failure (delivery_failed is its record), the
    Meta number lookup on a health check; and Node's own runtime warning.
    The code no longer files any of these (PR "Round 19"), so resolving them
    does not hide anything that will happen again.
Only `incidents` is touched; no owner data.
*/

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
    -- Nothing pending (emailed, or resolved): this occurrence's own level.
    -- Something pending: the worst of the two, so it is never quietened.
    severity = CASE
      WHEN i.resolved_at IS NOT NULL OR i.since_email = 0 THEN EXCLUDED.severity
      WHEN array_position(ARRAY['info','warn','error','critical'], EXCLUDED.severity) > array_position(ARRAY['info','warn','error','critical'], i.severity) THEN EXCLUDED.severity
      ELSE i.severity END,
    alert = CASE
      WHEN i.resolved_at IS NOT NULL OR i.since_email = 0 THEN EXCLUDED.alert
      WHEN EXCLUDED.alert = 'immediate' OR i.alert = 'immediate' THEN 'immediate'
      WHEN EXCLUDED.alert = 'digest' OR i.alert = 'digest' THEN 'digest'
      ELSE 'none' END,
    summary = left(EXCLUDED.summary, 500),
    last_props = EXCLUDED.last_props,
    resolved_at = NULL;
$$;

REVOKE ALL ON FUNCTION public.bump_incident(text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

UPDATE public.incidents
   SET alert = 'digest', severity = 'warn'
 WHERE fingerprint = 'delivery_failed:131026'
   AND alert = 'immediate';

UPDATE public.incidents
   SET resolved_at = now(), since_email = 0
 WHERE resolved_at IS NULL
   AND (
        (name = 'log_error' AND (
              summary LIKE 'Error logged: safety[step_compliance] flags%'
           OR summary LIKE 'Error logged: wa delivery failed%'
           OR summary LIKE 'Error logged: wa-number%'))
     OR (name = 'log_warning' AND summary LIKE 'Warning logged: (node:%')
   );
