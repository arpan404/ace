import { Worker } from "node:worker_threads";
import { PosixLanes, type PosixExecutor, type PosixExecutorEvents } from "./posix-lanes.ts";
import { PosixReply } from "./posix-wire.ts";

/**
 * One POSIX worker thread. It holds the process open only while a call is running. Descriptors
 * are per process, so the fds it opens are the caller's.
 */
export function spawnPosixWorker(events: PosixExecutorEvents): PosixExecutor {
  const worker = new Worker(new URL("./posix-worker.ts", import.meta.url), { execArgv: [] });
  worker.unref();
  worker.on("error", (error: unknown) =>
    events.exit(error instanceof Error ? error : new Error("Command discovery worker failed")),
  );
  worker.on("exit", () => events.exit(new Error("Command discovery worker exited")));
  worker.on("message", (input: unknown) => {
    const reply = PosixReply.safeParse(input);
    if (reply.success) events.reply(reply.data);
  });
  return {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker RPC.
    send: (id, operation) => worker.postMessage({ id, operation }),
    hold: (busy) => (busy ? worker.ref() : worker.unref()),
    terminate: () => void worker.terminate().catch(() => {}),
  };
}

const unrefTimer = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

/** Lanes on real worker threads. */
export function posixWorkerLanes(deadlineMs = 10_000): PosixLanes {
  return new PosixLanes({
    spawn: spawnPosixWorker,
    timer: unrefTimer,
    deadlineMs,
    idleMs: 30_000,
    spares: 2,
    stuckPerRoot: 2,
  });
}
