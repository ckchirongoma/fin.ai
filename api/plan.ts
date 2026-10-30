// Charles — reading your plan on the web.
//
// Not a second product: the same plan, from the same row, rendered by the same
// planDocHTML() that produces the PDF. If the two ever disagree, one of them is
// lying to the person.
//
// Identity is the WhatsApp number, because that is the identity the person
// already has with us and the only one they will remember. The one-time code
// arrives on WhatsApp, so only somebody holding that phone can sign in. Codes
// and session tokens are stored as peppered hashes: a leaked database row is
// not a working credential.

import { hashSecret, mintNumericCode, mintToken, safeEqualHex } from "./_lib/crypto.js";
import { db, findBusiness, findBusinessById, LOGIN_CODE_KIND, planFor, strategyRepairPending, toolsFor } from "./_lib/db.js";
import { sendTemplate, sendText, withinServiceWindow, type SendResult } from "./_lib/wa.js";
import { hasLiveConnector } from "./_lib/connector.js";
import { storedPlanHTML } from "./_lib/engine/planpdf.js";
import { env, isInternalNumber } from "./_lib/env.js";
import { publicNumberSource, resolvePublicWhatsAppNumber } from "./_lib/wanumber.js";
import { DOMAINS, DOMAIN_LABELS, type Business } from "./_lib/types.js";
import { greenMeans } from "./_lib/moneymap.js";
import { setTrackContext, since, track, trackFailure, trackUnmet, tracked } from "./_lib/track.js";

const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 864e5;
const MAX_CODE_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

/** Digits only, no plus. Exactly how Meta reports a sender. */
const LOCAL_EXAMPLES: { country: string; test: RegExp; example: string }[] = [
  { country: "South Africa", test: /^0[678]\d{8}$/, example: "080 993 0000 becomes 27809930000" },
];

/**
 * What to tell a person who typed their number the local way: an example for
 * the market, never their own number back (replies reach events). Kept in
 * step with public/plan.html and ask.html.
 */
export function wrongFormatMessage(raw: string): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  const fits = LOCAL_EXAMPLES.filter((e) => e.test.test(digits));
  const shown = fits.length ? fits : LOCAL_EXAMPLES;
  return `Start with your country code and leave out the first 0 and the plus. ${shown.map((e) => `In ${e.country}, ${e.example}.`).join(" ")}`;
}

/**
 * "082 123 4567", "(082) 123 4567", "082-123-4567": one leading 0 once the
 * spacing and punctuation people type are ignored, so no country code.
 * "0027…" is the international form, not local, and "+27…" has no 0 at all.
 */
export function typedLocally(raw: string): boolean {
  return /^0(?!0)/.test(String(raw ?? "").replace(/[\s().\-]/g, ""));
}

