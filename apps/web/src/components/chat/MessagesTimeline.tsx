import {
  type MessageId,
  type ProviderSlashCommand,
  type ThreadId,
  type TurnId,
} from "@ace/contracts";
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
  useLayoutEffect,
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
import {
  prefetchThreadTimelineRowsSnapshot,
  readTimelineModelRowHeight,
  useTimelineModelStore,
  writeTimelineModelRowHeight,
} from "../../lib/chat/timelineModelStore";
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
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Clock3Icon,
  EyeIcon,
  FileDiffIcon,
  GlobeIcon,
  HammerIcon,
  PinIcon,
  SplitIcon,
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
import { DiffStatLabel } from "./DiffStatLabel";
import { hasNonZeroStat } from "./diffStat";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  EMPTY_PINNED_MESSAGES,
  getPinnedMessageId,
  PINNED_MESSAGES_STORAGE_KEY,
  PinnedMessagesSchema,
  removePinnedMessage,
  upsertPinnedMessage,
  upsertPinnedSelectionMessage,
  type PinnedMessages,
} from "./pinnedMessagesStore";
import { normalizeCompactToolLabel } from "~/lib/chat/messagesTimeline";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { VscodeEntryIcon } from "./VscodeEntryIcon";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { APP_USER_BUBBLE_CLASS_NAME, APP_WORKSPACE_INSET_CLASS_NAME } from "~/lib/appChrome";
import { cn } from "~/lib/utils";
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
  isCompletedAssistantMessageRow,
  isEventInActiveTurn,
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
import type { StuckTurnSnapshot } from "~/lib/reliability/stuckTurn";
import { useTimelineRowsController } from "./useTimelineRowsController";
import { TimelineViewport } from "./TimelineViewport";

const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;
const TIMELINE_VIRTUALIZER_OVERSCAN = 16;
const MAX_TIMELINE_ROW_HEIGHT_CACHE_ENTRIES = 4_096;
const IMMEDIATE_ASSISTANT_MARKDOWN_TAIL_MESSAGES = 12;
const ASSISTANT_MARKDOWN_IDLE_BATCH_SIZE = 2;
const ASSISTANT_MARKDOWN_PENDING_LOOKBACK_ROWS = 256;
const ASSISTANT_MARKDOWN_PENDING_MESSAGE_LIMIT = 64;
const MAX_RENDERED_ASSISTANT_MARKDOWN_MESSAGE_IDS = 512;
const DEFAULT_TURN_DIFF_DIRECTORIES_EXPANDED = false;
const ASSISTANT_MARKDOWN_IDLE_TIMEOUT_MS = 600;
const ASSISTANT_MARKDOWN_FALLBACK_DELAY_MS = 80;
const TIMELINE_WIDTH_RESIZE_DEBOUNCE_MS = 96;
const TIMELINE_INITIAL_VIEWPORT_HEIGHT_PX = 720;
const TIMELINE_FALLBACK_VIRTUAL_RANGE_MIN_ROWS = TIMELINE_VIRTUALIZER_OVERSCAN * 2 + 8;
const EMPTY_PROVIDER_COMMANDS: ReadonlyArray<ProviderSlashCommand> = [];
const ASSISTANT_IMAGE_GENERATION_MESSAGE_ID_REGEX =
  /^assistant:image:(?<width>\d{2,5})x(?<height>\d{2,5}):/u;
const IMAGE_GENERATION_FRAME_MAX_WIDTH_REM = 42;
const IMAGE_GENERATION_LANDSCAPE_FRAME_MAX_HEIGHT_VH = 54;
const IMAGE_GENERATION_SQUARE_FRAME_MAX_HEIGHT_VH = 46;
const EMPTY_MESSAGE_TURN_COUNT_MAP = new Map<MessageId, number>();
const IMAGE_GENERATION_PORTRAIT_FRAME_MAX_HEIGHT_VH = 42;
const SELECTION_PIN_BUTTON_WIDTH_PX = 92;
const SELECTION_PIN_BUTTON_HEIGHT_PX = 32;
const TIMELINE_DIRECTIONAL_PREFETCH_MIN_VELOCITY_PX_PER_MS = 0.75;
const TIMELINE_BASE_PREFETCH_EDGE_ROWS = Math.max(TIMELINE_VIRTUALIZER_OVERSCAN * 2, 16);
const ASSISTANT_MESSAGE_ROW_SELECTOR = '[data-message-role="assistant"][data-message-id]';
const COMPLETED_WORK_SUMMARY_ROW_ID_PREFIX = "completed-work-summary:";
const PINNED_SELECTION_TEXT_BLOCK_SELECTOR =
  "blockquote,div,h1,h2,h3,h4,h5,h6,li,ol,p,pre,section,table,tbody,td,tfoot,th,thead,tr,ul";
const TIMELINE_ROW_ID_SELECTOR = "[data-timeline-row-id]";
const TIMELINE_ROW_RENDER_INTRINSIC_MIN_HEIGHT_PX = 40;

export function resolveTimelineScrollPrefetchLookaheadRows(velocityPxPerMs: number): number {
  const velocity = Math.max(0, Number.isFinite(velocityPxPerMs) ? velocityPxPerMs : 0);
  if (velocity < 0.75) return TIMELINE_BASE_PREFETCH_EDGE_ROWS;
  if (velocity < 1.5) return 64;
  if (velocity < 3) return 128;
  if (velocity < 6) return 256;
  if (velocity < 10) return 512;
  return 1_024;
}

type TimelineScrollPrefetchDirection = "older" | "newer" | "both";

export function deriveTimelineScrollPrefetchRequest(input: {
  readonly currentScrollTop: number;
  readonly previousScrollTop: number;
  readonly elapsedMs: number;
}): {
  readonly direction: TimelineScrollPrefetchDirection;
  readonly lookaheadRows: number;
  readonly velocityPxPerMs: number;
} {
  const deltaScrollTop = Number.isFinite(input.previousScrollTop)
    ? input.currentScrollTop - input.previousScrollTop
    : 0;
  const elapsedMs = Math.max(1, Number.isFinite(input.elapsedMs) ? input.elapsedMs : 1);
  const velocityPxPerMs = Math.abs(deltaScrollTop) / elapsedMs;
  const direction =
    velocityPxPerMs >= TIMELINE_DIRECTIONAL_PREFETCH_MIN_VELOCITY_PX_PER_MS
      ? deltaScrollTop < 0
        ? "older"
        : deltaScrollTop > 0
          ? "newer"
          : "both"
      : "both";
  return {
    direction,
    lookaheadRows: resolveTimelineScrollPrefetchLookaheadRows(velocityPxPerMs),
    velocityPxPerMs,
  };
}

export type TimelineRenderedWindowState = {
  readonly loadedEndIndexExclusive: number;
  readonly loadedRowCount: number;
  readonly loadedStartIndex: number;
  readonly overscanLoadedEndIndexExclusive: number;
  readonly overscanLoadedStartIndex: number;
};

export function deriveTimelineRenderedWindowState(input: {
  readonly totalRowCount?: number;
  readonly renderedVirtualItems: readonly VirtualItem[];
  readonly virtualizedRows: ReadonlyArray<TimelineRow>;
}): TimelineRenderedWindowState | null {
  const firstVirtualItem = input.renderedVirtualItems[0];
  const lastVirtualItem = input.renderedVirtualItems.at(-1);
  if (!firstVirtualItem || !lastVirtualItem) {
    const totalRowCount = Math.max(0, Math.trunc(input.totalRowCount ?? 0));
    if (input.virtualizedRows.length === 0 && totalRowCount > 0) {
      return {
        loadedEndIndexExclusive: totalRowCount,
        loadedRowCount: totalRowCount,
        loadedStartIndex: 0,
        overscanLoadedEndIndexExclusive: totalRowCount,
        overscanLoadedStartIndex: 0,
      };
    }
    return null;
  }

  return {
    loadedEndIndexExclusive: lastVirtualItem.index + 1,
    loadedRowCount: input.virtualizedRows.length,
    loadedStartIndex: firstVirtualItem.index,
    overscanLoadedEndIndexExclusive: lastVirtualItem.index + 1,
    overscanLoadedStartIndex: firstVirtualItem.index,
  };
}

function addTimelineRowCandidateId(ids: string[], id: string | null | undefined): void {
  if (!id) {
    return;
  }
  ids.push(id);
  if (id.startsWith(COMPLETED_WORK_SUMMARY_ROW_ID_PREFIX)) {
    ids.push(id.slice(COMPLETED_WORK_SUMMARY_ROW_ID_PREFIX.length));
  }
}

