/*
# Charlie — the strategy document (apply AFTER 0007)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once.

1. What this adds, in plain terms
The plan document was a list of steps with a map stapled to the front. Real
feedback: no depth. An owner — and a funder they show it to — needs three
things in one document: where the business stands today, the strategy (who we
serve, why they choose us, how we win, what we deliberately won't do, the
money logic in the owner's own numbers), and only THEN the 90 days of steps.

The steps stay exactly what they were: assembled from the fixed library,
never freestyled (rule 1). The strategy is prose, not structure, so the model
may write it — grounded in the diagnostic, the chosen customer and angle, and
the verified library, and checked by the same guardrails as everything else
before it is stored.

2. Why a column on `plans` rather than its own table
The strategy is written once, with the plan, from the same evidence, and is
meaningless without it. One row, one document.
*/

ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS strategy jsonb;

COMMENT ON COLUMN public.plans.strategy IS
  'The narrative two-thirds of the plan document: reading of the business, what is working and leaking, how we win, what we will not do, the money logic in the owner''s own numbers, milestones at day 30/60/90, and risks with responses. Written by the plan_builder model, grounded and compliance-checked. Null on plans built before this existed — the document renders without it.';
