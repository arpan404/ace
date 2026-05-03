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
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  ImageIcon,
  PlugIcon,
  SquarePenIcon,
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
  textContainsInlineTerminalContextLabels,
} from "~/lib/chat/userMessageTerminalContexts";
import { COMPOSER_PROVIDER_COMMAND_MARKER } from "~/composer-editor-mentions";
import {
  buildTimelineRows,
  isCompletedAssistantMessageRow,
  isEventInActiveTurn,
  shouldWorkerizeTimelineRows,
  type AssistantTimelineMessage,
  type BuildTimelineRowsInput,
  type SystemTimelineMessage,
  type TimelineMetaGroupEntry,
  type TimelineMessage,
  type TimelineProposedPlan,
  type TimelineRow,
  type TimelineWorkEntry,
  type UserTimelineMessage,
} from "~/lib/chat/timelineRows";
import {
  buildTimelineRowsCacheKey,
  prewarmTimelineRows,
  readCachedTimelineRows,
  writeCachedTimelineRows,
} from "~/lib/chat/timelineRowsClient";
import type { TimelineEntry } from "../../session-logic/types";

const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;
const TIMELINE_VIRTUALIZER_OVERSCAN = 12;
const MAX_TIMELINE_ROW_HEIGHT_CACHE_ENTRIES = 4_096;
const IMMEDIATE_ASSISTANT_MARKDOWN_TAIL_MESSAGES = 12;
const ASSISTANT_MARKDOWN_IDLE_BATCH_SIZE = 2;
const ASSISTANT_MARKDOWN_IDLE_TIMEOUT_MS = 600;
const ASSISTANT_MARKDOWN_FALLBACK_DELAY_MS = 80;
const TIMELINE_WIDTH_RESIZE_DEBOUNCE_MS = 96;
const TIMELINE_INITIAL_VIEWPORT_HEIGHT_PX = 720;
const EMPTY_TIMELINE_ROWS: ReadonlyArray<TimelineRow> = [];
const ASSISTANT_IMAGE_GENERATION_MESSAGE_ID_REGEX =
  /^assistant:image:(?<width>\d{2,5})x(?<height>\d{2,5}):/u;
const IMAGEGEN_COMMAND_TOKEN_REGEX = /(^|[\s([{])(?:\/|\$)imagegen(?=$|[\s,.;:!?)}\]])/iu;
const IMAGE_GENERATION_TOOL_TEXT_REGEX =
  /\b(?:imagegen|image[_ -]?gen|image[_ -]?generation|generate[_ -]?image|image[_ -]?generator)\b/iu;
const IMAGE_GENERATION_STATUS_TEXT_REGEX =
  /\b(?:generat(?:e|es|ed|ing)|creat(?:e|es|ed|ing)|render(?:s|ed|ing)?|mak(?:e|es|ing))\b[\s\S]{0,180}\b(?:image|mockup|visual|illustration|picture|photo|portrait|landscape)\b|\b(?:image|mockup|visual|illustration|picture|photo|portrait|landscape)\b[\s\S]{0,180}\b(?:generat(?:e|es|ed|ing)|creat(?:e|es|ed|ing)|render(?:s|ed|ing)?|mak(?:e|es|ing))\b/iu;
const IMAGE_DIMENSIONS_TEXT_REGEX = /(?<width>\d{2,5})\s*[x×]\s*(?<height>\d{2,5})/iu;
const DEFAULT_IMAGE_GENERATION_PLACEHOLDER_DIMENSIONS = {
  width: 1536,
  height: 1024,
} as const;
const PORTRAIT_IMAGE_GENERATION_PLACEHOLDER_DIMENSIONS = {
  width: 1024,
  height: 1536,
} as const;
const SQUARE_IMAGE_GENERATION_PLACEHOLDER_DIMENSIONS = {
  width: 1024,
  height: 1024,
} as const;
const IMAGE_GENERATION_FRAME_MAX_WIDTH_REM = 42;
const IMAGE_GENERATION_LANDSCAPE_FRAME_MAX_HEIGHT_VH = 54;
const IMAGE_GENERATION_SQUARE_FRAME_MAX_HEIGHT_VH = 46;
const IMAGE_GENERATION_PORTRAIT_FRAME_MAX_HEIGHT_VH = 42;

