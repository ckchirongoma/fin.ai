/*
# Charlie — an index for "has this owner message already been recorded?" (apply AFTER 0017)

Apply in Supabase → SQL Editor → New query → paste → Run. Safe to run more
than once (IF NOT EXISTS). Changes no data.

Why: round 6 made recording an owner's message idempotent. A retried or
reclaimed inbound job re-runs the turn, and used to write the same message
into the conversation twice (api/_lib/jobctx.ts). The check is
`select … from messages where wa_message_id = $1 and direction = 'in'`,
which runs on every inbound message. Without this, messages.wa_message_id
(db/0005) has no index, and that check scans the whole table.
*/

CREATE INDEX IF NOT EXISTS messages_in_wa_message_id_idx
  ON public.messages (wa_message_id)
  WHERE direction = 'in';
