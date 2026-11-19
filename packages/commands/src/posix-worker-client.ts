import { startWorker } from "@ace/provider-kit/worker";
import { PosixLanes } from "./posix-lanes.ts";
import type { PosixExecutor, PosixExecutorEvents } from "./posix-executor.ts";
import { PosixReply } from "./posix-wire.ts";

/**
 * One POSIX worker thread. It holds the process open only while a call is running. Descriptors
 * are per process, so the fds it opens are the caller's.
 */
export function spawnPosixWorker(events: PosixExecutorEvents): PosixExecutor {
  const worker = startWorker(new URL("./posix-worker.ts", import.meta.url), { execArgv: [] });
  worker.unref();
  // An error means the thread can't serve; only "exit" says it has stopped and frees its slot.
  worker.on("error", (error: unknown) =>
    events.failed(error instanceof Error ? error : new Error("Command discovery worker failed")),
  );
  worker.on("exit", () => events.exit());
  worker.on("message", (input: unknown) => {
    const reply = PosixReply.safeParse(input);
    if (reply.success) events.reply(reply.data);
  });
  return {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker RPC.
    send: (id, operation) => worker.postMessage({ id, operation }),
    hold: (busy) => (busy ? worker.ref() : worker.unref()),
    // Never terminate(): a terminated thread closes nothing it owns, and Bun re-refs it, so a
    // thread stuck in a call would keep the daemon alive. The thread exits by itself instead.
    drain: () => {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker RPC.
      worker.postMessage({ drain: true });
      worker.unref();
    },
  };
}

const unrefTimer = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

/** Lanes on real worker threads. */
export function posixWorkerLanes(): PosixLanes {
  return new PosixLanes({
    spawn: spawnPosixWorker,
    timer: unrefTimer,
    deadlineMs: 10_000,
    idleMs: 30_000,
    spares: 2,
    stuckPerRoot: 2,
    maxWorkers: 8,
    maxThreads: 16,
  });
}
