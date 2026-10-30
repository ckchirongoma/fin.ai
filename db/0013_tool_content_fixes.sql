/*
# Charles — `tools.needs_verification` (apply AFTER 0012)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once: the only statement is an idempotent ADD COLUMN.

In Charlie this file also corrected a handful of business-tool rows. Charles
carries none of those rows (its library is db/0034, generated from seed/),
so only the schema part is kept. The flag means the same thing here: a
human still needs to check this row's steps against the live site, and the
code shows the row with that hedge instead of hiding it.

Security: `tools` is a reference table (RLS public-read since db/0001);
adding a column changes no policy.
*/

ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS needs_verification boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tools.needs_verification IS 'True when the walkthrough has not been checked against the live site. Shown with a hedge, never hidden.';
