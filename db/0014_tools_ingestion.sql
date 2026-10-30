/*
# Charlie — tools: which kind of free, informal-business fit, a ten-minute first action; ten new rows; Yoco's rate (apply AFTER both 0013 files)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once: every column is ADD COLUMN IF NOT EXISTS, the constraint is added
only if missing, every data statement is a keyed UPDATE, and every new row is
inserted only WHERE NOT EXISTS for its (id, country).

1. What this does, in plain terms
  - Adds three columns to `tools`:
      `free_type text NOT NULL DEFAULT 'UNKNOWN'` — WHICH kind of free (or
        not) a tool is: FREE_FOREVER, FREE_TIER, FREE_TRIAL,
        FREE_FOR_QUALIFYING_USERS, NO_MONTHLY_FEE, PAY_PER_TRANSACTION,
        GOVERNMENT_GRANT or UNKNOWN (CHECK-constrained to exactly those).
        The default is UNKNOWN on purpose: a row nobody classified can never
        be labelled free by accident. See api/_lib/freetype.ts for the label
        each one puts in front of the cost, everywhere a cost is shown.
      `informal_business_supported boolean` — can an owner who has NOT
        registered the business use it? NULL means nobody checked, and the
        code never reads NULL as "no".
      `ten_minute_action text` — the one thing an owner can do in the next
        ten minutes to start. Required for every row added from this
        migration on. That rule is enforced by test/tools-ingestion.test.ts
        against seed/tools.json rather than by a database constraint: a
        CHECK or an INSERT trigger would also fire on scripts/seed.mjs's
        upsert of the 55 older rows, which legitimately have none, and break
        seeding a fresh project.
  - Backfills free_type on all 55 existing rows, and
    informal_business_supported where the row's own content settles it
    (a registration portal: false; a free app anyone can install: true);
    every other row stays NULL rather than guessed.
  - Corrects Yoco's card rate (section 3 below).
  - Adds ten rows: zoho_invoice and buffer (ZA), three purchase-order / invoice
    funders for South Africa (sourcefin, oricred, umsebenzi_capital), and five
    Kenyan funders (adifa, uwezo_fund, yedf, kie_micro_loan, kie_sme_loan).
  - seed/tools.json carries the identical data in the same commit (both are
    generated from one source), so `node scripts/seed.mjs` cannot revert this.

2. How the new rows were checked — read this before trusting them
Every fact below traces to the provider's own official domain, checked
2026-09-22. This environment's network policy blocked fetching those sites
directly, so the evidence is web-search results restricted to each official
domain (the search engine's extracts of those pages), not a read of the full
rendered page. Anything that could not be confirmed that way is left OUT of
the row, or written as "not published — get it in writing", never filled in:
  - No fee is invented for any funder. Sourcefin, Oricred, Uwezo, KIE and
    YEDF's individual loans publish no rate on the pages checked; their rows
    say so and are free_type UNKNOWN.
  - KIE's SME loan range is KSh 100,000–20 million over up to 84 months with
    at least 2 years' trading (an earlier brief's "5+ employees" gate was not
    found and is not in the row).
  - Uwezo lends to registered groups only, applied for at the constituency
    office; the first-loan amount is not published (only the KSh 500,000 cap
    on repeat loans is).
  - Oricred's invoice advance is only for invoices to government or listed
    blue-chip clients — in the row's own not_when.
  - Umsebenzi publishes no minimum order size, so none is claimed.
  - Zernio was dropped: it is developer infrastructure (CLAUDE.md, "About
    Zernio"), not a tool an owner signs up for.
  - No purchase-order or invoice financier for Nigeria or Ghana is added.
    That gap is still open.
  - Buffer is added for ZA only, like every other global tool in this table;
    rows for KE, NG and GH are a separate, later change.

3. Security
`tools` is reference data (public read since db/0001). This adds columns and
rows only; no policy changes are needed.
*/

-- ── 1. Columns ──────────────────────────────────────────────────────────
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS free_type text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS informal_business_supported boolean;
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS ten_minute_action text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tools_free_type_check' AND conrelid = 'public.tools'::regclass
  ) THEN
    ALTER TABLE public.tools ADD CONSTRAINT tools_free_type_check CHECK (free_type IN (
      'FREE_FOREVER', 'FREE_TIER', 'FREE_TRIAL', 'FREE_FOR_QUALIFYING_USERS',
      'NO_MONTHLY_FEE', 'PAY_PER_TRANSACTION', 'GOVERNMENT_GRANT', 'UNKNOWN'
    ));
  END IF;
END $$;

COMMENT ON COLUMN public.tools.free_type IS 'Which kind of free (or not) this tool is. See api/_lib/freetype.ts. UNKNOWN is never labelled free.';
COMMENT ON COLUMN public.tools.informal_business_supported IS 'Usable without registering the business? NULL = not checked, never read as no.';
COMMENT ON COLUMN public.tools.ten_minute_action IS 'The first thing an owner can do in ten minutes. Required on rows added from db/0014 on (enforced in tests).';

-- ── 2. Backfill: every existing row gets a free_type and, where the
--    row's own facts settle it, informal_business_supported ─────────────

UPDATE public.tools SET free_type = 'FREE_FOREVER'
WHERE id IN ('gbp', 'meta_pages', 'protenders_fund_finder', 'sedfa', 'sheets', 'sme_south_africa', 'turnover_tax', 'wa_business');

UPDATE public.tools SET free_type = 'FREE_TIER'
WHERE id IN ('canva', 'hubspot', 'lovable', 'loyverse', 'simplybook', 'zapier');

UPDATE public.tools SET free_type = 'FREE_FOR_QUALIFYING_USERS'
WHERE id IN ('zoho_books');

UPDATE public.tools SET free_type = 'NO_MONTHLY_FEE'
WHERE id IN ('ikhokha', 'kuda_business', 'moniepoint_pos', 'pochi_la_biashara', 'yoco');

UPDATE public.tools SET free_type = 'PAY_PER_TRANSACTION'
WHERE id IN ('flutterwave', 'gig_logistics', 'hubtel', 'kopokopo', 'kwik_delivery', 'lula', 'mpesa_till', 'mukuru', 'opay_business', 'ozow', 'pargo', 'paystack', 'pesapal', 'snapscan', 'speedaf_ghana', 'swoove', 'yango_delivery_ghana', 'yoco_capital');

UPDATE public.tools SET free_type = 'GOVERNMENT_GRANT'
WHERE id IN ('nyda');

UPDATE public.tools SET free_type = 'UNKNOWN'
WHERE id IN ('biz_account', 'boi_nigeria', 'cac_portal', 'cipc', 'ecitizen_brs', 'expresspay_gh', 'gea_ghana', 'hustler_fund_tool', 'kcb_sme_current', 'lightspeed', 'mtn_momo_ghana', 'orc_portal_ghana', 'respond_io', 'uzapoint', 'veira_pos', 'wati');

