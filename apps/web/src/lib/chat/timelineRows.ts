import { computeMessageDurationStart } from "./messagesTimeline";
import { stripProviderCommandMarkers } from "../../composer-editor-mentions";
import type { TimelineEntry } from "../../session-logic/types";

export type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
export type UserTimelineMessage = TimelineMessage & { role: "user" };
export type AssistantTimelineMessage = TimelineMessage & { role: "assistant" };
export type SystemTimelineMessage = TimelineMessage & { role: "system" };
export type TimelineProposedPlan = Extract<
  TimelineEntry,
  { kind: "proposed-plan" }
>["proposedPlan"];
export type TimelineWorkEntry = Extract<TimelineEntry, { kind: "work" }>["entry"];

export type TimelineMetaGroupEntry =
  | {
      kind: "intent";
      id: string;
      createdAt: string;
      text: string;
    }
  | {
      kind: "work";
      id: string;
      createdAt: string;
      workEntry: TimelineWorkEntry;
    };

export type TimelineRow =
  | {
      kind: "completed-work-summary";
      id: string;
      createdAt: string;
      startedAt: string;
      endedAt: string;
      entries: TimelineMetaGroupEntry[];
      detailRows: TimelineCompletedWorkDetailRow[];
      hiddenMessageCount: number;
      toolCallCount: number;
    }
  | {
      kind: "work";
      id: string;
      createdAt: string;
      workEntry: TimelineWorkEntry;
    }
  | {
      kind: "work-group";
      id: string;
      createdAt: string;
      entries: TimelineMetaGroupEntry[];
      summaryEndAt: string | null;
    }
  | {
      kind: "intent";
      id: string;
      createdAt: string;
      text: string;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: TimelineMessage;
      durationStart: string;
      completionSummary: string | null;
      isAssistantTurnTerminal?: boolean;
      showAssistantTiming?: boolean;
      showAssistantSummaryByDefault?: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: TimelineProposedPlan;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      mode: "live" | "silent-thinking";
      activity: "default" | "goal";
      goalStartedAt: string | null;
      intentText: string | null;
    };

export type TimelineWorkLogRow =
  | Extract<TimelineRow, { kind: "work" }>
  | Extract<TimelineRow, { kind: "work-group" }>
  | Extract<TimelineRow, { kind: "intent" }>;

export type TimelineCompletedWorkDetailRow =
  | TimelineWorkLogRow
  | Extract<TimelineRow, { kind: "message" }>;

export type AssistantTimelineMessageRow = Extract<TimelineRow, { kind: "message" }> & {
  message: AssistantTimelineMessage;
};

export interface BuildTimelineRowsInput {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly activeTurnInProgress: boolean;
  readonly activeTurnStartedAt: string | null;
  readonly completionDividerBeforeEntryId: string | null;
  readonly completionSummary: string | null;
  readonly hideCompletedWorkMessages?: boolean;
  readonly isWorking: boolean;
  readonly enableGoalWorkingState?: boolean;
}

export function isCompletedAssistantMessageRow(
  row: TimelineRow,
): row is AssistantTimelineMessageRow {
  return row.kind === "message" && row.message.role === "assistant" && !row.message.streaming;
}

export function isEventInActiveTurn(createdAt: string, activeTurnStartedAtMs: number): boolean {
  if (Number.isNaN(activeTurnStartedAtMs)) {
    return false;
  }
  const createdAtMs = Date.parse(createdAt);
  return !Number.isNaN(createdAtMs) && createdAtMs >= activeTurnStartedAtMs;
}

function shouldCollapseMetaEntries(entries: ReadonlyArray<TimelineMetaGroupEntry>): boolean {
  if (entries.some((entry) => entry.kind === "intent")) {
    return true;
  }

  if (entries.length !== 1) {
    return entries.length > 0;
  }

  const [entry] = entries;
  return (
    entry?.kind === "work" &&
    (entry.workEntry.tone === "thinking" || entry.workEntry.tone === "tool")
  );
}

function resolveWorkGroupSummaryEndAt(
  entries: ReadonlyArray<TimelineMetaGroupEntry>,
  nextEventCreatedAt: string | null,
): string | null {
  if (typeof nextEventCreatedAt === "string") {
    return nextEventCreatedAt;
  }
  return entries.at(-1)?.createdAt ?? null;
}

