/*
# Charles — a household of several WhatsApp numbers (apply AFTER 0039)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once. Until it runs, "invite someone to my household" says it could not
do that just now, and nothing else changes.

1. What this does, in plain terms
api/_lib/household.ts links two to six WhatsApp numbers into one household,
so Charles knows the shared picture: who supports whom, the bills each pays,
cover, stokvels, savings, the goal. Each person keeps their own conversation,
plan and memory. Debts and income are shared only when that person says so.

  - households: one row per household, and who started it.
  - household_members: who is in it. status 'pending_owner' until the person
    who invited them lets them in; role 'owner' for the one who answers
    join requests (passed on when they leave); share_debts when the person
    has chosen to share their debts and income.
  - household_invites: single-use codes, stored as a hash, 48 hours.

2. Consent and safety
Both sides agree before anything is shared. Anyone can leave at any time and
the others are not told. Members are shown to each other by first name,
never by number.

3. Locked like every other person-data table
RLS on, no policies: only the backend's service role reads or writes these.
"Forget my money" takes the person out first (api/_lib/db.ts), and the
foreign keys below cascade.
*/

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