UPDATE public.tools SET informal_business_supported = true
WHERE id IN ('canva', 'gbp', 'hubspot', 'hustler_fund_tool', 'lovable', 'loyverse', 'meta_pages', 'mtn_momo_ghana', 'pochi_la_biashara', 'sedfa', 'sheets', 'simplybook', 'wa_business', 'zapier');

UPDATE public.tools SET informal_business_supported = false
WHERE id IN ('cac_portal', 'cipc', 'ecitizen_brs', 'nyda', 'orc_portal_ghana', 'sme_south_africa', 'turnover_tax');

-- ── 3. Yoco: the card rate had changed ────────────────────────────────
-- Source: yoco.com/za/pricing/ (checked 2026-09-22): 2.3% ex VAT per in-person
-- payment below R200,000 a month, coming down to 1.2% as you transact more;
-- custom rates above R200,000 a month. verified_on stays 2026-09-11 on purpose:
-- only the rate was re-checked today, not the R699 machine price or the payout
-- time, and the date must not claim more than was checked.

UPDATE public.tools SET cost = 'machine from R699 once-off, no contract; 2.3% ex VAT per in-person card payment, coming down to 1.2% as you transact more, with custom rates above R200,000 a month; in your bank in 1–2 business days (verified Sept 2026)'
WHERE id = 'yoco' AND country = 'ZA';

-- ── 4. Ten new rows ──────────────────────────────────────────────────
-- Each is an UPDATE then an INSERT … WHERE NOT EXISTS keyed on (id, country),
-- so a re-run refreshes the row instead of failing or duplicating it.

-- zoho_invoice (ZA) — sources, all checked 2026-09-22: zoho.com/za/invoice/pricing/, zoho.com/za/invoice/kb/general/zoho-invoice-free.html, .../invoices-creation-free.html, .../kb/invoices/send-invoice-via-whatsapp.html, .../help/settings/reminders.html, .../help/getting-started/exploring-zoho-invoice.html, .../kb/general/change-base-currency.html
UPDATE public.tools SET
  domain = 'getting_paid',
  stages = ARRAY['start', 'run', 'grow']::text[],
  keywords = ARRAY['invoice', 'invoices', 'send invoice', 'quote', 'quotation', 'bill a client', 'not paying', 'owed money', 'late payment', 'chase payment', 'payment reminder', 'zoho', 'zoho invoice']::text[],
  name = 'Zoho Invoice',
  fits = 'you do jobs or sell on account and need proper invoices, quotes and automatic payment reminders, for free, sending fewer than 500 invoices a year',
  not_when = 'you send more than 500 invoices a year or need more than 2 people logged in (free limits); you need full bookkeeping (that is Zoho Books, a different product); you only take cash from walk-ins and never invoice anyone; no email address to sign up with',
  why = 'customers pay faster when they get a proper invoice and an automatic reminder instead of you chasing them',
  cost = 'no subscription (Zoho calls it ''forever free''). Free-plan limits: up to 500 invoices a year, 2 users, 3 projects, and invoices show ''Powered by Zoho Invoice''. Zoho says these limits are updated every year, and your account shows your current usage. No customer limit or revenue limit is published. Zoho takes no fee on payments you receive, but a payment gateway you connect may charge its own fee. For more invoices you move to Zoho Billing, which is paid (price not checked here — confirm before upgrading)',
  url = 'https://www.zoho.com/za/invoice/',
  setup = 'sign up free with your business name, email and a password → choose South Africa as your business location → click the verification link Zoho emails you → add a customer and send your first invoice',
  walkthrough = ARRAY['On zoho.com/za/invoice, sign up for free with your business name, email address and a password, and choose South Africa as your business location.', 'Open the email Zoho sends you and click the link to verify your account.', 'Make sure your currency is rand before you record anything. Zoho says the base currency can''t be changed once you''ve recorded transactions.', 'Add your customer. If you want to send invoices on WhatsApp, save their phone number with the country code (+27), because Zoho needs it.', 'Create the invoice with the due date and payment terms, then send it by email, as a PDF or a link, or open the invoice''s Send menu and choose WhatsApp Message.', 'Turn on automatic payment reminders so customers who pay late get nudged without you having to ask.']::text[],
  verified_on = '2026-09-22'::date,
  informal_business_supported = NULL,
  free_type = 'FREE_TIER',
  ten_minute_action = 'Sign up free on zoho.com/za/invoice with your email, choose South Africa as your location, and send one real invoice to a customer who owes you, by email or WhatsApp.'
WHERE id = 'zoho_invoice' AND country = 'ZA';
INSERT INTO public.tools (id, country, domain, stages, keywords, name, fits, not_when, why, cost, url, setup, walkthrough, verified_on, informal_business_supported, free_type, ten_minute_action)
SELECT
  'zoho_invoice',
  'ZA',
  'getting_paid',
  ARRAY['start', 'run', 'grow']::text[],
  ARRAY['invoice', 'invoices', 'send invoice', 'quote', 'quotation', 'bill a client', 'not paying', 'owed money', 'late payment', 'chase payment', 'payment reminder', 'zoho', 'zoho invoice']::text[],
  'Zoho Invoice',
  'you do jobs or sell on account and need proper invoices, quotes and automatic payment reminders, for free, sending fewer than 500 invoices a year',
  'you send more than 500 invoices a year or need more than 2 people logged in (free limits); you need full bookkeeping (that is Zoho Books, a different product); you only take cash from walk-ins and never invoice anyone; no email address to sign up with',
  'customers pay faster when they get a proper invoice and an automatic reminder instead of you chasing them',
  'no subscription (Zoho calls it ''forever free''). Free-plan limits: up to 500 invoices a year, 2 users, 3 projects, and invoices show ''Powered by Zoho Invoice''. Zoho says these limits are updated every year, and your account shows your current usage. No customer limit or revenue limit is published. Zoho takes no fee on payments you receive, but a payment gateway you connect may charge its own fee. For more invoices you move to Zoho Billing, which is paid (price not checked here — confirm before upgrading)',
  'https://www.zoho.com/za/invoice/',
  'sign up free with your business name, email and a password → choose South Africa as your business location → click the verification link Zoho emails you → add a customer and send your first invoice',
  ARRAY['On zoho.com/za/invoice, sign up for free with your business name, email address and a password, and choose South Africa as your business location.', 'Open the email Zoho sends you and click the link to verify your account.', 'Make sure your currency is rand before you record anything. Zoho says the base currency can''t be changed once you''ve recorded transactions.', 'Add your customer. If you want to send invoices on WhatsApp, save their phone number with the country code (+27), because Zoho needs it.', 'Create the invoice with the due date and payment terms, then send it by email, as a PDF or a link, or open the invoice''s Send menu and choose WhatsApp Message.', 'Turn on automatic payment reminders so customers who pay late get nudged without you having to ask.']::text[],
  '2026-09-22'::date,
  NULL,
  'FREE_TIER',
  'Sign up free on zoho.com/za/invoice with your email, choose South Africa as your location, and send one real invoice to a customer who owes you, by email or WhatsApp.'
WHERE NOT EXISTS (SELECT 1 FROM public.tools WHERE id = 'zoho_invoice' AND country = 'ZA');

