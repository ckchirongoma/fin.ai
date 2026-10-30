# PRD: Put Charles live on Supabase, OpenRouter and Vercel

| | |
|---|---|
| Owner | The intern doing the deployment |
| Approver | The founder |
| Repository | `ckchirongoma/fin.ai`, branch `main` |
| Status | Ready to start |
| Done when | Every acceptance check in section 9 passes on a real phone, and the hand-back in section 12 is sent |

---

## 1. What you are deploying

Charles is a WhatsApp number that knows one household's money. A person says
hi, answers twelve short questions, hears their money read back, picks one
thing to fix and one money rule, and gets a 90-day plan as a PDF. WhatsApp
then sends one step at a time and asks whether it worked. They can send a
bank statement and Charles reads it back and lays the month out as three
pots. Ask for a picture ("show me my month", "my map", "what do you know
about me?") and Charles sends one with a link to a small page to play with.
Their own ChatGPT or Claude can connect to the same memory.

It is financial education, not financial advice. It never recommends credit
and never asks for an ID number, account number, card number, PIN, OTP or
password.

All the code is written and tested: 920 automated tests pass. **Your job is
configuration, not code.** You create four accounts, paste one SQL file, paste
one environment file, point Meta at a URL, and prove it works end to end.

## 2. The four services, and what each one does

| Service | What it does for Charles | What you create there |
|---|---|---|
| **Supabase** | The database: every household, plan, message, the library, the knowledge graph, the job queue | One new project, one pasted SQL script |
| **OpenRouter** | Every AI model call goes through it: answers, the plan, guardrails, voice notes, reading statements | One API key, with a spending limit |
| **Vercel** | Runs the code: the WhatsApp webhook, the worker, the website, the PDF and picture renderer, the scheduled jobs | One project imported from GitHub, the environment variables |
| **Meta (WhatsApp Cloud API)** | The WhatsApp number people message | One app with WhatsApp added, using Meta's free test number |

Nothing else. No Azure, no separate graph database, no other AI provider, no
BSP. Resend (alert emails) and Jev (guardrails) are optional and covered in
section 8.

## 3. Ground rules. Read these before touching anything.

1. **Ask the founder before you spend any money.** That includes adding
   OpenRouter credit, upgrading Vercel to a paid plan, and anything in Meta
   that asks for a card.
2. **Do not register a production WhatsApp number and do not submit Meta
   business verification.** Use Meta's free test number. Those two are the
   founder's decisions.
3. **Never put a secret anywhere but the service's own settings page.** Not in
   the repo, not in a chat, not in an email, not in a screenshot, not in an
   issue. If you paste one somewhere by mistake, tell the founder and rotate
   it at once.
4. **Never use a real person's bank statement or ID to test.** Your own phone
   number is fine. For statements, use the invented one in section 9.4.
5. **Do not edit code to make something pass.** If something is broken, stop,
   write down exactly what you did and what you saw, and send it to the
   founder (section 11).
6. Everything else in this document is safe to do and safe to redo.

## 4. Before you start (about 20 minutes)

You need:

- [ ] Read access to `ckchirongoma/fin.ai` on GitHub (the founder adds you).
- [ ] A laptop with Node.js 22 and Git.
- [ ] Your own phone with WhatsApp, to be the first test user.
- [ ] Access to the founder's Supabase organisation, OpenRouter account and
      Vercel team, or your own accounts the founder has said to use.
- [ ] A Facebook account to sign in to developers.facebook.com.

Check the code is healthy on your machine first. Clone, install, run:

```bash
git clone https://github.com/ckchirongoma/fin.ai.git
```

```bash
cd fin.ai && npm ci
```

```bash
npm run typecheck && npm test
```

**Acceptance:** the last line of the test run says `# fail 0`. If it does
not, stop and send the output to the founder.

Make a private note, outside the repo, to collect values as you go. You will
need these later. Generate the four "long random strings" now, one per line:

```bash
openssl rand -hex 32
```

Run it four times and label them `WORKER_SECRET`, `SESSION_SECRET`,
`CRON_SECRET` and `ADMIN_SECRET`.

## 5. Phase 1: Supabase (about 30 minutes)

The full instructions, the one thing to edit, and the success table are in
**`docs/SUPABASE-SETUP.md`**. In short:

1. Supabase → **New project**. Name it `charles`. Pick the region closest to
   Johannesburg. Save the database password in your private note.
2. **Database → Extensions → search `vector` → enable.**
3. Open **`db/CHARLES-SETUP.sql`** in the repo, select all, copy. Supabase →
   **SQL Editor → New query** → paste → **Run**. It takes 10 to 30 seconds.
   It is every migration in order, safe to run twice.
4. **SQL Editor → New query** → paste the check query from section 4 of
   `docs/SUPABASE-SETUP.md` → **Run**.
5. **Project Settings → API**: copy the **Project URL** (`SUPABASE_URL`) and
   the **service_role** key (`SUPABASE_SERVICE_ROLE_KEY`) into your private
   note. The service_role key bypasses all security: it goes in Vercel and
   nowhere else.

**Acceptance:** every row of the check query says `PASS`. There are 21 rows.
The ones that matter most:

| Check | Expected |
|---|---|
| Tables with RLS off | 0 |
| Tables created | 39 |
| Knowledge entries (ZA) / tools (ZA) | 56 / 30 |
| Model config rows | 6 |
| WhatsApp templates (drafts) | 6 |
| Knowledge graph tables | 3 |
| Cards table | 1 |
| Vector extension enabled | 1 |

If `vector extension enabled` or `search-by-meaning functions` says `LOOK`,
you skipped step 2: enable the extension and run the whole script again.

## 6. Phase 2: OpenRouter (about 15 minutes)

1. openrouter.ai → sign in → **Keys → Create key**. Name it `charles-prod`.
   Copy it into your private note as `OPENROUTER_API_KEY`.
2. On the same key, **set a credit limit**. Ask the founder for the number.
   This is the safety net if something loops.
3. **Credits:** the account needs credit for real traffic. Adding credit
   spends money, so **the founder does this, or tells you the amount first.**
4. **Models: leave them as they are unless the founder says otherwise.** The
   setup script already pointed every job at one model on OpenRouter that
   reads text, images and PDFs, with a fallback. Which model does which job
   lives in the `model_config` table, never in code, so changing one is a
   single SQL line and needs no redeploy:

```sql
update public.model_config set model = 'the/slug-the-founder-chose' where role = 'wa_reply';
```

What each job is, if the founder asks you to change one:

| Role | What it does | What it needs |
|---|---|---|
| `router` | Reads each message and decides what kind of question it is | Fast and cheap |
| `wa_reply` | Writes answers, and **reads statements, photos and PDFs** | Must accept images and PDF files, or statement reading stops working |
| `help` | Helps when someone is stuck on a step | Good at plain instructions |
| `plan_builder` | Writes the 90-day plan document | The best writer; slower is fine |
| `safety` | Runs the guardrail checks when Jev is not configured | Fast, strict, cheap |
| `voice` | Turns voice notes into text | A transcription model |

**Acceptance:** the key exists, has a limit, and the founder has confirmed
the account has credit.

## 7. Phase 3: Vercel (about 30 minutes)

1. Vercel → **Add New → Project** → import `ckchirongoma/fin.ai`. Framework
   preset: **Other**. Leave the build command empty. Node version 22.
2. Open **`.env.vercel`** in the repo and copy the whole file. In the import
   screen's **Environment Variables** section, click the first Key box and
   paste. Vercel makes one row per variable, with the safe defaults filled.
3. Fill the blanks from your private note:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | From phase 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | From phase 1 |
| `OPENROUTER_API_KEY` | From phase 2 |
| `WORKER_SECRET`, `SESSION_SECRET`, `CRON_SECRET`, `ADMIN_SECRET` | The four random strings from section 4 |
| `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Leave blank for now; phase 4 fills them |
| `PUBLIC_BASE_URL` | Leave blank for the first deploy |
| `INTERNAL_WA_IDS` | Your own WhatsApp number, digits only, country code first (for example `27...`). Keeps your testing out of the real numbers. |

4. **Deploy.**
5. When it is live, copy the production URL (for example
   `https://charles.vercel.app`). Settings → Environment Variables → set
   `PUBLIC_BASE_URL` to it, with no trailing slash. **Redeploy** (Deployments
   → the latest → Redeploy). A changed variable never reaches a running
   deployment until you redeploy.
6. Settings → **Cron Jobs**: three should be listed, from `vercel.json`:
   `/api/cron/nudges` daily, `/api/cron/freshness` weekly, `/api/worker?tick=1`
   every minute.

**Vercel plan limits.** The every-minute worker tick and the longer function
durations in `vercel.json` may not be allowed on Vercel's free plan. If the
deploy or the Cron Jobs page says a limit is exceeded, **stop and tell the
founder**: the fix is a paid plan, and that is spending money.

**Acceptance, in a browser:**

| Open | You should see |
|---|---|
| `<url>/` | The landing page, a phone showing a WhatsApp conversation |
| `<url>/c?demo=month` | Lerato's month in three pots, with a working slider |
| `<url>/c?demo=memory` | "What Charles knows", a picture with Lerato in the middle |
| `<url>/example-plan.html` | A full 90-day plan document |
| `<url>/sponsor.html?demo=1` | The cohort report, marked as invented |
| `<url>/api/health` | JSON. At this point `whatsapp_link` is `false`: that is expected until phase 4 |

## 8. Phase 4: the WhatsApp test number (about 45 minutes)

1. developers.facebook.com → **My Apps → Create App** → type **Business** →
   name it `Charles`. Add the **WhatsApp** product. Meta gives you a free
   **test number**.
2. WhatsApp → **API Setup**: copy the **Phone number ID**
   (`WHATSAPP_PHONE_NUMBER_ID`) and the **temporary access token**
   (`WHATSAPP_ACCESS_TOKEN`). The temporary token lasts about a day; that is
   fine for this test. A lasting one (a System User token) is a later step the
   founder will ask for.
3. App settings → **Basic**: copy the **App Secret** (`WHATSAPP_APP_SECRET`).
4. Put all three into Vercel's environment variables. **Redeploy.**
5. WhatsApp → **Configuration → Webhook → Edit**:
   - Callback URL: `<url>/api/whatsapp-webhook`
   - Verify token: `charles-verify` (or whatever `WHATSAPP_VERIFY_TOKEN` is in Vercel)
   - **Verify and save.** Then **Manage → subscribe to `messages`**.
6. WhatsApp → API Setup → **To** → add your own WhatsApp number as a test
   recipient and confirm the code Meta sends you. The test number can message
   up to five numbers you add here.
7. Templates (for follow-ups outside 24 hours and the website's login code):
   submit the six in **`docs/META-TEMPLATES.md`** exactly as written. Approval
   takes minutes to a day. As each is approved, run the matching line from
   the end of that file in Supabase's SQL Editor. The journey in section 9
   works before any template is approved.

**Acceptance:** `<url>/api/health` now says `"ok": true`,
`"guardrails_live": true` and `"whatsapp_link": true`.

If `ok` is `false`, open the detailed health with your `WORKER_SECRET`; it
lists exactly which setting is missing:

```bash
curl -s -H "Authorization: Bearer $WORKER_SECRET" https://your-url/api/health
```

Run it on your own machine with the secret in an environment variable, never
pasted into a shared terminal or a chat.

### Optional, recommended once the above works

| Variable | What it adds | Where it comes from |
|---|---|---|
| `TYPESAFE_API_KEY` | Jev, the preferred guardrail engine. Without it the `safety` model runs the same checks. | The founder |
| `RESEND_API_KEY`, `ALERT_EMAIL_TO` | Alert emails when something breaks, and a daily summary | resend.com, free tier. `ALERT_EMAIL_TO` is the founder's address, set only in Vercel |

## 9. Acceptance test: the whole journey on your phone (about 40 minutes)

Do this from your own phone, to the test number, in one sitting. Tick each
line. If a line fails, note the time, what you sent and what came back, and
carry on with the next where you can.

### 9.1 Hello and the twelve questions

| Send | Expect |
|---|---|
| `hi` | One message: "Hi, I'm Charles", what will happen, the line saying it never asks for an ID, account, card, PIN or password and that "forget my money" deletes everything, then question 1 |
| Answer each question. Use invented answers, for example the ones below. | Each answer moves to the next question. Fixed-choice questions take a number. |

Use these invented answers, in order. They are Lerato's, the household the
automated end-to-end test walks, so you know they work:

1. `Lerato, I do domestic work three days a week and get two child grants`
2. `2`
3. `Diepsloot, Johannesburg`
4. `Pay off the mashonisa, R200 a week on R800, and put R1,000 away by Christmas`
5. `1, 2`
6. `3, 4`
7. `3`
8. `About R4,800 a month`
9. `2, 4`
10. `1`
11. `2`
12. `1`

| After the last answer | Expect |
|---|---|
| Wait (a minute or two) | Your money read back in a few lines, with "That's right" and "Not quite" |
| Tap **That's right** | Three goals, one marked as Charles's pick |
| Pick one | Three money rules, each next to what usually happens instead |
| Pick one | "Building your plan", then within a few minutes the plan summary, **the PDF**, and a link to your Money Map |

### 9.2 The step loop

| Send or tap | Expect |
|---|---|
| **Next step** | One step, with how to do it and buttons: Done, Walk me through, I'm stuck |
| **Done** | A few lines later, "Did that step change anything yet?" with three buttons |
| **Yes, already** | It records it and offers the next step |

### 9.3 Questions from the library

| Send | Expect |
|---|---|
| `Can a mashonisa keep my SASSA card?` | A direct answer starting "No", grounded in the library, naming the NCR line |
| `How do I get my free credit report?` | Steps, with a date the information was checked |
| `How am I doing?` | A short progress answer, then a picture of your Money Map with a link |

### 9.4 A bank statement

Make an invented statement: a one-page PDF or a phone photo of a page with a
bank name, a month, a few lines of money in (a salary, a grant) and money out
(groceries, an `Edgars account` payment, a loan, bank fees), totals at the
bottom, and a fake account number like `1234567890`. **Never a real person's
statement.**

| Send | Expect |
|---|---|
| The statement, as a document or photo | "Here's what your bank statement says": money in, money out, the biggest lines, fees. **No account number anywhere.** Buttons: Normal month, Not a normal month, Plan my budget. Then a picture of the statement with a link. |
| Tap **Plan my budget** | Your month in three pots, then a picture of it with a link. Open the link: the slider works. |

### 9.5 Pictures and memory

| Send | Expect |
|---|---|
| `Show me what I owe` | A picture of the debt page with a link; the link opens and the numbers change when you edit them |
| `I paid off Edgars last week` | A normal reply |
| `What do you know about me?` | A picture with you in the middle and everything your money touches around you, each with where it came from. Edgars shows as paid off. |

### 9.5b A household (needs a second phone, added as a test recipient)

| Do | Expect |
|---|---|
| From your phone: `invite someone to my household` | A six-character code, and a message to forward |
| From the second phone: the forwarded `join <code>` | "<your name> invited you to share a household", with Join and No thanks, then Charles's hello |
| Second phone: tap **Join** | Your phone gets "wants to join your household. Let them in?" |
| Your phone: tap **Let them in** | Both phones confirm. `who is in my household` lists both first names, never a number |
| Second phone: `leave household` | It confirms; **your phone gets nothing** (leaving is silent on purpose) |

### 9.6 The web

| Do | Expect |
|---|---|
| Open `<url>/plan`, enter your number | A login code arrives on WhatsApp (only within 24 hours of your last message, until the login template is approved) |
| Enter the code | The same plan as the PDF |
| Open `<url>/admin`, paste `ADMIN_SECRET` | The operator dashboard: incidents, the funnel and recent events |

### 9.7 Forgetting

| Send | Expect |
|---|---|
| `forget my money` | A message asking you to reply YES |
| `YES` | Confirmation that everything is deleted |
| In Supabase, run the query below | 0 rows |

```sql
select count(*) from public.businesses;
```

## 10. Checking the knowledge graph

Charles keeps two graphs (`docs/KNOWLEDGE-GRAPH.md`). There is nothing to
configure: the library graph is computed from the library, and the household
graph's tables came with the setup script.

During 9.5, before you send "forget my money", run this in Supabase. You
should see Edgars with `status = closed` and `said` among its sources:

```sql
select n.kind, n.label, e.rel, e.amount, e.per, e.status, e.sources
from public.kg_edges e join public.kg_nodes n on n.id = e.dst_id
order by e.last_seen desc limit 20;
```

## 11. If something goes wrong

| What you see | Likely cause | What to do |
|---|---|---|
| Meta says the webhook could not be verified | Wrong URL, wrong verify token, or the deploy is not live | Check the URL ends in `/api/whatsapp-webhook` and the token matches `WHATSAPP_VERIFY_TOKEN`; redeploy after changing variables |
| You message the number and nothing comes back | Not subscribed to `messages`, the token expired, or your number is not a test recipient | Recheck phase 4 steps 2, 5 and 6; get a fresh temporary token |
| `/api/health` says `ok: false` | A required variable is missing | Run the detailed health in section 8; it names the missing one |
| `guardrails_live: false` | No Jev key and no `safety` row | Rerun the Supabase check query; the `safety` row should exist. Do not go further until this is true |
| Replies are slow or fail, health is fine | OpenRouter out of credit, or a model is unavailable | Check OpenRouter's activity page; tell the founder |
| The plan arrives but no PDF | The PDF function could not start | Check Vercel → Logs for `render-pdf`; tell the founder with the time |
| A statement is "couldn't read that one" | The `wa_reply` model does not accept files | Tell the founder; the model must read images and PDFs |
| Cron jobs missing or refused | Vercel plan limits | Stop and tell the founder (it needs a paid plan) |
| A test fails on your laptop in section 4 | Something changed in the repo | Send the founder the last 40 lines of the test output |

Send problems to the founder with: the time, what you did, what you
expected, what you saw, and a screenshot **with no secrets in it**.

## 12. Hand-back to the founder

When section 9 is done, send the founder:

- [ ] The live URL.
- [ ] The test number's display number.
- [ ] A screenshot of the Supabase check query, all `PASS`.
- [ ] The public `/api/health` output (it contains no secrets).
- [ ] Section 9 with every line ticked, or the failures noted with times.
- [ ] Which templates are approved, pending or rejected.
- [ ] The OpenRouter limit you set, and that the account has credit.
- [ ] Anything you were unsure about.

Do not send any key, token or secret. The founder can see them in each
service's own settings.

## 13. Out of scope for you

- Registering a production WhatsApp number or Meta business verification.
- Spending money on any service without the founder's go-ahead.
- Changing code, prompts, the library or the SQL. If you think something
  should change, write it down for the founder.
- Azure, or any service not in section 2.
- Inviting real users. No cohort runs until the founder says so.

## 14. Where everything is

| File | What it is |
|---|---|
| `docs/SUPABASE-SETUP.md` | The database paste, the one edit, the success table |
| `db/CHARLES-SETUP.sql` | The whole database in one file |
| `.env.vercel` | Every environment variable, laid out for Vercel's paste box |
| `HANDOFF-DEPLOY.md` | The same deployment, for an engineer, with more detail |
| `docs/META-TEMPLATES.md` | The six WhatsApp templates to submit, and how to mark them approved |
| `docs/KNOWLEDGE-GRAPH.md` | The two knowledge graphs |
| `docs/PITCH.md` | What Charles is, for the bank |
| `README.md` | The shape of the code |
