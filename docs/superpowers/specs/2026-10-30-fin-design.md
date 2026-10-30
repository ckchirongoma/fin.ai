# Fin — design spec

*2026-10-30. A WhatsApp number that knows your money. Built from Charlie, for
GoTyme Bank's customers first. This is the document to argue with.*

---

## 0. The one-paragraph version

Fin is a WhatsApp number that learns one household's money once, builds a
90-day money plan from a fixed library of proven moves, and then pushes the
person through it one step at a time, following up on whether each step
actually worked. The person picks the goal and the one money rule they will
live by; Fin never offers a menu, never invents a fee or a rule, never pushes
credit, and switches to a hardship mode the moment someone cannot cover food,
rent or transport. Their own AI (ChatGPT, Claude) can connect to the same
memory. South Africa first; the next market (the Philippines, where Tyme has
11 million customers) is a data migration, not a rewrite.

## 1. Who it is for, and what the research says about them

**The customer.** GoTyme Bank (TymeBank until January 2026) has about 13
million South African customers. The CGAP case study on TymeBank (2022)
found it serves a much higher share of low-income customers than the typical
South African bank, with accounts opened at Pick n Pay and Boxer kiosks;
low-income women made up 65% of its sample. The bank's own new CEO, Cheslyn
Jacobs (from 1 January 2026), has said the number of credit-worthy South
Africans has barely changed in fifteen years, and the bank's 2026 strategy is
lending growth (MoreTyme, a credit card, unsecured and SME loans) on top of
free instant payments.

**Their money life, in the numbers that are public.**

| Fact | Source, with its caveat |
|---|---|
| About half of South African adults are not classed as financially literate (FSCA baseline ~51%), and the national score has been flat for years | FSCA / Treasury draft National Consumer Financial Education Policy (2026); secondary reporting |
| 10.5 million credit-active consumers have accounts in arrears, defaults or other negative records (more than a third) | National Credit Regulator, June 2025 |
| 72% of surveyed South Africans report money stress; 90% of those with unsustainable debt do not use debt counselling | DebtBusters Money-Stress Tracker 2026; a commercial survey, not nationally representative |
| 32% of surveyed borrowers used a mashonisa in the last year, double the year before; 85% because their credit score was too low; mashonisas commonly charge 30–50% a month and are unregistered, so the debt is unenforceable | Wonga survey 2026; NCR statements |
| R2.41 billion lost to digital banking crime in 2025, 89% of cases through banking apps, almost all social engineering | SABRIC Annual Crime Statistics 2025 |
| More than 11 million South Africans belong to a stokvel | NASASA's own estimate, August 2025 |
| The SRD grant stays R370 a month to March 2027; 2026 grant amounts are reported as R2,400 (old age), R580 (child support) by third-party sites and must be confirmed on sassa.gov.za | Treasury 2026 Budget; third-party reporting |

**What works, and what does not.**

- *Tips do not work.* TymeBank itself launched a financial-literacy SMS
  service with Juntos in 2020 (budgeting, saving, credit tips) and an
  education app, TymeCoach, with a chatbot. The national literacy score did
  not move. Generic content is the control condition.
- *Rules of thumb beat lessons.* Drexler, Fischer and Schoar (AEJ Applied
  2014): a randomised trial in the Dominican Republic found a simple
  rule-of-thumb course (separate the money physically, one rule at a time)
  improved financial practices and revenues where standard accounting training
  did nothing, and the gains were largest for people with the weakest
  starting practices.
- *Menus hurt the weakest.* The Harvard Business School field experiment
  (Otis, Clarke, Delecourt, Holtz and Koning, WP 24-042) gave 640 Kenyan
  entrepreneurs a GPT-4 mentor on WhatsApp that offered three to five
  suggestions per question. No average effect; the strongest gained
  15–20%, the weakest did about 10% worse, because they could not tell which
  suggestion fitted them.
- *Specific, concrete, followed-up.* Bruhn, Karlan and Schoar (2018) and
  the wider literature: programmes that address a concrete problem with a
  specific action outperform general training.

So Fin's spine is Charlie's spine, unchanged: **one recommendation, in the
person's own numbers, free and reversible first, with a follow-up on whether
it worked** — and a hardship mode that does nothing clever.

## 2. The spiky point of view (what the CEO is told)

