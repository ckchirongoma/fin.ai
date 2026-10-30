// Charles — the money diagnostic, and how it maps onto what WhatsApp can do.
//
// Three question shapes, and the platform decides which is which:
//   - open           → plain text (a voice note still gets an answer, but is not offered)
//   - one answer      → reply buttons (max 3) or a list (max 10 rows)
//   - many answers    → numbered plain text, because WhatsApp has no
//                       multi-select control at all. Lists let you pick one row
//                       and one row only. Pretending otherwise is how you build
//                       a flow that quietly loses half a person's answer.
//
// Twelve questions, about five minutes. Question four — "what are you trying
// to fix or achieve with your money?" — is the one the whole plan is built
// around, quoted in the person's own words, never paraphrased into something
// they did not say.

import { country } from "./countries.js";
import { STATEMENT_OFFER } from "./statement.js";
import {
  BLOCKER_OPTIONS,
  COVER_OPTIONS,
  CUSHION_OPTIONS,
  DEPENDS_OPTIONS,
  INCOME_KIND_OPTIONS,
  OBJECTIVE_KIND_OPTIONS,
  OWES_OPTIONS,
  RECORDS_OPTIONS,
} from "./diagoptions.js";
import { WA, clip, type Button, type ListRow } from "./wa.js";

export interface DiagQuestion {
  key: string;
  /** Written out per country, because "R3,500" is nonsense in Manila. */
  q: (countryCode: string) => string;
  options?: string[];
  multi?: boolean;
}

/**
 * The promise about their data, said once, in the first message.
 * forgetHousehold() makes the second half true; the first half is rule 12:
 * Charles never asks for an ID, account, card, PIN or password, and says so.
 */
export const CONSENT_LINE =
  "I'll keep what you tell me about your money so I can help you properly. I never ask for your ID number, account number, card, PIN or password — nobody at a bank should either. Nobody else sees this, and you can send \"forget my money\" any time and it's gone. One more thing: I teach and I plan with you; I'm not a financial adviser and I never sell you anything.";

export const DIAG: DiagQuestion[] = [
  {
    key: "person",
    q: () =>
      // Say up front what this costs them and what they get.
      "Hi, I'm Charles. I learn your money once, then I answer for it: what to do first, what it costs you, and where to tap.\n\n" +
      `Here's how this goes: ${DIAG.length} short questions (most take a number or a few words), about 5 minutes. Then you pick the one thing to fix first and the one rule you'll live by, and I build your 90-day money plan — a full document you can keep. I'll tell you how long each part takes as we go.\n\n` +
      `${CONSENT_LINE}\n\n` +
      "Question 1: what should I call you, and what do you do for money?",
  },
  {
    key: "income_kind",
    q: () => "How does money come in?",
    multi: true,
    options: [...INCOME_KIND_OPTIONS],
  },
  { key: "location", q: () => "Where are you based? Area and city is enough." },
  {
    key: "objective",
    q: () =>
      "Now the important one. What are you trying to fix or achieve with your money? Tell me in your own words — this is what your whole plan gets built around.",
  },
  {
    key: "objective_kind",
    q: () => "Is that mainly about any of these?",
    multi: true,
    options: [...OBJECTIVE_KIND_OPTIONS],
  },
  {
    key: "blockers",
    q: () => "What's getting in the way right now?",
    multi: true,
    options: [...BLOCKER_OPTIONS],
  },
  {
    key: "depends",
    q: () => "Who depends on your money?",
    multi: true,
    options: [...DEPENDS_OPTIONS],
  },
  {
    key: "income",
    q: (cc) => `Roughly, what comes in a month, all together? ${country(cc).incomeExample.replace(/^./, (c) => c.toUpperCase())}. A rough number is fine.\n\n${STATEMENT_OFFER}`,
  },
  {
    key: "owes",
    q: () => "Who do you owe money to right now?",
    multi: true,
    options: [...OWES_OPTIONS],
  },
  {
    key: "cushion",
    q: () => "If something broke tomorrow — a phone, a tooth, a taxi fare home — what could you reach?",
    options: [...CUSHION_OPTIONS],
  },
  {
    key: "cover",
    q: () => "What cover do you have?",
    multi: true,
    options: [...COVER_OPTIONS],
  },
  {
    key: "records",
    q: () => "How do you keep track of your money?",
    multi: true,
    options: [...RECORDS_OPTIONS],
  },
];

export const DIAG_COUNT = DIAG.length;

/** An action id for a diagnostic option, so a tap never round-trips as text. */
export const diagActionId = (step: number, optionIndex: number): string => `d.${step}.${optionIndex}`;

export function parseDiagAction(actionId: string): { step: number; option: number } | null {
  const m = /^d\.(\d+)\.(\d+)$/.exec(actionId || "");
  if (!m) return null;
  return { step: Number(m[1]), option: Number(m[2]) };
}

export type AskShape =
  | { kind: "text"; body: string }
  | { kind: "buttons"; body: string; buttons: Button[] }
  | { kind: "list"; body: string; buttonLabel: string; rows: ListRow[] };

