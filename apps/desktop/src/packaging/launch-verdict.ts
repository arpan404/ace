/**
 * Reads a packaged app's console output during the release launch check. A launch passes
 * once the supervisor reports the daemon running and the updater has started a check (it loaded, and
 * its timers were wired). Whether the check finds a release depends on GitHub, so a failed
 * check is not a failed launch. A crash in main fails it at once.
 */
export type LaunchVerdict =
  | { state: "waiting"; missing: string[] }
  | { state: "passed" }
  | { state: "failed"; reason: string };

const milestones = [
  // The daemon runs detached and writes to its own log (ADR 0186), so the app's line is the sign.
  { name: "the daemon running", pattern: /supervisor: The daemon is running/ },
  { name: "an update check starting", pattern: /updater: Checking for update/ },
];

const crashes = [
  /UnhandledPromiseRejection/,
  /Uncaught Exception/i,
  /Daemon start failed/,
  /Update checks failed to start/,
];

export function launchVerdict(lines: readonly string[]): LaunchVerdict {
  const crash = lines.find((line) => crashes.some((pattern) => pattern.test(line)));
  if (crash) return { state: "failed", reason: crash.trim() };
  const missing = milestones
    .filter(({ pattern }) => !lines.some((line) => pattern.test(line)))
    .map(({ name }) => name);
  return missing.length ? { state: "waiting", missing } : { state: "passed" };
}
