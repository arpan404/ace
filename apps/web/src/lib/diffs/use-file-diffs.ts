import type { FileChange } from "@ace/protocol";
import {
  countChanges,
  groupFileChanges,
  quickStat,
  type DiffStat,
  type FileChanges,
  type FileDiff,
  type Turn,
} from "@ace/ui-core";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { diffKey, diffService } from "./diff-service.ts";

export interface FileDiffs {
  /** Diffs that are ready, in first-touched order. */
  files: FileDiff[];
  /** Files still being diffed in the worker. */
  pending: number;
}

interface Keyed {
  file: FileChanges;
  key: string;
}

/** Each file's diff once the worker has it (undefined until then), in the order given. */
function useReadyDiffs(groups: readonly Keyed[]): (FileDiff | undefined)[] {
  const ready = useSyncExternalStore(diffService.subscribe, diffService.ready, diffService.ready);
  const diffs = useMemo(() => groups.map(({ file, key }) => ready.get(key, file)), [groups, ready]);
  useEffect(() => {
    groups.forEach(({ file, key }, index) => {
      if (!diffs[index]) void diffService.load(key, file).catch(() => {});
    });
  }, [groups, diffs]);
  return diffs;
}

const keyed = (files: readonly FileChanges[]): Keyed[] =>
  files.map((file) => ({ file, key: diffKey(file) }));

/** Diffs of the files `edits` touched, computed in the diff worker and cached by content. */
export function useFileDiffs(edits: Turn["edits"]): FileDiffs {
  const groups = useMemo(() => keyed(groupFileChanges(edits)), [edits]);
  const diffs = useReadyDiffs(groups);
  return useMemo(() => {
    const files = diffs.filter((diff): diff is FileDiff => diff !== undefined);
    return { files, pending: diffs.length - files.length };
  }, [diffs]);
}

/** Lines added and removed across `edits`, from their (cached) diffs. */
export function useDiffStat(edits: Turn["edits"]): { additions: number; deletions: number } {
  const { files } = useFileDiffs(edits);
  return useMemo(() => countChanges(files.flatMap((file) => file.rows)), [files]);
}

const statOf = (diff: FileDiff): DiffStat => ({ added: diff.additions, removed: diff.deletions });

/**
 * Per-file stats for the files `edits` touched, as the Changes tab counts them. A file whose
 * stat needs a text diff shows its quick count, if it has one, until the worker's diff lands.
 */
export function useFileStats(edits: Turn["edits"]): { path: string; stat: DiffStat | undefined }[] {
  const groups = useMemo(() => keyed(groupFileChanges(edits)), [edits]);
  const diffs = useReadyDiffs(groups);
  return useMemo(
    () =>
      groups.map(({ file }, index) => {
        const diff = diffs[index];
        return { path: file.path, stat: diff ? statOf(diff) : sumQuick(file.changes) };
      }),
    [groups, diffs],
  );
}

function sumQuick(changes: readonly FileChange[]): DiffStat | undefined {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    const stat = quickStat(change);
    if (!stat) return undefined;
    added += stat.added;
    removed += stat.removed;
  }
  return { added, removed };
}

const none: readonly FileChange[] = [];

/** Lines added and removed by one tool call's changes, each diffed in the worker. */
export function useChangesStat(changes: readonly FileChange[] = none): DiffStat | undefined {
  const groups = useMemo(
    () =>
      keyed(changes.map((change) => ({ path: change.movePath ?? change.path, changes: [change] }))),
    [changes],
  );
  const diffs = useReadyDiffs(groups);
  return useMemo(() => {
    if (!diffs.length || diffs.some((diff) => !diff)) return undefined;
    let added = 0;
    let removed = 0;
    for (const diff of diffs) {
      if (!diff) continue;
      added += diff.additions;
      removed += diff.deletions;
    }
    return { added, removed };
  }, [diffs]);
}
