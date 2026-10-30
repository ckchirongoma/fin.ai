/*
# Charlie — knowledge_signals: what real conversations say the library is missing or has wrong (apply AFTER 0014)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once.

1. What this is
One small, dated, atomic row per thing worth a second look — never a growing
transcript. The same pattern as `retrieval_gaps` (db/0005), generalised:
  - unanswered_question  a question the library could not match (written
                         alongside every retrieval_gaps row, no extra cost)
  - correction           an owner (or their connected AI) says a stored fact
                         is wrong: "that's not R699 anymore"
  - outcome_report       an owner reports how a tool or step actually went:
                         "Yoco took 3 days, not 1-2"
  - new_fact_candidate   something a connected AI logged that the library
                         might want to know
  - contradiction        reserved for the promotion pass (docs/PROMOTION-PASS.md)

2. What it is NOT
Nothing here ever changes `tools` or `knowledge_entries` by itself. A signal
is one owner's anecdote. Promotion to canonical fact is a deliberate,
agent-run research pass with a cited source and a checked date — see
docs/PROMOTION-PASS.md — never code.

3. Privacy
`raw_quote` is the owner's (or their AI's) own words, so it is owner data:
the row belongs to the business and goes when the business goes (ON DELETE
CASCADE, and api/_lib/db.ts forgetBusiness deletes it explicitly as well).
RLS on, no policies: only the service role (this backend) can read or write,
exactly like every other owner-data table since db/0001.
*/

CREATE TABLE IF NOT EXISTS public.knowledge_signals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('whatsapp', 'mcp')),
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  country text,
  signal_type text NOT NULL CHECK (signal_type IN ('correction', 'new_fact_candidate', 'unanswered_question', 'outcome_report', 'contradiction')),
  related_entity_type text CHECK (related_entity_type IS NULL OR related_entity_type IN ('tool', 'knowledge_entry')),
  related_entity_id text,
  raw_quote text NOT NULL CHECK (char_length(raw_quote) BETWEEN 1 AND 2000),
  candidate_claim text CHECK (candidate_claim IS NULL OR char_length(candidate_claim) <= 500),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'promoted', 'rejected')),
  reviewed_at timestamptz,
  reviewed_by text,
  notes text,
  CHECK ((related_entity_type IS NULL) = (related_entity_id IS NULL))
);

CREATE INDEX IF NOT EXISTS knowledge_signals_open_idx ON public.knowledge_signals (status, related_entity_type, related_entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_signals_business_idx ON public.knowledge_signals (business_id);

COMMENT ON TABLE public.knowledge_signals IS
  'Atomic, dated signals from real conversations that the library may be missing or wrong. Never promoted automatically: see docs/PROMOTION-PASS.md.';

ALTER TABLE public.knowledge_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.knowledge_signals FROM anon, authenticated;