1. **Financial literacy is a verb.** South Africa has had a national
   financial-education policy, a Financial Literacy Month and every bank's
   money tips for a decade, and the score is flat. People do not lack the
   knowledge that a mashonisa is expensive. They lack the next step, in their
   numbers, this week, and someone who asks on Friday whether it happened.
2. **The customer is not illiterate. They are overwhelmed.** A nurse's aide
   on R7,800 with two children, a mother to support, a clothing account, a
   bank loan and a mashonisa does not need a course. She needs one rule
   ("the mashonisa gets paid first, nothing new gets borrowed") and a plan
   that fits her payday.
3. **Fin is a credit-readiness engine, not a content programme.** Every
   household Fin steadies is a customer the bank could not underwrite
   yesterday: arrears cleared, a GoalSave balance that grows on payday, a
   bank-visible record of behaviour. The product's success metric is the
   bank's own: the share of customers who become credit-worthy. That is the
   number Mr Jacobs says has not moved in fifteen years.
4. **The rails already exist.** A plan step for a GoTyme customer is not
   advice. "Move R50 to GoalSave on grant day" is a thing the bank's own app
   does, for free. Fin sits on top of PayShap, GoalSave and the kiosk network
   and turns them into habits.
5. **Doing no harm is the feature.** The Kenya evidence says the usual
   chatbot makes the weakest customers worse. Fin's hardship mode pushes no
   product, names the free debt counsellor and the ombud, and pauses the
   plan. Counter-intuitively, that is what earns the trust a lending
   relationship needs.
6. **It is honest about what came before.** The SMS tips and the coaching
   app were the right instinct with the wrong unit: the message, not the
   household.

## 3. The journey

Same stages as Charlie (`Stage` in `types.ts`), same machinery, different
questions and choices. Where Charlie reads a business, Fin reads a household.

### 3.1 The money diagnostic, 12 questions, about 5 minutes

| # | Key | Question | Shape |
|---|---|---|---|
| 1 | `person` | Hi, I'm Fin… What should I call you, and what do you do for money? | open |
| 2 | `income_kind` | How does money come in? Salary or wage / Piece jobs or hustle / SASSA grant / My own business / Family or partner / A mix, not sure | multi, numbered |
| 3 | `location` | Where are you based? Area and city is enough | open (decides the market, as in Charlie) |
| 4 | `objective` | Now the important one. What are you trying to fix or achieve with your money? In your own words | open |
| 5 | `objective_kind` | Is that mainly about any of these? Get out of debt / Have something saved / Fix my credit record / Make the month fit / Protect my family / Something else | multi |
| 6 | `blockers` | What's getting in the way right now? Repayments eat my pay / Family needs money from me / The month is longer than the money / A mashonisa or loan shark / Nothing saved for emergencies / I don't know where it goes / Fees and airtime eat it / Nothing major, I want to get ahead | multi |
| 7 | `depends` | Who depends on your money? Just me / A partner / Children / Parents or elders / Extended family / Not sure | multi |
| 8 | `income` | Roughly, what comes in a month? For example R3,500, or R12,000 | open |
| 9 | `owes` | Who do you owe money to right now? A bank loan or card / A clothing or furniture account / A cellphone contract / A mashonisa / Stokvel, family or friends / Nobody | multi |
| 10 | `cushion` | If something broke tomorrow, what could you reach? Nothing / Less than a week's spend / About a month / More than a month | single, list |
| 11 | `cover` | What cover do you have? Funeral policy / Burial society / Medical aid / Life cover / None / Not sure | multi |
| 12 | `records` | How do you keep track of your money? In my head / A notebook / The bank app / A spreadsheet or app / Someone helps me | multi |

Rules in force are Charlie's: the question gate, the action id on every tap,
the voice-note read-back, the consent line ("forget my money" replaces
"forget my business").

### 3.2 Hardship check, before a single token is spent

`checkDistress` becomes `checkHardship`: genuine inability to cover food,
rent, transport or a child's needs, a garnishee or eviction, borrowing to
eat. The pre-written hardship message: three moves (borrow nothing more,
including from a mashonisa; write down every rand owed; the one free call to
make), the country's free advisor named, the plan paused with a way back.

### 3.3 Identity, once

The `identity` object becomes `{name, earns, one_liner, unsure}`: what they
asked to be called, how money comes in, one line about their money life.
Confirmed before anything is built.

