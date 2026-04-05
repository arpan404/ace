import { type MessageId, type TurnId } from "@t3tools/contracts";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { deriveTimelineEntries, formatElapsed } from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  ChevronDownIcon,
  ChevronRightIcon,
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
import {
  computeMessageDurationStart,
  normalizeCompactToolLabel,
} from "~/lib/chat/messagesTimeline";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatTimestamp } from "../../timestampFormat";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "~/lib/chat/userMessageTerminalContexts";

const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;
const LARGE_TOOL_GROUP_SUMMARY_THRESHOLD = 10;
const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;

interface MessagesTimelineProps {
  hasMessages: boolean;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  scrollContainer: HTMLDivElement | null;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  nowIso: string;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
}

export const MessagesTimeline = memo(function MessagesTimeline({
  hasMessages,
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  scrollContainer: _scrollContainer,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  nowIso,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
}: MessagesTimelineProps) {
  const rows = useMemo<TimelineRow[]>(() => {
    const nextRows: TimelineRow[] = [];
    const durationStartByMessageId = computeMessageDurationStart(
      timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
    );

    for (let index = 0; index < timelineEntries.length; index += 1) {
      const timelineEntry = timelineEntries[index];
      if (!timelineEntry) {
        continue;
      }

      if (activeTurnInProgress && timelineEntry.kind === "intent") {
        const groupedEntries: TimelineWorkEntry[] = [];
        let cursor = index + 1;
        while (cursor < timelineEntries.length) {
          const nextEntry = timelineEntries[cursor];
          if (!nextEntry || nextEntry.kind !== "work" || nextEntry.entry.tone !== "tool") {
            break;
          }
          groupedEntries.push(nextEntry.entry);
          cursor += 1;
        }

        if (groupedEntries.length > 0) {
          const previousRow = nextRows.at(-1);
          if (
            previousRow?.kind === "intent-work" &&
            normalizeIntentTimelineText(previousRow.text) ===
              normalizeIntentTimelineText(timelineEntry.text)
          ) {
            previousRow.groupedEntries.push(...groupedEntries);
          } else {
            nextRows.push({
              kind: "intent-work",
              id: `intent-work:${timelineEntry.id}`,
              createdAt: timelineEntry.createdAt,
              text: timelineEntry.text,
              groupedEntries,
              workCreatedAt: groupedEntries[0]?.createdAt ?? timelineEntry.createdAt,
            });
          }
          index = cursor - 1;
          continue;
        }
      }

      if (timelineEntry.kind === "work") {
        const groupedEntries = [timelineEntry.entry];
        let cursor = index + 1;
        while (cursor < timelineEntries.length) {
          const nextEntry = timelineEntries[cursor];
          if (
            !nextEntry ||
            nextEntry.kind !== "work" ||
            !canGroupAdjacentWorkEntries(groupedEntries[groupedEntries.length - 1], nextEntry.entry)
          ) {
            break;
          }
          groupedEntries.push(nextEntry.entry);
          cursor += 1;
        }
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries,
        });
        index = cursor - 1;
        continue;
      }

      if (timelineEntry.kind === "intent") {
        nextRows.push({
          kind: "intent",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          text: timelineEntry.text,
        });
        continue;
      }

      if (timelineEntry.kind === "proposed-plan") {
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
        shouldSkipAssistantMessageRow(
          timelineEntry.message,
          turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id),
        )
      ) {
        continue;
      }

      nextRows.push({
        kind: "message",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        message: timelineEntry.message,
        durationStart:
          durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
        showCompletionDivider:
          timelineEntry.message.role === "assistant" &&
          completionDividerBeforeEntryId === timelineEntry.id,
      });
    }

    if (isWorking) {
      nextRows.push({
        kind: "working",
        id: "working-indicator-row",
        createdAt: activeTurnStartedAt,
      });
    }

    return nextRows;
  }, [
    timelineEntries,
    completionDividerBeforeEntryId,
    isWorking,
    activeTurnStartedAt,
    activeTurnInProgress,
    turnDiffSummaryByAssistantMessageId,
  ]);
  const lastExpandableWorkRowId = useMemo(() => {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row?.kind === "work" || row?.kind === "intent-work") {
        return row.id;
      }
    }
    return null;
  }, [rows]);
  const [allDirectoriesExpandedByTurnId, setAllDirectoriesExpandedByTurnId] = useState<
    Record<string, boolean>
  >({});
  const onToggleAllDirectories = useCallback((turnId: TurnId) => {
    setAllDirectoriesExpandedByTurnId((current) => ({
      ...current,
      [turnId]: !(current[turnId] ?? true),
    }));
  }, []);

  const renderRowContent = (row: TimelineRow, rowIndex: number) => {
    const previousRow = rowIndex > 0 ? rows[rowIndex - 1] : undefined;
    const nextRow = rowIndex + 1 < rows.length ? rows[rowIndex + 1] : undefined;
    const attachThinkingToStreamingAssistant =
      isThinkingWorkRow(row) && isStreamingAssistantMessageRow(nextRow);
    const attachStreamingAssistantToThinking =
      isStreamingAssistantMessageRow(row) && isThinkingWorkRow(previousRow);
    const attachWorkToFollowUp = isWorkContainerRow(row) && isWorkFollowUpRow(nextRow);
    const attachFollowUpToWork = isWorkFollowUpRow(row) && isWorkContainerRow(previousRow);

    return (
      <div
        className={cn(
          "group/timeline relative pb-3",
          attachWorkToFollowUp && "pb-1.5",
          attachThinkingToStreamingAssistant && "pb-1.5",
          (attachStreamingAssistantToThinking || attachFollowUpToWork) && "-mt-0.5 pb-3",
        )}
        data-timeline-row-kind={row.kind}
        data-message-id={row.kind === "message" ? row.message.id : undefined}
        data-message-role={row.kind === "message" ? row.message.role : undefined}
        data-thinking-attached={attachThinkingToStreamingAssistant ? "true" : undefined}
        data-assistant-attached={attachStreamingAssistantToThinking ? "true" : undefined}
        data-work-followup-attached={attachFollowUpToWork ? "true" : undefined}
        data-intent-disclosure-open={
          row.kind === "intent-work"
            ? String(
                Object.prototype.hasOwnProperty.call(expandedWorkGroups, workGroupId(row.id))
                  ? Boolean(expandedWorkGroups[workGroupId(row.id)])
                  : row.id === lastExpandableWorkRowId,
              )
            : undefined
        }
      >
        {row.kind === "work" &&
          (() => {
            const groupedEntries = row.groupedEntries;
            const groupId = workGroupId(row.id);
            const isLiveWorkGroup = activeTurnInProgress && row.id === lastExpandableWorkRowId;
            const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
            const onlyThinkingEntries = groupedEntries.every((entry) => entry.tone === "thinking");
            const isExpanded = onlyThinkingEntries
              ? (expandedWorkGroups[groupId] ?? false)
              : isLiveWorkGroup
                ? false
                : (expandedWorkGroups[groupId] ?? false);
            const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
            const visibleEntries = onlyThinkingEntries
              ? isExpanded
                ? groupedEntries
                : []
              : hasOverflow && !isExpanded
                ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
                : groupedEntries;
            const hiddenCount = groupedEntries.length - visibleEntries.length;
            const hiddenEntries = hiddenCount > 0 ? groupedEntries.slice(0, hiddenCount) : [];
            const useToolSummaryRow =
              onlyToolEntries &&
              hiddenCount > 0 &&
              groupedEntries.length >= LARGE_TOOL_GROUP_SUMMARY_THRESHOLD &&
              !isExpanded;
            const showHeader = !useToolSummaryRow && (hasOverflow || !onlyToolEntries);
            const compactGroup = onlyToolEntries && groupedEntries.length >= 8;
            const groupLabel = onlyToolEntries
              ? "Tool calls"
              : onlyThinkingEntries
                ? "Thinking"
                : "Work log";
            const thinkingSummary = onlyThinkingEntries
              ? summarizeThinkingDisclosure(groupedEntries, nowIso, isLiveWorkGroup)
              : null;
            const ThinkingDisclosureIcon = isExpanded ? ChevronDownIcon : ChevronRightIcon;

            return (
              <div
                className={cn(
                  "min-w-0 border-l pl-4",
                  workGroupRailClass(groupedEntries),
                  attachThinkingToStreamingAssistant && "border-amber-500/35",
                )}
                data-thread-group={
                  onlyThinkingEntries ? "thinking" : onlyToolEntries ? "tool" : "work"
                }
              >
                {onlyThinkingEntries ? (
                  <button
                    type="button"
                    className="mb-2 w-full border-border/40 border-b pb-2 text-left transition-colors duration-150 hover:border-amber-500/24"
                    onClick={() => onToggleWorkGroup(groupId)}
                    data-thinking-disclosure="true"
                    data-thinking-disclosure-open={String(isExpanded)}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="flex size-4.5 shrink-0 items-center justify-center rounded-full border border-amber-500/20 text-muted-foreground/60">
                          <ThinkingDisclosureIcon className="size-3.5" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-[11px] font-medium text-foreground/82">
                            {thinkingSummary}
                          </p>
                          <p className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground/52">
                            {groupedEntries.length === 1
                              ? "1 thinking step"
                              : `${groupedEntries.length} thinking steps`}
                          </p>
                        </div>
                      </div>
                      <span className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/60">
                        {isExpanded ? "Hide" : "Show"}
                      </span>
                    </div>
                  </button>
                ) : (
                  showHeader && (
                    <div className="mb-2 flex items-center justify-between gap-2 border-border/35 border-b pb-2">
                      <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
                        {groupLabel} ({groupedEntries.length})
                      </p>
                      {hasOverflow && !isLiveWorkGroup && (
                        <button
                          type="button"
                          className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
                          onClick={() => onToggleWorkGroup(groupId)}
                        >
                          {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
                        </button>
                      )}
                      {hasOverflow && isLiveWorkGroup && (
                        <span className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/45">
                          Showing latest {visibleEntries.length}
                        </span>
                      )}
                    </div>
                  )
                )}
                <div className={cn(compactGroup ? "space-y-1" : "space-y-1.5")}>
                  {useToolSummaryRow && (
                    <CollapsedToolGroupSummaryRow
                      totalCount={groupedEntries.length}
                      hiddenCount={hiddenCount}
                      hiddenEntries={hiddenEntries}
                      canExpand={!isLiveWorkGroup}
                      onExpand={() => onToggleWorkGroup(groupId)}
                    />
                  )}
                  {visibleEntries.map((workEntry) => (
                    <SimpleWorkEntryRow
                      key={`work-row:${workEntry.id}`}
                      workEntry={workEntry}
                      compact={compactGroup}
                      expandedThinking={onlyThinkingEntries && isExpanded}
                    />
                  ))}
                </div>
              </div>
            );
          })()}

        {row.kind === "intent-work" &&
          (() => {
            const groupedEntries = row.groupedEntries;
            const groupId = workGroupId(row.id);
            const hasExplicitExpandedState = Object.prototype.hasOwnProperty.call(
              expandedWorkGroups,
              groupId,
            );
            const isCurrentIntentGroup = row.id === lastExpandableWorkRowId;
            const isExpanded = hasExplicitExpandedState
              ? Boolean(expandedWorkGroups[groupId])
              : isCurrentIntentGroup;
            const isLiveWorkGroup = activeTurnInProgress && isCurrentIntentGroup;
            const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
            const visibleEntries = isExpanded
              ? isLiveWorkGroup && hasOverflow
                ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
                : groupedEntries
              : [];
            const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
            const compactGroup = onlyToolEntries && groupedEntries.length >= 8;
            const toolCallCount = countToolCalls(groupedEntries);

            return (
              <div
                className="min-w-0 border-primary/18 border-l px-0.5 py-0.5 pl-4"
                data-intent-disclosure="true"
              >
                <button
                  type="button"
                  className="w-full py-1 text-left"
                  onClick={() => onToggleWorkGroup(groupId)}
                >
                  <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/55">
                    Message
                  </p>
                  <p className="mt-1 wrap-break-word text-[13px] leading-6 text-foreground/86">
                    &quot;{row.text}&quot;
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground/58">
                    {toolCallCount === 1 ? "1 tool call" : `${toolCallCount} tool calls`}
                    <span className="ml-2 uppercase tracking-[0.14em]">
                      {isExpanded ? "Hide" : "Open"}
                    </span>
                  </p>
                </button>
                {isExpanded && (
                  <div className="mt-3 border-l border-border/35 pl-4">
                    {isLiveWorkGroup && hasOverflow && (
                      <div className="mb-2 border-border/35 border-b pb-2 text-[10px] text-muted-foreground/60">
                        Showing latest {visibleEntries.length} of {groupedEntries.length} live tool
                        calls
                      </div>
                    )}
                    <div className={cn(compactGroup ? "space-y-1" : "space-y-1.5")}>
                      {visibleEntries.map((workEntry) => (
                        <SimpleWorkEntryRow
                          key={`intent-work-row:${workEntry.id}`}
                          workEntry={workEntry}
                          compact={compactGroup}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

        {row.kind === "intent" && (
          <div
            className={cn(
              "min-w-0 border-primary/18 border-l py-0.5 pr-1 pl-4",
              attachFollowUpToWork && "border-border/35",
            )}
            data-intent-message="true"
            data-thread-attached-surface={attachFollowUpToWork ? "true" : undefined}
          >
            <p className="px-0.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/55">
              Message
            </p>
            <p className="wrap-break-word px-0.5 pt-1 text-[13px] leading-6 text-foreground/84">
              <span>&quot;{row.text}&quot;</span>
            </p>
          </div>
        )}

        {row.kind === "message" &&
          row.message.role === "user" &&
          (() => {
            const userImages = row.message.attachments ?? [];
            const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
            const terminalContexts = displayedUserMessage.contexts;
            const canRevertAgentWork = revertTurnCountByUserMessageId.has(row.message.id);
            return (
              <div className="flex justify-end">
                <div
                  className="group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3"
                  data-user-message-bubble="true"
                >
                  {userImages.length > 0 && (
                    <div className="mb-2 grid max-w-105 grid-cols-2 gap-2">
                      {userImages.map(
                        (image: NonNullable<TimelineMessage["attachments"]>[number]) => (
                          <div
                            key={image.id}
                            className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
                          >
                            {image.previewUrl ? (
                              <button
                                type="button"
                                className="h-full w-full cursor-zoom-in"
                                aria-label={`Preview ${image.name}`}
                                onClick={() => {
                                  const preview = buildExpandedImagePreview(userImages, image.id);
                                  if (!preview) return;
                                  onImageExpand(preview);
                                }}
                              >
                                <img
                                  src={image.previewUrl}
                                  alt={image.name}
                                  className="h-full max-h-55 w-full object-cover"
                                />
                              </button>
                            ) : (
                              <div className="flex min-h-18 items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                                {image.name}
                              </div>
                            )}
                          </div>
                        ),
                      )}
                    </div>
                  )}
                  {(displayedUserMessage.visibleText.trim().length > 0 ||
                    terminalContexts.length > 0) && (
                    <UserMessageBody
                      text={displayedUserMessage.visibleText}
                      terminalContexts={terminalContexts}
                    />
                  )}
                  <div className="mt-1.5 flex items-center justify-end gap-2">
                    <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                      {displayedUserMessage.copyText && (
                        <MessageCopyButton text={displayedUserMessage.copyText} />
                      )}
                      {canRevertAgentWork && (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={isRevertingCheckpoint || isWorking}
                          onClick={() => onRevertUserMessage(row.message.id)}
                          title="Revert to this message"
                        >
                          <Undo2Icon className="size-3" />
                        </Button>
                      )}
                    </div>
                    <p className="text-right text-[10px] text-muted-foreground/30">
                      {formatTimestamp(row.message.createdAt, timestampFormat)}
                    </p>
                  </div>
                </div>
              </div>
            );
          })()}

        {row.kind === "message" &&
          row.message.role === "assistant" &&
          (() => {
            const messageText =
              row.message.text.trim().length > 0
                ? row.message.text
                : row.message.streaming
                  ? ""
                  : "(empty response)";
            return (
              <>
                {row.showCompletionDivider && (
                  <div className="my-3 flex items-center gap-3">
                    <span className="h-px flex-1 bg-border" />
                    <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
                      {completionSummary ? `Response • ${completionSummary}` : "Response"}
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}
                <div
                  className={cn(
                    "min-w-0 border-border/35 border-l py-0.5 pr-1 pl-4",
                    attachStreamingAssistantToThinking && "border-amber-500/35",
                  )}
                  data-thread-attached-surface={
                    attachStreamingAssistantToThinking || attachFollowUpToWork ? "true" : undefined
                  }
                >
                  <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/55">
                    Assistant
                  </p>
                  <ChatMarkdown
                    text={messageText}
                    cwd={markdownCwd}
                    isStreaming={Boolean(row.message.streaming)}
                  />
                  {(() => {
                    const turnSummary = turnDiffSummaryByAssistantMessageId.get(row.message.id);
                    if (!turnSummary) return null;
                    const checkpointFiles = turnSummary.files;
                    if (checkpointFiles.length === 0) return null;
                    const summaryStat = summarizeTurnDiffStats(checkpointFiles);
                    const changedFileCountLabel = String(checkpointFiles.length);
                    const allDirectoriesExpanded =
                      allDirectoriesExpandedByTurnId[turnSummary.turnId] ?? true;
                    return (
                      <div
                        className="mt-3 border-border/35 border-l pl-4"
                        data-turn-diff-summary="true"
                      >
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
                            <span>Changed files ({changedFileCountLabel})</span>
                            {hasNonZeroStat(summaryStat) && (
                              <>
                                <span className="mx-1">•</span>
                                <DiffStatLabel
                                  additions={summaryStat.additions}
                                  deletions={summaryStat.deletions}
                                />
                              </>
                            )}
                          </p>
                          <div className="flex items-center gap-1.5">
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              data-scroll-anchor-ignore
                              onClick={() => onToggleAllDirectories(turnSummary.turnId)}
                            >
                              {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              onClick={() =>
                                onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)
                              }
                            >
                              View diff
                            </Button>
                          </div>
                        </div>
                        <ChangedFilesTree
                          key={`changed-files-tree:${turnSummary.turnId}`}
                          turnId={turnSummary.turnId}
                          files={checkpointFiles}
                          allDirectoriesExpanded={allDirectoriesExpanded}
                          resolvedTheme={resolvedTheme}
                          onOpenTurnDiff={onOpenTurnDiff}
                        />
                      </div>
                    );
                  })()}
                  <p className="mt-1.5 text-[10px] text-muted-foreground/30">
                    {formatMessageMeta(
                      row.message.createdAt,
                      row.message.streaming
                        ? formatElapsed(row.durationStart, nowIso)
                        : formatElapsed(row.durationStart, row.message.completedAt),
                      timestampFormat,
                    )}
                  </p>
                </div>
              </>
            );
          })()}

        {row.kind === "proposed-plan" && (
          <div className="min-w-0 border-emerald-500/18 border-l py-0.5 pr-1 pl-4">
            <ProposedPlanCard
              planMarkdown={row.proposedPlan.planMarkdown}
              cwd={markdownCwd}
              workspaceRoot={workspaceRoot}
            />
          </div>
        )}

        {row.kind === "working" && (
          <div className="border-border/35 border-l py-0.5 pl-4">
            <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/55">
              Live
            </p>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70">
              <span className="inline-flex items-center gap-0.75">
                <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
                <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:200ms]" />
                <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:400ms]" />
              </span>
              <span>
                {row.createdAt
                  ? `Working for ${formatWorkingTimer(row.createdAt, nowIso) ?? "0s"}`
                  : "Working..."}
              </span>
            </div>
          </div>
        )}
      </div>
    );
  };

  if (!hasMessages && !isWorking) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <div data-timeline-root="true" className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden">
      {rows.map((row, index) => (
        <div key={`row:${row.id}`}>{renderRowContent(row, index)}</div>
      ))}
    </div>
  );
});

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineProposedPlan = Extract<TimelineEntry, { kind: "proposed-plan" }>["proposedPlan"];
type TimelineWorkEntry = Extract<TimelineEntry, { kind: "work" }>["entry"];
type TimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: TimelineWorkEntry[];
    }
  | {
      kind: "intent-work";
      id: string;
      createdAt: string;
      text: string;
      groupedEntries: TimelineWorkEntry[];
      workCreatedAt: string;
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
      showCompletionDivider: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: TimelineProposedPlan;
    }
  | { kind: "working"; id: string; createdAt: string | null };

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

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
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

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} • ${duration}`;
}

function workGroupId(rowId: string): string {
  return `work-group:${rowId}`;
}

function normalizeIntentTimelineText(value: string): string {
  return value
    .trim()
    .replace(/[^a-z0-9]+/gi, " ")
    .toLowerCase()
    .trim();
}

function isThinkingWorkRow(row: TimelineRow | undefined): boolean {
  return row?.kind === "work" && row.groupedEntries.every((entry) => entry.tone === "thinking");
}

function isWorkContainerRow(row: TimelineRow | undefined): boolean {
  return row?.kind === "work" || row?.kind === "intent-work";
}

function canGroupAdjacentWorkEntries(
  previous: TimelineWorkEntry | undefined,
  next: TimelineWorkEntry,
): boolean {
  if (!previous) {
    return true;
  }

  return previous.tone === next.tone;
}

function isStreamingAssistantMessageRow(row: TimelineRow | undefined): boolean {
  return row?.kind === "message" && row.message.role === "assistant" && row.message.streaming;
}

function isWorkFollowUpRow(row: TimelineRow | undefined): boolean {
  return row?.kind === "intent" || (row?.kind === "message" && row.message.role === "assistant");
}

function shouldSkipAssistantMessageRow(
  message: TimelineMessage,
  turnSummary: TurnDiffSummary | undefined,
): boolean {
  if (message.role !== "assistant" || message.streaming) {
    return false;
  }
  if (turnSummary && turnSummary.files.length > 0) {
    return false;
  }
  return message.text.trim().length === 0;
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
          <div className="wrap-break-word whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">
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
      <div className="wrap-break-word whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <pre className="whitespace-pre-wrap wrap-break-word font-mono text-sm leading-relaxed text-foreground">
      {props.text}
    </pre>
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

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
}

function workEntrySurfaceClass(tone: TimelineWorkEntry["tone"]): string {
  if (tone === "thinking") {
    return "border-amber-500/26 border-dashed";
  }
  if (tone === "tool") {
    return "border-border/40";
  }
  if (tone === "error") {
    return "border-rose-500/24";
  }
  return "border-emerald-500/18";
}

function workEntryBadgeLabel(tone: TimelineWorkEntry["tone"]): string {
  if (tone === "thinking") return "Thinking";
  if (tone === "tool") return "Tool";
  if (tone === "error") return "Issue";
  return "Event";
}

function workEntryBadgeClass(tone: TimelineWorkEntry["tone"]): string {
  if (tone === "thinking") {
    return "text-amber-700 dark:text-amber-100";
  }
  if (tone === "tool") {
    return "text-muted-foreground/62";
  }
  if (tone === "error") {
    return "text-rose-700 dark:text-rose-100";
  }
  return "text-emerald-700 dark:text-emerald-100";
}

function workEntryMarkerClass(tone: TimelineWorkEntry["tone"]): string {
  if (tone === "thinking") return "bg-amber-500/55";
  if (tone === "tool") return "bg-border";
  if (tone === "error") return "bg-rose-500/60";
  return "bg-emerald-500/60";
}

function workGroupRailClass(entries: ReadonlyArray<TimelineWorkEntry>): string {
  if (entries.every((entry) => entry.tone === "thinking")) {
    return "border-amber-500/26";
  }
  if (entries.some((entry) => entry.tone === "error")) {
    return "border-rose-500/22";
  }
  if (entries.every((entry) => entry.tone === "tool")) {
    return "border-border/35";
  }
  return "border-emerald-500/18";
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
) {
  const detailPreview = workEntry.detail?.trim() || null;
  const commandPreview = normalizeWorkCommandPreview(workEntry.command);

  if (commandPreview && (!detailPreview || !isNoisyWorkCommandPreview(workEntry.command))) {
    return commandPreview;
  }
  if (detailPreview) return detailPreview;
  if (commandPreview) return commandPreview;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  return workEntry.changedFiles!.length === 1
    ? firstPath
    : `${firstPath} +${workEntry.changedFiles!.length - 1} more`;
}

function summarizeThinkingDisclosure(
  entries: ReadonlyArray<TimelineWorkEntry>,
  nowIso: string,
  isLive: boolean,
): string {
  const firstEntry = entries[0];
  const lastEntry = entries.at(-1);
  const duration =
    firstEntry && lastEntry
      ? formatThoughtTimer(firstEntry.createdAt, isLive ? nowIso : lastEntry.createdAt)
      : null;

  if (!duration) {
    return isLive ? "Thinking" : "Thought";
  }

  return isLive ? `Thinking for ${duration}` : `Thought for ${duration}`;
}

function formatThoughtTimer(startIso: string, endIso: string): string | null {
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

function normalizeWorkCommandPreview(command: string | undefined): string | null {
  if (!command) {
    return null;
  }
  const normalized = command.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }
  return normalized.length <= 140 ? normalized : `${normalized.slice(0, 137)}...`;
}

function isNoisyWorkCommandPreview(command: string | undefined): boolean {
  if (!command) {
    return false;
  }
  return (
    /[\r\n]/.test(command) ||
    /\|\||&&|;/.test(command) ||
    /\b(?:node|python|ruby)\s+-[ce]\b/.test(command) ||
    command.trim().length > 140
  );
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

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  compact?: boolean;
  expandedThinking?: boolean;
}) {
  const { workEntry } = props;
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const preview = workEntryPreview(workEntry);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;
  const badgeLabel = workEntryBadgeLabel(workEntry.tone);
  const compact = props.compact ?? false;
  const expandedThinking = props.expandedThinking ?? false;

  return (
    <div
      className={cn("border-l pl-3", workEntrySurfaceClass(workEntry.tone), compact && "pl-2.5")}
      data-work-entry-id={workEntry.id}
      data-work-entry-tone={workEntry.tone}
    >
      <div className="flex items-start gap-2.5 transition-[opacity,translate] duration-200">
        <span
          className={cn(
            "mt-1.5 size-1.5 shrink-0 rounded-full",
            compact && "mt-1.25 size-1",
            workEntryMarkerClass(workEntry.tone),
          )}
        />
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="mb-0.5 flex min-w-0 items-center gap-1.5">
            <EntryIcon
              className={cn(compact ? "size-2.75" : "size-3", "shrink-0", iconConfig.className)}
            />
            <span
              className={cn(
                "shrink-0 text-[9px] font-medium uppercase tracking-[0.16em]",
                compact && "text-[8px] tracking-[0.14em]",
                workEntryBadgeClass(workEntry.tone),
              )}
            >
              {badgeLabel}
            </span>
            <p
              className={cn(
                "min-w-0 truncate text-[11px] leading-5",
                compact && "text-[10px] leading-4.5",
                workEntry.tone === "thinking" && "tracking-[0.01em]",
                workToneClass(workEntry.tone),
                preview ? "text-muted-foreground/70" : "",
              )}
              title={displayText}
            >
              <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                {heading}
              </span>
            </p>
          </div>
          {preview && (
            <p
              className={cn(
                "pl-0.5 font-mono text-[10px] leading-4 text-muted-foreground/65",
                compact && "text-[9px] leading-3.5",
                workEntry.tone === "thinking"
                  ? expandedThinking
                    ? "whitespace-pre-wrap wrap-break-word font-normal italic text-muted-foreground/72"
                    : "line-clamp-4 whitespace-pre-wrap wrap-break-word font-normal italic text-muted-foreground/72"
                  : "truncate",
              )}
              title={preview}
            >
              {preview}
            </p>
          )}
        </div>
      </div>
      {hasChangedFiles && !previewIsChangedFiles && (
        <div
          className={cn("mt-1.5 flex flex-wrap gap-x-2 gap-y-1 pl-5.5", compact && "mt-1 pl-4.5")}
        >
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

const CollapsedToolGroupSummaryRow = memo(function CollapsedToolGroupSummaryRow(props: {
  totalCount: number;
  hiddenCount: number;
  hiddenEntries: ReadonlyArray<TimelineWorkEntry>;
  canExpand: boolean;
  onExpand: () => void;
}) {
  const visibleCount = props.totalCount - props.hiddenCount;
  const hiddenBreakdown = summarizeToolGroupBreakdown(props.hiddenEntries);

  return (
    <div className="flex items-center justify-between gap-3 border-border/35 border-b pb-2">
      <div className="min-w-0">
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/58">
          {props.totalCount} tool calls
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground/72">
          {props.hiddenCount} earlier hidden, showing latest {visibleCount}
        </p>
        {hiddenBreakdown && (
          <p className="mt-1 truncate text-[10px] text-muted-foreground/55">{hiddenBreakdown}</p>
        )}
      </div>
      {props.canExpand ? (
        <button
          type="button"
          className="shrink-0 text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70 transition-colors duration-150 hover:text-foreground/78"
          onClick={props.onExpand}
        >
          Expand
        </button>
      ) : (
        <span className="shrink-0 text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground/52">
          Live
        </span>
      )}
    </div>
  );
});

function summarizeToolGroupBreakdown(entries: ReadonlyArray<TimelineWorkEntry>): string | null {
  if (entries.length === 0) {
    return null;
  }

  const counts = new Map<string, number>();
  for (const entry of entries) {
    const category = summarizeToolGroupEntryType(entry);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  const parts = [...counts.entries()]
    .toSorted(
      (left, right) =>
        right[1] - left[1] ||
        toolBreakdownCategoryRank(left[0]) - toolBreakdownCategoryRank(right[0]) ||
        left[0].localeCompare(right[0]),
    )
    .slice(0, 3)
    .map(([label, count]) => `${count} ${count === 1 ? label : `${label}s`}`);

  return parts.length > 0 ? parts.join(" · ") : null;
}

function countToolCalls(entries: ReadonlyArray<TimelineWorkEntry>): number {
  return entries.filter((entry) => entry.tone === "tool").length;
}

function toolBreakdownCategoryRank(category: string): number {
  switch (category) {
    case "file read":
      return 0;
    case "patch":
      return 1;
    case "command":
      return 2;
    case "search":
      return 3;
    case "image":
      return 4;
    default:
      return 5;
  }
}

function summarizeToolGroupEntryType(entry: TimelineWorkEntry): string {
  const titleText = `${entry.toolTitle ?? ""} ${entry.label}`.toLowerCase();

  if (entry.requestKind === "command" || entry.itemType === "command_execution" || entry.command) {
    return "command";
  }
  if (entry.requestKind === "file-read") {
    return "file read";
  }
  if (
    entry.requestKind === "file-change" ||
    entry.itemType === "file_change" ||
    (entry.changedFiles?.length ?? 0) > 0
  ) {
    return "patch";
  }
  if (entry.itemType === "web_search") {
    return "search";
  }
  if (entry.itemType === "image_view") {
    return "image";
  }
  if (/\b(read|view|open|cat|show)\b/.test(titleText)) {
    return "file read";
  }
  if (/\b(patch|edit|write|save|copy|update)\b/.test(titleText)) {
    return "patch";
  }
  if (/\b(command|bash|terminal|exec|run)\b/.test(titleText)) {
    return "command";
  }
  if (/\b(search|grep|rg|ripgrep|find)\b/.test(titleText)) {
    return "search";
  }
  return "tool call";
}
