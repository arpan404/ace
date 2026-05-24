import { type MessageId, type ProviderSlashCommand, type TurnId } from "@ace/contracts";
import { IconStack2, IconTerminal } from "@tabler/icons-react";
import {
  normalizeProviderSlashCommandName,
  providerSlashCommandExtensionKind,
  type ProviderExtensionCommandKind,
} from "@ace/shared/providerSlashCommands";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import {
  Fragment,
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type ReactNode,
} from "react";
import { estimateTimelineMessageHeight } from "../../lib/chat/timelineHeight";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "~/lib/composer/inlineChip";
import { formatCommandDisplayLabel } from "~/lib/commandDisplay";
import {
  getChatMessageRenderableText,
  resolveAssistantMessageRenderHint,
} from "../../lib/chat/messageText";
import {
  buildMarkdownRenderAnalysisCacheKey,
  shouldWorkerizeMarkdownRenderAnalysis,
  type MarkdownRenderAnalysisInput,
} from "../../lib/chat/markdownRenderAnalysis";
import { prewarmMarkdownRenderAnalysis } from "../../lib/chat/markdownRenderAnalysisClient";
import { deriveTimelineEntries } from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  ArrowLeftRightIcon,
  BrainIcon,
  CheckIcon,
  CircleAlertIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Clock3Icon,
  EyeIcon,
  GitForkIcon,
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  PlugIcon,
  SquarePenIcon,
  TargetIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import { normalizeCompactToolLabel } from "~/lib/chat/messagesTimeline";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { VscodeEntryIcon } from "./VscodeEntryIcon";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { measureRenderWork } from "~/lib/renderProfiling";
import { type TimestampFormat } from "@ace/contracts/settings";
import { formatTimestamp } from "../../timestampFormat";
import { basenameOfPath, inferEntryKindFromPath } from "../../vscode-icons";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  findTextIndexOf,
  textContainsInlineTerminalContextLabels,
} from "~/lib/chat/userMessageTerminalContexts";
import {
  buildTimelineRows,
  isCompletedAssistantMessageRow,
  isEventInActiveTurn,
  shouldWorkerizeTimelineRows,
  type AssistantTimelineMessage,
  type BuildTimelineRowsInput,
  type TimelineCompletedWorkDiagnosticRow,
  type SystemTimelineMessage,
  type TimelineCompletedWorkDetailRow,
  type TimelineMetaTone,
  type TimelineMetaGroupEntry,
  type TimelineMessage,
  type TimelineProposedPlan,
  type TimelineRow,
  type TimelineWorkEntry,
  type TimelineWorkGroupIconKey,
  type TimelineWorkGroupSummaryProjection,
  type TimelineWorkLogRow,
  type UserTimelineMessage,
} from "~/lib/chat/timelineRows";
import {
  buildTimelineRowsCacheKey,
  prewarmTimelineRows,
  readCachedTimelineRows,
  writeCachedTimelineRows,
} from "~/lib/chat/timelineRowsClient";
import type { StuckTurnSnapshot } from "~/lib/reliability/stuckTurn";

const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;
const TIMELINE_VIRTUALIZER_OVERSCAN = 12;
const MAX_TIMELINE_ROW_HEIGHT_CACHE_ENTRIES = 4_096;
const IMMEDIATE_ASSISTANT_MARKDOWN_TAIL_MESSAGES = 12;
const ASSISTANT_MARKDOWN_IDLE_BATCH_SIZE = 2;
const DEFAULT_TURN_DIFF_DIRECTORIES_EXPANDED = true;
const ASSISTANT_MARKDOWN_IDLE_TIMEOUT_MS = 600;
const ASSISTANT_MARKDOWN_FALLBACK_DELAY_MS = 80;
const TIMELINE_WIDTH_RESIZE_DEBOUNCE_MS = 96;
const TIMELINE_INITIAL_VIEWPORT_HEIGHT_PX = 720;
const TIMELINE_FALLBACK_VIRTUAL_RANGE_MIN_ROWS = TIMELINE_VIRTUALIZER_OVERSCAN * 2 + 8;
const EMPTY_TIMELINE_ROWS: ReadonlyArray<TimelineRow> = [];
const ASSISTANT_IMAGE_GENERATION_MESSAGE_ID_REGEX =
  /^assistant:image:(?<width>\d{2,5})x(?<height>\d{2,5}):/u;
const IMAGE_GENERATION_FRAME_MAX_WIDTH_REM = 42;
const IMAGE_GENERATION_LANDSCAPE_FRAME_MAX_HEIGHT_VH = 54;
const IMAGE_GENERATION_SQUARE_FRAME_MAX_HEIGHT_VH = 46;
const EMPTY_MESSAGE_TURN_COUNT_MAP = new Map<MessageId, number>();
const IMAGE_GENERATION_PORTRAIT_FRAME_MAX_HEIGHT_VH = 42;

interface AssistantImageGenerationPlaceholder {
  readonly width: number;
  readonly height: number;
}

function InlineTooltip(props: {
  children: ReactNode;
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
}) {
  if (
    typeof props.content === "string" &&
    (props.content.length > 240 || props.content.split("\n").length > 4)
  ) {
    return <span className={props.className}>{props.children}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={props.className} />}>
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side={props.side} align={props.align} className="max-w-96 whitespace-pre-wrap">
        {props.content}
      </TooltipPopup>
    </Tooltip>
  );
}

function canResolveTimelineRowsInWorker(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof Worker !== "undefined" &&
    typeof document.createElement === "function"
  );
}

export function shouldRenderTimelineVirtualizedBuffer(input: {
  readonly virtualizedRowCount: number;
}): boolean {
  return input.virtualizedRowCount > 0;
}

export function deriveFallbackTimelineVirtualItems(input: {
  readonly rowCount: number;
  readonly estimateSize: (index: number) => number;
  readonly getItemKey: (index: number) => VirtualItem["key"];
  readonly overscan: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
}): VirtualItem[] {
  if (input.rowCount <= 0) {
    return [];
  }

  const viewportHeight = Math.max(1, input.viewportHeight);
  const starts: number[] = [];
  const sizes: number[] = [];
  let totalSize = 0;
  for (let index = 0; index < input.rowCount; index += 1) {
    const rawSize = input.estimateSize(index);
    const size = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 96;
    starts.push(totalSize);
    sizes.push(size);
    totalSize += size;
  }

  const maxScrollTop = Math.max(totalSize - viewportHeight, 0);
  const scrollTop = Math.min(Math.max(input.scrollTop, 0), maxScrollTop);
  const visibleStart = Math.max(scrollTop - viewportHeight, 0);
  const visibleEnd = Math.min(scrollTop + viewportHeight * 2, totalSize);

  let startIndex = 0;
  while (
    startIndex < input.rowCount - 1 &&
    (starts[startIndex] ?? 0) + (sizes[startIndex] ?? 0) < visibleStart
  ) {
    startIndex += 1;
  }

  let endIndex = startIndex;
  while (endIndex < input.rowCount - 1 && (starts[endIndex] ?? 0) <= visibleEnd) {
    endIndex += 1;
  }

  startIndex = Math.max(0, startIndex - input.overscan);
  endIndex = Math.min(input.rowCount - 1, endIndex + input.overscan);

  if (endIndex - startIndex + 1 < TIMELINE_FALLBACK_VIRTUAL_RANGE_MIN_ROWS) {
    const missingRows = TIMELINE_FALLBACK_VIRTUAL_RANGE_MIN_ROWS - (endIndex - startIndex + 1);
    const prependRows = Math.min(startIndex, Math.floor(missingRows / 2));
    startIndex -= prependRows;
    endIndex = Math.min(input.rowCount - 1, endIndex + missingRows - prependRows);
  }

  const items: VirtualItem[] = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const start = starts[index] ?? 0;
    const size = sizes[index] ?? 96;
    items.push({
      key: input.getItemKey(index),
      index,
      start,
      end: start + size,
      size,
      lane: 0,
    });
  }
  return items;
}

