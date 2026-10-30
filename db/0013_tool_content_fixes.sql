/*
# Charlie — tool-content corrections from the Priority 4.3.1 research pass (apply AFTER 0012)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once — every statement is a keyed UPDATE or an idempotent ADD COLUMN.

1. What this does, in plain terms
Five `tools` rows had gone stale or were quietly wrong, and six had never
been genuinely verified at all. This migration:
  - Corrects `zoho_books`, `turnover_tax`, `meta_pages`, `gbp` and `sedfa`
    against sources fetched and read directly today (2026-09-22), each cited
    inline below.
  - Adds `needs_verification boolean`, defaulting to false, and sets it true
    on the six tools this pass still could not find a genuine step-by-step
    for (`expresspay_gh`, `hubtel`, `ozow`, `speedaf_ghana`, `veira_pos`,
    `yango_delivery_ghana`) — existing content is left in place rather than
    replaced with invented steps; the flag is the honest signal that a human
    (or a future session with live-site/login access) still needs to check
    these. `ozow` gets both: its sign-up portion was genuinely improved with
    sourced detail below, AND it keeps the flag, because the post-login
    dashboard steps still are not independently re-confirmed this session.
  - `seed/tools.json` (the point-in-time mirror `scripts/seed.mjs` upserts
    from) is updated with the identical corrections in the same commit, so
    a future `node scripts/seed.mjs` run does not silently revert this
    migration's fixes back to the stale snapshot — see that script's own
    header comment for why the two can otherwise drift.

2. One correction to .FIX-PROMPT-MASTER.txt's own research, found by
   actually doing the "verify directly" step it asked for
`zoho_books`: the brief this migration was written from claimed "Zoho Books
does not offer a permanent free plan, but it does provide a free trial" and
asked to verify directly on zoho.com/books/pricing before correcting. Doing
exactly that (fetched zoho.com/za/books/pricing directly, 2026-09-22,
confirmed against the raw page HTML, not just a summarizer) shows the
opposite: Zoho Books DOES have a permanent free plan — "As long as your
revenue for the financial year does not exceed the threshold of 1 Million
ZAR, Zoho Books's Free Plan is available indefinitely" (1 user + 1
accountant, up to 1,000 invoices/year, up to 1,000 expenses/year, email
support). The 14-day trial exists separately, for the PAID tiers only. The
stored "free plan" framing was therefore already directionally correct; what
it lacked was the concrete limit, which is what this UPDATE adds. Source:
https://www.zoho.com/za/books/pricing/ — checked 2026-09-22.

`turnover_tax`: the brief said registration is "now via SARS Online Query
System / eFiling". Checking sars.gov.za/types-of-tax/turnover-tax/how-to-register/
directly (2026-09-22) shows this is half right and half stale: SOQS is real
and current, but "The eFiling option is not yet available for submission of
the TT01 application form" — eFiling is NOT currently a channel for this
specific form. The UPDATE below reflects SOQS + the TT01 form (branch/email),
not eFiling. Thresholds (compulsory R1m → R2.3m, voluntary R50k → R120k,
tax-free R600k, effective 1 April 2026) were confirmed as stated, directly
against sars.gov.za/businesses-and-employers/small-businesses-taxpayers/ and
sars.gov.za/types-of-tax/turnover-tax/.

`meta_pages`: confirmed Meta has moved page/asset setup into Meta Business
Suite at business.facebook.com, with the old separate "Business Manager"
product name retired from that flow (some Meta documentation still calls the
settings/ownership layer "Business Portfolio"). The stored walkthrough
described a plain facebook.com "tap Pages, Create new page" flow that didn't
match the tool's own url (business.facebook.com) — rewritten to the real
Business Settings → Accounts → Pages / Instagram accounts flow, sourced from
Meta's own help center. Sources: facebook.com/business/help/720478807965744
(add a Page), facebook.com/business/help/620548115562686 (add Instagram),
facebook.com/help/977869848936797 (WhatsApp action button) — checked
2026-09-22.

`gbp`: the exact replacement text from .FIX-PROMPT-MASTER.txt's worked
example was re-verified against support.google.com/business/answer/7107242
directly (2026-09-22) and still holds; refined slightly with the video-call
requirement detail (show signage, premises, proof of management) also on
that same page.

`sedfa`: not in the "at minimum" list but flagged in the brief as "likely
fine, but verify the URL/contact details are still current". They were not:
seda.org.za is the pre-merger domain. The live, current site is
sedfa.org.za (confirmed reachable, same phone number 0860 103 703 /
(086) 010-3703, same Hatfield/Centurion offices). Source:
https://www.sedfa.org.za/, https://nationalgovernment.co.za/units/view/452/
— checked 2026-09-22.

3. The six flagged tools
expresspay_gh, hubtel, speedaf_ghana, veira_pos, yango_delivery_ghana: a
fresh web-search pass today reached the same wall the brief describes —
marketing copy, login screens, or contact numbers, but no genuine step-by-
step for first-time sign-up (Hubtel and ExpressPay's own sign-up pages
render as bare email/password forms with no visible field list past that;
Speedaf and Yango's own sites give a phone/WhatsApp booking number and a
feature summary, not a numbered flow; Veira's pages are all SEO/marketing
content). Existing stored content is left as-is rather than replaced with
invented steps, per CLAUDE.md rule 10 — only the flag is added.
ozow: genuinely improved this time — ozow.com/become-a-merchant, fetched
directly, lists the actual two sign-up paths (formal CIPC-registered vs.
informal via the Ozow.ME app) and the real document checklist for each. The
walkthrough's opening steps are corrected to match; the post-approval
dashboard steps (Payment Links, creating a link) are unchanged because nei-
ther this pass nor the prior one could independently confirm them — hence
still flagged.

4. Security
`tools` is a reference table (RLS public-read since db/0001); this migration
only adds a column and updates existing rows, so no policy changes needed.
*/

ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS needs_verification boolean NOT NULL DEFAULT false;

