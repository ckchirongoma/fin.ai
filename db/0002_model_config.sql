/*
# Charlie — model_config table (never hardcode a model name)

Apply in Supabase → SQL Editor → New query → paste → Run.
Run AFTER 0001. Safe to run more than once.

1. What this does, in plain terms
Creates one small table that says which AI model does which job in Charlie.
The backend reads this table at runtime. All calls go through OpenRouter —
you pick and change models on your OpenRouter dashboard, then update one
row here, no code change, no redeploy.

2. Jobs and their starting models (all via OpenRouter)
The `model` column holds OpenRouter model slugs (vendor/name format). The
examples below are starting points — replace them with the models you have
actually chosen on your OpenRouter dashboard. `OPENROUTER_API_KEY` is the only
credential needed; OpenRouter routes to whichever provider serves the model,
which is the point of going through it.

3. Security
RLS enabled, no policies: nobody with a public key can read or write it.
Only the backend (service role) uses this table.

4. Changing a model later
Update the row here (SQL Editor) — done. The webhook reads this table on
every call, so the change is live immediately.
*/

CREATE TABLE IF NOT EXISTS public.model_config (
  role text PRIMARY KEY,              -- router | wa_reply | help | voice | plan_builder
  provider text NOT NULL,             -- openrouter
  model text NOT NULL,                -- OpenRouter model slug, e.g. "groq/llama-3.1-8b-instant"
  params jsonb DEFAULT '{}'::jsonb,   -- extra settings (max_tokens, temperature)
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.model_config ENABLE ROW LEVEL SECURITY;

-- TODO(founder): replace each slug below with one you have actually chosen on
-- your OpenRouter dashboard. db/0005 corrects the `voice` row, whose seeded
-- slug was not a real OpenRouter model.
INSERT INTO public.model_config (role, provider, model, params) VALUES
  ('router',      'openrouter', 'groq/llama-3.1-8b-instant',  '{"max_tokens": 300}'),
  ('wa_reply',    'openrouter', 'groq/llama-3.3-70b-versatile','{"max_tokens": 900}'),
  ('help',        'openrouter', 'groq/llama-3.3-70b-versatile','{"max_tokens": 700}'),
  ('voice',       'openrouter', 'groq/whisper-large-v3',     '{}'),
  ('plan_builder','openrouter', 'anthropic/claude-sonnet-4.5','{"max_tokens": 2200}')
ON CONFLICT (role) DO NOTHING;
