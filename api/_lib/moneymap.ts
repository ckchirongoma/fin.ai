// Charles — scoring the Money Map against a fixed rubric.
//
// The eight-area map has to be rubric-based so it is consistent across people
// and reportable to a bank or a programme. A model grading its own output is
// not that: ask it twice and it drifts, and a sponsor comparing two cohorts is
// then comparing two different rulers.
//
// So the status (red / amber / green) is decided here, independently, against
// levels written as standalone SITUATIONS rather than degrees — each level has
// to stand on its own, because a calibrated scorer judges each in isolation and
// "worse than the one above" means nothing to it. The per-domain NOTE still
// comes from the generative call, because a scorer cannot write a sentence.

import { askJev, type JevQuestion } from "./jev.js";
import { askJSON } from "./models.js";
import { env } from "./env.js";
import { recordSafetyEvent } from "./db.js";
import { rethrowGuardrailDeadline } from "./jobctx.js";
import type { MapStatus } from "./types.js";

const RUBRIC: Record<string, [string, string, string]> = {
  income: [
    "They cannot say what comes in each month or when, and a grant, benefit or refund they likely qualify for has not been claimed or checked.",
    "They know roughly what comes in, but not the dates, or one benefit they likely qualify for is still unclaimed or unchecked.",
    "They know what comes in each month and the day it lands, and every grant, benefit or refund they qualify for is claimed or has been checked.",
  ],
  spending: [
    "The money runs out before the month does, bills are paid late or skipped, and there is no plan for where the money goes.",
    "They mostly get through the month, but by borrowing, skipping something, or without knowing where the money went.",
    "A plan for the month exists that fits the money that comes in, and bills are paid on the day the money lands.",
  ],
  debt: [
    "They owe money to more than one place, including a mashonisa or an account in arrears, and do not know the total.",
    "They know roughly what they owe but are paying whoever shouts loudest, or something new has been borrowed this month.",
    "Every rand owed is written down with its cost, the most expensive debt is being paid first, nothing new has been borrowed, and no mashonisa is owed.",
  ],
  cushion: [
    "Nothing is put aside that they could reach in an emergency; a surprise cost means borrowing.",
    "A small amount is sometimes put aside but gets used for ordinary spending, or there is no named target.",
    "A named amount they can reach without borrowing exists, in a place that is separate from everyday money, and it grows on the day money lands.",
  ],
  credit_record: [
    "They have never seen their credit report, or know they are in arrears or blacklisted, and do not know what is on it.",
    "They have an idea of their record but have not checked it this year, or an error or a prescribed debt is still listed.",
    "They have seen their free credit report in the last year, disputed anything wrong, and every account has been paid on time for three months.",
  ],
  protection: [
    "People depend on them and there is no funeral or other cover, or they hold more than one policy for the same thing without knowing it.",
    "There is some cover, but they do not know what it pays, its waiting period, who the beneficiary is, or whether it is doubled up.",
    "One policy that fits what they can pay covers the people who depend on them; they know its waiting period, the beneficiary is named, and no premium is doubled.",
  ],
  family_money: [
    "Money asked for by family is given whenever asked, with no limit, and it regularly breaks the month.",
    "They give to family but the amount changes every month, or a stokvel or burial society they belong to is one they cannot verify.",
    "What they give family is a fixed line in the month that everyone knows, and any stokvel or burial society is one they can verify and have seen the books of.",
  ],
  goals: [
    "There is no written goal for the next 90 days and nothing beyond the current month is planned for.",
    "There is a goal in their head but nothing written or measurable, or a longer goal with no vehicle for it.",
    "A written 90-day goal exists with a number on it, and a longer goal (a home, a child's schooling, retirement) has a vehicle they have started.",
  ],
};

const STATUS_BY_INDEX: MapStatus[] = ["red", "amber", "green"];
export const RUBRIC_DOMAINS = Object.keys(RUBRIC);

/** What "sorted" concretely means for one area. The plan document prints this
 * next to every area that is not there yet, so the map is a destination and
 * not just a verdict. */
