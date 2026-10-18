import type { ChangeTap, ThreadSource } from "@ace/client";
import { threadRow, itemRow } from "./presentation.ts";
import { interactionRow } from "./interaction-rows.ts";
import { itemDetail } from "./thread-rows.ts";

import { PatchPump } from "./patch-pump.ts";
export { PatchPump } from "./patch-pump.ts";

export function followThread(
  store: ThreadSource,
  threadId: string,
  epoch: number,
  pump: PatchPump,
  itemLimit: number,
) {
  const prefix = "thread:";
  const positions = new Map<string, number>();
  const put = (key: string, read: () => Record<string, unknown> | undefined) => {
    pump.put(prefix + key, () => {
      const patch = read();
      return patch && { ...patch, threadId, epoch };
    });
  };
  const row = (id: string, index?: number) => {
    if (index !== undefined) positions.set(id, index);
    put(`item:${id}`, () => {
      const item = store.item(id);
      return {
        type: "thread.item",
        id,
        row: item
          ? { ...itemRow(item, positions.get(id), store.truncated(id)), ...itemDetail(item) }
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
    if (keys === "all") {
      pump.clear(prefix);
      positions.clear();
      put("reset", () => ({ type: "thread.reset" }));
      // Stable snapshot order, in bounded chunks. Streaming changes touch only their row.
      store.order.forEach((id, index) => row(id, index));
      for (const id of store.interactionIds()) interaction(id);
    } else {
      if (keys.has("order")) {
        const retained = new Set(store.order);
        for (const id of positions.keys())
          if (!retained.has(id)) {
            positions.delete(id);
            row(id);
          }
        store.order.forEach((id, index) => {
          if (!positions.has(id)) row(id, index);
          else if (positions.get(id) !== index) {
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
        if (key.startsWith("interaction:")) interaction(key.slice(12));
      }
    }
    if (keys !== "all" && keys.has("error") && store.error)
      put("error", () => ({
        type: "error",
        message: "The conversation could not be loaded. Retry the connection.",
      }));
    if (keys === "all" || keys.has("thread"))
      put("metadata", () => ({
        type: "thread.metadata",
        row: store.thread ? threadRow(store.thread) : null,
      }));
    if (keys === "all" && itemLimit <= 200 && store.thread)
      put("ready", () => ({ type: "thread.ready", count: store.order.length }));
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
