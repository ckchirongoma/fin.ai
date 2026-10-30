# Cards: pictures of your money, on a phone — design note (2026-10-30)

## What the founder asked for

"Render images, nice things... small HTMLs, a link, and then you can open it
and play around with it on your phone, but it shows you some cool shit."

## The shape

A card is a snapshot of one picture of the person's money, built in code
from their own figures, stored behind a long random link for sixty days, and
sent on WhatsApp as a picture whose caption carries the link.

| Kind | What it shows | What it is built from |
|---|---|---|
| month | The month in three pots: must-pay, food and transport, what is left. A slider for what goes to a savings pocket on payday and what 90 days adds up to; untick a loose line to see what stopping it frees. | The statement they sent (statement.ts budgetFromStatement). |
| debt | When what they owe is gone at what they pay a week; the balance falling week by week; R50 more a week and how many weeks sooner. Interest is a blank field. | The statement's loan line, or their own words ("R200 a week on R800"); otherwise empty fields to type into. |
| map | The eight areas red, amber or green, each with its note and what sorted would mean; steps done; the day of the ninety; the days a step got done. | businesses.map, the plan and its steps. |
| statement | In against out, the biggest lines as bars by kind, fees, cash, days below zero, what the page itself flagged. | The statement they sent. |
| goal | How much per payday gets to a number, and the date; a jar that fills; the Christmas check. | The goal they chose and their words; the statement's put-away figure when there is one. |

Pieces: `api/_lib/cards.ts` (data builders, the pages, the links, the demo
figures), `api/card.ts` (`/c/<token>` and `/c?demo=<kind>`), `engine/cards.ts`
(build, mint, draw with Chromium through `render-pdf` as PNG, upload, send as
an image, fall back to the link), `db/0037_cards.sql`.

When a card goes out: a statement read (statement card), "Plan my budget"
(month), "how am I doing?" with a plan (the answer, then the map), the plan
hand-over (the map link), "show me my month / what I owe / my map / my
statement / my goal" at any stage, and the connector's `get_card`.

## What it must never do

- Let a model write a card: no figure on one is generated.
- Carry a phone number, an account number or a surname.
- Guess an interest rate: the debt card's rate field is blank until the
  person types one.
- Show a loan to end a loan.
- Outlive the household: `forget my money` deletes the rows.

## Tests

`test/cards.test.ts`: every page renders with its figures and nothing
external; script-closing labels are neutralised; data comes from the
household only; the typed asks; the link is a hashed token that serves the
snapshot, expires and says nothing about who; the demos; the statement,
budget, typed and progress triggers in a conversation, with the picture and
with the link alone when the render fails; the connector; the forget cascade.
`scripts/preview-cards.mts` draws the five demos at phone width and fails on
overflow or a script error.
