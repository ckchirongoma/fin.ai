/*
# Charlie — conversation state (apply AFTER 0001 and 0002)

Apply in Supabase → SQL Editor → New query → paste → Run.
Safe to run more than once.

1. What this does, in plain terms
Adds what the WhatsApp backend needs to remember where each owner is:
- answers: the diagnostic answers the owner has given so far
- diag_step: which diagnostic question they're on (0 = just started)
- messages: a log of every message in and out, so the backend and the
  owner's own AI share one memory

2. Security
The messages table is locked the same way as the other owner-data tables:
RLS enabled with no policies, so only the backend (service role) can touch it.
Existing data is not changed or removed.
*/

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS answers jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS diag_step int DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  direction text NOT NULL,             -- 'in' | 'out'
  text text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_business_idx ON public.messages (business_id, id);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