-- buffer (ZA) — sources, all checked 2026-09-22: buffer.com/pricing, buffer.com/pricing/publish, support.buffer.com/article/595, /643, /544, /869, /554, /632, /514, /549, /564
UPDATE public.tools SET
  domain = 'getting_found',
  stages = ARRAY['start', 'run', 'grow']::text[],
  keywords = ARRAY['buffer', 'schedule posts', 'social media', 'post every day', 'no time to post', 'plan my posts', 'instagram', 'facebook page', 'tiktok', 'posting', 'content', 'marketing', 'get customers online']::text[],
  name = 'Buffer',
  fits = 'you already have a Facebook Page, Instagram or TikTok and want to write a week of posts in one sitting and let them go out on their own',
  not_when = 'you mainly sell on WhatsApp Status or your personal Facebook profile (Buffer can''t post to either), or you have no business Page or account on a social app yet',
  why = 'write your posts once a week and they go out on time even on your busiest days',
  cost = 'Free plan: $0, no credit card needed. Up to 3 channels connected at a time, up to 10 posts waiting in each channel''s queue at any one time (not a monthly cap: once one goes out you can add another), 100 saved ideas, 1 user. Paid Essentials is $6 per channel per month on monthly billing, charged in US dollars only; your bank converts and may add its own fee. Confirm the current price at sign-up.',
  url = 'https://buffer.com/pricing',
  setup = 'sign up for the Free plan on buffer.com or the Buffer app → connect your Facebook Page, Instagram or TikTok → set your weekly posting times → write posts and add them to the queue',
  walkthrough = ARRAY['Get the Buffer app from the Play Store or App Store, or go to buffer.com, and sign up for the Free plan. You don''t need a card.', 'Log into your Facebook, Instagram or TikTok first, then connect it to Buffer. Facebook must be a business Page, not your personal profile; you log in with the personal profile that is admin of the Page.', 'If your Instagram is a personal account, Buffer can only send you a phone reminder to post it yourself. For automatic posting, switch it to a Professional (Business or Creator) account.', 'In that channel''s settings, set your posting times for the week, for example three slots.', 'Write your posts and choose Add to Queue. Each one goes into the next open slot. The Free plan holds 10 waiting posts per channel, so top it up once a week.', 'WhatsApp is not one of Buffer''s channels, so still put the same post on your WhatsApp Status yourself.']::text[],
  verified_on = '2026-09-22'::date,
  informal_business_supported = true,
  free_type = 'FREE_TIER',
  ten_minute_action = 'Sign up for Buffer''s Free plan without a card, connect your Facebook Page or Instagram, and add your next three posts to the queue.'
WHERE id = 'buffer' AND country = 'ZA';
INSERT INTO public.tools (id, country, domain, stages, keywords, name, fits, not_when, why, cost, url, setup, walkthrough, verified_on, informal_business_supported, free_type, ten_minute_action)
SELECT
  'buffer',
  'ZA',
  'getting_found',
  ARRAY['start', 'run', 'grow']::text[],
  ARRAY['buffer', 'schedule posts', 'social media', 'post every day', 'no time to post', 'plan my posts', 'instagram', 'facebook page', 'tiktok', 'posting', 'content', 'marketing', 'get customers online']::text[],
  'Buffer',
  'you already have a Facebook Page, Instagram or TikTok and want to write a week of posts in one sitting and let them go out on their own',
  'you mainly sell on WhatsApp Status or your personal Facebook profile (Buffer can''t post to either), or you have no business Page or account on a social app yet',
  'write your posts once a week and they go out on time even on your busiest days',
  'Free plan: $0, no credit card needed. Up to 3 channels connected at a time, up to 10 posts waiting in each channel''s queue at any one time (not a monthly cap: once one goes out you can add another), 100 saved ideas, 1 user. Paid Essentials is $6 per channel per month on monthly billing, charged in US dollars only; your bank converts and may add its own fee. Confirm the current price at sign-up.',
  'https://buffer.com/pricing',
  'sign up for the Free plan on buffer.com or the Buffer app → connect your Facebook Page, Instagram or TikTok → set your weekly posting times → write posts and add them to the queue',
  ARRAY['Get the Buffer app from the Play Store or App Store, or go to buffer.com, and sign up for the Free plan. You don''t need a card.', 'Log into your Facebook, Instagram or TikTok first, then connect it to Buffer. Facebook must be a business Page, not your personal profile; you log in with the personal profile that is admin of the Page.', 'If your Instagram is a personal account, Buffer can only send you a phone reminder to post it yourself. For automatic posting, switch it to a Professional (Business or Creator) account.', 'In that channel''s settings, set your posting times for the week, for example three slots.', 'Write your posts and choose Add to Queue. Each one goes into the next open slot. The Free plan holds 10 waiting posts per channel, so top it up once a week.', 'WhatsApp is not one of Buffer''s channels, so still put the same post on your WhatsApp Status yourself.']::text[],
  '2026-09-22'::date,
  true,
  'FREE_TIER',
  'Sign up for Buffer''s Free plan without a card, connect your Facebook Page or Instagram, and add your next three posts to the queue.'
WHERE NOT EXISTS (SELECT 1 FROM public.tools WHERE id = 'buffer' AND country = 'ZA');

-- sourcefin (ZA) — sources, all checked 2026-09-22: sourcefin.co.za/purchase-order-funding-minimum-amount-south-africa/, /purchase-order-funding-requirements-south-africa/, /how-to-apply-purchase-order-funding-south-africa/
UPDATE public.tools SET
  domain = 'growth',
  stages = ARRAY['run', 'grow']::text[],
  keywords = ARRAY['purchase order', 'purchase order funding', 'po funding', 'big order', 'tender funding', 'tender award', 'fund an order', 'stock for the order', 'pay my supplier', 'contract funding', 'sourcefin']::text[],
  name = 'Sourcefin (purchase order funding)',
  fits = 'you''re a registered company holding a confirmed purchase order or tender award from a credible customer, usually worth R250,000 or more, and you can''t pay your supplier upfront to deliver it',
  not_when = 'the business isn''t registered with CIPC or isn''t tax compliant with SARS; the order is small (Sourcefin says below about R200,000 is rarely funded); there''s no confirmed order yet, only a hope of one',
  why = 'a big order you can''t afford to deliver is money left on the table; purchase order funding pays for the goods so you can deliver it, without putting up collateral',
  cost = 'fee not published — get the total rand cost of the deal in writing before you accept. Sourcefin says most deals it funds start around R250,000, below R200,000 is rare, and it does not ask for collateral',
  url = 'https://www.sourcefin.co.za/how-to-apply-purchase-order-funding-south-africa/',
  setup = 'get the purchase order or tender award in writing → gather CIPC registration, SARS tax compliance, CSD registration, B-BBEE certificate or affidavit, recent bank statements and your supplier''s quote → apply on sourcefin.co.za',
  walkthrough = ARRAY['Get the order in writing first: a confirmed purchase order or a tender award letter from your customer. Sourcefin looks at the order, the customer, your supplier and whether you can deliver, not just the amount.', 'Gather what Sourcefin lists: CIPC company registration in good standing, SARS tax compliance status, CSD registration, a B-BBEE certificate or affidavit, recent business bank statements, and your supplier''s quote for the goods.', 'Apply through sourcefin.co.za with the order and those documents.', 'Before you accept, ask for the total fee in rand for this deal, in writing, and check your profit on the order still covers it.']::text[],
  verified_on = '2026-09-22'::date,
  informal_business_supported = false,
  free_type = 'UNKNOWN',
  ten_minute_action = 'Check you have the three things Sourcefin asks for first: the customer''s purchase order or tender award in writing, your CIPC registration, and a SARS tax compliance status. Whichever is missing is your first job.'
