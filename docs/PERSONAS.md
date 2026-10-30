# Personas and roles

Who Charles is for, who else touches it, and the invented households the tests
and the eval harness use. **Every person named here is made up.** No cohort
has run; nothing below is a customer.

## Roles (who can do what)

| Role | Door | What they can do | What they cannot see |
|---|---|---|---|
| **The person** | WhatsApp; the web plan viewer (`/plan`, signed in with their WhatsApp number and a one-time code); their own AI through the connector (`/mcp`) | Everything about their own money: the diagnostic, the plan, the Money Map, every step, their progress report, "forget my money" | Anyone else's data. The library's sources. |
| **The bank or programme (sponsor)** | The cohort console (`/sponsor.html`, a sponsor key minted by the operator) | Aggregate results only, split by baseline tier so harm to the weakest is visible: onboarded, with a plan, active, steps done, outcomes better/same/worse, areas moved to green, the guardrail counts. Printable. Groups under five people are withheld. | Names, numbers, anything a person wrote. Gender or age (Charles does not collect them). |
| **The operator** (the founder, the team) | `/admin.html` with `ADMIN_SECRET`; the alert emails; `/api/health` | What people tried and could not do, failures, guardrail flags, the funnel, one person's trace by id | A person's words unless `ALERT_EMAIL_EXCERPTS` is on, and never in email by default |
| **Claude Code** | This repository | Build, test, research the library | Production data without the founder (BEHAVIOR-MATRIX rule 9) |

## The four money stages (how Charles sees a household)

- **Surviving**: cannot make the month without borrowing or going without. Hardship mode is close; the plan starts with the money bleeding fastest.
- **Stretching**: makes the month, nothing kept. The plan is usually the month, the debts and a first cushion.
- **Steady**: a small cushion and the debts under control. The plan protects what is there and starts the future.
- **Building**: saving toward something. The plan names the goal and the place the money lives.

## The invented households (used in tests and the eval set)

| Persona | Stage | Money in | What is in the way | What they want | Where Charles starts |
|---|---|---|---|---|---|
| **Lerato**, Diepsloot | Surviving | Domestic work three days a week, paid cash on Fridays; two child support grants | A mashonisa (R800, R200 a week) and a clothing account; nothing put away; the month runs out around the 24th | Pay off the mashonisa and put R1,000 away by Christmas | Get out of the mashonisa's book, then the three pots, then a named cushion |
| **Nomsa**, Tembisa | Surviving → stretching | A cleaning job at a school; one child grant | Behind on the rent; a bank loan and a cellphone contract; less than a week's spend reachable; no cover | Get the month to fit without borrowing | Hardship check first; then the month, the owed list, a first R500 |
| **Thabo**, Soweto | Steady | A warehouse salary, about R9,500 | A clothing account in arrears; declined for a phone contract | Fix the credit record and start saving for a deposit | The free credit reports, the dispute, the settled-account letter, then the cushion and the goal |
| **Gogo Dlamini**, KwaMashu | Surviving | The old age grant, two grandchildren | Deductions off the grant before she sees it; two funeral policies; nothing saved | Stop the money finishing before the month ends | The SASSA deduction rule, one policy not two, the three pots on grant day |

## What a persona never is

Not a segment to target, not a label stored on the row, and not a reason to
assume. Charles reads every household from its own twelve answers; the personas
exist so the tests, the eval harness and the demo pages have real-shaped
households to run through, and so the bank can see the kind of person the
product is for without anyone's data being shown.
