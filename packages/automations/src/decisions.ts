import { TriggerVariables, maxMessageBytes, type Automation } from "@ace/protocol";
import type { Recurrence, Occurrence } from "./recurrence.ts";

export function renderPrompt(template: string, input: unknown): string {
  const variables = TriggerVariables.parse(input);
  const rendered = template.replace(
    /\{\{([A-Za-z][A-Za-z0-9_.]*)\}\}/g,
    (_match: string, key: string) => {
      if (!Object.hasOwn(variables, key)) throw new Error(`Missing trigger variable: ${key}`);
      return variables[key] ?? "";
    },
  );
  if (rendered.length > maxMessageBytes) throw new Error("Rendered prompt exceeds limit");
  return rendered;
}
/**
 * A run's prompt with the person's note for that one run: the saved prompt, a blank line, then
 * the note, so the run's thread shows both. Without a note the prompt is unchanged.
 */
export function withRunNote(prompt: string, note: string | undefined): string {
  if (note === undefined || note.trim() === "") return prompt;
  const joined = `${prompt}\n\n${note}`;
  if (joined.length > maxMessageBytes) throw new Error("Rendered prompt exceeds limit");
  return joined;
}
export function jitterDeadline(
  nominal: number | undefined,
  jitterMs: number,
  random: number,
): number | undefined {
  if (random < 0 || random >= 1 || !Number.isFinite(random))
    throw new Error("Random draw must be in [0, 1)");
  return nominal === undefined ? undefined : nominal + Math.floor(random * (jitterMs + 1));
}
export function recoverOccurrence(
  automation: Automation,
  recurrence: Recurrence,
  current: Occurrence,
  due: number,
  now: number,
): Occurrence | undefined {
  return due < now && automation.missedRun === "skip" ? recurrence.seek(now, current) : current;
}
export function scheduledDeadline(
  occurrence: Occurrence | undefined,
  recurrence: Recurrence,
  jitterMs: number,
  random: number,
): number | undefined {
  if (!occurrence) return undefined;
  const following = recurrence.seek(occurrence.at, occurrence);
  const maximum = following ? Math.min(jitterMs, following.at - occurrence.at - 1) : jitterMs;
  return jitterDeadline(occurrence.at, maximum, random);
}
/** Runs ace keeps going at once across every automation. */
export const runningLimit = 256;

/**
 * What a new fire of an automation becomes. Every run of an automation goes into its one
 * thread, so only one runs at a time: a fire while one runs waits behind it, one waiting is
 * enough (a further fire is skipped), and with ace at its running limit a fire is skipped. A
 * file automation's own edits never start it again (ADR 0015): a change while one of its runs
 * works or waits is skipped too, and the caller keeps no history of it.
 */
export function admission(facts: {
  active: number;
  waiting: boolean;
  total: number;
  file: boolean;
}): "running" | "queued" | "skipped" {
  if (facts.total >= runningLimit) return "skipped";
  if (facts.file && (facts.active > 0 || facts.waiting)) return "skipped";
  if (facts.waiting) return "skipped";
  return facts.active > 0 ? "queued" : "running";
}

/** Whether an automation's waiting run may start: nothing of it runs and ace has room. */
export function canPromote(facts: { active: number; total: number }): boolean {
  return facts.active === 0 && facts.total < runningLimit;
}
