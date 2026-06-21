import { spawnSync, type ChildProcess } from "node:child_process";

export interface TerminatePidOptions {
  readonly platform?: NodeJS.Platform;
  readonly signal?: NodeJS.Signals;
  readonly processGroup?: boolean;
  readonly force?: boolean;
  readonly kill?: typeof process.kill;
  readonly spawnSync?: typeof spawnSync;
}

export interface TerminateChildOptions extends TerminatePidOptions {
  readonly tree?: boolean;
}

function isMissingProcessError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === "ESRCH"
  );
}

export function terminatePid(pid: number, options: TerminatePidOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const signal = options.signal ?? "SIGTERM";
  const kill = options.kill ?? process.kill;
  const runSpawnSync = options.spawnSync ?? spawnSync;

  if (platform === "win32") {
    const args = ["/pid", String(pid), "/T"];
    if (options.force || signal === "SIGKILL") {
      args.push("/F");
    }
    const result = runSpawnSync("taskkill", args, { stdio: "ignore" });
    if (!result.error && result.status === 0) {
      return;
    }
  }

  const targetPid = options.processGroup && platform !== "win32" ? -pid : pid;
  try {
    kill(targetPid, signal);
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
  }
}

export function terminateChildProcess(
  child: Pick<ChildProcess, "kill" | "pid">,
  options: TerminateChildOptions = {},
): void {
  if (options.tree && child.pid !== undefined) {
    terminatePid(child.pid, options);
    return;
  }

  try {
    child.kill(options.signal ?? "SIGTERM");
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
  }
}
