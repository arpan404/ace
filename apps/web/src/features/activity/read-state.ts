import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";

/** Read marks kept per connection; far more than the feed ever shows at once. */
const remembered = 10_000;

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
    const next = new Set([...this.read, ...ids]);
    // Keep the newest marks only: the feed shows recent events, and a month of them would
    // otherwise all stay here (and be copied on every mark).
    for (const id of next) {
      if (next.size <= remembered) break;
      next.delete(id);
    }
    this.read = next;
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
