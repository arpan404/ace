import type { Selection } from "./observable.ts";

/** What `onSocketMove` needs from a client. */
export interface SocketSource {
  connectionGeneration(): Selection<number | undefined>;
}

/**
 * Call `moved` each time the connection moves to another daemon socket while it stays ready (a
 * path switch or failover, ADR 0114). Whatever the daemon kept for the old socket (streams,
 * service subscriptions) ended with it, so a holder re-attaches here. A drop and a later welcome
 * are not moves: holders already handle those by watching the connection state. Returns the
 * unsubscribe.
 */
export function onSocketMove(client: SocketSource, moved: () => void): () => void {
  const generation = client.connectionGeneration();
  let socket = generation.getSnapshot();
  return generation.subscribe(() => {
    const next = generation.getSnapshot();
    if (next === socket) return;
    const move = socket !== undefined && next !== undefined;
    socket = next;
    if (move) moved();
  });
}
