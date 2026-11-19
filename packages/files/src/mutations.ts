import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { SafeRoot } from "@ace/workspace";
import type { WorkspaceFileChange, FileOperation } from "@ace/protocol";
import { Catalog, MoveRecord, TrashRecord } from "./catalog.ts";
import type { ExclusiveRename } from "./exclusive-rename.ts";
import { newId } from "./filesystem.ts";
import type { Description, FilesIo, MoveOutcome } from "./io.ts";
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
  /** The entry's own version, which a name is trusted against after a move or a delete. */
  identity: string | null;
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
    return {
      own: description?.ownVersion ?? null,
      // A folder's digest records its path, so its own version is the identity a later read is
      // checked against; a file's version is its identity.
      identity: description ? (description.ownVersion ?? description.version) : null,
      bytes,
      folder: directory,
    };
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
        const leafStaging = (await this.folds(operation)) ? `.ace-upload-move-${id}` : undefined;
        // A case-only rename is two renames, so its staging name is journaled before the first
        // step: a crash between them leaves the entry under a name no listing shows, and the next
        // start finishes the move from this record.
        const receipt = leafStaging
          ? MoveRecord.parse({
              kind: "move",
              id,
              path: operation.path,
              destination: operation.destination,
              staging: beside(operation.path, leafStaging),
              identity: prepared.identity,
              bytes: 0,
              expires: Number.MAX_SAFE_INTEGER,
              pending: true,
            })
          : undefined;
        if (receipt) this.catalog.put(receipt);
        let moved: MoveOutcome;
        try {
          moved = await this.io.move(
            root,
            operation.path,
            operation.destination,
            operation.expected,
            prepared.own,
            leafStaging,
          );
        } catch (error) {
          if (receipt) this.failedMove(receipt, error);
          throw error;
        }
        if (receipt) this.catalog.delete(receipt.id);
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
          identity: prepared.identity,
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
        // A restore reports a version only when the port read one through the entry it moved.
        // Reading the path again after the queue would report whatever holds it by then as this
        // restore's version, so an unbound restore reports none.
        let version: string | null = null;
        if (record.location)
          version = (await this.io.untrash(root, record.location, operation.path)).version;
        else await this.legacyMove(record.id, operation.path);
        this.catalog.delete(record.id);
        return { id, op: operation.op, path: operation.path, committed: version };
      }
    }
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
   * Settles the receipts an interrupted change left behind, at start.
   *
   * A delete's receipt is settled only when the entry it names is located by identity at its
   * generated trash endpoint *and* what it holds is proven to be the version the delete was
   * guarded by. Retention starts only after that recorded verification; an entry that is located
   * but not proven is stranded, which means restorable and never expiring, so the bytes it names
   * are never swept before someone can look at them. A path that cannot be read, or a receipt
   * whose identity cannot be proven, keeps the receipt pending.
   *
   * A journaled case-only rename is finished: the entry is found at its old spelling, its new one
   * or the private staging name the journal recorded, and a start puts it where the client asked
   * for it, or under a visible recovery name when that name is taken.
   */
  async reconcile(): Promise<void> {
    for (const row of this.catalog.list("trash")) {
      const record = TrashRecord.parse(row);
      if (record.pending || record.stranded) await this.resolve(record);
    }
    for (const row of this.catalog.list("move")) {
      await this.finish(MoveRecord.parse(row));
    }
  }
  /**
   * Settles one unresolved delete receipt when its entry can be proven to be somewhere.
   *
   * The trash endpoint is probed first. An entry there with the identity the receipt recorded is
   * the one the delete moved, whatever now holds the old path; it starts retention only when its
   * version is also the one the delete was guarded by, and is kept stranded otherwise. A receipt
   * whose entry is still at its path, with that identity, names a move that never happened, so it
   * goes. Everything else is ambiguous and stays as it is.
   */
  private async resolve(receipt: TrashRecord): Promise<void> {
    switch (await this.parked(receipt)) {
      case "verified":
        this.settle(receipt);
        return;
      case "stranded":
        this.strand(receipt);
        return;
      case "absent":
        // The endpoint holds nothing, so the move never happened while the source still holds the
        // entry the receipt names. Clearing the receipt returns the quota it reserved; a receipt
        // written before identities were recorded is judged by the version the client held.
        if (await this.atPath(receipt.path, receipt.identity ?? receipt.version))
          this.catalog.delete(receipt.id);
        return;
      case "foreign":
      case "unreadable":
        return;
    }
  }
  /**
   * What to do with a delete whose move failed.
   *
   * A refusal the port reports before it moves anything leaves the entry at its path, so the
   * receipt goes and the caller sees the reason. Anything else may be a move that landed, and is
   * proved the same way a start proves it; when nothing can be proved the receipt stays pending,
   * and an entry that is located but not verified stays stranded, both of which keep a delete
   * whose rollback failed restorable and exempt from expiry.
   */
  private async abandon(receipt: TrashRecord, error: unknown): Promise<unknown> {
    if (refused(error)) {
      this.catalog.delete(receipt.id);
      return error;
    }
    await this.resolve(receipt);
    return error;
  }
  /** Whether the name holds the entry with `identity`, read the cheap way. */
  private async atPath(path: string, identity: string | null | undefined): Promise<boolean> {
    if (!identity) return false;
    try {
      const found = await this.io.shallow(this.root(), path);
      return found !== null && sameEntry(found.version, identity);
    } catch {
      return false;
    }
  }
  /**
   * What the receipt's generated endpoint holds.
   *
   * `absent` is a probed endpoint with nothing at it, which a start can tell apart from an
   * endpoint it could not read at all; `foreign` is an endpoint holding another entry. Only
   * `verified` proves the version the delete was guarded by, and only then does retention start.
   * A folder's digest records the path it is read at, so a folder at an endpoint is located but
   * never verified there; it stays stranded until it is restored.
   */
  private async parked(
    receipt: TrashRecord,
  ): Promise<"verified" | "stranded" | "absent" | "foreign" | "unreadable"> {
    if (!receipt.location) return "unreadable";
    let found;
    try {
      found = await this.io.internal.describe(this.root(), receipt.location);
    } catch {
      return "unreadable";
    }
    if (found === null) return "absent";
    // A receipt written before identities were recorded cannot prove which entry it moved.
    if (!receipt.identity) return "unreadable";
    if (!sameEntry(found.ownVersion ?? found.version, receipt.identity)) return "foreign";
    return !receipt.version.startsWith("tree:") && sameIdentity(found.version, receipt.version)
      ? "verified"
      : "stranded";
  }
  /**
   * Whether both spellings a rename names reach one entry, which only a case-insensitive volume
   * does. Those are the moves that take two steps, so only they need a journal.
   */
  private async folds(operation: Extract<Mutation, { op: "rename" | "move" }>): Promise<boolean> {
    const from = operation.path;
    const to = operation.destination;
    if (from === to) return false;
    if (folderOf(from) !== folderOf(to) || leafOf(from) === leafOf(to)) return false;
    if (leafOf(from).toLowerCase() !== leafOf(to).toLowerCase()) return false;
    const [source, target] = await Promise.all([
      this.io.shallow(this.root(), from).catch(() => null),
      this.io.shallow(this.root(), to).catch(() => null),
    ]);
    return source !== null && target !== null && sameIdentity(source.version, target.version);
  }
  /**
   * Forgets a journaled move's record when no start needs it.
   *
   * The record is the only thing that can find an entry parked under a private name, so it is
   * kept whenever the recovery path is one of those — the journal's own staging endpoint, or any
   * other hidden name in the entry's folder. It goes only when the entry is proven to be at a
   * visible path, or when the port refused before it moved anything and the entry never left its
   * own.
   */
  private failedMove(receipt: MoveRecord, error: unknown): void {
    const recovery = error instanceof FileError ? error.recovery : undefined;
    if (typeof recovery === "string") {
      if (recovery === receipt.staging || hidden(recovery)) return;
      this.catalog.delete(receipt.id);
      return;
    }
    if (refused(error)) this.catalog.delete(receipt.id);
  }
  /**
   * Finishes a journaled case-only move at start, or keeps the record for another try.
   *
   * The entry is at its old spelling, its new one, or the private staging name the journal
   * recorded. A move that had not started, or had already finished, is only a record to drop. A
   * parked entry is put where the client asked for it; if that name was taken in the meantime it
   * is put under a visible recovery name of its own instead, so nothing stays where no listing
   * shows it.
   */
  private async finish(record: MoveRecord): Promise<void> {
    if (
      (await this.atPath(record.path, record.identity)) ||
      (await this.atPath(record.destination, record.identity))
    ) {
      this.catalog.delete(record.id);
      return;
    }
    const parked = await this.parkedAt(record.staging, record.identity);
    if (parked === null) return;
    // The entry is the one the move parked, by its device and inode. A version that changed while
    // it waited is not what the client asked to move, so it is put where a person can see it
    // rather than presented as the move's result.
    const held = sameIdentity(parked.ownVersion ?? parked.version, record.identity);
    if (held && (await this.recover(record.staging, record.destination))) {
      this.catalog.delete(record.id);
      return;
    }
    const visible = recoveryName(record.destination, record.id);
    if (await this.recover(record.staging, visible)) this.catalog.delete(record.id);
  }
  /** The entry one of the daemon's own names holds, when it is the one with `identity`. */
  private async parkedAt(path: string, identity: string | null): Promise<Description | null> {
    if (!identity) return null;
    try {
      const found = await this.io.internal.describe(this.root(), path);
      if (found === null) return null;
      return sameEntry(found.ownVersion ?? found.version, identity) ? found : null;
    } catch {
      return null;
    }
  }
  /** Moves one of the daemon's own staging entries to a client path, never replacing one. */
  private async recover(from: string, to: string): Promise<boolean> {
    try {
      await this.io.internal.move(this.root(), from, to);
      return true;
    } catch {
      return false;
    }
  }
  /** Turns a receipt into an ordinary trash entry, which expiry may later clear. */
  private settle(receipt: TrashRecord): void {
    this.catalog.settleTrash({
      ...receipt,
      expires: this.options.now() + (this.options.retentionMs ?? 7 * 86400_000),
      pending: false,
      stranded: false,
    });
  }
  /**
   * Keeps a receipt whose entry is located but not verified, with no expiry at all.
   *
   * Nothing has proved what the entry holds, so it is never swept: it stays restorable until a
   * verification succeeds or someone restores it.
   */
  private strand(receipt: TrashRecord): void {
    this.catalog.settleTrash({
      ...receipt,
      expires: Number.MAX_SAFE_INTEGER,
      pending: false,
      stranded: true,
    });
  }
  /** Forget a trash entry: delete the bytes it kept, then its row. */
  async expire(record: TrashRecord): Promise<void> {
    // A stranded entry is never swept: nothing verified what it holds, so its bytes may be the
    // only copy of a version nobody has seen.
    if (record.stranded) return;
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
 * Whether two versions name the same entry whatever has been written to it.
 *
 * A version is `dev:ino:size:mtime:ctime`; the device and the inode survive a write in place, so
 * they locate an entry whose bytes have changed. A receipt uses this to find what its delete
 * moved, and the whole version to prove that what it found is the version the delete was guarded
 * by. A tree digest carries no identity to compare.
 */
function sameEntry(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right || left.startsWith("tree:") || right.startsWith("tree:")) return false;
  return left.split(":", 2).join(":") === right.split(":", 2).join(":");
}