function collectTimelineRowCandidateIds(row: TimelineRow): readonly string[] {
  const ids: string[] = [];
  addTimelineRowCandidateId(ids, row.id);
  if (row.kind === "completed-work-summary") {
    for (const sourceEntryId of row.sourceEntryIds) {
      addTimelineRowCandidateId(ids, sourceEntryId);
    }
    for (const detailRow of row.detailRows) {
      addTimelineRowCandidateId(ids, detailRow.id);
      if (detailRow.kind === "work-group") {
        for (const entry of detailRow.entries) {
          addTimelineRowCandidateId(ids, entry.id);
        }
      }
    }
    for (const diagnosticRow of row.visibleDiagnosticRows) {
      addTimelineRowCandidateId(ids, diagnosticRow.id);
    }
  } else if (row.kind === "work-group") {
    for (const entry of row.entries) {
      addTimelineRowCandidateId(ids, entry.id);
    }
  }
  return ids;
}

function resolveTimelineRowGlobalIndexRange(
  row: TimelineRow,
  timelineIndexByEntryId: ReadonlyMap<string, number>,
): { readonly endIndexExclusive: number; readonly startIndex: number } | null {
  let startIndex = Number.POSITIVE_INFINITY;
  let endIndexExclusive = Number.NEGATIVE_INFINITY;
  for (const candidateId of collectTimelineRowCandidateIds(row)) {
    const index = timelineIndexByEntryId.get(candidateId);
    if (index === undefined) {
      continue;
    }
    startIndex = Math.min(startIndex, index);
    endIndexExclusive = Math.max(endIndexExclusive, index + 1);
  }
  if (!Number.isFinite(startIndex) || !Number.isFinite(endIndexExclusive)) {
    return null;
  }
  return { startIndex, endIndexExclusive };
}

function resolveTimelineRowsGlobalIndexRange(input: {
  readonly endIndexExclusive: number;
  readonly rows: ReadonlyArray<TimelineRow>;
  readonly startIndex: number;
  readonly timelineIndexByEntryId: ReadonlyMap<string, number>;
}): { readonly endIndexExclusive: number; readonly startIndex: number } | null {
  const startIndex = Math.min(input.rows.length, Math.max(0, Math.trunc(input.startIndex)));
  const endIndexExclusive = Math.min(
    input.rows.length,
    Math.max(startIndex, Math.trunc(input.endIndexExclusive)),
  );
  if (endIndexExclusive <= startIndex) {
    return null;
  }

  let firstRange: { readonly endIndexExclusive: number; readonly startIndex: number } | null = null;
  for (let rowIndex = startIndex; rowIndex < endIndexExclusive; rowIndex += 1) {
    const row = input.rows[rowIndex];
    if (!row) {
      continue;
    }
    firstRange = resolveTimelineRowGlobalIndexRange(row, input.timelineIndexByEntryId);
    if (firstRange) {
      break;
    }
  }
  if (!firstRange) {
    return null;
  }

  let lastRange = firstRange;
  for (let rowIndex = endIndexExclusive - 1; rowIndex >= startIndex; rowIndex -= 1) {
    const row = input.rows[rowIndex];
    if (!row) {
      continue;
    }
    const range = resolveTimelineRowGlobalIndexRange(row, input.timelineIndexByEntryId);
    if (range) {
      lastRange = range;
      break;
    }
  }

  const globalStartIndex = Math.min(firstRange.startIndex, lastRange.startIndex);
  const globalEndIndexExclusive = Math.max(
    firstRange.endIndexExclusive,
    lastRange.endIndexExclusive,
  );
  if (globalEndIndexExclusive <= globalStartIndex) {
    return null;
  }
  return {
    startIndex: globalStartIndex,
    endIndexExclusive: globalEndIndexExclusive,
  };
}

export function deriveGlobalTimelineRenderedWindowState(input: {
  readonly renderedWindowState: TimelineRenderedWindowState | null;
  readonly rows: ReadonlyArray<TimelineRow>;
  readonly timelineIndexByEntryId?: ReadonlyMap<string, number> | null;
}): TimelineRenderedWindowState | null {
  if (!input.renderedWindowState) {
    return null;
  }
  if (!input.timelineIndexByEntryId) {
    return input.renderedWindowState;
  }
  const loadedRange = resolveTimelineRowsGlobalIndexRange({
    rows: input.rows,
    startIndex: input.renderedWindowState.loadedStartIndex,
    endIndexExclusive: input.renderedWindowState.loadedEndIndexExclusive,
    timelineIndexByEntryId: input.timelineIndexByEntryId,
  });
  if (!loadedRange) {
    return null;
  }
  const overscanRange =
    resolveTimelineRowsGlobalIndexRange({
      rows: input.rows,
      startIndex: input.renderedWindowState.overscanLoadedStartIndex,
      endIndexExclusive: input.renderedWindowState.overscanLoadedEndIndexExclusive,
      timelineIndexByEntryId: input.timelineIndexByEntryId,
    }) ?? loadedRange;

  return {
    loadedEndIndexExclusive: loadedRange.endIndexExclusive,
    loadedRowCount: input.renderedWindowState.loadedRowCount,
    loadedStartIndex: loadedRange.startIndex,
    overscanLoadedEndIndexExclusive: overscanRange.endIndexExclusive,
    overscanLoadedStartIndex: overscanRange.startIndex,
  };
}

type AssistantSelectionPinTarget = {
  left: number;
  messageId: string;
  text: string;
  top: number;
};

type TargetMessageNavigation = {
  messageId: string;
  requestId: number;
  targetKind: "message" | "selection";
  selectedText?: string;
};

function normalizePinnedSelectionText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function elementFromNode(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentNode instanceof Element
      ? node.parentNode
      : null;
}

function assistantMessageRowFromNode(node: Node): HTMLElement | null {
  return elementFromNode(node)?.closest<HTMLElement>(ASSISTANT_MESSAGE_ROW_SELECTOR) ?? null;
}

function readCurrentAssistantSelectionPinTarget(): {
  messageId: string;
  range: Range;
  text: string;
} | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const text = normalizePinnedSelectionText(selection.toString());
  if (!text) return null;

  const range = selection.getRangeAt(0);
  const startMessageRow = assistantMessageRowFromNode(range.startContainer);
  const endMessageRow = assistantMessageRowFromNode(range.endContainer);
  if (!startMessageRow || !endMessageRow || startMessageRow !== endMessageRow) return null;

  const messageRow = startMessageRow;
  const messageId = messageRow?.dataset.messageId;
  return messageId ? { messageId, range, text } : null;
}

function resolvePinnedSelectionNeedle(selectedText: string): string {
  const normalized = normalizePinnedSelectionText(selectedText);
  if (!normalized.endsWith("…")) return normalized;
  return normalized.slice(0, -1).trimEnd();
}

function closestPinnedSelectionTextBlock(node: Text): Element | null {
  return node.parentElement?.closest(PINNED_SELECTION_TEXT_BLOCK_SELECTOR) ?? null;
}

function shouldSeparatePinnedSelectionTextNodes(previousNode: Text | null, node: Text): boolean {
  if (!previousNode) return false;
  const previousBlock = closestPinnedSelectionTextBlock(previousNode);
  const nextBlock = closestPinnedSelectionTextBlock(node);
  return Boolean(previousBlock && nextBlock && previousBlock !== nextBlock);
}

