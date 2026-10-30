/*
# Charlie — RLS lockdown (the security fix)

Apply in Supabase → SQL Editor → New query → paste → Run.
Safe to run more than once.

1. What this does, in plain terms
- Your two research tables (knowledge_entries, tools) become readable by
  everyone but writable by nobody except your backend. They are reference
  data, like a public library.
- Your five owner-data tables (businesses, business_map, plans, plan_steps,
  decisions) become completely locked. Nobody can read or write them with
  the public key. Only the backend (service role) can touch them.

2. Why
Right now anyone holding the project's public key can read AND overwrite
every business's data. This change seals that.
*/

-- Reference tables: public to read, locked to write
ALTER TABLE public.knowledge_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tools ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_knowledge_entries" ON public.knowledge_entries;
CREATE POLICY "public_read_knowledge_entries"
  ON public.knowledge_entries FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "public_read_tools" ON public.tools;
CREATE POLICY "public_read_tools"
  ON public.tools FOR SELECT
  TO anon, authenticated
  USING (true);

-- Owner-data tables: fully locked. No policies = no access for public keys.
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.decisions ENABLE ROW LEVEL SECURITY;