/**
 * Decides how one question goes out. The decision is the platform's, not a
 * style choice: three or fewer single-answer options fit as buttons, more need
 * a list, and anything multi-answer has to be numbered text.
 */
export function shapeQuestion(step: number, countryCode: string): AskShape {
  const q = DIAG[step];
  if (!q) throw new Error(`diagnostic step ${step} does not exist`);
  const body = q.q(countryCode);

  if (!q.options) return { kind: "text", body };

  if (q.multi) {
    const numbered = q.options.map((o, i) => `${i + 1}. ${o}`).join("\n");
    return {
      kind: "text",
      // One instruction, once, and true: there is nothing to tap.
      body: `${body}\n\n${numbered}\n\nType the numbers of every one that fits — for example: 1, 3`,
    };
  }

  if (q.options.length <= WA.buttons) {
    return {
      kind: "buttons",
      body,
      buttons: q.options.map((o, i) => ({ id: diagActionId(step, i), title: clip(o, WA.buttonTitleChars) })),
    };
  }

  return {
    kind: "list",
    body,
    buttonLabel: "Choose one",
    rows: q.options.slice(0, WA.listRows).map((o, i) => ({ id: diagActionId(step, i), title: clip(o, WA.listRowTitleChars) })),
  };
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
};

/**
 * Words people use for an option that the option's own text does not
 * contain. Used ONLY by the no-model fallback (replyTouchesOptions) to judge
 * "is this an answer at all?" when neither Jev nor the model backstop is
 * available — never to choose which options get stored.
 */
const ALIASES: Record<string, string[]> = {
  "Salary or wage": ["salary", "wage", "wages", "payslip", "employed", "job", "work", "contract", "piece rate"],
  "Piece jobs or hustle": ["piece job", "piece jobs", "hustle", "side hustle", "odd jobs", "casual", "gigs", "uber", "bolt", "e-hailing", "hawking"],
  "SASSA grant": ["sassa", "grant", "srd", "child grant", "pension", "old age", "disability", "r370", "r350"],
  "My own business": ["business", "spaza", "salon", "sell", "selling", "trade", "shop", "stall"],
  "Family or partner": ["husband", "wife", "partner", "boyfriend", "girlfriend", "family", "parents", "mother", "father", "son", "daughter", "remittance", "sends me"],
  "A bank loan or card": ["loan", "credit card", "card", "capitec", "fnb", "absa", "nedbank", "standard bank", "african bank", "personal loan", "overdraft", "vehicle finance", "car finance", "bond", "home loan"],
  "A clothing or furniture account": ["account", "accounts", "edgars", "jet", "mr price", "truworths", "foschini", "ackermans", "pep", "lewis", "russells", "ok furniture", "bradlows", "joshua doore", "furniture", "clothing", "store card", "lay-by", "layby"],
  "A cellphone contract": ["cellphone", "phone contract", "contract phone", "vodacom", "mtn", "cell c", "telkom", "rain"],
  "A mashonisa": ["mashonisa", "loan shark", "umashonisa", "omashonisa", "skoploan", "skop", "cash loan", "cash loans", "micro lender", "lender"],
  "Stokvel, family or friends": ["stokvel", "society", "umgalelo", "friends", "friend", "family", "cousin", "brother", "sister", "neighbour", "neighbor"],
  "Funeral policy": ["funeral", "avbob", "funeral cover", "policy", "old mutual", "sanlam", "hollard", "1life", "clientele"],
  "Burial society": ["burial", "society", "masingcwabane", "umasingcwabane", "stokvel"],
  "Medical aid": ["medical", "medical aid", "discovery", "bonitas", "gems", "hospital plan"],
  "Life cover": ["life", "life cover", "life insurance", "credit life"],
  "In my head": ["head", "memory", "remember", "nothing", "no"],
  "A notebook": ["book", "exercise book", "paper", "notebook", "diary"],
  "The bank app": ["app", "bank app", "banking app", "tyme", "gotyme", "capitec app", "sms"],
  "A spreadsheet or app": ["excel", "sheets", "spreadsheet", "22seven", "budget app", "vault22"],
  "Someone helps me": ["husband", "wife", "mother", "daughter", "son", "partner", "helps", "friend"],
  "Just me": ["me", "myself", "alone", "nobody", "no one"],
  "A partner": ["husband", "wife", "partner", "boyfriend", "girlfriend"],
  "Children": ["kids", "child", "children", "son", "daughter", "baby", "babies", "grandchildren", "grandkids"],
  "Parents or elders": ["mother", "father", "mom", "mum", "dad", "parents", "gogo", "grandmother", "grandfather", "granny", "elders", "aunt", "uncle"],
  "Extended family": ["cousins", "siblings", "brother", "sister", "nephew", "niece", "family", "relatives", "home", "ekhaya", "back home", "black tax"],
};

const hasWord = (text: string, w: string) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(text);

