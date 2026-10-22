import { z } from "zod";
import type { ReadFamily } from "./read-policy.ts";

/*
 * The phone's kept daemon reads, as the web's query cache keeps them: an answer younger than
 * `freshMs` that nothing has put out of date is given again without asking the daemon; an older
 * or out-of-date one is still drawn (Swift holds a copy) while the daemon is asked again. Each
 * family carries a generation that moves whenever its answers go out of date, so a screen
 * showing one reads it again. Kept answers outlive the app through `ReadKeeper`.
 */

export interface KeptRead {
  key: string;
  family: ReadFamily;
  value: unknown;
  /** When the daemon gave it, in the injected clock's milliseconds. */
  at: number;
}
interface Entry extends KeptRead {
  stale: boolean;
}
export interface ReadCacheOptions {
  now(): number;
  /** The web's default staleTime. */
  freshMs?: number;
  /** At most this many answers are kept; the most recently given win. */
  limit?: number;
}

export class ReadCache {
  #entries = new Map<string, Entry>();
  #generations = new Map<ReadFamily, number>();
  #now: () => number;
  #freshMs: number;
  #limit: number;
  constructor(options: ReadCacheOptions) {
    this.#now = options.now;
    this.#freshMs = options.freshMs ?? 5_000;
    this.#limit = options.limit ?? 120;
  }

  /** The kept answer when it can be given without asking the daemon. */
  fresh(key: string): unknown {
    const entry = this.#entries.get(key);
    if (!entry || entry.stale || this.#now() - entry.at >= this.#freshMs) return undefined;
    return entry.value;
  }

  /** The kept answer however old, for drawing while it is read again. */
  latest(key: string): unknown {
    return this.#entries.get(key)?.value;
  }

  put(key: string, family: ReadFamily, value: unknown): void {
    this.#entries.delete(key);
    this.#entries.set(key, { key, family, value, at: this.#now(), stale: false });
    for (const old of this.#entries.keys()) {
      if (this.#entries.size <= this.#limit) break;
      this.#entries.delete(old);
    }
  }

  /** Put every answer of `families` out of date and move their generations. */
  invalidate(families: Iterable<ReadFamily>): boolean {
    const touched = new Set(families);
    if (!touched.size) return false;
    for (const family of touched)
      this.#generations.set(family, (this.#generations.get(family) ?? 0) + 1);
    for (const entry of this.#entries.values()) if (touched.has(entry.family)) entry.stale = true;
    return true;
  }

  /** After a reconnect everything may have changed while the phone wasn't listening. */
  invalidateAll(): boolean {
    const families = new Set<ReadFamily>([
      ...this.#generations.keys(),
      ...[...this.#entries.values()].map((entry) => entry.family),
    ]);
    return this.invalidate(families);
  }

  /** Each family's generation, for the screens that show its answers. */
  generations(): Record<string, number> {
    return Object.fromEntries(this.#generations);
  }

  /** What is kept, oldest first. */
  kept(): KeptRead[] {
    return [...this.#entries.values()].map(({ key, family, value, at }) => ({
      key,
      family,
      value,
      at,
    }));
  }

  /**
   * Answers an earlier run kept, never over newer ones. They are out of date until the daemon
   * answers again, like the web's restored queries.
   */
  restore(reads: readonly KeptRead[]): KeptRead[] {
    const restored: KeptRead[] = [];
    for (const read of reads) {
      const current = this.#entries.get(read.key);
      if (current && current.at >= read.at) continue;
      this.#entries.set(read.key, { ...read, stale: true });
      restored.push(read);
    }
    return restored;
  }
}

const families = [
  "projects",
  "settings",
  "source-control",
  "automations",
  "usage",
  "plugins",
  "prompts",
  "catalog",
  "forge",
] as const satisfies readonly ReadFamily[];
/** The kept record's shape. A new version starts empty rather than reading another shape. */
const recordVersion = 1;
const KeptRecord = z.object({
  version: z.literal(recordVersion),
  reads: z.array(
    z.object({
      key: z.string().max(4096),
      family: z.enum(families),
      value: z.unknown(),
      at: z.number(),
    }),
  ),
});

/** At most this many UTF-16 code units of kept answers are written; the newest win. */
export const keptBudget = 1_500_000;

/** The record to write: the newest answers that fit the budget. */
export function keptRecord(reads: readonly KeptRead[], budget = keptBudget): string {
  const chosen: string[] = [];
  let used = 0;
  for (const read of reads.toSorted((a, b) => b.at - a.at)) {
    const text = JSON.stringify(read);
    if (text === undefined || used + text.length > budget) continue;
    used += text.length;
    chosen.push(text);
  }
  return `{"version":${recordVersion},"reads":[${chosen.join(",")}]}`;
}

/** The answers a record holds, or none when it is missing, damaged or of another version. */
export function parseKeptRecord(text: string): KeptRead[] {
  if (!text) return [];
  try {
    const parsed = KeptRecord.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.reads : [];
  } catch {
    return [];
  }
}

export interface ReadStorage {
  load(): Promise<string>;
  save(text: string): Promise<void>;
}

/**
 * Keeps a cache's answers in the phone's storage for this machine: restores an earlier run's
 * answers, then writes changes at most once per `writeMs`.
 */
export class ReadKeeper {
  #cache: ReadCache;
  #storage: ReadStorage;
  #schedule: (delay: number, run: () => void) => () => void;
  #writeMs: number;
  #scheduled = false;
  constructor(
    cache: ReadCache,
    storage: ReadStorage,
    schedule: (delay: number, run: () => void) => () => void,
    writeMs = 1_000,
  ) {
    this.#cache = cache;
    this.#storage = storage;
    this.#schedule = schedule;
    this.#writeMs = writeMs;
  }

  /** The answers restored from storage; a failed read restores nothing. */
  async restore(): Promise<KeptRead[]> {
    try {
      return this.#cache.restore(parseKeptRecord(await this.#storage.load()));
    } catch {
      return [];
    }
  }

  /** Write the cache soon; several changes in a row write once. */
  changed(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#schedule(this.#writeMs, () => {
      this.#scheduled = false;
      void this.#storage.save(keptRecord(this.#cache.kept())).catch(() => {});
    });
  }
}
