/*
 * The model-facing account of an act batch: one numbered line per step the helper reports
 * (skipped steps included), then the failure, if any. Pure.
 */
import type { ComputerAction } from "./actions.ts";
import type { ExpandedActions, WireAction } from "./conditions.ts";
import type { ComputerActResult } from "./wire.ts";

/** Steps whose effect depends on the app routing input, which background apps may skip. */
const inputSteps: ReadonlySet<string> = new Set(["key", "menu", "paste", "type"]);

/**
 * Numbers lines by the model's own steps: the helper reports wire steps, and `if` steps it
 * never saw are left out of the count's gaps rather than renumbered.
 */
export function actLog(
  actions: readonly ComputerAction[],
  expanded: ExpandedActions,
  result: Pick<ComputerActResult, "done" | "error">,
): string[] {
  const number = (wireIndex: number) => (expanded.origin[wireIndex] ?? wireIndex) + 1;
  const log = result.done.map((step, index) => `${number(index)}. ${step}`);
  const error = result.error;
  if (error) {
    const failed = expanded.wire[error.index];
    const at = number(error.index);
    log.push(
      `Action ${at}${failed ? ` (${failed.type})` : ""} failed: ${error.message}${
        at < actions.length ? " The actions after it did not run." : ""
      }`,
    );
  }
  return log;
}

/** The steps that ran: reported done, and not skipped by their guard. */
export function ranSteps(wire: readonly WireAction[], done: readonly string[]) {
  return wire.filter((_, index) => index < done.length && !done[index]?.startsWith("skipped"));
}

/** True when a step that ran sends input an app in the background may ignore. */
export function sentInput(steps: readonly WireAction[]): boolean {
  return steps.some((step) => inputSteps.has(step.type));
}
