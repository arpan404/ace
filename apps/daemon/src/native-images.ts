import { isAbsolute, resolve, relative, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { ThreadId, Item, type Attachment } from "@ace/protocol";
import type { ContextService } from "@ace/context";
import type { Store } from "./store.ts";
import { toolImage } from "./tool-result-content.ts";
import { agentCwd, agentDirectory, readImageFile } from "./image-files.ts";

export function imageReference(reference: string): string | undefined {
  if (reference.startsWith("file:")) {
    try {
      return fileURLToPath(reference);
    } catch {
      return;
    }
  }
  return /^[a-z][a-z\d+.-]*:/i.test(reference) || reference.includes("\0")
    ? undefined
    : normalize(reference);
}

function nativePath(item: Item): string | undefined {
  if (item.type !== "tool_call" || item.call.detail.kind !== "image") return;
  if (item.call.detail.path) return item.call.detail.path;
  for (const raw of item.call.raw) {
    if (!("data" in raw) || typeof raw.data !== "object" || raw.data === null) continue;
    const data = raw.data as Record<string, unknown>;
    if (data.type === "imageView" && typeof data.path === "string") return data.path;
  }
}

/**
 * Rows the history backfill reads per step. Item rows can be large, so a step stays small and
 * the event loop gets a turn between steps; a 9 GB history otherwise blocked it for 30 s or more.
 */
const backfillSliceRows = 64;
const nextTurn = () => new Promise<void>((done) => setImmediate(done));

export interface NativeImageOptions {
  /** Rows per backfill step. */
  sliceRows?: number;
  /** Resolves when the backfill may take its next step. */
  nextTurn?: () => Promise<void>;
}

/** Capture after committed provider evidence; image IO never stalls a turn's event stream. */
export function observeNativeImages(
  store: Store,
  context: ContextService,
  signal: AbortSignal,
  options: NativeImageOptions = {},
): () => Promise<void> {
  const sliceRows = options.sliceRows ?? backfillSliceRows;
  const yieldTurn = options.nextTurn ?? nextTurn;
  let stopped = false;
  let running = 0;
  const pending = new Map<string, { thread: string; item: Item }>();
  const tasks = new Set<Promise<void>>();
  const active = new Set<string>();
  const capture = async (thread: string, item: Item) => {
    const source = nativePath(item);
    if (item.type !== "tool_call" || !source) return;
    const id = ThreadId.parse(thread);
    let path: string | undefined;
    let alias = imageReference(source) ?? source;
    let attachment: Attachment | undefined;
    try {
      if (stopped || signal.aborted) return;
      const reference = imageReference(source);
      const cwd = agentCwd(store, id, item.agentId);
      if (reference && isAbsolute(reference)) path = reference;
      else if (reference) {
        const directory = agentDirectory(store, id, item.agentId);
        if (directory) path = resolve(directory, reference);
      }
      if (!path) throw new Error("Image environment is unavailable");
      // Preserve relative prose references even when tools report an absolute path and
      // the producing agent later changes folders. This alias never performs file IO.
      if (reference && isAbsolute(reference) && cwd) alias = relative(cwd, path);
      const mimeType =
        extname(path).toLowerCase() === ".jpg" || extname(path).toLowerCase() === ".jpeg"
          ? "image/jpeg"
          : extname(path).toLowerCase() === ".webp"
            ? "image/webp"
            : "image/png";
      const bytes = await readImageFile(path);
      if (stopped || signal.aborted) return;
      attachment = await toolImage(
        context,
        { threadId: id, agentId: item.agentId, sessionId: "native-image" },
        { type: "image", mimeType, data: bytes.toString("base64") },
      );
    } catch {
      /* Missing/invalid images become an honest unavailable card, never a turn failure. */
    }
    const release = async () => {
      if (attachment)
        await context.uploads.handle("daemon-tool-result", {
          op: "attachment.release",
          threadId: id,
          sha256: attachment.sha256,
        });
    };
    let published = false;
    try {
      if (
        stopped ||
        signal.aborted ||
        !store.getThread(id) ||
        store.getThread(id)?.deletedAt !== undefined
      )
        return;
      await store.writable();
      const current = store.measurements.item(id, item.id);
      if (
        stopped ||
        signal.aborted ||
        !store.getThread(id) ||
        store.getThread(id)?.deletedAt !== undefined ||
        !current ||
        current.type !== "tool_call" ||
        current.call.detail.kind !== "image" ||
        nativePath(current) !== source
      )
        return;
      store.atomic(() => {
        store.nativeImages.save(thread, item.id, path ?? source, attachment, alias);
        store.appendEvents(id, [{ type: "item.updated", item: current }]);
      });
      published = true;
    } catch (error) {
      // A failed store publication pauses capture until restart. Never hot-loop a failing disk.
      stopped = true;
      throw error;
    } finally {
      if (!published) await release();
    }
  };
  // History not yet swept for uncaptured images: rows below this rowid. Undefined when done.
  let below: number | undefined;
  // An image arrived while the queue was full; sweep history again once this sweep ends.
  let rescan = false;
  let sweeping: Promise<void> | undefined;
  const top = () =>
    Number(store.statement("SELECT max(rowid) AS top FROM items").get()?.top ?? 0) + 1;
  const candidates = () =>
    store.statement(`SELECT rowid AS position,thread_id,item FROM items
      WHERE rowid < ? AND rowid >= ? AND json_extract(item,'$.type')='tool_call'
      AND json_extract(item,'$.call.detail.kind')='image' AND json_extract(item,'$.complete')=1
      AND (json_type(item,'$.call.detail.path')='text' OR EXISTS(SELECT 1 FROM json_each(items.item,'$.call.raw') raw WHERE json_extract(raw.value,'$.data.type')='imageView' AND json_type(raw.value,'$.data.path')='text'))
      AND NOT EXISTS(SELECT 1 FROM native_images WHERE thread_id=items.thread_id AND item_id=items.id)
      AND EXISTS(SELECT 1 FROM threads WHERE threads.id=items.thread_id AND json_extract(threads.client,'$.deletedAt') IS NULL)
      ORDER BY rowid DESC`);
  /** One bounded step, newest rows first. Stops early, resumable, when the queue is full. */
  const step = (end: number) => {
    const floor = Math.max(0, end - sliceRows);
    for (const row of candidates().all(end, floor)) {
      const thread = String(row.thread_id);
      const item = Item.parse(JSON.parse(String(row.item)));
      const key = `${thread}:${item.id}`;
      if (!nativePath(item) || active.has(key) || pending.has(key)) continue;
      if (pending.size >= 256) return Number(row.position) + 1;
      pending.set(key, { thread, item });
    }
    return floor > 0 ? floor : undefined;
  };
  const sweep = async () => {
    for (;;) {
      if (stopped || signal.aborted) return;
      if (below === undefined) {
        if (!rescan) return;
        rescan = false;
        below = top();
      }
      if (pending.size >= 256) return; // Resumed from `below` once captures drain the queue.
      below = step(below);
      pump();
      await yieldTurn();
    }
  };
  const refill = () => {
    if (sweeping || stopped || signal.aborted || (below === undefined && !rescan)) return;
    sweeping = sweep()
      .catch(() => {
        // An unreadable history pauses the backfill until restart, like a failed publication.
        stopped = true;
      })
      .finally(() => {
        sweeping = undefined;
        // Captures may have drained the queue while this sweep was ending.
        if (!pending.size) refill();
      });
  };
  const pump = () => {
    if (stopped) return;
    while (running < 2 && pending.size) {
      const first = pending.entries().next().value;
      if (!first) break;
      const [key, entry] = first;
      pending.delete(key);
      running++;
      active.add(key);
      const task = capture(entry.thread, entry.item).finally(() => {
        running--;
        active.delete(key);
        tasks.delete(task);
        if (!pending.size) refill();
        pump();
      });
      tasks.add(task);
      void task.catch(() => {});
    }
  };
  const consider = (thread: string, item: Item) => {
    if (
      !item.complete ||
      item.type !== "tool_call" ||
      item.call.detail.kind !== "image" ||
      !nativePath(item) ||
      active.has(`${thread}:${item.id}`) ||
      store.nativeImages.has(thread, item.id)
    )
      return;
    if (pending.size >= 256) {
      rescan = true; // The item is durable; a later sweep finds it.
      return;
    }
    pending.set(`${thread}:${item.id}`, { thread, item });
    pump();
  };
  const stop = store.subscribe((events) => {
    for (const event of events)
      if (event.payload.type === "item.created" || event.payload.type === "item.updated")
        consider(event.threadId, event.payload.item);
  });
  below = top();
  refill();
  return async () => {
    stopped = true;
    stop();
    pending.clear();
    await sweeping;
    await Promise.allSettled(tasks);
  };
}
