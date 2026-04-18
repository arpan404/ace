import { type MessageId, type TurnId } from "@ace/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Fragment, memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { estimateTimelineMessageHeight } from "../../lib/chat/timelineHeight";
import {
  getChatMessageRenderableText,
  resolveAssistantMessageRenderHint,
} from "../../lib/chat/messageText";
import { deriveTimelineEntries } from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  ArrowLeftRightIcon,
  CheckIcon,
  CircleAlertIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Clock3Icon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import { normalizeCompactToolLabel } from "~/lib/chat/messagesTimeline";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@ace/contracts/settings";
import { formatTimestamp } from "../../timestampFormat";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "~/lib/chat/userMessageTerminalContexts";

const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;
const TIMELINE_VIRTUALIZER_OVERSCAN = 12;
const MAX_TIMELINE_ROW_HEIGHT_CACHE_ENTRIES = 4_096;

const timelineRowHeightCache = new Map<string, number>();

function readCachedTimelineRowHeight(cacheKey: string): number | null {
  const cachedHeight = timelineRowHeightCache.get(cacheKey);
  if (cachedHeight === undefined) {
    return null;
  }

  timelineRowHeightCache.delete(cacheKey);
  timelineRowHeightCache.set(cacheKey, cachedHeight);
  return cachedHeight;
}

function writeCachedTimelineRowHeight(cacheKey: string, height: number): number {
  timelineRowHeightCache.set(cacheKey, height);
  if (timelineRowHeightCache.size > MAX_TIMELINE_ROW_HEIGHT_CACHE_ENTRIES) {
    const oldestCacheKey = timelineRowHeightCache.keys().next().value;
    if (oldestCacheKey !== undefined) {
      timelineRowHeightCache.delete(oldestCacheKey);
    }
  }
  return height;
}

function toTimelineWidthCacheKey(timelineWidthPx: number | null): string {
  if (timelineWidthPx === null || !Number.isFinite(timelineWidthPx)) {
    return "auto";
  }
  return String(Math.max(0, Math.round(timelineWidthPx / 4) * 4));
}

interface MessagesTimelineProps {
  hasMessages: boolean;
  isWorking: boolean;
  onStartConversationFromMessage?: (() => void) | null;
  onContinueWithGitHubIssues?: (() => void) | null;
  isContinueWithGitHubIssuesDisabled?: boolean;
  continueWithGitHubIssuesDisabledReason?: string;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  scrollContainer: HTMLDivElement | null;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  revertActionTitle?: string;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  markdownCwd: string | undefined;
  onOpenBrowserUrl?: ((url: string) => void) | null;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
}

