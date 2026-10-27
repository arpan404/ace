import type { ChangeTap } from "@ace/client";
import { checkoutProblem } from "@ace/ui-core/mobile";
import type { Preview } from "./agents.ts";
import { lockedOf, problemAction, type WorkStore } from "./work.ts";

type Put = (key: string, read: () => Record<string, unknown> | undefined) => void;

/*
 * What stops the thread's checkout, as one line in the thread just above the composer, where the
 * person already looks: a move that failed or wasn't confirmed, a missing worktree, a failed setup
 * script, or a stale Git lock an earlier daemon left. Each carries its way out as words: Retry,
 * Change checkout (which opens Work), Continue without setup, Clear stale lock. Clearing a failed
 * move stays in Work, behind its confirmation. A skipped setup only informs, so it stays in Work.
 */

/** The line, or null when nothing stops the checkout. */
export function workLine(store: Pick<WorkStore, "thread" | "queue">, preview: Preview) {
  const problem = checkoutProblem(store.thread?.details);
  if (problem?.failed) {
    const moves = problem.kind !== "setup-failed";
    return {
      kind: problem.kind,
      label: problem.label,
      detail: preview(problem.detail ?? problem.output.at(-1) ?? "", 512),
      actions: [
        ...problem.actions.filter((action) => action.kind !== "clear-move").map(problemAction),
        ...(moves ? [{ id: "open-work", label: "Change checkout", destructive: false }] : []),
      ],
    };
  }
  if (lockedOf(store))
    return {
      kind: "locked",
      label: "Git is locked",
      detail: "An earlier ace daemon left a Git lock on this checkout.",
      actions: [{ id: "lock.clear", label: "Clear stale lock", destructive: true }],
    };
  return null;
}

/** Re-reads the line when the thread's details or its queue change, never on a text delta. */
export function followWorkLine(
  store: Pick<WorkStore, "thread" | "queue">,
  put: Put,
  preview: Preview,
) {
  const emit = () => put("work", () => ({ type: "thread.work", row: workLine(store, preview) }));
  emit();
  const tap: ChangeTap = (keys) => {
    if (keys === "all" || keys.has("thread") || keys.has("queue")) emit();
  };
  return tap;
}
