import type { SelectedLineRange } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ThreadId, TurnId } from "@ace/contracts";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  Columns2Icon,
  ExternalLinkIcon,
  Rows3Icon,
  TextWrapIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from "react";
import { openInPreferredEditor } from "../editorPreferences";
import {
  gitBranchesQueryOptions,
  gitStatusQueryOptions,
  gitWorkingTreeDiffQueryOptions,
} from "~/lib/gitReactQuery";
import {
  checkpointDiffQueryOptions,
  isCheckpointTemporarilyUnavailable,
} from "~/lib/providerReactQuery";
import { cn } from "~/lib/utils";
import { readNativeApi } from "../nativeApi";
import { resolvePathLinkTarget } from "../terminal-links";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { useTheme } from "../hooks/useTheme";
import { resolveDiffThemeName } from "../lib/diffRendering";
import {
  buildFileDiffRenderKey,
  formatFileChangeType,
  getRenderablePatch,
  resolveFileDiffPath,
  summarizeFileDiff,
} from "../lib/diffPatch";
import { useWorkspaceCommentPlaceholder } from "../lib/editor/workspaceCommentPlaceholders";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useStore } from "../store";
import { useSetting } from "../hooks/useSettings";
import { formatShortTimestamp } from "../timestampFormat";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { buildDiffPanelUnsafeCss } from "./diffPanelUnsafeCss";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "./ui/select";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type DiffRenderMode = "stacked" | "split";
type DiffThemeType = "light" | "dark";
const ALL_TURNS_SELECT_VALUE = "__all_turns__";
const REVIEW_COMMENT_POPOVER_HEIGHT_PX = 48;
const REVIEW_COMMENT_POPOVER_WIDTH_PX = 390;
const REVIEW_COMMENT_POPOVER_GAP_PX = 8;
const REVIEW_COMMENT_POPOVER_FALLBACK_LEFT_PX = 56;
const REVIEW_COMMENT_POPOVER_FALLBACK_TOP_PX = 44;

type DiffReviewLineSide = "additions" | "deletions";

export interface DiffReviewLineRange {
  readonly endLine: number;
  readonly endSide: DiffReviewLineSide;
  readonly label: string;
  readonly startLine: number;
  readonly startSide: DiffReviewLineSide;
}

export interface DiffReviewCommentInput {
  readonly additions: number;
  readonly body: string;
  readonly changeType: string;
  readonly cwd: string;
  readonly deletions: number;
  readonly filePath: string;
  readonly hunkCount: number;
  readonly lineRange: DiffReviewLineRange;
  readonly previousFilePath: string | null;
  readonly scopeLabel: string;
}

interface ActiveReviewLineSelection {
  readonly fileKey: string;
  readonly filePath: string;
  readonly label: string;
  readonly lineRange: DiffReviewLineRange;
  readonly range: SelectedLineRange;
}

interface ReviewCommentPopoverPosition {
  readonly fileKey: string;
  readonly left: number;
  readonly placement: "anchored" | "fallback" | "pending";
  readonly top: number;
}

function normalizeDiffReviewLineSide(side: SelectedLineRange["side"]): DiffReviewLineSide {
  return side === "deletions" ? "deletions" : "additions";
}

function formatDiffReviewLineSide(side: DiffReviewLineSide): string {
  return side === "deletions" ? "old" : "new";
}

function formatDiffReviewLineRange(range: SelectedLineRange): DiffReviewLineRange {
  const startSide = normalizeDiffReviewLineSide(range.side);
  const endSide = normalizeDiffReviewLineSide(range.endSide ?? range.side);
  const sameSide = startSide === endSide;
  const sameLine = range.start === range.end;
  const orderedStartLine = sameSide ? Math.min(range.start, range.end) : range.start;
  const orderedEndLine = sameSide ? Math.max(range.start, range.end) : range.end;
  const startLabel = `${formatDiffReviewLineSide(startSide)} L${orderedStartLine}`;
  const endLabel = `${formatDiffReviewLineSide(endSide)} L${orderedEndLine}`;
  const label = sameSide
    ? sameLine
      ? startLabel
      : `${formatDiffReviewLineSide(startSide)} L${orderedStartLine}-L${orderedEndLine}`
    : `${startLabel} to ${endLabel}`;
  return {
    endLine: orderedEndLine,
    endSide,
    label,
    startLine: orderedStartLine,
    startSide,
  };
}

function areSelectedLineRangesEqual(
  left: SelectedLineRange | null | undefined,
  right: SelectedLineRange | null | undefined,
): boolean {
  return (
    (left?.start ?? null) === (right?.start ?? null) &&
    (left?.end ?? null) === (right?.end ?? null) &&
    (left?.side ?? null) === (right?.side ?? null) &&
    (left?.endSide ?? null) === (right?.endSide ?? null)
  );
}

function queryDiffElements(root: ParentNode, selector: string): HTMLElement[] {
  const matches = Array.from(root.querySelectorAll<HTMLElement>(selector));
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (element.shadowRoot) {
      matches.push(...queryDiffElements(element.shadowRoot, selector));
    }
  }
  return matches;
}

