import type { ChangeTap, ThreadSource } from "@ace/client";
import { threadRow, itemRow } from "./presentation.ts";
import { interactionRow } from "./interaction-rows.ts";
import { itemDetail, stepContext } from "./thread-rows.ts";
import { thoughtOf } from "./thread-messages.ts";

import type { PatchSink } from "./agents.ts";
import type { NativeLedger } from "./native-ledger.ts";
import { anchoredOffset } from "./anchored-positions.ts";
import { messageActionsOf } from "./message-actions.ts";

/** How far back a turn's end looks for its messages: a turn's answers sit near the end. */
const turnReach = 256;

/** The messages of turn `runId` among the newest items, whose actions its end changes. */
function turnMessages(store: ThreadSource, runId: string): string[] {
  const ids: string[] = [];
  for (let at = store.order.length - 1; at >= Math.max(0, store.order.length - turnReach); at--) {
    const id = store.order[at] ?? "";
    const item = store.item(id);
    if (item?.type === "message" && item.runId === runId) ids.push(id);
  }
  return ids;
}
export { PatchPump } from "./patch-pump.ts";

/**
 * `ledger`: what native holds of this thread (bound to the pump for `epoch`). With it, a whole
 * thread pass (opening, a fresh snapshot) diffs against native's copy instead of resetting it.
 * `prefix`: the pump keys' scope, `reading:` for the history window (`native-transcript.ts`).
 */
export function followThread(
  store: ThreadSource,
  threadId: string,
  epoch: number,
  pump: PatchSink,
  ledger?: NativeLedger,
  prefix: "thread:" | "reading:" = "thread:",
) {
  const positions = new Map<string, number>();
  const put = (key: string, read: () => Record<string, unknown> | undefined) => {
    pump.put(prefix + key, () => {
      const patch = read();
      return patch && { ...patch, threadId, epoch };
    });
  };
  const row = (id: string, index?: number, at?: number) => {
    if (index !== undefined) positions.set(id, index);
    put(`item:${id}`, () => {
      const item = store.item(id);
      return {
        type: "thread.item",
        id,
        row: item
          ? {
              ...itemRow(item, positions.get(id), store.truncated(id)),
              ...itemDetail(item, stepContext(store, item)),
              thought: thoughtOf(store, item),
              actions: messageActionsOf(store, item, at) ?? null,
            }
          : null,
      };
    });
  };
  const interaction = (id: string) =>
    put(`interaction:${id}`, () => {
      const value = store.interaction(id);
      return { type: "thread.interaction", id, row: value ? interactionRow(value, store) : null };
    });
  const change: ChangeTap = (keys) => {
    // Native's kept copy stays on screen until the store has the thread to diff it against.
    if (keys === "all" && ledger?.held && !store.thread) return;
    if (keys === "all") {
      positions.clear();
      if (!ledger?.begin()) {
        pump.clear(prefix);
        put("reset", () => ({ type: "thread.reset" }));
      }
      // Stable snapshot order, in bounded chunks. Streaming changes touch only their row.
      store.order.forEach((id, index) => row(id, index, index));
      for (const id of store.interactionIds()) interaction(id);
    } else {
      if (keys.has("order")) {
        // A thought ends where what follows it begins: its header reads that item.
        const thought = (index: number) => {
          const id = store.order[index - 1];
          if (id !== undefined && store.item(id)?.type === "reasoning") row(id);
        };
        const retained = new Set(store.order);
        const offset = anchoredOffset(positions, store.order);
        for (const id of positions.keys())
          if (!retained.has(id)) {
            positions.delete(id);
            row(id);
          }
        store.order.forEach((id, at) => {
          const index = at - offset;
          if (!positions.has(id)) {
            row(id, index);
            thought(at);
          } else if (positions.get(id) !== index) {
            positions.set(id, index);
            put(`position:${id}`, () => ({
              type: "thread.position",
              id,
              index: positions.get(id) ?? null,
            }));
          }
        });
      }
      for (const key of keys) {
        if (key.startsWith("item:")) row(key.slice(5));
        // A turn's end times its last thought.
        if (key.startsWith("run:")) {
          const last = store.order.at(-1);
          if (last !== undefined && store.item(last)?.type === "reasoning") row(last);
          // A finished turn can be forked from: its answers' actions change.
          turnMessages(store, key.slice(4)).forEach((id) => row(id));
        }
        if (key.startsWith("interaction:")) {
          interaction(key.slice(12));
          // The approval reads on its step ("Approved by you"): the step's row changes too.
          const call = store.interaction(key.slice(12))?.toolCallId;
          if (call && store.item(call)) row(call);
        }
      }
    }
    if (prefix === "thread:" && keys !== "all" && keys.has("error") && store.error)
      put("error", () => ({
        type: "error",
        message: "The conversation could not be loaded. Retry the connection.",
      }));
    if (keys === "all" || keys.has("thread"))
      put("metadata", () => ({
        type: "thread.metadata",
        row: store.thread ? threadRow(store.thread) : null,
      }));
    if (keys === "all" || keys.has("cursor"))
      put("cursor", () => ({ type: "thread.cursor", cursor: store.cursor ?? 0 }));
  };
  const stop = store.observe(change);
  change("all");
  return () => {
    stop();
    pump.clear(prefix);
  };
}
