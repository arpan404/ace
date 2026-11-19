import type { SafeRoot } from "@ace/workspace";

/** What an entry is on disk, before any final link is followed. */
export type EntryKind = "file" | "directory" | "symlink" | "other";

/**
 * One path's details, in the terms the daemon's guarded writes and its `stat` reply use.
 *
 * `version` is the daemon's version string: a file's identity and times, or a digest of a
 * folder's whole tree, so a client holding an older one can be told what changed. `size` is the
 * entry's own size, except that a link reports what its target holds, as `safe.metadata` does.
 */
export interface Description {
  version: string;
  /** A folder's own version, before its digest; absent for a file. */
  ownVersion?: string | undefined;
  /** True when a walk budget stopped a folder digest, so `version` is its own version. */
  shallow: boolean;
  size: number;
  kind: EntryKind;
  mode: number;
}

/** The bytes of a range, with the version they were read at. */
export interface ReadBytes {
  size: number;
  version: string;
  bytes: Buffer;
}

/** One entry a recursive walk found. */
export interface WalkEntry {
  /** Relative to the root, `/` separated. */
  path: string;
  /** What the entry is: a link is `symlink`, never what it points at. */
  type: EntryKind;
  size: number;
  /** Milliseconds since the Unix epoch. */
  mtime: number;
  /** True when the checkout's gitignore rules match the path. */
  ignored: boolean;
}

/**
 * The filesystem work `FilesService` needs, in one place so the daemon can answer it from
 * `ace-files` (ADR 0178) while tests and the daemon's own private registries use Node's I/O.
 *
 * Every call names the root it acts in. A port must refuse a path that leaves its root with
 * `PATH_ESCAPE`, and must never act on a path string it resolved itself: the Rust port walks
 * through handles, and the local one through `@ace/workspace`'s confined `SafeRoot`.
 *
 * A client path carries the daemon's mutation policy: no `.git` or `.ace-upload-*` component, in
 * any spelling the volume would answer, and no link on the way or as the leaf. The policy is
 * applied by the mutation itself, in the Rust port's walk, so a caller cannot skip it and the
 * check does not race the change. The `internal` entries are the daemon's own bookkeeping and
 * skip those rules.
 */
export interface FilesIo {
  /**
   * The path's version, size, kind and mode, or null when nothing is there. `full` walks a folder
   * with no entry budget, which a destructive guard needs; a display stat keeps the budget and
   * reports `shallow`.
   */
  describe(root: string, path: string, options?: DescribeOptions): Promise<Description | null>;
  /**
   * The entry itself: its own version, never a folder's tree digest. This is the cheap guard a
   * queued mutation re-checks, so a folder does not have to be walked again to know it moved.
   */
  shallow(root: string, path: string, options?: IoOptions): Promise<Description | null>;
  /** The kind and size of a path, which a read asks before it opens bytes. */
  metadata(root: string, path: string): Promise<{ kind: EntryKind; size: number } | null>;
  /**
   * A folder's paths breadth-first, folders ending in `/`, at most `limit`; git-ignored entries
   * and the daemon's own temporaries are left out. This is the legacy `list` reply's walk.
   */
  paths(
    root: string,
    dir: string,
    limit: number,
    options?: IoOptions,
  ): Promise<{ paths: string[]; truncated: boolean }>;
  /** One range of a file; a file that changes while being read is `CONFLICT`. */
  read(
    root: string,
    path: string,
    range: { offset: number; length: number; maxSize?: number | undefined },
    options?: IoOptions,
  ): Promise<ReadBytes>;
  /** Stage `bytes` beside the path and publish them; `expected` null means create only. */
  write(root: string, path: string, bytes: Buffer, expected: string | null): Promise<string>;
  /**
   * Create a folder and return its digest, read from the folder this call made. `null` means the
   * folder was created but its identity could not be proven, so no version is reported for it.
   */
  createDir(root: string, path: string): Promise<string | null>;
  /**
   * Move a client's entry, never replacing an existing destination.
   *
   * `expected` is the version the caller worked from and `own` a folder's own version before the
   * move: the moved tree is verified against them and put back when it changed, so the guard and
   * the move are one step. The outcome carries the moved entry's version when the port read one
   * from that entry, a moved folder's own version as the identity a later digest must match, and
   * the visible path an entry was preserved under when the move could not complete.
   */
  move(
    root: string,
    from: string,
    to: string,
    expected: string | null,
    own: string | null,
  ): Promise<MoveOutcome>;
  /**
   * Park a client's entry at the daemon's generated trash endpoint, guarded by the version it
   * had. Only an endpoint of the daemon's own shape is accepted, and the client's path is still
   * held to the whole policy.
   */
  trash(
    root: string,
    path: string,
    endpoint: string,
    expected: string,
    own: string | null,
  ): Promise<void>;
  /** Move a generated trash endpoint back to a client path, which must be absent. */
  untrash(root: string, endpoint: string, path: string): Promise<void>;
  /** Delete a file or a folder and everything inside it. The daemon's own cleanup only. */
  remove(root: string, path: string): Promise<void>;
  /**
   * Walk a file or a folder with `.git` and the daemon's own transfer temporaries left out. A link
   * is reported as itself and never followed, so a walk never reaches outside the root.
   */
  walk(root: string, path: string, options?: IoOptions): AsyncGenerator<WalkEntry>;
  /**
   * The bytes of the files below a path, which is what a delete reserves in the trash. `shallow`
   * means a walk budget stopped the count, so `bytes` is a lower bound.
   */
  measure(
    root: string,
    path: string,
    options?: IoOptions,
  ): Promise<{ bytes: number; shallow: boolean }>;
  /**
   * The daemon's own bookkeeping names, reached only by code it owns: a delete moves an entry to
   * `.ace-upload-trash-<id>` and a restore or sweep moves or removes it again. A client request
   * never reaches these, which is why they skip the reserved-name and link rules that protect it.
   */
  internal: {
    /** The entry itself at one of the daemon's own names, or null when it is not there. */
    describe(root: string, path: string): Promise<Description | null>;
    /** Move one of the daemon's own staging entries to a client path, never replacing one. */
    move(root: string, from: string, to: string): Promise<void>;
    remove(root: string, path: string): Promise<void>;
  };
}

/** What a move reported besides the change itself. */
export interface MoveOutcome {
  /** The moved entry's version, read from that entry; null when no identity proved it. */
  version: string | null;
  /** A moved folder's own version, which a digest read later must still match. */
  identity: string | null;
  /** The visible name an entry was preserved under when its move could not complete. */
  recovery: string | null;
}

export interface IoOptions {
  signal?: AbortSignal | undefined;
}

export interface DescribeOptions extends IoOptions {
  /** Walk the whole tree with no entry budget, for a guard a mutation compares. */
  full?: boolean | undefined;
}

/** The local port's roots: one confined `SafeRoot` per folder it is asked about. */
export type SafeRootSource = (root: string) => Promise<SafeRoot>;
