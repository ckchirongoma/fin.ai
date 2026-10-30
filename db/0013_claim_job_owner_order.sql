/*
# Charlie — claim_job() must never skip over an earlier job for the same owner

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once.

1. What was actually wrong (PRIORITY 0, live-verified 2026-09-22)
`claim_job()` (db/0005) picked the globally earliest eligible row by
`(run_after, id)`, with NO awareness of `wa_id` at all. Per-owner exclusion was
bolted on AFTER the claim, in application code (api/_lib/queue.ts's
otherJobRunningFor + holdJob): a worker claimed a job, THEN asked "is another
job for this owner already running?", and if so put it straight back with
`run_after = now() + 5s`.

That after-the-fact hold is what actually produced the bug. A live burst of
four messages 2-3s apart (jobs 59-62 for one wa_id) was claimed in the order
59 -> 61 -> 62 -> 60: job 60 kept losing the claim race, got held, and every
hold pushed its `run_after` five seconds into the future — which is often
LATER than a message the owner hadn't even sent yet when 60 was first held.
Once 61 and 62 existed with their own (earlier, untouched) `run_after`, they
sorted ahead of 60's repeatedly-postponed one, and 60 was claimed dead last.
The "done" tap's own handler was fine (proven separately, live, with real
pauses between messages) — the ordering was corrupted before it ever ran.

The same after-the-claim check also has a TOCTOU race: two workers can each
claim a DIFFERENT job for the SAME owner within milliseconds of each other,
and each one's "is anyone else running?" query can run before the other's
claim has committed, so BOTH proceed unheld. That is a second, independent way
for two messages from one owner to be handled concurrently, which is very
likely the root cause of two other bugs found the same day: a diagnostic
answer landing under the wrong key when a later message raced an earlier one's
read-modify-write, and a duplicate "That's right / Not quite" identity
read-back sent by two concurrent handlers.

2. The fix
Move the per-owner ordering INTO the same atomic statement that claims the
job, instead of checking it afterwards from a second, separate query. A job is
now only eligible to be claimed at all when no EARLIER job (by id) for the
same wa_id is still `queued`, `running` or `failed`. Under Postgres's default
READ COMMITTED isolation, an uncommitted status change made by a concurrent
claim is invisible to this check until it actually commits — so two workers
racing for the same owner's jobs cannot both conclude "nothing else is
pending" at once, and a job can never be handed out ahead of an older one for
its own owner, however the claim attempts are timed or ordered.

`otherJobRunningFor` / `holdJob` in api/_lib/queue.ts are kept as a harmless,
now-redundant safety net (see the comment above their use) rather than
removed, since this migration is the thing that actually has to land in
production for the fix to take effect.

3. Verify it worked
  select id, wa_id, status, locked_at from public.jobs where wa_id = '<a real
  wa_id>' order by id; -- locked_at should only ever advance in id order.
*/

CREATE OR REPLACE FUNCTION public.claim_job(p_worker text)
RETURNS SETOF public.jobs
LANGUAGE plpgsql
AS $$
DECLARE
  v_id bigint;
BEGIN
  SELECT j.id
    INTO v_id
    FROM public.jobs j
   WHERE (
           (j.status = 'queued'  AND j.run_after <= now())
        OR (j.status = 'running' AND j.locked_at < now() - interval '5 minutes')
         )
     AND (
           j.wa_id IS NULL
           -- Strict creation order, per owner: a job is claimable only when no
           -- STILL-PENDING earlier job (lower id) exists for the same wa_id.
           -- 'failed' is included defensively — nothing in this codebase sets
           -- it today (a failed attempt goes back to 'queued' with backoff, or
           -- to 'dead' once max_attempts is hit), but a job in that state has
           -- not finished either, and must not be skipped over any more than
           -- a 'queued' or 'running' one.
        OR NOT EXISTS (
             SELECT 1
               FROM public.jobs o
              WHERE o.wa_id = j.wa_id
                AND o.id < j.id
                AND o.status IN ('queued', 'running', 'failed')
           )
         )
   ORDER BY j.run_after, j.id
   FOR UPDATE OF j SKIP LOCKED
   LIMIT 1;

  IF v_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.jobs j
     SET status     = 'running',
         locked_at  = now(),
         locked_by  = p_worker,
         attempts   = j.attempts + 1,
         updated_at = now()
   WHERE j.id = v_id
  RETURNING j.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_job(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_job(text) FROM anon, authenticated;

-- Speeds the per-owner NOT EXISTS check above: without it, every claim scans
-- every other queued/running job for a busy owner instead of an index range.
CREATE INDEX IF NOT EXISTS jobs_owner_order_idx ON public.jobs (wa_id, id) WHERE wa_id IS NOT NULL;
