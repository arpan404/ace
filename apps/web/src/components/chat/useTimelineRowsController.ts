import { measureRenderWork } from "~/lib/renderProfiling";
import {
  buildTimelineRows,
  type BuildTimelineRowsInput,
  type TimelineRow,
} from "~/lib/chat/timelineRows";

const EMPTY_TIMELINE_ROWS: ReadonlyArray<TimelineRow> = [];

export function resolveVisibleTimelineRows(input: {
  readonly activeThreadId: string | null;
  readonly loading?: boolean | undefined;
  readonly retainedRows: {
    readonly activeThreadId: string;
    readonly rows: ReadonlyArray<TimelineRow>;
  } | null;
  readonly preferRetainedRows?: boolean;
  readonly retainRowsWhileLoading?: boolean;
  readonly syncRows: ReadonlyArray<TimelineRow>;
}): { readonly loading: boolean; readonly rows: ReadonlyArray<TimelineRow> } {
  const retainedRows =
    input.retainRowsWhileLoading !== false &&
    input.retainedRows?.activeThreadId === input.activeThreadId &&
    input.retainedRows.rows.length > 0
      ? input.retainedRows.rows
      : null;
  const rows =
    input.preferRetainedRows === true && retainedRows
      ? retainedRows
      : input.syncRows.length > 0
        ? input.syncRows
        : (retainedRows ?? EMPTY_TIMELINE_ROWS);

  return {
    loading: Boolean(input.loading && rows.length === 0),
    rows,
  };
}

export function useTimelineRowsController(input: {
  readonly activeThreadId: string | null;
  readonly loading?: boolean | undefined;
  readonly preResolvedRows?: ReadonlyArray<TimelineRow> | null;
  readonly timelineRowsInput: BuildTimelineRowsInput;
}): {
  readonly loading: boolean;
  readonly rows: ReadonlyArray<TimelineRow>;
} {
  const preResolvedRows = input.preResolvedRows ?? null;
  const syncTimelineRows =
    preResolvedRows ??
    measureRenderWork("chat.buildTimelineRows", () => buildTimelineRows(input.timelineRowsInput));
  const { loading, rows } = resolveVisibleTimelineRows({
    activeThreadId: input.activeThreadId,
    loading: input.loading,
    retainedRows: null,
    retainRowsWhileLoading: true,
    syncRows: syncTimelineRows,
  });

  return { loading, rows };
}
