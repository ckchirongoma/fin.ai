/*
# Charlie — questions kept from the diagnostic; one stray incident (apply AFTER 0025)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once. The code does not depend on it: until it runs, a question asked
mid-diagnostic is not kept and the owner is asked to send it again, as before.

1. businesses.kept_questions
Round 20 (live): an owner asked "how much does it cost to register a business
name in Kenya?" at question 4 and was told to ask again later. Nothing kept
the question. Now it is kept here — at most three, each at most 300
characters, in the owner's words, with the question number and time — and
answered straight after the plan is handed over (api/_lib/engine/kept.ts).
Cleared once the answer is queued. Owner data like the rest of the row: it
goes when the business is forgotten, and RLS on businesses is unchanged
(service role only).

2. The Node warning incident 0025 missed
0025 resolved a "Warning logged: (node:…" incident, but in production the
runtime's ExperimentalWarning had been filed as an ERROR, under the catch-all
fingerprint "log_error:log" (a line starting with "(" left the fingerprint
nothing to name it by). The code stopped filing it in round 19, and a line
starting with "(" now gets a fingerprint of its own (track.ts), so this
resolves the one that exists.
*/

ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS kept_questions jsonb;

COMMENT ON COLUMN public.businesses.kept_questions IS
  'Questions the owner asked during the diagnostic, kept to be answered after the plan is handed over (engine/kept.ts). [{text, step, at}], at most 3. Never diagnostic answers.';

UPDATE public.incidents
   SET resolved_at = now(), since_email = 0
 WHERE resolved_at IS NULL
   AND fingerprint = 'log_error:log'
   AND summary LIKE 'Error logged: (node:%';
