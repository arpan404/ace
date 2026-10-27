import type { CatalogEntry } from "@ace/protocol";
import type { ClientCore, Lease, ThreadSource } from "@ace/client";
import type { ChatCacheHost } from "./chat-cache.ts";
import { LedgerShelf } from "./native-ledger.ts";
import { followThread, type PatchPump } from "./patches.ts";
import { nativeChunks, type AttachmentTray, type ChunkReader } from "./thread-attachments.ts";
import { ThreadSession } from "./thread-session.ts";

/*
 * The thread open on the phone: its lease, what follows it to native, its session and its
 * navigation generation, which moves in step with native's on every open and back. Reloading it
 * from the machine (`chat-cache.ts`) leaves and opens it again under the next generation, and the
 * message's staged files go with it.
 */

/** What else on the phone follows the open thread (sheets, browser, transfers). */
export interface VisitHooks {
  /** The open thread is going, for another or for none. */
  leaving(): void;
  /** `threadId` is now open under `epoch`. */
  opened(threadId: string, epoch: number, store: ThreadSource): void;
  /** The history window the person reads in `threadId`, when one is open. */
  reading?(threadId: string): ThreadSource | undefined;
}

export class ThreadVisit {
  readonly #pump: PatchPump;
  readonly #hooks: VisitHooks;
  readonly #chunks: ChunkReader;
  readonly #catalog: (threadId: string) => readonly CatalogEntry[] | undefined;
  /**
   * Native keeps the open thread and the last six it showed (`ThreadShelf.swift`); ledgers past
   * 4 Mi UTF-16 units go too, the oldest first.
   */
  readonly #ledgers = new LedgerShelf(7, 4 * 1024 * 1024);
  #lease: Lease<ThreadSource> | undefined;
  #stop: (() => void) | undefined;
  #session: ThreadSession | undefined;
  #threadId: string | undefined;
  #epoch = 0;

  constructor(
    pump: PatchPump,
    hooks: VisitHooks,
    catalog: (threadId: string) => readonly CatalogEntry[] | undefined = () => undefined,
    chunks: ChunkReader = nativeChunks,
  ) {
    this.#pump = pump;
    this.#hooks = hooks;
    this.#catalog = catalog;
    this.#chunks = chunks;
  }

  get threadId(): string | undefined {
    return this.#threadId;
  }
  get store(): ThreadSource | undefined {
    return this.#lease?.store;
  }
  get session(): ThreadSession | undefined {
    return this.#session;
  }
  get epoch(): number {
    return this.#epoch;
  }

  /** Show `threadId` under the next generation, as native's `open` does. */
  open(client: ClientCore, threadId: string, warm: boolean, kept?: AttachmentTray): void {
    this.#hooks.leaving();
    this.#stop?.();
    this.#lease?.release();
    this.#threadId = threadId;
    const lease = client.thread(threadId);
    this.#lease = lease;
    this.#session?.dispose();
    const ledger = this.#ledgers.open(threadId, warm);
    this.#pump.bind(ledger, ++this.#epoch);
    this.#stop = followThread(lease.store, threadId, this.#epoch, this.#pump, ledger);
    this.#session = new ThreadSession(
      client,
      lease.store,
      threadId,
      this.#epoch,
      this.#pump,
      this.#chunks,
      this.#catalog,
      () => this.#hooks.reading?.(threadId),
      kept,
    );
    this.#hooks.opened(threadId, this.#epoch, lease.store);
  }

  /** Native went back: no thread is open under the next generation. */
  back(): void {
    this.#epoch++;
    this.#pump.bind(undefined, this.#epoch);
    this.#leave();
  }

  /** The reload hooks `chat-cache.ts` drives for this phone's open thread. */
  reloads(client: ClientCore): Pick<ChatCacheHost, "openThread" | "leave" | "reopen"> {
    let kept: AttachmentTray | undefined;
    return {
      openThread: () => this.#threadId,
      leave: () => {
        // The message's files stay on it while the transcript is read again.
        kept = this.#session?.keepTray();
        this.#leave();
      },
      reopen: (threadId) => {
        this.open(client, threadId, false, kept);
        kept = undefined;
      },
    };
  }

  /** Stop following the open thread and let its lease go; the caller moves the generation. */
  #leave(): void {
    this.#hooks.leaving();
    this.#ledgers.trim();
    this.#session?.dispose();
    this.#session = undefined;
    this.#stop?.();
    this.#stop = undefined;
    this.#lease?.release();
    this.#lease = undefined;
    this.#threadId = undefined;
  }
}
