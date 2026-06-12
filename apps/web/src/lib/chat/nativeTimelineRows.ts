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
  readonly completionSummary: string | null;
  readonly turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
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
  const orderedSourceRows = input.rows.toSorted((left, right) => {
    if (left.turnId && right.turnId && left.turnId === right.turnId) {
      const leftPriority = nativeTimelinePresentationPriority(left, messageById);
      const rightPriority = nativeTimelinePresentationPriority(right, messageById);
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
    }
    return (
      left.startSourceIndex - right.startSourceIndex ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id)
    );
  });

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

  for (const row of orderedSourceRows) {
    if (row.kind === "message") {
      flushPendingWorkGroup();
      const sourceRef = row.sourceRefs.find((source) => source.kind === "message");
      const message = sourceRef ? messageById.get(String(sourceRef.id)) : undefined;
      if (!sourceRef || !message) {
        continue;
      }
      const turnSummary = input.turnDiffSummaryByAssistantMessageId.get(message.id) ?? null;
      rows.push({
        kind: "message",
        id: row.id,
        createdAt: row.createdAt,
        message,
        durationStart: messageDurationStartById.get(message.id) ?? message.createdAt,
        completionSummary:
          message.role === "assistant" && input.completionDividerBeforeEntryId === row.id
            ? input.completionSummary
            : null,
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

function nativeTimelinePresentationPriority(
  row: OrchestrationTimelineRow,
  messageById: ReadonlyMap<string, ChatMessage>,
): number {
  if (row.kind !== "message") {
    return 1;
  }
  const sourceRef = row.sourceRefs.find((source) => source.kind === "message");
  const message = sourceRef ? messageById.get(String(sourceRef.id)) : undefined;
  return message?.role === "assistant" ? 2 : 0;
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