function withInlineIntentText(
  workEntry: TimelineWorkEntry,
  intentText: string | null,
): TimelineWorkEntry {
  if (!intentText || workEntry.intentText === intentText) {
    return workEntry;
  }
  return {
    ...workEntry,
    intentText,
  };
}

function buildMetaTimelineRows(input: {
  rowId: string;
  createdAt: string;
  entries: ReadonlyArray<TimelineMetaGroupEntry>;
  nextEventCreatedAt: string | null;
  hideElapsed?: boolean;
}): TimelineWorkLogRow[] {
  if (shouldCollapseMetaEntries(input.entries)) {
    return [
      {
        kind: "work-group",
        id: input.rowId,
        createdAt: input.createdAt,
        entries: [...input.entries],
        summaryEndAt: input.hideElapsed
          ? null
          : resolveWorkGroupSummaryEndAt(input.entries, input.nextEventCreatedAt),
      },
    ];
  }

  return input.entries.map((entry) => {
    if (entry.kind === "work") {
      return {
        kind: "work",
        id: entry.id,
        createdAt: entry.createdAt,
        workEntry: entry.workEntry,
      };
    }

    return {
      kind: "intent",
      id: entry.id,
      createdAt: entry.createdAt,
      text: entry.text,
    };
  });
}

function findTrailingLiveWorkEntryId(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  input: {
    activeTurnInProgress: boolean;
    activeTurnStartedAtMs: number;
  },
): string | null {
  if (!input.activeTurnInProgress) {
    return null;
  }

  for (let index = timelineEntries.length - 1; index >= 0; index -= 1) {
    const entry = timelineEntries[index];
    if (!entry) {
      continue;
    }
    if (entry.kind === "work") {
      return isEventInActiveTurn(entry.createdAt, input.activeTurnStartedAtMs) ? entry.id : null;
    }
    return null;
  }

  return null;
}

function shouldSkipAssistantMessageRow(message: TimelineMessage): boolean {
  if (message.role !== "assistant" || message.streaming) {
    return false;
  }
  return message.text.trim().length === 0 && (message.attachments?.length ?? 0) === 0;
}

type HiddenCompletedWorkAccumulator = {
  id: string;
  createdAt: string;
  startedAt: string;
  endedAt: string;
  entries: TimelineMetaGroupEntry[];
  detailRows: TimelineCompletedWorkDetailRow[];
  hiddenMessageCount: number;
  toolCallCount: number;
};

function latestIso(firstIso: string, secondIso: string): string {
  const firstMs = Date.parse(firstIso);
  const secondMs = Date.parse(secondIso);
  if (!Number.isFinite(firstMs)) {
    return secondIso;
  }
  if (!Number.isFinite(secondMs)) {
    return firstIso;
  }
  return secondMs >= firstMs ? secondIso : firstIso;
}

function isGoalCommandMessageText(text: string): boolean {
  return /^\/goal(?:\s|$)/iu.test(stripProviderCommandMarkers(text).trim());
}

function isCodexGoalCompletionMessageText(text: string): boolean {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return (
    /\bgoal\s+(?:completed|complete|finished|done|achieved)\b/iu.test(normalized) ||
    /\bassistant\s+stopping\s+completely\b/iu.test(normalized)
  );
}

function timelineEntryHasCodexGoalCompletionSignal(timelineEntry: TimelineEntry): boolean {
  if (timelineEntry.kind === "message") {
    return (
      timelineEntry.message.role === "assistant" &&
      isCodexGoalCompletionMessageText(timelineEntry.message.text)
    );
  }

  if (timelineEntry.kind !== "work") {
    return false;
  }

  return [timelineEntry.entry.label, timelineEntry.entry.detail]
    .filter((value): value is string => typeof value === "string")
    .some(isCodexGoalCompletionMessageText);
}

function latestGoalState(input: {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly enabled: boolean | undefined;
}): { readonly active: boolean; readonly startedAt: string | null } {
  if (input.enabled !== true) {
    return { active: false, startedAt: null };
  }

  let startedAt: string | null = null;
  let active = false;

  for (const timelineEntry of input.timelineEntries) {
    if (
      timelineEntry?.kind === "message" &&
      timelineEntry.message.role === "user" &&
      isGoalCommandMessageText(timelineEntry.message.text)
    ) {
      startedAt = timelineEntry.message.createdAt;
      active = true;
      continue;
    }

    if (active && timelineEntryHasCodexGoalCompletionSignal(timelineEntry)) {
      startedAt = null;
      active = false;
    }
  }

  return { active, startedAt };
}

