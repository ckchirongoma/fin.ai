// Fin — how long a person should expect to wait, said honestly.
//
// Founder, 2026-09-24: "Let me put the whole thing together. Won't be long"
// arrived, and then the plan took many minutes more. A promise like that is
// worse than silence. So the wait is stated ONCE, up front, from how long
// recent runs actually took (the timing rows each run leaves behind), and
// nothing in between pretends to be nearly done.
//
// The number is the 75th percentile of recent runs, rounded UP to a whole
// minute, so most people get their plan sooner than they were told. With too
// little history to say anything honest, it says "a few minutes" rather than
// inventing a figure.

import { typicalSeconds } from "./db.js";

type Timed = "plan_build_timing" | "readback_timing";

const CACHE_MS = 10 * 60_000;
const cache = new Map<Timed, { at: number; secs: number | null }>();

/** Test hook: forget cached estimates. */
export function __resetEtaCache(): void {
  cache.clear();
}

async function secondsFor(check: Timed): Promise<number | null> {
  const hit = cache.get(check);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.secs;
  const secs = await typicalSeconds(check).catch(() => null);
  cache.set(check, { at: Date.now(), secs });
  return secs;
}

/** Whole minutes, rounded up, never less than 1. Null when there is no honest figure. */
export async function typicalMinutes(check: Timed): Promise<number | null> {
  const secs = await secondsFor(check);
  if (secs === null) return null;
  return Math.max(1, Math.ceil(secs / 60));
}

/** "about 4 minutes", "about a minute", or "a few minutes" with no history. */
export function minutesPhrase(minutes: number | null): string {
  if (minutes === null) return "a few minutes";
  if (minutes <= 1) return "about a minute";
  return `about ${minutes} minutes`;
}

/**
 * What is left of a typical run that started `startedAt`, for a person who
 * asks mid-build. Never counts down past zero into a false "any second now":
 * once the typical time has gone, it says so plainly.
 */
export async function remainingPhrase(check: Timed, startedAt: string | null | undefined): Promise<string | null> {
  const minutes = await typicalMinutes(check);
  if (minutes === null || !startedAt) return null;
  const left = Math.ceil((new Date(startedAt).getTime() + minutes * 60_000 - Date.now()) / 60_000);
  if (!Number.isFinite(left)) return null;
  if (left >= 2) return `about ${left} more minutes`;
  if (left === 1) return "about a minute more";
  return "taking longer than usual, but it's still going";
}
