/*
# Charlie — make "forget my business" actually possible (apply AFTER 0005, 0006)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once.

1. What this fixes, in plain terms
An owner can send "forget my business" and everything about them is deleted.
That promise is in the product and it is a POPIA obligation. But `wa_id` is
UNIQUE on `businesses`, so anything short of removing the row leaves that
phone number permanently taken — and the owner who changes their mind a week
later cannot come back, because creating their business fails on a constraint
they can neither see nor clear.

So the deletion has to be a real one. These tables were created before the
rest of the schema and their foreign keys have no ON DELETE behaviour at all,
which means deleting a business fails on the first child row instead.

2. Why cascade rather than deleting each table by hand
The backend does delete the children explicitly too, so this works whether or
not this file has been applied. But a promise about someone's data should not
depend on an application remembering every table — the next table someone adds
would quietly break it. The database should enforce it.

3. `decisions` has no primary key in the original schema
It was created as an append-only log. Adding one now makes it addressable,
which the connector's decision history needs.
*/

-- plans → businesses
ALTER TABLE public.plans DROP CONSTRAINT IF EXISTS plans_business_id_fkey;
ALTER TABLE public.plans
  ADD CONSTRAINT plans_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;

-- plan_steps → plans
ALTER TABLE public.plan_steps DROP CONSTRAINT IF EXISTS plan_steps_plan_id_fkey;
ALTER TABLE public.plan_steps
  ADD CONSTRAINT plan_steps_plan_id_fkey
  FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE CASCADE;

-- business_map → businesses
ALTER TABLE public.business_map DROP CONSTRAINT IF EXISTS business_map_business_id_fkey;
ALTER TABLE public.business_map
  ADD CONSTRAINT business_map_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;

-- decisions → businesses
ALTER TABLE public.decisions DROP CONSTRAINT IF EXISTS decisions_business_id_fkey;
ALTER TABLE public.decisions
  ADD CONSTRAINT decisions_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;

-- The map is upserted per (business, domain); without this key that upsert
-- silently becomes an insert and the map grows a duplicate row every turn.
CREATE UNIQUE INDEX IF NOT EXISTS business_map_business_domain_key
  ON public.business_map (business_id, domain);

-- Make the decision log addressable, for the connector's history.
ALTER TABLE public.decisions ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
UPDATE public.decisions SET id = gen_random_uuid() WHERE id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS decisions_id_key ON public.decisions (id);

-- Worth knowing at a glance how many owners have asked to be forgotten.
CREATE TABLE IF NOT EXISTS public.forget_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  country text,
  requested_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.forget_log IS
  'One row per "forget my business", with NOTHING identifying in it. Enough to answer "how many people asked?" without keeping what they asked us to delete.';
ALTER TABLE public.forget_log ENABLE ROW LEVEL SECURITY;

-- `businesses.deleted_at` from 0005 is now unused: forgetting removes the row.
-- It is left in place rather than dropped, because dropping a column is the one
-- migration that cannot be undone by re-running a file.
COMMENT ON COLUMN public.businesses.deleted_at IS
  'Unused. "Forget my business" deletes the row outright — a soft delete would leave wa_id taken (it is UNIQUE) and the owner could never come back.';
