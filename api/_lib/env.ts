// Fin — every environment variable in one place, with an honest readiness
// report.
//
// The rule this file exists to enforce: a subsystem that is not configured must
// SAY SO, loudly and in one place, rather than quietly doing nothing. The first
// version of this backend shipped a distress check, a compliance check and a
// rubric scorer that all silently no-opped because one undocumented key was
// missing — which is the exact failure the Kenya RCT warns about (weaker
// businesses are the ones harmed when the guardrails are off).
//
// Nothing here throws at import time: Vercel imports every function module
// during a build, and a build must not fail because a secret is not set yet.

const read = (name: string): string => (process.env[name] ?? "").trim();

export const env = {
  // ── Data ───────────────────────────────────────────────────────
  SUPABASE_URL: read("SUPABASE_URL"),
  SUPABASE_SERVICE_ROLE_KEY: read("SUPABASE_SERVICE_ROLE_KEY"),

  // ── Models (everything goes through OpenRouter) ────────────────
  OPENROUTER_API_KEY: read("OPENROUTER_API_KEY"),

  // ── WhatsApp ───────────────────────────────────────────────────
  WHATSAPP_ACCESS_TOKEN: read("WHATSAPP_ACCESS_TOKEN"),
  WHATSAPP_PHONE_NUMBER_ID: read("WHATSAPP_PHONE_NUMBER_ID"),
  WHATSAPP_VERIFY_TOKEN: read("WHATSAPP_VERIFY_TOKEN") || "fin-verify",
  /** Meta app secret. Without it, inbound webhooks cannot be authenticated. */
  WHATSAPP_APP_SECRET: read("WHATSAPP_APP_SECRET"),
  /**
   * Optional. The number the website's buttons open. Unset, the bot's own
   * number is asked of Meta (see wanumber.ts); set it only to show a
   * different number from the bot's.
   */
  WHATSAPP_PUBLIC_NUMBER: read("WHATSAPP_PUBLIC_NUMBER"),
  /** Graph API version. In config because Meta sunsets versions on a ~2-year clock. */
  WHATSAPP_API_VERSION: read("WHATSAPP_API_VERSION") || "v21.0",

  // ── Guardrails ─────────────────────────────────────────────────
  /** Jev / TypeSafe System One. Optional: a model backstop covers the same checks. */
  TYPESAFE_API_KEY: read("TYPESAFE_API_KEY"),

  // ── Voice notes ────────────────────────────────────────────────
  /**
   * Optional, and only for routing transcription AWAY from OpenRouter.
   * OpenRouter proxies an OpenAI-shaped /audio/transcriptions endpoint, so the
   * default path needs no second account. Set this (and the `voice` row's
   * provider) to go direct to Groq — cheaper per hour, and the only way to get
   * per-segment confidence back, since OpenRouter only forwards verbose_json
   * to OpenAI-compatible upstreams.
   */
  GROQ_API_KEY: read("GROQ_API_KEY"),

  // ── Plumbing ───────────────────────────────────────────────────
  /** Shared secret between the webhook and the worker it wakes. */
  WORKER_SECRET: read("WORKER_SECRET"),
  /** Vercel sends this as a bearer token on scheduled cron requests. */
  CRON_SECRET: read("CRON_SECRET"),
  /**
   * Optional. Opens /api/knowledge-signals and nothing else, so the agent
   * running docs/PROMOTION-PASS.md never needs WORKER_SECRET (which also
   * drains the queue and runs admin actions). If unset, only WORKER_SECRET
   * opens it.
   */
  SIGNALS_ADMIN_SECRET: read("SIGNALS_ADMIN_SECRET"),
  /** Pepper for hashing login codes and connector tokens before storage. */
  SESSION_SECRET: read("SESSION_SECRET"),
  /** e.g. https://fin.vercel.app — used for connector URLs and self-calls. */
  PUBLIC_BASE_URL: read("PUBLIC_BASE_URL") || (read("VERCEL_URL") ? `https://${read("VERCEL_URL")}` : ""),

  /** Set to "1" to let the webhook run the work inline instead of via the queue. */
  INLINE_WORKER: read("INLINE_WORKER") === "1",

  // ── Tracking and alerts (api/_lib/track.ts, alerts.ts, email.ts) ──
  /** Resend API key (resend.com, free tier). Without it nothing is emailed; everything is still recorded. */
  RESEND_API_KEY: read("RESEND_API_KEY"),
  /** Who alert emails go to, comma-separated. Kept out of code on purpose. */
  ALERT_EMAIL_TO: read("ALERT_EMAIL_TO"),
  /** The sender. Until a domain is verified in Resend, only its test sender works, and only to the account owner's own address. */
  ALERT_EMAIL_FROM: read("ALERT_EMAIL_FROM") || "Fin alerts <onboarding@resend.dev>",
  /** UTC hour the daily summary goes out. Default 5 = 07:00 in Johannesburg. */
  ALERT_DIGEST_HOUR_UTC: Number(read("ALERT_DIGEST_HOUR_UTC") || 5),
  /** "0" leaves people' own words (scrubbed of numbers and links) out of alert emails. */
  ALERT_EMAIL_EXCERPTS: read("ALERT_EMAIL_EXCERPTS") !== "0",
  /** Opens /admin (the tracking dashboard) and /api/admin. Nothing else. */
  ADMIN_SECRET: read("ADMIN_SECRET"),
  /**
   * The founder's and testers' own numbers, comma-separated; "2780*" matches a
   * prefix. Their traffic is tracked but marked internal, so it stays out of
   * the funnel and the daily numbers. Never stored: only the yes/no is.
   */
  INTERNAL_WA_IDS: read("INTERNAL_WA_IDS"),
} as const;

