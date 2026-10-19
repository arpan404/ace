import type { ClientApi, OneWayMessage } from "@ace/client";
import type { ServerMessage } from "@ace/protocol";

/*
 * A daemon-wide set a client watches once (`browser.browsing`, `computer.using`): asked on
 * every reconnect, replaced by each answer, kept for the client's life while rows come and go.
 */
export interface DaemonWatch<T> {
  value: T;
  listeners: Set<() => void>;
}

let sequence = 0;

export function daemonWatch<T>(
  watches: WeakMap<ClientApi, DaemonWatch<T>>,
  client: ClientApi,
  spec: {
    initial: T;
    request: (requestId: string) => OneWayMessage;
    /** The new value from a message, or undefined when the message is not an answer. */
    read: (message: ServerMessage) => T | undefined;
  },
): DaemonWatch<T> {
  const existing = watches.get(client);
  if (existing) return existing;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const ask = (attempt = 0) => {
    clearTimeout(retry);
    if (client.state !== "ready") return;
    try {
      client.send(spec.request(`watch-${++sequence}`));
    } catch {
      // The service schemas load after the connection; offline, the next connection asks.
      if (attempt < 20) retry = setTimeout(() => ask(attempt + 1), 250);
    }
  };
  const current: DaemonWatch<T> = { value: spec.initial, listeners: new Set() };
  watches.set(client, current);
  const connection = client.connectionState();
  client.onMessage((message) => {
    const value = spec.read(message);
    if (value === undefined) return;
    current.value = value;
    for (const listener of current.listeners) listener();
  });
  connection.subscribe(() => {
    if (connection.getSnapshot() === "ready") ask();
  });
  ask();
  return current;
}
