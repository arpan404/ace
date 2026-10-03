import { once } from "node:events";
import { mkdir, symlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, Writable, type Readable } from "node:stream";
import type { Entry, ZipFile } from "yauzl";
import { openArchive } from "./archive-reader.ts";

function contained(root: string, path: string): string {
  const target = resolve(root, path);
  if (isAbsolute(path) || path.includes("\\") || target === root || !target.startsWith(root + sep))
    throw new Error("Unsafe Chromium archive path");
  return target;
}
function entryStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((accept, fail) =>
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) fail(error ?? new Error("Invalid archive entry"));
      else accept(stream);
    }),
  );
}
function nextEntry(zip: ZipFile, signal: AbortSignal): Promise<Entry | undefined> {
  return new Promise((accept, fail) => {
    const cleanup = () => {
      zip.off("entry", entry);
      zip.off("end", end);
      zip.off("error", error);
      signal.removeEventListener("abort", abort);
    };
    const entry = (value: Entry) => {
      cleanup();
      accept(value);
    };
    const end = () => {
      cleanup();
      accept(undefined);
    };
    const error = (cause: Error) => {
      cleanup();
      fail(cause);
    };
    const abort = () => {
      cleanup();
      fail(new Error("Chromium extraction cancelled"));
    };
    zip.once("entry", entry);
    zip.once("end", end);
    zip.once("error", error);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else zip.readEntry();
  });
}
/** Each ZIP entry streams to disk before requesting the next; archive links come last. */
export async function extractChromium(
  archive: string,
  root: string,
  signal: AbortSignal,
): Promise<void> {
  const zip = await openArchive(archive, signal);
  let bytes = 0,
    entries = 0;
  const links: { target: string; value: string }[] = [];
  const zipFailed = (error: Error) => {
    failure = error;
  };
  let failure: Error | undefined;
  zip.on("error", zipFailed);
  try {
    while (true) {
      signal.throwIfAborted();
      if (failure) throw failure;
      const entry = await nextEntry(zip, signal);
      if (!entry) break;
      if (
        ++entries > 20_000 ||
        entry.fileName.length > 512 ||
        entry.uncompressedSize > 512 * 1024 * 1024
      )
        throw new Error("Chromium archive entry limit");
      const target = contained(root, entry.fileName);
      const mode = entry.externalFileAttributes >>> 16;
      if ((mode & 0xf000) === 0xa000) {
        if (entry.uncompressedSize > 4096 || links.length >= 1024)
          throw new Error("Chromium archive symlink limit");
        // Legacy ZIP streams do not emit the close event required by Node's async
        // iterator cleanup. Pipeline drains them using the same path as regular files.
        const contents = Buffer.alloc(entry.uncompressedSize);
        let length = 0;
        await pipeline(
          await entryStream(zip, entry),
          new Writable({
            write(chunk: Buffer, _encoding, next) {
              bytes += chunk.length;
              if (
                !Buffer.isBuffer(chunk) ||
                length + chunk.length > contents.length ||
                bytes > 2 * 1024 * 1024 * 1024
              ) {
                next(new Error("Chromium symlink limit"));
                return;
              }
              chunk.copy(contents, length);
              length += chunk.length;
              next();
            },
          }),
          { signal },
        );
        const value = contents.subarray(0, length).toString("utf8");
        const destination = resolve(dirname(target), value);
        if (isAbsolute(value) || !destination.startsWith(root + sep) || value.includes("\0"))
          throw new Error("Unsafe Chromium symlink");
        links.push({ target, value });
      } else if (entry.fileName.endsWith("/")) {
        await mkdir(target, { recursive: true, mode: 0o700 });
      } else {
        if ((mode & 0xf000) !== 0 && (mode & 0xf000) !== 0x8000)
          throw new Error("Unsupported archive entry");
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const bound = new Transform({
          transform(chunk: Buffer, _encoding, next) {
            bytes += chunk.length;
            next(
              bytes > 2 * 1024 * 1024 * 1024 ? new Error("Chromium expansion limit") : null,
              chunk,
            );
          },
        });
        await pipeline(
          await entryStream(zip, entry),
          bound,
          createWriteStream(target, { flags: "wx", mode: mode & 0o111 ? 0o700 : 0o600 }),
          { signal },
        );
      }
    }
    signal.throwIfAborted();
    for (const link of links) {
      await mkdir(dirname(link.target), { recursive: true, mode: 0o700 });
      await symlink(link.value, link.target);
    }
  } finally {
    try {
      const closed = once(zip, "close");
      zip.close();
      await closed;
    } finally {
      zip.off("error", zipFailed);
    }
  }
}
