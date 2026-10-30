// Charles — the catch-up sweep.
//
// The webhook already drains the queue in its own invocation, so in normal
// operation this endpoint does nothing. It exists for the abnormal case: an
// instance killed mid-job, a model outage that pushed work onto a backoff, a
// burst that arrived faster than one invocation could absorb.
//
// Authenticated with WORKER_SECRET (or Vercel's CRON_SECRET when a schedule
// calls it). It fails CLOSED: with no secret configured it refuses rather than
// leaving a queue-draining endpoint open to anyone who guesses the URL.

import { timingSafeEqual } from "node:crypto";
import { env } from "./_lib/env.js";
import { waitUntil } from "@vercel/functions";
import { cronTick, drainQueue, runWatch } from "./_lib/queue.js";
import { noteRequestFailure, tracked } from "./_lib/track.js";
import { hopFrom, withHop } from "./_lib/chain.js";

export function authorised(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const secrets = [env.WORKER_SECRET, env.CRON_SECRET].filter(Boolean);
  if (!secrets.length) return false; // fail closed
  return secrets.some((s) => {
    const expected = `Bearer ${s}`;
    const a = Buffer.from(header, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (!authorised(req)) return new Response("Forbidden", { status: 403 });

  const url = new URL(req.url);
  const maxJobs = Math.min(50, Math.max(1, Number(url.searchParams.get("max") ?? 10)));
  // How deep in a chain of this deployment calling itself this request is
  // (chain.ts): everything below, waitUntil work included, runs at it.
  return withHop(hopFrom(url), () => route(url, maxJobs));
}

async function route(url: URL, maxJobs: number): Promise<Response> {
  // ?tick=1 is the once-a-minute cron (vercel.json): see queue.ts cronTick.
  if (url.searchParams.get("tick") === "1") {
    const r = await cronTick().catch((err) => {
      console.error("tick failed", err);
      return { error: (err as Error).message };
    });
    return new Response(JSON.stringify(r), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // ?watch=1 wakes the watchdog's own runner (queue.ts runWatch): it claims
  // the queued watchdog by id and runs nothing else, so a build stage that
  // hangs can never take the watchdog down with it.
  if (url.searchParams.get("watch") === "1") {
    waitUntil(runWatch({ label: "watch" }).catch((err) => console.warn("watch runner failed", err)));
    return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "Content-Type": "application/json" } });
  }

  // ?async=1 is the hand-on from another drain (queue.ts handOn): answer at
  // once so the caller can finish, and do the work in this invocation's own
  // time budget, waiting for work that becomes runnable within a minute.
  if (url.searchParams.get("async") === "1") {
    waitUntil(
      drainQueue({ maxJobs, budgetMs: 240_000, label: "handon", waitForDueMs: 60_000 }).catch((err) => console.warn("hand-on drain failed", err)),
    );
    return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "Content-Type": "application/json" } });
  }

  try {
    const report = await drainQueue({ maxJobs, budgetMs: 240_000, label: "sweep" });
    return new Response(JSON.stringify(report), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.log("worker sweep failed", err);
    noteRequestFailure(err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

const served = tracked("worker", "system", handler);
export const GET = served;
export const POST = served;
export const OPTIONS = served;
