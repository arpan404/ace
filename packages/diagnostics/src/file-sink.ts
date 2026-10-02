import { constants } from "node:fs";
import { mkdir, opendir, lstat, appendFile, rename, unlink, chmod } from "node:fs/promises";
import { join } from "node:path";
export interface FileSinkOptions {
  directory: string;
  fileBytes: number;
  totalBytes: number;
}
/** Single owner only. The worker serializes calls, including startup and rotation. */
export async function openFileSink(options: FileSinkOptions) {
  if (
    !Number.isSafeInteger(options.fileBytes) ||
    options.fileBytes < 128 ||
    !Number.isSafeInteger(options.totalBytes) ||
    options.totalBytes < options.fileBytes ||
    options.totalBytes / options.fileBytes > 1024
  )
    throw new RangeError("Invalid file limits");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const current = join(options.directory, "ace.jsonl");
  const files: { name: string; bytes: number }[] = [];
  let serial = 0;
  for await (const entry of await opendir(options.directory)) {
    if (!/^ace\.\d+\.jsonl$/.test(entry.name)) continue;
    const sequence = Number(entry.name.split(".")[1]);
    if (!Number.isSafeInteger(sequence) || !entry.isFile())
      throw new Error("Invalid rotated log file");
    serial = Math.max(serial, sequence);
    files.push({
      name: entry.name,
      bytes: (await lstat(join(options.directory, entry.name))).size,
    });
    files.sort((a, b) => Number(a.name.split(".")[1]) - Number(b.name.split(".")[1]));
    if (files.length > 1024) {
      const oldest = files.shift();
      if (oldest) await unlink(join(options.directory, oldest.name));
    }
  }
  let currentBytes = await lstat(current).then(
    (s) => {
      if (!s.isFile()) throw new Error("Invalid current log file");
      return s.size;
    },
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
      throw error;
    },
  );
  let total = currentBytes + files.reduce((sum, file) => sum + file.bytes, 0);
  async function trim() {
    while (total > options.totalBytes && files.length) {
      const oldest = files.shift();
      if (oldest) {
        await unlink(join(options.directory, oldest.name));
        total -= oldest.bytes;
      }
    }
    if (total > options.totalBytes) {
      await unlink(current);
      total -= currentBytes;
      currentBytes = 0;
    }
  }
  await trim();
  return {
    async write(lines: readonly string[]) {
      let pending = "",
        pendingBytes = 0;
      async function commit() {
        if (!pending) return;
        await appendFile(current, pending, {
          mode: 0o600,
          flag: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
        });
        await chmod(current, 0o600);
        currentBytes += pendingBytes;
        total += pendingBytes;
        pending = "";
        pendingBytes = 0;
        await trim();
      }
      for (const line of lines) {
        const bytes = Buffer.byteLength(line);
        if (bytes > options.fileBytes) throw new Error("Log record exceeds file size");
        if (currentBytes + pendingBytes + bytes > options.fileBytes) {
          await commit();
          if (currentBytes) {
            const name = `ace.${++serial}.jsonl`;
            await rename(current, join(options.directory, name));
            files.push({ name, bytes: currentBytes });
            currentBytes = 0;
          }
        }
        pending += line;
        pendingBytes += bytes;
      }
      await commit();
    },
  };
}
