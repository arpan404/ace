import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { useCallback, useSyncExternalStore } from "react";
import { daemonWatch, type DaemonWatch } from "./daemon-watch.ts";

/*
 * Which threads have an agent using Mac apps, and which apps, as the daemon reports them
 * (`computer.using`), for the task list's indicator. One watch per client; rows read their
 * own thread.
 */
const watches = new WeakMap<ClientApi, DaemonWatch<ReadonlyMap<string, readonly string[]>>>();
const none: readonly string[] = [];

const watch = (client: ClientApi) =>
  daemonWatch(watches, client, {
    initial: new Map<string, readonly string[]>(),
    request: (requestId) => ({ type: "computer.using.watch", requestId }),
    read: (message) =>
      message.type === "computer.using"
        ? new Map(message.threads.map((entry) => [entry.threadId, entry.apps]))
        : undefined,
  });

/** The apps an agent in this thread is using now; empty when none. */
export function useThreadComputerUse(threadId: string): readonly string[] {
  const client = useClient();
  const subscribe = useCallback(
    (changed: () => void) => {
      const current = watch(client);
      current.listeners.add(changed);
      return () => void current.listeners.delete(changed);
    },
    [client],
  );
  const read = () => watches.get(client)?.value.get(threadId) ?? none;
  return useSyncExternalStore(subscribe, read, read);
}
