// Charles — the connector a person points their own Claude or ChatGPT at.
//
// Written by hand rather than with the MCP SDK, for a concrete reason: the
// published TypeScript SDK tops out at protocol 2025-11-25 and rejects the
// 2026-07-28 handshake that Anthropic's hosted connector client and recent
// ChatGPT now send. So this speaks BOTH eras from one endpoint, which the spec
// explicitly permits:
//
//   legacy  (2024-11-05 … 2025-11-25) — `initialize` handshake, optional
//           session header, optional SSE stream. Protocol errors ride inside
//           HTTP 200.
//   modern  (2026-07-28)              — no handshake at all; every request
//           carries its own version and client info in params._meta, and the
//           server MUST implement `server/discover`. Unknown method is HTTP
//           404, bad version is HTTP 400, each with a JSON-RPC error body.
//
// It is stateless and JSON-only: every response is application/json, there is
// no SSE stream and no session id. That is fully conformant — the spec makes
// both optional — and it is the only shape that makes sense in a serverless
// function, where there is no instance to hold a session anyway.
//
// Auth is a per-person token, accepted three ways because different hosts allow
// different things: an Authorization header, a path segment (rewritten to ?k=),
// or a query parameter. It resolves to exactly one business, which is what
// makes the service-role database access honest.

import { businessForToken, callTool, dbError, TOOLS } from "./_lib/connector.js";
import { connectorInstructions } from "./_lib/prompts.js";
import type { Business } from "./_lib/types.js";
import { buildReport, sponsorForToken, SPONSOR_PREFIX, suppressSmall } from "./_lib/cohort.js";
import { errorText, normaliseForFingerprint, setTrackContext, track, trackFailure, trackUnmet, tracked } from "./_lib/track.js";
import { isInternalNumber } from "./_lib/env.js";
import { readUiResource, UI_RESOURCES } from "./_lib/appview.js";

const SERVER_INFO = { name: "charles", title: "Charles — your money", version: "1.0.0" };
const MODERN = "2026-07-28";
const SUPPORTED = [MODERN, "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, MCP-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID",
  // Without this a browser client cannot read the negotiated version or an
  // auth challenge off the response.
  "Access-Control-Expose-Headers": "MCP-Protocol-Version, WWW-Authenticate",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...extra },
  });

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const rpcError = (id: string | number | null | undefined, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

const rpcResult = (id: string | number | null | undefined, result: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  result,
});

// ── Auth ─────────────────────────────────────────────────────────

function tokenFrom(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const url = new URL(req.url);
  // The vercel.json rewrite turns /mcp/<token> into /api/mcp?k=<token>.
  return (url.searchParams.get("k") ?? "").trim();
}

// ── Era detection ────────────────────────────────────────────────

function isModern(req: Request, rpc: RpcRequest): boolean {
  const meta = rpc.params?._meta as Record<string, unknown> | undefined;
  if (meta && typeof meta[META_VERSION] === "string") return true;
  if (rpc.method === "server/discover") return true;
  const header = req.headers.get("mcp-protocol-version");
  return header === MODERN;
}

/** Legacy negotiation: echo what they asked for if we know it, else our best. */
function negotiate(asked: unknown): string {
  const v = typeof asked === "string" ? asked : "";
  return SUPPORTED.includes(v) ? v : "2025-06-18";
}

