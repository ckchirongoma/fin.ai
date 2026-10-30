// Fin — a question asked mid-diagnostic, kept and answered later.
//
// Round 20 (live): at question 4 a person asked "how much does it cost to
// register a business name in Kenya?" and was told to ask it again once the
// questions were done. Nothing kept it, so unless they remembered, it was
// lost. Rule 7 still holds — a question is never taken as an answer, and the
// diagnostic is not stopped to answer it with half a picture of the business
// — but the question is now kept on the business row and answered once the
// picture is whole: straight after the plan is handed over or, when the
// diagnostic ends in stabilising mode, straight after that message.
//
// Why not sooner. While the plan builds, its stages write the business's
// context, and an answer's learning step (updateMemory) writes the same
// field from what it read a minute earlier; and at the read-back the answer
// would land in the middle of the customer choices. After the hand-over the
// question is an ordinary one, on an ordinary turn.
//
// Answered as its own queued job, keyed on the person's number so it runs in
// order with their own messages: a "Start step 1" tapped just after the
// hand-over waits for the answer instead of crossing it. The job goes
// through the same answer() as a question typed at that moment — retrieval,
// guardrails, timing, the learning after the turn — so nothing about how a
// question is answered is special-cased here.
//
// Needs db/0026 (businesses.kept_questions). Until it runs, keeping fails
// with a warning and the person is asked to send the question again, as before.

import { db, enqueue, findBusinessById, updateBusiness } from "../db.js";
import { DIAG } from "../diagnostic.js";
import { isInternalNumber } from "../env.js";
import { sendText } from "../wa.js";
import { errorText, track, trackUnmet, withTrackContext } from "../track.js";
import { answerTurn } from "./qa.js";
import { pickedOptions } from "../safety.js";
import type { Business, JobRow, KeptQuestion } from "../types.js";

/** The newest three are kept: a person asking more than that mid-diagnostic is rare, and one answer has to cover them. */
export const MAX_KEPT = 3;
const MAX_CHARS = 300;

/** Two wordings of the same question compare equal: case, punctuation and spacing aside. */
export const sameText = (a: string): string => a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Keeps the question on the business. False when it could not be kept (db/0026 not applied, or a write failure). */
export async function keepQuestion(biz: Business, text: string, step: number): Promise<boolean> {
  const q = text.trim().slice(0, MAX_CHARS);
  if (!q) return false;
  // The same question asked again (at a later question, or re-sent) is kept once.
  const earlier = (biz.kept_questions ?? []).filter((k) => sameText(k.text) !== sameText(q));
  const kept: KeptQuestion[] = [...earlier, { text: q, step, at: new Date().toISOString() }].slice(-MAX_KEPT);
  try {
    await updateBusiness(biz.id, { kept_questions: kept });
    return true;
  } catch (err) {
    console.warn("kept-question: could not keep it (is db/0026 applied?)", errorText(err));
    return false;
  }
}

/**
 * The person sent the "question" again, as the bounce told them to if it WAS
 * their answer — so it is their answer, not a question to answer after the
 * plan ("about R150?" at the price question; review, round 20). Called for
 * every diagnostic answer, typed or voice; writes only when there is a match,
 * so before db/0026 (nothing is ever kept) it never touches the column.
 */
export async function dropKeptAnswer(biz: Business, step: number, said: string): Promise<void> {
  const kept = biz.kept_questions ?? [];
  const rest = kept.filter((k) => !(k.step === step && sameText(k.text) === sameText(said)));
  if (rest.length === kept.length) return;
  try {
    await updateBusiness(biz.id, { kept_questions: rest.length ? rest : null });
  } catch (err) {
    console.warn("kept-question: an answer re-sent as one could not be taken off the kept list", errorText(err));
  }
}

/**
 * Queues the answer to whatever was kept. Called once the plan has been
 * handed over, or once stabilising mode has begun. Never throws: a plan
 * hand-over is never failed over this.
 */
export async function queueKeptQuestions(businessId: string, when: "plan_ready" | "stabilising"): Promise<void> {
  try {
    const biz = await findBusinessById(businessId);
    const kept = (biz?.kept_questions ?? []).filter((q) => typeof q?.text === "string" && q.text.trim());
    if (!biz || !kept.length) return;
    // Queued first, then cleared: a failed clear can at worst answer twice;
    // the other order could lose the question it promised to answer.
    await enqueue({ kind: "kept_question", businessId: biz.id, waId: biz.wa_id, payload: { questions: kept, when } });
    await updateBusiness(biz.id, { kept_questions: null });
  } catch (err) {
    console.error("kept-question: could not queue the answer", errorText(err));
  }
}

/** The diagnostic question as asked: its last paragraph, and the options if it had any. For the models. */
export function diagQuestionAsked(step: number, countryCode: string): string | null {
  const d = DIAG[step];
  if (!d) return null;
  const paras = d.q(countryCode).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const asked = paras[paras.length - 1] ?? "";
  const options = d.options?.length ? ` (options: ${d.options.map((o, i) => `${i + 1}. ${o}`).join("; ")})` : "";
  return `${asked}${options}`.slice(0, 400) || null;
}

