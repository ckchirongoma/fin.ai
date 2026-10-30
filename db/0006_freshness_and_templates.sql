/*
# Charlie — knowledge freshness + the WhatsApp templates (apply AFTER 0005)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once.

1. What this does, in plain terms
- Two views that answer "what in the knowledge base is out of date?" without
  anyone having to remember to look. Anything checked more than 90 days ago is
  stale; the plan builder already hedges those to "confirm at sign-up", and the
  quarterly job writes a report so a human can go re-check them.
- The five follow-up messages, written out as the templates Meta has to approve
  before Charlie is allowed to start a conversation outside the 24-hour window.
  They live in the database so the approved Meta name can be filled in later
  without touching code.
*/

-- ── What has gone stale ──────────────────────────────────────────
CREATE OR REPLACE VIEW public.knowledge_freshness AS
SELECT id, country, domain, title, verified_on,
       (CURRENT_DATE - verified_on) AS days_old,
       (verified_on IS NULL OR CURRENT_DATE - verified_on > 90) AS is_stale
  FROM public.knowledge_entries;

CREATE OR REPLACE VIEW public.tools_freshness AS
SELECT id, country, domain, name, cost, verified_on,
       (CURRENT_DATE - verified_on) AS days_old,
       (verified_on IS NULL OR CURRENT_DATE - verified_on > 90) AS is_stale
  FROM public.tools;

CREATE TABLE IF NOT EXISTS public.freshness_reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(),
  stale_knowledge int NOT NULL DEFAULT 0,
  stale_tools int NOT NULL DEFAULT 0,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE public.freshness_reports ENABLE ROW LEVEL SECURITY;

-- ── The five templates ───────────────────────────────────────────
-- Meta's own placeholder syntax is {{1}}, {{2}} — positional, not named.
-- Keep the wording short: these are interruptions, and they cost money.
INSERT INTO public.wa_templates (id, meta_name, language, category, body, variables, status) VALUES
  ('commitment_check', 'charlie_commitment_check', 'en', 'UTILITY',
   'Did you manage to {{1}}? Tap Done, or Help me if you got stuck.',
   ARRAY['what_they_committed_to'], 'draft'),
  ('monday_focus', 'charlie_monday_focus', 'en', 'UTILITY',
   'This week for {{1}}: {{2}}. Reply NEXT when you want the step.',
   ARRAY['business_name','one_thing'], 'draft'),
  ('month_end_money', 'charlie_month_end_money', 'en', 'UTILITY',
   'Month-end. Want me to draft the reminders to whoever still owes {{1}}? Reply YES.',
   ARRAY['business_name'], 'draft'),
  ('monthly_checkin', 'charlie_monthly_checkin', 'en', 'UTILITY',
   'Quick one for {{1}}: sales this month against last month — up, same or down?',
   ARRAY['business_name'], 'draft'),
  ('reengage', 'charlie_reengage', 'en', 'UTILITY',
   'Still thinking about {{1}}? Reply and we pick up exactly where we left off.',
   ARRAY['their_open_headache'], 'draft'),
  -- Signing in to read the plan on the web. Meta categorises one-time codes
  -- separately from utility messages, and an AUTHENTICATION template is the
  -- only thing that will deliver a code outside the 24-hour window.
  ('login_code', 'charlie_login_code', 'en', 'AUTHENTICATION',
   'Your Charlie code is {{1}}. It works for ten minutes. If you did not ask for it, ignore this message.',
   ARRAY['code'], 'draft')
ON CONFLICT (id) DO NOTHING;
