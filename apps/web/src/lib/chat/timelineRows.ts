import { computeMessageDurationStart } from "./messagesTimeline";
import { getChatMessageRenderableText } from "./messageText";
import { stripProviderCommandMarkers } from "../../composer-editor-mentions";
import type { TimelineEntry } from "../../session-logic/types";

export type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
export type UserTimelineMessage = TimelineMessage & { role: "user" };
export type AssistantTimelineMessage = TimelineMessage & { role: "assistant" };
export type SystemTimelineMessage = TimelineMessage & { role: "system" };
type TimelineTurnId = NonNullable<Extract<TimelineEntry, { kind: "intent" }>["turnId"]>;
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
      turnId?: TimelineTurnId | null;
      text: string;
    }
  | {
      kind: "work";
      id: string;
      createdAt: string;
      workEntry: TimelineWorkEntry;
    };

export type TimelineMetaTone = "neutral" | "intent" | "thinking" | "tool" | "error" | "success";

export type TimelineToolSummaryKind =
  | "command"
  | "file-read"
  | "file-change"
  | "web-search"
  | "image-view"
  | "generic-tool";

export type TimelineWorkGroupIconKey =
  | "target"
  | "alert"
  | "terminal"
  | "file-change"
  | "eye"
  | "web-search"
  | "wrench"
  | "brain"
  | "check";

export type TimelineWorkGroupThreadTone =
  | "mixed"
  | "tool"
  | "thinking"
  | "intent"
  | "error"
  | "info";

export interface TimelineToolSummaryCounts {
  readonly command: number;
  readonly fileRead: number;
  readonly fileChange: number;
  readonly webSearch: number;
  readonly imageView: number;
  readonly genericTool: number;
}

export interface TimelineWorkGroupSummaryProjection {
  readonly entryCount: number;
  readonly workEntryCount: number;
  readonly intentCount: number;
  readonly toolCount: number;
  readonly thinkingCount: number;
  readonly errorCount: number;
  readonly infoCount: number;
  readonly toolSummaryCounts: TimelineToolSummaryCounts;
  readonly hasIntentEntries: boolean;
  readonly hasToolEntries: boolean;
  readonly hasThinkingEntries: boolean;
  readonly surfaceTone: TimelineMetaTone;
  readonly threadGroupTone: TimelineWorkGroupThreadTone;
  readonly iconKey: TimelineWorkGroupIconKey;
}

export type TimelineWorkRow = {
  kind: "work";
  id: string;
  createdAt: string;
  workEntry: TimelineWorkEntry;
};

export type TimelineWorkGroupRow = {
  kind: "work-group";
  id: string;
  createdAt: string;
  entries: TimelineMetaGroupEntry[];
  summaryEndAt: string | null;
  summary: TimelineWorkGroupSummaryProjection;
};

export type TimelineIntentRow = {
  kind: "intent";
  id: string;
  createdAt: string;
  text: string;
};

export type TimelineMessageRow = {
  kind: "message";
  id: string;
  createdAt: string;
  message: TimelineMessage;
  durationStart: string;
  completionSummary: string | null;
  isAssistantTurnTerminal?: boolean;
  showAssistantTiming?: boolean;
  showAssistantSummaryByDefault?: boolean;
};

export type TimelineProposedPlanRow = {
  kind: "proposed-plan";
  id: string;
  createdAt: string;
  proposedPlan: TimelineProposedPlan;
};

export type TimelineWorkingRow = {
  kind: "working";
  id: string;
  createdAt: string | null;
  mode: "live" | "silent-thinking";
  activity: "default" | "goal";
  goalStartedAt: string | null;
  intentText: string | null;
};

export type TimelineWorkLogRow = TimelineWorkRow | TimelineWorkGroupRow | TimelineIntentRow;

export type TimelineCompletedWorkDetailRow = TimelineWorkLogRow | TimelineMessageRow;

export type TimelineCompletedWorkDiagnosticRow = TimelineWorkRow;

