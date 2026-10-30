/*
# Charlie — semantic search, as a second pass under the keywords (apply AFTER 0009)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once.

1. What this does, in plain terms
Keyword search stays the default, because it is free and predictable. This
adds the second pass for the moment it fails: an owner asks in words the
library's keywords never anticipated, and instead of "nothing matched" the
question is matched by MEANING against the same knowledge and tool rows.

It only runs when keywords found nothing, so most messages never pay for it.
The embedding columns have existed since the start (1536 dimensions); this
adds the index, the two lookup functions, and a hash so an edited row is
re-embedded rather than left searching on stale text.

2. Which rows the second pass rescued
`retrieval_gaps.rescued` records whether meaning found something keywords
missed. A row with rescued = true is a keyword worth adding; a row with
rescued = false is a real gap in the library.

3. Security
The functions are callable only by the backend (service role). Nobody holding
the project's public key can call them.
*/

ALTER TABLE public.knowledge_entries ADD COLUMN IF NOT EXISTS embedding_hash text;
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS embedding_hash text;
ALTER TABLE public.retrieval_gaps ADD COLUMN IF NOT EXISTS rescued boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS knowledge_entries_embedding_idx
  ON public.knowledge_entries USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS tools_embedding_idx
  ON public.tools USING hnsw (embedding vector_cosine_ops);

CREATE OR REPLACE FUNCTION public.match_knowledge(
  query_embedding vector(1536),
  match_country text,
  match_count int DEFAULT 4
) RETURNS TABLE (id text, similarity double precision)
LANGUAGE sql STABLE AS $$
  SELECT k.id::text, 1 - (k.embedding <=> query_embedding)
    FROM public.knowledge_entries k
   WHERE k.country = match_country AND k.embedding IS NOT NULL
   ORDER BY k.embedding <=> query_embedding
   LIMIT match_count
$$;

CREATE OR REPLACE FUNCTION public.match_tools(
  query_embedding vector(1536),
  match_country text,
  match_count int DEFAULT 4
) RETURNS TABLE (id text, similarity double precision)
LANGUAGE sql STABLE AS $$
  SELECT t.id::text, 1 - (t.embedding <=> query_embedding)
    FROM public.tools t
   WHERE t.country = match_country AND t.embedding IS NOT NULL
   ORDER BY t.embedding <=> query_embedding
   LIMIT match_count
$$;

REVOKE ALL ON FUNCTION public.match_knowledge(vector, text, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.match_tools(vector, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_knowledge(vector, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_tools(vector, text, int) TO service_role;
