/*
# Charles — cards: the small pages a person opens from a WhatsApp link (apply AFTER 0036)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once. Until it runs, no card link can be made and Charles says the
figures in words instead.

1. What this does, in plain terms
A card (api/_lib/cards.ts) is a snapshot of one picture of the person's
money, built in code from their own figures: the month in three pots, when a
debt is gone, the Money Map, what the statement says, getting to a number.
Each is reached by a long random link; the token is stored here as a hash,
with the snapshot it shows, for sixty days.

  - `token_hash`: sha256 of the link token, peppered like every other
    credential (api/_lib/crypto.ts). The token itself is never stored.
  - `data`: the snapshot: figures, labels, notes. Never a phone number, an
    account number or a surname (statement.ts drops identifiers before
    anything is kept; cards.ts uses first names only).
  - `expires_at`: the link stops working after this; `opened_at` is the last
    time it was opened.

2. Locked like every other person-data table
RLS on, no policies: only the backend's service role reads or writes it. The
page itself is served by api/card.ts, which looks the token up with the
service role. "Forget my money" deletes the rows with the household (the
cascade below, and api/_lib/db.ts forgetBusiness deletes them explicitly too).
*/

CREATE TABLE IF NOT EXISTS public.cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('month', 'debt', 'map', 'statement', 'goal')),
  token_hash text NOT NULL UNIQUE,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  opened_at timestamptz
);

CREATE INDEX IF NOT EXISTS cards_business_idx ON public.cards (business_id, created_at DESC);

ALTER TABLE public.cards ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.cards IS 'Snapshots behind the card links Charles sends on WhatsApp (api/_lib/cards.ts): figures only, sixty days, deleted with the household.';
