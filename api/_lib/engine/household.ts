// Charles — the household conversations (../household.ts holds the rules).

import { CONSENT_LINE } from "../diagnostic.js";
import { checkCode, createInvite, decideJoin, firstName, householdView, inviteText, JOIN_ASK, leaveHousehold, LEAVE_ASK, REFUSED_TEXT, requestToJoin, setShareDebts, SHARE_DEBTS_ASK, SHARED_SUMMARY, UNSHARE_DEBTS_ASK, INVITE_ASK, WHO_ASK } from "../household.js";
import { findBusinessById } from "../db.js";
import { track } from "../track.js";
import { sendButtons, sendText } from "../wa.js";
import type { Business } from "../types.js";

/** "join K7P9QX", as a person types it, from a new number or a known one. */
export async function offerJoin(biz: Business, said: string, isNew: boolean): Promise<boolean> {
  const m = JOIN_ASK.exec(said);
  if (!m) return false;
  const code = m[1]!.toUpperCase();
  const check = await checkCode(biz, code);
  if ("refused" in check) {
    await sendText(biz.wa_id, REFUSED_TEXT[check.refused] ?? REFUSED_TEXT.unknown!, biz.id);
    track("household_join_refused", { category: "unmet_request", severity: "info", props: { reason: check.refused } });
    return !isNew;
  }
  await sendButtons(
    biz.wa_id,
    `${check.inviter ?? "Someone"} invited you to share a household on Charles.\n\nIf you join, you'll each see ${SHARED_SUMMARY}. Your own messages stay yours, and debts and income stay private unless you choose to share them. You can leave any time by sending "leave household", and nobody is told.${isNew ? `\n\n${CONSENT_LINE}` : ""}`,
    [
      { id: `a.hh.join:${code}`, title: "Join" },
      { id: "a.hh.skip", title: "No thanks" },
    ],
    biz.id,
  );
  track("household_join_offered", { category: "funnel", props: { new_number: isNew } });
  return !isNew;
}

/** The two-sided consent: the joiner's tap, then the inviter's. */
export async function householdTap(biz: Business, actionId: string): Promise<boolean> {
  const join = /^a\.hh\.join:([A-Z2-9]{6})$/.exec(actionId);
  if (join) {
    const r = await requestToJoin(biz, join[1]!);
    if ("refused" in r) {
      await sendText(biz.wa_id, REFUSED_TEXT[r.refused] ?? REFUSED_TEXT.failed!, biz.id);
      return true;
    }
    const inviter = firstName(r.owner);
    await sendText(biz.wa_id, `Done: I've asked ${inviter ?? "them"} to let you in. You'll hear here as soon as they do.`, biz.id);
    await sendButtons(
      r.owner.wa_id,
      `${firstName(biz) ?? "Someone"} used your household code and wants to join your household. Let them in? Once you do, you'll each see ${SHARED_SUMMARY}.`,
      [
        { id: `a.hh.ok:${r.member.id}`, title: "Let them in" },
        { id: `a.hh.no:${r.member.id}`, title: "No" },
      ],
      r.owner.id,
    );
    return true;
  }
  if (actionId === "a.hh.skip") {
    await sendText(biz.wa_id, "No problem: nothing is shared. You can still use Charles on your own.", biz.id);
    return true;
  }
  const decide = /^a\.hh\.(ok|no):(.+)$/.exec(actionId);
  if (decide) {
    const yes = decide[1] === "ok";
    const r = await decideJoin(biz, decide[2]!, yes);
    if (!r) {
      await sendText(biz.wa_id, "That request has already been settled.", biz.id);
      return true;
    }
    const joinerName = firstName(r.joiner);
    if (yes) {
      await sendText(biz.wa_id, `Done: ${joinerName ?? "they're"} ${joinerName ? "is " : ""}in your household.`, biz.id);
      if (r.joiner) await sendText(r.joiner.wa_id, `You're in ${firstName(biz) ?? "the"}${firstName(biz) ? "'s" : ""} household. Send "who is in my household" any time, and "leave household" to leave.`, r.joiner.id);
    } else {
      await sendText(biz.wa_id, "Okay, they're not added.", biz.id);
      if (r.joiner) await sendText(r.joiner.wa_id, "You weren't added to that household this time. You can still use Charles on your own.", r.joiner.id);
    }
    return true;
  }
  return false;
}

/** The typed household commands, at any stage. True when one was handled. */
export async function householdCommand(biz: Business, said: string): Promise<boolean> {
  if (INVITE_ASK.test(said)) {
    const r = await createInvite(biz);
    if ("refused" in r) {
      await sendText(biz.wa_id, REFUSED_TEXT[r.refused] ?? REFUSED_TEXT.failed!, biz.id);
      return true;
    }
    const t = inviteText(r.code);
    await sendText(biz.wa_id, t.toYou, biz.id);
    await sendText(biz.wa_id, t.toForward, biz.id);
    return true;
  }
  if (LEAVE_ASK.test(said)) {
    const left = await leaveHousehold(biz.id);
    await sendText(biz.wa_id, left ? "You've left the household. The others no longer see anything from you, and nobody is sent a message about it." : "You're not in a household.", biz.id);
    return true;
  }
  if (WHO_ASK.test(said)) {
    const v = await householdView(biz);
    if (!v) {
      await sendText(biz.wa_id, `You're not in a household yet. To start one, send "invite someone to my household".`, biz.id);
      return true;
    }
    const names = v.members.map((m) => (m.you ? "you" : (m.name ?? "someone")) + (m.sharesDebts ? " (shares debts and income)" : "")).join(", ");
    await sendText(biz.wa_id, `In your household: ${names}. Everyone sees ${SHARED_SUMMARY}. ${v.sharesDebts ? "You share your debts and income too; send \"stop sharing my debts\" to stop." : "Your debts and income stay private; send \"share my debts with my household\" to share them."}`, biz.id);
    return true;
  }
  if (SHARE_DEBTS_ASK.test(said) || UNSHARE_DEBTS_ASK.test(said)) {
    const share = SHARE_DEBTS_ASK.test(said);
    const ok = await setShareDebts(biz.id, share);
    await sendText(biz.wa_id, !ok ? "You're not in a household." : share ? "Done: your household now sees your debts and income too. Send \"stop sharing my debts\" to stop." : "Done: your debts and income are private again.", biz.id);
    return true;
  }
  return false;
}

export { findBusinessById };
