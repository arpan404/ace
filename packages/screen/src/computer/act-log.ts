/*
 * The model-facing account of an act batch: one numbered line per step the helper reports
 * (skipped steps included), then the failure, if any. Pure.
 */
import type { ComputerAction } from "./actions.ts";
import type { ComputerActResult } from "./wire.ts";

/** Steps whose effect depends on the app routing input, which background apps may skip. */
const inputSteps: ReadonlySet<string> = new Set(["key", "menu", "paste", "type"]);

export function actLog(
  actions: readonly ComputerAction[],
  result: Pick<ComputerActResult, "done" | "error">,
): string[] {
  const log = result.done.map((step, index) => `${index + 1}. ${step}`);
  const error = result.error;
  if (error) {
    const failed = actions[error.index];
    log.push(
      `Action ${error.index + 1}${failed ? ` (${failed.type})` : ""} failed: ${error.message}${
        error.index < actions.length - 1 ? " The actions after it did not run." : ""
      }`,
    );
  }
  return log;
}

/** The steps that ran: reported done, and not skipped by their `when`. */
export function ranSteps(actions: readonly ComputerAction[], done: readonly string[]) {
  return actions.filter((_, index) => index < done.length && !done[index]?.startsWith("skipped"));
}

/** True when a step that ran sends input an app in the background may ignore. */
export function sentInput(steps: readonly ComputerAction[]): boolean {
  return steps.some((step) => inputSteps.has(step.type));
}
