/*
# Charlie — one model for everything, and a real cost meter (apply AFTER 0008)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once.

1. What this does, in plain terms
- Points every role at Xiaomi MiMo-V2.5 (`xiaomi/mimo-v2.5` on OpenRouter): one
  model that reads text, pictures, voice notes and video, at roughly
  $0.14 per million tokens in and $0.28 out. The text-only MiMo-V2.5-Pro is the
  one configured fallback for every role.
- `model_usage`: one row per model call (tokens and, when OpenRouter reports
  it, dollars). PRODUCT-DEFINITION section 7 says to measure real cost per
  active owner in the pilot before quoting anyone a price; this is that
  measurement.

2. Reasoning
MiMo can spend tokens "thinking" before it answers. That is good for the plan
and wasteful for a yes/no. So the `reasoning` setting is per role, in `params`:
off for the classifier and the safety backstop, low for live replies, medium for
the plan builder. If the usage table shows reasoning eating more than it earns,
change it here with one UPDATE — no deploy.

3. Voice
The `voice` row now uses provider `openrouter_chat`: MiMo listens to the note
directly. If that call fails, the code falls back to Whisper on OpenRouter's
transcription route, so a voice note is never simply dropped.

4. Security
`model_usage` is RLS-on with no policies, like every other table.
*/

CREATE TABLE IF NOT EXISTS public.model_usage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role text,
  model text,
  prompt_tokens int NOT NULL DEFAULT 0,
  completion_tokens int NOT NULL DEFAULT 0,
  cost_usd numeric(12, 6),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_usage_created_idx ON public.model_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS model_usage_role_idx ON public.model_usage (role, created_at DESC);
ALTER TABLE public.model_usage ENABLE ROW LEVEL SECURITY;

-- Every role gets the same model. `params || ...` merges, so max_tokens and
-- temperature already set on a row are kept.
UPDATE public.model_config
   SET provider = 'openrouter',
       model = 'xiaomi/mimo-v2.5',
       fallbacks = ARRAY['xiaomi/mimo-v2.5-pro'],
       params = params || '{"reasoning": {"enabled": false}}'::jsonb
 WHERE role IN ('router', 'safety');

UPDATE public.model_config
   SET provider = 'openrouter',
       model = 'xiaomi/mimo-v2.5',
       fallbacks = ARRAY['xiaomi/mimo-v2.5-pro'],
       params = params || '{"reasoning": {"effort": "low"}}'::jsonb
 WHERE role IN ('wa_reply', 'help');

UPDATE public.model_config
   SET provider = 'openrouter',
       model = 'xiaomi/mimo-v2.5',
       fallbacks = ARRAY['xiaomi/mimo-v2.5-pro'],
       params = params || '{"reasoning": {"effort": "medium"}}'::jsonb
 WHERE role = 'plan_builder';

-- Voice: MiMo listens directly. Whisper on OpenRouter is the code-level fallback.
INSERT INTO public.model_config (role, provider, model, params, notes)
VALUES ('voice', 'openrouter_chat', 'xiaomi/mimo-v2.5', '{}'::jsonb,
        'MiMo hears the voice note itself. Falls back to openai/whisper-1 on the transcription route.')
ON CONFLICT (role) DO UPDATE
   SET provider = 'openrouter_chat', model = 'xiaomi/mimo-v2.5', notes = EXCLUDED.notes;
