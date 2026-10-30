// Charles — never let an unfilled placeholder reach a phone.
//
// PRIORITY 5.1, live-verified 2026-09-22, reproduced three times: a plan
// step's artifact — a message written for the OWNER to send to THEIR
// customer — arrived on WhatsApp verbatim as "Hi [Name], thanks for choosing
// Verify Script Test Business... [Link to Google profile]". The tailoring
// prompt (prompts.ts's plan_builder call) already says "write the actual
// words, ready to paste... with their real details filled in. Never a
// description of what to write" — and usually the model does exactly that.
// But some placeholders describe something that genuinely does not exist yet
// at build time: a future customer's name, or a Google Business Profile link
// before the person has even set one up (see playbooks.ts's `f1` step, "the
// message asking five regulars for a review" — the exact artifact this bug
// was found on). No prompt can fix that; the model is being asked to fill in
// a fact nobody has yet. This is the runtime backstop: resolve whatever
// Charles already knows for certain, and refuse — never guess — the rest.
//
// The gap track1 (PR #22) flagged explicitly in its own body: this choke
// point only sat on the WhatsApp step-push/reply path (steps.ts) and the new
// per-step PDF (stepdoc.ts, via sendStepPdf). `plan_steps.artifact` reaches
// three OTHER places, none of which called this: the full-plan PDF/webpage
// (plandoc.ts's stepRow — shared by both api/plan.ts and
// engine/planbuild.ts's runPdfStage), the MCP connector's get_plan
// (connector.ts, the person's own connected AI), and the row itself as
// engine/planbuild.ts's runFinalizeStage writes it to plan_steps in the first
// place. All three now call checkArtifact — the SAME function, not a second
// implementation of the same idea.

/** Bracketed text WhatsApp would show verbatim, e.g. "[Name]" or "[Link to Google profile]". */
const PLACEHOLDER_RE = /\[([^[\]\n]{1,80})\]/g;

/**
 * The minimal shape checkArtifact actually needs: enough to fill a known
 * name or location, nothing else. A full `Business` satisfies this
 * structurally (every existing call site just passes `biz` straight in) —
 * this exists so a caller that only ever holds a rendering-time context, not
 * a real Business (plandoc.ts's PlanDocData has no Business at all), can
 * still call the exact same function instead of constructing a fake one.
 */
export interface KnownFactsSource {
  context?: { name?: string | null; location?: string | null } | null;
  identity?: { name?: string | null } | null;
}

/**
 * Facts Charles actually has, keyed by the words an artifact plausibly uses
 * for them. Deliberately small and literal — this is a lookup, not a guess
 * (see docs note in CLAUDE.md-adjacent Priority 2b: a fact Charles already
 * knows exactly gets checked/filled mechanically; only a genuinely unknown
 * fact goes unfilled rather than invented).
 */
function knownFacts(biz: KnownFactsSource): Record<string, string> {
  const name = (biz.context?.name || biz.identity?.name || "").trim();
  const location = (biz.context?.location || "").trim();
  const facts: Record<string, string> = {};
  if (name) {
    for (const key of ["your name", "my name", "sender name", "your first name", "my first name"]) {
      facts[key] = name;
    }
  }
  if (location) {
    for (const key of ["location", "city", "area", "your location", "your area", "your city", "where you live"]) {
      facts[key] = location;
    }
  }
  return facts;
}

function fillKnown(text: string, biz: KnownFactsSource): string {
  const facts = knownFacts(biz);
  if (!Object.keys(facts).length) return text;
  return text.replace(PLACEHOLDER_RE, (whole, inner: string) => facts[inner.trim().toLowerCase()] ?? whole);
}

export interface ArtifactCheck {
  /** Safe to send exactly as written — every placeholder has been resolved. */
  text: string | null;
  /**
   * Set only when `text` is null: the message itself, with the parts only
   * the person knows still in [brackets], under one line telling them to fill
   * those in before sending. Round 18: the old fallback was an apology sent
   * INSTEAD of the message ("write that part yourself…"), so the person got
   * no message at all — and the build stored that apology over the message.
   */
  fallback: string | null;
  /** Set with `fallback`: the message with its brackets, nothing else — what is stored and printed. */
  draft: string | null;
  /** The parts still to fill, lower-case, e.g. ["name", "your phone number"]. */
  missing: string[];
}