function assistantImageGenerationDimensionsFromMessageId(
  message: AssistantTimelineMessage,
): AssistantImageGenerationPlaceholder | null {
  const match = ASSISTANT_IMAGE_GENERATION_MESSAGE_ID_REGEX.exec(String(message.id));
  const width = match?.groups?.width ? Number(match.groups.width) : Number.NaN;
  const height = match?.groups?.height ? Number(match.groups.height) : Number.NaN;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function assistantImageGenerationPlaceholder(
  message: AssistantTimelineMessage,
): AssistantImageGenerationPlaceholder | null {
  if (!message.streaming || (message.attachments?.length ?? 0) > 0) {
    return null;
  }
  return assistantImageGenerationDimensionsFromMessageId(message);
}

function imageGenerationFrameStyle(dimensions: AssistantImageGenerationPlaceholder): CSSProperties {
  const aspectRatio = dimensions.width / dimensions.height;
  const maxHeightVh =
    aspectRatio < 0.9
      ? IMAGE_GENERATION_PORTRAIT_FRAME_MAX_HEIGHT_VH
      : aspectRatio <= 1.15
        ? IMAGE_GENERATION_SQUARE_FRAME_MAX_HEIGHT_VH
        : IMAGE_GENERATION_LANDSCAPE_FRAME_MAX_HEIGHT_VH;
  const widthVh = maxHeightVh * aspectRatio;
  return {
    aspectRatio: `${dimensions.width} / ${dimensions.height}`,
    maxWidth: `min(100%, ${IMAGE_GENERATION_FRAME_MAX_WIDTH_REM}rem)`,
    width: `${Number(widthVh.toFixed(4))}vh`,
  };
}

const timelineRowHeightCache = new Map<string, number>();
type TimelineIcon = ComponentType<{ className?: string }>;
export interface AssistantMarkdownAnalysisPrewarmJob {
  readonly cacheKey: string;
  readonly input: MarkdownRenderAnalysisInput;
}
interface AssistantMarkdownIdleDeadline {
  readonly didTimeout: boolean;
  timeRemaining(): number;
}

type AssistantMarkdownIdleHandle =
  | { readonly kind: "idle"; readonly id: number }
  | { readonly kind: "timeout"; readonly id: number };

function requestAssistantMarkdownIdleCallback(
  callback: (deadline: AssistantMarkdownIdleDeadline) => void,
): AssistantMarkdownIdleHandle {
  const idleWindow = window as Window & {
    requestIdleCallback?: (
      callback: (deadline: AssistantMarkdownIdleDeadline) => void,
      options?: { timeout: number },
    ) => number;
  };
  if (typeof idleWindow.requestIdleCallback === "function") {
    return {
      kind: "idle",
      id: idleWindow.requestIdleCallback(callback, {
        timeout: ASSISTANT_MARKDOWN_IDLE_TIMEOUT_MS,
      }),
    };
  }
  return {
    kind: "timeout",
    id: window.setTimeout(() => {
      callback({
        didTimeout: true,
        timeRemaining: () => 0,
      });
    }, ASSISTANT_MARKDOWN_FALLBACK_DELAY_MS),
  };
}

function cancelAssistantMarkdownIdleCallback(handle: AssistantMarkdownIdleHandle): void {
  if (handle.kind === "timeout") {
    window.clearTimeout(handle.id);
    return;
  }
  const idleWindow = window as Window & {
    cancelIdleCallback?: (id: number) => void;
  };
  idleWindow.cancelIdleCallback?.(handle.id);
}

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
  stuckTurnSnapshot?: StuckTurnSnapshot;
  onStopStuckTurn?: (() => void) | null;
  onOpenStuckTurnDiagnostics?: (() => void) | null;
  backgroundMarkdownPrewarm?: boolean;
  getScrollContainer: () => HTMLDivElement | null;
  hideCompletedWorkMessages?: boolean;
  liveTimers?: boolean;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  revertTurnCountByAssistantMessageId?: Map<MessageId, number>;
  onRevertAssistantMessage?: (messageId: MessageId) => void;
  revertActionTitle?: string;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  markdownCwd: string | undefined;
  onOpenBrowserUrl?: ((url: string) => void) | null;
  onOpenFilePath?: ((path: string) => void) | null;
  enableLocalFileLinks?: boolean;
  providerCommands?: ReadonlyArray<ProviderSlashCommand>;
  onForkConversation?: (() => void) | null;
  isForkConversationDisabled?: boolean;
  enableGoalWorkingState?: boolean;
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
  stuckTurnSnapshot,
  onStopStuckTurn = null,
  onOpenStuckTurnDiagnostics = null,
  backgroundMarkdownPrewarm = true,
  getScrollContainer,
  hideCompletedWorkMessages = false,
  liveTimers = true,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  revertTurnCountByAssistantMessageId = EMPTY_MESSAGE_TURN_COUNT_MAP,
  onRevertAssistantMessage,
  revertActionTitle = "Revert to this message",
  isRevertingCheckpoint,
  onImageExpand,
  markdownCwd,
  onOpenBrowserUrl = null,
  onOpenFilePath = null,
  enableLocalFileLinks = true,
  providerCommands = [],
  onForkConversation = null,
  isForkConversationDisabled = false,
  enableGoalWorkingState = false,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
}: MessagesTimelineProps) {
  const userMessageProviderCommandLookup = useMemo(
    () => buildUserMessageProviderCommandLookup(providerCommands),
    [providerCommands],
  );
  const supportsForkConversation = useMemo(
    () => hasProviderSlashCommand(providerCommands, "fork"),
    [providerCommands],
  );
  const timelineRowsInput = useMemo<BuildTimelineRowsInput>(
    () => ({
      timelineEntries,
      activeTurnInProgress,
      activeTurnStartedAt,
      completionDividerBeforeEntryId,
      completionSummary,
      hideCompletedWorkMessages,
      isWorking,
      enableGoalWorkingState,
    }),
    [
      activeTurnInProgress,
      timelineEntries,
      completionDividerBeforeEntryId,
      completionSummary,
      hideCompletedWorkMessages,
      isWorking,
      activeTurnStartedAt,
      enableGoalWorkingState,
    ],
  );
  const shouldResolveTimelineRowsInWorker = useMemo(
    () => canResolveTimelineRowsInWorker() && shouldWorkerizeTimelineRows(timelineRowsInput),
    [timelineRowsInput],
  );
  const timelineRowsCacheKey = useMemo(
    () => buildTimelineRowsCacheKey(timelineRowsInput),
    [timelineRowsInput],
  );
  const cachedTimelineRows = readCachedTimelineRows(timelineRowsCacheKey);
  const syncTimelineRows = useMemo<ReadonlyArray<TimelineRow>>(() => {
    if (cachedTimelineRows) {
      return cachedTimelineRows;
    }
    return measureRenderWork("chat.buildTimelineRows", () => buildTimelineRows(timelineRowsInput));
  }, [cachedTimelineRows, timelineRowsInput]);
  const rows = syncTimelineRows.length > 0 ? syncTimelineRows : EMPTY_TIMELINE_ROWS;

  useEffect(() => {
    if (cachedTimelineRows) {
      return;
    }
    writeCachedTimelineRows(timelineRowsCacheKey, timelineRowsInput, syncTimelineRows);
  }, [cachedTimelineRows, syncTimelineRows, timelineRowsCacheKey, timelineRowsInput]);

  useEffect(() => {
    if (!shouldResolveTimelineRowsInWorker || cachedTimelineRows) {
      return;
    }
    prewarmTimelineRows(timelineRowsCacheKey, timelineRowsInput);
  }, [
    cachedTimelineRows,
    shouldResolveTimelineRowsInWorker,
    timelineRowsCacheKey,
    timelineRowsInput,
  ]);

  const activeTurnStartedAtMs =
    activeTurnInProgress && activeTurnStartedAt ? Date.parse(activeTurnStartedAt) : Number.NaN;
  const [allDirectoriesExpandedByTurnId, setAllDirectoriesExpandedByTurnId] = useState<
    Record<string, boolean>
  >({});
  const [timelineRootElement, setTimelineRootElement] = useState<HTMLDivElement | null>(null);
  const [timelineWidthPx, setTimelineWidthPx] = useState<number | null>(null);
  const [renderedAssistantMarkdownMessageIds, setRenderedAssistantMarkdownMessageIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const onToggleAllDirectories = useCallback((turnId: TurnId) => {
    setAllDirectoriesExpandedByTurnId((current) => ({
      ...current,
      [turnId]: !(current[turnId] ?? DEFAULT_TURN_DIFF_DIRECTORIES_EXPANDED),
    }));
  }, []);

  useEffect(() => {
    if (!timelineRootElement) {
      setTimelineWidthPx(null);
      return;
    }

    let pendingWidth: number | null = null;
    let timeoutId: number | null = null;

    const updateWidth = (nextWidth: number) => {
      setTimelineWidthPx((current) =>
        current !== null && Math.abs(current - nextWidth) < 0.5 ? current : nextWidth,
      );
    };
    const scheduleWidthUpdate = (nextWidth: number) => {
      pendingWidth = nextWidth;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        const width = pendingWidth;
        pendingWidth = null;
        if (width !== null) {
          updateWidth(width);
        }
      }, TIMELINE_WIDTH_RESIZE_DEBOUNCE_MS);
    };

    updateWidth(timelineRootElement.clientWidth);

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) {
        return;
      }
      scheduleWidthUpdate(entry.contentRect.width);
    });
    observer.observe(timelineRootElement);
    return () => {
      observer.disconnect();
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
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
  const measuredRowElementByIdRef = useRef(new Map<string, HTMLDivElement>());
  const measuredRowVirtualIndexByIdRef = useRef(new Map<string, number>());
  const measuredRowMeasurementFrameByIdRef = useRef(new Map<string, number>());
  const measuredRowResizeObserverByIdRef = useRef(new Map<string, ResizeObserver>());
  const measuredRowHeightByIdRef = useRef(new Map<string, number>());
  const estimateVirtualizedRowSize = useCallback(
    (index: number) =>
      estimateTimelineRowHeight(virtualizedRows[index], {
        timelineWidthPx,
        expandedWorkGroups,
      }),
    [expandedWorkGroups, timelineWidthPx, virtualizedRows],
  );
  const rowVirtualizer = useVirtualizer({
    count: virtualizedRows.length,
    estimateSize: estimateVirtualizedRowSize,
    getItemKey: getVirtualRowKey,
    getScrollElement: getScrollContainer,
    initialRect: { width: 0, height: TIMELINE_INITIAL_VIEWPORT_HEIGHT_PX },
    overscan: TIMELINE_VIRTUALIZER_OVERSCAN,
    useAnimationFrameWithResizeObserver: true,
  });
  const shouldUseVirtualizedBuffer = virtualizedRows.length > 0;
  const shouldPrioritizeAssistantMarkdown = shouldUseVirtualizedBuffer;
  const shouldPrewarmAssistantMarkdown =
    shouldPrioritizeAssistantMarkdown && backgroundMarkdownPrewarm;
  const virtualItems = shouldUseVirtualizedBuffer ? rowVirtualizer.getVirtualItems() : [];
  const fallbackVirtualItems = useMemo(() => {
    if (!shouldUseVirtualizedBuffer || virtualItems.length > 0) {
      return [];
    }
    const scrollContainer = getScrollContainer();
    return deriveFallbackTimelineVirtualItems({
      rowCount: virtualizedRows.length,
      estimateSize: estimateVirtualizedRowSize,
      getItemKey: getVirtualRowKey,
      overscan: TIMELINE_VIRTUALIZER_OVERSCAN,
      scrollTop: scrollContainer?.scrollTop ?? Number.POSITIVE_INFINITY,
      viewportHeight: scrollContainer?.clientHeight ?? TIMELINE_INITIAL_VIEWPORT_HEIGHT_PX,
    });
  }, [
    estimateVirtualizedRowSize,
    getScrollContainer,
    getVirtualRowKey,
    shouldUseVirtualizedBuffer,
    virtualItems.length,
    virtualizedRows.length,
  ]);
  const renderedVirtualItems = virtualItems.length > 0 ? virtualItems : fallbackVirtualItems;
  const shouldRenderVirtualizedBuffer = shouldRenderTimelineVirtualizedBuffer({
    virtualizedRowCount: virtualizedRows.length,
  });
  const virtualizedBufferHeight =
    renderedVirtualItems.length > 0
      ? Math.max(rowVirtualizer.getTotalSize(), renderedVirtualItems.at(-1)?.end ?? 0)
      : rowVirtualizer.getTotalSize();
  const mountedVirtualizedAssistantMarkdownMessageIds = shouldPrioritizeAssistantMarkdown
    ? deriveMountedVirtualizedAssistantMarkdownMessageIds(renderedVirtualItems, virtualizedRows)
    : [];
  const mountedVirtualizedAssistantMarkdownMessageIdKey =
    mountedVirtualizedAssistantMarkdownMessageIds.join("\0");
  const mountedVirtualizedAssistantMarkdownMessageIdSet = useMemo(
    () =>
      new Set(
        mountedVirtualizedAssistantMarkdownMessageIdKey.length > 0
          ? mountedVirtualizedAssistantMarkdownMessageIdKey.split("\0")
          : [],
      ),
    [mountedVirtualizedAssistantMarkdownMessageIdKey],
  );
  const immediateAssistantMarkdownMessageIds = useMemo(
    () =>
      shouldPrioritizeAssistantMarkdown
        ? deriveImmediateAssistantMarkdownMessageIds(rows, firstUnvirtualizedRowIndex)
        : [],
    [firstUnvirtualizedRowIndex, rows, shouldPrioritizeAssistantMarkdown],
  );
  const immediateAssistantMarkdownMessageIdSet = useMemo(
    () => new Set(immediateAssistantMarkdownMessageIds),
    [immediateAssistantMarkdownMessageIds],
  );
  const allAssistantMarkdownMessageIds = useMemo(() => {
    const messageIds: string[] = [];
    for (const row of rows) {
      if (isCompletedAssistantMessageRow(row)) {
        messageIds.push(String(row.message.id));
      }
    }
    return messageIds;
  }, [rows]);
  const pendingAssistantMarkdownMessageIds = useMemo(
    () =>
      shouldPrewarmAssistantMarkdown
        ? derivePendingAssistantMarkdownMessageIdsBottomUp(rows, {
            firstUnvirtualizedRowIndex,
            immediateMessageIds: immediateAssistantMarkdownMessageIdSet,
            mountedMessageIds: mountedVirtualizedAssistantMarkdownMessageIdSet,
            renderedMessageIds: renderedAssistantMarkdownMessageIds,
          })
        : [],
    [
      firstUnvirtualizedRowIndex,
      immediateAssistantMarkdownMessageIdSet,
      mountedVirtualizedAssistantMarkdownMessageIdSet,
      renderedAssistantMarkdownMessageIds,
      rows,
      shouldPrewarmAssistantMarkdown,
    ],
  );
  const assistantMarkdownAnalysisPrewarmJobs = useMemo(() => {
    if (!shouldPrewarmAssistantMarkdown) {
      return [];
    }
    return buildAssistantMarkdownAnalysisPrewarmJobs({
      rows,
      immediateMessageIds: immediateAssistantMarkdownMessageIds,
      pendingMessageIds: pendingAssistantMarkdownMessageIds,
    });
  }, [
    immediateAssistantMarkdownMessageIds,
    pendingAssistantMarkdownMessageIds,
    rows,
    shouldPrewarmAssistantMarkdown,
  ]);
  const allAssistantMarkdownMessageIdKey = allAssistantMarkdownMessageIds.join("\0");
  const immediateAssistantMarkdownMessageIdKey = immediateAssistantMarkdownMessageIds.join("\0");
  const pendingAssistantMarkdownMessageIdKey = pendingAssistantMarkdownMessageIds.join("\0");
  const assistantMarkdownAnalysisPrewarmJobKey = assistantMarkdownAnalysisPrewarmJobs
    .map((job) => job.cacheKey)
    .join("\0");
  const assistantMarkdownPriorityRef = useRef({
    allMessageIds: allAssistantMarkdownMessageIds,
    immediateMessageIds: immediateAssistantMarkdownMessageIds,
    mountedMessageIds: mountedVirtualizedAssistantMarkdownMessageIds,
    pendingMessageIds: pendingAssistantMarkdownMessageIds,
  });
  assistantMarkdownPriorityRef.current = {
    allMessageIds: allAssistantMarkdownMessageIds,
    immediateMessageIds: immediateAssistantMarkdownMessageIds,
    mountedMessageIds: mountedVirtualizedAssistantMarkdownMessageIds,
    pendingMessageIds: pendingAssistantMarkdownMessageIds,
  };

  useEffect(() => {
    if (!shouldPrioritizeAssistantMarkdown) {
      setRenderedAssistantMarkdownMessageIds((current) =>
        current.size === 0 ? current : new Set(),
      );
      return;
    }
    const { allMessageIds, immediateMessageIds, mountedMessageIds } =
      assistantMarkdownPriorityRef.current;
    const validMessageIds = new Set(allMessageIds);
    setRenderedAssistantMarkdownMessageIds((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const messageId of current) {
        if (!validMessageIds.has(messageId)) {
          changed = true;
          continue;
        }
        next.add(messageId);
      }
      for (const messageId of immediateMessageIds) {
        if (!next.has(messageId)) {
          changed = true;
          next.add(messageId);
        }
      }
      for (const messageId of mountedMessageIds) {
        if (!next.has(messageId)) {
          changed = true;
          next.add(messageId);
        }
      }
      return changed ? next : current;
    });
  }, [
    allAssistantMarkdownMessageIdKey,
    immediateAssistantMarkdownMessageIdKey,
    mountedVirtualizedAssistantMarkdownMessageIdKey,
    shouldPrioritizeAssistantMarkdown,
  ]);

  useEffect(() => {
    if (!shouldPrewarmAssistantMarkdown || pendingAssistantMarkdownMessageIdKey.length === 0) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    const pendingMessageIds = assistantMarkdownPriorityRef.current.pendingMessageIds;

    let cancelled = false;
    let cursor = 0;
    let idleHandle: AssistantMarkdownIdleHandle | null = null;

    const activateNextBatch = (deadline: AssistantMarkdownIdleDeadline) => {
      if (cancelled) {
        return;
      }
      const batch: string[] = [];
      while (
        cursor < pendingMessageIds.length &&
        batch.length < ASSISTANT_MARKDOWN_IDLE_BATCH_SIZE &&
        (batch.length === 0 || deadline.didTimeout || deadline.timeRemaining() > 6)
      ) {
        const messageId = pendingMessageIds[cursor];
        cursor += 1;
        if (messageId) {
          batch.push(messageId);
        }
      }
      if (batch.length > 0) {
        startTransition(() => {
          setRenderedAssistantMarkdownMessageIds((current) => {
            let changed = false;
            const next = new Set(current);
            for (const messageId of batch) {
              if (!next.has(messageId)) {
                changed = true;
                next.add(messageId);
              }
            }
            return changed ? next : current;
          });
        });
      }
      if (cursor >= pendingMessageIds.length) {
        return;
      }
      idleHandle = requestAssistantMarkdownIdleCallback(activateNextBatch);
    };

    idleHandle = requestAssistantMarkdownIdleCallback(activateNextBatch);
    return () => {
      cancelled = true;
      if (idleHandle !== null) {
        cancelAssistantMarkdownIdleCallback(idleHandle);
      }
    };
  }, [pendingAssistantMarkdownMessageIdKey, shouldPrewarmAssistantMarkdown]);
  useEffect(() => {
    if (!shouldPrewarmAssistantMarkdown || assistantMarkdownAnalysisPrewarmJobs.length === 0) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }

    let cancelled = false;
    let cursor = 0;
    let idleHandle: AssistantMarkdownIdleHandle | null = null;

    const prewarmNextBatch = (deadline: AssistantMarkdownIdleDeadline) => {
      if (cancelled) {
        return;
      }
      let processed = 0;
      while (
        cursor < assistantMarkdownAnalysisPrewarmJobs.length &&
        processed < ASSISTANT_MARKDOWN_IDLE_BATCH_SIZE &&
        (processed === 0 || deadline.didTimeout || deadline.timeRemaining() > 6)
      ) {
        const job = assistantMarkdownAnalysisPrewarmJobs[cursor];
        cursor += 1;
        if (!job) {
          continue;
        }
        prewarmMarkdownRenderAnalysis(job.cacheKey, job.input);
        processed += 1;
      }
      if (cursor >= assistantMarkdownAnalysisPrewarmJobs.length) {
        return;
      }
      idleHandle = requestAssistantMarkdownIdleCallback(prewarmNextBatch);
    };

    idleHandle = requestAssistantMarkdownIdleCallback(prewarmNextBatch);
    return () => {
      cancelled = true;
      if (idleHandle !== null) {
        cancelAssistantMarkdownIdleCallback(idleHandle);
      }
    };
  }, [
    assistantMarkdownAnalysisPrewarmJobKey,
    assistantMarkdownAnalysisPrewarmJobs,
    shouldPrewarmAssistantMarkdown,
  ]);
  const scheduleMeasuredRowResize = useCallback(
    (rowId: string, nextHeight: number) => {
      const pendingFrameId = measuredRowMeasurementFrameByIdRef.current.get(rowId);
      if (pendingFrameId !== undefined && typeof window !== "undefined") {
        window.cancelAnimationFrame(pendingFrameId);
        measuredRowMeasurementFrameByIdRef.current.delete(rowId);
      }

      const applyResize = () => {
        const index = measuredRowVirtualIndexByIdRef.current.get(rowId);
        if (index === undefined) {
          return;
        }
        const cachedHeight = measuredRowHeightByIdRef.current.get(rowId);
        if (cachedHeight === nextHeight) {
          return;
        }
        measuredRowHeightByIdRef.current.set(rowId, nextHeight);
        rowVirtualizer.resizeItem(index, nextHeight);
      };

      if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        const frameId = window.requestAnimationFrame(() => {
          measuredRowMeasurementFrameByIdRef.current.delete(rowId);
          applyResize();
        });
        measuredRowMeasurementFrameByIdRef.current.set(rowId, frameId);
        return;
      }
      applyResize();
    },
    [rowVirtualizer],
  );

  const registerMeasuredRowElement = useCallback(
    (rowId: string, index: number, element: HTMLDivElement | null) => {
      measuredRowVirtualIndexByIdRef.current.set(rowId, index);

      const pendingFrameId = measuredRowMeasurementFrameByIdRef.current.get(rowId);
      if (pendingFrameId !== undefined && typeof window !== "undefined") {
        window.cancelAnimationFrame(pendingFrameId);
        measuredRowMeasurementFrameByIdRef.current.delete(rowId);
      }

      const observer = measuredRowResizeObserverByIdRef.current.get(rowId);
      if (observer) {
        observer.disconnect();
        measuredRowResizeObserverByIdRef.current.delete(rowId);
      }

      if (!element) {
        measuredRowElementByIdRef.current.delete(rowId);
        measuredRowVirtualIndexByIdRef.current.delete(rowId);
        measuredRowHeightByIdRef.current.delete(rowId);
        return;
      }

      measuredRowElementByIdRef.current.set(rowId, element);

      if (typeof ResizeObserver === "undefined") {
        scheduleMeasuredRowResize(rowId, Math.ceil(element.offsetHeight));
        return;
      }

      const resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) {
          return;
        }
        const borderBoxSize = Array.isArray(entry.borderBoxSize)
          ? entry.borderBoxSize[0]
          : entry.borderBoxSize;
        const nextHeight = Math.ceil(borderBoxSize?.blockSize ?? entry.contentRect.height);
        scheduleMeasuredRowResize(rowId, nextHeight);
      });
      resizeObserver.observe(element, { box: "border-box" });
      measuredRowResizeObserverByIdRef.current.set(rowId, resizeObserver);
    },
    [scheduleMeasuredRowResize],
  );

  useEffect(() => {
    const measuredRowMeasurementFrameById = measuredRowMeasurementFrameByIdRef.current;
    const measuredRowResizeObserverById = measuredRowResizeObserverByIdRef.current;
    const measuredRowElementById = measuredRowElementByIdRef.current;
    const measuredRowVirtualIndexById = measuredRowVirtualIndexByIdRef.current;
    const measuredRowHeightById = measuredRowHeightByIdRef.current;

    return () => {
      if (typeof window === "undefined") {
        measuredRowMeasurementFrameById.clear();
      } else {
        for (const frameId of measuredRowMeasurementFrameById.values()) {
          window.cancelAnimationFrame(frameId);
        }
      }
      for (const observer of measuredRowResizeObserverById.values()) {
        observer.disconnect();
      }
      measuredRowMeasurementFrameById.clear();
      measuredRowResizeObserverById.clear();
      measuredRowElementById.clear();
      measuredRowVirtualIndexById.clear();
      measuredRowHeightById.clear();
    };
  }, []);

  const buildRowContent = (row: TimelineRow, _rowIndex: number) => {
    return (
      <div
        className="group/timeline relative pb-3"
        data-timeline-row-kind={row.kind}
        data-message-id={row.kind === "message" ? row.message.id : undefined}
        data-message-role={row.kind === "message" ? row.message.role : undefined}
      >
        {row.kind === "completed-work-summary" && (
          <CompletedWorkSummaryTimelineRow
            row={row}
            enableLocalFileLinks={enableLocalFileLinks}
            expandedWorkGroups={expandedWorkGroups}
            liveTimers={liveTimers}
            markdownCwd={markdownCwd}
            onImageExpand={onImageExpand}
            onOpenBrowserUrl={onOpenBrowserUrl}
            onOpenFilePath={onOpenFilePath}
            onToggleWorkGroup={onToggleWorkGroup}
            timestampFormat={timestampFormat}
          />
        )}

        {(row.kind === "work" || row.kind === "work-group" || row.kind === "intent") && (
          <WorkLogTimelineRow
            row={row}
            expandedWorkGroups={expandedWorkGroups}
            onToggleWorkGroup={onToggleWorkGroup}
          />
        )}

        {row.kind === "message" && isUserTimelineMessage(row.message) && (
          <UserMessageTimelineRow
            canRevertAgentWork={revertTurnCountByUserMessageId.has(row.message.id)}
            isRevertingCheckpoint={isRevertingCheckpoint}
            isWorking={isWorking}
            message={row.message}
            onImageExpand={onImageExpand}
            onRevertUserMessage={onRevertUserMessage}
            providerCommandLookup={userMessageProviderCommandLookup}
            revertActionTitle={revertActionTitle}
            resolvedTheme={resolvedTheme}
            timestampFormat={timestampFormat}
          />
        )}

        {row.kind === "message" && isSystemTimelineMessage(row.message) && (
          <SystemMessageTimelineRow message={row.message} />
        )}

        {row.kind === "message" &&
          isAssistantTimelineMessage(row.message) &&
          (() => {
            const turnSummary = turnDiffSummaryByAssistantMessageId.get(row.message.id) ?? null;
            const shouldShowTurnSummary =
              turnSummary !== null &&
              turnSummary.files.length > 0 &&
              !(activeTurnInProgress && isEventInActiveTurn(row.createdAt, activeTurnStartedAtMs));
            const assistantMessageId = String(row.message.id);
            const canRevertTurnDiffSummary =
              onRevertAssistantMessage !== undefined &&
              revertTurnCountByAssistantMessageId.has(row.message.id);
            const renderedAssistantText = getChatMessageRenderableText(row.message);
            const assistantCopyText =
              renderedAssistantText.trim().length > 0 ? renderedAssistantText : null;
            const assistantTiming = resolveAssistantTurnTiming({
              completedAt: row.message.completedAt ?? null,
              durationStart: row.durationStart,
              isAssistantTurnTerminal: row.isAssistantTurnTerminal ?? false,
              showCompletedTiming: row.showAssistantTiming ?? false,
              timestampFormat,
            });
            const shouldPersistAssistantFooter = Boolean(
              row.completionSummary || row.showAssistantSummaryByDefault,
            );
            const shouldRenderAssistantMarkdown =
              !shouldPrioritizeAssistantMarkdown ||
              row.message.streaming ||
              immediateAssistantMarkdownMessageIdSet.has(assistantMessageId) ||
              mountedVirtualizedAssistantMarkdownMessageIdSet.has(assistantMessageId) ||
              renderedAssistantMarkdownMessageIds.has(assistantMessageId);

            return (
              <div className="min-w-0">
                <AssistantMessageTimelineRow
                  completionSummary={row.completionSummary}
                  durationStart={row.durationStart}
                  isAssistantTurnTerminal={row.isAssistantTurnTerminal ?? false}
                  liveTimers={liveTimers}
                  showCompletedTiming={row.showAssistantTiming ?? false}
                  showAssistantSummaryByDefault={row.showAssistantSummaryByDefault ?? false}
                  suppressFooter={shouldShowTurnSummary}
                  markdownCwd={markdownCwd}
                  message={row.message}
                  onImageExpand={onImageExpand}
                  onOpenBrowserUrl={onOpenBrowserUrl}
                  onOpenFilePath={onOpenFilePath}
                  enableLocalFileLinks={enableLocalFileLinks}
                  onForkConversation={supportsForkConversation ? onForkConversation : null}
                  isForkConversationDisabled={isForkConversationDisabled}
                  renderMarkdown={shouldRenderAssistantMarkdown}
                  timestampFormat={timestampFormat}
                />
                {shouldShowTurnSummary && (
                  <div className="mt-2.5 max-w-3xl">
                    <AssistantMessageTurnDiffSummary
                      allDirectoriesExpanded={
                        allDirectoriesExpandedByTurnId[turnSummary.turnId] ??
                        DEFAULT_TURN_DIFF_DIRECTORIES_EXPANDED
                      }
                      onOpenTurnDiff={onOpenTurnDiff}
                      canRevert={canRevertTurnDiffSummary}
                      isRevertingCheckpoint={isRevertingCheckpoint}
                      isWorking={isWorking}
                      onRevert={
                        canRevertTurnDiffSummary
                          ? () => onRevertAssistantMessage(row.message.id)
                          : undefined
                      }
                      onToggleAllDirectories={onToggleAllDirectories}
                      revertActionTitle={revertActionTitle}
                      resolvedTheme={resolvedTheme}
                      turnSummary={turnSummary}
                    />
                    <AssistantTurnFooter
                      copyText={assistantCopyText}
                      onForkConversation={supportsForkConversation ? onForkConversation : null}
                      isForkConversationDisabled={isForkConversationDisabled}
                      persistVisible={shouldPersistAssistantFooter}
                      timing={assistantTiming}
                    />
                  </div>
                )}
              </div>
            );
          })()}

        {row.kind === "proposed-plan" && (
          <ProposedPlanTimelineRow
            cwd={markdownCwd}
            onOpenBrowserUrl={onOpenBrowserUrl}
            onOpenFilePath={onOpenFilePath}
            enableLocalFileLinks={enableLocalFileLinks}
            proposedPlan={row.proposedPlan}
            workspaceRoot={workspaceRoot}
          />
        )}

        {row.kind === "working" && (
          <div className="min-w-0 py-1">
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground/72">
              <span className="inline-flex min-w-0 items-center gap-2">
                <WorkingActivityIndicator />
                {row.createdAt ? (
                  <WorkingTimer
                    createdAt={row.createdAt}
                    label={row.mode === "silent-thinking" ? "Getting started for" : "Working for"}
                    live={liveTimers}
                  />
                ) : row.mode === "silent-thinking" ? (
                  "Getting started..."
                ) : (
                  "Working..."
                )}
              </span>
            </div>
            {row.activity === "goal" && (
              <div
                className="mt-1 flex items-center gap-2 pl-6 text-[11px] leading-5 text-emerald-600/72 dark:text-emerald-400/72"
                data-goal-working-timer="true"
              >
                <TargetIcon className="size-3 shrink-0 text-emerald-600/58 dark:text-emerald-400/58" />
                {row.goalStartedAt ? (
                  <WorkingTimer
                    createdAt={row.goalStartedAt}
                    label="Pursuing goal for"
                    live={liveTimers}
                  />
                ) : (
                  "Pursuing goal..."
                )}
              </div>
            )}
            {row.intentText && (
              <p
                className="mt-1 pl-6 text-[11px] leading-5 text-muted-foreground/66"
                data-inline-intent="true"
              >
                <span className="mr-1 text-[9px] uppercase tracking-[0.14em] text-muted-foreground/38">
                  Intent
                </span>
                <span className="text-foreground/72">{row.intentText}</span>
              </p>
            )}
            {stuckTurnSnapshot?.isLikelyStuck ? (
              <div
                className="mt-2 ml-6 flex max-w-xl flex-wrap items-center gap-2 rounded-md border border-warning/35 bg-warning/6 px-2.5 py-1.5 text-[11px] text-warning"
                data-stuck-turn-hint="true"
              >
                <span className="min-w-0 flex-1">
                  Still running for{" "}
                  {formatElapsedSeconds(Math.floor(stuckTurnSnapshot.runningForMs / 1000))}
                </span>
                {onStopStuckTurn ? (
                  <Button type="button" variant="outline" size="xs" onClick={onStopStuckTurn}>
                    Stop
                  </Button>
                ) : null}
                {onOpenStuckTurnDiagnostics ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={onOpenStuckTurnDiagnostics}
                  >
                    Details
                  </Button>
                ) : null}
              </div>
            ) : null}
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
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => onContinueWithGitHubIssues()}
                      disabled={isContinueWithGitHubIssuesDisabled}
                      className={cn(
                        "inline p-0 h-auto min-h-0 border-0 bg-transparent font-inherit underline underline-offset-2",
                        "cursor-pointer text-primary hover:text-primary/90",
                        "disabled:cursor-not-allowed disabled:opacity-50 disabled:text-muted-foreground disabled:hover:text-muted-foreground",
                      )}
                    />
                  }
                >
                  continue with an open GitHub issue
                </TooltipTrigger>
                {continueWithGitHubIssuesDisabledReason ? (
                  <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap">
                    {continueWithGitHubIssuesDisabledReason}
                  </TooltipPopup>
                ) : null}
              </Tooltip>
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
      {shouldRenderVirtualizedBuffer ? (
        <div
          data-virtualizer-buffer="true"
          className="relative"
          style={{ height: `${virtualizedBufferHeight}px` }}
        >
          {renderedVirtualItems.map((virtualRow) => {
            const row = virtualizedRows[virtualRow.index];
            if (!row) {
              return null;
            }
            return (
              <div
                key={`row:${row.id}`}
                ref={(element) => {
                  registerMeasuredRowElement(row.id, virtualRow.index, element);
                }}
                data-index={virtualRow.index}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {buildRowContent(row, virtualRow.index)}
              </div>
            );
          })}
        </div>
      ) : (
        virtualizedRows.map((row, index) => (
          <div key={`row:${row.id}`}>{buildRowContent(row, index)}</div>
        ))
      )}
      {trailingRows.map((row, index) => (
        <div key={`row:${row.id}`}>{buildRowContent(row, virtualizedRows.length + index)}</div>
      ))}
    </div>
  );
});

