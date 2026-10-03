import type { ExclusiveRename } from "./exclusive-rename.ts";
import { lstat, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { GitIgnore, SafeRoot, walkWorkspace } from "@ace/workspace";
import { Catalog, UploadRecord } from "./catalog.ts";
import {
  checkedTarget,
  hashFile,
  newId,
  openUpload,
  writeAll,
  replacementMode,
} from "./filesystem.ts";
import { CHUNK_SIZE, codeOf, FileError, version, type FilesOptions } from "./types.ts";

export class Uploads {
  private readonly safe: SafeRoot;
  private readonly catalog: Catalog;
  private readonly options: FilesOptions;
  private readonly exclusive: ExclusiveRename;
  constructor(safe: SafeRoot, catalog: Catalog, options: FilesOptions, exclusive: ExclusiveRename) {
    this.safe = safe;
    this.catalog = catalog;
    this.options = options;
    this.exclusive = exclusive;
  }
  private record(id: string, device: string): UploadRecord {
    const record = UploadRecord.parse(this.catalog.get(id));
    if (record.device !== device)
      throw new FileError("FORBIDDEN", "Upload belongs to another device");
    if (record.expires <= this.options.now()) throw new FileError("EXPIRED", "Upload expired");
    if (record.cleanup) throw new FileError("ABORTED", "Upload cleanup is pending");
    return record;
  }
  async begin(device: string, path: string, expected: string | null, size: number) {
    const total = this.catalog.total("upload");
    if (
      total.count >= 32 ||
      size > (this.options.maxUploadBytes ?? 10 * 1024 ** 3) ||
      total.bytes + size > (this.options.maxReservedBytes ?? 20 * 1024 ** 3)
    )
      throw new FileError("QUOTA", "Upload quota exceeded");
    const target = await checkedTarget(this.safe, path, expected);
    const id = newId(this.options.id);
    const temp = `.ace-upload-${id}`;
    const handle = await open(join(dirname(target.path), temp), "wx", 0o600);
    let registered: UploadRecord | undefined;
    try {
      const info = await handle.stat();
      const record: UploadRecord = {
        id,
        kind: "upload",
        path,
        temp,
        device,
        expected,
        cleanup: false,
        bytes: size,
        identity: `${info.dev}:${info.ino}`,
        expires: this.options.now() + (this.options.retentionMs ?? 7 * 86400_000),
      };
      this.catalog.put(record);
      registered = record;
      await target.verify();
    } catch (error) {
      if (registered) await this.remove(registered);
      else {
        const own = await handle.stat();
        const current = await lstat(join(dirname(target.path), temp)).catch((problem: unknown) => {
          if (codeOf(problem) === "ENOENT") return undefined;
          throw problem;
        });
        if (current?.isFile() && current.dev === own.dev && current.ino === own.ino)
          await rm(join(dirname(target.path), temp));
      }
      throw error;
    } finally {
      await handle.close();
    }
    return { uploadId: id, offset: 0, size };
  }
  async resume(device: string, id: string) {
    const record = this.record(id, device);
    const { handle, verify } = await openUpload(this.safe, record);
    try {
      const offset = (await handle.stat()).size;
      await verify();
      return { uploadId: id, offset, size: record.bytes };
    } finally {
      await handle.close();
    }
  }
  async append(device: string, id: string, offset: number, bytes: Buffer) {
    const record = this.record(id, device);
    if (!bytes.length || bytes.length > CHUNK_SIZE || offset + bytes.length > record.bytes)
      throw new FileError("QUOTA", "Upload frame exceeds declared size");
    const { handle, verify } = await openUpload(this.safe, record);
    try {
      if ((await handle.stat()).size !== offset)
        throw new FileError("OFFSET", "Resume from acknowledged offset");
      await writeAll(handle, bytes, offset);
      await handle.sync();
      await verify();
      return { uploadId: id, offset: offset + bytes.length, size: record.bytes };
    } finally {
      await handle.close();
    }
  }
  async commit(device: string, id: string, sha256: string): Promise<string> {
    const record = this.record(id, device);
    const { handle, verify } = await openUpload(this.safe, record);
    try {
      if ((await handle.stat()).size !== record.bytes)
        throw new FileError("INCOMPLETE", "Upload is incomplete");
      const before = version(await handle.stat());
      if ((await hashFile(handle)) !== sha256)
        throw new FileError("CHECKSUM", "Upload SHA-256 mismatch");
      if (version(await handle.stat()) !== before)
        throw new FileError("CONFLICT", "Upload changed during verification");
      await verify();
      const target = await checkedTarget(this.safe, record.path, record.expected);
      if (record.expected !== null) await handle.chmod(await replacementMode(target.path));
      await handle.sync();
      await target.verify();
      await verify();
      const temp = join(dirname(target.path), record.temp);
      if (record.expected === null) await this.exclusive.move(temp, target.path);
      else await rename(temp, target.path);
      await target.verify();
      this.catalog.delete(id);
      return record.path;
    } finally {
      await handle.close();
    }
  }
  async cancel(device: string, id: string): Promise<void> {
    const record = this.record(id, device);
    await this.remove(record);
  }
  assertUnoccupied(path: string): void {
    const source = this.safe.path(path);
    for (const record of this.catalog.list("upload")) {
      const upload = UploadRecord.parse(record);
      const target = this.safe.path(upload.path);
      if (source === target || target.startsWith(source + "/"))
        throw new FileError("BUSY", "An upload owns this path or directory");
    }
  }
  async remove(record: UploadRecord): Promise<void> {
    await this.removeMany([record]);
  }
  /** Missing/replaced files keep their durable reservation until their inode is removed. */
  async removeMany(records: UploadRecord[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    for (const record of records) this.catalog.markUploadCleanup(record.id);
    const debt = new Map(records.map((record) => [record.temp, record]));
    const removeAt = async (record: UploadRecord, destination: string): Promise<boolean> => {
      try {
        signal?.throwIfAborted();
        const target = await this.safe.target(destination);
        const temp = join(dirname(target.path), record.temp);
        const info = await lstat(temp);
        if (!info.isFile() || `${info.dev}:${info.ino}` !== record.identity) return false;
        await target.verify();
        // Recheck after parent verification; never unlink a replacement inode.
        const current = await lstat(temp);
        if (!current.isFile() || `${current.dev}:${current.ino}` !== record.identity) return false;
        signal?.throwIfAborted();
        await rm(temp);
        await target.verify();
        this.catalog.delete(record.id);
        return true;
      } catch (error) {
        if (
          [
            "ENOENT",
            "NOT_FOUND",
            "PATH_ESCAPE",
            "PATH_CHANGED",
            "NOT_DIRECTORY",
            "INVALID_PATH",
            "ENOTDIR",
          ].includes(codeOf(error))
        )
          return false;
        throw error;
      }
    };
    for (const record of records) {
      signal?.throwIfAborted();
      if (await removeAt(record, record.path)) debt.delete(record.temp);
    }
    if (!debt.size) return;
    // One bounded traversal per cleanup batch, including ignored directories, never links.
    const ignore = await GitIgnore.create(this.safe);
    try {
      for await (const entry of walkWorkspace(this.safe, ignore, {
        dir: "",
        depth: Number.MAX_SAFE_INTEGER,
        includeIgnored: true,
        ...(signal ? { signal } : {}),
        exclude: () => false,
      })) {
        signal?.throwIfAborted();
        if (entry.type !== "file") continue;
        const record = debt.get(basename(entry.path));
        if (record && (await removeAt(record, join(dirname(entry.path), basename(record.path)))))
          debt.delete(record.temp);
        if (!debt.size) break;
      }
    } catch (error) {
      signal?.throwIfAborted();
      // A capped or raced scan leaves debt accounted for; future sweeps can retry.
      if (!["LIMIT_EXCEEDED", "NOT_FOUND", "PATH_CHANGED", "PATH_ESCAPE"].includes(codeOf(error)))
        throw error;
    }
  }
}