export function normaliseWaId(raw: string): string {
  const digits = (raw || "").replace(/\D/g, "").replace(/^0+/, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : "";
}

/**
 * Tracking (track.ts): every event for the rest of this request carries the
 * owner, their stage and country, and whether the number is one of ours —
 * never the number itself. tracked() only knows the channel.
 */
function attribute(biz: Business): void {
  setTrackContext({ businessId: biz.id, stage: biz.stage, country: biz.country, internal: isInternalNumber(biz.wa_id) });
}

/**
 * An error, safe for trackFailure: a database error becomes its code and
 * message, never `details`. supabase-js hands its errors back as plain
 * objects, which errorText prints whole, and Postgres puts the failing row in
 * `details` — a phone number, a code hash, a person's question. A real Error
 * (only its message is ever printed) and a string pass through.
 */
export function dbError(err: unknown): unknown {
  if (err instanceof Error || typeof err === "string") return err;
  const e = (err && typeof err === "object" ? err : {}) as { code?: unknown; message?: unknown };
  return `${e.code ? `${String(e.code)}: ` : ""}${e.message !== undefined ? String(e.message) : "database error"}`.slice(0, 300);
}

/** The code reached WhatsApp, or it did not and the person was told it is on its way. */
function codeSent(via: "text" | "template", sent: SendResult | undefined, started: number): void {
  if (sent?.ok) {
    // skipped: WhatsApp is not configured here, so nothing actually went.
    track("web_signin_code_sent", { category: "funnel", ms: since(started), props: { via, ...(sent.skipped ? { skipped: true } : {}) } });
    return;
  }
  // wa_send_failed (wa.ts) is the immediate alert for the refusal itself;
  // this says what it cost: a person waiting for a code that is not coming.
  trackFailure("web_signin_failed", sent?.error ?? "WhatsApp did not take the code", {
    alert: "digest",
    props: { reason: "code_not_sent", via, meta_error: sent?.code ?? null, window_closed: Boolean(sent?.windowClosed) },
    fingerprint: `web_signin_failed:code_not_sent:${sent?.code ?? 0}`,
    summary: `Sign-in: a person was told a code is on its way and WhatsApp did not take it (${via})`,
  });
}

// ── Step one: ask for a code ─────────────────────────────────────

async function requestCode(waId: string): Promise<Response> {
  // Always answer the same way, whether or not this number is known. Otherwise
  // this endpoint becomes a way to test which numbers have a Charles account.
  // The "no code?" line is the same for every number, so it tells a stranger
  // nothing. It is there because a code can only be sent as plain text within
  // 24 hours of the person's last WhatsApp message (Meta's rule); outside that,
  // only an approved login template can carry it, and until one is approved a
  // quiet owner got "on its way" and then nothing (founder, 2026-09-24).
  const generic = {
    ok: true,
    message: "If that number has a plan with Charles, a code is on its way to it on WhatsApp. No code after a minute? Send \"hi\" to Charles on WhatsApp, then ask for a new code here.",
  };

  let lookupFailed = false;
  const biz = await findBusiness(waId).catch((err) => {
    // Swallowed on purpose (the answer must not differ), but a person with a
    // plan gets no code — a failure, not a stranger.
    lookupFailed = true;
    trackFailure("web_signin_failed", dbError(err), { props: { reason: "lookup_failed", step: "request_code" }, fingerprint: "web_signin_failed:lookup_failed", summary: "Sign-in: a code request could not look the number up, so no code was sent" });
    return null;
  });
  if (!biz) {
    track("web_signin_requested", { category: "funnel", props: { known: lookupFailed ? null : false } });
    // A number with no business behind it — often a person whose WhatsApp is
    // another number. They are told a code may be coming; none will.
    if (!lookupFailed) trackUnmet("web_signin_failed", { severity: "info", props: { reason: "unknown_number", reply: generic.message }, fingerprint: "web_signin_failed:unknown_number" });
    return json(generic);
  }
  attribute(biz);

  const { data: existing } = await db().from("plan_access_codes").select("created_at").eq("wa_id", waId).maybeSingle();
  const last = (existing as { created_at: string } | null)?.created_at;
  if (last && Date.now() - new Date(last).getTime() < RESEND_COOLDOWN_MS) {
    // Asked again inside the minute: nothing new is sent; the code already sent still works.
    track("web_signin_requested", { category: "funnel", props: { known: true, throttled: true, secs_since_last: Math.round((Date.now() - new Date(last).getTime()) / 1000) } });
    return json(generic);
  }
  track("web_signin_requested", { category: "funnel", props: { known: true, throttled: false } });

  const code = mintNumericCode(6);
  const { error: notStored } = await db().from("plan_access_codes").upsert(
    {
      wa_id: waId,
      code_hash: hashSecret(code),
      expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      attempts: 0,
      created_at: new Date().toISOString(),
    },
    { onConflict: "wa_id" },
  );
  // Sent but never stored, a code can never be verified: "Ask for a new code".
  if (notStored) trackFailure("web_signin_failed", dbError(notStored), { props: { reason: "code_not_stored" }, fingerprint: "web_signin_failed:code_not_stored", summary: "Sign-in: a code could not be stored, so the one sent will not work" });

  // Founder, 2026-09-24: the message is the code and nothing else, so the
  // phone offers it for copying or autofill without the person picking it out
  // of a sentence. Ten minutes and "ignore it if you didn't ask" are on the
  // sign-in page, where the person is looking when it arrives.
  // Logged under its own kind, never as an ordinary "text" turn: the
  // conversation log is memory for every prompt and for the person's own AI,
  // and a live code has no business in either (live, 2026-09-25 — see
  // recentMessages in db.ts). The row itself is kept, exactly as the
  // template path keeps its redacted one, so the live verifier can still
  // read a code back by kind and sign in with a synthetic number.
  const text = code;
  const sending = Date.now();
  if (withinServiceWindow(biz.last_inbound_at)) {
    const sent = await sendText(waId, text, biz.id, { kind: LOGIN_CODE_KIND });
    codeSent("text", sent, sending);
  } else {
    const { data } = await db().from("wa_templates").select("meta_name, language, status").eq("id", "login_code").maybeSingle();
    const t = data as { meta_name: string | null; language: string; status: string } | null;
    if (t?.meta_name && t.status === "approved") {
      const sent = await sendTemplate(waId, t.meta_name, t.language, [code], biz.id, { otp: true });
      codeSent("template", sent, sending);
    } else {
      console.log("plan login: outside the 24h window and the login_code template is not approved yet");
      trackFailure("web_signin_failed", "outside the 24-hour window and the login_code template is not approved", {
        props: { reason: "no_login_template", template_status: t?.status ?? "missing" },
        fingerprint: "web_signin_failed:no_login_template",
        summary: "Sign-in: a person quiet for 24 hours was told a code is on its way and none was sent — the login_code template is not approved",
      });
    }
  }
  return json(generic);
}

// ── Step two: prove you got it ───────────────────────────────────

async function verifyCode(waId: string, code: string): Promise<Response> {
  const { data, error: unread } = await db().from("plan_access_codes").select("*").eq("wa_id", waId).maybeSingle();
  const row = data as { code_hash: string; expires_at: string; attempts: number } | null;
  if (!row) {
    // A failed read looks exactly like no code: a person holding a good code
    // is told to ask for a new one. That is a failure, not a stale code.
    if (unread) trackFailure("web_signin_failed", dbError(unread), { props: { reason: "lookup_failed", step: "verify" }, fingerprint: "web_signin_failed:lookup_failed", summary: "Sign-in: a code could not be checked (the read failed), so the person was told to ask for a new one" });
    else trackUnmet("web_signin_failed", { severity: "info", props: { reason: "no_code", reply: "Ask for a new code." }, fingerprint: "web_signin_failed:no_code" });
    return json({ ok: false, message: "Ask for a new code." }, 401);
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db().from("plan_access_codes").delete().eq("wa_id", waId);
    trackUnmet("web_signin_failed", { severity: "info", props: { reason: "expired", mins_late: Math.round((Date.now() - new Date(row.expires_at).getTime()) / 60_000) }, fingerprint: "web_signin_failed:expired" });
    return json({ ok: false, message: "That code has expired. Ask for a new one." }, 401);
  }
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    await db().from("plan_access_codes").delete().eq("wa_id", waId);
    // Still trying after the lockout: security, grouped with the lockout itself.
    track("web_signin_failed", { category: "security", severity: "warn", props: { reason: "too_many_tries", attempts: row.attempts }, fingerprint: "web_signin_failed:locked", summary: "Sign-in: a code was tried again after five wrong guesses" });
    return json({ ok: false, message: "Too many tries. Ask for a new code." }, 429);
  }

  if (!safeEqualHex(hashSecret((code || "").trim()), row.code_hash)) {
    const attempt = row.attempts + 1;
    const { error: uncounted } = await db().from("plan_access_codes").update({ attempts: row.attempts + 1 }).eq("wa_id", waId);
    // An uncounted wrong guess is the five-try limit not holding.
    if (uncounted) trackFailure("web_signin_failed", dbError(uncounted), { props: { reason: "attempt_not_counted" }, fingerprint: "web_signin_failed:attempt_not_counted", summary: "Sign-in: a wrong code was not counted, so the five-try limit is not holding" });
    // One wrong code is a typo; the fifth locks the code, and repeated wrong
    // codes against one number are somebody guessing.
    if (attempt >= MAX_CODE_ATTEMPTS) {
      track("web_signin_failed", { category: "security", severity: "warn", props: { reason: "wrong_code", attempt, locked: true }, fingerprint: "web_signin_failed:locked", summary: "Sign-in: five wrong codes for one number; the code is locked" });
    } else {
      trackUnmet("web_signin_failed", { severity: "info", props: { reason: "wrong_code", attempt, reply: "That code isn't right." }, fingerprint: "web_signin_failed:wrong_code" });
    }
    return json({ ok: false, message: "That code isn't right." }, 401);
  }

  const biz = await findBusiness(waId);
  if (!biz) {
    // The code was right, but the business went ("forget my business") in between.
    trackUnmet("web_signin_failed", { severity: "info", props: { reason: "no_business", reply: "Ask for a new code." }, fingerprint: "web_signin_failed:no_business" });
    return json({ ok: false, message: "Ask for a new code." }, 401);
  }
  attribute(biz);

  const { error: notCleared } = await db().from("plan_access_codes").delete().eq("wa_id", waId);
  // Left behind, a used code still signs in for the rest of its ten minutes.
  if (notCleared) console.error("plan login: a used code could not be cleared", dbError(notCleared));
  const token = mintToken(32);
  const { error: noSession } = await db().from("plan_sessions").insert({
    token_hash: hashSecret(token),
    business_id: biz.id,
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });
  // The cookie below still goes out, for a session that does not exist: the
  // owner is sent to /plan and asked to sign in again.
  if (noSession) trackFailure("web_signin_failed", dbError(noSession), { props: { reason: "session_not_stored" }, fingerprint: "web_signin_failed:session_not_stored", summary: "Sign-in: the code was right but the session could not be stored, so the person is asked to sign in again" });
  // ms: from the code being issued to the person typing it in.
  else track("web_signin_ok", { category: "funnel", ms: Date.now() - (new Date(row.expires_at).getTime() - CODE_TTL_MS), props: { attempt: row.attempts + 1, has_plan: Boolean(biz.current_plan_id) } });

  return json(
    { ok: true, redirect: "/plan" },
    200,
    {
      "Set-Cookie": [
        `charles_session=${token}`,
        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      ].join("; "),
    },
  );
}

