import { ClientError } from "./errors.ts";
import type { ConnectionState } from "./types.ts";
import type { Selection } from "./observable.ts";

/** Bind before lazy loading so a recovered connection cannot revive an obsolete read. */
export function attachmentReadScope(
  client: {
    readonly state: ConnectionState;
    connectionState(): Selection<ConnectionState>;
  },
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new ClientError("aborted");
  if (client.state !== "ready") throw new ClientError("offline");
  const controller = new AbortController();
  let stop: (() => void) | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stop?.();
    signal?.removeEventListener("abort", abort);
  };
  const abort = () => {
    controller.abort();
    close();
  };
  stop = client.connectionState().subscribe(() => {
    if (client.state !== "ready") abort();
  });
  if (closed) stop();
  else {
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  }
  return { signal: controller.signal, close };
}