-- ── zoho_books — free plan is real, not just a trial; add the actual limit ──
-- Source: https://www.zoho.com/za/books/pricing/ (fetched + raw-HTML-confirmed
-- 2026-09-22): "As long as your revenue for the financial year does not
-- exceed the threshold of 1 Million ZAR, Zoho Books's Free Plan is available
-- indefinitely" — 1 user + 1 accountant, 1,000 invoices/yr, 1,000 expenses/yr.
UPDATE public.tools SET
  cost = 'free plan - genuinely permanent while your revenue for the financial year stays under R1,000,000; 1 user + 1 accountant, up to 1,000 invoices/year and 1,000 expenses/year (zoho.com/za/books/pricing, checked 2026-09-22)',
  walkthrough = ARRAY[
    'Only do this once your business money is in its own account, or it will not tell you anything useful.',
    'On zoho.com/za/books, sign up for the free plan — it has no time limit, but only while your revenue for the year stays under R1,000,000, and you get 1 user plus 1 accountant seat. Do not start a paid trial unless you already know you are over that.',
    'Set your currency to Rand and your financial year to March, which is the South African tax year.',
    'Add your customers and create your first invoice with your real banking details on it.',
    'Log every expense as it happens, with a photo of the slip.',
    'At month end, open the Profit and Loss report. That number is what the business actually made.'
  ]::text[],
  verified_on = DATE '2026-09-22'
WHERE id = 'zoho_books';

-- ── turnover_tax — 2026/2027 SARS thresholds + the real registration channel ──
-- Source: https://www.sars.gov.za/businesses-and-employers/small-businesses-taxpayers/
-- and https://www.sars.gov.za/types-of-tax/turnover-tax/how-to-register/
-- (both fetched directly 2026-09-22). Compulsory R1m→R2.3m, voluntary
-- R50k→R120k, tax-free R600k, effective 1 April 2026. Registration is via
-- SOQS (tools.sars.gov.za/sarsonlinequery/turnovertax) or the TT01 form at a
-- branch/by email — NOT eFiling: "The eFiling option is not yet available
-- for submission of the TT01 application form" (sars.gov.za, same page).
UPDATE public.tools SET
  fits = 'micro businesses under R2.3m turnover (raised from R1m, effective 1 April 2026) that want one simple tax',
  not_when = 'over R2.3m turnover',
  setup = 'check eligibility → apply via SARS Online Query System (SOQS) or the TT01 form → confirm with SARS or an accountant',
  walkthrough = ARRAY[
    'First check you qualify: turnover under R2.3 million a year (this compulsory threshold was raised from R1 million, effective 1 April 2026), and you are not a personal service provider. The first R600,000 of turnover is taxed at 0%. sars.gov.za sets this out.',
    'Register on the SARS Online Query System (SOQS) at tools.sars.gov.za/sarsonlinequery/turnovertax — that is the current way in, alongside the TT01 form submitted at a branch or by email. (eFiling itself does not yet accept the TT01 form.)',
    'The form you are completing either way is the TT01, the turnover tax registration form.',
    'Fill in your expected turnover for the year. Be honest; it gets reconciled later.',
    'Register before the new tax year starts on 1 March (so by end of February) if you are already trading, or within two months of starting if you are new. Then diarise the payment dates — usually two during the year and a final return.',
    'Confirm with an accountant or SARS before you commit, as it is not the better option for every business.'
  ]::text[],
  verified_on = DATE '2026-09-22'
WHERE id = 'turnover_tax';

