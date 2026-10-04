import type { ThreadListEntry } from "@ace/protocol";
import type { SidebarSource, Lease } from "./api.ts";
import { Notifications, type Selection } from "./observable.ts";
import type { MachineEntry } from "./machine-directory.ts";

export interface MachineThreadRef {
  hostId: string;
  threadId: string;
}
export interface MachineThread extends MachineThreadRef {
  key: string;
  machine: MachineEntry;
  thread: ThreadListEntry;
}
export interface MachineThreadChange {
  key: string;
  previous: MachineThread | undefined;
  current: MachineThread | undefined;
}
export function machineThreadKey(ref: MachineThreadRef): string {
  return JSON.stringify([ref.hostId, ref.threadId]);
}
interface Source {
  entry: MachineEntry;
  lease: Lease<SidebarSource>;
  stop(): void;
  keys: Set<string>;
}

/** Stable machine insertion order, then each daemon's insertion order. Deltas never sort history. */
export class MachineThreads {
  private sources = new Map<string, Source>();
  private machines = new Map<string, MachineEntry>();
  private rows = new Map<string, MachineThread>();
  private order: readonly string[] | undefined;
  private notifications = new Notifications(4096);
  private revision = 0;
  private changes = new Set<(change: MachineThreadChange) => void>();
  get ids(): readonly string[] {
    if (this.order) return this.order;
    const ids: string[] = [];
    for (const hostId of this.machines.keys()) {
      const source = this.sources.get(hostId);
      if (source) for (const key of source.keys) ids.push(key);
    }
    return (this.order = ids);
  }
  thread(key: string): MachineThread | undefined {
    return this.rows.get(key);
  }
  loaded(hostId: string): boolean {
    return this.sources.get(hostId)?.lease.store.loaded ?? false;
  }
  select<T>(
    keys: readonly string[],
    read: (store: MachineThreads) => T,
    equal?: (a: T, b: T) => boolean,
  ): Selection<T> {
    return this.notifications.select(keys, () => read(this), equal);
  }
  /** Count consumers subtract previous and add current, touching only changed rows. */
  observeChanges(listener: (change: MachineThreadChange) => void): () => void {
    this.changes.add(listener);
    return () => {
      this.changes.delete(listener);
    };
  }
  /** Initialize once, then adjust counts from changed rows using the caller's existing rule. */
  count(predicate: (row: MachineThread) => boolean): Selection<number> {
    let value = 0;
    let seen = -1;
    let stop: (() => void) | undefined;
    const listeners = new Set<() => void>();
    const read = () => {
      if (!listeners.size && seen !== this.revision) {
        value = 0;
        for (const row of this.rows.values()) if (predicate(row)) value++;
        seen = this.revision;
      }
      return value;
    };
    return {
      getSnapshot: read,
      subscribe: (listener) => {
        read();
        if (!listeners.size)
          stop = this.observeChanges(({ previous, current }) => {
            const next =
              value +
              Number(Boolean(current && predicate(current))) -
              Number(Boolean(previous && predicate(previous)));
            seen = this.revision;
            if (next === value) return;
            value = next;
            for (const notify of listeners) notify();
          });
        listeners.add(listener);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          listeners.delete(listener);
          if (!listeners.size) {
            stop?.();
            stop = undefined;
          }
        };
      },
    };
  }
  register(entry: MachineEntry): void {
    this.machines.set(entry.hostId, entry);
    this.order = undefined;
  }
  attach(entry: MachineEntry, lease: Lease<SidebarSource>): void {
    const existing = this.sources.get(entry.hostId);
    if (existing) {
      existing.stop();
      existing.lease.release();
    }
    if (!this.machines.has(entry.hostId)) this.register(entry);
    const source: Source = { entry, lease, keys: new Set(existing?.keys), stop: () => {} };
    this.sources.set(entry.hostId, source);
    source.stop = lease.store.observe((keys) => this.update(source, keys));
    this.update(source, "all");
  }
  rename(entry: MachineEntry): void {
    const source = this.sources.get(entry.hostId);
    if (!source) return;
    source.entry = entry;
    const changed = new Set<string>();
    for (const key of source.keys) {
      const row = this.rows.get(key);
      if (row) this.replace(key, { ...row, machine: entry }, changed);
    }
    this.notifications.emit(changed);
  }
  detach(hostId: string): void {
    const source = this.sources.get(hostId);
    this.machines.delete(hostId);
    this.order = undefined;
    if (!source) return;
    source.stop();
    source.lease.release();
    this.sources.delete(hostId);
    const changed = new Set<string>();
    for (const key of source.keys) this.replace(key, undefined, changed);
    this.order = undefined;
    changed.add("ids");
    changed.add(`loaded:${hostId}`);
    this.notifications.emit(changed);
  }
  private replace(key: string, row: MachineThread | undefined, changed: Set<string>): void {
    const previous = this.rows.get(key);
    if (previous?.thread === row?.thread && previous?.machine === row?.machine) return;
    if (row) this.rows.set(key, row);
    else this.rows.delete(key);
    this.revision++;
    changed.add(`thread:${key}`);
    changed.add("threads");
    for (const listener of this.changes) listener({ key, previous, current: row });
  }
  private update(source: Source, keys: ReadonlySet<string> | "all"): void {
    const store = source.lease.store;
    const changed = new Set<string>();
    const reset = keys === "all";
    const ids = reset
      ? new Set(store.ids)
      : new Set([...keys].filter((key) => key.startsWith("thread:")).map((key) => key.slice(7)));
    if (reset) {
      for (const key of source.keys) {
        const row = this.rows.get(key);
        if (row && !ids.has(row.threadId)) {
          this.replace(key, undefined, changed);
          source.keys.delete(key);
        }
      }
    }
    let membership = reset;
    for (const threadId of ids) {
      const ref = { hostId: source.entry.hostId, threadId };
      const key = machineThreadKey(ref);
      const thread = store.thread(threadId);
      const had = source.keys.has(key);
      if (thread) source.keys.add(key);
      else source.keys.delete(key);
      if (had !== Boolean(thread)) membership = true;
      this.replace(
        key,
        thread ? { ...ref, key, machine: source.entry, thread } : undefined,
        changed,
      );
    }
    if (membership) {
      // Materialize IDs only when read. Updating membership itself touches changed keys.
      this.order = undefined;
      changed.add("ids");
    }
    if (reset) changed.add(`loaded:${source.entry.hostId}`);
    this.notifications.emit(changed);
  }
}
