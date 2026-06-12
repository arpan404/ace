import {
  type MessageId,
  type OrchestrationMessage,
  type OrchestrationLatestTurn,
  type OrchestrationProposedPlan,
  type OrchestrationThreadActivity,
  type OrchestrationTimelineRow,
} from "@ace/contracts";

import { createChatMessageStreamingTextState, getChatMessageRenderableText } from "./messageText";
import { computeMessageDurationStart } from "./messagesTimeline";
import {
  buildTimelineWorkGroupSummaryProjection,
  type TimelineCompletedWorkSummaryRow,
  type TimelineMetaGroupEntry,
  type TimelineRow,
} from "./timelineRows";
import { deriveWorkLogEntries, filterVisibleWorkLogActivities } from "../../session-logic/worklog";
import type { ChatMessage, ProposedPlan, TurnDiffSummary } from "../../types";

export interface NativeTimelineRowsInput {
  readonly rows: readonly OrchestrationTimelineRow[];
  readonly messages: readonly OrchestrationMessage[];
  readonly activities: readonly OrchestrationThreadActivity[];
  readonly proposedPlans: readonly OrchestrationProposedPlan[];
  readonly activeTurnInProgress: boolean;
  readonly activeTurnStartedAt: string | null;
  readonly completionDividerBeforeEntryId: string | null;
  readonly completionEndedAt?: string | null;
  readonly completionSummary: string | null;
  readonly completionTurnId?: string | null;
  readonly completionStartedAt?: string | null;
  readonly hideCompletedWorkMessages?: boolean;
  readonly turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
}

export interface NativeCompletionAttachment {
  readonly dividerBeforeEntryId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly turnId: string | null;
}

