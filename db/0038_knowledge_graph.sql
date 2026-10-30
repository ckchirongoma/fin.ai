/*
# Charles — the household knowledge graph (apply AFTER 0037)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once. The code does not depend on it: until it runs, the graph Charles
derives from the diagnostic, the statement and the plan still works, and
nothing learned from conversation is kept.

1. What this does, in plain terms
api/_lib/graph.ts keeps what one household's money touches as a small graph:
the person at the centre, and around them where money comes from, who they
owe and what they pay, who they support, their cover, their stokvel or
burial society, where they save and bank, the bills they pay. Every edge
says where it came from (they said it, a setup answer, their statement,
their own AI) and when, so Charles can be specific without ever claiming
the person said something they did not (rule 2), and every figure on it is
one they typed or a page showed (rule 10).

  - kg_nodes: one row per thing, per household. `key` is a normalised name
    ("the mashonisa" and "loan shark" are one node).
  - kg_edges: one row per (household, thing, relation). `amount` and `per`
    are what is paid or received each time, `balance` what is still owed.
    `status` is closed when they paid it off or stopped. `history` keeps the
    last few amounts, so "was R200 a week" survives a change.

What the graph derives from the household row (the diagnostic, the
statement, the goal and the rule) is computed every time and also lives
here once learned; what the person says in conversation, and what their own
AI records with the connector's record_fact, lives only here.

2. The library graph needs nothing here
The links between knowledge entries, tools and plan modules are computed
from the library itself on every load (api/_lib/libgraph.ts).

3. Locked like every other person-data table
RLS on, no policies: only the backend's service role reads or writes these.
"Forget my money" deletes them with the household (the cascades below, and
api/_lib/db.ts forgetBusiness deletes them explicitly too). Never an ID,
account, card or reference number: graph.ts refuses one before it is written.

4. The memory card
Card kind 'memory' ("what Charles knows", drawn) is added to cards.kind.
*/

CREATE TABLE IF NOT EXISTS public.kg_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('self', 'income', 'creditor', 'dependant', 'cover', 'savings', 'bank', 'group', 'bill', 'goal', 'rule')),
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 60),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, kind, key)
);

CREATE TABLE IF NOT EXISTS public.kg_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  dst_id uuid NOT NULL REFERENCES public.kg_nodes(id) ON DELETE CASCADE,
  rel text NOT NULL CHECK (rel IN ('earns_from', 'owes', 'supports', 'covered_by', 'saves_in', 'banks_with', 'member_of', 'pays', 'working_towards', 'lives_by')),
  amount numeric CHECK (amount IS NULL OR amount >= 0),
  per text CHECK (per IS NULL OR per IN ('week', 'month')),
  balance numeric CHECK (balance IS NULL OR balance >= 0),
  day int CHECK (day IS NULL OR day BETWEEN 1 AND 31),
  note text CHECK (note IS NULL OR char_length(note) <= 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  source text NOT NULL CHECK (source IN ('said', 'answer', 'statement', 'plan', 'connector')),
  sources text[] NOT NULL DEFAULT '{}',
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (business_id, dst_id, rel)
);

CREATE INDEX IF NOT EXISTS kg_nodes_business_idx ON public.kg_nodes (business_id);
CREATE INDEX IF NOT EXISTS kg_edges_business_idx ON public.kg_edges (business_id);

ALTER TABLE public.kg_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kg_edges ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.kg_nodes IS 'The household knowledge graph: one row per thing a household''s money touches (api/_lib/graph.ts). Service role only; deleted with the household.';
COMMENT ON TABLE public.kg_edges IS 'The household knowledge graph: how the person is linked to each thing, with amounts, where it came from and when. Never an identifier.';

-- The memory card ("what Charles knows", drawn).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cards_kind_check' AND conrelid = 'public.cards'::regclass) THEN
    ALTER TABLE public.cards DROP CONSTRAINT cards_kind_check;
  END IF;
  ALTER TABLE public.cards ADD CONSTRAINT cards_kind_check CHECK (kind IN ('month', 'debt', 'map', 'statement', 'goal', 'memory'));
END $$;

-- Belt and braces, as owner_notes (db/0032): no grant for the public keys at all.
REVOKE ALL ON public.kg_nodes FROM anon, authenticated;
REVOKE ALL ON public.kg_edges FROM anon, authenticated;
