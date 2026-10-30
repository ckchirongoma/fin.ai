// Charles — a household of several WhatsApp numbers.
//
// One person's money is rarely one person's: a partner pays the rent, a
// sister sends money home, a mother keeps the burial society. A household
// links two to six numbers so Charles knows the shared picture: who pays
// which bill, who supports whom, what the household is working towards. Each
// person keeps their own conversation, their own plan and their own memory.
//
// Built for the way money and power actually sit between people:
//   - Both sides agree. The person who invites sends a code; the person who
//     joins sees what is shared and taps Join; the inviter then taps Let them
//     in. Nothing is shared before both have said yes.
//   - Debts and income are private by default. What is shared: who they
//     support, the bills they pay, their cover, their stokvel or burial
//     society, their savings, their goal. A person shares their debts and
//     income only by saying so ("share my debts with my household"), and
//     can stop at any time.
//   - Anyone can leave at any time, and the others are NOT told. Someone
//     leaving a controlling relationship must never have Charles announce it.
//   - Others are named by first name, never by number. "You told me" is never
//     said about another member's line: it is "Sipho told me".
//   - Codes are six characters, single use, 48 hours, stored as a hash.
//   - "Forget my money" takes the person out of the household with everything
//     else; if they started it, the longest-standing member takes it over.
//
// Tables: households, household_members, household_invites (db/0040).

import { db, findBusinessById } from "./db.js";
import { hashSecret } from "./crypto.js";
import { householdGraph, edgeLine, type Edge, type Rel } from "./graph.js";
import { track } from "./track.js";
import type { Business } from "./types.js";
import { randomInt } from "node:crypto";

export const MAX_MEMBERS = 6;
export const INVITE_HOURS = 48;
const MAX_OPEN_INVITES = 3;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Shared with the household by default. */
const SHARED: ReadonlySet<Rel> = new Set(["supports", "pays", "covered_by", "member_of", "saves_in", "working_towards"]);
/** Shared only when the person says so. */
const PRIVATE_UNLESS: ReadonlySet<Rel> = new Set(["owes", "earns_from"]);

// ── What people type ─────────────────────────────────────────────

