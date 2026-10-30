# Charles — deployment handoff

Written for whoever puts this live. Everything needed is in this file, in the
order it is needed. **An intern or anyone new to the project should follow
`docs/PRD-INTERN-DEPLOY.md` instead:** the same deployment, step by step, with
an acceptance test on a real phone and a hand-back list. Sections 1–4 get a working WhatsApp test number. Section 5
is what is built and what is not.

**Ask the founder before:** spending money, registering the production WhatsApp
number, and submitting for Meta business verification. Everything else in here
is safe to do.

Nothing in this file contains a secret value. Secrets are set by name in
section 3.

---

## Project facts

| | |
|---|---|
| Database | A **fresh Supabase project** the founder creates for Charles (Charlie's project is not reused). Region: pick the one closest to Johannesburg. |
| Hosting | **Vercel** runs the code, Supabase stores the data |
| Models | **Everything goes through OpenRouter.** Which model does which job comes from the `model_config` table, never from code |
| Guardrails | Jev (TypeSafe) preferred; the `safety` model row runs the same checks without it. `/api/health` says which is live |
| Repo | `ckchirongoma/fin.ai` |

---

## Section 1 — create the database and run the scripts (do this first)

The whole of this section, with the paste, the one thing to edit and the
success table, is `docs/SUPABASE-SETUP.md`. In short:

1. Supabase → New project. Note the project URL and the service-role key (section 3). Database → Extensions → enable `vector`.
2. SQL Editor → New query → paste **all of `db/CHARLES-SETUP.sql`** → Run. It is every migration in order in one file, safe to run twice.
3. SQL Editor → New query → paste the check query from `docs/SUPABASE-SETUP.md` section 4 → Run. Every row must say `PASS`. Among them: RLS on for all 36 tables, 56 knowledge entries and 30 tools for ZA, six model rows, six template drafts, no Charlie column left behind.
4. Set the models. The `model_config` rows the script inserts are starting values; replace each `model` slug with one you have chosen on your OpenRouter dashboard (OpenRouter → Models). One `UPDATE` per role; the webhook reads the table on every call, so a change is live at once.

Without SQL, the library can also be loaded from `seed/` through the REST API: the command is at the top of `db/0034_charles_za_library.sql`.

---

## Section 2 — deploy on Vercel

1. Vercel → Add New Project → import `ckchirongoma/fin.ai`. Framework: Other. No build command. Node 22.
2. Deploy once with no environment variables: it will come up and `/api/health` will list what is missing.
3. `vercel.json` already sets the function sizes, the crons (`/api/cron/nudges` daily, `/api/cron/freshness` weekly, `/api/worker?tick=1` every minute) and the rewrites (`/mcp`, `/plan`, `/wa`, `/my-plan`).

---

## Section 3 — set the environment variables

The fast way: open `.env.vercel` in the repo, copy the whole file, and in Vercel → Project → Settings → Environment Variables click the Key box and paste. Vercel splits it into one row per variable, with the safe defaults already filled. Fill the blanks from the tables below, save, then **redeploy** (a change does not reach a running deployment). The deploy button in `README.md` does the same for the required ones at import time. `.env.example` is the same list with longer notes, for local work.

### Required. Charles will not run without these.

| Name | Where it comes from |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page. Bypasses RLS: Vercel only, never a browser, never the repo |
| `OPENROUTER_API_KEY` | openrouter.ai → Keys |
| `WHATSAPP_APP_SECRET` | Meta → App → App Settings → Basic |
| `WORKER_SECRET` | Any long random string you generate |
| `PUBLIC_BASE_URL` | The Vercel URL, e.g. `https://charles.vercel.app` |

### To actually send WhatsApp messages

| Name | Where it comes from |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Meta → WhatsApp → API Setup (a temporary token first; a System User token for anything lasting) |
| `WHATSAPP_PHONE_NUMBER_ID` | Same page |
| `WHATSAPP_VERIFY_TOKEN` | Any string; you type the same one into Meta in section 4 |

Without these Charles still runs, thinks and writes to the database; it sends nothing and logs every skipped send.

### Strongly recommended

`SESSION_SECRET` (the website and the connector cannot issue credentials without it), `CRON_SECRET` (the cron endpoints fail closed without it), `TYPESAFE_API_KEY` (Jev), `ADMIN_SECRET` (the `/admin` dashboard), `RESEND_API_KEY` and `ALERT_EMAIL_TO` (alert emails; `docs/TRACKING.md`), `INTERNAL_WA_IDS` (your own and your testers' numbers, kept out of the funnel).

### The guardrails — read this before going live

`/api/health` must say `guardrails_live: true`. With no Jev key and no `safety` row the checks run on nothing, and the health page says so in capitals. Every check writes a `safety_events` row either way, so a switched-off guardrail is a row in the database, never a silence.

---

## Section 4 — point Meta at the webhook

1. developers.facebook.com → your app → WhatsApp → Configuration → Webhook: Callback URL `https://<your-vercel-url>/api/whatsapp-webhook`, Verify token = `WHATSAPP_VERIFY_TOKEN`. Verify and save.
2. Subscribe to the `messages` field.
3. WhatsApp → API Setup: add your own number as a test recipient, send "hi" from it. The first message back is the hello, the consent line (including "forget my money") and question one.
4. Submit the six templates in `docs/META-TEMPLATES.md`, then mark each approved one in `wa_templates` (last section of that file). Until then follow-ups outside the 24-hour window are not sent, and the plan viewer's login code cannot be delivered outside it either.

### Going live on your own number (the founder's part)

Meta business verification and a production number are the founder's call and cost money: ask first. The test number serves the whole journey for testers until then.

---

## Section 5 — what is built

- The whole money journey: hello → twelve questions → read-back → goal → rule → plan from the fixed library → step loop → outcome. Hardship mode on every door. Voice notes. Forwarded links and photos with a scam check. "Forget my money" with a confirmation.
- The plan document, printed to PDF in a real browser, with the strategy and the Money Map; the per-step PDF.
- The web: landing page, sign-in by WhatsApp number, the plan viewer, the web chat with the same guardrails.
- The connector for the person's own AI, with the plan, the step and the map drawn inside Claude and ChatGPT.
- The South African library: 56 knowledge entries, 30 tools, sourced and measured (`docs/kb-gap-analysis.md`).
- Tracking, alert emails, the admin dashboard, the sponsor report.
- A bank statement, payslip or credit report, read only when the person chooses to send one, said back from the page and laid out as three pots; never the file, never an account number.
- Cards: six small pages sent as pictures with a link (the month, a debt, the Money Map, the statement, a goal, what Charles knows), built in code from the person's own figures.
- Two knowledge graphs (`docs/KNOWLEDGE-GRAPH.md`): the library's, computed from the library, and each household's, in `kg_nodes` and `kg_edges`, every line with where it came from.

## What is deliberately not built

- Reading the bank's own data or any account. Charles knows what it is told, and what a statement the person chose to send shows.
- A second market's library.
- A recommendation to take credit, ever.
- Testimonials, user counts, pilot results. No cohort has run.

## Definition of done for a first pilot

- [x] RLS fixed with real policies (`db/0001`), to be run on the fresh project.
- [ ] A real WhatsApp test number where a stranger completes the journey by chat. **Needs the Meta setup above.**
- [x] The plan from the fixed library, grounded only in shortlisted knowledge (`test/journey.e2e.test.ts`).
- [x] Every fact confirmed before use; no "you told me" (`test/context-guardrails.test.ts`, `test/safety.test.ts`).
- [x] One full "Send next step" → walkthrough → "Done" → outcome loop (`test/journey.e2e.test.ts`).
- [x] The plan document prints correctly (`scripts/check-plan-print.ts`, nothing wider than A4).
- [x] Every model choice from `model_config`.
- [x] The web plan viewer shows the same plan (`api/plan.ts`, `public/plan.html`).
- [x] A landing page with a working link to the number (`public/index.html` → `/wa`).

## Before each release

```bash
npm run typecheck
```

```bash
npm test
```

```bash
TRACKING_OFF=1 node --experimental-strip-types --import ./scripts/register-ts.mjs --test "test/**/*.test.ts"
```

```bash
npm run eval -- --dry
```

```bash
node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/kb-coverage.ts
```

```bash
node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/preview-plan.mjs
```
