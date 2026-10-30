/*
# Fin — the money journey's columns (from Charlie's business journey)

Apply in Supabase → SQL Editor → New query → paste → Run.
Run AFTER 0032. Safe to run more than once.

1. What this does, in plain terms
Fin is built from Charlie. The tables keep their names (a `businesses` row is
one household's money; `business_map` is the Money Map; `owner_notes` is what
Fin remembers about the person), because renaming every table buys nothing
and risks a lot. Four columns change meaning enough to deserve their new
names, and the code reads the new ones:

  pending_customer_options → pending_goal_options   (the goals offered)
  customer                 → goal                   (the goal(s) chosen)
  pending_angle_options    → pending_rule_options   (the rules offered)
  angle                    → rule                   (the rule(s) chosen)

`biz_stage` now holds the money stage: surviving | stretching | steady |
building. `business_map.domain` and `plan_steps.domain` now hold the eight
money areas: income, spending, debt, cushion, credit_record, protection,
family_money, goals. Neither column was ever constrained, so no constraint
changes.

2. Existing rows
A fresh project has none. On a project that ran Charlie, rows built for a
business are meaningless to Fin: delete them (or the whole project) before
pointing Fin at it. This script only renames; it never deletes.

3. Security
Nothing changes: RLS stays on, backend-only, as 0001 set it.
*/

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'businesses' AND column_name = 'pending_customer_options')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'businesses' AND column_name = 'pending_goal_options') THEN
    ALTER TABLE public.businesses RENAME COLUMN pending_customer_options TO pending_goal_options;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'businesses' AND column_name = 'customer')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'businesses' AND column_name = 'goal') THEN
    ALTER TABLE public.businesses RENAME COLUMN customer TO goal;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'businesses' AND column_name = 'pending_angle_options')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'businesses' AND column_name = 'pending_rule_options') THEN
    ALTER TABLE public.businesses RENAME COLUMN pending_angle_options TO pending_rule_options;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'businesses' AND column_name = 'angle')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'businesses' AND column_name = 'rule') THEN
    ALTER TABLE public.businesses RENAME COLUMN angle TO rule;
  END IF;
END $$;

-- A project that never ran Charlie (0004 applied after this file was written) gets the new names directly.
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS pending_goal_options jsonb,
  ADD COLUMN IF NOT EXISTS goal jsonb,
  ADD COLUMN IF NOT EXISTS pending_rule_options jsonb,
  ADD COLUMN IF NOT EXISTS rule jsonb;

COMMENT ON COLUMN public.businesses.biz_stage IS 'Money stage: surviving | stretching | steady | building';
COMMENT ON COLUMN public.businesses.goal IS 'The goal(s) the person chose (GoalOption[])';
COMMENT ON COLUMN public.businesses.rule IS 'The one money rule they chose to live by (RuleOption[])';
COMMENT ON TABLE public.businesses IS 'One row per household (one WhatsApp number). Named businesses because Fin is built from Charlie; see db/0033.';
COMMENT ON TABLE public.business_map IS 'The Money Map: eight areas (income, spending, debt, cushion, credit_record, protection, family_money, goals), red/amber/green.';
COMMENT ON TABLE public.owner_notes IS 'What Fin remembers about the person, in their words.';
