import { constants } from "node:fs";
import { open, lstat, realpath, stat as pathStat } from "node:fs/promises";
import { isAbsolute, resolve, relative, parse, join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { ThreadId, Item, Agent, type Attachment } from "@ace/protocol";
import type { ContextService } from "@ace/context";
import type { Store } from "./store.ts";
import { toolImage } from "./tool-result-content.ts";

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

/** Read only the exact image a native tool produced, never follow filesystem links. */
async function readImage(path: string): Promise<Buffer> {
  const root = parse(path).root;
  let part = root;
  for (const segment of path.slice(root.length).split("/").filter(Boolean)) {
    part = join(part, segment);
    if ((await lstat(part)).isSymbolicLink()) throw new Error("Image is a symbolic link");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    const sameFile = async () => {
      const current = await pathStat(path);
      const opened = await file.stat();
      return (
        (await realpath(path)) === path &&
        current.ino === stat.ino &&
        current.dev === stat.dev &&
        opened.size === stat.size &&
        opened.mtimeMs === stat.mtimeMs &&
        opened.ctimeMs === stat.ctimeMs &&
        current.size === stat.size &&
        current.mtimeMs === stat.mtimeMs &&
        current.ctimeMs === stat.ctimeMs
      );
    };
    if (!(await sameFile()) || !stat.isFile() || stat.size > 8 * 1024 * 1024)
      throw new Error("Image unavailable");
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== stat.size || !(await sameFile())) throw new Error("Image changed while reading");
    return bytes.subarray(0, size);
  } finally {
    await file.close();
  }
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

/** Capture after committed provider evidence; image IO never stalls a turn's event stream. */
export function observeNativeImages(
  store: Store,
  context: ContextService,
  signal: AbortSignal,
): () => Promise<void> {
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
      const agentRow = store
        .statement(
          "SELECT value FROM view_entities WHERE thread_id=? AND collection='agents' AND id=?",
        )
        .get(id, item.agentId);
      const cwd = agentRow ? Agent.parse(JSON.parse(String(agentRow.value))).cwd : undefined;
      if (reference && isAbsolute(reference)) path = reference;
      else if (reference) {
        if (typeof cwd === "string" && isAbsolute(cwd)) path = resolve(cwd, reference);
        else {
          const binding = store.executionWorkspace(id);
          if (binding.ready) path = resolve(binding.path, reference);
        }
      }
      if (!path) throw new Error("Image environment is unavailable");
      // Preserve relative prose references even when tools report an absolute path and
      // the producing agent later changes folders. This alias never performs file IO.
      if (reference && isAbsolute(reference) && cwd && isAbsolute(cwd)) alias = relative(cwd, path);
      const mimeType =
        extname(path).toLowerCase() === ".jpg" || extname(path).toLowerCase() === ".jpeg"
          ? "image/jpeg"
          : extname(path).toLowerCase() === ".webp"
            ? "image/webp"
            : "image/png";
      const bytes = await readImage(path);
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
  let refill: () => void;
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
    if (pending.size >= 256) return; // Durable items are refilled as captures complete.
    pending.set(`${thread}:${item.id}`, { thread, item });
    pump();
  };
  const stop = store.subscribe((events) => {
    for (const event of events)
      if (event.payload.type === "item.created" || event.payload.type === "item.updated")
        consider(event.threadId, event.payload.item);
  });
  refill = () => {
    if (stopped || signal.aborted) return;
    for (const row of store
      .statement(`SELECT thread_id,item FROM items WHERE json_extract(item,'$.type')='tool_call'
      AND json_extract(item,'$.call.detail.kind')='image' AND json_extract(item,'$.complete')=1
      AND (json_type(item,'$.call.detail.path')='text' OR EXISTS(SELECT 1 FROM json_each(items.item,'$.call.raw') raw WHERE json_extract(raw.value,'$.data.type')='imageView' AND json_type(raw.value,'$.data.path')='text'))
      AND NOT EXISTS(SELECT 1 FROM native_images WHERE thread_id=items.thread_id AND item_id=items.id)
      AND EXISTS(SELECT 1 FROM threads WHERE threads.id=items.thread_id AND json_extract(threads.client,'$.deletedAt') IS NULL)
      ORDER BY rowid DESC LIMIT 258`)
      .all()) {
      const thread = String(row.thread_id);
      const item = Item.parse(JSON.parse(String(row.item)));
      const key = `${thread}:${item.id}`;
      if (nativePath(item) && !active.has(key) && pending.size < 256)
        pending.set(key, { thread, item });
    }
  };
  refill();
  pump();
  return async () => {
    stopped = true;
    stop();
    pending.clear();
    await Promise.allSettled(tasks);
  };
}
