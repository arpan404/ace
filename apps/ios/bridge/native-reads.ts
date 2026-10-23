import type { ConnectionState, Selection } from "@ace/client";
import type { ServerMessage } from "@ace/protocol";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import type { NewThreadMemory } from "./new-thread.ts";
import { ReadCache, ReadKeeper, type KeptRead, type ReadStorage } from "./read-cache.ts";
import {
  eventFamilies,
  keepable,
  readFamily,
  writeFamilies,
  type ReadFamily,
} from "./read-policy.ts";

/*
 * The service bridge's kept reads (`read-cache.ts`) wired to the phone: Swift keeps a copy of
 * each kept answer (`service.cache`) so a screen draws it in its first frame, and each family's
 * generation (`service.generations`) so a screen showing an out-of-date answer reads it again.
 * Daemon change events, writes and reconnects move the generations; nothing polls.
 * `reconnects` beside them counts the machine coming back, for screens whose reads aren't kept:
 * the one signal every screen reads again on.
 */

export interface ReadsOwner {
  onMessage(listener: (message: ServerMessage) => void): () => void;
  connectionState(): Selection<ConnectionState>;
}
export interface ReadsOptions {
  now(): number;
  schedule(delay: number, run: () => void): () => void;
  /** This machine's storage on the phone; omitted keeps answers for this run only. */
  storage?: ReadStorage;
  /** At most this many answers are kept (`ReadCache`). */
  limit?: number;
}
/** A kept read's name in Swift's copy, sent with the request. */
export interface ReadKey {
  key: string;
  family: ReadFamily;
}

/**
 * A kept read as it was asked: what had happened by then, so an answer that arrives after its
 * family went out of date, after a reconnect, or after a newer answer for the same name is
 * shown to its screen but never kept as fresh.
 */
export interface ReadTicket extends ReadKey {
  readonly generation: number;
  readonly reconnects: number;
  readonly sequence: number;
}

/** Beside the families' generations: how many times the connection came back. */
export const reconnectsKey = "reconnects";
/** Answers the bridge keeps for itself, never handed to Swift's copy. */
const ownPrefix = "bridge:";
const Patch = z.record(z.string(), z.unknown());

export class NativeReads implements NewThreadMemory {
  readonly #cache: ReadCache;
  readonly #keeper: ReadKeeper | undefined;
  readonly #sink: PatchSink;
  readonly #stops: (() => void)[] = [];
  #reconnects = 0;
  #asked = 0;
  /** Per kept name, the order of the newest answer kept. */
  readonly #keptOrder = new Map<string, number>();
  constructor(owner: ReadsOwner, sink: PatchSink, options: ReadsOptions) {
    this.#sink = sink;
    this.#cache = new ReadCache({
      now: options.now,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    this.#keeper = options.storage
      ? new ReadKeeper(this.#cache, options.storage, options.schedule)
      : undefined;
    this.#stops.push(
      owner.onMessage((message) => {
        if (this.#cache.invalidate(eventFamilies(message.type))) this.#publish();
      }),
    );
    const connection = owner.connectionState();
    let ready = connection.getSnapshot() === "ready";
    this.#stops.push(
      connection.subscribe(() => {
        const now = connection.getSnapshot() === "ready";
        if (now && !ready) {
          this.#reconnects++;
          this.#cache.invalidateAll();
          this.#publish();
        }
        ready = now;
      }),
    );
  }

  /** Give Swift the answers an earlier run kept, before any screen asks. */
  async restore(): Promise<void> {
    const restored = (await this.#keeper?.restore()) ?? [];
    for (const read of restored) if (!read.key.startsWith(ownPrefix)) this.#send(read);
  }

  /** The request's kept-read name, when Swift named it and its answer is kept. */
  key(request: unknown, key: string | undefined): ReadTicket | undefined {
    const family = key ? readFamily(request) : undefined;
    if (!key || !family) return undefined;
    return {
      key,
      family,
      generation: this.#cache.generation(family),
      reconnects: this.#reconnects,
      sequence: ++this.#asked,
    };
  }

  /**
   * Where a family's answers stand: it changes whenever they go out of date or the connection
   * comes back. Memory kept elsewhere for the family is good only under the same stamp.
   */
  stamp(family: ReadFamily): string {
    return `${this.#cache.generation(family)}:${this.#reconnects}`;
  }

  /** The kept answer to give without asking the daemon. */
  fresh(read: ReadKey): unknown {
    return this.#cache.fresh(read.key);
  }

  /** The daemon answered a kept read. A refusal or an obsolete answer is never kept. */
  answered(read: ReadTicket, value: unknown): boolean {
    if (!keepable(value) || this.#obsolete(read)) return false;
    this.#keptOrder.set(read.key, read.sequence);
    this.#evicted(this.#cache.put(read.key, read.family, value));
    this.#keeper?.changed();
    return true;
  }

  /** A request that changes daemon data succeeded: what it touched is read again. */
  wrote(request: unknown): void {
    if (this.#cache.invalidate(writeFamilies(request))) this.#publish();
  }

  /** New thread's last lists (`new-thread.ts`), kept beside Swift's reads. */
  recall(key: string): Record<string, unknown> | undefined {
    return Patch.safeParse(this.#cache.latest(ownPrefix + key)).data;
  }
  keep(key: string, family: ReadFamily, patch: Record<string, unknown>): void {
    this.#evicted(this.#cache.put(ownPrefix + key, family, patch));
    this.#keeper?.changed();
  }

  dispose(): void {
    for (const stop of this.#stops.splice(0)) stop();
  }

  #obsolete(read: ReadTicket): boolean {
    return (
      read.generation !== this.#cache.generation(read.family) ||
      read.reconnects !== this.#reconnects ||
      read.sequence < (this.#keptOrder.get(read.key) ?? 0)
    );
  }

  #publish(): void {
    this.#sink.put("service:generations", () => ({
      type: "service.generations",
      generations: {
        ...this.#cache.generations(),
        ...(this.#reconnects ? { [reconnectsKey]: this.#reconnects } : {}),
      },
    }));
  }

  /** Answers the cache pushed out leave Swift's copy too; one it is still sending is withdrawn. */
  #evicted(keys: readonly string[]): void {
    for (const key of keys) {
      this.#keptOrder.delete(key);
      if (key.startsWith(ownPrefix)) continue;
      this.#sink.put(`service:cache:${key}`, () => ({ type: "service.evict", key }));
    }
  }

  #send(read: KeptRead): void {
    this.#sink.put(`service:cache:${read.key}`, () => ({
      type: "service.cache",
      key: read.key,
      family: read.family,
      value: read.value,
    }));
  }
}
