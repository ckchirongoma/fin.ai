# Charles — the knowledge graphs

Charles keeps two graphs. Both live in this repository and in Supabase. There
is no separate graph database, no Azure and no vector service beyond the
pgvector extension Supabase already has.

| | The library graph | The household graph |
|---|---|---|
| What it holds | How the 56 knowledge entries, 30 tools and 13 plan modules relate to each other | What one household's money touches: who they owe, where money comes from, who they support, their cover, stokvel, bank, goal and rule |
| Where it lives | Computed from the library rows on every load (`api/_lib/libgraph.ts`). No table. | `kg_nodes` and `kg_edges` (`db/0038_knowledge_graph.sql`), plus what is derived from the household row every time (`api/_lib/graph.ts`) |
| Who writes it | Nobody. It follows the library and the plan modules automatically. | Code (from the setup answers, the statement, the plan), the memory step after each answer, and the person's own AI through the connector's `record_fact` |
| What it improves | Retrieval: the strongest tool and entry linked to the top hits are added to the shortlist | Every answer: the prompt carries what Charles knows, each line with where it came from |
| Privacy | Reference data, public-read like the library | Service role only, never an identifier, deleted with "forget my money" |

## The library graph

Nodes are knowledge entries, tools, plan modules and the eight money areas.
Edges, with a weight each:

| Edge | Meaning | Weight | Count today |
|---|---|---|---|
| `pins` | A module's step pins this knowledge entry | 3 | 35 |
| `offers` | A module's step offers this tool | 3 | 42 |
| `used_with` | An entry and a tool pinned and offered by the same step | 3 | 51 |
| `mentions` | An entry names the tool or its web address | 2 | 41 |
| `related` | Two rows share keywords (two anywhere, or one in the same money area) | 1 per keyword | 50 |
| `in` | A row or module belongs to a money area | 1 | 99 |

After the keyword shortlist picks its rows, `neighboursFor()` adds at most one
tool (the strongest linked to the top entry) and one entry (the strongest
linked to the top tool), after the keyword rows, so nothing the keywords found
is ever pushed out. A question about listing debts now also brings the money
log tool the debt-list module uses, without anyone adding a keyword.

`test/knowledge-graph.test.ts` pins the counts as floors and fails if more
than a handful of rows have no link but their money area: those rows are the
next thing to connect, in the same way the held-out misses are the next
thing to research.

## The household graph

The person is the centre. Every edge is one of: `owes`, `earns_from`,
`supports`, `covered_by`, `member_of`, `saves_in`, `banks_with`, `pays`,
`working_towards`, `lives_by`. An edge carries what is paid or received each
time (`amount`, `per`), what is still owed (`balance`), the day of the month,
a short note, whether it is closed (paid off or stopped), every source that
told Charles about it, and the last few amounts it had.

### Where each line comes from

| Source | Written by | How it is said back |
|---|---|---|
| `answer` | Code, from the twelve setup answers | "you told me" is allowed (it is in their setup answers) |
| `statement` | Code, from the bank statement, payslip or credit report they chose to send | "your statement shows", never "you said" |
| `plan` | Code, from the goal and the rule they chose | "the goal you chose" |
| `said` | The memory step after an answer, checked in code | "you told me", with the date |
| `connector` | Their own AI, through `record_fact`, checked the same way | "your AI passed on" |

### What the memory step may not do

The memory model proposes facts; `graphUpdates()` keeps one only when:

- the person's own stated words (not a question they asked) share a word with it;
- every figure on it is a figure they typed (an amount they did not type is dropped, the fact kept);
- "paid off" is only kept when they used a word for paying off, cancelling or stopping;
- for who they support, it is a role ("my mother"), never a person's name;
- nothing on it is shaped like an ID, account, card or reference number.

A refused fact is counted (`memory_fact_refused`) and never stored. A tap or
a forwarded page never teaches the graph.

### What it changes in a conversation

- Every answer's prompt carries the lines (`graphSheet()`), and the rule that
  "you told me" is only for lines marked "they said" or "setup answer".
- The person's own creditors, grants and cover tip the shortlist toward the
  library rows about them (`graphTerms()`): a tie-break, never a match alone.
- A changed amount keeps the old one ("was R200 a week until 2 Nov"), so
  Charles can notice progress and say so.
- "What do you know about me?" draws it as the memory card: the person in the
  middle, everything their money touches around them, each with its source.
- Their own AI reads it in `get_household_context` as `memory_graph`.

### Checking it in Supabase

After a test journey, in the SQL Editor:

```sql
select n.kind, n.label, e.rel, e.amount, e.per, e.balance, e.status, e.sources, e.last_seen
from public.kg_edges e join public.kg_nodes n on n.id = e.dst_id
order by e.last_seen desc limit 20;
```

Lines from the setup answers and the statement are derived every time and
appear in Supabase once something is learned about the same thing in
conversation; lines learned in conversation are only ever in these tables.