function readDiffLineNumber(
  node: HTMLElement,
  key: "line" | "altLine" | "columnNumber",
): number | null {
  const raw = node.dataset[key];
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function getDiffElementSide(node: HTMLElement): DiffReviewLineSide | null {
  if (node.closest("[data-deletions]")) {
    return "deletions";
  }
  if (node.closest("[data-additions]")) {
    return "additions";
  }
  const lineType = node.dataset.lineType ?? "";
  if (lineType.includes("deletion")) {
    return "deletions";
  }
  if (lineType.includes("addition") || lineType === "context") {
    return "additions";
  }
  return null;
}

function getDiffLineNumbers(node: HTMLElement): number[] {
  return [
    readDiffLineNumber(node, "line"),
    readDiffLineNumber(node, "altLine"),
    readDiffLineNumber(node, "columnNumber"),
  ].filter((lineNumber): lineNumber is number => lineNumber !== null);
}

function isDiffLineElementForSelection(
  node: HTMLElement,
  selection: ActiveReviewLineSelection,
): boolean {
  if (!getDiffLineNumbers(node).includes(selection.range.start)) {
    return false;
  }
  const elementSide = getDiffElementSide(node);
  return elementSide === null || elementSide === normalizeDiffReviewLineSide(selection.range.side);
}

function getDiffLineAnchorScore(node: HTMLElement): number {
  if (node.hasAttribute("data-line")) {
    return 4;
  }
  if (node.hasAttribute("data-column-number")) {
    return 3;
  }
  if (node.hasAttribute("data-line-annotation")) {
    return 2;
  }
  return 1;
}

function chooseVisibleDiffLineElement(nodes: ReadonlyArray<HTMLElement>): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestScore = 0;
  let bestWidth = 0;
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }
    const score = getDiffLineAnchorScore(node);
    if (score > bestScore || (score === bestScore && rect.width > bestWidth)) {
      best = node;
      bestScore = score;
      bestWidth = rect.width;
    }
  }
  return best;
}

function findReviewCommentAnchorLineElement(
  fileElement: HTMLElement,
  selection: ActiveReviewLineSelection,
): HTMLElement | null {
  const selectedLineElements = queryDiffElements(fileElement, "[data-selected-line]");
  const selectedStartLineElements = selectedLineElements.filter((node) =>
    isDiffLineElementForSelection(node, selection),
  );
  const selectedStartLineElement = chooseVisibleDiffLineElement(selectedStartLineElements);
  if (selectedStartLineElement) {
    return selectedStartLineElement;
  }

  const selectedLineElement = chooseVisibleDiffLineElement(selectedLineElements);
  if (selectedLineElement) {
    return selectedLineElement;
  }

  const matchingLineElements = queryDiffElements(
    fileElement,
    "[data-line], [data-alt-line], [data-column-number]",
  ).filter((node) => isDiffLineElementForSelection(node, selection));
  return chooseVisibleDiffLineElement(matchingLineElements);
}

function findDiffFileElement(
  viewport: HTMLElement,
  selection: ActiveReviewLineSelection,
): HTMLElement | null {
  return (
    Array.from(viewport.querySelectorAll<HTMLElement>("[data-diff-file-path]")).find(
      (element) => element.dataset.diffFilePath === selection.filePath,
    ) ?? null
  );
}

function resolveReviewCommentPopoverPosition(
  fileElement: HTMLElement,
  anchorElement: HTMLElement,
  fileKey: string,
): ReviewCommentPopoverPosition {
  const fileRect = fileElement.getBoundingClientRect();
  const anchorRect = anchorElement.getBoundingClientRect();
  const fileWidth = Math.max(fileElement.clientWidth, fileRect.width);
  const fileHeight = Math.max(fileElement.offsetHeight, fileRect.height);
  const lineTop = anchorRect.top - fileRect.top;
  const lineBottom = anchorRect.bottom - fileRect.top;
  const minTop = 40;
  const topAbove = lineTop - REVIEW_COMMENT_POPOVER_HEIGHT_PX - REVIEW_COMMENT_POPOVER_GAP_PX;
  const topBelow = lineBottom + REVIEW_COMMENT_POPOVER_GAP_PX;
  const unclampedTop = topAbove >= minTop ? topAbove : topBelow;
  const maxTop = Math.max(minTop, fileHeight - REVIEW_COMMENT_POPOVER_HEIGHT_PX - 8);
  const leftFromLine = anchorRect.left - fileRect.left + 8;
  const maxLeft = Math.max(8, fileWidth - REVIEW_COMMENT_POPOVER_WIDTH_PX - 12);

  return {
    fileKey,
    left: Math.min(Math.max(8, leftFromLine), maxLeft),
    placement: "anchored",
    top: Math.min(Math.max(minTop, unclampedTop), maxTop),
  };
}

function createFallbackReviewCommentPopoverPosition(
  fileKey: string,
  placement: ReviewCommentPopoverPosition["placement"] = "fallback",
): ReviewCommentPopoverPosition {
  return {
    fileKey,
    left: REVIEW_COMMENT_POPOVER_FALLBACK_LEFT_PX,
    placement,
    top: REVIEW_COMMENT_POPOVER_FALLBACK_TOP_PX,
  };
}

