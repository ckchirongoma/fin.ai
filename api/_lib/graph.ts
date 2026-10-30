// Charles — what Charles knows about one household's money, as a graph.
//
// The person is the centre. Around them: where money comes from, who they
// owe, who they support, what covers them, where they save and bank, which
// stokvel or burial society they belong to, the goal they chose, the rule
// they live by. Every line carries WHERE IT CAME FROM and WHEN, because two
// of the product's rules turn on exactly that:
//
//   rule 2  Charles may say "you told me" only about what the person told
//           it. A line from their statement says "your statement shows"; a
//           line from their own AI says so.
//   rule 10 A figure on a line is one the person gave or a page showed. A
//           figure the memory model proposes that is not in their message
//           is dropped, in code.
//
// Four ways in, three of them plain code:
//   derive()         from the diagnostic answers, the statement they sent,
//                    and the goal and rule they chose. Recomputed from the
//                    household row every time, so it can never drift.
//   graphUpdates()   from the memory step after each answer (engine/qa.ts
//                    updateMemory): the model proposes, this file checks
//                    each fact against the person's own words and keeps
//                    only what they said. "I paid off Edgars" closes a line.
//   the connector    record_fact, from the person's own AI, marked as such.
//   stored history   a changed amount keeps the old one ("was R200 a week").
//
// And three ways out:
//   graphSheet()     the lines every answer's prompt carries (prompts.ts core).
//   graphTerms()     the person's own creditors, grants and cover, a small
//                    tie-break boost for the library rows about them.
//   the memory card  "what Charles knows", drawn (cards.ts kind "memory").
//
// Stored in kg_nodes and kg_edges (db/0038), service role only, deleted with
// the household. If the tables are missing the derived graph still works and
// nothing learned from conversation is kept: an unreadable memory is an empty
// one, never a failed answer.

import { db } from "./db.js";
import { figuresFrom } from "./grounding.js";
import { scrubText, type StatementRead } from "./statement.js";
import { track } from "./track.js";
import { splitPicks, COVER_OPTIONS, DEPENDS_OPTIONS, INCOME_KIND_OPTIONS, OWES_OPTIONS } from "./diagoptions.js";
import type { Business } from "./types.js";

export type NodeKind = "self" | "income" | "creditor" | "dependant" | "cover" | "savings" | "bank" | "group" | "bill" | "goal" | "rule";
export type Rel = "earns_from" | "owes" | "supports" | "covered_by" | "saves_in" | "banks_with" | "member_of" | "pays" | "working_towards" | "lives_by";
export type Source = "said" | "answer" | "statement" | "plan" | "connector";

export const REL_KIND: Record<Rel, NodeKind> = {
  earns_from: "income",
  owes: "creditor",
  supports: "dependant",
  covered_by: "cover",
  saves_in: "savings",
  banks_with: "bank",
  member_of: "group",
  pays: "bill",
  working_towards: "goal",
  lives_by: "rule",
};
const RELS = Object.keys(REL_KIND) as Rel[];

export interface Fact {
  rel: Rel;
  /** What it is, in their words or the page's: "the mashonisa", "SASSA child support grant", "my mother". */
  label: string;
  /** What is paid or received each time, in rand. */
  amount?: number | null;
  per?: "week" | "month" | null;
  /** What is still owed, for a creditor. */
  balance?: number | null;
  /** Day of the month, when known. */
  day?: number | null;
  note?: string | null;
  /** Paid off, cancelled, stopped. */
  closed?: boolean;
  source: Source;
  /** ISO date the fact was learned. */
  on: string;
}

export interface Edge extends Fact {
  key: string;
  kind: NodeKind;
  sources: Source[];
  history: { amount?: number | null; per?: string | null; balance?: number | null; on: string; source: Source }[];
}

export interface HouseholdGraph {
  name: string | null;
  edges: Edge[];
}

// ── Keys: one node per thing, however it is written ──────────────

const ALIASES: [RegExp, string][] = [
  [/\b(?:mashonisa|machonisa|loan\s*shark|machine)\b/i, "mashonisa"],
  [/\b(?:sassa|child\s+(?:support\s+)?grant|old\s+age\s+grant|srd|social\s+grant)\b/i, "sassa grant"],
  [/\b(?:burial\s+society)\b/i, "burial society"],
  [/\b(?:funeral\s+(?:policy|cover|plan))\b/i, "funeral policy"],
  [/\b(?:medical\s+aid)\b/i, "medical aid"],
  [/\b(?:stokvel)\b/i, "stokvel"],
  [/\b(?:children|kids|child|son|daughter)\b/i, "children"],
  [/\b(?:mother|mom|mum|mama|father|dad|parents?|gogo|granny|elders?)\b/i, "parents"],
  [/\b(?:partner|husband|wife|boyfriend|girlfriend)\b/i, "partner"],
];

const STRIP = /^(?:(?:a|an|the|my|our|her|his|their)\s+)+/i;

/**
 * The words that only say WHAT KIND of thing it is. "SASSA child support
 * grant" is all of them, so it is the same node as "a SASSA grant". "Old
 * Mutual funeral cover" is not ("old mutual" names a provider), so it stays
 * its own node, and a second policy from another insurer is a second node:
 * two funeral policies are two lines, never merged into one (and that is
 * exactly the double cover the plan wants to see).
 */
