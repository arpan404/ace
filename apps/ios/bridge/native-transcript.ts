import type { ClientCore, Lease, ThreadSource } from "@ace/client";
import { inRootLane } from "@ace/projection";
import { ItemId, ThreadId } from "@ace/protocol";
import {
  JumpController,
  jumpedSource,
  windowBounds,
  type JumpSnapshot,
  type WindowBounds,
} from "@ace/ui-core";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import { followThread } from "./patches.ts";
import { ReadingSource } from "./reading-source.ts";
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

export const NativeTranscriptRequest = z
  .object({
    type: z.literal("native.transcript"),
    threadId: ThreadId,
    /** The reading view's generation: its patches carry it as their epoch. */
    epoch: z.number().int().negative(),
    operation: z.enum(["hold", "older", "newer", "live", "item"]),
    /** The item a jump brings into view (`operation: "item"`). */
    itemId: ItemId.optional(),
  })
  .refine((value) => (value.operation === "item") === (value.itemId !== undefined));
type Query = z.infer<typeof NativeTranscriptRequest>;

export interface TranscriptState {
  active: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  joined: boolean;
  /** The item a jump aimed at, to scroll to once its rows land. */
  focus: string | null;
  /** Items in the window and the tail rows joined to it, as the reading view shows them. */
  count: number;
}

const atLive: TranscriptState = {
  active: false,
  hasOlder: false,
  hasNewer: false,
  joined: true,
  focus: null,
  count: 0,
};

interface Active {
  threadId: string;
  epoch: number;
  lease: Lease<ThreadSource>;
  jump: JumpController;
  deleted: Set<string>;
  stops: (() => void)[];
  shown?: { window: NonNullable<JumpSnapshot["window"]>; joined: boolean; reading: ReadingSource };
}

export class NativeTranscript {
  #active: Active | undefined;
  readonly client: ClientCore;
  readonly #sink: PatchSink;
  readonly #bounds: WindowBounds;
  constructor(client: ClientCore, sink: PatchSink, bounds: WindowBounds = windowBounds) {
    this.client = client;
    this.#sink = sink;
    this.#bounds = bounds;
  }

  /** Back to the live tail: the window, its lease and its rows go. */
  close(): void {
    const active = this.#active;
    if (!active) return;
    this.#active = undefined;
    active.jump.dispose();
    for (const stop of active.stops.splice(0).toReversed()) stop();
    active.shown?.reading.dispose();
    active.lease.release();
  }

  async read(query: Query, signal: AbortSignal): Promise<TranscriptState> {
    if (query.operation === "live") {
      this.close();
      return atLive;
    }
    const active = this.#open(query);
    const cancel = () => {
      if (this.#active === active) this.close();
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) throw new Error("Reading cancelled");
      switch (query.operation) {
        case "hold":
          active.jump.hold();
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
      }
      if (signal.aborted || this.#active !== active) throw new Error("Reading cancelled");
      const snapshot = active.jump.snapshot();
      if (snapshot.failed) throw new Error(snapshot.failed);
      const shown = active.shown;
      if (!shown) throw new Error("Conversation history is not ready yet.");
      return {
        active: true,
        hasOlder: shown.window.before !== null,
        hasNewer: !shown.joined,
        joined: shown.joined,
        focus: query.operation === "item" ? (snapshot.focus?.itemId ?? null) : null,
        count: shown.reading.source.order.length,
      };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  /** The window session for this thread and reading generation, started if needed. */
  #open(query: Query): Active {
    const current = this.#active;
    if (current?.threadId === query.threadId && current.epoch === query.epoch) return current;
    this.close();
    const lease = this.client.thread(query.threadId);
    const store = lease.store;
    const jump = new JumpController(this.client, query.threadId, this.#bounds);
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
      deleted: new Set(),
      stops: [],
    };
    active.stops.push(
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
    active.stops.push(reading.source.observe(blocks.tap));
    blocks.tap("all");
  }
}
