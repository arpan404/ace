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

/** How many finished runs are said one by one before the rest are folded into one summary. */
export const runAlertsShown = 3;

export interface RunAlertBatch<T> {
  /** Said one by one, newest finish first. */
  shown: T[];
  /** The rest, as one alert; null when every run is shown. */
  summary: { count: number; title: string; body: string } | null;
}

type Finished = Pick<AutomationRun, "status" | "finishedAt">;

const count = new Intl.NumberFormat("en-US");

/** The newest first, split into those said one by one and the rest, with how many of the rest failed. */
function split<T extends Finished>(runs: readonly T[]) {
  const newest = runs.toSorted((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  const rest = newest.slice(runAlertsShown);
  return {
    newest,
    shown: newest.slice(0, runAlertsShown),
    rest: rest.length,
    failed: rest.filter((run) => run.status === "failed").length,
  };
}

/**
 * Many runs that finished at once, such as while the phone was away, as a few alerts: the newest
 * three each, then one saying how many more finished and how many of those failed. A summary
 * never stands in for a single run.
 */
export function batchRunAlerts<T extends Finished>(runs: readonly T[]): RunAlertBatch<T> {
  const { newest, shown, rest, failed } = split(runs);
  if (newest.length <= runAlertsShown + 1) return { shown: newest, summary: null };
  return {
    shown,
    summary: {
      count: rest,
      title: `${count.format(rest)} more automation runs finished`,
      body: failed ? `${count.format(failed)} failed` : "None failed",
    },
  };
}

/**
 * More runs finished than the phone read at once: the newest three each, then the rest it read
 * as "at least" so many, since older ones it didn't read finished too.
 */
export function batchRunAlertsBeyond<T extends Finished>(runs: readonly T[]): RunAlertBatch<T> {
  const { shown, rest, failed } = split(runs);
  return {
    shown,
    summary: {
      count: rest,
      title: `${count.format(rest)}+ more automation runs finished`,
      body: failed ? `${count.format(failed)}+ failed` : "Some may have failed: see Automations",
    },
  };
}
