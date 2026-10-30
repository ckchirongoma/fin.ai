/*
# Charles — the bank statement a person chose to send (apply AFTER 0035)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once. The code does not depend on it: until it runs, a statement is
still read and said back, and the column write fails quietly.

1. What this does, in plain terms
Adds `businesses.statement jsonb`: the totals and payees api/_lib/statement.ts
kept from a bank statement, payslip or credit report the person sent on
WhatsApp. Money in by source, money out by payee with its kind, bank fees,
cash drawn, days below zero, what was left, and the page's own flags (a
returned debit order, an arrears note). Read once, with one model call told
to leave out the account number, card number, ID number, the holder's name
and every reference number; scrubbed again in code; and the file itself is
never stored anywhere.

It is on the household row, so "forget my money" deletes it with everything
else, and it is reachable only through the backend's service role (0001).

2. Rule 12, kept
Charles never asks for an account number and never keeps one. A statement
carries one; this column never does. test/statement.test.ts pins that.
*/

ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS statement jsonb;

COMMENT ON COLUMN public.businesses.statement IS 'The bank statement (or payslip, credit report) the person chose to send, as totals and payees only (api/_lib/statement.ts). Never the file, never an account number.';