interface AssistantImageGenerationPlaceholder {
  readonly width: number;
  readonly height: number;
}

const IMAGE_GENERATION_FLOATING_DOTS = [
  { x: "-36px", y: "-18px", size: "7px", delay: "0s", floatX: "5px", floatY: "-10px" },
  { x: "-16px", y: "10px", size: "10px", delay: "-0.7s", floatX: "-6px", floatY: "-8px" },
  { x: "10px", y: "-26px", size: "8px", delay: "-1.35s", floatX: "4px", floatY: "11px" },
  { x: "33px", y: "8px", size: "12px", delay: "-0.35s", floatX: "-7px", floatY: "-7px" },
  { x: "-4px", y: "-2px", size: "6px", delay: "-1.8s", floatX: "8px", floatY: "6px" },
  { x: "48px", y: "-20px", size: "6px", delay: "-1.05s", floatX: "-5px", floatY: "9px" },
] as const;

function canResolveTimelineRowsInWorker(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof Worker !== "undefined" &&
    typeof document.createElement === "function"
  );
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

function imageGenerationFloatingDotStyle(
  dot: (typeof IMAGE_GENERATION_FLOATING_DOTS)[number],
): CSSProperties {
  return {
    "--dot-x": dot.x,
    "--dot-y": dot.y,
    "--dot-size": dot.size,
    "--dot-delay": dot.delay,
    "--dot-float-x": dot.floatX,
    "--dot-float-y": dot.floatY,
  } as CSSProperties;
}

function normalizeImageGenerationDimension(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const dimension = Number(value);
  if (!Number.isFinite(dimension) || dimension < 32 || dimension > 8192) {
    return null;
  }
  return Math.round(dimension);
}

function imageGenerationDimensionsFromText(
  text: string,
): AssistantImageGenerationPlaceholder | null {
  const match = IMAGE_DIMENSIONS_TEXT_REGEX.exec(text);
  const width = normalizeImageGenerationDimension(match?.groups?.width);
  const height = normalizeImageGenerationDimension(match?.groups?.height);
  return width !== null && height !== null ? { width, height } : null;
}

function imageGenerationPlaceholderDimensionsFromText(
  text: string,
): AssistantImageGenerationPlaceholder {
  const explicitDimensions = imageGenerationDimensionsFromText(text);
  if (explicitDimensions) {
    return explicitDimensions;
  }
  if (/\b(?:portrait|mobile|phone|vertical|tall)\b/iu.test(text)) {
    return PORTRAIT_IMAGE_GENERATION_PLACEHOLDER_DIMENSIONS;
  }
  if (/\b(?:square|avatar|icon)\b/iu.test(text)) {
    return SQUARE_IMAGE_GENERATION_PLACEHOLDER_DIMENSIONS;
  }
  return DEFAULT_IMAGE_GENERATION_PLACEHOLDER_DIMENSIONS;
}