### 3.4 Choosing the goal, then the rule

Charlie's customer→angle becomes **goal→rule**:

- **Three genuinely different 90-day goals** the diagnostic supports, each
  with: `label` (20 chars), `what` (the goal as one line), `why_you` (why it
  fits them), `worth` (what it is worth in their own numbers, never
  invented), `first_move` (what they could do this week), `catch`. The model
  recommends one.
- **Three money rules** — one-sentence rules of thumb the person would say
  to themselves (Drexler), each with `label`, `rule` (the sentence),
  `why_it_works`, `what_it_costs_you`. The alternatives step becomes "what
  usually happens instead" (`alternatives` → the two or three things people
  in this situation usually do, honestly: borrow again, skip a payment, ask
  family) so the rule is chosen against reality.

Multi-select on both, as numbered text.

### 3.5 The build

Unchanged mechanically: context + map, Jev/model rubric scoring, the
strategy document, one tailoring call per chosen module, compliance on every
step. The eight areas become the **Money Map**:

| Area | Green means |
|---|---|
| `income` | Knows what comes in and when; every grant or benefit they qualify for is claimed |
| `spending` | A month plan exists that fits the money; bills are paid on the day money lands |
| `debt` | Every rand owed is listed, the costliest is being paid first, nothing new borrowed, no mashonisa |
| `cushion` | A named amount they can reach, growing on payday |
| `credit_record` | Report checked in the last year, errors disputed, every account paid on time for three months |
| `protection` | One funeral policy that fits, no duplicates, beneficiaries named; cover for the people who depend on them |
| `family_money` | Support to family is a fixed line; stokvel or burial society is one they can verify |
| `goals` | A written 90-day goal, and a longer one with a vehicle (TFSA, retirement, home) |

The `biz_stage` becomes the **money stage**: `surviving` (cannot make the
month), `stretching` (makes the month, nothing kept), `steady` (small
cushion, debts under control), `building` (saving toward a goal).

### 3.6 The fixed module library

Thirteen modules, each with `needs()` on signals read from the diagnostic,
fixed steps with `how_to` lines, knowledge pins and tool choices. The model
tailors wording only. No invented structure.

| Module | Title | Fires when |
|---|---|---|
| `m_owed` | See every rand you owe | owes anything |
| `m_shark` | Get out of the mashonisa's book | owes a mashonisa |
| `m_snowball` | Kill the smallest debt first | two or more debts |
| `m_month` | Make the month fit the money | month short, or does not know where it goes |
| `m_cushion` | Build a cushion you can reach | nothing or under a week saved |
| `m_credit` | Fix your credit record | credit worry, arrears, or a credit goal |
| `m_family` | Set the family line | family pressure |
| `m_cover` | Cover the people who depend on you | dependants and no cover, or double cover |
| `m_fees` | Stop paying to use your own money | fees pain |
| `m_claim` | Claim what you're owed | grant income, retrenched, or a likely unclaimed benefit |
| `m_safe` | Make your money hard to steal | everyone with a bank app; scored low unless scam-exposed |
| `m_review` | Get legal protection from your creditors | over-indebted and not in hardship mode |
| `m_future` | Put a name on the bigger goal | steady or building stage |

