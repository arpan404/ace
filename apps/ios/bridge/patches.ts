import type { ChangeTap, SidebarSource, ThreadSource } from "@ace/client";
import { host, scheduler } from "./host.ts";
import { threadRow, itemRow, approvalRow } from "./presentation.ts";

/** One in-flight frame, at most 32 KiB UTF-8. Keep dirty keys, never queued transcript copies. */
export class PatchPump {
  #inFlight = false;
  #timer: (() => void) | undefined;
  #tasks = new Map<string, () => unknown | undefined>();
  put(key: string, read: () => unknown | undefined): void {
    this.#tasks.set(key, read);
    this.#schedule();
  }
  ack(): void { this.#inFlight = false; this.#schedule(); }
  clear(prefix: string): void {
    for (const key of this.#tasks.keys()) if (key.startsWith(prefix)) this.#tasks.delete(key);
  }
  #schedule(): void {
    if (this.#inFlight || this.#timer || !this.#tasks.size) return;
    this.#timer = scheduler.set(8, () => { this.#timer = undefined; this.#flush(); });
  }
  #flush(): void {
    if (this.#inFlight) return;
    const frame: unknown[] = [];
    let bytes = 2;
    for (const [key, read] of this.#tasks) {
      const patch = read();
      if (patch === undefined) { this.#tasks.delete(key); continue; }
      const json = JSON.stringify(patch);
      const size = host.encode(json).length;
      if (size > 32760) {
        this.#tasks.delete(key);
        this.put("error", () => ({ type: "error", message: "Native patch exceeded its byte budget" }));
        continue;
      }
      if (bytes + size + 1 > 32768 || frame.length >= 32) break;
      this.#tasks.delete(key);
      frame.push(patch);
      bytes += size + 1;
    }
    if (frame.length) { this.#inFlight = true; host.emit(JSON.stringify(frame)); }
  }
}
export function followInbox(store: SidebarSource, pump: PatchPump): () => void {
  const row = (id: string) => pump.put(`inbox:${id}`, () => ({
    type: "inbox.row", id, row: (() => { const value = store.thread(id); return value ? threadRow(value) : null; })(),
  }));
  const change: ChangeTap = (keys) => {
    if (keys === "all" || keys.has("ids")) {
      pump.clear("inbox:");
      pump.put("inbox:reset", () => ({ type: "inbox.reset" }));
      for (const id of store.ids) row(id);
    } else for (const key of keys) if (key.startsWith("thread:")) row(key.slice(7));
  };
  const stop = store.observe(change);
  change("all");
  return stop;
}
export function followThread(store: ThreadSource, threadId: string, epoch: number, pump: PatchPump) {
  const prefix = "thread:";
  const positions = new Map<string, number>();
  const put = (key: string, read: () => Record<string, unknown> | undefined) => {
    pump.put(prefix + key, () => { const patch = read(); return patch && { ...patch, threadId, epoch }; });
  };
  const row = (id: string, index?: number) => {
    if (index !== undefined) positions.set(id, index);
    put(`item:${id}`, () => {
    const item = store.item(id);
    return { type: "thread.item", id, row: item ? itemRow(item, positions.get(id)) : null };
    });
  };
  const interaction = (id: string) => put(`interaction:${id}`, () => {
    const value = store.interaction(id);
    return { type: "thread.interaction", id, row: value ? approvalRow(value, store) : null };
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
        for (const id of positions.keys()) if (!retained.has(id)) { positions.delete(id); row(id); }
        store.order.forEach((id, index) => {
          if (!positions.has(id)) row(id, index);
          else if (positions.get(id) !== index) {
            positions.set(id, index);
            put(`position:${id}`, () => ({ type: "thread.position", id, index: positions.get(id) ?? null }));
          }
        });
      }
      for (const key of keys) {
        if (key.startsWith("item:")) row(key.slice(5));
        if (key.startsWith("interaction:")) interaction(key.slice(12));
      }
    }
    if (keys !== "all" && keys.has("error") && store.error) put("error", () => ({ type: "error", message: "The conversation could not be loaded. Retry the connection." }));
    if (keys === "all" || keys.has("thread")) put("metadata", () => ({
      type: "thread.metadata", row: store.thread ? threadRow(store.thread) : null,
    }));
    if (keys === "all") put("ready", () => ({ type: "thread.ready", count: store.order.length }));
    if (keys === "all" || keys.has("cursor")) put("cursor", () => ({ type: "thread.cursor", cursor: store.cursor ?? 0 }));
  };
  const stop = store.observe(change);
  change("all");
  return () => { stop(); pump.clear(prefix); };
}
