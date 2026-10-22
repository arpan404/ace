import type { ConnectionState, Selection } from "@ace/client";
import type { ServerMessage } from "@ace/protocol";
import type { PatchSink } from "./agents.ts";
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

export class NativeReads {
  readonly #cache: ReadCache;
  readonly #keeper: ReadKeeper | undefined;
  readonly #sink: PatchSink;
  readonly #stops: (() => void)[] = [];
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
        if (now && !ready && this.#cache.invalidateAll()) this.#publish();
        ready = now;
      }),
    );
  }

  /** Give Swift the answers an earlier run kept, before any screen asks. */
  async restore(): Promise<void> {
    const restored = (await this.#keeper?.restore()) ?? [];
    for (const read of restored) this.#send(read);
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

  dispose(): void {
    for (const stop of this.#stops.splice(0)) stop();
  }

  #publish(): void {
    this.#sink.put("service:generations", () => ({
      type: "service.generations",
      generations: this.#cache.generations(),
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
