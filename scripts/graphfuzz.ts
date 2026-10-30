// Charles — the knowledge graph, fuzzed.
//
// Random households, random messages, random model proposals, thrown at the
// graph's pure core (graphUpdates → foldFact → merge → graphSheet / saidSheet
// / actionsFor) for as many journeys as asked, with every invariant the
// product depends on checked after every turn. Seeded, so a failure is
// reproducible from its seed and journey number.
//
//   node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/fuzz-graph.ts [journeys] [seed]
//
// test/knowledge-graph-fuzz.test.ts runs a few thousand journeys on every
// test run; the script runs a million.
//
// The messages are built to be the most random a real WhatsApp line gets:
// truthful facts, negated ones, supposed ones, other people's debts, payoffs,
// "stopped paying", questions, identifiers, PINs, emoji, isiZulu and
// Afrikaans words, numbers in every format, empty strings, ten-thousand
// character pastes, control characters and odd unicode. The proposals are
// what a confused or hostile model returns: faithful ones, invented labels,
// invented amounts, wrong relations, strings for numbers, negative and
// non-finite numbers, nested objects, nulls, huge arrays.

import { actionsFor } from "../api/_lib/graphactions.ts";
import { classOf, derive, foldFact, graphSheet, graphUpdates, keyOf, merge, REL_KIND, saidSheet, type Edge, type Fact, type FoldedEdge, type Rel } from "../api/_lib/graph.ts";
import { figuresFrom } from "../api/_lib/grounding.ts";

