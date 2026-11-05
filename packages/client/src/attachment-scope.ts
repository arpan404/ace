import { ClientError } from "./errors.ts";
import type { ConnectionState } from "./types.ts";
import type { Selection } from "./observable.ts";

interface ScopedClient {
  readonly state: ConnectionState;
  connectionGeneration(): Selection<number | undefined>;
}
/** Each open scope's signal, and the client whose socket it is bound to. */
const bound = new WeakMap<AbortSignal, ScopedClient>();

/**
 * Bind before lazy loading so a recovered connection cannot revive an obsolete read. A read
 * streams over one daemon socket, so a move to another path (ADR 0114) ends it too. A read
 * started under another scope of the same client (attachmentBytes, then its chunks) is already
 * bound by it, so it takes no second listener; the outer scope stays open until it returns.
 */
export function attachmentReadScope(client: ScopedClient, signal?: AbortSignal) {
  if (signal?.aborted) throw new ClientError("aborted");
  if (client.state !== "ready") throw new ClientError("offline");
  if (signal && bound.get(signal) === client) return { signal, close: () => {} };
  const controller = new AbortController();
  bound.set(controller.signal, client);
  let stop: (() => void) | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    // A read started from this signal after now is bound by its own scope.
    bound.delete(controller.signal);
    stop?.();
    signal?.removeEventListener("abort", abort);
  };
  const abort = () => {
    controller.abort();
    close();
  };
  const socket = client.connectionGeneration();
  const started = socket.getSnapshot();
  stop = socket.subscribe(() => {
    if (socket.getSnapshot() !== started) abort();
  });
  if (closed) stop();
  else {
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  }
  return { signal: controller.signal, close };
}
