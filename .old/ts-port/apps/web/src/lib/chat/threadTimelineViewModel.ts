import { useMemo } from "react";
import { MessageId, type ThreadId } from "@ace/contracts";

import { deriveTimelineEntries } from "../../session-logic";
import type { WorkLogEntry } from "../../session-logic/types";
import type { ChatMessage, TurnDiffSummary } from "../../types";
import { buildSourceTimelineRows, type SourceTimelineRowsInput } from "./sourceTimelineRows";
import {
  readTimelineRowsProjection,
  type TimelineRowsProjection,
  useTimelineModelStore,
} from "./timelineModelStore";
import { buildTimelineRows, type TimelineRow } from "./timelineRows";

const EMPTY_ROW_IDS: readonly string[] = [];
const EMPTY_TIMELINE_ROWS: readonly TimelineRow[] = [];
const EMPTY_TIMELINE_INDEX_BY_ENTRY_ID: ReadonlyMap<string, number> = new Map();
const EMPTY_TURN_DIFF_SUMMARY_BY_ASSISTANT_MESSAGE_ID: ReadonlyMap<MessageId, TurnDiffSummary> =
  new Map();

export type ThreadTimelineViewModelSurface = "chat" | "board" | "detached" | "subagent";
export type ThreadTimelineViewModelSource = "live" | "snapshot" | "recovery";

export interface ThreadTimelineRowsBuildOptions {
  readonly activeTurnId?: string | null;
  readonly activeTurnInProgress?: boolean;
  readonly activeTurnStartedAt?: string | null;
  readonly completionDividerBeforeEntryId?: string | null;
  readonly completionEndedAt?: string | null;
  readonly completionStartedAt?: string | null;
  readonly completionSummary?: string | null;
  readonly completionTurnId?: string | null;
  readonly hideCompletedWorkMessages?: boolean;
  readonly turnDiffSummaryByAssistantMessageId?: ReadonlyMap<MessageId, TurnDiffSummary>;
}

export interface UseThreadTimelineViewModelInput {
  readonly threadId: ThreadId | null | undefined;
  readonly enabled: boolean;
  readonly surface: ThreadTimelineViewModelSurface;
  readonly buildRows?: boolean;
  readonly rowsBuildOptions?: ThreadTimelineRowsBuildOptions;
}

export interface ThreadTimelineViewModel {
  readonly rows: readonly TimelineRow[];
  readonly rowIds: readonly string[];
  readonly revision: number;
  readonly timelineIndexByEntryId: ReadonlyMap<string, number>;
  readonly loading: boolean;
  readonly hydrating: boolean;
  readonly source: ThreadTimelineViewModelSource;
  readonly projection: TimelineRowsProjection | null;
  readonly completeSnapshot: {
    readonly cacheVersion?: string;
    readonly revision: string;
    readonly totalRows: number;
    readonly loadedAt: number;
  } | null;
}

export interface SubagentTimelineThreadInput {
  readonly id: string;
  readonly status: "running" | "completed" | "failed";
  readonly entries: ReadonlyArray<WorkLogEntry>;
}

export interface UseSubagentTimelineViewModelInput {
  readonly thread: SubagentTimelineThreadInput | null | undefined;
  readonly enabled: boolean;
  readonly surface: "subagent";
}

export interface SubagentTimelineViewModel {
  readonly rows: readonly TimelineRow[];
  readonly rowIds: readonly string[];
  readonly revision: number;
  readonly timelineIndexByEntryId: ReadonlyMap<string, number>;
  readonly loading: false;
  readonly hydrating: false;
  readonly source: "live";
  readonly hasEntries: boolean;
  readonly activeTurnInProgress: boolean;
  readonly activeTurnStartedAt: string | null;
}

export function useThreadTimelineViewModel(
  input: UseThreadTimelineViewModelInput,
): ThreadTimelineViewModel {
  const threadId = input.enabled ? (input.threadId ?? null) : null;
  const rowIds = useTimelineModelStore((store) =>
    threadId ? (store.rowIdsByThreadId[threadId] ?? EMPTY_ROW_IDS) : EMPTY_ROW_IDS,
  );
  const revision = useTimelineModelStore((store) =>
    threadId ? (store.revisionByThreadId[threadId] ?? 0) : 0,
  );
  const completeSnapshot = useTimelineModelStore((store) =>
    threadId ? (store.completeSnapshotByThreadId[threadId] ?? null) : null,
  );
  const fetchState = useTimelineModelStore((store) =>
    threadId ? (store.fetchStateByThreadId[threadId] ?? null) : null,
  );

  const projection = useMemo(() => {
    void revision;
    if (!threadId || (completeSnapshot === null && rowIds.length === 0)) {
      return null;
    }
    return readTimelineRowsProjection(threadId);
  }, [completeSnapshot, revision, rowIds.length, threadId]);

  const rows = useMemo(() => {
    if (input.buildRows === false) {
      return EMPTY_TIMELINE_ROWS;
    }
    if (!projection) {
      return EMPTY_TIMELINE_ROWS;
    }
    const rowsBuildOptions = input.rowsBuildOptions;
    const sourceInput: SourceTimelineRowsInput = {
      rows: projection.rows,
      messages: projection.messages,
      activities: projection.activities,
      proposedPlans: projection.proposedPlans,
      activeTurnId: rowsBuildOptions?.activeTurnId ?? null,
      activeTurnInProgress: rowsBuildOptions?.activeTurnInProgress ?? false,
      activeTurnStartedAt: rowsBuildOptions?.activeTurnStartedAt ?? null,
      completionDividerBeforeEntryId: rowsBuildOptions?.completionDividerBeforeEntryId ?? null,
      completionEndedAt: rowsBuildOptions?.completionEndedAt ?? null,
      completionSummary: rowsBuildOptions?.completionSummary ?? null,
      completionTurnId: rowsBuildOptions?.completionTurnId ?? null,
      completionStartedAt: rowsBuildOptions?.completionStartedAt ?? null,
      ...(rowsBuildOptions?.hideCompletedWorkMessages !== undefined
        ? { hideCompletedWorkMessages: rowsBuildOptions.hideCompletedWorkMessages }
        : {}),
      turnDiffSummaryByAssistantMessageId:
        rowsBuildOptions?.turnDiffSummaryByAssistantMessageId ??
        EMPTY_TURN_DIFF_SUMMARY_BY_ASSISTANT_MESSAGE_ID,
    };
    return buildSourceTimelineRows(sourceInput);
  }, [input.buildRows, input.rowsBuildOptions, projection]);

  const hydrating = (fetchState?.inFlightCount ?? 0) > 0;
  const source: ThreadTimelineViewModelSource =
    completeSnapshot !== null ? "snapshot" : rowIds.length > 0 ? "live" : "recovery";

  return {
    rows,
    rowIds,
    revision,
    timelineIndexByEntryId: projection?.timelineIndexByEntryId ?? EMPTY_TIMELINE_INDEX_BY_ENTRY_ID,
    loading: input.enabled && projection === null && hydrating,
    hydrating,
    source,
    projection,
    completeSnapshot,
  };
}