WHERE id = 'sourcefin' AND country = 'ZA';
INSERT INTO public.tools (id, country, domain, stages, keywords, name, fits, not_when, why, cost, url, setup, walkthrough, verified_on, informal_business_supported, free_type, ten_minute_action)
SELECT
  'sourcefin',
  'ZA',
  'growth',
  ARRAY['run', 'grow']::text[],
  ARRAY['purchase order', 'purchase order funding', 'po funding', 'big order', 'tender funding', 'tender award', 'fund an order', 'stock for the order', 'pay my supplier', 'contract funding', 'sourcefin']::text[],
  'Sourcefin (purchase order funding)',
  'you''re a registered company holding a confirmed purchase order or tender award from a credible customer, usually worth R250,000 or more, and you can''t pay your supplier upfront to deliver it',
  'the business isn''t registered with CIPC or isn''t tax compliant with SARS; the order is small (Sourcefin says below about R200,000 is rarely funded); there''s no confirmed order yet, only a hope of one',
  'a big order you can''t afford to deliver is money left on the table; purchase order funding pays for the goods so you can deliver it, without putting up collateral',
  'fee not published — get the total rand cost of the deal in writing before you accept. Sourcefin says most deals it funds start around R250,000, below R200,000 is rare, and it does not ask for collateral',
  'https://www.sourcefin.co.za/how-to-apply-purchase-order-funding-south-africa/',
  'get the purchase order or tender award in writing → gather CIPC registration, SARS tax compliance, CSD registration, B-BBEE certificate or affidavit, recent bank statements and your supplier''s quote → apply on sourcefin.co.za',
  ARRAY['Get the order in writing first: a confirmed purchase order or a tender award letter from your customer. Sourcefin looks at the order, the customer, your supplier and whether you can deliver, not just the amount.', 'Gather what Sourcefin lists: CIPC company registration in good standing, SARS tax compliance status, CSD registration, a B-BBEE certificate or affidavit, recent business bank statements, and your supplier''s quote for the goods.', 'Apply through sourcefin.co.za with the order and those documents.', 'Before you accept, ask for the total fee in rand for this deal, in writing, and check your profit on the order still covers it.']::text[],
  '2026-09-22'::date,
  false,
  'UNKNOWN',
  'Check you have the three things Sourcefin asks for first: the customer''s purchase order or tender award in writing, your CIPC registration, and a SARS tax compliance status. Whichever is missing is your first job.'
WHERE NOT EXISTS (SELECT 1 FROM public.tools WHERE id = 'sourcefin' AND country = 'ZA');

-- oricred (ZA) — sources, all checked 2026-09-22: oricred.co.za/, /our-services, /apply/, /invoice-discounting-application/, /application-process/
UPDATE public.tools SET
  domain = 'growth',
  stages = ARRAY['run', 'grow']::text[],
  keywords = ARRAY['purchase order', 'purchase order funding', 'po funding', 'contract funding', 'big order', 'fund an order', 'invoice discounting', 'government invoice', 'government pays late', 'factoring', 'oricred']::text[],
  name = 'Oricred',
  fits = 'you''ve won a purchase order or contract and need money to fulfil it, or you''ve invoiced a government department or a listed big company and can''t wait for them to pay',
  not_when = 'you want an advance on an invoice to a private person or a small business (Oricred''s invoice advance is for invoices to government or listed blue-chip clients); there''s no order, contract or invoice yet',
  why = 'pays for what you need to deliver a big order, or turns a slow government invoice into cash now',
  cost = 'fee not published — get the total rand cost in writing before you accept. Oricred says it funds up to 100% of what''s needed to fulfil a purchase order or contract (for orders worth up to R80 million), and advances up to 75% of an invoice''s value upfront when the invoice is to government or a listed blue-chip client',
  url = 'https://oricred.co.za/apply/',
  setup = 'choose purchase order funding or invoice discounting → complete Oricred''s online application → submit the documents it asks for',
  walkthrough = ARRAY['Decide which you need: purchase order funding (money to deliver an order you''ve won) or invoice discounting (cash now against an invoice you''ve already sent to government or a listed company).', 'Have the purchase order, contract or invoice in hand. That''s what the funding is against.', 'Complete the matching online application on oricred.co.za and submit all the documents it asks for. You can also contact their team first to talk through your deal.', 'Before you sign, get the total fee in rand for this deal in writing, and check your profit on the order still covers it.']::text[],
  verified_on = '2026-09-22'::date,
  informal_business_supported = NULL,
  free_type = 'UNKNOWN',
  ten_minute_action = 'Check who your customer is: Oricred''s invoice advance is only for invoices to government or a listed big company. If yours is, or you hold a signed purchase order, open oricred.co.za/apply and see which documents it asks for.'
WHERE id = 'oricred' AND country = 'ZA';
INSERT INTO public.tools (id, country, domain, stages, keywords, name, fits, not_when, why, cost, url, setup, walkthrough, verified_on, informal_business_supported, free_type, ten_minute_action)
SELECT
  'oricred',
  'ZA',
  'growth',
  ARRAY['run', 'grow']::text[],
  ARRAY['purchase order', 'purchase order funding', 'po funding', 'contract funding', 'big order', 'fund an order', 'invoice discounting', 'government invoice', 'government pays late', 'factoring', 'oricred']::text[],
  'Oricred',
  'you''ve won a purchase order or contract and need money to fulfil it, or you''ve invoiced a government department or a listed big company and can''t wait for them to pay',
  'you want an advance on an invoice to a private person or a small business (Oricred''s invoice advance is for invoices to government or listed blue-chip clients); there''s no order, contract or invoice yet',
  'pays for what you need to deliver a big order, or turns a slow government invoice into cash now',
  'fee not published — get the total rand cost in writing before you accept. Oricred says it funds up to 100% of what''s needed to fulfil a purchase order or contract (for orders worth up to R80 million), and advances up to 75% of an invoice''s value upfront when the invoice is to government or a listed blue-chip client',
  'https://oricred.co.za/apply/',
  'choose purchase order funding or invoice discounting → complete Oricred''s online application → submit the documents it asks for',
  ARRAY['Decide which you need: purchase order funding (money to deliver an order you''ve won) or invoice discounting (cash now against an invoice you''ve already sent to government or a listed company).', 'Have the purchase order, contract or invoice in hand. That''s what the funding is against.', 'Complete the matching online application on oricred.co.za and submit all the documents it asks for. You can also contact their team first to talk through your deal.', 'Before you sign, get the total fee in rand for this deal in writing, and check your profit on the order still covers it.']::text[],
  '2026-09-22'::date,
  NULL,
  'UNKNOWN',
  'Check who your customer is: Oricred''s invoice advance is only for invoices to government or a listed big company. If yours is, or you hold a signed purchase order, open oricred.co.za/apply and see which documents it asks for.'
