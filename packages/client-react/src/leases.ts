import type { SidebarSource, ThreadSource } from "@ace/client";
import { useMemo, useSyncExternalStore } from "react";
import { useClient } from "./context.ts";

interface Lease<T> {
  subscribe(changed: () => void): () => void;
  get(): T | undefined;
}
/** A reference-counted SDK lease held for exactly as long as React keeps a subscription. */
function lease<T>(acquire: () => { store: T; release(): void }): Lease<T> {
  let store: T | undefined;
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
 * subscription between every holder of the same thread. Undefined until the first commit.
 */
export function useThreadStore(threadId: string | undefined): ThreadSource | undefined {
  const client = useClient();
  const held = useMemo(
    () => (threadId ? lease(() => client.thread(threadId)) : undefined),
    [client, threadId],
  );
  return useSyncExternalStore(held?.subscribe ?? noSubscribe, held?.get ?? noStore, noStore);
}
export function useSidebarStore(): SidebarSource | undefined {
  const client = useClient();
  const held = useMemo(() => lease(() => client.threads()), [client]);
  return useSyncExternalStore(held.subscribe, held.get, noStore);
}
const noSubscribe = () => () => {};
const noStore = () => undefined;
