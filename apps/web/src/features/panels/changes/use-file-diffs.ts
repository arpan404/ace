import { countChanges, groupFileChanges, type FileDiff, type Turn } from "@ace/ui-core";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { diffKey, diffService } from "./diff-service.ts";

export interface FileDiffs {
  /** Diffs that are ready, in first-touched order. */
  files: FileDiff[];
  /** Files still being diffed in the worker. */
  pending: number;
}

/** Diffs of the files `edits` touched, computed in the diff worker and cached by content. */
export function useFileDiffs(edits: Turn["edits"]): FileDiffs {
  const groups = useMemo(
    () => groupFileChanges(edits).map((file) => ({ file, key: diffKey(file) })),
    [edits],
  );
  const ready = useSyncExternalStore(diffService.subscribe, diffService.ready, diffService.ready);
  const result = useMemo(() => {
    const files: FileDiff[] = [];
    let pending = 0;
    for (const { file, key } of groups) {
      const diff = ready.get(key, file);
      if (diff) files.push(diff);
      else pending++;
    }
    return { files, pending };
  }, [groups, ready]);
  useEffect(() => {
    for (const { file, key } of groups)
      if (!ready.get(key, file)) void diffService.load(key, file).catch(() => {});
  }, [groups, ready]);
  return result;
}

/** Lines added and removed across `edits`, from their (cached) diffs. */
export function useDiffStat(edits: Turn["edits"]): { additions: number; deletions: number } {
  const { files } = useFileDiffs(edits);
  return useMemo(() => countChanges(files.flatMap((file) => file.rows)), [files]);
}
