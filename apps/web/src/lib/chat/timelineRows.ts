import { computeMessageDurationStart } from "./messagesTimeline";
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
      intentText: string | null;
    };

export type AssistantTimelineMessageRow = Extract<TimelineRow, { kind: "message" }> & {
  message: AssistantTimelineMessage;
};

export interface BuildTimelineRowsInput {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly activeTurnInProgress: boolean;
  readonly activeTurnStartedAt: string | null;
  readonly completionDividerBeforeEntryId: string | null;
  readonly completionSummary: string | null;
  readonly isWorking: boolean;
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

export function buildTimelineRows(input: BuildTimelineRowsInput): TimelineRow[] {
  const nextRows: TimelineRow[] = [];
  const terminalAssistantMessageIds = new Set<string>();
  const assistantMessageIdsWithoutLaterUser = new Set<string>();
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
  let activeTurnUserMessageCreatedAt: string | null = null;
  let pendingMetaRowId: string | null = null;
  let pendingMetaCreatedAt: string | null = null;
  let pendingMetaEntries: TimelineMetaGroupEntry[] = [];
  let pendingIntentEntries: Array<Extract<TimelineMetaGroupEntry, { kind: "intent" }>> = [];
  let activeLiveIntentText: string | null = null;

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

    if (shouldCollapseMetaEntries(pendingMetaEntries)) {
      const shouldHideLiveElapsed =
        input.activeTurnInProgress &&
        isEventInActiveTurn(pendingMetaCreatedAt, activeTurnStartedAtMs);
      nextRows.push({
        kind: "work-group",
        id: pendingMetaRowId,
        createdAt: pendingMetaCreatedAt,
        entries: pendingMetaEntries,
        summaryEndAt: shouldHideLiveElapsed
          ? null
          : resolveWorkGroupSummaryEndAt(pendingMetaEntries, nextEventCreatedAt),
      });
    } else {
      for (const entry of pendingMetaEntries) {
        if (entry.kind === "work") {
          nextRows.push({
            kind: "work",
            id: entry.id,
            createdAt: entry.createdAt,
            workEntry: entry.workEntry,
          });
          continue;
        }

        nextRows.push({
          kind: "intent",
          id: entry.id,
          createdAt: entry.createdAt,
          text: entry.text,
        });
      }
    }

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

    if (
      timelineEntry.message.role === "assistant" &&
      shouldSkipAssistantMessageRow(timelineEntry.message)
    ) {
      continue;
    }

    if (isEventInActiveTurn(timelineEntry.createdAt, activeTurnStartedAtMs)) {
      hasRenderableCurrentTurnOutput = true;
    }

    const durationStart =
      messageDurationStartById.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;
    if (timelineEntry.message.role === "user") {
      lastMessageBoundaryAt = timelineEntry.message.createdAt;
      if (
        Number.isNaN(activeTurnStartedAtMs) ||
        isEventInActiveTurn(timelineEntry.createdAt, activeTurnStartedAtMs)
      ) {
        activeTurnUserMessageCreatedAt = timelineEntry.message.createdAt;
      }
    }

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart,
      completionSummary:
        timelineEntry.message.role === "assistant" &&
        input.completionDividerBeforeEntryId === timelineEntry.id
          ? input.completionSummary
          : null,
      isAssistantTurnTerminal:
        timelineEntry.message.role === "assistant" &&
        terminalAssistantMessageIds.has(timelineEntry.id),
      showAssistantTiming:
        timelineEntry.message.role === "assistant" &&
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

  const liveDurationStartAt =
    activeTurnUserMessageCreatedAt ?? input.activeTurnStartedAt ?? lastMessageBoundaryAt;

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: liveDurationStartAt,
      mode: hasRenderableCurrentTurnOutput ? "live" : "silent-thinking",
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
