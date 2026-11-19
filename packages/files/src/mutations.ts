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
export type Applied = Omit<WorkspaceFileChange, "version"> & {
  /**
   * The version the port read from the object it committed, when it read one there.
   *
   * A save's version comes from a handle to the file the save published, a new folder's from the
   * folder that create made, and a move's from the entry that moved, so none is an inference
   * from a later state. Absent when the version can only be read after the queue has released the
   * path; `null` when the commit is known and its version is not.
   */
  committed?: string | null;
  /**
   * A moved folder's own version after the move. The digest read after the queue is accepted only
   * while the folder it describes still has this identity, so a name another program took in the
   * meantime never lends its digest to this change.
   */
  identity?: string | null;
};

/**
 * What preparation learned: the full version the client's expectation was checked against, and
 * the folder's own version a post-move verification needs.
 */
interface Prepared {
  /** A folder's own version before the move; a file has none. */
  own: string | null;
  /** The bytes a delete would reserve in the trash. */
  bytes: number;
  /** True when the entry is a folder, whose digest can only be read after a move. */
  folder: boolean;
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
    return { own: description?.ownVersion ?? null, bytes, folder: directory };
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
        const saved = await this.io.write(root, operation.path, bytes, operation.expected);
        return {
          id,
          op: operation.op,
          path: operation.path,
          committed: saved,
        };
      }
      case "mkdir": {
        let version: string | null;
        try {
          version = await this.io.createDir(root, operation.path);
        } catch (error) {
          // A taken name is a plain conflict for `mkdir`: the client already knows it exists.
          if (error instanceof FileError && error.code === "CONFLICT")
            throw new FileError("CONFLICT", error.message);
          throw error;
        }
        // The port read the digest from the folder it made, inside the queue, so the reply is not
        // an inference from a name that may hold something else by now.
        return {
          id,
          op: operation.op,
          path: operation.path,
          committed: version,
        };
      }
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
        const moved = await this.io.move(
          root,
          operation.path,
          operation.destination,
          operation.expected,
          prepared.own,
        );
        destination = operation.destination;
        // A file's version comes from the entry that moved. A folder's digest records the new
        // path, so it is read after the queue and accepted only against the folder's own version.
        const identity =
          prepared.folder && sameIdentity(moved.identity, prepared.own) ? moved.identity : null;
        return {
          id,
          op: operation.op,
          path: operation.path,
          destination,
          ...(prepared.folder ? { identity } : { committed: moved.version }),
        };
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
        // The receipt is written before the move and never expires until it is settled: an answer
        // that never comes back may still have landed, and a row written afterwards would lose
        // the entry it names. A failure that is not provably a refusal leaves it pending for the
        // next start to reconcile.
        const receipt = TrashRecord.parse({
          kind: "trash",
          id,
          path: operation.path,
          bytes,
          version: operation.expected,
          location,
          expires: Number.MAX_SAFE_INTEGER,
          pending: true,
        });
        this.catalog.put(receipt);
        try {
          await this.io.trash(root, operation.path, location, operation.expected, prepared.own);
        } catch (error) {
          throw await this.abandon(receipt, error);
        }
        this.catalog.settleTrash({
          ...receipt,
          expires: this.options.now() + (this.options.retentionMs ?? 7 * 86400_000),
          pending: false,
        });
        trashId = id;
        return { id, op: operation.op, path: operation.path, committed: null, trashId };
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
   * a folder too large to digest. A change whose version the port already read — a save's, or a
   * new folder's — is reported as it is. A read that fails here cannot turn a committed change
   * into an error: the change is reported without a version and the watcher or the next stat
   * corrects it, because the bytes are already where the caller asked for them.
   */
  async change(applied: Applied): Promise<WorkspaceFileChange> {
    const { committed, identity, ...change } = applied;
    if (committed !== undefined) return { ...change, version: committed };
    const path = change.destination ?? change.path;
    const after = await this.io.describe(this.root(), path, { full: true }).catch(() => undefined);
    // A moved folder's digest belongs to this change only while the name still holds the folder
    // whose own version the move reported; a different entry's digest is never reported as its.
    if (identity !== undefined && !sameIdentity(after?.ownVersion, identity))
      return { ...change, version: null };
    return { ...change, version: after?.version ?? null };
  }
  /**
   * Settles the receipts an interrupted delete left behind, at start.
   *
   * An entry still at its path was never moved, so its receipt is a lie and goes. An entry gone
   * from its path may be in the trash: the receipt becomes an ordinary, restorable trash entry.
   * A path that cannot be read at all keeps its receipt pending, and a pending receipt never
   * expires, so the bytes it names are never swept before someone can restore them.
   */
  async reconcile(): Promise<void> {
    for (const row of this.catalog.list("trash")) {
      const record = TrashRecord.parse(row);
      if (!record.pending) continue;
      const present = await this.presence(record.path);
      if (present === "gone") this.settle(record);
      else if (present === "there") this.catalog.delete(record.id);
    }
  }
  /**
   * What to do with a delete whose move failed.
   *
   * A refusal the port reports before it moves anything leaves the entry at its path, so the
   * receipt goes and the caller sees the reason. Anything else may be a move that landed: an
   * entry gone from its path becomes a restorable trash entry, and a path that cannot be read
   * keeps the receipt pending until the next start reconciles it.
   */
  private async abandon(receipt: TrashRecord, error: unknown): Promise<unknown> {
    if (refused(error)) {
      this.catalog.delete(receipt.id);
      return error;
    }
    const present = await this.presence(receipt.path);
    if (present === "there") this.catalog.delete(receipt.id);
    else if (present === "gone") this.settle(receipt);
    return error;
  }
  /** Whether the entry a receipt names is at its path, gone from it, or unreadable right now. */
  private async presence(path: string): Promise<"there" | "gone" | "unknown"> {
    try {
      return (await this.io.shallow(this.root(), path)) === null ? "gone" : "there";
    } catch {
      return "unknown";
    }
  }
  /** Turns a receipt into an ordinary trash entry, which expiry may later clear. */
  private settle(receipt: TrashRecord): void {
    this.catalog.settleTrash({
      ...receipt,
      expires: this.options.now() + (this.options.retentionMs ?? 7 * 86400_000),
      pending: false,
    });
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

/**
 * Whether two versions name the same entry: a rename changes the change time and nothing else a
 * version records, so the last field is left out. A tree digest carries no identity to compare.
 */
function sameIdentity(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right || left.startsWith("tree:") || right.startsWith("tree:")) return false;
  return left.slice(0, left.lastIndexOf(":")) === right.slice(0, right.lastIndexOf(":"));
}

/**
 * Whether a port refused a delete before moving anything.
 *
 * A guard that did not hold, a path the policy refuses, a name that is taken or a filesystem that
 * cannot move atomically all leave the entry where it was: the port says so before it acts, so
 * the receipt is wrong and goes. Everything else — a lost connection, a restart, a failed sync —
 * may be an answer about a move that already happened.
 */
function refused(error: unknown): boolean {
  const code = codeOf(error);
  return [
    "ABORTED",
    "BUSY",
    "CONFLICT",
    "FORBIDDEN",
    "INVALID_ARGUMENT",
    "INVALID_PATH",
    "NOT_FILE",
    "NOT_FOUND",
    "PATH_CHANGED",
    "PATH_ESCAPE",
    "QUOTA",
    "UNSUPPORTED",
  ].includes(code);
}
