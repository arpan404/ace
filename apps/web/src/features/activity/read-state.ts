import { ClientError, type ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { activityReadLimits, type ActivityItemRef, type ActivityReadCursor } from "@ace/protocol";
import {
  applyActivityReads,
  isActivityRead,
  type ActivityReadChange,
} from "@ace/projection/activity-reads";
import { firstLaunch } from "@ace/ui-core";
import { useSyncExternalStore } from "react";

export type Change = { read?: ActivityItemRef[]; unread?: ActivityItemRef[]; allBefore?: number };

/** Where read marks live: the daemon, or (a daemon without the cursor) this session only. */
export type ReadMode = "daemon" | "local" | "refused";

/** Daemon answers meaning "there is no read cursor here", as opposed to "not right now". */
const unsupported = new Set(["activity_unavailable", "invalid_message", "unknown_message"]);
const retryMs = [2_000, 5_000, 15_000, 30_000] as const;

const newestFirst = (a: ActivityItemRef, b: ActivityItemRef) => b.at - a.at;
const capped = (items: Map<string, ActivityItemRef>) =>
  [...items.values()].toSorted(newestFirst).slice(0, activityReadLimits.change);

/**
 * Two changes as one, in order: a later Mark all read supersedes earlier marks it covers, a
 * later mark of an item replaces an earlier one. Each list keeps the newest marks the protocol
 * allows in one change; older ones beyond that are dropped (they're the oldest marks, and
 * the cursor itself keeps no more).
 */
export function compactChanges(first: Change, later: Change): Change {
  const allBefore =
    first.allBefore === undefined && later.allBefore === undefined
      ? undefined
      : Math.max(first.allBefore ?? 0, later.allBefore ?? 0);
  const covered = (item: ActivityItemRef) =>
    later.allBefore !== undefined && item.at <= later.allBefore;
  const read = new Map((first.read ?? []).filter((item) => !covered(item)).map((i) => [i.id, i]));
  const unread = new Map(
    (first.unread ?? []).filter((item) => !covered(item)).map((i) => [i.id, i]),
  );
  for (const item of later.read ?? []) {
    unread.delete(item.id);
    read.set(item.id, item);
  }
  for (const item of later.unread ?? []) {
    read.delete(item.id);
    unread.set(item.id, item);
  }
  return {
    ...(allBefore === undefined ? {} : { allBefore }),
    ...(read.size ? { read: capped(read) } : {}),
    ...(unread.size ? { unread: capped(unread) } : {}),
  };
}

const asChange = (change: Change): ActivityReadChange => change;

/**
 * Which Activity items have been read: the daemon's cursor (`activity.reads`), so read marks
 * survive reloads and follow the person to every device. Marks apply here at once and are
 * sent in order. A mark the daemon couldn't take yet (offline, a timeout) is kept, folded into
 * at most one waiting change, and sent again: after a short backoff while connected, and once
 * the connection is back. Only a daemon that has no cursor at all leaves a cursor for this
 * session (from this device's first launch); a refusal (this device may not change it) is said
 * in the list.
 */
export class ReadState {
  private cursor: ActivityReadCursor | undefined;
  /** The newest daemon revision taken; older replies and pushes are stale. */
  private revision = -1;
  private inflight: Change | undefined;
  private queued: Change | undefined;
  private sending = false;
  private failures = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private mode: ReadMode = "daemon";
  private started = false;
  /** When each item the feed shows happened, by id, for marks that name only ids. */
  private known = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly client: ClientApi;
  private readonly now: () => number;
  constructor(client: ClientApi, now: () => number = Date.now) {
    this.client = client;
    this.now = now;
  }

  snapshot = (): ActivityReadCursor | undefined => this.cursor;
  readMode = (): ReadMode => this.mode;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.start();
    return () => this.listeners.delete(listener);
  };

  /** The items the feed shows now, so `mark(ids)` can place them. Replaces the last set. */
  know(items: readonly ActivityItemRef[]): void {
    this.known = new Map(items.map((item) => [item.id, item.at]));
  }
  isRead(item: ActivityItemRef): boolean {
    return this.cursor ? isActivityRead(this.cursor, item) : false;
  }
  /** Mark items read (or unread again). Ids the feed doesn't show count as just now. */
  mark(ids: readonly string[], read = true): void {
    const refs = ids.map((id) => ({ id, at: this.known.get(id) ?? this.now() }));
    const changed = refs.filter((ref) => this.isRead(ref) !== read);
    if (!changed.length) return;
    this.change(read ? { read: changed } : { unread: changed });
  }
  /** Everything up to `at` is read (Mark all read). */
  markAllBefore(at: number): void {
    this.change({ allBefore: at });
  }

  private change(change: Change): void {
    if (this.cursor) this.cursor = applyActivityReads(this.cursor, asChange(change));
    if (this.mode === "daemon")
      this.queued = this.queued ? compactChanges(this.queued, change) : change;
    this.emit();
    void this.flush();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** The daemon's cursor, with marks it hasn't confirmed yet laid over it. */
  private adopt(cursor: ActivityReadCursor): void {
    if (cursor.revision < this.revision) return;
    this.revision = cursor.revision;
    const pending = [this.inflight, this.queued].filter((change) => change !== undefined);
    this.cursor = pending.reduce(
      (current, change) => applyActivityReads(current, asChange(change)),
      cursor,
    );
    this.emit();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.client.onMessage((message) => {
      if (message.type === "activity.reads.changed" && this.mode === "daemon")
        this.adopt(message.cursor);
    });
    const connection = this.client.connectionState();
    connection.subscribe(() => {
      if (connection.getSnapshot() === "ready") void this.load();
    });
    void this.load();
  }

  private async load(): Promise<void> {
    if (this.mode !== "daemon" || this.client.state !== "ready") return;
    try {
      const reply = await this.client.request({ type: "activity.reads" });
      this.adopt(reply.cursor);
      await this.flush();
    } catch (error) {
      this.failed(error);
    }
  }

  private async flush(): Promise<void> {
    if (this.sending || this.mode !== "daemon" || this.client.state !== "ready") return;
    this.sending = true;
    try {
      while (this.queued) {
        this.inflight = this.queued;
        this.queued = undefined;
        const reply = await this.client.request({ type: "activity.markRead", ...this.inflight });
        this.inflight = undefined;
        this.failures = 0;
        this.adopt(reply.cursor);
      }
    } catch (error) {
      // Not taken: it goes back in front of anything marked since.
      if (this.inflight)
        this.queued = this.queued ? compactChanges(this.inflight, this.queued) : this.inflight;
      this.inflight = undefined;
      this.failed(error);
    } finally {
      this.sending = false;
    }
  }

  /** Unsupported: a session cursor. Refused: the same, said in the list. Else: try again. */
  private failed(error: unknown): void {
    const code = error instanceof ClientError ? error.message : undefined;
    if (error instanceof ClientError && error.code === "daemon" && code === "forbidden")
      return this.goLocal("refused");
    if (
      error instanceof ClientError &&
      (error.code === "protocol" || (error.code === "daemon" && unsupported.has(code ?? "")))
    )
      return this.goLocal("local");
    if (this.retry !== undefined || this.client.state !== "ready") return;
    const delay = retryMs[Math.min(this.failures, retryMs.length - 1)];
    this.failures += 1;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.load();
    }, delay);
  }

  private goLocal(mode: Exclude<ReadMode, "daemon">): void {
    this.mode = mode;
    this.queued = undefined;
    this.inflight = undefined;
    if (!this.cursor) {
      const storage = typeof localStorage === "undefined" ? undefined : localStorage;
      this.cursor = { before: firstLaunch(storage, this.now()), read: [], unread: [], revision: 0 };
    }
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

/** Whether read marks reach the daemon, stay in this session, or were refused. */
export function useReadMode(): ReadMode {
  const state = useReadState();
  return useSyncExternalStore(state.subscribe, state.readMode, state.readMode);
}
