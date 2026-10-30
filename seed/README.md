# Seed data

This is a complete, point-in-time mirror of everything in the live Supabase
`knowledge_entries` and `tools` tables, across South Africa, Kenya, Uganda,
Nigeria and Ghana — every row added or changed by the `db/` migrations up to
the newest one is in here. `scripts/kb-coverage.ts` prints the counts per
country and `scripts/kb-depth.ts` how deep each row goes.

**Supabase is the live source of truth, not these files.** They're here so
the full research is versioned somewhere durable, and so Claude Code (or
anyone) can inspect or re-seed a fresh environment without needing database
access first. If you change data in Supabase, these files go stale — that's
expected. Don't edit these and expect it to sync back.

Schema matches the `knowledge_entries` and `tools` tables exactly (see
`docs/ARCHITECTURE.md` Part 3) minus the `embedding` column, which is
runtime-generated and empty at this stage regardless.
