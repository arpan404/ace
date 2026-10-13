import {
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { appendFile, chmod, lstat, mkdir, opendir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { logSegmentBytes, segmentsToEvict, type LogSegment } from "./log-policy.ts";

export interface FileSinkOptions {
  directory: string;
  /** Disk cap for this stream: the current file plus every rotated segment. */
  totalBytes: number;
  /** Segment size. Derived from `totalBytes` unless a caller pins it. */
  fileBytes?: number;
}
const CURRENT = "ace.jsonl";
const ROTATED = /^ace\.(\d+)\.jsonl$/;
const APPEND = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW;
const absent = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

function limits(options: FileSinkOptions) {
  const fileBytes = options.fileBytes ?? logSegmentBytes(options.totalBytes);
  if (
    !Number.isSafeInteger(fileBytes) ||
    fileBytes < 128 ||
    !Number.isSafeInteger(options.totalBytes) ||
    options.totalBytes < fileBytes ||
    options.totalBytes / fileBytes > 1024
  )
    throw new RangeError("Invalid file limits");
  return { fileBytes, totalBytes: options.totalBytes };
}
const sequence = (name: string) => Number(ROTATED.exec(name)?.[1]);
const ordered = (files: LogSegment[]) =>
  files.toSorted((a, b) => sequence(a.name) - sequence(b.name));

/** Single owner only. The worker serializes calls, including startup, rotation and resize. */
export async function openFileSink(options: FileSinkOptions) {
  let { fileBytes, totalBytes } = limits(options);
  const pinned = options.fileBytes !== undefined;
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const current = join(options.directory, CURRENT);
  let files: LogSegment[] = [];
  let serial = 0;
  let currentBytes = 0;
  /** Read the directory again: retention or a person may have removed segments meanwhile. */
  async function scan() {
    const found: LogSegment[] = [];
    for await (const entry of await opendir(options.directory)) {
      if (!ROTATED.test(entry.name)) continue;
      const number = sequence(entry.name);
      if (!Number.isSafeInteger(number) || !entry.isFile())
        throw new Error("Invalid rotated log file");
      serial = Math.max(serial, number);
      const bytes = await lstat(join(options.directory, entry.name)).then(
        (info) => info.size,
        (error: unknown) => {
          if (absent(error)) return undefined;
          throw error;
        },
      );
      if (bytes !== undefined) found.push({ name: entry.name, bytes });
    }
    files = ordered(found);
    currentBytes = await lstat(current).then(
      (info) => {
        if (!info.isFile()) throw new Error("Invalid current log file");
        return info.size;
      },
      (error: unknown) => {
        if (absent(error)) return 0;
        throw error;
      },
    );
  }
  await scan();
  /** Make room for `incoming` bytes so the stream never exceeds its cap on disk. */
  async function reserve(incoming: number) {
    const { evict, truncateCurrent } = segmentsToEvict(files, currentBytes, incoming, totalBytes);
    for (const segment of evict) {
      files.shift();
      await unlink(join(options.directory, segment.name)).catch((error: unknown) => {
        if (!absent(error)) throw error;
      });
    }
    if (truncateCurrent && currentBytes) {
      await unlink(current).catch((error: unknown) => {
        if (!absent(error)) throw error;
      });
      currentBytes = 0;
    }
  }
  async function rotate() {
    if (!currentBytes) return;
    const name = `ace.${++serial}.jsonl`;
    await rename(current, join(options.directory, name));
    files.push({ name, bytes: currentBytes });
    currentBytes = 0;
  }
  await reserve(0);
  return {
    /** Appends whole lines, one write per segment. Lines larger than a segment are dropped. */
    async write(lines: readonly string[]): Promise<{ dropped: number }> {
      let pending = "",
        pendingBytes = 0,
        dropped = 0;
      async function commit() {
        if (!pending) return;
        await reserve(pendingBytes);
        await appendFile(current, pending, { mode: 0o600, flag: APPEND });
        await chmod(current, 0o600);
        currentBytes += pendingBytes;
        pending = "";
        pendingBytes = 0;
      }
      for (const line of lines) {
        const bytes = Buffer.byteLength(line);
        if (bytes > fileBytes) {
          dropped++;
          continue;
        }
        if (currentBytes + pendingBytes + bytes > fileBytes) {
          await commit();
          await rotate();
        }
        pending += line;
        pendingBytes += bytes;
      }
      await commit();
      return { dropped };
    },
    /** Apply a new cap now, deleting the oldest segments the smaller cap no longer allows. */
    async resize(next: number): Promise<void> {
      ({ fileBytes, totalBytes } = limits({
        directory: options.directory,
        totalBytes: next,
        ...(pinned ? { fileBytes } : {}),
      }));
      await scan();
      if (currentBytes > fileBytes) await rotate();
      await reserve(0);
    },
  };
}

/**
 * Crash-path append for a process that may not reach another event-loop turn. It rescans the
 * directory, keeps the stream under its cap and appends with one synchronous write.
 */
export function appendLogLinesSync(options: FileSinkOptions, lines: readonly string[]): void {
  const { fileBytes, totalBytes } = limits(options);
  const text = lines.filter((line) => Buffer.byteLength(line) <= fileBytes).join("");
  const bytes = Buffer.byteLength(text);
  if (!bytes) return;
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const current = join(options.directory, CURRENT);
  const found: LogSegment[] = [];
  let serial = 0;
  for (const name of readdirSync(options.directory)) {
    if (!ROTATED.test(name)) continue;
    serial = Math.max(serial, sequence(name));
    found.push({ name, bytes: lstatSync(join(options.directory, name)).size });
  }
  const files = ordered(found);
  let currentBytes = 0;
  try {
    currentBytes = lstatSync(current).size;
  } catch (error) {
    if (!absent(error)) throw error;
  }
  if (currentBytes && currentBytes + bytes > fileBytes) {
    const name = `ace.${serial + 1}.jsonl`;
    renameSync(current, join(options.directory, name));
    files.push({ name, bytes: currentBytes });
    currentBytes = 0;
  }
  const { evict, truncateCurrent } = segmentsToEvict(files, currentBytes, bytes, totalBytes);
  for (const segment of evict) {
    try {
      unlinkSync(join(options.directory, segment.name));
    } catch (error) {
      if (!absent(error)) throw error;
    }
  }
  if (truncateCurrent && currentBytes) unlinkSync(current);
  const descriptor = openSync(current, APPEND, 0o600);
  try {
    const buffer = Buffer.from(text);
    for (let offset = 0; offset < buffer.length;) offset += writeSync(descriptor, buffer, offset);
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
}