/** Which AI app is calling, when it says (modern clients, on every request). A product name, nothing personal. */
function clientName(rpc: RpcRequest): string | null {
  const info = (rpc.params?._meta as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/clientInfo"] as { name?: unknown } | undefined;
  return typeof info?.name === "string" ? info.name.slice(0, 40) : null;
}

/**
 * The person's AI asked for something the connector refused or does not have.
 * An unknown method is usually a client probing for an optional feature, so
 * it is counted but never emailed; a refused protocol version is a client
 * upgrade that has stopped this connector working for someone.
 */
function refused(reason: string, props: Record<string, unknown> = {}, alert: "none" | "digest" = "digest"): void {
  trackUnmet("mcp_request_refused", {
    severity: alert === "none" ? "info" : "warn",
    alert,
    props: { reason, ...props },
    fingerprint: `mcp_request_refused:${reason}`,
    summary: `The AI connector refused a request: ${reason.replace(/_/g, " ")}`,
  });
}

// ── Tool descriptions, per era ───────────────────────────────────

// ── The sponsor's one tool ───────────────────────────────────────

const SPONSOR_TOOL = {
  name: "get_cohort_report",
  title: "Cohort report",
  description:
    "Aggregate results for the Charles cohort you sponsor: how many people onboarded, finished a plan and stayed active, step and outcome counts, and improvement reported by starting tier (the do-no-harm check). Aggregates only — no names, numbers or anything a person wrote — and groups of fewer than five businesses are withheld.",
  inputSchema: {
    type: "object",
    properties: { days: { type: "number", description: "Look-back window in days, 1 to 365. Default 30." } },
    additionalProperties: false,
  },
};

const SPONSOR_INSTRUCTIONS =
  "You are connected to a sponsor's read-only view of a Charles cohort. Use get_cohort_report. Report the numbers as given and state their caveats plainly: if a figure is marked suppressed or says there is not enough data, say so rather than estimating. The harm_monitoring line is the most important sentence in the report; never omit it.";

interface RpcCtx {
  biz: Business | null;
  /** Set when the caller is a sponsor: the label their token was minted under. */
  sponsor: string | null;
}

function toolList(modern: boolean, sponsor = false): Record<string, unknown> {
  // Deterministic order helps client-side and prompt caching.
  if (sponsor) {
    const tools = [SPONSOR_TOOL];
    return modern ? { tools, resultType: "complete", ttlMs: 300_000, cacheScope: "private" } : { tools };
  }
  // `_meta` carries the view link (appview.ts): a host that draws MCP Apps
  // shows the plan, the step or the map under that tool's answer; any other
  // host ignores it and shows the text, as before.
  const tools = [...TOOLS]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, ...(t._meta ? { _meta: t._meta } : {}) }));
  return modern ? { tools, resultType: "complete", ttlMs: 300_000, cacheScope: "private" } : { tools };
}

// ── The RPC switch ───────────────────────────────────────────────

