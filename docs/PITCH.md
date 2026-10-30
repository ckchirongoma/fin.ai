# Charles — a one-page pitch to the CEO of GoTyme Bank

*A WhatsApp number that knows your money. South Africa first. No cohort has run yet.*

---

## The problem, in your customers' terms

About half of South African adults are not classed as financially literate on the FSCA's baseline (around 51%), and that score has been flat for years (FSCA / Treasury draft National Consumer Financial Education Policy, 2026, via secondary reporting). 10.5 million credit-active consumers — more than a third of everyone with credit — have accounts in arrears, defaults or other negative records (National Credit Regulator, June 2025). In a commercial survey that is not nationally representative, 72% of respondents report money stress, and 90% of those with unsustainable debt do not use debt counselling (DebtBusters Money-Stress Tracker, 2026). In a lender's own survey, 32% of borrowers used a mashonisa in the last year, double the year before, 85% of them because their credit score was too low; mashonisas commonly charge 30–50% a month and are unregistered, so the debt is unenforceable (Wonga survey 2026; NCR statements). R2.41 billion was lost to digital banking crime in 2025, 89% of cases through banking apps, almost all social engineering (SABRIC Annual Crime Statistics 2025). More than 11 million South Africans belong to a stokvel, by NASASA's own estimate (August 2025). The SRD grant stays at R370 a month to March 2027 (Treasury 2026 Budget); other 2026 grant amounts circulate on third-party sites and have to be confirmed on sassa.gov.za.

You have said yourself that the number of credit-worthy South Africans has barely moved in fifteen years. The customer behind these numbers is not illiterate. She is overwhelmed. Picture a nurse's aide on R7,800 with two children, a mother to support, a clothing account, a bank loan and a mashonisa does not need a course (an invented example, not a customer; no cohort has run). She needs one rule and a plan that fits her payday.

## Why content did not work

TymeBank launched a financial-literacy SMS service with Juntos in 2020 — budgeting, saving and credit tips — and an education app, TymeCoach, with a chatbot. The national score did not move. That was the right instinct with the wrong unit: the message, not the household. Two findings explain it.

- **Rules of thumb beat lessons.** Drexler, Fischer and Schoar (American Economic Journal: Applied Economics, 2014) ran a randomised trial in the Dominican Republic: a simple rule-of-thumb course — separate the money physically, one rule at a time — improved financial practices and revenues where standard accounting training did nothing, and the gains were largest for people with the weakest starting practices.
- **Menus hurt the weakest.** A Harvard Business School field experiment (Otis, Clarke, Delecourt, Holtz and Koning, Working Paper 24-042) gave 640 Kenyan entrepreneurs an AI mentor on WhatsApp that offered three to five suggestions per question. No average effect: the strongest gained 15–20%, the weakest did about 10% worse, because they could not tell which suggestion fitted them.

So the usual chatbot makes the customers who most need help worse off. Generic content is the control condition.

## What Charles does differently

Charles is a WhatsApp number that learns one household's money once — twelve questions, about five minutes — reads it back for the person to confirm, and then builds a 90-day plan from a fixed library of thirteen proven moves. The person chooses the goal (from three genuinely different ones) and the one money rule they will live by (from three, shown against what people in their situation usually do instead). WhatsApp then pushes them through the plan one step at a time: send, do, done, did it help. Their own AI (ChatGPT, Claude) can connect to the same memory.

The rules Charles keeps, written into the code and tested:

1. The plan comes from the fixed library, never freestyled.
2. It never claims the person said something they did not.
3. One recommendation, never a menu.
4. The person chooses the goal and the rule.
5. Their money is read back once, confirmed, and reused.
6. Every figure comes from a verified, dated source; past 90 days it is hedged to "confirm first"; where sources disagree, Charles says so.
7. Free and reversible before anything that costs money.
8. Hardship mode: if someone cannot cover food, rent or transport, Charles stops planning, protects cash, names the free help (the NCR's consumer line, 0860 627 627; the National Financial Ombud) and pauses with a way back.
9. It never recommends credit — no loan, no buy-now-pay-later, no cash advance, however cheap. A bank product that costs nothing and is reversible (a savings pocket, an instant payment) may be named where it fits; a loan may only be explained.
10. It never asks for or stores an ID number, account number, card number, PIN, OTP or password, and says so in its first message. Charles reads no statement and no app; it knows what the person tells it.
11. "Forget my money" deletes everything.
12. Anything the person's own AI suggests changing is confirmed with them on WhatsApp first.

The plan is one document — where your money stands, the strategy, the next 90 days — that prints, downloads, and is readable on the web. Underneath it is a Money Map: eight areas (money in, money out, what you owe, emergency money, credit record, cover, family money, the future), each scored against the same fixed rubric for every household, so a bank or a programme can compare cohorts with one ruler. An area only moves when the person shows it moved.

## Why a bank, and why this bank

A plan step for a GoTyme customer is not advice. "Move R50 to the savings pocket on grant day" is a thing your app already does, for free. Charles sits on top of the rails you have built and turns them into habits. A household that Charles steadies — arrears cleared, a cushion that grows on payday, a bank-visible record of behaviour — is a customer who could not be underwritten yesterday and might, later, be lent to responsibly. Charles promises no outcome; the measure we would propose is your own, the share of customers who become credit-worthy, and the first thing a pilot must prove, given the Kenya evidence, is that the weakest customers do no worse. Doing no harm is the feature: hardship mode pushes no product, names the free debt counsellor and the ombud, and pauses the plan. That is what earns the trust a lending relationship needs.

## What Charles needs from the bank

- A WhatsApp number on the bank's business account.
- A pilot cohort, invited by the bank.
- Nothing from the core systems at first. Charles knows only what each person tells it. The same connector a person's own AI uses is a door the bank's data could use later; that is the bank's call, and it is deliberately not built until you make it.

## What is deliberately not built

- Reading bank statements or the bank's data.
- A second market's library. The code supports one (the Philippines is the obvious next, with Tyme's 11 million customers there), but nobody has verified that market's rules, and the rules forbid guessing.
- A recommendation to take credit, ever.
- Testimonials, user counts, pilot results.

## Honest status

No cohort has run. There are no testimonials because there are no users, and there are no results on this page because there are none to report. What exists is the whole journey on a WhatsApp test number — hello, diagnostic, read-back, goal, rule, plan, first step, done, did it help — a South African library of rights, rules and places to go with the date each row was checked, the printable plan document, the web plan viewer, and the connector for the person's own AI. Pricing and outcome targets are not in this document; a pilot would set the measures before anyone talks about scale.

## See it before a pilot

Three pages run on invented data and say so on the page: the WhatsApp-style chat on an example household (`/ask.html?demo=1`), a full 90-day plan document as it prints (`/example-plan.html`), and the cohort console a bank reads (`/sponsor.html?demo=1`), with the do-no-harm check that a real pilot would turn on.

## What Charles is, legally

Charles teaches and plans with the person. It is financial education, not financial advice: it never tells anyone which product, policy, fund or investment to buy, never rates a provider, never says a figure is guaranteed, and never recommends credit. It explains how a thing works, what it costs on a checked fact, and what to confirm, and leaves the choice with the person. That line is in its first message, in every prompt and on every plan.

*Nothing here is a loan recommendation.*
