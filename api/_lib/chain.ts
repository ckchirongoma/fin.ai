// Fin — how deep a chain of this deployment calling itself has gone.
//
// Round 23, live: the plan PDF's render answered 508 INFINITE_LOOP_DETECTED
// on 4 of 14 plans, every one of them a build that had needed retries. A
// queued job runs in a worker that another worker woke over HTTP (queue.ts
// handOn), which another woke, and so on; the render is one more call to the
// same deployment. Vercel refuses a request once a function has called its
// own deployment too many times in one chain (about the fourth nested call,
// by public reports: it documents no exact limit), so a long build's render
// was refused before it ran, and only a retry from a fresh chain got through.
//
// So every self-call carries its depth (`hop` in the URL), the worker runs
// inside it, and two limits keep a chain short enough:
//  - a worker wakes another worker (hand-on, the watch runner) only while
//    that one would be at most MAX_WORKER_HOP deep; past it the once-a-
//    minute tick (a fresh chain) carries the work on;
//  - so the render, one more call from any worker, is at most
//    MAX_WORKER_HOP + 1 deep.

import { AsyncLocalStorage } from "node:async_hooks";

/** The deepest worker a chain may wake: webhook or tick (0) → worker (1) → worker (2). */
export const MAX_WORKER_HOP = 2;

const store = new AsyncLocalStorage<{ hop: number }>();

/** How many times this deployment has called itself to reach the code running now (0: an outside request). */
export function currentHop(): number {
  return store.getStore()?.hop ?? 0;
}

/** Runs `fn` at a given depth: everything it calls on to (waitUntil included) inherits it. */
export function withHop<T>(hop: number, fn: () => T): T {
  return store.run({ hop }, fn);
}

/** The depth a call made from here arrives at. */
export const nextHop = (): number => currentHop() + 1;

/** May this code wake another worker? */
export const mayWakeWorker = (): boolean => nextHop() <= MAX_WORKER_HOP;

/** The `hop` a request carries (0 when it has none: a webhook, a cron, a person). */
export function hopFrom(url: URL): number {
  const n = Number(url.searchParams.get("hop"));
  return Number.isInteger(n) && n >= 0 && n < 100 ? n : 0;
}