/** Is this number one of ours (INTERNAL_WA_IDS)? */
export function isInternalNumber(waId: string | null | undefined): boolean {
  if (!waId) return false;
  const digits = waId.replace(/\D/g, "");
  return env.INTERNAL_WA_IDS.split(",")
    .map((x) => x.trim().replace(/[^\d*]/g, ""))
    .filter(Boolean)
    .some((p) => (p.endsWith("*") ? digits.startsWith(p.slice(0, -1)) : digits === p));
}

export type Subsystem =
  | "database"
  | "models"
  | "whatsapp_send"
  | "whatsapp_verify"
  | "guardrails_jev"
  | "guardrails_model"
  | "voice"
  | "worker"
  | "website"
  | "whatsapp_link"
  | "connector"
  | "alerts"
  | "admin";

export interface Readiness {
  subsystem: Subsystem;
  ready: boolean;
  /** true when the product is unsafe or broken without it, not merely reduced. */
  required: boolean;
  detail: string;
}

export function readiness(): Readiness[] {
  const has = (v: string) => v.length > 0;
  return [
    {
      subsystem: "database",
      ready: has(env.SUPABASE_URL) && has(env.SUPABASE_SERVICE_ROLE_KEY),
      required: true,
      detail: "SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Nothing works without these.",
    },
    {
      subsystem: "models",
      ready: has(env.OPENROUTER_API_KEY),
      required: true,
      detail: "OPENROUTER_API_KEY. Every model call goes through OpenRouter; the models themselves come from the model_config table.",
    },
    {
      subsystem: "whatsapp_send",
      ready: has(env.WHATSAPP_ACCESS_TOKEN) && has(env.WHATSAPP_PHONE_NUMBER_ID),
      required: false,
      detail: "WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID. Missing means Fin runs and logs but sends nothing — deliberate, so the flow can be exercised before a number exists.",
    },
    {
      subsystem: "whatsapp_verify",
      ready: has(env.WHATSAPP_APP_SECRET),
      required: true,
      detail: "WHATSAPP_APP_SECRET. Without it the webhook cannot prove a request came from Meta, and anyone who finds the URL can write owner data and spend model credits.",
    },
    {
      subsystem: "guardrails_jev",
      ready: has(env.TYPESAFE_API_KEY),
      required: false,
      detail: "TYPESAFE_API_KEY (Jev). Preferred guardrail engine: calibrated, ~150ms, near-zero cost. Falls back to the model backstop when absent.",
    },
    {
      subsystem: "guardrails_model",
      ready: has(env.OPENROUTER_API_KEY),
      required: true,
      detail: "The backstop that runs the same safety checks on a small model when Jev is unavailable. At least one guardrail engine must be live.",
    },
    {
      subsystem: "voice",
      // Must agree with voiceConfigured() in transcribe.ts. It previously did
      // not: this checked GROQ_API_KEY alone, so an OpenRouter-only deployment
      // — the default one — reported voice notes dead on /api/health while
      // they were working perfectly.
      ready: has(env.OPENROUTER_API_KEY) || has(env.GROQ_API_KEY) || has(read("OPENAI_API_KEY")),
      required: false,
      detail:
        "Transcription. Runs through OpenRouter by default, so OPENROUTER_API_KEY is usually enough; GROQ_API_KEY or OPENAI_API_KEY only to route direct. Missing means a voice note gets a polite 'type it to me' reply rather than being silently dropped.",
    },
    {
      subsystem: "worker",
      ready: has(env.WORKER_SECRET) && (has(env.PUBLIC_BASE_URL) || env.INLINE_WORKER),
      required: true,
      detail: "WORKER_SECRET + PUBLIC_BASE_URL. The webhook must answer Meta in under a second and hand the slow work to the worker; set INLINE_WORKER=1 only for local testing.",
    },
    {
      subsystem: "website",
      ready: has(env.SESSION_SECRET),
      required: false,
      detail: "SESSION_SECRET. Pepper for the one-time login codes that let a person read their plan on the web.",
    },
    {
      subsystem: "whatsapp_link",
      // Sync best guess; /api/health replaces it with the result of the real lookup.
      ready: publicWhatsAppNumber() !== null || (has(read("WHATSAPP_PHONE_NUMBER_ID")) && has(read("WHATSAPP_ACCESS_TOKEN"))),
      required: false,
      detail:
        "Every 'Message Fin' button on the website goes through /wa, which opens WhatsApp on the bot's own number as Meta reports it (from WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN), or on WHATSAPP_PUBLIC_NUMBER if set. Not ready means those buttons show a 'not live yet' page instead of opening WhatsApp.",
    },
    {
      subsystem: "connector",
      ready: has(env.SESSION_SECRET) && has(env.PUBLIC_BASE_URL),
      required: false,
      detail: "SESSION_SECRET + PUBLIC_BASE_URL. Needed to mint and verify the token a person's own AI uses.",
    },
    {
      subsystem: "alerts",
      ready: has(env.RESEND_API_KEY) && has(env.ALERT_EMAIL_TO),
      required: false,
      detail:
        "RESEND_API_KEY + ALERT_EMAIL_TO. ALERT EMAILS ARE OFF without them: every failure and unmet request is still recorded in events/incidents and shown on /admin, but nobody is told. CRON_SECRET must also be set, or the per-minute tick that sends them is refused.",
    },
    {
      subsystem: "admin",
      ready: has(env.ADMIN_SECRET),
      required: false,
      detail: "ADMIN_SECRET. Opens the tracking dashboard at /admin. Without it the dashboard refuses everyone.",
    },
  ];
}

