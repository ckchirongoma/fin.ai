# Fin — implementation plan

*From the spec at `docs/superpowers/specs/2026-10-30-fin-design.md`. Charlie's
code is the starting point (1,731 tests green on the fork). Every step ends
with the typecheck and the suite; nothing is committed red.*

## Order

1. **Fork and baseline** — done. Charlie's tracked files copied into this
   repo; `npm run typecheck` and `npm test` green.
2. **Domain core** (`api/_lib/`): `countries.ts` (ZA only, consumer bodies),
   `diagnostic.ts` + `diagoptions.ts` (the money diagnostic),
   `types.ts` (domains, stages, `GoalOption`, `RuleOption`, `Household`
   context), `businessmap.ts` → the Money Map rubric, `playbooks.ts` (the
   thirteen modules), `location.ts` (ZA places kept, the rest removed),
   `freetype.ts` unchanged.
3. **Prompts** (`prompts.ts`): every prompt re-grounded; goal and rule
   options; the money-stage definitions; connector instructions; the router
   intents and domains.
4. **Engine fit**: `engine/index.ts`, `build.ts`, `planbuild.ts`,
   `steps.ts`, `qa.ts`, `kept.ts`, `context.ts`, `repair.ts`, `artifact.ts`,
   `stepdoc.ts`, `planpdf.ts`; `safety.ts` (hardship check, propositions,
   credential rule), `judgement.ts` (confusables for money words),
   `grounding.ts` (rand only), `pricestamp.ts`, `contacts.ts`, `signals.ts`,
   `plandoc.ts` (the document), `connector.ts` + `appview.ts` + `api/mcp.ts`
   (the AI door), `nudges.ts` + templates, `db.ts`, `queue.ts`, `wa.ts`,
   `transcribe.ts` (vocabulary), `alerts.ts`/`track.ts` (wording),
   `api/*.ts` endpoints, `scripts/*`.
5. **Knowledge base**: `seed/knowledge.json`, `seed/tools.json`,
   `docs/kb-sources.md`, `db/` consolidated migrations for a fresh project
   plus the library insert.
6. **Tests**: remove business-only round tests; adapt `_fakes.ts`,
   `journey.e2e`, `mcp.e2e`, `distress-trap.e2e` (→ hardship), `guardrails`,
   `plandoc`, `retrieval`, `kb-depth`, `kb-coverage`, `eval` fixtures; add
   `fin-journey.e2e.test.ts` and `fin-rules.test.ts`.
7. **Website**: `public/index.html` (new), `public/plan.html`,
   `public/ask.html`, `public/sponsor.html`, `public/admin.html` rebranded;
   SVG imagery; `docs/PITCH.md`.
8. **Docs**: `README.md`, `CLAUDE.md`, `BEHAVIOR-MATRIX.md`,
   `HANDOFF-DEPLOY.md`, `docs/ARCHITECTURE.md`, `docs/EXPERIENCE.md`,
   `docs/PRODUCT-DEFINITION.md`, `docs/OPERATIONS.md`, `.env.example`,
   `package.json`, `vercel.json`, `docs/SUPABASE-SETUP.md`.
9. **Verify and ship**: typecheck, suite in both modes, `eval --dry`, depth
   and coverage, `preview-plan.mjs` through Chromium, read the e2e
   transcript as the person would; commit and push.

## Vocabulary map (code and copy)

| Charlie | Fin |
|---|---|
| Charlie | Fin |
| business / owner | household / the person ("you") — `biz` stays as the row variable name where renaming buys nothing |
| customer options → `GoalOption` | goal options |
| angle options → `RuleOption` | money-rule options |
| alternatives | what usually happens instead |
| biz_stage idea/start/run/grow | money stage surviving/stretching/steady/building |
| distress / stabilising | hardship / steadying |
| registrar, tax, advisor | NCR, SARS, debt counsellor, NFO, SASSA |
| "forget my business" | "forget my money" |
| domains | income, spending, debt, cushion, credit_record, protection, family_money, goals |