function deriveMountedVirtualizedAssistantMarkdownMessageIds(
  virtualItems: ReadonlyArray<VirtualItem>,
  virtualizedRows: ReadonlyArray<TimelineRow>,
): string[] {
  const messageIds: string[] = [];
  for (const virtualItem of virtualItems) {
    const row = virtualizedRows[virtualItem.index];
    if (!row || !isCompletedAssistantMessageRow(row)) {
      continue;
    }
    messageIds.push(String(row.message.id));
  }
  return messageIds;
}

function buildAssistantMarkdownAnalysisStableKey(
  message: AssistantTimelineMessage,
  messageText: string,
): string {
  return `${message.id}:${message.streaming ? "streaming" : (message.completedAt ?? "complete")}:${messageText.length}`;
}

export function buildAssistantMarkdownAnalysisPrewarmJobs(input: {
  rows: ReadonlyArray<TimelineRow>;
  immediateMessageIds: ReadonlyArray<string>;
  pendingMessageIds: ReadonlyArray<string>;
}): AssistantMarkdownAnalysisPrewarmJob[] {
  const requestedMessageIds = [...input.immediateMessageIds, ...input.pendingMessageIds];
  if (requestedMessageIds.length === 0) {
    return [];
  }

  const requestedMessageIdSet = new Set(requestedMessageIds);
  const rowsByMessageId = new Map<string, AssistantTimelineMessage>();
  for (const row of input.rows) {
    if (!isCompletedAssistantMessageRow(row)) {
      continue;
    }
    const messageId = String(row.message.id);
    if (!requestedMessageIdSet.has(messageId)) {
      continue;
    }
    rowsByMessageId.set(messageId, row.message);
  }

  const jobs: AssistantMarkdownAnalysisPrewarmJob[] = [];
  const seenMessageIds = new Set<string>();
  const seenCacheKeys = new Set<string>();
  for (const messageId of requestedMessageIds) {
    if (seenMessageIds.has(messageId)) {
      continue;
    }
    seenMessageIds.add(messageId);

    const message = rowsByMessageId.get(messageId);
    if (!message) {
      continue;
    }

    const messageText = getChatMessageRenderableText(message);
    const jobInput: MarkdownRenderAnalysisInput = {
      text: messageText,
      isStreaming: Boolean(message.streaming),
      renderPlainText: false,
      ...(message.streamingTextState
        ? {
            streamingTextState: {
              totalLineCount: message.streamingTextState.totalLineCount,
              truncatedCharCount: message.streamingTextState.truncatedCharCount,
              truncatedLineCount: message.streamingTextState.truncatedLineCount,
            },
          }
        : {}),
    };
    if (!shouldWorkerizeMarkdownRenderAnalysis(jobInput)) {
      continue;
    }

    const cacheKey = buildMarkdownRenderAnalysisCacheKey(
      jobInput,
      buildAssistantMarkdownAnalysisStableKey(message, messageText),
    );
    if (seenCacheKeys.has(cacheKey)) {
      continue;
    }
    seenCacheKeys.add(cacheKey);
    jobs.push({
      cacheKey,
      input: jobInput,
    });
  }

  return jobs;
}