function splitSubagentTimelineEntries(entries: ReadonlyArray<WorkLogEntry>): {
  readonly messages: ChatMessage[];
  readonly workEntries: WorkLogEntry[];
} {
  const messages: ChatMessage[] = [];
  const workEntries: WorkLogEntry[] = [];

  for (const entry of entries) {
    if (entry.sideChatMessageRole && entry.sideChatMessageText) {
      messages.push({
        id: MessageId.makeUnsafe(entry.sideChatMessageId ?? entry.id),
        role: entry.sideChatMessageRole,
        text: entry.sideChatMessageText,
        turnId: null,
        createdAt: entry.createdAt,
        ...(entry.sequence !== undefined ? { sequence: entry.sequence } : {}),
        streaming: false,
      });
      continue;
    }
    workEntries.push(entry);
  }

  return { messages, workEntries };
}

function revisionFromSubagentEntries(
  thread: SubagentTimelineThreadInput | null | undefined,
): number {
  if (!thread) {
    return 0;
  }
  let hash = thread.status === "running" ? 17 : thread.status === "failed" ? 31 : 43;
  for (const entry of thread.entries) {
    hash = Math.imul(hash ^ entry.id.length, 16777619);
    hash = Math.imul(hash ^ entry.createdAt.length, 16777619);
    hash = Math.imul(hash ^ (entry.status?.length ?? 0), 16777619);
    hash = Math.imul(hash ^ (entry.detail?.length ?? 0), 16777619);
    hash = Math.imul(hash ^ (entry.terminalOutput?.length ?? 0), 16777619);
    hash = Math.imul(hash ^ (entry.sideChatMessageText?.length ?? 0), 16777619);
  }
  return hash >>> 0;
}

export function useSubagentTimelineViewModel(
  input: UseSubagentTimelineViewModelInput,
): SubagentTimelineViewModel {
  const thread = input.enabled ? (input.thread ?? null) : null;
  const revision = useMemo(() => revisionFromSubagentEntries(thread), [thread]);
  const activeTurnStartedAt = useMemo(() => {
    if (!thread) {
      return null;
    }
    return (
      thread.entries.find((entry) => entry.status === "inProgress")?.createdAt ??
      thread.entries[0]?.createdAt ??
      null
    );
  }, [thread]);
  const activeTurnInProgress = thread?.status === "running";
  const timelineEntries = useMemo(() => {
    if (!thread) {
      return [];
    }
    const splitTimeline = splitSubagentTimelineEntries(thread.entries);
    return deriveTimelineEntries(splitTimeline.messages, [], splitTimeline.workEntries);
  }, [thread]);
  const rows = useMemo(() => {
    if (!thread) {
      return EMPTY_TIMELINE_ROWS;
    }
    return buildTimelineRows({
      timelineEntries,
      activeTurnInProgress,
      activeTurnStartedAt,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: activeTurnInProgress,
    });
  }, [activeTurnInProgress, activeTurnStartedAt, thread, timelineEntries]);
  const rowIds = useMemo(
    () => (rows.length === 0 ? EMPTY_ROW_IDS : rows.map((row) => row.id)),
    [rows],
  );
  const timelineIndexByEntryId = useMemo(() => {
    if (timelineEntries.length === 0) {
      return EMPTY_TIMELINE_INDEX_BY_ENTRY_ID;
    }
    const next = new Map<string, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (entry) {
        next.set(entry.id, index);
      }
    }
    return next;
  }, [timelineEntries]);

  return {
    rows,
    rowIds,
    revision,
    timelineIndexByEntryId,
    loading: false,
    hydrating: false,
    source: "live",
    hasEntries: timelineEntries.length > 0,
    activeTurnInProgress,
    activeTurnStartedAt,
  };
}
