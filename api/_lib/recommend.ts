// Charles — the "My pick" line, made to point at what the person can see.
//
// Live test, 2026-09-25: in 3 of 5 customer-options messages the model's
// recommendation named its own internal option id ("Start with c — ...")
// instead of the number printed on the card, and in one case said "option 2"
// while the reasoning described option 1. The person replies with the number on
// the card, so a pick that names anything else is worse than no pick. Prompting
// alone does not hold — models slip — so the line is normalised here, at
// display time, with no model call: work out which option the text means and
// rewrite it as "Start with N (<label>) — <reason>", N being the DISPLAYED
// number. Pure and deterministic, so already-stored recommends are fixed too.

const PICK_VERB =
  "(?:(?:i'?d\\s+|i\\s+would\\s+|my\\s+pick\\s*(?:is|:)?\\s*)?(?:start\\s+with|go\\s+with|go\\s+after|go\\s+for|pick|choose|try|aim\\s+(?:at|for)|focus\\s+on|option|number|no\\.?|#)|my\\s+pick(?:\\s+is|\\s*:))";
// Between a pick verb and what it picks: whitespace, or nothing after "#",
// "no." or "my pick:" — so "Nod." is never verb "no" + letter "d".
const VSEP = "(?:\\s+|(?<=[#.:])\\s*)";
// What may follow the pick token for it to count as the whole pick phrase and
// not the start of a longer clause: a dash, punctuation, "first", or the end.
const AFTER = "\\s*(?:first\\b\\s*)?(?:[—–\\-:.,;!]+\\s*|$)";
const OPEN = "[(\"“'‘\\[]";
const CLOSE = "[)\"”'’\\]]";
const ID_LETTERS = "abcd";
// Words that, just before a label, mean the reason is comparing against it or
// turning it down ("unlike guesthouses", "you can't be the cheapest").
const CUE = /(?:\bnot|n't|\bnever|\bno|\bunlike|\bthan|\bover|\binstead\s+of|\brather|\bavoid|\bskip|\bbeats?|\bexcept|\bwithout|\bvs\.?|\bversus)\b/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A label as a pattern: case-insensitive, and "never wait" also matches "never-wait". */
function labelRe(label: string): string {
  return label
    .trim()
    .split(/[\s\-–]+/)
    .filter(Boolean)
    .map(escapeRe)
    .join("[\\s\\-–]+");
}

/** Whole-phrase label match: no letter or digit may touch either end. */
function wholeLabel(label: string): string {
  return `(?<![\\p{L}\\p{N}])${labelRe(label)}(?![\\p{L}\\p{N}])`;
}

function labelIndex(phrase: string, labels: string[]): number {
  const norm = (s: string) => s.trim().toLowerCase().replace(/^the\s+/, "").split(/[\s\-–]+/).join(" ");
  const p = norm(phrase);
  return labels.findIndex((l) => !!l?.trim() && norm(l) === p);
}

function tokenIndex(tok: string): number {
  return /^\d+$/.test(tok) ? Number(tok) - 1 : ID_LETTERS.indexOf(tok.toLowerCase());
}

/**
 * The leading pick phrase, if the text opens with one: which option it names
 * (0-based, or -1 when it names one that is not on the card) and where the
 * phrase ends, so the caller can strip it. Recognises every form the model
 * writes, including the normalised one ("Start with 1 (Guesthouses) — "), so
 * normalising twice changes nothing.
 */
function leadPick(text: string, labels: string[]): { index: number; end: number } | null {
  const n = labels.length;
  const live = labels.filter((l) => l?.trim()).sort((a, b) => b.trim().length - a.trim().length);
  const anyLabel = live.length ? `(?:the\\s+)?(?:${live.map(wholeLabel).join("|")})` : "(?!)";
  // "over 3", "not 2", "rather than guesthouses": a comparison that is still
  // part of the pick phrase, stripped with it.
  const compare = `(?:\\s+(?:over|not|rather\\s+than|instead\\s+of|ahead\\s+of|before)\\s+(?:the\\s+)?(?:\\d+|[a-d]|${anyLabel})(?![\\p{L}\\p{N}]))?`;
  const verb = `(?:(${PICK_VERB})${VSEP})?`;

  // 1. An explicit number or id letter, optionally echoed with its label:
  //    "Start with 2 —", "Option b:", "(a)", "1 (Guesthouses) —",
  //    "Start with 1: Guesthouses —", "Start with 1 over 3 —".
  const tokRe = new RegExp(
    `^\\s*${verb}(?:the\\s+)?(?:\\(\\s*(\\d+|[a-d])\\s*\\)|(\\d+|[a-d]))` +
      `(?:\\s*${OPEN}\\s*(${anyLabel})\\s*${CLOSE}|\\s*[:,]\\s*(${anyLabel})(?=${AFTER}))?` +
      `${compare}(?:${AFTER}|(?<=[\\d)])(\\s+)(?=[\\p{L}\\p{N}]))`,
    "iu",
  );
  const t = text.match(tokRe);
  if (t) {
    const hasVerb = !!t[1];
    const bracketed = t[2] !== undefined;
    const tok = t[2] ?? t[3];
    const echoed = t[4] ?? t[5];
    const isLetter = !/^\d+$/.test(tok);
    // A bare number running into a word ("3 customers a week") is a count,
    // not a pick, unless a pick verb introduced it. A bare letter needs a verb
    // or brackets: "A regular contract…" is the article.
    // "(a) they trust you": the brackets are the delimiter.
    const runsOn = t[6] !== undefined && !bracketed;
    const ok = (!isLetter || hasVerb || bracketed) && (!runsOn || hasVerb);
    if (ok) {
      // A label echoed right beside the token is the pick phrase itself; if
      // the two disagree, the label is the one the reasoning was written for.
      const li = echoed ? labelIndex(echoed, labels) : -1;
      if (li >= 0) return { index: li, end: t[0].length };
      const i = tokenIndex(tok);
      return { index: i >= 0 && i < n ? i : -1, end: t[0].length };
    }
  }

  // 2. A label used as the pick word, optionally quoted or bracketed and
  //    optionally followed by its number: "Guesthouses —", "Go after
  //    guesthouses first.", 'Start with "Weekend tourists" —', "Guesthouses (1) —".
  for (const label of live) {
    const re = new RegExp(
      `^\\s*${verb}(?:the\\s+)?${OPEN}?\\s*${wholeLabel(label)}\\s*${CLOSE}?(?:\\s*\\(\\s*(?:\\d+|[a-d])\\s*\\))?${compare}${AFTER}`,
      "iu",
    );
    const m = text.match(re);
    if (m) return { index: labels.indexOf(label), end: m[0].length };
  }
  return null;
}

/**
 * Which option (0-based) the recommendation means, or -1.
 *
 * Each rule is a weaker signal than the one before it:
 * 1. the leading pick phrase: a number 1..n or an id letter a–d at the start
 *    (after an optional pick verb), or a label that IS the pick phrase. A
 *    label echoed right beside the number ("2 (Saturday regulars)") decides
 *    if the two disagree — that is the "option 2 with option 1's reasoning"
 *    slip. A label that only appears later, in the reason, never overrides an
 *    explicit number: the reason routinely names the options it rejected
 *    ("unlike guesthouses…", "you can't be the cheapest…").
 * 2. a number or letter elsewhere: "option 2", "number 3", "go with b", "(a)".
 *    Never the article "a" in running text.
 * 3. only when there is no number or letter at all: exactly one label named
 *    in the text as a whole phrase, and not straight after a word that turns
 *    it down or compares against it ("not", "n't", "unlike", "than", "over").
 */
export function resolvePick(text: string, labels: string[]): number {
  const n = labels.length;
  if (!text.trim() || !n) return -1;

  const lead = leadPick(text, labels);
  if (lead) return lead.index;

  const num = text.match(/\b(?:option|number|no\.?)\s*(\d+)\b/i);
  const letter =
    text.match(new RegExp(`(?:^|\\b)${PICK_VERB}\\s+\\(?([a-d])\\)?(?=${AFTER})`, "i")) ??
    text.match(/\(([a-d])\)/i);
  if (num || letter) {
    const i = num ? Number(num[1]) - 1 : ID_LETTERS.indexOf(letter![1].toLowerCase());
    return i >= 0 && i < n ? i : -1;
  }

  const hits: number[] = [];
  labels.forEach((label, i) => {
    if (!label?.trim()) return;
    const re = new RegExp(wholeLabel(label), "giu");
    for (const m of text.matchAll(re)) {
      const before = text.slice(0, m.index).split(/\s+/).slice(-4).join(" ");
      if (!CUE.test(before)) {
        hits.push(i);
        return;
      }
    }
  });
  return hits.length === 1 ? hits[0] : -1;
}

/**
 * Rewrites a model's recommendation as "Start with N (<label>) — <reason>",
 * with N the displayed number. `labels` are the option labels in the order
 * they were shown. Text that names no option it can resolve comes back
 * unchanged. The leading pick phrase it replaced ("Start with c —",
 * "Option 2:", "Go after guesthouses first.", or an already-normalised
 * "Start with 1 (Guesthouses) —") is stripped so the reason reads on its own
 * and the function is idempotent.
 */
export function normaliseRecommend(text: string, labels: string[]): string {
  const i = resolvePick(text, labels);
  if (i < 0) return text;
  const label = labels[i].trim();
  const lead = leadPick(text, labels);
  const reason = (lead ? text.slice(lead.end) : text).trim();
  return `Start with ${i + 1} (${label})${reason ? ` — ${reason}` : ""}`;
}
