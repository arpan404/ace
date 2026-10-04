import { execFile } from "node:child_process";

export type KillCommand = (command: string, args: string[]) => Promise<void>;
const executeKill: KillCommand = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 1000, windowsHide: true }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}
/** Inject the asynchronous Windows command edge without replacing tree-kill policy. */
export function chromiumProcessKiller(
  platform: NodeJS.Platform,
  execute: KillCommand = executeKill,
  isAlive: (pid: number) => boolean = alive,
): (pid: number) => Promise<void> {
  return async (pid) => {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid Chromium process identity");
    if (platform === "win32") {
      try {
        await execute("taskkill", ["/PID", String(pid), "/T", "/F"]);
      } catch (error) {
        if (isAlive(pid)) throw error;
      }
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
  };
}