export function toPagedChatMessage(message: OrchestrationMessage): ChatMessage {
  const attachments = message.attachments?.map((attachment) => ({
    type: "image" as const,
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  }));

  return {
    id: message.id,
    role: message.role,
    text: message.streaming ? "" : message.text,
    ...(message.streaming
      ? { streamingTextState: createChatMessageStreamingTextState(message.text) }
      : {}),
    turnId: message.turnId,
    createdAt: message.createdAt,
    ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
    streaming: message.streaming,
    ...(message.streaming ? {} : { completedAt: message.updatedAt }),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

export function toPagedProposedPlan(plan: OrchestrationProposedPlan): ProposedPlan {
  return {
    id: plan.id,
    turnId: plan.turnId,
    planMarkdown: plan.planMarkdown,
    implementedAt: plan.implementedAt,
    implementationThreadId: plan.implementationThreadId,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

export function buildNativeTimelineRows(input: NativeTimelineRowsInput): TimelineRow[] {
  const messageById = new Map<string, ChatMessage>();
  for (const message of input.messages) {
    messageById.set(String(message.id), toPagedChatMessage(message));
  }
  const workEntryByActivityId = new Map<string, ReturnType<typeof deriveWorkLogEntries>[number]>();
  const visibleActivities = filterVisibleWorkLogActivities(input.activities, {
    enableToolStreaming: true,
    enableThinkingStreaming: true,
  });
  for (const workEntry of deriveWorkLogEntries(visibleActivities)) {
    workEntryByActivityId.set(workEntry.id, workEntry);
  }
  const proposedPlanById = new Map<string, ProposedPlan>();
  for (const plan of input.proposedPlans) {
    proposedPlanById.set(String(plan.id), toPagedProposedPlan(plan));
  }
  const durationMessages: Array<{
    readonly id: ChatMessage["id"];
    readonly role: ChatMessage["role"];
    readonly createdAt: ChatMessage["createdAt"];
    completedAt?: ChatMessage["completedAt"];
  }> = [];
  for (const message of messageById.values()) {
    const durationMessage: (typeof durationMessages)[number] = {
      id: message.id,
      role: message.role,
      createdAt: message.createdAt,
    };
    if (message.completedAt) {
      durationMessage.completedAt = message.completedAt;
    }
    durationMessages.push(durationMessage);
  }
  const messageDurationStartById = computeMessageDurationStart(durationMessages);
  const terminalAssistantMessageIds = deriveLoadedTerminalAssistantMessageIds(input.rows, {
    messageById,
    activeTurnInProgress: input.activeTurnInProgress,
  });
  const orderedSourceRows = input.rows.toSorted(compareNativeTimelineRowsBySourceOrder);
  const completionWorkSummary = buildNativeCompletionWorkSummary({
    completionEndedAt: input.completionEndedAt ?? null,
    completionStartedAt: input.completionStartedAt ?? null,
    completionTurnId: input.completionTurnId ?? null,
    completionDividerBeforeEntryId: input.completionDividerBeforeEntryId,
    rows: input.rows,
    messageById,
    workEntryByActivityId,
  });
  const completionWorkSourceRowIds = new Set(completionWorkSummary?.sourceRowIds ?? []);
  const activeTurnStartedAtMs = input.activeTurnStartedAt
    ? Date.parse(input.activeTurnStartedAt)
    : Number.NaN;
  const latestActiveWorkRowId = findLatestActiveWorkRowId(input, {
    activeTurnStartedAtMs,
    orderedSourceRows,
    workEntryByActivityId,
  });
  const rows: TimelineRow[] = [];
  let lastMessageBoundaryAt: string | null = null;
  let pendingWorkGroup: {
    rowId: string;
    createdAt: string;
    updatedAt: string;
    turnId: string | null;
    entries: TimelineMetaGroupEntry[];
  } | null = null;
  let pendingHiddenCompletedWork: {
    id: string;
    createdAt: string;
    startedAt: string;
    endedAt: string;
    turnId: string | null;
    sourceEntryIds: string[];
    detailRows: TimelineCompletedWorkSummaryRow["detailRows"];
    hiddenThinkingCount: number;
    toolCallCount: number;
  } | null = null;

  const flushPendingWorkGroup = () => {
    if (!pendingWorkGroup) {
      return;
    }

    const { rowId, createdAt, updatedAt, entries } = pendingWorkGroup;
    if (entries.length === 1) {
      const [entry] = entries;
      if (entry?.kind === "work") {
        const shouldCollapseSingle =
          entry.workEntry.tone === "thinking" || entry.workEntry.tone === "tool";
        if (!shouldCollapseSingle) {
          rows.push({
            kind: "work",
            id: rowId,
            createdAt,
            workEntry: entry.workEntry,
          });
          pendingWorkGroup = null;
          return;
        }
      }
    }

    rows.push({
      kind: "work-group",
      id: rowId,
      createdAt,
      entries,
      summaryEndAt: updatedAt,
      summary: buildTimelineWorkGroupSummaryProjection(entries),
    });
    pendingWorkGroup = null;
  };

  const recordHiddenCompletedWork = (
    row: OrchestrationTimelineRow,
    entries: readonly TimelineMetaGroupEntry[],
  ) => {
    const firstEntry = entries[0];
    if (!firstEntry) {
      return;
    }
    const summary = buildTimelineWorkGroupSummaryProjection(entries);
    const detailRow = compactNativeHiddenCompletedWorkDetailRow({
      row,
      entries,
      summary,
    });
    if (!pendingHiddenCompletedWork) {
      pendingHiddenCompletedWork = {
        id: `completed-work-summary:${row.turnId ?? firstEntry.id}`,
        createdAt: firstEntry.createdAt,
        startedAt: firstEntry.createdAt,
        endedAt: row.updatedAt,
        turnId: row.turnId ?? null,
        sourceEntryIds: entries.map((entry) => entry.id),
        detailRows: [detailRow],
        hiddenThinkingCount: summary.thinkingCount,
        toolCallCount: summary.toolCount,
      };
      return;
    }
    pendingHiddenCompletedWork = {
      ...pendingHiddenCompletedWork,
      endedAt: latestIso(pendingHiddenCompletedWork.endedAt, row.updatedAt),
      turnId: pendingHiddenCompletedWork.turnId ?? row.turnId ?? null,
      sourceEntryIds: [
        ...pendingHiddenCompletedWork.sourceEntryIds,
        ...entries.map((entry) => entry.id),
      ],
      detailRows: [...pendingHiddenCompletedWork.detailRows, detailRow],
      hiddenThinkingCount: pendingHiddenCompletedWork.hiddenThinkingCount + summary.thinkingCount,
      toolCallCount: pendingHiddenCompletedWork.toolCallCount + summary.toolCount,
    };
  };

  const flushHiddenCompletedWorkSummary = (endedAt: string | null) => {
    if (!pendingHiddenCompletedWork) {
      return;
    }
    const startedAt =
      lastMessageBoundaryAt !== null
        ? latestIso(pendingHiddenCompletedWork.startedAt, lastMessageBoundaryAt)
        : pendingHiddenCompletedWork.startedAt;
    rows.push({
      kind: "completed-work-summary",
      id: pendingHiddenCompletedWork.id,
      createdAt: startedAt,
      startedAt,
      endedAt: endedAt ?? pendingHiddenCompletedWork.endedAt,
      sourceEntryIds: pendingHiddenCompletedWork.sourceEntryIds,
      detailRows: pendingHiddenCompletedWork.detailRows,
      visibleDiagnosticRows: [],
      visibleDiagnosticCacheKey: "empty",
      hiddenMessageCount: 0,
      hiddenThinkingCount: pendingHiddenCompletedWork.hiddenThinkingCount,
      toolCallCount: pendingHiddenCompletedWork.toolCallCount,
    });
    pendingHiddenCompletedWork = null;
  };

  const discardHiddenCompletedWorkSummary = () => {
    pendingHiddenCompletedWork = null;
  };

  for (const row of orderedSourceRows) {
    if (completionWorkSourceRowIds.has(row.id)) {
      flushPendingWorkGroup();
      continue;
    }

    if (row.kind === "message") {
      flushPendingWorkGroup();
      const sourceRef = row.sourceRefs.find((source) => source.kind === "message");
      const message = sourceRef ? messageById.get(String(sourceRef.id)) : undefined;
      if (!sourceRef || !message) {
        continue;
      }
      const turnSummary = input.turnDiffSummaryByAssistantMessageId.get(message.id) ?? null;
      const completionSummaryBelongsToMessage =
        message.role === "assistant" && input.completionDividerBeforeEntryId === row.id;
      if (completionSummaryBelongsToMessage && completionWorkSummary) {
        discardHiddenCompletedWorkSummary();
        rows.push(completionWorkSummary.row);
      } else if (message.role === "assistant" && !message.streaming) {
        flushHiddenCompletedWorkSummary(message.completedAt ?? message.createdAt);
      } else {
        discardHiddenCompletedWorkSummary();
      }
      rows.push({
        kind: "message",
        id: row.id,
        createdAt: row.createdAt,
        message,
        durationStart: messageDurationStartById.get(message.id) ?? message.createdAt,
        completionSummary: completionSummaryBelongsToMessage ? input.completionSummary : null,
        isAssistantTurnTerminal:
          message.role === "assistant" && terminalAssistantMessageIds.has(String(message.id)),
        showAssistantTiming:
          message.role === "assistant" &&
          terminalAssistantMessageIds.has(String(message.id)) &&
          !message.streaming,
        showAssistantSummaryByDefault:
          message.role === "assistant" && turnSummary !== null && !message.streaming,
      });
      lastMessageBoundaryAt = message.createdAt;
      continue;
    }

    if (row.kind === "proposed-plan") {
      flushPendingWorkGroup();
      const sourceRef = row.sourceRefs.find((source) => source.kind === "proposed-plan");
      const proposedPlan = sourceRef ? proposedPlanById.get(String(sourceRef.id)) : undefined;
      if (!sourceRef || !proposedPlan) {
        continue;
      }
      rows.push({
        kind: "proposed-plan",
        id: row.id,
        createdAt: row.createdAt,
        proposedPlan,
      });
      continue;
    }

    const entries: TimelineMetaGroupEntry[] = [];
    for (const sourceRef of row.sourceRefs) {
      if (sourceRef.kind !== "activity") {
        continue;
      }
      const workEntry = workEntryByActivityId.get(String(sourceRef.id));
      if (!workEntry) {
        continue;
      }
      entries.push({
        kind: "work",
        id: workEntry.id,
        createdAt: workEntry.createdAt,
        workEntry,
      });
    }
    if (entries.length === 0) {
      continue;
    }
    if (row.id === latestActiveWorkRowId) {
      flushPendingWorkGroup();
      appendIndividualWorkRows(rows, row, entries);
      continue;
    }
    if (input.hideCompletedWorkMessages === true) {
      flushPendingWorkGroup();
      recordHiddenCompletedWork(row, entries);
      continue;
    }
    const rowTurnId = row.turnId ?? null;
    if (pendingWorkGroup && pendingWorkGroup.turnId !== rowTurnId) {
      flushPendingWorkGroup();
    }
    if (!pendingWorkGroup) {
      pendingWorkGroup = {
        rowId: row.id,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        turnId: rowTurnId,
        entries: [],
      };
    } else if (row.updatedAt > pendingWorkGroup.updatedAt) {
      pendingWorkGroup.updatedAt = row.updatedAt;
    }
    pendingWorkGroup.entries.push(...entries);
    if (row.kind !== "work") {
      flushPendingWorkGroup();
      continue;
    }
  }
  flushPendingWorkGroup();
  if (input.activeTurnInProgress) {
    const hasRenderableCurrentTurnOutput = rows.some((row) => {
      if (!input.activeTurnStartedAt || Number.isNaN(activeTurnStartedAtMs)) {
        return false;
      }
      if (row.kind === "message" && row.message.role === "user") {
        return false;
      }
      if (!row.createdAt) {
        return false;
      }
      const rowCreatedAtMs = Date.parse(row.createdAt);
      return !Number.isNaN(rowCreatedAtMs) && rowCreatedAtMs >= activeTurnStartedAtMs;
    });
    rows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
      mode: hasRenderableCurrentTurnOutput ? "live" : "silent-thinking",
      activity: "default",
      goalStartedAt: null,
      intentText: null,
    });
  }
  return rows;
}

function isActiveTurnWorkRow(
  input: NativeTimelineRowsInput,
  activeTurnStartedAtMs: number,
  row: OrchestrationTimelineRow,
): boolean {
  if (
    !input.activeTurnInProgress ||
    !input.activeTurnStartedAt ||
    Number.isNaN(activeTurnStartedAtMs)
  ) {
    return false;
  }
  const rowCreatedAtMs = Date.parse(row.createdAt);
  return !Number.isNaN(rowCreatedAtMs) && rowCreatedAtMs >= activeTurnStartedAtMs;
}

function findLatestActiveWorkRowId(
  input: NativeTimelineRowsInput,
  options: {
    readonly activeTurnStartedAtMs: number;
    readonly orderedSourceRows: readonly OrchestrationTimelineRow[];
    readonly workEntryByActivityId: ReadonlyMap<
      string,
      ReturnType<typeof deriveWorkLogEntries>[number]
    >;
  },
): string | null {
  let latestRowId: string | null = null;
  for (const row of options.orderedSourceRows) {
    if (!isActiveTurnWorkRow(input, options.activeTurnStartedAtMs, row)) {
      continue;
    }
    const hasVisibleWorkEntry = row.sourceRefs.some(
      (sourceRef) =>
        sourceRef.kind === "activity" && options.workEntryByActivityId.has(String(sourceRef.id)),
    );
    if (hasVisibleWorkEntry) {
      latestRowId = row.id;
    }
  }
  return latestRowId;
}

function appendIndividualWorkRows(
  rows: TimelineRow[],
  row: OrchestrationTimelineRow,
  entries: readonly TimelineMetaGroupEntry[],
): void {
  for (const entry of entries) {
    if (entry.kind !== "work") {
      continue;
    }
    rows.push({
      kind: "work",
      id: entries.length === 1 ? row.id : `${row.id}:${entry.id}`,
      createdAt: entry.createdAt,
      workEntry: entry.workEntry,
    });
  }
}

function compactNativeHiddenCompletedWorkDetailRow(input: {
  readonly row: OrchestrationTimelineRow;
  readonly entries: readonly TimelineMetaGroupEntry[];
  readonly summary: ReturnType<typeof buildTimelineWorkGroupSummaryProjection>;
}): TimelineCompletedWorkSummaryRow["detailRows"][number] {
  if (input.entries.length === 1) {
    const [entry] = input.entries;
    if (entry?.kind === "work") {
      return {
        kind: "work",
        id: entry.id,
        createdAt: entry.createdAt,
        workEntry: entry.workEntry,
      };
    }
  }
  return {
    kind: "work-group",
    id: `completed-work-detail:${input.row.id}`,
    createdAt: input.row.createdAt,
    entries: [...input.entries],
    summaryEndAt: input.row.updatedAt,
    summary: input.summary,
  };
}

const MAX_NATIVE_HIDDEN_ASSISTANT_UPDATE_TEXT_LENGTH = 1_200;

function compactNativeHiddenAssistantUpdateRow(
  message: ChatMessage,
): TimelineCompletedWorkSummaryRow["detailRows"][number] {
  const text = getChatMessageRenderableText(message).trim();
  const truncated = text.length > MAX_NATIVE_HIDDEN_ASSISTANT_UPDATE_TEXT_LENGTH;
  return {
    kind: "assistant-update",
    id: `hidden-assistant-update:${String(message.id)}`,
    createdAt: message.createdAt,
    text: truncated
      ? text.slice(0, MAX_NATIVE_HIDDEN_ASSISTANT_UPDATE_TEXT_LENGTH).trimEnd()
      : text,
    truncated,
  };
}

function latestIso(left: string, right: string): string {
  return left >= right ? left : right;
}

function buildNativeCompletionWorkSummary(input: {
  readonly completionEndedAt: string | null;
  readonly completionStartedAt: string | null;
  readonly completionTurnId: string | null;
  readonly completionDividerBeforeEntryId: string | null;
  readonly rows: readonly OrchestrationTimelineRow[];
  readonly messageById: ReadonlyMap<string, ChatMessage>;
  readonly workEntryByActivityId: ReadonlyMap<
    string,
    ReturnType<typeof deriveWorkLogEntries>[number]
  >;
}): {
  readonly row: TimelineCompletedWorkSummaryRow;
  readonly sourceRowIds: readonly string[];
} | null {
  if (!input.completionStartedAt || !input.completionEndedAt) {
    return null;
  }

  const sourceRowIds: string[] = [];
  const sourceEntryIds: string[] = [];
  const detailRows: TimelineCompletedWorkSummaryRow["detailRows"] = [];
  const visibleDiagnosticRows: TimelineCompletedWorkSummaryRow["visibleDiagnosticRows"] = [];
  const summaryEntries: TimelineMetaGroupEntry[] = [];
  let hiddenMessageCount = 0;
  let pendingDetailGroupIndex = 0;
  let pendingDetailGroup: {
    rowId: string;
    createdAt: string;
    updatedAt: string;
    groupKey: string;
    entries: TimelineMetaGroupEntry[];
  } | null = null;
  const flushPendingDetailGroup = () => {
    if (!pendingDetailGroup) {
      return;
    }
    const { rowId, createdAt, updatedAt, entries } = pendingDetailGroup;
    if (entries.length === 1) {
      const [entry] = entries;
      if (entry?.kind === "work") {
        detailRows.push({
          kind: "work",
          id: entry.id,
          createdAt: entry.createdAt,
          workEntry: entry.workEntry,
        });
        pendingDetailGroup = null;
        return;
      }
    }
    detailRows.push({
      kind: "work-group",
      id: `completed-work-detail:${pendingDetailGroupIndex}:${rowId}`,
      createdAt,
      entries,
      summaryEndAt: updatedAt,
      summary: buildTimelineWorkGroupSummaryProjection(entries),
    });
    pendingDetailGroupIndex += 1;
    pendingDetailGroup = null;
  };

  for (const row of input.rows.toSorted(compareNativeTimelineRowsBySourceOrder)) {
    if (row.kind === "message") {
      flushPendingDetailGroup();
      if (row.id === input.completionDividerBeforeEntryId) {
        continue;
      }
      const sourceRef = row.sourceRefs.find((source) => source.kind === "message");
      const message = sourceRef ? input.messageById.get(String(sourceRef.id)) : undefined;
      if (
        !message ||
        message.role !== "assistant" ||
        message.streaming ||
        !isNativeCompletionSummarySourceRow(input, row)
      ) {
        continue;
      }
      const detailRow = compactNativeHiddenAssistantUpdateRow(message);
      sourceRowIds.push(row.id);
      sourceEntryIds.push(String(message.id));
      detailRows.push(detailRow);
      hiddenMessageCount += 1;
      continue;
    }

    if (row.kind !== "work") {
      flushPendingDetailGroup();
      continue;
    }
    if (!isNativeCompletionSummarySourceRow(input, row)) {
      continue;
    }
    const entries: TimelineMetaGroupEntry[] = [];
    for (const sourceRef of row.sourceRefs) {
      if (sourceRef.kind !== "activity") {
        continue;
      }
      const workEntry = input.workEntryByActivityId.get(String(sourceRef.id));
      if (!workEntry) {
        continue;
      }
      const entry: TimelineMetaGroupEntry = {
        kind: "work",
        id: workEntry.id,
        createdAt: workEntry.createdAt,
        workEntry,
      };
      entries.push(entry);
      summaryEntries.push(entry);
      sourceEntryIds.push(workEntry.id);
      if (workEntry.tone === "error") {
        visibleDiagnosticRows.push({
          kind: "work",
          id: workEntry.id,
          createdAt: workEntry.createdAt,
          workEntry,
        });
      }
    }
    if (entries.length === 0) {
      continue;
    }
    sourceRowIds.push(row.id);
    for (const entry of entries) {
      const groupKey = completedWorkDetailGroupKey(entry);
      if (!pendingDetailGroup || pendingDetailGroup.groupKey !== groupKey) {
        flushPendingDetailGroup();
        pendingDetailGroup = {
          rowId: row.id,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          groupKey,
          entries: [],
        };
      } else if (row.updatedAt > pendingDetailGroup.updatedAt) {
        pendingDetailGroup.updatedAt = row.updatedAt;
      }
      pendingDetailGroup.entries.push(entry);
    }
  }
  flushPendingDetailGroup();

  const summary = buildTimelineWorkGroupSummaryProjection(summaryEntries);
  const visibleDiagnosticCacheKey =
    visibleDiagnosticRows.length === 0
      ? "empty"
      : visibleDiagnosticRows.map((row) => row.id).join(",");
  return {
    row: {
      kind: "completed-work-summary",
      id: `completed-work-summary:${input.completionTurnId ?? input.completionEndedAt}`,
      createdAt: input.completionStartedAt,
      startedAt: input.completionStartedAt,
      endedAt: input.completionEndedAt,
      sourceEntryIds,
      detailRows,
      visibleDiagnosticRows,
      visibleDiagnosticCacheKey,
      hiddenMessageCount,
      hiddenThinkingCount: summary.thinkingCount,
      toolCallCount: summary.toolCount,
    },
    sourceRowIds,
  };
}

function isNativeCompletionSummarySourceRow(
  input: {
    readonly completionStartedAt: string | null;
    readonly completionEndedAt: string | null;
    readonly completionTurnId: string | null;
  },
  row: OrchestrationTimelineRow,
): boolean {
  if (input.completionTurnId && row.turnId !== undefined && row.turnId !== input.completionTurnId) {
    return false;
  }
  if (input.completionStartedAt && row.createdAt < input.completionStartedAt) {
    return false;
  }
  if (input.completionEndedAt && row.createdAt > input.completionEndedAt) {
    return false;
  }
  return true;
}

function completedWorkDetailGroupKey(entry: TimelineMetaGroupEntry): string {
  if (entry.kind === "intent") {
    return "intent";
  }
  return `work:${entry.workEntry.tone}`;
}

function compareNativeTimelineRowsBySourceOrder(
  left: OrchestrationTimelineRow,
  right: OrchestrationTimelineRow,
): number {
  return (
    compareLiveNativeTimelineRowSourceSequence(left, right) ||
    left.startSourceIndex - right.startSourceIndex ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function compareLiveNativeTimelineRowSourceSequence(
  left: OrchestrationTimelineRow,
  right: OrchestrationTimelineRow,
): number {
  if (!isLiveNativeTimelineRow(left) && !isLiveNativeTimelineRow(right)) {
    return 0;
  }
  const leftSequence = nativeTimelineRowFirstSequence(left);
  const rightSequence = nativeTimelineRowFirstSequence(right);
  if (leftSequence === undefined || rightSequence === undefined || leftSequence === rightSequence) {
    return 0;
  }
  return leftSequence - rightSequence;
}

function isLiveNativeTimelineRow(row: OrchestrationTimelineRow): boolean {
  return row.contentVersion.startsWith("live:");
}

function nativeTimelineRowFirstSequence(row: OrchestrationTimelineRow): number | undefined {
  let sequence: number | undefined;
  for (const sourceRef of row.sourceRefs) {
    if (sourceRef.sequence === undefined) {
      continue;
    }
    sequence = sequence === undefined ? sourceRef.sequence : Math.min(sequence, sourceRef.sequence);
  }
  return sequence;
}

export function deriveNativeCompletionDividerBeforeRowId(input: {
  readonly latestTurn: Pick<
    OrchestrationLatestTurn,
    "turnId" | "assistantMessageId" | "startedAt" | "completedAt"
  > | null;
  readonly rows: readonly OrchestrationTimelineRow[];
  readonly messages: readonly OrchestrationMessage[];
}): string | null {
  const latestTurn = input.latestTurn;
  if (!latestTurn?.startedAt || !latestTurn.completedAt) {
    return null;
  }
  const messageById = new Map<string, OrchestrationMessage>();
  for (const message of input.messages) {
    messageById.set(String(message.id), message);
  }

  let latestAssistantRowForTurn: string | null = null;
  for (const row of input.rows) {
    if (row.kind !== "message") {
      continue;
    }
    const sourceRef = row.sourceRefs.find((source) => source.kind === "message");
    const message = sourceRef ? messageById.get(String(sourceRef.id)) : undefined;
    if (!message || message.role !== "assistant") {
      continue;
    }
    if (message.turnId === latestTurn.turnId) {
      latestAssistantRowForTurn = row.id;
    }
  }
  if (latestAssistantRowForTurn) {
    return latestAssistantRowForTurn;
  }

  if (latestTurn.assistantMessageId) {
    for (const row of input.rows) {
      if (row.kind !== "message") {
        continue;
      }
      const sourceRef = row.sourceRefs.find((source) => source.kind === "message");
      if (sourceRef && String(sourceRef.id) === String(latestTurn.assistantMessageId)) {
        return row.id;
      }
    }
  }

  const turnStartedAt = Date.parse(latestTurn.startedAt);
  const turnCompletedAt = Date.parse(latestTurn.completedAt);
  if (Number.isNaN(turnStartedAt) || Number.isNaN(turnCompletedAt)) {
    return null;
  }

  let inRangeMatch: string | null = null;
  let fallbackMatch: string | null = null;
  for (const row of input.rows) {
    if (row.kind !== "message") {
      continue;
    }
    const sourceRef = row.sourceRefs.find((source) => source.kind === "message");
    const message = sourceRef ? messageById.get(String(sourceRef.id)) : undefined;
    if (!message || message.role !== "assistant") {
      continue;
    }
    const messageAt = Date.parse(message.createdAt);
    if (Number.isNaN(messageAt) || messageAt < turnStartedAt) {
      continue;
    }
    fallbackMatch = row.id;
    if (messageAt <= turnCompletedAt) {
      inRangeMatch = row.id;
    }
  }
  return inRangeMatch ?? fallbackMatch;
}

export function deriveNativeCompletionAttachment(input: {
  readonly latestTurn: Pick<
    OrchestrationLatestTurn,
    "turnId" | "assistantMessageId" | "startedAt" | "completedAt"
  > | null;
  readonly rows: readonly OrchestrationTimelineRow[];
  readonly messages: readonly OrchestrationMessage[];
}): NativeCompletionAttachment | null {
  const latestTurn = input.latestTurn;
  const dividerFromTurn = deriveNativeCompletionDividerBeforeRowId(input);
  if (dividerFromTurn && latestTurn?.startedAt && latestTurn.completedAt) {
    return {
      dividerBeforeEntryId: dividerFromTurn,
      startedAt: latestTurn.startedAt,
      endedAt: latestTurn.completedAt,
      turnId: String(latestTurn.turnId),
    };
  }

  const messageById = new Map<string, OrchestrationMessage>();
  for (const message of input.messages) {
    messageById.set(String(message.id), message);
  }

  let terminalAssistant: {
    readonly row: OrchestrationTimelineRow;
    readonly message: OrchestrationMessage;
  } | null = null;
  let previousUserMessage: OrchestrationMessage | null = null;
  let lastUserBeforeTerminalAssistant: OrchestrationMessage | null = null;
  const orderedRows = input.rows.toSorted(compareNativeTimelineRowsBySourceOrder);
  for (const row of orderedRows) {
    if (row.kind !== "message") {
      continue;
    }
    const sourceRef = row.sourceRefs.find((source) => source.kind === "message");
    const message = sourceRef ? messageById.get(String(sourceRef.id)) : undefined;
    if (!message) {
      continue;
    }
    if (message.role === "user") {
      previousUserMessage = message;
      continue;
    }
    if (message.role !== "assistant" || message.streaming) {
      continue;
    }
    terminalAssistant = { row, message };
    lastUserBeforeTerminalAssistant = previousUserMessage;
  }

  if (!terminalAssistant) {
    return null;
  }

  const endedAt = terminalAssistant.message.updatedAt;
  let startedAt =
    latestTurn?.startedAt ??
    lastUserBeforeTerminalAssistant?.createdAt ??
    terminalAssistant.message.createdAt;
  const endedAtMs = Date.parse(endedAt);
  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(endedAtMs)) {
    return null;
  }
  if (Number.isNaN(startedAtMs) || startedAtMs > endedAtMs) {
    startedAt = terminalAssistant.message.createdAt;
  }

  return {
    dividerBeforeEntryId: terminalAssistant.row.id,
    startedAt,
    endedAt,
    turnId:
      latestTurn?.turnId !== undefined && latestTurn.turnId !== null
        ? String(latestTurn.turnId)
        : terminalAssistant.message.turnId !== null
          ? String(terminalAssistant.message.turnId)
          : null,
  };
}

function deriveLoadedTerminalAssistantMessageIds(
  rows: readonly OrchestrationTimelineRow[],
  input: {
    readonly messageById: ReadonlyMap<string, ChatMessage>;
    readonly activeTurnInProgress: boolean;
  },
): ReadonlySet<string> {
  const byTurnId = new Map<string, string>();
  const fallbackBySegment = new Map<number, string>();
  let segmentIndex = 0;
  for (const row of rows) {
    if (row.kind !== "message") {
      continue;
    }
    const sourceRef = row.sourceRefs.find((source) => source.kind === "message");
    const message = sourceRef ? input.messageById.get(String(sourceRef.id)) : undefined;
    if (!message) {
      continue;
    }
    if (message.role === "user") {
      segmentIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }
    if (message.turnId) {
      byTurnId.set(message.turnId, String(message.id));
    } else {
      fallbackBySegment.set(segmentIndex, String(message.id));
    }
  }
  const terminalIds = new Set<string>([...byTurnId.values(), ...fallbackBySegment.values()]);
  if (input.activeTurnInProgress) {
    const currentFallback = fallbackBySegment.get(segmentIndex);
    if (currentFallback) {
      terminalIds.add(currentFallback);
    }
  }
  return terminalIds;
}
