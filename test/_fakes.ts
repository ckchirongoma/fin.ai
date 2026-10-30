// Charles — in-memory stand-ins for Supabase, WhatsApp and the model gateway.
//
// These exist so the WHOLE conversation can be run in a test: twelve
// diagnostic answers, the identity confirmation, two multi-select choices, the
// plan build, and the step-push loop, end to end, with no network and no
// credentials. Per-module unit tests cannot catch the failures that actually
// hurt here — an owner stranded on a stage nothing handles, a button that
// dispatches nowhere, a message sent with an empty body — because every one of
// those is a wiring failure between modules.
//
// The fake database implements only the query shapes this codebase actually
// uses. That is deliberate: a fake that silently accepts a query it does not
// really support would make a broken test pass. Anything unsupported throws.

import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, any>;

interface Filter {
  kind: "eq" | "is" | "not" | "gte" | "gt" | "lt" | "lte" | "in";
  column: string;
  value: any;
}

/** A column, or a PostgREST JSON path into one: `col->>key` reads `key` of a
 * jsonb column as text (null when the column or the key is missing), which
 * is how a conditional write keyed on a value inside jsonb is expressed. */
const columnValue = (row: Row, column: string): any => {
  const path = /^([a-z_]+)->>([a-z_]+)$/.exec(column);
  if (!path) return row[column];
  const v = row[path[1]!]?.[path[2]!];
  return v === null || v === undefined ? null : String(v);
};

const matches = (row: Row, filters: Filter[]): boolean =>
  filters.every((f) => {
    const v = columnValue(row, f.column);
    if (f.kind === "eq") return v === f.value;
    if (f.kind === "is") return f.value === null ? v === null || v === undefined : v === f.value;
    if (f.kind === "not") return f.value === null ? v !== null && v !== undefined : v !== f.value;
    if (f.kind === "gte") return v !== null && v !== undefined && v >= f.value;
    if (f.kind === "lt") return v !== null && v !== undefined && v < f.value;
    if (f.kind === "gt") return v !== null && v !== undefined && v > f.value;
    if (f.kind === "lte") return v !== null && v !== undefined && v <= f.value;
    if (f.kind === "in") return Array.isArray(f.value) && f.value.includes(v);
    return true;
  });

let idCounter = 1;
/** The raw, always-numeric insertion sequence `id` is generated from. Kept
 * separately (as `_seq` on every inserted row, below) because `id`'s own
 * zero-padded text format stops sorting correctly once idCounter runs past
 * four digits across a long test run — which claim_job's per-owner ordering
 * check below depends on getting right, unlike anything before it. */
const nextSeq = (): number => idCounter++;
const nextId = (): string => `id-${String(nextSeq()).padStart(4, "0")}`;

export interface FakeDb {
  client: SupabaseClient;
  tables: Record<string, Row[]>;
  /** Every query run, for assertions and for debugging a surprising test. */
  log: string[];
  reset(): void;
}