function imageGenerationWorkEntryText(workEntry: TimelineWorkEntry): string {
  return [
    workEntry.toolTitle,
    workEntry.label,
    workEntry.detail,
    workEntry.command,
    workEntry.itemType,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
}

function imageGenerationPlaceholderDimensionsFromWorkEntry(
  workEntry: TimelineWorkEntry,
): AssistantImageGenerationPlaceholder | null {
  const text = imageGenerationWorkEntryText(workEntry);
  if (!IMAGE_GENERATION_TOOL_TEXT_REGEX.test(text)) {
    return null;
  }
  return imageGenerationPlaceholderDimensionsFromText(text);
}

function isImageGenerationWorkEntry(workEntry: TimelineWorkEntry): boolean {
  return imageGenerationPlaceholderDimensionsFromWorkEntry(workEntry) !== null;
}

function userMessageStartsImageGeneration(message: TimelineMessage): boolean {
  if (message.role !== "user") {
    return false;
  }
  const text = message.text.replaceAll(COMPOSER_PROVIDER_COMMAND_MARKER, "");
  return IMAGEGEN_COMMAND_TOKEN_REGEX.test(text);
}

function assistantMessageIndicatesImageGeneration(
  message: AssistantTimelineMessage,
): AssistantImageGenerationPlaceholder | null {
  if ((message.attachments?.length ?? 0) > 0) {
    return null;
  }
  const text = getChatMessageRenderableText(message).trim();
  if (!text || !IMAGE_GENERATION_STATUS_TEXT_REGEX.test(text)) {
    return null;
  }
  return imageGenerationPlaceholderDimensionsFromText(text);
}

function findActiveImageGenerationWorkingPlaceholder(
  rows: ReadonlyArray<TimelineRow>,
  timelineEntries: ReadonlyArray<TimelineEntry>,
): AssistantImageGenerationPlaceholder | null {
  const toolPlaceholder =
    findActiveImageGenerationToolPlaceholderFromTimelineEntries(timelineEntries);
  if (toolPlaceholder) {
    return toolPlaceholder;
  }

  let assistantStatusPlaceholder: AssistantImageGenerationPlaceholder | null = null;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || row.kind !== "message") {
      continue;
    }
    if (
      isAssistantTimelineMessage(row.message) &&
      assistantImageGenerationPlaceholder(row.message)
    ) {
      return null;
    }
    if (isAssistantTimelineMessage(row.message)) {
      const assistantPlaceholder = assistantMessageIndicatesImageGeneration(row.message);
      if (assistantPlaceholder) {
        assistantStatusPlaceholder = assistantPlaceholder;
      }
      if ((row.message.attachments?.length ?? 0) > 0) {
        return null;
      }
      continue;
    }
    if (row.message.role !== "user") {
      continue;
    }
    if (!userMessageStartsImageGeneration(row.message)) {
      return assistantStatusPlaceholder;
    }
    return imageGenerationPlaceholderDimensionsFromText(row.message.text);
  }

  return assistantStatusPlaceholder;
}

function findActiveImageGenerationToolPlaceholderFromTimelineEntries(
  timelineEntries: ReadonlyArray<TimelineEntry>,
): AssistantImageGenerationPlaceholder | null {
  for (let index = timelineEntries.length - 1; index >= 0; index -= 1) {
    const timelineEntry = timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }
    if (timelineEntry.kind === "work") {
      const dimensions = imageGenerationPlaceholderDimensionsFromWorkEntry(timelineEntry.entry);
      if (dimensions) {
        return dimensions;
      }
      continue;
    }
    if (timelineEntry.kind !== "message") {
      continue;
    }
    if (timelineEntry.message.role === "user") {
      return null;
    }
    if (!isAssistantTimelineMessage(timelineEntry.message)) {
      continue;
    }
    if (
      assistantImageGenerationPlaceholder(timelineEntry.message) ||
      (timelineEntry.message.attachments?.length ?? 0) > 0
    ) {
      return null;
    }
  }

  return null;
}

