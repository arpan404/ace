/*
 * `if` steps. The model writes one `{type:"if", text, steps}` before the steps it guards; the
 * helper takes a `when` on each guarded step instead. Expanding here keeps the model-facing
 * schema small (one guard type, not a guard on every step) and the helper unchanged. Pure.
 */
import type { ComputerAction } from "./actions.ts";

type IfStep = Extract<ComputerAction, { type: "if" }>;
export type Guard = { text?: string; id?: number; gone?: boolean };
/** A step as the helper receives it: never `if`, maybe guarded. */
export type WireAction = Exclude<ComputerAction, IfStep> & { when?: Guard };

export interface ExpandedActions {
  /** The steps the helper runs, in order. */
  wire: WireAction[];
  /** For each wire step, the index of the model's step it came from. */
  origin: number[];
}

const guardOf = (step: IfStep): Guard => ({
  ...(step.text !== undefined ? { text: step.text } : {}),
  ...(step.id !== undefined ? { id: step.id } : {}),
  ...(step.gone ? { gone: true } : {}),
});

/** Moves each `if` onto the steps it guards. Overlapping guards are rejected by the schema. */
export function expandConditions(actions: readonly ComputerAction[]): ExpandedActions {
  const wire: WireAction[] = [];
  const origin: number[] = [];
  let guard: Guard | undefined;
  let remaining = 0;
  actions.forEach((step, index) => {
    if (step.type === "if") {
      guard = guardOf(step);
      remaining = step.steps ?? 1;
      return;
    }
    wire.push(remaining > 0 && guard ? { ...step, when: guard } : step);
    origin.push(index);
    if (remaining > 0) remaining--;
  });
  return { wire, origin };
}

/** The first problem with the batch's `if` steps, or undefined when they are well formed. */
export function conditionProblem(actions: readonly ComputerAction[]): string | undefined {
  let covered = 0;
  for (const [index, step] of actions.entries()) {
    if (step.type !== "if") {
      if (covered > 0) covered--;
      continue;
    }
    if (covered > 0) return `if at step ${index + 1} is inside the steps of an earlier if`;
    const span = step.steps ?? 1;
    if (index + span >= actions.length)
      return `if at step ${index + 1} guards ${span} step${span === 1 ? "" : "s"}, but fewer follow it`;
    covered = span;
  }
  return undefined;
}
