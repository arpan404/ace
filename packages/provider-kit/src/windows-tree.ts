import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/** Whole-tree stop on Windows, where process groups do not exist. */
export type WindowsKillTree = (pid: number, force: boolean) => void;

/** taskkill /T stops the tree the way a Job Object would; /F forces it. Never uses a shell. */
export function killWindowsTree(pid: number, force: boolean): void {
  try {
    const killer = spawn(
      "taskkill",
      force ? ["/pid", String(pid), "/T", "/F"] : ["/pid", String(pid), "/T"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    killer.once("error", () => {});
    killer.unref();
  } catch {
    /* Exit polling still reaps a survivor; the next stop escalates. */
  }
}

/** Graceful tree stop that escalates after the grace, mirroring stopRetainedGroup. */
export async function stopRetainedWindowsTree(
  pid: number,
  graceMs: number,
  killTree: WindowsKillTree = killWindowsTree,
): Promise<void> {
  killTree(pid, false);
  const deadline = performance.now() + graceMs;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    if (performance.now() >= deadline) {
      killTree(pid, true);
      return;
    }
    await delay(25);
  }
}
