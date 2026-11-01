import type { SidebarSource, ThreadSource } from "@ace/client";
import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useClient } from "./context.ts";
import { useThreadWindow } from "./window-context.ts";

interface Lease<T> {
  subscribe(changed: () => void): () => void;
  get(): T | undefined;
}
/**
 * A reference-counted SDK lease held for exactly as long as React keeps a subscription. Before
 * the first commit it reads `cached`, a store the client kept, so a warm view paints at once.
 */
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

const OptionalLeases = createContext(false);

/**
 * Inside, thread leases are optional (`ClientApi.thread`): they take only spare subscription
 * room and give it up for a thread the person opens. A view that shows more when it can, like
 * the Summary's delegated threads, wraps what it reads in this. Refused or given up, a thread's
 * error reads `no_room`; `useThreadRoom` says when to try again.
 */
export function OptionalLeaseScope(props: { children?: ReactNode }) {
  return createElement(OptionalLeases.Provider, { value: true }, props.children);
}

/** Thread subscriptions an optional lease may still take; 0 when the client can't say. */
export function useThreadRoom(): number {
  const client = useClient();
  const room = useMemo(() => client.threadRoom?.(), [client]);
  return useSyncExternalStore(room?.subscribe ?? noSubscribe, room?.getSnapshot ?? noRoom, noRoom);
}

/**
 * Hold a thread subscription while the component is mounted. The client shares one wire
 * subscription between every holder of the same thread. Before the first commit, the store the
 * client kept for it (it may be syncing), or undefined.
 * Inside a `ThreadWindowProvider` for this thread, the window's source once the tail is held.
 */
export function useThreadStore(threadId: string | undefined): ThreadSource | undefined {
  const client = useClient();
  const window = useThreadWindow(threadId);
  const optional = useContext(OptionalLeases);
  const held = useMemo(
    () =>
      threadId
        ? lease(
            () => client.thread(threadId, optional ? { optional } : undefined),
            client.cachedThread?.(threadId),
          )
        : undefined,
    [client, threadId, optional],
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
const noRoom = () => 0;