async function handleRpc(req: Request, rpc: RpcRequest, ctx: RpcCtx): Promise<{ body: unknown; status: number } | null> {
  const biz = ctx.biz;
  const modern = isModern(req, rpc);
  const id = rpc.id;
  const method = rpc.method ?? "";

  // A notification (no id) never gets a response body. Detect it by the absence
  // of an id rather than by method name, so cancelled/progress behave too.
  if (id === undefined || id === null) return null;

  if (modern) {
    const meta = rpc.params?._meta as Record<string, unknown> | undefined;
    const declared = typeof meta?.[META_VERSION] === "string" ? (meta[META_VERSION] as string) : null;
    const header = req.headers.get("mcp-protocol-version");
    if (declared && header && declared !== header) {
      refused("header_mismatch", { method: String(method).slice(0, 40), client: clientName(rpc) });
      return { body: rpcError(id, -32020, "HeaderMismatch: MCP-Protocol-Version does not match params._meta"), status: 400 };
    }
    const asked = declared ?? header;
    if (asked && !SUPPORTED.includes(asked)) {
      refused("unsupported_version", { requested: asked.slice(0, 20), method: String(method).slice(0, 40), client: clientName(rpc) });
      return {
        body: rpcError(id, -32022, "Unsupported protocol version", { supported: SUPPORTED, requested: asked }),
        status: 400,
      };
    }
  }

  switch (method) {
    // ── modern discovery ──
    case "server/discover":
      return {
        body: rpcResult(id, {
          resultType: "complete",
          supportedVersions: SUPPORTED,
          capabilities: ctx.sponsor ? { tools: {} } : { tools: {}, resources: {} },
          instructions: ctx.sponsor ? SPONSOR_INSTRUCTIONS : connectorInstructions(biz!.country),
          ttlMs: 3_600_000,
          // One person's view is not cacheable by a shared intermediary.
          cacheScope: "private",
          _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
        }),
        status: 200,
      };

    // ── legacy handshake ──
    case "initialize":
      return {
        body: rpcResult(id, {
          protocolVersion: negotiate(rpc.params?.protocolVersion),
          // Advertise only what is implemented: a client told there are
          // prompts will call for them and get an error. Resources are the
          // person's view (round 28: appview.ts), so only a person gets them.
          capabilities: ctx.sponsor ? { tools: { listChanged: false } } : { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
          serverInfo: SERVER_INFO,
          instructions: ctx.sponsor ? SPONSOR_INSTRUCTIONS : connectorInstructions(biz!.country),
        }),
        status: 200,
      };

    case "ping":
      return { body: rpcResult(id, modern ? { resultType: "complete" } : {}), status: 200 };

    case "tools/list":
      return { body: rpcResult(id, toolList(modern, Boolean(ctx.sponsor))), status: 200 };

    case "tools/call": {
      const name = String(rpc.params?.name ?? "");
      const args = (rpc.params?.arguments as Record<string, unknown>) ?? {};
      const known = ctx.sponsor ? name === SPONSOR_TOOL.name : TOOLS.some((t) => t.name === name);
      if (!known) {
        refused("unknown_tool", { tool: name.slice(0, 64), sponsor: Boolean(ctx.sponsor), era: modern ? "modern" : "legacy" });
        return { body: rpcError(id, -32602, `Unknown tool: ${name}`), status: modern ? 404 : 200 };
      }
      const started = Date.now();
      const called = { tool: name, era: modern ? "modern" : "legacy", sponsor: Boolean(ctx.sponsor), client: clientName(rpc) };
      try {
        let out: { text: string; isError?: boolean; structured?: unknown; code?: string };
        if (ctx.sponsor) {
          const days = Math.min(365, Math.max(1, Number(args.days ?? 30) || 30));
          const structured = suppressSmall(await buildReport(days));
          out = { text: JSON.stringify(structured, null, 2), structured };
        } else {
          out = await callTool(biz!, name, args);
        }
        const result: Record<string, unknown> = {
          content: [{ type: "text", text: out.text }],
          isError: Boolean(out.isError),
          ...(out.structured ? { structuredContent: out.structured } : {}),
          ...(modern ? { resultType: "complete" } : {}),
        };
        // `result` is the tool's own label (no_plan, no_match, asked…), never its text.
        track("mcp_tool_called", { category: "behaviour", ms: Date.now() - started, props: { ...called, ok: !out.isError, result: out.code ?? null } });
        return { body: rpcResult(id, result), status: 200 };
      } catch (err) {
        console.log(`mcp tools/call ${name} failed`, err);
        track("mcp_tool_called", { category: "behaviour", ms: Date.now() - started, props: { ...called, ok: false, result: "threw" } });
        // A propose_change that threw may have left the person unasked on
        // WhatsApp while their AI reads "That didn't work".
        // dbError: a thrown database error carries the failing row (the
        // person's words, their number) in `details`.
        const cause = dbError(err);
        trackFailure("mcp_tool_failed", cause, {
          severity: "error",
          props: { tool: name, sponsor: Boolean(ctx.sponsor) },
          fingerprint: `mcp_tool_failed:${name}:${normaliseForFingerprint(errorText(cause)).slice(0, 80)}`,
          summary: `The AI connector's ${name} failed: ${errorText(cause).slice(0, 160)}`,
        });
        // A tool that failed is a RESULT with isError, not a protocol error:
        // the model can read the message and do something sensible with it,
        // whereas a JSON-RPC error is usually swallowed by the host.
        return {
          body: rpcResult(id, {
            content: [{ type: "text", text: `That didn't work: ${(err as Error).message}` }],
            isError: true,
            ...(modern ? { resultType: "complete" } : {}),
          }),
          status: 200,
        };
      }
    }

    // The person's view (appview.ts): the one page Claude and ChatGPT draw
    // the plan, the step and the map with. It holds no owner data, so it is
    // the same page for everyone; a sponsor has no view.
    case "resources/list": {
      const resources = ctx.sponsor ? [] : UI_RESOURCES.map((r) => ({ ...r }));
      return { body: rpcResult(id, { resources, ...(modern ? { resultType: "complete", ttlMs: 300_000, cacheScope: "private" } : {}) }), status: 200 };
    }
    case "resources/read": {
      const uri = String(rpc.params?.uri ?? "");
      const content = ctx.sponsor ? null : readUiResource(uri);
      if (!content) {
        refused("unknown_resource", { uri: uri.slice(0, 80), sponsor: Boolean(ctx.sponsor), era: modern ? "modern" : "legacy" }, "none");
        // -32002: the MCP spec's "resource not found".
        return { body: rpcError(id, -32002, "Resource not found", { uri }), status: modern ? 404 : 200 };
      }
      track("mcp_view_read", { category: "behaviour", props: { uri, era: modern ? "modern" : "legacy", client: clientName(rpc) } });
      return { body: rpcResult(id, { contents: [content], ...(modern ? { resultType: "complete", ttlMs: 3_600_000, cacheScope: "private" } : {}) }), status: 200 };
    }
    case "resources/templates/list":
      return { body: rpcResult(id, { resourceTemplates: [], ...(modern ? { resultType: "complete", ttlMs: 300_000, cacheScope: "private" } : {}) }), status: 200 };
    case "prompts/list":
      return { body: rpcResult(id, { prompts: [], ...(modern ? { resultType: "complete", ttlMs: 300_000, cacheScope: "private" } : {}) }), status: 200 };

    default:
      // String(): the body is the client's JSON, and a number here must still get "Method not found", not a crash.
      refused("unknown_method", { method: String(method).slice(0, 60), era: modern ? "modern" : "legacy", client: clientName(rpc) }, "none");
      return { body: rpcError(id, -32601, `Method not found: ${method}`), status: modern ? 404 : 200 };
  }
}

// ── HTTP ─────────────────────────────────────────────────────────

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // The spec says a server that does not offer an SSE stream or client-ended
  // sessions answers GET and DELETE with 405, and 2026-07-28 removed both
  // outright. Say which method IS allowed, so clients stop probing.
  if (req.method !== "POST") {
    return new Response("Method not allowed. This MCP endpoint is POST-only.", {
      status: 405,
      headers: { Allow: "POST, OPTIONS", ...CORS },
    });
  }

  const token = tokenFrom(req);
  if (!token) {
    // Usually a person who pasted the connector address without its private part.
    track("mcp_auth_failed", { category: "security", severity: "warn", alert: "digest", props: { reason: "no_token" }, fingerprint: "mcp_auth_failed:no_token", summary: "An AI connector called with no address token" });
    return json({ error: "unauthorized", message: "This connector needs your personal address. Send \"connect\" to Charles on WhatsApp to get one." }, 401, {
      "WWW-Authenticate": 'Bearer realm="charles"',
    });
  }

  // A sponsor's token is a different kind of key: it opens the cohort tool and
  // nothing else, and never resolves to a business.
  let ctx: RpcCtx;
  try {
    if (token.startsWith(SPONSOR_PREFIX)) {
      const sponsor = await sponsorForToken(token);
      ctx = { biz: null, sponsor: sponsor?.label ?? null };
      if (!sponsor) {
        track("mcp_auth_failed", { category: "security", severity: "warn", alert: "digest", props: { reason: "sponsor_invalid" }, fingerprint: "mcp_auth_failed:sponsor_invalid", summary: "A sponsor key that is not valid (any more) was used" });
        return json({ error: "unauthorized", message: "That sponsor key is not valid any more. Ask the operator for a fresh one." }, 401, {
          "WWW-Authenticate": 'Bearer realm="charles", error="invalid_token"',
        });
      }
    } else {
      const biz = await businessForToken(token);
      ctx = { biz, sponsor: null };
      // Every event from here on (the tool, its model calls, the WhatsApp
      // send) is this person's. A refusal is tracked in businessForToken,
      // which knows why.
      if (biz) setTrackContext({ businessId: biz.id, stage: biz.stage, country: biz.country, internal: isInternalNumber(biz.wa_id) });
      if (!biz) {
        return json({ error: "unauthorized", message: "That address is not valid any more. Send \"connect\" to Charles on WhatsApp for a fresh one." }, 401, {
          "WWW-Authenticate": 'Bearer realm="charles", error="invalid_token"',
        });
      }
    }
  } catch (err) {
    console.log("mcp auth lookup failed", err);
    trackFailure("mcp_auth_failed", dbError(err), {
      severity: "error",
      props: { reason: "lookup_failed", sponsor: token.startsWith(SPONSOR_PREFIX) },
      fingerprint: "mcp_auth_failed:lookup_failed",
      summary: "An AI connector could not be let in: looking up its address failed (500)",
    });
    return json({ error: "server_error" }, 500);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await req.text());
  } catch {
    refused("parse_error");
    return json(rpcError(null, -32700, "Parse error: body is not valid JSON"), 400);
  }

  // 2025-03-26 allowed JSON-RPC batches; later revisions dropped them. Accept
  // one either way — it costs a few lines and an unexpected batch would
  // otherwise look like a malformed request.
  const batch = Array.isArray(payload);
  const items = (batch ? payload : [payload]) as RpcRequest[];
  if (!items.length) {
    refused("empty_batch");
    return json(rpcError(null, -32600, "Invalid request: empty batch"), 400);
  }

  const responses: unknown[] = [];
  let status = 200;
  for (const rpc of items) {
    if (!rpc || typeof rpc !== "object" || rpc.jsonrpc !== "2.0") {
      refused("invalid_jsonrpc");
      responses.push(rpcError(rpc?.id ?? null, -32600, "Invalid request: expected JSON-RPC 2.0"));
      status = 400;
      continue;
    }
    const out = await handleRpc(req, rpc, ctx);
    if (out) {
      responses.push(out.body);
      if (out.status !== 200) status = out.status;
    }
  }

  // Every message was a notification: 202 with no body, per the transport spec.
  // Returning 200 with a JSON body here is the single most common handshake bug.
  if (!responses.length) return new Response(null, { status: 202, headers: CORS });

  const version = req.headers.get("mcp-protocol-version");
  return json(batch ? responses : responses[0], status, version && SUPPORTED.includes(version) ? { "MCP-Protocol-Version": version } : {});
}

const served = tracked("mcp", "mcp", handler);
export const GET = served;
export const POST = served;
export const DELETE = served;
export const OPTIONS = served;
