import { z } from "zod";

/*
 * Heavy derived work (markdown, highlighting, diffs) runs in a dedicated worker, never on the
 * main thread (ADR 0050). Where the platform has no Worker (tests, very old engines) the same
 * function runs in place, so callers see one asynchronous interface either way.
 */

export interface OffThread<I, O> {
  run(input: I): Promise<O>;
  /** True when work runs in a worker; false when it runs in place. */
  readonly parallel: boolean;
}

const Reply = z.union([
  z.object({ id: z.number(), output: z.unknown() }),
  z.object({ id: z.number(), error: z.string() }),
]);

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
    return { parallel: false, run: async (input) => options.local(input) };
  let worker: Worker | undefined;
  let next = 0;
  const pending = new Map<number, { resolve(value: O): void; reject(error: Error): void }>();
  const start = () => {
    const spawned = options.spawn();
    spawned.addEventListener("message", (event: MessageEvent<unknown>) => {
      const reply = Reply.safeParse(event.data);
      if (!reply.success) return;
      const waiter = pending.get(reply.data.id);
      pending.delete(reply.data.id);
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
      // A crashed worker fails what it held; the next call starts a fresh one.
      for (const waiter of pending.values()) waiter.reject(new Error("Worker failed"));
      pending.clear();
      worker = undefined;
    });
    return spawned;
  };
  return {
    parallel: true,
    run(input) {
      worker ??= start();
      const id = ++next;
      const target = worker;
      return new Promise<O>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        // A dedicated worker has no target origin.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        target.postMessage({ id, input });
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
