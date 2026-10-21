import type { CheckResult } from "@ace/diagnostics";
import type { DiagnosticsHealth } from "@ace/protocol";
import type { DaemonHistory, LastRun } from "./daemon-health-history.ts";
import { clip, duration } from "./format.ts";

export type Verdict = Omit<CheckResult, "id">;

/** How the running daemon answered doctor's health request. */
export type DaemonAnswer =
  | { kind: "health"; health: DiagnosticsHealth }
  /** Connected, but the health report failed or timed out. */
  | { kind: "error"; message: string }
  /** No connection or no answer at all. */
  | { kind: "silent" };

/** A daemon that started this recently may still be opening its database and listeners. */
export const STARTUP_GRACE_MS = 60_000;

const START_IT = "Open ace to start it.";

export function daemonStateVerdict(input: {
  state: "running" | "stopped";
  answer?: DaemonAnswer;
  history: DaemonHistory;
  now: number;
  platform: NodeJS.Platform;
}): Verdict {
  const verdict =
    input.state === "running"
      ? runningVerdict(input.answer ?? { kind: "silent" }, input.history, input.now, input.platform)
      : stoppedVerdict(input.history, input.now);
  return { ...verdict, message: clip(verdict.message) };
}

function runningVerdict(
  answer: DaemonAnswer,
  history: DaemonHistory,
  now: number,
  platform: NodeJS.Platform,
): Verdict {
  const run = history.run.kind === "running" ? history.run : undefined;
  const start = history.log.lastStart;
  // The start record is this run's only when it names the same process.
  const version = start?.version && (!run || start.pid === run.pid) ? start.version : undefined;
  if (answer.kind === "health") {
    const facts = [
      ...(run ? [`pid ${run.pid}`] : []),
      ...(version ? [`version ${version}`] : []),
      ...(run ? [`up ${duration(now - run.startedAt)}`] : []),
      ...(answer.health.activeSessions === null
        ? []
        : [
            `${answer.health.activeSessions} active ${answer.health.activeSessions === 1 ? "session" : "sessions"}`,
          ]),
    ];
    return {
      status: "ok",
      message: `Running and answering${facts.length ? `: ${facts.join(", ")}` : ""}`,
      fix: "",
    };
  }
  const who = run ? `pid ${run.pid}` : "per its run file";
  if (answer.kind === "error")
    return {
      status: "warn",
      message: `Running (${who}) and connected, but its health report failed: ${answer.message}`,
      fix: "Run ace doctor again in a minute. If it still fails, run ace triage to have an agent investigate.",
    };
  if (run && now - run.startedAt < STARTUP_GRACE_MS)
    return {
      status: "warn",
      message: `Started ${duration(now - run.startedAt)} ago (pid ${run.pid}) and isn't answering yet; it may still be starting`,
      fix: "Wait a minute and run ace doctor again.",
    };
  const kill = run
    ? platform === "win32"
      ? `taskkill /PID ${run.pid} /F`
      : `kill ${run.pid}`
    : undefined;
  return {
    status: "fail",
    message: run
      ? `Running as pid ${run.pid} (started ${duration(now - run.startedAt)} ago) but not answering: it may be stuck`
      : "Running per its run file but not answering: it may be stuck",
    fix:
      `Run ace stop.${kill ? ` If that doesn't finish, end it with ${kill}.` : ""} Then open ace again. ` +
      "Run ace triage to have an agent find out why it hung.",
  };
}

function stoppedVerdict(history: DaemonHistory, now: number): Verdict {
  const { run, log, receipt } = history;
  const runStart = "startedAt" in run ? run.startedAt : -Infinity;
  const failure = log.lastStartFailure;
  // A failed start newer than the last good one, and not older than the run file, is why
  // ace isn't running now.
  if (failure && failure.at > (log.lastStart?.at ?? -Infinity) && failure.at >= runStart)
    return {
      status: "fail",
      message: `Not running. Its last start, ${duration(now - failure.at)} ago, failed: ${failure.error}`,
      fix: failure.refused
        ? "Open the newest ace, or update this one: this build is older than your data."
        : "Run ace triage to have an agent investigate, or run ace start in a terminal to watch it fail.",
    };
  if (run.kind === "stopped" && run.source === "startup-failure")
    return {
      status: "fail",
      message: `Not running. Its last start, ${duration(now - run.stoppedAt)} ago, failed; the log has no details`,
      fix: "Run ace start in a terminal to watch it start, or run ace triage to have an agent investigate.",
    };
  const fatal = log.lastFatal && log.lastFatal.at >= runStart ? log.lastFatal : undefined;
  const fatalNote = fatal
    ? ` Last fatal error, ${duration(now - fatal.at)} ago: ${fatal.error}`
    : "";
  const stopNote =
    receipt && receipt.at >= runStart && receipt.state !== "succeeded"
      ? receipt.state === "failed"
        ? " Its last ace stop reported that cleanup failed or ran past its deadline."
        : " An ace stop was requested but never confirmed finishing."
      : "";
  switch (run.kind) {
    case "running":
      return {
        status: "warn",
        message:
          `Not running. Its last run (pid ${run.pid}, started ${duration(now - run.startedAt)} ago) ` +
          `ended without stopping: it crashed or was killed.${fatalNote}${stopNote}`,
        fix: `${START_IT} If it keeps stopping, run ace triage to have an agent find out why.`,
      };
    case "stopped":
      return {
        // Quitting ace is normal. Only a messy stop or a fatal error is worth a warning.
        status: overranNote(run) || fatalNote || stopNote ? "warn" : "ok",
        message: `Not running. It stopped ${duration(now - run.stoppedAt)} ago ${howStopped(run)}.${overranNote(run)}${fatalNote}${stopNote}`,
        fix: START_IT,
      };
    case "unreadable":
      return {
        status: "warn",
        message: `Not running. Its run file is unreadable, so how it last stopped is unknown.${fatalNote}`,
        fix: START_IT,
      };
    case "none":
      return {
        status: "ok",
        message: "Not running, and there's no record of an earlier run in this data folder",
        fix: START_IT,
      };
  }
}

function howStopped(run: Extract<LastRun, { kind: "stopped" }>): string {
  switch (run.source) {
    case "signal":
      return `on ${run.signal ?? "a signal"} (an app quit, an update or a service manager)`;
    case "stop-request":
      return "on request (ace stop)";
    case "abort":
    case "close":
      return "when the app hosting it closed it";
    default:
      return `(${run.source})`;
  }
}

function overranNote(run: Extract<LastRun, { kind: "stopped" }>): string {
  if (!run.overran?.length) return "";
  return ` Shutdown ran past its deadline while still closing: ${run.overran.slice(0, 5).join(", ")}.`;
}