WHERE NOT EXISTS (SELECT 1 FROM public.tools WHERE id = 'oricred' AND country = 'ZA');

-- umsebenzi_capital (ZA) — sources, all checked 2026-09-22: umsebenzicapital.co.za/purchase-order-funding/, /invoice-discounting/
UPDATE public.tools SET
  domain = 'growth',
  stages = ARRAY['run', 'grow']::text[],
  keywords = ARRAY['purchase order', 'purchase order funding', 'po funding', 'big order', 'fund an order', 'stock for the order', 'pay my supplier', 'supplier upfront', 'can''t afford to deliver', 'invoice discounting', 'tender', 'umsebenzi']::text[],
  name = 'Umsebenzi Capital',
  fits = 'you''ve won a purchase order and can''t pay your supplier upfront to deliver it',
  not_when = 'there''s no confirmed order yet; you can''t have your customer pay into an account Umsebenzi controls, because that is how its model works',
  why = 'it pays your supplier directly so you can deliver an order you couldn''t otherwise afford, and you keep the profit',
  cost = 'a fee per deal, taken out of your customer''s payment together with the money Umsebenzi put up; the rest (your profit) is paid to you within 24 hours. The fee and any minimum order size aren''t published — get the full cost in writing in their proposal before you accept',
  url = 'https://umsebenzicapital.co.za/purchase-order-funding/',
  setup = 'complete the online application and upload the documents → pre-approved applicants get a project finance proposal within 24 hours → Umsebenzi pays your supplier, you deliver and invoice',
  walkthrough = ARRAY['Have the confirmed purchase order from your customer and your supplier''s quote ready.', 'Complete Umsebenzi''s online application (there''s an eligibility form to check you qualify) and upload the documents it asks for.', 'If you''re pre-approved, they send you a project finance proposal within 24 hours. Read the fee in it and check your profit on the order still covers it.', 'If you go ahead: Umsebenzi pays your supplier, you deliver to your customer and invoice them, your customer pays into a regulated account, and Umsebenzi takes back its money and fee and pays you the rest within 24 hours.']::text[],
  verified_on = '2026-09-22'::date,
  informal_business_supported = NULL,
  free_type = 'PAY_PER_TRANSACTION',
  ten_minute_action = 'Write down the order''s value, your supplier''s price and your profit on it, then fill in Umsebenzi''s eligibility form on umsebenzicapital.co.za to see if the order qualifies.'
WHERE id = 'umsebenzi_capital' AND country = 'ZA';
INSERT INTO public.tools (id, country, domain, stages, keywords, name, fits, not_when, why, cost, url, setup, walkthrough, verified_on, informal_business_supported, free_type, ten_minute_action)
SELECT
  'umsebenzi_capital',
  'ZA',
  'growth',
  ARRAY['run', 'grow']::text[],
  ARRAY['purchase order', 'purchase order funding', 'po funding', 'big order', 'fund an order', 'stock for the order', 'pay my supplier', 'supplier upfront', 'can''t afford to deliver', 'invoice discounting', 'tender', 'umsebenzi']::text[],
  'Umsebenzi Capital',
  'you''ve won a purchase order and can''t pay your supplier upfront to deliver it',
  'there''s no confirmed order yet; you can''t have your customer pay into an account Umsebenzi controls, because that is how its model works',
  'it pays your supplier directly so you can deliver an order you couldn''t otherwise afford, and you keep the profit',
  'a fee per deal, taken out of your customer''s payment together with the money Umsebenzi put up; the rest (your profit) is paid to you within 24 hours. The fee and any minimum order size aren''t published — get the full cost in writing in their proposal before you accept',
  'https://umsebenzicapital.co.za/purchase-order-funding/',
  'complete the online application and upload the documents → pre-approved applicants get a project finance proposal within 24 hours → Umsebenzi pays your supplier, you deliver and invoice',
  ARRAY['Have the confirmed purchase order from your customer and your supplier''s quote ready.', 'Complete Umsebenzi''s online application (there''s an eligibility form to check you qualify) and upload the documents it asks for.', 'If you''re pre-approved, they send you a project finance proposal within 24 hours. Read the fee in it and check your profit on the order still covers it.', 'If you go ahead: Umsebenzi pays your supplier, you deliver to your customer and invoice them, your customer pays into a regulated account, and Umsebenzi takes back its money and fee and pays you the rest within 24 hours.']::text[],
  '2026-09-22'::date,
  NULL,
  'PAY_PER_TRANSACTION',
  'Write down the order''s value, your supplier''s price and your profit on it, then fill in Umsebenzi''s eligibility form on umsebenzicapital.co.za to see if the order qualifies.'
WHERE NOT EXISTS (SELECT 1 FROM public.tools WHERE id = 'umsebenzi_capital' AND country = 'ZA');

-- adifa (KE) — sources, all checked 2026-09-22: adifa.co.ke/
UPDATE public.tools SET
  domain = 'growth',
  stages = ARRAY['run', 'grow']::text[],
  keywords = ARRAY['lpo', 'lpo financing', 'invoice financing', 'invoice discounting', 'buyer pays late', 'waiting for payment', 'stock for the next order', 'big order', 'working capital', 'supply chain finance', 'adifa']::text[],
  name = 'Adifa (invoice financing)',
  fits = 'you''ve delivered goods to a reputable company buyer, you hold their valid LPO and your invoice, and waiting for them to pay is stopping you buying stock for the next order',
  not_when = 'your buyer isn''t an established company (Adifa judges the buyer''s ability to pay, not yours); there''s no LPO or invoice; you sell to walk-in customers for cash',
  why = 'turns an invoice a big buyer will pay later into cash within 24 hours, without putting up your own assets',
  cost = 'a single flat service fee, typically 3–5% of the invoice depending on how long until it''s due, with no application fee, no monthly subscription and no penalty interest. Adifa pays you 85% of the invoice within 24 hours and the remaining balance when your buyer pays Adifa on the due date',
  url = 'https://adifa.co.ke/',
  setup = 'deliver the goods → upload the LPO and invoice to Adifa → get 85% within 24 hours → your buyer pays Adifa in full on the due date and you get the balance',
  walkthrough = ARRAY['Deliver the goods to your buyer and make sure you have their valid LPO and your invoice. Those are your security, not your house or car.', 'Upload the invoice to Adifa on adifa.co.ke.', 'Adifa checks your buyer''s creditworthiness. If it approves, it pays you 85% of the invoice within 24 hours.', 'Your buyer pays Adifa the full invoice on the due date, and Adifa sends you the remaining balance.', 'Before you use it, work out the fee on this invoice (Adifa says typically 3–5%, depending on how long until it''s due) and check your margin covers it.']::text[],
  verified_on = '2026-09-22'::date,
  informal_business_supported = NULL,
  free_type = 'PAY_PER_TRANSACTION',
  ten_minute_action = 'Pick one unpaid invoice to a company buyer that has an LPO behind it and work out 85% of it: that''s what Adifa says it could pay you within 24 hours. Then check the buyer is one Adifa would accept on adifa.co.ke.'
