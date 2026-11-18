import { rm, rename as nodeRename } from "node:fs/promises";
import { join } from "node:path";
import type { SafeRoot } from "@ace/workspace";
import type { WorkspaceFileChange, FileOperation } from "@ace/protocol";
import { Catalog, TrashRecord } from "./catalog.ts";
import { newId } from "./filesystem.ts";
import type { FilesIo } from "./io.ts";
import { codeOf, FileError, checkVersion, type FilesOptions } from "./types.ts";

type Mutation = Extract<
  FileOperation,
  { op: "write" | "create" | "mkdir" | "rename" | "move" | "delete" | "restore" }
>;

/**
 * The write operations a client asks for, on the checkout's I/O port.
 *
 * Preparation reads the version the client worked from and fails with `CONFLICT` (and the current
 * version) when it differs; the same check runs again under the mutation queue, so a save that
 * lost a race never lands on another writer's work. Recently-deleted entries are this class's own
 * bookkeeping: a delete moves the entry to a private name in the checkout, and a restore moves it
 * back only while the destination is still absent.
 */
export class Mutations {
  private readonly io: FilesIo;
  private readonly safe: SafeRoot;
  private readonly catalog: Catalog;
  private readonly options: FilesOptions;
  constructor(io: FilesIo, safe: SafeRoot, catalog: Catalog, options: FilesOptions) {
    this.io = io;
    this.safe = safe;
    this.catalog = catalog;
    this.options = options;
  }
  private root(): string {
    return this.safe.root;
  }
  async prepare(operation: Mutation, signal: AbortSignal) {
    const current = await this.io.describe(this.root(), operation.path, { signal });
    checkVersion(current?.version ?? null, operation.expected);
    const bytes =
      operation.op === "delete" && current?.kind === "directory"
        ? await this.io.measure(this.root(), operation.path, { signal })
        : current?.kind === "file"
          ? current.size
          : 0;
    return { fingerprint: current?.version ?? null, bytes };
  }
  async apply(
    operation: Mutation,
    prepared: Awaited<ReturnType<Mutations["prepare"]>>,
  ): Promise<WorkspaceFileChange> {
    const root = this.root();
    const current = await this.io.describe(root, operation.path);
    if ((current?.version ?? null) !== prepared.fingerprint)
      throw new FileError("CONFLICT", "File version changed");
    const id = newId(this.options.id);
    let trashId: string | undefined;
    let destination: string | undefined;
    switch (operation.op) {
      case "write":
      case "create": {
        const bytes = Buffer.from(operation.text);
        if (bytes.length > 1024 * 1024) throw new FileError("QUOTA", "Inline write exceeds 1 MiB");
        await this.io.write(root, operation.path, bytes, operation.expected);
        break;
      }
      case "mkdir":
        try {
          await this.io.createDir(root, operation.path);
        } catch (error) {
          // A taken name is a plain conflict for `mkdir`: the client already knows it exists.
          if (error instanceof FileError && error.code === "CONFLICT")
            throw new FileError("CONFLICT", error.message);
          throw error;
        }
        break;
      case "rename":
      case "move": {
        if (operation.destination === operation.path)
          throw new FileError("INVALID_PATH", "Source equals destination");
        // Replacing a target must never permanently discard it. Move to an absent path only.
        if (operation.destinationExpected !== null) {
          const target = await this.io.describe(root, operation.destination);
          throw new FileError(
            "CONFLICT",
            "Move destination must be absent",
            target?.version ?? null,
          );
        }
        await this.io.move(root, operation.path, operation.destination);
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
          await this.io.move(root, operation.path, `.ace-upload-trash-${id}`);
        } catch (error) {
          this.catalog.delete(id);
          throw error;
        }
        trashId = id;
        break;
      }
      case "restore": {
        const record = TrashRecord.parse(this.catalog.get(operation.trashId));
        if (record.expires <= this.options.now())
          throw new FileError("EXPIRED", "Trash entry expired");
        if (operation.expected !== null) {
          const target = await this.io.describe(root, operation.path);
          throw new FileError(
            "CONFLICT",
            "Restore destination must be absent",
            target?.version ?? null,
          );
        }
        if (record.location) await this.io.move(root, record.location, operation.path);
        else await this.legacyMove(record.id, operation.path);
        this.catalog.delete(record.id);
        break;
      }
    }
    const after = await this.io.describe(root, destination ?? operation.path);
    return {
      id,
      op: operation.op,
      path: operation.path,
      version: after?.version ?? null,
      ...(destination ? { destination } : {}),
      ...(trashId ? { trashId } : {}),
    };
  }
  /** Forget a trash entry: delete the bytes it kept, then its row. */
  async expire(record: TrashRecord): Promise<void> {
    if (record.location) await this.io.remove(this.root(), record.location);
    else await this.legacyRemove(record.id);
    this.catalog.delete(record.id);
  }
  /**
   * Trash entries written before the checkout kept its own copies live in the daemon's data
   * folder, outside any checkout root, so they move with Node's rename, not a port op. They last
   * one retention window and are never created again.
   */
  private async legacyMove(id: string, path: string): Promise<void> {
    try {
      await nodeRename(join(this.options.dataDir, "trash", id), this.safe.path(path));
    } catch (error) {
      throw new FileError(codeOf(error), "Trash entry could not be restored");
    }
  }
  private async legacyRemove(id: string): Promise<void> {
    await rm(join(this.options.dataDir, "trash", id), { recursive: true, force: true });
  }
}
