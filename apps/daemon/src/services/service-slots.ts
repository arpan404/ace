import type { Services } from "./types.ts";

/** One start attempt of a service, as the owner of the slots it published. */
export type SlotOwner = object;

interface Watcher {
  listener: (value: unknown) => void;
  /** The value it last heard, so a value it already has is never repeated. */
  heard: { value: unknown } | undefined;
}

/**
 * The shared `services` object, as the services that follow one another's slots see it.
 * Each slot remembers which start attempt published it, so only that attempt's failure or
 * shutdown withdraws it. Followers hear every change once, in order and as the slot is when
 * they hear it, so one that republishes while being told never leaves another with a stale value.
 */
export class ServiceSlots {
  private readonly services: Partial<Services>;
  private readonly failed: (key: string, error: unknown) => void;
  private readonly watchers = new Map<string, Set<Watcher>>();
  private readonly owners = new Map<string, { owner: SlotOwner; value: unknown }>();
  private readonly due: string[] = [];
  private telling = false;

  constructor(services: Partial<Services>, failed: (key: string, error: unknown) => void) {
    this.services = services;
    this.failed = failed;
  }

  /** Calls `listener` with the slot now and on each change; a throw is logged, never raised. */
  watch<K extends keyof Services>(
    key: K,
    listener: (value: Services[K] | undefined) => void,
  ): () => void {
    // Each slot's watchers hear only that slot's value.
    const watcher: Watcher = { listener: listener as (value: unknown) => void, heard: undefined };
    const watchers = this.watchers.get(key) ?? new Set();
    this.watchers.set(key, watchers);
    watchers.add(watcher);
    this.tell(key, watcher);
    return () => void watchers.delete(watcher);
  }

  /** Sets a slot for `owner` without telling anyone yet (see `announce`). */
  claim(owner: SlotOwner, key: string, value: unknown): void {
    Reflect.set(this.services, key, value);
    this.owners.set(key, { owner, value });
  }

  /** Tells the followers of `keys` what their slots hold now. */
  announce(keys: readonly string[]): void {
    this.due.push(...keys);
    if (this.telling) return;
    this.telling = true;
    try {
      for (let key = this.due.shift(); key !== undefined; key = this.due.shift()) {
        // Those watching when the change came: one added meanwhile already heard it.
        const recipients = Array.from(this.watchers.get(key) ?? []);
        for (const watcher of recipients) this.tell(key, watcher);
      }
    } finally {
      this.telling = false;
    }
  }

  /** Empties every slot `owner` still holds, and tells their followers. */
  withdraw(owner: SlotOwner): void {
    const keys: string[] = [];
    for (const [key, held] of this.owners) {
      if (held.owner !== owner) continue;
      this.owners.delete(key);
      if (Reflect.get(this.services, key) !== held.value) continue;
      Reflect.deleteProperty(this.services, key);
      keys.push(key);
    }
    this.announce(keys);
  }

  private tell(key: string, watcher: Watcher): void {
    const value: unknown = Reflect.get(this.services, key);
    if (watcher.heard && watcher.heard.value === value) return;
    watcher.heard = { value };
    try {
      watcher.listener(value);
    } catch (error) {
      this.failed(key, error);
    }
  }
}