export function makeFakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const tables: Record<string, Row[]> = {
    businesses: [],
    messages: [],
    jobs: [],
    wa_inbound: [],
    plans: [],
    plan_steps: [],
    plan_builds: [],
    business_map: [],
    decisions: [],
    commitments: [],
    outcomes: [],
    safety_events: [],
    retrieval_gaps: [],
    nudges: [],
    wa_templates: [],
    connector_tokens: [],
    proposed_changes: [],
    plan_access_codes: [],
    plan_sessions: [],
    model_config: [],
    knowledge_entries: [],
    tools: [],
    freshness_reports: [],
    forget_log: [],
    knowledge_signals: [],
    events: [],
    incidents: [],
    alert_state: [],
    event_daily: [],
    ...structuredClone(seed),
  };
  const log: string[] = [];

  const table = (name: string): Row[] => {
    if (!tables[name]) tables[name] = [];
    return tables[name]!;
  };

  function builder(name: string) {
    const filters: Filter[] = [];
    let pending: { op: "insert" | "update" | "upsert" | "delete"; rows?: Row[]; patch?: Row; onConflict?: string } | null = null;
    let orderBy: { column: string; ascending: boolean } | null = null;
    let limitTo: number | null = null;
    let rangeTo: [number, number] | null = null;
    let wantCount = false;
    let headOnly = false;

    const applied = (): Row[] => {
      let rows = table(name).filter((r) => matches(r, filters));
      if (orderBy) {
        const { column, ascending } = orderBy;
        rows = [...rows].sort((a, b) => {
          const av = a[column] ?? "";
          const bv = b[column] ?? "";
          if (av === bv) return 0;
          return (av > bv ? 1 : -1) * (ascending ? 1 : -1);
        });
      }
      if (rangeTo) rows = rows.slice(rangeTo[0], rangeTo[1] + 1);
      if (limitTo !== null) rows = rows.slice(0, limitTo);
      return rows;
    };

    const runWrite = (): { data: Row[]; error: any } => {
      const rows = table(name);
      if (pending?.op === "insert") {
        const inserted: Row[] = [];
        for (const r of pending.rows ?? []) {
          const withId: Row = { id: r.id ?? nextId(), _seq: nextSeq(), created_at: r.created_at ?? new Date().toISOString(), ...r };
          // alert_state's primary key: alerts.ts claims a slot by inserting it.
          if (name === "alert_state" && rows.some((x) => x.key === withId.key)) {
            return { data: null as unknown as Row[], error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
          // Emulate the unique constraint that makes de-duplication atomic.
          if (name === "wa_inbound" && rows.some((x) => x.wa_message_id === withId.wa_message_id)) {
            return { data: [], error: { code: "23505", message: "duplicate key" } };
          }
          rows.push(withId);
          inserted.push(withId);
        }
        return { data: inserted, error: null };
      }
      if (pending?.op === "update") {
        const hit = rows.filter((r) => matches(r, filters));
        for (const r of hit) Object.assign(r, pending.patch);
        return { data: hit, error: null };
      }
      if (pending?.op === "upsert") {
        const keys = (pending.onConflict ?? "id").split(",").map((k) => k.trim());
        const out: Row[] = [];
        for (const r of pending.rows ?? []) {
          const existing = rows.find((x) => keys.every((k) => x[k] === r[k]));
          if (existing) {
            Object.assign(existing, r);
            out.push(existing);
          } else {
            const withId: Row = { id: r.id ?? nextId(), ...r };
            rows.push(withId);
            out.push(withId);
          }
        }
        return { data: out, error: null };
      }
      if (pending?.op === "delete") {
        const keep = rows.filter((r) => !matches(r, filters));
        const removed = rows.filter((r) => matches(r, filters));
        tables[name] = keep;
        return { data: removed, error: null };
      }
      return { data: [], error: null };
    };

    const settle = (): { data: any; error: any; count?: number } => {
      log.push(`${name}:${pending?.op ?? "select"}(${filters.map((f) => `${f.column}${f.kind === "eq" ? "=" : " " + f.kind + " "}${JSON.stringify(f.value)}`).join(",")})`);
      if (pending) return runWrite();
      const rows = applied();
      if (wantCount) return { data: headOnly ? null : rows, error: null, count: table(name).filter((r) => matches(r, filters)).length };
      return { data: rows, error: null };
    };

    const api: any = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.count) wantCount = true;
        if (opts?.head) headOnly = true;
        return api;
      },
      insert(rows: Row | Row[]) {
        pending = { op: "insert", rows: Array.isArray(rows) ? rows : [rows] };
        return api;
      },
      update(patch: Row) {
        pending = { op: "update", patch };
        return api;
      },
      upsert(rows: Row | Row[], opts?: { onConflict?: string }) {
        pending = { op: "upsert", rows: Array.isArray(rows) ? rows : [rows], onConflict: opts?.onConflict };
        return api;
      },
      delete() {
        pending = { op: "delete" };
        return api;
      },
      eq(column: string, value: any) {
        filters.push({ kind: "eq", column, value });
        return api;
      },
      is(column: string, value: any) {
        filters.push({ kind: "is", column, value });
        return api;
      },
      not(column: string, _op: string, value: any) {
        filters.push({ kind: "not", column, value });
        return api;
      },
      neq(column: string, value: any) {
        filters.push({ kind: "not", column, value });
        return api;
      },
      gte(column: string, value: any) {
        filters.push({ kind: "gte", column, value });
        return api;
      },
      lt(column: string, value: any) {
        filters.push({ kind: "lt", column, value });
        return api;
      },
      gt(column: string, value: any) {
        filters.push({ kind: "gt", column, value });
        return api;
      },
      lte(column: string, value: any) {
        filters.push({ kind: "lte", column, value });
        return api;
      },
      /** PostgREST paging: rows from..to inclusive, after ordering. */
      range(from: number, to: number) {
        rangeTo = [from, to];
        return api;
      },
      in(column: string, value: any[]) {
        filters.push({ kind: "in", column, value });
        return api;
      },
      order(column: string, opts?: { ascending?: boolean }) {
        orderBy = { column, ascending: opts?.ascending !== false };
        return api;
      },
      limit(n: number) {
        limitTo = n;
        return api;
      },
      maybeSingle() {
        const r = settle();
        if (r.error) return Promise.resolve({ data: null, error: r.error });
        const rows = (r.data as Row[]) ?? [];
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      single() {
        const r = settle();
        if (r.error) return Promise.resolve({ data: null, error: r.error });
        const rows = (r.data as Row[]) ?? [];
        return Promise.resolve(rows.length ? { data: rows[0], error: null } : { data: null, error: { message: "no rows" } });
      },
      then(resolve: (v: any) => any, reject?: (e: any) => any) {
        try {
          return Promise.resolve(settle()).then(resolve, reject);
        } catch (err) {
          return Promise.reject(err).catch(reject);
        }
      },
    };
    return api;
  }

  const client = {
    from: (name: string) => builder(name),
    rpc: async (fn: string, args: Record<string, any>) => {
      log.push(`rpc:${fn}`);
      if (fn === "match_knowledge" || fn === "match_tools") {
        const rows = table(fn === "match_knowledge" ? "knowledge_entries" : "tools")
          .filter((r) => r.country === args.match_country && Array.isArray(r.embedding))
          .map((r) => ({ id: r.id, similarity: cosine(r.embedding, args.query_embedding) }))
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, args.match_count ?? 4);
        return { data: rows, error: null };
      }
      if (fn === "mark_incident_emailed") {
        const hit = table("incidents").find((r) => r.fingerprint === args.p_fingerprint);
        if (hit) {
          hit.emailed_at = args.p_at;
          hit.since_email = Math.max(0, hit.since_email - args.p_sent);
        }
        return { data: null, error: null };
      }
      if (fn === "rollup_event_day") {
        // Mirrors db/0024 rollup_event_day: one UTC day, counted per name and internal.
        const from = new Date(`${args.p_day}T00:00:00.000Z`).getTime();
        const groups = new Map<string, { name: string; internal: boolean; category: string; count: number; owners: Set<string> }>();
        for (const e of table("events")) {
          const t = new Date(e.at).getTime();
          if (t < from || t >= from + 86_400_000) continue;
          const k = `${e.name}|${e.internal}`;
          const g = groups.get(k) ?? { name: e.name, internal: e.internal, category: e.category, count: 0, owners: new Set<string>() };
          g.count += 1;
          if (e.business_id) g.owners.add(e.business_id);
          groups.set(k, g);
        }
        const daily = table("event_daily");
        for (const g of groups.values()) {
          const row = { day: args.p_day, name: g.name, category: g.category, internal: g.internal, count: g.count, businesses: g.owners.size };
          const hit = daily.find((r) => r.day === row.day && r.name === row.name && r.internal === row.internal);
          if (hit) Object.assign(hit, row);
          else daily.push(row);
        }
        return { data: groups.size, error: null };
      }
      if (fn === "bump_incident") {
        // Mirrors db/0025_alert_levels.sql bump_incident: insert, or count one
        // more; with nothing pending (emailed or resolved) take this one's
        // level, otherwise keep the worst severity and the loudest alert;
        // reopen if resolved.
        const rank = ["info", "warn", "error", "critical"];
        const alerts = ["none", "digest", "immediate"];
        const rows = table("incidents");
        const now = new Date().toISOString();
        const hit = rows.find((r) => r.fingerprint === args.p_fingerprint);
        if (!hit) {
          rows.push({ fingerprint: args.p_fingerprint, name: args.p_name, category: args.p_category, severity: args.p_severity, alert: args.p_alert, summary: String(args.p_summary).slice(0, 500), first_seen: now, last_seen: now, count: 1, since_email: 1, last_props: args.p_props ?? {}, emailed_at: null, resolved_at: null });
        } else {
          const settled = hit.resolved_at != null || hit.since_email === 0;
          hit.last_seen = now;
          hit.count += 1;
          hit.since_email += 1;
          if (settled || rank.indexOf(args.p_severity) > rank.indexOf(hit.severity)) hit.severity = args.p_severity;
          if (settled || alerts.indexOf(args.p_alert) > alerts.indexOf(hit.alert)) hit.alert = args.p_alert;
          hit.summary = String(args.p_summary).slice(0, 500);
          hit.last_props = args.p_props ?? {};
          hit.resolved_at = null;
        }
        return { data: null, error: null };
      }
      if (fn !== "claim_job") throw new Error(`fake db: unknown rpc "${fn}"`);
      const now = Date.now();
      const PENDING = new Set(["queued", "running", "failed"]);
      const rows = table("jobs");
      const eligible = rows.filter(
        (j) => (j.status === "queued" && new Date(j.run_after ?? 0).getTime() <= now) || (j.status === "running" && now - new Date(j.locked_at ?? 0).getTime() > 3e5),
      );
      // Mirrors db/0013_claim_job_owner_order.sql exactly: a job may be
      // claimed only when no EARLIER job (by creation order) for the same
      // wa_id is still pending. `_seq` (a plain insertion counter — see
      // nextSeq above) stands in for the real table's bigint `id`, which is
      // what this ordering is actually keyed on in production. Without this
      // check, the fake would pass every test while hiding the exact bug
      // PRIORITY 0 found live — messages from one owner claimed out of
      // creation order.
      const claimable = eligible.filter(
        (j) => !j.wa_id || !rows.some((o) => o.wa_id === j.wa_id && o._seq !== j._seq && o._seq < j._seq && PENDING.has(o.status)),
      );
      const job = claimable.sort((a, b) => String(a.run_after).localeCompare(String(b.run_after)) || a._seq - b._seq)[0];
      if (!job) return { data: [], error: null };
      job.status = "running";
      job.attempts = (job.attempts ?? 0) + 1;
      job.locked_at = new Date().toISOString();
      job.locked_by = args.p_worker;
      return { data: [structuredClone(job)], error: null };
    },
  } as unknown as SupabaseClient;

  return {
    client,
    tables,
    log,
    reset() {
      for (const k of Object.keys(tables)) tables[k] = [];
      log.length = 0;
    },
  };
}