export function buildTimelineRows(input: BuildTimelineRowsInput): TimelineRow[] {
  const nextRows: TimelineRow[] = [];
  const terminalAssistantMessageIds = new Set<string>();
  const assistantMessageIdsWithoutLaterUser = new Set<string>();
  const goalState = latestGoalState({
    timelineEntries: input.timelineEntries,
    enabled: input.enableGoalWorkingState,
  });
  const lastAssistantMessageIdByTurnId = new Map<string, string>();
  for (const timelineEntry of input.timelineEntries) {
    if (timelineEntry?.kind !== "message" || timelineEntry.message.role !== "assistant") {
      continue;
    }
    const turnId = timelineEntry.message.turnId;
    if (turnId) {
      lastAssistantMessageIdByTurnId.set(turnId, timelineEntry.id);
      continue;
    }
    terminalAssistantMessageIds.add(timelineEntry.id);
  }
  for (const messageId of lastAssistantMessageIdByTurnId.values()) {
    terminalAssistantMessageIds.add(messageId);
  }
  let seenLaterUserMessage = false;
  for (let index = input.timelineEntries.length - 1; index >= 0; index -= 1) {
    const timelineEntry = input.timelineEntries[index];
    if (timelineEntry?.kind !== "message") {
      continue;
    }
    if (timelineEntry.message.role === "user") {
      seenLaterUserMessage = true;
      continue;
    }
    if (timelineEntry.message.role === "assistant" && !seenLaterUserMessage) {
      assistantMessageIdsWithoutLaterUser.add(timelineEntry.id);
    }
  }
  const activeTurnStartedAtMs =
    typeof input.activeTurnStartedAt === "string"
      ? Date.parse(input.activeTurnStartedAt)
      : Number.NaN;
  const liveWorkEntryId = findTrailingLiveWorkEntryId(input.timelineEntries, {
    activeTurnInProgress: input.activeTurnInProgress,
    activeTurnStartedAtMs,
  });
  const messageDurationStartById = computeMessageDurationStart(
    input.timelineEntries.flatMap((timelineEntry) => {
      if (timelineEntry?.kind !== "message") {
        return [];
      }

      return [
        {
          id: timelineEntry.message.id,
          role: timelineEntry.message.role,
          createdAt: timelineEntry.message.createdAt,
          ...(timelineEntry.message.completedAt
            ? { completedAt: timelineEntry.message.completedAt }
            : {}),
        },
      ];
    }),
  );
  let hasRenderableCurrentTurnOutput = false;
  let lastMessageBoundaryAt: string | null = null;
  let activeTurnPrimaryUserMessageCreatedAt: string | null = null;
  let activeTurnPrimaryUserMessageIsGoalCommand = false;
  let pendingMetaRowId: string | null = null;
  let pendingMetaCreatedAt: string | null = null;
  let pendingMetaEntries: TimelineMetaGroupEntry[] = [];
  let pendingIntentEntries: Array<Extract<TimelineMetaGroupEntry, { kind: "intent" }>> = [];
  let activeLiveIntentText: string | null = null;
  let hiddenCompletedWork: HiddenCompletedWorkAccumulator | null = null;

  const resetPendingMetaEntries = () => {
    pendingMetaEntries = [];
    pendingMetaRowId = null;
    pendingMetaCreatedAt = null;
  };

  const appendPendingIntentEntriesToMeta = (preferredRowId: string | null) => {
    if (pendingIntentEntries.length === 0) {
      return;
    }

    if (!pendingMetaCreatedAt) {
      pendingMetaCreatedAt = pendingIntentEntries[0]?.createdAt ?? null;
    }
    if (!pendingMetaRowId) {
      pendingMetaRowId = preferredRowId ?? pendingIntentEntries[0]?.id ?? null;
    }

    pendingMetaEntries.push(...pendingIntentEntries);
    pendingIntentEntries = [];
  };

  const recordHiddenCompletedWork = (input: {
    id: string;
    startedAt: string;
    endedAt: string;
    hiddenMessageCount: number;
    toolCallCount: number;
  }) => {
    if (!hiddenCompletedWork) {
      hiddenCompletedWork = {
        id: `completed-work-summary:${input.id}`,
        createdAt: input.startedAt,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        entries: [],
        detailRows: [],
        hiddenMessageCount: input.hiddenMessageCount,
        toolCallCount: input.toolCallCount,
      };
      return;
    }

    hiddenCompletedWork = {
      ...hiddenCompletedWork,
      endedAt: latestIso(hiddenCompletedWork.endedAt, input.endedAt),
      hiddenMessageCount: hiddenCompletedWork.hiddenMessageCount + input.hiddenMessageCount,
      toolCallCount: hiddenCompletedWork.toolCallCount + input.toolCallCount,
    };
  };

  const recordHiddenMetaEntries = (
    entries: ReadonlyArray<TimelineMetaGroupEntry>,
    nextEventCreatedAt: string | null,
  ) => {
    const firstEntry = entries[0];
    if (!firstEntry) {
      return;
    }
    const fallbackEndAt = entries.at(-1)?.createdAt ?? firstEntry.createdAt;
    const endedAt = nextEventCreatedAt ?? fallbackEndAt;
    const toolCallCount = entries.filter(
      (entry) => entry.kind === "work" && entry.workEntry.tone === "tool",
    ).length;
    const previousEntries = hiddenCompletedWork?.entries ?? [];
    const previousDetailRows = hiddenCompletedWork?.detailRows ?? [];
    recordHiddenCompletedWork({
      id: firstEntry.id,
      startedAt: firstEntry.createdAt,
      endedAt,
      hiddenMessageCount: 0,
      toolCallCount,
    });
    if (hiddenCompletedWork) {
      hiddenCompletedWork = {
        ...hiddenCompletedWork,
        entries: [...previousEntries, ...entries],
        detailRows: [
          ...previousDetailRows,
          ...buildMetaTimelineRows({
            rowId: firstEntry.id,
            createdAt: firstEntry.createdAt,
            entries,
            nextEventCreatedAt,
          }),
        ],
      };
    }
  };

  const recordHiddenAssistantMessage = (message: TimelineMessage, durationStart: string) => {
    const previousDetailRows = hiddenCompletedWork?.detailRows ?? [];
    recordHiddenCompletedWork({
      id: String(message.id),
      startedAt: message.createdAt,
      endedAt: message.completedAt ?? message.createdAt,
      hiddenMessageCount: 1,
      toolCallCount: 0,
    });
    if (hiddenCompletedWork) {
      hiddenCompletedWork = {
        ...hiddenCompletedWork,
        detailRows: [
          ...previousDetailRows,
          {
            kind: "message",
            id: String(message.id),
            createdAt: message.createdAt,
            message,
            durationStart,
            completionSummary: null,
            isAssistantTurnTerminal: false,
            showAssistantTiming: false,
            showAssistantSummaryByDefault: false,
          },
        ],
      };
    }
  };

  const flushHiddenCompletedWorkSummary = (input: {
    startedAtFloor: string | null;
    endedAt: string | null;
  }) => {
    if (!hiddenCompletedWork) {
      return;
    }
    const startedAt =
      input.startedAtFloor !== null
        ? latestIso(hiddenCompletedWork.startedAt, input.startedAtFloor)
        : hiddenCompletedWork.startedAt;
    nextRows.push({
      kind: "completed-work-summary",
      id: hiddenCompletedWork.id,
      createdAt: startedAt,
      startedAt,
      endedAt: input.endedAt ?? hiddenCompletedWork.endedAt,
      entries: hiddenCompletedWork.entries,
      detailRows: hiddenCompletedWork.detailRows,
      hiddenMessageCount: hiddenCompletedWork.hiddenMessageCount,
      toolCallCount: hiddenCompletedWork.toolCallCount,
    });
    hiddenCompletedWork = null;
  };

  const consumeLatestPendingIntentText = () => {
    const latestIntentText = pendingIntentEntries.at(-1)?.text ?? null;
    pendingIntentEntries = [];
    return latestIntentText;
  };

  const flushPendingMetaEntries = (
    nextEventCreatedAt: string | null,
    options?: { includePendingIntents?: boolean },
  ) => {
    if (options?.includePendingIntents !== false) {
      appendPendingIntentEntriesToMeta(null);
    }

    if (pendingMetaEntries.length === 0 || !pendingMetaRowId || !pendingMetaCreatedAt) {
      resetPendingMetaEntries();
      return;
    }

    const pendingMetaIsInActiveTurn =
      input.activeTurnInProgress &&
      isEventInActiveTurn(pendingMetaCreatedAt, activeTurnStartedAtMs);
    if (input.hideCompletedWorkMessages === true && !pendingMetaIsInActiveTurn) {
      recordHiddenMetaEntries(pendingMetaEntries, nextEventCreatedAt);
      resetPendingMetaEntries();
      return;
    }

    const shouldHideLiveElapsed =
      input.activeTurnInProgress &&
      isEventInActiveTurn(pendingMetaCreatedAt, activeTurnStartedAtMs);
    nextRows.push(
      ...buildMetaTimelineRows({
        rowId: pendingMetaRowId,
        createdAt: pendingMetaCreatedAt,
        entries: pendingMetaEntries,
        nextEventCreatedAt,
        hideElapsed: shouldHideLiveElapsed,
      }),
    );

    resetPendingMetaEntries();
  };

  const pushPendingWorkEntry = (timelineEntry: Extract<TimelineEntry, { kind: "work" }>) => {
    if (timelineEntry.id === liveWorkEntryId) {
      flushPendingMetaEntries(timelineEntry.createdAt, { includePendingIntents: false });
      const liveIntentText = consumeLatestPendingIntentText();
      nextRows.push({
        kind: "work",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        workEntry: withInlineIntentText(timelineEntry.entry, liveIntentText),
      });
      return;
    }

    if (pendingMetaEntries.length === 0) {
      if (pendingIntentEntries.length > 0) {
        pendingMetaEntries = [...pendingIntentEntries];
        pendingMetaCreatedAt = pendingIntentEntries[0]?.createdAt ?? timelineEntry.createdAt;
        pendingIntentEntries = [];
      } else {
        pendingMetaCreatedAt = timelineEntry.createdAt;
      }
      pendingMetaRowId = timelineEntry.id;
    } else {
      appendPendingIntentEntriesToMeta(pendingMetaRowId);
    }

    pendingMetaEntries.push({
      kind: "work",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      workEntry: timelineEntry.entry,
    });
  };

  for (const timelineEntry of input.timelineEntries) {
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      if (isEventInActiveTurn(timelineEntry.createdAt, activeTurnStartedAtMs)) {
        hasRenderableCurrentTurnOutput = true;
      }
      pushPendingWorkEntry(timelineEntry);
      continue;
    }

    if (timelineEntry.kind === "intent") {
      pendingIntentEntries.push({
        kind: "intent",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        text: timelineEntry.text,
      });
      continue;
    }

    flushPendingMetaEntries(timelineEntry.createdAt);

    if (timelineEntry.kind === "proposed-plan") {
      if (isEventInActiveTurn(timelineEntry.createdAt, activeTurnStartedAtMs)) {
        hasRenderableCurrentTurnOutput = true;
      }
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    const { message } = timelineEntry;

    if (message.role === "assistant" && shouldSkipAssistantMessageRow(message)) {
      continue;
    }

    const messageIsInActiveTurn = isEventInActiveTurn(
      timelineEntry.createdAt,
      activeTurnStartedAtMs,
    );
    if (messageIsInActiveTurn) {
      hasRenderableCurrentTurnOutput = true;
    }

    const durationStart = messageDurationStartById.get(message.id) ?? message.createdAt;
    if (message.role === "user") {
      hiddenCompletedWork = null;
      lastMessageBoundaryAt = message.createdAt;
      if (
        Number.isNaN(activeTurnStartedAtMs) ||
        isEventInActiveTurn(timelineEntry.createdAt, activeTurnStartedAtMs)
      ) {
        if (activeTurnPrimaryUserMessageCreatedAt === null) {
          activeTurnPrimaryUserMessageCreatedAt = message.createdAt;
          activeTurnPrimaryUserMessageIsGoalCommand = isGoalCommandMessageText(message.text);
        }
      }
    }

    const messageCompletedAt = message.completedAt;

    if (
      input.hideCompletedWorkMessages === true &&
      message.role === "assistant" &&
      !message.streaming &&
      !terminalAssistantMessageIds.has(timelineEntry.id) &&
      !(input.activeTurnInProgress && messageIsInActiveTurn)
    ) {
      recordHiddenAssistantMessage(message, durationStart);
      if (message.completedAt) {
        lastMessageBoundaryAt = message.completedAt;
      }
      continue;
    }

    if (
      input.hideCompletedWorkMessages === true &&
      message.role === "assistant" &&
      !message.streaming &&
      terminalAssistantMessageIds.has(timelineEntry.id) &&
      !(input.activeTurnInProgress && messageIsInActiveTurn)
    ) {
      flushHiddenCompletedWorkSummary({
        startedAtFloor: durationStart,
        endedAt: messageCompletedAt ?? timelineEntry.createdAt,
      });
    }

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message,
      durationStart,
      completionSummary:
        message.role === "assistant" && input.completionDividerBeforeEntryId === timelineEntry.id
          ? input.completionSummary
          : null,
      isAssistantTurnTerminal:
        message.role === "assistant" && terminalAssistantMessageIds.has(timelineEntry.id),
      showAssistantTiming:
        message.role === "assistant" &&
        terminalAssistantMessageIds.has(timelineEntry.id) &&
        !(
          input.activeTurnInProgress &&
          isEventInActiveTurn(timelineEntry.createdAt, activeTurnStartedAtMs)
        ),
      showAssistantSummaryByDefault:
        timelineEntry.message.role === "assistant" &&
        terminalAssistantMessageIds.has(timelineEntry.id) &&
        assistantMessageIdsWithoutLaterUser.has(timelineEntry.id),
    });

    if (timelineEntry.message.role === "assistant" && timelineEntry.message.completedAt) {
      lastMessageBoundaryAt = timelineEntry.message.completedAt;
    }
  }

  if (input.isWorking && pendingIntentEntries.length > 0) {
    flushPendingMetaEntries(null, { includePendingIntents: false });
    activeLiveIntentText = consumeLatestPendingIntentText();
  } else {
    flushPendingMetaEntries(null);
  }
  flushHiddenCompletedWorkSummary({
    startedAtFloor: lastMessageBoundaryAt,
    endedAt: null,
  });

  const goalWorkingStateEnabled =
    input.enableGoalWorkingState === true &&
    goalState.active &&
    (activeTurnPrimaryUserMessageIsGoalCommand || goalState.startedAt !== null);
  const liveDurationStartAt =
    activeTurnPrimaryUserMessageCreatedAt ?? input.activeTurnStartedAt ?? lastMessageBoundaryAt;

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: liveDurationStartAt,
      mode: hasRenderableCurrentTurnOutput ? "live" : "silent-thinking",
      activity: goalWorkingStateEnabled ? "goal" : "default",
      goalStartedAt: goalWorkingStateEnabled ? goalState.startedAt : null,
      intentText: activeLiveIntentText,
    });
  }

  return nextRows;
}

