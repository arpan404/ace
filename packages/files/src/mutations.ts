import type { ExclusiveRename } from "./exclusive-rename.ts";
import { lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { SafeRoot, GitIgnore, walkWorkspace } from "@ace/workspace";
import type { WorkspaceFileChange, FileOperation } from "@ace/protocol";
import { Catalog, TrashRecord } from "./catalog.ts";
import { atomicWrite, checkedTarget, newId, observed } from "./filesystem.ts";
import { codeOf, FileError, version, type FilesOptions } from "./types.ts";

type Mutation = Extract<
  FileOperation,
  { op: "write" | "create" | "mkdir" | "rename" | "move" | "delete" | "restore" }
>;
export class Mutations {
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
  async prepare(operation: Mutation, signal: AbortSignal) {
    const target = await checkedTarget(this.safe, operation.path, operation.expected, signal);
    const info = operation.expected === null ? undefined : await lstat(target.path);
    let bytes = info?.isFile() ? info.size : 0;
    const availableBytes =
      (this.options.maxTrashBytes ?? 20 * 1024 ** 3) - this.catalog.total("trash").bytes;
    if (operation.op === "delete" && info?.isDirectory()) {
      const ignore = await GitIgnore.create(this.safe);
      for await (const entry of walkWorkspace(this.safe, ignore, {
        dir: operation.path,
        depth: Number.MAX_SAFE_INTEGER,
        includeIgnored: true,
        exclude: () => false,
        signal,
        entryLimit: 1_000_000,
      })) {
        if (entry.type === "file") bytes += entry.size;
        if (bytes > availableBytes) throw new FileError("QUOTA", "Trash quota exceeded");
      }
    }
    return { target, fingerprint: info ? version(info) : null, bytes };
  }
  async apply(
    operation: Mutation,
    prepared: Awaited<ReturnType<Mutations["prepare"]>>,
  ): Promise<WorkspaceFileChange> {
    const { target } = prepared;
    await target.verify();
    const current = await lstat(target.path).catch((error: unknown) => {
      if (codeOf(error) === "ENOENT") return undefined;
      throw error;
    });
    if ((current ? version(current) : null) !== prepared.fingerprint)
      throw new FileError("CONFLICT", "File version changed");
    const id = newId(this.options.id);
    let trashId: string | undefined;
    let destination: string | undefined;
    switch (operation.op) {
      case "write":
      case "create": {
        const bytes = Buffer.from(operation.text);
        if (bytes.length > 1024 * 1024) throw new FileError("QUOTA", "Inline write exceeds 1 MiB");
        await atomicWrite(this.safe, operation.path, operation.expected, bytes, id, this.exclusive);
        break;
      }
      case "mkdir":
        await target.verify();
        try {
          await mkdir(target.path);
        } catch (error) {
          if (codeOf(error) === "EEXIST")
            throw new FileError("CONFLICT", "Directory was created concurrently");
          throw error;
        }
        await target.verify();
        break;
      case "rename":
      case "move": {
        if (operation.destination === operation.path)
          throw new FileError("INVALID_PATH", "Source equals destination");
        // Replacing a target must never permanently discard it. Move to an absent path only.
        if (operation.destinationExpected !== null)
          throw new FileError(
            "CONFLICT",
            "Move destination must be absent",
            await observed(this.safe, operation.destination),
          );
        const dest = await checkedTarget(
          this.safe,
          operation.destination,
          operation.destinationExpected,
        );
        await target.verify();
        await dest.verify();
        await this.exclusive.move(target.path, dest.path);
        await target.verify();
        await dest.verify();
        destination = operation.destination;
        break;
      }
      case "delete": {
        if (operation.expected === null)
          throw new FileError("NOT_FOUND", "Cannot delete an absent path");
        const total = this.catalog.total("trash");
        const bytes = prepared.bytes;
        if (
          total.count >= 128 ||
          total.bytes + bytes > (this.options.maxTrashBytes ?? 20 * 1024 ** 3)
        )
          throw new FileError("QUOTA", "Trash quota exceeded");
        const record: TrashRecord = {
          kind: "trash",
          id,
          path: operation.path,
          bytes,
          version: operation.expected,
          location: `.ace-upload-trash-${id}`,
          expires: this.options.now() + (this.options.retentionMs ?? 7 * 86400_000),
        };
        this.catalog.put(record);
        try {
          await target.verify();
          await this.exclusive.move(target.path, join(this.safe.root, `.ace-upload-trash-${id}`));
        } catch (error) {
          this.catalog.delete(id);
          throw error;
        }
        // After the rename, retain recovery metadata even if a parent race is detected.
        await target.verify();
        trashId = id;
        break;
      }
      case "restore": {
        const record = TrashRecord.parse(this.catalog.get(operation.trashId));
        if (record.expires <= this.options.now())
          throw new FileError("EXPIRED", "Trash entry expired");
        if (operation.expected !== null)
          throw new FileError(
            "CONFLICT",
            "Restore destination must be absent",
            await observed(this.safe, operation.path),
          );
        await target.verify();
        await this.exclusive.move(
          record.location
            ? await this.safe.resolve(record.location)
            : join(this.options.dataDir, "trash", record.id),
          target.path,
        );
        await target.verify();
        this.catalog.delete(record.id);
        break;
      }
    }
    return {
      id,
      op: operation.op,
      path: operation.path,
      version: await observed(this.safe, destination ?? operation.path),
      ...(destination ? { destination } : {}),
      ...(trashId ? { trashId } : {}),
    };
  }
  async expire(record: TrashRecord): Promise<void> {
    await rm(
      record.location
        ? await this.safe.resolve(record.location)
        : join(this.options.dataDir, "trash", record.id),
      { recursive: true, force: true },
    );
    this.catalog.delete(record.id);
  }
}