function findPinnedSelectionRange(root: HTMLElement, selectedText: string): Range | null {
  const needle = resolvePinnedSelectionNeedle(selectedText);
  if (!needle) return null;

  const searchRoot = root.querySelector<HTMLElement>("[data-assistant-message-content]") ?? root;
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parentElement = node.parentElement;
      if (
        parentElement?.closest(
          "button,textarea,input,select,script,style,[data-assistant-turn-actions]",
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let nextNode = walker.nextNode();
  while (nextNode) {
    textNodes.push(nextNode as Text);
    nextNode = walker.nextNode();
  }

  const positions: Array<{ node: Text; offset: number }> = [];
  let haystack = "";
  let previousWasWhitespace = true;
  let previousNode: Text | null = null;
  for (const node of textNodes) {
    const text = node.data;
    if (
      shouldSeparatePinnedSelectionTextNodes(previousNode, node) &&
      !previousWasWhitespace &&
      !/^\s/u.test(text)
    ) {
      haystack += " ";
      positions.push({ node, offset: 0 });
      previousWasWhitespace = true;
    }

    for (let offset = 0; offset < text.length; offset += 1) {
      const character = text[offset] ?? "";
      if (/\s/u.test(character)) {
        if (!previousWasWhitespace) {
          haystack += " ";
          positions.push({ node, offset });
          previousWasWhitespace = true;
        }
        continue;
      }
      haystack += character;
      positions.push({ node, offset });
      previousWasWhitespace = false;
    }
    previousNode = node;
  }

  const startIndex = haystack.indexOf(needle);
  if (startIndex < 0) return null;
  const endIndex = startIndex + needle.length - 1;
  const startPosition = positions[startIndex];
  const endPosition = positions[endIndex];
  if (!startPosition || !endPosition) return null;

  const range = document.createRange();
  range.setStart(startPosition.node, startPosition.offset);
  range.setEnd(endPosition.node, endPosition.offset + 1);
  return range;
}

function highlightPinnedSelectionText(
  root: HTMLElement,
  selectedText: string,
  scrollContainer: HTMLElement,
): (() => void) | null {
  const range = findPinnedSelectionRange(root, selectedText);
  if (!range) return null;

  const firstRect = range.getBoundingClientRect();
  if (firstRect.width <= 0 || firstRect.height <= 0) return null;

  const initialContainerRect = scrollContainer.getBoundingClientRect();
  scrollContainer.scrollTop = Math.max(
    0,
    scrollContainer.scrollTop +
      firstRect.top -
      initialContainerRect.top -
      scrollContainer.clientHeight / 2 +
      firstRect.height / 2,
  );

  const containerRect = scrollContainer.getBoundingClientRect();
  const rangeRects = [...range.getClientRects()].filter(
    (rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom >= containerRect.top &&
      rect.top <= containerRect.bottom,
  );
  if (rangeRects.length === 0) return null;

  const previousPosition = scrollContainer.style.position;
  const shouldRestorePosition = window.getComputedStyle(scrollContainer).position === "static";
  if (shouldRestorePosition) {
    scrollContainer.style.position = "relative";
  }

  const overlay = document.createElement("div");
  overlay.dataset.pinnedSelectionHighlight = "true";
  overlay.style.pointerEvents = "none";
  overlay.style.position = "absolute";
  overlay.style.inset = "0";
  overlay.style.zIndex = "20";
  scrollContainer.appendChild(overlay);

  for (const rect of rangeRects) {
    const highlight = document.createElement("div");
    highlight.style.position = "absolute";
    highlight.style.left = `${rect.left - containerRect.left + scrollContainer.scrollLeft - 2}px`;
    highlight.style.top = `${rect.top - containerRect.top + scrollContainer.scrollTop - 2}px`;
    highlight.style.width = `${rect.width + 4}px`;
    highlight.style.height = `${rect.height + 4}px`;
    highlight.style.borderRadius = "0.25rem";
    highlight.style.background = "hsl(var(--primary) / 0.22)";
    highlight.style.boxShadow = "0 0 0 1px hsl(var(--primary) / 0.36)";
    overlay.appendChild(highlight);
  }

  return () => {
    overlay.remove();
    if (shouldRestorePosition) {
      scrollContainer.style.position = previousPosition;
    }
  };
}

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

function TimelineRowsFetchingPill() {
  return (
    <div className="inline-flex items-center gap-2 rounded-full bg-background/80 px-3 py-1.5 text-[11px] text-muted-foreground shadow-lg shadow-background/30 backdrop-blur">
      <span className="size-3 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
      Loading thread...
    </div>
  );
}

export function TimelineRowsLoadingFallback() {
  return (
    <div
      className="mx-auto flex h-full w-full max-w-3xl items-center justify-center px-4 py-8"
      aria-label="Loading thread"
    >
      <TimelineRowsFetchingPill />
    </div>
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
    return readTimelineModelRowHeight(cacheKey);
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
  writeTimelineModelRowHeight(cacheKey, height);
  return height;
}

function measureTimelineRowElementHeight(
  element: Element,
  entry?: ResizeObserverEntry | undefined,
): number {
  const borderBoxSize = Array.isArray(entry?.borderBoxSize)
    ? entry.borderBoxSize[0]
    : entry?.borderBoxSize;
  return Math.ceil(borderBoxSize?.blockSize ?? element.getBoundingClientRect().height);
}

function toTimelineWidthCacheKey(timelineWidthPx: number | null): string {
  if (timelineWidthPx === null || !Number.isFinite(timelineWidthPx)) {
    return "auto";
  }
  return String(Math.max(0, Math.round(timelineWidthPx / 4) * 4));
}

interface MessagesTimelineProps {
  activeThreadId?: string;
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
  timelineCacheScope?: string | null;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  timelineRowsLoading?: boolean;
  timelineRowsOverride?: ReadonlyArray<TimelineRow> | null;
  timelineIndexByEntryId?: ReadonlyMap<string, number> | null;
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
  isPinned?: boolean;
  onTogglePinnedMessage?: (() => void) | null;
  isForkConversationDisabled?: boolean;
  enableGoalWorkingState?: boolean;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  targetMessageNavigation?: TargetMessageNavigation | null;
}

export const MessagesTimeline = memo(function MessagesTimeline({
  activeThreadId,
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
  timelineCacheScope = null,
  timelineEntries,
  timelineRowsLoading: externalTimelineRowsLoading = false,
  timelineRowsOverride = null,
  timelineIndexByEntryId = null,
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
  providerCommands = EMPTY_PROVIDER_COMMANDS,
  onForkConversation = null,
  isForkConversationDisabled = false,
  enableGoalWorkingState = false,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  targetMessageNavigation = null,
}: MessagesTimelineProps) {
  const userMessageProviderCommandLookup = useMemo(
    () => buildUserMessageProviderCommandLookup(providerCommands),
    [providerCommands],
  );
  const supportsForkConversation = Boolean(onForkConversation);
  const [pinnedMessages, setPinnedMessages] = useLocalStorage<PinnedMessages, PinnedMessages>(
    PINNED_MESSAGES_STORAGE_KEY,
    EMPTY_PINNED_MESSAGES,
    PinnedMessagesSchema,
  );
  const pinnedMessageIdSet = useMemo(
    () => new Set(pinnedMessages.map((message) => message.id)),
    [pinnedMessages],
  );
  const [selectionPinTarget, setSelectionPinTarget] = useState<AssistantSelectionPinTarget | null>(
    null,
  );
  const updateSelectionPinTarget = useCallback(() => {
    if (!activeThreadId) {
      setSelectionPinTarget(null);
      return;
    }
    const currentSelectionPinTarget = readCurrentAssistantSelectionPinTarget();
    if (!currentSelectionPinTarget) {
      setSelectionPinTarget(null);
      return;
    }

    const selectionRects = [...currentSelectionPinTarget.range.getClientRects()].filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
    const anchorRect =
      selectionRects.at(-1) ?? currentSelectionPinTarget.range.getBoundingClientRect();
    if (anchorRect.width <= 0 || anchorRect.height <= 0) {
      setSelectionPinTarget(null);
      return;
    }

    const preferredTop = anchorRect.top - SELECTION_PIN_BUTTON_HEIGHT_PX - 8;
    const top =
      preferredTop >= 8
        ? preferredTop
        : Math.min(window.innerHeight - SELECTION_PIN_BUTTON_HEIGHT_PX - 8, anchorRect.bottom + 8);
    setSelectionPinTarget({
      left: Math.min(
        window.innerWidth - SELECTION_PIN_BUTTON_WIDTH_PX - 8,
        Math.max(8, anchorRect.right - SELECTION_PIN_BUTTON_WIDTH_PX),
      ),
      messageId: currentSelectionPinTarget.messageId,
      text: currentSelectionPinTarget.text,
      top,
    });
  }, [activeThreadId]);
  const pinSelectedAssistantText = useCallback(() => {
    if (!activeThreadId || !selectionPinTarget) return;
    setPinnedMessages((current) =>
      upsertPinnedSelectionMessage(current, {
        threadId: activeThreadId,
        messageId: selectionPinTarget.messageId,
        text: selectionPinTarget.text,
      }),
    );
    window.getSelection()?.removeAllRanges();
    setSelectionPinTarget(null);
  }, [activeThreadId, selectionPinTarget, setPinnedMessages]);
  useEffect(() => {
    const updateAfterSelectionSettles = () => {
      window.requestAnimationFrame(updateSelectionPinTarget);
    };
    document.addEventListener("selectionchange", updateAfterSelectionSettles);
    document.addEventListener("mouseup", updateAfterSelectionSettles);
    document.addEventListener("keyup", updateAfterSelectionSettles);
    return () => {
      document.removeEventListener("selectionchange", updateAfterSelectionSettles);
      document.removeEventListener("mouseup", updateAfterSelectionSettles);
      document.removeEventListener("keyup", updateAfterSelectionSettles);
    };
  }, [updateSelectionPinTarget]);
  const timelineRowsInput = useMemo<BuildTimelineRowsInput>(
    () => ({
      timelineEntries,
      activeTurnInProgress,
      activeTurnStartedAt,
      ...(timelineCacheScope ? { cacheScopeKey: timelineCacheScope } : {}),
      completionDividerBeforeEntryId,
      completionSummary,
      hideCompletedWorkMessages,
      isWorking,
      enableGoalWorkingState,
    }),
    [
      activeTurnInProgress,
      timelineEntries,
      timelineCacheScope,
      completionDividerBeforeEntryId,
      completionSummary,
      hideCompletedWorkMessages,
      isWorking,
      activeTurnStartedAt,
      enableGoalWorkingState,
    ],
  );
  const isTimelineSnapshotLoading = useTimelineModelStore((state) => {
    if (!activeThreadId) {
      return false;
    }
    return (state.fetchStateByThreadId[activeThreadId]?.inFlightCount ?? 0) > 0;
  });
  const { loading: timelineRowsLoading, rows } = useTimelineRowsController({
    activeThreadId: activeThreadId ?? null,
    loading: isTimelineSnapshotLoading || externalTimelineRowsLoading,
    preResolvedRows: timelineRowsOverride,
    timelineRowsInput,
  });
  const latestForkableAssistantMessageId = useMemo(() => {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row?.kind !== "message") {
        continue;
      }
      if (isUserTimelineMessage(row.message)) {
        return null;
      }
      if (!isAssistantTimelineMessage(row.message)) continue;
      const renderedText = getChatMessageRenderableText(row.message);
      if (renderedText.trim().length > 0) {
        return String(row.message.id);
      }
    }
    return null;
  }, [rows]);
  const assistantFooterByPlacementRowId = useMemo(() => {
    const footerByRowId = new Map<string, AssistantTurnFooterModel>();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (
        row?.kind !== "message" ||
        !isAssistantTimelineMessage(row.message) ||
        !(row.isAssistantTurnTerminal ?? false)
      ) {
        continue;
      }

      const timing = resolveAssistantTurnTiming({
        completedAt: row.message.completedAt ?? null,
        durationStart: row.durationStart,
        isAssistantTurnTerminal: row.isAssistantTurnTerminal ?? false,
        showCompletedTiming: row.showAssistantTiming ?? false,
        timestampFormat,
      });
      const shouldShowAssistantTurnActions =
        timing !== null &&
        !row.message.streaming &&
        row.message.completedAt !== undefined &&
        row.message.completedAt !== null;
      const assistantTurnPinTarget = shouldShowAssistantTurnActions
        ? collectVisibleAssistantTurnPinTarget(rows, index)
        : null;
      const copyText = assistantTurnPinTarget?.text ?? null;
      const onForkConversationForRow =
        shouldShowAssistantTurnActions &&
        supportsForkConversation &&
        String(row.message.id) === latestForkableAssistantMessageId
          ? onForkConversation
          : null;
      const pinMessageId =
        shouldShowAssistantTurnActions && assistantTurnPinTarget && activeThreadId
          ? assistantTurnPinTarget.messageId
          : null;
      const pinnedMessageId =
        pinMessageId && activeThreadId
          ? getPinnedMessageId({ threadId: activeThreadId, messageId: pinMessageId })
          : null;
      const isPinned = pinnedMessageId ? pinnedMessageIdSet.has(pinnedMessageId) : false;
      const onTogglePinnedMessage =
        pinMessageId && activeThreadId && assistantTurnPinTarget
          ? () => {
              const selectedPinTarget =
                readCurrentAssistantSelectionPinTarget() ?? selectionPinTarget;
              if (selectedPinTarget) {
                setPinnedMessages((current) =>
                  upsertPinnedSelectionMessage(current, {
                    threadId: activeThreadId,
                    messageId: selectedPinTarget.messageId,
                    text: selectedPinTarget.text,
                  }),
                );
                window.getSelection()?.removeAllRanges();
                setSelectionPinTarget(null);
                return;
              }

              setPinnedMessages((current) =>
                isPinned
                  ? removePinnedMessage(current, {
                      threadId: activeThreadId,
                      messageId: pinMessageId,
                    })
                  : upsertPinnedMessage(current, {
                      threadId: activeThreadId,
                      messageId: pinMessageId,
                      text: assistantTurnPinTarget.text,
                    }),
              );
            }
          : null;
      if (!copyText && !timing && !onForkConversationForRow && !onTogglePinnedMessage) {
        continue;
      }

      footerByRowId.set(row.id, {
        copyText,
        isPinned,
        isForkConversationDisabled,
        onForkConversation: onForkConversationForRow,
        onTogglePinnedMessage,
        timing,
      });
    }
    return footerByRowId;
  }, [
    isForkConversationDisabled,
    activeThreadId,
    latestForkableAssistantMessageId,
    onForkConversation,
    pinnedMessageIdSet,
    rows,
    selectionPinTarget,
    setPinnedMessages,
    supportsForkConversation,
    timestampFormat,
  ]);
  const trailingCompletedWorkSummaryByAssistantRowId = useMemo(() => {
    const summaryByAssistantRowId = new Map<
      string,
      Extract<TimelineRow, { kind: "completed-work-summary" }>
    >();
    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index];
      if (row?.kind !== "completed-work-summary") {
        continue;
      }
      const previousRow = rows[index - 1];
      if (
        previousRow?.kind !== "message" ||
        !isAssistantTimelineMessage(previousRow.message) ||
        !(previousRow.isAssistantTurnTerminal ?? false)
      ) {
        continue;
      }
      summaryByAssistantRowId.set(previousRow.id, row);
    }
    return summaryByAssistantRowId;
  }, [rows]);
  const hoistedCompletedWorkSummaryRowIds = useMemo(
    () =>
      new Set(
        [...trailingCompletedWorkSummaryByAssistantRowId.values()].map((summaryRow) => {
          return summaryRow.id;
        }),
      ),
    [trailingCompletedWorkSummaryByAssistantRowId],
  );

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
  const estimateVirtualizedRowSize = useCallback(
    (index: number) =>
      estimateTimelineRowHeight(virtualizedRows[index], {
        timelineWidthPx,
        expandedWorkGroups,
      }),
    [expandedWorkGroups, timelineWidthPx, virtualizedRows],
  );
  const measureVirtualizedRowElement = useCallback(
    (element: Element, entry?: ResizeObserverEntry | undefined) => {
      const htmlElement = element as HTMLElement;
      const index = Number(htmlElement.dataset.index);
      const height = measureTimelineRowElementHeight(element, entry);
      const row = Number.isInteger(index) ? virtualizedRows[index] : undefined;
      if (row && Number.isFinite(height) && height > 0) {
        writeCachedTimelineRowHeight(
          getTimelineRowHeightCacheKey(row, {
            timelineWidthPx,
            expandedWorkGroups,
          }),
          height,
        );
      }
      return height;
    },
    [expandedWorkGroups, timelineWidthPx, virtualizedRows],
  );
  const rowVirtualizer = useVirtualizer({
    count: virtualizedRows.length,
    estimateSize: estimateVirtualizedRowSize,
    getItemKey: getVirtualRowKey,
    getScrollElement: getScrollContainer,
    initialRect: { width: 0, height: TIMELINE_INITIAL_VIEWPORT_HEIGHT_PX },
    measureElement: measureVirtualizedRowElement,
    overscan: TIMELINE_VIRTUALIZER_OVERSCAN,
    useAnimationFrameWithResizeObserver: true,
  });
  const isTimelineScrolling = rowVirtualizer.isScrolling;
  const timelineScrollSampleRef = useRef({
    scrollTop: Number.NaN,
    sampledAt: 0,
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
  const renderedWindowState = useMemo(
    () =>
      deriveTimelineRenderedWindowState({
        renderedVirtualItems,
        totalRowCount: rows.length,
        virtualizedRows,
      }),
    [renderedVirtualItems, rows.length, virtualizedRows],
  );
  const renderedWindowIndexRows =
    shouldUseVirtualizedBuffer || renderedVirtualItems.length > 0 ? virtualizedRows : rows;
  const globalRenderedWindowState = useMemo(
    () =>
      deriveGlobalTimelineRenderedWindowState({
        renderedWindowState,
        rows: renderedWindowIndexRows,
        timelineIndexByEntryId,
      }),
    [renderedWindowIndexRows, renderedWindowState, timelineIndexByEntryId],
  );
  const shouldRenderVirtualizedBuffer = shouldRenderTimelineVirtualizedBuffer({
    virtualizedRowCount: virtualizedRows.length,
  });
  useEffect(() => {
    if (!activeThreadId || !globalRenderedWindowState) {
      return;
    }
    if (
      globalRenderedWindowState.loadedEndIndexExclusive <=
      globalRenderedWindowState.loadedStartIndex
    ) {
      return;
    }
    useTimelineModelStore.getState().setActiveWindow(activeThreadId as ThreadId, {
      startRowIndex: globalRenderedWindowState.loadedStartIndex,
      endRowIndexExclusive: globalRenderedWindowState.loadedEndIndexExclusive,
      overscanStartRowIndex: globalRenderedWindowState.overscanLoadedStartIndex,
      overscanEndRowIndexExclusive: globalRenderedWindowState.overscanLoadedEndIndexExclusive,
      revision: timelineCacheScope,
    });
  }, [activeThreadId, globalRenderedWindowState, timelineCacheScope]);
  useEffect(() => {
    if (!activeThreadId || !renderedWindowState || rows.length === 0) {
      return;
    }
    const scrollContainer = getScrollContainer();
    const now = Date.now();
    const currentScrollTop = scrollContainer?.scrollTop ?? 0;
    const previousSample = timelineScrollSampleRef.current;
    const prefetchRequest = deriveTimelineScrollPrefetchRequest({
      currentScrollTop,
      previousScrollTop: previousSample.scrollTop,
      elapsedMs: now - previousSample.sampledAt,
    });
    timelineScrollSampleRef.current = {
      scrollTop: currentScrollTop,
      sampledAt: now,
    };
    const edgeThreshold = Math.max(TIMELINE_BASE_PREFETCH_EDGE_ROWS, prefetchRequest.lookaheadRows);
    const isNearOlderEdge = renderedWindowState.loadedStartIndex <= edgeThreshold;
    const isNearNewerEdge =
      renderedWindowState.loadedRowCount - renderedWindowState.loadedEndIndexExclusive <=
      edgeThreshold;
    const isNearRenderedEdge = isNearOlderEdge || isNearNewerEdge;
    if (!isNearRenderedEdge) {
      return;
    }
    void prefetchThreadTimelineRowsSnapshot({
      threadId: activeThreadId as ThreadId,
    }).catch(() => undefined);
  }, [activeThreadId, getScrollContainer, renderedWindowState, rows.length]);
  useEffect(() => {
    if (!targetMessageNavigation) return;
    const targetMessageId = targetMessageNavigation.messageId;
    const rowIndex = rows.findIndex(
      (row) => row.kind === "message" && String(row.message.id) === targetMessageId,
    );
    if (rowIndex < 0) return;

    const scrollContainer = getScrollContainer();
    if (!scrollContainer) return;

    const escapedMessageId =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(targetMessageId)
        : targetMessageId.replace(/["\\]/gu, "\\$&");
    const selector = `[data-message-id="${escapedMessageId}"]`;
    let clearHighlightTimeoutId: number | null = null;
    let cleanupTextHighlight: (() => void) | null = null;
    const highlightMountedRow = () => {
      const row = scrollContainer.querySelector<HTMLElement>(selector);
      if (!row) return;
      const isSelectionTarget = targetMessageNavigation.targetKind === "selection";
      const selectedText = targetMessageNavigation.selectedText;
      const cleanupSelectedTextHighlight =
        isSelectionTarget && selectedText
          ? highlightPinnedSelectionText(row, selectedText, scrollContainer)
          : null;
      if (isSelectionTarget) {
        if (!cleanupSelectedTextHighlight) {
          row.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }

        cleanupTextHighlight = cleanupSelectedTextHighlight;
        clearHighlightTimeoutId = window.setTimeout(() => {
          cleanupTextHighlight?.();
          cleanupTextHighlight = null;
        }, 2200);
        return;
      }

      row.scrollIntoView({ behavior: "smooth", block: "center" });
      row.dataset.pinnedMessageTarget = "true";
      clearHighlightTimeoutId = window.setTimeout(() => {
        if (row.dataset.pinnedMessageTarget === "true") {
          delete row.dataset.pinnedMessageTarget;
        }
      }, 1200);
    };

    if (rowIndex < virtualizedRows.length && shouldRenderVirtualizedBuffer) {
      let secondFrameId: number | null = null;
      rowVirtualizer.scrollToIndex(rowIndex, { align: "center" });
      const firstFrameId = window.requestAnimationFrame(() => {
        secondFrameId = window.requestAnimationFrame(highlightMountedRow);
      });
      return () => {
        window.cancelAnimationFrame(firstFrameId);
        if (secondFrameId !== null) {
          window.cancelAnimationFrame(secondFrameId);
        }
        if (clearHighlightTimeoutId !== null) {
          window.clearTimeout(clearHighlightTimeoutId);
        }
        cleanupTextHighlight?.();
      };
    }

    highlightMountedRow();
    return () => {
      if (clearHighlightTimeoutId !== null) {
        window.clearTimeout(clearHighlightTimeoutId);
      }
      cleanupTextHighlight?.();
    };
  }, [
    getScrollContainer,
    rowVirtualizer,
    rows,
    shouldRenderVirtualizedBuffer,
    targetMessageNavigation,
    virtualizedRows.length,
  ]);
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
  const pendingAssistantMarkdownMessageIds = useMemo(
    () =>
      shouldPrewarmAssistantMarkdown
        ? derivePendingAssistantMarkdownMessageIdsBottomUp(rows, {
            firstUnvirtualizedRowIndex,
            immediateMessageIds: immediateAssistantMarkdownMessageIdSet,
            maxMessageIds: ASSISTANT_MARKDOWN_PENDING_MESSAGE_LIMIT,
            maxRows: ASSISTANT_MARKDOWN_PENDING_LOOKBACK_ROWS,
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
  const assistantMarkdownPrewarmRows = useMemo(
    () =>
      shouldPrewarmAssistantMarkdown
        ? collectAssistantMarkdownPrewarmRows(rows, {
            firstUnvirtualizedRowIndex,
            renderedVirtualItems,
            virtualizedRows,
          })
        : [],
    [
      firstUnvirtualizedRowIndex,
      renderedVirtualItems,
      rows,
      shouldPrewarmAssistantMarkdown,
      virtualizedRows,
    ],
  );
  const assistantMarkdownAnalysisPrewarmJobs = useMemo(() => {
    if (!shouldPrewarmAssistantMarkdown) {
      return [];
    }
    return buildAssistantMarkdownAnalysisPrewarmJobs({
      rows: assistantMarkdownPrewarmRows,
      immediateMessageIds: immediateAssistantMarkdownMessageIds,
      pendingMessageIds: pendingAssistantMarkdownMessageIds,
    });
  }, [
    assistantMarkdownPrewarmRows,
    immediateAssistantMarkdownMessageIds,
    pendingAssistantMarkdownMessageIds,
    shouldPrewarmAssistantMarkdown,
  ]);
  const immediateAssistantMarkdownMessageIdKey = immediateAssistantMarkdownMessageIds.join("\0");
  const pendingAssistantMarkdownMessageIdKey = pendingAssistantMarkdownMessageIds.join("\0");
  const assistantMarkdownAnalysisPrewarmJobKey = assistantMarkdownAnalysisPrewarmJobs
    .map((job) => job.cacheKey)
    .join("\0");
  const assistantMarkdownPriorityRef = useRef({
    immediateMessageIds: immediateAssistantMarkdownMessageIds,
    mountedMessageIds: mountedVirtualizedAssistantMarkdownMessageIds,
    pendingMessageIds: pendingAssistantMarkdownMessageIds,
  });
  assistantMarkdownPriorityRef.current = {
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
    if (isTimelineScrolling) {
      return;
    }
    const { immediateMessageIds, mountedMessageIds, pendingMessageIds } =
      assistantMarkdownPriorityRef.current;
    const priorityMessageIds = [...immediateMessageIds, ...mountedMessageIds, ...pendingMessageIds];
    setRenderedAssistantMarkdownMessageIds((current) => {
      const next = new Set<string>();
      for (const messageId of priorityMessageIds) {
        if (!next.has(messageId)) {
          next.add(messageId);
        }
      }
      for (const messageId of current) {
        if (!next.has(messageId)) {
          next.add(messageId);
        }
        if (next.size >= MAX_RENDERED_ASSISTANT_MARKDOWN_MESSAGE_IDS) {
          break;
        }
      }
      return areStringSetsEqual(next, current) ? current : next;
    });
  }, [
    immediateAssistantMarkdownMessageIdKey,
    isTimelineScrolling,
    mountedVirtualizedAssistantMarkdownMessageIdKey,
    pendingAssistantMarkdownMessageIdKey,
    shouldPrioritizeAssistantMarkdown,
  ]);

  useEffect(() => {
    if (
      isTimelineScrolling ||
      !shouldPrewarmAssistantMarkdown ||
      pendingAssistantMarkdownMessageIdKey.length === 0
    ) {
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
  }, [isTimelineScrolling, pendingAssistantMarkdownMessageIdKey, shouldPrewarmAssistantMarkdown]);
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
  const buildRowContent = (row: TimelineRow, _rowIndex: number) => {
    const detachedAssistantFooter = assistantFooterByPlacementRowId.get(row.id) ?? null;
    if (row.kind === "completed-work-summary" && hoistedCompletedWorkSummaryRowIds.has(row.id)) {
      return null;
    }
    return (
      <div
        className="group/timeline relative pb-3 transition-colors data-[pinned-message-target=true]:rounded-xl data-[pinned-message-target=true]:bg-accent/20 data-[pinned-message-target=true]:ring-1 data-[pinned-message-target=true]:ring-primary/35"
        data-timeline-row-kind={row.kind}
        data-message-id={row.kind === "message" ? row.message.id : undefined}
        data-message-role={row.kind === "message" ? row.message.role : undefined}
      >
        {row.kind === "completed-work-summary" && (
          <CompletedWorkSummaryTimelineRow
            row={row}
            expandedWorkGroups={expandedWorkGroups}
            onToggleWorkGroup={onToggleWorkGroup}
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
            const shouldRenderAssistantMarkdown =
              !shouldPrioritizeAssistantMarkdown ||
              row.message.streaming ||
              immediateAssistantMarkdownMessageIdSet.has(assistantMessageId) ||
              (!isTimelineScrolling &&
                mountedVirtualizedAssistantMarkdownMessageIdSet.has(assistantMessageId)) ||
              renderedAssistantMarkdownMessageIds.has(assistantMessageId);

            return (
              <div className="min-w-0">
                {(() => {
                  const trailingCompletedWorkSummary =
                    trailingCompletedWorkSummaryByAssistantRowId.get(row.id) ?? null;
                  return trailingCompletedWorkSummary ? (
                    <div className="mb-2">
                      <CompletedWorkSummaryTimelineRow
                        row={trailingCompletedWorkSummary}
                        expandedWorkGroups={expandedWorkGroups}
                        onToggleWorkGroup={onToggleWorkGroup}
                      />
                    </div>
                  ) : null;
                })()}
                <AssistantMessageTimelineRow
                  durationStart={row.durationStart}
                  isAssistantTurnTerminal={row.isAssistantTurnTerminal ?? false}
                  liveTimers={liveTimers}
                  showCompletedTiming={row.showAssistantTiming ?? false}
                  suppressFooter
                  markdownCwd={markdownCwd}
                  message={row.message}
                  onImageExpand={onImageExpand}
                  onOpenBrowserUrl={onOpenBrowserUrl}
                  onOpenFilePath={onOpenFilePath}
                  enableLocalFileLinks={enableLocalFileLinks}
                  onForkConversation={null}
                  isForkConversationDisabled={isForkConversationDisabled}
                  renderMarkdown={shouldRenderAssistantMarkdown}
                  showCopyAction={false}
                  timestampFormat={timestampFormat}
                />
                {detachedAssistantFooter && (
                  <AssistantTurnFooter
                    copyText={detachedAssistantFooter.copyText}
                    isPinned={detachedAssistantFooter.isPinned}
                    onForkConversation={detachedAssistantFooter.onForkConversation}
                    isForkConversationDisabled={detachedAssistantFooter.isForkConversationDisabled}
                    onTogglePinnedMessage={detachedAssistantFooter.onTogglePinnedMessage}
                    timing={detachedAssistantFooter.timing}
                  />
                )}
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
        {detachedAssistantFooter && row.kind !== "message" && (
          <AssistantTurnFooter
            copyText={detachedAssistantFooter.copyText}
            isPinned={detachedAssistantFooter.isPinned}
            onForkConversation={detachedAssistantFooter.onForkConversation}
            isForkConversationDisabled={detachedAssistantFooter.isForkConversationDisabled}
            onTogglePinnedMessage={detachedAssistantFooter.onTogglePinnedMessage}
            timing={detachedAssistantFooter.timing}
          />
        )}
      </div>
    );
  };
  const buildRowRenderCacheStyle = useCallback(
    (row: TimelineRow, style: CSSProperties = {}): CSSProperties => {
      const intrinsicHeight = Math.max(
        TIMELINE_ROW_RENDER_INTRINSIC_MIN_HEIGHT_PX,
        Math.ceil(
          estimateTimelineRowHeight(row, {
            timelineWidthPx,
            expandedWorkGroups,
          }),
        ),
      );
      return {
        ...style,
        "--timeline-row-estimated-height": `${intrinsicHeight}px`,
      } as CSSProperties;
    },
    [expandedWorkGroups, timelineWidthPx],
  );

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

  if (timelineRowsLoading && rows.length === 0) {
    return <TimelineRowsLoadingFallback />;
  }

  return (
    <div
      ref={setTimelineRootElement}
      data-timeline-root="true"
      className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden"
      style={{ overflowAnchor: "none" }}
      onKeyUp={updateSelectionPinTarget}
      onMouseUp={updateSelectionPinTarget}
    >
      {selectionPinTarget ? (
        <button
          type="button"
          className="glass-surface glass-surface--compact fixed z-[120] inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium text-popover-foreground transition-colors hover:bg-accent/80 hover:text-accent-foreground"
          style={{ left: selectionPinTarget.left, top: selectionPinTarget.top }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={pinSelectedAssistantText}
          aria-label="Pin selected assistant text"
        >
          <PinIcon className="size-3" />
          Pin
        </button>
      ) : null}
      <TimelineViewport
        buildRowContent={buildRowContent}
        buildRowRenderCacheStyle={buildRowRenderCacheStyle}
        measureVirtualizedRowElement={rowVirtualizer.measureElement}
        renderedVirtualItems={renderedVirtualItems}
        shouldRenderVirtualizedBuffer={shouldRenderVirtualizedBuffer}
        trailingRows={trailingRows}
        virtualizedBufferHeight={virtualizedBufferHeight}
        virtualizedRows={virtualizedRows}
      />
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
    maxMessageIds?: number;
    maxRows?: number;
    mountedMessageIds: ReadonlySet<string>;
    renderedMessageIds: ReadonlySet<string>;
  },
): string[] {
  const messageIds: string[] = [];
  const maxRows = Math.max(0, Math.trunc(input.maxRows ?? Number.POSITIVE_INFINITY));
  const maxMessageIds = Math.max(0, Math.trunc(input.maxMessageIds ?? Number.POSITIVE_INFINITY));
  const minIndexExclusive =
    Number.isFinite(maxRows) && maxRows > 0
      ? Math.max(0, input.firstUnvirtualizedRowIndex - maxRows)
      : 0;
  for (let index = input.firstUnvirtualizedRowIndex - 1; index >= minIndexExclusive; index -= 1) {
    if (messageIds.length >= maxMessageIds) {
      break;
    }
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

function collectAssistantMarkdownPrewarmRows(
  rows: ReadonlyArray<TimelineRow>,
  input: {
    readonly firstUnvirtualizedRowIndex: number;
    readonly renderedVirtualItems: readonly VirtualItem[];
    readonly virtualizedRows: ReadonlyArray<TimelineRow>;
  },
): TimelineRow[] {
  const rowById = new Map<string, TimelineRow>();
  for (const virtualItem of input.renderedVirtualItems) {
    const row = input.virtualizedRows[virtualItem.index];
    if (row) {
      rowById.set(row.id, row);
    }
  }

  const pendingLookbackStartIndex = Math.max(
    0,
    input.firstUnvirtualizedRowIndex - ASSISTANT_MARKDOWN_PENDING_LOOKBACK_ROWS,
  );
  for (let index = pendingLookbackStartIndex; index < rows.length; index += 1) {
    const row = rows[index];
    if (row) {
      rowById.set(row.id, row);
    }
  }
  return [...rowById.values()];
}

function areStringSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
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
      <span className="working-activity-indicator-dot" />
      <span className="working-activity-indicator-dot" />
      <span className="working-activity-indicator-dot" />
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
      className={cn(
        APP_WORKSPACE_INSET_CLASS_NAME,
        "image-generation-placeholder-frame relative mb-2.5 max-w-3xl overflow-hidden rounded-xl",
      )}
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

  return height;
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
  thinkingDurationMs: number | null,
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

  if (isThinkingOnly) {
    const steps = summarizeCount(thinkingCount, "reasoning step");
    const thinkingDurationLabel =
      thinkingDurationMs === null ? null : formatToolDuration(thinkingDurationMs);
    return [
      {
        key: "thinking",
        text: thinkingDurationLabel
          ? `${summarizeMultiplier(thinkingCount, "Thinking")} · ${thinkingDurationLabel}`
          : summarizeMultiplier(thinkingCount, "Thinking"),
        title: thinkingDurationLabel ? `${steps}, ${thinkingDurationLabel} reported` : steps,
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
    const thinkingDurationLabel =
      thinkingDurationMs === null ? null : formatToolDuration(thinkingDurationMs);
    parts.push({
      key: "thinking",
      text: thinkingDurationLabel
        ? `${summarizeMultiplier(thinkingCount, "Thinking")} · ${thinkingDurationLabel}`
        : summarizeMultiplier(thinkingCount, "Thinking"),
      title: thinkingDurationLabel ? `${steps}, ${thinkingDurationLabel} reported` : steps,
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

function summarizeReportedThinkingDurationMs(
  entries: ReadonlyArray<TimelineMetaGroupEntry>,
): number | null {
  let totalDurationMs = 0;
  let hasReportedDuration = false;
  for (const entry of entries) {
    if (entry.kind !== "work" || entry.workEntry.tone !== "thinking") {
      continue;
    }
    const durationMs = entry.workEntry.durationMs;
    if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
      continue;
    }
    totalDurationMs += durationMs;
    hasReportedDuration = true;
  }
  return hasReportedDuration ? totalDurationMs : null;
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
              : "border border-border/50 bg-muted/40 text-foreground/85",
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
  const hasGroupDetails = props.row.entries.length > 0;
  const isExpanded = props.expandedWorkGroups[groupId] ?? false;
  const ChevronIcon = isExpanded ? ChevronDownIcon : ChevronRightIcon;
  const { summary } = props.row;
  const elapsedLabel = summarizeWorkGroupElapsedLabel(props.row.createdAt, props.row.summaryEndAt);
  const thinkingDurationMs = summarizeReportedThinkingDurationMs(props.row.entries);
  const breakdownParts = summarizeWorkGroupBreakdownParts(summary, thinkingDurationMs);
  const GroupIcon = workGroupIcon(summary.iconKey);

  return (
    <div className="min-w-0 py-0.5" data-thread-group={summary.threadGroupTone}>
      <button
        type="button"
        className={cn(
          "group/disclosure flex max-w-full items-center gap-3 rounded-md bg-transparent px-0 py-1 text-left outline-none focus-visible:outline-none focus-visible:ring-0",
          !hasGroupDetails && "cursor-default",
        )}
        onClick={() => {
          if (hasGroupDetails) {
            props.onToggleWorkGroup(groupId);
          }
        }}
        aria-expanded={hasGroupDetails ? isExpanded : undefined}
        data-meta-disclosure="true"
        data-meta-disclosure-open={hasGroupDetails ? String(isExpanded) : undefined}
        data-thinking-disclosure={summary.hasThinkingEntries ? "true" : undefined}
        data-thinking-disclosure-open={
          summary.hasThinkingEntries && hasGroupDetails ? String(isExpanded) : undefined
        }
        data-tool-disclosure={summary.hasToolEntries ? "true" : undefined}
        data-tool-disclosure-open={
          summary.hasToolEntries && hasGroupDetails ? String(isExpanded) : undefined
        }
      >
        <GroupIcon
          className={cn("mt-0.5 size-3.5 shrink-0", metaToneTextClass(summary.surfaceTone))}
        />
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[13px] leading-5 text-muted-foreground/70">
          {breakdownParts.map((part, index) => (
            <Fragment key={`${props.row.id}:summary:${part.key}`}>
              {index > 0 && <span className="shrink-0 text-muted-foreground/45">·</span>}
              {hasGroupDetails ? (
                <InlineTooltip
                  content={part.title}
                  className={cn(
                    "min-w-0 truncate transition-colors duration-100 group-hover/disclosure:text-foreground/92 group-focus-visible/disclosure:text-foreground/92",
                    isExpanded ? "text-foreground/92" : "text-muted-foreground/70",
                  )}
                >
                  {part.text}
                </InlineTooltip>
              ) : (
                <span className="min-w-0 truncate text-muted-foreground/70">{part.text}</span>
              )}
            </Fragment>
          ))}
          {hasGroupDetails && (
            <ChevronIcon
              className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors duration-100 group-hover/disclosure:text-foreground/90 group-focus-visible/disclosure:text-foreground/90"
              strokeWidth={2.2}
            />
          )}
          {elapsedLabel && (
            <span
              className="sr-only"
              data-meta-disclosure-elapsed={elapsedLabel}
            >{`Elapsed ${elapsedLabel}`}</span>
          )}
        </div>
      </button>
      {isExpanded && hasGroupDetails && (
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
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
}) {
  if (props.row.kind === "assistant-update") {
    return <AssistantUpdateTimelineRow row={props.row} />;
  }

  return (
    <WorkLogTimelineRow
      row={props.row}
      expandedWorkGroups={props.expandedWorkGroups}
      onToggleWorkGroup={props.onToggleWorkGroup}
    />
  );
});

const AssistantUpdateTimelineRow = memo(function AssistantUpdateTimelineRow(props: {
  row: Extract<TimelineCompletedWorkDetailRow, { kind: "assistant-update" }>;
}) {
  return (
    <div
      className="min-w-0 py-0.5"
      data-completed-work-assistant-update="true"
      data-assistant-update-id={props.row.id}
    >
      <p className="wrap-break-word max-w-[min(100%,72rem)] whitespace-pre-wrap text-[13px] leading-[1.55] text-foreground/80">
        {props.row.text}
        {props.row.truncated ? (
          <span className="block text-[12px] leading-5 text-muted-foreground/55">
            ... update truncated
          </span>
        ) : null}
      </p>
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
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
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
      <span
        className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] leading-5 text-muted-foreground/76 transition-colors group-hover/completed-work:text-foreground/86"
        data-completed-work-summary-label="worked-for"
      >
        <span>Worked for {elapsedLabel}</span>
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
              expandedWorkGroups={props.expandedWorkGroups}
              onToggleWorkGroup={props.onToggleWorkGroup}
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
        <div className={cn(APP_USER_BUBBLE_CLASS_NAME, "relative")}>
          {userImages.length > 0 && (
            <div className="mb-2.5 grid max-w-105 grid-cols-2 gap-1.5">
              {userImages.map((image: NonNullable<TimelineMessage["attachments"]>[number]) => (
                <div
                  key={image.id}
                  className={cn(APP_WORKSPACE_INSET_CLASS_NAME, "overflow-hidden rounded-xl")}
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
                      className="glass-inset border-border/50"
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

export const AssistantMarkdownDeferredPreview = memo(
  function AssistantMarkdownDeferredPreview(props: { readonly text: string }) {
    return (
      <div
        className="chat-markdown-deferred-preview w-full min-w-0 wrap-break-word whitespace-pre-wrap text-[13px] leading-[1.55] text-foreground/80"
        data-assistant-markdown-deferred-preview="true"
      >
        {props.text}
      </div>
    );
  },
);

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
      className={cn(
        APP_WORKSPACE_INSET_CLASS_NAME,
        "inline-flex max-w-full justify-self-start overflow-hidden rounded-xl",
      )}
      style={frameDimensions ? imageGenerationFrameStyle(frameDimensions) : undefined}
    >
      {props.image.previewUrl ? (
        <button
          type="button"
          className={cn(
            "inline-flex max-w-full cursor-zoom-in items-start justify-start glass-inset",
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
  durationStart: string;
  isAssistantTurnTerminal?: boolean;
  liveTimers: boolean;
  showCompletedTiming?: boolean;
  suppressFooter?: boolean;
  markdownCwd: string | undefined;
  message: AssistantTimelineMessage;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenBrowserUrl?: ((url: string) => void) | null;
  onOpenFilePath?: ((path: string) => void) | null;
  enableLocalFileLinks?: boolean;
  onForkConversation?: (() => void) | null;
  isPinned?: boolean;
  onTogglePinnedMessage?: (() => void) | null;
  isForkConversationDisabled?: boolean;
  renderMarkdown: boolean;
  showCopyAction: boolean;
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
  const copyText =
    props.showCopyAction && renderedMessageText.trim().length > 0 ? renderedMessageText : null;
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
      {messageText.length === 0 ? null : (
        <div className="min-w-0" data-assistant-message-content="true">
          {props.renderMarkdown ? (
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
            <AssistantMarkdownDeferredPreview text={messageText} />
          )}
        </div>
      )}
      {!props.suppressFooter && (
        <AssistantTurnFooter
          copyText={copyText}
          isPinned={props.isPinned ?? false}
          onForkConversation={props.onForkConversation ?? null}
          isForkConversationDisabled={props.isForkConversationDisabled ?? false}
          onTogglePinnedMessage={props.onTogglePinnedMessage ?? null}
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

type AssistantTurnFooterModel = {
  copyText: string | null;
  isPinned: boolean;
  onForkConversation: (() => void) | null;
  onTogglePinnedMessage: (() => void) | null;
  isForkConversationDisabled: boolean;
  timing: { completedAtLabel: string; elapsedLabel: string } | null;
};

function collectVisibleAssistantTurnPinTarget(
  rows: ReadonlyArray<TimelineRow>,
  terminalRowIndex: number,
): { messageId: string; text: string } | null {
  const terminalRow = rows[terminalRowIndex];
  if (
    terminalRow?.kind !== "message" ||
    !isAssistantTimelineMessage(terminalRow.message) ||
    !(terminalRow.isAssistantTurnTerminal ?? false)
  ) {
    return null;
  }

  const turnId = terminalRow.message.turnId ?? null;
  const visibleAssistantTexts: string[] = [];
  let firstAssistantMessageId: string | null = null;
  for (let index = 0; index <= terminalRowIndex; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message" || !isAssistantTimelineMessage(row.message)) {
      continue;
    }
    if (turnId !== null && row.message.turnId !== turnId) {
      continue;
    }
    if (turnId === null && row.id !== terminalRow.id) {
      continue;
    }

    const renderedText = getChatMessageRenderableText(row.message).trim();
    if (renderedText.length > 0) {
      firstAssistantMessageId ??= String(row.message.id);
      visibleAssistantTexts.push(renderedText);
    }
  }

  return visibleAssistantTexts.length > 0 && firstAssistantMessageId
    ? {
        messageId: firstAssistantMessageId,
        text: visibleAssistantTexts.join("\n\n"),
      }
    : null;
}

const AssistantTurnFooter = memo(function AssistantTurnFooter(props: {
  copyText: string | null;
  isPinned?: boolean;
  onForkConversation?: (() => void) | null;
  onTogglePinnedMessage?: (() => void) | null;
  isForkConversationDisabled?: boolean;
  timing: { completedAtLabel: string; elapsedLabel: string } | null;
}) {
  const hasActions = Boolean(
    props.copyText || props.onTogglePinnedMessage || props.onForkConversation,
  );
  if (!props.timing && !hasActions) {
    return null;
  }

  const hoverOnlyClass =
    "opacity-0 transition-opacity duration-150 group-hover/timeline:opacity-100 group-focus-within/timeline:opacity-100";

  return (
    <div
      className="mt-2 flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1"
      data-assistant-turn-footer="true"
    >
      {props.copyText && (
        <div className="flex items-center" data-assistant-turn-copy-action="true">
          <MessageCopyButton
            text={props.copyText}
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground/68 hover:bg-foreground/[0.05] hover:text-foreground"
          />
        </div>
      )}
      {props.timing && (
        <span
          className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground/52"
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
      {(props.onTogglePinnedMessage || props.onForkConversation) && (
        <div
          className={cn(
            "flex items-center gap-1",
            hoverOnlyClass,
            !props.timing && !props.copyText && "ml-auto",
          )}
          data-assistant-turn-actions="true"
        >
          {props.onTogglePinnedMessage ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className={cn(
                      "text-muted-foreground/68 transition-all duration-200 hover:bg-foreground/[0.05] hover:text-foreground",
                      props.isPinned && "text-foreground",
                    )}
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onClick={props.onTogglePinnedMessage}
                    aria-label={
                      props.isPinned ? "Unpin assistant message" : "Pin assistant message"
                    }
                  />
                }
              >
                <PinIcon className={cn("size-3", props.isPinned && "fill-current")} />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {props.isPinned ? "Unpin message" : "Pin message"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {props.onForkConversation ? (
            <AssistantForkButton
              disabled={props.isForkConversationDisabled ?? false}
              onClick={props.onForkConversation}
            />
          ) : null}
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
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground/68 transition-all duration-200 hover:bg-muted/45 hover:text-foreground"
            disabled={props.disabled}
            onClick={props.onClick}
            aria-label="Fork conversation"
          />
        }
      >
        <SplitIcon className="size-3 rotate-90" />
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
      className="glass-inset min-w-0 overflow-hidden rounded-[var(--panel-radius)] border border-border/36 bg-background/28"
      data-turn-diff-summary="true"
    >
      <div className="flex min-w-0 items-center gap-2 border-border/24 border-b bg-muted/[0.08] px-3 py-2">
        <span className="min-w-0 truncate font-mono text-[10px] leading-4 font-medium tracking-[0.16em] text-muted-foreground/76 uppercase">
          Changed files ({checkpointFiles.length})
        </span>
        {hasNonZeroStat(summaryStat) && (
          <>
            <span aria-hidden="true" className="text-[11px] text-muted-foreground/34">
              •
            </span>
            <span className="shrink-0 font-mono text-[12px] leading-4 tabular-nums">
              <DiffStatLabel additions={summaryStat.additions} deletions={summaryStat.deletions} />
            </span>
          </>
        )}
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="h-6 rounded-[var(--control-radius)] px-2 text-[11px] font-normal text-muted-foreground/64 hover:bg-foreground/[0.05] hover:text-foreground"
          onClick={() => props.onOpenTurnDiff(props.turnSummary.turnId, checkpointFiles[0]?.path)}
        >
          <FileDiffIcon aria-hidden="true" className="mr-1 size-3.5" />
          View diff
        </Button>
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
                      className="size-6 rounded-[var(--control-radius)] border-0 bg-transparent text-muted-foreground/66 shadow-none hover:bg-foreground/[0.055] hover:text-foreground"
                      disabled={props.isRevertingCheckpoint || props.isWorking}
                      onClick={props.onRevert}
                      aria-label={props.revertActionTitle}
                    />
                  }
                >
                  <Undo2Icon aria-hidden="true" className="size-3" />
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
                      className="size-6 rounded-[var(--control-radius)] border-0 bg-transparent text-muted-foreground/66 shadow-none hover:bg-foreground/[0.055] hover:text-foreground"
                      onClick={() => props.onToggleAllDirectories(props.turnSummary.turnId)}
                      aria-label={props.allDirectoriesExpanded ? "Collapse all" : "Expand all"}
                    />
                  }
                >
                  {props.allDirectoriesExpanded ? (
                    <ChevronsDownUpIcon aria-hidden="true" className="size-3" />
                  ) : (
                    <ChevronsUpDownIcon aria-hidden="true" className="size-3" />
                  )}
                </TooltipTrigger>
                <TooltipPopup side="top" align="end">
                  {props.allDirectoriesExpanded ? "Collapse all" : "Expand all"}
                </TooltipPopup>
              </Tooltip>
            )}
          </div>
        )}
      </div>
      <div className="px-2 py-2">
        <ChangedFilesTree
          key={`changed-files-tree:${props.turnSummary.turnId}`}
          turnId={props.turnSummary.turnId}
          files={checkpointFiles}
          allDirectoriesExpanded={props.allDirectoriesExpanded}
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
    <div className="max-w-3xl">
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

export const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
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
          className={cn("mt-1 shrink-0", "size-3.5", iconConfig.className, metaToneTextClass(tone))}
        />
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="mb-0.5 flex min-w-0 items-center gap-2">
            <button
              type="button"
              className={cn(
                "group/work-detail flex min-w-0 max-w-full items-center gap-1.5 rounded-sm bg-transparent p-0 text-left leading-5 text-muted-foreground/70 outline-none transition-colors duration-100 hover:text-foreground/90 focus-visible:text-foreground/90 focus-visible:outline-none focus-visible:ring-0",
                isNested ? "text-[12px]" : "text-[12.5px]",
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
              className={cn(APP_WORKSPACE_INSET_CLASS_NAME, "mt-1.5 max-w-full px-3 py-2")}
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
        <IconTerminal className="mt-1 size-3.5 shrink-0 text-muted-foreground/62" />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className={cn(
              "group/command flex max-w-full items-center gap-1.5 rounded-sm bg-transparent p-0 text-left leading-5 text-muted-foreground/70 outline-none transition-colors duration-100 hover:text-foreground/90 focus-visible:text-foreground/90 focus-visible:outline-none focus-visible:ring-0",
              isNested ? "text-[12px]" : "text-[12.5px]",
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
                cn(APP_WORKSPACE_INSET_CLASS_NAME, "mt-2 max-w-full px-3 py-2.5"),
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