WHERE id = 'adifa' AND country = 'KE';
INSERT INTO public.tools (id, country, domain, stages, keywords, name, fits, not_when, why, cost, url, setup, walkthrough, verified_on, informal_business_supported, free_type, ten_minute_action)
SELECT
  'adifa',
  'KE',
  'growth',
  ARRAY['run', 'grow']::text[],
  ARRAY['lpo', 'lpo financing', 'invoice financing', 'invoice discounting', 'buyer pays late', 'waiting for payment', 'stock for the next order', 'big order', 'working capital', 'supply chain finance', 'adifa']::text[],
  'Adifa (invoice financing)',
  'you''ve delivered goods to a reputable company buyer, you hold their valid LPO and your invoice, and waiting for them to pay is stopping you buying stock for the next order',
  'your buyer isn''t an established company (Adifa judges the buyer''s ability to pay, not yours); there''s no LPO or invoice; you sell to walk-in customers for cash',
  'turns an invoice a big buyer will pay later into cash within 24 hours, without putting up your own assets',
  'a single flat service fee, typically 3–5% of the invoice depending on how long until it''s due, with no application fee, no monthly subscription and no penalty interest. Adifa pays you 85% of the invoice within 24 hours and the remaining balance when your buyer pays Adifa on the due date',
  'https://adifa.co.ke/',
  'deliver the goods → upload the LPO and invoice to Adifa → get 85% within 24 hours → your buyer pays Adifa in full on the due date and you get the balance',
  ARRAY['Deliver the goods to your buyer and make sure you have their valid LPO and your invoice. Those are your security, not your house or car.', 'Upload the invoice to Adifa on adifa.co.ke.', 'Adifa checks your buyer''s creditworthiness. If it approves, it pays you 85% of the invoice within 24 hours.', 'Your buyer pays Adifa the full invoice on the due date, and Adifa sends you the remaining balance.', 'Before you use it, work out the fee on this invoice (Adifa says typically 3–5%, depending on how long until it''s due) and check your margin covers it.']::text[],
  '2026-09-22'::date,
  NULL,
  'PAY_PER_TRANSACTION',
  'Pick one unpaid invoice to a company buyer that has an LPO behind it and work out 85% of it: that''s what Adifa says it could pay you within 24 hours. Then check the buyer is one Adifa would accept on adifa.co.ke.'
WHERE NOT EXISTS (SELECT 1 FROM public.tools WHERE id = 'adifa' AND country = 'KE');

-- uwezo_fund (KE) — sources, all checked 2026-09-22: uwezo.go.ke/faqs, /loan-products, /uwezo-forms
UPDATE public.tools SET
  domain = 'growth',
  stages = ARRAY['start', 'run']::text[],
  keywords = ARRAY['uwezo', 'uwezo fund', 'group loan', 'chama loan', 'table banking', 'women group loan', 'youth group loan', 'disability group', 'constituency', 'government loan']::text[],
  name = 'Uwezo Fund (group loans)',
  fits = 'you''re in a registered youth, women''s or disability group in your constituency that already does table banking, and the group wants a loan to grow members'' businesses',
  not_when = 'you''re applying on your own (Uwezo lends to groups, not individuals); the group isn''t registered, has no bank account in its own name, or doesn''t make monthly table-banking contributions',
  why = 'government money for groups that already save together, applied for at your own constituency office',
  cost = 'the first-loan amount and repayment terms aren''t on Uwezo''s site — ask at your constituency office and get them in writing. Repeat loans can grow to 150–200% of the group''s previous loan, capped at KSh 500,000',
  url = 'https://www.uwezo.go.ke/',
  setup = 'check the group meets the rules → get the Uwezo application form online, from the NGCDF constituency office or the Sub-County Youth Development Officer → hand it in at the constituency office with the attachments it lists',
  walkthrough = ARRAY['Check your group qualifies: registered, based and operating in the constituency where you apply, doing table banking with monthly contributions, with a bank account in the group''s name.', 'Check who''s in it: youth groups are aged 18–35, women''s and disability groups 18 and over. A group can include up to 30% others, as long as all its leaders are youth, women or people with disability.', 'Get the Uwezo Fund loan application form from uwezo.go.ke, the NGCDF constituency office, or the Sub-County Youth Development Officer.', 'Fill it in, attach everything the form asks for, and hand it in at the constituency office.', 'Ask for the loan amount and repayment terms in writing before the group signs.']::text[],
  verified_on = '2026-09-22'::date,
  informal_business_supported = NULL,
  free_type = 'UNKNOWN',
  ten_minute_action = 'Ask your group''s chair three things: is the group registered, does it have a bank account in its own name, and do members make monthly table-banking contributions? If all three are yes, download the Uwezo application form from uwezo.go.ke.'
WHERE id = 'uwezo_fund' AND country = 'KE';
INSERT INTO public.tools (id, country, domain, stages, keywords, name, fits, not_when, why, cost, url, setup, walkthrough, verified_on, informal_business_supported, free_type, ten_minute_action)
SELECT
  'uwezo_fund',
  'KE',
  'growth',
  ARRAY['start', 'run']::text[],
  ARRAY['uwezo', 'uwezo fund', 'group loan', 'chama loan', 'table banking', 'women group loan', 'youth group loan', 'disability group', 'constituency', 'government loan']::text[],
  'Uwezo Fund (group loans)',
  'you''re in a registered youth, women''s or disability group in your constituency that already does table banking, and the group wants a loan to grow members'' businesses',
  'you''re applying on your own (Uwezo lends to groups, not individuals); the group isn''t registered, has no bank account in its own name, or doesn''t make monthly table-banking contributions',
  'government money for groups that already save together, applied for at your own constituency office',
  'the first-loan amount and repayment terms aren''t on Uwezo''s site — ask at your constituency office and get them in writing. Repeat loans can grow to 150–200% of the group''s previous loan, capped at KSh 500,000',
  'https://www.uwezo.go.ke/',
  'check the group meets the rules → get the Uwezo application form online, from the NGCDF constituency office or the Sub-County Youth Development Officer → hand it in at the constituency office with the attachments it lists',
  ARRAY['Check your group qualifies: registered, based and operating in the constituency where you apply, doing table banking with monthly contributions, with a bank account in the group''s name.', 'Check who''s in it: youth groups are aged 18–35, women''s and disability groups 18 and over. A group can include up to 30% others, as long as all its leaders are youth, women or people with disability.', 'Get the Uwezo Fund loan application form from uwezo.go.ke, the NGCDF constituency office, or the Sub-County Youth Development Officer.', 'Fill it in, attach everything the form asks for, and hand it in at the constituency office.', 'Ask for the loan amount and repayment terms in writing before the group signs.']::text[],
  '2026-09-22'::date,
  NULL,
  'UNKNOWN',
  'Ask your group''s chair three things: is the group registered, does it have a bank account in its own name, and do members make monthly table-banking contributions? If all three are yes, download the Uwezo application form from uwezo.go.ke.'
