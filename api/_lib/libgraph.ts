// Charles — the library as a knowledge graph.
//
// The library is 56 knowledge entries and 30 tools, and the plan library is
// thirteen modules whose steps pin knowledge rows and offer tools. Until now
// each row was retrieved on its own: a question about a mashonisa found the
// rights entry and stopped there, though the NCR complaint tool, the debt
// list and the module that uses all three belong with it. This file draws
// the lines between them, in plain code, every time the library loads. There
// is nothing to migrate and nothing for a model to invent.
//
// Nodes: knowledge rows (k.*), tools (by id), modules (m_*), the eight money
// areas (domain:*).
// Edges, each with a weight:
//   pins      module → knowledge   a step in the module pins the row            (3)
//   offers    module → tool        a step in the module offers the tool          (3)
//   used_with knowledge ↔ tool     pinned and offered by the same step           (3)
//   mentions  knowledge → tool     the entry names the tool or its web address   (2)
//   related   row ↔ row            keywords in common (two, or one in the same    (1 each)
//                                  money area), weight per keyword
//   in        row/module → domain  the money area it belongs to                  (1)
//
// What it is used for:
//   1. neighboursFor(): after the keyword shortlist, the strongest tool linked
//      to the top entry, and the strongest entry linked to the top tool, are
//      added when missing. At most one of each, after the shortlist's own rows,
//      so nothing the keywords found is ever pushed out (engine/context.ts).
//   2. related(): the connector's find_knowledge returns "see also" lines.
//   3. stats(): docs/KNOWLEDGE-GRAPH.md and test/knowledge-graph.test.ts.

import { MODULES } from "./playbooks.js";
import type { KnowledgeRow, ToolRow } from "./types.js";

export type LibRel = "pins" | "offers" | "used_with" | "mentions" | "related" | "in";

export interface LibEdge {
  from: string;
  to: string;
  rel: LibRel;
  weight: number;
}

export interface LibGraph {
  country: string;
  nodes: Map<string, { id: string; type: "knowledge" | "tool" | "module" | "domain"; label: string; domain?: string }>;
  edges: LibEdge[];
  /** Every edge touching a node, both directions, strongest first. */
  adj: Map<string, LibEdge[]>;
}

const host = (u: string | null | undefined): string | null => {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, "").toLowerCase() : null;
  } catch {
    return null;
  }
};

const textOf = (k: KnowledgeRow): string => JSON.stringify([k.title, (k as unknown as Record<string, unknown>).owner_summary, (k as unknown as Record<string, unknown>).applies_when, (k as unknown as Record<string, unknown>).steps, k.cost]).toLowerCase();

/** Words too common in this library to say two rows are about the same thing. */
const COMMON = new Set(["money", "pay", "free", "bank", "south africa", "rand", "month", "save", "saving", "savings", "debt", "loan", "account"]);

export function buildLibraryGraph(knowledge: KnowledgeRow[], tools: ToolRow[], country: string): LibGraph {
  const nodes: LibGraph["nodes"] = new Map();
  const edges: LibEdge[] = [];
  const add = (from: string, to: string, rel: LibRel, weight: number) => {
    if (from !== to && nodes.has(from) && nodes.has(to)) edges.push({ from, to, rel, weight });
  };

  const ks = knowledge.filter((k) => k.country === country);
  const ts = tools.filter((t) => t.country === country);
  for (const k of ks) nodes.set(k.id, { id: k.id, type: "knowledge", label: k.title, domain: k.domain ?? undefined });
  for (const t of ts) nodes.set(t.id, { id: t.id, type: "tool", label: t.name, domain: t.domain ?? undefined });
  for (const d of new Set([...ks, ...ts].map((r) => r.domain).filter((d): d is string => Boolean(d)))) nodes.set(`domain:${d}`, { id: `domain:${d}`, type: "domain", label: d });

  // The plan library: what the fixed modules already say belongs together.
  for (const m of Object.values(MODULES)) {
    nodes.set(m.id, { id: m.id, type: "module", label: m.title, domain: m.domain });
    add(m.id, `domain:${m.domain}`, "in", 1);
    for (const st of m.steps) {
      const kids = (st.knowledge_ids ?? []).filter((id) => nodes.has(id));
      const tids = (st.tool_choices ?? []).filter((id) => nodes.has(id));
      for (const k of kids) add(m.id, k, "pins", 3);
      for (const t of tids) add(m.id, t, "offers", 3);
      for (const k of kids) for (const t of tids) add(k, t, "used_with", 3);
    }
  }

  // An entry that names a tool, or its web address, is about using it.
  for (const k of ks) {
    const text = textOf(k);
    for (const t of ts) {
      const name = t.name.toLowerCase();
      const h = host(t.url);
      if ((name.length >= 5 && text.includes(name)) || (h && h.length >= 6 && text.includes(h))) add(k.id, t.id, "mentions", 2);
    }
  }

  // Shared keywords, the library's own vocabulary for what a row is about.
  // Two in common anywhere, or one in common inside the same money area.
  const rows = [...ks.map((r) => ({ id: r.id, kw: r.keywords ?? [], domain: r.domain })), ...ts.map((r) => ({ id: r.id, kw: r.keywords ?? [], domain: r.domain }))];
  for (let i = 0; i < rows.length; i++) {
    const a = new Set(rows[i]!.kw.map((w) => w.toLowerCase()).filter((w) => !COMMON.has(w)));
    for (let j = i + 1; j < rows.length; j++) {
      const shared = rows[j]!.kw.map((w) => w.toLowerCase()).filter((w) => a.has(w));
      const n = new Set(shared).size;
      if (n >= 2 || (n === 1 && rows[i]!.domain === rows[j]!.domain)) add(rows[i]!.id, rows[j]!.id, "related", n);
    }
  }
  for (const r of [...ks, ...ts]) add(r.id, `domain:${r.domain}`, "in", 1);

  // One edge per pair and relation: the strongest reading wins.
  const best = new Map<string, LibEdge>();
  for (const e of edges) {
    const key = `${e.rel}|${[e.from, e.to].sort().join("|")}`;
    const was = best.get(key);
    if (!was || e.weight > was.weight) best.set(key, e);
  }
  const unique = [...best.values()];
  const adj: LibGraph["adj"] = new Map();
  for (const e of unique) {
    for (const end of [e.from, e.to]) {
      if (!adj.has(end)) adj.set(end, []);
      adj.get(end)!.push(e);
    }
  }
  for (const list of adj.values()) list.sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { country, nodes, edges: unique, adj };
}

