/**
 * What a start is doing right now, in one plain sentence. The desktop's supervisor names its step
 * (`DaemonStage` in apps/desktop); a browser knows only what its own connection does.
 */

/** How long one step may last before the screen says it is taking longer than usual. */
export const startupStepLongMs = 8_000;

/** The desktop supervisor's steps, as far as the startup screen knows them. */
export type DaemonStage =
  | "looking"
  | "service"
  | "launching"
  | "lock-wait"
  | "warming"
  | "admission";

const daemonStages: readonly string[] = [
  "looking",
  "service",
  "launching",
  "lock-wait",
  "warming",
  "admission",
] satisfies DaemonStage[];

export function isDaemonStage(value: unknown): value is DaemonStage {
  return typeof value === "string" && daemonStages.includes(value);
}

export type StartupActivity =
  | DaemonStage
  /** No step known yet (a desktop build that predates steps). */
  | "starting"
  /** Reaching the daemon. */
  | "connecting"
  /** The daemon answered and said it is still starting (what a browser can tell). */
  | "daemon-starting"
  /** Connected; the app is loading its first data underneath. */
  | "opening"
  | "reconnecting"
  /** The desktop restarts a daemon that stopped on its own. */
  | "restarting"
  /** ...without what kept it from starting (safe mode, ADR 0175). */
  | "safe-mode";

const words: Record<StartupActivity, string> = {
  looking: "Looking for ace's background service",
  service: "Starting ace's background service",
  launching: "Starting ace's background service",
  "lock-wait": "Waiting for the previous ace to close",
  warming: "Getting your threads ready",
  admission: "Connecting to ace's background service",
  starting: "Starting ace",
  connecting: "Connecting to ace",
  "daemon-starting": "Waiting for ace to finish starting",
  opening: "Opening your threads",
  reconnecting: "Reconnecting to ace",
  restarting: "ace's background service stopped, so ace is starting it again",
  "safe-mode":
    "ace kept stopping as it started, so it is starting again without the part it was stuck on",
};

/** Past `startupStepLongMs` on one step: the same step, said as taking longer than usual. */
const longWords: Record<StartupActivity, string> = {
  looking: "Still looking for ace's background service",
  service: "ace's background service is taking longer than usual to start",
  launching: "ace's background service is taking longer than usual to start",
  "lock-wait": "The previous ace is taking a while to close; ace starts as soon as it does",
  warming: "Still getting your threads ready; ace's background service is taking longer than usual",
  admission: "ace's background service is slow to answer; ace keeps asking",
  starting: "ace is taking longer than usual to start",
  connecting: "Still connecting to ace; it keeps trying",
  "daemon-starting": "ace is taking longer than usual to finish starting",
  opening: "Still opening your threads",
  reconnecting: "Still reconnecting to ace; it keeps trying",
  restarting: "ace's background service stopped, so ace is starting it again",
  "safe-mode": words["safe-mode"],
};

export function activityWords(activity: StartupActivity, long: boolean): string {
  return long ? longWords[activity] : words[activity];
}

/**
 * What the desktop's daemon is doing while it starts or restarts, in the startup screen's words,
 * for the shell once the window is open on what it kept: "Starting ace's background service"
 * rather than "Reconnecting", which would say a running daemon was lost. Undefined in any other
 * state (running, stopped, failed), where the connection's own words apply.
 */
export function daemonStartWords(status: {
  state: string;
  stage?: string | undefined;
  message?: string | undefined;
  safeMode?: boolean | undefined;
}): string | undefined {
  if (status.state !== "starting" && status.state !== "restarting") return undefined;
  // A restart the person asked for carries no message; one after a crash says why.
  if (status.state === "restarting" && status.message !== undefined)
    return words[status.safeMode ? "safe-mode" : "restarting"];
  return words[isDaemonStage(status.stage) ? status.stage : "starting"];
}
