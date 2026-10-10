import { z } from "zod";

/*
 * Heavy derived work (markdown, highlighting, diffs) runs in a dedicated worker, never on the
 * main thread (ADR 0056). Where the platform has no Worker (tests, very old engines) the same
 * function runs in place, so callers see one asynchronous interface either way.
 */

export interface OffThread<I, O> {
  run(input: I, signal?: AbortSignal): Promise<O>;
  /** True when work runs in a worker; false when it runs in place. */
  readonly parallel: boolean;
}

const Reply = z.union([
  z.object({ id: z.number(), output: z.unknown() }),
  z.object({ id: z.number(), error: z.string() }),
]);
const cancelled = () => new DOMException("Worker job cancelled", "AbortError");

/**
 * `spawn` starts the worker (pass `() => new Worker(new URL("./x.worker.ts", import.meta.url),
 * { type: "module" })` so the bundler sees it); `local` does the same work in place. `decode`
 * checks what the worker returned.
 */
export function offThread<I, O>(options: {
  spawn: () => Worker;
  local: (input: I) => O | Promise<O>;
  decode: (output: unknown) => O;
}): OffThread<I, O> {
  if (typeof Worker !== "function")
    return {
      parallel: false,
      async run(input, signal) {
        if (signal?.aborted) throw cancelled();
        // In-process work cannot be interrupted. Keep the lane occupied until it finishes,
        // then discard the output if its consumer left while it was running.
        const output = await options.local(input);
        if (signal?.aborted) throw cancelled();
        return output;
      },
    };
  let worker: Worker | undefined;
  let next = 0;
  let abandoned = false;
  const pending = new Map<number, { resolve(value: O): void; reject(error: Error): void }>();
  const stopIfIdle = () => {
    if (!abandoned || pending.size || !worker) return;
    const prior = worker;
    worker = undefined;
    abandoned = false;
    prior.terminate();
  };
  const start = () => {
    const spawned = options.spawn();
    spawned.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (worker !== spawned) return;
      const reply = Reply.safeParse(event.data);
      if (!reply.success) return;
      const waiter = pending.get(reply.data.id);
      pending.delete(reply.data.id);
      stopIfIdle();
      if (!waiter) return;
      if ("error" in reply.data) waiter.reject(new Error(reply.data.error));
      else {
        try {
          waiter.resolve(options.decode(reply.data.output));
        } catch (error) {
          waiter.reject(error instanceof Error ? error : new Error("Bad worker reply"));
        }
      }
    });
    spawned.addEventListener("error", () => {
      if (worker !== spawned) return;
      worker = undefined;
      abandoned = false;
      spawned.terminate();
      // A crashed worker fails what it held; the next call starts a fresh one.
      for (const waiter of pending.values()) waiter.reject(new Error("Worker failed"));
      pending.clear();
    });
    return spawned;
  };
  return {
    parallel: true,
    run(input, signal) {
      if (signal?.aborted) return Promise.reject(cancelled());
      worker ??= start();
      const id = ++next;
      const target = worker;
      return new Promise<O>((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener("abort", abort);
        const abort = () => {
          const waiter = pending.get(id);
          if (!waiter) return;
          pending.delete(id);
          waiter.reject(cancelled());
          // Preserve other callers until they finish, then stop any abandoned CPU even if
          // those callers completed before the canceled request would have replied.
          abandoned = true;
          stopIfIdle();
        };
        pending.set(id, {
          resolve(value) {
            cleanup();
            resolve(value);
          },
          reject(error) {
            cleanup();
            reject(error);
          },
        });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
          return;
        }
        try {
          // A dedicated worker has no target origin.
          // oxlint-disable-next-line unicorn/require-post-message-target-origin
          target.postMessage({ id, input });
        } catch (error) {
          const waiter = pending.get(id);
          pending.delete(id);
          waiter?.reject(error instanceof Error ? error : new Error("Worker dispatch failed"));
          stopIfIdle();
        }
      });
    },
  };
}

const Request = z.object({ id: z.number(), input: z.unknown() });

/** The worker side: answer each request with `work(input)`. Call once in a worker entry. */
export function serveOffThread<I>(
  decode: (input: unknown) => I,
  work: (input: I) => unknown | Promise<unknown>,
): void {
  addEventListener("message", (event: MessageEvent<unknown>) => {
    const request = Request.safeParse(event.data);
    if (!request.success) return;
    const { id } = request.data;
    // A worker's postMessage answers its own parent; there is no target origin.
    /* oxlint-disable unicorn/require-post-message-target-origin */
    void (async () => {
      try {
        postMessage({ id, output: await work(decode(request.data.input)) });
      } catch (error) {
        postMessage({ id, error: error instanceof Error ? error.message : "Worker task failed" });
      }
    })();
    /* oxlint-enable unicorn/require-post-message-target-origin */
  });
}
