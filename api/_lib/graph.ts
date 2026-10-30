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

export function keyOf(label: string, kind: NodeKind): string {
  for (const [re, key] of ALIASES) if (re.test(label)) return key;
  const k = label.toLowerCase().replace(STRIP, "").replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+(?:account|acc|store\s+card)$/, "");
  return k || kind;
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
const IDENTIFIER = /\b(?:\d[\s-]?){6,}\b|\b(?:pin|otp|password|cvv|id\s+number|account\s+number|card\s+number)\b/i;
/** A capitalised word that is not a place, brand or role at the start of a dependant label is probably a person's name. */
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
  const words = (t: string) => (t.toLowerCase().match(/[a-z']{3,}/g) ?? []).filter((w) => !LITTLE.has(w)).map(stem);
  const theirWords = new Set(words(said));
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
    if (rel === "supports" && !ROLE_ONLY.test(label)) {
      refused.push({ label, reason: "not_a_role" });
      continue;
    }
    const labelWords = words(label);
    if (!labelWords.some((w) => theirWords.has(w)) && !(keyOf(label, REL_KIND[rel]) !== REL_KIND[rel] && ALIASES.some(([re]) => re.test(label) && re.test(said)))) {
      refused.push({ label, reason: "not_said" });
      continue;
    }
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null);
    let amount = num(r.amount);
    let balance = num(r.balance);
    if (amount !== null && !theirFigures.has(amount)) amount = null;
    if (balance !== null && !theirFigures.has(balance)) balance = null;
    const per = r.per === "week" || r.per === "month" ? r.per : null;
    const closed = r.closed === true && CLOSING.test(said);
    const day = typeof r.day === "number" && Number.isInteger(r.day) && r.day >= 1 && r.day <= 31 && theirFigures.has(r.day) ? r.day : null;
    const note = typeof r.note === "string" ? scrubText(r.note).slice(0, 100) || null : null;
    kept.push({ rel, label, amount, per: amount !== null ? per : null, balance, day, note, closed, source, on: today });
  }
  return { kept, refused };
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

/** Writes facts learned from conversation or the connector. Never throws. Returns how many changed something. */
export async function recordFacts(businessId: string, facts: Fact[]): Promise<number> {
  let changed = 0;
  try {
    for (const f of facts) {
      const kind = REL_KIND[f.rel];
      const key = keyOf(f.label, kind);
      const { data: nodeData, error: nodeErr } = await db()
        .from("kg_nodes")
        .upsert({ business_id: businessId, kind, key, label: f.label, updated_at: new Date().toISOString() }, { onConflict: "business_id,kind,key" })
        .select("id");
      if (nodeErr) throw nodeErr;
      const node = (Array.isArray(nodeData) ? nodeData[0] : nodeData) as { id: string } | undefined;
      if (!node?.id) continue;
      const { data: existingData } = await db().from("kg_edges").select("*").eq("business_id", businessId).eq("dst_id", node.id).eq("rel", f.rel).maybeSingle();
      const was = existingData as EdgeRow | null;
      const moved = was && ((f.amount ?? null) !== null && f.amount !== was.amount || (f.balance ?? null) !== null && f.balance !== was.balance);
      const history = [...(was?.history ?? [])];
      if (was && moved) history.push({ amount: was.amount, per: was.per, balance: was.balance, on: String(was.last_seen).slice(0, 10), source: was.source });
      const row = {
        business_id: businessId,
        dst_id: node.id,
        rel: f.rel,
        amount: f.amount ?? was?.amount ?? null,
        per: f.amount != null ? (f.per ?? null) : (was?.per ?? null),
        balance: f.balance ?? was?.balance ?? null,
        day: f.day ?? was?.day ?? null,
        note: f.note ?? was?.note ?? null,
        status: f.closed ? "closed" : was?.status === "closed" && !f.amount ? "closed" : "active",
        source: f.source,
        sources: [...new Set([...(was?.sources ?? []), f.source])],
        history: history.slice(-6),
        first_seen: was?.first_seen ?? new Date().toISOString(),
        last_seen: new Date().toISOString(),
        closed_at: f.closed ? new Date().toISOString() : (was?.closed_at ?? null),
      };
      const { error } = await db().from("kg_edges").upsert(row, { onConflict: "business_id,dst_id,rel" });
      if (error) throw error;
      if (!was || moved || Boolean(f.closed) !== (was.status === "closed")) changed++;
    }
    if (changed) track("memory_fact_recorded", { category: "behaviour", props: { facts: facts.length, changed, sources: [...new Set(facts.map((f) => f.source))] } });
  } catch (err) {
    console.warn("recordFacts: not kept", err);
    track("memory_fact_failed", { category: "failure", props: { facts: facts.length } });
  }
  return changed;
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
    if (e.source !== "answer" || e.rel !== "owes") return true;
    const generic = Object.entries(GENERIC).find(([g]) => e.label.toLowerCase().includes(g));
    return !generic || !edges.some((o) => o !== e && o.rel === "owes" && o.source === "statement" && generic[1].test(o.label));
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

/** The lines every answer's prompt carries, most useful first, capped. */
export function graphSheet(g: HouseholdGraph, max = 18): string {
  const sorted = [...g.edges].sort((a, b) => Number(a.closed) - Number(b.closed) || ORDER.indexOf(a.rel) - ORDER.indexOf(b.rel) || (b.amount ?? 0) - (a.amount ?? 0));
  return sorted.slice(0, max).map((e) => `- ${edgeLine(e)}`).join("\n");
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
  const sorted = [...g.edges].sort((a, b) => Number(a.closed) - Number(b.closed) || ORDER.indexOf(a.rel) - ORDER.indexOf(b.rel) || (b.amount ?? 0) - (a.amount ?? 0));
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