export type TimelineCompletedWorkSummaryRow = {
  kind: "completed-work-summary";
  id: string;
  createdAt: string;
  startedAt: string;
  endedAt: string;
  entries: TimelineMetaGroupEntry[];
  detailRows: TimelineCompletedWorkDetailRow[];
  visibleDiagnosticRows: TimelineCompletedWorkDiagnosticRow[];
  visibleDiagnosticCacheKey: string;
  hiddenMessageCount: number;
  hiddenThinkingCount: number;
  toolCallCount: number;
};

export type TimelineRow =
  | TimelineCompletedWorkSummaryRow
  | TimelineWorkLogRow
  | TimelineMessageRow
  | TimelineProposedPlanRow
  | TimelineWorkingRow;

export type AssistantTimelineMessageRow = TimelineMessageRow & {
  message: AssistantTimelineMessage;
};

export interface BuildTimelineRowsInput {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly activeTurnInProgress: boolean;
  readonly activeTurnStartedAt: string | null;
  readonly cacheScopeKey?: string;
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

export function classifyTimelineToolSummaryEntry(
  workEntry: TimelineWorkEntry,
): TimelineToolSummaryKind {
  const textHint = `${workEntry.toolTitle ?? ""} ${workEntry.label}`.trim().toLowerCase();
  if (
    workEntry.requestKind === "command" ||
    workEntry.itemType === "command_execution" ||
    textHint.includes("run command") ||
    textHint.includes("execute command")
  ) {
    return "command";
  }
  if (
    workEntry.requestKind === "file-read" ||
    textHint.includes("read file") ||
    textHint.includes("open file") ||
    textHint.includes("inspect file")
  ) {
    return "file-read";
  }
  if (workEntry.itemType === "web_search" || /\b(find|search|grep|ripgrep|glob)\b/.test(textHint)) {
    return "web-search";
  }
  if (
    workEntry.requestKind === "file-change" ||
    workEntry.itemType === "file_change" ||
    (workEntry.changedFiles?.length ?? 0) > 0 ||
    textHint.includes("edit file") ||
    textHint.includes("write file") ||
    textHint.includes("apply patch")
  ) {
    return "file-change";
  }
  if (workEntry.itemType === "image_view") {
    return "image-view";
  }
  return "generic-tool";
}

function resolveTimelineWorkGroupSurfaceTone(input: {
  intentCount: number;
  toolCount: number;
  thinkingCount: number;
  errorCount: number;
}): TimelineMetaTone {
  if (input.errorCount > 0) {
    return "error";
  }
  if (input.thinkingCount > 0 && input.toolCount === 0) {
    return "thinking";
  }
  if (input.toolCount > 0) {
    return "tool";
  }
  if (input.intentCount > 0) {
    return "intent";
  }
  return "success";
}

function resolveTimelineWorkGroupThreadTone(input: {
  intentCount: number;
  toolCount: number;
  thinkingCount: number;
  errorCount: number;
  surfaceTone: TimelineMetaTone;
}): TimelineWorkGroupThreadTone {
  if (input.toolCount > 0) {
    return input.thinkingCount > 0 ? "mixed" : "tool";
  }
  if (input.thinkingCount > 0) {
    return "thinking";
  }
  if (input.intentCount > 0) {
    return "intent";
  }
  return input.surfaceTone === "error" || input.errorCount > 0 ? "error" : "info";
}

function iconKeyForToolSummaryKind(
  classification: TimelineToolSummaryKind | null,
): TimelineWorkGroupIconKey {
  if (classification === "command") return "terminal";
  if (classification === "file-change") return "file-change";
  if (classification === "file-read" || classification === "image-view") return "eye";
  if (classification === "web-search") return "web-search";
  return "wrench";
}

export function buildTimelineWorkGroupSummaryProjection(
  entries: ReadonlyArray<TimelineMetaGroupEntry>,
): TimelineWorkGroupSummaryProjection {
  const toolSummaryCounts = {
    command: 0,
    fileRead: 0,
    fileChange: 0,
    webSearch: 0,
    imageView: 0,
    genericTool: 0,
  };
  let workEntryCount = 0;
  let intentCount = 0;
  let toolCount = 0;
  let thinkingCount = 0;
  let errorCount = 0;
  let infoCount = 0;
  let firstToolClassification: TimelineToolSummaryKind | null = null;
  let hasMixedToolClassifications = false;

  for (const entry of entries) {
    if (entry.kind === "intent") {
      intentCount += 1;
      continue;
    }

    workEntryCount += 1;
    switch (entry.workEntry.tone) {
      case "tool": {
        toolCount += 1;
        const classification = classifyTimelineToolSummaryEntry(entry.workEntry);
        if (firstToolClassification === null) {
          firstToolClassification = classification;
        } else if (firstToolClassification !== classification) {
          hasMixedToolClassifications = true;
        }
        switch (classification) {
          case "command":
            toolSummaryCounts.command += 1;
            break;
          case "file-read":
            toolSummaryCounts.fileRead += 1;
            break;
          case "file-change":
            toolSummaryCounts.fileChange += Math.max(1, entry.workEntry.changedFiles?.length ?? 0);
            break;
          case "web-search":
            toolSummaryCounts.webSearch += 1;
            break;
          case "image-view":
            toolSummaryCounts.imageView += 1;
            break;
          case "generic-tool":
            toolSummaryCounts.genericTool += 1;
            break;
        }
        break;
      }
      case "thinking":
        thinkingCount += 1;
        break;
      case "error":
        errorCount += 1;
        break;
      case "info":
        infoCount += 1;
        break;
      default:
        break;
    }
  }

  const surfaceTone = resolveTimelineWorkGroupSurfaceTone({
    intentCount,
    toolCount,
    thinkingCount,
    errorCount,
  });
  const threadGroupTone = resolveTimelineWorkGroupThreadTone({
    intentCount,
    toolCount,
    thinkingCount,
    errorCount,
    surfaceTone,
  });
  const iconKey =
    workEntryCount === 0
      ? "target"
      : errorCount > 0
        ? "alert"
        : toolCount > 0
          ? iconKeyForToolSummaryKind(hasMixedToolClassifications ? null : firstToolClassification)
          : thinkingCount > 0
            ? "brain"
            : "check";

  return {
    entryCount: entries.length,
    workEntryCount,
    intentCount,
    toolCount,
    thinkingCount,
    errorCount,
    infoCount,
    toolSummaryCounts,
    hasIntentEntries: intentCount > 0,
    hasToolEntries: toolCount > 0,
    hasThinkingEntries: thinkingCount > 0,
    surfaceTone,
    threadGroupTone,
    iconKey,
  };
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
  summary?: TimelineWorkGroupSummaryProjection;
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
        summary: input.summary ?? buildTimelineWorkGroupSummaryProjection(input.entries),
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
  return (
    getChatMessageRenderableText(message).trim().length === 0 &&
    (message.attachments?.length ?? 0) === 0
  );
}

function isVisibleCompletedWorkDiagnosticEntry(
  entry: TimelineMetaGroupEntry,
): entry is Extract<TimelineMetaGroupEntry, { kind: "work" }> {
  return (
    entry.kind === "work" &&
    (entry.workEntry.tone === "error" || entry.workEntry.diagnosticKind !== undefined)
  );
}

function workRowFromMetaEntry(
  entry: Extract<TimelineMetaGroupEntry, { kind: "work" }>,
): TimelineCompletedWorkDiagnosticRow {
  return {
    kind: "work",
    id: entry.id,
    createdAt: entry.createdAt,
    workEntry: entry.workEntry,
  };
}

function collectVisibleCompletedWorkDiagnosticRows(
  detailRows: ReadonlyArray<TimelineCompletedWorkDetailRow>,
): TimelineCompletedWorkDiagnosticRow[] {
  const diagnosticRows: TimelineCompletedWorkDiagnosticRow[] = [];
  for (const detailRow of detailRows) {
    if (detailRow.kind === "work") {
      if (
        detailRow.workEntry.tone === "error" ||
        detailRow.workEntry.diagnosticKind !== undefined
      ) {
        diagnosticRows.push(detailRow);
      }
      continue;
    }

    if (detailRow.kind !== "work-group") {
      continue;
    }

    for (const entry of detailRow.entries) {
      if (isVisibleCompletedWorkDiagnosticEntry(entry)) {
        diagnosticRows.push(workRowFromMetaEntry(entry));
      }
    }
  }
  return diagnosticRows;
}

function completedWorkDiagnosticCacheKeyPart(row: TimelineCompletedWorkDiagnosticRow): string {
  return `${row.id}:${row.workEntry.detail?.length ?? 0}:${row.workEntry.terminalOutput?.length ?? 0}`;
}

function completedWorkDiagnosticsCacheKey(
  rows: ReadonlyArray<TimelineCompletedWorkDiagnosticRow>,
): string {
  return rows.length === 0 ? "none" : rows.map(completedWorkDiagnosticCacheKeyPart).join(",");
}

type HiddenCompletedWorkAccumulator = {
  id: string;
  createdAt: string;
  startedAt: string;
  endedAt: string;
  turnId: TimelineTurnId | null;
  entries: TimelineMetaGroupEntry[];
  detailRows: TimelineCompletedWorkDetailRow[];
  visibleDiagnosticRows: TimelineCompletedWorkDiagnosticRow[];
  visibleDiagnosticCacheKeyParts: string[];
  hiddenMessageCount: number;
  hiddenThinkingCount: number;
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

function timelineTurnIdsMatch(left: TimelineTurnId | null, right: TimelineTurnId | null): boolean {
  return left === right || left === null || right === null;
}

function metaEntryTurnId(entry: TimelineMetaGroupEntry): TimelineTurnId | null {
  if (entry.kind === "intent") {
    return entry.turnId ?? null;
  }
  return entry.workEntry.turnId ?? null;
}

function resolveMetaEntriesTurnId(
  entries: ReadonlyArray<TimelineMetaGroupEntry>,
): TimelineTurnId | null {
  let resolvedTurnId: TimelineTurnId | null = null;
  for (const entry of entries) {
    const entryTurnId = metaEntryTurnId(entry);
    if (entryTurnId === null) {
      continue;
    }
    if (resolvedTurnId !== null && resolvedTurnId !== entryTurnId) {
      return null;
    }
    resolvedTurnId = entryTurnId;
  }
  return resolvedTurnId;
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
  const fallbackAssistantMessageIdsBySegment = new Map<number, string[]>();
  const lastFallbackAssistantMessageIdBySegment = new Map<number, string>();
  let fallbackTurnSegmentIndex = 0;
  for (const timelineEntry of input.timelineEntries) {
    if (timelineEntry?.kind !== "message") {
      continue;
    }
    if (timelineEntry.message.role === "user") {
      fallbackTurnSegmentIndex += 1;
      continue;
    }
    if (timelineEntry.message.role !== "assistant") continue;
    const turnId = timelineEntry.message.turnId;
    if (turnId) {
      lastAssistantMessageIdByTurnId.set(turnId, timelineEntry.id);
      continue;
    }
    const segmentMessageIds = fallbackAssistantMessageIdsBySegment.get(fallbackTurnSegmentIndex);
    if (segmentMessageIds) {
      segmentMessageIds.push(timelineEntry.id);
    } else {
      fallbackAssistantMessageIdsBySegment.set(fallbackTurnSegmentIndex, [timelineEntry.id]);
    }
    lastFallbackAssistantMessageIdBySegment.set(fallbackTurnSegmentIndex, timelineEntry.id);
  }
  for (const messageId of lastAssistantMessageIdByTurnId.values()) {
    terminalAssistantMessageIds.add(messageId);
  }
  for (const messageId of lastFallbackAssistantMessageIdBySegment.values()) {
    terminalAssistantMessageIds.add(messageId);
  }
  if (input.activeTurnInProgress) {
    for (const messageId of fallbackAssistantMessageIdsBySegment.get(fallbackTurnSegmentIndex) ??
      []) {
      terminalAssistantMessageIds.add(messageId);
    }
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
  let pendingMetaTurnId: TimelineTurnId | null = null;
  let pendingMetaEntries: TimelineMetaGroupEntry[] = [];
  let pendingIntentEntries: Array<Extract<TimelineMetaGroupEntry, { kind: "intent" }>> = [];
  let activeLiveIntentText: string | null = null;
  let hiddenCompletedWork: HiddenCompletedWorkAccumulator | null = null;

  const resetPendingMetaEntries = () => {
    pendingMetaEntries = [];
    pendingMetaRowId = null;
    pendingMetaCreatedAt = null;
    pendingMetaTurnId = null;
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
    if (pendingMetaTurnId === null) {
      pendingMetaTurnId = resolveMetaEntriesTurnId(pendingIntentEntries);
    }

    pendingMetaEntries.push(...pendingIntentEntries);
    pendingIntentEntries = [];
  };

  const recordHiddenCompletedWork = (input: {
    id: string;
    startedAt: string;
    endedAt: string;
    turnId: TimelineTurnId | null;
    hiddenMessageCount: number;
    hiddenThinkingCount: number;
    toolCallCount: number;
  }) => {
    if (hiddenCompletedWork && !timelineTurnIdsMatch(hiddenCompletedWork.turnId, input.turnId)) {
      flushHiddenCompletedWorkSummary({
        startedAtFloor: null,
        endedAt: null,
      });
    }

    if (!hiddenCompletedWork) {
      hiddenCompletedWork = {
        id: `completed-work-summary:${input.id}`,
        createdAt: input.startedAt,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        turnId: input.turnId,
        entries: [],
        detailRows: [],
        visibleDiagnosticRows: [],
        visibleDiagnosticCacheKeyParts: [],
        hiddenMessageCount: input.hiddenMessageCount,
        hiddenThinkingCount: input.hiddenThinkingCount,
        toolCallCount: input.toolCallCount,
      };
      return;
    }

    hiddenCompletedWork = {
      ...hiddenCompletedWork,
      endedAt: latestIso(hiddenCompletedWork.endedAt, input.endedAt),
      turnId: hiddenCompletedWork.turnId ?? input.turnId,
      hiddenMessageCount: hiddenCompletedWork.hiddenMessageCount + input.hiddenMessageCount,
      hiddenThinkingCount: hiddenCompletedWork.hiddenThinkingCount + input.hiddenThinkingCount,
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
    const summary = buildTimelineWorkGroupSummaryProjection(entries);
    const detailRows = buildMetaTimelineRows({
      rowId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      entries,
      nextEventCreatedAt,
      summary,
    });
    const visibleDiagnosticRows = collectVisibleCompletedWorkDiagnosticRows(detailRows);
    const previousEntries = hiddenCompletedWork?.entries ?? [];
    const previousDetailRows = hiddenCompletedWork?.detailRows ?? [];
    const previousVisibleDiagnosticRows = hiddenCompletedWork?.visibleDiagnosticRows ?? [];
    const previousVisibleDiagnosticCacheKeyParts =
      hiddenCompletedWork?.visibleDiagnosticCacheKeyParts ?? [];
    recordHiddenCompletedWork({
      id: firstEntry.id,
      startedAt: firstEntry.createdAt,
      endedAt,
      turnId: resolveMetaEntriesTurnId(entries),
      hiddenMessageCount: 0,
      hiddenThinkingCount: summary.thinkingCount,
      toolCallCount: summary.toolCount,
    });
    if (hiddenCompletedWork) {
      hiddenCompletedWork = {
        ...hiddenCompletedWork,
        entries: [...previousEntries, ...entries],
        detailRows: [...previousDetailRows, ...detailRows],
        visibleDiagnosticRows: [...previousVisibleDiagnosticRows, ...visibleDiagnosticRows],
        visibleDiagnosticCacheKeyParts: [
          ...previousVisibleDiagnosticCacheKeyParts,
          ...visibleDiagnosticRows.map(completedWorkDiagnosticCacheKeyPart),
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
      turnId: message.turnId ?? null,
      hiddenMessageCount: 1,
      hiddenThinkingCount: 0,
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

  function flushHiddenCompletedWorkSummary(input: {
    startedAtFloor: string | null;
    endedAt: string | null;
  }): void {
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
      visibleDiagnosticRows: hiddenCompletedWork.visibleDiagnosticRows,
      visibleDiagnosticCacheKey:
        hiddenCompletedWork.visibleDiagnosticCacheKeyParts.length === 0
          ? completedWorkDiagnosticsCacheKey(hiddenCompletedWork.visibleDiagnosticRows)
          : hiddenCompletedWork.visibleDiagnosticCacheKeyParts.join(","),
      hiddenMessageCount: hiddenCompletedWork.hiddenMessageCount,
      hiddenThinkingCount: hiddenCompletedWork.hiddenThinkingCount,
      toolCallCount: hiddenCompletedWork.toolCallCount,
    });
    hiddenCompletedWork = null;
  }

  const flushOrDiscardHiddenCompletedWorkAtBoundary = () => {
    if (!hiddenCompletedWork) {
      return;
    }
    if (lastMessageBoundaryAt === null) {
      hiddenCompletedWork = null;
      return;
    }
    flushHiddenCompletedWorkSummary({
      startedAtFloor: lastMessageBoundaryAt,
      endedAt: null,
    });
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
    const workTurnId = timelineEntry.entry.turnId ?? null;
    if (pendingIntentEntries.length > 0) {
      const pendingIntentTurnId = resolveMetaEntriesTurnId(pendingIntentEntries);
      if (!timelineTurnIdsMatch(pendingIntentTurnId, workTurnId)) {
        flushPendingMetaEntries(timelineEntry.createdAt);
      }
    }
    if (pendingMetaEntries.length > 0 && !timelineTurnIdsMatch(pendingMetaTurnId, workTurnId)) {
      flushPendingMetaEntries(timelineEntry.createdAt);
    }

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
        pendingMetaTurnId = resolveMetaEntriesTurnId(pendingIntentEntries) ?? workTurnId;
        pendingIntentEntries = [];
      } else {
        pendingMetaCreatedAt = timelineEntry.createdAt;
        pendingMetaTurnId = workTurnId;
      }
      pendingMetaRowId = timelineEntry.id;
    } else {
      appendPendingIntentEntriesToMeta(pendingMetaRowId);
      if (pendingMetaTurnId === null) {
        pendingMetaTurnId = workTurnId;
      }
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
        turnId: timelineEntry.turnId ?? null,
        text: timelineEntry.text,
      });
      continue;
    }

    const pendingMetaNextEventCreatedAt =
      timelineEntry.kind === "message" && timelineEntry.message.role === "user"
        ? null
        : timelineEntry.createdAt;
    flushPendingMetaEntries(pendingMetaNextEventCreatedAt);

    if (timelineEntry.kind === "proposed-plan") {
      if (isEventInActiveTurn(timelineEntry.createdAt, activeTurnStartedAtMs)) {
        hasRenderableCurrentTurnOutput = true;
      }
      flushOrDiscardHiddenCompletedWorkAtBoundary();
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
      flushOrDiscardHiddenCompletedWorkAtBoundary();
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
    } else if (message.role === "system") {
      flushOrDiscardHiddenCompletedWorkAtBoundary();
    }

    const messageCompletedAt = message.completedAt;

    if (
      input.hideCompletedWorkMessages === true &&
      message.role === "assistant" &&
      !goalState.active &&
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
