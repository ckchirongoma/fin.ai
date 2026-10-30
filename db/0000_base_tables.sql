/*
# Charles — the seven base tables

Apply in Supabase → SQL Editor → New query → paste → Run. Run FIRST, before
0001. Safe to run more than once.

1. What this does, in plain terms
Charlie's first project had these seven tables made by hand before any script
existed, so 0001 onward only ALTER them. A fresh project has none of them.
This file creates them with the columns the original schema had
(docs/ARCHITECTURE.md Part 3); every later column is added by the file that
introduced it, with IF NOT EXISTS, so the order below is the only order.

2. The vector extension
Supabase → Database → Extensions → enable "vector" first, or this file's
CREATE EXTENSION does it where the role is allowed to. The embedding columns
are empty until the second-pass search is populated; nothing reads them
until then.

3. Security
Row-level security is switched on and locked down by 0001, straight after.
*/

CREATE EXTENSION IF NOT EXISTS vector;

-- One row per household (one WhatsApp number). Named businesses because
-- Charles is built from Charlie; see db/0033.
CREATE TABLE IF NOT EXISTS public.businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_id text UNIQUE NOT NULL,
  country text NOT NULL DEFAULT 'ZA',
  stage text NOT NULL DEFAULT 'diag',
  identity jsonb,
  context jsonb,
  customer jsonb,
  angle jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- The Money Map: eight areas, red/amber/green, one note each.
CREATE TABLE IF NOT EXISTS public.business_map (
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  domain text NOT NULL,
  status text NOT NULL,
  note text,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (business_id, domain)
);

CREATE TABLE IF NOT EXISTS public.plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  goal text,
  headline text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.plan_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid REFERENCES public.plans(id) ON DELETE CASCADE,
  workstream_title text,
  step_order int,
  title text,
  push text,
  artifact text,
  tool_id text,
  status text DEFAULT 'open',
  done_when text
);

CREATE TABLE IF NOT EXISTS public.decisions (
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  what text,
  source text,
  created_at timestamptz DEFAULT now()
);

-- The library: researched once, read on every answer.
CREATE TABLE IF NOT EXISTS public.knowledge_entries (
  id text PRIMARY KEY,
  country text NOT NULL,
  domain text,
  stages text[],
  keywords text[],
  title text,
  owner_summary text,
  applies_when text,
  not_when text,
  steps text[],
  cost text,
  stakes text,
  verified_on date,
  embedding vector(1536),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tools (
  id text PRIMARY KEY,
  country text NOT NULL,
  domain text,
  stages text[],
  keywords text[],
  name text,
  fits text,
  not_when text,
  why text,
  cost text,
  url text,
  setup text,
  walkthrough text[],
  verified_on date,
  embedding vector(1536),
  created_at timestamptz DEFAULT now()
);
