import { mkdir, symlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { open, type Entry, type ZipFile } from "yauzl";

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
  const zip = await new Promise<ZipFile>((accept, fail) =>
    open(
      archive,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true },
      (error, result) => {
        if (error || !result) fail(error ?? new Error("Invalid Chromium archive"));
        else accept(result);
      },
    ),
  );
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
        const stream = await entryStream(zip, entry);
        const abort = () => stream.destroy(new Error("Chromium extraction cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        let value = "";
        try {
          for await (const chunk of stream) {
            signal.throwIfAborted();
            if (!Buffer.isBuffer(chunk)) throw new Error("Invalid archive data");
            bytes += chunk.length;
            value += chunk.toString("utf8");
            if (Buffer.byteLength(value) > 4096) throw new Error("Chromium symlink limit");
          }
        } finally {
          signal.removeEventListener("abort", abort);
          stream.destroy();
        }
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
    zip.close();
    zip.off("error", zipFailed);
  }
}
