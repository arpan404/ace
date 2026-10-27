import type { Automation, AutomationRun } from "@ace/protocol";
import { formatElapsed } from "../time.ts";
import { formatWhen } from "./schedule.ts";

export const missedRunLabels: Record<Automation["missedRun"], string> = {
  run_once: "Run it once",
  skip: "Skip it",
};

/** What a run found, in one line: "Running…", "Failed: npm registry timeout", the result. */
export function runSummary(run: AutomationRun): string {
  switch (run.status) {
    case "queued":
      return "Waiting for the last run to finish";
    case "running":
      return "Running…";
    case "failed":
      return `Failed: ${run.result ?? "no result"}`;
    case "skipped":
      return `Skipped${run.result ? `: ${run.result}` : ""}`;
    case "succeeded":
      return run.result ?? "Finished";
  }
}

/** A run's head tone: only a failure is loud; a run waiting on the person says so. */
export type RunTone = "failed" | "needsYou" | "idle";

/**
 * One run as a turn of its automation's conversation: when it started, how it went, how long it
 * worked, and what it said. A run still going is `live` ("Working for …"); a running run whose
 * thread waits on the person says "Needs you" instead, so it never reads as quietly working.
 */
export interface RunTurn {
  when: string;
  status: { tone: RunTone; word: string } | undefined;
  /** "Worked for 14m", "after 2m". */
  detail: string | undefined;
  /** One sentence under the head while it waits or works. */
  note: string | undefined;
  live: boolean;
  /** The run's answer; undefined while it is queued or running. */
  body: string | undefined;
  /** The answer reads muted: the run didn't succeed. */
  muted: boolean;
  /** Offer "Run again" beside it. */
  runAgain: boolean;
}

export function runTurn(
  run: AutomationRun,
  now: number,
  timezone: string | undefined,
  waitsOnPerson = false,
): RunTurn {
  const when = formatWhen(run.startedAt, now, timezone);
  const took =
    run.finishedAt !== undefined ? wholeElapsed(run.finishedAt - run.startedAt) : undefined;
  const base: RunTurn = {
    when,
    status: undefined,
    detail: undefined,
    note: undefined,
    live: false,
    body: undefined,
    muted: run.status !== "succeeded",
    runAgain: run.status === "failed",
  };
  switch (run.status) {
    case "running":
      return waitsOnPerson
        ? {
            ...base,
            status: { tone: "needsYou", word: "Needs you" },
            note: "Its thread is waiting on you. Open it to answer.",
          }
        : { ...base, live: true };
    case "queued":
      return {
        ...base,
        status: { tone: "idle", word: "Queued" },
        note: "Waits for the last run to finish, then starts.",
      };
    case "succeeded":
      return {
        ...base,
        detail: took && `Worked for ${took}`,
        body: run.result ?? "Finished with nothing to report.",
      };
    case "failed":
      return {
        ...base,
        status: { tone: "failed", word: "Failed" },
        detail: took && `after ${took}`,
        body: run.result ?? "The run stopped before it finished.",
      };
    case "skipped":
      return {
        ...base,
        status: { tone: "idle", word: "Skipped" },
        body: run.result ?? "Nothing to do this time.",
      };
  }
}

/** "Working for 3m 12s" for a run still going. */
export function workingFor(run: AutomationRun, now: number): string {
  return `Working for ${formatElapsed(Math.max(0, now - run.startedAt))}`;
}

/** "14m", not "14m 0s": whole minutes read cleaner in a turn's head. */
const wholeElapsed = (ms: number) => formatElapsed(ms).replace(/(\d)m 0s$/, "$1m");

/** How often a run history is read again: soon while a run goes or waits, else each minute. */
export function historyPollMs(runs: readonly AutomationRun[]): number {
  return runs.some((run) => run.status === "running" || run.status === "queued") ? 5_000 : 60_000;
}
