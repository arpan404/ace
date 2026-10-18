import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { useCallback, useSyncExternalStore } from "react";

/*
 * Which threads have an agent working in their browser, as the daemon reports them
 * (`browser.browsing`), for the task list's indicator. One watch per client, asked again on
 * every reconnect; rows read their own thread.
 */
interface Watch {
  threads: ReadonlySet<string>;
  listeners: Set<() => void>;
}
const watches = new WeakMap<ClientApi, Watch>();
let sequence = 0;

function watch(client: ClientApi): Watch {
  const existing = watches.get(client);
  if (existing) return existing;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const ask = (attempt = 0) => {
    clearTimeout(retry);
    if (client.state !== "ready") return;
    try {
      client.send({ type: "browser.browsing.watch", requestId: `browsing-${++sequence}` });
    } catch {
      // The service schemas load after the connection; offline, the next connection asks.
      if (attempt < 20) retry = setTimeout(() => ask(attempt + 1), 250);
    }
  };
  // Kept for the client's life: rows come and go, the set stays current.
  const current: Watch = { threads: new Set(), listeners: new Set() };
  watches.set(client, current);
  const connection = client.connectionState();
  client.onMessage((message) => {
    if (message.type !== "browser.browsing") return;
    current.threads = new Set(message.threads);
    for (const listener of current.listeners) listener();
  });
  connection.subscribe(() => {
    if (connection.getSnapshot() === "ready") ask();
  });
  ask();
  return current;
}

/** True while an agent works in this thread's browser. */
export function useThreadBrowsing(threadId: string): boolean {
  const client = useClient();
  const subscribe = useCallback(
    (changed: () => void) => {
      const current = watch(client);
      current.listeners.add(changed);
      return () => void current.listeners.delete(changed);
    },
    [client],
  );
  const read = () => watches.get(client)?.threads.has(threadId) ?? false;
  return useSyncExternalStore(subscribe, read, read);
}