/** The apology older builds stored over the message. Nothing to recover from it. */
const OLD_STUB_RE = /^There's a ready-to-send message for this one, but part of it is only something you know/;

/**
 * A number written as a mask ("0XX XXX XXXX", "07XX XXX XXX", "+27 XX XXX
 * XXXX") is a placeholder too — round 18 printed three of them as if they
 * were real. It becomes a bracket like any other unknown.
 */
const MASKED_NUMBER_RE = /(?:\+\d{1,3}[ -]?)?\b0?\d?X{1,2}[X\d]*(?:[ -][X\d]*X[X\d]*){1,4}\b/g;
export function bracketMasks(text: string): string {
  return text.replace(MASKED_NUMBER_RE, "[your phone number]");
}

/** An unfilled "[your details]" on paper: a line to write on, with what goes there. */
export function blanks(text: string): string {
  return text.replace(PLACEHOLDER_RE, (_, what: string) => `________ (${what.trim()})`);
}

/**
 * The single choke point every artifact-touching path goes through: the
 * WhatsApp send (sendReply/pushNextStep, steps.ts), the per-step PDF
 * (stepdoc.ts, via sendStepPdf), the full-plan PDF/webpage (plandoc.ts's
 * stepRow), the MCP connector's get_plan (connector.ts), and the row as it
 * is written to plan_steps in the first place (planbuild.ts's
 * runFinalizeStage). Fills what Charles actually knows; anything left is
 * handed over clearly marked as the person's to fill, never invented.
 */
export function checkArtifact(raw: string | null | undefined, biz: KnownFactsSource): ArtifactCheck {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || OLD_STUB_RE.test(trimmed)) return { text: null, fallback: null, draft: null, missing: [] };

  const filled = fillKnown(bracketMasks(trimmed), biz);
  const remaining = [...new Set([...filled.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!.trim().toLowerCase()))];
  if (!remaining.length) return { text: filled, fallback: null, draft: null, missing: [] };
  // Named as written, once each: "a landmark people in Germiston would know",
  // never "germiston" (round 35, ZA, live).
  const shown = new Map<string, string>();
  for (const m of filled.matchAll(PLACEHOLDER_RE)) {
    const w = m[1]!.trim();
    if (!shown.has(w.toLowerCase())) shown.set(w.toLowerCase(), w.charAt(0).toLowerCase() + w.slice(1));
  }

  return {
    text: null,
    fallback: `Fill in the part${remaining.length === 1 ? "" : "s"} in [brackets] (${[...shown.values()].join(", ")}) before you send this:\n\n${filled}`,
    draft: filled,
    missing: remaining,
  };
}

// ── A way to pay nobody gave ─────────────────────────────────────

/** What each way of paying is called, by kind (the diagnostic's "How do they pay you?" options). */
const PAY_KINDS: [string, RegExp][] = [
  ["cash", /\bcash\b/i],
  ["bank", /\b(?:bank(?: transfers?)?|EFT|transfers?)\b/i],
  ["card", /\b(?:card(?: machine)?s?|swipe|Yoco|SnapScan|Zapper)\b/i],
  ["mobile", /\b(?:M-?Pesa|mobile money|MoMo|Airtel Money|QR(?: code)?|SnapScan|Zapper|OPay|PalmPay)\b/i],
  ["account", /\b(?:on account|invoice)\b/i],
];
const PAY_TERM = String.raw`(?:cash|bank transfers?|EFT|card(?: machine)?s?|M-?Pesa|mobile money|MTN MoMo|MoMo|Airtel Money|QR(?: code)?|SnapScan|Zapper|Yoco|OPay|PalmPay)`;
const PAY_LIST = new RegExp(String.raw`\b${PAY_TERM}(?:\s*(?:,|\bor\b|\band\b|\/|&)\s*${PAY_TERM})*\b`, "gi");
const kindsOf = (t: string): Set<string> => new Set(PAY_KINDS.filter(([, re]) => re.test(t)).map(([k]) => k));