/**
 * The plan build is a resumable state machine (engine/planbuild.ts): choosing
 * an angle only enqueues a "plan_build_stage" job, the way a real webhook
 * call does — it never finishes the build inline any more. Tests that need
 * the finished plan call this afterwards, exactly the way production's own
 * webhook/worker/opportunistic-drain paths would. Dynamically imported so
 * this file has no opinion on env vars, which each test file sets itself
 * before anything touching Supabase is first called.
 */
export async function drainJobs(maxJobs = 30): Promise<void> {
  const { drainQueue } = await import("../api/_lib/queue.ts");
  // The production worker's budget (api/worker.ts): a build call will not
  // start with under BUILD_CALL_MIN_MS (90s) left, as in production.
  await drainQueue({ maxJobs, budgetMs: 240_000 });
}

// ── WhatsApp and the model gateway ───────────────────────────────

export interface SentMessage {
  to: string;
  type: string;
  /** The visible words, whatever kind of message it was. */
  body: string;
  buttons: { id: string; title: string }[];
  raw: Record<string, any>;
}

export interface FakeNet {
  sent: SentMessage[];
  modelCalls: { model: string; prompt: string; payload?: Record<string, any> }[];
  /**
   * A fake Jev. Set handler to answer a request's questions; null makes Jev
   * unreachable (503). A handler may instead return a Response (or a Promise
   * of one), sent as-is — e.g. stalledBody(init.signal) for a body that
   * never finishes.
   */
  jev: { handler: JevHandler | null; calls: { state: any; questions: Record<string, any> }[] };
  /** The file the fake Meta media route serves for any media id. */
  media: { bytes: Uint8Array; mime: string };
  /**
   * The fake Graph GET /<PHONE_NUMBER_ID>?fields=display_phone_number.
   * display null = respond 404; hang = never answer (until the caller aborts).
   * Each lookup's URL and Authorization header is recorded.
   */
  /** display "" = the live shape: 200 OK with no display_phone_number in it. */
  phoneNumber: { display: string | null; hang: boolean; lookups: { url: string; auth: string }[] };
  /** What the fake /audio/transcriptions route returns (null = respond 500). */
  transcription: { text: string | null };
  /**
   * Hidden reasoning tokens the fake chat route reports, as OpenRouter does
   * in usage.completion_tokens_details.reasoning_tokens. null (the default)
   * leaves the usage block as it always was, so no other test sees it.
   */
  usage: { reasoningTokens: number | null };
  /** Vector the fake /embeddings route returns for an input; defaults to a hash-based unit vector. */
  embed?: (input: string) => number[];
  /**
   * Answer a model call by matching something distinctive in the prompt.
   * `respond` may return a value directly, or a Promise of one — a test can
   * `await new Promise((r) => setTimeout(r, ms))` before resolving, to model
   * a model call that is genuinely still in flight when a concurrent one
   * starts (see queue.ts's PRIORITY 0 fix and its regression tests).
   * It is also given the request's `init` (its abort signal, say), and a
   * Response it returns is sent as-is rather than wrapped as an answer —
   * e.g. stalledBody(init.signal), round 21's body that never finishes.
   */
  onModel(match: RegExp | string, respond: (prompt: string, init?: RequestInit) => unknown | Promise<unknown>): void;
  /** The fake /api/render-pdf: fail=true answers 500 (a render failure); calls counts requests. */
  pdf: { fail: boolean; calls: number };
  /** Every POST a drain made to wake /api/worker (queue.ts handOn). */
  workerCalls: { url: string; auth: string }[];
  /** Every alert email sent through Resend (email.ts); fail=true answers 500. */
  emails: { from: string; to: string[]; subject: string; text: string; html: string }[];
  email: { fail: boolean };
  /** Set to make WhatsApp refuse every send with this error (wa.ts). */
  whatsappError: { status: number; code: number; message: string } | null;
  fetch: typeof fetch;
  restore(): void;
}