export const MessagesTimeline = memo(function MessagesTimeline({
  hasMessages,
  isWorking,
  onStartConversationFromMessage = null,
  onContinueWithGitHubIssues = null,
  isContinueWithGitHubIssuesDisabled = false,
  continueWithGitHubIssuesDisabledReason,
  activeTurnInProgress,
  activeTurnStartedAt,
  scrollContainer,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  revertActionTitle = "Revert to this message",
  isRevertingCheckpoint,
  onImageExpand,
  markdownCwd,
  onOpenBrowserUrl = null,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
}: MessagesTimelineProps) {
  const rows = useMemo<TimelineRow[]>(
    () =>
      buildTimelineRows({
        timelineEntries,
        activeTurnInProgress,
        activeTurnStartedAt,
        completionDividerBeforeEntryId,
        completionSummary,
        isWorking,
      }),
    [
      activeTurnInProgress,
      timelineEntries,
      completionDividerBeforeEntryId,
      completionSummary,
      isWorking,
      activeTurnStartedAt,
    ],
  );
  const latestAssistantTurnSummary = useMemo(
    () =>
      resolveLatestAssistantTurnDiffSummary(timelineEntries, turnDiffSummaryByAssistantMessageId),
    [timelineEntries, turnDiffSummaryByAssistantMessageId],
  );
  const [allDirectoriesExpandedByTurnId, setAllDirectoriesExpandedByTurnId] = useState<
    Record<string, boolean>
  >({});
  const [timelineRootElement, setTimelineRootElement] = useState<HTMLDivElement | null>(null);
  const [timelineWidthPx, setTimelineWidthPx] = useState<number | null>(null);
  const onToggleAllDirectories = useCallback((turnId: TurnId) => {
    setAllDirectoriesExpandedByTurnId((current) => ({
      ...current,
      [turnId]: !(current[turnId] ?? false),
    }));
  }, []);

  useEffect(() => {
    if (!timelineRootElement) {
      setTimelineWidthPx(null);
      return;
    }

    const updateWidth = () => {
      const nextWidth = timelineRootElement.getBoundingClientRect().width;
      setTimelineWidthPx((current) =>
        current !== null && Math.abs(current - nextWidth) < 0.5 ? current : nextWidth,
      );
    };

    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => updateWidth());
    observer.observe(timelineRootElement);
    return () => observer.disconnect();
  }, [timelineRootElement]);

  const firstUnvirtualizedRowIndex = useMemo(
    () =>
      deriveFirstUnvirtualizedTimelineRowIndex(rows, {
        activeTurnInProgress,
        activeTurnStartedAt,
        preserveCurrentTurnTail: true,
      }),
    [activeTurnInProgress, activeTurnStartedAt, rows],
  );
  const virtualizedRows = useMemo(
    () => rows.slice(0, firstUnvirtualizedRowIndex),
    [firstUnvirtualizedRowIndex, rows],
  );
  const trailingRows = useMemo(
    () => rows.slice(firstUnvirtualizedRowIndex),
    [firstUnvirtualizedRowIndex, rows],
  );
  const getVirtualRowKey = useCallback(
    (index: number) => virtualizedRows[index]?.id ?? index,
    [virtualizedRows],
  );
  const estimateVirtualizedRowSize = useCallback(
    (index: number) =>
      estimateTimelineRowHeight(virtualizedRows[index], {
        timelineWidthPx,
        expandedWorkGroups,
      }),
    [expandedWorkGroups, timelineWidthPx, virtualizedRows],
  );
  const virtualizedRowsMeasurementKey = useMemo(
    () =>
      virtualizedRows
        .map((row) =>
          getTimelineRowHeightCacheKey(row, {
            timelineWidthPx,
            expandedWorkGroups,
          }),
        )
        .join("|"),
    [expandedWorkGroups, timelineWidthPx, virtualizedRows],
  );
  const rowVirtualizer = useVirtualizer({
    count: virtualizedRows.length,
    estimateSize: estimateVirtualizedRowSize,
    getItemKey: getVirtualRowKey,
    getScrollElement: () => scrollContainer,
    overscan: TIMELINE_VIRTUALIZER_OVERSCAN,
  });

  useEffect(() => {
    if (virtualizedRows.length === 0) {
      return;
    }
    rowVirtualizer.measure();
  }, [rowVirtualizer, virtualizedRows.length, virtualizedRowsMeasurementKey]);
  const shouldUseVirtualizedBuffer =
    scrollContainer !== null && virtualizedRows.length > 0 && !activeTurnInProgress;

  const renderRowContent = (row: TimelineRow, _rowIndex: number) => {
    return (
      <div
        className="group/timeline relative pb-3"
        data-timeline-row-kind={row.kind}
        data-message-id={row.kind === "message" ? row.message.id : undefined}
        data-message-role={row.kind === "message" ? row.message.role : undefined}
      >
        {row.kind === "work" && (
          <div className="min-w-0 py-0.5">
            <SimpleWorkEntryRow
              workEntry={row.workEntry}
              inlineIntentText={row.workEntry.intentText ?? null}
            />
          </div>
        )}

        {row.kind === "work-group" &&
          (() => {
            const groupId = workGroupId(row.id);
            const isExpanded = expandedWorkGroups[groupId] ?? false;
            const ChevronIcon = isExpanded ? ChevronDownIcon : ChevronRightIcon;
            const disclosureLabel = summarizeWorkGroupLabel(row.entries, row.summaryEndAt);
            const breakdownParts = summarizeWorkGroupBreakdownParts(row.entries);
            const hasThinkingEntries = row.entries.some(
              (entry) => entry.kind === "work" && entry.workEntry.tone === "thinking",
            );
            const hasToolEntries = row.entries.some(
              (entry) => entry.kind === "work" && entry.workEntry.tone === "tool",
            );
            const hasIntentEntries = row.entries.some((entry) => entry.kind === "intent");
            const surfaceTone = resolveMetaGroupTone(row.entries);
            const elapsedLabel = summarizeWorkGroupElapsedLabel(row.entries, row.summaryEndAt);
            const threadGroupTone = hasToolEntries
              ? hasThinkingEntries
                ? "mixed"
                : "tool"
              : hasThinkingEntries
                ? "thinking"
                : hasIntentEntries
                  ? "intent"
                  : surfaceTone === "error"
                    ? "error"
                    : "info";

            return (
              <div className="min-w-0 py-0.5" data-thread-group={threadGroupTone}>
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => onToggleWorkGroup(groupId)}
                  data-meta-disclosure="true"
                  data-meta-disclosure-open={String(isExpanded)}
                  data-thinking-disclosure={hasThinkingEntries ? "true" : undefined}
                  data-thinking-disclosure-open={
                    hasThinkingEntries ? String(isExpanded) : undefined
                  }
                  data-tool-disclosure={hasToolEntries ? "true" : undefined}
                  data-tool-disclosure-open={hasToolEntries ? String(isExpanded) : undefined}
                >
                  <div className="flex min-w-0 items-center gap-2.5 border-border/45 border-b pb-1.5 transition-colors duration-100 hover:text-foreground/92">
                    <ChevronIcon
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground/52 transition-transform duration-150",
                        metaToneTextClass(surfaceTone),
                      )}
                    />
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[12px] leading-5 text-foreground/82">
                        {breakdownParts.map((part, index) => (
                          <Fragment key={`${row.id}:summary:${part.label}:${part.count}`}>
                            {index > 0 && (
                              <span className="shrink-0 text-muted-foreground/30">·</span>
                            )}
                            <span
                              className="min-w-0 truncate"
                              title={`${part.count} ${part.label}`}
                            >
                              {part.count} {part.label}
                            </span>
                          </Fragment>
                        ))}
                      </div>
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground/52">
                      <Clock3Icon className="size-3 shrink-0" />
                      <span>{elapsedLabel ?? disclosureLabel}</span>
                    </div>
                  </div>
                </button>
                {isExpanded && (
                  <div className="mt-2 space-y-2 border-border/40 border-l pl-4">
                    {row.entries.map((entry) =>
                      entry.kind === "work" ? (
                        <SimpleWorkEntryRow
                          key={`work-group:${row.id}:${entry.id}`}
                          workEntry={entry.workEntry}
                          inlineIntentText={null}
                          variant="nested"
                        />
                      ) : (
                        <SimpleIntentEntryRow
                          key={`work-group:${row.id}:${entry.id}`}
                          entry={entry}
                          variant="nested"
                        />
                      ),
                    )}
                  </div>
                )}
              </div>
            );
          })()}

        {row.kind === "intent" && (
          <div className="min-w-0 py-0.5" data-intent-message="true">
            <SimpleIntentEntryRow entry={row} variant="standalone" />
          </div>
        )}

        {row.kind === "message" && isUserTimelineMessage(row.message) && (
          <UserMessageTimelineRow
            canRevertAgentWork={revertTurnCountByUserMessageId.has(row.message.id)}
            isRevertingCheckpoint={isRevertingCheckpoint}
            isWorking={isWorking}
            message={row.message}
            onImageExpand={onImageExpand}
            onRevertUserMessage={onRevertUserMessage}
            revertActionTitle={revertActionTitle}
            timestampFormat={timestampFormat}
          />
        )}

        {row.kind === "message" && isSystemTimelineMessage(row.message) && (
          <SystemMessageTimelineRow message={row.message} />
        )}

        {row.kind === "message" &&
          isAssistantTimelineMessage(row.message) &&
          (() => (
            <AssistantMessageTimelineRow
              completionSummary={row.completionSummary}
              markdownCwd={markdownCwd}
              message={row.message}
              onOpenBrowserUrl={onOpenBrowserUrl}
            />
          ))()}

        {row.kind === "proposed-plan" && (
          <ProposedPlanTimelineRow
            cwd={markdownCwd}
            onOpenBrowserUrl={onOpenBrowserUrl}
            proposedPlan={row.proposedPlan}
            workspaceRoot={workspaceRoot}
          />
        )}

        {row.kind === "working" && (
          <div className="min-w-0 py-1">
            <div className="flex items-center gap-2.5 text-[12px] text-muted-foreground/72">
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/28 animate-pulse" />
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/24 animate-pulse [animation-delay:200ms]" />
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/20 animate-pulse [animation-delay:400ms]" />
              </span>
              <span>
                {row.createdAt ? (
                  <WorkingTimer
                    createdAt={row.createdAt}
                    label={row.mode === "silent-thinking" ? "Getting started for" : "Working for"}
                  />
                ) : row.mode === "silent-thinking" ? (
                  "Getting started..."
                ) : (
                  "Working..."
                )}
              </span>
            </div>
            {row.intentText && (
              <p
                className="mt-1 pl-5 text-[11px] leading-5 text-muted-foreground/66"
                data-inline-intent="true"
              >
                <span className="mr-1 text-[9px] uppercase tracking-[0.14em] text-muted-foreground/38">
                  Intent
                </span>
                <span className="text-foreground/72">{row.intentText}</span>
              </p>
            )}
          </div>
        )}
      </div>
    );
  };

  if (!hasMessages && !isWorking) {
    const showConversationStarters =
      onStartConversationFromMessage !== null || onContinueWithGitHubIssues !== null;
    if (!showConversationStarters) {
      return (
        <div className="flex h-full items-center justify-center">
          <p className="text-sm text-muted-foreground/45">Start by sending a message.</p>
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="max-w-xl text-center">
          <p className="font-medium text-foreground/88 text-sm">Start this conversation</p>
          <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
            Write a message or{" "}
            {onContinueWithGitHubIssues !== null ? (
              <button
                type="button"
                onClick={() => onContinueWithGitHubIssues()}
                disabled={isContinueWithGitHubIssuesDisabled}
                title={continueWithGitHubIssuesDisabledReason}
                className={cn(
                  "inline p-0 h-auto min-h-0 border-0 bg-transparent font-inherit underline underline-offset-2",
                  "cursor-pointer text-primary hover:text-primary/90",
                  "disabled:cursor-not-allowed disabled:opacity-50 disabled:text-muted-foreground disabled:hover:text-muted-foreground",
                )}
              >
                continue with an open GitHub issue
              </button>
            ) : (
              "continue with an open GitHub issue"
            )}
            .
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={setTimelineRootElement}
      data-timeline-root="true"
      className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden"
    >
      {shouldUseVirtualizedBuffer ? (
        <div
          data-virtualizer-buffer="true"
          className="relative"
          style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = virtualizedRows[virtualRow.index];
            if (!row) {
              return null;
            }
            return (
              <div
                key={`row:${row.id}`}
                ref={rowVirtualizer.measureElement}
                data-index={virtualRow.index}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderRowContent(row, virtualRow.index)}
              </div>
            );
          })}
        </div>
      ) : (
        virtualizedRows.map((row, index) => (
          <div key={`row:${row.id}`}>{renderRowContent(row, index)}</div>
        ))
      )}
      {trailingRows.map((row, index) => (
        <div key={`row:${row.id}`}>{renderRowContent(row, virtualizedRows.length + index)}</div>
      ))}
      {latestAssistantTurnSummary && (
        <div
          className="group/timeline relative pb-3"
          data-timeline-row-kind="assistant-diff-summary"
        >
          <div className="rounded-xl border border-border/45 bg-background/35 px-4 py-3">
            <AssistantMessageTurnDiffSummary
              allDirectoriesExpanded={
                allDirectoriesExpandedByTurnId[latestAssistantTurnSummary.turnId] ?? false
              }
              onOpenTurnDiff={onOpenTurnDiff}
              onToggleAllDirectories={onToggleAllDirectories}
              resolvedTheme={resolvedTheme}
              turnSummary={latestAssistantTurnSummary}
            />
          </div>
        </div>
      )}
    </div>
  );
});

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type UserTimelineMessage = TimelineMessage & { role: "user" };
type AssistantTimelineMessage = TimelineMessage & { role: "assistant" };
type SystemTimelineMessage = TimelineMessage & { role: "system" };
type TimelineProposedPlan = Extract<TimelineEntry, { kind: "proposed-plan" }>["proposedPlan"];
type TimelineWorkEntry = Extract<TimelineEntry, { kind: "work" }>["entry"];
type TimelineMetaGroupEntry =
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
type TimelineRow =
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

