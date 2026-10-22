import { spawnSupervised } from "@ace/provider-kit/process";

/** How the check command ends: its exit code, or why it has none. */
export interface CheckExit {
  code: number | null;
  reason: "exit" | "signal" | "stopped" | "spawn-error" | "output-limit" | "timeout";
}

/** Runs one check command in a checkout, reporting each output line. */
export type CheckShell = (input: {
  command: string;
  cwd: string;
  line(text: string): void;
  signal: AbortSignal;
}) => Promise<CheckExit>;

/** The shell a check command line runs through on this platform. */
export function shellInvocation(
  command: string,
  platform: NodeJS.Platform,
): { command: string; args: string[] } {
  return platform === "win32"
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", command] }
    : { command: "/bin/sh", args: ["-c", command] };
}

/**
 * The command in its own process group (a Windows tree there), stdout and stderr as lines,
 * stdin closed. Aborting `signal`, or running past `timeoutMs`, stops the whole group.
 */
export function supervisedCheckShell(
  options: { platform?: NodeJS.Platform; timeoutMs?: number; graceMs?: number } = {},
): CheckShell {
  const platform = options.platform ?? process.platform;
  const graceMs = options.graceMs ?? 5_000;
  return async ({ command, cwd, line, signal }) => {
    signal.throwIfAborted();
    const shell = shellInvocation(command, platform);
    const child = spawnSupervised({
      ...shell,
      cwd,
      env: {},
      name: "verify check",
      platform,
      maxLineBytes: 1024 * 1024,
      onStdoutLineDropped: () => {},
    });
    child.stdin.end();
    child.stdout.on("line", (text) => line(text));
    child.stderr.on("line", (text) => line(text));
    let timedOut = false;
    const stop = () => void child.stop({ graceMs });
    signal.addEventListener("abort", stop, { once: true });
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            stop();
          }, options.timeoutMs);
    try {
      const exit = await child.exited;
      return { code: exit.code, reason: timedOut ? "timeout" : exit.reason };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    }
  };
}
