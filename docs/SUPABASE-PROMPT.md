# Supabase prompt: Charles's knowledge graph, graph actions and households

Copy everything inside the box below into the Supabase AI assistant (or the SQL Editor), in the right project.

````text
You are in my Supabase project for Charles, the WhatsApp money coach. It was set up earlier with db/CHARLES-SETUP.sql up to migration 0037. I want to add migrations 0038, 0039 and 0040 from the fin.ai repository: each household's money graph, the once-only actions it triggers, and households of two to six WhatsApp numbers. They only create new tables and widen one check on the cards table. They do not touch existing rows. If this project has never been set up at all, stop and tell me: I will run the whole db/CHARLES-SETUP.sql instead.

Rules for you, the assistant:
- Run only the SQL I give you, exactly as written. Do not rewrite it, shorten it or "improve" it.
- Do not drop, rename or alter any other table, and do not insert, update or delete any row.
- It is safe to run twice. If any statement errors, stop and show me the exact error. Do not try a workaround.

Step 1. Check first. Run this and show me the result:

```sql
select to_regclass('public.businesses') is not null and to_regclass('public.cards') is not null as set_up_through_0037;
```

If it returns false, stop and tell me. Do not run step 2.

Step 2. Run this SQL as one script:

```sql
CREATE TABLE IF NOT EXISTS public.kg_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('self', 'income', 'creditor', 'dependant', 'cover', 'savings', 'bank', 'group', 'bill', 'goal', 'rule')),
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 60),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, kind, key)
);

CREATE TABLE IF NOT EXISTS public.kg_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  dst_id uuid NOT NULL REFERENCES public.kg_nodes(id) ON DELETE CASCADE,
  rel text NOT NULL CHECK (rel IN ('earns_from', 'owes', 'supports', 'covered_by', 'saves_in', 'banks_with', 'member_of', 'pays', 'working_towards', 'lives_by')),
  amount numeric CHECK (amount IS NULL OR amount >= 0),
  per text CHECK (per IS NULL OR per IN ('week', 'month')),
  balance numeric CHECK (balance IS NULL OR balance >= 0),
  day int CHECK (day IS NULL OR day BETWEEN 1 AND 31),
  note text CHECK (note IS NULL OR char_length(note) <= 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  source text NOT NULL CHECK (source IN ('said', 'answer', 'statement', 'plan', 'connector')),
  sources text[] NOT NULL DEFAULT '{}',
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (business_id, dst_id, rel)
);

CREATE INDEX IF NOT EXISTS kg_nodes_business_idx ON public.kg_nodes (business_id);
CREATE INDEX IF NOT EXISTS kg_edges_business_idx ON public.kg_edges (business_id);

ALTER TABLE public.kg_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kg_edges ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.kg_nodes IS 'The household knowledge graph: one row per thing a household''s money touches (api/_lib/graph.ts). Service role only; deleted with the household.';
COMMENT ON TABLE public.kg_edges IS 'The household knowledge graph: how the person is linked to each thing, with amounts, where it came from and when. Never an identifier.';

-- The memory card ("what Charles knows", drawn).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cards_kind_check' AND conrelid = 'public.cards'::regclass) THEN
    ALTER TABLE public.cards DROP CONSTRAINT cards_kind_check;
  END IF;
  ALTER TABLE public.cards ADD CONSTRAINT cards_kind_check CHECK (kind IN ('month', 'debt', 'map', 'statement', 'goal', 'memory'));
END $$;

-- Belt and braces, as owner_notes (db/0032): no grant for the public keys at all.
REVOKE ALL ON public.kg_nodes FROM anon, authenticated;
REVOKE ALL ON public.kg_edges FROM anon, authenticated;

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

CREATE TABLE IF NOT EXISTS public.households (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.household_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  business_id uuid NOT NULL UNIQUE REFERENCES public.businesses(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  status text NOT NULL DEFAULT 'pending_owner' CHECK (status IN ('pending_owner', 'active')),
  share_debts boolean NOT NULL DEFAULT false,
  joined_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.household_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS household_members_household_idx ON public.household_members (household_id);
CREATE INDEX IF NOT EXISTS household_invites_household_idx ON public.household_invites (household_id);

ALTER TABLE public.households ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.household_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.household_invites ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.households IS 'A household of several WhatsApp numbers (api/_lib/household.ts). Service role only.';
COMMENT ON TABLE public.household_members IS 'Who is in a household, with two-sided consent and per-person debt sharing. Service role only; a member leaves silently.';
COMMENT ON TABLE public.household_invites IS 'Single-use household codes, hashed, 48 hours. Service role only.';

REVOKE ALL ON public.households FROM anon, authenticated;
REVOKE ALL ON public.household_members FROM anon, authenticated;
REVOKE ALL ON public.household_invites FROM anon, authenticated;
```

Step 3. Run this check and show me the result as a table with the columns check_name, found and expected:

```sql
select 'new tables created' as check_name, (select count(*) from information_schema.tables where table_schema='public' and table_name in ('kg_nodes','kg_edges','kg_triggers','households','household_members','household_invites'))::text as found, '6' as expected
union all select 'row level security on' as check_name, (select count(*) from pg_class where relnamespace='public'::regnamespace and relname in ('kg_nodes','kg_edges','kg_triggers','households','household_members','household_invites') and relrowsecurity)::text as found, '6' as expected
union all select 'direct-access policies' as check_name, (select count(*) from pg_policies where schemaname='public' and tablename in ('kg_nodes','kg_edges','kg_triggers','households','household_members','household_invites'))::text as found, '0' as expected
union all select 'grants to the public keys' as check_name, (select count(*) from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated') and table_name in ('kg_nodes','kg_edges','kg_triggers','households','household_members','household_invites'))::text as found, '0' as expected
union all select 'one household per person' as check_name, (select count(*) from pg_constraint where conrelid='public.household_members'::regclass and contype='u')::text as found, '1' as expected
union all select 'codes are single' as check_name, (select count(*) from pg_constraint where conrelid='public.household_invites'::regclass and contype='u')::text as found, '1' as expected
union all select 'memory card allowed' as check_name, (select count(*) from pg_constraint where conname='cards_kind_check' and pg_get_constraintdef(oid) like '%memory%')::text as found, '1' as expected
union all select 'deleted with the person' as check_name, (select count(*) from pg_constraint where contype='f' and confdeltype='c' and conrelid in ('public.kg_nodes'::regclass,'public.kg_edges'::regclass,'public.kg_triggers'::regclass,'public.household_members'::regclass,'public.household_invites'::regclass))::text as found, '8' as expected
union all select 'tables in the project' as check_name, (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')::text as found, '39' as expected;
```

Then tell me in one line whether every row's found matches expected. If any does not, say which and stop.
````

## Success criteria

Every row must match. The first 9 rows are what step 3 prints. The others you check by eye.

| Check | Expected | What it means |
|---|---|---|
| new tables created | 6 | The household graph (2), the actions it triggered (1) and households (3) exist. |
| row level security on | 6 | All six are locked. |
| direct-access policies | 0 | Only the backend's service role reads or writes them. |
| grants to the public keys | 0 | The publishable key cannot see one row. |
| one household per person | 1 | A number can be in only one household at a time. |
| codes are single | 1 | Two invites can never share a code. |
| memory card allowed | 1 | "What do you know about me?" can save its card. |
| deleted with the person | 8 | "Forget my money" takes their graph, actions and household rows with it. |
| tables in the project | 39 | The whole Charles schema, through db/0040. |
| Step 1 result | true | The project was already set up through db/0037, so this is the right project. |
| Errors in step 2 | none | The script ran clean. A second run is also clean. |

