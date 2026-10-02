import { TriggerVariables, type Automation } from "@ace/protocol";
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
  if (rendered.length > 65_536) throw new Error("Rendered prompt exceeds limit");
  return rendered;
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
export function canAdmit(active: number, limit: number): boolean {
  return active < limit;
}
