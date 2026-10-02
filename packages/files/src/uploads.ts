import { open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SafeRoot } from "@ace/workspace";
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
  constructor(safe: SafeRoot, catalog: Catalog, options: FilesOptions) {
    this.safe = safe;
    this.catalog = catalog;
    this.options = options;
  }
  private record(id: string, device: string): UploadRecord {
    const record = UploadRecord.parse(this.catalog.get(id));
    if (record.device !== device)
      throw new FileError("FORBIDDEN", "Upload belongs to another device");
    if (record.expires <= this.options.now()) throw new FileError("EXPIRED", "Upload expired");
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
    try {
      const info = await handle.stat();
      await target.verify();
      const record: UploadRecord = {
        id,
        kind: "upload",
        path,
        temp,
        device,
        expected,
        bytes: size,
        identity: `${info.dev}:${info.ino}`,
        expires: this.options.now() + (this.options.retentionMs ?? 7 * 86400_000),
      };
      this.catalog.put(record);
    } catch (error) {
      await rm(join(dirname(target.path), temp), { force: true });
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
      await rename(join(dirname(target.path), record.temp), target.path);
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
    try {
      const target = await this.safe.target(record.path);
      await target.verify();
      await rm(join(dirname(target.path), record.temp), { force: true });
      await target.verify();
    } catch (error) {
      // Expiry must not prevent daemon startup when an agent removed or relocated
      // a parent. Never follow that parent outside the workspace to find the temp.
      if (!["ENOENT", "NOT_FOUND", "PATH_ESCAPE", "PATH_CHANGED"].includes(codeOf(error)))
        throw error;
    }
    this.catalog.delete(record.id);
  }
}
