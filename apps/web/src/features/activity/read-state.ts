import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";

/** Which feed events and automation runs this device has read. */
class ReadState {
  private read: ReadonlySet<string> = new Set();
  private listeners = new Set<() => void>();
  snapshot = () => this.read;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  mark(ids: readonly string[]): void {
    if (ids.every((id) => this.read.has(id))) return;
    this.read = new Set([...this.read, ...ids]);
    for (const listener of this.listeners) listener();
  }
}

// One read set per daemon client, so each connection (and each test) starts unread.
const reads = new WeakMap<ClientApi, ReadState>();
export function useReadState(): ReadState {
  const client = useClient();
  let state = reads.get(client);
  if (!state) {
    state = new ReadState();
    reads.set(client, state);
  }
  return state;
}