export const INVITE_ASK =
  /^\s*(?:(?:can\s+i\s+|i\s+want\s+to\s+|please\s+|i'?d\s+like\s+to\s+)?(?:invite|add|bring\s+in|connect)\s+(?:someone|somebody|my\s+(?:partner|husband|wife|boyfriend|girlfriend|mother|mom|mum|father|dad|sister|brother|son|daughter|family|household)|a\s+(?:family\s+member|partner|person))(?:\s+(?:to|into|on)\s+(?:my\s+|the\s+|our\s+)?(?:household|plan|charles))?|(?:start|make|create|set\s+up)\s+(?:a\s+|my\s+|our\s+)?household|share\s+(?:my\s+|our\s+)?(?:plan|money)\s+with\s+(?:my\s+)?(?:partner|husband|wife|family|household|someone))[\s.!?]*$/i;
export const JOIN_ASK = /^\s*(?:hi\s+charles[,!.\s]*)?(?:please\s+)?join\s+(?:the\s+|my\s+|our\s+)?(?:household\s+)?([A-Za-z2-9]{6})\b[\s.!?]*$/i;
export const LEAVE_ASK = /^\s*(?:i\s+want\s+to\s+|please\s+)?(?:leave|exit|quit)\s+(?:the\s+|my\s+|our\s+|this\s+)?household[\s.!?]*$/i;
export const WHO_ASK = /^\s*(?:who(?:'s|\s+is)\s+in\s+(?:my|the|our)\s+household|(?:show\s+me\s+)?(?:my|our)\s+household(?:\s+members)?)[\s?!.]*$/i;
export const SHARE_DEBTS_ASK = /^\s*(?:please\s+)?share\s+my\s+(?:debts?|income|money|debts?\s+and\s+income)\s+with\s+(?:my\s+|the\s+|our\s+)?(?:household|family|partner)[\s.!?]*$/i;
export const UNSHARE_DEBTS_ASK = /^\s*(?:please\s+)?(?:stop\s+sharing|don'?t\s+share|unshare)\s+my\s+(?:debts?|income|money|debts?\s+and\s+income)(?:\s+with\s+(?:my\s+|the\s+|our\s+)?(?:household|family|partner))?[\s.!?]*$/i;

// ── Rows ─────────────────────────────────────────────────────────

export interface MemberRow {
  id: string;
  household_id: string;
  business_id: string;
  role: "owner" | "member";
  status: "pending_owner" | "active";
  share_debts: boolean;
  joined_at: string | null;
  created_at: string;
}

async function memberRow(businessId: string): Promise<MemberRow | null> {
  const { data } = await db().from("household_members").select("*").eq("business_id", businessId).maybeSingle();
  return (data as MemberRow | null) ?? null;
}

async function activeMembers(householdId: string): Promise<MemberRow[]> {
  const { data } = await db().from("household_members").select("*").eq("household_id", householdId).eq("status", "active");
  return ((data as MemberRow[]) ?? []).sort((a, b) => String(a.joined_at ?? a.created_at).localeCompare(String(b.joined_at ?? b.created_at)));
}

/** A first name, never a number. */
export const firstName = (biz: Pick<Business, "identity" | "context" | "answers"> | null): string | null => {
  const n = (biz?.identity?.name ?? biz?.context?.name ?? biz?.answers?.person?.split(/[,.]/)[0] ?? "").trim().split(/\s+/)[0] ?? "";
  return n && n.toLowerCase() !== "you" && !/\d/.test(n) ? n.slice(0, 24) : null;
};

const mintCode = (): string => Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

// ── Inviting ─────────────────────────────────────────────────────

export type InviteResult = { code: string } | { refused: "full" | "too_many_invites" | "pending" | "failed" };

/** Makes the household if there is none, and a fresh single-use code for it. */
export async function createInvite(biz: Business): Promise<InviteResult> {
  try {
    let me = await memberRow(biz.id);
    if (me?.status === "pending_owner") return { refused: "pending" };
    if (!me) {
      const { data: h, error } = await db().from("households").insert({ created_by: biz.id }).select("id").single();
      if (error || !h) return { refused: "failed" };
      const { data: m, error: mErr } = await db()
        .from("household_members")
        .insert({ household_id: (h as { id: string }).id, business_id: biz.id, role: "owner", status: "active", share_debts: false, joined_at: new Date().toISOString() })
        .select("*")
        .single();
      if (mErr || !m) return { refused: "failed" };
      me = m as MemberRow;
      track("household_created", { category: "funnel" });
    }
    if ((await activeMembers(me.household_id)).length >= MAX_MEMBERS) return { refused: "full" };
    const { data: open } = await db().from("household_invites").select("id, expires_at, used_at").eq("household_id", me.household_id).is("used_at", null);
    if (((open as { expires_at: string }[]) ?? []).filter((i) => Date.parse(i.expires_at) > Date.now()).length >= MAX_OPEN_INVITES) return { refused: "too_many_invites" };
    const code = mintCode();
    const { error } = await db().from("household_invites").insert({
      household_id: me.household_id,
      created_by: biz.id,
      code_hash: hashSecret(code),
      expires_at: new Date(Date.now() + INVITE_HOURS * 36e5).toISOString(),
    });
    if (error) return { refused: "failed" };
    track("household_invite_created", { category: "funnel" });
    return { code };
  } catch (err) {
    console.warn("createInvite failed", err);
    return { refused: "failed" };
  }
}

// ── Joining ──────────────────────────────────────────────────────

export type JoinCheck = { householdId: string; inviter: string | null; members: number } | { refused: "unknown" | "expired" | "used" | "full" | "already_in" | "own" };

/** What a code leads to, without using it. */
export async function checkCode(biz: Business, code: string): Promise<JoinCheck> {
  const { data } = await db().from("household_invites").select("*").eq("code_hash", hashSecret(code.toUpperCase())).maybeSingle();
  const inv = data as { household_id: string; created_by: string; expires_at: string; used_at: string | null } | null;
  if (!inv) return { refused: "unknown" };
  if (inv.used_at) return { refused: "used" };
  if (Date.parse(inv.expires_at) < Date.now()) return { refused: "expired" };
  if (inv.created_by === biz.id) return { refused: "own" };
  const mine = await memberRow(biz.id);
  if (mine) return { refused: mine.household_id === inv.household_id ? "already_in" : "already_in" };
  const members = await activeMembers(inv.household_id);
  if (members.length >= MAX_MEMBERS) return { refused: "full" };
  const inviter = await findBusinessById(inv.created_by);
  return { householdId: inv.household_id, inviter: firstName(inviter), members: members.length };
}

/**
 * The joiner said yes: the code is used, and the inviter is asked. Returns
 * the inviter's business and the pending member row, or why not.
 */
export async function requestToJoin(biz: Business, code: string): Promise<{ owner: Business; member: MemberRow } | { refused: string }> {
  const check = await checkCode(biz, code);
  if ("refused" in check) return check;
  const { data: invData } = await db().from("household_invites").select("*").eq("code_hash", hashSecret(code.toUpperCase())).maybeSingle();
  const inv = invData as { id: string; created_by: string } | null;
  if (!inv) return { refused: "unknown" };
  const { error: useErr } = await db().from("household_invites").update({ used_at: new Date().toISOString(), used_by: biz.id }).eq("id", inv.id).is("used_at", null);
  if (useErr) return { refused: "failed" };
  const { data: m, error } = await db()
    .from("household_members")
    .insert({ household_id: check.householdId, business_id: biz.id, role: "member", status: "pending_owner", share_debts: false })
    .select("*")
    .single();
  if (error || !m) return { refused: "failed" };
  const owner = await findBusinessById(inv.created_by);
  if (!owner) return { refused: "unknown" };
  track("household_join_requested", { category: "funnel" });
  return { owner, member: m as MemberRow };
}

/** The inviter's answer. Only the person who made the code may answer for it. */
export async function decideJoin(owner: Business, memberId: string, yes: boolean): Promise<{ joiner: Business | null; householdId: string } | null> {
  const { data } = await db().from("household_members").select("*").eq("id", memberId).maybeSingle();
  const m = data as MemberRow | null;
  if (!m || m.status !== "pending_owner") return null;
  const mine = await memberRow(owner.id);
  if (!mine || mine.household_id !== m.household_id || mine.status !== "active") return null;
  const joiner = await findBusinessById(m.business_id);
  if (yes) {
    if ((await activeMembers(m.household_id)).length >= MAX_MEMBERS) return null;
    await db().from("household_members").update({ status: "active", joined_at: new Date().toISOString() }).eq("id", m.id);
    track("household_joined", { category: "funnel" });
  } else {
    await db().from("household_members").delete().eq("id", m.id);
    track("household_join_declined", { category: "funnel" });
  }
  return { joiner, householdId: m.household_id };
}

// ── Leaving, quietly ─────────────────────────────────────────────

/**
 * Out of the household. Nobody else is told: Charles never announces that
 * someone left. If they started it, the longest-standing member takes it
 * over; if nobody is left, the household goes.
 */
export async function leaveHousehold(businessId: string): Promise<boolean> {
  const me = await memberRow(businessId);
  if (!me) return false;
  await db().from("household_members").delete().eq("id", me.id);
  await db().from("household_invites").delete().eq("created_by", businessId).is("used_at", null);
  const rest = await activeMembers(me.household_id);
  if (!rest.length) {
    await db().from("household_members").delete().eq("household_id", me.household_id);
    await db().from("household_invites").delete().eq("household_id", me.household_id);
    await db().from("households").delete().eq("id", me.household_id);
  } else if (me.role === "owner") {
    await db().from("household_members").update({ role: "owner" }).eq("id", rest[0]!.id);
  }
  track("household_left", { category: "funnel", props: { remaining: rest.length } });
  return true;
}

export async function setShareDebts(businessId: string, share: boolean): Promise<boolean> {
  const me = await memberRow(businessId);
  if (!me || me.status !== "active") return false;
  await db().from("household_members").update({ share_debts: share }).eq("id", me.id);
  track("household_sharing_changed", { category: "behaviour", props: { share_debts: share } });
  return true;
}

// ── What the others share ────────────────────────────────────────

export interface HouseholdView {
  members: { name: string | null; you: boolean; role: "owner" | "member"; sharesDebts: boolean }[];
  /** Other members' shared lines, each with who. */
  shared: { who: string; edge: Edge }[];
  /** Whether this person shares their own debts and income. */
  sharesDebts: boolean;
}

/** Null when the person is in no household (or only waiting to be let in). */
export async function householdView(biz: Business): Promise<HouseholdView | null> {
  try {
    const me = await memberRow(biz.id);
    if (!me || me.status !== "active") return null;
    const members = await activeMembers(me.household_id);
    if (members.length < 2) return { members: [{ name: firstName(biz), you: true, role: me.role, sharesDebts: me.share_debts }], shared: [], sharesDebts: me.share_debts };
    const others = members.filter((m) => m.business_id !== biz.id);
    const rows = await Promise.all(others.map((m) => findBusinessById(m.business_id)));
    const graphs = await Promise.all(rows.map((b) => (b ? householdGraph(b) : Promise.resolve(null))));
    const shared: HouseholdView["shared"] = [];
    others.forEach((m, i) => {
      const who = firstName(rows[i] ?? null) ?? "Someone in the household";
      for (const e of graphs[i]?.edges ?? []) {
        if (SHARED.has(e.rel) || (m.share_debts && PRIVATE_UNLESS.has(e.rel))) shared.push({ who, edge: e });
      }
    });
    return {
      members: members.map((m) => ({ name: m.business_id === biz.id ? firstName(biz) : firstName(rows[others.indexOf(m)] ?? null), you: m.business_id === biz.id, role: m.role, sharesDebts: m.share_debts })),
      shared,
      sharesDebts: me.share_debts,
    };
  } catch (err) {
    console.warn("householdView: unreadable", err);
    return null;
  }
}

/**
 * The household's lines as a prompt carries them: each says WHO, and where
 * it came from in their terms ("Sipho said", "Sipho's statement"). Capped.
 */
export function householdSheet(view: HouseholdView | null, maxLines = 12, maxChars = 1200): string {
  if (!view?.shared.length) return "";
  const lines = view.shared
    .sort((a, b) => Number(Boolean(a.edge.closed)) - Number(Boolean(b.edge.closed)) || (b.edge.amount ?? 0) - (a.edge.amount ?? 0))
    .slice(0, maxLines)
    .map(({ who, edge }) =>
      `- ${who}: ${edgeLine(edge)
        .replace(/\(([^)]*)\)$/, (_, src: string) => `(${src.replace(/they said/g, `${who} said`).replace(/setup answer/g, `${who}'s setup answer`).replace(/their statement/g, `${who}'s statement`).replace(/they chose it/g, `${who} chose it`).replace(/their AI said/g, `${who}'s AI said`)})`)}`,
    );
  let used = 0;
  return lines.filter((l) => (used += l.length + 1) <= maxChars).join("\n");
}

// ── What Charles says ────────────────────────────────────────────

export const SHARED_SUMMARY = "who you support, the bills you pay, your cover, your stokvel or burial society, your savings and your goal";

export function inviteText(code: string): { toYou: string; toForward: string } {
  return {
    toYou: `Here's a household code: ${code}. It works once, for the next ${INVITE_HOURS} hours. Forward the next message to the person you want to add. Once they join and you let them in, you'll each see ${SHARED_SUMMARY}. Debts and income stay private unless each of you says "share my debts with my household".`,
    toForward: `Join my household on Charles, the WhatsApp money coach. Message Charles and send: join ${code}`,
  };
}

export const REFUSED_TEXT: Record<string, string> = {
  unknown: "I don't know that code. Check it with the person who sent it, or ask them to make a new one.",
  expired: `That code has expired: codes work for ${INVITE_HOURS} hours. Ask for a new one.`,
  used: "That code has already been used. Ask for a new one.",
  full: `That household is full: it already has ${MAX_MEMBERS} people.`,
  already_in: "You're already in a household. To join a different one, send \"leave household\" first.",
  own: "That's your own code. Forward it to the person you want to add.",
  pending: "You're waiting to be let into a household already. Once that's settled you can invite others.",
  too_many_invites: "There are already three codes waiting to be used. Let one be used or expire first.",
  failed: "I couldn't do that just now. Try again in a minute.",
};