/** The same question, short enough to quote to the person: its first sentence ending in "?". */
export function diagQuestionShort(step: number, countryCode: string): string | null {
  const asked = DIAG[step] ? diagQuestionAsked(step, countryCode)?.replace(/ \(options: .*$/, "") ?? "" : "";
  const q = (asked.match(/[^.?!]*\?/)?.[0] ?? "").trim().replace(/^Question \d+:\s*/i, "");
  return q ? q[0]!.toUpperCase() + q.slice(1) : null;
}

/**
 * What the person sees before each answer: which question it answers, and
 * which of Fin's questions they asked it at. One per kept question —
 * round 21: two questions answered as one lost "what do you mean by that?"
 * (asked at "How do they pay you?") to the registration question beside it.
 */
export function keptPreface(q: Pick<KeptQuestion, "text" | "step">, countryCode: string, first = true): string {
  const at = diagQuestionShort(q.step, countryCode);
  const asked = `you asked me: "${q.text.trim()}"`;
  if (!first) return `${at ? `And when I asked "${at}", ${asked}` : `You also asked me: "${q.text.trim()}"`}\n\nHere's my answer to that.`;
  return `${at ? `Earlier, when I asked "${at}", ${asked}` : `Earlier ${asked}`}\n\nNow that I know your money, here's my answer.`;
}

/** Indexes from a job's payload: which kept questions have had their preface, and which their answer. */
const indexes = (v: unknown): Set<number> => new Set(Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : []);

/**
 * The kept_question job: each kept question answered on its own, under its
 * own preface, with its own diagnostic question as context. The job keeps
 * which prefaces went out and which answers are done, so a retry (answerTurn
 * asks the queue for one when a model call fails) picks up at the question
 * that failed: no preface twice, no answer twice.
 */
export async function runKeptQuestionJob(job: JobRow): Promise<void> {
  const found = job.business_id ? await findBusinessById(job.business_id) : null;
  // Forgotten since it was queued: there is nobody to answer.
  if (!found || found.deleted_at) return;
  let biz: Business = found;
  const kept = (Array.isArray(job.payload?.questions) ? (job.payload.questions as KeptQuestion[]) : []).filter((q) => typeof q?.text === "string" && q.text.trim());
  if (!kept.length) return;
  // A job queued by the build before this one (one preface for all) counts as prefaced.
  const prefaced = job.payload?.preface_sent === true ? new Set(kept.map((_, i) => i)) : indexes(job.payload?.prefaced);
  const answered = indexes(job.payload?.answered);
  const note = async (): Promise<void> => {
    job.payload = { ...job.payload, prefaced: [...prefaced], answered: [...answered] };
    const { error } = await db().from("jobs").update({ payload: job.payload }).eq("id", job.id);
    if (error) console.warn("kept-question: could not note the job's progress", errorText(error));
  };

  for (const [i, q] of kept.entries()) {
    if (answered.has(i)) continue;
    // Said once, and only once it has actually gone.
    if (!prefaced.has(i)) {
      const sent = await sendText(biz.wa_id, keptPreface(q, biz.country, i === 0 || !kept.slice(0, i).some((_, j) => prefaced.has(j))), biz.id);
      if (sent.ok) {
        prefaced.add(i);
        await note();
      }
    }
    // The question of Fin's they were answering, for the models: "what
    // does that mean?" means nothing without it.
    const askedAt = diagQuestionAsked(q.step, biz.country) ?? undefined;
    // And what they then picked there, when it was a fixed-option question:
    // round 21, "what do you mean by that?" at "How do they pay you?" was
    // answered as if they had picked one option of the two they had.
    // Only real option picks: an answer in their own words (or a voice note
    // stored as heard) may be misheard — rule 5 (review, round 21).
    const d = DIAG[q.step];
    const picked = d?.options?.length ? pickedOptions(biz.answers?.[d.key] ?? "", d.options) : null;
    const answeredWith = picked?.join(", ") || undefined;
    const text = q.text.trim();
    // Tracked as the person's own turn — their number's internal flag, their
    // country and stage — not as background work: a failed answer to a
    // tester must not page, and an answer that only apologises is an unmet
    // request. (The preface stays outside: it quotes the person's words,
    // which can read like an apology.)
    const current: Business = biz;
    await withTrackContext(
      { channel: "whatsapp", businessId: current.id, internal: isInternalNumber(current.wa_id), country: current.country, stage: current.stage, said: text },
      async () => {
        const outcome = await answerTurn(current, text, undefined, { ...(askedAt ? { askedAt } : {}), ...(answeredWith ? { answeredWith } : {}) });
        const asked = Date.parse(q.at);
        const facts = { index: i, of: kept.length, step: q.step, when: String(job.payload?.when ?? ""), waited_s: Number.isFinite(asked) ? Math.round((Date.now() - asked) / 1000) : null };
        if (outcome.replied) track("kept_question_answered", { businessId: current.id, props: facts });
        else
          trackUnmet("kept_question_unanswered", {
            businessId: current.id,
            alert: "none",
            props: { ...facts, reason: outcome.handledAs.slice(0, 80) },
            summary: "A question kept from the diagnostic got no real answer after the plan (the turn was taken for something else, or the answer failed)",
          });
      },
    );
    answered.add(i);
    await note();
    // The next answer reads what this one may have learned (memory, map).
    if (i < kept.length - 1) biz = (await findBusinessById(current.id)) ?? current;
  }
}
