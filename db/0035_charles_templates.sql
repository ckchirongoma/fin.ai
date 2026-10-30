/*
# Charles — the six WhatsApp templates, reworded for one household's money

Apply in Supabase → SQL Editor → New query → paste → Run.
Run AFTER 0034. Safe to run more than once.

1. What this does, in plain terms
db/0006 seeded Charlie's six templates (names charlie_*, wording about a
business). Charles's follow-ups are about a person's money, so the bodies and
the Meta names change; the template ids the code looks up (commitment_check,
monday_focus, month_end_money, monthly_checkin, reengage, login_code) and the
variable positions do not. The copy-paste set for Meta is docs/META-TEMPLATES.md:
name, category, language and body must match what is below exactly.

2. Status
Every template goes back to 'draft': nothing is sent from a template until
Meta has approved the new wording and you mark it approved (see the last
section of docs/META-TEMPLATES.md).
*/

UPDATE public.wa_templates SET meta_name = 'charles_commitment_check', body = 'Did you manage to {{1}}? Tap Done, or Help me if you got stuck.', variables = ARRAY['what_they_committed_to'], status = 'draft' WHERE id = 'commitment_check';
UPDATE public.wa_templates SET meta_name = 'charles_monday_focus', body = 'This week, {{1}}: {{2}}. Reply NEXT when you want the step.', variables = ARRAY['first_name','one_thing'], status = 'draft' WHERE id = 'monday_focus';
UPDATE public.wa_templates SET meta_name = 'charles_month_end_money', body = 'Payday is close, {{1}}. Want the three pots for this month before the money lands? Reply YES.', variables = ARRAY['first_name'], status = 'draft' WHERE id = 'month_end_money';
UPDATE public.wa_templates SET meta_name = 'charles_monthly_checkin', body = 'Quick one, {{1}}: did the month fit the money this time — yes, nearly, or no?', variables = ARRAY['first_name'], status = 'draft' WHERE id = 'monthly_checkin';
UPDATE public.wa_templates SET meta_name = 'charles_reengage', body = 'Still thinking about {{1}}? Reply and we pick up exactly where we left off.', variables = ARRAY['their_open_headache'], status = 'draft' WHERE id = 'reengage';
UPDATE public.wa_templates SET meta_name = 'charles_login_code', body = 'Your Charles code is {{1}}. It works for ten minutes. If you did not ask for it, ignore this message.', variables = ARRAY['code'], status = 'draft' WHERE id = 'login_code';

-- A fresh project where 0006 was never run against Charlie gets the same rows.
INSERT INTO public.wa_templates (id, meta_name, language, category, body, variables, status) VALUES
  ('commitment_check', 'charles_commitment_check', 'en', 'UTILITY', 'Did you manage to {{1}}? Tap Done, or Help me if you got stuck.', ARRAY['what_they_committed_to'], 'draft'),
  ('monday_focus', 'charles_monday_focus', 'en', 'UTILITY', 'This week, {{1}}: {{2}}. Reply NEXT when you want the step.', ARRAY['first_name','one_thing'], 'draft'),
  ('month_end_money', 'charles_month_end_money', 'en', 'UTILITY', 'Payday is close, {{1}}. Want the three pots for this month before the money lands? Reply YES.', ARRAY['first_name'], 'draft'),
  ('monthly_checkin', 'charles_monthly_checkin', 'en', 'UTILITY', 'Quick one, {{1}}: did the month fit the money this time — yes, nearly, or no?', ARRAY['first_name'], 'draft'),
  ('reengage', 'charles_reengage', 'en', 'UTILITY', 'Still thinking about {{1}}? Reply and we pick up exactly where we left off.', ARRAY['their_open_headache'], 'draft'),
  ('login_code', 'charles_login_code', 'en', 'AUTHENTICATION', 'Your Charles code is {{1}}. It works for ten minutes. If you did not ask for it, ignore this message.', ARRAY['code'], 'draft')
ON CONFLICT (id) DO NOTHING;