const timelineRowHeightCache = new Map<string, number>();
type TimelineIcon = ComponentType<{ className?: string }>;
interface AssistantMarkdownAnalysisPrewarmJob {
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
  backgroundMarkdownPrewarm?: boolean;
  getScrollContainer: () => HTMLDivElement | null;
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
  revertActionTitle?: string;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  markdownCwd: string | undefined;
  onOpenBrowserUrl?: ((url: string) => void) | null;
  onOpenFilePath?: ((path: string) => void) | null;
  enableLocalFileLinks?: boolean;
  providerCommands?: ReadonlyArray<ProviderSlashCommand>;
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
  backgroundMarkdownPrewarm = true,
  getScrollContainer,
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
  revertActionTitle = "Revert to this message",
  isRevertingCheckpoint,
  onImageExpand,
  markdownCwd,
  onOpenBrowserUrl = null,
  onOpenFilePath = null,
  enableLocalFileLinks = true,
  providerCommands = [],
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
}: MessagesTimelineProps) {
  const userMessageProviderCommandLookup = useMemo(
    () => buildUserMessageProviderCommandLookup(providerCommands),
    [providerCommands],
  );
  const visibleTimelineEntries = useMemo(
    () =>
      timelineEntries.filter(
        (entry) => entry.kind !== "work" || !isImageGenerationWorkEntry(entry.entry),
      ),
    [timelineEntries],
  );
  const timelineRowsInput = useMemo<BuildTimelineRowsInput>(
    () => ({
      timelineEntries: visibleTimelineEntries,
      activeTurnInProgress,
      activeTurnStartedAt,
      completionDividerBeforeEntryId,
      completionSummary,
      isWorking,
    }),
    [
      activeTurnInProgress,
      visibleTimelineEntries,
      completionDividerBeforeEntryId,
      completionSummary,
      isWorking,
      activeTurnStartedAt,
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
  const rows = useMemo(
    () => (syncTimelineRows.length > 0 ? syncTimelineRows : EMPTY_TIMELINE_ROWS),
    [syncTimelineRows],
  );
  const activeImageGenerationWorkingPlaceholder = useMemo(
    () =>
      isWorking && activeTurnInProgress
        ? findActiveImageGenerationWorkingPlaceholder(rows, timelineEntries)
        : null,
    [activeTurnInProgress, isWorking, rows, timelineEntries],
  );

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
      [turnId]: !(current[turnId] ?? false),
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
  const shouldUseVirtualizedBuffer = virtualizedRows.length > 0 && !activeTurnInProgress;
  const shouldPrioritizeAssistantMarkdown = shouldUseVirtualizedBuffer;
  const shouldPrewarmAssistantMarkdown =
    shouldPrioritizeAssistantMarkdown && backgroundMarkdownPrewarm;
  const virtualItems = shouldUseVirtualizedBuffer ? rowVirtualizer.getVirtualItems() : [];
  const mountedVirtualizedAssistantMarkdownMessageIds = shouldPrioritizeAssistantMarkdown
    ? deriveMountedVirtualizedAssistantMarkdownMessageIds(virtualItems, virtualizedRows)
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
  const allAssistantMarkdownMessageIds = useMemo(
    () => rows.filter(isCompletedAssistantMessageRow).map((row) => String(row.message.id)),
    [rows],
  );
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

    const jobsByMessageId = new Map<string, AssistantMarkdownAnalysisPrewarmJob>();
    for (const row of rows) {
      if (!isCompletedAssistantMessageRow(row)) {
        continue;
      }
      const messageText = getChatMessageRenderableText(row.message);
      const input: MarkdownRenderAnalysisInput = {
        text: messageText,
        isStreaming: Boolean(row.message.streaming),
        renderPlainText: false,
        ...(row.message.streamingTextState
          ? {
              streamingTextState: {
                totalLineCount: row.message.streamingTextState.totalLineCount,
                truncatedCharCount: row.message.streamingTextState.truncatedCharCount,
                truncatedLineCount: row.message.streamingTextState.truncatedLineCount,
              },
            }
          : {}),
      };
      if (!shouldWorkerizeMarkdownRenderAnalysis(input)) {
        continue;
      }
      jobsByMessageId.set(String(row.message.id), {
        cacheKey: buildMarkdownRenderAnalysisCacheKey(
          input,
          buildAssistantMarkdownAnalysisStableKey(row.message, messageText),
        ),
        input,
      });
    }

    const jobs: AssistantMarkdownAnalysisPrewarmJob[] = [];
    const seenCacheKeys = new Set<string>();
    for (const messageId of immediateAssistantMarkdownMessageIds) {
      const job = jobsByMessageId.get(messageId);
      if (!job || seenCacheKeys.has(job.cacheKey)) {
        continue;
      }
      seenCacheKeys.add(job.cacheKey);
      jobs.push(job);
    }
    for (const messageId of pendingAssistantMarkdownMessageIds) {
      const job = jobsByMessageId.get(messageId);
      if (!job || seenCacheKeys.has(job.cacheKey)) {
        continue;
      }
      seenCacheKeys.add(job.cacheKey);
      jobs.push(job);
    }
    return jobs;
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
                  className="group/disclosure w-full rounded-md border border-border/35 bg-background/45 px-2.5 py-1.5 text-left transition-[background-color,border-color] duration-100 hover:border-border/55 hover:bg-background/65"
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
                  <div className="flex min-w-0 items-center gap-2.5 text-foreground/60 transition-[color,opacity] duration-100 group-hover/disclosure:text-foreground/94">
                    <ChevronIcon
                      strokeWidth={2.5}
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground/48 transition-[transform,color,opacity] duration-150 group-hover/disclosure:text-muted-foreground/78 group-hover/disclosure:opacity-100",
                        metaToneTextClass(surfaceTone),
                      )}
                    />
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[12px] leading-5 text-foreground/62">
                        {breakdownParts.map((part, index) => (
                          <Fragment key={`${row.id}:summary:${part.label}:${part.count}`}>
                            {index > 0 && (
                              <span className="shrink-0 text-muted-foreground/46 group-hover/disclosure:text-muted-foreground/68">
                                ·
                              </span>
                            )}
                            <span
                              className="min-w-0 truncate font-medium text-foreground/64 decoration-border/0 underline underline-offset-[5px] transition-[color,font-weight,text-decoration-color,opacity] duration-100 group-hover/disclosure:font-semibold group-hover/disclosure:text-foreground/96 group-hover/disclosure:decoration-border/85"
                              title={`${part.count} ${part.label}`}
                            >
                              <span className="inline-flex items-baseline gap-1">
                                <span>{part.count}</span>
                                <span>{part.label}</span>
                              </span>
                            </span>
                          </Fragment>
                        ))}
                      </div>
                    </div>
                    {elapsedLabel && (
                      <div
                        className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] font-medium text-muted-foreground/46 transition-[color,opacity] duration-100 group-hover/disclosure:text-muted-foreground/72"
                        data-meta-disclosure-elapsed={elapsedLabel}
                      >
                        <Clock3Icon className="size-3.5 shrink-0" strokeWidth={2.4} />
                        <span>{elapsedLabel}</span>
                      </div>
                    )}
                  </div>
                </button>
                {isExpanded && (
                  <div className="mt-2 space-y-2 border-border/35 border-l pl-4">
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
                  markdownCwd={markdownCwd}
                  message={row.message}
                  onImageExpand={onImageExpand}
                  onOpenBrowserUrl={onOpenBrowserUrl}
                  onOpenFilePath={onOpenFilePath}
                  enableLocalFileLinks={enableLocalFileLinks}
                  renderMarkdown={shouldRenderAssistantMarkdown}
                  timestampFormat={timestampFormat}
                />
                {shouldShowTurnSummary && (
                  <div className="mt-2.5 rounded-xl border border-border/45 bg-background/35 px-4 py-3">
                    <AssistantMessageTurnDiffSummary
                      allDirectoriesExpanded={
                        allDirectoriesExpandedByTurnId[turnSummary.turnId] ?? false
                      }
                      onOpenTurnDiff={onOpenTurnDiff}
                      onToggleAllDirectories={onToggleAllDirectories}
                      resolvedTheme={resolvedTheme}
                      turnSummary={turnSummary}
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

        {row.kind === "working" &&
          (activeImageGenerationWorkingPlaceholder ? (
            <div className="min-w-0 py-1">
              <ImageGenerationPlaceholderFrame
                createdAt={row.createdAt}
                dimensions={activeImageGenerationWorkingPlaceholder}
                liveTimers={liveTimers}
              />
            </div>
          ) : (
            <div className="min-w-0 py-1">
              <div className="flex items-center gap-2.5 text-[12px] text-muted-foreground/72">
                <span className="inline-flex items-center gap-1">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full bg-muted-foreground/28",
                      liveTimers ? "animate-pulse" : null,
                    )}
                  />
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full bg-muted-foreground/24",
                      liveTimers ? "animate-pulse [animation-delay:200ms]" : null,
                    )}
                  />
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full bg-muted-foreground/20",
                      liveTimers ? "animate-pulse [animation-delay:400ms]" : null,
                    )}
                  />
                </span>
                <span>
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
          ))}
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
          {virtualItems.map((virtualRow) => {
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
  readonly createdAt: string | null;
  readonly dimensions: AssistantImageGenerationPlaceholder;
  readonly liveTimers: boolean;
}) {
  const dimensionLabel = `${props.dimensions.width} x ${props.dimensions.height}`;

  return (
    <div
      className="image-generation-placeholder-frame relative mb-2.5 max-w-3xl overflow-hidden rounded-xl border border-border/55 bg-muted/20"
      data-image-generation-placeholder="true"
      style={imageGenerationFrameStyle(props.dimensions)}
    >
      <div className="absolute inset-0 animate-pulse bg-muted/35" />
      <div
        className="image-generation-floating-dot-cluster pointer-events-none absolute inset-0"
        aria-hidden="true"
      >
        {IMAGE_GENERATION_FLOATING_DOTS.map((dot) => (
          <span
            key={`image-generation-floating-dot:${dot.x}:${dot.y}:${dot.size}`}
            className="image-generation-floating-dot"
            style={imageGenerationFloatingDotStyle(dot)}
          />
        ))}
      </div>
      <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-background/72 to-transparent" />
      <div className="absolute left-4 top-4 inline-flex items-center gap-2 rounded-md border border-border/50 bg-background/76 px-2.5 py-1.5 text-xs font-medium text-foreground/86 shadow-sm backdrop-blur">
        <span className="inline-flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <ImageIcon className="size-3.5" strokeWidth={2.2} />
        </span>
        <span>Generating image</span>
        <span className="text-muted-foreground/62">{dimensionLabel}</span>
      </div>
      <div className="absolute bottom-4 left-4 rounded-md border border-border/45 bg-background/72 px-2.5 py-1.5 text-[11px] text-muted-foreground/80 backdrop-blur">
        {props.createdAt ? (
          <WorkingTimer
            createdAt={props.createdAt}
            label="Generating for"
            live={props.liveTimers}
          />
        ) : (
          "Generating..."
        )}
      </div>
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
        row.isAssistantTurnTerminal && row.message.completedAt ? 1 : 0,
        row.showAssistantSummaryByDefault ? 1 : 0,
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

function summarizeWorkGroupElapsedLabel(
  entries: ReadonlyArray<TimelineMetaGroupEntry>,
  summaryEndAt: string | null,
): string | null {
  const firstEntry = entries[0];
  const duration =
    firstEntry && summaryEndAt
      ? formatCompletedWorkTimer(firstEntry.createdAt, summaryEndAt)
      : null;
  return duration;
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
  const eventCount = infoCount;
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
  if (eventCount > 0) {
    parts.push({ label: eventCount === 1 ? "event" : "events", count: eventCount });
  }

  if (parts.length > 0) {
    return parts;
  }

  return [{ label: entries.length === 1 ? "log entry" : "log entries", count: entries.length }];
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
  readonly kind: ProviderExtensionCommandKind;
  readonly label: string;
};

type UserMessageProviderCommandLookup = ReadonlyMap<string, UserMessageProviderCommandDisplay>;

const USER_MESSAGE_INLINE_TOKEN_REGEX =
  /(^|[\s([{])((?:(?:\/|\$)[A-Za-z0-9][A-Za-z0-9_.:/-]{0,120})(?=$|[\s,.;:!?)}\]])|(?:@[^\s@]+))/g;

function providerCommandKindForDisplay(
  command: ProviderSlashCommand,
  normalizedName: string,
): ProviderExtensionCommandKind | null {
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

function renderUserMessageInlineText(
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

    if (providerCommandDisplay) {
      const ProviderCommandIcon = providerCommandDisplay.kind === "plugin" ? PlugIcon : IconStack2;
      nodes.push(
        <span
          key={`${keyPrefix}:provider-command:${tokenStart}`}
          className="inline-flex items-center gap-1 rounded-md border border-sky-500/35 bg-sky-500/10 px-1 py-px font-medium text-sky-700 leading-[1.15] dark:text-sky-300"
        >
          <ProviderCommandIcon
            aria-hidden="true"
            className={
              providerCommandDisplay.kind === "plugin"
                ? "size-3.5 shrink-0 text-violet-400/90"
                : "size-3.5 shrink-0 text-cyan-400/90"
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
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            ...renderUserMessageInlineText(
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
            ...renderUserMessageInlineText(
              props.text.slice(cursor),
              `user-message-terminal-context-inline-rest:${cursor}`,
              props.providerCommandLookup,
              props.resolvedTheme,
            ),
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
      inlineNodes.push(
        ...renderUserMessageInlineText(
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
      <div className="m-0 wrap-break-word whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground/90">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <div className="m-0 whitespace-pre-wrap wrap-break-word font-mono text-sm leading-relaxed text-foreground/90">
      {renderUserMessageInlineText(
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
        className="group relative max-w-[82%] px-0 py-0 sm:max-w-[72%]"
        data-user-message-bubble="true"
      >
        <div className="relative rounded-2xl rounded-br-lg border border-border/65 bg-chat-bubble px-3.5 py-2.5 ">
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

const AssistantMarkdownPendingPlaceholder = memo(function AssistantMarkdownPendingPlaceholder() {
  return (
    <div
      className="space-y-2 py-1 text-sm text-muted-foreground/58"
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
  markdownCwd: string | undefined;
  message: AssistantTimelineMessage;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenBrowserUrl?: ((url: string) => void) | null;
  onOpenFilePath?: ((path: string) => void) | null;
  enableLocalFileLinks?: boolean;
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
  const messageText =
    renderedMessageText.trim().length > 0
      ? renderedMessageText
      : props.message.streaming
        ? ""
        : assistantImages.length > 0
          ? ""
          : "(empty response)";
  const completedAt = props.message.completedAt ?? null;
  const elapsedLabel =
    props.showCompletedTiming && props.isAssistantTurnTerminal && completedAt
      ? formatCompletedWorkTimer(props.durationStart, completedAt)
      : null;
  const completedAtLabel =
    props.showCompletedTiming && props.isAssistantTurnTerminal && completedAt
      ? formatTimestamp(completedAt, props.timestampFormat)
      : null;
  const persistVisible = Boolean(props.completionSummary || props.showAssistantSummaryByDefault);

  return (
    <div className="min-w-0">
      {imageGenerationPlaceholder && (
        <ImageGenerationPlaceholderFrame
          createdAt={props.message.createdAt}
          dimensions={imageGenerationPlaceholder}
          liveTimers={props.liveTimers}
        />
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
      {completedAtLabel && elapsedLabel && (
        <div className="mt-2 flex min-h-4 flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 text-[10px] text-muted-foreground/52 transition-opacity duration-150",
              persistVisible
                ? "opacity-100"
                : "opacity-0 group-hover/timeline:opacity-100 group-focus-within/timeline:opacity-100",
            )}
            data-response-summary="true"
            data-response-summary-time={completedAtLabel}
            data-response-summary-elapsed={elapsedLabel}
          >
            <Clock3Icon className="size-3 shrink-0" />
            <span>{completedAtLabel}</span>
            <span className="text-muted-foreground/34">·</span>
            <span>{elapsedLabel}</span>
          </span>
        </div>
      )}
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

function workEntryIcon(workEntry: TimelineWorkEntry): TimelineIcon {
  if (workEntry.requestKind === "command") return IconTerminal;
  if (workEntry.requestKind === "file-read") return EyeIcon;
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