export function deriveFirstUnvirtualizedTimelineRowIndex(
  rows: ReadonlyArray<TimelineRow>,
  input: {
    activeTurnInProgress: boolean;
    activeTurnStartedAt: string | null;
    preserveCurrentTurnTail: boolean;
  },
): number {
  const firstTailRowIndex = Math.max(rows.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS, 0);
  if (!input.activeTurnInProgress || !input.preserveCurrentTurnTail) {
    return firstTailRowIndex;
  }

  const turnStartedAtMs =
    typeof input.activeTurnStartedAt === "string"
      ? Date.parse(input.activeTurnStartedAt)
      : Number.NaN;
  let firstCurrentTurnRowIndex = -1;
  if (!Number.isNaN(turnStartedAtMs)) {
    firstCurrentTurnRowIndex = rows.findIndex((row) => {
      if (row.kind === "working") return true;
      if (!row.createdAt) return false;
      const rowCreatedAtMs = Date.parse(row.createdAt);
      return !Number.isNaN(rowCreatedAtMs) && rowCreatedAtMs >= turnStartedAtMs;
    });
  }

  if (firstCurrentTurnRowIndex < 0) {
    firstCurrentTurnRowIndex = rows.findIndex(
      (row) => row.kind === "message" && row.message.role === "assistant" && row.message.streaming,
    );
  }

  if (firstCurrentTurnRowIndex < 0) return firstTailRowIndex;

  for (let index = firstCurrentTurnRowIndex - 1; index >= 0; index -= 1) {
    const previousRow = rows[index];
    if (!previousRow || previousRow.kind !== "message") continue;
    if (previousRow.message.role === "user") {
      return Math.min(index, firstTailRowIndex);
    }
    if (previousRow.message.role === "assistant" && !previousRow.message.streaming) {
      break;
    }
  }

  return Math.min(firstCurrentTurnRowIndex, firstTailRowIndex);
}

