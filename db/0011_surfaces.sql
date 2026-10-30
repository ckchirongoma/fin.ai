/*
# Charlie — the owner's progress view and the sponsor console (apply AFTER 0010)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more than once.

1. What this adds, in plain terms
- `businesses.map_first`: the eight-area map exactly as it stood on day one, kept
  so an owner can see where they started against where they are now. Written
  once, when the first plan is built, and never overwritten.
- `sponsor_tokens`: a funder's key to the cohort report. It can read aggregates
  and nothing else, can be revoked by its label, and is stored only as a hash.
  It is a separate key from the internal secret on purpose: that secret also runs
  the job queue and the PDF renderer.

2. Security
`sponsor_tokens` is RLS-on with no policies, like every other table.
*/

ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS map_first jsonb;

CREATE TABLE IF NOT EXISTS public.sponsor_tokens (
  token_hash text PRIMARY KEY,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS sponsor_tokens_label_idx ON public.sponsor_tokens (label);
ALTER TABLE public.sponsor_tokens ENABLE ROW LEVEL SECURITY;

-- Meta fixes the wording of an AUTHENTICATION template, so the stored body has
-- to be Meta's, not ours. Only kept in sync so the table describes what is sent.
update public.wa_templates
   set body = '{{1}} is your verification code. For your security, do not share this code. This code expires in 10 minutes.'
 where id = 'login_code' and status = 'draft';