WHERE NOT EXISTS (SELECT 1 FROM public.tools WHERE id = 'uwezo_fund' AND country = 'KE');

-- yedf (KE) — sources, all checked 2026-09-22: youthfund.go.ke/our-products/, /constituency-based-loan/, /loan-application-forms/
UPDATE public.tools SET
  domain = 'growth',
  stages = ARRAY['start', 'run', 'grow']::text[],
  keywords = ARRAY['youth fund', 'yedf', 'youth enterprise', 'youth loan', 'vuka', 'stawi', 'money to buy stock', 'buy stock', 'start-up loan', 'startup loan', 'government loan', 'loan']::text[],
  name = 'Youth Enterprise Development Fund (YEDF)',
  fits = 'you''re a young owner (group members must be 18–34) who needs a loan to start or grow the business, on your own or through a registered youth group',
  not_when = 'you''re 35 or older; the business is losing money every month (a loan makes that bigger, so fix that first)',
  why = 'government loans sized from a first stock order up to expanding: KSh 100,000–500,000 to start, up to KSh 5 million to expand',
  cost = 'group loans: YEDF says no interest, but a one-off 5% management fee is taken off the loan when it''s paid out. Individual loans (Vuka: start-up KSh 100,000–500,000; expansion or asset financing KSh 100,000–5 million): repayment terms aren''t on the pages checked — get them in writing before you sign',
  url = 'https://www.youthfund.go.ke/our-products/',
  setup = 'choose group or individual → download that product''s application form from youthfund.go.ke → fill it in and submit it with the documents it lists',
  walkthrough = ARRAY['Decide group or individual. Group loans (Smart, KSh 25,000–200,000; Stawi, KSh 100,000–1 million) need a registered youth group at least 3 months old with its own bank account, members aged 18–34.', 'On your own, the Vuka loans are for businesses owned and run by young people: start-up KSh 100,000–500,000, expansion KSh 100,000–5 million.', 'Download the right form from the Loan Application Forms page on youthfund.go.ke.', 'Fill it in and submit it with the documents it lists.', 'Before you sign, ask for the interest, fees and repayment schedule in writing and check your monthly profit covers the repayment.']::text[],
  verified_on = '2026-09-22'::date,
  informal_business_supported = NULL,
  free_type = 'UNKNOWN',
  ten_minute_action = 'If you''re 18–34, open youthfund.go.ke, pick Smart or Stawi (with a group) or Vuka start-up or expansion (on your own), and download that form.'
WHERE id = 'yedf' AND country = 'KE';
INSERT INTO public.tools (id, country, domain, stages, keywords, name, fits, not_when, why, cost, url, setup, walkthrough, verified_on, informal_business_supported, free_type, ten_minute_action)
SELECT
  'yedf',
  'KE',
  'growth',
  ARRAY['start', 'run', 'grow']::text[],
  ARRAY['youth fund', 'yedf', 'youth enterprise', 'youth loan', 'vuka', 'stawi', 'money to buy stock', 'buy stock', 'start-up loan', 'startup loan', 'government loan', 'loan']::text[],
  'Youth Enterprise Development Fund (YEDF)',
  'you''re a young owner (group members must be 18–34) who needs a loan to start or grow the business, on your own or through a registered youth group',
  'you''re 35 or older; the business is losing money every month (a loan makes that bigger, so fix that first)',
  'government loans sized from a first stock order up to expanding: KSh 100,000–500,000 to start, up to KSh 5 million to expand',
  'group loans: YEDF says no interest, but a one-off 5% management fee is taken off the loan when it''s paid out. Individual loans (Vuka: start-up KSh 100,000–500,000; expansion or asset financing KSh 100,000–5 million): repayment terms aren''t on the pages checked — get them in writing before you sign',
  'https://www.youthfund.go.ke/our-products/',
  'choose group or individual → download that product''s application form from youthfund.go.ke → fill it in and submit it with the documents it lists',
  ARRAY['Decide group or individual. Group loans (Smart, KSh 25,000–200,000; Stawi, KSh 100,000–1 million) need a registered youth group at least 3 months old with its own bank account, members aged 18–34.', 'On your own, the Vuka loans are for businesses owned and run by young people: start-up KSh 100,000–500,000, expansion KSh 100,000–5 million.', 'Download the right form from the Loan Application Forms page on youthfund.go.ke.', 'Fill it in and submit it with the documents it lists.', 'Before you sign, ask for the interest, fees and repayment schedule in writing and check your monthly profit covers the repayment.']::text[],
  '2026-09-22'::date,
  NULL,
  'UNKNOWN',
  'If you''re 18–34, open youthfund.go.ke, pick Smart or Stawi (with a group) or Vuka start-up or expansion (on your own), and download that form.'
WHERE NOT EXISTS (SELECT 1 FROM public.tools WHERE id = 'yedf' AND country = 'KE');

-- kie_micro_loan (KE) — sources, all checked 2026-09-22: kie.co.ke/get-loan/, kie.co.ke/faq/
UPDATE public.tools SET
  domain = 'growth',
  stages = ARRAY['start', 'run']::text[],
  keywords = ARRAY['kie', 'kenya industrial estates', 'jua kali', 'micro loan', 'small loan', 'money to buy stock', 'buy stock', 'loan for tools', 'buy a machine', 'equipment loan', 'women group loan', 'youth loan', 'government loan', 'loan']::text[],
  name = 'KIE micro loan (Kenya Industrial Estates)',
  fits = 'you''re a jua kali operator, a young entrepreneur or in a women''s group and need KSh 10,000–500,000 for stock, tools or a machine',
  not_when = 'you need more than KSh 500,000 (that''s KIE''s SME loan); the business is losing money every month (a loan makes that bigger, so fix that first)',
  why = 'a government lender whose micro loans were set up for small informal businesses, with up to 4 years to repay',
  cost = 'interest and fees aren''t on the pages checked — ask KIE and get them in writing. Loans of KSh 10,000–500,000, repaid over up to 4 years; registered women''s groups, youth and people with disability can borrow without collateral because members guarantee each other',
  url = 'https://kie.co.ke/get-loan/',
  setup = 'download KIE''s application form for loans up to KSh 500,000 and its loan checklist from kie.co.ke → fill it in → submit it with the checklist documents',
  walkthrough = ARRAY['Work out exactly what the money is for (stock, a tool, a machine) and how much, between KSh 10,000 and 500,000.', 'On kie.co.ke, open Get Loan and download the application form for loans of up to KSh 500,000, and KIE''s loan checklist.', 'Fill in the form and gather what the checklist asks for.', 'If you''re in a registered women''s or youth group, ask about borrowing as a group: members guarantee each other instead of putting up collateral.', 'Submit it to KIE as the form directs, and ask for the interest and repayment schedule in writing before you sign.']::text[],
  verified_on = '2026-09-22'::date,
  informal_business_supported = true,
  free_type = 'UNKNOWN',
  ten_minute_action = 'Write down what the money is for and the exact amount (KSh 10,000–500,000), then download KIE''s application form for loans up to KSh 500,000 from kie.co.ke/get-loan.'
