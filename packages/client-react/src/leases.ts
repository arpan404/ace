import type { SidebarSource, ThreadSource } from "@ace/client";
import { useMemo, useSyncExternalStore } from "react";
import { useClient } from "./context.ts";
import { useThreadWindow } from "./window-context.ts";

interface Lease<T> {
  subscribe(changed: () => void): () => void;
  get(): T | undefined;
}
/** A reference-counted SDK lease held for exactly as long as React keeps a subscription. */
function lease<T>(acquire: () => { store: T; release(): void }, cached?: T): Lease<T> {
  let store: T | undefined = cached;
  return {
    subscribe(changed) {
      const held = acquire();
      store = held.store;
      changed();
      return () => {
        held.release();
        store = undefined;
      };
    },
    get: () => store,
  };
}

/**
 * Hold a thread subscription while the component is mounted. The client shares one wire
 * subscription between every holder of the same thread. Warm views paint before commit.
 * Inside a `ThreadWindowProvider` for this thread, the window's source once the tail is held.
 */
export function useThreadStore(threadId: string | undefined): ThreadSource | undefined {
  const client = useClient();
  const window = useThreadWindow(threadId);
  const held = useMemo(
    () =>
      threadId ? lease(() => client.thread(threadId), client.cachedThread?.(threadId)) : undefined,
    [client, threadId],
  );
  const live = useSyncExternalStore(held?.subscribe ?? noSubscribe, held?.get ?? noStore, noStore);
  return live && window ? window : live;
}
export function useSidebarStore(): SidebarSource | undefined {
  const client = useClient();
  const held = useMemo(() => lease(() => client.threads(), client.cachedThreads?.()), [client]);
  return useSyncExternalStore(held.subscribe, held.get, noStore);
}
const noSubscribe = () => () => {};
const noStore = () => undefined;
