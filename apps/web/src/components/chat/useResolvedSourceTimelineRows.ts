import type { ThreadId } from "@ace/contracts";
import { startTransition, useEffect, useRef, useState } from "react";

import {
  buildSourceTimelineRows,
  type SourceTimelineRowsInput,
} from "~/lib/chat/sourceTimelineRows";
import {
  readCachedSourceTimelineRows,
  resolveSourceTimelineRows,
} from "~/lib/chat/sourceTimelineRowsClient";
import { createSourceTimelineRowsLiveResolver } from "~/lib/chat/sourceTimelineRowsLiveResolver";
import { shouldBuildSourceTimelineRowsOnMainThread } from "~/lib/chat/sourceTimelineRowsScheduling";
import type { TimelineRow } from "~/lib/chat/timelineRows";
import { measureRenderWork } from "~/lib/renderProfiling";

export interface UseResolvedSourceTimelineRowsInput {
  readonly cacheKey: string | null;
  readonly hasCompleteSnapshot: boolean;
  readonly rowsInput: SourceTimelineRowsInput | null;
  readonly threadId: ThreadId | null;
  readonly rebuildDelayMs: number;
}

export function useResolvedSourceTimelineRows({
  cacheKey,
  hasCompleteSnapshot,
  rowsInput,
  threadId,
  rebuildDelayMs,
}: UseResolvedSourceTimelineRowsInput): {
  readonly loading: boolean;
  readonly rows: ReadonlyArray<TimelineRow> | null;
} {
  const [resolvedRows, setResolvedRows] = useState<{
    readonly key: string;
    readonly rows: ReadonlyArray<TimelineRow>;
    readonly threadId: ThreadId | null;
  } | null>(null);
  const resolverRef = useRef<ReturnType<typeof createSourceTimelineRowsLiveResolver> | null>(null);

  if (resolverRef.current === null) {
    resolverRef.current = createSourceTimelineRowsLiveResolver({
      delayMs: rebuildDelayMs,
      publishRows: ({ key, rows, threadId: resolvedThreadId }) => {
        startTransition(() => {
          setResolvedRows({ key, rows, threadId: resolvedThreadId });
        });
      },
      reportError: (error) => {
        console.error("Failed to build active source timeline rows", error);
      },
      resolveRows: ({ key, rowsInput: latestRowsInput }) =>
        resolveSourceTimelineRows({
          cacheKey: key,
          rowsInput: latestRowsInput,
        }),
    });
  }

  useEffect(
    () => () => {
      resolverRef.current?.dispose();
      resolverRef.current = null;
    },
    [],
  );

  const cachedRows = readCachedSourceTimelineRows(cacheKey);
  const shouldBuildSynchronously =
    rowsInput !== null &&
    cacheKey !== null &&
    shouldBuildSourceTimelineRowsOnMainThread({
      hasCompleteSnapshot,
      rowCount: rowsInput.rows.length,
    });
  const synchronousRows: ReadonlyArray<TimelineRow> | null = (() => {
    if (!shouldBuildSynchronously || !rowsInput) {
      return null;
    }
    return measureRenderWork("chat.buildSourceTimelineRows", () =>
      buildSourceTimelineRows(rowsInput),
    );
  })();
  const hasCachedRows = cachedRows !== null;

  useEffect(() => {
    if (!rowsInput || !cacheKey) {
      resolverRef.current?.clear();
      return;
    }
    if (shouldBuildSynchronously || hasCachedRows) {
      resolverRef.current?.clear();
      return;
    }
    if (rowsInput.activeTurnInProgress) {
      resolverRef.current?.setLatest({
        key: cacheKey,
        rowsInput,
        threadId,
      });
      return;
    }

    let canceled = false;
    resolverRef.current?.clear();
    resolveSourceTimelineRows({
      cacheKey,
      rowsInput,
    })
      .then((rows) => {
        if (canceled) {
          return;
        }
        startTransition(() => {
          setResolvedRows({ key: cacheKey, rows, threadId });
        });
      })
      .catch((error) => {
        if (!canceled) {
          console.error("Failed to build source timeline rows", error);
        }
      });

    return () => {
      canceled = true;
    };
  }, [cacheKey, hasCachedRows, rowsInput, shouldBuildSynchronously, threadId]);

  const loading =
    !shouldBuildSynchronously &&
    rowsInput !== null &&
    cacheKey !== null &&
    cachedRows === null &&
    resolvedRows?.key !== cacheKey;
  const staleRows = loading && resolvedRows?.threadId === threadId ? resolvedRows.rows : null;

  return {
    loading,
    rows:
      synchronousRows ??
      cachedRows ??
      (resolvedRows?.key === cacheKey ? resolvedRows.rows : null) ??
      staleRows,
  };
}
