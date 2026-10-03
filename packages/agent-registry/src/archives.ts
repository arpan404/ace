import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import { open as openZip, type ZipFile, type Entry } from "yauzl";
import { contained } from "./plans.ts";
const maximum = 256 * 1024 * 1024;
class ExpansionBudget {
  bytes = 0;
  entries = 0;
  entry(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0 || size > maximum || ++this.entries > 10000)
      throw new Error("Archive entry budget exceeded");
  }
  stream(): Transform {
    return new Transform({
      transform: (chunk: Buffer, _encoding, done) => {
        this.bytes += chunk.length;
        done(this.bytes > maximum ? new Error("Archive expansion budget exceeded") : null, chunk);
      },
    });
  }
}
export async function extractTar(path: string, root: string, signal: AbortSignal): Promise<void> {
  const budget = new ExpansionBudget();
  const archive = extract();
  const active = new Set<Promise<void>>();
  archive.on("entry", (header, stream, next) => {
    const task = (async () => {
      signal.throwIfAborted();
      budget.entry(header.size ?? 0);
      if (header.type === "directory" && [".", "./"].includes(header.name)) {
        stream.resume();
        next();
        return;
      }
      const destination = contained(root, header.name.replace(/\/$/, ""));
      if (header.type === "directory") {
        await mkdir(destination, { recursive: true, mode: 0o700 });
        stream.resume();
      } else if (header.type === "file") {
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await pipeline(
          stream,
          budget.stream(),
          createWriteStream(destination, { flags: "wx", mode: 0o600 }),
          { signal },
        );
      } else throw new Error("Archive links and special files are unsupported");
      next();
    })().catch((error) =>
      archive.destroy(error instanceof Error ? error : new Error("Archive extraction failed")),
    );
    active.add(task);
    void task.then(() => active.delete(task));
  });
  try {
    await pipeline(
      createReadStream(path),
      createGunzip(),
      new ExpansionBudget().stream(),
      archive,
      { signal },
    );
  } finally {
    await Promise.allSettled(active);
  }
}
export async function extractZip(path: string, root: string, signal: AbortSignal): Promise<void> {
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    openZip(
      path,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true },
      (error, result) =>
        error || !result ? reject(error ?? new Error("Invalid ZIP")) : resolve(result),
    ),
  );
  const budget = new ExpansionBudget();
  const active = new Set<Promise<void>>();
  const lifetime = new AbortController();
  const extractionSignal = AbortSignal.any([signal, lifetime.signal]);
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => {
        lifetime.abort();
        zip.close();
        reject(error);
      };
      const abort = () => fail(new Error("Archive cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      zip.once("error", fail);
      zip.once("end", () => {
        signal.removeEventListener("abort", abort);
        resolve();
      });
      zip.once("close", () => signal.removeEventListener("abort", abort));
      zip.on("entry", (entry: Entry) => {
        const task = (async () => {
          extractionSignal.throwIfAborted();
          budget.entry(entry.uncompressedSize);
          const type = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (type && type !== 0o100000 && type !== 0o040000)
            throw new Error("ZIP links and special files unsupported");
          if (entry.generalPurposeBitFlag & 1) throw new Error("Encrypted ZIP unsupported");
          const destination = contained(root, entry.fileName.replace(/\/$/, ""));
          if (entry.fileName.endsWith("/"))
            await mkdir(destination, { recursive: true, mode: 0o700 });
          else {
            await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
            const stream = await new Promise<import("node:stream").Readable>(
              (resolveStream, rejectStream) =>
                zip.openReadStream(entry, (error, value) =>
                  error || !value
                    ? rejectStream(error ?? new Error("ZIP stream unavailable"))
                    : resolveStream(value),
                ),
            );
            await pipeline(
              stream,
              budget.stream(),
              createWriteStream(destination, { flags: "wx", mode: 0o600 }),
              { signal: extractionSignal },
            );
          }
          zip.readEntry();
        })().catch(fail);
        active.add(task);
        void task.then(() => active.delete(task));
      });
      if (signal.aborted) abort();
      else zip.readEntry();
    });
  } finally {
    lifetime.abort();
    zip.close();
    await Promise.allSettled(active);
  }
}
