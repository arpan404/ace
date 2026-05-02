import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ThreadId, TurnId } from "@ace/contracts";
import { Columns2Icon, Rows3Icon, TextWrapIcon } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
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
import { buildPatchCacheKey } from "../lib/diffRendering";
import { resolveDiffThemeName } from "../lib/diffRendering";
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

type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) {
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
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
  onSelectTurn?: (turnId: TurnId) => void;
  onSelectWholeConversation?: () => void;
  mode?: DiffPanelMode;
  selectedFilePath?: string | null;
  selectedTurnId?: TurnId | null;
  threadId?: ThreadId | null;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({
  diffOpen: diffOpenOverride,
  mode = "inline",
  onSelectTurn,
  onSelectWholeConversation,
  selectedFilePath: selectedFilePathOverride,
  selectedTurnId: selectedTurnIdOverride,
  threadId,
}: DiffPanelProps) {
  const diffPanelUnsafeCss = useMemo(() => buildDiffPanelUnsafeCss(mode), [mode]);
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const diffWordWrapSetting = useSetting("diffWordWrap");
  const timestampFormat = useSetting("timestampFormat");
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [diffWordWrap, setDiffWordWrap] = useState(diffWordWrapSetting);
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const previousDiffOpenRef = useRef(false);
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
  const gitBranchesQuery = useQuery(gitBranchesQueryOptions(activeCwd ?? null));
  const gitStatusQuery = useQuery(
    gitStatusQueryOptions(
      activeThread?.latestTurn?.state === "running" ? (activeCwd ?? null) : null,
    ),
  );
  const gitRepoStatus = gitBranchesQuery.data?.isRepo;
  const gitRepoCheckError =
    gitBranchesQuery.error instanceof Error
      ? gitBranchesQuery.error.message
      : gitBranchesQuery.error
        ? "Failed to inspect git repository status."
        : null;
  const isCheckingGitRepo =
    activeCwd !== null &&
    (gitBranchesQuery.isPending ||
      (gitBranchesQuery.fetchStatus === "fetching" && typeof gitRepoStatus !== "boolean"));
  const isGitRepo = gitRepoStatus === true;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );
  const queryableTurnDiffSummaries = useMemo(
    () =>
      orderedTurnDiffSummaries.filter((summary) =>
        isCheckpointSummaryQueryable(
          summary,
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
        ),
      ),
    [inferredCheckpointTurnCountByTurnId, orderedTurnDiffSummaries],
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
    gitStatusQuery.data?.hasWorkingTreeChanges === true;
  const selectedTurnUnavailableReason = useMemo(() => {
    if (
      !selectedTurn ||
      selectedTurnQueryable ||
      selectedTurnLiveDiff ||
      selectedTurnWorkspaceFallback
    ) {
      return null;
    }
    if (selectedTurn.status === "missing") {
      return "Diff is still being prepared for this turn.";
    }
    if (selectedTurn.status === "error") {
      return "Diff generation failed for this turn.";
    }
    return "Diff is unavailable for this turn.";
  }, [selectedTurn, selectedTurnLiveDiff, selectedTurnQueryable, selectedTurnWorkspaceFallback]);
  const selectedCheckpointRange = useMemo(
    () =>
      selectedTurn && selectedTurnQueryable && typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount, selectedTurn, selectedTurnQueryable],
  );
  const conversationCheckpointTurnCount = useMemo(() => {
    const turnCounts = queryableTurnDiffSummaries
      .map(
        (summary) =>
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
      )
      .filter((value): value is number => typeof value === "number");
    if (turnCounts.length === 0) {
      return undefined;
    }
    const latest = Math.max(...turnCounts);
    return latest > 0 ? latest : undefined;
  }, [inferredCheckpointTurnCountByTurnId, queryableTurnDiffSummaries]);
  const conversationCheckpointRange = useMemo(
    () =>
      !selectedTurn && typeof conversationCheckpointTurnCount === "number"
        ? {
            fromTurnCount: 0,
            toTurnCount: conversationCheckpointTurnCount,
          }
        : null,
    [conversationCheckpointTurnCount, selectedTurn],
  );
  const activeCheckpointRange = selectedTurn
    ? selectedCheckpointRange
    : conversationCheckpointRange;
  const conversationCacheScope = useMemo(() => {
    if (selectedTurn || queryableTurnDiffSummaries.length === 0) {
      return null;
    }
    return `conversation:${queryableTurnDiffSummaries.map((summary) => summary.turnId).join(",")}`;
  }, [queryableTurnDiffSummaries, selectedTurn]);
  const canQueryCheckpointDiff =
    diffOpen &&
    !isCheckingGitRepo &&
    isGitRepo &&
    activeThreadId !== null &&
    activeCheckpointRange !== null &&
    !selectedTurnLiveDiff &&
    !selectedTurnWorkspaceFallback;
  const activeCheckpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      threadId: activeThreadId,
      fromTurnCount: activeCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: activeCheckpointRange?.toTurnCount ?? null,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : conversationCacheScope,
      enabled: canQueryCheckpointDiff,
    }),
  );
  const selectedTurnCheckpointDiff = selectedTurn
    ? activeCheckpointDiffQuery.data?.diff
    : undefined;
  const workingTreeDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      cwd: activeCwd ?? null,
      enabled: diffOpen && selectedTurnWorkspaceFallback,
    }),
  );
  const conversationCheckpointDiff = selectedTurn
    ? undefined
    : activeCheckpointDiffQuery.data?.diff;
  const isLoadingCheckpointDiff =
    (canQueryCheckpointDiff &&
      (activeCheckpointDiffQuery.isPending ||
        activeCheckpointDiffQuery.fetchStatus === "fetching")) ||
    (selectedTurnWorkspaceFallback &&
      (workingTreeDiffQuery.isPending || workingTreeDiffQuery.fetchStatus === "fetching"));
  const checkpointDiffError = selectedTurnWorkspaceFallback
    ? workingTreeDiffQuery.error instanceof Error
      ? workingTreeDiffQuery.error.message
      : workingTreeDiffQuery.error
        ? "Failed to load workspace diff."
        : null
    : activeCheckpointDiffQuery.error instanceof Error
      ? activeCheckpointDiffQuery.error.message
      : activeCheckpointDiffQuery.error
        ? "Failed to load checkpoint diff."
        : null;
  const checkpointDiffIsTemporarilyUnavailable =
    !selectedTurnLiveDiff &&
    !selectedTurnWorkspaceFallback &&
    activeCheckpointDiffQuery.error !== null &&
    isCheckpointTemporarilyUnavailable(activeCheckpointDiffQuery.error);

  const selectedPatch = diffOpen
    ? selectedTurn
      ? (selectedTurnLiveDiff ?? workingTreeDiffQuery.data?.diff ?? selectedTurnCheckpointDiff)
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
  const renderablePatch = useMemo(
    () => getRenderablePatch(deferredSelectedPatch, "diff-panel"),
    [deferredSelectedPatch],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);

  useEffect(() => {
    if (diffOpen && !previousDiffOpenRef.current) {
      setDiffWordWrap(diffWordWrapSetting);
    }
    previousDiffOpenRef.current = diffOpen;
  }, [diffOpen, diffWordWrapSetting]);

  useEffect(() => {
    if (!selectedFilePath || !patchViewportRef.current) {
      return;
    }
    const target = Array.from(
      patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
    ).find((element) => element.dataset.diffFilePath === selectedFilePath);
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedFilePath, renderableFiles]);

  const openDiffFileInEditor = useCallback(
    (filePath: string) => {
      const api = readNativeApi();
      if (!api) return;
      const targetPath = activeCwd ? resolvePathLinkTarget(filePath, activeCwd) : filePath;
      void openInPreferredEditor(api, targetPath).catch((error) => {
        console.warn("Failed to open diff file in editor.", error);
      });
    },
    [activeCwd],
  );

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
  const selectedTurnSelectValue = selectedTurn?.turnId ?? ALL_TURNS_SELECT_VALUE;
  const selectedTurnLabel = selectedTurn
    ? resolveTurnCheckpointLabel(selectedTurn, inferredCheckpointTurnCountByTurnId)
    : "All turns";
  const turnSelectorDisabled = orderedTurnDiffSummaries.length === 0;

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
            className="w-auto min-w-0 max-w-40 flex-none rounded-lg px-2.5 text-sm font-medium text-foreground hover:bg-accent/60 hover:text-foreground"
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
                  className="h-8 rounded-lg px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground data-pressed:bg-accent data-pressed:text-foreground"
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
                  className="h-8 rounded-lg px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground data-pressed:bg-accent data-pressed:text-foreground"
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
                className="h-8 rounded-lg px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground data-pressed:bg-accent data-pressed:text-foreground"
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
          Checking git repository status...
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
                  return (
                    <div
                      key={themedFileKey}
                      data-diff-file-path={filePath}
                      className="diff-render-file overflow-hidden"
                      onClickCapture={(event) => {
                        const nativeEvent = event.nativeEvent as MouseEvent;
                        const composedPath = nativeEvent.composedPath?.() ?? [];
                        const clickedHeader = composedPath.some((node) => {
                          if (!(node instanceof Element)) return false;
                          return node.hasAttribute("data-title");
                        });
                        if (!clickedHeader) return;
                        openDiffFileInEditor(filePath);
                      }}
                    >
                      <FileDiff
                        fileDiff={fileDiff}
                        options={{
                          diffStyle: diffRenderMode === "split" ? "split" : "unified",
                          lineDiffType: "none",
                          overflow: diffWordWrap ? "wrap" : "scroll",
                          theme: resolveDiffThemeName(resolvedTheme),
                          themeType: resolvedTheme as DiffThemeType,
                          unsafeCSS: diffPanelUnsafeCss,
                        }}
                      />
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
