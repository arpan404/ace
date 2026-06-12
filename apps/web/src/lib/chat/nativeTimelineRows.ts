import {
  type MessageId,
  type OrchestrationMessage,
  type OrchestrationLatestTurn,
  type OrchestrationProposedPlan,
  type OrchestrationThreadActivity,
  type OrchestrationTimelineRow,
} from "@ace/contracts";

import { createChatMessageStreamingTextState } from "./messageText";
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
    rows: input.rows,
    workEntryByActivityId,
  });
  const completionWorkSourceRowIds = new Set(completionWorkSummary?.sourceRowIds ?? []);
  const activeTurnStartedAtMs = input.activeTurnStartedAt
    ? Date.parse(input.activeTurnStartedAt)
    : Number.NaN;
  const rows: TimelineRow[] = [];
  let pendingWorkGroup: {
    rowId: string;
    createdAt: string;
    updatedAt: string;
    turnId: string | null;
    entries: TimelineMetaGroupEntry[];
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
        if (!shouldCollapseSingle || input.activeTurnInProgress) {
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

  for (const row of orderedSourceRows) {
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
        rows.push(completionWorkSummary.row);
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

    if (completionWorkSourceRowIds.has(row.id)) {
      flushPendingWorkGroup();
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

function buildNativeCompletionWorkSummary(input: {
  readonly completionEndedAt: string | null;
  readonly completionStartedAt: string | null;
  readonly completionTurnId: string | null;
  readonly rows: readonly OrchestrationTimelineRow[];
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
  for (const row of input.rows.toSorted(compareNativeTimelineRowsBySourceOrder)) {
    if (row.kind !== "work") {
      continue;
    }
    if (
      input.completionTurnId &&
      row.turnId !== undefined &&
      row.turnId !== input.completionTurnId
    ) {
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
    if (entries.length === 1) {
      const [entry] = entries;
      if (entry?.kind === "work") {
        detailRows.push({
          kind: "work",
          id: entry.id,
          createdAt: entry.createdAt,
          workEntry: entry.workEntry,
        });
      }
      continue;
    }
    detailRows.push({
      kind: "work-group",
      id: `completed-work-detail:${row.id}`,
      createdAt: row.createdAt,
      entries,
      summaryEndAt: row.updatedAt,
      summary: buildTimelineWorkGroupSummaryProjection(entries),
    });
  }

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
      hiddenMessageCount: 0,
      hiddenThinkingCount: summary.thinkingCount,
      toolCallCount: summary.toolCount,
    },
    sourceRowIds,
  };
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