const CLASS_WORDS: Record<string, Set<string>> = {
  mashonisa: new Set(["mashonisa", "machonisa", "loan", "shark", "sharks", "machine", "cash", "send", "informal", "lender"]),
  "sassa grant": new Set(["sassa", "child", "children", "support", "grant", "grants", "old", "age", "srd", "social", "pension", "payment", "r370"]),
  "burial society": new Set(["burial", "society"]),
  "funeral policy": new Set(["funeral", "policy", "cover", "plan", "insurance", "premium"]),
  "medical aid": new Set(["medical", "aid"]),
  stokvel: new Set(["stokvel", "savings", "club", "group", "society", "contribution"]),
  children: new Set(["children", "kids", "child", "son", "sons", "daughter", "daughters", "two", "three", "four", "five", "school"]),
  parents: new Set(["mother", "mom", "mum", "mama", "father", "dad", "parents", "parent", "gogo", "granny", "elders", "elder", "or"]),
  partner: new Set(["partner", "husband", "wife", "boyfriend", "girlfriend"]),
};
const FILLER = new Set(["a", "an", "the", "my", "our", "her", "his", "their", "and", "of", "for", "to", "from", "at", "on", "in", "account", "acc", "payment", "payments", "debit", "order", "monthly", "weekly"]);

const words = (label: string): string[] =>
  label.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);

/** What kind of thing it is, when it is one of the kinds Charles knows by many names. */
export function classOf(label: string): string | null {
  for (const [re, key] of ALIASES) if (re.test(label)) return key;
  return null;
}

export function keyOf(label: string, kind: NodeKind): string {
  const cls = classOf(label);
  if (cls) {
    // A leading number is a count ("2 children"); anywhere else it says which
    // one ("Stokvel 2", "Shop 24"), so two of them stay two (found by the
    // Charlie port of this file).
    const ws = words(label).filter((w) => !FILLER.has(w));
    const extra = ws.filter((w, i) => !CLASS_WORDS[cls]!.has(w) && !(i === 0 && /^\d+$/.test(w)));
    if (!extra.length) return cls;
  }
  const k = words(label).filter((w, i, all) => !(i === 0 && FILLER.has(w)) && !(i === all.length - 1 && (w === "account" || w === "acc"))).join(" ").replace(/^(?:(?:a|an|the|my|our)\s+)+/, "").trim();
  return k.slice(0, 60) || kind;
}

/** A generic setup-answer node ("A clothing or furniture account") a statement line names more exactly. */
const GENERIC: Record<string, RegExp> = {
  "clothing or furniture": /\b(?:edgars|jet|ackermans|truworths|foschini|tfg|mr\s*price|pep|lewis|beares|russells|ok\s*furniture|bradlows|account)\b/i,
  "bank loan or card": /\b(?:capfin|finchoice|wonga|african\s+bank|loan|credit\s+card|personal\s+loan)\b/i,
  "cellphone contract": /\b(?:vodacom|mtn|cell\s*c|telkom)\b/i,
};

// ── derive(): from what the household row already holds ──────────

const OWES_LABEL: Record<string, string> = {
  "A bank loan or card": "A bank loan or card",
  "A clothing or furniture account": "A clothing or furniture account",
  "A cellphone contract": "A cellphone contract",
  "A mashonisa": "The mashonisa",
  "Stokvel, family or friends": "Stokvel, family or friends",
};
const DEPENDS_LABEL: Record<string, string> = { "A partner": "A partner", Children: "Children", "Parents or elders": "Parents or elders", "Extended family": "Extended family" };
const INCOME_LABEL: Record<string, string> = { "Salary or wage": "A salary or wage", "Piece jobs or hustle": "Piece jobs", "SASSA grant": "A SASSA grant", "My own business": "Their own business", "Family or partner": "Family or a partner" };
const COVER_LABEL: Record<string, string> = { "Funeral policy": "A funeral policy", "Burial society": "A burial society", "Medical aid": "Medical aid", "Life cover": "Life cover" };

/** "R200 a week", "R1,060 a month" near a word, in one clause of their own text. */
function amountNear(text: string, re: RegExp): { amount: number; per: "week" | "month" } | null {
  for (const clause of text.split(/[.;\n]|,\s*(?:and|but)\s+/i)) {
    if (!re.test(clause)) continue;
    const m = /R\s?([\d][\d,\s]*(?:\.\d+)?)\s*(?:a|per|every|each)\s+(week|month)/i.exec(clause);
    if (m) return { amount: Number(m[1]!.replace(/[,\s]/g, "")), per: m[2]!.toLowerCase() as "week" | "month" };
  }
  return null;
}

/** "on R800", "owe R800", "R800 left" near a word: what is still owed. */
function balanceNear(text: string, re: RegExp): number | null {
  for (const clause of text.split(/[.;\n]|,\s*(?:and|but)\s+/i)) {
    if (!re.test(clause)) continue;
    const m = /(?:\bon|\bowe|\bowing|\bleft\s+on|\bof)\s+R\s?([\d][\d,\s]*)|R\s?([\d][\d,\s]*)\s+(?:left|owed|outstanding|still\s+to\s+pay)/i.exec(clause);
    if (m) return Number((m[1] ?? m[2])!.replace(/[,\s]/g, ""));
  }
  return null;
}

const OUT_REL: Partial<Record<string, Rel>> = { loan: "owes", store_account: "owes", insurance: "covered_by", stokvel: "member_of", family: "supports", rent: "pays", electricity: "pays", school: "pays", debit_order: "pays" };

