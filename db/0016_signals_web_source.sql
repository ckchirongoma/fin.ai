/*
# Charlie — knowledge signals can come from the web ask page too (apply AFTER 0015)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once.

The web page /ask.html (api/ask.ts) answers an owner's questions with the
same engine as WhatsApp, so the same owner-typed question can carry the
same kind of signal. `source` was CHECK-constrained to 'whatsapp' | 'mcp';
this widens it to include 'web'. Nothing else changes: no new table, no
policy change (RLS stays on, service-role only, as db/0015 set it).

Until this runs, a signal from the web page fails its insert — which is
not silent: api/_lib/db.ts records a knowledge_signal safety_events row
flagged write_failed with the database's own error message.
*/

ALTER TABLE public.knowledge_signals DROP CONSTRAINT IF EXISTS knowledge_signals_source_check;
ALTER TABLE public.knowledge_signals ADD CONSTRAINT knowledge_signals_source_check CHECK (source IN ('whatsapp', 'mcp', 'web'));
