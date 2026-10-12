import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CompactionInput, CompactionOutput } from "./compaction-protocol.ts";
import { storageSchedule, type StorageSchedule } from "./schedule.ts";
import type { z } from "zod";

export interface CompactionRuntime {
  spawn?(url: URL, input: z.infer<typeof CompactionInput>): ChildProcess;
  schedule?: StorageSchedule;
  timeoutMs?: number;
}
export interface CompactionProcess {
  result: Promise<{ status: "complete" | "deferred"; confirmed: boolean }>;
  exited: Promise<void>;
}
/** The owned helper has no descendants. Kill its process, not a blocked worker-thread isolate. */
export function startCompactionProcess(
  input: z.infer<typeof CompactionInput>,
  signal: AbortSignal,
  options: CompactionRuntime = {},
): CompactionProcess {
  const schedule = options.schedule ?? storageSchedule;
  const url = new URL("./compaction-worker.ts", import.meta.url);
  const child = options.spawn
    ? options.spawn(url, input)
    : spawn(process.execPath, [fileURLToPath(url), JSON.stringify(CompactionInput.parse(input))], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
  child.stdin?.end();
  const ended = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<{ status: "complete" | "deferred"; confirmed: boolean }>();
  let output = "",
    cancelled = false,
    finished = false;
  let stopKillDeadline: (() => void) | undefined;
  const cancel = () => {
    if (finished || cancelled) return;
    cancelled = true;
    child.kill("SIGKILL");
    stopKillDeadline = schedule(1000, () => {
      reply.resolve({ status: "deferred", confirmed: false });
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    });
  };
  const stopDeadline = schedule(options.timeoutMs ?? 30000, cancel);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  child.stdout?.on("data", (bytes: Buffer) => {
    if (output.length + bytes.length > 1024) {
      cancel();
      return;
    }
    output += bytes.toString("utf8");
  });
  child.stderr?.resume();
  child.stdout?.on("error", cancel);
  child.stderr?.on("error", cancel);
  child.on("error", () => {
    // A failed spawn has no worker; a later pipe error still needs a confirmed exit.
    if (child.pid === undefined) finish();
    else cancel();
  });
  const finish = () => {
    if (finished) return;
    finished = true;
    stopDeadline();
    stopKillDeadline?.();
    signal.removeEventListener("abort", cancel);
    let status: "complete" | "deferred" = "deferred";
    try {
      if (!cancelled && child.exitCode === 0) status = CompactionOutput.parse(JSON.parse(output));
    } catch {
      /* Malformed replies defer. */
    }
    reply.resolve({ status, confirmed: true });
    ended.resolve();
  };
  child.once("close", finish);
  // The production helper emits its bounded reply synchronously before exiting.
  return { result: reply.promise, exited: ended.promise };
}
