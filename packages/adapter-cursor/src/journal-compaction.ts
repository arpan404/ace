import { constants, createReadStream } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { z } from "zod";
import { Envelope, type CursorEnvelope } from "./contracts.ts";

/** Where a compaction writes the next journal before it renames it into place. */
export const compactionSuffix = ".compact";

const identity = z.string().min(1).max(512);
/**
 * A compacted journal starts with one or more header lines. They name the offset of the last
 * frame dropped and the SDK observe offsets those frames had set, so recovery rebuilds the same
 * state. Several lines only when the observe offsets do not fit in one frame's budget.
 */
const Header = z.strictObject({
  aceJournal: z.literal(2),
  baseOffset: z.number().int().positive().max(10000000),
  observe: z.array(z.tuple([identity, identity])),
});
export type JournalHeader = z.infer<typeof Header>;

/** A header line, or undefined when the line is an ordinary frame. */
export function parseHeader(value: unknown): JournalHeader | undefined {
  const header = Header.safeParse(value);
  return header.success ? header.data : undefined;
}

/** Header lines for `baseOffset`, each within `maxLineBytes` including its newline. */
export function encodeHeader(
  baseOffset: number,
  observe: ReadonlyMap<string, string>,
  maxLineBytes: number,
): string[] {
  const lines: string[] = [];
  const line = (entries: [string, string][]) =>
    JSON.stringify({ aceJournal: 2, baseOffset, observe: entries } satisfies JournalHeader) + "\n";
  let entries: [string, string][] = [];
  for (const entry of observe) {
    const next = [...entries, entry];
    if (entries.length && Buffer.byteLength(line(next)) > maxLineBytes) {
      lines.push(line(entries));
      entries = [entry];
    } else entries = next;
  }
  const last = line(entries);
  if (Buffer.byteLength(last) > maxLineBytes) throw new Error("SDK journal header exceeds budget");
  lines.push(last);
  return lines;
}

/** Applies a frame's SDK observe offset, the one piece of state recovery rebuilds. */
export function observeOf(frame: CursorEnvelope): [string, string] | undefined {
  if (!["observe", "recovery"].includes(frame.kind) || !frame.observeOffset || !frame.runId)
    return undefined;
  return [frame.runId, frame.observeOffset];
}

/**
 * Writes the next journal to `temp`: a header for every frame up to `target`, then the frames
 * after it, read from the first `bytes` of `path`. The source is only read, so appends past
 * `bytes` may continue meanwhile. Yields between lines so the host is never held for long.
 * Returns the open temp file and where its frames end; the caller fsyncs and renames it.
 */
export async function writeCompacted(options: {
  path: string;
  temp: string;
  bytes: number;
  target: number;
  maxFrameBytes: number;
}): Promise<{ file: FileHandle; bytes: number; lastOffset: number }> {
  const { path, temp, target, maxFrameBytes } = options;
  // A temp file left by a crash is never trusted; it is rewritten from the journal.
  await unlinkIfPresent(temp);
  const file = await open(
    temp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const observe = new Map<string, string>();
    const kept: string[] = [];
    let keptBytes = 0;
    let written = 0;
    let offset: number | undefined;
    let headerWritten = false;
    const flush = async () => {
      if (!kept.length) return;
      const chunk = kept.join("");
      kept.length = 0;
      keptBytes = 0;
      await file.writeFile(chunk);
      written += Buffer.byteLength(chunk);
    };
    const writeHeader = async () => {
      for (const line of encodeHeader(target, observe, maxFrameBytes)) {
        await file.writeFile(line);
        written += Buffer.byteLength(line);
      }
      headerWritten = true;
    };
    if (options.bytes > 0) {
      const stream = createReadStream(path, { start: 0, end: options.bytes - 1, highWaterMark: 65536 });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let count = 0;
      try {
        for await (const line of lines) {
          if (++count % 256 === 0) await yieldImmediate();
          const value: unknown = JSON.parse(line);
          const header = parseHeader(value);
          if (header) {
            if (offset !== undefined && offset !== header.baseOffset)
              throw new Error("SDK journal header conflicts with its frames");
            offset = header.baseOffset;
            for (const [runId, at] of header.observe) observe.set(runId, at);
            continue;
          }
          const frame = Envelope.parse(value);
          if (frame.boundaryOffset !== (offset ?? 0) + 1)
            throw new Error("SDK journal has an incomplete or unordered commit");
          offset = frame.boundaryOffset;
          if (offset <= target) {
            const observed = observeOf(frame);
            if (observed) observe.set(...observed);
            continue;
          }
          if (!headerWritten) await writeHeader();
          kept.push(line + "\n");
          keptBytes += Buffer.byteLength(line) + 1;
          if (keptBytes >= 65536) await flush();
        }
      } finally {
        lines.close();
        stream.destroy();
      }
    }
    if ((offset ?? 0) < target) throw new Error("SDK journal compaction target is past its end");
    if (!headerWritten) await writeHeader();
    await flush();
    return { file, bytes: written, lastOffset: offset ?? 0 };
  } catch (error) {
    await file.close();
    await unlinkIfPresent(temp);
    throw error;
  }
}

/** Copies `[start, end)` of `path` to the end of `file`, a few chunks at a time. */
export async function copyTail(
  path: string,
  start: number,
  end: number,
  file: FileHandle,
): Promise<void> {
  if (end <= start) return;
  const stream = createReadStream(path, { start, end: end - 1, highWaterMark: 65536 });
  try {
    for await (const chunk of stream) await file.writeFile(z.instanceof(Buffer).parse(chunk));
  } finally {
    stream.destroy();
  }
}

/** Makes a rename durable. Windows cannot open a directory for fsync; NTFS journals it. */
export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
