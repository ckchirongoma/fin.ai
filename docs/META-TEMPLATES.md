# WhatsApp message templates — copy and paste

Where: **business.facebook.com → WhatsApp Manager → Message templates → Create template**, on the sender number the bank or the founder registers for Charles.

Rules that matter:
- **Name, category and language must match exactly** what is below. The code looks templates up by name (`db/0035_charles_templates.sql` holds the same six).
- Keep `{{1}}`, `{{2}}` exactly as written. They are positional and cannot be changed after creation.
- Meta asks for a **sample value** for each variable. Paste the samples given. They are invented; no real person's words are in them.
- Approval usually takes minutes; sometimes a day. A rejected template can be edited and resubmitted.
- Nothing is sent from a template until you mark it approved in the database (last section).
- Templates are the only way to reach someone more than 24 hours after their last message. Everything else Charles sends is a free-form reply inside that window.

---

## 1. charles_monday_focus
- **Category:** Utility
- **Language:** English
- **Body:**
```
This week, {{1}}: {{2}}. Reply NEXT when you want the step.
```
- **Samples:** {{1}} = `Lerato` · {{2}} = `pay the mashonisa on Friday, the day the money lands`

## 2. charles_commitment_check
- **Category:** Utility
- **Language:** English
- **Body:**
```
Did you manage to {{1}}? Tap Done, or Help me if you got stuck.
```
- **Buttons → Quick reply**, add two: `Done` and `Help me`
- **Sample:** {{1}} = `write down everyone you owe and what each one costs`

## 3. charles_month_end_money
- **Category:** Utility
- **Language:** English
- **Body:**
```
Payday is close, {{1}}. Want the three pots for this month before the money lands? Reply YES.
```
- **Sample:** {{1}} = `Lerato`

## 4. charles_monthly_checkin
- **Category:** Utility
- **Language:** English
- **Body:**
```
Quick one, {{1}}: did the month fit the money this time — yes, nearly, or no?
```
- **Sample:** {{1}} = `Lerato`

## 5. charles_reengage
- **Category:** Utility
- **Language:** English
- **Body:**
```
Still thinking about {{1}}? Reply and we pick up exactly where we left off.
```
- **Sample:** {{1}} = `the clothing account`

## 6. charles_login_code
- **Category:** Authentication
- **Language:** English
- **Body:**
```
Your Charles code is {{1}}. It works for ten minutes. If you did not ask for it, ignore this message.
```
- Meta's authentication template form may ask you to pick "copy code" and an expiry; choose 10 minutes. The body may be fixed by Meta's own authentication wording; use theirs if it refuses this one.
- **Sample:** {{1}} = `482913`

---

## After Meta approves

Supabase → SQL Editor:

```sql
update public.wa_templates set status = 'approved' where meta_name = 'charles_monday_focus';
```

One line per approved template. The nudge sweep sends only from `approved`
rows, and never more than one follow-up a week to any person (`api/_lib/nudges.ts`).
