import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import type { SpawnOptions, SupervisedProcess, ProcessExit } from "@ace/provider-kit/process";
/** The native helper never creates children. Own this one process until stdin EOF, then kill if stuck. */
export function spawnWindowsHelper(options: SpawnOptions): SupervisedProcess {
  const child = spawn(options.command, [...(options.args ?? [])], {
    env: { ...process.env, ...options.env },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const controller = new AbortController();
  function bounded(input: NodeJS.ReadableStream) {
    let bytes = 0;
    const stream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        for (const byte of chunk) {
          bytes = byte === 10 ? 0 : bytes + 1;
          if (bytes > 1024 * 1024) {
            child.kill();
            callback(new Error("Helper line exceeds limit"));
            return;
          }
        }
        callback(null, chunk);
      },
    });
    stream.on("error", () => child.kill());
    input.pipe(stream);
    return createInterface({ input: stream, crlfDelay: Infinity });
  }
  const stdout = bounded(child.stdout);
  const stderr = bounded(child.stderr);
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