/**
 * Ways to pay, in words the person will paste, that they never said they
 * take (rule 2): their slot to fill. Round 35 (ZA and KE, live): "Cash or
 * bank transfer" and "Cash, M-Pesa or QR" in posts for people who had
 * said neither. `known`: their answer to "How do they pay you?" and what
 * they typed.
 */
export function bracketUnknownPayments(text: string | null, known: string): { text: string | null; replaced: string[] } {
  if (!text) return { text, replaced: [] };
  const theirs = kindsOf(known);
  const replaced: string[] = [];
  const out = text.replace(PAY_LIST, (m) => {
    // SnapScan and Zapper are a card or a QR: theirs if either is.
    const named = PAY_KINDS.filter(([, re]) => re.test(m)).map(([k]) => k);
    const each = m.split(/\s*(?:,|\bor\b|\band\b|\/|&)\s*/i).filter(Boolean);
    const unbacked = each.some((t) => ![...kindsOf(t)].some((k) => theirs.has(k)));
    if (!named.length || !unbacked) return m;
    replaced.push(m);
    return "[how you take payment]";
  });
  return { text: out, replaced };
}

// ── A landmark nobody gave ───────────────────────────────────────

/**
 * "Opposite the taxi stage, Ntinda." in a post written for the person to send
 * (round 24 and round 25, live, UG salon): a landmark the person never named,
 * stated as fact in words they would paste to their customers (rule 2).
 * Where a business is, beyond the area it gave, is a detail only the person
 * knows: a "next to / opposite / near the …" whose words appear nowhere in
 * what they told Charles becomes a slot for them to fill, the round-18
 * convention for owner-only details in an artifact. Their own area, or a
 * landmark they did name, stays as written.
 */
// Only the words that say where a door is ("near", "behind", "close to" also
// mean "almost", "late" and "soon": "behind on payments", "near the end of
// the month"), and only before a place: a proper name ("Shoprite") or a
// place noun ("the taxi stage").
const LANDMARK_RE = /\b(?:right |just )?(?:opposite|next to|across (?:the road )?from|beside|around the corner from|(?:on|at) the corner of)\s+(?:the\s+|a\s+|an\s+)?([A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*){0,4})/gi;
const PLACE_NOUN =
  /\b(?:stage|station|rank|stop|market|mall|plaza|centre|center|church|mosque|temple|school|college|university|hospital|clinic|pharmacy|chemist|bank|garage|filling|park|road|street|avenue|lane|junction|roundabout|bridge|building|tower|house|shop|shops|store|supermarket|hotel|lodge|restaurant|bar|stadium|office|offices|post|police|court|gate|terminal|depot|square|complex|arcade|estate)\b/i;
const PLACE_STOP = new Set(["the", "a", "an", "of", "and", "in", "on", "at", "you", "your", "us", "our", "me", "my", "here", "there", "home", "town", "it", "them"]);

export function bracketUnknownLandmarks(text: string | null, known: string): { text: string | null; replaced: string[] } {
  if (!text) return { text, replaced: [] };
  const knownWords = new Set(known.toLowerCase().match(/[a-z]{3,}/g) ?? []);
  const replaced: string[] = [];
  const out = text.replace(LANDMARK_RE, (whole, place: string) => {
    // A place: a place noun, or a name (a capitalised word that does not open a sentence here).
    const isPlace = PLACE_NOUN.test(place) || /(?:^|\s)[A-Z][a-z]/.test(place);
    const words = place.toLowerCase().match(/[a-z]{3,}/g)?.filter((w) => !PLACE_STOP.has(w)) ?? [];
    // Not a place at all ("next to nothing"), or one they gave.
    if (!isPlace || !words.length || words.some((w) => knownWords.has(w) && !PLACE_NOUN.test(w))) return whole;
    replaced.push(whole.trim());
    return "[where to find you]";
  });
  return { text: out, replaced };
}