// ── A seeded generator ───────────────────────────────────────────

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type R = () => number;
const pick = <T>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const chance = (r: R, p: number): boolean => r() < p;
const int = (r: R, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

const CREDITORS = ["the mashonisa", "a loan shark", "Edgars", "Edgars account", "Jet", "Capfin", "FinChoice", "Wonga", "my cellphone contract", "Vodacom", "Truworths", "Lewis", "African Bank", "the spaza", "my landlord", "Mashonisa (cash send)", "TFG", "Mr Price"];
const INCOME = ["SASSA grant", "child support grant", "the salon", "my wages", "piece jobs", "my boss", "the restaurant", "EFT from an employer", "old age grant", "SRD"];
const ROLES = ["my mother", "my mom", "my gogo", "my sister", "my brother", "my two children", "the kids", "my son", "my daughter", "my partner", "my husband", "my cousin"];
const NAMES = ["Thabo", "Nomvula Dlamini", "Sipho", "Lindiwe", "Mama Joyce", "Bongani"];
const COVER = ["Old Mutual funeral cover", "Avbob funeral policy", "a funeral policy", "the burial society", "medical aid", "Hollard funeral plan"];
const GROUPS = ["a stokvel", "the stokvel at church", "a burial society", "the savings club", "a grocery stokvel"];
const SAVES = ["a GoalSave pocket", "a savings pocket", "my TFSA", "a jar at home", "the stokvel"];
const BILLS = ["rent", "electricity", "school fees", "the taxi", "DStv", "water"];
const ZULU = ["sawubona", "ngiyabonga", "imali", "eish", "yebo", "hayi", "baie dankie", "ja nee", "ayikho", "kodwa"];
const EMOJI = ["🙏", "😭", "💰", "👍🏾", "🔥", "😅", "❤️", "✅"];
const ODD = ["​", "‮", "\u0000", "\t", "\r\n", "﻿", "ｒ５００", "R‎500", "Ｒ1 000"];

function amountText(r: R): { text: string; n: number } {
  const n = pick(r, [50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800, 1000, 1200, 1500, 2000, 2500, 3600, 4800, 5000, 12000]);
  const fmt = n >= 1000 ? pick(r, [`R${n.toLocaleString("en-ZA").replace(/\s/g, ",")}`, `R${n}`, `R${String(n).replace(/(\d)(?=(\d{3})+$)/g, "$1 ")}`, `${n} rand`, `R ${n}`]) : pick(r, [`R${n}`, `R ${n}`, `${n} rand`, `R${n}.00`]);
  return { text: fmt, n };
}

const PERS = ["a week", "a month", "every Friday", "per month", "monthly", "each week", ""] as const;
const per = (r: R) => pick(r, PERS);
/** What a faithful model would say the period is, from the words. */
const perOf = (p: string): "week" | "month" | null => (/week|friday/i.test(p) ? "week" : /month/i.test(p) ? "month" : null);

/** One message, and the facts a faithful model would honestly propose from it. */
export function message(r: R): { said: string; honest: unknown[]; kind: string } {
  const a = amountText(r);
  const kind = pick(r, ["owe", "owe", "pay_off", "stopped", "support", "income", "cover", "group", "save", "bill", "negated", "hypothetical", "someone_else", "question", "identifier", "name", "noise", "long", "empty", "unicode"]);
  const c = pick(r, CREDITORS);
  switch (kind) {
    case "owe": { const p = per(r); return { said: `I pay ${c} ${a.text} ${p}.`, honest: [{ relation: "owes", object: c, amount: a.n, per: perOf(p) }], kind }; }
    case "pay_off": return { said: pick(r, [`I paid off ${c}!`, `${c} is settled now.`, `I don't owe ${c} anymore.`, `Finished paying ${c} last week ${pick(r, EMOJI)}`]), honest: [{ relation: "owes", object: c, closed: true }], kind };
    case "stopped": return { said: pick(r, [`I stopped paying ${c}.`, `I can't pay ${c} this month.`, `I missed paying ${c}.`]), honest: [{ relation: "owes", object: c, closed: true }], kind };
    case "support": { const who = pick(r, ROLES); const p = per(r); return { said: `I send ${who} ${a.text} ${p}.`, honest: [{ relation: "supports", object: who, amount: a.n, per: perOf(p) }], kind }; }
    case "income": { const i = pick(r, INCOME); const p = per(r); return { said: `I get ${a.text} from ${i} ${p}.`, honest: [{ relation: "earns_from", object: i, amount: a.n, per: perOf(p) }], kind }; }
    case "cover": { const v = pick(r, COVER); return { said: `I pay ${a.text} for ${v}.`, honest: [{ relation: "covered_by", object: v, amount: a.n, per: "month" }], kind }; }
    case "group": { const g = pick(r, GROUPS); const p = per(r); return { said: `I joined ${g}, ${a.text} ${p}.`, honest: [{ relation: "member_of", object: g, amount: a.n, per: perOf(p) }], kind }; }
    case "save": { const s = pick(r, SAVES); const p = per(r); return { said: `I put ${a.text} into ${s} ${p}.`, honest: [{ relation: "saves_in", object: s, amount: a.n, per: perOf(p) }], kind }; }
    case "bill": { const b = pick(r, BILLS); const p = per(r); return { said: `My ${b} is ${a.text} ${p}.`, honest: [{ relation: "pays", object: b, amount: a.n, per: perOf(p) }], kind }; }
    case "negated": return { said: pick(r, [`I never borrowed from ${c}.`, `I don't have ${pick(r, COVER)}.`, `I have never been in ${pick(r, GROUPS)}.`]), honest: [], kind };
    case "hypothetical": return { said: pick(r, [`If I took ${a.text} from ${c}, what would it cost?`, `I'm thinking of joining ${pick(r, GROUPS)}.`, `Should I borrow ${a.text} from ${c}?`, `Maybe I could get ${a.text} from ${c}.`]), honest: [], kind };
    case "someone_else": return { said: pick(r, [`My sister owes ${c} ${a.text}.`, `My brother pays ${c} ${a.text} a week.`, `She borrowed ${a.text} from ${c}.`]), honest: [], kind };
    case "question": return { said: pick(r, [`What can ${c} do if I miss a week?`, `How do I get my credit report?`, `Is ${c} legal?`, `how am i doing?`]), honest: [], kind };
    case "identifier": return { said: pick(r, [`My account is 1234 5678 9012, I owe ${c} ${a.text}.`, `My ID number is 8001015009087.`, `PIN 4321 for ${c}`, `card 5412 7512 3412 3456`]), honest: [], kind };
    case "name": { const n = pick(r, NAMES); return { said: `I give ${n} ${a.text} a month.`, honest: [], kind }; }
    case "noise": return { said: Array.from({ length: int(r, 1, 6) }, () => pick(r, [...ZULU, ...EMOJI])).join(" "), honest: [], kind };
    case "long": return { said: `${pick(r, ZULU)} `.repeat(int(r, 200, 2000)) + `I pay ${c} ${a.text} a week.`, honest: [{ relation: "owes", object: c, amount: a.n, per: "week" }], kind };
    case "empty": return { said: pick(r, ["", " ", "\n", "?", "..."]), honest: [], kind };
    default: return { said: `${pick(r, ODD)}I pay ${c}${pick(r, ODD)} ${a.text}${pick(r, ODD)}`, honest: [], kind };
  }
}

const RELS_ALL = ["owes", "earns_from", "supports", "covered_by", "saves_in", "banks_with", "member_of", "pays", "working_towards", "lives_by", "owns", "", "OWES", null, 7];

/** What a model proposes: sometimes faithful, sometimes invented, sometimes garbage. */
export function proposals(r: R, honest: unknown[]): unknown {
  const mode = pick(r, ["faithful", "faithful", "faithful", "invent", "garbage", "mixed", "empty", "huge"]);
  const invent = () => ({
    relation: pick(r, RELS_ALL),
    object: pick(r, [...CREDITORS, ...ROLES, ...NAMES, ...COVER, "", "x".repeat(int(r, 1, 300)), "account 4111111111111111", null, 12, { nested: true }]),
    amount: pick(r, [amountText(r).n, -50, 0, NaN, Infinity, "300", null, 1e12, 0.001, undefined]),
    per: pick(r, ["week", "month", "day", "year", null, 5]),
    balance: pick(r, [null, amountText(r).n, -1, "800"]),
    day: pick(r, [null, 3, 25, 0, 32, 2.5, "3"]),
    closed: pick(r, [true, false, "yes", null]),
    note: pick(r, [null, "fine", "PIN 1234", "x".repeat(500), "<script>alert(1)</script>"]),
  });
  switch (mode) {
    case "faithful": return honest;
    case "invent": return Array.from({ length: int(r, 1, 4) }, invent);
    case "mixed": return [...honest, ...Array.from({ length: int(r, 0, 3) }, invent)];
    case "empty": return pick(r, [[], null, undefined, {}, "nothing"]);
    case "huge": return Array.from({ length: int(r, 20, 60) }, invent);
    default: return pick(r, ["[]", 42, { relation: "owes" }, [null, null], [[{}]], true]);
  }
}

/** Setup answers and a statement for a random household. */
export function household(r: R): Parameters<typeof derive>[0] {
  const owes = ["A bank loan or card", "A clothing or furniture account", "A cellphone contract", "A mashonisa", "Stokvel, family or friends", "Nobody"].filter(() => chance(r, 0.35)).join(", ");
  const statement = chance(r, 0.4)
    ? {
        doc: "bank_statement" as const, source: pick(r, ["Capitec", "GoTyme", "FNB", null]), period: "Oct 2026",
        money_in: Array.from({ length: int(r, 0, 4) }, () => ({ label: pick(r, INCOME), amount: amountText(r).n, day: chance(r, 0.6) ? int(r, 1, 28) : null })),
        money_out: Array.from({ length: int(r, 0, 45) }, () => ({ label: pick(r, [...CREDITORS, ...COVER, ...BILLS, "Shoprite", "Bank fees"]), amount: amountText(r).n, day: chance(r, 0.5) ? int(r, 1, 28) : null, kind: pick(r, ["loan", "store_account", "insurance", "rent", "electricity", "debit_order", "groceries", "bank_fees", "stokvel", "family", "other"]) as never })),
        totals: { in: null, out: null, fees: null, cash: null, closing: null }, days_below_zero: null, flags: [], unclear: null, read_on: "2026-11-01",
      }
    : null;
  return {
    answers: { owes, depends: chance(r, 0.5) ? "Children, Parents or elders" : "Just me", cover: chance(r, 0.5) ? "Funeral policy" : "None", income_kind: chance(r, 0.5) ? "Salary or wage, SASSA grant" : "Piece jobs or hustle", objective: chance(r, 0.5) ? "Pay off the mashonisa, R200 a week on R800" : pick(r, ["", "save R1,000", "🙏"]) },
    identity: null,
    statement,
    goal: chance(r, 0.6) ? [{ label: "R1,000 by Christmas", what: "R1,000 in a pocket", why_you: "", worth: "", first_move: "", catch: "" }] : null,
    rule: chance(r, 0.6) ? [{ label: "Payday first", rule: "The fixed things get paid first.", why_it_works: "", what_it_costs_you: null }] : null,
    created_at: "2026-10-01T00:00:00Z",
  } as never;
}

// ── The invariants ───────────────────────────────────────────────

const IDENTIFIER = /\b(?:\d[\s-]?){6,}\b|\b(?:pin|otp|password|cvv)\b/i;
const BAD_TEXT = /\b(?:undefined|NaN|Infinity|\[object Object\])\b|null(?!\w)/;
const SOURCE_PHRASE = /\((?:they said|setup answer|their statement|they chose it|their AI said)/;
const CREDIT = /\b(?:take a loan|get a loan|consolidat\w*|borrow (?:more|again|from)|credit card|overdraft|cash advance|buy now)\b/i;

export interface FuzzStats {
  journeys: number;
  turns: number;
  kept: number;
  refused: Record<string, number>;
  actions: Record<string, number>;
  maxEdges: number;
  maxSheet: number;
  violations: string[];
  ms: number;
}

function check(cond: boolean, what: string, ctx: string, out: string[]): void {
  if (!cond && out.length < 50) out.push(`${what} :: ${ctx}`);
}

/** One household, `turns` messages, every invariant checked after each. */
export function journey(seed: number, turns: number, stats: FuzzStats): void {
  const r = rng(seed);
  const biz = household(r);
  const stored = new Map<string, { rel: Rel; label: string; kind: string; key: string; row: FoldedEdge }>();
  let clock = Date.parse("2026-10-01T08:00:00Z");
  const fired = new Set<string>();

  for (let t = 0; t < turns; t++) {
    clock += int(r, 1, 72) * 36e5;
    const now = new Date(clock).toISOString();
    const today = now.slice(0, 10);
    const m = message(r);
    const ctx = `seed=${seed} turn=${t} kind=${m.kind} said=${JSON.stringify(m.said.slice(0, 120))}`;
    const raw = proposals(r, m.honest);
    let res: ReturnType<typeof graphUpdates>;
    try {
      res = graphUpdates(raw, m.said, today, chance(r, 0.1) ? "connector" : "said");
    } catch (err) {
      check(false, `graphUpdates threw ${(err as Error).message}`, ctx, stats.violations);
      continue;
    }
    stats.turns++;
    stats.kept += res.kept.length;
    for (const x of res.refused) stats.refused[x.reason] = (stats.refused[x.reason] ?? 0) + 1;
    const figures = figuresFrom(m.said);

    for (const f of res.kept) {
      check(Object.prototype.hasOwnProperty.call(REL_KIND, f.rel) && f.rel !== "working_towards" && f.rel !== "lives_by", `bad relation ${f.rel}`, ctx, stats.violations);
      check(f.label.length > 0 && f.label.length <= 48, `label length ${f.label.length}`, ctx, stats.violations);
      check(!IDENTIFIER.test(f.label) && !IDENTIFIER.test(f.note ?? ""), `identifier kept: ${f.label} / ${f.note}`, ctx, stats.violations);
      for (const n of [f.amount, f.balance]) check(n == null || (Number.isFinite(n) && n > 0 && figures.has(n)), `figure not typed: ${n}`, ctx, stats.violations);
      check(f.day == null || (Number.isInteger(f.day) && f.day >= 1 && f.day <= 31), `bad day ${f.day}`, ctx, stats.violations);
      check(f.amount != null || f.per == null, "per without amount", ctx, stats.violations);
      const wordsPer = /\b(?:a|per|every|each)\s+(?:week|friday)\b|\bweekly\b/i.test(m.said) ? "week" : /\b(?:a|per|every|each)\s+month\b|\bmonthly\b/i.test(m.said) ? "month" : null;
      check(f.amount == null || !wordsPer || f.per === wordsPer, `per ${f.per} but the words say ${wordsPer}`, ctx, stats.violations);
      check(!(f.rel === "owes" && f.closed && /\b(?:stopped|can'?t|cannot|missed|skipped)\s+pay/i.test(m.said)), "stopped paying closed a debt", ctx, stats.violations);
      check(!(f.rel === "owes" && m.kind === "someone_else"), "someone else's debt kept", ctx, stats.violations);
      check(!(m.kind === "negated" && !f.closed), "negated fact kept", ctx, stats.violations);
      check(!(m.kind === "hypothetical" && !f.closed), "hypothetical fact kept", ctx, stats.violations);
      check(f.rel !== "supports" || !NAMES.some((n) => f.label.includes(n)), `a name kept for a dependant: ${f.label}`, ctx, stats.violations);
      const k = keyOf(f.label, REL_KIND[f.rel]);
      const typedWords = new Set((m.said.toLowerCase().match(/[a-z']{3,}/g) ?? []).map((w) => w.slice(0, 5)));
      const keyed = (k.match(/[a-z']{3,}/g) ?? []).filter((w) => !["the", "and", "from", "for", "with", "our", "her", "his"].includes(w));
      check(classOf(f.label) === k || keyed.every((w) => typedWords.has(w.slice(0, 5))), `a label not backed by their words: ${f.label}`, ctx, stats.violations);
      check(k.length > 0 && k.length <= 60 && /^[a-z0-9 ]+$/.test(k), `bad key ${JSON.stringify(k)}`, ctx, stats.violations);
      check(keyOf(f.label, REL_KIND[f.rel]) === k, "keyOf not deterministic", ctx, stats.violations);

      const id = `${REL_KIND[f.rel]}|${k}|${f.rel}`;
      const was = stored.get(id)?.row ?? null;
      const { row } = foldFact(was, f, now);
      check((row.history ?? []).length <= 6, "history over six", ctx, stats.violations);
      check(row.status === "active" || row.status === "closed", "bad status", ctx, stats.violations);
      check(row.amount == null || (Number.isFinite(row.amount) && row.amount >= 0), `bad stored amount ${row.amount}`, ctx, stats.violations);
      stored.set(id, { rel: f.rel, label: f.label, kind: REL_KIND[f.rel], key: k, row });
    }

    // Reading back: the merged graph, the prompt block, the evidence, the actions.
    const asEdges: Edge[] = [...stored.values()].map((s) => ({
      rel: s.rel, label: s.label, key: s.key, kind: s.kind as Edge["kind"],
      amount: s.row.amount, per: (s.row.per as Fact["per"]) ?? null, balance: s.row.balance, day: s.row.day, note: s.row.note,
      closed: s.row.status === "closed", source: s.row.source, sources: s.row.sources ?? [s.row.source], history: s.row.history ?? [],
      on: String(s.row.closed_at ?? s.row.last_seen).slice(0, 10),
    }));
    let edges: Edge[];
    try {
      edges = merge(derive(biz), asEdges);
    } catch (err) {
      check(false, `merge threw ${(err as Error).message}`, ctx, stats.violations);
      continue;
    }
    const again = merge(derive(biz), [...asEdges].reverse());
    const sig = (es: Edge[]) => es.map((e) => `${e.rel}|${e.key}|${e.amount}|${e.closed}`).sort().join(";");
    check(sig(edges) === sig(again), "merge depends on the order it is given", ctx, stats.violations);
    const ids = edges.map((e) => `${e.rel}|${e.key}`);
    check(new Set(ids).size === ids.length, "two edges for one thing", ctx, stats.violations);
    stats.maxEdges = Math.max(stats.maxEdges, edges.length);

    const g = { name: "Nomsa", edges };
    const sheet = graphSheet(g);
    stats.maxSheet = Math.max(stats.maxSheet, sheet.length);
    check(sheet.length <= 1800, `sheet ${sheet.length} chars`, ctx, stats.violations);
    check(sheet.split("\n").filter(Boolean).length <= 19, "sheet over 19 lines", ctx, stats.violations);
    for (const line of sheet.split("\n").filter(Boolean)) {
      check(!BAD_TEXT.test(line), `bad text in sheet: ${line}`, ctx, stats.violations);
      check(SOURCE_PHRASE.test(line), `a line with no source: ${line}`, ctx, stats.violations);
      check(!IDENTIFIER.test(line.replace(/R[\d,]+(?:\.\d+)?/g, "").replace(/\d{4}-\d{2}-\d{2}/g, "")), `identifier in sheet: ${line}`, ctx, stats.violations);
    }
    const told = saidSheet(g);
    check(!/their statement|their AI said|they chose it/.test(told), "evidence holds a line they did not say", ctx, stats.violations);
    check(told.length <= 1200, "evidence over its cap", ctx, stats.violations);

    for (const a of actionsFor(g)) {
      stats.actions[a.trigger] = (stats.actions[a.trigger] ?? 0) + 1;
      check(!BAD_TEXT.test(a.text), `bad text in action: ${a.text}`, ctx, stats.violations);
      check(!CREDIT.test(a.text), `action points at credit: ${a.text}`, ctx, stats.violations);
      check(a.buttons.length >= 1 && a.buttons.length <= 3, "action buttons", ctx, stats.violations);
      for (const b of a.buttons) check(b.title.length <= 20 && b.id.length <= 200 && /^a\.(?:q\.k:|kg\.card:)/.test(b.id), `bad button ${JSON.stringify(b)}`, ctx, stats.violations);
      // Every rand figure in an action is the graph's own, or 13 weeks / 3 months of one.
      const own = new Set<number>();
      for (const e of edges) for (const n of [e.amount, e.balance, ...e.history.map((h) => h.amount)]) if (n != null) { own.add(n); own.add(Math.round(n * 13 * 100) / 100); own.add(Math.round(n * 3 * 100) / 100); }
      for (const m2 of a.text.matchAll(/R([\d,]+(?:\.\d+)?)/g)) { const n = Number(m2[1]!.replace(/,/g, "")); check(own.has(n), `action figure R${n} not the graph's own`, ctx, stats.violations); }
      const id = `${a.trigger}|${a.subject}`;
      check(a.subject.length > 0, "empty subject", ctx, stats.violations);
      fired.add(id);
    }
  }
  stats.journeys++;
}

export function fuzz(journeys: number, seed = 1, turns = 12): FuzzStats {
  const stats: FuzzStats = { journeys: 0, turns: 0, kept: 0, refused: {}, actions: {}, maxEdges: 0, maxSheet: 0, violations: [], ms: 0 };
  const t0 = performance.now();
  for (let j = 0; j < journeys; j++) {
    journey(seed * 1_000_003 + j, turns, stats);
    if (stats.violations.length >= 50) break;
  }
  stats.ms = performance.now() - t0;
  return stats;
}