function resolveTurnCheckpointLabel(
  summary: {
    turnId: TurnId;
    checkpointTurnCount?: number | undefined;
  },
  inferredCheckpointTurnCountByTurnId: Partial<Record<TurnId, number>>,
): string {
  const checkpointTurnCount =
    summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
  return typeof checkpointTurnCount === "number" ? `Turn ${checkpointTurnCount}` : "Turn ?";
}

function isCheckpointSummaryQueryable(
  summary: { status?: string | undefined },
  checkpointTurnCount: number | undefined,
): boolean {
  if (summary.status === "missing" || summary.status === "error") {
    return false;
  }
  return typeof checkpointTurnCount === "number" && checkpointTurnCount > 0;
}

interface DiffPanelProps {
  diffOpen?: boolean;
  onAddReviewComment?: (comment: DiffReviewCommentInput) => void;
  onSelectTurn?: (turnId: TurnId) => void;
  onSelectWholeConversation?: () => void;
  mode?: DiffPanelMode;
  selectedFilePath?: string | null;
  selectedTurnId?: TurnId | null;
  threadId?: ThreadId | null;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

function useDiffPanelComponent({
  diffOpen: diffOpenOverride,
  mode = "inline",
  onAddReviewComment,
  onSelectTurn,
  onSelectWholeConversation,
  selectedFilePath: selectedFilePathOverride,
  selectedTurnId: selectedTurnIdOverride,
  threadId,
}: DiffPanelProps) {
  const diffPanelUnsafeCss = buildDiffPanelUnsafeCss(mode);
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const diffWordWrapSetting = useSetting("diffWordWrap");
  const timestampFormat = useSetting("timestampFormat");
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [diffWordWrap, setDiffWordWrap] = useState(diffWordWrapSetting);
  const [collapsedFileKeys, setCollapsedFileKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [activeCommentFileKey, setActiveCommentFileKey] = useState<string | null>(null);
  const [activeReviewLineSelection, setActiveReviewLineSelection] =
    useState<ActiveReviewLineSelection | null>(null);
  const commentPlaceholder = useWorkspaceCommentPlaceholder(
    "diff",
    activeReviewLineSelection
      ? `${activeReviewLineSelection.fileKey}:${activeReviewLineSelection.lineRange.startSide}:${activeReviewLineSelection.lineRange.startLine}:${activeReviewLineSelection.lineRange.endSide}:${activeReviewLineSelection.lineRange.endLine}`
      : null,
  );
  const [reviewCommentPopoverPosition, setReviewCommentPopoverPosition] =
    useState<ReviewCommentPopoverPosition | null>(null);
  const [reviewCommentDraft, setReviewCommentDraft] = useState("");
  const reviewCommentInputRef = useRef<HTMLInputElement>(null);
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const diffOpen = diffOpenOverride ?? diffSearch.diff === "1";
  const activeThreadId = threadId ?? routeThreadId;
  const activeThread = useStore((store) =>
    activeThreadId ? store.threads.find((thread) => thread.id === activeThreadId) : undefined,
  );
  const liveTurnDiffMode = activeThread?.session?.capabilities?.liveTurnDiffMode;
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeProjectId ? store.projects.find((project) => project.id === activeProjectId) : undefined,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.cwd;
  const {
    data: gitBranchesData,
    error: gitBranchesError,
    fetchStatus: gitBranchesFetchStatus,
    isPending: isGitBranchesPending,
  } = useQuery(gitBranchesQueryOptions(activeCwd ?? null));
  const { data: gitStatusData } = useQuery(
    gitStatusQueryOptions(
      activeThread?.latestTurn?.state === "running" ? (activeCwd ?? null) : null,
    ),
  );
  const gitRepoStatus = gitBranchesData?.isRepo;
  const gitRepoCheckError =
    gitBranchesError instanceof Error
      ? gitBranchesError.message
      : gitBranchesError
        ? "Failed to inspect git repository status."
        : null;
  const isCheckingGitRepo =
    activeCwd !== null &&
    (isGitBranchesPending ||
      (gitBranchesFetchStatus === "fetching" && typeof gitRepoStatus !== "boolean"));
  const isGitRepo = gitRepoStatus === true;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const orderedTurnDiffSummaries = [...turnDiffSummaries].toSorted((left, right) => {
    const leftTurnCount =
      left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
    const rightTurnCount =
      right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
    if (leftTurnCount !== rightTurnCount) {
      return rightTurnCount - leftTurnCount;
    }
    return right.completedAt.localeCompare(left.completedAt);
  });
  const queryableTurnDiffSummaries = orderedTurnDiffSummaries.filter((summary) =>
    isCheckpointSummaryQueryable(
      summary,
      summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
    ),
  );

  const selectedTurnId =
    selectedTurnIdOverride !== undefined ? selectedTurnIdOverride : (diffSearch.diffTurnId ?? null);
  const selectedFilePath =
    selectedTurnId !== null
      ? selectedFilePathOverride !== undefined
        ? selectedFilePathOverride
        : (diffSearch.diffFilePath ?? null)
      : null;
  const selectedTurn =
    selectedTurnId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        queryableTurnDiffSummaries[0] ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
  const selectedTurnQueryable = selectedTurn
    ? isCheckpointSummaryQueryable(selectedTurn, selectedCheckpointTurnCount)
    : false;
  const selectedTurnLiveDiff =
    diffOpen &&
    selectedTurn?.turnId === activeThread?.latestTurn?.turnId &&
    activeThread?.latestTurn?.state === "running" &&
    selectedTurn?.status === "missing"
      ? selectedTurn.diff
      : undefined;
  const selectedTurnWorkspaceFallback =
    diffOpen &&
    selectedTurn?.turnId === activeThread?.latestTurn?.turnId &&
    activeThread?.latestTurn?.state === "running" &&
    selectedTurn?.status === "missing" &&
    !selectedTurnLiveDiff &&
    (liveTurnDiffMode === undefined || liveTurnDiffMode === "workspace") &&
    gitStatusData?.hasWorkingTreeChanges === true;
  const selectedTurnUnavailableReason =
    !selectedTurn || selectedTurnQueryable || selectedTurnLiveDiff || selectedTurnWorkspaceFallback
      ? null
      : selectedTurn.status === "missing"
        ? "Diff is still being prepared for this turn."
        : selectedTurn.status === "error"
          ? "Diff generation failed for this turn."
          : "Diff is unavailable for this turn.";
  const selectedCheckpointRange =
    selectedTurn && selectedTurnQueryable && typeof selectedCheckpointTurnCount === "number"
      ? {
          fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
          toTurnCount: selectedCheckpointTurnCount,
        }
      : null;
  const conversationCheckpointTurnCounts: number[] = [];
  for (const summary of queryableTurnDiffSummaries) {
    const turnCount =
      summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
    if (typeof turnCount === "number") {
      conversationCheckpointTurnCounts.push(turnCount);
    }
  }
  const latestConversationCheckpointTurnCount =
    conversationCheckpointTurnCounts.length > 0
      ? Math.max(...conversationCheckpointTurnCounts)
      : undefined;
  const conversationCheckpointTurnCount =
    latestConversationCheckpointTurnCount && latestConversationCheckpointTurnCount > 0
      ? latestConversationCheckpointTurnCount
      : undefined;
  const conversationCheckpointRange =
    !selectedTurn && typeof conversationCheckpointTurnCount === "number"
      ? {
          fromTurnCount: 0,
          toTurnCount: conversationCheckpointTurnCount,
        }
      : null;
  const activeCheckpointRange = selectedTurn
    ? selectedCheckpointRange
    : conversationCheckpointRange;
  const conversationCacheScope =
    selectedTurn || queryableTurnDiffSummaries.length === 0
      ? null
      : `conversation:${queryableTurnDiffSummaries.map((summary) => summary.turnId).join(",")}`;
  const canQueryCheckpointDiff =
    diffOpen &&
    !isCheckingGitRepo &&
    isGitRepo &&
    activeThreadId !== null &&
    activeCheckpointRange !== null &&
    !selectedTurnLiveDiff &&
    !selectedTurnWorkspaceFallback;
  const {
    data: activeCheckpointDiffData,
    error: activeCheckpointDiffError,
    fetchStatus: activeCheckpointDiffFetchStatus,
    isPending: isActiveCheckpointDiffPending,
  } = useQuery(
    checkpointDiffQueryOptions({
      threadId: activeThreadId,
      fromTurnCount: activeCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: activeCheckpointRange?.toTurnCount ?? null,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : conversationCacheScope,
      enabled: canQueryCheckpointDiff,
    }),
  );
  const selectedTurnCheckpointDiff = selectedTurn ? activeCheckpointDiffData?.diff : undefined;
  const {
    data: workingTreeDiffData,
    error: workingTreeDiffError,
    fetchStatus: workingTreeDiffFetchStatus,
    isPending: isWorkingTreeDiffPending,
  } = useQuery(
    gitWorkingTreeDiffQueryOptions({
      cwd: activeCwd ?? null,
      enabled: diffOpen && selectedTurnWorkspaceFallback,
    }),
  );
  const conversationCheckpointDiff = selectedTurn ? undefined : activeCheckpointDiffData?.diff;
  const isLoadingCheckpointDiff =
    (canQueryCheckpointDiff &&
      (isActiveCheckpointDiffPending || activeCheckpointDiffFetchStatus === "fetching")) ||
    (selectedTurnWorkspaceFallback &&
      (isWorkingTreeDiffPending || workingTreeDiffFetchStatus === "fetching"));
  const checkpointDiffError = selectedTurnWorkspaceFallback
    ? workingTreeDiffError instanceof Error
      ? workingTreeDiffError.message
      : workingTreeDiffError
        ? "Failed to load workspace diff."
        : null
    : activeCheckpointDiffError instanceof Error
      ? activeCheckpointDiffError.message
      : activeCheckpointDiffError
        ? "Failed to load checkpoint diff."
        : null;
  const checkpointDiffIsTemporarilyUnavailable =
    !selectedTurnLiveDiff &&
    !selectedTurnWorkspaceFallback &&
    activeCheckpointDiffError !== null &&
    isCheckpointTemporarilyUnavailable(activeCheckpointDiffError);

  const selectedPatch = diffOpen
    ? selectedTurn
      ? (selectedTurnLiveDiff ?? workingTreeDiffData?.diff ?? selectedTurnCheckpointDiff)
      : conversationCheckpointDiff
    : undefined;
  const deferredSelectedPatch = useDeferredValue(selectedPatch);
  const isPatchResolutionDeferred =
    typeof selectedPatch === "string" && selectedPatch !== deferredSelectedPatch;
  const hasResolvedPatch = typeof deferredSelectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && deferredSelectedPatch.trim().length === 0;
  const noPatchMessage =
    selectedTurnUnavailableReason ??
    (checkpointDiffIsTemporarilyUnavailable
      ? "Diff checkpoints are still being prepared for this selection."
      : null) ??
    (!selectedTurn && queryableTurnDiffSummaries.length === 0
      ? "Diff checkpoints are still being prepared for this conversation."
      : hasNoNetChanges
        ? selectedTurnLiveDiff || selectedTurnWorkspaceFallback
          ? "No net changes in the current turn."
          : "No net changes in this selection."
        : "No patch available for this selection.");
  const renderablePatch = getRenderablePatch(deferredSelectedPatch, "diff-panel");
  const renderableFiles =
    renderablePatch?.kind === "files"
      ? renderablePatch.files.toSorted((left, right) =>
          resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
            numeric: true,
            sensitivity: "base",
          }),
        )
      : [];
  const renderableFileKeys = renderableFiles.map((fileDiff) => buildFileDiffRenderKey(fileDiff));
  const renderableFileKeySet = new Set(renderableFileKeys);
  const visibleCollapsedFileKeys = new Set(
    Array.from(collapsedFileKeys).filter((fileKey) => renderableFileKeySet.has(fileKey)),
  );
  const visibleCollapsedFileKeysSignature = Array.from(visibleCollapsedFileKeys).join("\u0000");
  const expandedFileCount = renderableFiles.length - visibleCollapsedFileKeys.size;
  const allFilesCollapsed = renderableFiles.length > 0 && expandedFileCount === 0;

