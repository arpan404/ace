import type { FileChange, GitStatusFile } from "@ace/protocol";
import {
  contentHash,
  diffFile,
  fileDiffKey,
  fileStatus,
  gitPatchFiles,
  LruCache,
  quickStat,
  type FileChanges,
  type FileDiff,
} from "@ace/ui-core";

/*
 * Where one file's diff comes from in the sheet's scope, and its version (a viewed mark holds
 * the version it was viewed at). The bridge runs in JavaScriptCore without a JIT, so a turn's
 * text diff is computed only for a file that is open (or commented on) and cached by its
 * content key; summary rows count without diffing where the changes allow.
 */

/** A file the scope lists. `counted` is false while its lines are unknown without a diff. */
export interface ScopeFile {
  path: string;
  from: string | null;
  status: GitStatusFile["status"];
  additions: number;
  deletions: number;
  binary: boolean;
  counted: boolean;
}

export type FileSource =
  /** Edits from the thread's turns, diffed here. */
  | { kind: "turn"; file: FileChanges }
  /** The file's whole section of the checkout's patch. */
  | { kind: "section"; text: string }
  /**
   * Cut from the checkout's patch: read alone from the daemon, page by page. `round` names the
   * checkout read it was listed in; the file's version is the daemon's validator for it.
   */
  | { kind: "daemon"; path: string; from: string | null; round: number }
  /** Git shows no text for it. */
  | { kind: "binary" };

export interface Sourced {
  source: FileSource;
  version: string;
}

/** One turn-scope diff kept per content; text diffs are the expensive part. */
const diffCache = { maxEntries: 24, maxWeight: 200_000 };

export class TurnDiffs {
  #keys = new Map<string, { changes: readonly FileChange[]; key: string }>();
  #diffs = new LruCache<string, FileDiff>({ ...diffCache, weigh: (diff) => diff.rows.length + 1 });
  #counts = new LruCache<string, { additions: number; deletions: number }>({ maxEntries: 2000 });

  /** The content key of a file's changes, recomputed only when one of its changes is new. */
  key(file: FileChanges): string {
    const held = this.#keys.get(file.path);
    if (
      held &&
      held.changes.length === file.changes.length &&
      held.changes.every((change, index) => change === file.changes[index])
    )
      return held.key;
    const key = fileDiffKey(file, contentHash);
    this.#keys.set(file.path, { changes: file.changes, key });
    if (this.#keys.size > 4000) this.#keys.delete(this.#keys.keys().next().value ?? "");
    return key;
  }

  diff(file: FileChanges): FileDiff {
    const key = this.key(file);
    const held = this.#diffs.get(key);
    if (held) return held;
    const diff = diffFile(file);
    this.#diffs.set(key, diff);
    this.#counts.set(key, { additions: diff.additions, deletions: diff.deletions });
    return diff;
  }

  /** A summary row: counted from a diff already made, or from changes that need none. */
  row(file: FileChanges): ScopeFile {
    const moved = file.changes.find((change) => change.kind === "move");
    const status = fileStatus(file.changes);
    const base = {
      path: file.path,
      from: moved ? moved.path : null,
      status: status === "moved" ? ("renamed" as const) : status,
      binary: false,
    };
    const known = this.#counts.get(this.key(file));
    if (known) return { ...base, ...known, counted: true };
    let additions = 0;
    let deletions = 0;
    for (const change of file.changes) {
      const stat = quickStat(change);
      if (!stat) return { ...base, additions: 0, deletions: 0, counted: false };
      additions += stat.added;
      deletions += stat.removed;
    }
    return { ...base, additions, deletions, counted: true };
  }
}

/** A working-tree section's rows (a cut section ends with the rows it has). */
export function sectionDiff(text: string): FileDiff | undefined {
  return gitPatchFiles(text)[0];
}

/**
 * The version of a working-tree file's diff whose whole section the checkout's patch holds: the
 * section's hash. A file cut from that patch is versioned by the daemon's validator instead.
 */
export function workingVersion(section: string): string {
  return contentHash(section);
}
