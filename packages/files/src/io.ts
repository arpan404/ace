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
  /** The kind of what the path resolves to: a link to a file is a file. */
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
 */
export interface FilesIo {
  /** The path's version, size, kind and mode, or null when nothing is there. */
  describe(root: string, path: string, options?: IoOptions): Promise<Description | null>;
  /** The kind and size of a path, which a read asks before it opens bytes. */
  metadata(root: string, path: string): Promise<{ kind: EntryKind; size: number } | null>;
  /** One range of a file; a file that changes while being read is `CONFLICT`. */
  read(
    root: string,
    path: string,
    range: { offset: number; length: number; maxSize?: number | undefined },
    options?: IoOptions,
  ): Promise<ReadBytes>;
  /** Stage `bytes` beside the path and publish them; `expected` null means create only. */
  write(root: string, path: string, bytes: Buffer, expected: string | null): Promise<string>;
  createDir(root: string, path: string): Promise<void>;
  /** Move an entry, never replacing an existing destination. */
  move(root: string, from: string, to: string): Promise<void>;
  /** Delete a file or a folder and everything inside it. */
  remove(root: string, path: string): Promise<void>;
  /**
   * Walk a file or a folder, preorder, with `.git` and the daemon's own transfer temporaries left
   * out. A link is followed only while it stays inside the root; one that escapes is skipped.
   */
  walk(root: string, path: string, options?: IoOptions): AsyncGenerator<WalkEntry>;
  /** The bytes of the files below a path, which is what a delete reserves in the trash. */
  measure(root: string, path: string, options?: IoOptions): Promise<number>;
}

export interface IoOptions {
  signal?: AbortSignal | undefined;
}

/** The workspace's port and the map of roots it is allowed to act on. */
export type IoFor = (root: string) => FilesIo;

/** The local port: Node's I/O through a confined `SafeRoot`, one per root. */
export type SafeRootSource = (root: string) => Promise<SafeRoot>;
