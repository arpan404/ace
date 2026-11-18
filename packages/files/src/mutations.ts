import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { SafeRoot } from "@ace/workspace";
import type { WorkspaceFileChange, FileOperation } from "@ace/protocol";
import { Catalog, TrashRecord } from "./catalog.ts";
import type { ExclusiveRename } from "./exclusive-rename.ts";
import { newId } from "./filesystem.ts";
import type { Description, FilesIo } from "./io.ts";
import { codeOf, FileError, checkVersion, type FilesOptions } from "./types.ts";

type Mutation = Extract<
  FileOperation,
  { op: "write" | "create" | "mkdir" | "rename" | "move" | "delete" | "restore" }
>;

/** What preparation learned: the guard a queued apply re-checks, and what a delete reserves. */
interface Prepared {
  /** The entry's own version at prepare: identity and times, never a folder digest. */
  guard: string | null;
  /** The version the client's expectation was checked against, dug through for a folder. */
  version: string | null;
  /** True when a walk budget stopped that version, so only the guard can be compared. */
  shallow: boolean;
  /** True when the path is a folder, whose tree the version covers. */
  directory: boolean;
  /** The bytes a delete would reserve in the trash. */
  bytes: number;
}

/**
 * The write operations a client asks for, on the checkout's I/O port.
 *
 * Preparation reads the version the client worked from and fails with `CONFLICT` (and the current
 * version) when it differs; the same check runs again under the mutation queue, so a save that
 * lost a race never lands on another writer's work. Recently-deleted entries are this class's own
 * bookkeeping: a delete moves the entry to a private name in the checkout, and a restore moves it
 * back only while the destination is still absent.
 *
 * Preparation happens outside the mutation queue and may walk a folder once. The queued apply
 * compares only the folder's own version, so a delete of `node_modules` does not walk it again
 * with every other write waiting: a direct entry change is the one case that re-reads the tree
 * digest, and a folder too large to digest is guarded by its own version alone.
 */
export class Mutations {
  private readonly io: FilesIo;
  private readonly safe: SafeRoot;
  private readonly catalog: Catalog;
  private readonly options: FilesOptions;
  private readonly exclusive: ExclusiveRename;
  constructor(
    io: FilesIo,
    safe: SafeRoot,
    catalog: Catalog,
    options: FilesOptions,
    exclusive: ExclusiveRename,
  ) {
    this.io = io;
    this.safe = safe;
    this.catalog = catalog;
    this.options = options;
    this.exclusive = exclusive;
  }
  private root(): string {
    return this.safe.root;
  }
  async prepare(operation: Mutation, signal: AbortSignal): Promise<Prepared> {
    const description = await this.io.describe(this.root(), operation.path, { signal });
    checkVersion(description?.version ?? null, operation.expected);
    const guard = description === null ? null : (description.ownVersion ?? description.version);
    const directory = description?.kind === "directory";
    const bytes = directory
      ? operation.op === "delete"
        ? (await this.io.measure(this.root(), operation.path, { signal })).bytes
        : 0
      : description?.kind === "file"
        ? description.size
        : 0;
    return {
      guard,
      version: description?.version ?? null,
      shallow: description?.shallow ?? false,
      directory,
      bytes,
    };
  }
  async apply(operation: Mutation, prepared: Prepared): Promise<WorkspaceFileChange> {
    const root = this.root();
    const current = await this.io.shallow(root, operation.path);
    const guard = current === null ? null : current.version;
    if (guard !== prepared.guard) {
      const latest = await this.revalidated(operation.path, current, prepared);
      throw new FileError("CONFLICT", "File version changed", latest);
    }
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
        const location = `.ace-upload-trash-${id}`;
        const record: TrashRecord = {
          kind: "trash",
          id,
          path: operation.path,
          bytes,
          version: operation.expected,
          location,
          expires: this.options.now() + (this.options.retentionMs ?? 7 * 86400_000),
        };
        await this.io.checkMutation(root, operation.path);
        this.catalog.put(record);
        try {
          await this.io.internal.move(root, operation.path, location);
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
        await this.io.checkMutation(root, operation.path);
        if (record.location) await this.io.internal.move(root, record.location, operation.path);
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
  /**
   * The version to report for an entry that moved between prepare and apply.
   *
   * The own version already answered the common case; when it changed on a folder whose tree was
   * digested, the digest is read once more, so a rename out and back is not a conflict while a
   * real change is. A folder too large to digest keeps its own version, which is what `prepare`
   * compared.
   */
  private async revalidated(
    path: string,
    current: Description | null,
    prepared: Prepared,
  ): Promise<string | null> {
    if (!prepared.directory || prepared.shallow || current?.kind !== "directory")
      return current?.version ?? null;
    const again = await this.io.describe(this.root(), path);
    if ((again?.version ?? null) === prepared.version) return null;
    return again?.version ?? null;
  }
  /** Forget a trash entry: delete the bytes it kept, then its row. */
  async expire(record: TrashRecord): Promise<void> {
    if (record.location) await this.io.internal.remove(this.root(), record.location);
    else await this.legacyRemove(record.id);
    this.catalog.delete(record.id);
  }
  /**
   * Trash entries written before the checkout kept its own copies live in the daemon's data
   * folder, outside any checkout root, so they move with Node's rename, not a port op. They last
   * one retention window and are never created again.
   *
   * The destination is the same confined, link-free target a client mutation gets, and the move
   * never replaces a name: a destination that appeared after the queue admitted this restore is a
   * `CONFLICT` carrying its version, and the record is kept for another try.
   */
  private async legacyMove(id: string, path: string): Promise<void> {
    const destination = await this.safe.target(path);
    try {
      await this.exclusive.move(join(this.options.dataDir, "trash", id), destination.path);
    } catch (error) {
      if (error instanceof FileError && error.code === "CONFLICT") {
        const current = await this.io.describe(this.root(), path).catch(() => null);
        throw new FileError(
          "CONFLICT",
          "Restore destination must be absent",
          current?.version ?? null,
        );
      }
      throw new FileError(codeOf(error), "Trash entry could not be restored");
    }
  }
  private async legacyRemove(id: string): Promise<void> {
    await rm(join(this.options.dataDir, "trash", id), { recursive: true, force: true });
  }
}
