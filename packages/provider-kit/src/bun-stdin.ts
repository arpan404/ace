import type { Writable } from "node:stream";

interface Sink {
  flush(): unknown;
}
function isSink(value: unknown): value is Sink {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "flush") === "function"
  );
}
/** The native sink behind a Bun child's stdin, found by its description since it isn't exported. */
function nativeSink(stdin: Writable): Sink | undefined {
  for (const key of Object.getOwnPropertySymbols(stdin)) {
    if (key.description !== "kWriteStreamFastPath") continue;
    const sink: unknown = Reflect.get(stdin, key);
    return isSink(sink) ? sink : undefined;
  }
  return undefined;
}

/**
 * Makes a Bun child's stdin report a closed reader as Node's does. Bun's stream reports a small
 * write (up to about 8 KB) as written once its native sink buffers it; when the child has closed
 * its stdin, the sink's later write fails with EPIPE and the stream never hears of it. A request
 * sent that way would wait for an answer forever. Flushing the sink after each write surfaces that
 * failure, and it destroys the stream with it, which emits the `error` and `close` Node gives.
 * Writes, their order and backpressure are untouched. Elsewhere (Node, or a Bun whose stream has
 * no such sink) this does nothing.
 */
export function reportBunStdinFailures(stdin: Writable): void {
  const sink = nativeSink(stdin);
  if (!sink) return;
  let flushing = false;
  let again = false;
  const flush = () => {
    if (flushing) {
      again = true;
      return;
    }
    flushing = true;
    void (async () => {
      try {
        do {
          again = false;
          await sink.flush();
        } while (again && !stdin.destroyed);
      } catch (error) {
        if (!stdin.destroyed) stdin.destroy(error instanceof Error ? error : new Error(String(error)));
      } finally {
        flushing = false;
      }
    })();
  };
  const write = stdin.write.bind(stdin);
  // Every write of the stream, including end's final chunk, goes through write.
  Reflect.set(stdin, "write", (...args: Parameters<Writable["write"]>) => {
    const accepted = write(...args);
    queueMicrotask(flush);
    return accepted;
  });
}