/** See FakeNet.jev. */
export type JevHandler = (
  payload: { state: any; questions: Record<string, any> },
  init?: RequestInit,
) => Record<string, any> | Response | Promise<Record<string, any> | Response>;

/**
 * Round 21's stall: 200 headers at once, then a body that trickles a newline
 * every 50ms and never finishes — what OpenRouter sends while an upstream
 * provider hangs. A hand-built Response is not wired to the request's
 * signal, so the stream listens to it itself and errors when the caller
 * aborts (with the signal's reason, as a real fetch does). Pass the
 * request's `init.signal`: without one, nothing ends it.
 */
export function stalledBody(signal?: AbortSignal | null): Response {
  const enc = new TextEncoder();
  let beat: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      beat = setInterval(() => ctrl.enqueue(enc.encode("\n")), 50);
      // Never what keeps a test process alive on its own.
      beat.unref?.();
      const stop = () => {
        clearInterval(beat);
        ctrl.error(signal?.reason ?? new DOMException("This operation was aborted", "AbortError"));
      };
      if (signal?.aborted) stop();
      else signal?.addEventListener("abort", stop, { once: true });
    },
    cancel() {
      clearInterval(beat);
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

export function installFakeNet(): FakeNet {
  const real = globalThis.fetch;
  const sent: SentMessage[] = [];
  const modelCalls: { model: string; prompt: string; payload?: Record<string, any> }[] = [];
  const state: {
    transcription: { text: string | null };
    embed?: (input: string) => number[];
    media: { bytes: Uint8Array; mime: string };
    jev: { handler: JevHandler | null; calls: { state: any; questions: Record<string, any> }[] };
    phoneNumber: FakeNet["phoneNumber"];
    pdf: FakeNet["pdf"];
    usage: FakeNet["usage"];
  } = { pdf: { fail: false, calls: 0 }, phoneNumber: { display: null, hang: false, lookups: [] }, transcription: { text: "hello from a voice note" }, media: { bytes: new Uint8Array([1, 2, 3, 4]), mime: "audio/ogg; codecs=opus" }, jev: { handler: null, calls: [] }, usage: { reasoningTokens: null } };
  const responders: { match: RegExp; respond: (prompt: string, init?: RequestInit) => unknown }[] = [];
  const workerCalls: { url: string; auth: string }[] = [];
  const emails: FakeNet["emails"] = [];
  const email = { fail: false };
  const errors: { whatsapp: FakeNet["whatsappError"] } = { whatsapp: null };

  const fakeFetch = (async (input: any, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const body = typeof init?.body === "string" ? init.body : "";

    // ── Resend (alert emails) ──
    if (url.includes("api.resend.com/emails")) {
      if (email.fail) return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
      emails.push(JSON.parse(body || "{}"));
      return json({ id: `email-${emails.length}` });
    }

    // ── Meta Graph ──
    if (url.includes("graph.facebook.com")) {
      if (url.endsWith("/messages")) {
        const payload = JSON.parse(body || "{}");
        if (payload.status === "read") return json({ success: true });
        if (errors.whatsapp) {
          const e = errors.whatsapp;
          return new Response(JSON.stringify({ error: { message: e.message, code: e.code, error_data: { details: e.message }, fbtrace_id: "AbCdEf123456" } }), { status: e.status, headers: { "Content-Type": "application/json" } });
        }
        sent.push({
          to: payload.to,
          type: payload.type,
          body: readableBody(payload),
          buttons: (payload.interactive?.action?.buttons ?? []).map((b: any) => ({ id: b.reply.id, title: b.reply.title })),
          raw: payload,
        });
        return json({ messages: [{ id: `wamid.out.${sent.length}` }] });
      }
      if (url.endsWith("/media")) return json({ id: `media-${sent.length}` });
      if (url.includes("fields=display_phone_number")) {
        const headers = new Headers(init?.headers);
        state.phoneNumber.lookups.push({ url, auth: headers.get("Authorization") ?? "" });
        if (state.phoneNumber.hang) {
          return new Promise<Response>((_, reject) => {
            const signal = init?.signal;
            if (!signal) return; // never settles: the caller must bound it
            if (signal.aborted) return reject(signal.reason);
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        if (state.phoneNumber.display === null) return new Response(JSON.stringify({ error: { message: "Unsupported get request", code: 100 } }), { status: 400, headers: { "Content-Type": "application/json" } });
        if (state.phoneNumber.display === "") return json({ id: url.split("?")[0]!.split("/").pop() });
        return json({ display_phone_number: state.phoneNumber.display, id: url.split("?")[0]!.split("/").pop() });
      }
      return json({ url: "https://lookaside.fbsbx.com/x", mime_type: state.media.mime, file_size: state.media.bytes.byteLength });
    }
    // The file itself, from Meta's media host.
    if (url.includes("lookaside.fbsbx.com")) {
      return new Response(state.media.bytes as unknown as BodyInit, { status: 200, headers: { "Content-Type": state.media.mime } });
    }

    // ── Jev (TypeSafe System One) ──
    if (url.includes("api.typesafe.ai")) {
      const payload = JSON.parse(body || "{}");
      state.jev.calls.push(payload);
      if (!state.jev.handler) return new Response("unavailable", { status: 503 });
      const answers = await state.jev.handler(payload, init);
      if (answers instanceof Response) return answers;
      return json({ model: "jev-latest", answers, usage: { input_tokens: 10, output_tokens: 0 } });
    }

    // ── OpenRouter: transcription and embeddings routes ──
    if (url.includes("openrouter.ai/api/v1/audio/transcriptions")) {
      if (state.transcription.text === null) return new Response("nope", { status: 500 });
      return json({ text: state.transcription.text });
    }
    if (url.includes("openrouter.ai/api/v1/embeddings")) {
      const payload = JSON.parse(body || "{}");
      const inputs: string[] = Array.isArray(payload.input) ? payload.input : [payload.input];
      const make = state.embed ?? ((t: string) => hashVector(t));
      return json({ data: inputs.map((t, index) => ({ index, embedding: make(t) })), usage: { prompt_tokens: 5 } });
    }

    // ── OpenRouter: chat ──
    if (url.includes("openrouter.ai")) {
      const payload = JSON.parse(body || "{}");
      const first = payload.messages?.[0]?.content;
      // Multimodal messages carry an array of parts; the prompt is the text ones.
      const prompt = Array.isArray(first)
        ? first.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n")
        : String(first ?? "");
      modelCalls.push({ model: payload.model, prompt, payload });
      const hit = responders.find((r) => r.match.test(prompt));
      if (!hit) throw new Error(`fake net: no scripted model response for prompt starting:\n${prompt.slice(0, 300)}`);
      const content = await hit.respond(prompt, init);
      if (content instanceof Response) return content;
      const reasoning = state.usage.reasoningTokens;
      return json({
        choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 10 + (reasoning ?? 0),
          ...(reasoning === null ? {} : { completion_tokens_details: { reasoning_tokens: reasoning } }),
        },
      });
    }

    // ── Our own PDF renderer (pdfclient.ts renderPdf) ──
    if (/\/api\/render-pdf(\?|$)/.test(url)) {
      state.pdf.calls++;
      if (state.pdf.fail) return new Response("render failed", { status: 500 });
      return new Response(new Uint8Array([37, 80, 68, 70]) as unknown as BodyInit, { status: 200, headers: { "Content-Type": "application/pdf" } });
    }

    // ── Our own worker, woken by a drain that left work behind (queue.ts handOn) ──
    if (/\/api\/worker(\?|$)/.test(url)) {
      workerCalls.push({ url, auth: new Headers(init?.headers).get("Authorization") ?? "" });
      return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "Content-Type": "application/json" } });
    }

    // Anything else in a test is a mistake worth failing on.
    throw new Error(`fake net: unexpected request to ${url}`);
  }) as unknown as typeof fetch;

  globalThis.fetch = fakeFetch;

  return {
    sent,
    modelCalls,
    transcription: state.transcription,
    usage: state.usage,
    jev: state.jev,
    phoneNumber: state.phoneNumber,
    media: state.media,
    get embed() {
      return state.embed;
    },
    set embed(fn) {
      state.embed = fn;
    },
    onModel(match, respond) {
      responders.push({ match: typeof match === "string" ? new RegExp(escapeRe(match)) : match, respond });
    },
    workerCalls,
    emails,
    email,
    get whatsappError() {
      return errors.whatsapp;
    },
    set whatsappError(e) {
      errors.whatsapp = e;
    },
    pdf: state.pdf,
    fetch: fakeFetch,
    restore() {
      globalThis.fetch = real;
    },
  };
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** A deterministic 1536-dim unit vector from text, so similar words land near each other in tests. */
export function hashVector(text: string, dims = 1536): number[] {
  const v = new Array(dims).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (const ch of word) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    v[h % dims] += 1;
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

function readableBody(payload: Record<string, any>): string {
  if (payload.type === "text") return payload.text?.body ?? "";
  if (payload.type === "interactive") return payload.interactive?.body?.text ?? "";
  if (payload.type === "document") return payload.document?.caption ?? "";
  if (payload.type === "template") return `[template ${payload.template?.name}]`;
  return "";
}

// ── Building inbound messages ────────────────────────────────────

let inboundCounter = 0;

/** `overrides.timestamp` lets a test build a message that arrived long ago. */
export const textFrom = (from: string, text: string, overrides: { timestamp?: number } = {}) => ({
  waMessageId: `wamid.in.${++inboundCounter}`,
  from,
  timestamp: overrides.timestamp ?? Date.now(),
  kind: "text" as const,
  text,
});

export const tapFrom = (from: string, actionId: string, label = "", overrides: { timestamp?: number } = {}) => ({
  waMessageId: `wamid.in.${++inboundCounter}`,
  from,
  timestamp: overrides.timestamp ?? Date.now(),
  kind: "button" as const,
  text: "",
  actionId,
  actionLabel: label,
});
