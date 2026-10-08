import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, writeFile } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { safeOpen, fingerprint } from "@ace/native-session";

export class SnapshotChanged extends Error {
  constructor() {
    super("Provider database changed during snapshot; retry when its writer settles");
  }
}

/** Copy a frozen WAL prefix. Appending commits is safe; reset/checkpoint/replacement is not. */
export async function copySqliteSnapshot(
  home: string,
  source: string,
  target: string,
  signal: AbortSignal,
  walPath?: string,
): Promise<void> {
  const base = await safeOpen(home, source);
  try {
    const before = fingerprint(await base.stat());
    await copyDatabase(base, target, signal);
    if (walPath) {
      const journal = await safeOpen(home, walPath);
      try {
        const size = (await journal.stat()).size;
        const copied = await copyWal(journal, target + "-wal", signal, size);
        // Compare only copied bytes. Later commits need not stop the history scanner.
        const hash = createHash("sha256");
        const stream =
          size === 0
            ? []
            : journal.createReadStream({
                autoClose: false,
                highWaterMark: 64 * 1024,
                start: 0,
                end: Math.max(0, size - 1),
              });
        for await (const chunk of stream) {
          signal.throwIfAborted();
          hash.update(chunk);
        }
        const after = await lstat(walPath);
        const opened = await journal.stat();
        if (
          after.dev !== opened.dev ||
          after.ino !== opened.ino ||
          opened.size < size ||
          copied !== hash.digest("hex")
        )
          throw new SnapshotChanged();
      } finally {
        await journal.close();
      }
    }
    if (before !== fingerprint(await base.stat()) || before !== fingerprint(await lstat(source)))
      throw new SnapshotChanged();
  } finally {
    await base.close();
  }
}
/** The database fingerprint fences writes. Only WAL prefixes need a content digest. */
async function copyDatabase(
  file: Awaited<ReturnType<typeof safeOpen>>,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  const length = (await file.stat()).size;
  if (length === 0) {
    signal.throwIfAborted();
    await writeFile(target, "", { flag: "wx", mode: 0o600 });
    return;
  }
  await pipeline(
    file.createReadStream({
      autoClose: false,
      highWaterMark: 64 * 1024,
      start: 0,
      end: length - 1,
    }),
    createWriteStream(target, { flags: "wx", mode: 0o600 }),
    { signal },
  );
}
async function copyWal(
  file: Awaited<ReturnType<typeof safeOpen>>,
  target: string,
  signal: AbortSignal,
  length: number,
): Promise<string> {
  const hash = createHash("sha256");
  if (length === 0) {
    signal.throwIfAborted();
    await writeFile(target, "", { flag: "wx", mode: 0o600 });
    return hash.digest("hex");
  }
  const digest = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(
    file.createReadStream({
      autoClose: false,
      highWaterMark: 64 * 1024,
      start: 0,
      end: Math.max(0, length - 1),
    }),
    digest,
    createWriteStream(target, { flags: "wx", mode: 0o600 }),
    { signal },
  );
  return hash.digest("hex");
}