export function derive(biz: Pick<Business, "answers" | "identity" | "statement" | "goal" | "rule" | "created_at">): Fact[] {
  const a = biz.answers ?? {};
  const on = String(biz.created_at ?? new Date().toISOString()).slice(0, 10);
  const facts: Fact[] = [];
  const own = `${a.objective ?? ""}\n${a.blockers ?? ""}`;

  for (const pick of splitPicks(a.income_kind ?? "", INCOME_KIND_OPTIONS)) {
    if (INCOME_LABEL[pick]) facts.push({ rel: "earns_from", label: INCOME_LABEL[pick]!, source: "answer", on });
  }
  for (const pick of splitPicks(a.owes ?? "", OWES_OPTIONS)) {
    const label = OWES_LABEL[pick];
    if (!label) continue;
    const re = pick === "A mashonisa" ? /mashonisa|loan\s*shark/i : pick === "A clothing or furniture account" ? /account|clothing|furniture|edgars|jet/i : pick === "A cellphone contract" ? /contract|cellphone|phone/i : pick === "A bank loan or card" ? /bank|loan|card/i : /stokvel|family|friend/i;
    const pay = amountNear(own, re);
    facts.push({ rel: "owes", label, amount: pay?.amount ?? null, per: pay?.per ?? null, balance: balanceNear(own, re), source: "answer", on });
  }
  for (const pick of splitPicks(a.depends ?? "", DEPENDS_OPTIONS)) {
    if (DEPENDS_LABEL[pick]) facts.push({ rel: "supports", label: DEPENDS_LABEL[pick]!, source: "answer", on });
  }
  for (const pick of splitPicks(a.cover ?? "", COVER_OPTIONS)) {
    if (COVER_LABEL[pick]) facts.push({ rel: "covered_by", label: COVER_LABEL[pick]!, source: "answer", on });
  }

  const read = biz.statement;
  if (read && (read.doc === "bank_statement" || read.doc === "payslip" || read.doc === "credit_report")) {
    const sOn = read.read_on;
    if (read.source && read.doc === "bank_statement") facts.push({ rel: "banks_with", label: read.source, source: "statement", on: sOn });
    if (read.doc !== "credit_report") {
      for (const l of read.money_in) facts.push({ rel: "earns_from", label: l.label, amount: l.amount, per: "month", day: l.day, note: l.times ? `${l.times} payments` : null, source: "statement", on: sOn });
    }
    for (const l of read.money_out) {
      const rel = OUT_REL[l.kind ?? ""] ?? (/mashonisa|loan/i.test(l.label) ? "owes" : null);
      if (!rel) continue;
      if (read.doc === "credit_report") facts.push({ rel: "owes", label: l.label, balance: l.amount, source: "statement", on: sOn });
      else facts.push({ rel, label: l.label, amount: l.amount, per: "month", day: l.day, note: l.times ? `${l.times} payments` : null, source: "statement", on: sOn });
    }
  }

  const goal = biz.goal?.[0];
  if (goal?.label) facts.push({ rel: "working_towards", label: goal.label, note: goal.what ?? null, source: "plan", on });
  const rule = biz.rule?.[0];
  if (rule?.rule) facts.push({ rel: "lives_by", label: rule.label || "Their rule", note: rule.rule, source: "plan", on });
  return facts;
}

// ── graphUpdates(): what the memory model proposed, checked in code ──