/**
 * The placeholder that shipped in public/*.html before the website read the
 * number at request time. Treated as "not set" wherever it turns up, so a
 * copied .env.example can never quietly put a dead number back on the site.
 */
export const PLACEHOLDER_WA_NUMBER = "27663129297";

/**
 * WHATSAPP_PUBLIC_NUMBER as digits, or null when it is not set. The website
 * uses resolvePublicWhatsAppNumber() in wanumber.ts, which falls back to
 * asking Meta for the bot's own number. Read at call time rather than from `env`, so a test
 * (or a redeploy with a new value) sees the current setting. Accepts the forms
 * a person actually types into a settings page: "+27 66 312 9297", "27-66...".
 */
export function publicWhatsAppNumber(): string | null {
  const digits = read("WHATSAPP_PUBLIC_NUMBER").replace(/[\s+().-]/g, "");
  if (!/^\d{8,15}$/.test(digits) || digits === PLACEHOLDER_WA_NUMBER) return null;
  return digits;
}

/** Names of required subsystems that are not configured. Empty means go. */
export function missingRequired(): string[] {
  return readiness().filter((r) => r.required && !r.ready).map((r) => r.subsystem);
}

/**
 * True when at least one guardrail engine can actually run. If this is ever
 * false in production, Fin is giving business advice with no safety net,
 * and the health endpoint says so in plain words.
 */
export const guardrailsLive = (): boolean => Boolean(env.TYPESAFE_API_KEY || env.OPENROUTER_API_KEY);
