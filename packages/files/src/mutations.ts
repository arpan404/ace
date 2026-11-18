import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { SafeRoot } from "@ace/workspace";
import type { WorkspaceFileChange, FileOperation } from "@ace/protocol";
import { Catalog, TrashRecord } from "./catalog.ts";
import type { ExclusiveRename } from "./exclusive-rename.ts";
import { newId } from "./filesystem.ts";
import type { FilesIo } from "./io.ts";
import { codeOf, FileError, checkVersion, type FilesOptions } from "./types.ts";

type Mutation = Extract<
  FileOperation,
  { op: "write" | "create" | "mkdir" | "rename" | "move" | "delete" | "restore" }
>;

/** A mutation that landed, before its new version is read. */
export type Applied = Omit<WorkspaceFileChange, "version">;

/**
 * What preparation learned: the full version the client's expectation was checked against, and
 * the folder's own version a post-move verification needs.
 */
interface Prepared {
  /** A folder's own version before the move; a file has none. */
  own: string | null;
  /** The bytes a delete would reserve in the trash. */
  bytes: number;
}

/**
 * The write operations a client asks for, on the checkout's I/O port.
 *
 * Preparation reads the version the client worked from and fails with `CONFLICT` (and the current
 * version) when it differs. The guard is the whole tree for a destructive operation: a delete or
 * a move of a folder is admitted only against a full digest, never a shallow own version, and a
 * client that holds only the folder's identity is told to stat it again. The digest is read
 * outside the mutation queue, with the request's cancellation and no entry budget.
 *
 * The queued apply moves in one atomic no-replace rename and verifies the moved tree against the
 * digest it was admitted with; a tree that changed is moved straight back and reported as
 * `CONFLICT` with the digest on disk. The new version is read after the queue, never in it, so a
 * huge folder's digest does not hold up every other write; `null` means the path is absent.
 *
 * Recently-deleted entries are this class's own bookkeeping: a delete moves the entry to a
 * private name in the checkout through `trash`, and a restore moves it back through `untrash`
 * only while the destination is still absent.
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
    const destructive =
      operation.op === "delete" ||
      operation.op === "rename" ||
      operation.op === "move" ||
      operation.op === "restore";
    const description = await this.io.describe(this.root(), operation.path, {
      signal,
      ...(destructive ? { full: true } : {}),
    });
    const directory = description?.kind === "directory";
    if (destructive && description?.shallow)
      throw new FileError(
        "INVALID_ARGUMENT",
        "The folder was described without its tree digest; stat it again before changing it",
      );
    // A folder's identity is what a display stat falls back to for a huge tree; it is never a
    // guard. The client is told to stat again rather than being handed a conflict it cannot fix.
    if (directory && operation.expected !== null && !operation.expected.startsWith("tree:"))
      throw new FileError(
        "INVALID_ARGUMENT",
        "The expected version is a folder's identity, not its tree digest; stat it again",
      );
    checkVersion(description?.version ?? null, operation.expected);
    const bytes = directory
      ? operation.op === "delete"
        ? (await this.io.measure(this.root(), operation.path, { signal })).bytes
        : 0
      : description?.kind === "file"
        ? description.size
        : 0;
    return { own: description?.ownVersion ?? null, bytes };
  }
  async apply(operation: Mutation, prepared: Prepared): Promise<Applied> {
    const root = this.root();
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
          const target = await this.io.describe(root, operation.destination, { full: true });
          throw new FileError(
            "CONFLICT",
            "Move destination must be absent",
            target?.version ?? null,
          );
        }
        await this.io.move(
          root,
          operation.path,
          operation.destination,
          operation.expected,
          prepared.own,
        );
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
        // The row is written first so a landed move is never lost, and removed only on a
        // refusal; a mutation that committed with a sync warning stays catalogued.
        this.catalog.put(record);
        try {
          await this.io.trash(root, operation.path, location, operation.expected, prepared.own);
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
          const target = await this.io.describe(root, operation.path, { full: true });
          throw new FileError(
            "CONFLICT",
            "Restore destination must be absent",
            target?.version ?? null,
          );
        }
        if (record.location) await this.io.untrash(root, record.location, operation.path);
        else await this.legacyMove(record.id, operation.path);
        this.catalog.delete(record.id);
        break;
      }
    }
    return {
      id,
      op: operation.op,
      path: operation.path,
      ...(destination ? { destination } : {}),
      ...(trashId ? { trashId } : {}),
    };
  }
  /**
   * The change with the version the path has now, read after the mutation queue has released it.
   *
   * `current: null` means the path is absent, which is what a delete leaves and never a guess at
   * a folder too large to digest.
   */
  async change(applied: Applied): Promise<WorkspaceFileChange> {
    const path = applied.destination ?? applied.path;
    const after = await this.io.describe(this.root(), path, { full: true });
    return { ...applied, version: after?.version ?? null };
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
        const current = await this.io.describe(this.root(), path, { full: true });
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
