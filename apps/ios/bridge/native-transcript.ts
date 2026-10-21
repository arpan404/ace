import type { ClientCore, Lease, ThreadSource } from "@ace/client";
import { inRootLane } from "@ace/projection";
import { ThreadId } from "@ace/protocol";
import { JumpController, jumpedSource } from "@ace/ui-core";
import { createBlockReader } from "@ace/ui-core/transcript-block-reader";
import { z } from "zod";
import { blockRow } from "./thread-blocks.ts";
import { itemRow } from "./presentation.ts";
import { itemDetail } from "./thread-rows.ts";

export const NativeTranscriptRequest = z.object({
  type: z.literal("native.transcript"),
  threadId: ThreadId,
  operation: z.enum(["hold", "older", "newer", "live"]),
});

/** One bounded reading window beside the subscribed tail, owned by the browser's controller. */
export class NativeTranscript {
  #active:
    | {
        id: string;
        lease: Lease<ThreadSource>;
        jump: JumpController;
        stop: () => void;
        deleted: Set<string>;
      }
    | undefined;
  readonly client: ClientCore;
  constructor(client: ClientCore) {
    this.client = client;
  }
  close(): void {
    this.#active?.jump.dispose();
    this.#active?.stop();
    this.#active?.lease.release();
    this.#active = undefined;
  }
  async read(query: z.infer<typeof NativeTranscriptRequest>, signal: AbortSignal) {
    if (query.operation === "live") {
      this.close();
      return {
        active: false,
        hasOlder: false,
        hasNewer: false,
        joined: true,
        items: [],
        blocks: [],
      };
    }
    if (this.#active?.id !== query.threadId) {
      this.close();
      const lease = this.client.thread(query.threadId);
      const store = lease.store;
      const jump = new JumpController(this.client, query.threadId);
      jump.setTail(() => ({
        order: store.order,
        before: store.itemsBefore,
        seq: (id) => store.itemSeq?.(id),
        item: (id) => store.item(id),
        inLane: (id) => inRootLane(store.item(id)?.agentId, store.thread?.rootAgentId),
        firstItemOf: () => undefined,
      }));
      const deleted = new Set<string>();
      const stop = store.observe((keys) => {
        if (keys !== "all")
          for (const key of keys) {
            if (
              key.startsWith("item:") &&
              store.deleted?.(key.slice(5)) &&
              jump.snapshot().window?.seqs.has(key.slice(5))
            )
              deleted.add(key.slice(5));
          }
        if (keys === "all" || keys.has("order")) jump.tailMoved();
      });
      this.#active = { id: query.threadId, lease, jump, stop, deleted };
    }
    const active = this.#active;
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
      }
      if (signal.aborted || this.#active !== active) throw new Error("Reading cancelled");
      const snapshot = active.jump.snapshot();
      if (snapshot.failed) throw new Error(snapshot.failed);
      const window = snapshot.window;
      if (!window) throw new Error("Conversation history is not ready yet.");
      for (const id of active.deleted) if (!window.seqs.has(id)) active.deleted.delete(id);
      const source = jumpedSource(active.lease.store, window, snapshot.joined, active.deleted);
      return {
        active: true,
        hasOlder: window.before !== null,
        hasNewer: !snapshot.joined,
        joined: snapshot.joined,
        items: source.order.flatMap((id, index) => {
          const item = source.item(id);
          return item
            ? [
                {
                  ...itemRow(item, index, source.truncated(id)),
                  ...itemDetail(item),
                  seq: source.itemSeq?.(id),
                },
              ]
            : [];
        }),
        blocks: createBlockReader()(source).value.map((block, index) => ({
          id: block.key,
          row: blockRow(source, block, index),
        })),
      };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
}
