/**
 * Reads a packaged app's console output during the release launch check. A launch passes
 * once the managed daemon is serving and the updater has started a check (it loaded, and
 * its timers were wired). Whether the check finds a release depends on GitHub, so a failed
 * check is not a failed launch. A crash in main fails it at once.
 */
export type LaunchVerdict =
  | { state: "waiting"; missing: string[] }
  | { state: "passed" }
  | { state: "failed"; reason: string };

const milestones = [
  { name: "the daemon serving", pattern: /ace daemon: ws:\/\// },
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
