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
}
/** A kept read's name in Swift's copy, sent with the request. */
export interface ReadKey {
  key: string;
  family: ReadFamily;
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
  constructor(owner: ReadsOwner, sink: PatchSink, options: ReadsOptions) {
    this.#sink = sink;
    this.#cache = new ReadCache({ now: options.now });
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
  key(request: unknown, key: string | undefined): ReadKey | undefined {
    const family = key ? readFamily(request) : undefined;
    return key && family ? { key, family } : undefined;
  }

  /** The kept answer to give without asking the daemon. */
  fresh(read: ReadKey): unknown {
    return this.#cache.fresh(read.key);
  }

  /** The daemon answered a kept read. A refusal is never kept. */
  answered(read: ReadKey, value: unknown): boolean {
    if (!keepable(value)) return false;
    this.#cache.put(read.key, read.family, value);
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
    this.#cache.put(ownPrefix + key, family, patch);
    this.#keeper?.changed();
  }

  dispose(): void {
    for (const stop of this.#stops.splice(0)) stop();
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

  #send(read: KeptRead): void {
    this.#sink.put(`service:cache:${read.key}`, () => ({
      type: "service.cache",
      key: read.key,
      family: read.family,
      value: read.value,
    }));
  }
}
