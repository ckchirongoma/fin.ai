# A bank statement, by choice — design note (2026-10-30)

## What the founder asked for

"If you want, I can look at your bank statement and explain your finances
back to you, then plan a budget." Optional. Also: what else could a person
send? A payslip and a credit report, read the same way.

## The shape

One door, four pieces, three of them plain code.

1. **The offer**, said twice and never pushed: under the income question
   ("Or send me a bank statement, a PDF from your banking app or a photo of
   the pages, and I'll read it back to you. I keep only the totals and who
   gets paid, never the account number, and I don't keep the file.") and as
   the answer to "can you read my bank statement?" at any stage.
2. **The reading** (`readMoneyDocument`): one model call on the multimodal
   `wa_reply` model, extraction only, a small fixed JSON: money in by source,
   money out by payee with a kind (loan, store account, insurance, rent,
   groceries, transport, airtime, bank fees, cash, …), totals, days below
   zero, the page's own flags. Told to leave out the account number, card
   number, ID number, the holder's name and address, reference numbers, and
   private people's names. `scrubText` then drops any long digit run or
   labelled identifier that got through. `{"doc":"not_money"}` sends a flyer
   or a quote on to the ordinary forward reader.
3. **What is said back** (`explainBack`, `budgetMessage`): built in code from
   the summary, so every figure is the page's own (rule 10) and nothing can
   be invented. The read-back ends on "Does this look like a normal month?"
   with three buttons: Normal month, Not a normal month, Plan my budget. The
   budget is the three pots the m_month module teaches: what must be paid
   the day money lands, food and transport, what is left; then the one move
   from their own numbers, and the costliest loan line named as the costliest
   money (never as something to refinance, rule 11).
4. **Where it goes**: `businesses.statement` (db/0036, on the household row,
   so "forget my money" takes it), and one line under the diagnostic answers
   keyed `statement` whose first words are "From the bank statement they
   sent", so every plan prompt and the price grounding see real figures and
   `base()` tells every model to say "your statement shows", never "you
   said" (rule 2). The context gets a `statement` line in code; the plan
   document prints it as a fact row; the connector returns it in
   `get_household_context`.

In the diagnostic: the income question is answered from the statement out
loud ("I'll take it from your bank statement, about R4,820 a month. If that's
not a usual month, tell me the usual figure later") unless the person said it
was not a normal month; "who do you owe" names the loan and store-account
payees the statement shows so none is left off.

## What it must never do

- Ask for a statement. It is offered.
- Store the file, anywhere, for any time.
- Keep an account, card, ID or reference number: dropped by the prompt, then
  by code, pinned by `test/statement.test.ts` with a model that returns them.
- Let a model write a figure into the read-back or the budget.
- Recommend credit off the back of what it sees.

## Tests

`test/statement.test.ts`: the parser and scrubber; the read-back for a
statement, a payslip and a credit report; the summary and document lines; the
budget maths and the short-month case; the typed question; the whole flow in
a conversation mid-diagnostic and after the plan; the flyer still going to
the forward reader; the plan context and document; the connector; the forget
cascade.
