/*
# Charles — tools: which kind of free, works-without-a-payslip, a ten-minute first action (apply AFTER both 0013 files)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once: every column is ADD COLUMN IF NOT EXISTS and the constraint is
added only if missing.

1. What this does, in plain terms
  - Adds three columns to `tools`:
      `free_type text NOT NULL DEFAULT 'UNKNOWN'` — WHICH kind of free (or
        not) a tool is: FREE_FOREVER, FREE_TIER, FREE_TRIAL,
        FREE_FOR_QUALIFYING_USERS, NO_MONTHLY_FEE, PAY_PER_TRANSACTION,
        GOVERNMENT_GRANT or UNKNOWN (CHECK-constrained to exactly those).
        The default is UNKNOWN on purpose: a row nobody classified can never
        be labelled free by accident. See api/_lib/freetype.ts for the label
        each one puts in front of the cost, everywhere a cost is shown.
      `informal_business_supported boolean` — for Charles: can a person with
        no payslip, no formal job or no bank statement use it? NULL means
        nobody checked, and the code never reads NULL as "no".
      `ten_minute_action text` — the one thing a person can do in the next
        ten minutes to start. Required for every row in seed/tools.json
        (enforced by test/tools-ingestion.test.ts, not by a constraint).
  - Adds no rows. In Charlie this file also inserted ten business tools;
    Charles's whole library is db/0034, generated from seed/, so a fresh
    project holds exactly the rows in seed/tools.json and nothing else.

2. Security
`tools` is a reference table (RLS public-read since db/0001); adding columns
changes no policy.
*/

-- ── 1. Columns ──────────────────────────────────────────────────────────
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS free_type text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS informal_business_supported boolean;
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS ten_minute_action text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tools_free_type_check' AND conrelid = 'public.tools'::regclass
  ) THEN
    ALTER TABLE public.tools ADD CONSTRAINT tools_free_type_check CHECK (free_type IN (
      'FREE_FOREVER', 'FREE_TIER', 'FREE_TRIAL', 'FREE_FOR_QUALIFYING_USERS',
      'NO_MONTHLY_FEE', 'PAY_PER_TRANSACTION', 'GOVERNMENT_GRANT', 'UNKNOWN'
    ));
  END IF;
END $$;

COMMENT ON COLUMN public.tools.free_type IS 'Which kind of free (or not) this tool is. See api/_lib/freetype.ts. UNKNOWN is never labelled free.';
COMMENT ON COLUMN public.tools.informal_business_supported IS 'Usable with no payslip, formal job or bank statement? NULL = not checked, never read as no.';
COMMENT ON COLUMN public.tools.ten_minute_action IS 'The first thing a person can do in ten minutes. Required on every seed row (enforced in tests).';