function deriveImmediateAssistantMarkdownMessageIds(
  rows: ReadonlyArray<TimelineRow>,
  firstUnvirtualizedRowIndex: number,
): string[] {
  const messageIds = new Set<string>();
  for (let index = firstUnvirtualizedRowIndex; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || !isCompletedAssistantMessageRow(row)) {
      continue;
    }
    messageIds.add(String(row.message.id));
  }

  let assistantMessageCount = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || !isCompletedAssistantMessageRow(row)) {
      continue;
    }
    messageIds.add(String(row.message.id));
    assistantMessageCount += 1;
    if (assistantMessageCount >= IMMEDIATE_ASSISTANT_MARKDOWN_TAIL_MESSAGES) {
      break;
    }
  }

  return [...messageIds];
}

export function derivePendingAssistantMarkdownMessageIdsBottomUp(
  rows: ReadonlyArray<TimelineRow>,
  input: {
    firstUnvirtualizedRowIndex: number;
    immediateMessageIds: ReadonlySet<string>;
    mountedMessageIds: ReadonlySet<string>;
    renderedMessageIds: ReadonlySet<string>;
  },
): string[] {
  const messageIds: string[] = [];
  for (let index = input.firstUnvirtualizedRowIndex - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || !isCompletedAssistantMessageRow(row)) {
      continue;
    }
    const messageId = String(row.message.id);
    if (
      input.immediateMessageIds.has(messageId) ||
      input.mountedMessageIds.has(messageId) ||
      input.renderedMessageIds.has(messageId)
    ) {
      continue;
    }
    messageIds.push(messageId);
  }
  return messageIds;
}

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

const WorkingActivityIndicator = memo(function WorkingActivityIndicator({
  tone = "default",
}: {
  tone?: "default" | "goal";
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "working-activity-indicator",
        tone === "goal" && "working-activity-indicator-goal",
      )}
      data-working-activity-indicator="true"
    >
      <span className="working-activity-indicator-bar" />
      <span className="working-activity-indicator-bar" />
      <span className="working-activity-indicator-bar" />
      <span className="working-activity-indicator-bar" />
    </span>
  );
});

const WorkingTimer = memo(function WorkingTimer({
  createdAt,
  label,
  live,
}: {
  createdAt: string;
  label: string;
  live: boolean;
}) {
  const startedAtMs = Date.parse(createdAt);
  const [elapsed, setElapsed] = useState(() =>
    Number.isFinite(startedAtMs) ? Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)) : 0,
  );

  useEffect(() => {
    if (!live) return;
    if (!Number.isFinite(startedAtMs)) return;
    const timer = window.setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [live, startedAtMs]);

  return (
    <>
      {label} {formatElapsedSeconds(elapsed)}
    </>
  );
});

const ImageGenerationPlaceholderFrame = memo(function ImageGenerationPlaceholderFrame(props: {
  readonly dimensions: AssistantImageGenerationPlaceholder;
}) {
  return (
    <div
      className="image-generation-placeholder-frame relative mb-2.5 max-w-3xl overflow-hidden rounded-xl border border-border/55 bg-background/70"
      aria-label="Image generation in progress"
      data-image-generation-placeholder="true"
      style={imageGenerationFrameStyle(props.dimensions)}
    >
      <div className="image-generation-placeholder-surface absolute inset-0" aria-hidden="true" />
      <div className="image-generation-placeholder-sheen absolute inset-y-0" aria-hidden="true" />
    </div>
  );
});

function workGroupId(rowId: string): string {
  return `work-group:${rowId}`;
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

function estimateWorkEntryRowHeight(workEntry: TimelineWorkEntry): number {
  if (workEntry.requestKind === "command" || workEntry.command) {
    return workEntry.terminalOutput || workEntry.detail ? 96 : 42;
  }
  return workEntry.detail || workEntry.terminalOutput ? 82 : 42;
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
    case "completed-work-summary":
      height = 42 + estimateVisibleCompletedWorkDiagnosticRowsHeight(row.visibleDiagnosticRows);
      break;
    case "message": {
      const message = row.message;
      const renderedMessageText =
        message.role === "assistant"
          ? getChatMessageRenderableText(message)
          : getUserMessageTextForHeightEstimate(message.text);
      const messageText =
        message.role === "assistant" &&
        renderedMessageText.trim().length === 0 &&
        !message.streaming &&
        (message.attachments?.length ?? 0) === 0
          ? "(empty response)"
          : renderedMessageText;
      if (!isAssistantTimelineMessage(message)) {
        const messageHeight = estimateTimelineMessageHeight(
          {
            role: message.role,
            text: messageText,
            ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          },
          {
            timelineWidthPx: input.timelineWidthPx,
          },
        );
        height = messageHeight + 18;
        break;
      }

      const pendingImageGeneration = assistantImageGenerationPlaceholder(message);
      const messageHeight = estimateTimelineMessageHeight(
        {
          role: "assistant",
          text: messageText,
          ...(pendingImageGeneration !== null
            ? { attachments: [{ id: "pending-image-generation" }] }
            : message.attachments !== undefined
              ? { attachments: message.attachments }
              : {}),
          assistantRenderHint: resolveAssistantMessageRenderHint(message),
        },
        {
          timelineWidthPx: input.timelineWidthPx,
        },
      );
      const completionSummaryExtra =
        row.isAssistantTurnTerminal && row.message.completedAt ? 24 : 0;
      height = messageHeight + completionSummaryExtra + 16;
      break;
    }
    case "work":
      height = estimateWorkEntryRowHeight(row.workEntry);
      break;
    case "work-group": {
      const collapsedHeight = 52;
      const isExpanded = input.expandedWorkGroups[workGroupId(row.id)] ?? false;
      height = isExpanded
        ? collapsedHeight +
          row.entries.reduce(
            (total, entry) =>
              total + (entry.kind === "work" ? estimateWorkEntryRowHeight(entry.workEntry) : 58),
            0,
          )
        : collapsedHeight;
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
    case "completed-work-summary":
      return `completed-work-summary:${row.id}:${row.startedAt}:${row.endedAt}:${row.detailRows.length}:${row.toolCallCount}:${row.hiddenThinkingCount}:${row.hiddenMessageCount}:${row.visibleDiagnosticCacheKey}`;
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
        row.isAssistantTurnTerminal && row.message.completedAt ? 1 : 0,
        row.showAssistantSummaryByDefault ? 1 : 0,
        row.completionSummary ? 1 : 0,
        widthCacheKey,
      ].join(":");
    }
    case "work":
      return `work:${row.id}:${row.workEntry.detail ? 1 : 0}:${row.workEntry.command ? 1 : 0}:${row.workEntry.terminalOutput?.length ?? 0}:${row.workEntry.terminalOutputTruncated ? 1 : 0}:${row.workEntry.status ?? ""}:${row.workEntry.exitCode ?? ""}:${row.workEntry.durationMs ?? ""}:${row.workEntry.changedFileStats?.length ?? 0}`;
    case "work-group":
      return `work-group:${row.id}:${input.expandedWorkGroups[workGroupId(row.id)] ? 1 : 0}:${row.entries.length}`;
    case "intent":
      return `intent:${row.id}`;
    case "proposed-plan":
      return `proposed-plan:${row.id}:${row.proposedPlan.planMarkdown.length}`;
    case "working":
      return `working:${row.id}:${row.mode}:${row.activity}:${row.goalStartedAt ?? "no-goal"}:${row.intentText ? 1 : 0}`;
  }
}

function resolveWorkEntryTone(tone: TimelineWorkEntry["tone"]): TimelineMetaTone {
  if (tone === "thinking") return "thinking";
  if (tone === "tool") return "tool";
  if (tone === "error") return "error";
  if (tone === "info") return "success";
  return "neutral";
}

function metaToneTextClass(tone: TimelineMetaTone): string {
  if (tone === "intent") return "text-primary/70";
  if (tone === "thinking") return "text-warning/80";
  if (tone === "tool") return "text-muted-foreground/55";
  if (tone === "error") return "text-destructive/80";
  if (tone === "success") return "text-emerald-500/75";
  return "text-muted-foreground/45";
}

function summarizeWorkGroupElapsedLabel(
  createdAt: string,
  summaryEndAt: string | null,
): string | null {
  return summaryEndAt ? formatCompletedWorkTimer(createdAt, summaryEndAt) : null;
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

function formatSecondsAsWords(seconds: number): string {
  const roundedSeconds = Math.max(1, Math.ceil(seconds));
  return `${roundedSeconds} ${roundedSeconds === 1 ? "second" : "seconds"}`;
}

function summarizeCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function summarizeMultiplier(count: number, label: string): string {
  return count === 1 ? label : `${label} x${count}`;
}

function compactDisplayText(value: string, maxLength = 72): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function summarizeWorkGroupBreakdownParts(
  summary: TimelineWorkGroupSummaryProjection,
  elapsedLabel: string | null,
  thinkingOnlyDurationSeconds: number | null,
): Array<{ key: string; text: string; title: string }> {
  const {
    entryCount,
    intentCount,
    toolCount,
    thinkingCount,
    errorCount,
    infoCount,
    toolSummaryCounts,
  } = summary;
  const eventCount = infoCount;
  const parts: Array<{ key: string; text: string; title: string }> = [];
  const isThinkingOnly = thinkingCount > 0 && entryCount === thinkingCount;

  if (isThinkingOnly && thinkingOnlyDurationSeconds !== null) {
    const steps = summarizeCount(thinkingCount, "reasoning step");
    const times = summarizeCount(thinkingCount, "time");
    return [
      {
        key: "thinking",
        text: `Thought ${times} for ${formatSecondsAsWords(thinkingOnlyDurationSeconds)}`,
        title: steps,
      },
    ];
  } else if (isThinkingOnly && elapsedLabel) {
    const steps = summarizeCount(thinkingCount, "reasoning step");
    const times = summarizeCount(thinkingCount, "time");
    return [
      {
        key: "thinking",
        text: `Thought ${times} for ${elapsedLabel}`,
        title: steps,
      },
    ];
  }

  if (intentCount > 0) {
    parts.push({
      key: "intent",
      text: summarizeMultiplier(intentCount, "Plan"),
      title: summarizeCount(intentCount, "intent"),
    });
  }
  if (toolCount > 0) {
    const toolParts: string[] = [];
    if (toolSummaryCounts.command > 0) {
      toolParts.push(`Ran ${summarizeCount(toolSummaryCounts.command, "command")}`);
    }
    if (toolSummaryCounts.fileRead > 0) {
      toolParts.push(`Read ${summarizeCount(toolSummaryCounts.fileRead, "file")}`);
    }
    if (toolSummaryCounts.fileChange > 0) {
      toolParts.push(`Edited ${summarizeCount(toolSummaryCounts.fileChange, "file")}`);
    }
    if (toolSummaryCounts.webSearch > 0) {
      toolParts.push(
        toolSummaryCounts.webSearch === 1
          ? "Searched once"
          : `Searched ${toolSummaryCounts.webSearch} times`,
      );
    }
    if (toolSummaryCounts.imageView > 0) {
      toolParts.push(`Viewed ${summarizeCount(toolSummaryCounts.imageView, "image")}`);
    }
    if (toolSummaryCounts.genericTool > 0) {
      toolParts.push(`Used ${summarizeCount(toolSummaryCounts.genericTool, "tool")}`);
    }
    const summaryText =
      toolParts.length > 0 ? toolParts.join(" · ") : `Used ${summarizeCount(toolCount, "tool")}`;
    parts.push({ key: "tools", text: summaryText, title: summaryText });
  }
  if (thinkingCount > 0) {
    const steps = summarizeCount(thinkingCount, "reasoning step");
    parts.push({
      key: "thinking",
      text: summarizeMultiplier(thinkingCount, "Thinking"),
      title: steps,
    });
  }
  if (errorCount > 0) {
    const issues = summarizeCount(errorCount, "issue", "issues");
    parts.push({ key: "errors", text: `Hit ${issues}`, title: issues });
  }
  if (eventCount > 0 && parts.length === 0) {
    const events = summarizeCount(eventCount, "event");
    parts.push({ key: "events", text: capitalizePhrase(events), title: events });
  }

  if (parts.length > 0) {
    return parts;
  }

  const entriesLabel = summarizeCount(entryCount, "log entry", "log entries");
  return [{ key: "fallback", text: `Logged ${entriesLabel}`, title: entriesLabel }];
}

function summarizeThinkingOnlyDurationSeconds(
  entries: ReadonlyArray<TimelineMetaGroupEntry>,
  summaryEndAt: string | null,
): number | null {
  const thinkingEntries = entries.filter(
    (entry): entry is Extract<TimelineMetaGroupEntry, { kind: "work" }> =>
      entry.kind === "work" && entry.workEntry.tone === "thinking",
  );
  if (thinkingEntries.length === 0 || thinkingEntries.length !== entries.length) {
    return null;
  }

  let totalSeconds = 0;
  for (let index = 0; index < thinkingEntries.length; index += 1) {
    const current = thinkingEntries[index];
    if (!current) {
      continue;
    }
    const startMs = Date.parse(current.createdAt);
    const nextCreatedAt = thinkingEntries[index + 1]?.createdAt ?? summaryEndAt;
    const endMs = nextCreatedAt ? Date.parse(nextCreatedAt) : Number.NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      continue;
    }
    totalSeconds += Math.ceil((endMs - startMs) / 1_000);
  }

  return Math.max(1, totalSeconds);
}