const CLOSING = /\b(?:paid\s+(?:it\s+|them\s+|that\s+)?(?:all\s+)?(?:off|back|up)|finished\s+paying|settled|cleared|cancel+ed|closed|stopped(?:\s+paying)?|no\s+longer|don'?t\s+owe|left\s+the)\b/i;
/**
 * A DEBT is only closed by words for paying it off. "I stopped paying
 * Edgars" closes a stokvel or a policy, but on a debt it means arrears: the
 * debt is still there and now growing, and calling it paid off would be the
 * most harmful mistake this graph could make.
 */
const PAID_OFF = /\b(?:paid\s+(?:it\s+|them\s+|that\s+|him\s+|her\s+)?(?:all\s+)?(?:off|back|up)|finished\s+paying(?!\s+late)|settled|cleared|don'?t\s+owe|no\s+longer\s+owe|debt\s+(?:is\s+)?(?:gone|done)|it'?s\s+(?:all\s+)?paid)\b/i;
const STOPPED_PAYING = /\b(?:stopped|stop|can'?t|cannot|couldn'?t|missed|skipped|didn'?t)\s+(?:paying|pay)\b|\bbehind\s+on\b/i;
const closes = (rel: string, text: string): boolean => (rel === "owes" ? PAID_OFF.test(text) && !STOPPED_PAYING.test(text) : CLOSING.test(text));
const IDENTIFIER = /\b(?:\d[\s-]?){6,}\b|\b(?:pin|otp|password|cvv|id\s+number|account\s+number|card\s+number)\b/i;
/** A capitalised word that is not a place, brand or role at the start of a dependant label is probably a person's name. */
/** "I never borrowed from a mashonisa", "I don't have a funeral policy". */
const NEGATED = /\b(?:never|not|no|don'?t|do\s+not|didn'?t|did\s+not|haven'?t|have\s+not|hasn'?t|isn'?t|wasn'?t|nothing|none|without)\b/i;
/** "If I took a loan from Capfin", "I'm thinking of joining a stokvel", "should I". */
const HYPOTHETICAL = /\b(?:if|maybe|might|thinking\s+(?:of|about)|considering|planning\s+to|want(?:s|ed)?\s+to|would|could|should|wish|hope\s+to|going\s+to\s+(?:try|ask|apply))\b/i;
/** "My sister owes the mashonisa", "my brother pays Edgars": someone else's money, not theirs. */
const SOMEONE_ELSE = /\b(?:my|her|his|our)\s+(?:sister|brother|mother|mom|mum|father|dad|friend|cousin|aunt|uncle|neighbou?r|husband|wife|partner|boyfriend|girlfriend|son|daughter|colleague)\s+(?:owes|borrowed|pays|took|has|is\s+paying|gets|earns)\b|\b(?:she|he|they)\s+(?:owes?|borrowed|pays?|took)\b/i;

/**
 * Every word a role, and nothing else: "my mother", "my two children", "the
 * kids". "Mama Joyce" starts with a role and ends with a name, so it is a
 * name (found by the fuzzer).
 */
const ROLE_WORDS = new Set(["my", "the", "our", "her", "his", "their", "two", "three", "four", "five", "younger", "older", "little", "big", "elder", "eldest", "youngest", "and",
  "mother", "mom", "mum", "mama", "father", "dad", "parents", "parent", "gogo", "granny", "grandmother", "grandfather", "grandparents", "sister", "brother", "sisters", "brothers",
  "son", "sons", "daughter", "daughters", "children", "kids", "child", "baby", "partner", "husband", "wife", "aunt", "uncle", "cousin", "cousins", "nephew", "niece", "family",
  "extended", "in", "law", "laws", "elders", "siblings", "grandchildren", "grandchild"]);
const roleOnly = (label: string): boolean => {
  const ws = label.toLowerCase().replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
  return ws.length > 0 && ws.every((w) => ROLE_WORDS.has(w)) && ROLE_ONLY.test(label);
};

const ROLE_ONLY = /^(?:my\s+)?(?:mother|mom|mum|mama|father|dad|parents?|gogo|granny|grandmother|grandfather|sister|brother|sisters|brothers|son|daughter|children|kids|child|partner|husband|wife|aunt|uncle|cousin|nephew|niece|family|extended\s+family|in-?laws?)\b/i;

/**
 * Keeps a proposed fact only when the person's own words back it: its label
 * shares a word with what they stated, any amount is a figure they typed,
 * and "closed" is only kept when they used a word for paying off or
 * stopping. Nothing that looks like an identifier, no person's name.
 */
export function graphUpdates(raw: unknown, ownerStatements: string, today: string, source: "said" | "connector" = "said"): { kept: Fact[]; refused: { label: string; reason: string }[] } {
  const kept: Fact[] = [];
  const refused: { label: string; reason: string }[] = [];
  const said = ownerStatements ?? "";
  const theirFigures = figuresFrom(said);
  const stem = (w: string) => w.toLowerCase().replace(/[^a-z]/g, "").slice(0, 5);
  const LITTLE = new Set(["the", "my", "our", "and", "from", "for", "now", "with", "his", "her", "their", "was", "this", "that", "who", "all", "new", "old"]);
  const ownWords = (t: string) => (t.toLowerCase().match(/[a-z']{3,}/g) ?? []).filter((w) => !LITTLE.has(w)).map(stem);
  const theirWords = new Set(ownWords(said));
  for (const item of Array.isArray(raw) ? raw.slice(0, 8) : []) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const rel = String(r.relation ?? r.rel ?? "") as Rel;
    const rawLabel = String(r.object ?? r.label ?? "");
    const label = scrubText(rawLabel).replace(/\s+/g, " ").trim().slice(0, 48);
    if (!RELS.includes(rel) || rel === "working_towards" || rel === "lives_by") {
      refused.push({ label, reason: "relation" });
      continue;
    }
    if (!label || IDENTIFIER.test(rawLabel) || IDENTIFIER.test(String(r.note ?? ""))) {
      refused.push({ label, reason: "identifier" });
      continue;
    }
    if (rel === "supports" && !roleOnly(label)) {
      refused.push({ label, reason: "not_a_role" });
      continue;
    }
    const labelWords = ownWords(label);
    // The clause the fact sits in, by the label's own words: what is negated,
    // supposed or about someone else is not a fact about their money.
    // When the label's own words are not in the message (a model writing "a
    // loan shark" for their "mashonisa"), the guards read the sentence that
    // names the thing by another of its names, or the whole message: a fact
    // with no sentence to check is never let through unchecked (found by the
    // fuzzer).
    const aliasRe = classOf(label) ? ALIASES.find(([, k]) => k === classOf(label))?.[0] : undefined;
    const byAlias = aliasRe ? (said.split(/(?<=[.!?;])\s+|\n+/).find((c) => aliasRe.test(c)) ?? null) : null;
    const clause = clauseFor(said, labelWords, stem) ?? byAlias ?? (said.trim() ? said : null);
    if (clause) {
      const closing = r.closed === true && closes(rel, clause);
      // "I stopped paying Edgars": still owed, and now behind. Kept open, said so.
      if (rel === "owes" && STOPPED_PAYING.test(clause)) {
        r.closed = false;
        r.note = "they said they stopped paying";
      }
      if (!closing && NEGATED.test(clause) && !closes(rel, clause)) {
        refused.push({ label, reason: "negated" });
        continue;
      }
      if (HYPOTHETICAL.test(clause) && !closing) {
        refused.push({ label, reason: "hypothetical" });
        continue;
      }
      if (rel !== "supports" && SOMEONE_ELSE.test(clause)) {
        refused.push({ label, reason: "someone_else" });
        continue;
      }
    }
    // Backed by their words: a thing Charles knows by many names ("the
    // mashonisa", "a SASSA grant") when they used one of its names; anything
    // else when they used EVERY word that says which one it is. One shared
    // word is not enough: "Hollard funeral plan" does not back "Avbob funeral
    // policy" (found by the fuzzer).
    const key = keyOf(label, REL_KIND[rel]);
    const cls = classOf(label);
    const keyWords = ownWords(key).filter((w) => w.length >= 3);
    const backed = cls && key === cls ? ALIASES.some(([re, k]) => k === cls && re.test(said)) : keyWords.length > 0 && keyWords.every((w) => theirWords.has(w));
    if (!backed) {
      refused.push({ label, reason: "not_said" });
      continue;
    }
    // A thing that can only be one kind of relation: a mashonisa is owed,
    // a grant is money in, a funeral policy or medical aid is cover.
    const ONLY: Partial<Record<string, Rel[]>> = { mashonisa: ["owes"], "sassa grant": ["earns_from"], "funeral policy": ["covered_by"], "medical aid": ["covered_by"] };
    if (cls && ONLY[cls] && !ONLY[cls]!.includes(rel)) {
      refused.push({ label, reason: "wrong_relation" });
      continue;
    }
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null);
    let amount = num(r.amount);
    let balance = num(r.balance);
    if (amount !== null && !theirFigures.has(amount)) amount = null;
    if (balance !== null && !theirFigures.has(balance)) balance = null;
    // How often, from their own words when they said it: "every Friday" is a
    // week whatever the model wrote, "monthly" a month (found by the fuzzer).
    const text = clause ?? said;
    const said_per = /\b(?:a|per|every|each)\s+(?:week|friday|monday|tuesday|wednesday|thursday|saturday|sunday)\b|\bweekly\b/i.test(text) ? "week" : /\b(?:a|per|every|each)\s+month\b|\bmonthly\b|\bpay\s*day\b|\bsalary\b/i.test(text) ? "month" : null;
    const per = said_per ?? (r.per === "week" || r.per === "month" ? r.per : null);
    const closed = r.closed === true && closes(rel, clause ?? said);
    const day = typeof r.day === "number" && Number.isInteger(r.day) && r.day >= 1 && r.day <= 31 && theirFigures.has(r.day) ? r.day : null;
    const note = typeof r.note === "string" ? scrubText(r.note).slice(0, 100) || null : null;
    kept.push({ rel, label, amount, per: amount !== null ? per : null, balance, day, note, closed, source, on: today });
  }
  return { kept, refused };
}

/** The sentence or clause of what they said that carries the label's words; null if none does. */
function clauseFor(said: string, labelWords: string[], stem: (w: string) => string): string | null {
  const clauses = said.split(/(?<=[.!?;])\s+|\n+|,\s*(?=(?:but|and|so|because)\b)/i).map((c) => c.trim()).filter(Boolean);
  const hit = clauses.find((c) => {
    const cw = new Set((c.toLowerCase().match(/[a-z']{3,}/g) ?? []).map(stem));
    return labelWords.some((w) => cw.has(w));
  });
  return hit ?? null;
}

// ── Storage ──────────────────────────────────────────────────────

interface NodeRow { id: string; business_id: string; kind: NodeKind; key: string; label: string }
interface EdgeRow {
  id: string;
  business_id: string;
  dst_id: string;
  rel: Rel;
  amount: number | null;
  per: string | null;
  balance: number | null;
  day: number | null;
  note: string | null;
  status: "active" | "closed";
  source: Source;
  sources: Source[] | null;
  history: Edge["history"] | null;
  first_seen: string;
  last_seen: string;
  closed_at: string | null;
}

/** What an edge row holds besides its keys. */
export type FoldedEdge = Omit<EdgeRow, "id" | "business_id" | "dst_id" | "rel">;

/**
 * One fact onto the edge it lands on, as a pure function: the same code the
 * database write uses and the fuzzer drives a million times. A changed
 * amount or balance goes to history (the last six); "closed" closes; a closed
 * line reopens only on a new amount or balance; every source is kept.
 */
export function foldFact(was: Pick<EdgeRow, "amount" | "per" | "balance" | "day" | "note" | "status" | "source" | "sources" | "history" | "first_seen" | "last_seen" | "closed_at"> | null, f: Fact, now: string): { row: FoldedEdge; changed: boolean } {
  const moved = Boolean(was && (((f.amount ?? null) !== null && f.amount !== was.amount) || ((f.balance ?? null) !== null && f.balance !== was.balance)));
  const history = [...(was?.history ?? [])];
  if (was && moved) history.push({ amount: was.amount, per: was.per, balance: was.balance, on: String(was.last_seen).slice(0, 10), source: was.source });
  const status: "active" | "closed" = f.closed ? "closed" : was?.status === "closed" && f.amount == null && f.balance == null ? "closed" : "active";
  const row: FoldedEdge = {
    amount: f.amount ?? was?.amount ?? null,
    per: f.amount != null ? (f.per ?? null) : (was?.per ?? null),
    balance: f.balance ?? was?.balance ?? null,
    day: f.day ?? was?.day ?? null,
    note: f.note ?? was?.note ?? null,
    status,
    source: f.source,
    sources: [...new Set([...(was?.sources ?? []), f.source])],
    history: history.slice(-6),
    first_seen: was?.first_seen ?? now,
    last_seen: now,
    closed_at: f.closed ? (was?.status === "closed" ? (was.closed_at ?? now) : now) : status === "closed" ? (was?.closed_at ?? null) : null,
  };
  return { row, changed: !was || moved || status !== was.status };
}

/** Writes facts learned from conversation or the connector. Never throws. Returns how many changed something. */
export async function recordFacts(businessId: string, facts: Fact[]): Promise<number> {
  let changed = 0;
  if (!facts.length) return 0;
  try {
    // Three round trips however many facts: every node at once, every edge
    // that already exists for them at once, every edge written at once. The
    // memory step runs after the reply has gone, but a slow write still holds
    // the person's queue, and the next message waits on it.
    const now = new Date().toISOString();
    const nodeRows = [...new Map(facts.map((f) => {
      const kind = REL_KIND[f.rel];
      const key = keyOf(f.label, kind);
      return [`${kind}|${key}`, { business_id: businessId, kind, key, label: f.label.slice(0, 60), updated_at: now }];
    })).values()];
    const { data: nodeData, error: nodeErr } = await db().from("kg_nodes").upsert(nodeRows, { onConflict: "business_id,kind,key" }).select("id, kind, key");
    if (nodeErr) throw nodeErr;
    const nodes = ((nodeData as { id: string; kind: NodeKind; key: string }[]) ?? []);
    const nodeId = (f: Fact) => nodes.find((n) => n.kind === REL_KIND[f.rel] && n.key === keyOf(f.label, REL_KIND[f.rel]))?.id;
    const ids = [...new Set(facts.map(nodeId).filter((x): x is string => Boolean(x)))];
    const { data: existingData } = ids.length ? await db().from("kg_edges").select("*").eq("business_id", businessId).in("dst_id", ids) : { data: [] };
    const existing = (existingData as EdgeRow[]) ?? [];
    const rows: Record<string, unknown>[] = [];
    for (const f of facts) {
      const id = nodeId(f);
      if (!id) continue;
      const was = (rows.find((r) => r.dst_id === id && r.rel === f.rel) as unknown as EdgeRow | undefined) ?? existing.find((e) => e.dst_id === id && e.rel === f.rel) ?? null;
      const { row: folded, changed: did } = foldFact(was, f, now);
      const row = { business_id: businessId, dst_id: id, rel: f.rel, ...folded };
      if (did) changed++;
      const at = rows.findIndex((r) => r.dst_id === id && r.rel === f.rel);
      if (at >= 0) rows[at] = row;
      else rows.push(row);
    }
    if (rows.length) {
      const { error } = await db().from("kg_edges").upsert(rows, { onConflict: "business_id,dst_id,rel" });
      if (error) throw error;
    }
    // Only a write that added a line can push the graph past its cap, so only
    // that write pays for the size check.
    const added = rows.filter((r) => !existing.some((e) => e.dst_id === r.dst_id && e.rel === r.rel)).length;
    if (added) {
      const { count } = await db().from("kg_edges").select("id", { count: "exact", head: true }).eq("business_id", businessId);
      if ((count ?? 0) > MAX_EDGES) await prune(businessId);
    }
    if (changed) track("memory_fact_recorded", { category: "behaviour", props: { facts: facts.length, changed, sources: [...new Set(facts.map((f) => f.source))] } });
  } catch (err) {
    console.warn("recordFacts: not kept", err);
    track("memory_fact_failed", { category: "failure", props: { facts: facts.length } });
  }
  return changed;
}

/**
 * A graph that grows for years stays bounded: at most MAX_EDGES lines per
 * household. What goes first is history (closed lines), oldest first, then
 * the least recently seen open lines. What a person said last week is never
 * what goes.
 */
export const MAX_EDGES = 250;

async function prune(businessId: string): Promise<void> {
  const { data } = await db().from("kg_edges").select("id, dst_id, status, last_seen").eq("business_id", businessId);
  const all = ((data as { id: string; dst_id: string; status: string; last_seen: string }[]) ?? []).sort(
    (a, b) => Number(a.status !== "closed") - Number(b.status !== "closed") || String(a.last_seen).localeCompare(String(b.last_seen)),
  );
  const drop = all.slice(0, Math.max(0, all.length - MAX_EDGES));
  if (!drop.length) return;
  await db().from("kg_edges").delete().eq("business_id", businessId).in("id", drop.map((d) => d.id));
  const left = new Set(all.slice(drop.length).map((e) => e.dst_id));
  const orphans = [...new Set(drop.map((d) => d.dst_id))].filter((id) => !left.has(id));
  if (orphans.length) await db().from("kg_nodes").delete().eq("business_id", businessId).in("id", orphans);
  track("memory_graph_pruned", { category: "behaviour", props: { dropped: drop.length, kept: all.length - drop.length } });
}

async function storedEdges(businessId: string): Promise<Edge[]> {
  try {
    const [{ data: nodes }, { data: edges }] = await Promise.all([
      db().from("kg_nodes").select("id, kind, key, label").eq("business_id", businessId),
      db().from("kg_edges").select("*").eq("business_id", businessId),
    ]);
    const byId = new Map(((nodes as NodeRow[]) ?? []).map((n) => [n.id, n]));
    return ((edges as EdgeRow[]) ?? [])
      .map((e): Edge | null => {
        const n = byId.get(e.dst_id);
        if (!n) return null;
        return {
          rel: e.rel, label: n.label, key: n.key, kind: n.kind,
          amount: e.amount, per: (e.per as Fact["per"]) ?? null, balance: e.balance, day: e.day, note: e.note,
          closed: e.status === "closed", source: e.source, sources: e.sources ?? [e.source], history: e.history ?? [],
          on: String(e.closed_at ?? e.last_seen).slice(0, 10),
        };
      })
      .filter((e): e is Edge => Boolean(e));
  } catch {
    return [];
  }
}

const RANK: Record<Source, number> = { said: 5, connector: 4, statement: 3, answer: 2, plan: 1 };

/** Facts become edges: one per (relation, thing), the most specific source on top, every source kept. */
export function merge(derived: Fact[], stored: Edge[]): Edge[] {
  const out = new Map<string, Edge>();
  const put = (f: Fact | Edge) => {
    const kind = REL_KIND[f.rel];
    const key = "key" in f ? f.key : keyOf(f.label, kind);
    const id = `${f.rel}|${key}`;
    const was = out.get(id);
    const sources = [...new Set([...(was?.sources ?? []), ...("sources" in f ? f.sources : [f.source])])];
    if (!was) {
      out.set(id, { ...f, key, kind, sources, history: "history" in f ? f.history : [] });
      return;
    }
    const wins = RANK[f.source] >= RANK[was.source] || "history" in f;
    const top = wins ? f : was;
    const low = wins ? was : f;
    out.set(id, {
      ...top,
      key, kind, sources,
      label: f.source === "statement" ? f.label : top.label,
      amount: top.amount ?? low.amount ?? null,
      per: top.amount != null ? top.per ?? null : low.per ?? null,
      balance: top.balance ?? low.balance ?? null,
      day: top.day ?? low.day ?? null,
      note: top.note ?? low.note ?? null,
      closed: "history" in f ? f.closed : was.closed || f.closed,
      history: "history" in f ? f.history : was.history,
    });
  };
  for (const f of derived) put(f);
  for (const e of stored) put(e);
  // A generic setup answer the statement names exactly: the statement's line stands for it.
  const edges = [...out.values()];
  return edges.filter((e) => {
    if (!e.sources.every((s) => s === "answer")) return true;
    // A setup answer's class node ("A funeral policy") once a named one of the
    // same class exists ("Old Mutual funeral cover"), from anywhere.
    const cls = classOf(e.label);
    if (cls && e.key === cls && edges.some((o) => o !== e && o.rel === e.rel && o.key !== e.key && classOf(o.label) === cls)) return false;
    // A setup answer's broad category ("A clothing or furniture account") once
    // the statement or the person names one ("Edgars account").
    const generic = Object.entries(GENERIC).find(([g]) => e.label.toLowerCase().includes(g));
    return !generic || !edges.some((o) => o !== e && o.rel === e.rel && !o.sources.every((s) => s === "answer") && generic[1].test(o.label));
  });
}

export async function householdGraph(biz: Business): Promise<HouseholdGraph> {
  const stored = await storedEdges(biz.id);
  const name = (biz.identity?.name ?? biz.context?.name ?? "").trim().split(/\s+/)[0] || null;
  return { name: name && name.toLowerCase() !== "you" ? name : null, edges: merge(derive(biz), stored) };
}

// ── Out: the prompt lines, the retrieval terms ───────────────────

export const rand = (n: number): string => `R${(Math.round(n * 100) / 100).toLocaleString("en-ZA").replace(/ |\s/g, ",")}`;

const FROM: Record<Source, string> = { said: "they said", answer: "setup answer", statement: "their statement", plan: "they chose it", connector: "their AI said" };

const VERB: Record<Rel, string> = {
  earns_from: "Money in from",
  owes: "Owes",
  supports: "Supports",
  covered_by: "Covered by",
  saves_in: "Saves in",
  banks_with: "Banks with",
  member_of: "Member of",
  pays: "Pays",
  working_towards: "Working towards",
  lives_by: "Lives by the rule",
};

const ORDER: Rel[] = ["owes", "earns_from", "supports", "pays", "covered_by", "member_of", "saves_in", "banks_with", "working_towards", "lives_by"];

export function edgeLine(e: Edge): string {
  const bits: string[] = [];
  if (e.amount != null) bits.push(`${e.rel === "earns_from" ? "" : e.rel === "owes" ? "pays " : ""}${rand(e.amount)}${e.per ? ` a ${e.per}` : ""}`.trim());
  if (e.balance != null) bits.push(`${rand(e.balance)} ${e.closed ? "was owed" : "owed"}`);
  if (e.day) bits.push(`around the ${e.day}${e.day % 10 === 1 && e.day !== 11 ? "st" : e.day % 10 === 2 && e.day !== 12 ? "nd" : e.day % 10 === 3 && e.day !== 13 ? "rd" : "th"}`);
  if (e.note && e.rel !== "lives_by") bits.push(e.note);
  const last = e.history.at(-1);
  if (last && last.amount != null && last.amount !== e.amount) bits.push(`was ${rand(last.amount)}${last.per ? ` a ${last.per}` : ""} until ${last.on}`);
  const where = e.sources.map((s) => FROM[s]).join("; ");
  const head = e.closed ? `Paid off or stopped: ${e.label}` : e.rel === "lives_by" ? `${VERB[e.rel]}: "${e.note ?? e.label}"` : `${VERB[e.rel]} ${e.label}`;
  return `${head}${bits.length ? `: ${bits.join(", ")}` : ""} (${where}${e.source === "said" || e.source === "connector" || e.closed ? `, ${e.on}` : ""})`;
}

/** Most useful first: what is still true before history, debts before bills, big before small. */
function ranked(g: HouseholdGraph): Edge[] {
  return [...g.edges].sort((a, b) => Number(Boolean(a.closed)) - Number(Boolean(b.closed)) || ORDER.indexOf(a.rel) - ORDER.indexOf(b.rel) || (b.amount ?? b.balance ?? 0) - (a.amount ?? a.balance ?? 0) || a.key.localeCompare(b.key));
}

/**
 * The lines every answer's prompt carries. Capped twice, by lines and by
 * characters, so a statement with forty debit orders cannot crowd the
 * library out of the prompt: at most six bills, the rest summed in one line.
 */
export function graphSheet(g: HouseholdGraph, max = 18, maxChars = 1800): string {
  const all = ranked(g);
  const bills = all.filter((e) => e.rel === "pays" && !e.closed);
  const keep = all.filter((e) => e.rel !== "pays" || e.closed || bills.indexOf(e) < 6);
  const lines = keep.slice(0, max).map((e) => `- ${edgeLine(e)}`);
  const rest = bills.slice(6);
  if (rest.length) lines.push(`- Pays ${rest.length} other bill${rest.length === 1 ? "" : "s"} too${rest.some((e) => e.amount != null) ? `, about ${rand(rest.reduce((a, e) => a + (e.amount ?? 0), 0))} a month together` : ""} (their statement)`);
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > maxChars) break;
    out.push(l);
    used += l.length + 1;
  }
  return out.join("\n");
}

/**
 * What the person themselves told Charles, at any time: the lines a "you
 * told me" may stand on. The reply checker sees these, so a fact said three
 * weeks ago is not cut as a false attribution just because it has scrolled
 * out of the recent conversation. Statement, plan and their-AI lines are
 * not here: "you told me" is never true of those.
 */
export function saidSheet(g: HouseholdGraph, maxChars = 1200): string {
  const lines = ranked(g)
    .filter((e) => e.sources.includes("said") || e.sources.includes("answer"))
    .map((e) => `- ${edgeLine({ ...e, sources: e.sources.filter((s) => s === "said" || s === "answer") })}`);
  let used = 0;
  return lines.filter((l) => (used += l.length + 1) <= maxChars).join("\n");
}

/**
 * The days money lands and the days money goes, from the graph: "the 3rd
 * (SASSA child support grant), the 25th (EFT from an employer)". Plain code,
 * so a check-in can name payday without a model guessing it.
 */
export function moneyDays(g: HouseholdGraph): { lands: string; goes: string } {
  const th = (d: number) => `${d}${d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th"}`;
  const list = (es: Edge[]) => [...es].sort((a, b) => (a.day ?? 0) - (b.day ?? 0)).slice(0, 5).map((e) => `the ${th(e.day!)} (${e.label})`).join(", ");
  const open = g.edges.filter((e) => !e.closed && e.day);
  return { lands: list(open.filter((e) => e.rel === "earns_from")), goes: list(open.filter((e) => e.rel === "owes" || e.rel === "pays" || e.rel === "covered_by" || e.rel === "member_of")) };
}

/** Words for the library rows about this person's own money: a tie-break, never a match on its own. */
export function graphTerms(g: HouseholdGraph): string {
  return [...new Set(g.edges.filter((e) => !e.closed && ["owes", "earns_from", "covered_by", "member_of", "supports"].includes(e.rel)).map((e) => e.key))].slice(0, 10).join(" ");
}

/** What the person's AI reads in get_household_context. */
export function graphForConnector(g: HouseholdGraph): { relation: Rel; what: string; line: string; from: Source[]; closed: boolean }[] {
  return g.edges.map((e) => ({ relation: e.rel, what: e.label, line: edgeLine(e), from: e.sources, closed: Boolean(e.closed) }));
}

/** The memory card's data (cards.ts kind "memory"): short lines, first name only, sources in plain words. */
export function memoryCardData(g: HouseholdGraph): { name: string | null; items: { group: string; label: string; line: string; from: string; closed: boolean }[] } {
  const FROM_YOU: Record<Source, string> = { said: "you said", answer: "setup answer", statement: "your statement", plan: "you chose it", connector: "your AI" };
  const sorted = [...g.edges].sort((a, b) => Number(Boolean(a.closed)) - Number(Boolean(b.closed)) || ORDER.indexOf(a.rel) - ORDER.indexOf(b.rel) || (b.amount ?? 0) - (a.amount ?? 0));
  return {
    name: g.name,
    items: sorted.slice(0, 14).map((e) => {
      const bits: string[] = [];
      if (e.amount != null) bits.push(`${rand(e.amount)}${e.per ? ` a ${e.per}` : ""}`);
      if (e.balance != null) bits.push(`${rand(e.balance)} owed`);
      if (e.rel === "lives_by" && e.note) bits.push(`"${e.note}"`);
      else if (e.note) bits.push(e.note);
      const src = e.source === "said" || e.source === "connector" ? `${FROM_YOU[e.source]}, ${e.on}` : FROM_YOU[e.source];
      return { group: e.rel, label: e.rel === "lives_by" ? "Your rule" : e.label, line: bits.join(", ") || VERB[e.rel], from: src, closed: Boolean(e.closed) };
    }),
  };
}

export type { StatementRead };
