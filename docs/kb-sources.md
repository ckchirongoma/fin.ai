# Knowledge-base sources: the Charles South African library (db/0034)

Every knowledge entry and tool in `seed/knowledge.json` and `seed/tools.json` (all country `ZA`, all `verified_on` 2026-10-30, loaded by `db/0034_charles_za_library.sql`) is listed here with the URLs its facts came from, what those sources support, and the verdict of the check. The seed carries no source column, so this file is how a figure in a row is traced back. Keep it in step: when a row is re-verified, update its entry here as well as its `verified_on`.

## How these rows were verified (read first)

- **No official site could be opened from the build environment.** Every WebFetch to nfosa.co.za, sassa.gov.za, sars.gov.za, transunion.co.za, safps.org.za and fsca.co.za failed to resolve (the session's network allow-list), and the lead had already found gotyme.co.za, tymebank.co.za and moneyza.co.za blocked. **Every figure in every row was therefore read from web-search result text** (standard and extended search modes) of the pages listed below, including snippets of the official pages themselves. A URL below is the page whose snippet was read, not a page that was opened. Rows marked "snippet of the official page" are the strongest; rows marked "third-party only" are the ones to re-check first.
- Where published figures conflict, the row says "published figures differ" and names the place to confirm (CLAUDE.md rule 10). Where nothing could be confirmed, the figure was left out rather than guessed. The lead's pre-gathered facts were re-checked against the same search results; where a search contradicted the lead's figure, the row follows the search and the difference is listed under "Facts that differ from the lead's brief".
- `verified_on` is 2026-10-30 on every row: the date the figures were checked, by that method. The freshness job flags them again after 90 days.
- **No row recommends credit.** Loans, cards, overdrafts, buy-now-pay-later and consolidation loans appear only as things to refuse (`k.no_new_credit`) or as rules that protect a borrower (`k.nca_caps_reckless`).
- **No row asks for or stores an ID number, account number, card number, PIN, OTP or password.** Walkthroughs say "you will be asked for your ID number on their site" where that is true, and several steps say never to send those to anyone, including Charles.
- `tools.informal_business_supported` keeps Charlie's column name but now means **"works without a payslip"**: `true` when a person with no formal job can use the tool (most rows), `false` when it needs an employer, a fund membership or a home loan (`ufiling_uif`, `ccma_referral`, `fund_two_pot_portal`, `nhfc_first_home_finance`).
- The only phone numbers in the rows are institutional lines (regulators, ombuds, banks' published fraud lines, SASSA, SARS, Legal Aid). No example personal numbers were needed.
- Measured by `scripts/kb-depth.ts` (knowledge avg 9.6/10, min 8; tools avg 9.9/10, min 9; no shallow rows) and `scripts/kb-coverage.ts` (29/29 plan steps that name a tool have one; the benchmark fixtures are still Charlie's business questions and score 0 until the lead replaces them). A scratch probe of 37 natural money questions through the real `shortlist()` reached a row of the right area in the top 3 for all 37.

### Re-check first, once a live fetch is possible

1. **Debt review fees** (`k.debt_review_what_it_is`, `ncr_debt_counsellor`): the NCR fee guideline PDF snippet was garbled; third-party sources give R50 application, a restructuring cap of R8,000 (R9,000 in community of property), aftercare 5% capped at R400 or R450, and some add a R300 admin fee. The rows state R50 and "published figures differ" for the rest.
2. **SASSA grant amounts** (`k.sassa_grants_overview`, `sassa_office`): R2,400 / R2,420 / R580 are from news reports of the 2026 Budget, not sassa.gov.za. Foster care conflicts (R1,290 vs R1,180) and is not stated.
3. **SASSA WhatsApp number** (`sassa_whatsapp`, `sassa_srd_online`): 082 046 8553 appears on many third-party sites citing a SASSA newsroom article; a few sites give 082 054 0016 or 0600 123 456. The rows say "widely published as … confirm on sassa.gov.za".
4. **SRD income threshold R624** (`k.srd_grant`, `sassa_srd_online`): third-party only, and a 2025 High Court ruling on the SRD regulations is reported as contested.
5. **GoTyme figures** (`k.goalsave_rules`, `gotyme_goalsave`, `gotyme_everyday`, `k.bank_fees_audit`): GoalSave 6% base / 10% with 10 days' notice / 20 GoalSaves / R250,000 cap are from the snippet of GoTyme's own GoalSave page; MoneyToday and Rateweb describe a 4%→6%→10% ladder instead. The fee page snippet lists a free current account, R7 for instant payments above R5,000, R10 for a SendMoney voucher to a non-GoTyme customer, R3 for a declined debit order and R7/month after six months' inactivity, while the current-account page snippet lists cash withdrawals as free. Till cash fees at Pick n Pay / Boxer were not found. The product is called "EveryDay" by the lead and "Current Account" on the fee page; every GoTyme figure in the rows is hedged "confirm in the GoTyme app".
6. **PayShap fees per bank** (`k.payshap_free_rule`, `payshap`): BusinessTech, Moneyweb, TechCentral, momocalc and Netcash disagree on Absa, Standard Bank and Capitec tiers and on the per-transaction limit (R3,000 vs R50,000). Rows give only "free or near-free under R100 at most banks, up to about R7.50 elsewhere, confirm in your bank's fee guide".
7. **UIF call centre** (`k.uif_claim`, `ufiling_uif`): 0800 030 007 is widely listed; GroundUp gives 0800 843 843 for the call centre and 0800 030 007 for escalations. Both are in `ufiling_uif`.
8. **FSCA toll-free number** (`fsca_check` and five knowledge rows): 0800 110 443 is the number in the most recent (2024) coverage; 0800 20 37 22 / 0800 203 722 appears in 2019 articles. Rows use 0800 110 443.
9. **Standard Bank fraud line** (`bank_fraud_report`, `k.sim_swap_signs`): Standard Bank's own security page lists 0800 222 050 (24/7) and 0800 020 600 as the lost-card line; an older SABRIC page lists 0800 020 600 as the fraud line. Rows use 0800 222 050.
10. **First Home Finance subsidy range** (`k.first_home_finance`, `nhfc_first_home_finance`): the top of R169,264 agrees across 2026 guides, the bottom does not (R27,960 vs R38,878); whether a loan approval in principle is still required also conflicts. Rows send the person to the NHFC calculator.
11. **NCA short-term credit caps** (`k.nca_caps_reckless`): the 2016 Pretoria High Court set-aside of the short-term regulations and the NCR's appeal: no result found on how it ended. The row states the published caps and says to confirm with the NCR.
12. **Policyholder Protection Rules, accidental death** (`k.funeral_cover_rules`): six-month natural-death waiting period and 31-day cooling-off are supported (1Life, FSCA MyMoney); "accidental death from day one" is supported only by product terms (Guardrisk, Old Mutual), not by the rule text. The row says "usually".
13. **Tax threshold 2026/27 R99,000** (`k.sars_refund_threshold`): third-party tax tables only; R95,750 for the year to 28 February 2026 is supported by the Government Notice 7422 filing-season coverage.
14. **Emolument attachment base** (`k.garnishee_order`): Acts Online's section 65J text says 25% of "basic salary"; one 2018 report says gross. Rows say basic salary.
15. **NASASA registration threshold** (`k.stokvel_safety`, `nasasa_stokvel`): R100,000 in contributions (SME South Africa, Standard Bank) vs "all stokvels must register" (one source); membership fee "none" is from a 2015 interview. Rows say "sources differ, ask NASASA".
16. **Credit life refund on settlement** (`k.settled_account`): section 106(7) refund of the unused annual premium is from the Act's text via Acts Online; whether a monthly-premium policy must be cancelled by the lender was not found, so the row says "cancel any … tied to that account" and gives the yearly-premium refund only.

### Facts that differ from the lead's brief

- **UIF replacement rate**: the brief said 38–58%; every source found says 38% to 60% (60% for the lowest earners). Rows say 38% to 60%.
- **Funeral cover cooling-off**: the brief said 30 days; the FSCA MyMoney page and product terms say 31 days after receiving the policy documents. Rows say 31 days.
- **FSCA toll-free**: the brief did not give one; the current number is 0800 110 443 (see item 8).
- **NCA short-term caps**: the brief stated 5%/3% and repo+21% as settled; the 2016 set-aside and appeal mean the row hedges.
- **Debt review aftercare cap**: the brief said "about 5% capped (conflicting)"; sources give R400 or R450. Row says so.
- **Debit order dispute window**: not in the brief; PASA moved it from 40 to 60 calendar days on 13 April 2026 (`k.debit_order_control`, `debicheck`).
- **SAFPS contact**: the brief had none; SAFPS's own application page snippet gives protection@safps.org.za, 011 867 2234 and a 48-hour reference.
- **NFO WhatsApp 076 574 8055**: confirmed from the snippet of nfosa.co.za ("Our New WhatsApp Number"); bank pages still show +27 66 473 0157, so the row notes older bank pages differ.

### Where the playbook's how_to lines sit against the sources

No `how_to` line in `api/_lib/playbooks.ts` contradicts a source. Two places where the library wording is narrower than the rows:

- `m_shark sh1` brief says "holding a card, ID or PIN is a crime": the NCR calls it "a criminal offence in terms of the National Credit Act" (via Soul City and lender blogs); no source gave the section number, so `k.mashonisa_law` attributes it to the NCR rather than citing a section.
- `m_credit cr2` brief says prescribed debt "comes off": the regulations remove *paid-up* adverse information and judgments; a prescribed (unpaid) debt comes off through a section 72 dispute, which is how `k.dispute_credit_listing` and `k.prescribed_debt` put it.

---

## Knowledge entries

Each entry: domain, sources (snippets read), what they support, verdict.

#### `k.sassa_grants_overview` — SASSA grants: which ones exist and who qualifies
Domain `income`. Sources: https://www.ourpower.co.za/sassa/grants/amounts-2026 · https://grantza.org.za/news/budget-2026-sassa-grant-increases · https://techcabal.com/2026/03/18/sassa-grants-to-increase-in-april-payment/ · https://www.rateweb.co.za/sassa-grants · https://ourpower.co.za/sassa/sassa/means-test · https://www.citizen.co.za/kempton-express/news-headlines/local-news/2026/05/22/means-test-explained-as-sassa-updates-social-grant-limits-for-2026/ · https://ourpower.co.za/sassa/contact. Support: R2,400 (60–74), R2,420 (75+), R580 child support from April 2026; documents (13-digit ID, birth certificate, proof of income, 3 months' bank statements); toll-free 0800 60 10 11; means-test figures conflict between sites (R5,400 / R5,000 / R5,600 a month for child support; R8,990 / R9,350 for older persons). Verdict: **hedged** — amounts stated as "reported … confirm on sassa.gov.za"; means-test figures left out; foster care amount left out (conflict).

#### `k.sassa_deductions_rule` — What may be taken off a SASSA grant
Domain `income`. Sources: https://www.sanews.gov.za/south-africa/sassa-concerned-over-unlawful-deductions-social-grants · https://www.timeslive.co.za/news/south-africa/2025-08-15-sassa-flags-unlawful-grant-deductions-by-insurance-companies/ · https://www.citizen.co.za/germiston-city-news/news-headlines/local-news/2026/04/28/sassa-gauteng-warns-of-unauthorised-deductions-from-social-grants/ · https://groundup.news/article/sassa-pensioners-refunded-after-groundups-queries-about-insurance-premium-deductions/. Support: one funeral deduction, max 10%, registered long-term insurer, consent required, not from child grants; SMS dispute to 34548 with ID number and provider name; refunds obtained. SASSA cites "Regulation 29", others "26A": the row cites neither number. Verdict: **kept**.

#### `k.uif_claim` — Claiming UIF after losing work
Domain `income`. Sources: https://www.recordinglaw.com/south-africa/labour-law/uif-claim-process/ · https://www.recordinglaw.com/south-africa/labour-law/uif-explained/ · https://uifcalculators.co.za/methodology/ · https://www.taxtim.com/za/calculators/uif · https://briefly.co.za/83037-uif-contact-details-contact-assistance.html · https://groundup.org.za/qanda/715 · https://uifcalculators.co.za/articles/uif-documents-needed/. Support: 12-month claim window; 1 credit day per 4 days worked up to 365; 38%–60% sliding scale; UI-19, work-seeker registration, uFiling; call centre 0800 030 007 (conflict with 0800 843 843). Verdict: **kept with the 38–60% correction**; the R17,712 ceiling and 238-day tier left out (third-party calculators only).

#### `k.indigent_register` — The indigent register: free basic electricity and water
Domain `income`. Sources: https://www.ekurhuleni.gov.za/press-releases/service-delivery/city-encourages-qualifying-residents-to-apply-for-indigent-support/ · https://www.citizen.co.za/germiston-city-news/news-headlines/local-municipal-news/2026/08/04/city-encourages-qualifying-residents-to-apply-for-indigent-support/ · https://overstrand.gov.za/?p=11708 · https://www.rustenburg.gov.za/Documents/MEDIA%20RELEASE%20INDIGENT%20REGISTRATION%20DRIVE_.pdf · https://www.eskom.co.za/distribution/free-basic-electricity/ · https://groundup.org.za/qanda/1025/. Support: Ekurhuleni limit R10,478.92 (2026); 50 kWh (some 60 kWh), 10 kl water; documents; *130*269# (Eskom also lists *130*869#); no carry-over; approval takes months. Verdict: **kept**; Eskom's 2021 R3,500 threshold left out as dated.

#### `k.srd_grant` — The R370 SRD grant
Domain `income`. Sources: https://ourpower.co.za/sassa/news/srd-r370-extended-march-2027 · https://nuusflits.com/sassa-srd-grant-2027/ · https://www.bizcommunity.com/article/finance-minister-extends-sassas-r370-covid-19-srd-grant-285887a · https://grantza.org.za/sassa/srd · https://www.ourpower.co.za/sassa/srd/application. Support: R370 to 31 March 2027 (R36.4bn, Budget 2026); online-only at srd.sassa.gov.za; monthly status checks and income re-checks; R624 threshold (third-party); 2025 High Court challenge noted. Verdict: **hedged** on the threshold; the appeal window (30 vs 90 days conflicts) left as "within the time it shows".

#### `k.severance_pay` — Severance pay when you are retrenched
Domain `income`. Sources: https://businesstech.co.za/news/business-opinion/638681/what-the-law-says-about-severance-pay-in-south-africa/ · https://serr.co.za/how-to-calculate-severance-pay-due-to-employees-during-retrenchments · https://www.polity.org.za/article/enforcing-the-payment-of-severance-pay-2019-04-01 · https://ourpower.co.za/tools/ccma-referral · https://www.gov.za/services/services-residents/world-work/employee-rights/refer-dispute-ccma. Support: BCEA s41 one week per completed year; operational-requirements dismissals only; CCMA 0861 16 16 16, free, form LRA 7.11. Verdict: **kept**.

#### `k.sars_refund_threshold` — Do you need to file with SARS
Domain `income`. Sources: https://www.accountingweekly.com/sars-updates/filing-season-2026-sars-has-set-the-dates-are-you-ready · https://www.xero.com/za/guides/sars-tax-tables-2026/ · https://sarstax.co.za/income-tax/brackets/ · https://businesstech.co.za/news/finance/863009/sars-announces-dates-for-tax-season-2026-when-to-expect-auto-assessments/ · https://www.ewn.co.za/2026/06/19/dont-miss-it-sars-confirms-tax-filing-deadlines-for-2026 · https://www.citizen.co.za/southern-courier/news-headlines/2022/06/20/yourtaxmatters-auto-assessment-sars-has-made-it-easier-for-you-to-file/ · https://www.sars.gov.za/filing-season-2025-everything-you-need-to-know. Support: R95,750 under-65 threshold for the year to 28 Feb 2026 (Government Notice 7422); R99,000 for 2026/27 (third-party); auto-assessments 1–12 July 2026, individual filing 13 July–23 October 2026; auto-assessment needs no action if correct; SARS contact centre 0800 00 7277. Verdict: **hedged** on R99,000; the brief's "20 October" and "7 July" replaced by 23 October and 1–12 July.

#### `k.income_calendar` — Know what comes in and on which day
Domain `income`. Rule of thumb; the only fact is that SASSA publishes monthly payment dates (older persons, then disability, then children), supported by https://www.ecr.co.za/shows/stacey-jsbu/sassa-confirms-payment-dates-for-june-2026/ and https://techcabal.com/2026/02/16/everything-you-need-to-know-about-sassa-grant-payments-for-march-2026/. Verdict: **kept**, no figures.

#### `k.week_spend_log`, `k.three_pots_budget`, `k.twenty_four_hour_rule` — the budgeting rules of thumb
Domain `spending`. No figures beyond illustrative lines the person writes themselves. The design basis (one rule at a time, physical separation) is Drexler, Fischer and Schoar, AEJ Applied 2014, as cited in `docs/superpowers/specs/2026-10-30-charles-design.md`. Verdict: **kept**.

#### `k.bank_fees_audit` — Find every fee on last month's statement
Domain `spending`. Sources: https://gotyme.co.za/personal/bank-account/current-account/fees-and-charges · https://gotyme.co.za/personal/bank-account/current-account. Support: free current account, R3 declined debit order (fee page snippet). Verdict: **hedged** — GoTyme figures "confirm in the app"; other banks' fees not stated.

#### `k.payshap_free_rule` — PayShap
Domain `spending`. Sources: https://businesstech.co.za/news/banking/775230/payshap-fees-in-south-africa-absa-vs-nedbank-vs-standard-bank-vs-fnb-vs-tymebank-and-more/ · https://www.moneyweb.co.za/news/south-africa/beware-banks-steep-instant-payment-charges/ · https://momocalc.com/south-africa/payshap-fees · https://techcentral.co.za/high-fees-keep-payshap-stuck-in-first-gear/275073/ · https://netcash.co.za/blog/how-businesses-can-use-payshap-for-payroll-creditor-payments/. Support: TymeBank free at all amounts; Nedbank and Capitec free/near-free under R100; Absa R7.50 to account; limits R3,000 at some banks, R50,000 at others. Verdict: **hedged** per bank; no per-bank table in the row.

#### `k.layby_rights` — Lay-by
Domain `spending`. Sources: https://www.acts.co.za/consumer-protection/62_lay_bys · https://www.acts.co.za/consumer-protection-act-/r293_34__maximum_amount_of_cancellation_penalty_for_lay_by_s.php · https://www.citizen.co.za/business/personal-finance/your-consumer-rights-in-a-lay-by-transaction · https://www.legalwise.co.za/help-yourself/legal-articles/understanding-your-right-lay-goods. Support: CPA s62, regulation 34 1% cap, no penalty on death or hospitalisation. Verdict: **kept**.

#### `k.debit_order_control` — Debit orders
Domain `spending`. Sources: https://pasa.org.za/wp-content/uploads/2026/04/PASA_DODE_FAQ_v3.pdf · https://iol.co.za/personal-finance/financial-planning/2026-02-27-south-africas-new-60-day-dispute-rule-a-shift-in-south-africas-debit-order-rules/ · https://businesstech.co.za/news/banking/853776/big-changes-for-debit-orders-in-south-africa-next-month/ · https://www.standardbank.co.za/southafrica/personal/products-and-services/security-centre/bank-safely/debicheck · https://www.acpas.co.za/MandatesBlog.html. Support: DebiCheck approval in app/USSD/phone; 60-calendar-day dispute window from 13 April 2026; a DebiCheck matching the mandate is declined on dispute. Verdict: **kept**.

#### `k.debt_list` — Write down everyone you owe
Domain `debt`. Sources: mashonisa rates 30–50% a month from https://allafrica.com/stories/202609210585.html and the Wonga survey as cited in the design spec; statement-free-of-charge from the NCA (s108/s109 via https://www.credizen.net/en-ZA/blog/ncr-consumer-rights/rights-national-credit-act). Verdict: **kept**; the section number is not stated in the row.

#### `k.debt_snowball` — Kill the smallest debt first
Domain `debt`. Sources: https://www.kellogg.northwestern.edu/news/blog/2012/08/07/the-snowball-approach-to-debt/ · https://insight.kellogg.northwestern.edu/article/to_beat_debt_consider_starting_small · https://www.cbsnews.com/amp/news/study-to-get-out-of-debt-start-small. Support: Gal and McShane, JMR 2012, closing accounts predicts payoff; sample "about 6,000" (sources say 4,000–6,000). Verdict: **kept** with "about 6,000".

#### `k.settled_account` — When a debt is paid
Domain `debt`. Sources: https://www.gov.za/sites/default/files/gcis_document/201409/37386rg10136gon144.pdf · https://api.acts.co.za/national-credit-act-2005/r144_3__submission_and_utilisa.php · https://www.acts.co.za/national-credit-act-2005/106__credit_insurance · https://www.ncr.org.za/documents/GUIDELINE%20ON%20THE%20APPLICATION%20OF%20THE%20CREDIT%20LIFE%20INSURANCE%20REGULATIONS.pdf. Support: paid-up judgments removed within 7 days of proof; s106(7) refund of unused annual premium; s72 20 business days. Verdict: **kept**; see re-check item 16.

#### `k.mashonisa_law` — What a mashonisa can and cannot do
Domain `debt`. Sources: https://lawlibrary.org.za/akn/za/act/gn/2016/513/eng@2016-05-11 · https://fairbridges.co.za/?p=1736 · https://serr.co.za/the-national-credit-act-and-zero-registration-threshold · https://mjkinc.co.za/finance-credit-law/unlawful-and-unregistered-credit-agreements · https://www.soulcity.org.za/news-events/201cmashonisas201d · https://randcash.co.za/learn/mashonisa-loans-south-africa-your-rights · https://ncr.org.za/index.php/departments/complaints. Support: GN 513 nil threshold from 11 Nov 2016; unregistered agreement unlawful/void; NCR calls holding cards/IDs a criminal offence; NCR 0860 627 627. Verdict: **kept**; section numbers for the offence not cited (lender blogs only).

#### `k.debt_review_what_it_is` — Debt review
Domain `debt`. Sources: https://www.ncr.org.za/documents/pages/registration&compliance/debt_counsellors/Updated%20Fee%20Guidelines%20for%20Debt%20Counsellors.pdf (garbled snippet) · https://smartaboutmoney.co.za/debt/managing-debt/what-does-debt-review-cost/ · https://www.dcasa.co.za/what-fees-can-a-debt-counsellor-ask-during-the-debt-review-process/ · https://www.citizenhelp.co.za/consumer/debt-counselling-south-africa · https://www.ourpower.co.za/tools/debt-review/debt-review-process-explained · https://www.dcasa.co.za/when-can-you-be-legally-cleared-from-debt-review/. Support: s86; R50 application; restructuring cap R8,000/R9,000; aftercare 5% capped R400/R450; Form 16, 17.1 within 5 business days, 30-business-day determination; s71 certificate within 7 days; no new credit under review. Verdict: **hedged** on every fee except R50; the brief's "60 business days" not found and not used.

#### `k.debt_counselling_vs_removal_scams`
Domain `debt`. Sources: https://www.ncr.org.za/documents/Circulars/Circular%201%20of%202024-%20UNAUTHORISED%20USE%20OF%20DEBT%20COUNSELLORS%20REGISTRATION%20CREDENTIALS%20BY%20UNREGISTERED%20PERSONS%20(1).pdf · https://www.dcasa.co.za/how-to-check-if-a-debt-counsellor-is-registered/ · https://www.ourpower.co.za/tools/debt-review/verify-ncr-registered-debt-counsellor · https://www.dailymaverick.co.za/article/2024-04-16-beware-dodgy-debt-counsellors/ · https://www.moneyshop.co.za/?p=6754 (charging to "fix" a report is illegal). Verdict: **kept**.

#### `k.debt_collectors_rights`
Domain `debt`. Sources: https://www.cfdc.org.za/faqs/ · https://legalrights.co.za/how-to-file-a-complaint-with-the-debt-collectors-council/ · https://www.gov.za/sites/default/files/gcis_document/202006/43447bn67.pdf · https://www.recordinglaw.com/south-africa/debt-and-consumer/debt-collection-rights/. Support: registration mandatory, unregistered collection a criminal offence; 012 804 9808, info@cfdc.org.za; sworn written complaint; register at cfdc.org.za (one 2020 notice shows cfdc.org.za for electronic access). Fee tariff amounts not found: row says "regulated tariff, ask for the breakdown". Verdict: **kept, fees left out**.

#### `k.nca_caps_reckless`
Domain `debt`. Sources: https://www.acts.co.za/national-credit-act-2005/r489_42__maximum_prescribed_interest_and_initiation_fees.php · https://www.justmoney.co.za/articles/guide-to-maximum-prescribed-interest-rate · https://www.businessday.co.za/bd/national/2016-11-23-court-sets-aside-caps-on-interest-rates-and-fees-for-short-term-credit/ · https://www.businesslive.co.za/bd/companies/financial-services/2016-11-24-watchdog-to-fight-court-on-loan-rules/ · https://www.golegal.co.za/?p=41497 · https://www.dcasa.co.za/what-you-should-know-before-taking-out-credit-understanding-reckless-credit-and-your-rights-under-the-national-credit-act · https://ncr.org.za/index.php/departments/complaints. Support: regulation 42 table (RR+21% unsecured; 5%/3% short-term up to R8,000, 6 months); 2016 set-aside and appeal; s80–83 reckless credit, court may set aside/suspend; NCR form 29. Verdict: **hedged** (see re-check item 11); initiation and service fee amounts left out.

#### `k.garnishee_order`
Domain `debt`. Sources: https://www.acts.co.za/magistrates-courts-lower-courts-act-1944/65j_emoluments_attachment_orders · https://www.recordinglaw.com/south-africa/debt-and-consumer/garnishee-orders/ · https://www.legalwise.co.za/help-yourself/quicklaw-guides/emoluments-attachment-orders · https://www.timeslive.co.za/news/consumer-live/2019-12-17-a-christmas-present-for-those-with-garnishees-an-end-to-rampant-exploitation/ · https://legal-aid.co.za/how-it-works/ · https://thestar.co.za/saturday-star/news/2026-04-01-more-south-africans-can-now-qualify-for-legal-aid-after-means-test-increase. Support: 25% of basic salary cap; court must find it just and equitable; Courts of Law Amendment Act 7 of 2017; Legal Aid means test R9,400 (civil, individual) from 1 April 2026; Please Call Me 079 835 7179. Verdict: **kept**.

#### `k.prescribed_debt`
Domain `debt`. Sources: https://nfosa.co.za/prescribed-debt/ · https://www.moonstone.co.za/ombudsman-sets-out-what-consumers-should-know-about-prescription/ · https://www.debtbusters.co.za/articles/debt-old/ · https://debtrescue.co.za/blog/debt-management-21-12-2020-prescribed-debt-everything-you-need-to-know/ · https://www.pressreader.com/south-africa/business-day/20170103/281578060335054. Support: 3 years; s126B since March 2015; acknowledgment restarts; home loans 30 years; SARS 15 or 30 years (conflict, so the row says only "much later"). Verdict: **kept**.

#### `k.no_new_credit`
Domain `debt`. Sources: NCR June 2025 figure (10.5 million impaired consumers) as cited in the design spec; pre-agreement quote duty from the NCA (s92) via https://www.credizen.net/en-ZA/blog/ncr-consumer-rights/rights-national-credit-act. Verdict: **kept**; no product is named or recommended.

#### `k.cushion_target`, `k.payday_first`, `k.cushion_when_to_use` — cushion rules of thumb
Domain `cushion`. No external figures; "5% a month" in `k.cushion_when_to_use` is the short-term cap from `k.nca_caps_reckless`. Verdict: **kept**.

#### `k.separate_money`, `k.goalsave_rules`
Domain `cushion`. Sources: https://gotyme.co.za/personal/save-and-invest/goalsave · https://gotyme.co.za/personal/media/money-skills-landing/how-can-i-earn-10percent-interest-with-goalsave · https://moneytoday.co.za/compare/savings/tymebank-goalsave · https://www.rateweb.co.za/banking/tymebank-gotyme-fixed-deposit-goalsave-rates/ · https://en.wikipedia.org/wiki/GoTyme_Bank_(South_Africa). Support: 6% base / 10% with 10 days' notice / 20 GoalSaves / R250,000 (GoTyme page snippet); 4→6→10% ladder (MoneyToday, Rateweb); TymeBank became GoTyme in January 2026. Verdict: **hedged** "published figures differ, confirm in the app".

#### `k.free_credit_report`
Domain `credit_record`. Sources: https://www.moneyshop.co.za/?p=6754 · https://www.transunion.co.za/product/annual-free-credit-report · https://transunion.co.za/customer-support/contact-us · https://www.experian.co.za/consumer/my-free-credit-check-and-your-free-credit-report · https://www.xds.co.za/for-me/ · https://www.justmoney.co.za/articles/how-to-raise-a-dispute-with-a-credit-bureau/. Support: s72 one free report per bureau per year; TransUnion 0861 482 482; Experian Up; XDS Splendi. Verdict: **kept**.

#### `k.dispute_credit_listing`
Domain `credit_record`. Sources: https://www.ncr.org.za/phocadownload/GUIDELINES%20FOR%20THE%20SUBMISSION%20OF%20COMPLAINTS%20RELATING%20TO%20DISPUTED%20CONSUMER%20CREDIT%20INFORMATION1.pdf · https://sundaytribune.co.za/news/2026-03-24-national-credit-regulator-issues-new-guideline-to-strengthen-credit-report-dispute-process/ · https://www.mondaq.com/southafrica/consumer-law/1215684/i-have-been-blacklisted-now-what · https://nfosa.co.za/unfairly-listed-with-a-credit-bureau-speak-up/. Support: bureau must investigate free and act within 20 business days (NCR guideline, December 2024; Mondaq reads the 20 days as the consumer's escalation window, so the row keeps the NCR reading); NCR and NFO routes. Verdict: **kept**.

#### `k.credit_score_moves`
Domain `credit_record`. Sources: https://www.clearscore.com/za/learn/credit-score-and-report/factors-that-affect-your-credit-score · https://www.moonstone.co.za/what-you-need-to-know-about-credit-scores/ · https://www.ooba.co.za/resources/clear-credit-score/ · https://www.debtsolutions4u.co.za/article/credit-score-south-africa-explained. Support: payment history weighs most; utilisation matters; each bureau's own scale (TransUnion 0–999). Durations for how long adverse data stays were **not found** and are not stated; the "30% utilisation" figure was not SA-sourced and is not stated. Verdict: **kept, figures left out**.

#### `k.paid_up_judgment_removal`
Domain `credit_record`. Sources: https://www.gov.za/sites/default/files/gcis_document/201409/37386rg10136gon144.pdf · https://www.acts.co.za/national-credit/r144_3__submission_and_utilisa · https://www.sanews.gov.za/index.php/node/21592 · https://www.mondaq.com/southafrica/consumer-law/1215684/i-have-been-blacklisted-now-what. Support: creditor submits within 7 days; bureau removes within 7 days; cross-bureau notice within 3 days; no relisting; paid-up defaults removed on confirmation. Verdict: **kept**.

#### `k.debt_review_clearance`
Domain `credit_record`. Sources: https://lawlibrary.org.za/akn/za/act/2005/34/eng%402021-06-30/provision/chp_4__part_B__sec_71 · https://www.acts.co.za/national-credit/71__removal_of_record_of_debt_adjustment_or_judgment · https://ncr.org.za/documents/Guidelines/Guideline%20February%202026.pdf · https://www.dcasa.co.za/when-can-you-be-legally-cleared-from-debt-review/. Support: s71(1) 7 days to issue; s71(4) 7 days to file with bureaus; s71(5) expunge; s71(3) Tribunal review. The bureau's own deadline after receipt is not stated in law and not in the row. Verdict: **kept**.

#### `k.funeral_cover_rules`
Domain `protection`. Sources: https://www.1life.co.za/blog/waiting-periods-funeral · https://www.fscamymoney.co.za/Financial%20Protection/Key%20considerations%20before%20buying%20funeral%20cover.pdf · https://www.acts.co.za/long-term-/n1407_2a_6_waiting_periods · https://www.oldmutual.co.za/articles/funeral-cover-for-parents-and-the-elderly/ · https://rcs.co.za/media/dsoblvn3/rcs-funeral-plan-dec-20.pdf · https://www.sirago.co.za/funeral-cover/ · https://www.faisombud.co.za/latest-news/funeral-policies-what-consumers-should-know-and-avoid/. Support: 6-month natural-death waiting period (3 months at some insurers); accidental death no waiting period (product terms); PPR 2A.6 no re-imposed waiting period after a completed one; 31-day cooling-off (FSCA). Verdict: **kept**, "usually" on accidental death (re-check item 12).

#### `k.double_cover`
Domain `protection`. Sources: SASSA deduction rule as for `k.sassa_deductions_rule`; https://www.citizen.co.za/news/south-africa/sassa-warns-insurers-preying-on-pensioners-grants/ (no legal limit on number of policies, only one grant deduction). Verdict: **kept**.

#### `k.beneficiary_nomination`
Domain `protection`. Sources: s37C Pension Funds Act (trustees decide by dependency, nomination guides) — general law not re-searched this round; will formalities (two witnesses, not beneficiaries) — Wills Act, general law. Verdict: **kept, no figures**; flagged for a citation pass.

#### `k.sim_swap_signs`
Domain `protection`. Sources: https://www.sabric.co.za/?p=4450 · https://businesstech.co.za/news/banking/872115/r2-4-billion-stolen-from-south-africans-over-r21800-per-person/ · https://techcentral.co.za/ai-led-digital-banking-fraud-south-africa/269384 · https://techcentral.co.za/sabric-warns-of-surge-in-sim-swap-fraud/200959/ · https://businesstech.co.za/news/telecommunications/284332/8-things-you-should-know-to-avoid-becoming-a-victim-of-sim-swap-fraud/ · https://www.capitecbank.co.za/fraud-centre/report-fraud/ · https://www.fnb.co.za/security-centre/security-software/index.html · https://www.standardbank.co.za/southafrica/personal/products-and-services/security-centre · https://ministryofcyberaffairs.com/bank-fraud-help/south-africa. Support: R2.41bn 2025, 88.6% of cases via apps, social engineering; signal loss as SIM-swap sign; fraud lines Capitec 0860 10 20 43 and FNB 087 575 9444 (own pages), Standard Bank 0800 222 050 (own page), Absa 0860 557 557, Nedbank 0800 110 929, TymeBank/GoTyme 0860 999 119 (third-party aggregator). Verdict: **kept**; row tells the person to confirm each number in the app.

#### `k.ponzi_signs`
Domain `protection`. Sources: https://www.acts.co.za/consumer-protection/43_pyramid_and_related_schemes · https://www.schindlers.co.za/?p=13043 · https://www.justmoney.co.za/articles/what-does-it-mean-to-be-a-registered-financial-services-provider · https://athlonenews.co.za/business/advice/2024-11-13-fsca-warns-of-fraudulent-financial-service-providers-claiming-authority · https://www.sowetanlive.co.za/amp/business/money/2019-03-04-regulator-urges-consumers-to-always-check-fsp-credentials/. Support: s43 multiplication scheme = 20 points above repo; FSP search by name/number; borrowed FSP numbers; 0800 110 443. Verdict: **kept**.

#### `k.safps_protective_reg`
Domain `protection`. Sources: https://www.safps.org.za/Home/OurServices_ApplyProtectiveRegistration · https://securecitizen.co.za/what-is-safps-protective-registration/ · https://banking.org.za/news/guarding-against-identity-theft-important-tips/ · https://grumblesa.co.za/what-happens-if-you-are-listed-on-safps/. Support: free; online, email (protection@safps.org.za, certified ID copy + form) or 011 867 2234; reference within 48 hours; victim-of-impersonation listing needs the credit provider's letter. Verdict: **kept**.

#### `k.family_line`, `k.lending_to_family`
Domain `family_money`. Rules of thumb; PayShap free-under-R100 from `k.payshap_free_rule`. Verdict: **kept**.

#### `k.stokvel_safety`, `k.burial_society_vs_policy`
Domain `family_money`. Sources: https://www.ewn.co.za/more-than-11-million-south-africans-are-members-of-stokvels-nasasa · https://smesouthafrica.co.za/how-to-legally-start-a-stokvel/ · https://www.moonstone.co.za/before-you-invest-tell-tale-signs-that-a-stokvel-is-not-the-real-deal/ · https://sponsorships.standardbank.com/southafrica/personal/learn/why-you-should-consider-joining-a-stokvel · https://www.citizen.co.za/randburg-sun/news-headlines/2025/02/25/dos-and-donts-of-stokvels/. Support: 11 million members (NASASA); GN 404 of 2012; sample constitution; 010 007 2129, info@nasasa.co.za; R100,000 registration rule (conflicting). Verdict: **kept with "sources differ"**.

#### `k.pyramid_scheme_law`
Domain `family_money`. Sources: https://www.acts.co.za/consumer-protection/43_pyramid_and_related_schemes · https://www.gov.za/news/media-statements/national-consumer-tribunal-fines-money-pty-ltd-declares-it-pyramid-scheme-29 · https://www.sanews.gov.za/south-africa/money-fined-r1-million-conducting-pyramid-scheme · https://www.schindlers.co.za/?p=13043. Support: s43 definitions; Up Money R1 million fine; NCC as the reporting body. Verdict: **kept**.

#### `k.goal_vehicle`, `k.goal_monthly_number`
Domain `goals`. Figures reused from `k.tfsa_rules` and `k.first_home_finance`. Verdict: **kept**.

#### `k.tfsa_rules`
Domain `goals`. Sources: https://www.sars.gov.za/types-of-tax/personal-income-tax/tax-free-investments/ · https://www.10x.co.za/blog/tax-free-savings-account-limit-increased-to-r46-000-per-tax-year · https://blogs.easyequities.co.za/treasury-lifts-tfsa-limit-to-r46-000 · https://www.businessday.co.za/news/2026-02-25-budget-2026-tax-thresholds-receive-some-long-awaited-attention/ · https://www.taxtim.com/za/blog/tax-free-savings-accounts-everything-you-need-to-know. Support: R46,000 from 1 March 2026 (2027 year of assessment), R500,000 lifetime, 40% on excess (SARS worked example), no roll-over, withdrawals do not restore room. Verdict: **kept**.

#### `k.first_home_finance`
Domain `goals`. Sources: https://www.ooba.co.za/faq/flisp-subsidy-quantum-table/ · https://grantza.org.za/blog/flisp-subsidy-bands-2026 · https://www.ooba.co.za/faq/how-does-flisp-work/ · https://nhfc.co.za/ · https://nhfc.co.za/tiny/2025/02/Communique-Rejection-of-manual-submission-of-First-Home-Finance-applications-by-third-parties.pdf · https://nhfc.co.za/tiny/2024/07/Communique-to-First-Home-Finance-Subsidy-Partners-and-Applicants_Bank-Statements.pdf · https://www.absa.co.za/personal/loans/for-a-home/government-subsidy. Support: R3,501–R22,000; first-time, owner-occupied, citizen/PR; subsidy range conflict; portal windows; third-party manual submissions rejected; income verification consent. Verdict: **hedged** on amounts.

#### `k.two_pot_withdrawal`
Domain `goals`. Sources: https://www.capitecbank.co.za/personal/credit-hub/articles/planning-and-goals/two-pot-withdrawals-what-you-need-to-know/ · https://personal.nedbank.co.za/learn/blog/2-pot-savings-withdrawals-faqs.html · https://www.allangray.co.za/latest-insights/retirement/two-pot-cheat-sheet/ · https://www.ewn.co.za/2026/06/25/tax-season-warning-two-pot-retirement-withdrawals-could-leave-south-africans-owing-sars · https://taxplanners.co.za/two-pot-retirement-system/ · https://www.taxtim.com/za/calc/two-pot/. Support: one withdrawal per tax year, R2,000 minimum, savings pot only, one-third/two-thirds split from 1 September 2024, marginal-rate tax via directive with no tax-free portion, SARS deducts tax debts. "Cannot be reversed" was not found in a source; the row phrases it as "cannot be cancelled once the tax directive is issued", which follows from the directive mechanism, and is flagged here. Verdict: **kept with that flag**.

## Tools

#### `bank_fraud_report` — Your bank's fraud line
Domain `protection`. Sources as for `k.sim_swap_signs` plus https://www.sabric.co.za/how-to-stay-safe/. Verdict: **kept**; Standard Bank number per its own page; the row tells the person to confirm numbers in the app.

#### `cdc_register` — Council for Debt Collectors
Domain `debt`. Sources as for `k.debt_collectors_rights`. Verdict: **kept**; tariff amounts left out.

#### `debicheck` — DebiCheck and debit order control
Domain `spending`. Sources as for `k.debit_order_control` plus https://www.1life.co.za/globalassets/debicheck/bank/2022-12/updated/fnb.pdf (disputes over R200 via branch or call centre) and https://www.1life.co.za/globalassets/debicheck/bank/2022-12/updated/absa.pdf. Menu paths are typical app navigation, not quoted from a source. Verdict: **kept**.

#### `experian_free_report` — Experian (Up)
Domain `credit_record`. Sources: https://www.experian.co.za/consumer/my-free-credit-check-and-your-free-credit-report · https://www.experian.co.za/contact-us · https://www.experian.co.za/legal/trust-centre/consumer-trust-centre/data-rights/right-of-access · https://solmate.co.za/blog/credit-bureaus-south-africa/. Support: Up platform, free, SA ID; WhatsApp +27 79 127 4906; disputes on the platform. The brief's 0861 105 665 was not found and is not used. Verdict: **kept**.

#### `fsca_check` — FSCA licence check
Domain `protection`. Sources as for `k.ponzi_signs` plus https://tradefx.co.za/fsca-fsp-search/ (search page path) and https://www.ebnet.co.za/?p=37458 (0800 110 443). Verdict: **kept** (re-check item 8).

#### `gotyme_everyday` — GoTyme Bank EveryDay account
Domain `spending`. Sources: https://gotyme.co.za/personal/bank-account/current-account/fees-and-charges · https://gotyme.co.za/personal/bank-account/current-account · https://gotyme.co.za/personal/media/newsroom-landing/banking-south-africans-will-love · https://www.bizcommunity.com/article/from-tymebank-to-gotyme-bank-a-bold-new-digital-first-approach-406159a · https://ministryofcyberaffairs.com/bank-fraud-help/south-africa (0860 999 119). Support: R0 monthly fee; R3 declined debit order; SendMoney voucher fee to non-GoTyme customers; cash withdrawal listed free on one page and R10 on another; old app retired 31 August 2026. Verdict: **hedged** "confirm in the GoTyme app" on every figure except R0 monthly and R3 declined.

#### `gotyme_goalsave` — GoTyme GoalSave
Domain `cushion`. Sources as for `k.goalsave_rules`. Verdict: **hedged**.

#### `municipal_indigent_register`, `eskom_fbe_token`
Domain `income`. Sources as for `k.indigent_register`. Verdict: **kept**; Eskom's 2021 R3,500 threshold left out.

#### `nasasa_stokvel`
Domain `family_money`. Sources as for `k.stokvel_safety`. Verdict: **kept with "ask NASASA"** on the registration threshold and fee.

#### `ncr_complaint`, `ncr_debt_counsellor`
Domain `debt`. Sources: https://ncr.org.za/index.php/departments/complaints · https://www.ncr.org.za/index.php/14-complaint/92-frequently-asked-questions · https://ncr.org.za/index.php/departments/complaints/14-complaint/90-complaints-we-can-handle · https://www.ncr.org.za/documents/Circulars/Circular%201%20of%202024-… · fee sources as for `k.debt_review_what_it_is`. Support: 0860 627 627, complaints@ncr.org.za, form 29, consent form for third parties, hours Mon–Thu 8–5 and Fri 8–4:30, cyber-attack notice on the site. Verdict: **kept**; fees hedged.

#### `nfo_complaint` — National Financial Ombud
Domain `debt`. Sources: https://nfosa.co.za/ · https://nfosa.co.za/wp-content/uploads/2026/08/NFO_Application_Form_Interactive.pdf · https://themercury.co.za/2025-03-04-national-financial-ombud-scheme-marks-one-year-in-operation-facilitates-r416-million-in-consumer-refunds/ · https://corporateandinvestment.standardbank.com/cib/global/who-we-are/about-us/legal/regulatory-bodies · https://www.directaxis.co.za/about/complaints. Support: 1 March 2024; free; 0860 800 900; info@nfosa.co.za; WhatsApp 076 574 8055 (NFO site) vs +27 66 473 0157 (bank pages); 20 working days with the institution first; R416 million in year one. Verdict: **kept**.

#### `nhfc_first_home_finance`
Domain `goals`. Sources as for `k.first_home_finance` plus https://wcedonline.westerncape.gov.za/documents/HousingAllowance/FIRST%20HOME%20FINANCE%20-%20PRESENTATION%20%28STANDARD%29.pdf (online form, document upload, status updates). No NHFC phone number found; none stated. Verdict: **hedged** on amounts.

#### `notes_money_log`, `sheets_budget`
Domain `spending`. No external facts; the apps named are the ones on a standard Android or iPhone. Verdict: **kept**.

#### `payshap`
Domain `spending`. Sources as for `k.payshap_free_rule`; app menu paths are typical navigation, not quoted. Verdict: **hedged** per bank.

#### `safps_protective_registration`
Domain `protection`. Sources as for `k.safps_protective_reg`. Verdict: **kept**.

#### `saps_case`
Domain `protection`. Sources: https://www.citizen.co.za/network-news/lnn/article/opening-a-police-case-is-more-important-than-you-think-this-is-how-it-works/ · https://www.citizen.co.za/kempton-express/news-headlines/2018/06/14/be-informed-about-opening-a-case/ · https://www.citizen.co.za/south-coast-sun/news-headlines/2019/05/16/how-to-report-a-crime/ · https://www.mikebolhuis.co.za/post/project-know-your-rights-as-a-complainant-concerning-the-refusal-by-saps-members-to-open-dockets. Support: any station must open a case; CAS number; 10111; 08600 10111 Crime Stop; SAPS National Complaints 0800 333 177 (via a private security firm's page). Verdict: **kept**; MySAPS app not mentioned (not found).

#### `sars_efiling`
Domain `income`. Sources as for `k.sars_refund_threshold` plus https://www.citizen.co.za/ridge-times/?p=290821 (0800 00 7277, eBooking) and https://www.sars.gov.za/filing-season-2025-everything-you-need-to-know. Verdict: **kept**.

#### `sassa_office`, `sassa_srd_online`, `sassa_whatsapp`
Domain `income`. Sources as for `k.sassa_grants_overview` and `k.srd_grant` plus https://csrd.co.za/sassa-whatsapp-number · https://ourpower.co.za/sassa/contact · https://moshito.co.za/sassa-whatsapp-number/ · https://grantza.org.za/sassa/srd/status-check/how-to-apply. Support: 0800 60 10 11 (consistent); 082 046 8553 (widely published, third-party); srd.sassa.gov.za; banking changes only on the site; documents list. Verdict: **hedged** on the WhatsApp number and the threshold; amounts hedged.

#### `tfsa_account`
Domain `goals`. Sources as for `k.tfsa_rules` plus https://moneywise-2mr.pages.dev/compare/savings/tymebank-goalsave (GoTyme not offering a TFSA as of May 2026, single third-party source; the row says "was not reported to offer one … ask your bank"). Verdict: **kept**.

#### `transunion_free_report`
Domain `credit_record`. Sources: https://www.transunion.co.za/product/annual-free-credit-report · https://transunion.co.za/customer-support/contact-us · https://www.transunion.co.za/assistance/free-credit-report · https://it-online.co.za/2017/10/25/get-free-credit-report-checks/. Support: annual free report page; 0861 482 482 option 2; dispute link on the contact page; OTP/verification steps (older third-party). Verdict: **kept**.

#### `ufiling_uif`, `ccma_referral`
Domain `income`. Sources as for `k.uif_claim` and `k.severance_pay` plus https://pondolandtimes.co.za/?p=38553 ("Apply for benefits → Unemployment benefits"), https://uifcalculators.co.za/articles/uif-documents-needed/ (UI-19, UI-2.8, ID, payslips), https://labourguide.co.za/ccma-section/ccma-information/get-the-power-of-the-ccma-behind-you/ (30 days for dismissal, counting weekends; case management officers; LRA 7.11). One source says the portal is now "UIF Online"; the row keeps ufiling.labour.gov.za and says the claim can be made at a labour centre if the site fails. Verdict: **kept**.

#### `xds_free_report`
Domain `credit_record`. Sources: https://www.xds.co.za/for-me/ · https://www.xds.co.za/customer-solutions/ · https://solmate.co.za/blog/credit-bureaus-south-africa/. Support: Splendi free; 0860 937 000; online disputes. Verdict: **kept**.

#### `fund_two_pot_portal`
Domain `goals`. Sources as for `k.two_pot_withdrawal` plus https://invest.alexforbes.com/za/en/twopot/two-pot (claims through the administrator's own channel). Administrator names are the large SA fund administrators and are not claims about their products. Verdict: **kept with the "cannot be cancelled" flag**.

#### `legal_aid_sa`
Domain `debt`. Sources: https://legal-aid.co.za/how-it-works/ · https://thestar.co.za/saturday-star/news/2026-04-01-more-south-africans-can-now-qualify-for-legal-aid-after-means-test-increase · https://www.sanews.gov.za/node/80588 · https://www.westerncape.gov.za/service/getting-legal-assistance. Support: advice line 7am–5pm; Please Call Me 079 835 7179; April 2026 means test R9,400 individual / R10,200 household (civil), movable assets cap R173,300; NCA debt matters covered; lawyers may not ask for payment. The advice line's own number was not in a snippet, so the row gives the Please Call Me route. Verdict: **kept**.

## Rows added by the lead on 2026-10-30 (general guidance, no figures)

Four rows written to close gaps the blind benchmarks showed, after the researched library landed. Each states no price, fee, rate or deadline; where a body is named it is one already sourced above (Legal Aid SA, SAPS, SAFPS, the NCR, the maintenance office of the magistrate's court).

- `k.partner_money` (family_money): splitting shared bills in proportion to income, one account each, the marriage regime deciding ownership and debt. The last point is the general position under South African matrimonial property law; the row names Legal Aid SA for the person's own case rather than stating a rule. Verdict: general, figure-free; a citation pass on the Matrimonial Property Act would strengthen it.
- `k.maintenance_claim` (family_money): the maintenance office at the magistrate's court takes applications free, without a lawyer, and the court can order deduction from salary. These are the ordinary workings of the Maintenance Act 99 of 1998; no amount or timeline is stated. Verdict: general, figure-free.
- `k.creditor_arrangement` (debt): asking a creditor in writing for a smaller instalment and keeping paying; the formal route is debt review (sourced above). Verdict: general, figure-free.
- `k.prize_sms_scam` (protection): the "you have won, pay a fee" pattern; report to the bank and SAPS; SAFPS protective registration (sourced above). Verdict: general, figure-free.

Keyword phrasings added the same day to existing rows came only from the MAIN benchmark's misses (natural phrasings such as "the month is longer than the money", "pension savings pot", "remove my bad credit for a fee"). Phrasings suggested by the held-out set were deliberately not added, so the held-out score stays an untuned measure; its misses are listed in `docs/kb-gap-analysis.md` as the next content round.