/** The folder part of a path, with its trailing separator; empty at the root. */
function folderOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

/** The last segment of a path. */
function leafOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Whether a path names one of the daemon's private entries, wherever it lives. */
function hidden(path: string): boolean {
  return leafOf(path).startsWith(".ace-upload-");
}

/**
 * The full path of `name` in the folder that holds `path`.
 */
function beside(path: string, name: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? name : `${path.slice(0, cut + 1)}${name}`;
}

/**
 * The visible name an entry is recovered under beside `path`: `<stem>.conflict-<id><ext>`.
 *
 * The name is bounded to what a volume accepts, so a name already at the limit still gets a
 * recovery name instead of a failed rename that leaves the entry where no listing shows it.
 */
function recoveryName(path: string, id: string): string {
  const cut = path.lastIndexOf("/");
  const folder = cut < 0 ? "" : path.slice(0, cut + 1);
  const name = path.slice(cut + 1);
  const dot = name.lastIndexOf(".");
  const keepExtension = dot > 0 && name.length - dot <= 33;
  const stem = keepExtension ? name.slice(0, dot) : name;
  const tail = `.conflict-${id}${keepExtension ? name.slice(dot) : ""}`;
  const room = Math.max(1, 255 - Buffer.byteLength(tail));
  return `${folder}${cutBytes(stem, room)}${tail}`;
}

/** The longest prefix of `text` that fits in `limit` UTF-8 bytes, never splitting a character. */
function cutBytes(text: string, limit: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > limit) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end);
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