const cache = new Map<string, { sig: string; graph: LibGraph }>();

/** Built once per library version (ids and verified_on dates), per country. */
export function libraryGraph(knowledge: KnowledgeRow[], tools: ToolRow[], country: string): LibGraph {
  const sig = `${knowledge.length}:${tools.length}:${knowledge.map((k) => `${k.id}@${k.verified_on}`).join(",").length}:${tools.map((t) => `${t.id}@${t.verified_on}`).join(",").length}`;
  const hit = cache.get(country);
  if (hit && hit.sig === sig) return hit.graph;
  const graph = buildLibraryGraph(knowledge, tools, country);
  cache.set(country, { sig, graph });
  return graph;
}

/** The ids linked to one row, strongest first, of the given node type. Modules and domains are routes, not answers. */
export function related(g: LibGraph, id: string, type: "knowledge" | "tool", limit = 3): { id: string; label: string; rel: LibRel; weight: number }[] {
  const out: { id: string; label: string; rel: LibRel; weight: number }[] = [];
  for (const e of g.adj.get(id) ?? []) {
    if (e.rel === "in") continue;
    const other = e.from === id ? e.to : e.from;
    const node = g.nodes.get(other);
    if (!node || node.type !== type || out.some((o) => o.id === other)) continue;
    out.push({ id: other, label: node.label, rel: e.rel, weight: e.weight });
    if (out.length >= limit) break;
  }
  // Two rows used in the same module are linked through it even without a direct edge.
  if (out.length < limit) {
    for (const e of g.adj.get(id) ?? []) {
      if (e.rel !== "pins" && e.rel !== "offers") continue;
      const mod = e.from === id ? e.to : e.from;
      for (const f of g.adj.get(mod) ?? []) {
        if (f.rel !== "pins" && f.rel !== "offers") continue;
        const other = f.from === mod ? f.to : f.from;
        const node = g.nodes.get(other);
        if (other === id || !node || node.type !== type || out.some((o) => o.id === other)) continue;
        out.push({ id: other, label: node.label, rel: "used_with", weight: 1 });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/**
 * The rows the graph would add to a shortlist: the strongest tool linked to
 * the top knowledge entry, and the strongest entry linked to the top tool,
 * when each is not already there. Appended, never inserted, so the keyword
 * pass keeps every row it chose.
 */
export function neighboursFor(
  g: LibGraph,
  picked: { knowledge: KnowledgeRow[]; tools: ToolRow[] },
  all: { knowledge: KnowledgeRow[]; tools: ToolRow[] },
): { knowledge: KnowledgeRow[]; tools: ToolRow[] } {
  const haveK = new Set(picked.knowledge.map((k) => k.id));
  const haveT = new Set(picked.tools.map((t) => t.id));
  const addT: ToolRow[] = [];
  const addK: KnowledgeRow[] = [];
  const topK = picked.knowledge[0];
  if (topK) {
    const t = related(g, topK.id, "tool", 5).find((r) => !haveT.has(r.id) && r.weight >= 2);
    const row = t && all.tools.find((x) => x.id === t.id);
    if (row) addT.push(row);
  }
  const topT = picked.tools[0];
  if (topT) {
    const k = related(g, topT.id, "knowledge", 5).find((r) => !haveK.has(r.id) && r.weight >= 2);
    const row = k && all.knowledge.find((x) => x.id === k.id);
    if (row) addK.push(row);
  }
  return { knowledge: addK, tools: addT };
}

export function stats(g: LibGraph): { nodes: Record<string, number>; edges: Record<LibRel, number>; isolated: string[]; toolsUnreached: string[] } {
  const nodes: Record<string, number> = {};
  for (const n of g.nodes.values()) nodes[n.type] = (nodes[n.type] ?? 0) + 1;
  const edges = { pins: 0, offers: 0, used_with: 0, mentions: 0, related: 0, in: 0 } as Record<LibRel, number>;
  for (const e of g.edges) edges[e.rel]++;
  const meaningful = (id: string) => (g.adj.get(id) ?? []).some((e) => e.rel !== "in");
  const isolated = [...g.nodes.values()].filter((n) => (n.type === "knowledge" || n.type === "tool") && !meaningful(n.id)).map((n) => n.id).sort();
  const toolsUnreached = [...g.nodes.values()]
    .filter((n) => n.type === "tool" && !(g.adj.get(n.id) ?? []).some((e) => e.rel === "offers" || e.rel === "mentions" || e.rel === "used_with"))
    .map((n) => n.id)
    .sort();
  return { nodes, edges, isolated, toolsUnreached };
}