  useEffect(() => {
    if (!selectedFilePath || !patchViewportRef.current) {
      return;
    }
    const target = Array.from(
      patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
    ).find((element) => element.dataset.diffFilePath === selectedFilePath);
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedFilePath, renderableFiles]);

  const openDiffFileInEditor = (filePath: string) => {
    const api = readNativeApi();
    if (!api) return;
    const targetPath = activeCwd ? resolvePathLinkTarget(filePath, activeCwd) : filePath;
    void openInPreferredEditor(api, targetPath).catch((error) => {
      console.warn("Failed to open diff file in editor.", error);
    });
  };

  const toggleFileCollapsed = (fileKey: string) => {
    setCollapsedFileKeys((current) => {
      const next = new Set(current);
      if (next.has(fileKey)) {
        next.delete(fileKey);
      } else {
        next.add(fileKey);
      }
      return next;
    });
  };

  const setAllFilesCollapsed = (collapsed: boolean) => {
    setCollapsedFileKeys(collapsed ? new Set(renderableFileKeys) : new Set());
  };

  const openReviewLineSelection = (
    fileKey: string,
    filePath: string,
    range: SelectedLineRange | null,
  ) => {
    if (!range) {
      setActiveReviewLineSelection((current) => (current?.fileKey === fileKey ? null : current));
      setActiveCommentFileKey((current) => (current === fileKey ? null : current));
      if (activeReviewLineSelection?.fileKey === fileKey) {
        setReviewCommentPopoverPosition(null);
        setReviewCommentDraft("");
      }
      return;
    }
    const lineRange = formatDiffReviewLineRange(range);
    const sameSelection =
      activeReviewLineSelection?.fileKey === fileKey &&
      activeReviewLineSelection.filePath === filePath &&
      areSelectedLineRangesEqual(activeReviewLineSelection.range, range);
    if (!sameSelection) {
      setReviewCommentPopoverPosition(
        createFallbackReviewCommentPopoverPosition(fileKey, "pending"),
      );
      setReviewCommentDraft("");
    }
    setActiveReviewLineSelection((current) => {
      if (
        current?.fileKey === fileKey &&
        current.filePath === filePath &&
        areSelectedLineRangesEqual(current.range, range)
      ) {
        return current;
      }
      return {
        fileKey,
        filePath,
        label: lineRange.label,
        lineRange,
        range,
      };
    });
    setActiveCommentFileKey(fileKey);
    setCollapsedFileKeys((current) => {
      if (!current.has(fileKey)) {
        return current;
      }
      const next = new Set(current);
      next.delete(fileKey);
      return next;
    });
  };
  const activeReviewFileDiff = activeReviewLineSelection
    ? (renderableFiles.find(
        (fileDiff) => buildFileDiffRenderKey(fileDiff) === activeReviewLineSelection.fileKey,
      ) ?? null)
    : null;
  const reviewCommentPopoverOpen =
    activeCommentFileKey !== null &&
    activeReviewLineSelection !== null &&
    activeReviewFileDiff !== null;
  const visibleReviewCommentPopoverPosition = reviewCommentPopoverOpen
    ? reviewCommentPopoverPosition
    : null;
  const closeReviewCommentPopover = () => {
    setActiveCommentFileKey(null);
    setActiveReviewLineSelection(null);
    setReviewCommentPopoverPosition(null);
    setReviewCommentDraft("");
  };

