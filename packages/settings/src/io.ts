import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, open, rename, unlink, stat } from "node:fs/promises";
import { dirname, basename, join, relative, sep } from "node:path";
import { MAX_DOCUMENT_BYTES, SettingsError } from "./document.ts";

export interface Scheduler {
  schedule(callback: () => void, delay: number): () => void;
}
export const scheduler: Scheduler = {
  schedule(callback, delay) {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
export interface FileIO {
  read(path: string): Promise<string | undefined>;
  write(path: string, text: string): Promise<void>;
  watch(path: string, changed: () => void, failed: () => void): Promise<() => void>;
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export async function readBounded(path: string): Promise<string | undefined> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  try {
    const size = (await file.stat()).size;
    if (size > MAX_DOCUMENT_BYTES)
      throw new SettingsError("size", "Settings document exceeds 1 MiB");
    let buffer = Buffer.alloc(Math.max(1, size + 1));
    let length = 0;
    while (true) {
      if (length === buffer.length) {
        if (length > MAX_DOCUMENT_BYTES)
          throw new SettingsError("size", "Settings document exceeds 1 MiB");
        const grown = Buffer.alloc(
          Math.min(MAX_DOCUMENT_BYTES + 1, Math.max(4096, buffer.length * 2)),
        );
        buffer.copy(grown);
        buffer = grown;
      }
      const result = await file.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
      if (length > MAX_DOCUMENT_BYTES)
        throw new SettingsError("size", "Settings document exceeds 1 MiB");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, length),
      );
    } catch {
      throw new SettingsError("parse", "Settings file is not valid UTF-8");
    }
  } finally {
    await file.close();
  }
}
export async function atomicWrite(
  path: string,
  text: string,
  beforeRename?: () => Promise<void>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(temp, "wx", 0o600);
  try {
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await beforeRename?.();
    await rename(temp, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temp).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
  }
}
async function watchPath(
  path: string,
  changed: () => void,
  failed: () => void,
): Promise<() => void> {
  let parent = dirname(path);
  while (true) {
    try {
      await stat(parent);
      break;
    } catch (error) {
      if (!missing(error) || dirname(parent) === parent) throw error;
      parent = dirname(parent);
    }
  }
  const child = relative(parent, path).split(sep)[0];
  const watcher = watch(parent, (_event, filename) => {
    if (!filename || filename.toString() === child) changed();
  });
  watcher.on("error", failed);
  return () => watcher.close();
}
export const fileIO: FileIO = { read: readBounded, write: atomicWrite, watch: watchPath };
