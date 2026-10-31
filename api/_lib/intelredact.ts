// Chase Intelligence — what never leaves the process (docs/INTEL-CONTRACT.md §4).
//
// Every captured event and every exported line goes through here, twice:
// once before it is written, once more on export. Two kinds of thing go:
//
//   - Secrets: this deployment's own keys (matched by value, whatever they
//     look like), and anything shaped like a key, token, JWT, private key,
//     connection string, password or signed link.
//   - Identifiers (CLAUDE.md rule 12): ID, card, account and phone numbers,
//     PINs, OTPs, passwords and sign-in codes. Any run of nine or more
//     digits goes, so money ("R3,000", "R12 500", "R1200000") and dates stay.
//
// Pure: no database, no settings module, nothing that can throw outward.

/** This deployment's secrets, matched by value. Read at call time so a rotated key is covered at once. */
const SECRET_ENV = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENROUTER_API_KEY",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "WORKER_SECRET",
  "SESSION_SECRET",
  "CRON_SECRET",
  "ADMIN_SECRET",
  "SIGNALS_ADMIN_SECRET",
  "TYPESAFE_API_KEY",
  "RESEND_API_KEY",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
];

const R = "[redacted]";

const PATTERNS: [RegExp, string][] = [
  // Private keys, whole.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, R],
  // scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/"'\\]+:[^\s@/"'\\]+@/gi, `$1${R}@`],
  // Authorization values.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, `$1 ${R}`],
  // JWTs (Supabase keys are JWTs).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, R],
  // Vendor key shapes.
  [/\bsk-(?:or-v1-|proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{16,}/g, R],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, R],
  [/\bEAA[A-Za-z0-9]{30,}/g, R],
  [/\bAKIA[0-9A-Z]{16}\b/g, R],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, R],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, R],
  [/\bre_[A-Za-z0-9_]{20,}/g, R],
  [/\bwhsec_[A-Za-z0-9+/=]{16,}/g, R],
  [/\bAIza[0-9A-Za-z_-]{35}/g, R],
  // Signed or tokened links: the connector address, card and plan links.
  [/(\/mcp\/)[A-Za-z0-9_-]{16,}/g, `$1${R}`],
  [/([?&](?:k|key|token|code|secret|sig|signature|access_token|auth)=)[^&\s"'\\#]+/gi, `$1${R}`],
  // key=value and "key: value" in prose and logs.
  [/\b(api[_-]?key|secret|passw(?:or)?d|passcode|token|cvv|cvc)\b(\s*(?:is|was|:|=)\s*["']?)(?!\[redacted\])[^\s"',;\\]{3,}/gi, `$1$2${R}`],
  // PINs, OTPs and sign-in codes: the digits after the word.
  [/\b(pin|otp|one[- ]time (?:pin|code|password)|code)\b([^\d\n\\]{0,25}?)\d{4,8}\b/gi, `$1$2${R}`],
  // Nine or more digits, with or without spaces and dashes inside: ID, card,
  // account and phone numbers. Money and dates are shorter.
  // (Preceded by a start, a non-word character, or an escaped \n, \t or \r inside JSON text.)
  [/(?<=^|[^\w.]|\\[ntr])\+?\d(?:[ -]?\d){8,}(?![\w])/g, "[number]"],
];

/** JSON keys whose values are always secret, whatever they hold. */
const SECRET_KEYS = /"(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client_secret|api_key|apikey|x-api-key|token|access_token|refresh_token|id_token|private_key|code_hash|token_hash|session|pin|otp)"(\s*:\s*)"(?:[^"\\]|\\.)*"/gi;

function secretValues(): string[] {
  const out: string[] = [];
  for (const k of SECRET_ENV) {
    const v = process.env[k];
    if (v && v.length >= 8) out.push(v);
  }
  return out;
}

/** Text with every secret and identifier taken out. Never throws. */
export function redactText(input: string): string {
  try {
    let s = input;
    for (const v of secretValues()) if (s.includes(v)) s = s.split(v).join(R);
    for (const [re, to] of PATTERNS) s = s.replace(re, to);
    return s;
  } catch {
    return "[unreadable]";
  }
}

/**
 * A JSON text with secrets out, still valid JSON. Values under secret-named
 * keys go whole; then the text rules run over the rest. NUL characters go too:
 * Postgres jsonb refuses them.
 */
export function redactJson(json: string): string {
  try {
    let s = json.replace(SECRET_KEYS, `"$1"$2"${R}"`);
    s = redactText(s);
    return s.replace(/\\u0000/g, "");
  } catch {
    return "null";
  }
}
