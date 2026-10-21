import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { useCallback, useSyncExternalStore } from "react";
import { daemonWatch, type DaemonWatch } from "./daemon-watch.ts";

/*
 * Which threads have an agent working in their browser, as the daemon reports them
 * (`browser.browsing`), for the task list's indicator. One watch per client, asked again on
 * every reconnect; rows read their own thread.
 */
const watches = new WeakMap<ClientApi, DaemonWatch<ReadonlySet<string>>>();

const watch = (client: ClientApi) =>
  daemonWatch(watches, client, {
    initial: new Set<string>(),
    request: (requestId) => ({ type: "browser.browsing.watch", requestId }),
    read: (message) => (message.type === "browser.browsing" ? new Set(message.threads) : undefined),
  });

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
  const read = () => watches.get(client)?.value.has(threadId) ?? false;
  return useSyncExternalStore(subscribe, read, read);
}

/** Every thread with an agent working in its browser now. */
export function useBrowsingThreads(): ReadonlySet<string> {
  const client = useClient();
  const subscribe = useCallback(
    (changed: () => void) => {
      const current = watch(client);
      current.listeners.add(changed);
      return () => void current.listeners.delete(changed);
    },
    [client],
  );
  const read = () => watches.get(client)?.value ?? none;
  return useSyncExternalStore(subscribe, read, read);
}
const none: ReadonlySet<string> = new Set();