  useLayoutEffect(() => {
    if (!reviewCommentPopoverOpen || !activeReviewLineSelection) {
      return;
    }

    let animationFrameId: number | null = null;
    let retryCount = 0;
    const pendingPosition = createFallbackReviewCommentPopoverPosition(
      activeReviewLineSelection.fileKey,
      "pending",
    );
    const fallbackPosition = createFallbackReviewCommentPopoverPosition(
      activeReviewLineSelection.fileKey,
      "fallback",
    );

    const measure = () => {
      const viewport = patchViewportRef.current;
      if (!viewport) {
        setReviewCommentPopoverPosition(fallbackPosition);
        return;
      }

      const fileElement = findDiffFileElement(viewport, activeReviewLineSelection);
      const anchorElement = fileElement
        ? findReviewCommentAnchorLineElement(fileElement, activeReviewLineSelection)
        : null;

      if (!fileElement || !anchorElement) {
        setReviewCommentPopoverPosition((current) => current ?? pendingPosition);
        if (retryCount < 10) {
          retryCount += 1;
          animationFrameId = window.requestAnimationFrame(measure);
          return;
        }
        setReviewCommentPopoverPosition(fallbackPosition);
        return;
      }

      const nextPosition = resolveReviewCommentPopoverPosition(
        fileElement,
        anchorElement,
        activeReviewLineSelection.fileKey,
      );
      setReviewCommentPopoverPosition((current) =>
        current?.fileKey === nextPosition.fileKey &&
        current.left === nextPosition.left &&
        current.placement === nextPosition.placement &&
        current.top === nextPosition.top
          ? current
          : nextPosition,
      );
    };

    animationFrameId = window.requestAnimationFrame(measure);
    return () => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
    };
  }, [
    activeReviewLineSelection,
    visibleCollapsedFileKeysSignature,
    diffRenderMode,
    diffWordWrap,
    resolvedTheme,
    reviewCommentPopoverOpen,
  ]);

  useEffect(() => {
    if (!reviewCommentPopoverOpen || visibleReviewCommentPopoverPosition?.placement === "pending") {
      return;
    }
    reviewCommentInputRef.current?.focus({ preventScroll: true });
  }, [
    activeReviewLineSelection,
    reviewCommentPopoverOpen,
    visibleReviewCommentPopoverPosition?.placement,
  ]);

  const selectedTurnSelectValue = selectedTurn?.turnId ?? ALL_TURNS_SELECT_VALUE;
  const selectedTurnLabel = selectedTurn
    ? resolveTurnCheckpointLabel(selectedTurn, inferredCheckpointTurnCountByTurnId)
    : "All turns";
  const turnSelectorDisabled = orderedTurnDiffSummaries.length === 0;

  const submitReviewComment = () => {
    const body = reviewCommentDraft.trim();
    if (
      !body ||
      !activeCwd ||
      !onAddReviewComment ||
      !activeReviewLineSelection ||
      !activeReviewFileDiff
    ) {
      return;
    }
    const stat = summarizeFileDiff(activeReviewFileDiff);
    onAddReviewComment({
      additions: stat.additions,
      body,
      changeType: formatFileChangeType(activeReviewFileDiff),
      cwd: activeCwd,
      deletions: stat.deletions,
      filePath: activeReviewLineSelection.filePath,
      hunkCount: stat.hunkCount,
      lineRange: activeReviewLineSelection.lineRange,
      previousFilePath: activeReviewFileDiff.prevName ?? null,
      scopeLabel: selectedTurnLabel,
    });
    closeReviewCommentPopover();
    setCollapsedFileKeys((current) => {
      if (!current.has(activeReviewLineSelection.fileKey)) {
        return current;
      }
      const next = new Set(current);
      next.delete(activeReviewLineSelection.fileKey);
      return next;
    });
  };

  const selectTurn = (turnId: TurnId) => {
    if (onSelectTurn) {
      onSelectTurn(turnId);
      return;
    }
    if (!activeThread) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1", diffTurnId: turnId };
      },
    });
  };
  const selectWholeConversation = () => {
    if (onSelectWholeConversation) {
      onSelectWholeConversation();
      return;
    }
    if (!activeThread) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1" };
      },
    });
  };
  const headerRow = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3 [-webkit-app-region:no-drag]">
        <Select
          value={selectedTurnSelectValue}
          onValueChange={(value) => {
            if (value === ALL_TURNS_SELECT_VALUE) {
              selectWholeConversation();
              return;
            }
            if (value === null) {
              return;
            }
            selectTurn(TurnId.makeUnsafe(value));
          }}
          disabled={turnSelectorDisabled}
        >
          <SelectTrigger
            variant="ghost"
            size="lg"
            className="w-auto min-w-0 max-w-40 flex-none rounded-md px-2 text-sm font-medium text-foreground hover:bg-accent/55 hover:text-foreground"
            aria-label="Select review scope"
          >
            <span className="truncate text-sm font-medium text-foreground">
              {selectedTurnLabel}
            </span>
          </SelectTrigger>
          <SelectPopup align="start" className="max-h-80">
            <SelectItem value={ALL_TURNS_SELECT_VALUE}>
              <span className="truncate font-medium text-foreground">All turns</span>
            </SelectItem>
            {orderedTurnDiffSummaries.map((summary) => (
              <SelectItem key={summary.turnId} value={summary.turnId}>
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <span className="truncate font-medium text-foreground">
                    {resolveTurnCheckpointLabel(summary, inferredCheckpointTurnCountByTurnId)}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground/65">
                    {formatShortTimestamp(summary.completedAt, timestampFormat)}
                  </span>
                </div>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
        {renderableFiles.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground/75 transition-colors hover:bg-accent/70 hover:text-foreground"
                  onClick={() => setAllFilesCollapsed(!allFilesCollapsed)}
                  aria-label={allFilesCollapsed ? "Expand all files" : "Collapse all files"}
                />
              }
            >
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", allFilesCollapsed && "-rotate-90")}
              />
              <span className="hidden sm:inline">{allFilesCollapsed ? "Expand" : "Collapse"}</span>
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {allFilesCollapsed ? "Expand all files" : "Collapse all files"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        <ToggleGroup
          className="shrink-0 gap-1"
          variant="default"
          size="sm"
          value={[diffRenderMode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") {
              setDiffRenderMode(next);
            }
          }}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label="Unified diff view"
                  className="h-8 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground data-pressed:bg-accent/80 data-pressed:text-foreground"
                  value="stacked"
                />
              }
            >
              <Rows3Icon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Unified diff view</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label="Split diff view"
                  className="h-8 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground data-pressed:bg-accent/80 data-pressed:text-foreground"
                  value="split"
                />
              }
            >
              <Columns2Icon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Split diff view</TooltipPopup>
          </Tooltip>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={
                  diffWordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"
                }
                variant="default"
                size="sm"
                className="h-8 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground data-pressed:bg-accent/80 data-pressed:text-foreground"
                pressed={diffWordWrap}
                onPressedChange={(pressed) => {
                  setDiffWordWrap(Boolean(pressed));
                }}
              />
            }
          >
            <TextWrapIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {diffWordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground/60">
          Select a thread to inspect turn diffs.
        </div>
      ) : activeCwd === null ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground/60">
          Turn diffs are unavailable because this thread has no workspace path.
        </div>
      ) : isCheckingGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground/60">
          Checking git repository status…
        </div>
      ) : gitRepoCheckError && typeof gitRepoStatus !== "boolean" ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground/60">
          {gitRepoCheckError}
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground/60">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground/60">
          No completed turns yet.
        </div>
      ) : (
        <>
          <div
            ref={patchViewportRef}
            className="diff-panel-viewport min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            {checkpointDiffError && !checkpointDiffIsTemporarilyUnavailable && !renderablePatch && (
              <div className="px-3.5">
                <p className="mb-2 text-[11px] text-destructive/70">{checkpointDiffError}</p>
              </div>
            )}
            {!renderablePatch ? (
              isLoadingCheckpointDiff || isPatchResolutionDeferred ? (
                <DiffPanelLoadingState label="Loading checkpoint diff..." />
              ) : (
                <div className="flex h-full items-center justify-center px-4 py-2 text-xs text-muted-foreground/60">
                  <p>{noPatchMessage}</p>
                </div>
              )
            ) : renderablePatch.kind === "files" ? (
              <Virtualizer
                className="diff-render-surface h-full min-h-0 overflow-auto px-0 pb-0"
                config={{
                  overscrollSize: 600,
                  intersectionObserverMargin: 1200,
                }}
              >
                {renderableFiles.map((fileDiff) => {
                  const filePath = resolveFileDiffPath(fileDiff);
                  const fileKey = buildFileDiffRenderKey(fileDiff);
                  const themedFileKey = `${fileKey}:${resolvedTheme}`;
                  const stat = summarizeFileDiff(fileDiff);
                  const changeType = formatFileChangeType(fileDiff);
                  const collapsed = visibleCollapsedFileKeys.has(fileKey);
                  const commentSelection =
                    activeReviewLineSelection?.fileKey === fileKey
                      ? activeReviewLineSelection
                      : null;
                  const commentPopoverOpen =
                    reviewCommentPopoverOpen &&
                    activeCommentFileKey === fileKey &&
                    commentSelection !== null;
                  const commentPopoverPosition =
                    visibleReviewCommentPopoverPosition?.fileKey === fileKey
                      ? visibleReviewCommentPopoverPosition
                      : commentPopoverOpen
                        ? createFallbackReviewCommentPopoverPosition(fileKey, "pending")
                        : null;
                  const commentPopoverPositionReady =
                    commentPopoverPosition !== null &&
                    commentPopoverPosition.placement !== "pending";
                  return (
                    <div
                      key={themedFileKey}
                      data-diff-file-path={filePath}
                      className="diff-render-file relative overflow-hidden border-b border-border/40 bg-background last:border-b-0"
                    >
                      <div className="group/file sticky top-0 z-[2] bg-background">
                        <div className="flex min-h-9 items-center gap-1.5 px-2 py-1 transition-colors group-hover/file:bg-muted/20">
                          <button
                            type="button"
                            className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground/72 transition-colors hover:bg-accent/70 hover:text-foreground"
                            aria-label={collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
                            onClick={() => toggleFileCollapsed(fileKey)}
                          >
                            <ChevronDownIcon
                              className={cn(
                                "size-3.5 transition-transform",
                                collapsed && "-rotate-90",
                              )}
                            />
                          </button>
                          <button
                            type="button"
                            className="min-w-0 flex-1 truncate text-left font-mono text-[12px] leading-5 text-foreground/80 underline decoration-transparent underline-offset-2 transition-colors hover:text-foreground hover:decoration-current"
                            title={filePath}
                            onClick={() => openDiffFileInEditor(filePath)}
                          >
                            {filePath}
                          </button>
                          <span className="hidden shrink-0 text-[10px] font-medium uppercase text-muted-foreground/45 sm:inline-flex">
                            {changeType}
                          </span>
                          <span className="shrink-0 font-mono text-[11px] tabular-nums text-success/75">
                            +{stat.additions}
                          </span>
                          <span className="shrink-0 font-mono text-[11px] tabular-nums text-destructive/75">
                            -{stat.deletions}
                          </span>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 opacity-100 transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:opacity-100 sm:opacity-0 sm:group-hover/file:opacity-100 sm:group-focus-within/file:opacity-100"
                                  aria-label={`Open ${filePath} in editor`}
                                  onClick={() => openDiffFileInEditor(filePath)}
                                />
                              }
                            >
                              <ExternalLinkIcon className="size-3.5" />
                            </TooltipTrigger>
                            <TooltipPopup side="bottom">Open in editor</TooltipPopup>
                          </Tooltip>
                        </div>
                      </div>
                      {commentPopoverOpen && commentPopoverPosition ? (
                        <form
                          className={cn(
                            "absolute z-[5] flex h-12 w-[min(390px,calc(100%-3rem))] items-center gap-2 rounded-full border border-foreground/18 bg-background/95 px-2 ring-1 ring-background/80 shadow-[0_16px_38px_rgba(0,0,0,0.18)] backdrop-blur-xl",
                            !commentPopoverPositionReady && "pointer-events-none opacity-0",
                          )}
                          style={{
                            left: commentPopoverPosition.left,
                            top: commentPopoverPosition.top,
                          }}
                          onSubmit={(event) => {
                            event.preventDefault();
                            submitReviewComment();
                          }}
                        >
                          <span
                            className="max-w-28 shrink-0 truncate rounded-full bg-muted/55 px-2 py-1 font-mono text-[10px] leading-none text-muted-foreground/78"
                            title={commentSelection.label}
                          >
                            {commentSelection.label}
                          </span>
                          <input
                            ref={reviewCommentInputRef}
                            aria-label="Review comment"
                            value={reviewCommentDraft}
                            onChange={(event) => setReviewCommentDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                closeReviewCommentPopover();
                              }
                            }}
                            placeholder={commentPlaceholder}
                            className="h-9 min-w-0 flex-1 border-0 bg-transparent px-1 text-[13px] font-medium text-foreground outline-none placeholder:text-muted-foreground/55"
                          />
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground/72 transition-colors hover:bg-accent/70 hover:text-foreground"
                                  onClick={closeReviewCommentPopover}
                                  aria-label="Cancel comment"
                                />
                              }
                            >
                              <XIcon className="size-3.5" />
                            </TooltipTrigger>
                            <TooltipPopup side="top">Cancel</TooltipPopup>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <button
                                  type="submit"
                                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-40"
                                  disabled={reviewCommentDraft.trim().length === 0}
                                  aria-label="Submit comment"
                                />
                              }
                            >
                              <ArrowUpRightIcon className="size-4" />
                            </TooltipTrigger>
                            <TooltipPopup side="top">Submit comment</TooltipPopup>
                          </Tooltip>
                        </form>
                      ) : null}
                      {!collapsed ? (
                        <FileDiff
                          fileDiff={fileDiff}
                          options={{
                            diffStyle: diffRenderMode === "split" ? "split" : "unified",
                            disableFileHeader: true,
                            enableGutterUtility: Boolean(onAddReviewComment),
                            enableLineSelection: Boolean(onAddReviewComment),
                            lineDiffType: "none",
                            lineHoverHighlight: onAddReviewComment ? "number" : "disabled",
                            ...(onAddReviewComment
                              ? {
                                  onGutterUtilityClick: (range: SelectedLineRange) =>
                                    openReviewLineSelection(fileKey, filePath, range),
                                  onLineSelected: (range: SelectedLineRange | null) =>
                                    openReviewLineSelection(fileKey, filePath, range),
                                }
                              : {}),
                            overflow: diffWordWrap ? "wrap" : "scroll",
                            theme: resolveDiffThemeName(resolvedTheme),
                            themeType: resolvedTheme as DiffThemeType,
                            unsafeCSS: diffPanelUnsafeCss,
                          }}
                          selectedLines={commentSelection?.range ?? null}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </Virtualizer>
            ) : (
              <div className="h-full overflow-auto px-4 py-3">
                <div className="space-y-2.5">
                  <p className="text-[11px] text-muted-foreground/65">{renderablePatch.reason}</p>
                  <pre
                    className={cn(
                      "max-h-[72vh] overflow-auto bg-transparent p-0 font-mono text-[11px] leading-relaxed text-muted-foreground",
                      diffWordWrap ? "whitespace-pre-wrap wrap-break-word" : "",
                    )}
                  >
                    {renderablePatch.text}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </DiffPanelShell>
  );
}

export default function DiffPanel(props: DiffPanelProps) {
  return useDiffPanelComponent(props);
}
