import { useCallback, useMemo, useRef, useState } from "react";
import type { ForgeReviewAction } from "@ace/protocol";
import type { ReviewWriteResult } from "./pr-review-writes.ts";

/** A Viewed mark changed here and not yet confirmed by a read of GitHub's state. */
export interface ViewedChange {
  checked: boolean;
  seq: number;
}

/**
 * Viewed marks as the person set them, shown at once while each write waits its turn: a mark
 * shows its new state until the write is done and GitHub's state is read again, and goes back
 * with a reason (`failed`) when GitHub refused it.
 */
export function useViewedChanges(write: (action: ForgeReviewAction) => Promise<ReviewWriteResult>) {
  const [changes, setChanges] = useState<ReadonlyMap<string, ViewedChange>>(new Map());
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(new Map());
  const seq = useRef(0);
  const set = useCallback(
    (path: string, checked: boolean, headSha: string) => {
      const mine = ++seq.current;
      setChanges((previous) => new Map(previous).set(path, { checked, seq: mine }));
      setFailed((previous) => {
        if (!previous.has(path)) return previous;
        const next = new Map(previous);
        next.delete(path);
        return next;
      });
      void write({ kind: checked ? "file.view" : "file.unview", path, headSha }).then((result) => {
        // A later change of the same mark owns it now.
        setChanges((previous) => {
          if (previous.get(path)?.seq !== mine) return previous;
          const next = new Map(previous);
          next.delete(path);
          return next;
        });
        if (!result.ok) setFailed((previous) => new Map(previous).set(path, result.message));
      });
    },
    [write],
  );
  return useMemo(() => ({ changes, failed, set }), [changes, failed, set]);
}