export const greenMeans = (domain: string): string => RUBRIC[domain]?.[2] ?? "";

/** The rubric, as prose, for the model backstop and for the plan document. */
export function rubricText(): string {
  return Object.entries(RUBRIC)
    .map(([domain, levels]) => `${domain}:\n  red — ${levels[0]}\n  amber — ${levels[1]}\n  green — ${levels[2]}`)
    .join("\n");
}

export type MapScores = Partial<Record<string, MapStatus>>;

/**
 * Returns {} when no engine can run, and the caller keeps the generative call's
 * own status. That is a worse map, not a broken conversation — but it writes an
 * `unavailable` row so the degradation is visible.
 */
export async function scoreMoneyMap(
  answers: Record<string, string>,
  identity: unknown,
  goal: unknown,
  ctx: { businessId?: string | null } = {},
): Promise<MapScores> {
  const state = { diagnostic_answers: answers, household_identity: identity, goal_chosen: goal };

  // ── Engine 1: Jev's calibrated score question, one per area ──
  if (env.TYPESAFE_API_KEY) {
    const questions: Record<string, JevQuestion> = {};
    for (const [domain, levels] of Object.entries(RUBRIC)) {
      questions[domain] = {
        type: "score",
        instructions: `How far along is this household in the "${domain.replace(/_/g, " ")}" area of its money life, based on the diagnostic answers given?`,
        criteria: levels,
      };
    }
    const outcome = await askJev({ apiKey: env.TYPESAFE_API_KEY, state, questions });
    if (outcome.ok && outcome.answers) {
      const result: MapScores = {};
      for (const domain of RUBRIC_DOMAINS) {
        const a = outcome.answers[domain];
        // Ties round DOWN, matching what the model backstop is told: "when the
        // answers do not clearly support the higher level, choose the lower one".
        if (a?.type === "score") result[domain] = STATUS_BY_INDEX[Math.min(2, Math.max(0, Math.ceil(a.score - 0.5)))];
      }
      await recordSafetyEvent({ businessId: ctx.businessId, check: "map_score", engine: "jev", outcome: "pass", detail: JSON.stringify(result) });
      return result;
    }
    console.warn("safety[map_score] jev unavailable:", outcome.credential ? "bad credential" : outcome.message);
  }

  // ── Engine 2: the same rubric, given to a small model as a closed choice ──
  if (env.OPENROUTER_API_KEY) {
    try {
      const prompt = `You are scoring one household's money life against a fixed rubric. You do not write advice. For each area, choose exactly one of red, amber or green by deciding which description matches the household as it is TODAY.

Score each area independently. Do not let one area's score influence another. When the answers do not clearly support the higher level, choose the lower one.

RUBRIC:
${rubricText()}

THE HOUSEHOLD:
${JSON.stringify(state).slice(0, 8000)}

Return JSON only, no fences, no commentary — all eight areas:
{${RUBRIC_DOMAINS.map((d) => `"${d}": "red"|"amber"|"green"`).join(", ")}}`;

      const out = await askJSON("safety", prompt, { maxTokens: 400, temperature: 0, label: "safety:map_score" });
      const result: MapScores = {};
      for (const domain of RUBRIC_DOMAINS) {
        const v = String(out[domain] ?? "").toLowerCase();
        if (v === "red" || v === "amber" || v === "green") result[domain] = v;
      }
      if (Object.keys(result).length) {
        await recordSafetyEvent({ businessId: ctx.businessId, check: "map_score", engine: "model", outcome: "pass", detail: JSON.stringify(result) });
        return result;
      }
    } catch (err) {
      rethrowGuardrailDeadline(err);
      console.log("safety[map_score] model backstop failed:", err);
    }
  }

  await recordSafetyEvent({
    businessId: ctx.businessId,
    check: "map_score",
    engine: "none",
    outcome: "unavailable",
    detail: "Map status fell back to the plan-builder's own self-grading, which is not comparable across people.",
  });
  return {};
}