/**
 * The options a reply picks when the reply is NOTHING BUT a pick: digits
 * ("1, 4", "1 and 4"), number words ("one and three", "the first two"),
 * the option labels themselves ("Nobody", "children and parents"), or a
 * bare "all". Anything with other words in it is the person talking —
 * "one of my kids is at varsity" is not option 1, "no loan, only the
 * clothing account" is not "A bank loan or card", "what counts as a
 * mashonisa?" is not an answer — so it returns nothing and the reply is
 * judged and kept in their words.
 */
export function matchOptions(said: string, options: string[]): string[] {
  const text = (said || "").toLowerCase().trim().replace(/[.!]+$/, "");
  if (/^(all|all of them|all of the above|everything|all of it)$/.test(text)) return [...options];

  // The option labels themselves and nothing else: "Nobody", "children and parents or elders".
  const parts = text.split(/\s*(?:,|&|\+|\/|\band\b)\s*/).map((p) => p.trim()).filter(Boolean);
  const byLabel = parts.map((p) => options.find((o) => o.toLowerCase() === p));
  if (parts.length && byLabel.every(Boolean)) return options.filter((o) => byLabel.includes(o));

  const words = Object.keys(NUMBER_WORDS).join("|");
  const pickOnly = new RegExp(`^(?:(?:the\\s+)?(?:\\d{1,2}|${words})(?:\\s*(?:,|&|\\+|and|or|/)\\s*|\\s+|$))+$`);
  const firstN = /^(?:the\s+)?first\s+(two|three|four)$/.exec(text);
  const nums = new Set<number>();
  if (firstN) {
    for (let i = 1; i <= NUMBER_WORDS[firstN[1]!]!; i++) nums.add(i);
  } else if (pickOnly.test(text)) {
    for (const m of text.matchAll(new RegExp(`\\d{1,2}|${words}`, "g"))) {
      const n = /\d/.test(m[0]) ? parseInt(m[0], 10) : NUMBER_WORDS[m[0]]!;
      if (n < 1 || n > options.length) return []; // "7" for five options is not a pick; let the check read it
      nums.add(n);
    }
  }
  return [...nums].sort((a, b) => a - b).map((n) => options[n - 1]!);
}

/**
 * Reads a multi-answer reply into what gets stored. Digits that name an
 * offered option, then an option's own full text, then a pure number-word
 * pick ("one and three"). If neither applies we keep what they wrote: a
 * person who types "mostly my mother, and my sister's kids" has told us
 * something real. (Whether a reply is an answer at all is decided before
 * this, in handleDiagText.)
 */
export function parseMultiReply(said: string, options: string[]): string[] {
  const pure = matchOptions(said, options);
  if (pure.length) return pure;

  const nums = [...(said || "").matchAll(/\d+/g)]
    .map((m) => parseInt(m[0]!, 10))
    .filter((n) => n >= 1 && n <= options.length);
  const picked = [...new Set(nums)].map((n) => options[n - 1]!).filter(Boolean);
  if (picked.length) return picked;

  const lower = (said || "").toLowerCase();
  const byText = options.filter((o) => lower.includes(o.toLowerCase()));
  if (byText.length) return byText;

  return [(said || "").trim()].filter(Boolean);
}

/** Filler words in the option labels that say nothing about which option is meant. */
const FILLER = new Set(["just", "want", "come", "back", "keep", "time", "what", "more", "less", "some", "else", "your", "they", "with", "that", "have", "does", "their", "nothing", "major", "ahead", "from", "than", "month", "money", "something"]);

/**
 * The no-model fallback, used only when the typed check is unavailable: does
 * the reply share a real word stem with any option? Deliberately modest; the
 * typed check in handleDiagText is the real judge of "is this an answer".
 */
export function replyTouchesOptions(said: string, options: string[]): boolean {
  if (matchOptions(said, options).length) return true;
  const text = (said || "").toLowerCase();
  if (options.some((o) => text.includes(o.toLowerCase()) || (ALIASES[o] ?? []).some((al) => hasWord(text, al)))) return true;
  const stem = (w: string) => w.slice(0, 5);
  const optionStems = new Set(
    options.flatMap((o) => (o.toLowerCase().match(/[a-z]{5,}/g) ?? []).filter((w) => !FILLER.has(w)).map(stem)),
  );
  return (text.match(/[a-z]{5,}/g) ?? []).filter((w) => !FILLER.has(w)).some((w) => optionStems.has(stem(w)));
}

/** Store an answer in the shape the plan builder expects. */
export function recordAnswer(answers: Record<string, string>, step: number, said: string): Record<string, string> {
  const q = DIAG[step];
  if (!q || !said?.trim()) return answers;
  // A single-answer question offered as buttons or a list, answered by
  // typing its number ("2") or its label: store the option, not the digit.
  const exact = q.options?.find((o) => o.toLowerCase() === said.trim().toLowerCase().replace(/[.!]+$/, ""));
  const single = !q.multi && q.options ? (exact ? [exact] : matchOptions(said, q.options)) : [];
  const value = q.multi && q.options ? parseMultiReply(said, q.options).join(", ") : single.length === 1 ? single[0]! : said.trim();
  return { ...answers, [q.key]: value };
}