Order: `pickPlaybook` ranks by what the person said they want, with the
owed/shark modules boosted the way Charlie boosts `m_owed`/`m_cash` ("that
money is already yours" becomes "that is the money bleeding fastest").

### 3.7 Delivery, the loop, nudges, Q&A, the document, the website, the connector

All as Charlie, with the words changed: "Your 90-day money plan", the step
loop (send, do, done, did it help), the outcome question, bounded plan
changes, nudges capped in code, the Q&A grounded in the shortlist, forwarded
links scam-checked (now the primary case, not an edge case), the three-part
document (Where you stand / The strategy / The next 90 days) rendered with
tables and inline hex, the plan viewer, and the MCP door for the person's
own AI with the same tool set (`get_household_context` etc.).

## 4. Rules that do not change

CLAUDE.md's ten rules, verbatim in spirit:

1. Plan from the fixed library, never freestyled.
2. Nothing claims the person said what they did not.
3. One recommendation, never a menu (HBS WP 24-042).
4. Collaborative: goal and rule chosen by the person.
5. Identity established once, then reused.
6. Retries with backoff on every model call.
7. Every button an action id; a question is never an answer.
8. The document renders with tables and inline hex.
9. Free and reversible before anything that costs money; hardship mode.
10. Never invent a price, fee, rule or deadline; `verified_on` on every fact;
    past 90 days, hedged.

Two added for money:

11. **Never recommend credit.** No loan, no BNPL, no cash advance, however
    cheap. If the person is considering one, work through their numbers and
    say the downside first. A bank-partner product (GoalSave, PayShap) may be
    named because it costs nothing and is reversible; MoreTyme and any loan
    may only be explained, never pushed.
12. **Never ask for or store an ID number, account number, card number, PIN,
    OTP or password**, and say so in the first message. Fin reads no bank
    statement and no app; it knows what the person tells it.

## 5. The knowledge base

Same two tables, same columns, new rows. South Africa first.

- `knowledge_entries` (~45): rights and rules a person can act on — the free
  annual credit report (NCA s72) and the 20-business-day dispute; prescribed
  debt (three years, never acknowledge); debt review (what it does, what it
  costs, what it blocks); the NCA interest and fee caps and what "reckless
  lending" means; mashonisa law (unregistered lender, unenforceable, holding
  a card or ID is a crime); emolument attachment orders (court-issued, 25%
  cap); the NFO and NCR complaint routes (free); SASSA grants, reviews and
  the 10% funeral-deduction rule; SRD; UIF (claim within 12 months, 1 day
  per 4 worked, 38–58%); severance (one week per completed year); two-pot
  (one withdrawal per tax year, R2,000 minimum, taxed at marginal rate,
  cannot be cancelled); TFSA (R46,000 a year from 1 March 2026, R500,000
  lifetime, 40% penalty on excess); SARS threshold and auto-assessment;
  funeral cover rules (six-month natural-death waiting period, accidental
  death covered from day one, 30-day cooling off); stokvel safety; lay-by
  rights (CPA s62, 1% cancellation cap); scams (bank never asks, SIM swap
  signs, SAFPS protective registration); free basic electricity and the
  indigent register; FLISP income bands; budgeting rules of thumb
  (payday-first, the three pots, the 24-hour rule); the family-money
  conversation; the debt snowball with the evidence for it.
- `tools` (~30): the places a step sends someone — GoTyme GoalSave, GoTyme
  EveryDay, PayShap, SendMoney, cash at the Pick n Pay or Boxer till; the
  TransUnion, Experian and XDS free reports; the NCR debt-counsellor
  register and consumer line; the NFO; SAFPS; the FSCA licence check; SASSA
  SRD online; the SASSA office; uFiling; SARS eFiling and MobiApp; the fund
  administrator's two-pot portal; a TFSA; the NHFC First Home Finance portal;
  the municipal indigent office; the Council for Debt Collectors register;
  NASASA; a notes-app money log; a sheet budget. Every row with
  `verified_on`, `free_type`, `informal_business_supported` → renamed in
  meaning to "works without a payslip", and a `walkthrough`.

Every figure is sourced in `docs/kb-sources.md`. Where sources conflict
(GoalSave tiers, grant amounts, debt-review fees) the row says so and the
read-time hedge carries it. GoTyme's own site could not be fetched from this
session; its product figures are hedged "confirm in the app" until the
founder verifies them.

## 6. What is deliberately not in this version

- Reading bank statements or the bank's data. Fin knows what it is told.
  A bank integration is the obvious next step and it is the bank's call.
- A second market's library. The code supports it; nobody has verified the
  Philippines' rules yet, and rule 10 forbids guessing.
- A recommendation to take credit, ever.
- Testimonials, user counts, pilot results. No cohort has run.

## 7. Done means

- `npm run typecheck`, `npm test` in both modes, `npm run eval -- --dry`,
  the depth and coverage scripts, all green.
- The whole money journey runs end to end in the e2e test: hello →
  diagnostic → read-back → goal → rule → plan → first step → done → outcome.
- The plan document prints to PDF in Chromium with no banned construct.
- The landing page says what Fin is in the person's words, carries the
  evidence with its caveats, and says out loud that no cohort has run.
- A `db/` folder the founder can paste into a fresh Supabase project in
  order, and a seed the depth script measures.
