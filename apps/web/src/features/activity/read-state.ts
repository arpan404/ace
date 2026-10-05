import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import {
  applyActivityReads,
  isActivityRead,
  type ActivityItemRef,
  type ActivityReadCursor,
} from "@ace/protocol";
import { firstLaunch } from "@ace/ui-core";
import { useSyncExternalStore } from "react";

type Change = { read?: ActivityItemRef[]; unread?: ActivityItemRef[]; allBefore?: number };

/**
 * Which Activity items have been read: the daemon's cursor (`activity.reads`), so read marks
 * survive reloads and follow the person to every device. Marks apply here at once and are
 * sent in order; ones made offline go out once the connection is back. A daemon without the
 * cursor leaves a cursor for this session, starting at this device's first launch.
 */
export class ReadState {
  private cursor: ActivityReadCursor | undefined;
  /** Marks not yet confirmed by the daemon, oldest first; replayed over each daemon cursor. */
  private pending: Change[] = [];
  private sending = false;
  private local = false;
  private started = false;
  /** When each feed item happened, by id, for marks that name only ids. */
  private readonly known = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly client: ClientApi;
  constructor(client: ClientApi) {
    this.client = client;
  }

  snapshot = (): ActivityReadCursor | undefined => this.cursor;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.start();
    return () => this.listeners.delete(listener);
  };

  /** Notes when items happened, so `mark(ids)` can place them. */
  know(items: readonly ActivityItemRef[]): void {
    for (const item of items) this.known.set(item.id, item.at);
  }
  isRead(item: ActivityItemRef): boolean {
    return this.cursor ? isActivityRead(this.cursor, item) : false;
  }
  /** Mark items read (or unread again). Ids the feed hasn't shown count as just now. */
  mark(ids: readonly string[], read = true): void {
    const refs = ids.map((id) => ({ id, at: this.known.get(id) ?? Date.now() }));
    const changed = refs.filter((ref) => this.isRead(ref) !== read);
    if (!changed.length) return;
    this.change(read ? { read: changed } : { unread: changed });
  }
  /** Everything up to `at` is read (Mark all read). */
  markAllBefore(at: number): void {
    this.change({ allBefore: at });
  }

  private change(change: Change): void {
    this.pending.push(change);
    if (this.cursor) this.cursor = applyActivityReads(this.cursor, change);
    this.emit();
    void this.flush();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** The daemon's cursor, with marks it hasn't confirmed yet laid over it. */
  private adopt(cursor: ActivityReadCursor): void {
    this.cursor = this.pending.reduce(applyActivityReads, cursor);
    this.emit();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.client.onMessage((message) => {
      if (message.type === "activity.reads.changed" && !this.local) this.adopt(message.cursor);
    });
    const connection = this.client.connectionState();
    connection.subscribe(() => {
      if (connection.getSnapshot() === "ready") void this.load();
    });
    void this.load();
  }

  private async load(): Promise<void> {
    if (this.local || this.client.state !== "ready") return;
    try {
      const reply = await this.client.request({ type: "activity.reads" });
      this.adopt(reply.cursor);
      await this.flush();
    } catch {
      if (this.client.state === "ready") this.goLocal();
    }
  }

  private async flush(): Promise<void> {
    if (this.sending || this.local || this.client.state !== "ready") return;
    this.sending = true;
    try {
      while (this.pending.length) {
        const [change] = this.pending;
        if (!change) break;
        const reply = await this.client.request({ type: "activity.markRead", ...change });
        this.pending.shift();
        this.adopt(reply.cursor);
      }
    } catch {
      // Offline: kept, and sent again once the connection is back. A refusal while connected
      // means this daemon has no cursor.
      if (this.client.state === "ready") this.goLocal();
    } finally {
      this.sending = false;
    }
  }

  /** A daemon without the cursor: keep one here for this session. */
  private goLocal(): void {
    if (this.local) return;
    this.local = true;
    const storage = typeof localStorage === "undefined" ? undefined : localStorage;
    const start = { before: firstLaunch(storage, Date.now()), read: [], unread: [], revision: 0 };
    this.cursor = this.pending.splice(0).reduce(applyActivityReads, this.cursor ?? start);
    this.emit();
  }
}

// One read state per daemon client: each connection reads that daemon's cursor.
const reads = new WeakMap<ClientApi, ReadState>();
export function useReadState(): ReadState {
  const client = useClient();
  let state = reads.get(client);
  if (!state) {
    state = new ReadState(client);
    reads.set(client, state);
  }
  return state;
}

/** The cursor, live; undefined until the daemon has answered. */
export function useReadCursor(): ActivityReadCursor | undefined {
  const state = useReadState();
  return useSyncExternalStore(state.subscribe, state.snapshot, state.snapshot);
}