// ── Reading the plan ─────────────────────────────────────────────

export function sessionToken(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const cookie = req.headers.get("cookie") ?? "";
  return /(?:^|;\s*)charles_session=([^;]+)/.exec(cookie)?.[1]?.trim() ?? "";
}

/** `where` is only for tracking: which page or call the session was presented to. */
export async function businessForSession(token: string, where = "plan"): Promise<Business | null> {
  if (!token) return null;
  const { data, error } = await db().from("plan_sessions").select("business_id, expires_at").eq("token_hash", hashSecret(token)).maybeSingle();
  // A failed read looks exactly like no session: a signed-in owner is told to sign in again.
  if (error) trackFailure("web_session_rejected", dbError(error), { props: { reason: "lookup_failed", where }, fingerprint: "web_session_rejected:lookup_failed", summary: "A signed-in owner was told to sign in again: their session could not be read" });
  const row = data as { business_id: string; expires_at: string } | null;
  if (!row) {
    if (!error) track("web_session_rejected", { category: "security", props: { reason: "unknown", where } });
    return null;
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db().from("plan_sessions").delete().eq("token_hash", hashSecret(token));
    track("web_session_rejected", { category: "security", businessId: row.business_id, props: { reason: "expired", where } });
    return null;
  }
  const biz = await findBusinessById(row.business_id);
  if (biz) attribute(biz);
  else track("web_session_rejected", { category: "security", props: { reason: "no_business", where } });
  return biz;
}

