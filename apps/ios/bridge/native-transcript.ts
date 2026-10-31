import type { ClientCore, Lease, ThreadSource } from "@ace/client";
import { inRootLane } from "@ace/projection";
import { ItemId, ThreadId } from "@ace/protocol";
import { JumpController, jumpedSource, type JumpSnapshot, type WindowBounds } from "@ace/ui-core";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import { followThread } from "./patches.ts";
import { ReadingSource } from "./reading-source.ts";
import { HistoryWindowReads, confirmHistorySource } from "./history-window-reads.ts";
import { historyBlockSpans, historyWindowMetadata } from "./history-window-metadata.ts";
import { followBlocks } from "./thread-blocks.ts";

/*
 * The phone's history window (ADR 0062): the shared `JumpController` holds at most one bounded
 * window beside the subscribed live tail, slides it by whole turns as the reader pages older or
 * newer, evicts at the end away from the reader, joins it to the tail where they meet and opens
 * it around an item for a jump. Its rows reach Swift as patches under `reading:`, scoped to the
 * reading view's generation (a negative epoch Swift picks), from the same row and block followers
 * as the live transcript, so a page sends only what it added or evicted, and a joined window's
 * streaming rows stay live. Replies carry only where the window stands.
 */

/**
 * The phone's window: a few hundred rows (dozens of screens), as the web's agent transcript
 * holds. Every frame that moves the window re-lays out the rows it holds, so the bound is the
 * cost of each page on the main thread and of the memory the rows keep.
 */
export const phoneWindow: WindowBounds = { capacity: 400, weight: 2 * 1024 * 1024 };

export const NativeTranscriptRequest = z
  .object({
    type: z.literal("native.transcript"),
    threadId: ThreadId,
    /** The reading view's generation: its patches carry it as their epoch. */
    epoch: z.number().int().negative(),
    operation: z.enum(["hold", "follow", "older", "newer", "live", "item", "turn"]),
    /** The item a jump brings into view (`operation: "item"`). */
    itemId: ItemId.optional(),
    /** The turn a jump opens at its ask (`operation: "turn"`). */
    ordinal: z.number().int().positive().optional(),
    /** The reader's semantic anchor when reconnect rebuilds a stale window. */
    anchorItemId: ItemId.optional(),
  })
  .refine((value) => (value.operation === "item") === (value.itemId !== undefined))
  .refine((value) => (value.operation === "turn") === (value.ordinal !== undefined));
type Query = z.infer<typeof NativeTranscriptRequest>;

export interface TranscriptState extends ReturnType<typeof historyWindowMetadata> {
  active: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  joined: boolean;
  /** The item a jump aimed at, to scroll to once its rows land. */
  focus: string | null;
  /** Items in the window and the tail rows joined to it, as the reading view shows them. */
  count: number;
  freshness: "current" | "cached";
}

const atLive: TranscriptState = {
  ...historyWindowMetadata([], [], () => false, null, null),
  active: false,
  hasOlder: false,
  hasNewer: false,
  joined: true,
  focus: null,
  count: 0,
  freshness: "current",
};

interface Active {
  threadId: string;
  epoch: number;
  lease: Lease<ThreadSource>;
  jump: JumpController;
  reads: HistoryWindowReads;
  blocks?: ReturnType<typeof followBlocks>;
  deleted: Set<string>;
  stops: (() => void)[];
  shown?: { window: NonNullable<JumpSnapshot["window"]>; joined: boolean; reading: ReadingSource };
}

export class NativeTranscript {
  #active: Active | undefined;
  readonly client: ClientCore;
  readonly #sink: PatchSink;
  readonly #bounds: WindowBounds;
  constructor(client: ClientCore, sink: PatchSink, bounds: WindowBounds = phoneWindow) {
    this.client = client;
    this.#sink = sink;
    this.#bounds = bounds;
  }

  /** The history window the person reads in thread `threadId`, when one is open. */
  source(threadId: string): ThreadSource | undefined {
    const active = this.#active;
    return active?.threadId === threadId ? active.shown?.reading.source : undefined;
  }

  /** Back to the live tail: the window, its lease and its rows go. */
  close(): void {
    this.#retire()?.lease.release();
  }

