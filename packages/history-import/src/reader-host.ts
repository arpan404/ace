/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker_threads has no targetOrigin. */
import { parentPort, workerData } from "node:worker_threads";
import { startWorker } from "@ace/provider-kit/worker";
import { z } from "zod";

/** The reader's side of its channel to the daemon. */
export interface ReaderPort {
  postMessage(value: unknown, transfer?: ArrayBuffer[]): void;
  on(event: "message", listener: (value: unknown) => void): void;
  /** No more messages: the reader ends once what it sent has gone. */
  close(): void;
}

/** The daemon's first message to a reader process: the options a worker gets as workerData. */
export const ReaderInit = z.object({ init: z.unknown() });
/** A reader process reporting the failure that ends it, as a worker's `error` event would. */
export const ReaderFault = z.object({
  fault: z.object({ message: z.string(), code: z.string().optional() }),
});

/**
 * Where the reader runs: in a process of its own (the daemon's default), or in a worker thread,
 * which tests still inject. Either way the reader gets one port and its options.
 */
export async function readerHost(): Promise<{ port: ReaderPort; data: unknown }> {
  if (parentPort) {
    const worker = parentPort;
    return {
      port: {
        postMessage: (value, transfer) =>
          transfer ? worker.postMessage(value, transfer) : worker.postMessage(value),
        on: (_event, listener) => void worker.on("message", listener),
        close: () => worker.close(),
      },
      data: workerData,
    };
  }
  return processHost();
}

function processHost(): Promise<{ port: ReaderPort; data: unknown }> {
  const send = process.send?.bind(process);
  if (!send) throw new Error("The history reader needs a channel to the daemon");
  // The daemon is gone (exited or killed outright): nothing can use this reader any more. It
  // may have gone while this process was still loading, before a listener could hear it.
  process.on("disconnect", () => process.exit(0));
  if (!process.connected) process.exit(0);
  watchParent(ReaderParent.parse(process.env.ACE_HISTORY_READER_PARENT));
  const fail = (error: unknown) => {
    const fault = {
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && "code" in error && typeof error.code === "string"
        ? { code: error.code }
        : {}),
    };
    if (!process.connected) process.exit(1);
    send({ fault }, () => process.exit(1));
  };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  // Messages that arrive before the reader listens wait here, as they would on a worker's port.
  let listener: ((value: unknown) => void) | undefined;
  const early: unknown[] = [];
  const { promise, resolve } = Promise.withResolvers<{ port: ReaderPort; data: unknown }>();
  let started = false;
  let flushed = Promise.resolve();
  process.on("message", (value: unknown) => {
    if (!started) {
      const init = ReaderInit.safeParse(value);
      if (!init.success) return;
      started = true;
      resolve({
        port: {
          postMessage: (message) => {
            if (!process.connected) return;
            const sent = Promise.withResolvers<void>();
            send(message, () => sent.resolve());
            flushed = sent.promise;
          },
          on: (_event, next) => {
            listener = next;
            for (const message of early.splice(0)) next(message);
          },
          // Sends are delivered in order, so the last one going means all have.
          close: () => void flushed.then(() => process.disconnect?.()),
        },
        data: init.data.init,
      });
      return;
    }
    if (listener) listener(value);
    else early.push(value);
  });
  return promise;
}

/** The daemon's pid, which it passes in: the reader's own parent may change if it dies first. */
const ReaderParent = z.coerce.number().int().positive();

/**
 * Ends the reader if the daemon dies while the reader's own thread is busy, in a long parse or
 * a runaway one, and can't see its channel close. A thread of its own (about 5 MB) checks the
 * daemon every 250 ms. Inline, so the release bundle needs no extra entry for it. A thread that
 * can't start leaves the channel's close as the safeguard, so the reader carries on without it.
 */
function watchParent(daemon: number): void {
  const sentinel = startWorker(
    `const { workerData: daemon } = require("node:worker_threads");
    setInterval(() => {
      let gone = false;
      try { process.kill(daemon, 0); } catch { gone = true; }
      if (gone) process.kill(process.pid, "SIGKILL");
    }, 250);`,
    { eval: true, workerData: daemon },
  );
  sentinel.on("error", (error: unknown) =>
    process.emitWarning(
      `The history reader can't watch its daemon: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
  sentinel.unref();
}
