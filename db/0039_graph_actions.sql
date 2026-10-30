/*
# Charles — the actions the knowledge graph triggers, once each (apply AFTER 0038)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once. Until it runs, the graph triggers nothing: without a ledger it
cannot promise "once", so it sends nothing.

1. What this does, in plain terms
api/_lib/graphactions.ts acts when a household's graph changes in a way that
matters: a debt paid off (send the freed payment to savings), a new
mashonisa (what they can do, when it is gone), a repayment that went up, money
to family up by a fifth, two funeral policies, a new stokvel, a new saving
habit. Each is sent once: this ledger keys it on the trigger and the thing
(and the new amount, when the news is an amount). At most one a turn, none
within six hours of the last, none in hardship mode.

2. Locked like every other person-data table
RLS on, no policies: only the backend's service role reads or writes it.
"Forget my money" deletes it with the household.
*/

CREATE TABLE IF NOT EXISTS public.kg_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('debt_paid_off', 'new_mashonisa', 'repayment_up', 'support_up', 'double_cover', 'joined_stokvel', 'started_saving')),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 120),
  fired_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, trigger, subject)
);

CREATE INDEX IF NOT EXISTS kg_triggers_business_idx ON public.kg_triggers (business_id, fired_at DESC);

ALTER TABLE public.kg_triggers ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.kg_triggers IS 'The actions the household knowledge graph has triggered, once each (api/_lib/graphactions.ts). Service role only; deleted with the household.';

REVOKE ALL ON public.kg_triggers FROM anon, authenticated;