  /** Retire the window while allowing a reconnect rebuild to transfer its live lease. */
  #retire(): Active | undefined {
    const active = this.#active;
    if (!active) return undefined;
    this.#active = undefined;
    active.jump.dispose();
    for (const stop of active.stops.splice(0).toReversed()) stop();
    active.shown?.reading.dispose();
    return active;
  }

  async read(query: Query, signal: AbortSignal): Promise<TranscriptState> {
    if (query.operation === "live") {
      this.close();
      return atLive;
    }
    const previous = this.#active;
    if (
      previous?.threadId === query.threadId &&
      previous.reads.cached &&
      this.client.state === "ready"
    ) {
      await confirmHistorySource(this.client, previous.lease.store, signal);
      if (this.#active !== previous) throw new Error("Reading cancelled");
    }
    const previousBlocks =
      previous?.threadId === query.threadId && previous.shown && previous.blocks
        ? historyBlockSpans(previous.shown.reading.source, previous.blocks.snapshot())
        : [];
    const confirmed = previous?.lease.store;
    const rebuild =
      previous?.reads.cached === true &&
      previous.threadId === query.threadId &&
      this.client.state === "ready" &&
      confirmed?.thread !== undefined &&
      !confirmed.syncing &&
      !confirmed.unconfirmed;
    const restore = rebuild
      ? (query.anchorItemId ??
        previous.shown?.window.targetId ??
        previous.shown?.reading.source.order[0])
      : undefined;
    const retainedLease = rebuild ? this.#retire()?.lease : undefined;
    const active = this.#open(query, retainedLease);
    const cancel = () => {
      if (this.#active === active) this.close();
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) throw new Error("Reading cancelled");
      if (restore && query.operation !== "item" && query.operation !== "turn")
        await active.jump.toItem(restore);
      switch (query.operation) {
        case "hold":
          active.jump.hold();
          break;
        case "follow":
          active.jump.follow();
          break;
        case "older":
          await active.jump.older();
          break;
        case "newer":
          await active.jump.newer();
          break;
        case "item":
          if (query.itemId) await active.jump.toItem(query.itemId);
          break;
        case "turn":
          if (query.ordinal) await active.jump.toTurn(query.ordinal);
          break;
      }
      if (signal.aborted || this.#active !== active) throw new Error("Reading cancelled");
      const snapshot = active.jump.snapshot();
      if (snapshot.failed) throw new Error(snapshot.failed);
      const shown = active.shown;
      if (
        this.client.state !== "ready" ||
        active.lease.store.syncing ||
        active.lease.store.unconfirmed
      )
        active.reads.cached = true;
      if (!shown) throw new Error("Conversation history is not ready yet.");
      const nextBlocks = active.blocks
        ? historyBlockSpans(shown.reading.source, active.blocks.snapshot())
        : [];
      return {
        ...historyWindowMetadata(
          previousBlocks,
          nextBlocks,
          (id) => active.lease.store.deleted?.(id) ?? false,
          shown.window.before,
          shown.joined ? null : shown.window.after,
        ),
        active: true,
        hasOlder: shown.window.before !== null,
        hasNewer: !shown.joined,
        joined: shown.joined,
        focus:
          query.operation === "item" || query.operation === "turn"
            ? (snapshot.focus?.itemId ?? null)
            : null,
        count: shown.reading.source.order.length,
        freshness: active.reads.cached ? "cached" : "current",
      };
    } finally {
      signal.removeEventListener("abort", cancel);
      this.#settled(active);
    }
  }

  /**
   * Everything this read changed has been put: native, which holds a requested page's rows,
   * applies them together, so a page is one layout and one keep-place scroll, not one per frame.
   */
  #settled(active: Active): void {
    if (this.#active !== active) return;
    const { threadId, epoch } = active;
    this.#sink.put("reading:settled", () => ({ type: "reading.settled", threadId, epoch }));
  }

  /** The window session for this thread and reading generation, started if needed. */
  #open(query: Query, retainedLease?: Lease<ThreadSource>): Active {
    const current = this.#active;
    if (current?.threadId === query.threadId && current.epoch === query.epoch) return current;
    this.close();
    const lease = retainedLease ?? this.client.thread(query.threadId);
    const store = lease.store;
    const reads = new HistoryWindowReads(this.client);
    const jump = new JumpController(
      {
        itemsWindow: (input, options) => reads.read(input, options),
        turnsPage: (input, options) => this.client.turnsPage(input, options),
      },
      query.threadId,
      this.#bounds,
    );
    jump.setTail(() => ({
      order: store.order,
      before: store.itemsBefore,
      seq: (id) => store.itemSeq?.(id),
      item: (id) => store.item(id),
      inLane: (id) => inRootLane(store.item(id)?.agentId, store.thread?.rootAgentId),
      firstItemOf: () => undefined,
    }));
    const active: Active = {
      threadId: query.threadId,
      epoch: query.epoch,
      lease,
      jump,
      reads,
      deleted: new Set(),
      stops: [],
    };
    const connection = this.client.connectionState();
    if (connection.getSnapshot() !== "ready") reads.cached = true;
    active.stops.push(
      connection.subscribe(() => {
        if (connection.getSnapshot() !== "ready") reads.cached = true;
      }),
      store.observe((keys) => {
        if (keys === "all" || keys.has("order")) jump.tailMoved();
      }),
      jump.subscribe(() => this.#show(active)),
    );
    this.#active = active;
    return active;
  }

  /** The controller moved: show its window, or the window it replaced it with. */
  #show(active: Active): void {
    if (this.#active !== active) return;
    const { window, joined } = active.jump.snapshot();
    if (!window) return;
    const shown = active.shown;
    if (shown && shown.window === window && shown.joined === joined) return;
    if (shown?.window !== window)
      for (const id of active.deleted) if (!window.seqs.has(id)) active.deleted.delete(id);
    const store = active.lease.store;
    const view = jumpedSource(store, window, joined, active.deleted);
    if (shown) {
      active.shown = { window, joined, reading: shown.reading };
      shown.reading.replace(view);
      return;
    }
    const reading = new ReadingSource(store, view);
    active.shown = { window, joined, reading };
    const { threadId, epoch } = active;
    active.stops.push(
      followThread(reading.source, threadId, epoch, this.#sink, undefined, "reading:"),
    );
    const blocks = followBlocks(reading.source, (key, read) =>
      this.#sink.put(`reading:${key}`, () => {
        const patch = read();
        return patch && { ...patch, threadId, epoch };
      }),
    );
    active.blocks = blocks;
    active.stops.push(reading.source.observe(blocks.tap));
    blocks.tap("all");
  }
}
