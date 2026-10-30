// Types for scripts/apply-knowledge.mjs, so test/vat-knowledge.test.ts can
// import it under `strict` without the script itself becoming TypeScript
// (the founder runs it with plain `node`, like scripts/seed.mjs).

/** The two columns the script reads; every other column passes through untouched. */
export interface SeedRow {
  id: string;
  country: string;
  verified_on?: string | null;
}

export function selectRows<T extends SeedRow>(rows: T[], ids: string[]): T[];

export function upsertRows(
  fetchImpl: typeof fetch,
  target: { url: string; key: string },
  table: "knowledge_entries" | "tools",
  rows: SeedRow[],
): Promise<number>;

export function parseArgs(argv: string[]): { knowledge_entries: string[]; tools: string[]; dry: boolean };

export function parseSpec(spec: string): { id: string; columns: string[] | null };

export interface PlannedRequest {
  table: "knowledge_entries" | "tools";
  kind: "upsert" | "patch";
  ids: string[];
  columns?: string[];
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

export function planRequests(
  target: { url: string; key: string },
  seeds: Partial<Record<"knowledge_entries" | "tools", SeedRow[]>>,
  args: { knowledge_entries?: string[]; tools?: string[] },
): PlannedRequest[];

export function sendRequest(fetchImpl: typeof fetch, key: string, req: PlannedRequest): Promise<number>;
