/*
# Charlie — resumable plan builds (apply AFTER 0001–0011)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once.

1. What this does, in plain terms
Before this, building a 90-day plan was one function call doing five or six
model calls back to back — context, a module audit, a strategy, and one call
per part of the plan — inside a single job that a single Vercel invocation
had to finish inside its own timeout. A stuck or slow call anywhere in that
chain meant the whole thing had to be retried from the top, and the owner's
`stage` sat on "building_plan" with nothing behind it to show for however
long that took.

`plan_builds` is the durable memory of how far a build has actually got.
Each phase (context, then strategy + the plan's parts together, then
writing the plan to the database, then the PDF) now runs as its own short
job, and writes what it produced here before the next phase is even
enqueued. A crash or a Vercel timeout loses at most one phase's work, not
the whole build — the next attempt picks up from `stage`, not from zero.

2. Why heartbeat_at, not the jobs table's own 5-minute reclaim
`claim_job()` reclaims an abandoned 'running' job after 5 minutes — sized to
the longest function timeout in vercel.json, because a job legitimately
running the OLD, monolithic build really could take that long. A single
*stage* here is one or two model calls: if a stage job's heartbeat has gone
quiet for even 90 seconds, something has actually gone wrong, and the
opportunistic sweep in api/_lib/queue.ts re-enqueues that phase rather than
waiting minutes to notice.

3. Security
Owner data: RLS enabled, no policies — service role only, same as every
table in db/0005.
*/

CREATE TABLE IF NOT EXISTS public.plan_builds (
  business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  stage text NOT NULL DEFAULT 'context',   -- context | building | finalize | pdf | done | failed
  goal text,
  context jsonb,
  map jsonb,
  dropped_modules text[] NOT NULL DEFAULT '{}',
  strategy jsonb,
  strategy_done boolean NOT NULL DEFAULT false,
  workstreams jsonb NOT NULL DEFAULT '[]'::jsonb,
  pending_workstreams text[] NOT NULL DEFAULT '{}',
  plan_id uuid REFERENCES public.plans(id) ON DELETE SET NULL,
  last_error text,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plan_builds_stale_idx ON public.plan_builds (stage, heartbeat_at);

ALTER TABLE public.plan_builds ENABLE ROW LEVEL SECURITY;