function formatElapsedSeconds(elapsedSeconds: number): string {
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** Self-contained timer that re-renders only itself every second. */
const WorkingTimer = memo(function WorkingTimer({
  createdAt,
  label,
}: {
  createdAt: string;
  label: string;
}) {
  const startedAtMs = Date.parse(createdAt);
  const [elapsed, setElapsed] = useState(() =>
    Number.isFinite(startedAtMs) ? Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)) : 0,
  );

  useEffect(() => {
    if (!Number.isFinite(startedAtMs)) return;
    const timer = window.setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [startedAtMs]);

  return (
    <>
      {label} {formatElapsedSeconds(elapsed)}
    </>
  );
});

function buildTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  isWorking: boolean;
}): TimelineRow[] {
  const nextRows: TimelineRow[] = [];
  const activeTurnStartedAtMs =
    typeof input.activeTurnStartedAt === "string"
      ? Date.parse(input.activeTurnStartedAt)
      : Number.NaN;
  const liveWorkEntryId = findTrailingLiveWorkEntryId(input.timelineEntries, {
    activeTurnInProgress: input.activeTurnInProgress,
    activeTurnStartedAtMs,
  });
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
      nextRows.push({
        kind: "work-group",
        id: pendingMetaRowId,
        createdAt: pendingMetaCreatedAt,
        entries: pendingMetaEntries,
        summaryEndAt: resolveWorkGroupSummaryEndAt(pendingMetaEntries, nextEventCreatedAt),
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

    const durationStart = lastMessageBoundaryAt ?? timelineEntry.message.createdAt;
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

function workGroupId(rowId: string): string {
  return `work-group:${rowId}`;
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

function isEventInActiveTurn(createdAt: string, activeTurnStartedAtMs: number): boolean {
  if (Number.isNaN(activeTurnStartedAtMs)) {
    return false;
  }
  const createdAtMs = Date.parse(createdAt);
  return !Number.isNaN(createdAtMs) && createdAtMs >= activeTurnStartedAtMs;
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

function getUserMessageTextForHeightEstimate(userPromptText: string): string {
  const displayedUserMessage = deriveDisplayedUserMessageState(userPromptText);
  if (displayedUserMessage.visibleText.trim().length > 0) {
    return displayedUserMessage.visibleText;
  }
  if (displayedUserMessage.contexts.length > 0) {
    return displayedUserMessage.contexts.map((context) => context.header).join(" ");
  }
  return userPromptText;
}

function estimateTimelineRowHeight(
  row: TimelineRow | undefined,
  input: {
    timelineWidthPx: number | null;
    expandedWorkGroups: Record<string, boolean>;
  },
): number {
  if (!row) {
    return 96;
  }

  const cacheKey = getTimelineRowHeightCacheKey(row, input);
  const cachedHeight = readCachedTimelineRowHeight(cacheKey);
  if (cachedHeight !== null) {
    return cachedHeight;
  }

  let height: number;
  switch (row.kind) {
    case "message": {
      const assistantRenderHint =
        row.message.role === "assistant"
          ? resolveAssistantMessageRenderHint(row.message)
          : "full-text";
      const renderedMessageText =
        row.message.role === "assistant"
          ? getChatMessageRenderableText(row.message)
          : getUserMessageTextForHeightEstimate(row.message.text);
      const messageText =
        row.message.role === "assistant" &&
        renderedMessageText.trim().length === 0 &&
        !row.message.streaming
          ? "(empty response)"
          : renderedMessageText;
      const messageHeightInput =
        row.message.attachments === undefined
          ? {
              role: row.message.role,
              text: messageText,
              ...(row.message.role === "assistant" ? { assistantRenderHint } : {}),
            }
          : {
              role: row.message.role,
              text: messageText,
              attachments: row.message.attachments,
              ...(row.message.role === "assistant" ? { assistantRenderHint } : {}),
            };
      const messageHeight = estimateTimelineMessageHeight(messageHeightInput, {
        timelineWidthPx: input.timelineWidthPx,
      });
      if (row.message.role !== "assistant") {
        height = messageHeight + 18;
        break;
      }
      const completionSummaryExtra = row.completionSummary ? 24 : 0;
      height = messageHeight + completionSummaryExtra + 16;
      break;
    }
    case "work":
      height = row.workEntry.detail || row.workEntry.command ? 84 : 52;
      break;
    case "work-group": {
      const collapsedHeight = 64;
      const isExpanded = input.expandedWorkGroups[workGroupId(row.id)] ?? false;
      height = isExpanded ? collapsedHeight + row.entries.length * 52 : collapsedHeight;
      break;
    }
    case "intent":
      height = 56;
      break;
    case "proposed-plan":
      height = 160 + Math.min(12, Math.ceil(row.proposedPlan.planMarkdown.length / 120)) * 24;
      break;
    case "working":
      height = row.intentText ? 90 : 60;
      break;
  }

  return writeCachedTimelineRowHeight(cacheKey, height);
}

function getTimelineRowHeightCacheKey(
  row: TimelineRow | undefined,
  input: {
    timelineWidthPx: number | null;
    expandedWorkGroups: Record<string, boolean>;
  },
): string {
  if (!row) {
    return "empty";
  }

  const widthCacheKey = toTimelineWidthCacheKey(input.timelineWidthPx);
  switch (row.kind) {
    case "message": {
      const assistantRenderHint =
        row.message.role === "assistant"
          ? resolveAssistantMessageRenderHint(row.message)
          : "full-text";
      const renderedMessageText =
        row.message.role === "assistant"
          ? getChatMessageRenderableText(row.message)
          : getUserMessageTextForHeightEstimate(row.message.text);
      return [
        "message",
        row.id,
        row.message.role,
        renderedMessageText.length,
        assistantRenderHint,
        row.message.attachments?.length ?? 0,
        row.message.streaming ? 1 : 0,
        row.message.completedAt ?? "incomplete",
        row.completionSummary ? 1 : 0,
        widthCacheKey,
      ].join(":");
    }
    case "work":
      return `work:${row.id}:${row.workEntry.detail ? 1 : 0}:${row.workEntry.command ? 1 : 0}`;
    case "work-group":
      return `work-group:${row.id}:${input.expandedWorkGroups[workGroupId(row.id)] ? 1 : 0}:${row.entries.length}`;
    case "intent":
      return `intent:${row.id}`;
    case "proposed-plan":
      return `proposed-plan:${row.id}:${row.proposedPlan.planMarkdown.length}`;
    case "working":
      return `working:${row.id}:${row.mode}:${row.intentText ? 1 : 0}`;
  }
}

type TimelineMetaTone = "neutral" | "intent" | "thinking" | "tool" | "error" | "success";

function resolveWorkEntryTone(tone: TimelineWorkEntry["tone"]): TimelineMetaTone {
  if (tone === "thinking") return "thinking";
  if (tone === "tool") return "tool";
  if (tone === "error") return "error";
  if (tone === "info") return "success";
  return "neutral";
}

function resolveMetaGroupTone(entries: ReadonlyArray<TimelineMetaGroupEntry>): TimelineMetaTone {
  const hasThinking = entries.some(
    (entry) => entry.kind === "work" && entry.workEntry.tone === "thinking",
  );
  const hasTool = entries.some((entry) => entry.kind === "work" && entry.workEntry.tone === "tool");
  const hasIntent = entries.some((entry) => entry.kind === "intent");

  if (entries.some((entry) => entry.kind === "work" && entry.workEntry.tone === "error")) {
    return "error";
  }
  if (hasThinking && !hasTool) {
    return "thinking";
  }
  if (hasTool) {
    return "tool";
  }
  if (hasIntent) {
    return "intent";
  }
  return "success";
}

function metaToneTextClass(tone: TimelineMetaTone): string {
  if (tone === "intent") return "text-primary/70";
  if (tone === "thinking") return "text-warning/80";
  if (tone === "tool") return "text-muted-foreground/55";
  if (tone === "error") return "text-destructive/80";
  if (tone === "success") return "text-emerald-500/75";
  return "text-muted-foreground/45";
}

function summarizeWorkGroupLabel(
  entries: ReadonlyArray<TimelineMetaGroupEntry>,
  summaryEndAt: string | null,
): string {
  return summarizeWorkGroupElapsedLabel(entries, summaryEndAt) ?? "Activity log";
}

function summarizeWorkGroupElapsedLabel(
  entries: ReadonlyArray<TimelineMetaGroupEntry>,
  summaryEndAt: string | null,
): string | null {
  const firstEntry = entries[0];
  const duration =
    firstEntry && summaryEndAt
      ? formatCompletedWorkTimer(firstEntry.createdAt, summaryEndAt)
      : null;

  return duration ? `Elapsed ${duration}` : null;
}

function formatCompletedWorkTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(1, Math.ceil((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function summarizeWorkGroupBreakdownParts(entries: ReadonlyArray<TimelineMetaGroupEntry>): Array<{
  label: string;
  count: number;
}> {
  const intentCount = entries.filter((entry) => entry.kind === "intent").length;
  const toolCount = entries.filter(
    (entry) => entry.kind === "work" && entry.workEntry.tone === "tool",
  ).length;
  const thinkingCount = entries.filter(
    (entry) => entry.kind === "work" && entry.workEntry.tone === "thinking",
  ).length;
  const errorCount = entries.filter(
    (entry) => entry.kind === "work" && entry.workEntry.tone === "error",
  ).length;
  const infoCount = entries.filter(
    (entry) => entry.kind === "work" && entry.workEntry.tone === "info",
  ).length;
  const parts: Array<{ label: string; count: number }> = [];

  if (intentCount > 0) {
    parts.push({ label: intentCount === 1 ? "intent" : "intents", count: intentCount });
  }
  if (toolCount > 0) {
    parts.push({ label: toolCount === 1 ? "tool call" : "tool calls", count: toolCount });
  }
  if (thinkingCount > 0) {
    parts.push({
      label: thinkingCount === 1 ? "reasoning step" : "reasoning steps",
      count: thinkingCount,
    });
  }
  if (errorCount > 0) {
    parts.push({ label: errorCount === 1 ? "issue" : "issues", count: errorCount });
  }
  if (infoCount > 0) {
    parts.push({ label: infoCount === 1 ? "event" : "events", count: infoCount });
  }

  if (parts.length > 0) {
    return parts;
  }

  return [{ label: entries.length === 1 ? "log entry" : "log entries", count: entries.length }];
}

function shouldSkipAssistantMessageRow(message: TimelineMessage): boolean {
  if (message.role !== "assistant" || message.streaming) {
    return false;
  }
  return message.text.trim().length === 0;
}

function resolveLatestAssistantTurnDiffSummary(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  summaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>,
): TurnDiffSummary | null {
  for (let index = timelineEntries.length - 1; index >= 0; index -= 1) {
    const entry = timelineEntries[index];
    if (!entry || entry.kind !== "message") {
      continue;
    }
    if (entry.message.role !== "assistant") {
      return null;
    }
    const summary = summaryByAssistantMessageId.get(entry.message.id);
    if (!summary || summary.files.length === 0) {
      return null;
    }
    return summary;
  }
  return null;
}

function isUserTimelineMessage(message: TimelineMessage): message is UserTimelineMessage {
  return message.role === "user";
}

function isSystemTimelineMessage(message: TimelineMessage): message is SystemTimelineMessage {
  return message.role === "system";
}

function isAssistantTimelineMessage(message: TimelineMessage): message is AssistantTimelineMessage {
  return message.role === "assistant";
}

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
}) {
  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              {props.text.slice(cursor, matchIndex)}
            </span>,
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              {props.text.slice(cursor)}
            </span>,
          );
        }

        return (
          <div className="m-0 wrap-break-word whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground/90">
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(<span key="user-message-terminal-context-inline-text">{props.text}</span>);
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="m-0 wrap-break-word whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground/90">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <pre className="m-0 whitespace-pre-wrap wrap-break-word font-mono text-sm leading-relaxed text-foreground/90">
      {props.text}
    </pre>
  );
});

const SystemMessageTimelineRow = memo(function SystemMessageTimelineRow(props: {
  message: SystemTimelineMessage;
}) {
  if (props.message.text.trim().length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-3 py-2">
      <div className="h-px flex-1 bg-border" />
      <div className="flex max-w-[75%] items-center gap-2 rounded-full border border-border/50 bg-muted px-3 py-1 text-[11px] text-muted-foreground">
        <ArrowLeftRightIcon className="size-3 text-muted-foreground" />
        <span className="wrap-break-word text-center leading-relaxed">{props.message.text}</span>
      </div>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
});

const UserMessageTimelineRow = memo(function UserMessageTimelineRow(props: {
  canRevertAgentWork: boolean;
  isRevertingCheckpoint: boolean;
  isWorking: boolean;
  message: UserTimelineMessage;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onRevertUserMessage: (messageId: MessageId) => void;
  revertActionTitle: string;
  timestampFormat: TimestampFormat;
}) {
  const userImages = props.message.attachments ?? [];
  const displayedUserMessage = deriveDisplayedUserMessageState(props.message.text);
  const terminalContexts = displayedUserMessage.contexts;

  return (
    <div className="flex justify-end">
      <div
        className="group relative max-w-[82%] px-0 py-0 sm:max-w-[72%]"
        data-user-message-bubble="true"
      >
        <span className="-right-0.5 absolute bottom-2 h-3.5 w-3.5 rotate-45 rounded-[3px] border-border/65 border-r border-b bg-chat-bubble" />
        <div className="relative rounded-[1.35rem] rounded-br-md border border-border/65 bg-chat-bubble px-3.5 py-2.5 shadow-[0_10px_24px_-22px_rgba(0,0,0,0.55)]">
          {userImages.length > 0 && (
            <div className="mb-2.5 grid max-w-105 grid-cols-2 gap-1.5">
              {userImages.map((image: NonNullable<TimelineMessage["attachments"]>[number]) => (
                <div
                  key={image.id}
                  className="overflow-hidden rounded-xl border border-border/55 bg-background/90"
                >
                  {image.previewUrl ? (
                    <button
                      type="button"
                      className="h-full w-full cursor-zoom-in"
                      aria-label={`Preview ${image.name}`}
                      onClick={() => {
                        const preview = buildExpandedImagePreview(userImages, image.id);
                        if (!preview) return;
                        props.onImageExpand(preview);
                      }}
                    >
                      <img
                        src={image.previewUrl}
                        alt={image.name}
                        className="h-full max-h-55 w-full object-cover"
                      />
                    </button>
                  ) : (
                    <div className="flex min-h-18 items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground">
                      {image.name}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {(displayedUserMessage.visibleText.trim().length > 0 || terminalContexts.length > 0) && (
            <UserMessageBody
              text={displayedUserMessage.visibleText}
              terminalContexts={terminalContexts}
            />
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-end gap-2 pr-1">
          <div className="flex items-center gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
            {displayedUserMessage.copyText && (
              <MessageCopyButton text={displayedUserMessage.copyText} />
            )}
            {props.canRevertAgentWork && (
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="border-border/55 bg-background/55"
                disabled={props.isRevertingCheckpoint || props.isWorking}
                onClick={() => props.onRevertUserMessage(props.message.id)}
                title={props.revertActionTitle}
                aria-label={props.revertActionTitle}
              >
                <Undo2Icon className="size-3" />
              </Button>
            )}
          </div>
          <p className="text-right text-[10px] text-muted-foreground/26">
            {formatTimestamp(props.message.createdAt, props.timestampFormat)}
          </p>
        </div>
      </div>
    </div>
  );
});

const AssistantMessageTimelineRow = memo(function AssistantMessageTimelineRow(props: {
  completionSummary: string | null;
  markdownCwd: string | undefined;
  message: AssistantTimelineMessage;
  onOpenBrowserUrl?: ((url: string) => void) | null;
}) {
  const onOpenBrowserUrl = props.onOpenBrowserUrl ?? null;
  const renderedMessageText = getChatMessageRenderableText(props.message);
  const messageText =
    renderedMessageText.trim().length > 0
      ? renderedMessageText
      : props.message.streaming
        ? ""
        : "(empty response)";

  return (
    <div className="min-w-0">
      <ChatMarkdown
        text={messageText}
        cwd={props.markdownCwd}
        isStreaming={Boolean(props.message.streaming)}
        onOpenBrowserUrl={onOpenBrowserUrl}
        {...(props.message.streamingTextState
          ? { streamingTextState: props.message.streamingTextState }
          : {})}
      />
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        {props.completionSummary && (
          <span
            className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/52"
            data-response-summary="true"
          >
            <Clock3Icon className="size-3 shrink-0" />
            <span>{props.completionSummary}</span>
          </span>
        )}
      </div>
    </div>
  );
});

const AssistantMessageTurnDiffSummary = memo(function AssistantMessageTurnDiffSummary(props: {
  allDirectoriesExpanded: boolean;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onToggleAllDirectories: (turnId: TurnId) => void;
  resolvedTheme: "light" | "dark";
  turnSummary: TurnDiffSummary;
}) {
  const checkpointFiles = props.turnSummary.files;
  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
  const changedFileCountLabel = String(checkpointFiles.length);

  return (
    <div className="mt-1.5" data-turn-diff-summary="true">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/65">
          <span>Changed files ({changedFileCountLabel})</span>
          {hasNonZeroStat(summaryStat) && (
            <>
              <span className="mx-1">•</span>
              <DiffStatLabel additions={summaryStat.additions} deletions={summaryStat.deletions} />
            </>
          )}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-scroll-anchor-ignore
            onClick={() => props.onToggleAllDirectories(props.turnSummary.turnId)}
          >
            {props.allDirectoriesExpanded ? "Collapse all" : "Expand all"}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => props.onOpenTurnDiff(props.turnSummary.turnId, checkpointFiles[0]?.path)}
          >
            View diff
          </Button>
        </div>
      </div>
      <ChangedFilesTree
        key={`changed-files-tree:${props.turnSummary.turnId}`}
        turnId={props.turnSummary.turnId}
        files={checkpointFiles}
        allDirectoriesExpanded={props.allDirectoriesExpanded}
        resolvedTheme={props.resolvedTheme}
        onOpenTurnDiff={props.onOpenTurnDiff}
      />
    </div>
  );
});

const ProposedPlanTimelineRow = memo(function ProposedPlanTimelineRow(props: {
  cwd: string | undefined;
  onOpenBrowserUrl?: ((url: string) => void) | null;
  proposedPlan: TimelineProposedPlan;
  workspaceRoot: string | undefined;
}) {
  const onOpenBrowserUrl = props.onOpenBrowserUrl ?? null;
  return (
    <div className="rounded-xl border border-border/45 bg-background/35 px-4 py-3">
      <ProposedPlanCard
        planMarkdown={props.proposedPlan.planMarkdown}
        cwd={props.cwd}
        onOpenBrowserUrl={onOpenBrowserUrl}
        workspaceRoot={props.workspaceRoot}
      />
    </div>
  );
});

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground/92",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground/92",
  };
}

function workEntryDetailText(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
) {
  const detailText = workEntry.detail?.trim() || null;
  const commandText = normalizeWorkCommandText(workEntry.command);

  if (detailText) return detailText;
  if (commandText) return commandText;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  return workEntry.changedFiles!.length === 1
    ? firstPath
    : `${firstPath} +${workEntry.changedFiles!.length - 1} more`;
}

function normalizeWorkCommandText(command: string | undefined): string | null {
  if (!command) {
    return null;
  }
  const normalized = command.replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) {
    return null;
  }
  return normalized;
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return TerminalIcon;
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return WrenchIcon;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return HammerIcon;
  }

  return workToneIcon(workEntry.tone).icon;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

const SimpleIntentEntryRow = memo(function SimpleIntentEntryRow(props: {
  entry: Extract<TimelineMetaGroupEntry, { kind: "intent" }>;
  variant?: "nested" | "standalone";
}) {
  const variant = props.variant ?? "standalone";
  return (
    <div
      className={cn("min-w-0", variant === "nested" && "pl-2")}
      data-intent-message="true"
      data-meta-entry-kind="intent"
    >
      <div className="flex items-start gap-2.5 transition-[opacity,translate] duration-200">
        <SquarePenIcon className="mt-1 size-3 shrink-0 text-muted-foreground/42" />
        <div className="min-w-0 flex-1 overflow-hidden">
          <p className="wrap-break-word whitespace-pre-wrap text-[12px] leading-5 text-muted-foreground/76">
            <span className="mr-1 text-foreground/80">Intent:</span>
            {props.entry.text}
          </p>
        </div>
      </div>
    </div>
  );
});

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  inlineIntentText?: string | null;
  variant?: "nested" | "standalone";
}) {
  const { workEntry } = props;
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const detailText = workEntryDetailText(workEntry);
  const displayText = detailText ? `${heading} - ${detailText}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;
  const inlineIntentText = props.inlineIntentText?.trim() || null;
  const variant = props.variant ?? "standalone";
  const tone = resolveWorkEntryTone(workEntry.tone);

  return (
    <div
      className={cn("min-w-0", variant === "nested" && "pl-2")}
      data-work-entry-id={workEntry.id}
      data-work-entry-tone={workEntry.tone}
    >
      <div className="flex items-start gap-3 transition-[opacity,translate] duration-200">
        <EntryIcon
          className={cn("mt-1 size-3 shrink-0", iconConfig.className, metaToneTextClass(tone))}
        />
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="mb-0.5 flex min-w-0 items-center gap-2">
            <p
              className={cn(
                "min-w-0 flex-1 truncate text-[12px] leading-5 text-muted-foreground/78",
                workEntry.tone === "thinking" && "tracking-[0.01em]",
              )}
              title={displayText}
            >
              <span>{heading}</span>
            </p>
          </div>
          {inlineIntentText && (
            <p
              className="mb-1 text-[11px] leading-5 text-muted-foreground/68"
              data-inline-intent="true"
            >
              <span className="mr-1 text-[9px] uppercase tracking-[0.14em] text-muted-foreground/38">
                Intent
              </span>
              <span className="text-foreground/72">{inlineIntentText}</span>
            </p>
          )}
          {detailText && (
            <p
              className={cn(
                "wrap-break-word whitespace-pre-wrap",
                workEntry.tone === "thinking"
                  ? "text-[11px] leading-5 text-foreground/72"
                  : "font-mono text-[10px] leading-5 text-muted-foreground/65",
              )}
              title={detailText}
            >
              {detailText}
            </p>
          )}
        </div>
      </div>
      {hasChangedFiles && !previewIsChangedFiles && (
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 pl-5.5">
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => (
            <span
              key={`${workEntry.id}:${filePath}`}
              className="font-mono text-[10px] text-muted-foreground/75"
              title={filePath}
            >
              {filePath}
            </span>
          ))}
          {(workEntry.changedFiles?.length ?? 0) > 4 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">
              +{(workEntry.changedFiles?.length ?? 0) - 4}
            </span>
          )}
        </div>
      )}
    </div>
  );
});
