import { spawn } from "node:child_process";
import { lineReader } from "@ace/provider-kit/process";
import type { SpawnOptions, SupervisedProcess, ProcessExit } from "@ace/provider-kit/process";
/** The native helper never creates children. Own this one process until stdin EOF, then kill if stuck. */
export function spawnWindowsHelper(options: SpawnOptions): SupervisedProcess {
  const child = spawn(options.command, [...(options.args ?? [])], {
    env: { ...process.env, ...options.env },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const controller = new AbortController();
  const stdout = lineReader(child.stdout, options.maxLineBytes ?? 1024 * 1024, () => child.kill());
  const stderr = lineReader(child.stderr, options.maxLineBytes ?? 1024 * 1024, () => child.kill());
  child.stdin.on("error", () => {});
  let failed = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  child.once("error", () => {
    failed = true;
    controller.abort();
  });
  const exited = new Promise<ProcessExit>((resolve) =>
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      controller.abort();
      stdout.close();
      stderr.close();
      resolve({
        code,
        signal,
        reason: failed ? "spawn-error" : stopped ? "stopped" : signal ? "signal" : "exit",
      });
    }),
  );
  return {
    stdin: child.stdin,
    stdout,
    stderr,
    signal: controller.signal,
    exited,
    stop({ graceMs = 1000 } = {}) {
      if (!stopped && !controller.signal.aborted) {
        stopped = true;
        child.stdin.end();
        timer = setTimeout(() => child.kill(), graceMs);
      }
      return exited;
    },
  };
}
