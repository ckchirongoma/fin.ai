/*
# Charlie — what Charlie remembers about the owner (apply AFTER 0031)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once. The code does not depend on it: until it runs, nothing about the
owner is remembered, every answer works as before, and the owner's AI is told
a note "could not be saved" (owner_notes_failed names this file).

1. owner_notes
Round 27: the owner's own AI (Claude, ChatGPT) can now drive Charlie through
the connector, and the founder asked that Charlie start remembering things
about the PERSON — the time they have, who helps them, how they like to work,
what worries them — so advice fits them on both doors. That is not a business
fact (businesses.context holds what they sell, who they sell to, their price)
and it is not a decision or a commitment, so it gets its own small table:

  - written by the owner's AI (the `remember` tool, source 'connector') and by
    the memory step after a WhatsApp or web answer (source 'whatsapp'/'web');
  - read back into every answer's prompt and the owner's AI's context;
  - deleted one at a time when the owner says "forget that" (`forget_note`),
    and all at once with the business ("forget my business": the cascade
    below, and api/_lib/db.ts forgetBusiness deletes it explicitly too).

Never an ID, bank, card, PIN or password detail: the tool and the memory
prompt both refuse them, and a note is at most 300 characters.

2. Locked like every other owner-data table
RLS on, no policies: only the backend's service role can read or write it.
The publishable key cannot see a single row.
*/

CREATE TABLE IF NOT EXISTS public.owner_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  about text NOT NULL DEFAULT 'other'
    CHECK (about IN ('person', 'situation', 'preference', 'constraint', 'worry', 'goal', 'other')),
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 300),
  source text NOT NULL DEFAULT 'connector' CHECK (source IN ('connector', 'whatsapp', 'web')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS owner_notes_business_idx ON public.owner_notes (business_id, created_at DESC);

COMMENT ON TABLE public.owner_notes IS
  'What Charlie remembers about the owner as a person (time, help, preferences, worries), from their own AI or the WhatsApp/web memory step. Never ID, bank or card details. Deleted with the business.';

ALTER TABLE public.owner_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.owner_notes FROM anon, authenticated;
