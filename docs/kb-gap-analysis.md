# Knowledge-base gap analysis: South Africa, the money library

**Measured 2026-10-30, the day the library landed.** This file is the yardstick. Re-run the scripts after every content batch and compare with the numbers below; `test/kb-coverage.test.ts` and `test/kb-depth.test.ts` pin them as floors, so a regression fails `npm test`.

## How to re-run

```sh
node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/kb-coverage.ts
```

```sh
node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/kb-coverage.ts --json
```

```sh
node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/kb-depth.ts --shallow
```

The scripts read `seed/knowledge.json`, `seed/tools.json`, `api/_lib/playbooks.ts`, `test/fixtures/kb-benchmark.json` and the held-out set `test/fixtures/kb-benchmark-holdout.json`. No database, no model, no network.

## Method

For the one market the product serves, the coverage script measures four things:

1. **Rows per area and per stage.** `knowledge_entries` and `tools` rows for each of the eight money areas (income, spending, debt, cushion, credit_record, protection, family_money, goals) and each of the four money stages (surviving, stretching, steady, building).
2. **Plan-step tool coverage.** Every step in `MODULES` that names `tool_choices` (29 steps) must have at least one of those tools as a row in the market; `forCountry()` in `api/_lib/engine/build.ts` drops ids with no local row, so an uncovered step reaches the person with no tool.
3. **Question benchmarks.** The main set holds 72 questions a household might type, nine or ten per area, every stage represented, no country or brand named. The held-out set holds 43 more, written blind and never tuned to. Each question runs through the real `shortlist()` over the market's rows; it counts as answered when one of the top three rows is in the question's area and overlaps its words.
4. **Freshness.** Rows whose `verified_on` is more than 90 days old.

The depth script scores every row on whether the person can act on it: named bodies and portals, a dated figure or a plain "free", concrete steps, a walkthrough and a ten-minute action for a tool.

**Rules:** add questions freely; never reword an existing one to move a number. Keywords may be added to rows for phrasings seen in the MAIN set or in real messages. Never for a held-out phrasing: that set measures untuned coverage.

## Results, 2026-10-30

| Market | Knowledge | Tools | Plan-step tool coverage | Main benchmark | Held-out | Stale (>90d) |
|---|---|---|---|---|---|---|
| ZA | 56 | 30 | 29/29 (100%) | 72/72 (100%) | 31/43 (72%) | 0 |

Depth: knowledge 9.5/10 average (56/56 rows at 8 or more), tools 9.9/10 (30/30), no benchmark question answered only by a shallow row.

Knowledge rows per area: income 8, spending 7, debt 12, cushion 5, credit_record 5, protection 7, family_money 7, goals 5. Tools per area: income 8, spending 5, debt 5, cushion 1, credit_record 3, protection 4, family_money 1, goals 3.

The main benchmark reached 100% after the library's own keyword pass (phrasings such as "the month is longer than the money", "pension savings pot", "remove my bad credit for a fee") and four rows the lead added for real gaps (`k.partner_money`, `k.maintenance_claim`, `k.creditor_arrangement`, `k.prize_sms_scam`; see `docs/kb-sources.md`).

## The next content round: what the held-out set still misses

Twelve of 43, as of 2026-10-30. Each is a real question with no row that answers it in its area, or a row whose words do not reach it. Write content for these; do not add their words as keywords.

- Income: hours cut and the month no longer fits (a reduced-income row: UIF for reduced time, the CCMA, the three pots re-cut).
- Spending: surviving to payday on very little; the electricity cut off with no money for units (the free basic electricity row exists but speaks only of the indigent register).
- Debt: proving an account is paid up (the settled-account row exists; it does not say "paid up").
- Cushion: checking whether a stokvel is registered (the stokvel row is filed under family money); the penalty for early retirement withdrawal (the two-pot row is filed under goals and does not say "penalty").
- Credit record: an account opened in your name (the SAFPS row is filed under protection and does not say "in my name").
- Protection: an insurer refusing a claim and where to complain (the ombud is named in the funeral-cover row, not reachable from "refusing to pay").
- Family money: teaching children about money (no row).
- Goals: a named amount by a date ("R1,000 by December"), a fixed monthly amount over years, and the prize-SMS scam filed under protection rather than goals.

## Tools still thin

One tool each in cushion (`gotyme_goalsave`) and family money (`nasasa_stokvel`). A second savings place that is not one bank's product, and a maintenance-office tool for `k.maintenance_claim`, are the obvious next rows.
