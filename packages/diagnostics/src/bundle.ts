import { constants, createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdtemp, opendir, rm, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createGzip } from "node:zlib";
import tar from "tar-stream";
import { boundedMetadata } from "./bounded.ts";
import { DoctorReport } from "./doctor.ts";
export interface BundleOptions {
  logsDirectory: string;
  temporaryRoot: string;
  output: Writable;
  report: DoctorReport;
  versions: Record<string, string>;
  settings: unknown;
  redact: (line: string) => string;
  includeThreads?: boolean;
  threads?: () => AsyncIterable<string>;
  maxBytes?: number;
}
/** Keep complete lines across chunks. Drop oversized lines whole, never export prefixes. */
async function* sanitized(
  source: AsyncIterable<unknown>,
  redact: (line: string) => string,
  limit: number,
) {
  const decoder = new StringDecoder("utf8");
  let pending = "",
    oversized = false,
    bytes = 0;
  function line(value: string) {
    const clean = redact(value) + "\n";
    const size = Buffer.byteLength(clean);
    if (bytes + size > limit) return undefined;
    bytes += size;
    return clean;
  }
  for await (const chunk of source) {
    if (typeof chunk !== "string" && !Buffer.isBuffer(chunk))
      throw new Error("Invalid text source");
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let offset = 0;
    while (offset < text.length) {
      const end = text.indexOf("\n", offset);
      const fragment = text.slice(offset, end < 0 ? undefined : end);
      if (!oversized) {
        if (pending.length + fragment.length > 65536) {
          pending = "";
          oversized = true;
        } else pending += fragment;
      }
      if (end < 0) break;
      const clean = line(oversized ? "<OVERSIZED LINE OMITTED>" : pending);
      if (clean === undefined) return;
      yield clean;
      pending = "";
      oversized = false;
      offset = end + 1;
    }
  }
  pending += decoder.end();
  if (pending || oversized) {
    const clean = line(oversized ? "<OVERSIZED LINE OMITTED>" : pending);
    if (clean !== undefined) yield clean;
  }
}
export async function writeSupportBundle(options: BundleOptions): Promise<void> {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 256 * 1024 * 1024)
    throw new RangeError("Invalid bundle cap");
  const staging = await mkdtemp(join(options.temporaryRoot, "ace-support-"));
  const pack = tar.pack();
  const output = pipeline(pack, createGzip(), options.output);
  // Observe errors immediately while staging or writing entries.
  void output.catch(() => {});
  let remaining = maxBytes;
  let index = 0;
  async function entry(name: string, source: AsyncIterable<unknown>) {
    if (remaining <= 0) return;
    const path = join(staging, String(index++));
    await pipeline(
      Readable.from(sanitized(source, options.redact, remaining)),
      createWriteStream(path, { mode: 0o600, flags: "wx" }),
    );
    const size = (await stat(path)).size;
    remaining -= size;
    await pipeline(
      createReadStream(path),
      pack.entry({ name, size, mode: 0o600, mtime: new Date(0) }),
    );
    await rm(path);
  }
  try {
    await entry(
      "doctor.json",
      Readable.from([JSON.stringify(DoctorReport.parse(options.report)) + "\n"]),
    );
    await entry("versions.json", Readable.from([JSON.stringify(boundedMetadata(options.versions)) + "\n"]));
    await entry("settings.json", Readable.from([JSON.stringify(boundedMetadata(options.settings)) + "\n"]));
    const logs: string[] = [];
    const directory = await opendir(options.logsDirectory).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (directory)
      for await (const fileEntry of directory) {
        if (!/^ace(?:\.\d+)?\.jsonl$/.test(fileEntry.name) || !fileEntry.isFile()) continue;
        logs.push(fileEntry.name);
        logs.sort((a, b) =>
          a === "ace.jsonl"
            ? -1
            : b === "ace.jsonl"
              ? 1
              : Number(b.split(".")[1]) - Number(a.split(".")[1]),
        );
        if (logs.length > 1025) logs.pop();
      }
    for (const name of logs.slice(0, 1025)) {
      const path = join(options.logsDirectory, name);
      if (!(await lstat(path)).isFile()) continue;
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await entry(`logs/${name}`, file.createReadStream());
      } finally {
        await file.close();
      }
      if (remaining <= 0) break;
    }
    if (options.includeThreads && options.threads) await entry("threads.jsonl", options.threads());
    pack.finalize();
    await output;
  } catch (error) {
    pack.destroy(error instanceof Error ? error : new Error("Bundle failed"));
    await output.catch(() => {});
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
