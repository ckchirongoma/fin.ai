/*
# Charlie — plan-building flow state (apply AFTER 0001, 0002, 0003)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run
more than once.

1. What this does, in plain terms
The diagnostic used to end with just "Got it". This adds the columns the
rest of the flow needs to run end to end: confirming what the business
actually is, choosing who to aim at, choosing the angle, and the context
+ map the plan gets built from. Also widens `plans` / `plan_steps` (created
before Claude Code touched this project) with the columns the new plan
builder writes.

2. Security
Same as the rest of `businesses`, `plans` and `plan_steps`: RLS already
enabled with no public policies, so only the backend (service role) can
read or write these columns.
*/

-- `stage` already means the conversation-flow stage (diag, diag_done, ...) in
-- the existing schema — `biz_stage` is the separate business-lifecycle stage
-- (idea | start | run | grow) the plan builder needs, kept in its own column
-- rather than overloading `stage` with two different meanings.
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS biz_stage text,
  ADD COLUMN IF NOT EXISTS identity jsonb,
  ADD COLUMN IF NOT EXISTS signals jsonb,
  ADD COLUMN IF NOT EXISTS objective_read text,
  ADD COLUMN IF NOT EXISTS pending_customer_options jsonb,
  ADD COLUMN IF NOT EXISTS customer jsonb,
  ADD COLUMN IF NOT EXISTS pending_angle_options jsonb,
  ADD COLUMN IF NOT EXISTS angle jsonb,
  ADD COLUMN IF NOT EXISTS alternatives jsonb,
  ADD COLUMN IF NOT EXISTS context jsonb,
  ADD COLUMN IF NOT EXISTS map jsonb,
  ADD COLUMN IF NOT EXISTS current_plan_id uuid;

ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS headline text;

ALTER TABLE public.plan_steps
  ADD COLUMN IF NOT EXISTS domain text,
  ADD COLUMN IF NOT EXISTS why_for_you text,
  ADD COLUMN IF NOT EXISTS artifact text,
  ADD COLUMN IF NOT EXISTS done_when text;