function workGroupIcon(iconKey: TimelineWorkGroupIconKey): TimelineIcon {
  if (iconKey === "target") return TargetIcon;
  if (iconKey === "alert") return CircleAlertIcon;
  if (iconKey === "terminal") return IconTerminal;
  if (iconKey === "file-change") return SquarePenIcon;
  if (iconKey === "eye") return EyeIcon;
  if (iconKey === "web-search") return GlobeIcon;
  if (iconKey === "brain") return BrainIcon;
  if (iconKey === "check") return CheckIcon;
  return WrenchIcon;
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

type UserMessageProviderCommandDisplay = {
  readonly kind: ProviderExtensionCommandKind | "goal";
  readonly label: string;
};

type UserMessageProviderCommandLookup = ReadonlyMap<string, UserMessageProviderCommandDisplay>;

const USER_MESSAGE_INLINE_TOKEN_REGEX =
  /(^|[\s([{])((?:(?:\/|\$)[A-Za-z0-9][A-Za-z0-9_.:/-]{0,120})(?=$|[\s,.;:!?)}\]])|(?:@[^\s@]+))/g;

function providerCommandKindForDisplay(
  command: ProviderSlashCommand,
  normalizedName: string,
): ProviderExtensionCommandKind | "goal" | null {
  if (command.kind === "provider" && normalizedName === "goal") {
    return "goal";
  }
  if (command.kind === "skill" || command.kind === "plugin") {
    return command.kind;
  }
  return providerSlashCommandExtensionKind(command, normalizedName);
}

function registerUserMessageProviderCommandToken(
  lookup: Map<string, UserMessageProviderCommandDisplay>,
  token: string | null | undefined,
  display: UserMessageProviderCommandDisplay,
): void {
  const normalizedToken = token?.trim();
  if (!normalizedToken) {
    return;
  }
  lookup.set(normalizedToken.toLowerCase(), display);
}

function buildUserMessageProviderCommandLookup(
  commands: ReadonlyArray<ProviderSlashCommand>,
): UserMessageProviderCommandLookup {
  const lookup = new Map<string, UserMessageProviderCommandDisplay>();
  for (const command of commands) {
    const normalizedName = normalizeProviderSlashCommandName(command.name);
    if (!normalizedName) {
      continue;
    }
    const kind = providerCommandKindForDisplay(command, normalizedName);
    if (!kind) {
      continue;
    }
    const display: UserMessageProviderCommandDisplay = {
      kind,
      label: formatCommandDisplayLabel(command.name),
    };
    const promptPrefixToken = command.promptPrefix?.trim().split(/\s+/u)[0];

    registerUserMessageProviderCommandToken(lookup, `/${normalizedName}`, display);
    registerUserMessageProviderCommandToken(lookup, promptPrefixToken, display);
    registerUserMessageProviderCommandToken(
      lookup,
      kind === "skill" ? `$${normalizedName}` : `@${normalizedName}`,
      display,
    );
  }
  return lookup;
}

function hasProviderSlashCommand(
  commands: ReadonlyArray<ProviderSlashCommand>,
  commandName: string,
): boolean {
  const normalizedTarget = normalizeProviderSlashCommandName(commandName);
  if (!normalizedTarget) {
    return false;
  }
  return commands.some(
    (command) => normalizeProviderSlashCommandName(command.name) === normalizedTarget,
  );
}

function splitTrailingMentionPunctuation(token: string): {
  token: string;
  trailingText: string;
} {
  const normalizedToken = token.replace(/[),.;:!?}\]]+$/u, "");
  return {
    token: normalizedToken,
    trailingText: token.slice(normalizedToken.length),
  };
}

function buildUserMessageInlineText(
  text: string,
  keyPrefix: string,
  providerCommandLookup: UserMessageProviderCommandLookup,
  resolvedTheme: "light" | "dark",
): ReactNode[] {
  if (text.length === 0) {
    return [];
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  USER_MESSAGE_INLINE_TOKEN_REGEX.lastIndex = 0;

  for (const match of text.matchAll(USER_MESSAGE_INLINE_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const matchedToken = match[2] ?? "";
    const matchIndex = match.index ?? 0;
    const tokenStart = matchIndex + prefix.length;
    const tokenEnd = tokenStart + fullMatch.length - prefix.length;
    const { token, trailingText } = matchedToken.startsWith("@")
      ? splitTrailingMentionPunctuation(matchedToken)
      : { token: matchedToken, trailingText: "" };

    if (token.length <= 1) {
      continue;
    }

    if (tokenStart > cursor) {
      nodes.push(<span key={`${keyPrefix}:text:${cursor}`}>{text.slice(cursor, tokenStart)}</span>);
    }

    const providerCommandDisplay = providerCommandLookup.get(token.toLowerCase());

    const isFirstNonWhitespaceToken = text.slice(0, tokenStart).trim().length === 0;
    const shouldDecorateProviderCommand =
      providerCommandDisplay &&
      (providerCommandDisplay.kind !== "goal" || isFirstNonWhitespaceToken);

    if (shouldDecorateProviderCommand) {
      const ProviderCommandIcon =
        providerCommandDisplay.kind === "plugin"
          ? PlugIcon
          : providerCommandDisplay.kind === "goal"
            ? TargetIcon
            : IconStack2;
      nodes.push(
        <span
          key={`${keyPrefix}:provider-command:${tokenStart}`}
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-1 py-px font-medium leading-[1.15]",
            providerCommandDisplay.kind === "goal"
              ? "border border-emerald-500/40 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
              : "border border-border/70 bg-muted/70 text-foreground/85",
          )}
        >
          <ProviderCommandIcon
            aria-hidden="true"
            className={
              providerCommandDisplay.kind === "plugin"
                ? "size-3.5 shrink-0 text-muted-foreground/85"
                : providerCommandDisplay.kind === "goal"
                  ? "size-3.5 shrink-0 text-emerald-500"
                  : "size-3.5 shrink-0 text-muted-foreground/85"
            }
          />
          <span>{providerCommandDisplay.label}</span>
        </span>,
      );
    } else if (token.startsWith("@")) {
      const pathValue = token.slice(1);
      nodes.push(
        <span
          key={`${keyPrefix}:mention:${tokenStart}`}
          className={COMPOSER_INLINE_CHIP_CLASS_NAME}
        >
          <VscodeEntryIcon
            pathValue={pathValue}
            kind={inferEntryKindFromPath(pathValue)}
            theme={resolvedTheme}
            className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
          />
          <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{basenameOfPath(pathValue)}</span>
        </span>,
      );
    } else {
      nodes.push(<span key={`${keyPrefix}:command-text:${tokenStart}`}>{token}</span>);
    }
    if (trailingText) {
      nodes.push(<span key={`${keyPrefix}:trailing:${tokenStart}`}>{trailingText}</span>);
    }
    cursor = tokenEnd;
  }

  if (cursor < text.length) {
    nodes.push(<span key={`${keyPrefix}:text:${cursor}`}>{text.slice(cursor)}</span>);
  }

  return nodes.length > 0 ? nodes : [text];
}