-- ── meta_pages — Meta Business Suite is the real current entry point ──
-- Sources (fetched 2026-09-22): facebook.com/business/help/720478807965744,
-- facebook.com/business/help/620548115562686, facebook.com/help/977869848936797.
UPDATE public.tools SET
  setup = 'sign in at business.facebook.com → create/add your Page and connect Instagram in Business Settings → add the WhatsApp action button → post real work 3 times a week',
  walkthrough = ARRAY[
    'Go to business.facebook.com and sign in with your personal Facebook account. (Meta has folded the old separate "Business Manager" product into Meta Business Suite — this is the current entry point, not a separate app.)',
    'In Business Settings (the gear icon), open Accounts → Pages → + Add, then choose Create a new Facebook Page (or Add an existing Facebook Page if your business already has one). Use your exact business name and pick the category that matches what you do.',
    'In Business Settings → Accounts → Instagram accounts → + Add, log in with your Instagram account to connect it — it needs to be set to Business or Creator, not a personal account.',
    'On your Page, click the three dots next to your profile photo, choose Add/Edit Action Button, and set it to Send WhatsApp Message — you will need your WhatsApp Business number linked first.',
    'Post three real pieces of work in your first week. Real photos beat stock images every time.'
  ]::text[],
  verified_on = DATE '2026-09-22'
WHERE id = 'meta_pages';

-- ── gbp — the real 5 verification methods, not "usually a video or a postcard" ──
-- Source: https://support.google.com/business/answer/7107242?hl=en, fetched
-- directly 2026-09-22 (re-verifies .FIX-PROMPT-MASTER.txt's worked example,
-- which still holds; refined with the video-call requirement detail).
-- array_replace (not a positional index) so this is a no-op, not silent
-- corruption, if the live row's wording has already drifted from the exact
-- string quoted as evidence in .FIX-PROMPT-MASTER.txt.
UPDATE public.tools SET
  walkthrough = array_replace(
    walkthrough,
    'Verify — usually a short video or a postcard. You are not live on the map until you do.',
    'Verify: Google offers you a method automatically once your details are in — phone/SMS or email if your listing qualifies (both immediate); instant, automatic verification if your business website is already verified in Google Search Console; otherwise a live video call with a Google rep during business hours (not a pre-recorded video — you show your signage, premises and proof you manage the business), or a postcard by mail (most arrive within 14 days, and the code expires after 30). Whichever you get, Google''s review can then take up to 5 business days. You are not live on the map until it is verified.'
  ),
  verified_on = DATE '2026-09-22'
WHERE id = 'gbp';

-- ── sedfa — URL drift found while re-checking the merger note ──
-- Source: https://www.sedfa.org.za/ (live, fetched 2026-09-22) and
-- https://nationalgovernment.co.za/units/view/452/ — seda.org.za is the
-- pre-merger domain; sedfa.org.za is current. Same phone number confirmed
-- (0860 103 703 / (086) 010-3703), so that part of the brief already held.
UPDATE public.tools SET
  url = 'https://www.sedfa.org.za/',
  walkthrough = array_replace(
    walkthrough,
    'On seda.org.za, use Find a branch and pick the one closest to you.',
    'On sedfa.org.za, use the Branches / Get In Touch page to find the one closest to you, or call 0860 103 703 for directions to your nearest branch. (seda.org.za is the pre-merger domain; sedfa.org.za is the current one.)'
  ),
  verified_on = DATE '2026-09-22'
WHERE id = 'sedfa';

-- ── ozow — genuinely improved sign-up detail, still partially flagged ──
-- Source: https://ozow.com/become-a-merchant, fetched directly 2026-09-22:
-- two real paths (formal CIPC-registered vs. informal Ozow.ME app) and the
-- actual document checklist for each. Dashboard steps after approval remain
-- unconfirmed this session — see needs_verification below.
UPDATE public.tools SET
  walkthrough = ARRAY[
    'On ozow.com, open Become a Merchant. There are two paths: a full CIPC-registered business, or an informal merchant via the Ozow.ME app if you are not registered.',
    'Formal path: have ready your CIPC business registration number, SA ID document, a registered mobile number, banking details, proof of SA residency, and any licences your business needs. Informal path: the same list, minus the CIPC number.',
    'Fill in the short enquiry form (first name, surname, business email, company name, industry) and Ozow follows up — or, if you are ready to go straight through, sign up directly at signup.ozow.com.',
    'Once approved, open the dashboard and find Payment Links.',
    'Create your first link: put in the amount, or leave it open so the customer types it.',
    'Send that link in a WhatsApp chat and test it by paying yourself R5. The money lands straight away, no waiting for an EFT.'
  ]::text[],
  verified_on = DATE '2026-09-22',
  needs_verification = true
WHERE id = 'ozow';

-- ── the five still-unverified tools: flag only, content left in place ──
-- A fresh search+fetch pass today (2026-09-22) reached the same wall as the
-- prior session for each of these — see the file header for exactly what
-- was and was not found for each. No content invented; flag added instead.
UPDATE public.tools SET needs_verification = true
WHERE id IN ('expresspay_gh', 'hubtel', 'speedaf_ghana', 'veira_pos', 'yango_delivery_ghana');
