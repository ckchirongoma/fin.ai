# Charlie — the whole experience, planned to the bone

> ## Charles addendum (2026-10-30)
>
> This document is Charlie's design record, kept because every decision in it
> still holds for Charles and was earned the hard way. Read it with the
> vocabulary map in `docs/superpowers/plans/2026-10-30-charles-build-plan.md`:
> business → household (one person's money), owner → person, customer → goal,
> angle → rule, idea/start/run/grow → surviving/stretching/steady/building,
> distress → hardship, the eight business areas → the eight money areas
> (income, spending, debt, cushion, credit_record, protection, family_money,
> goals), the five markets → South Africa first. Where this file names a
> business body (CIPC, SARS for a business, SEDFA), Charles names the money ones
> (the NCR consumer line, SASSA, SARS for a person, the National Financial
> Ombud). Two rules were added for Charles: never recommend credit, and never ask
> for an ID number, account number, card number, PIN, OTP or password. The
> design itself is `docs/superpowers/specs/2026-10-30-charles-design.md`.
>
> One door Charlie never had: a bank statement, sent by choice
> (`docs/superpowers/specs/2026-10-30-statement-design.md`). The offer sits
> under the income question and in the answer to "can you read my
> statement?". One model call extracts totals and payees with identifiers
> left out; everything said back, the three-pot budget included, is built in
> code from those figures; the file is never stored. And cards
> (`docs/superpowers/specs/2026-10-30-cards-design.md`): five small pages a
> person opens from a WhatsApp link, each sent with its picture, built in
> code from their own figures.


*The design of everything an owner touches, in the order they touch it, and the
machinery underneath each moment. Written against the code as it stands —
every file path in here is real — with the deliberate gaps marked as gaps
rather than papered over. This is the document to argue with: if a design
decision isn't defensible here, it isn't defensible.*

---

## 0. The spine

Everything below hangs off five commitments. Each one traces to evidence or to
a failure that already happened — none is taste.

| Commitment | Where it comes from |
|---|---|
| **One recommendation, never a menu.** | HBS WP 24-042: 640 Kenyan owners, a GPT-4 WhatsApp mentor offering 3–5 suggestions per question. Zero average effect; the strongest businesses +15–20%, the weakest ~10% *worse*, because weaker owners couldn't tell which suggestion fit. Choosing is the product. |
| **Structure is never generated.** | Early prototypes let the model design plans and got "ask people for a price" as a 90-day strategy. The fixed module library (`api/_lib/playbooks.ts`) decides what is in a plan; the model only tailors wording, and `hydrateWorkstream()` makes that structural — an invented step has no library entry to merge onto, so it cannot exist. |
| **Nothing claims the owner said what they didn't.** | A real step once told an owner about "the leak you named" when they'd named no leak. Now a proposition checked on every generated step, every live reply and the whole strategy document — and a caught breach is *replaced* with library wording, not logged and sent anyway. |
| **Judgement may flag or soften, never silence — and never silently.** | The guardrail layer fails open (a wrongly-swallowed message to a real owner is worse than a needless one), but every check that could not run writes an `unavailable` row to `safety_events` and shows on `/api/health`. The first build shipped with every guardrail silently off; that class of failure is now structurally impossible to miss. |
| **Free and reversible before anything that costs money.** | In every recommendation, in the ordering bonus inside retrieval itself (`retrieval.ts` scores free options up), and in stabilising mode, where a business in real distress gets cash protection and a free human advisor instead of a plan. |

One sentence on tone, binding everywhere: plain, warm, direct; the owner's own
words for their own business; no jargon (`ICP`, `funnel`, `CRM`, `SEO`, `KPI`
are banned strings, enforced in `tidy()`); no hype; "great question" never.

---

## 1. The journey, message by message

Every state below is a value of `Stage` in `api/_lib/types.ts`, every button an
explicit action id in `api/_lib/actions.ts` (rule 7: a tap dispatches on its
id, never on its label), and a test in `test/` asserts every stage has a
handler — because an unhandled stage is an owner stranded in silence, which is
the worst thing this product can do.

### 1.1 First contact

The first message from a new number is a greeting, not an answer to a question
nobody asked. Charlie replies with ONE message, in the order a person would
say it: who Charlie is and what it does, then the consent line, then question
one. (Until 2026-10 the consent line went out first, on its own, before
Charlie had even said hello — the founder found that backwards.)

1. Hello and what to expect: *"Hi, I'm Charlie…"*, how many questions, how
   long, what they get at the end.
2. Consent, one line, plain: *"I'll keep what you tell me about your business
   so I can help you properly. Nobody else sees it, and you can send 'forget
   my business' any time and it's gone."* Not a terms link. The promise is
   real: `forgetBusiness()` hard-deletes across every table (db/0007 makes the
   cascades structural), keeps only a count with nothing identifying in it,
   and the same number can start again a minute later.
3. Question one of the diagnostic.

The market follows **where the business is, not the phone number** (round
24). The number's dialling prefix (`countryFromWaId`) is only the first guess,
for the two questions before "Where are you based?". That answer decides
(`location.ts`, read in code from fixed lists of each market's country name,
regions, cities and the suburbs owners name), before the price and
registration questions are asked:

- a place in one market: stamped on `businesses.country`, nothing more asked
  (a South African number with a salon in Kampala is asked "For example UGX
  15,000" and "registered with URSB");
- no place on the lists, or places in two markets: the owner is asked, never
  guessed for — one tap ("Yes, Uganda") when the number's own country is one
  of the five, the list of five plus "Somewhere else" otherwise;
- a place outside the five (Lusaka, Harare, London): said honestly — Charlie
  only knows the fees, rules and tools of the five, and will not build a plan
  on guesses — and the question stays open (`market_outside`, the demand
  signal for a sixth market);
- the market moving later (a read-back correction that says "in Kampala", or
  a diagnostic already past the question when this shipped): registration is
  asked again in the new market's terms, and the price too unless it was
  already given in that currency, then the read-back runs again.

From then on every prompt carries that country's currency, registrar, tax
authority and free advisor (`groundingLine` in `countries.ts`), and the web
plan, the PDF, the web Q&A and the connector all read the same
`businesses.country`. Existing businesses stamped from their number are
listed (and, only with `--apply` and only before they have a plan, re-tagged)
by `scripts/market-mismatch.ts` — the founder's call.

Adding a market is mostly data, but not only data. Uganda (the fifth) needed,
in order: a `COUNTRIES` row (prefix, currency, registrar, tax body, an
advisor that a verified tool row backs, and `moneyRe`, how its money is
written); its places in `location.ts` (`PLACES`, and its country names in
`COUNTRY_NAMES`), or its owners are always asked which country they are in;
its money forms in `grounding.ts`
(`CUR`, plus the "50,000/=" suffix), `pricestamp.ts` (`SLOT_CUR`),
`contacts.ts` (`CURRENCY_BEFORE_RE`, and ".ug" in `URL_LIKE_RE`) and
`signals.ts` (`MONEY`); its own id on every plan step that names a tool and
every pinned topic (`playbooks.ts`); its brand words (`OWNER_TOOL_WORDS` in
`engine/build.ts`, `TOOL_ALIASES` in `signals.ts`); its distress phrasing
(`MONEY_TROUBLE_RE`); greetings, transcription vocabulary and utilities; the
web sign-in copy; the eval's advisor pattern and questions; and the library
itself, measured by `scripts/kb-coverage.ts` and `scripts/kb-depth.ts`.
`test/uganda.test.ts` pins each of these.

### 1.2 The diagnostic — 12 questions, ~5 minutes

Defined in `api/_lib/diagnostic.ts`. Three shapes, decided by what WhatsApp
can actually do, not by taste:

| Shape | Sent as | Why |
|---|---|---|
| Open (name, location, objective, price) | Plain text, voice note welcome | The owner's words are the product's raw material |
| One answer, ≤3 options | Reply buttons | Real buttons, real action ids |
| One answer, >3 options | List message | 10 rows max, single-pick |
| Many answers | **Numbered plain text** ("reply 1, 3") | WhatsApp has no multi-select control at all. Pretending a list is one silently loses half of an owner's answer |

Rules in force during the diagnostic:

- **The question gate** (rule 7's second half): a reply that reads as a
  question — "what does registered mean?" — is never stored as the answer to
  what was pending. It is **kept** (`businesses.kept_questions`, db/0026, at
  most three) and answered straight after the plan is handed over, when
  Charlie knows the business — or after the stabilising message, if the
  diagnostic ends there (`engine/kept.ts`). The owner is told exactly that;
  without db/0026 they are asked to send it again instead. Structural check first (ends in "?", under
  200 chars — free), then a Jev/model judgement (§5). **With a floor:** bounce
  once, and if the owner says the same thing again, take them at their word.
  "How do I get more customers?" is a fine answer to "what are you trying to
  fix?", and without the floor that owner was trapped forever.
- A tapped diagnostic option carries its step in the action id (`d.3.1`), so a
  tap on a stale card from three questions ago cannot corrupt the current
  answer — and a diagnostic tap after the plan exists gets *"That was from
  when we first met"* plus useful buttons, instead of (as originally shipped)
  silently rebuilding the entire plan.
- Voice notes are transcribed (§7) with a decoder hint biased toward the
  vocabulary that actually gets mangled — spaza→spa, panelbeater→panel beat,
  laundromat→lodge — and a low-confidence transcript is read back before
  anything is built on it.

The question that matters most is number four — *"what are you actually trying
to achieve or fix? This is what your whole plan gets built around"* — because
everything downstream (`signals`, module selection, the strategy document, the
one-recommendation discipline) is anchored to the owner's own statement of the
problem, quoted, never paraphrased into something they didn't say.

### 1.3 Distress check — before a single plan-building token

`checkDistress` runs on the raw answers first. A business that cannot pay rent
does not get a growth plan; the evidence says handing it one causes harm. It
gets stabilising mode: three moves (collect what's owed, no new debt, spend
nothing), the country's *free* advisor named, and the door left open. The
stabilising message is **pre-written, not generated** — the one moment a model
has nothing to add and something to lose.

Stabilising mode's design constraint is that it must have an exit. What the
owner says while in it is appended (newest words kept — the truncation
direction was a real bug) and re-judged; when the distress reading clears,
Charlie *asks* — "want me to build the plan now?" — and waits for the tap.
Asks, because this is precisely the owner who must not be pushed.

### 1.4 Identity, once

One call reads the whole diagnostic and produces a single `identity` object;
where the transcription-vs-reality doubt exists it is surfaced as one question
("Did you mean a laundromat rather than a lodge?"). The owner confirms or
corrects **before anything is built**, and every later prompt uses the
established identity, never a re-reading of the raw answers (rule 5). A typed
"yes-ish" reply confirms; anything else is treated as a correction — the safer
reading of ambiguity.

### 1.5 Choosing the customer, then the angle

Collaborative, not one-shot (rule 4). Four *genuinely different* customers —
the prompt forces at least two business/contract segments, because in most
trades the real money is in the segment the owner doesn't think of first
(guesthouses for a laundry, fleets for a mechanic, bridal parties for a
salon). Then three angles, each a sentence the owner would actually say, each
with its honest cost. Multi-select on both, as numbered text.

Reading the choice is a judged act, not a regex: "the second one and maybe the
last" resolves properly (§5.3). Two hard rules, both from real failures:

- A judged "this reply selects nothing" is an **answer** — the digit scan may
  not override it, or "I don't understand option 2" becomes a vote for
  option 2 and the whole plan is built on it.
- **Never default to option one.** Who the owner aims at is the decision the
  plan is built on; when the reply can't be read, Charlie asks again. Asking
  twice is cheap; guessing wrong is not.

### 1.6 The build — and what the owner experiences while it runs

The moment the angle lands, the owner gets an acknowledgement with their goal
restated, then typing indicators (`markRead` sends one) while the build runs.
Messages arriving mid-build get *"Still putting it together — one minute"*;
a build stalled past four minutes is restarted by the owner's own next message
(`handleBuilding`). Nobody waits on a corpse.

Under the hood, in parallel: the context+map call; Jev/model rubric scoring
overriding the map's colours (consistency across owners is what makes the map
reportable); the **strategy document** (§2); and one tailoring call per chosen
module, each grounded in its *own* keyword shortlist, never the whole library.
Every generated step then passes compliance (§5.4) before it is stored.

If `pickPlaybook` finds no module the diagnosis actually earned, Charlie says
so — *"I don't have enough to build you a real 90 days yet, and I'd rather say
that than hand you three generic parts"* — and asks for the one thing that
would make the difference. An honest nothing beats a plausible anything.

### 1.7 Delivery

Outline in chat (parts, steps, order rationale), then the full document as a
PDF (§2), then the bridge: link to read it on the web, "send *connect* for
your own AI", and three buttons — **First step**, **Why this order?**,
**Change something**. The document is never the end of the conversation; the
first step is.

### 1.8 The loop that makes it a product

`api/_lib/engine/steps.ts`. Send next step → do it → done → *did it actually
work?* → next. The Kenya mentor's documented failure was that it never
learned; this loop is the learning.

- **A pushed step is a commitment** (3-day due date) — that is what the
  follow-up engine works from. One per step, idempotent: re-taps within 90
  seconds get *"that's the one you're on"*, not three duplicate messages and a
  second commitment.
- **Walkthroughs are pre-written** on the tool rows (none link-only), so
  "take them to the door" costs zero model calls. An unreadable tool row
  mid-walkthrough says so and hands over to help — it does not (as first
  shipped) declare the step done and congratulate the owner on work they
  hadn't finished.
- **"I'm stuck" is a real path**: the help call gets the step, its done-when,
  the walkthrough line they're on, and a shortlist scored on their own words;
  its reply pins `pending_action` to the step so its Done/Skip buttons act on
  the right thing. "This step doesn't fit you — skip it" is an allowed and
  encouraged answer.
- **The outcome question is asked every time** something is marked done:
  better already / too early / no change. Logged to `outcomes`, which feeds
  the harm monitoring split (§9). A map area moves up **only** on a completed
  step plus a reported improvement — never on a tap, never downward without
  the owner saying something stopped working.
- **Changing the plan** is bounded: swap a tool (within the step's allowed
  choices), drop a step, move a part forward — or "none", with the reason the
  order is what it is. A plan that bends to every discomfort stops being a
  plan; one that can't bend to reality stops being followed.
- **Completion is a beginning**: its button carries its own action
  (`a.plan.rebuild` — wired to anything else it loops), asks what changed,
  and feeds the answer into the same builder with the finished work as
  context. The next 90 starts from where the business *is*.

### 1.9 Between sessions: the follow-through

`api/_lib/nudges.ts`. Hard caps in code that no model can talk past: two
business-initiated messages a week, nothing within two days of the last
outbound, one tap pauses everything permanently — and an owner messaging
Charlie again is *not* consent to resume (that regression is tested). Priority
order: overdue commitment → monthly check-in → month-end money → weekly focus
→ re-engage after 14 days. "Send nothing" is written into the prompt as a good
outcome and logged as one. Inside the 24-hour window nudges go free-form;
outside it only Meta-approved templates (`wa_templates`, six drafted including
the sign-in code) are even attempted.

### 1.10 Q&A and forwarded things, forever after

Any message once a plan exists: router classify (cheap) → shortlist → one
grounded answer through the full reply schema → compliance check → memory
update from **what the owner said, never what Charlie suggested**. Forwarded
links are fetched with a guard that survives redirects (every hop re-checked
against private-address space) and always get the scam check: fee-to-release,
banking details, unofficial domain, pressure to act today. Distress detected
mid-conversation does everything diagnostic-time detection does — state,
audit row, stabilising — because a stabilising message followed by
business-as-usual on the very next turn is theatre.

**Writing for the owner (round 31).** Asked to write a message or a post,
Charlie writes it. A special they have decided on is theirs: it is written at
their price, with the downside in one line from their own numbers, never
argued down and never turned into "which do you want to send?". A special
priced above everything they usually charge is asked about once, in fixed
words, before any model writes ("R120 is more than your usual R80… Is R120
right?", with an "R120 is right" button), and their answer is never asked
again. No compliance step they did not ask about rides along (registering,
an officer, a licence), and no regulator line sits under the promo unless
they asked about customers' data, and no data-protection rule said in
passing either (round 32: the rule is theirs the moment they ask). "Above
the usual price" means above what they charge for the same service, not
above everything they sell. Asked for a special with none given, Charlie
asks what it is rather than inventing one; a special they gave a message
or two earlier is used, and quoted back in their own words, so a different
one is one message away, and every earlier special the words use is named.
Words to send that already went out are not sent again under an answer to
something else, and "send it again" resends them exactly, with no model.
Round 33: a special they decided on is not handed back ("Worth it to
you?"), nudged lower, or offered a "Make it cheaper" button; asked for words
about a special with none given, Charlie asks what it is before any model
writes; the owner is always "you", and what they did or did not do is never
assumed ("If you didn't…", not "You didn't…"). Round 34: a promo post is
written whenever it states no deal nobody gave (their own prices and hours
are theirs); a price above what they charge for a service is never called a
special in later words; and no blank [slot] is left in Charlie's own advice.

---

## 2. The document

Three parts, in the order a reader — the owner, or the funder they hand it to —
actually needs them. The old document was Part III with a map stapled on; the
honest review of it was "no depth".

| | What it holds | Written by |
|---|---|---|
| **I — Where the business stands** | The facts as the owner gave them, as a table ("this is your business, on paper"); *what your answers add up to* — two-three paragraphs reading the business; the eight areas, with **what "sorted" concretely means** for every area that isn't (deterministic, straight from the rubric); working vs leaking | Facts and rubric: deterministic. Narrative: model, grounded, checked |
| **II — The strategy** | Chosen customer(s) in full; the angle as the sentence the owner will say; what that customer does instead today and how we win against it; **what we deliberately won't do** (strategy is also refusal); **the money logic** in the owner's own numbers — never an invented figure, and simple arithmetic shown where their numbers allow it; day 30/60/90 as *statements that are true*, not effort; three risks each with its response | Model, grounded in diagnostic + choices + verified library, `strategy_compliance`-checked (§5.6) before storage |
| **III — The next 90 days** | The steps, with ready-to-paste artifacts and done-when lines; the tools with verified costs | Fixed library, tailored wording only |

Stored as `plans.strategy` (jsonb, db/0008) so the PDF, the website viewer and
the MCP connector all serve the *same* document — one source, three doors. A
plan whose strategy call failed renders coherently without Parts I.2/I.4 and
most of II; depth degrades, delivery never blocks.

Rendering (rule 8) is non-negotiable: presentation tables, inline hex, no
grid/flex/`var()`/negative margins — the HTML-email discipline that survives
every renderer including print. `scripts/preview-plan.mjs` renders a realistic
fixture through actual Chromium after any change and *fails* if a banned
construct crept back in. Page-break guards keep each step, card and milestone
row intact across pages.

---

## 3. The website

Two jobs, one data source (never a second one):

1. **The marketing page** (`public/index.html`, static, zero JS): the owner
   pitch in owner language (the say/don't-say table from PRODUCT-DEFINITION
   2.5 is binding), the worked Thandi example, and an unburied **"For a funder
   or programme"** section — the sourced numbers with their caveats intact,
   the Kenya RCT stated plainly with one-recommendation as the design
   response, the metrics a cohort reports, the do-no-harm commitment. It says
   out loud that no cohort has run yet. No testimonials, no counts, nothing
   implied.
2. **The plan viewer** (`public/plan.html` + `api/plan.ts`): identity is the
   WhatsApp number; a six-digit code arrives *on WhatsApp* (so only the person
   holding the phone can sign in), hashed at rest, five attempts, ten-minute
   expiry, same response for known and unknown numbers (no enumeration).
   What renders is `planDocHTML` over the same rows — strategy included — in
   a sandboxed frame with a print button. The definition-of-done sentence "the
   website shows the same plan from the same row" is a test, not a claim.

Later (designed, not built): the owner dashboard — map over time, commitments,
outcome history — once there are owners; and the sponsor console as a page
over `/api/sponsor`, which already serves the aggregates.

---

## 4. The owner's own AI — the MCP door

The product's data has two doors: WhatsApp, and the owner's own Claude or
ChatGPT via MCP (`api/mcp.ts`). Deep reasoning runs on the owner's own
subscription — Charlie's marginal cost for the heaviest thinking is zero.

**Protocol reality:** two MCP eras are live simultaneously; the endpoint
speaks both (modern `server/discover` + per-request `_meta`; legacy
`initialize` handshake), is stateless and JSON-only (conformant in both eras),
returns tool failures as `isError` results the model can read rather than
protocol errors the host swallows, and marks every response `cacheScope:
"private"` — one owner's business must never sit in a shared cache.

**Auth, pragmatically:** a per-owner secret address (`/mcp/<token>`), minted
by sending *connect* on WhatsApp, accepted as bearer header, path or query —
because that is what every host actually supports today. Hashed at rest,
constant-time compared, revoked by rotation. OAuth waits until it buys
something real.

**The tools** (each described *for the model that will call it*, with the
instructions block teaching it Charlie's rules — one next step, library costs
only, free-first):

| Tool | Contract |
|---|---|
| `get_business_context` | Identity, stage, context, choices, open commitments, recent WhatsApp turns, **and the house rules**; since round 27 the **north star** (the goal and the step they are on), progress, what Charlie remembers about them, recent decisions, and where they are on WhatsApp |
| `get_business_map` | The eight areas from the normalised table |
| `get_plan` | Goal, headline, **the full strategy**, outline, every step with status |
| `find_knowledge(query, domain?)` | The same two-pass retrieval as WhatsApp; verified costs with dates; explicitly says when nothing matched rather than inviting a guess |
| `log_decision(what, why)` | Owner decided something — WhatsApp now knows |
| `add_commitment(what, due)` | Owner will do something — WhatsApp will follow up |
| `propose_change(fact, from, to, reason)` | **Never writes.** Critical facts (what they sell, who to, price, registration, goal…) go to a pending row + a yes/no push on WhatsApp. The tool's reply tells the AI to say nothing has changed yet. An owner's plan cannot be rewritten by a laptop conversation without a thumb on a phone saying yes. Refused while a plan is being built on WhatsApp (round 27), so a yes/no never lands mid-build |
| `get_current_step(send_to_whatsapp?)` | Round 27. The step they are on, whole: what to do, why for them, done-when, the words ready to send (or the draft with its blanks named, never a placeholder as "ready"), the library how-to, the tool with its checked cost and set-up. Optionally pushed to WhatsApp exactly as "Next step" does, inside the 24-hour window only. Held while stabilising; refused during a build or rebuild |
| `complete_step(step_id?)` / `skip_step(step_id?, reason)` | Round 27. The same state WhatsApp's Done and Skip write (`engine/steps.ts` `recordStepDone` / `recordStepSkipped`): status, the step's follow-up closed or dropped, the decision log. WhatsApp is released from that step; any other flow there is left alone. Nothing extra is sent — the owner is in their AI's chat |
| `report_outcome(step_id, effect)` | Round 27. Only for a finished step, once, in the owner's words (better / same / too_early); a "better" moves the map area up through the same plausibility check as WhatsApp |
| `request_plan_change(change, reason?)` | Round 27. **Never writes.** A change to the plan's steps goes to a pending row and a yes/no on WhatsApp; on yes it runs through the same change flow as typing it after "Change my plan" (library tools only, the step settled from the owner's words). Not stored or asked outside the 24-hour window, so WhatsApp is never left waiting on a question nobody saw |
| `send_plan_pdf` | Round 27. Queues the plan document for WhatsApp (a `plan_pdf` job in "asked" mode — rendered off the AI's request), plus the online link |
| `remember(note, about)` / `forget_note(note_id)` | Round 27. Memory about the PERSON (db/0032 `owner_notes`): their hours, who helps, money they can or cannot put in, how they like to work, worries. Never a secret (ID, account, card, phone number, PIN, password). The WhatsApp memory step keeps such notes too, and every answer's prompt carries them as background, never as "you told me" |
| `flag_hardship(what_they_said)` | Round 27. Rule 9 on this door: the same evidence test as a WhatsApp message (money words, or the safety judge's second opinion), and on agreement the same switch to stabilising mode, so WhatsApp stops pushing growth steps |

**Drawn in the chat (round 28).** `get_plan`, `get_current_step` and
`get_business_map` carry `_meta.ui.resourceUri` (MCP Apps, SEP-1865, stable
2026-01-26) and ChatGPT's `openai/outputTemplate`, both pointing at the same
static page (`api/_lib/appview.ts`; `ui://charlie/view.html` as
`text/html;profile=mcp-app`, `ui://charlie/view-chatgpt.html` as
`text/html+skybridge`). The host reads the page once and hands it each tool
result's `structuredContent`, which now says which `view` to draw (step,
plan, map, paused, none, done) and, where there is nothing to draw, a message
written to the owner rather than to their AI. The page listens on both
bridges (`ui/notifications/tool-result`, `window.openai.toolOutput`), draws
with tables and inline hex (rule 8), escapes every owner string, opens only
http(s) links through the host, and declares an empty CSP. Its buttons are
actions (rule 7): `complete_step`, `report_outcome`, `get_current_step` (with
`send_to_whatsapp` for "Send to my phone"), each through the host, and each
tells the AI what the owner did (`ui/update-model-context`, or ChatGPT's
widget state). `test/round28.test.ts` runs it in a real Chromium.

**What the owner's AI is told (round 27).** The instructions now make the 90-day
plan the north star: an off-plan question gets a real answer, grounded in
`find_knowledge` for anything that costs money or binds them, then a kind
nudge back to the step they are on (park the idea, or change the plan through
the owner). They carry Charlie's research-backed rules in full, with the
reason for the first: one recommendation, never a menu (the HBS field
experiment, WP 24-042: weaker owners given several suggestions did worse);
library facts only, never memory; free and reversible first; stabilising mode
with the country's own free advisor; tax and legal named to the country's own
bodies; no "you told me" from memory. `test/round27-mcp.e2e.test.ts` pins every
one of them for all five markets, so they cannot quietly regress.

**Roadmap for the MCP surface:** (1) a scoped read-only *sponsor* token
serving only `/api/sponsor`-shaped aggregates, so a funder's analyst can query
their cohort from their own AI; (2) action tools behind the same
propose→confirm pattern — the Zernio-shaped case from CLAUDE.md, where "post
three times this week" becomes Charlie drafting and, on WhatsApp confirmation,
posting; (3) `find_knowledge` over pgvector *if and only if* `retrieval_gaps`
earns it (§6).

---

## 5. Jev — the judgement layer, question by question

Jev (TypeSafe System One, client in `api/_lib/jev.ts`) is not a language
model: it takes a `state` and typed questions and returns calibrated answers
in ~150ms at near-zero cost. It cannot write, which is precisely why it is
trusted to judge — it cannot be talked into anything, and it cannot replace a
message with its own. Three question types:

```jsonc
// noul — one calibrated probability that a proposition holds
{ "type": "noul", "instructions": "…proposition…" }            // → { "noul": 0.0–1.0 }

// score — placement on 2–10 levels, EACH A STANDALONE SITUATION
{ "type": "score", "instructions": "…", "criteria": ["red …", "amber …", "green …"] }
                                                               // → { "score": n, "confidence": c }

// choice — pick one of up to 255 labelled options
{ "type": "choice", "instructions": "…", "criteria": { "a": "…", "b": "…" } }
                                                               // → { "choice": "a", "probabilities": {…} }
```

**The laws, all enforced in code, all with a failure story behind them:**

1. *Flag or soften, never silence.* No judgement may swallow a message. The
   single hard replacement (credential solicitation) substitutes a
   **pre-written** line — Jev never writes.
2. *Fail open, never silently.* Two engines: Jev preferred, the `safety`
   model row as backstop (same propositions, strict JSON). Both down → the
   check passes through **and writes `outcome: "unavailable"`** to
   `safety_events`; `/api/health` then says, in words, that advice is going
   out unchecked.
3. *The backstop's answer shape is verified, not assumed.* A reply with
   missing or non-boolean keys is `unavailable`, never "all clear" — the
   shipped-then-caught critical bug where `{"answers":{…}}` read as five
   passing checks.
4. *Score levels are situations, not degrees* ("worse than the last one"
   means nothing to a calibrated scorer), red is index 0, and **ties round
   down** — both engines, same direction, or two owners in the same situation
   get different maps. **One deliberate, documented exception:** `scam_score`
   rounds a tie at the warning boundary *up*, not down (`judgement.ts`) —
   because a needless warning about a real offer costs an owner a minute and
   a missed warning about a real scam costs them money, the asymmetry a
   neutral rubric like the map does not have. Any other check found rounding
   ties up is a bug; this one is not, and the reason is written next to the
   code, not just here.
5. *Thresholds are per-check and written down* (below). Raising one to make a
   noisy check quiet is a design change, not a tweak.
6. *Budget:* ~32k tokens shared per call, pre-checked (`overBudget`);
   batching is the norm (one call for five propositions, one for eight map
   areas, one per option-set).

### 5.1–5.12 Deployed checks

All twelve run today. The first seven live in `api/_lib/safety.ts`; the last
five — arbitration, scam scoring, the nudge gate, outcome attribution and the
module audit — live in `api/_lib/judgement.ts`, added after this document
first specified them below as "designed, not yet deployed." That section
heading is gone because there is nothing left under it: `test/judgement.test.ts`
is the executable version of every row from 8 to 12, the same relationship
`test/guardrails.e2e` has to rows 1–7.

| # | Check (`safety_events.check_name`) | Type & state | Threshold | On true | On unavailable |
|---|---|---|---|---|---|
| 1 | `question_gate` | 1 noul over `{question_asked, reply}` | 0.65 | Answer it as a question; re-ask; **once** — the second identical reply is accepted as the answer | Treat as answer (old behaviour) |
| 2 | `distress` | 1 noul over the raw diagnostic answers — "genuine distress, not ordinary tightness" | **0.70** (higher: the action taken is large) | Stabilising mode; no plan; free advisor; `outcome: "block"` | Proceed, on the record |
| 3 | `selection` | N nouls, one per option, over `{reply, numbered options}` | 0.60 | Picked set; **empty set is an answer** | `null` → digit fallback *only if the reply looks like a choice*; else ask again |
| 4 | `step_compliance` | 5 nouls per generated step: ungrounded price · menu without the deciding fact · risky push with no downside · **solicits credentials into this chat** (narrow: mentioning an ID or carrying the owner's own bank details for customers is the product working) · claims-they-said | 0.65 | Price → hedge appended; credentials → pre-written replacement; claims-they-said → **library wording substituted** (true by construction); others → flag | Step goes out as generated, on the record |
| 5 | `reply_compliance` | 6 nouls on live answers (adds: generic-to-anyone, legal-certainty) | 0.65 | Attribution phrases stripped; hedges appended; credentials replaced | Same |
| 6 | `strategy_compliance` | 4 nouls over the **whole strategy document** in one call | 0.65 | Same fix policy, per field | Strategy ships as written, on the record |
| 7 | `map_score` | 8 score questions (the fixed 3-level rubric per area) over `{answers, identity, customer}` | round-half-**down** | Overrides the generative call's self-graded colours; notes kept | `{}` → self-graded colours survive, flagged as not sponsor-comparable |
| 8 | `trade_arbitration` | 1 choice over confusable-trade readings (laundromat/lodge, spaza/spa, tuck shop/truck shop) — the whole diagnostic decides | fires only if confidence ≥ 0.5 **and** the winner disagrees with what was heard | Deterministic wording asks "Did you mean X rather than Y?" — Jev decides *whether* to ask; the question text is pre-written, never generated | Jev-only; unavailable → the model's own `unsure` question stands, unchanged |
| 9 | `scam_score` | 1 score over 3 standalone levels, run over the forward independent of the model that will write the reply | rounds to the warning at exactly 1.5 — **ties round UP here**, the law-4 exception | Level 2 → pre-written scam warning, hard override regardless of what the writer concluded | Proceed on the forward prompt's own (weaker) check alone, on the record |
| 10 | `nudge_gate` | 2 nouls — *would this plausibly help this week* / *does it repeat a recent nudge* | 0.65 | Either true → the send is skipped, logged as a good outcome | Send proceeds, on the record (fail open, same as every other check) |
| 11 | `outcome_attribution` | 1 noul — *is the reported improvement implausible this soon after the step* | 0.70, **and only a Jev score can withhold** — a model backstop's bare true/false is never enough on its own | Map area does not move; noted, never argued with the owner | Map moves as reported — this one has no model backstop by design |
| 12 | `module_audit` | N nouls, one per candidate plan module — *do the answers actually evidence this problem* | < 0.3 drops the module | Dropped **before** a tailoring token is spent; the owner's own stated top problem is never dropped; never drops every module down to nothing | Jev-only; unavailable → nothing dropped, plan builds from every module `pickPlaybook` chose |

**Eval judging** — the twelfth item on the original "designed, not yet deployed"
list — is built too, but it does not appear in the table above because it is
not a runtime guardrail and writes no `safety_events` row: it scores
`scripts/eval.ts`'s offline corpus of answers, not a live conversation.
`jevJudge()` asks the same "specific to this business" / "would a good local
advisor say this" questions as `score` types over five standalone levels each,
Jev preferred and a model rubric as the backstop exactly like every check
above — which is what makes two runs over the same answer agree, the thing a
free-text 1–5 from a model does not reliably do. `test/eval-judge.test.ts`
covers the rounding convention (round-half-**down**, matching `map_score`, not
`scam_score`) and the fallback.

### As built — the exact Jev calls behind rows 8–12

Kept verbatim from the original spec below, because the wording is still what
ships in `judgement.ts` today; only the heading was wrong once these were
built. Useful as a reference for the actual `criteria` text without reading
the source, and as a record that nothing was loosened between the spec and
the implementation.

**Trade arbitration** — one `choice` over trade candidates assembled from the
diagnostic, asked only when exactly one reading of a confusable pair
(`CONFUSABLES` in `judgement.ts`) appears in what the owner said:

```jsonc
{ "type": "choice",
  "instructions": "Take every diagnostic answer together — what they sell, who buys, what they charge, how they are paid, what they are trying to fix. Which reading of this business do the answers as a whole best support?",
  "criteria": { "laundromat": "washes, dries and folds clothing and linen for customers",
                "lodge": "provides overnight accommodation and rooms to guests", "other": "…" } }
```
The winning reading only produces a question when it disagrees with what was
heard at confidence ≥ 0.5; the confirmation text itself is fixed, never
generated.

**Scam scoring** on forwards — a `score`, because scamminess has real levels,
run independent of the model that will write the reply:
```jsonc
{ "type": "score", "instructions": "How does this forwarded offer or message read?",
  "criteria": [
    "A verifiable offer from an official domain with no upfront payment and no request for personal banking details.",
    "Unverifiable but not extractive: vague terms or an unofficial channel, yet nothing is asked of the reader.",
    "Classic advance-fee markers: a fee to release funds, banking details or PINs requested, guaranteed approval, or pressure to act today." ] }
```
Level 2 hardens the reply to a pre-written warning regardless of what the
generative call concluded; the forward prompt's own weaker check is now the
`unavailable` path, not the whole defence.

**Nudge gate** — two nouls before any template send: *would this plausibly
help this week given their history* and *does it repeat a recent nudge*.
Either true → skip, logged. Protects the quality rating that decides whether
the number can grow.

**Outcome attribution** — one noul on "is the reported improvement
implausible this soon after the step", withheld unless Jev itself answers (a
model backstop's bare true/false does not carry enough signal to hold back a
map move) — guards the map, and the sponsor numbers built on it, against
feel-good inflation, without ever arguing with the owner.

**Module audit** — belt-and-braces on rule 1: per chosen module, one noul
asking whether the diagnostic actually evidences the signal that selected it,
run between `pickPlaybook` and the build. A clear "no" (< 0.3) drops the
module before a token is spent tailoring it — except the owner's own stated
top problem, which is never audited away, and except when dropping everything
flagged would leave no plan at all.

---

## 6. Memory, retrieval, and when embeddings earn their keep

**Memory** is one Supabase project: `businesses` (the context, the choices,
the conversation position), `plans`+`plan_steps`+`strategy`, `business_map`
(normalised, sponsor-readable), `commitments`/`outcomes`/`decisions` (written
only from what the *owner* said — a suggestion is not a decision until they
agree), `messages` both directions (WhatsApp and the connector share one
memory), and the audit tables (`safety_events`, `retrieval_gaps`,
`freshness_reports`, `forget_log`). RLS everywhere; owner data reachable only
through the service role.

**Retrieval** is deliberately boring and free: score every row by keyword
overlap in plain code — tiered now (verbatim phrase 3 · all meaningful words
2 · most 1 · single words on word boundaries so "vat" ≠ "private"), plus
domain +2, stage +1, free-first +1 — hand the model only the shortlist, and
tell it those are the only facts it may use. Relevance (`topScore`) counts
keyword evidence *only*, so incidental bonuses can't fake a match: an honest
zero writes a `retrieval_gaps` row.

**pgvector is live, as the second pass it was always meant to be, not the
default.** `shortlist()` calls `semanticRank()` (`api/_lib/embeddings.ts`)
only when `topScore === 0` on a message longer than 8 characters — a keyword
match never pays for an embedding call, so most traffic still costs nothing to
retrieve for. `db/0010_vector_search.sql` adds the HNSW index and two
service-role-only lookup functions over the `embedding` columns that had sat
empty since the start; `retrieval_gaps.rescued` records whether meaning found
something keywords missed, which is the honest way to tell "a keyword worth
adding" apart from "a real gap in the library" — a rescued row means fix the
keywords, not that semantic search should become the default. The eval harness
gave the original evidence for building this at all: 12 of 40 synthetic
questions scored zero, most correctly (off-topic, distress), a handful real
gaps, all non-ZA.

**Freshness is rule 10 made structural:** every cost is hedged at *read time*
once `verified_on` passes 90 days — a stale price cannot be stated as fact by
any prompt, because the string handed to the model already carries the hedge.
And at *write time* (`pricestamp.ts`, round 21): every figure in a WhatsApp
or web answer that a shortlisted row carries gets one closing line — "That
figure was last checked on 15 Sep 2026." — or the confirm-at-sign-up line
when the row is stale, asks for it, or says its figure is disputed. A reply
with no figure is untouched; a "₦[amount]" slot never reaches the owner.
The weekly sweep writes the re-check worklist.

---

## 7. The model layer

Every call through OpenRouter; every model choice a row in `model_config`. A
catalogue retirement is one `UPDATE`. The one file allowed literal slugs is
`models.ts` (the last-resort chain cannot live in the table it exists to
survive), and CI enforces that exemption stays singular.

**Every role currently points at one model** (Xiaomi MiMo-V2.5,
`db/0009_mimo_and_usage.sql`), reasoning turned off, low or medium per role in
`model_config.params` — a real decision made through the table the brief asked
for, not a hardcoded slug: changing it back to several models, or to a
different one, is an `UPDATE`, not a deploy. `model_usage` logs prompt and
completion tokens (and cost, when OpenRouter reports it) on every call, which
is PRODUCT-DEFINITION section 7's "measure real cost per active owner before
quoting a price" made real rather than promised.

| Role | Runs | Sizing logic |
|---|---|---|
| `router` | every free-text message; memory updates | near-free, temperature 0, reasoning off |
| `wa_reply` / `help` | live answers, forwards, stuck-help, nudge writing, reading a forwarded photo or PDF | mid; grounded by shortlist; reasoning low |
| `plan_builder` | once per business: identity/customers, angles, context, strategy, per-module tailoring, plan changes | the one place quality outranks speed; reasoning medium |
| `safety` | the guardrail backstop | small, strict, temperature 0; never writes prose an owner sees; reasoning off |
| `voice` | transcription | MiMo hears the voice note directly (`provider: openrouter_chat`) — no separate transcription call on the happy path. If that fails, `transcribe.ts` falls back in code to `LAST_RESORT_VOICE` (`openai/whisper-1` on OpenRouter's transcription route), so a voice note is never simply dropped even if the multimodal call errors. |

A photo or PDF an owner forwards is read by whichever model is configured for
`wa_reply` — `attachments.ts` extracts what is written in it (never an
opinion, never advice) and hands that text to the same grounded, checked reply
path as typed text, kept apart from the owner's own words so nothing printed
on a stranger's flyer can be read as a command (`"forget my money"` on a
scam poster must not delete anything — checked directly against `FORGET_RE`
only ever testing the owner's own typed message).

Failure policy, uniform: truncation → same model, more room (rule 6);
congestion → *different* model immediately (waiting on a shared free queue is
documented waste); auth/credit → stop loudly. Per-owner serialisation in the
queue means retries never interleave one conversation.

---

## 8. Measurement, and the number that gates growth

Instrumentation maps one-to-one to the value ladder: onboarding completion
(minute 5), first artifact (minute 10), first setup started (week 1 —
`commitments` with `plan_step_id`), weekly active (month 1), areas moved and
90-day retention (month 3). All of it lands in `/api/sponsor` as aggregates —
no names, no numbers, no free text an owner wrote, and no gender/age split
*because Charlie doesn't collect them and won't infer them*.

The gating number is `harm_monitoring`: outcomes split by `baseline_tier`,
assigned once from the day-one map and never recomputed (a tier computed
later answers a different question and hides exactly what this exists to
find). Weakest-third improvement rate diverging 15 points below the
strongest-third's triggers the written commitment: pause and review before
the cohort grows. The endpoint says plainly when there is too little data to
mean anything — and the eval ship bar (100% on safety and cost checks, 4+/5
judged, on *real* owner questions replacing the labelled-synthetic set) gates
any prompt change on the way to that pilot.

---

## 9. Now / next / later

**Now (deployable):** everything in §1–§8 marked built — the full journey,
document, website, connector, guardrails with audit, all twelve Jev checks
(§5.1–5.12), eval judging, pgvector as a second pass, multimodal voice/photo/
PDF reading, the owner progress dashboard, the sponsor console and its scoped
MCP token, queue, nudges, freshness, cost metering, 391 tests, CI. This list
shrank a lot since this document was first written, which is the point of
writing "later" items down precisely enough to build from: most of them got
built, and this section's job now is to say which ones didn't rather than
imply everything did.

**Next (unblocks the pilot):** Meta credentials into Vercel and the webhook
handshake; templates submitted for approval (six now, `docs/META-TEMPLATES.md`
is the copy-paste set); keywords for the non-ZA gaps the eval surfaced; real
owner questions into `eval/questions.json` — the eval ship bar still runs
against synthetic questions, per `eval/README.md`'s own warning, and that
warning is the accurate one, not a formality.

**Later (earns its way in by evidence):** WhatsApp Flows for the diagnostic
once volume justifies Meta review; action tools (Zernio-shaped) behind
propose→confirm, for a plan step that currently only instructs an owner to
post on Status/Instagram/Facebook themselves. Per-segment voice confidence via
direct Groq routing needs no new code — `transcribe.ts` already switches on a
`provider` column per `model_config` row — it is a row edit away, not a build,
whenever a market's voice-note accuracy calls for it.

*The build order stays the brief's: ask the founder before anything that
spends money, registers the production number, or submits verification.
Everything else — build it.*
