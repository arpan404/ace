import type { AutomationRun } from "@ace/protocol";

/*
 * Which automation runs are news, and the words for their alert, shared by the web's toasts and
 * the phone's notifications. Pure.
 */

/**
 * Runs that finished after `since` and haven't been said yet, whether or not they were ever seen
 * running: a run can start and end between two reads of the inbox. Runs that finished before
 * `since` are history.
 */
export function finishedSince(
  runs: readonly AutomationRun[],
  since: number,
  said: ReadonlySet<string>,
): AutomationRun[] {
  return runs.filter(
    (run) =>
      run.status !== "running" &&
      run.finishedAt !== undefined &&
      run.finishedAt > since &&
      !said.has(run.id),
  );
}

/** "Nightly audit failed", "Nightly audit finished". */
export function runAlertTitle(run: Pick<AutomationRun, "status" | "title">): string {
  return run.status === "failed" ? `${run.title} failed` : `${run.title} finished`;
}

/**
 * What a system notification may say about a run: its outcome, never its output (ADR 0012
 * keeps previews off lock screens unless asked for).
 */
export function runStatusLine(run: Pick<AutomationRun, "status">): string {
  return run.status === "failed" ? "The automation run failed" : "The automation run finished";
}