const UserMessageBody = memo(function UserMessageBody(props: {
  providerCommandLookup: UserMessageProviderCommandLookup;
  resolvedTheme: "light" | "dark";
  text: string;
  terminalContexts: ReadonlyArray<ParsedTerminalContextEntry>;
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
        const matchIndex = findTextIndexOf(props.text, label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            ...buildUserMessageInlineText(
              props.text.slice(cursor, matchIndex),
              `user-terminal-context-inline-before:${context.header}:${cursor}`,
              props.providerCommandLookup,
              props.resolvedTheme,
            ),
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
            ...buildUserMessageInlineText(
              props.text.slice(cursor),
              `user-message-terminal-context-inline-rest:${cursor}`,
              props.providerCommandLookup,
              props.resolvedTheme,
            ),
          );
        }

        return (
          <div className="m-0 wrap-break-word whitespace-pre-wrap font-mono text-[13px] leading-[1.55] text-foreground/90">
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
      inlineNodes.push(
        ...buildUserMessageInlineText(
          props.text,
          "user-message-terminal-context-inline-text",
          props.providerCommandLookup,
          props.resolvedTheme,
        ),
      );
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="m-0 wrap-break-word whitespace-pre-wrap font-mono text-[13px] leading-[1.55] text-foreground/90">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <div className="m-0 whitespace-pre-wrap wrap-break-word font-mono text-[13px] leading-[1.55] text-foreground/90">
      {buildUserMessageInlineText(
        props.text,
        "user-message-provider-command",
        props.providerCommandLookup,
        props.resolvedTheme,
      )}
    </div>
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

const WorkLogTimelineRow = memo(function WorkLogTimelineRow(props: {
  row: TimelineWorkLogRow;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
}) {
  if (props.row.kind === "work") {
    return (
      <div className="min-w-0 py-0.5">
        <SimpleWorkEntryRow
          workEntry={props.row.workEntry}
          inlineIntentText={props.row.workEntry.intentText ?? null}
        />
      </div>
    );
  }

  if (props.row.kind === "intent") {
    return (
      <div className="min-w-0 py-0.5" data-intent-message="true">
        <SimpleIntentEntryRow entry={props.row} variant="standalone" />
      </div>
    );
  }

  const groupId = workGroupId(props.row.id);
  const isExpanded = props.expandedWorkGroups[groupId] ?? false;
  const ChevronIcon = isExpanded ? ChevronDownIcon : ChevronRightIcon;
  const { summary } = props.row;
  const elapsedLabel = summarizeWorkGroupElapsedLabel(props.row.createdAt, props.row.summaryEndAt);
  const thinkingOnlyDurationSeconds = summarizeThinkingOnlyDurationSeconds(
    props.row.entries,
    props.row.summaryEndAt,
  );
  const breakdownParts = summarizeWorkGroupBreakdownParts(
    summary,
    elapsedLabel,
    thinkingOnlyDurationSeconds,
  );
  const GroupIcon = workGroupIcon(summary.iconKey);

  return (
    <div className="min-w-0 py-0.5" data-thread-group={summary.threadGroupTone}>
      <button
        type="button"
        className="group/disclosure flex max-w-full items-center gap-3 rounded-md bg-transparent px-0 py-1 text-left outline-none focus-visible:outline-none focus-visible:ring-0"
        onClick={() => props.onToggleWorkGroup(groupId)}
        aria-expanded={isExpanded}
        data-meta-disclosure="true"
        data-meta-disclosure-open={String(isExpanded)}
        data-thinking-disclosure={summary.hasThinkingEntries ? "true" : undefined}
        data-thinking-disclosure-open={summary.hasThinkingEntries ? String(isExpanded) : undefined}
        data-tool-disclosure={summary.hasToolEntries ? "true" : undefined}
        data-tool-disclosure-open={summary.hasToolEntries ? String(isExpanded) : undefined}
      >
        <GroupIcon
          className={cn("mt-0.5 size-3.5 shrink-0", metaToneTextClass(summary.surfaceTone))}
        />
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[13px] leading-5 text-muted-foreground/70">
          {breakdownParts.map((part, index) => (
            <Fragment key={`${props.row.id}:summary:${part.key}`}>
              {index > 0 && <span className="shrink-0 text-muted-foreground/45">·</span>}
              <InlineTooltip
                content={part.title}
                className={cn(
                  "min-w-0 truncate transition-colors duration-100 group-hover/disclosure:text-foreground/92 group-focus-visible/disclosure:text-foreground/92",
                  isExpanded ? "text-foreground/92" : "text-muted-foreground/70",
                )}
              >
                {part.text}
              </InlineTooltip>
            </Fragment>
          ))}
          <ChevronIcon
            className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors duration-100 group-hover/disclosure:text-foreground/90 group-focus-visible/disclosure:text-foreground/90"
            strokeWidth={2.2}
          />
          {elapsedLabel && (
            <span
              className="sr-only"
              data-meta-disclosure-elapsed={elapsedLabel}
            >{`Elapsed ${elapsedLabel}`}</span>
          )}
        </div>
      </button>
      {isExpanded && (
        <div
          className="mt-2 space-y-2 border-l border-border/45 pl-5"
          data-meta-disclosure-body="true"
        >
          {props.row.entries.map((entry) =>
            entry.kind === "work" ? (
              <SimpleWorkEntryRow
                key={`work-group:${props.row.id}:${entry.id}`}
                workEntry={entry.workEntry}
                inlineIntentText={null}
                variant="nested"
              />
            ) : (
              <SimpleIntentEntryRow
                key={`work-group:${props.row.id}:${entry.id}`}
                entry={entry}
                variant="nested"
              />
            ),
          )}
        </div>
      )}
    </div>
  );
});

const CompletedWorkDetailTimelineRow = memo(function CompletedWorkDetailTimelineRow(props: {
  row: TimelineCompletedWorkDetailRow;
  enableLocalFileLinks: boolean | undefined;
  expandedWorkGroups: Record<string, boolean>;
  liveTimers: boolean;
  markdownCwd: string | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenBrowserUrl: ((url: string) => void) | null | undefined;
  onOpenFilePath: ((path: string) => void) | null | undefined;
  onToggleWorkGroup: (groupId: string) => void;
  timestampFormat: TimestampFormat;
}) {
  if (props.row.kind === "work" || props.row.kind === "work-group" || props.row.kind === "intent") {
    return (
      <WorkLogTimelineRow
        row={props.row}
        expandedWorkGroups={props.expandedWorkGroups}
        onToggleWorkGroup={props.onToggleWorkGroup}
      />
    );
  }

  if (!isAssistantTimelineMessage(props.row.message)) {
    return null;
  }

  return (
    <div className="min-w-0 py-0.5" data-completed-work-hidden-assistant-message="true">
      <AssistantMessageTimelineRow
        completionSummary={props.row.completionSummary}
        durationStart={props.row.durationStart}
        isAssistantTurnTerminal={props.row.isAssistantTurnTerminal ?? false}
        liveTimers={props.liveTimers}
        showCompletedTiming={props.row.showAssistantTiming ?? false}
        showAssistantSummaryByDefault={props.row.showAssistantSummaryByDefault ?? false}
        markdownCwd={props.markdownCwd}
        message={props.row.message}
        onImageExpand={props.onImageExpand}
        onOpenBrowserUrl={props.onOpenBrowserUrl ?? null}
        onOpenFilePath={props.onOpenFilePath ?? null}
        enableLocalFileLinks={props.enableLocalFileLinks ?? true}
        renderMarkdown
        timestampFormat={props.timestampFormat}
      />
    </div>
  );
});

function estimateVisibleCompletedWorkDiagnosticRowsHeight(
  diagnosticRows: ReadonlyArray<TimelineCompletedWorkDiagnosticRow>,
): number {
  let height = 0;
  for (const diagnosticRow of diagnosticRows) {
    height +=
      diagnosticRow.workEntry.detail ||
      diagnosticRow.workEntry.command ||
      diagnosticRow.workEntry.terminalOutput
        ? 104
        : 52;
  }
  return height;
}

const CompletedWorkSummaryTimelineRow = memo(function CompletedWorkSummaryTimelineRow(props: {
  row: Extract<TimelineRow, { kind: "completed-work-summary" }>;
  enableLocalFileLinks: boolean | undefined;
  expandedWorkGroups: Record<string, boolean>;
  liveTimers: boolean;
  markdownCwd: string | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenBrowserUrl: ((url: string) => void) | null | undefined;
  onOpenFilePath: ((path: string) => void) | null | undefined;
  onToggleWorkGroup: (groupId: string) => void;
  timestampFormat: TimestampFormat;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const visibleDiagnosticRows = props.row.visibleDiagnosticRows;
  const elapsedLabel = formatCompletedWorkTimer(props.row.startedAt, props.row.endedAt);
  if (!elapsedLabel) {
    return null;
  }
  const hasHiddenLogs = props.row.detailRows.length > 0;
  const summaryContent = (
    <>
      <Clock3Icon className="mt-1 size-3 shrink-0 text-muted-foreground/42 transition-colors group-hover/completed-work:text-muted-foreground/78" />
      <span className="min-w-0 text-[12px] leading-5 text-muted-foreground/76 transition-colors group-hover/completed-work:text-foreground/86">
        Worked for {elapsedLabel}
      </span>
      {hasHiddenLogs && (
        <ChevronDownIcon
          className={cn(
            "mt-1 size-3 shrink-0 text-muted-foreground/48 transition-[color,transform] duration-150 group-hover/completed-work:text-muted-foreground/86",
            !isOpen && "-rotate-90",
          )}
          aria-hidden="true"
        />
      )}
    </>
  );

  return (
    <div className="min-w-0 py-0.5" data-completed-work-summary="true">
      {hasHiddenLogs ? (
        <button
          type="button"
          className="group/completed-work flex min-w-0 items-start gap-2.5 border-0 bg-transparent p-0 text-left outline-none transition-colors focus-visible:text-foreground/86"
          data-completed-work-summary-elapsed={elapsedLabel}
          data-completed-work-summary-tool-calls={props.row.toolCallCount}
          data-completed-work-summary-thinking={props.row.hiddenThinkingCount}
          data-completed-work-summary-hidden-messages={props.row.hiddenMessageCount}
          data-completed-work-summary-open={String(isOpen)}
          aria-expanded={isOpen}
          aria-label={isOpen ? "Hide hidden work logs" : "Show hidden work logs"}
          onClick={() => setIsOpen((current) => !current)}
        >
          {summaryContent}
        </button>
      ) : (
        <div
          className="group/completed-work flex min-w-0 items-start gap-2.5"
          data-completed-work-summary-elapsed={elapsedLabel}
          data-completed-work-summary-tool-calls={props.row.toolCallCount}
          data-completed-work-summary-thinking={props.row.hiddenThinkingCount}
          data-completed-work-summary-hidden-messages={props.row.hiddenMessageCount}
        >
          {summaryContent}
        </div>
      )}
      {!isOpen && visibleDiagnosticRows.length > 0 && (
        <div
          className="mt-2 ml-[5px] min-w-0 space-y-2 border-destructive/35 border-l py-0.5 pl-4"
          data-completed-work-visible-diagnostics="true"
        >
          {visibleDiagnosticRows.map((diagnosticRow) => (
            <WorkLogTimelineRow
              key={`completed-work-visible-diagnostic:${props.row.id}:${diagnosticRow.id}`}
              row={diagnosticRow}
              expandedWorkGroups={props.expandedWorkGroups}
              onToggleWorkGroup={props.onToggleWorkGroup}
            />
          ))}
        </div>
      )}
      {isOpen && hasHiddenLogs && (
        <div
          className="mt-2 ml-[5px] min-w-0 space-y-2 border-border/35 border-l py-0.5 pl-4"
          data-completed-work-details="true"
        >
          {props.row.detailRows.map((detailRow) => (
            <CompletedWorkDetailTimelineRow
              key={`completed-work-summary:${props.row.id}:${detailRow.kind}:${detailRow.id}`}
              row={detailRow}
              enableLocalFileLinks={props.enableLocalFileLinks}
              expandedWorkGroups={props.expandedWorkGroups}
              liveTimers={props.liveTimers}
              markdownCwd={props.markdownCwd}
              onImageExpand={props.onImageExpand}
              onOpenBrowserUrl={props.onOpenBrowserUrl}
              onOpenFilePath={props.onOpenFilePath}
              onToggleWorkGroup={props.onToggleWorkGroup}
              timestampFormat={props.timestampFormat}
            />
          ))}
        </div>
      )}
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
  providerCommandLookup: UserMessageProviderCommandLookup;
  revertActionTitle: string;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
}) {
  const userImages = props.message.attachments ?? [];
  const displayedUserMessage = deriveDisplayedUserMessageState(props.message.text);
  const terminalContexts = displayedUserMessage.contexts;

  return (
    <div className="flex justify-end">
      <div
        className="group relative max-w-[82%] p-0 sm:max-w-[72%]"
        data-user-message-bubble="true"
      >
        <div className="relative rounded-2xl rounded-br-lg border border-border/40 bg-chat-bubble px-4 py-3 ">
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
            <div>
              <UserMessageBody
                text={displayedUserMessage.visibleText}
                terminalContexts={terminalContexts}
                providerCommandLookup={props.providerCommandLookup}
                resolvedTheme={props.resolvedTheme}
              />
            </div>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-end gap-2 pr-1">
          <div className="flex items-center gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
            {displayedUserMessage.copyText && (
              <MessageCopyButton text={displayedUserMessage.copyText} />
            )}
            {props.canRevertAgentWork && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      className="border-border/55 bg-background/55"
                      disabled={props.isRevertingCheckpoint || props.isWorking}
                      onClick={() => props.onRevertUserMessage(props.message.id)}
                      aria-label={props.revertActionTitle}
                    />
                  }
                >
                  <Undo2Icon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="left" align="center">
                  {props.revertActionTitle}
                </TooltipPopup>
              </Tooltip>
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

const AssistantMarkdownPendingPlaceholder = memo(function AssistantMarkdownPendingPlaceholder() {
  return (
    <div
      className="space-y-2 py-1 text-[13px] text-muted-foreground/58"
      data-assistant-markdown-pending="true"
    >
      <div className="h-3.5 w-2/3 rounded bg-muted-foreground/9" />
      <div className="h-3.5 w-1/2 rounded bg-muted-foreground/7" />
    </div>
  );
});

const AssistantImageAttachmentFrame = memo(function AssistantImageAttachmentFrame(props: {
  readonly generationDimensions: AssistantImageGenerationPlaceholder | null;
  readonly image: NonNullable<TimelineMessage["attachments"]>[number];
  readonly images: ReadonlyArray<NonNullable<TimelineMessage["attachments"]>[number]>;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const [naturalDimensions, setNaturalDimensions] =
    useState<AssistantImageGenerationPlaceholder | null>(null);
  const frameDimensions = naturalDimensions ?? props.generationDimensions;

  return (
    <div
      className="inline-flex max-w-full justify-self-start overflow-hidden rounded-xl border border-border/55 bg-background/70"
      style={frameDimensions ? imageGenerationFrameStyle(frameDimensions) : undefined}
    >
      {props.image.previewUrl ? (
        <button
          type="button"
          className={cn(
            "inline-flex max-w-full cursor-zoom-in items-start justify-start bg-background/55",
            frameDimensions ? "h-full" : "",
          )}
          aria-label={`Preview ${props.image.name}`}
          onClick={() => {
            const preview = buildExpandedImagePreview(props.images, props.image.id);
            if (!preview) return;
            props.onImageExpand(preview);
          }}
        >
          <img
            src={props.image.previewUrl}
            alt={props.image.name}
            className={cn(
              "block object-contain",
              frameDimensions ? "h-full w-full" : "max-h-[52vh] max-w-full",
            )}
            onLoad={(event) => {
              const { naturalHeight, naturalWidth } = event.currentTarget;
              if (naturalWidth <= 0 || naturalHeight <= 0) {
                return;
              }
              setNaturalDimensions((current) =>
                current?.width === naturalWidth && current.height === naturalHeight
                  ? current
                  : { width: naturalWidth, height: naturalHeight },
              );
            }}
          />
        </button>
      ) : (
        <div className="flex min-h-24 items-center justify-center px-3 py-4 text-center text-xs text-muted-foreground">
          {props.image.name}
        </div>
      )}
    </div>
  );
});

const AssistantMessageTimelineRow = memo(function AssistantMessageTimelineRow(props: {
  completionSummary: string | null;
  durationStart: string;
  isAssistantTurnTerminal?: boolean;
  liveTimers: boolean;
  showCompletedTiming?: boolean;
  showAssistantSummaryByDefault?: boolean;
  suppressFooter?: boolean;
  markdownCwd: string | undefined;
  message: AssistantTimelineMessage;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenBrowserUrl?: ((url: string) => void) | null;
  onOpenFilePath?: ((path: string) => void) | null;
  enableLocalFileLinks?: boolean;
  onForkConversation?: (() => void) | null;
  isForkConversationDisabled?: boolean;
  renderMarkdown: boolean;
  timestampFormat: TimestampFormat;
}) {
  const onOpenBrowserUrl = props.onOpenBrowserUrl ?? null;
  const onOpenFilePath = props.onOpenFilePath ?? null;
  const assistantImages = props.message.attachments ?? [];
  const imageGenerationPlaceholder = assistantImageGenerationPlaceholder(props.message);
  const imageGenerationAttachmentDimensions = assistantImageGenerationDimensionsFromMessageId(
    props.message,
  );
  const renderedMessageText = getChatMessageRenderableText(props.message);
  const copyText = renderedMessageText.trim().length > 0 ? renderedMessageText : null;
  const messageText =
    renderedMessageText.trim().length > 0
      ? renderedMessageText
      : props.message.streaming
        ? ""
        : assistantImages.length > 0
          ? ""
          : "(empty response)";
  const timing = resolveAssistantTurnTiming({
    completedAt: props.message.completedAt ?? null,
    durationStart: props.durationStart,
    isAssistantTurnTerminal: props.isAssistantTurnTerminal ?? false,
    showCompletedTiming: props.showCompletedTiming ?? false,
    timestampFormat: props.timestampFormat,
  });
  const persistVisible = Boolean(props.completionSummary || props.showAssistantSummaryByDefault);

  return (
    <div className="min-w-0">
      {imageGenerationPlaceholder && (
        <ImageGenerationPlaceholderFrame dimensions={imageGenerationPlaceholder} />
      )}
      {assistantImages.length > 0 && (
        <div
          className={cn(
            "grid w-fit max-w-full grid-cols-1 justify-items-start gap-2",
            messageText ? "mb-2.5" : "",
          )}
        >
          {assistantImages.map((image: NonNullable<TimelineMessage["attachments"]>[number]) => (
            <AssistantImageAttachmentFrame
              key={image.id}
              generationDimensions={imageGenerationAttachmentDimensions}
              image={image}
              images={assistantImages}
              onImageExpand={props.onImageExpand}
            />
          ))}
        </div>
      )}
      {messageText.length === 0 ? null : props.renderMarkdown ? (
        <ChatMarkdown
          key={`${props.message.id}:${props.message.streaming ? "streaming" : (props.message.completedAt ?? "complete")}:${messageText.length}`}
          analysisCacheKey={buildMarkdownRenderAnalysisCacheKey(
            {
              text: messageText,
              isStreaming: Boolean(props.message.streaming),
              renderPlainText: false,
              ...(props.message.streamingTextState
                ? {
                    streamingTextState: {
                      totalLineCount: props.message.streamingTextState.totalLineCount,
                      truncatedCharCount: props.message.streamingTextState.truncatedCharCount,
                      truncatedLineCount: props.message.streamingTextState.truncatedLineCount,
                    },
                  }
                : {}),
            },
            buildAssistantMarkdownAnalysisStableKey(props.message, messageText),
          )}
          text={messageText}
          cwd={props.markdownCwd}
          isStreaming={Boolean(props.message.streaming)}
          onOpenBrowserUrl={onOpenBrowserUrl}
          onOpenFilePath={onOpenFilePath}
          enableLocalFileLinks={props.enableLocalFileLinks ?? true}
          {...(props.message.streamingTextState
            ? { streamingTextState: props.message.streamingTextState }
            : {})}
        />
      ) : (
        <AssistantMarkdownPendingPlaceholder />
      )}
      {!props.suppressFooter && (
        <AssistantTurnFooter
          copyText={copyText}
          onForkConversation={props.onForkConversation ?? null}
          isForkConversationDisabled={props.isForkConversationDisabled ?? false}
          persistVisible={persistVisible}
          timing={timing}
        />
      )}
    </div>
  );
});

function resolveAssistantTurnTiming(input: {
  completedAt: string | null;
  durationStart: string;
  isAssistantTurnTerminal: boolean;
  showCompletedTiming: boolean;
  timestampFormat: TimestampFormat;
}): { completedAtLabel: string; elapsedLabel: string } | null {
  if (!input.showCompletedTiming || !input.isAssistantTurnTerminal || !input.completedAt) {
    return null;
  }

  const elapsedLabel = formatCompletedWorkTimer(input.durationStart, input.completedAt);
  if (!elapsedLabel) {
    return null;
  }

  return {
    completedAtLabel: formatTimestamp(input.completedAt, input.timestampFormat),
    elapsedLabel,
  };
}

const AssistantTurnFooter = memo(function AssistantTurnFooter(props: {
  copyText: string | null;
  onForkConversation?: (() => void) | null;
  isForkConversationDisabled?: boolean;
  persistVisible: boolean;
  timing: { completedAtLabel: string; elapsedLabel: string } | null;
}) {
  const hasActions = Boolean(props.copyText || props.onForkConversation);
  if (!props.timing && !hasActions) {
    return null;
  }

  return (
    <div
      className="mt-2 flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1"
      data-assistant-turn-footer="true"
    >
      {props.timing && (
        <span
          className={cn(
            "inline-flex items-center gap-1.5 text-[10px] text-muted-foreground/52 transition-opacity duration-150",
            props.persistVisible
              ? "opacity-100"
              : "opacity-0 group-hover/timeline:opacity-100 group-focus-within/timeline:opacity-100",
          )}
          data-response-summary="true"
          data-response-summary-time={props.timing.completedAtLabel}
          data-response-summary-elapsed={props.timing.elapsedLabel}
        >
          <Clock3Icon className="size-3 shrink-0" />
          <span>{props.timing.completedAtLabel}</span>
          <span className="text-muted-foreground/34">·</span>
          <span>{props.timing.elapsedLabel}</span>
        </span>
      )}
      {hasActions && (
        <div
          className={cn(
            "ml-auto flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/timeline:opacity-100 group-focus-within/timeline:opacity-100",
            !props.timing && "w-full justify-end",
          )}
          data-assistant-turn-actions="true"
        >
          {props.onForkConversation && (
            <AssistantForkButton
              disabled={props.isForkConversationDisabled ?? false}
              onClick={props.onForkConversation}
            />
          )}
          {props.copyText && (
            <MessageCopyButton
              text={props.copyText}
              className="bg-background/45 hover:bg-background/78"
            />
          )}
        </div>
      )}
    </div>
  );
});

const AssistantForkButton = memo(function AssistantForkButton(props: {
  disabled: boolean;
  onClick: () => void;
}) {
  const tooltipLabel = props.disabled
    ? "Finish the current turn before forking"
    : "Fork conversation";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="border-border/40 bg-background/45 transition-all duration-200 hover:border-border/60 hover:bg-background/78"
            disabled={props.disabled}
            onClick={props.onClick}
            aria-label="Fork conversation"
          />
        }
      >
        <GitForkIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltipLabel}</TooltipPopup>
    </Tooltip>
  );
});

const AssistantMessageTurnDiffSummary = memo(function AssistantMessageTurnDiffSummary(props: {
  allDirectoriesExpanded: boolean;
  canRevert: boolean;
  isRevertingCheckpoint: boolean;
  isWorking: boolean;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onRevert?: (() => void) | undefined;
  onToggleAllDirectories: (turnId: TurnId) => void;
  revertActionTitle: string;
  resolvedTheme: "light" | "dark";
  turnSummary: TurnDiffSummary;
}) {
  const checkpointFiles = props.turnSummary.files;
  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
  const changedFileCountLabel = summarizeCount(checkpointFiles.length, "file");
  const hasExpandableDirectories = checkpointFiles.some(
    (file) =>
      file.path
        .replaceAll("\\", "/")
        .split("/")
        .filter((segment) => segment.length > 0).length > 1,
  );
  const hasRightActions = (props.canRevert && props.onRevert) || hasExpandableDirectories;

  return (
    <div
      className="min-w-0 overflow-hidden rounded-lg border border-border/45 bg-muted/16 shadow-[0_1px_0_rgba(255,255,255,0.035)_inset]"
      data-turn-diff-summary="true"
    >
      <div className="flex min-w-0 items-start gap-3 border-border/45 border-b px-3 py-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/45 bg-background/55 text-foreground/80">
          <SquarePenIcon className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <span className="sr-only">Changed files ({checkpointFiles.length})</span>
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-[15px] leading-5 font-medium text-foreground/92">
            <span>Edited {changedFileCountLabel}</span>
            {hasNonZeroStat(summaryStat) && (
              <span className="font-mono text-[13px] tabular-nums">
                <DiffStatLabel
                  additions={summaryStat.additions}
                  deletions={summaryStat.deletions}
                />
              </span>
            )}
          </p>
          <Button
            type="button"
            size="xs"
            variant="link"
            className="mt-1 h-auto p-0 text-[11px] font-normal text-muted-foreground/70 hover:text-foreground"
            onClick={() => props.onOpenTurnDiff(props.turnSummary.turnId, checkpointFiles[0]?.path)}
          >
            View diff
          </Button>
        </div>
        {hasRightActions && (
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {props.canRevert && props.onRevert && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className="rounded-md text-muted-foreground hover:bg-background/70 hover:text-foreground"
                      disabled={props.isRevertingCheckpoint || props.isWorking}
                      onClick={props.onRevert}
                      aria-label={props.revertActionTitle}
                    />
                  }
                >
                  <Undo2Icon aria-hidden="true" className="size-2.5" />
                </TooltipTrigger>
                <TooltipPopup side="top" align="end">
                  {props.revertActionTitle}
                </TooltipPopup>
              </Tooltip>
            )}
            {hasExpandableDirectories && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      data-scroll-anchor-ignore
                      className="rounded-md text-muted-foreground hover:bg-background/70 hover:text-foreground"
                      onClick={() => props.onToggleAllDirectories(props.turnSummary.turnId)}
                      aria-label={props.allDirectoriesExpanded ? "Collapse all" : "Expand all"}
                    />
                  }
                >
                  <ChevronDownIcon
                    aria-hidden="true"
                    className={cn(
                      "size-2.5 transition-transform",
                      !props.allDirectoriesExpanded && "-rotate-90",
                    )}
                  />
                </TooltipTrigger>
                <TooltipPopup side="top" align="end">
                  {props.allDirectoriesExpanded ? "Collapse all" : "Expand all"}
                </TooltipPopup>
              </Tooltip>
            )}
          </div>
        )}
      </div>
      <div className="px-2 py-1.5">
        <ChangedFilesTree
          key={`changed-files-tree:${props.turnSummary.turnId}`}
          turnId={props.turnSummary.turnId}
          files={checkpointFiles}
          allDirectoriesExpanded={props.allDirectoriesExpanded}
          resolvedTheme={props.resolvedTheme}
          onOpenTurnDiff={props.onOpenTurnDiff}
        />
      </div>
    </div>
  );
});

const ProposedPlanTimelineRow = memo(function ProposedPlanTimelineRow(props: {
  cwd: string | undefined;
  onOpenBrowserUrl?: ((url: string) => void) | null;
  onOpenFilePath?: ((path: string) => void) | null;
  enableLocalFileLinks?: boolean;
  proposedPlan: TimelineProposedPlan;
  workspaceRoot: string | undefined;
}) {
  const onOpenBrowserUrl = props.onOpenBrowserUrl ?? null;
  const onOpenFilePath = props.onOpenFilePath ?? null;
  return (
    <div className="rounded-xl border border-border/45 bg-background/35 px-4 py-3">
      <ProposedPlanCard
        planMarkdown={props.proposedPlan.planMarkdown}
        cwd={props.cwd}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenFilePath={onOpenFilePath}
        enableLocalFileLinks={props.enableLocalFileLinks ?? true}
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
      icon: BrainIcon,
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

function normalizeTerminalOutputText(output: string | undefined): string | null {
  if (!output) {
    return null;
  }
  const normalized = output.replace(/\r\n?/g, "\n").trimEnd();
  return normalized.length > 0 ? normalized : null;
}

function formatToolDuration(durationMs: number | undefined): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  if (durationMs < 1_000) {
    return `${Math.max(1, Math.round(durationMs))}ms`;
  }
  if (durationMs < 10_000) {
    return `${(durationMs / 1_000).toFixed(1)}s`;
  }
  return `${Math.round(durationMs / 1_000)}s`;
}

function commandTextFromWorkEntry(workEntry: TimelineWorkEntry): string | null {
  const explicitCommand = normalizeWorkCommandText(workEntry.command);
  if (explicitCommand) {
    return explicitCommand;
  }
  if (!isCommandWorkEntry(workEntry)) {
    return null;
  }
  const detail = normalizeWorkCommandText(workEntry.detail);
  if (!detail) {
    return null;
  }
  const stripped = detail.replace(/^(?:bash|shell|run command)\s*:\s*/iu, "").trim();
  return stripped.length > 0 ? stripped : detail;
}

function compactCommandText(command: string | null): string | null {
  if (!command) {
    return null;
  }
  return command.length > 72 ? `${command.slice(0, 69)}...` : command;
}

function commandDetailIsDuplicate(
  command: string | undefined,
  detail: string | undefined,
): boolean {
  const normalizedCommand = normalizeWorkCommandText(command);
  const normalizedDetail = detail?.trim() || null;
  if (!normalizedCommand || !normalizedDetail) {
    return false;
  }
  const lowerDetail = normalizedDetail.toLowerCase();
  return (
    normalizedDetail === normalizedCommand ||
    lowerDetail === `bash: ${normalizedCommand}`.toLowerCase() ||
    lowerDetail === `shell: ${normalizedCommand}`.toLowerCase() ||
    lowerDetail === `run command: ${normalizedCommand}`.toLowerCase()
  );
}

function isCommandWorkEntry(workEntry: TimelineWorkEntry): boolean {
  const textHint = `${workEntry.toolTitle ?? ""} ${workEntry.label}`.toLowerCase();
  return (
    workEntry.requestKind === "command" ||
    workEntry.itemType === "command_execution" ||
    textHint.includes("run command") ||
    textHint.includes("ran command") ||
    textHint.includes("execute command")
  );
}

function isFileEditWorkEntry(workEntry: TimelineWorkEntry): boolean {
  return (
    workEntry.requestKind === "file-change" &&
    !isCommandWorkEntry(workEntry) &&
    (workEntry.changedFiles?.length ?? 0) > 0
  );
}

function isFileReadWorkEntry(workEntry: TimelineWorkEntry): boolean {
  const textHint = `${workEntry.toolTitle ?? ""} ${workEntry.label}`.toLowerCase();
  return (
    workEntry.requestKind === "file-read" ||
    textHint.includes("read file") ||
    textHint.includes("open file") ||
    textHint.includes("inspect file")
  );
}

function isSearchWorkEntry(workEntry: TimelineWorkEntry): boolean {
  const textHint = `${workEntry.toolTitle ?? ""} ${workEntry.label}`.toLowerCase();
  return (
    workEntry.itemType === "web_search" || /\b(find|search|grep|ripgrep|glob)\b/.test(textHint)
  );
}

function cleanProviderPayloadText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed
    .replace(/<\/?(?:path|type|content|task_result|task)[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isRawProviderPayloadText(value: string | null): boolean {
  if (!value) {
    return false;
  }
  return /<\/?[a-z_][^>]*>/iu.test(value) || /^\s*[{[]/u.test(value);
}

function extractReadablePath(workEntry: TimelineWorkEntry): string | null {
  const changedPath = workEntry.changedFiles?.[0];
  if (changedPath) {
    return changedPath;
  }
  const raw = workEntry.detail ?? workEntry.label;
  const pathMatch =
    raw.match(/<path>(?<path>[^<]+)<\/path>/u) ??
    raw.match(/(?:^|\s)(?<path>(?:~|\/|\.{1,2}\/)[^\s<>"']+)/u);
  const pathValue = pathMatch?.groups?.path?.trim();
  if (pathValue && pathValue.length > 0) {
    return pathValue;
  }
  const cleaned = cleanProviderPayloadText(workEntry.detail);
  if (cleaned && !/\s/u.test(cleaned) && cleaned.length <= 160) {
    return cleaned;
  }
  return null;
}

function extractSearchQuery(workEntry: TimelineWorkEntry): string | null {
  const raw = cleanProviderPayloadText(workEntry.detail) ?? workEntry.toolTitle ?? workEntry.label;
  const quoted = raw.match(/["'`](?<query>[^"'`]{2,})["'`]/u)?.groups?.query?.trim();
  if (quoted) {
    return quoted;
  }
  const query = raw
    .replace(/\b(?:find|search|grep|ripgrep|glob|rg)\b/giu, "")
    .replace(/--?[a-z][\w-]*(?:=\S+)?/giu, "")
    .trim();
  return query.length > 0 ? compactDisplayText(query, 56) : null;
}

function formatSubagentLabel(value: string | undefined): string | null {
  const normalized = value?.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized
    .split(" ")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function nonCommandWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (workEntry.tone === "error") {
    if (workEntry.diagnosticKind === "runtime-error") {
      return "Runtime error";
    }
    return "Error";
  }
  if (workEntry.tone === "thinking") {
    return "Thinking";
  }
  if (workEntry.itemType === "collab_agent_tool_call") {
    const label =
      formatSubagentLabel(workEntry.subagentName) ?? formatSubagentLabel(workEntry.subagentType);
    return label ? `Subagent ${label}` : "Subagent task";
  }
  if (workEntry.itemType === "image_view") {
    const path = extractReadablePath(workEntry);
    return path ? `Viewed ${basenameOfPath(path) || path}` : "Viewed image";
  }
  if (isFileReadWorkEntry(workEntry)) {
    const path = extractReadablePath(workEntry);
    return path ? `Read ${basenameOfPath(path) || path}` : "Read file";
  }
  if (isSearchWorkEntry(workEntry)) {
    const query = extractSearchQuery(workEntry);
    return query ? `Searched "${query}"` : "Searched";
  }
  return toolWorkEntryHeading(workEntry);
}

function commandStatusLabel(workEntry: TimelineWorkEntry): {
  text: string;
  className: string;
  icon: TimelineIcon;
} {
  if (workEntry.exitCode !== undefined && workEntry.exitCode !== 0) {
    return {
      text: `Exit code ${workEntry.exitCode}`,
      className: "text-red-300/80",
      icon: CircleAlertIcon,
    };
  }
  if (workEntry.status === "failed") {
    return {
      text: "Failed",
      className: "text-red-300/80",
      icon: CircleAlertIcon,
    };
  }
  if (workEntry.status === "completed" || workEntry.exitCode === 0) {
    return {
      text: "Success",
      className: "text-emerald-300/80",
      icon: CheckIcon,
    };
  }
  return {
    text: "Running",
    className: "text-muted-foreground/76",
    icon: Clock3Icon,
  };
}

function commandWorkEntryPlainText(workEntry: TimelineWorkEntry): string {
  const command = compactCommandText(commandTextFromWorkEntry(workEntry));
  if (workEntry.status === "inProgress") {
    return command ? `Running ${command}` : "Running command";
  }
  return command ? `Ran ${command}` : "Ran command";
}

function workEntryIcon(workEntry: TimelineWorkEntry): TimelineIcon {
  if (workEntry.requestKind === "command") return IconTerminal;
  if (workEntry.requestKind === "file-read") return EyeIcon;

  const textHint = `${workEntry.toolTitle ?? ""} ${workEntry.label}`.trim().toLowerCase();
  if (/\b(find|search|grep|ripgrep|glob)\b/.test(textHint)) return GlobeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return IconTerminal;
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
  if (workEntry.tone === "tool" && isCommandWorkEntry(workEntry)) {
    return <CommandWorkEntryRow {...props} />;
  }
  if (workEntry.tone === "tool" && isFileEditWorkEntry(workEntry)) {
    return <FileEditWorkEntryRow {...props} />;
  }

  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = nonCommandWorkEntryHeading(workEntry);
  const commandIsAlreadyInHeading =
    workEntry.command !== undefined && heading.includes(workEntry.command);
  const detailText =
    commandIsAlreadyInHeading && !workEntry.detail ? null : workEntryDetailText(workEntry);
  const terminalOutputText = normalizeTerminalOutputText(workEntry.terminalOutput);
  const displayText = detailText ? `${heading} - ${detailText}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;
  const inlineIntentText = props.inlineIntentText?.trim() || null;
  const variant = props.variant ?? "standalone";
  const isNested = variant === "nested";
  const tone = resolveWorkEntryTone(workEntry.tone);
  const showDetailInline =
    workEntry.tone !== "thinking" &&
    workEntry.tone !== "error" &&
    !isFileReadWorkEntry(workEntry) &&
    !isSearchWorkEntry(workEntry) &&
    workEntry.itemType !== "image_view" &&
    Boolean(detailText) &&
    !terminalOutputText &&
    !isRawProviderPayloadText(detailText);
  const hasExpandableDetail =
    workEntry.tone !== "thinking" &&
    !showDetailInline &&
    Boolean(detailText || terminalOutputText || hasChangedFiles);
  const [isDetailOpen, setIsDetailOpen] = useState(
    workEntry.tone === "error" || workEntry.diagnosticKind !== undefined,
  );
  const DetailChevronIcon = isDetailOpen ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div
      className={cn("min-w-0", isNested && "pl-3")}
      data-work-entry-id={workEntry.id}
      data-work-entry-tone={workEntry.tone}
      data-work-entry-nested={isNested ? "true" : undefined}
    >
      <div
        className={cn(
          "flex items-start transition-[opacity,translate] duration-200",
          isNested ? "gap-2.5" : "gap-3",
        )}
      >
        <EntryIcon
          className={cn(
            "mt-1 shrink-0",
            isNested ? "size-3.5" : "size-4",
            iconConfig.className,
            metaToneTextClass(tone),
          )}
        />
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="mb-0.5 flex min-w-0 items-center gap-2">
            <button
              type="button"
              className={cn(
                "group/work-detail flex min-w-0 max-w-full items-center gap-1.5 rounded-sm bg-transparent p-0 text-left leading-5 text-muted-foreground/70 outline-none transition-colors duration-100 hover:text-foreground/90 focus-visible:text-foreground/90 focus-visible:outline-none focus-visible:ring-0",
                isNested ? "text-[12px]" : "text-[15px]",
                workEntry.tone === "thinking" && "tracking-[0.01em]",
                !hasExpandableDetail && "cursor-default hover:text-muted-foreground/70",
              )}
              onClick={() => {
                if (hasExpandableDetail) {
                  setIsDetailOpen((current) => !current);
                }
              }}
              aria-expanded={hasExpandableDetail ? isDetailOpen : undefined}
              data-work-detail-disclosure={hasExpandableDetail ? "true" : undefined}
              data-work-detail-open={hasExpandableDetail ? String(isDetailOpen) : undefined}
            >
              <InlineTooltip content={displayText} className="min-w-0 truncate">
                {heading}
              </InlineTooltip>
              {hasExpandableDetail && (
                <DetailChevronIcon
                  className="size-3.5 shrink-0 text-muted-foreground/55 transition-colors duration-100 group-hover/work-detail:text-foreground/82 group-focus-visible/work-detail:text-foreground/82"
                  strokeWidth={2.2}
                />
              )}
            </button>
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
          {detailText && workEntry.tone === "thinking" && (
            <InlineTooltip
              content={detailText}
              className={cn(
                "wrap-break-word block whitespace-pre-wrap",
                workEntry.tone === "thinking" && isNested
                  ? "mt-0.5 text-[11px] leading-5 text-foreground/76"
                  : workEntry.tone === "thinking"
                    ? "text-[11px] leading-5 text-foreground/72"
                    : isNested
                      ? "font-mono text-[11px] leading-5 text-muted-foreground/62"
                      : "font-mono text-[10px] leading-5 text-muted-foreground/65",
              )}
            >
              {detailText}
            </InlineTooltip>
          )}
          {showDetailInline && detailText && (
            <InlineTooltip
              content={detailText}
              className={cn(
                "wrap-break-word block whitespace-pre-wrap",
                isNested
                  ? "font-mono text-[11px] leading-5 text-muted-foreground/62"
                  : "font-mono text-[10px] leading-5 text-muted-foreground/65",
              )}
            >
              {detailText}
            </InlineTooltip>
          )}
          {isDetailOpen && hasExpandableDetail && (
            <div
              className="mt-1.5 max-w-full rounded-md bg-muted/35 px-3 py-2"
              data-work-detail-panel="true"
            >
              {detailText && (
                <InlineTooltip
                  content={detailText}
                  className={cn(
                    "wrap-break-word block whitespace-pre-wrap",
                    workEntry.tone === "error"
                      ? "text-[12px] leading-5 text-red-200/88"
                      : "font-mono text-[11px] leading-5 text-muted-foreground/72",
                  )}
                >
                  {detailText}
                </InlineTooltip>
              )}
              {terminalOutputText && (
                <InlineTooltip
                  content={terminalOutputText}
                  className="mt-1 block whitespace-pre-wrap border-l border-border/55 pl-2 font-mono text-[11px] leading-4 text-muted-foreground/72"
                >
                  {terminalOutputText}
                  {workEntry.terminalOutputTruncated ? "\n... output truncated" : ""}
                </InlineTooltip>
              )}
              {hasChangedFiles && (
                <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1">
                  {workEntry.changedFiles?.slice(0, 6).map((filePath) => (
                    <InlineTooltip
                      key={`${workEntry.id}:${filePath}`}
                      content={filePath}
                      className="font-mono text-[10px] text-muted-foreground/75"
                    >
                      {filePath}
                    </InlineTooltip>
                  ))}
                  {(workEntry.changedFiles?.length ?? 0) > 6 && (
                    <span className="px-1 text-[10px] text-muted-foreground/55">
                      +{(workEntry.changedFiles?.length ?? 0) - 6}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {hasChangedFiles && !previewIsChangedFiles && !hasExpandableDetail && (
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 pl-5.5">
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => (
            <InlineTooltip
              key={`${workEntry.id}:${filePath}`}
              content={filePath}
              className="font-mono text-[10px] text-muted-foreground/75"
            >
              {filePath}
            </InlineTooltip>
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

const CommandWorkEntryRow = memo(function CommandWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  inlineIntentText?: string | null;
  variant?: "nested" | "standalone";
}) {
  const { workEntry } = props;
  const command = commandTextFromWorkEntry(workEntry);
  const outputText = normalizeTerminalOutputText(workEntry.terminalOutput);
  const detailText = commandDetailIsDuplicate(workEntry.command, workEntry.detail)
    ? null
    : command && workEntry.detail?.trim() === command
      ? null
      : workEntry.detail?.trim() || null;
  const status = commandStatusLabel(workEntry);
  const durationText = formatToolDuration(workEntry.durationMs);
  const heading = commandWorkEntryPlainText(workEntry);
  const detailOutput = outputText ?? detailText;
  const variant = props.variant ?? "standalone";
  const isNested = variant === "nested";
  const inlineIntentText = props.inlineIntentText?.trim() || null;
  const hasExpandableOutput = Boolean(command || detailOutput);
  const [isOutputOpen, setIsOutputOpen] = useState(false);
  const OutputChevronIcon = isOutputOpen ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div
      className={cn("min-w-0", isNested && "pl-3")}
      data-work-entry-id={workEntry.id}
      data-work-entry-tone={workEntry.tone}
      data-work-entry-kind="command"
      data-work-entry-nested={isNested ? "true" : undefined}
    >
      <div className={cn("flex items-start", isNested ? "gap-2.5" : "gap-3")}>
        <IconTerminal
          className={cn("mt-1 shrink-0 text-muted-foreground/62", isNested ? "size-3.5" : "size-4")}
        />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className={cn(
              "group/command flex max-w-full items-center gap-1.5 rounded-sm bg-transparent p-0 text-left leading-6 text-muted-foreground/70 outline-none transition-colors duration-100 hover:text-foreground/90 focus-visible:text-foreground/90 focus-visible:outline-none focus-visible:ring-0",
              isNested ? "text-[12px]" : "text-[15px]",
              !hasExpandableOutput && "cursor-default hover:text-muted-foreground/70",
            )}
            onClick={() => {
              if (hasExpandableOutput) {
                setIsOutputOpen((current) => !current);
              }
            }}
            aria-expanded={hasExpandableOutput ? isOutputOpen : undefined}
            data-command-output-disclosure={hasExpandableOutput ? "true" : undefined}
            data-command-output-open={hasExpandableOutput ? String(isOutputOpen) : undefined}
          >
            <InlineTooltip
              content={[
                command ?? heading,
                durationText ? `Finished in ${durationText}` : null,
                status.text !== "Running" ? status.text : null,
              ]
                .filter(Boolean)
                .join("\n")}
              className="min-w-0 truncate"
            >
              {heading}
            </InlineTooltip>
            {hasExpandableOutput && (
              <OutputChevronIcon
                className="size-3.5 shrink-0 text-muted-foreground/55 transition-colors duration-100 group-hover/command:text-foreground/82 group-focus-visible/command:text-foreground/82"
                strokeWidth={2.2}
              />
            )}
          </button>
          {inlineIntentText && (
            <p
              className="mt-1 text-[11px] leading-5 text-muted-foreground/68"
              data-inline-intent="true"
            >
              <span className="mr-1 text-[9px] uppercase tracking-[0.14em] text-muted-foreground/38">
                Intent
              </span>
              <span className="text-foreground/72">{inlineIntentText}</span>
            </p>
          )}
          {isOutputOpen && hasExpandableOutput && (
            <div
              className={cn(
                "mt-2 max-w-full rounded-md bg-muted/45 px-3 py-2.5",
                isNested && "-ml-6",
              )}
              data-command-output-panel="true"
            >
              <div className="mb-2 text-[11px] leading-none text-muted-foreground/72">Shell</div>
              {command && (
                <pre className="mb-2 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-5 text-foreground/92">
                  {`$ ${command}`}
                </pre>
              )}
              {detailOutput && (
                <InlineTooltip
                  content={detailOutput}
                  className="block whitespace-pre-wrap font-mono text-[11px] leading-5 text-muted-foreground/82"
                >
                  {detailOutput}
                  {workEntry.terminalOutputTruncated ? "\n... output truncated" : ""}
                </InlineTooltip>
              )}
              {status.text !== "Running" && (
                <div className={cn("mt-2 text-right text-[12px] leading-5", status.className)}>
                  {status.text}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

const FileEditWorkEntryRow = memo(function FileEditWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  inlineIntentText?: string | null;
  variant?: "nested" | "standalone";
}) {
  const { workEntry } = props;
  const variant = props.variant ?? "standalone";
  const isNested = variant === "nested";
  const firstPath = workEntry.changedFiles?.[0] ?? workEntry.detail ?? "file";
  const visibleName = basenameOfPath(firstPath) || firstPath;
  const stat =
    workEntry.changedFileStats?.find((entry) => entry.path === firstPath) ??
    workEntry.changedFileStats?.[0];
  const extraCount = Math.max(0, (workEntry.changedFiles?.length ?? 0) - 1);
  const inlineIntentText = props.inlineIntentText?.trim() || null;

  return (
    <div
      className={cn("min-w-0", isNested && "pl-3")}
      data-work-entry-id={workEntry.id}
      data-work-entry-tone={workEntry.tone}
      data-work-entry-kind="file-edit"
      data-work-entry-nested={isNested ? "true" : undefined}
    >
      <div className={cn("flex items-start", isNested ? "gap-2.5" : "gap-3")}>
        <SquarePenIcon
          className={cn("mt-1 shrink-0 text-muted-foreground/62", isNested ? "size-3.5" : "size-4")}
        />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "min-w-0 leading-5 text-muted-foreground/82",
              isNested ? "text-[12px]" : "text-[13px]",
            )}
          >
            <span>Editing </span>
            <InlineTooltip content={firstPath} className="font-medium text-sky-300/90">
              {visibleName}
            </InlineTooltip>
            {extraCount > 0 && (
              <span className="ml-1 text-muted-foreground/54">+{extraCount} more</span>
            )}
            {stat?.additions !== undefined && stat.additions > 0 && (
              <span className="ml-2 font-mono text-emerald-300/90">+{stat.additions}</span>
            )}
            {stat?.deletions !== undefined && stat.deletions > 0 && (
              <span className="ml-1 font-mono text-red-300/90">-{stat.deletions}</span>
            )}
          </p>
          {inlineIntentText && (
            <p
              className="mt-1 text-[11px] leading-5 text-muted-foreground/68"
              data-inline-intent="true"
            >
              <span className="mr-1 text-[9px] uppercase tracking-[0.14em] text-muted-foreground/38">
                Intent
              </span>
              <span className="text-foreground/72">{inlineIntentText}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
});