WHERE id = 'kie_micro_loan' AND country = 'KE';
INSERT INTO public.tools (id, country, domain, stages, keywords, name, fits, not_when, why, cost, url, setup, walkthrough, verified_on, informal_business_supported, free_type, ten_minute_action)
SELECT
  'kie_micro_loan',
  'KE',
  'growth',
  ARRAY['start', 'run']::text[],
  ARRAY['kie', 'kenya industrial estates', 'jua kali', 'micro loan', 'small loan', 'money to buy stock', 'buy stock', 'loan for tools', 'buy a machine', 'equipment loan', 'women group loan', 'youth loan', 'government loan', 'loan']::text[],
  'KIE micro loan (Kenya Industrial Estates)',
  'you''re a jua kali operator, a young entrepreneur or in a women''s group and need KSh 10,000–500,000 for stock, tools or a machine',
  'you need more than KSh 500,000 (that''s KIE''s SME loan); the business is losing money every month (a loan makes that bigger, so fix that first)',
  'a government lender whose micro loans were set up for small informal businesses, with up to 4 years to repay',
  'interest and fees aren''t on the pages checked — ask KIE and get them in writing. Loans of KSh 10,000–500,000, repaid over up to 4 years; registered women''s groups, youth and people with disability can borrow without collateral because members guarantee each other',
  'https://kie.co.ke/get-loan/',
  'download KIE''s application form for loans up to KSh 500,000 and its loan checklist from kie.co.ke → fill it in → submit it with the checklist documents',
  ARRAY['Work out exactly what the money is for (stock, a tool, a machine) and how much, between KSh 10,000 and 500,000.', 'On kie.co.ke, open Get Loan and download the application form for loans of up to KSh 500,000, and KIE''s loan checklist.', 'Fill in the form and gather what the checklist asks for.', 'If you''re in a registered women''s or youth group, ask about borrowing as a group: members guarantee each other instead of putting up collateral.', 'Submit it to KIE as the form directs, and ask for the interest and repayment schedule in writing before you sign.']::text[],
  '2026-09-22'::date,
  true,
  'UNKNOWN',
  'Write down what the money is for and the exact amount (KSh 10,000–500,000), then download KIE''s application form for loans up to KSh 500,000 from kie.co.ke/get-loan.'
WHERE NOT EXISTS (SELECT 1 FROM public.tools WHERE id = 'kie_micro_loan' AND country = 'KE');

-- kie_sme_loan (KE) — sources, all checked 2026-09-22: kie.co.ke/get-loan/, kie.co.ke/faq/
UPDATE public.tools SET
  domain = 'growth',
  stages = ARRAY['run', 'grow']::text[],
  keywords = ARRAY['kie', 'kenya industrial estates', 'sme loan', 'business loan', 'expansion loan', 'working capital', 'equipment loan', 'buy a machine', 'grow the business', 'government loan', 'capital']::text[],
  name = 'KIE SME loan (Kenya Industrial Estates)',
  fits = 'your business has traded for at least 2 years and needs KSh 100,000 to 20 million to expand, for equipment or working capital',
  not_when = 'you''ve traded less than 2 years (KIE requires that for a working-capital loan) or need under KSh 100,000 (look at KIE''s micro loan); the business is losing money every month',
  why = 'a government lender for bigger loans, with up to 84 months (7 years) to repay',
  cost = 'interest, fees and collateral rules aren''t on the pages checked — ask KIE and get them in writing. Loans of KSh 100,000–20 million, repaid over up to 84 months; at least 2 years of trading for a working-capital loan',
  url = 'https://kie.co.ke/get-loan/',
  setup = 'download KIE''s loan application form and checklist from kie.co.ke → fill it in → submit it with the documents',
  walkthrough = ARRAY['Check you qualify: at least 2 years of trading for a working-capital loan, and a need between KSh 100,000 and 20 million.', 'Write down what the loan will buy and how the extra sales repay it each month.', 'On kie.co.ke, open Get Loan and download the loan application form and KIE''s loan checklist.', 'Fill it in, gather the checklist documents, and submit it to KIE as the form directs.', 'Ask for the interest rate, fees, collateral and repayment schedule in writing before you sign.']::text[],
  verified_on = '2026-09-22'::date,
  informal_business_supported = NULL,
  free_type = 'UNKNOWN',
  ten_minute_action = 'Check two things: has the business traded for 2 years or more, and can you name what the loan buys? If yes, download KIE''s application form and checklist from kie.co.ke/get-loan.'
WHERE id = 'kie_sme_loan' AND country = 'KE';
INSERT INTO public.tools (id, country, domain, stages, keywords, name, fits, not_when, why, cost, url, setup, walkthrough, verified_on, informal_business_supported, free_type, ten_minute_action)
SELECT
  'kie_sme_loan',
  'KE',
  'growth',
  ARRAY['run', 'grow']::text[],
  ARRAY['kie', 'kenya industrial estates', 'sme loan', 'business loan', 'expansion loan', 'working capital', 'equipment loan', 'buy a machine', 'grow the business', 'government loan', 'capital']::text[],
  'KIE SME loan (Kenya Industrial Estates)',
  'your business has traded for at least 2 years and needs KSh 100,000 to 20 million to expand, for equipment or working capital',
  'you''ve traded less than 2 years (KIE requires that for a working-capital loan) or need under KSh 100,000 (look at KIE''s micro loan); the business is losing money every month',
  'a government lender for bigger loans, with up to 84 months (7 years) to repay',
  'interest, fees and collateral rules aren''t on the pages checked — ask KIE and get them in writing. Loans of KSh 100,000–20 million, repaid over up to 84 months; at least 2 years of trading for a working-capital loan',
  'https://kie.co.ke/get-loan/',
  'download KIE''s loan application form and checklist from kie.co.ke → fill it in → submit it with the documents',
  ARRAY['Check you qualify: at least 2 years of trading for a working-capital loan, and a need between KSh 100,000 and 20 million.', 'Write down what the loan will buy and how the extra sales repay it each month.', 'On kie.co.ke, open Get Loan and download the loan application form and KIE''s loan checklist.', 'Fill it in, gather the checklist documents, and submit it to KIE as the form directs.', 'Ask for the interest rate, fees, collateral and repayment schedule in writing before you sign.']::text[],
  '2026-09-22'::date,
  NULL,
  'UNKNOWN',
  'Check two things: has the business traded for 2 years or more, and can you name what the loan buys? If yes, download KIE''s application form and checklist from kie.co.ke/get-loan.'
WHERE NOT EXISTS (SELECT 1 FROM public.tools WHERE id = 'kie_sme_loan' AND country = 'KE');