export function shouldWorkerizeTimelineRows(input: BuildTimelineRowsInput): boolean {
  if (input.activeTurnInProgress || input.isWorking) {
    return false;
  }

  let textBudget = 0;
  let workEntryCount = 0;
  for (const entry of input.timelineEntries) {
    if (!entry) {
      continue;
    }
    if (entry.kind === "message") {
      textBudget += entry.message.text.length;
      continue;
    }
    if (entry.kind === "work") {
      workEntryCount += 1;
      textBudget += entry.entry.label.length;
      textBudget += entry.entry.detail?.length ?? 0;
      continue;
    }
    if (entry.kind === "intent") {
      textBudget += entry.text.length;
      continue;
    }
    if (entry.kind === "proposed-plan") {
      textBudget += entry.proposedPlan.planMarkdown.length;
    }
  }

  return input.timelineEntries.length >= 72 || workEntryCount >= 32 || textBudget >= 40_000;
}

export function estimateTimelineRowsCacheSize(
  input: BuildTimelineRowsInput,
  rows: ReadonlyArray<TimelineRow>,
): number {
  let size = rows.length * 192;
  for (const entry of input.timelineEntries) {
    if (!entry) {
      continue;
    }
    if (entry.kind === "message") {
      size += Math.min(entry.message.text.length, 16_384) * 2;
      continue;
    }
    if (entry.kind === "proposed-plan") {
      size += Math.min(entry.proposedPlan.planMarkdown.length, 12_288) * 2;
      continue;
    }
    if (entry.kind === "intent") {
      size += entry.text.length * 2;
      continue;
    }
    size += (entry.entry.label.length + (entry.entry.detail?.length ?? 0)) * 2;
  }
  return Math.max(4_096, size);
}
