import type { ChangeTap, SidebarSource, ThreadSource } from "@ace/client";
import { host, scheduler } from "./host.ts";
import { threadRow, itemRow, approvalRow } from "./presentation.ts";

/** One in-flight frame, at most 32 KiB UTF-8. Keep dirty keys, never queued transcript copies. */
export class PatchPump {
  #inFlight: (() => void) | undefined;
  #timer: (() => void) | undefined;
  #tasks = new Map<string, () => unknown | undefined>();
  #fragment:
    | {
        key: string;
        read: () => unknown | undefined;
        id: string;
        data: string;
        offset: number;
        index: number;
      }
    | undefined;
  put(key: string, read: () => unknown | undefined): void {
    this.#tasks.set(key, read);
    this.#schedule();
  }
  ack(accepted: boolean): void {
    const commit = this.#inFlight;
    if (!commit) return;
    this.#inFlight = undefined;
    if (accepted) commit();
    else this.#fragment = undefined; // Native reset its assembly. Re-read the still-dirty key.
    this.#schedule();
  }
  clear(prefix: string): void {
    for (const key of this.#tasks.keys()) if (key.startsWith(prefix)) this.#tasks.delete(key);
  }
  #schedule(): void {
    if (this.#inFlight || this.#timer || (!this.#tasks.size && !this.#fragment)) return;
    this.#timer = scheduler.set(8, () => {
      this.#timer = undefined;
      this.#flush();
    });
  }
  #flush(): void {
    if (this.#inFlight) return;
    if (this.#fragment) {
      this.#emitFragment();
      return;
    }
    const frame: unknown[] = [];
    const delivered: { key: string; read: () => unknown | undefined }[] = [];
    let bytes = 2;
    for (const [key, read] of this.#tasks) {
      const patch = read();
      if (patch === undefined) {
        this.#tasks.delete(key);
        continue;
      }
      const json = JSON.stringify(patch);
      // Native UTF-8/base64 conversion avoids a boxed JS number for every payload byte.
      const encoded = host.utf8Base64(json);
      const size =
        (encoded.length / 4) * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
      if (size > 32760) {
        if (frame.length) break;
        this.#fragment = { key, read, id: host.uuid(), data: encoded, offset: 0, index: 0 };
        this.#emitFragment();
        return;
      }
      if (bytes + size + 1 > 32768 || frame.length >= 32) break;
      delivered.push({ key, read });
      frame.push(patch);
      bytes += size + 1;
    }
    if (frame.length) {
      this.#inFlight = () => {
        for (const { key, read } of delivered) this.#confirm(key, read);
      };
      host.emit(JSON.stringify(frame));
    }
  }
  #emitFragment(): void {
    const fragment = this.#fragment;
    if (!fragment) return;
    // 24 KiB base64 represents 18 KiB UTF-8 and leaves room inside the 32 KiB frame.
    const data = fragment.data.slice(fragment.offset, fragment.offset + 24576);
    const last = fragment.offset + data.length === fragment.data.length;
    this.#inFlight = () => {
      if (last) {
        this.#confirm(fragment.key, fragment.read);
        this.#fragment = undefined;
      } else {
        fragment.offset += data.length;
        fragment.index++;
      }
    };
    host.emit(
      JSON.stringify([{ type: "fragment", id: fragment.id, index: fragment.index, last, data }]),
    );
  }
  #confirm(key: string, read: () => unknown | undefined): void {
    // An SDK update received during delivery replaces the reader and stays dirty.
    if (this.#tasks.get(key) === read) this.#tasks.delete(key);
  }
}
export function followInbox(store: SidebarSource, pump: PatchPump): () => void {
  const row = (id: string) =>
    pump.put(`inbox:${id}`, () => ({
      type: "inbox.row",
      id,
      row: (() => {
        const value = store.thread(id);
        return value ? threadRow(value) : null;
      })(),
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
        row: item ? itemRow(item, positions.get(id), store.truncated(id)) : null,
      };
    });
  };
  const interaction = (id: string) =>
    put(`interaction:${id}`, () => {
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