async function renderPlan(req: Request): Promise<Response> {
  const started = Date.now();
  const biz = await businessForSession(sessionToken(req), "plan");
  if (!biz) return json({ ok: false, message: "Sign in to see your plan." }, 401);

  const plan = await planFor(biz.id);
  if (!plan) {
    trackUnmet("plan_viewed", { severity: "info", props: { what: "document", reason: "no_plan", reply: "No plan here yet" }, fingerprint: "plan_viewed:no_plan" });
    return new Response(notYet(), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }

  // Live, 2026-09-25: the PDF told a connected owner "Your own AI is
  // connected" and this page never did, because nothing here asked. The
  // document only ever prints that the connector is live (only the hash of
  // the address is stored), so a marker is all planDocHTML needs. A failed
  // lookup loses the box, not the plan.
  const [tools, connected, strategyPending] = await Promise.all([
    toolsFor(biz.country),
    hasLiveConnector(biz.id).catch((err) => {
      trackFailure("web_data_missing", dbError(err), { severity: "warn", props: { what: "connector", where: "plan" }, fingerprint: "web_data_missing:connector", summary: "A plan page went out without its \"your own AI is connected\" box: the connector lookup failed" });
      return false;
    }),
    // A strategy still being written says so (plandoc.ts); a failed lookup only loses the note.
    plan.plan.strategy ? false : strategyRepairPending(biz.id, plan.plan.id).catch(() => false),
  ]);
  const toolsById = Object.fromEntries(tools.map((t) => [t.id, t]));

  // The document from the stored rows, in step order, so the page shows
  // exactly what was saved — including anything the person has since
  // swapped, skipped or completed. The same builder makes the PDF a person
  // asks for later (engine/planpdf.ts). No "read it online" link: this page
  // is that link. The PDF is where it earns its place.
  const html = storedPlanHTML(biz, plan, toolsById, { connectorUrl: connected ? "connected" : null, link: null, strategyPending });

  track("plan_viewed", {
    ms: since(started),
    props: { what: "document", steps: plan.steps.length, done: plan.steps.filter((s) => s.status === "done").length, connected: Boolean(connected) },
  });
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// ── The person's progress view ────────────────────────────────────

/**
 * Everything a person can read about how it is going, as JSON — never as
 * markup, so the page has to put it on screen as TEXT. It is their own data,
 * but some of it is words they typed, and words they typed do not get to become
 * HTML.
 *
 * Deliberately no score, no ranking, no comparison with other businesses. The
 * map is where they stand against what "sorted" concretely means for their own
 * trade, and where they stood when they started.
 */
async function dashboard(req: Request): Promise<Response> {
  const biz = await businessForSession(sessionToken(req), "dashboard");
  if (!biz) return json({ ok: false, message: "Sign in to see your progress." }, 401);

  const plan = await planFor(biz.id);
  const [commitmentsRes, outcomesRes] = await Promise.all([
    db().from("commitments").select("what, due, status, created_at").eq("business_id", biz.id).order("created_at", { ascending: false }).limit(30),
    db().from("outcomes").select("what, effect, created_at").eq("business_id", biz.id).order("created_at", { ascending: false }).limit(30),
  ]);

  const steps = plan?.steps ?? [];
  const done = steps.filter((s) => s.status === "done").length;
  const skipped = steps.filter((s) => s.status === "skipped").length;
  const next = steps.find((s) => s.status === "open");
  // A failed read is shown as an empty list, never an error: say so here.
  for (const [what, res] of [["commitments", commitmentsRes], ["outcomes", outcomesRes]] as const) {
    if (res.error) trackFailure("web_data_missing", dbError(res.error), { severity: "warn", props: { what, where: "dashboard" }, fingerprint: `web_data_missing:${what}`, summary: `A person's progress page showed no ${what}: the read failed` });
  }
  track("plan_viewed", { props: { what: "progress", has_plan: Boolean(plan), done, skipped, total: steps.length } });

  const first = new Map((biz.map_first ?? []).map((m) => [m.domain, m.status]));
  const now = new Map((biz.map ?? []).map((m) => [m.domain, m]));
  const map = DOMAINS.map((id) => {
    const cur = now.get(id);
    if (!cur) return null;
    return {
      domain: id,
      label: DOMAIN_LABELS[id] ?? id,
      status: cur.status,
      was: first.get(id) ?? null,
      note: cur.note ?? "",
      // What "sorted" concretely means, for every area that is not there yet.
      sorted_means: cur.status === "green" ? "" : greenMeans(id),
    };
  }).filter(Boolean);

  return json({
    ok: true,
    business: { name: biz.context?.name ?? biz.identity?.name ?? "Your money", one_liner: biz.context?.one_liner ?? biz.identity?.one_liner ?? "" },
    started: biz.created_at,
    hasPlan: Boolean(plan),
    progress: {
      done,
      skipped,
      total: steps.length,
      percent: steps.length ? Math.round((done / steps.length) * 100) : 0,
      next_step: next?.title ?? null,
    },
    map,
    commitments: ((commitmentsRes.data as { what: string; due: string | null; status: string }[]) ?? []).map((c) => ({ what: c.what, due: c.due, status: c.status })),
    outcomes: ((outcomesRes.data as { what: string; effect: string; created_at: string }[]) ?? []).map((o) => ({ what: o.what, effect: o.effect, at: o.created_at })),
  });
}

const notYet = (): string => `<!doctype html><html><head><meta charset="utf-8"><title>No plan yet</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#171f1a;color:#f2f4f0;font-family:Helvetica,Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center">
<div style="max-width:420px;padding:24px">
<h1 style="font-size:22px;margin:0 0 10px">No plan here yet</h1>
<p style="color:#b8c2ba;line-height:1.6;font-size:15px;margin:0">Finish the questions on WhatsApp and your 90-day plan will appear here automatically.</p>
</div></body></html>`;

// ── The website's WhatsApp buttons ───────────────────────────────
//
// Every "Message Charles" button on public/*.html links to /wa?m=<preset>
// (vercel.json rewrites /wa here), and this answers with a redirect to
// wa.me/<number>. The number is WHATSAPP_PUBLIC_NUMBER if set, otherwise the
// bot's own number as Meta reports it (see _lib/wanumber.ts). Live, 2026-09-23: the pages used to carry
// the number baked in as a placeholder that a manual deploy-time `sed` was
// meant to replace — nothing ran it, and every visitor got a dead link.
//
// A redirect rather than a script that rewrites links: it needs no build
// step, works with JavaScript off, and the button is never conditional on a
// fetch landing on a slow phone. It lives in this function rather than its
// own because Vercel Hobby caps a deployment at 12 functions.
//
// The prefilled text comes from a fixed list, never the query string: an
// open "?text=" would let anyone craft a link that puts their words in an
// owner's mouth to Charles.
export const WA_PRESETS: Record<string, string> = {
  start: "Hi Charles, I want to start.",
  plan: "Send me my plan please.",
  programme: "I'm asking about Charles for a programme or cohort.",
  ask: "",
};

const notLiveYet = (): string => `<!doctype html><html><head><meta charset="utf-8"><title>Charles on WhatsApp</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"></head>
<body style="margin:0;background:#171f1a;color:#f2f4f0;font-family:Helvetica,Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center">
<div style="max-width:420px;padding:24px">
<h1 style="font-size:22px;margin:0 0 10px">Charles's WhatsApp number isn't switched on yet</h1>
<p style="color:#b8c2ba;line-height:1.6;font-size:15px;margin:0 0 18px">Sorry — this button should have opened WhatsApp. Please try again a little later.</p>
<p style="margin:0"><a href="/" style="color:#8fd6ae">Back to the Charles home page</a></p>
</div></body></html>`;

export async function whatsappRedirect(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const number = await resolvePublicWhatsAppNumber();
  if (!number) {
    // Loud in the function log, and on /api/health (subsystem whatsapp_link),
    // but a visitor gets an honest page, never a wa.me link to nobody.
    console.log("wa: no WhatsApp number — WHATSAPP_PUBLIC_NUMBER is unset (or the placeholder) and Meta could not be asked for the bot's number; the website's WhatsApp buttons cannot open WhatsApp");
    const asked = url.searchParams.get("m") ?? "";
    // Every visitor who lands here wanted to message Charles and could not.
    trackFailure("wa_link_dead", "no public WhatsApp number", {
      severity: "critical",
      props: { preset: Object.hasOwn(WA_PRESETS, asked) ? asked : "start", source: publicNumberSource() },
      fingerprint: "wa_link_dead",
      summary: "A visitor tapped a \"Message Charles\" button and got the \"not switched on yet\" page: no public WhatsApp number",
    });
    return new Response(notLiveYet(), { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }
  // Own keys only: "__proto__" or "toString" must not reach the link text.
  const m = url.searchParams.get("m") ?? "";
  const text = Object.hasOwn(WA_PRESETS, m) ? WA_PRESETS[m]! : WA_PRESETS.start!;
  const target = `https://wa.me/${number}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
  // The top of the funnel: the website sending somebody to WhatsApp. Which
  // page, by our own path only — another site's address is just "external".
  const from = (() => {
    try {
      const r = new URL(req.headers.get("referer") ?? "");
      return r.host === url.host ? r.pathname.slice(0, 60) : "external";
    } catch {
      return null;
    }
  })();
  track("wa_link_opened", { category: "funnel", props: { preset: Object.hasOwn(WA_PRESETS, m) ? m : "start", from, source: publicNumberSource() } });
  // no-store: a changed number must take effect on the next click, not after a CDN TTL.
  return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store" } });
}

// ── Routing ──────────────────────────────────────────────────────

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "";

  if (req.method === "GET") {
    if (action === "whatsapp") return whatsappRedirect(req);
    if (action === "dashboard") return dashboard(req);
    if (action === "session") {
      const biz = await businessForSession(sessionToken(req), "session");
      return json({ signedIn: Boolean(biz), business: biz?.context?.name ?? null });
    }
    return renderPlan(req);
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: { wa_id?: string; code?: string };
  try {
    body = (await req.json()) as { wa_id?: string; code?: string };
  } catch {
    return json({ ok: false, message: "Bad request." }, 400);
  }

  // Which sign-in step, for tracking: our own two names, never the raw query.
  const step = action === "request_code" || action === "verify" ? action : "other";
  const waId = normaliseWaId(body.wa_id ?? "");
  if (!waId) {
    trackUnmet("web_signin_failed", {
      severity: "info",
      props: { reason: "bad_number", step, digits: String(body.wa_id ?? "").replace(/\D/g, "").length, reply: "Send your WhatsApp number with the country code, no plus." },
      fingerprint: "web_signin_failed:bad_number",
    });
    return json({ ok: false, message: "Send your WhatsApp number with the country code, no plus." }, 400);
  }
  // Only the yes/no of "one of ours" is kept, never the number.
  setTrackContext({ internal: isInternalNumber(waId) });
  if (!env.SESSION_SECRET) {
    console.log("plan: SESSION_SECRET is not set, refusing to mint credentials");
    trackFailure("web_signin_failed", "SESSION_SECRET is not set", {
      severity: "critical",
      props: { reason: "not_configured", step },
      fingerprint: "web_signin_failed:not_configured",
      summary: "Website sign-in is off: SESSION_SECRET is not set, so nobody can sign in to see their plan",
    });
    return json({ ok: false, message: "Sign-in is not switched on yet." }, 503);
  }
  // A number typed the local way (082…) becomes 82…, matches no business, and
  // used to get "a code is on its way" and then nothing — so say what's wrong.
  // Only the local form is refused: any number can hold a business (the
  // webhook takes all comers), so a country-code allow-list would lock out
  // real people and anyone testing from abroad.
  if (typedLocally(body.wa_id ?? "")) {
    // No `reply`: the message carries example phone numbers, and no number goes in an event.
    trackUnmet("web_signin_failed", { severity: "info", props: { reason: "local_format", step }, fingerprint: "web_signin_failed:local_format" });
    return json({ ok: false, message: wrongFormatMessage(body.wa_id ?? "") }, 400);
  }

  if (action === "request_code") return requestCode(waId);
  if (action === "verify") return verifyCode(waId, String(body.code ?? ""));
  return json({ ok: false, message: "Unknown action." }, 400);
}

const served = tracked("plan", "web", handler);
export const GET = served;
export const POST = served;
export const OPTIONS = served;
