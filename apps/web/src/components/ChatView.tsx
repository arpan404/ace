import {
  DEFAULT_MODEL_BY_PROVIDER,
  PROVIDER_DISPLAY_NAMES,
  ProviderInteractionMode,
  RuntimeMode,
  TerminalOpenInput,
  ThreadId,
  MessageId,
  type ApprovalRequestId,
  type DesktopDetachedWindowReturnRequest,
  type ModelSelection,
  type ProjectId,
  type ProjectScript,
  type ProviderApprovalDecision,
  type ProviderKind,
  type ThreadHandoffMode,
  type TurnId,
} from "@ace/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@ace/contracts/settings";
import { buildProviderModelSelection } from "@ace/shared/model";
import {
  mergeProviderSlashCommands,
  providerFallbackSlashCommands,
} from "@ace/shared/providerSlashCommands";
import { truncate } from "@ace/shared/String";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, GitBranchPlusIcon, LaptopIcon } from "lucide-react";
import { AnimatePresence, LayoutGroup, LazyMotion, domAnimation, m } from "motion/react";
import {
  Suspense,
  lazy,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";
import {
  resolveThreadOriginConnectionUrl,
  useConnectionServerConfig,
} from "~/hooks/useConnectionServerProviders";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useEffectEvent } from "~/hooks/useEffectEvent";
import { useLocalDispatchState } from "~/hooks/useLocalDispatchState";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "~/hooks/useLocalStorage";
import { useStableCallback } from "~/hooks/useStableCallback";
import { reportBackgroundError } from "~/lib/async";
import { resolveScopedBrowserStorageKey } from "~/lib/browser/storage";
import { isThreadLiveWorkActive } from "~/lib/chat/activeThreadHydration";
import {
  DEFAULT_THREAD_TITLE,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  buildLocalDraftThread,
  buildTemporaryWorktreeBranchName,
  cloneComposerImageForRetry,
  collectUserMessageBlobPreviewUrls,
  deriveHydratedThreadHistoryKeepIds,
  deriveRecentlyVisitedThreadHistoryKeepIds,
  formatOutgoingPrompt,
  readFileAsDataUrl,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  threadHasStarted,
  waitForStartedServerThread,
} from "~/lib/chat/chatView";
import {
  buildCheckpointRestoreConfirmation,
  checkpointRestoreActionTitle,
  checkpointRestoreFailureMessage,
} from "~/lib/chat/checkpointRestore";
import { type PendingComposerComment } from "~/lib/chat/commentAccumulation";
import { buildGitHubIssueSelectionPayload } from "~/lib/chat/githubIssueSelection";
import {
  buildHandoffTimeline,
  resolveHandoffSourceProvider,
  resolveThreadLineageSourceThreadId,
} from "~/lib/chat/handoff";
import {
  DEFAULT_RIGHT_SIDE_PANEL_WIDTH,
  MIN_RIGHT_SIDE_PANEL_CHAT_WIDTH,
  MIN_RIGHT_SIDE_PANEL_WIDTH,
  RIGHT_SIDE_PANEL_RESIZE_HANDLE_WIDTH,
  clampRightSidePanelWidth,
  constrainedPanelWidth,
} from "~/lib/chat/rightSidePanelWidth";
import {
  deriveSourceCompletionAttachment,
  toPagedChatMessage,
  type SourceTimelineRowsInput,
} from "~/lib/chat/sourceTimelineRows";
import { createSourceTimelineRowsCacheKey } from "~/lib/chat/sourceTimelineRowsClient";
import { useThreadPlanCatalog } from "~/lib/chat/threadPlanCatalog";
import {
  deriveThreadActivityRenderState,
  deriveThreadTimelineRenderState,
  deriveTurnDiffSummaryByAssistantMessageId,
} from "~/lib/chat/threadRenderState";
import {
  buildThreadTimelineCacheScope,
  deriveThreadCompletionSummary,
} from "~/lib/chat/timelineCacheScope";
import {
  collectTimelineRowsDisclosureKeys,
  pruneTimelineDisclosureExpansionState,
  toggleTimelineDisclosureExpansion,
  type TimelineDisclosureExpansionState,
  type TimelineDisclosureKey,
} from "~/lib/chat/timelineDisclosureState";
import { buildTimelineRows, type TimelineRow } from "~/lib/chat/timelineRows";
import {
  MIN_WORKSPACE_CHAT_SPLIT_WIDTH,
  clampWorkspaceEditorSplitWidth,
} from "~/lib/chat/workspaceSplit";
import {
  SIDEBAR_RESIZE_END_EVENT,
  beginLayoutResizeInteraction,
  endLayoutResizeInteraction,
  isLayoutResizeInProgress,
} from "~/lib/desktopChrome";
import {
  DETACHED_WINDOW_RETURN_EVENT,
  consumePendingDetachedWindowReturnRequest,
  isDetachedWindowReturnRequest,
  resolveDetachedWindowReturnThreadId,
} from "~/lib/detachedWindowReturn";
import {
  gitBranchesQueryOptions,
  gitCreateWorktreeMutationOptions,
  gitStatusQueryOptions,
} from "~/lib/gitReactQuery";
import { NOT_STUCK_TURN_SNAPSHOT, deriveStuckTurnSnapshot } from "~/lib/reliability/stuckTurn";
import {
  loadRemoteHostInstances,
  normalizeWsUrl,
  resolveHostConnectionWsUrl,
} from "~/lib/remoteHosts";
import { measureRenderWork } from "~/lib/renderProfiling";
import {
  RIGHT_SIDE_PANEL_WIDTH_STORAGE_KEY,
  resolveRequestedRightSidePanelMode,
  resolveRightSidePanelModeAfterDiffClose,
  shouldApplyThreadBrowserViewportResizeToVisiblePanel,
  type RightSidePanelMode,
} from "~/lib/rightSidePanelState";
import { resolveSidebarNewThreadOptions } from "~/lib/sidebar";
import {
  deriveTerminalTitleFromCommand,
  resolveTerminalDisplayTitle,
} from "~/lib/terminalPresentation";
import { cn, newCommandId, newMessageId, newThreadId, randomUUID } from "~/lib/utils";
import { resolveWorkspaceEditorFilePath } from "~/markdown-links";
import { readNativeApi } from "~/nativeApi";
import {
  DEFAULT_PROJECT_SCRIPT_ENV_FILE_PATH,
  commandForProjectScript,
  formatProjectScriptEnvFile,
  nextProjectScriptId,
  projectScriptCwd,
  projectScriptRuntimeEnv,
  setupProjectScript,
} from "~/projectScripts";
import { useServerAvailableEditors, useServerKeybindings } from "~/rpc/serverState";
import {
  hasScrolledUp,
  isScrollContainerNearBottom,
  resolveAutoScrollOnScroll,
  scrollContainerToBottom,
  shouldShowScrollToBottomButton,
} from "../chat-scroll";
import { useChatThreadBoardStore } from "../chatThreadBoardStore";
import { stripComposerInlineMarkers } from "../composer-editor-mentions";
import { collapseExpandedComposerCursor } from "../composer-logic";
import {
  deriveEffectiveComposerExecutionModeState,
  deriveEffectiveComposerModelState,
  getComposerThreadDraft,
  getComposerThreadDraftState,
  useComposerDraftStore,
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
} from "../composerDraftStore";
import { parseDiffRouteSearch } from "../diffRouteSearch";
import {
  resolveEditorInstanceStateScopeId,
  resolveEditorWindowStateInstanceId,
  useEditorStateStore,
} from "../editorStateStore";
import { isElectron } from "../env";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSetting } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { useThreadActions } from "../hooks/useThreadActions";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import {
  useHostConnectionStore,
  useProjectConnectionUrl,
  useThreadConnectionUrl,
} from "../hostConnectionStore";
import { shouldEscalateInterruptToSessionStop } from "../lib/chat/interruptFallback";
import { useThreadTimelineViewModel } from "../lib/chat/threadTimelineViewModel";
import { startThreadTimelineRowsOpenPrefetch } from "../lib/chat/timelineModelStore";
import {
  buildSingleThreadRouteHref,
  buildSingleThreadRouteSearch,
} from "../lib/chatThreadBoardRouteSearch";
import { THREAD_ROUTE_CONNECTION_SEARCH_PARAM } from "../lib/connectionRouting";
import { deriveLatestContextWindowSnapshot } from "../lib/contextWindow";
import { isMemoryPressureAtLeast, subscribeToMemoryPressure } from "../lib/memoryPressure";
import { PANEL_SPRING_TRANSITION } from "../lib/panelMotion";
import {
  appendTerminalContextsToPrompt,
  deriveDisplayedUserMessageState,
  formatTerminalContextLabel,
  insertInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import { hydrateThreadFromCache } from "../lib/threadHydrationCache";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  selectPendingUserInputOption,
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import {
  buildPlanImplementationPrompt,
  buildPlanImplementationThreadTitle,
  proposedPlanTitle,
} from "../proposedPlan";
import {
  getDefaultServerModel,
  getProviderModels,
  resolveSelectableProvider,
} from "../providerModels";
import {
  deriveActivePlanState,
  deriveActiveWorkStartedAt,
  deriveCompletionDividerBeforeEntryId,
  deriveLatestGeneratedWorkspaceSummary,
  derivePhase,
  deriveVisibleWorkTurnId,
  findLatestProposedPlan,
  findSidebarProposedPlan,
  hasActionableProposedPlan,
  hasLiveTurn,
  isLatestTurnSettled,
} from "../session-logic";
import { getThreadById, useStore } from "../store";
import { useProjectById, useThreadById } from "../storeSelectors";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import {
  normalizeThreadWorkspaceLayoutMode,
  type ThreadWorkspaceMode,
} from "../threadWorkspaceMode";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  type ChatMessage,
  type QueuedComposerImageAttachment,
} from "../types";
import { useUiStateStore } from "../uiStateStore";
import { ChatConversationExtras } from "./chat/ChatConversationExtras";
import { ChatMessagesPane } from "./chat/ChatMessagesPane";
import {
  EnvironmentMiniPanelPortal,
  InlineEnvironmentMiniPanel,
} from "./chat/ChatViewEnvironmentMiniPanels";
import { ChatViewPanels } from "./chat/ChatViewPanels";
import { RightSidePanelTabStrip, type PanelTabOrderEntry } from "./chat/ChatViewRightSidePanels";
import { getComposerProviderState } from "./chat/composerProviderRegistry";
import {
  ConnectedChatComposerPanels,
  ConnectedComposerProviderStatusBanner,
  type ConnectedChatComposerPanelsHandle,
} from "./chat/ConnectedChatComposerPanels";
import { DraftBranchToolbar } from "./chat/DraftBranchToolbar";
import { EnvironmentMiniPanel } from "./chat/EnvironmentMiniPanel";
import { resolveExpandedImageItem, type ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { NewThreadStartSurface, useNewThreadRecommendedPrompts } from "./chat/NewThreadLanding";
import type { PinnedMessageNavigationTarget } from "./chat/pinnedMessagesStore";
import { ProjectContextSwitcher } from "./chat/ProjectContextSwitcher";
import { deriveSubagentThreads, type SubagentThread } from "./chat/subagentThreads";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import { ThreadRenameDialog } from "./chat/ThreadRenameDialog";
import { useChatViewBrowserState } from "./chat/useChatViewBrowserState";
import {
  useChatViewComposerActions,
  type UseChatViewComposerActionsInput,
} from "./chat/useChatViewComposerActions";
import { useChatViewKeyboardShortcuts } from "./chat/useChatViewKeyboardShortcuts";
import { useChatViewProviderSelectionState } from "./chat/useChatViewModelState";
import { useChatViewPersistentPanelState } from "./chat/useChatViewPersistentPanelState";
import { useChatViewTerminalState } from "./chat/useChatViewTerminalState";
import type { DiffReviewCommentInput } from "./DiffPanel";
import { GitHubIssuePreviewDialog } from "./GitHubIssuePreviewDialog";
import { GitHubIcon } from "./Icons";
import {
  type BrowserViewportResizeRequest,
  type BrowserViewportResizeResult,
} from "./InAppBrowser";
import { ProjectGlyphIcon } from "./ProjectAvatar";
import { type NewProjectScriptInput } from "./ProjectScriptsControl";
import { ConnectionHealthPill } from "./reliability/ConnectionHealthPill";
import { ReliabilityDiagnosticsDialog } from "./reliability/ReliabilityDiagnosticsDialog";
import {
  DRAFT_CONTEXT_PILL_ICON_CLASS_NAME,
  DRAFT_CONTEXT_PILL_TRIGGER_CLASS_NAME,
} from "./thread/topBarClusterStyles";
import { Button } from "./ui/button";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

import { ChatViewBottomPanelContent } from "./chat/ChatViewBottomPanelContent";
import {
  ACTIVE_SOURCE_TIMELINE_ROWS_REBUILD_DELAY_MS,
  ATTACHMENT_PREVIEW_HANDOFF_TTL_MS,
  BOTTOM_EDGE_PANEL_SPRING_ANIMATION,
  DEFAULT_LOCAL_DIFF_STATE,
  EMPTY_ACTIVITIES,
  EMPTY_CHAT_MESSAGES,
  EMPTY_CHAT_VIEW_DIALOG_STATE,
  EMPTY_CHAT_VIEW_TRANSIENT_STATE,
  EMPTY_COMPOSER_MODEL_SELECTIONS,
  EMPTY_HISTORICAL_MESSAGE_IDS,
  EMPTY_MESSAGE_ID_SET,
  EMPTY_MESSAGE_TURN_COUNT_MAP,
  EMPTY_PENDING_USER_INPUT_ANSWERS,
  EMPTY_PROPOSED_PLANS,
  EMPTY_PROVIDER_STATUSES,
  EMPTY_QUEUED_COMPOSER_MESSAGES,
  EMPTY_THREAD_LAST_VISITED_AT_BY_ID,
  EMPTY_TIMELINE_DISCLOSURE_EXPANSION_STATE,
  EMPTY_TIMELINE_ENTRIES,
  EMPTY_TIMELINE_ROWS,
  EMPTY_VISIBLE_BOARD_THREAD_IDS,
  ENVIRONMENT_MINI_PANEL_INLINE_INSET_PX,
  ENVIRONMENT_MINI_PANEL_MAX_GAP_PX,
  ENVIRONMENT_MINI_PANEL_MIN_CHAT_WIDTH_PX,
  ENVIRONMENT_MINI_PANEL_MIN_GAP_PX,
  ENVIRONMENT_MINI_PANEL_WIDTH_PX,
  ENVIRONMENT_POPOVER_INTERACTIVE_LAYER_SELECTOR,
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
  INITIAL_THREAD_BOTTOM_PIN_MAX_MS,
  INITIAL_THREAD_BOTTOM_PIN_MIN_MS,
  INITIAL_THREAD_BOTTOM_PIN_STABLE_FRAMES,
  INTERRUPT_STOP_FALLBACK_DELAY_MS,
  OPTIMISTIC_QUEUE_STATE_MAX_AGE_MS,
  PANEL_CONTENT_DEFER_FALLBACK_MS,
  PANEL_EDGE_LAYOUT_TRANSITION,
  PANEL_OPACITY_SPRING_ANIMATION,
  PANEL_RESIZE_LAYOUT_TRANSITION,
  RECENT_HYDRATED_THREAD_HISTORY_KEEP_COUNT,
  RESIZABLE_PANEL_HEIGHT_STYLE,
  RESIZABLE_PANEL_WIDTH_STYLE,
  RIGHT_EDGE_PANEL_SPRING_ANIMATION,
  SCRIPT_TERMINAL_COLS,
  SCRIPT_TERMINAL_ROWS,
  THREAD_SWITCH_SCROLL_SETTLE_DELAY_MS,
  WORKSPACE_SIDE_PANEL_TRANSITION,
} from "./chat/chatViewConstants";
import { ChatViewHeader } from "./chat/ChatViewHeader";
import { ChatViewRightSidePanelContent } from "./chat/ChatViewRightSidePanelContent";
import {
  appendPanelTabOrder,
  chatViewDialogStateReducer,
  chatViewTransientStateReducer,
  clampBottomPanelHeight,
  createPanelEditorTab,
  mergeVisiblePanelTabOrder,
  removePanelTabOrder,
  removePanelTabOrderByMode,
  type ChatViewProps,
  type ComposerDispatchFailureContext,
  type DockPanelMode,
  type LocalDiffState,
  type OptimisticInactiveTurnState,
  type OptimisticQueuedDispatchState,
  type PanelEditorTab,
  type QueuedComposerMessage,
  type QueuedComposerState,
} from "./chat/chatViewTypes";
import {
  appendOptimisticUserMessagesToSourceTimeline,
  applyResizablePanelHeight,
  applyResizablePanelWidth,
  buildSourceTimelineRowsContentKey,
  clearResizablePanelHeight,
  clearResizablePanelWidth,
  createHandoffLineageSelector,
  eventTargetIsInsideElement,
  eventTargetIsInsideSelector,
  formatComposerDispatchFailureMessage,
  isAbsoluteFilesystemPath,
  onBrowserSessionChange,
  optimisticInactiveTurnCoversLiveTurn,
  persistProjectScripts,
  primeOptimisticUserTimelineRow,
  queuedComposerStateMatches,
  refreshProviderStatus,
  removeOptimisticUserTimelineRow,
  resolveBrowserInstanceId,
} from "./chat/chatViewUtils";
import { useResolvedSourceTimelineRows } from "./chat/useResolvedSourceTimelineRows";

const ThreadWorkspaceEditor = lazy(() => import("./editor/ThreadWorkspaceEditor"));

function useChatViewComponent({
  activeInBoard = true,
  connectionUrl = null,
  paneControls = null,
  shortcutsEnabled = true,
  showSidebarTrigger = true,
  splitPane = false,
  threadId,
  visibleBoardThreadIds = EMPTY_VISIBLE_BOARD_THREAD_IDS,
}: ChatViewProps) {
  const activeForSideEffects = !splitPane || activeInBoard;
  const ownsGlobalSideEffects = activeForSideEffects;
  const serverThread = useThreadById(threadId);
  const setStoreThreadError = useStore((store) => store.setError);
  const dismissStoreThreadError = useStore((store) => store.dismissThreadError);
  const setStoreThreadBranch = useStore((store) => store.setThreadBranch);
  const hydrateThreadFromReadModel = useStore((store) => store.hydrateThreadFromReadModel);
  const pruneHydratedThreadHistories = useStore((store) => store.pruneHydratedThreadHistories);
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const activeThreadPinned = useUiStateStore((store) =>
    store.pinnedItems.some((item) => item.kind === "thread" && item.id === threadId),
  );
  const togglePinnedThread = useUiStateStore((store) => store.togglePinnedThread);
  const trackActiveThread = useUiStateStore((store) => store.trackActiveThread);
  const trackedActiveThreadId = useUiStateStore((store) =>
    ownsGlobalSideEffects ? store.activeThreadId : null,
  );
  const previousActiveThreadId = useUiStateStore((store) =>
    ownsGlobalSideEffects ? store.previousActiveThreadId : null,
  );
  const threadLastVisitedAtById = useUiStateStore((store) =>
    ownsGlobalSideEffects ? store.threadLastVisitedAtById : EMPTY_THREAD_LAST_VISITED_AT_BY_ID,
  );
  const activeThreadLastVisitedAt = useUiStateStore((store) =>
    ownsGlobalSideEffects ? store.threadLastVisitedAtById[threadId] : undefined,
  );
  const defaultThreadEnvMode = useSetting("defaultThreadEnvMode");
  const enableThinkingStreaming = useSetting("enableThinkingStreaming");
  const enableToolStreaming = useSetting("enableToolStreaming");
  const hideCompletedWorkMessages = useSetting("hideCompletedWorkMessages");
  const reliabilityUxEnabled = useSetting("reliabilityUxEnabled");
  const timestampFormat = useSetting("timestampFormat");
  const workspaceEditorOpenMode = useSetting("workspaceEditorOpenMode");
  const commentSubmissionMode = useSetting("commentSubmissionMode");
  const {
    activeDraftThread: currentRouteDraftThread,
    activeThread: currentRouteThread,
    handleNewThread,
  } = useHandleNewThread();
  const { archiveThread } = useThreadActions();
  const { copyToClipboard: copyThreadMenuValue } = useCopyToClipboard<{ label: string }>({
    onCopy: ({ label }) => {
      toastManager.add({
        type: "success",
        title: `${label} copied`,
      });
    },
    onError: (error, { label }) => {
      toastManager.add({
        type: "error",
        title: `Failed to copy ${label.toLowerCase()}`,
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const navigate = useNavigate();
  const locationSearch = useLocation({ select: (location) => location.searchStr });
  const rawSearch = useSearch({
    strict: false,
    select: (params) => parseDiffRouteSearch(params),
  });
  const {
    browserSplitWidth,
    browserMode,
    environmentPanelOpen,
    handoffInFlight,
    isHeaderHidden,
    isRevertingCheckpoint,
    rightSidePanelDiffOpen,
    rightSidePanelEditorOpen,
    rightSidePanelFloatingChatOpen,
    rightSidePanelFullscreen,
    rightSidePanelLastNonDiffMode,
    rightSidePanelMode,
    rightSidePanelReviewOpen,
    rightSidePanelTerminalOpen,
    rightSidePanelVisible,
    rightSidePanelWidth,
    setBrowserDevToolsOpen,
    setBrowserMode,
    setBrowserSplitWidth,
    setEnvironmentPanelOpen,
    setHandoffInFlight,
    setIsHeaderHidden,
    setIsRevertingCheckpoint,
    setRightSidePanelDiffOpenState,
    setRightSidePanelEditorOpen,
    setRightSidePanelFloatingChatOpen,
    setRightSidePanelFullscreen,
    setRightSidePanelMode,
    setRightSidePanelReviewOpen,
    setRightSidePanelTerminalOpen,
    setRightSidePanelVisible,
    setRightSidePanelWidth,
    setShowScrollToBottom,
    setStoredBrowserSplitWidth,
    setStoredRightSidePanelWidth,
    setStoredWorkspaceEditorSplitWidth,
    setTerminalFocusRequestId,
    setWorkspaceEditorSplitWidth,
    setWorkspaceLayoutByThreadId,
    setWorkspaceModeByThreadId,
    showScrollToBottom,
    storedBrowserSplitWidth,
    storedRightSidePanelWidth,
    storedWorkspaceEditorSplitWidth,
    terminalFocusRequestId,
    workspaceEditorSplitWidth,
    workspaceLayoutByThreadId,
  } = useChatViewPersistentPanelState(threadId);
  const [bottomPanelMode, setBottomPanelMode] = useState<DockPanelMode | null>(null);
  const [bottomPanelBrowserOpen, setBottomPanelBrowserOpen] = useState(false);
  const [bottomPanelReviewOpen, setBottomPanelReviewOpen] = useState(false);
  const [bottomPanelContentDeferred, setBottomPanelContentDeferred] = useState(false);
  const [bottomPanelMotionActive, setBottomPanelMotionActive] = useState(false);
  const [bottomPanelResizing, setBottomPanelResizing] = useState(false);
  const [rightSidePanelContentDeferred, setRightSidePanelContentDeferred] = useState(false);
  const [rightSidePanelMotionActive, setRightSidePanelMotionActive] = useState(false);
  const [rightSidePanelResizing, setRightSidePanelResizing] = useState(false);
  const bottomPanelMotionActiveRef = useRef(false);
  const pendingBottomPanelTerminalOpenRef = useRef(false);
  const rightSidePanelMotionActiveRef = useRef(false);
  const beginRightSidePanelMotion = useStableCallback(() => {
    if (rightSidePanelMotionActiveRef.current) {
      return;
    }
    rightSidePanelMotionActiveRef.current = true;
    setRightSidePanelMotionActive(true);
    beginLayoutResizeInteraction();
  });
  const endRightSidePanelMotion = useStableCallback(() => {
    if (!rightSidePanelMotionActiveRef.current) {
      return;
    }
    rightSidePanelMotionActiveRef.current = false;
    setRightSidePanelMotionActive(false);
    setRightSidePanelContentDeferred(false);
    endLayoutResizeInteraction();
  });
  const windowStateInstanceId = resolveEditorWindowStateInstanceId();
  const workspaceEditorStateInstanceId = `workspace-${windowStateInstanceId}`;
  const rightPanelFallbackEditorStateInstanceId = `right-${windowStateInstanceId}`;
  const bottomPanelFallbackEditorStateInstanceId = `bottom-${windowStateInstanceId}`;
  const [rightPanelTabOrder, setRightPanelTabOrder] = useState<PanelTabOrderEntry[]>(() => [
    "summary",
    ...(rightSidePanelEditorOpen ? (["editor"] as const) : []),
    ...(rightSidePanelTerminalOpen ? (["terminal"] as const) : []),
  ]);
  const [bottomPanelTabOrder, setBottomPanelTabOrder] = useState<PanelTabOrderEntry[]>([]);
  const [rightPanelEditorTabs, setRightPanelEditorTabs] = useState<PanelEditorTab[]>(() =>
    rightSidePanelEditorOpen ? [createPanelEditorTab(rightPanelFallbackEditorStateInstanceId)] : [],
  );
  const [activeRightPanelEditorTabId, setActiveRightPanelEditorTabId] = useState<string | null>(
    () => (rightSidePanelEditorOpen ? (rightPanelEditorTabs[0]?.id ?? null) : null),
  );
  const [bottomPanelEditorTabs, setBottomPanelEditorTabs] = useState<PanelEditorTab[]>([]);
  const [activeBottomPanelEditorTabId, setActiveBottomPanelEditorTabId] = useState<string | null>(
    null,
  );
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const createWorktreeMutation = useMutation(gitCreateWorktreeMutationOptions({ queryClient }));
  const appendRightPanelTabOrder = useCallback((entry: PanelTabOrderEntry) => {
    setRightPanelTabOrder((current) => appendPanelTabOrder(current, entry));
  }, []);
  const removeRightPanelTabOrder = useCallback((mode: RightSidePanelMode) => {
    if (mode === "summary") return;
    setRightPanelTabOrder((current) => removePanelTabOrderByMode(current, mode));
  }, []);
  const appendBottomPanelTabOrder = useCallback((entry: PanelTabOrderEntry) => {
    setBottomPanelTabOrder((current) => appendPanelTabOrder(current, entry));
  }, []);
  const removeBottomPanelTabOrder = (mode: RightSidePanelMode) => {
    setBottomPanelTabOrder((current) => removePanelTabOrderByMode(current, mode));
  };
  const reorderRightPanelTabOrder = (nextVisibleOrder: ReadonlyArray<PanelTabOrderEntry>) => {
    setRightPanelTabOrder((current) => mergeVisiblePanelTabOrder(current, nextVisibleOrder));
  };
  const reorderBottomPanelTabOrder = (nextVisibleOrder: ReadonlyArray<PanelTabOrderEntry>) => {
    setBottomPanelTabOrder((current) => mergeVisiblePanelTabOrder(current, nextVisibleOrder));
  };
  const composerShellDraft = useComposerDraftStore(
    useShallow((store) => {
      const draft = store.draftsByThreadId[threadId];
      return {
        activeProvider: draft?.activeProvider ?? null,
        interactionMode: draft?.interactionMode ?? null,
        modelSelectionByProvider:
          draft?.modelSelectionByProvider ?? EMPTY_COMPOSER_MODEL_SELECTIONS,
        runtimeMode: draft?.runtimeMode ?? null,
      };
    }),
  );
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const promptRef = useRef("");
  const [expandedImageState, setExpandedImageState] = useState<{
    readonly threadId: ThreadId;
    readonly preview: ExpandedImagePreview;
  } | null>(null);
  const expandedImage =
    expandedImageState?.threadId === threadId ? expandedImageState.preview : null;
  const [optimisticUserMessagesState, setOptimisticUserMessagesState] = useState<{
    readonly threadId: ThreadId;
    readonly messages: readonly ChatMessage[];
  } | null>(null);
  const optimisticUserMessages =
    optimisticUserMessagesState?.threadId === threadId
      ? optimisticUserMessagesState.messages
      : EMPTY_CHAT_MESSAGES;
  const optimisticUserMessagesStateRef = useRef(optimisticUserMessagesState);
  useLayoutEffect(() => {
    optimisticUserMessagesStateRef.current = optimisticUserMessagesState;
  }, [optimisticUserMessagesState]);
  const setThreadOptimisticUserMessages = useStableCallback(
    (
      targetThreadId: ThreadId,
      updater: (existing: readonly ChatMessage[]) => readonly ChatMessage[],
    ) => {
      const previousState = optimisticUserMessagesStateRef.current;
      if (previousState && previousState.threadId !== targetThreadId) {
        for (const message of previousState.messages) {
          revokeUserMessagePreviewUrls(message);
        }
      }
      setOptimisticUserMessagesState((current) => {
        const existing =
          current?.threadId === targetThreadId ? current.messages : EMPTY_CHAT_MESSAGES;
        const next = updater(existing);
        return next.length === 0 ? null : { threadId: targetThreadId, messages: next };
      });
    },
  );
  const [threadEnvModeOverrideById, setThreadEnvModeOverrideById] = useState<
    Partial<Record<ThreadId, DraftThreadEnvMode>>
  >({});
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  useLayoutEffect(() => {
    optimisticUserMessagesRef.current = optimisticUserMessages;
  }, [optimisticUserMessages]);
  const [optimisticQueuedComposerState, setOptimisticQueuedComposerState] =
    useState<QueuedComposerState | null>(null);
  const optimisticQueuedComposerStateRef = useRef(optimisticQueuedComposerState);
  useLayoutEffect(() => {
    optimisticQueuedComposerStateRef.current = optimisticQueuedComposerState;
  }, [optimisticQueuedComposerState]);
  const [optimisticInactiveTurnState, setOptimisticInactiveTurnState] =
    useState<OptimisticInactiveTurnState | null>(null);
  const [optimisticQueuedDispatchState, setOptimisticQueuedDispatchState] =
    useState<OptimisticQueuedDispatchState | null>(null);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const isConnecting = false;
  const [chatViewTransientState, dispatchChatViewTransientState] = useReducer(
    chatViewTransientStateReducer,
    EMPTY_CHAT_VIEW_TRANSIENT_STATE,
  );
  const openSummaryOnNextThreadRef = useRef(false);
  const [chatViewDialogState, dispatchChatViewDialogState] = useReducer(
    chatViewDialogStateReducer,
    EMPTY_CHAT_VIEW_DIALOG_STATE,
  );
  const {
    gitHubIssueDialogOpen,
    gitHubIssueDialogInitialIssueNumber,
    gitHubIssueDialogInitialSelectedIssueNumbers,
    issuePreviewNumber,
    pullRequestDialogState,
    pendingPullRequestSetupRequest,
  } = chatViewDialogState;
  const {
    localDiffStateByThreadId,
    localDraftErrorsByThreadId,
    respondingRequestIds,
    respondingUserInputRequestIds,
    pendingUserInputAnswersByRequestId,
    pendingUserInputQuestionIndexByRequestId,
    expandedWorkGroupsByThreadId,
    attachmentPreviewHandoffByMessageId,
    pendingComposerCommentsByThreadId,
  } = chatViewTransientState;
  const setLocalDiffStateByThreadId = (
    localDiffStateByThreadId:
      | Record<ThreadId, LocalDiffState>
      | ((current: Record<ThreadId, LocalDiffState>) => Record<ThreadId, LocalDiffState>),
  ) => {
    dispatchChatViewTransientState({
      type: "set-local-diff-state-by-thread-id",
      localDiffStateByThreadId,
    });
  };
  const setLocalDraftErrorsByThreadId = (
    localDraftErrorsByThreadId:
      | Record<ThreadId, string | null>
      | ((current: Record<ThreadId, string | null>) => Record<ThreadId, string | null>),
  ) => {
    dispatchChatViewTransientState({
      type: "set-local-draft-errors-by-thread-id",
      localDraftErrorsByThreadId,
    });
  };
  const setRespondingRequestIds = (
    respondingRequestIds:
      | ApprovalRequestId[]
      | ((current: ApprovalRequestId[]) => ApprovalRequestId[]),
  ) => {
    dispatchChatViewTransientState({
      type: "set-responding-request-ids",
      respondingRequestIds,
    });
  };
  const setRespondingUserInputRequestIds = (
    respondingUserInputRequestIds:
      | ApprovalRequestId[]
      | ((current: ApprovalRequestId[]) => ApprovalRequestId[]),
  ) => {
    dispatchChatViewTransientState({
      type: "set-responding-user-input-request-ids",
      respondingUserInputRequestIds,
    });
  };
  const setPendingUserInputAnswersByRequestId = (
    pendingUserInputAnswersByRequestId:
      | Record<string, Record<string, PendingUserInputDraftAnswer>>
      | ((
          current: Record<string, Record<string, PendingUserInputDraftAnswer>>,
        ) => Record<string, Record<string, PendingUserInputDraftAnswer>>),
  ) => {
    dispatchChatViewTransientState({
      type: "set-pending-user-input-answers-by-request-id",
      pendingUserInputAnswersByRequestId,
    });
  };
  const setPendingUserInputQuestionIndexByRequestId = (
    pendingUserInputQuestionIndexByRequestId:
      | Record<string, number>
      | ((current: Record<string, number>) => Record<string, number>),
  ) => {
    dispatchChatViewTransientState({
      type: "set-pending-user-input-question-index-by-request-id",
      pendingUserInputQuestionIndexByRequestId,
    });
  };
  const setExpandedWorkGroupsByThreadId = (
    expandedWorkGroupsByThreadId:
      | Record<ThreadId, TimelineDisclosureExpansionState>
      | ((
          current: Record<ThreadId, TimelineDisclosureExpansionState>,
        ) => Record<ThreadId, TimelineDisclosureExpansionState>),
  ) => {
    dispatchChatViewTransientState({
      type: "set-expanded-work-groups-by-thread-id",
      expandedWorkGroupsByThreadId,
    });
  };
  const setAttachmentPreviewHandoffByMessageId = (
    attachmentPreviewHandoffByMessageId:
      | Record<string, string[]>
      | ((current: Record<string, string[]>) => Record<string, string[]>),
  ) => {
    dispatchChatViewTransientState({
      type: "set-attachment-preview-handoff-by-message-id",
      attachmentPreviewHandoffByMessageId,
    });
  };
  const setPendingComposerCommentsByThreadId = (
    pendingComposerCommentsByThreadId:
      | Record<ThreadId, PendingComposerComment[]>
      | ((
          current: Record<ThreadId, PendingComposerComment[]>,
        ) => Record<ThreadId, PendingComposerComment[]>),
  ) => {
    dispatchChatViewTransientState({
      type: "set-pending-composer-comments-by-thread-id",
      pendingComposerCommentsByThreadId,
    });
  };
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const previousThreadIdRef = useRef<ThreadId | null>(null);
  const pendingInitialBottomScrollThreadIdRef = useRef<ThreadId | null>(null);
  const pendingInitialBottomPinFrameRef = useRef<number | null>(null);
  const pendingInitialBottomPinResizeObserverRef = useRef<ResizeObserver | null>(null);
  const lastKnownScrollTopRef = useRef(0);
  const isPointerScrollActiveRef = useRef(false);
  const lastTouchClientYRef = useRef<number | null>(null);
  const pendingUserScrollUpIntentRef = useRef(false);
  const pendingAutoScrollFrameRef = useRef<number | null>(null);
  const showScrollToBottomRef = useRef(showScrollToBottom);
  const pendingShowScrollToBottomFrameRef = useRef<number | null>(null);
  const pendingShowScrollToBottomValueRef = useRef<boolean | null>(null);
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewHandoffTimeoutByMessageIdRef = useRef<Record<string, number>>({});
  const pendingInterruptStopFallbackRef = useRef<number | null>(null);
  const sendInFlightRef = useRef(false);
  const [sendInFlight, setSendInFlight] = useState(false);
  const setSendInFlightState = useStableCallback((value: boolean) => {
    sendInFlightRef.current = value;
    setSendInFlight(value);
  });
  const queuedDesignMessageEditRef = useRef<QueuedComposerMessage | null>(null);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});
  const composerPanelsRef = useRef<ConnectedChatComposerPanelsHandle>(null);
  const subagentComposerPanelsRef = useRef<ConnectedChatComposerPanelsHandle>(null);
  const chatShellRef = useRef<HTMLDivElement | null>(null);
  const [chatShellElement, setChatShellElement] = useState<HTMLDivElement | null>(null);
  const setChatShellRef = useStableCallback((element: HTMLDivElement | null) => {
    chatShellRef.current = element;
    setChatShellElement(element);
  });
  useEffect(() => {
    showScrollToBottomRef.current = showScrollToBottom;
  }, [showScrollToBottom]);
  const setShowScrollToBottomIfChanged = useStableCallback((nextVisible: boolean) => {
    pendingShowScrollToBottomValueRef.current = null;
    if (showScrollToBottomRef.current === nextVisible) {
      return;
    }
    showScrollToBottomRef.current = nextVisible;
    setShowScrollToBottom(nextVisible);
  });
  const scheduleShowScrollToBottom = useStableCallback((nextVisible: boolean) => {
    pendingShowScrollToBottomValueRef.current = nextVisible;
    if (pendingShowScrollToBottomFrameRef.current !== null) {
      return;
    }
    pendingShowScrollToBottomFrameRef.current = window.requestAnimationFrame(() => {
      pendingShowScrollToBottomFrameRef.current = null;
      const scheduledVisible =
        pendingShowScrollToBottomValueRef.current ?? showScrollToBottomRef.current;
      setShowScrollToBottomIfChanged(scheduledVisible);
    });
  });
  const cancelPendingShowScrollToBottom = useStableCallback(() => {
    const pendingFrame = pendingShowScrollToBottomFrameRef.current;
    pendingShowScrollToBottomValueRef.current = null;
    if (pendingFrame === null) {
      return;
    }
    pendingShowScrollToBottomFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  });
  const setMessagesScrollContainerRef = useStableCallback((element: HTMLDivElement | null) => {
    if (messagesScrollRef.current === element) {
      return;
    }
    messagesScrollRef.current = element;
    if (!element || pendingInitialBottomScrollThreadIdRef.current !== threadId) {
      return;
    }
    scrollContainerToBottom(element);
    lastKnownScrollTopRef.current = element.scrollTop;
    shouldAutoScrollRef.current = true;
    pendingUserScrollUpIntentRef.current = false;
    setShowScrollToBottomIfChanged(false);
  });
  const getMessagesScrollContainer = useStableCallback(() => messagesScrollRef.current);
  useEffect(() => {
    const syncComposerDraftRefs = (state: ReturnType<typeof useComposerDraftStore.getState>) => {
      const draft = getComposerThreadDraftState(state, threadId);
      promptRef.current = draft.prompt;
      composerImagesRef.current = draft.images;
      composerTerminalContextsRef.current = draft.terminalContexts;
      if (
        draft.prompt.length === 0 &&
        draft.images.length === 0 &&
        draft.terminalContexts.length === 0 &&
        !sendInFlightRef.current
      ) {
        queuedDesignMessageEditRef.current = null;
      }
    };

    syncComposerDraftRefs(useComposerDraftStore.getState());
    return useComposerDraftStore.subscribe(syncComposerDraftRefs);
  }, [threadId]);

  // Terminal state and callbacks are provided by useChatViewTerminalState hook below.

  // setPrompt, addComposerImagesToDraft, addComposerTerminalContextsToDraft,
  // pendingComposerComments, dismissPendingComposerComment, clearPendingComposerComments
  // are provided by useChatViewComposerActions hook below.
  const addDiffReviewComment = (comment: DiffReviewCommentInput) => {
    const body = comment.body.trim();
    if (!body) {
      return;
    }
    const hiddenContextBlock = [
      "<diff_review_context>",
      JSON.stringify(
        {
          cwd: comment.cwd,
          filePath: comment.filePath,
          previousFilePath: comment.previousFilePath,
          scope: comment.scopeLabel,
          changeType: comment.changeType,
          additions: comment.additions,
          deletions: comment.deletions,
          hunkCount: comment.hunkCount,
          lineRange: comment.lineRange,
        },
        null,
        2,
      ),
      "</diff_review_context>",
    ].join("\n");
    setPendingComposerCommentsByThreadId((current) => ({
      ...current,
      [threadId]: [
        ...(current[threadId] ?? []),
        {
          id: randomUUID(),
          source: "review",
          body,
          targetLabel: `${comment.filePath} ${comment.lineRange.label}`,
          detailLabel: comment.scopeLabel,
          hiddenContextBlock,
          createdAt: new Date().toISOString(),
        },
      ],
    }));
    toastManager.add({
      type: "success",
      title: "Review comment added",
      description: "It will be sent with your next message.",
    });
  };

  const threadConnectionUrl = useThreadConnectionUrl(threadId);
  const projectConnectionUrl = useProjectConnectionUrl(
    serverThread?.projectId ?? draftThread?.projectId,
  );
  const routeConnectionUrl = (() => {
    const value = new URLSearchParams(locationSearch)
      .get(THREAD_ROUTE_CONNECTION_SEARCH_PARAM)
      ?.trim();
    if (!value) {
      return null;
    }
    try {
      return normalizeWsUrl(value);
    } catch {
      return null;
    }
  })();
  const activeServerConnectionUrl = resolveThreadOriginConnectionUrl({
    explicitConnectionUrl: connectionUrl,
    projectConnectionUrl,
    routeConnectionUrl,
    threadConnectionUrl,
  });
  const resolveBrowserThreadConnectionUrl = (browserThreadId: ThreadId): string => {
    const browserThread =
      browserThreadId === threadId
        ? (serverThread ?? draftThread ?? null)
        : (getThreadById(useStore.getState().threads, browserThreadId) ?? null);
    const hostConnections = useHostConnectionStore.getState();
    return resolveThreadOriginConnectionUrl({
      explicitConnectionUrl: browserThreadId === threadId ? connectionUrl : null,
      projectConnectionUrl:
        browserThread?.projectId != null
          ? (hostConnections.projectConnectionById[browserThread.projectId] ?? null)
          : null,
      routeConnectionUrl,
      threadConnectionUrl: hostConnections.threadConnectionById[browserThreadId] ?? null,
    });
  };
  const fallbackDraftProject = useProjectById(draftThread?.projectId);
  const localDraftError = serverThread ? null : (localDraftErrorsByThreadId[threadId] ?? null);
  const connectionServerConfig = useConnectionServerConfig(activeServerConnectionUrl);
  const providerStatuses = connectionServerConfig?.providers ?? EMPTY_PROVIDER_STATUSES;
  const providerSettings =
    connectionServerConfig?.settings.providers ?? DEFAULT_UNIFIED_SETTINGS.providers;
  const modelSettings = { providers: providerSettings };
  const localDraftThread = draftThread
    ? buildLocalDraftThread(
        threadId,
        draftThread,
        fallbackDraftProject?.defaultModelSelection ?? {
          provider: "codex",
          model: getDefaultServerModel(providerStatuses, "codex"),
        },
        localDraftError,
      )
    : undefined;
  const activeThread = serverThread ?? localDraftThread;
  const { runtimeMode, interactionMode } = deriveEffectiveComposerExecutionModeState({
    draft: composerShellDraft,
    threadRuntimeMode: activeThread?.runtimeMode ?? null,
    threadInteractionMode: activeThread?.interactionMode ?? null,
  });
  const isServerThread = serverThread !== undefined;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const activeThreadLineageSourceThreadId =
    isServerThread && activeThread ? resolveThreadLineageSourceThreadId(activeThread) : null;
  const handoffLineageSelector = createHandoffLineageSelector(activeThreadLineageSourceThreadId);
  const handoffLineage = useStore(handoffLineageSelector);
  const lineageSourceThreadIds = useMemo(
    () => handoffLineage?.threads.map((thread) => thread.id) ?? [],
    [handoffLineage],
  );
  const handoffMissingThreadId = handoffLineage?.missingThreadId ?? null;
  const handoffHasCycle = handoffLineage?.hasCycle ?? false;
  const isThreadHistoryMetadataOnly = isServerThread && activeThread?.historyLoaded === false;
  const activeThreadTimelineViewModel = useThreadTimelineViewModel({
    threadId,
    enabled: isServerThread,
    surface: splitPane ? "board" : "chat",
    buildRows: false,
  });
  const activeThreadTimelineRevision = activeThreadTimelineViewModel.revision;
  const activeThreadTimelineCompleteSnapshot = activeThreadTimelineViewModel.completeSnapshot;
  const activeThreadTimelineProjection = activeThreadTimelineViewModel.projection;
  useEffect(() => {
    if (
      !ownsGlobalSideEffects ||
      !isServerThread ||
      !activeThread?.id ||
      isThreadLiveWorkActive(activeThread)
    ) {
      return;
    }
    const prefetch = startThreadTimelineRowsOpenPrefetch({
      threadId: activeThread.id,
      priority: "immediate",
    });
    void prefetch.done.catch((error) => {
      console.error("Failed to prefetch active thread timeline", error);
    });
    return () => {
      prefetch.stop();
    };
  }, [activeThread, activeThread?.id, isServerThread, ownsGlobalSideEffects]);
  const canCheckoutPullRequestIntoThread = isLocalDraftThread;
  const routeWorkspaceMode: ThreadWorkspaceMode =
    !splitPane && (rawSearch.mode === "editor" || rawSearch.mode === "split")
      ? rawSearch.mode
      : "chat";
  const localDiffState = localDiffStateByThreadId[threadId] ?? DEFAULT_LOCAL_DIFF_STATE;
  const setLocalDiffState = useCallback(
    (nextState: LocalDiffState | ((state: LocalDiffState) => LocalDiffState)) => {
      setLocalDiffStateByThreadId((previous) => {
        const current = previous[threadId] ?? DEFAULT_LOCAL_DIFF_STATE;
        const resolved =
          typeof nextState === "function"
            ? (nextState as (state: LocalDiffState) => LocalDiffState)(current)
            : nextState;
        if (
          current.filePath === resolved.filePath &&
          current.open === resolved.open &&
          current.turnId === resolved.turnId
        ) {
          return previous;
        }
        return {
          ...previous,
          [threadId]: resolved,
        };
      });
    },
    [threadId],
  );
  const rightSidePanelEnabled = true;
  const rightSidePanelInteractive = rightSidePanelEnabled;
  const effectiveRightSidePanelMode = rightSidePanelEnabled
    ? (rightSidePanelMode ?? "summary")
    : null;
  const diffOpen = rightSidePanelEnabled ? rightSidePanelDiffOpen : false;
  const rightSidePanelOpen = rightSidePanelEnabled && rightSidePanelVisible;
  const activeThreadId = activeThread?.id ?? null;
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const sourceProposedPlanThreadId = activeLatestTurn?.sourceProposedPlan?.threadId ?? null;

  useEffect(() => {
    if (!rightSidePanelOpen || !rightSidePanelContentDeferred) return;
    const timer = window.setTimeout(() => {
      if (rightSidePanelMotionActiveRef.current) {
        endRightSidePanelMotion();
        return;
      }
      setRightSidePanelContentDeferred(false);
    }, PANEL_CONTENT_DEFER_FALLBACK_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [endRightSidePanelMotion, rightSidePanelContentDeferred, rightSidePanelOpen]);
  const sourcePlanThread = useThreadById(sourceProposedPlanThreadId);
  const sourcePlanHydrationInFlightRef = useRef<ThreadId | null>(null);
  const handoffHydrationInFlightRef = useRef<Set<ThreadId>>(null!);
  if (handoffHydrationInFlightRef.current === null) {
    handoffHydrationInFlightRef.current = new Set<ThreadId>();
  }
  const recentThreadHistoryKeepId =
    trackedActiveThreadId === activeThreadId ? previousActiveThreadId : trackedActiveThreadId;
  const recentThreadHistoryThread = useThreadById(recentThreadHistoryKeepId);
  const recentThreadHistoryHydrationInFlightRef = useRef<ThreadId | null>(null);
  const hydratedThreadHistoryKeepIds = deriveHydratedThreadHistoryKeepIds({
    activeThreadId,
    sourceProposedPlanThreadId,
    previousThreadId: recentThreadHistoryKeepId,
    lineageSourceThreadIds,
    additionalThreadIds: [
      ...visibleBoardThreadIds,
      ...deriveRecentlyVisitedThreadHistoryKeepIds({
        activeThreadId,
        threadLastVisitedAtById,
        maxCount: RECENT_HYDRATED_THREAD_HISTORY_KEEP_COUNT,
      }),
    ],
  });
  const memoryPressureHydratedThreadHistoryKeepIds = deriveHydratedThreadHistoryKeepIds({
    activeThreadId,
    sourceProposedPlanThreadId,
    previousThreadId: null,
    lineageSourceThreadIds,
    additionalThreadIds: visibleBoardThreadIds,
  });
  const criticalHydratedThreadHistoryKeepIds = deriveHydratedThreadHistoryKeepIds({
    activeThreadId,
    sourceProposedPlanThreadId: null,
    previousThreadId: null,
    lineageSourceThreadIds,
    additionalThreadIds: visibleBoardThreadIds,
  });

  // Update this before the next interaction so rapid thread switches keep the just-viewed history warm.
  useLayoutEffect(() => {
    if (!ownsGlobalSideEffects) return;
    trackActiveThread(activeThreadId);
  }, [activeThreadId, ownsGlobalSideEffects, trackActiveThread]);

  useEffect(() => {
    if (
      !recentThreadHistoryKeepId ||
      recentThreadHistoryKeepId === activeThreadId ||
      recentThreadHistoryThread === undefined ||
      recentThreadHistoryThread.historyLoaded !== false ||
      isThreadLiveWorkActive(recentThreadHistoryThread)
    ) {
      return;
    }

    if (recentThreadHistoryHydrationInFlightRef.current === recentThreadHistoryKeepId) {
      return;
    }

    recentThreadHistoryHydrationInFlightRef.current = recentThreadHistoryKeepId;
    let canceled = false;
    const prefetch = startThreadTimelineRowsOpenPrefetch({
      threadId: recentThreadHistoryKeepId,
      priority: "background",
    });
    void (async () => {
      try {
        await prefetch.done;
      } catch (error) {
        if (!canceled) {
          console.error("Failed to prefetch recent thread timeline", error);
        }
      }
      if (
        !canceled &&
        recentThreadHistoryHydrationInFlightRef.current === recentThreadHistoryKeepId
      ) {
        recentThreadHistoryHydrationInFlightRef.current = null;
      }
    })();

    return () => {
      canceled = true;
      prefetch.stop();
      if (recentThreadHistoryHydrationInFlightRef.current === recentThreadHistoryKeepId) {
        recentThreadHistoryHydrationInFlightRef.current = null;
      }
    };
  }, [activeThreadId, recentThreadHistoryKeepId, recentThreadHistoryThread]);

  useEffect(() => {
    if (hydratedThreadHistoryKeepIds.length === 0) {
      return;
    }
    pruneHydratedThreadHistories(hydratedThreadHistoryKeepIds);
  }, [hydratedThreadHistoryKeepIds, pruneHydratedThreadHistories]);
  useEffect(() => {
    if (memoryPressureHydratedThreadHistoryKeepIds.length === 0) {
      return;
    }

    return subscribeToMemoryPressure((snapshot) => {
      if (snapshot === null || !isMemoryPressureAtLeast("high", snapshot)) {
        return;
      }
      pruneHydratedThreadHistories(
        snapshot.level === "critical"
          ? criticalHydratedThreadHistoryKeepIds
          : memoryPressureHydratedThreadHistoryKeepIds,
      );
    });
  }, [
    criticalHydratedThreadHistoryKeepIds,
    memoryPressureHydratedThreadHistoryKeepIds,
    pruneHydratedThreadHistories,
  ]);
  const threadPlanCatalogThreadIds: ThreadId[] = [];
  if (activeThread?.id) {
    threadPlanCatalogThreadIds.push(activeThread.id);
  }
  if (sourceProposedPlanThreadId && sourceProposedPlanThreadId !== activeThread?.id) {
    threadPlanCatalogThreadIds.push(sourceProposedPlanThreadId);
  }
  const threadPlanCatalog = useThreadPlanCatalog(threadPlanCatalogThreadIds);
  useEffect(() => {
    if (
      sourceProposedPlanThreadId === null ||
      sourceProposedPlanThreadId === activeThread?.id ||
      sourcePlanThread === undefined ||
      sourcePlanThread.historyLoaded !== false ||
      isThreadLiveWorkActive(sourcePlanThread)
    ) {
      return;
    }

    if (sourcePlanHydrationInFlightRef.current === sourceProposedPlanThreadId) {
      return;
    }

    sourcePlanHydrationInFlightRef.current = sourceProposedPlanThreadId;
    let canceled = false;
    const prefetch = startThreadTimelineRowsOpenPrefetch({
      threadId: sourceProposedPlanThreadId,
      priority: "background",
    });
    void (async () => {
      try {
        await prefetch.done;
      } catch (error) {
        if (!canceled) {
          console.error("Failed to prefetch source proposed-plan timeline", error);
        }
      }
      if (!canceled && sourcePlanHydrationInFlightRef.current === sourceProposedPlanThreadId) {
        sourcePlanHydrationInFlightRef.current = null;
      }
    })();

    return () => {
      canceled = true;
      prefetch.stop();
      if (sourcePlanHydrationInFlightRef.current === sourceProposedPlanThreadId) {
        sourcePlanHydrationInFlightRef.current = null;
      }
    };
  }, [activeThread?.id, sourcePlanThread, sourceProposedPlanThreadId]);

  useEffect(() => {
    if (!activeThreadLineageSourceThreadId || !isServerThread || handoffHasCycle) {
      return;
    }

    if (lineageSourceThreadIds.length === 0 && handoffMissingThreadId === null) {
      return;
    }

    let canceled = false;
    const pendingThreadIds = new Set(lineageSourceThreadIds);
    if (handoffMissingThreadId) {
      pendingThreadIds.add(handoffMissingThreadId);
    }
    const handoffHydrationInFlight = handoffHydrationInFlightRef.current;
    const prefetches: Array<ReturnType<typeof startThreadTimelineRowsOpenPrefetch>> = [];

    for (const threadIdToHydrate of pendingThreadIds) {
      const thread = getThreadById(useStore.getState().threads, threadIdToHydrate);
      if (thread && thread.historyLoaded !== false) {
        continue;
      }
      if (isThreadLiveWorkActive(thread)) {
        continue;
      }
      if (handoffHydrationInFlight.has(threadIdToHydrate)) {
        continue;
      }
      handoffHydrationInFlight.add(threadIdToHydrate);
      const prefetch = startThreadTimelineRowsOpenPrefetch({
        threadId: threadIdToHydrate,
        priority: "background",
      });
      prefetches.push(prefetch);
      void (async () => {
        try {
          await prefetch.done;
        } catch (error) {
          if (!canceled) {
            console.error("Failed to prefetch handoff timeline", error);
          }
        }
        handoffHydrationInFlight.delete(threadIdToHydrate);
      })();
    }

    return () => {
      canceled = true;
      for (const prefetch of prefetches) {
        prefetch.stop();
      }
      for (const threadIdToHydrate of pendingThreadIds) {
        handoffHydrationInFlight.delete(threadIdToHydrate);
      }
    };
  }, [
    activeThreadLineageSourceThreadId,
    handoffHasCycle,
    handoffMissingThreadId,
    lineageSourceThreadIds,
    isServerThread,
  ]);
  const rawLatestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const rawLiveTurnInProgress = hasLiveTurn(activeLatestTurn, activeThread?.session ?? null);
  const optimisticInactiveTurnActive = optimisticInactiveTurnCoversLiveTurn({
    state: optimisticInactiveTurnState,
    thread: activeThread,
    latestTurn: activeLatestTurn,
    rawLiveTurnInProgress,
  });
  const latestTurnSettled = optimisticInactiveTurnActive ? true : rawLatestTurnSettled;
  const liveTurnInProgress = rawLiveTurnInProgress && !optimisticInactiveTurnActive;
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnosticsFocus, setDiagnosticsFocus] = useState<"connection" | "provider" | "thread">(
    "connection",
  );
  const [stuckTurnNow, setStuckTurnNow] = useState(() => Date.now());
  useEffect(() => {
    if (!reliabilityUxEnabled || !liveTurnInProgress) {
      return;
    }
    const timer = window.setInterval(() => setStuckTurnNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [liveTurnInProgress, reliabilityUxEnabled]);
  const visibleDiagnosticsOpen = reliabilityUxEnabled && diagnosticsOpen;
  const activeProject = useProjectById(activeThread?.projectId);
  const activeProjectId = activeProject?.id ?? null;
  const activeRemoteHost =
    loadRemoteHostInstances().find(
      (host) => resolveHostConnectionWsUrl(host) === activeServerConnectionUrl,
    ) ?? null;
  useEffect(() => {
    if (!activeForSideEffects) {
      return;
    }
    if (!activeThread?.id) {
      return;
    }
    const store = useHostConnectionStore.getState();
    store.upsertThreadOwnership(activeServerConnectionUrl, activeThread.id);
  }, [activeForSideEffects, activeServerConnectionUrl, activeThread?.id]);
  useEffect(() => {
    if (!activeForSideEffects) {
      return;
    }
    if (!activeProjectId) {
      return;
    }
    useHostConnectionStore
      .getState()
      .upsertProjectOwnership(activeServerConnectionUrl, activeProjectId);
  }, [activeForSideEffects, activeProjectId, activeServerConnectionUrl]);
  const activeEnvironmentIcon =
    activeRemoteHost && (activeRemoteHost.iconGlyph || activeRemoteHost.iconColor)
      ? {
          glyph: activeRemoteHost.iconGlyph ?? "folder",
          color: activeRemoteHost.iconColor ?? "slate",
        }
      : null;
  const handleActiveProjectChange = (projectId: ProjectId) => {
    void handleNewThread(projectId, {
      ...resolveSidebarNewThreadOptions({
        projectId,
        defaultEnvMode: defaultThreadEnvMode,
        activeThread:
          currentRouteThread && currentRouteThread.projectId === projectId
            ? {
                projectId: currentRouteThread.projectId,
                branch: currentRouteThread.branch,
                worktreePath: currentRouteThread.worktreePath,
              }
            : null,
        activeDraftThread:
          currentRouteDraftThread && currentRouteDraftThread.projectId === projectId
            ? {
                projectId: currentRouteDraftThread.projectId,
                branch: currentRouteDraftThread.branch,
                worktreePath: currentRouteDraftThread.worktreePath,
                envMode: currentRouteDraftThread.envMode,
              }
            : null,
      }),
    });
  };
  const serverQueuedComposerMessages =
    serverThread?.queuedComposerMessages ?? EMPTY_QUEUED_COMPOSER_MESSAGES;
  const serverQueuedSteerRequest = serverThread?.queuedSteerRequest ?? null;
  const activeOptimisticQueuedComposerState = (() => {
    const optimisticState = optimisticQueuedComposerState;
    if (!optimisticState || optimisticState.threadId !== serverThread?.id) {
      return null;
    }
    return queuedComposerStateMatches(
      optimisticState,
      serverQueuedComposerMessages,
      serverQueuedSteerRequest,
    )
      ? null
      : optimisticState;
  })();
  const queuedComposerMessages = (activeOptimisticQueuedComposerState?.messages ??
    serverQueuedComposerMessages) as QueuedComposerMessage[];
  const queuedSteerRequest =
    activeOptimisticQueuedComposerState?.steerRequest ?? serverQueuedSteerRequest;
  const optimisticQueuedDispatchMessageId = (() => {
    const dispatchState = optimisticQueuedDispatchState;
    if (dispatchState === null || dispatchState.threadId !== serverThread?.id) {
      return null;
    }
    return queuedComposerMessages.some((message) => message.id === dispatchState.messageId)
      ? dispatchState.messageId
      : null;
  })();
  const queuedComposerMessagesRef = useRef(queuedComposerMessages);
  const queuedSteerRequestRef = useRef(queuedSteerRequest);
  useLayoutEffect(() => {
    queuedComposerMessagesRef.current = queuedComposerMessages;
  }, [queuedComposerMessages]);
  useLayoutEffect(() => {
    queuedSteerRequestRef.current = queuedSteerRequest;
  }, [queuedSteerRequest]);
  const captureQueuedComposerState = (targetThreadId: ThreadId): QueuedComposerState | null => {
    if (serverThread?.id !== targetThreadId) {
      return null;
    }
    const optimisticState = optimisticQueuedComposerStateRef.current;
    if (
      optimisticState?.threadId === targetThreadId &&
      !queuedComposerStateMatches(
        optimisticState,
        serverQueuedComposerMessages,
        serverQueuedSteerRequest,
      )
    ) {
      return optimisticState;
    }
    return {
      threadId: targetThreadId,
      messages: serverQueuedComposerMessages,
      steerRequest: serverQueuedSteerRequest,
    };
  };
  const commitOptimisticQueuedComposerState = (nextState: QueuedComposerState) => {
    setOptimisticQueuedComposerState(nextState);
    window.setTimeout(() => {
      setOptimisticQueuedComposerState((current) => (current === nextState ? null : current));
    }, OPTIMISTIC_QUEUE_STATE_MAX_AGE_MS);
  };
  const applyOptimisticQueuedComposerState = (
    targetThreadId: ThreadId,
    updater: (state: QueuedComposerState) => QueuedComposerState,
  ): QueuedComposerState | null => {
    const previousState = captureQueuedComposerState(targetThreadId);
    if (!previousState) {
      return null;
    }
    const nextState = updater(previousState);
    commitOptimisticQueuedComposerState(nextState);
    return previousState;
  };
  const restoreOptimisticQueuedComposerState = (state: QueuedComposerState | null) => {
    if (state) {
      commitOptimisticQueuedComposerState(state);
    }
  };

  const pullRequestDialogKeyRef = useRef(0);
  const openPullRequestDialog = (reference?: string) => {
    if (!canCheckoutPullRequestIntoThread) {
      return;
    }
    pullRequestDialogKeyRef.current += 1;
    dispatchChatViewDialogState({
      type: "open-pull-request-dialog",
      pullRequestDialogState: {
        initialReference: reference ?? null,
        key: pullRequestDialogKeyRef.current,
      },
    });
    composerPanelsRef.current?.resetUi();
  };

  const closePullRequestDialog = () => {
    dispatchChatViewDialogState({ type: "close-pull-request-dialog" });
  };

  const openGitHubIssueDialog = useStableCallback(
    (options?: {
      initialIssueNumber?: number | null;
      initialSelectedIssueNumbers?: ReadonlyArray<number>;
    }) => {
      dispatchChatViewDialogState({
        type: "open-github-issue-dialog",
        gitHubIssueDialogInitialIssueNumber: options?.initialIssueNumber ?? null,
        gitHubIssueDialogInitialSelectedIssueNumbers: [
          ...(options?.initialSelectedIssueNumbers ?? []),
        ],
      });
      composerPanelsRef.current?.resetUi();
    },
  );

  const closeGitHubIssueDialog = () => {
    dispatchChatViewDialogState({ type: "close-github-issue-dialog" });
  };

  const openRightSidePanelDiff = useEffectEvent(() => {
    setRightSidePanelDiffOpenState(true);
    setRightSidePanelReviewOpen(true);
    setLocalDiffState((previous) => ({ ...previous, open: true }));
  });

  const ensureWorkspaceEditorPanelVisible = useEffectEvent(() => {
    setRightSidePanelEditorOpen(true);
    setRightSidePanelMode("editor");
    setRightSidePanelVisible(true);
  });

  const resetThreadScopedUi = useEffectEvent(() => {
    if (
      gitHubIssueDialogOpen ||
      gitHubIssueDialogInitialIssueNumber !== null ||
      gitHubIssueDialogInitialSelectedIssueNumbers.length > 0
    ) {
      closeGitHubIssueDialog();
    }
    if (pullRequestDialogState !== null) {
      dispatchChatViewDialogState({ type: "close-pull-request-dialog" });
    }
  });

  const onComposerIssueTokenClick = (issueNumber: number) => {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return;
    }
    dispatchChatViewDialogState({
      type: "set-issue-preview-number",
      issuePreviewNumber: issueNumber,
    });
  };

  const openOrReuseProjectDraftThread = async (input: {
    branch: string;
    worktreePath: string | null;
    envMode: DraftThreadEnvMode;
  }) => {
    if (!activeProject) {
      throw new Error("No active project is available for this pull request.");
    }
    const storedDraftThread = getDraftThreadByProjectId(activeProject.id);
    if (storedDraftThread) {
      setDraftThreadContext(storedDraftThread.threadId, input);
      setProjectDraftThreadId(activeProject.id, storedDraftThread.threadId, input);
      if (storedDraftThread.threadId !== threadId) {
        await navigate({
          to: "/$threadId",
          params: { threadId: storedDraftThread.threadId },
        });
      }
      return storedDraftThread.threadId;
    }

    const activeDraftThread = getDraftThread(threadId);
    if (!isServerThread && activeDraftThread?.projectId === activeProject.id) {
      setDraftThreadContext(threadId, input);
      setProjectDraftThreadId(activeProject.id, threadId, input);
      return threadId;
    }

    clearProjectDraftThreadId(activeProject.id);
    const nextThreadId = newThreadId();
    setProjectDraftThreadId(activeProject.id, nextThreadId, {
      createdAt: new Date().toISOString(),
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_INTERACTION_MODE,
      ...input,
    });
    await navigate({
      to: "/$threadId",
      params: { threadId: nextThreadId },
    });
    return nextThreadId;
  };

  const handlePreparedPullRequestThread = async (input: {
    branch: string;
    worktreePath: string | null;
  }) => {
    const targetThreadId = await openOrReuseProjectDraftThread({
      branch: input.branch,
      worktreePath: input.worktreePath,
      envMode: input.worktreePath ? "worktree" : "local",
    });
    const setupScript =
      input.worktreePath && activeProject ? setupProjectScript(activeProject.scripts) : null;
    if (targetThreadId && input.worktreePath && setupScript) {
      dispatchChatViewDialogState({
        type: "set-pending-pull-request-setup-request",
        pendingPullRequestSetupRequest: {
          threadId: targetThreadId,
          worktreePath: input.worktreePath,
          scriptId: setupScript.id,
        },
      });
    } else {
      dispatchChatViewDialogState({
        type: "set-pending-pull-request-setup-request",
        pendingPullRequestSetupRequest: null,
      });
    }
  };

  useEffect(() => {
    if (!activeForSideEffects) return;
    if (!serverThread?.id) return;
    markThreadVisited(serverThread.id);
  }, [activeForSideEffects, markThreadVisited, serverThread?.id]);

  useEffect(() => {
    if (!activeForSideEffects) return;
    if (!serverThread?.id) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnCompletedAt)) return;
    const lastVisitedAt = activeThreadLastVisitedAt ? Date.parse(activeThreadLastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= turnCompletedAt) return;

    markThreadVisited(serverThread.id);
  }, [
    activeLatestTurn?.completedAt,
    activeThreadLastVisitedAt,
    activeForSideEffects,
    latestTurnSettled,
    markThreadVisited,
    serverThread?.id,
  ]);

  const hasThreadStarted = threadHasStarted(activeThread);
  const {
    activeProviderStatus,
    composerModelOptions,
    handoffTargetProviders,
    lockedProvider,
    modelOptionsByProvider,
    selectedModel,
    selectedModelForPickerWithCustomFallback,
    selectedModelSelection,
    selectedProvider,
    selectedProviderModels,
  } = useChatViewProviderSelectionState({
    draft: composerShellDraft,
    hasThreadStarted,
    isServerThread,
    lockProvider: Boolean(activeThread?.fork),
    modelSettings,
    projectModelSelection: activeProject?.defaultModelSelection,
    providers: providerStatuses,
    sessionProvider: activeThread?.session?.provider ?? null,
    threadModelSelection: activeThread?.modelSelection,
  });
  const providerInstancesByProvider = {
    codex: modelSettings.providers.codex.instances,
    claudeAgent: modelSettings.providers.claudeAgent.instances,
    githubCopilot: modelSettings.providers.githubCopilot.instances,
    cursor: modelSettings.providers.cursor.instances,
    pi: modelSettings.providers.pi.instances,
    gemini: modelSettings.providers.gemini.instances,
    opencode: modelSettings.providers.opencode.instances,
  };
  const commandProvider = activeThread?.session?.provider ?? selectedProvider;
  const selectedProviderCommands =
    providerStatuses.find((provider) => provider.provider === commandProvider)?.commands ?? [];
  const composerProviderCommands = mergeProviderSlashCommands(
    activeThread?.session?.commands,
    selectedProviderCommands,
    providerFallbackSlashCommands(commandProvider),
  );
  const readCurrentSelectedPromptEffort = () => {
    return getComposerProviderState({
      provider: selectedProvider,
      model: selectedModel,
      models: selectedProviderModels,
      prompt: promptRef.current,
      modelOptions: composerModelOptions,
    }).promptEffort;
  };
  const timelineProjectionActivities = activeThreadTimelineProjection?.activities ?? null;
  const timelineProjectionProposedPlans = activeThreadTimelineProjection?.proposedPlans ?? null;
  const activeThreadProposedPlans =
    timelineProjectionProposedPlans ?? activeThread?.proposedPlans ?? EMPTY_PROPOSED_PLANS;
  const activeContextWindow = hasThreadStarted
    ? deriveLatestContextWindowSnapshot(
        timelineProjectionActivities ?? activeThread?.activities ?? [],
      )
    : null;
  const phase = derivePhase(activeThread?.session ?? null);
  const threadActivities =
    timelineProjectionActivities ?? activeThread?.activities ?? EMPTY_ACTIVITIES;
  const activityVisibilitySettings = {
    enableToolStreaming,
    enableThinkingStreaming,
  };
  const { visibleThreadActivities, workLogEntries, pendingApprovals, pendingUserInputs } =
    deriveThreadActivityRenderState(threadActivities, activityVisibilitySettings);
  const activeWorkTurnId = deriveVisibleWorkTurnId(
    activeLatestTurn,
    activeThread?.session ?? null,
    visibleThreadActivities,
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = activePendingUserInput
    ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
      EMPTY_PENDING_USER_INPUT_ANSWERS)
    : EMPTY_PENDING_USER_INPUT_ANSWERS;
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = activePendingUserInput
    ? derivePendingUserInputProgress(
        activePendingUserInput.questions,
        activePendingDraftAnswers,
        activePendingQuestionIndex,
      )
    : null;
  const activePendingResolvedAnswers = activePendingUserInput
    ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
    : null;
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activeProposedPlan = latestTurnSettled
    ? findLatestProposedPlan(activeThreadProposedPlans, activeLatestTurn?.turnId ?? null)
    : null;
  const sidebarProposedPlan = findSidebarProposedPlan({
    threads: threadPlanCatalog,
    latestTurn: activeLatestTurn,
    latestTurnSettled,
    threadId: activeThread?.id ?? null,
  });
  const activePlan = deriveActivePlanState(threadActivities, activeWorkTurnId);
  const activeGeneratedWorkspaceSummary = deriveLatestGeneratedWorkspaceSummary(threadActivities);
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);
  const activePendingApproval = pendingApprovals[0] ?? null;
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree,
    isSendBusy,
  } = useLocalDispatchState({
    activeThread,
    activeLatestTurn,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError: activeThread?.error,
  });
  const isWorking = liveTurnInProgress || isSendBusy || isConnecting || isRevertingCheckpoint;
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    activeLatestTurn,
    activeThread?.session ?? null,
    localDispatchStartedAt,
  );
  const stuckTurnSnapshot =
    reliabilityUxEnabled && activeThread && activeLatestTurn?.state === "running"
      ? deriveStuckTurnSnapshot({
          latestTurn: activeLatestTurn,
          messages:
            activeThreadTimelineProjection?.messages.map(toPagedChatMessage) ??
            activeThread.messages,
          activities: threadActivities,
          now: stuckTurnNow,
        })
      : NOT_STUCK_TURN_SNAPSHOT;
  const openDiagnostics = (focus: "connection" | "provider" | "thread") => {
    if (!reliabilityUxEnabled) {
      return;
    }
    setDiagnosticsFocus(focus);
    setDiagnosticsOpen(true);
  };
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    for (const timeoutId of Object.values(attachmentPreviewHandoffTimeoutByMessageIdRef.current)) {
      window.clearTimeout(timeoutId);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  const clearOptimisticUserMessagePreviews = useEffectEvent(() => {
    for (const message of optimisticUserMessagesStateRef.current?.messages ?? []) {
      revokeUserMessagePreviewUrls(message);
    }
  });
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      clearOptimisticUserMessagePreviews();
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    const nextPreviewUrlSet = new Set(previewUrls);
    for (const previewUrl of previousPreviewUrls) {
      if (!nextPreviewUrlSet.has(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });

    const existingTimeout = attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    if (typeof existingTimeout === "number") {
      window.clearTimeout(existingTimeout);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId] = window.setTimeout(() => {
      const currentPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId];
      if (currentPreviewUrls) {
        for (const previewUrl of currentPreviewUrls) {
          revokeBlobPreviewUrl(previewUrl);
        }
      }
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) return existing;
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      delete attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    }, ATTACHMENT_PREVIEW_HANDOFF_TTL_MS);
  }, []);
  const serverMessages = activeThreadTimelineProjection
    ? activeThreadTimelineProjection.messages.map(toPagedChatMessage)
    : (activeThread?.messages ?? []);
  const serverMessageIdKey = serverMessages.map((message) => message.id).join("\0");
  const activeThreadMessages = (() => {
    const messages = serverMessages;
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          // oxlint-disable-next-line no-map-spread
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    if (optimisticUserMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  })();
  const hasLiveThreadTimelineContent =
    activeThreadMessages.length > 0 ||
    workLogEntries.length > 0 ||
    (activeThreadTimelineProjection?.rows.length ?? 0) > 0;
  const isThreadHistoryLoading = isThreadHistoryMetadataOnly && !hasLiveThreadTimelineContent;
  const handoffTimeline = (() => {
    if (
      isThreadHistoryLoading &&
      activeThreadMessages.length === 0 &&
      workLogEntries.length === 0
    ) {
      return {
        messages: [],
        proposedPlans: [],
        workEntries: [],
        historicalMessageIds: new Set<MessageId>(),
      };
    }
    if (isThreadHistoryLoading) {
      return {
        messages: activeThreadMessages,
        proposedPlans: activeThreadProposedPlans,
        workEntries: workLogEntries,
        historicalMessageIds: EMPTY_HISTORICAL_MESSAGE_IDS,
      };
    }
    if (!activeThread) {
      return {
        messages: activeThreadMessages,
        proposedPlans: [],
        workEntries: [],
        historicalMessageIds: EMPTY_HISTORICAL_MESSAGE_IDS,
      };
    }
    if (!isServerThread) {
      return {
        messages: activeThreadMessages,
        proposedPlans: activeThreadProposedPlans,
        workEntries: workLogEntries,
        historicalMessageIds: EMPTY_HISTORICAL_MESSAGE_IDS,
      };
    }
    return buildHandoffTimeline({
      activeThread,
      activeThreadMessages,
      activeThreadProposedPlans,
      activeThreadWorkEntries: workLogEntries,
      handoffLineage,
      activityVisibility: {
        enableToolStreaming,
        enableThinkingStreaming,
      },
    });
  })();
  const timelineMessages = handoffTimeline.messages;
  const timelineProposedPlans = handoffTimeline.proposedPlans;
  const timelineWorkEntries = handoffTimeline.workEntries;
  const subagentProvider =
    activeThread?.session?.provider ?? activeThread?.modelSelection.provider ?? null;
  const subagentThreads = deriveSubagentThreads(timelineWorkEntries, subagentProvider);
  const [activeSubagentThreadId, setActiveSubagentThreadId] = useState<string | null>(null);
  const visibleActiveSubagentThreadId =
    subagentThreads.find((thread) => thread.id === activeSubagentThreadId)?.id ??
    subagentThreads[0]?.id ??
    null;
  const environmentMiniPanelRef = useRef<HTMLElement | null>(null);
  const [environmentPanelPopoverStyle, setEnvironmentPanelPopoverStyle] = useState<{
    left: number;
    maxHeight?: number;
    top: number;
  } | null>(null);
  const activeThreadMessageIds =
    activeThreadMessages.length === 0
      ? EMPTY_MESSAGE_ID_SET
      : new Set(activeThreadMessages.map((message) => message.id));
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId =
    deriveTurnDiffSummaryByAssistantMessageId(turnDiffSummaries);
  const completionSummary = deriveThreadCompletionSummary(activeLatestTurn, latestTurnSettled);
  const nativeCompletionAttachment = (() => {
    if (!activeThreadTimelineProjection) {
      return null;
    }
    if (!latestTurnSettled && activeLatestTurn !== null) {
      return null;
    }
    return deriveSourceCompletionAttachment({
      latestTurn: activeLatestTurn,
      rows: activeThreadTimelineProjection.rows,
      messages: activeThreadTimelineProjection.messages,
    });
  })();
  const nativeCompletionDividerBeforeEntryId =
    nativeCompletionAttachment?.dividerBeforeEntryId ?? null;
  const sourceTimelineRowsInput: SourceTimelineRowsInput | null = (() => {
    if (!isServerThread) {
      return null;
    }
    const baseRows = activeThreadTimelineProjection?.rows ?? [];
    const baseMessages = activeThreadTimelineProjection?.messages ?? [];
    if (baseRows.length === 0 && optimisticUserMessages.length === 0) {
      return null;
    }
    const timelineWithOptimisticMessages = appendOptimisticUserMessagesToSourceTimeline({
      rows: baseRows,
      messages: baseMessages,
      optimisticUserMessages,
    });
    return {
      rows: timelineWithOptimisticMessages.rows,
      messages: timelineWithOptimisticMessages.messages,
      activities: activeThreadTimelineProjection?.activities ?? [],
      proposedPlans: activeThreadTimelineProjection?.proposedPlans ?? [],
      activeTurnId: activeLatestTurn?.turnId ?? null,
      activeTurnInProgress: isWorking,
      activeTurnStartedAt: activeWorkStartedAt,
      completionDividerBeforeEntryId: nativeCompletionDividerBeforeEntryId,
      completionEndedAt: nativeCompletionAttachment?.endedAt ?? null,
      completionSummary,
      completionTurnId: nativeCompletionAttachment?.turnId ?? null,
      completionStartedAt: nativeCompletionAttachment?.startedAt ?? null,
      hideCompletedWorkMessages,
      turnDiffSummaryByAssistantMessageId,
    };
  })();
  const nativeTurnDiffSummaryKey = (() => {
    if (!sourceTimelineRowsInput || turnDiffSummaryByAssistantMessageId.size === 0) {
      return "";
    }
    return [...turnDiffSummaryByAssistantMessageId.keys()].join("\0");
  })();
  const sourceTimelineRowsContentKey = (() => {
    if (!sourceTimelineRowsInput) {
      return "";
    }
    return buildSourceTimelineRowsContentKey(sourceTimelineRowsInput);
  })();
  const sourceTimelineRowsThreadId = activeThread?.id ?? null;
  const sourceTimelineRowsInputKey = (() => {
    if (!sourceTimelineRowsInput) {
      return null;
    }
    return createSourceTimelineRowsCacheKey({
      threadId: sourceTimelineRowsThreadId,
      snapshotRevision: activeThreadTimelineCompleteSnapshot?.revision ?? null,
      snapshotTotalRows: activeThreadTimelineCompleteSnapshot?.totalRows ?? null,
      threadRevision: activeThreadTimelineRevision,
      rowCount: sourceTimelineRowsInput.rows.length,
      rowContentKey: sourceTimelineRowsContentKey,
      isActiveTurnRunning: isWorking,
      activeTurnId: sourceTimelineRowsInput.activeTurnId ?? null,
      activeTurnStartedAt: activeWorkStartedAt,
      completionEndedAt: sourceTimelineRowsInput.completionEndedAt ?? null,
      completionDividerBeforeEntryId: nativeCompletionDividerBeforeEntryId,
      completionSummary,
      completionStartedAt: sourceTimelineRowsInput.completionStartedAt ?? null,
      completionTurnId: sourceTimelineRowsInput.completionTurnId ?? null,
      hideCompletedWorkMessages,
      turnDiffSummaryKey: nativeTurnDiffSummaryKey,
    });
  })();
  const { loading: sourceTimelineRowsLoading, rows: sourceTimelineRowsOverride } =
    useResolvedSourceTimelineRows({
      cacheKey: sourceTimelineRowsInputKey,
      hasCompleteSnapshot: activeThreadTimelineCompleteSnapshot !== null,
      rowsInput: sourceTimelineRowsInput,
      threadId: sourceTimelineRowsThreadId,
      rebuildDelayMs: ACTIVE_SOURCE_TIMELINE_ROWS_REBUILD_DELAY_MS,
    });
  const shouldUseSourceTimelineRows = sourceTimelineRowsInput !== null;
  const timelineRenderState = (() => {
    if (shouldUseSourceTimelineRows) {
      return {
        timelineEntries: EMPTY_TIMELINE_ENTRIES,
        turnDiffSummaryByAssistantMessageId,
      };
    }
    return measureRenderWork("chat.deriveThreadTimelineRenderState", () =>
      deriveThreadTimelineRenderState({
        messages: timelineMessages,
        proposedPlans: timelineProposedPlans,
        workLogEntries: timelineWorkEntries,
        turnDiffSummaries,
      }),
    );
  })();
  const timelineEntries = timelineRenderState.timelineEntries;
  const revertTurnCountByUserMessageId = (() => {
    if (timelineEntries.length === 0 || turnDiffSummaryByAssistantMessageId.size === 0) {
      return EMPTY_MESSAGE_TURN_COUNT_MAP;
    }
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }
      if (!activeThreadMessageIds.has(entry.message.id)) {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  })();
  const revertTurnCountByAssistantMessageId = (() => {
    if (turnDiffSummaryByAssistantMessageId.size === 0) {
      return EMPTY_MESSAGE_TURN_COUNT_MAP;
    }
    const byAssistantMessageId = new Map<MessageId, number>();
    for (const [assistantMessageId, summary] of turnDiffSummaryByAssistantMessageId) {
      const turnCount =
        summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
      if (typeof turnCount !== "number") {
        continue;
      }
      byAssistantMessageId.set(assistantMessageId, Math.max(0, turnCount - 1));
    }
    return byAssistantMessageId;
  })();

  const completionDividerBeforeEntryId = (() => {
    if (shouldUseSourceTimelineRows) {
      return nativeCompletionDividerBeforeEntryId;
    }
    if (!latestTurnSettled) return null;
    if (!completionSummary) return null;
    return deriveCompletionDividerBeforeEntryId(timelineEntries, activeLatestTurn);
  })();
  const timelineCacheScope = shouldUseSourceTimelineRows
    ? null
    : buildThreadTimelineCacheScope({
        thread: activeThread,
        timelineEntries,
        timelineMessages,
        timelineProposedPlans,
        timelineWorkEntries,
        turnDiffSummaries,
      });
  const fallbackTimelineRows: ReadonlyArray<TimelineRow> = (() => {
    if (shouldUseSourceTimelineRows) {
      return EMPTY_TIMELINE_ROWS;
    }
    return measureRenderWork("chat.buildTimelineRows", () =>
      buildTimelineRows({
        timelineEntries,
        activeTurnId: activeLatestTurn?.turnId ?? null,
        activeTurnInProgress: isWorking,
        activeTurnStartedAt: activeWorkStartedAt,
        ...(timelineCacheScope ? { cacheScopeKey: timelineCacheScope } : {}),
        completionDividerBeforeEntryId,
        completionSummary,
        hideCompletedWorkMessages,
        isWorking,
        enableGoalWorkingState:
          (activeThread?.session?.provider ?? activeThread?.modelSelection.provider) === "codex",
      }),
    );
  })();
  const timelineRows = sourceTimelineRowsOverride ?? fallbackTimelineRows;
  const expandedWorkGroups = activeThreadId
    ? (expandedWorkGroupsByThreadId[activeThreadId] ?? EMPTY_TIMELINE_DISCLOSURE_EXPANSION_STATE)
    : EMPTY_TIMELINE_DISCLOSURE_EXPANSION_STATE;
  useEffect(() => {
    if (!activeThreadId) {
      return;
    }
    if (Object.keys(expandedWorkGroups).length === 0) {
      return;
    }
    const activeTimelineDisclosureKeys = collectTimelineRowsDisclosureKeys(timelineRows);
    const nextExpandedWorkGroups = pruneTimelineDisclosureExpansionState(
      expandedWorkGroups,
      activeTimelineDisclosureKeys,
    );
    if (nextExpandedWorkGroups === expandedWorkGroups) {
      return;
    }
    setExpandedWorkGroupsByThreadId((current) => {
      const existing = current[activeThreadId] ?? EMPTY_TIMELINE_DISCLOSURE_EXPANSION_STATE;
      const pruned =
        existing === expandedWorkGroups
          ? nextExpandedWorkGroups
          : pruneTimelineDisclosureExpansionState(existing, activeTimelineDisclosureKeys);
      if (pruned === existing) {
        return current;
      }
      return {
        ...current,
        [activeThreadId]: pruned,
      };
    });
  }, [activeThreadId, expandedWorkGroups, timelineRows]);
  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.cwd },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  const codingGitCwd = gitCwd;
  const canOpenLocalMarkdownFiles = Boolean(activeThreadId && gitCwd);
  const workspaceStatusPollingMs = latestTurnSettled ? 10_000 : 5_000;
  const { data: workspaceStatusData, error: workspaceStatusError } = useQuery({
    ...gitStatusQueryOptions(codingGitCwd, activeServerConnectionUrl),
    enabled: codingGitCwd !== null && activeForSideEffects,
    staleTime: workspaceStatusPollingMs,
    refetchInterval: workspaceStatusPollingMs,
    refetchIntervalInBackground: false,
  });
  const workspaceWorkingTree = workspaceStatusData?.workingTree;
  const workspaceChangeStat =
    workspaceWorkingTree &&
    (workspaceWorkingTree.insertions !== 0 || workspaceWorkingTree.deletions !== 0)
      ? {
          additions: workspaceWorkingTree.insertions,
          deletions: workspaceWorkingTree.deletions,
        }
      : null;
  const handleRegenerateSummary = async () => {
    if (!activeThread) {
      return;
    }
    const api = readNativeApi();
    if (!api) {
      return;
    }

    await api.orchestration.dispatchCommand({
      type: "thread.workspace-summary.regenerate",
      commandId: newCommandId(),
      threadId: activeThread.id,
      createdAt: new Date().toISOString(),
    });
  };
  const { data: branchesData } = useQuery({
    ...gitBranchesQueryOptions(codingGitCwd, activeServerConnectionUrl),
    enabled: codingGitCwd !== null && activeForSideEffects,
  });
  // Default true while loading to avoid toolbar flicker.
  const rawIsGitRepo = branchesData?.isRepo ?? true;
  const isGitRepo = rawIsGitRepo;
  const activeThreadBranchName =
    activeThread?.branch ?? branchesData?.branches.find((branch) => branch.current)?.name ?? null;
  const keybindings = useServerKeybindings({ enabled: activeForSideEffects });
  const availableEditors = useServerAvailableEditors({ enabled: activeForSideEffects });
  const handoffDisabledReason = (() => {
    if (!activeThread || !isServerThread) {
      return "Handoff is only available for saved threads.";
    }
    if (activeThread.messages.length === 0) {
      return "Send a message before handing off.";
    }
    if (isWorking || handoffInFlight) {
      return "Wait for the current turn to finish.";
    }
    if (handoffTargetProviders.length === 0) {
      return "No other providers are available.";
    }
    return null;
  })();
  const handoffDisabled = handoffDisabledReason !== null;
  const activeProjectCwd = activeProject?.cwd ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const threadTerminalRuntimeEnv = activeProjectCwd
    ? projectScriptRuntimeEnv({
        project: {
          cwd: activeProjectCwd,
        },
        worktreePath: activeThreadWorktreePath,
      })
    : {};
  const chatViewportRef = useRef<HTMLDivElement | null>(null);
  const workspaceViewportRef = useRef<HTMLDivElement | null>(null);
  const [workspaceViewportSize, setWorkspaceViewportSize] = useState({ height: 0, width: 0 });
  const workspaceEditorSplitWidthRef = useRef(workspaceEditorSplitWidth);
  const workspaceEditorSplitPanelRef = useRef<HTMLDivElement | null>(null);
  const workspaceEditorSplitResizePointerIdRef = useRef<number | null>(null);
  const workspaceEditorSplitResizeStateRef = useRef<{
    contentElement: HTMLElement | null;
    pendingWidth: number;
    rafId: number | null;
    startX: number;
    startWidth: number;
  } | null>(null);
  const didResizeWorkspaceEditorSplitDuringDragRef = useRef(false);

  useLayoutEffect(() => {
    const viewportElement = workspaceViewportRef.current;
    if (!viewportElement) return;

    let frameId: number | null = null;
    let pendingDeferredSync = false;
    const syncViewportSize = () => {
      frameId = null;
      pendingDeferredSync = false;
      const rect = viewportElement.getBoundingClientRect();
      const nextWidth = Math.floor(rect.width);
      const nextHeight = Math.floor(rect.height);
      setWorkspaceViewportSize((current) =>
        current.width === nextWidth && current.height === nextHeight
          ? current
          : { height: nextHeight, width: nextWidth },
      );
    };
    const scheduleSync = () => {
      if (isLayoutResizeInProgress()) {
        pendingDeferredSync = true;
        return;
      }
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(syncViewportSize);
    };
    const handleLayoutResizeEnd = () => {
      if (pendingDeferredSync) {
        scheduleSync();
      }
    };

    scheduleSync();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleSync);
    resizeObserver?.observe(viewportElement);
    window.addEventListener("resize", scheduleSync, { passive: true });
    window.addEventListener("ace:native-window-resize-end", handleLayoutResizeEnd);
    window.addEventListener(SIDEBAR_RESIZE_END_EVENT, handleLayoutResizeEnd);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleSync);
      window.removeEventListener("ace:native-window-resize-end", handleLayoutResizeEnd);
      window.removeEventListener(SIDEBAR_RESIZE_END_EVENT, handleLayoutResizeEnd);
    };
  }, []);
  const lastSyncedWorkspaceEditorSplitWidthRef = useRef(workspaceEditorSplitWidth);
  const rightSidePanelWidthRef = useRef(rightSidePanelWidth);
  const rightSidePanelElementRef = useRef<HTMLDivElement | null>(null);
  const bottomPanelElementRef = useRef<HTMLDivElement | null>(null);
  const bottomPanelContentElementRef = useRef<HTMLDivElement | null>(null);
  const dockedRightSidePanelHeaderRef = useRef<HTMLDivElement | null>(null);
  const bottomPanelResizePointerIdRef = useRef<number | null>(null);
  const bottomPanelResizeStateRef = useRef<{
    contentElement: HTMLElement | null;
    handleElement: HTMLElement | null;
    panelElement: HTMLElement | null;
    pendingHeight: number;
    rafId: number | null;
    startHeight: number;
    startY: number;
  } | null>(null);
  const didResizeBottomPanelDuringDragRef = useRef(false);

  const {
    terminalState,
    rightTerminalPanelState,
    createNewTerminal,
    createNewPanelTerminal,
    createSplitTerminal,
    activateTerminal,
    activatePanelTerminal,
    moveTerminal,
    movePanelTerminal,
    setTerminalGroupSplitRatios,
    setPanelTerminalGroupSplitRatios,
    closeTerminal,
    setTerminalAutoTitle,
    setTerminalHeight,
    setRightPanelTerminalHeight,
    toggleTerminalVisibility,
    setTerminalOpen,
    onCloseRightSidePanelTerminal,
    onCloseBottomPanelTerminal,
    onReorderRightSidePanelTerminalTab,
    onReorderBottomPanelTerminalTab,
    beginBottomPanelMotion,
    endBottomPanelMotion,
    handleBottomPanelResizePointerDown,
    clearPendingBottomPanelTerminalOpenTimer,
  } = useChatViewTerminalState({
    threadId,
    activeThread,
    setBottomPanelMode,
    rightSidePanelMode,
    setRightSidePanelMode,
    setRightSidePanelTerminalOpen,
    composerPanelsRef,
    promptRef,
    composerTerminalContextsRef,
    insertComposerDraftTerminalContext,
    terminalFocusRequestId,
    setTerminalFocusRequestId,
    appendRightPanelTabOrder,
    removeRightPanelTabOrder,
    appendBottomPanelTabOrder,
    removeBottomPanelTabOrder,
    setBottomPanelTabOrder,
    setRightPanelTabOrder,
    bottomPanelContentElementRef,
    bottomPanelElementRef,
    bottomPanelResizePointerIdRef,
    bottomPanelResizeStateRef,
    didResizeBottomPanelDuringDragRef,
    setBottomPanelResizing,
    setBottomPanelContentDeferred,
    setBottomPanelMotionActive,
    bottomPanelMotionActiveRef,
  });

  const rightSidePanelResizePointerIdRef = useRef<number | null>(null);
  const rightSidePanelResizeStateRef = useRef<{
    headerElement: HTMLElement | null;
    panelElement: HTMLElement | null;
    pendingWidth: number;
    rafId: number | null;
    startX: number;
    startWidth: number;
  } | null>(null);
  const didResizeRightSidePanelDuringDragRef = useRef(false);
  const lastSyncedRightSidePanelWidthRef = useRef(rightSidePanelWidth);
  const defaultWorkspaceMode: ThreadWorkspaceMode =
    workspaceEditorOpenMode === "split" ? "split" : "editor";
  const persistedWorkspaceLayout = normalizeThreadWorkspaceLayoutMode(
    workspaceLayoutByThreadId[threadId],
    defaultWorkspaceMode,
  );
  const workspaceMode: ThreadWorkspaceMode = routeWorkspaceMode;
  const editorHostedInRightPanel =
    effectiveRightSidePanelMode === "editor" ||
    workspaceMode === "editor" ||
    workspaceMode === "split";
  const headerWorkspaceMode: ThreadWorkspaceMode = editorHostedInRightPanel
    ? "split"
    : workspaceMode;
  useLayoutEffect(() => {
    if (!rightSidePanelEnabled || rightSidePanelMode !== "diff" || rightSidePanelDiffOpen) {
      return;
    }
    openRightSidePanelDiff();
  }, [rightSidePanelDiffOpen, rightSidePanelEnabled, rightSidePanelMode]);
  useEffect(() => {
    if (!rightSidePanelEnabled || !diffOpen) {
      return;
    }
    setRightSidePanelReviewOpen(true);
  }, [diffOpen, rightSidePanelEnabled, setRightSidePanelReviewOpen]);
  useLayoutEffect(() => {
    if (
      rightSidePanelEnabled &&
      browserMode !== "closed" &&
      isElectron &&
      !diffOpen &&
      bottomPanelMode !== "browser" &&
      rightSidePanelMode === null
    ) {
      setRightSidePanelMode("browser");
    }
  }, [
    bottomPanelMode,
    browserMode,
    diffOpen,
    rightSidePanelEnabled,
    rightSidePanelMode,
    setRightSidePanelMode,
  ]);
  useLayoutEffect(() => {
    if (!splitPane && (routeWorkspaceMode === "editor" || routeWorkspaceMode === "split")) {
      ensureWorkspaceEditorPanelVisible();
    }
  }, [routeWorkspaceMode, splitPane]);
  useLayoutEffect(() => {
    if (splitPane || routeWorkspaceMode === "chat") {
      return;
    }
    setWorkspaceModeByThreadId((previous) => {
      if (previous[threadId] === routeWorkspaceMode) {
        return previous;
      }
      return {
        ...previous,
        [threadId]: routeWorkspaceMode,
      };
    });
    setWorkspaceLayoutByThreadId((previous) => {
      if (previous[threadId] === routeWorkspaceMode) {
        return previous;
      }
      return {
        ...previous,
        [threadId]: routeWorkspaceMode,
      };
    });
  }, [
    routeWorkspaceMode,
    setWorkspaceLayoutByThreadId,
    setWorkspaceModeByThreadId,
    splitPane,
    threadId,
  ]);
  const onWorkspaceModeChange = useCallback(
    (mode: ThreadWorkspaceMode) => {
      if (splitPane) {
        return;
      }
      const nextMode =
        mode === "editor" && workspaceMode === "chat" ? persistedWorkspaceLayout : mode;
      if (nextMode === "editor" || nextMode === "split") {
        setRightSidePanelEditorOpen(true);
        setRightSidePanelMode("editor");
        setRightSidePanelVisible(true);
        setWorkspaceLayoutByThreadId((previous) => ({
          ...previous,
          [threadId]: nextMode,
        }));
        return;
      }
      if (rightSidePanelMode === "editor") {
        setRightSidePanelMode("summary");
      }
      setRightSidePanelEditorOpen(false);
      if (nextMode === workspaceMode) {
        return;
      }
      setWorkspaceModeByThreadId((previous) => ({
        ...previous,
        [threadId]: nextMode,
      }));
      if (nextMode !== "chat") {
        setWorkspaceLayoutByThreadId((previous) => ({
          ...previous,
          [threadId]: nextMode,
        }));
      }
      void navigate({
        to: "/$threadId",
        params: { threadId },
        replace: true,
        search: (previous) => ({
          ...previous,
          mode: nextMode === "chat" ? undefined : nextMode,
        }),
      });
    },
    [
      navigate,
      persistedWorkspaceLayout,
      rightSidePanelMode,
      setRightSidePanelEditorOpen,
      setRightSidePanelMode,
      setRightSidePanelVisible,
      setWorkspaceLayoutByThreadId,
      setWorkspaceModeByThreadId,
      splitPane,
      threadId,
      workspaceMode,
    ],
  );
  const toggleWorkspaceMode = useCallback(() => {
    onWorkspaceModeChange(workspaceMode === "chat" ? "editor" : "chat");
  }, [onWorkspaceModeChange, workspaceMode]);
  const toggleHeaderVisibility = useCallback(() => {
    setIsHeaderHidden((previous) => !previous);
  }, [setIsHeaderHidden]);
  const setRightSidePanelDiffOpen = useCallback(
    (nextDiffOpen: boolean) => {
      setRightSidePanelDiffOpenState(nextDiffOpen);
      setRightSidePanelReviewOpen(nextDiffOpen);
      setLocalDiffState((previous) => ({
        ...previous,
        open: nextDiffOpen,
      }));
      if (nextDiffOpen) {
        setRightSidePanelVisible(true);
      }
      if (splitPane) {
        setRightSidePanelMode(nextDiffOpen ? "diff" : null);
        return;
      }
      if (nextDiffOpen) {
        setRightSidePanelMode("diff");
      } else if (rightSidePanelMode === "diff") {
        setRightSidePanelMode(
          resolveRightSidePanelModeAfterDiffClose({
            activeMode: rightSidePanelMode,
            lastNonDiffMode: rightSidePanelLastNonDiffMode,
          }),
        );
      }
    },
    [
      rightSidePanelLastNonDiffMode,
      rightSidePanelMode,
      setLocalDiffState,
      setRightSidePanelDiffOpenState,
      setRightSidePanelMode,
      setRightSidePanelReviewOpen,
      setRightSidePanelVisible,
      splitPane,
    ],
  );
  const onOpenRightSidePanelDiff = useCallback(() => {
    appendRightPanelTabOrder("diff");
    if (diffOpen) {
      setRightSidePanelDiffOpenState(true);
      setRightSidePanelReviewOpen(true);
      setRightSidePanelMode("diff");
      setRightSidePanelVisible(true);
      return;
    }
    setRightSidePanelDiffOpen(true);
  }, [
    appendRightPanelTabOrder,
    diffOpen,
    setRightSidePanelDiffOpen,
    setRightSidePanelDiffOpenState,
    setRightSidePanelMode,
    setRightSidePanelReviewOpen,
    setRightSidePanelVisible,
  ]);

  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "closed")),
  );
  const setThreadError = (targetThreadId: ThreadId | null, error: string | null) => {
    if (!targetThreadId) return;
    if (getThreadById(useStore.getState().threads, targetThreadId)) {
      setStoreThreadError(targetThreadId, error);
      return;
    }
    setLocalDraftErrorsByThreadId((existing) => {
      if ((existing[targetThreadId] ?? null) === error) {
        return existing;
      }
      return {
        ...existing,
        [targetThreadId]: error,
      };
    });
  };
  const dismissThreadError = (targetThreadId: ThreadId | null) => {
    if (!targetThreadId) return;
    if (getThreadById(useStore.getState().threads, targetThreadId)) {
      dismissStoreThreadError(targetThreadId);
      return;
    }
    setLocalDraftErrorsByThreadId((existing) => {
      if ((existing[targetThreadId] ?? null) === null) {
        return existing;
      }
      const next = { ...existing };
      delete next[targetThreadId];
      return next;
    });
  };

  const scheduleComposerFocus = useCallback((attempts = 4) => {
    let frameId: number | null = null;
    const requestFocus = (remainingAttempts: number) => {
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        if (composerPanelsRef.current?.focusAtEnd() || remainingAttempts <= 1) {
          return;
        }
        requestFocus(remainingAttempts - 1);
      });
    };

    requestFocus(Math.max(1, attempts));
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, []);
  // dispatchQueuedComposerCommand, appendQueuedComposerMessage, deleteQueuedComposerMessage,
  // clearQueuedComposerState, reorderQueuedComposerState, steerQueuedComposerMessage,
  // clearQueuedSteerRequest, dispatchQueuedComposerMessage, ensureQueuedComposerThread,
  // buildQueuedComposerImages, removeQueuedComposerMessage, clearQueuedComposerMessages,
  // reorderQueuedComposerMessages, restoreQueuedComposerMessageToDraft, onEditQueuedComposerMessage,
  // queueCurrentComposerMessage, queuePreparedMessage, onSteerQueuedComposerMessage
  // are provided by useChatViewComposerActions hook above.
  const addTerminalContextToDraft = (selection: TerminalContextSelection) => {
    if (!activeThread) {
      return;
    }
    const snapshot = composerPanelsRef.current?.readSnapshot() ?? {
      value: promptRef.current,
      cursor: promptRef.current.length,
      expandedCursor: promptRef.current.length,
      terminalContextIds: composerTerminalContextsRef.current.map((context) => context.id),
    };
    const insertion = insertInlineTerminalContextPlaceholder(
      snapshot.value,
      snapshot.expandedCursor,
    );
    const nextCollapsedCursor = collapseExpandedComposerCursor(insertion.prompt, insertion.cursor);
    const inserted = insertComposerDraftTerminalContext(
      activeThread.id,
      insertion.prompt,
      {
        id: randomUUID(),
        threadId: activeThread.id,
        createdAt: new Date().toISOString(),
        ...selection,
      },
      insertion.contextIndex,
    );
    if (!inserted) {
      return;
    }
    promptRef.current = insertion.prompt;
    composerPanelsRef.current?.resetUi(insertion.prompt);
    window.requestAnimationFrame(() => {
      composerPanelsRef.current?.focusAt(nextCollapsedCursor);
    });
  };
  // setTerminalOpen, beginBottomPanelMotion, endBottomPanelMotion, setTerminalHeight,
  // setRightPanelTerminalHeight, handleBottomPanelResizePointerDown, toggleTerminalVisibility,
  // clearPendingBottomPanelTerminalOpenTimer, readActiveTerminalState, createNewTerminal,
  // createNewPanelTerminal, createSplitTerminal, activateTerminal, activatePanelTerminal,
  // moveTerminal, movePanelTerminal, setTerminalGroupSplitRatios, setPanelTerminalGroupSplitRatios,
  // closeTerminalTarget, setTerminalAutoTitle, closeTerminal
  // are provided by useChatViewTerminalState hook above.
  const syncBottomPanelHeightEvent = useEffectEvent((nextHeight: number) => {
    if (!activeThreadId) return;
    setTerminalHeight(nextHeight);
  });

  const syncRightSidePanelWidth = useCallback(
    (nextWidth: number) => {
      const viewportWidth = chatViewportRef.current?.clientWidth ?? window.innerWidth;
      const clampedWidth = clampRightSidePanelWidth(nextWidth, viewportWidth);
      rightSidePanelWidthRef.current = clampedWidth;
      setRightSidePanelWidth(clampedWidth);
      if (lastSyncedRightSidePanelWidthRef.current === clampedWidth) {
        return;
      }
      lastSyncedRightSidePanelWidthRef.current = clampedWidth;
      setStoredRightSidePanelWidth(clampedWidth);
    },
    [setRightSidePanelWidth, setStoredRightSidePanelWidth],
  );

  const onToggleRightSidePanel = useCallback(() => {
    beginRightSidePanelMotion();
    if (rightSidePanelOpen) {
      setRightSidePanelContentDeferred(false);
      setRightSidePanelVisible(false);
      return;
    }
    setRightSidePanelContentDeferred(false);
    setRightSidePanelVisible(true);
  }, [beginRightSidePanelMotion, rightSidePanelOpen, setRightSidePanelVisible]);
  const onNewRightSidePanelEditorTab = useCallback(
    (tabId?: string) => {
      const tab = createPanelEditorTab(tabId);
      appendRightPanelTabOrder(`editor:${tab.id}`);
      setRightPanelEditorTabs((current) => [...current, tab]);
      setActiveRightPanelEditorTabId(tab.id);
      setRightSidePanelEditorOpen(true);
      setRightSidePanelMode("editor");
      setRightSidePanelVisible(true);
    },
    [
      appendRightPanelTabOrder,
      setRightSidePanelEditorOpen,
      setRightSidePanelMode,
      setRightSidePanelVisible,
    ],
  );
  const onSelectRightSidePanelEditorTab = (tabId: string) => {
    setActiveRightPanelEditorTabId(tabId);
    setRightSidePanelEditorOpen(true);
    setRightSidePanelMode("editor");
    setRightSidePanelVisible(true);
  };
  const onCloseRightSidePanelEditorTab = (tabId: string) => {
    const tabIndex = rightPanelEditorTabs.findIndex((tab) => tab.id === tabId);
    if (tabIndex < 0) return;
    const nextTabs = rightPanelEditorTabs.filter((tab) => tab.id !== tabId);
    setRightPanelEditorTabs(nextTabs);
    setRightPanelTabOrder((current) => removePanelTabOrder(current, `editor:${tabId}`));
    if (nextTabs.length === 0) {
      setActiveRightPanelEditorTabId(null);
      setRightSidePanelEditorOpen(false);
      removeRightPanelTabOrder("editor");
      setRightSidePanelMode((current) => (current === "editor" ? "summary" : current));
      return;
    }
    setActiveRightPanelEditorTabId((current) => {
      if (current && current !== tabId && nextTabs.some((tab) => tab.id === current)) {
        return current;
      }
      return nextTabs[Math.min(tabIndex, nextTabs.length - 1)]?.id ?? null;
    });
  };
  const onReorderRightSidePanelEditorTab = (draggedTabId: string, targetTabId: string) => {
    setRightPanelEditorTabs((current) => {
      const draggedIndex = current.findIndex((tab) => tab.id === draggedTabId);
      const targetIndex = current.findIndex((tab) => tab.id === targetTabId);
      if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) {
        return current;
      }
      const next = [...current];
      const [draggedTab] = next.splice(draggedIndex, 1);
      if (!draggedTab) {
        return current;
      }
      next.splice(targetIndex, 0, draggedTab);
      return next;
    });
  };
  const onOpenRightSidePanelEditor = useCallback(
    (tabId?: string) => {
      if (tabId) {
        const existingEditorTab = rightPanelEditorTabs.find((tab) => tab.id === tabId);
        const nextEditorTab = existingEditorTab ?? createPanelEditorTab(tabId);
        if (!existingEditorTab) {
          setRightPanelEditorTabs((current) => [...current, nextEditorTab]);
        }
        appendRightPanelTabOrder(`editor:${nextEditorTab.id}`);
        setActiveRightPanelEditorTabId(nextEditorTab.id);
        setRightSidePanelEditorOpen(true);
        setRightSidePanelMode("editor");
        setRightSidePanelVisible(true);
        return;
      }
      if (rightPanelEditorTabs.length === 0) {
        onNewRightSidePanelEditorTab(rightPanelFallbackEditorStateInstanceId);
        return;
      }
      const activeEditorTabId = activeRightPanelEditorTabId ?? rightPanelEditorTabs[0]?.id ?? null;
      if (activeEditorTabId) {
        appendRightPanelTabOrder(`editor:${activeEditorTabId}`);
      }
      setActiveRightPanelEditorTabId(activeEditorTabId);
      setRightSidePanelEditorOpen(true);
      setRightSidePanelMode("editor");
      setRightSidePanelVisible(true);
    },
    [
      activeRightPanelEditorTabId,
      appendRightPanelTabOrder,
      onNewRightSidePanelEditorTab,
      rightPanelFallbackEditorStateInstanceId,
      rightPanelEditorTabs,
      setRightPanelEditorTabs,
      setRightSidePanelEditorOpen,
      setRightSidePanelMode,
      setRightSidePanelVisible,
    ],
  );
  const onOpenRightSidePanelTerminal = useCallback(() => {
    appendRightPanelTabOrder(`terminal:${terminalState.activeTerminalId}`);
    setRightSidePanelTerminalOpen(true);
    setRightSidePanelMode("terminal");
    setRightSidePanelVisible(true);
    setTerminalFocusRequestId((value) => value + 1);
  }, [
    appendRightPanelTabOrder,
    setRightSidePanelMode,
    setRightSidePanelTerminalOpen,
    setRightSidePanelVisible,
    setTerminalFocusRequestId,
    terminalState.activeTerminalId,
  ]);
  const openEditorFile = useEditorStateStore((state) => state.openFile);
  const workspaceRootsForInAppFileOpen = [
    activeThread?.worktreePath,
    gitCwd,
    activeProject?.cwd,
  ].filter((root): root is string => typeof root === "string" && root.trim().length > 0);
  const openMarkdownFileInAppEditor = useStableCallback(async (targetPath: string) => {
    if (!activeThreadId || !gitCwd) {
      return;
    }
    const normalizedTargetPath = targetPath.trim();
    if (normalizedTargetPath.length === 0) {
      return;
    }
    const api = readNativeApi();
    if (api) {
      try {
        const pathInfo = await api.shell.pathInfo(normalizedTargetPath, {
          connectionUrl: activeServerConnectionUrl,
        });
        if (pathInfo.kind === "directory") {
          await api.shell.revealInFileManager(normalizedTargetPath, {
            connectionUrl: activeServerConnectionUrl,
          });
          return;
        }
      } catch (error) {
        console.warn("Failed to inspect local file path before opening editor.", error);
      }
    }
    let resolvedFilePath = resolveWorkspaceEditorFilePath(
      normalizedTargetPath,
      workspaceRootsForInAppFileOpen[0] ?? "",
    );
    if (isAbsoluteFilesystemPath(resolvedFilePath) && workspaceRootsForInAppFileOpen.length > 1) {
      for (const workspaceRoot of workspaceRootsForInAppFileOpen.slice(1)) {
        const candidatePath = resolveWorkspaceEditorFilePath(normalizedTargetPath, workspaceRoot);
        if (!isAbsoluteFilesystemPath(candidatePath)) {
          resolvedFilePath = candidatePath;
          break;
        }
      }
    }
    if (resolvedFilePath.length === 0) {
      return;
    }
    const targetEditorTabId =
      activeRightPanelEditorTabId ?? rightPanelEditorTabs[0]?.id ?? `editor-${randomUUID()}`;
    onOpenRightSidePanelEditor(targetEditorTabId);
    openEditorFile(
      resolveEditorInstanceStateScopeId({
        gitCwd,
        instanceId: targetEditorTabId,
        threadId: activeThreadId,
      }),
      resolvedFilePath,
    );
  });
  const onCloseRightSidePanelEditor = () => {
    const activeEditorTabId = activeRightPanelEditorTabId ?? rightPanelEditorTabs[0]?.id ?? null;
    if (activeEditorTabId) {
      onCloseRightSidePanelEditorTab(activeEditorTabId);
      return;
    }
    setRightSidePanelEditorOpen(false);
    setRightSidePanelMode((current) => (current === "editor" ? "summary" : current));
  };
  const onNewBottomPanelEditorTab = useCallback(
    (tabId?: string) => {
      const tab = createPanelEditorTab(tabId);
      appendBottomPanelTabOrder(`editor:${tab.id}`);
      setBottomPanelEditorTabs((current) => [...current, tab]);
      setActiveBottomPanelEditorTabId(tab.id);
      setBottomPanelMode("editor");
    },
    [appendBottomPanelTabOrder],
  );
  const onSelectBottomPanelEditorTab = (tabId: string) => {
    setActiveBottomPanelEditorTabId(tabId);
    setBottomPanelMode("editor");
  };
  const onCloseBottomPanelEditorTab = (tabId: string) => {
    const tabIndex = bottomPanelEditorTabs.findIndex((tab) => tab.id === tabId);
    if (tabIndex < 0) return;
    const nextTabs = bottomPanelEditorTabs.filter((tab) => tab.id !== tabId);
    setBottomPanelEditorTabs(nextTabs);
    setBottomPanelTabOrder((current) => removePanelTabOrder(current, `editor:${tabId}`));
    if (nextTabs.length === 0) {
      setActiveBottomPanelEditorTabId(null);
      removeBottomPanelTabOrder("editor");
      setBottomPanelMode((current) => (current === "editor" ? "terminal" : current));
      setTerminalOpen(true);
      return;
    }
    setActiveBottomPanelEditorTabId((current) => {
      if (current && current !== tabId && nextTabs.some((tab) => tab.id === current)) {
        return current;
      }
      return nextTabs[Math.min(tabIndex, nextTabs.length - 1)]?.id ?? null;
    });
  };
  const onReorderBottomPanelEditorTab = (draggedTabId: string, targetTabId: string) => {
    setBottomPanelEditorTabs((current) => {
      const draggedIndex = current.findIndex((tab) => tab.id === draggedTabId);
      const targetIndex = current.findIndex((tab) => tab.id === targetTabId);
      if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) {
        return current;
      }
      const next = [...current];
      const [draggedTab] = next.splice(draggedIndex, 1);
      if (!draggedTab) {
        return current;
      }
      next.splice(targetIndex, 0, draggedTab);
      return next;
    });
  };
  const onCloseBottomPanelEditor = () => {
    const activeEditorTabId = activeBottomPanelEditorTabId ?? bottomPanelEditorTabs[0]?.id ?? null;
    if (activeEditorTabId) {
      onCloseBottomPanelEditorTab(activeEditorTabId);
      return;
    }
    setBottomPanelMode((current) => (current === "editor" ? "terminal" : current));
    setTerminalOpen(true);
    removeBottomPanelTabOrder("editor");
  };
  const onOpenBottomPanelEditor = useCallback(
    (tabId?: string) => {
      if (tabId) {
        const existingEditorTab = bottomPanelEditorTabs.find((tab) => tab.id === tabId);
        const nextEditorTab = existingEditorTab ?? createPanelEditorTab(tabId);
        if (!existingEditorTab) {
          setBottomPanelEditorTabs((current) => [...current, nextEditorTab]);
        }
        setActiveBottomPanelEditorTabId(nextEditorTab.id);
        appendBottomPanelTabOrder(`editor:${nextEditorTab.id}`);
        setBottomPanelMode("editor");
        return;
      }
      if (bottomPanelEditorTabs.length === 0) {
        onNewBottomPanelEditorTab(bottomPanelFallbackEditorStateInstanceId);
        return;
      }
      const activeEditorTabId =
        activeBottomPanelEditorTabId ?? bottomPanelEditorTabs[0]?.id ?? null;
      setActiveBottomPanelEditorTabId(activeEditorTabId);
      if (activeEditorTabId) {
        appendBottomPanelTabOrder(`editor:${activeEditorTabId}`);
      }
      setBottomPanelMode("editor");
    },
    [
      activeBottomPanelEditorTabId,
      appendBottomPanelTabOrder,
      bottomPanelFallbackEditorStateInstanceId,
      bottomPanelEditorTabs,
      onNewBottomPanelEditorTab,
      setBottomPanelEditorTabs,
    ],
  );
  // onCloseRightSidePanelTerminal, onReorderRightSidePanelTerminalTab,
  // onReorderBottomPanelTerminalTab, onCloseBottomPanelTerminal
  // are provided by useChatViewTerminalState hook above.
  const onCloseRightSidePanelDiff = () => {
    setRightSidePanelDiffOpenState(false);
    setRightSidePanelReviewOpen(false);
    removeRightPanelTabOrder("diff");
    setRightSidePanelMode((current) =>
      resolveRightSidePanelModeAfterDiffClose({
        activeMode: current,
        lastNonDiffMode: rightSidePanelLastNonDiffMode,
      }),
    );
    if (!bottomPanelReviewOpen) {
      setLocalDiffState((previous) => ({ ...previous, open: false }));
    }
  };
  const onOpenBottomPanelDiff = useCallback(() => {
    appendBottomPanelTabOrder("diff");
    setBottomPanelReviewOpen(true);
    setBottomPanelMode("diff");
    setLocalDiffState((previous) => ({ ...previous, open: true }));
  }, [appendBottomPanelTabOrder, setLocalDiffState]);
  const onCloseBottomPanelDiff = () => {
    setBottomPanelReviewOpen(false);
    removeBottomPanelTabOrder("diff");
    setBottomPanelMode((current) => (current === "diff" ? "terminal" : current));
    if (!rightSidePanelReviewOpen) {
      setLocalDiffState((previous) => ({ ...previous, open: false }));
    }
    setTerminalOpen(true);
  };
  const onSelectBottomPanelMode = (mode: DockPanelMode) => {
    if (mode === "summary") {
      setBottomPanelMode("summary");
      return;
    }
    if (mode === "browser") {
      onOpenBottomPanelBrowser();
      return;
    }
    if (mode === "diff") {
      onOpenBottomPanelDiff();
      return;
    }
    if (mode === "terminal") {
      appendBottomPanelTabOrder(`terminal:${terminalState.activeTerminalId}`);
      setTerminalOpen(true);
      setBottomPanelMode("terminal");
      setTerminalFocusRequestId((value) => value + 1);
      return;
    }
    if (mode === "editor") {
      onOpenBottomPanelEditor();
      return;
    }
    setBottomPanelMode(mode);
  };
  const bottomPanelOpen =
    bottomPanelMode !== null ||
    bottomPanelBrowserOpen ||
    bottomPanelEditorTabs.length > 0 ||
    bottomPanelReviewOpen ||
    terminalState.terminalOpen;

  useEffect(() => {
    if (!bottomPanelOpen || !bottomPanelContentDeferred) return;
    const timer = window.setTimeout(() => {
      if (bottomPanelMotionActiveRef.current) {
        endBottomPanelMotion();
        return;
      }
      setBottomPanelContentDeferred(false);
    }, PANEL_CONTENT_DEFER_FALLBACK_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [bottomPanelContentDeferred, bottomPanelOpen, endBottomPanelMotion]);

  useEffect(() => {
    if (!bottomPanelOpen) {
      return;
    }
    const handlePointerMove = (event: PointerEvent) => {
      if (bottomPanelResizePointerIdRef.current !== event.pointerId) {
        return;
      }
      const resizeState = bottomPanelResizeStateRef.current;
      if (!resizeState) {
        return;
      }
      const nextHeight = clampBottomPanelHeight(
        resizeState.startHeight + (resizeState.startY - event.clientY),
      );
      resizeState.pendingHeight = nextHeight;
      if (resizeState.rafId !== null) {
        return;
      }
      resizeState.rafId = window.requestAnimationFrame(() => {
        const activeResizeState = bottomPanelResizeStateRef.current;
        if (!activeResizeState) {
          return;
        }
        activeResizeState.rafId = null;
        applyResizablePanelHeight(
          activeResizeState.panelElement,
          activeResizeState.pendingHeight + 48,
        );
        applyResizablePanelHeight(
          activeResizeState.contentElement,
          activeResizeState.pendingHeight,
        );
      });
      didResizeBottomPanelDuringDragRef.current = true;
    };
    const handlePointerEnd = (event: PointerEvent) => {
      if (
        bottomPanelResizePointerIdRef.current === null ||
        bottomPanelResizePointerIdRef.current !== event.pointerId
      ) {
        return;
      }
      const resizeState = bottomPanelResizeStateRef.current;
      if (resizeState?.rafId !== null && resizeState?.rafId !== undefined) {
        window.cancelAnimationFrame(resizeState.rafId);
      }
      if (resizeState) {
        applyResizablePanelHeight(resizeState.panelElement, resizeState.pendingHeight + 48);
        applyResizablePanelHeight(resizeState.contentElement, resizeState.pendingHeight);
      }
      bottomPanelResizePointerIdRef.current = null;
      bottomPanelResizeStateRef.current = null;
      if (resizeState?.handleElement?.hasPointerCapture(event.pointerId)) {
        resizeState.handleElement.releasePointerCapture(event.pointerId);
      }
      if (!didResizeBottomPanelDuringDragRef.current) {
        clearResizablePanelHeight(resizeState?.panelElement ?? null);
        clearResizablePanelHeight(resizeState?.contentElement ?? null);
        setBottomPanelResizing(false);
        endLayoutResizeInteraction();
        return;
      }
      didResizeBottomPanelDuringDragRef.current = false;
      syncBottomPanelHeightEvent(resizeState?.pendingHeight ?? terminalState.terminalHeight);
      window.requestAnimationFrame(() => {
        setBottomPanelResizing(false);
        window.requestAnimationFrame(() => {
          clearResizablePanelHeight(resizeState?.panelElement ?? null);
          clearResizablePanelHeight(resizeState?.contentElement ?? null);
          endLayoutResizeInteraction();
        });
      });
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [bottomPanelOpen, terminalState.terminalHeight]);
  const onToggleBottomPanel = () => {
    beginBottomPanelMotion();
    if (bottomPanelOpen) {
      pendingBottomPanelTerminalOpenRef.current = false;
      clearPendingBottomPanelTerminalOpenTimer();
      setBottomPanelContentDeferred(false);
      setBottomPanelMode(null);
      setBottomPanelBrowserOpen(false);
      setBottomPanelEditorTabs([]);
      setActiveBottomPanelEditorTabId(null);
      setBottomPanelReviewOpen(false);
      setBottomPanelTabOrder([]);
      setTerminalOpen(false);
      return;
    }
    pendingBottomPanelTerminalOpenRef.current = true;
    setBottomPanelContentDeferred(false);
    setBottomPanelMode("terminal");
    setTerminalFocusRequestId((value) => value + 1);
  };
  const onToggleRightSidePanelFullscreen = useCallback(() => {
    setRightSidePanelFullscreen((current) => !current);
  }, [setRightSidePanelFullscreen]);
  const onToggleRightSidePanelFloatingChat = useCallback(() => {
    if (!rightSidePanelFullscreen) return;
    setRightSidePanelFloatingChatOpen((current) => !current);
  }, [rightSidePanelFullscreen, setRightSidePanelFloatingChatOpen]);

  const ensureQueuedComposerThreadRef = useRef<
    | ((options: {
        titleSeed: string;
        modelSelection: ModelSelection;
        runtimeMode: RuntimeMode;
        interactionMode: ProviderInteractionMode;
      }) => Promise<ThreadId | null>)
    | null
  >(null);
  const appendQueuedComposerMessageRef = useRef<
    ((targetThreadId: ThreadId, message: QueuedComposerMessage) => Promise<boolean>) | null
  >(null);

  const {
    browserControllerRef,
    browserControllerByThread,
    rightBrowserInstanceId,
    bottomBrowserInstanceId,
    rightBrowserOpen,
    anyBrowserOpen,
    browserViewMode,
    browserPanelAvailable,
    closeBrowser,
    openBrowser,
    openBrowserUrlInNewTab,
    detachBottomPanelBrowser,
    detachRightSidePanelBrowser,
    setBrowserController,
    handleBrowserRuntimeStateChange,
    queueBrowserDesignRequest,
    onOpenRightSidePanelBrowserTab,
    onOpenBottomPanelBrowser,
    onOpenBottomPanelBrowserTab,
    onSelectRightSidePanelBrowserTab,
    onSelectBottomPanelBrowserTab,
    onCloseRightSidePanelBrowserTab,
    onReorderRightSidePanelBrowserTab,
    onCloseBottomPanelBrowser,
    onCloseBottomPanelBrowserTab,
    onReorderBottomPanelBrowserTab,
    activeRightPanelBrowserSession,
    activeBottomPanelBrowserSession,
    activeRightPanelBrowserTabId,
    activeBottomPanelBrowserTabId,
    rightBrowserPanelInstanceIds,
    bottomBrowserPanelInstanceIds,
  } = useChatViewBrowserState({
    threadId,
    activeThread,
    activeForSideEffects,
    ownsGlobalSideEffects,
    isElectron,
    windowStateInstanceId,
    splitPane,
    routeWorkspaceMode,
    browserMode,
    setBrowserMode: setBrowserMode as (mode: string) => void,
    setBrowserDevToolsOpen,
    rightSidePanelEnabled,
    rightSidePanelInteractive,
    rightSidePanelVisible,
    setRightSidePanelVisible,
    rightSidePanelMode: rightSidePanelMode as RightSidePanelMode,
    setRightSidePanelMode: setRightSidePanelMode as (
      mode: RightSidePanelMode | ((prev: RightSidePanelMode | null) => RightSidePanelMode | null),
    ) => void,
    rightSidePanelWidth,
    rightSidePanelFullscreen,
    rightSidePanelDiffOpen,
    rightSidePanelOpen,
    setRightSidePanelDiffOpenState,
    setRightSidePanelReviewOpen,
    setRightSidePanelEditorOpen,
    browserSplitWidth,
    setBrowserSplitWidth,
    storedBrowserSplitWidth,
    setStoredBrowserSplitWidth,
    appendRightPanelTabOrder,
    removeRightPanelTabOrder,
    appendBottomPanelTabOrder,
    removeBottomPanelTabOrder,
    setTerminalOpen,
    bottomPanelMode,
    setBottomPanelMode,
    bottomPanelBrowserOpen,
    setBottomPanelBrowserOpen,
    bottomPanelOpen,
    commentSubmissionMode,
    selectedModelSelection,
    runtimeMode,
    interactionMode,
    ensureQueuedComposerThread: async (options: {
      titleSeed: string;
      modelSelection: ModelSelection;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }) => ensureQueuedComposerThreadRef.current?.(options) ?? null,
    appendQueuedComposerMessage: async (targetThreadId: ThreadId, message: QueuedComposerMessage) =>
      appendQueuedComposerMessageRef.current?.(targetThreadId, message) ?? false,
    pendingComposerCommentsByThreadId,
    setPendingComposerCommentsByThreadId,
    syncRightSidePanelWidth,
    chatViewportRef,
  });

  const onSelectRightSidePanelMode = (mode: RightSidePanelMode) => {
    setRightSidePanelVisible(true);
    if (mode === "summary") {
      setRightSidePanelMode("summary");
      return;
    }
    if (mode === "browser") {
      openBrowser();
      return;
    }
    if (mode === "diff") {
      onOpenRightSidePanelDiff();
      return;
    }
    if (mode === "subagent") {
      appendRightPanelTabOrder("subagent");
      setRightSidePanelMode("subagent");
      return;
    }
    if (mode === "terminal") {
      onOpenRightSidePanelTerminal();
      return;
    }
    onOpenRightSidePanelEditor();
  };

  const handleDetachedWindowReturnRequest = useEffectEvent(
    (request: DesktopDetachedWindowReturnRequest) => {
      const requestThreadId = resolveDetachedWindowReturnThreadId(request);
      if (requestThreadId !== null && requestThreadId !== threadId) {
        return;
      }
      if (request.kind === "browser") {
        if (request.scopeId === bottomBrowserInstanceId) {
          onOpenBottomPanelBrowser();
          return;
        }
        openBrowser();
        return;
      }
      if (request.placement === "bottom") {
        onOpenBottomPanelEditor(request.editorStateInstanceId);
        return;
      }
      if (request.placement === "workspace") {
        onWorkspaceModeChange(request.workspaceMode ?? "editor");
        return;
      }
      onOpenRightSidePanelEditor(request.editorStateInstanceId);
    },
  );
  useLayoutEffect(() => {
    const pendingRequest = consumePendingDetachedWindowReturnRequest(threadId);
    if (pendingRequest) {
      handleDetachedWindowReturnRequest(pendingRequest);
    }
  }, [threadId]);
  useEffect(() => {
    const handleDetachedWindowReturn = (event: Event) => {
      const request = event instanceof CustomEvent ? event.detail : null;
      if (!isDetachedWindowReturnRequest(request)) {
        return;
      }
      handleDetachedWindowReturnRequest(request);
    };
    window.addEventListener(DETACHED_WINDOW_RETURN_EVENT, handleDetachedWindowReturn);
    return () => {
      window.removeEventListener(DETACHED_WINDOW_RETURN_EVENT, handleDetachedWindowReturn);
    };
  }, []);

  const lastBrowserPointerClearedTurnRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeForSideEffects) return;
    if (!activeThread?.id) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;

    const key = `${activeThread.id}:${activeLatestTurn.turnId}:${activeLatestTurn.completedAt}`;
    if (lastBrowserPointerClearedTurnRef.current === key) {
      return;
    }
    lastBrowserPointerClearedTurnRef.current = key;
    browserControllerByThread
      .get(resolveBrowserInstanceId(activeThread.id, "right", windowStateInstanceId))
      ?.clearAgentPointers();
    browserControllerByThread
      .get(resolveBrowserInstanceId(activeThread.id, "bottom", windowStateInstanceId))
      ?.clearAgentPointers();
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.turnId,
    activeForSideEffects,
    activeThread?.id,
    browserControllerByThread,
    latestTurnSettled,
    windowStateInstanceId,
  ]);

  const syncWorkspaceEditorSplitWidth = (nextWidth: number) => {
    const viewportWidth = workspaceViewportRef.current?.clientWidth ?? window.innerWidth;
    const clampedWidth = clampWorkspaceEditorSplitWidth(nextWidth, viewportWidth);
    workspaceEditorSplitWidthRef.current = clampedWidth;
    setWorkspaceEditorSplitWidth(clampedWidth);
    if (lastSyncedWorkspaceEditorSplitWidthRef.current === clampedWidth) {
      return;
    }
    lastSyncedWorkspaceEditorSplitWidthRef.current = clampedWidth;
    setStoredWorkspaceEditorSplitWidth(clampedWidth);
  };
  const syncWorkspaceEditorSplitWidthEvent = useEffectEvent((nextWidth: number) => {
    syncWorkspaceEditorSplitWidth(nextWidth);
  });

  const handleWorkspaceEditorSplitResizePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    beginLayoutResizeInteraction();
    workspaceEditorSplitResizePointerIdRef.current = event.pointerId;
    workspaceEditorSplitResizeStateRef.current = {
      contentElement: workspaceEditorSplitPanelRef.current,
      pendingWidth: workspaceEditorSplitWidthRef.current,
      rafId: null,
      startX: event.clientX,
      startWidth: workspaceEditorSplitWidthRef.current,
    };
    applyResizablePanelWidth(
      workspaceEditorSplitPanelRef.current,
      workspaceEditorSplitWidthRef.current,
    );
    didResizeWorkspaceEditorSplitDuringDragRef.current = false;
  };

  useLayoutEffect(() => {
    if (workspaceMode !== "split" || editorHostedInRightPanel) {
      return;
    }
    const handlePointerMove = (event: PointerEvent) => {
      if (workspaceEditorSplitResizePointerIdRef.current !== null) {
        const resizeState = workspaceEditorSplitResizeStateRef.current;
        if (!resizeState) {
          return;
        }
        const viewportWidth = workspaceViewportRef.current?.clientWidth ?? window.innerWidth;
        const nextWidth = clampWorkspaceEditorSplitWidth(
          resizeState.startWidth + (resizeState.startX - event.clientX),
          viewportWidth,
        );
        workspaceEditorSplitWidthRef.current = nextWidth;
        resizeState.pendingWidth = nextWidth;
        if (resizeState.rafId === null) {
          resizeState.rafId = window.requestAnimationFrame(() => {
            const activeResizeState = workspaceEditorSplitResizeStateRef.current;
            if (!activeResizeState) {
              return;
            }
            activeResizeState.rafId = null;
            applyResizablePanelWidth(
              activeResizeState.contentElement,
              activeResizeState.pendingWidth,
            );
          });
        }
        didResizeWorkspaceEditorSplitDuringDragRef.current = true;
      }
    };
    const handlePointerEnd = () => {
      if (workspaceEditorSplitResizePointerIdRef.current === null) {
        return;
      }
      const resizeState = workspaceEditorSplitResizeStateRef.current;
      if (resizeState?.rafId !== null && resizeState?.rafId !== undefined) {
        window.cancelAnimationFrame(resizeState.rafId);
      }
      if (resizeState) {
        applyResizablePanelWidth(resizeState.contentElement, resizeState.pendingWidth);
      }
      workspaceEditorSplitResizePointerIdRef.current = null;
      workspaceEditorSplitResizeStateRef.current = null;
      if (!didResizeWorkspaceEditorSplitDuringDragRef.current) {
        clearResizablePanelWidth(resizeState?.contentElement ?? null);
        endLayoutResizeInteraction();
        return;
      }
      didResizeWorkspaceEditorSplitDuringDragRef.current = false;
      syncWorkspaceEditorSplitWidthEvent(workspaceEditorSplitWidthRef.current);
      window.requestAnimationFrame(() => {
        clearResizablePanelWidth(resizeState?.contentElement ?? null);
        endLayoutResizeInteraction();
      });
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [editorHostedInRightPanel, setWorkspaceEditorSplitWidth, workspaceMode]);

  useLayoutEffect(() => {
    if (workspaceMode !== "split" || editorHostedInRightPanel) {
      return;
    }
    const viewportWidth = workspaceViewportRef.current?.clientWidth ?? window.innerWidth;
    const clampedWidth = clampWorkspaceEditorSplitWidth(
      storedWorkspaceEditorSplitWidth,
      viewportWidth,
    );
    workspaceEditorSplitWidthRef.current = clampedWidth;
    lastSyncedWorkspaceEditorSplitWidthRef.current = clampedWidth;
    setWorkspaceEditorSplitWidth(clampedWidth);
  }, [
    editorHostedInRightPanel,
    setWorkspaceEditorSplitWidth,
    storedWorkspaceEditorSplitWidth,
    workspaceMode,
  ]);

  useEffect(() => {
    if (workspaceMode !== "split" || editorHostedInRightPanel) {
      return;
    }

    let frameId: number | null = null;
    let pendingNativeResizeSync = false;
    const syncViewportWidth = () => {
      pendingNativeResizeSync = false;
      const viewportWidth = workspaceViewportRef.current?.clientWidth ?? window.innerWidth;
      const clampedWidth = clampWorkspaceEditorSplitWidth(
        workspaceEditorSplitWidthRef.current,
        viewportWidth,
      );
      if (workspaceEditorSplitWidthRef.current !== clampedWidth) {
        workspaceEditorSplitWidthRef.current = clampedWidth;
        setWorkspaceEditorSplitWidth(clampedWidth);
      }
      if (workspaceEditorSplitResizePointerIdRef.current === null) {
        syncWorkspaceEditorSplitWidthEvent(clampedWidth);
      }
    };
    const scheduleViewportWidthSync = () => {
      if (isLayoutResizeInProgress()) {
        pendingNativeResizeSync = true;
        return;
      }
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        syncViewportWidth();
      });
    };

    scheduleViewportWidthSync();
    const viewportElement = workspaceViewportRef.current;
    const resizeObserver =
      typeof ResizeObserver === "undefined" || !viewportElement
        ? null
        : new ResizeObserver(scheduleViewportWidthSync);
    if (resizeObserver && viewportElement) {
      resizeObserver.observe(viewportElement);
    } else {
      window.addEventListener("resize", scheduleViewportWidthSync);
    }
    const handleNativeWindowResizeEnd = () => {
      if (pendingNativeResizeSync) {
        scheduleViewportWidthSync();
      }
    };
    window.addEventListener("ace:native-window-resize-end", handleNativeWindowResizeEnd);
    window.addEventListener(SIDEBAR_RESIZE_END_EVENT, handleNativeWindowResizeEnd);
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      window.removeEventListener("ace:native-window-resize-end", handleNativeWindowResizeEnd);
      window.removeEventListener(SIDEBAR_RESIZE_END_EVENT, handleNativeWindowResizeEnd);
      resizeObserver?.disconnect();
      if (!resizeObserver) {
        window.removeEventListener("resize", scheduleViewportWidthSync);
      }
    };
  }, [editorHostedInRightPanel, setWorkspaceEditorSplitWidth, workspaceMode]);

  const resizeBrowserViewportForBridge = (
    requestThreadId: ThreadId,
    request: BrowserViewportResizeRequest,
  ): BrowserViewportResizeResult => {
    const viewportWidth = chatViewportRef.current?.clientWidth ?? window.innerWidth;
    const requestedPanelWidth =
      request.panelWidth ??
      (request.width !== undefined
        ? request.width + RIGHT_SIDE_PANEL_RESIZE_HANDLE_WIDTH
        : undefined);
    const requestIsForActiveThread = shouldApplyThreadBrowserViewportResizeToVisiblePanel({
      activeThreadId,
      requestThreadId,
      rightSidePanelInteractive,
    });
    const requestThreadPanelWidthStorageKey = resolveScopedBrowserStorageKey(
      RIGHT_SIDE_PANEL_WIDTH_STORAGE_KEY,
      requestThreadId,
    );
    const storedRequestThreadPanelWidth = requestIsForActiveThread
      ? rightSidePanelWidthRef.current
      : (getLocalStorageItem(requestThreadPanelWidthStorageKey, Schema.Number) ??
        DEFAULT_RIGHT_SIDE_PANEL_WIDTH);
    const currentPanelWidth = clampRightSidePanelWidth(
      storedRequestThreadPanelWidth,
      viewportWidth,
    );
    const nextPanelWidth =
      requestedPanelWidth !== undefined
        ? clampRightSidePanelWidth(requestedPanelWidth, viewportWidth)
        : currentPanelWidth;

    if (requestIsForActiveThread) {
      setRightSidePanelMode("browser");
      setBrowserMode("split");
      setRightSidePanelVisible(true);
      setRightSidePanelFullscreen(false);
      syncRightSidePanelWidth(nextPanelWidth);
    } else if (requestedPanelWidth !== undefined) {
      setLocalStorageItem(requestThreadPanelWidthStorageKey, nextPanelWidth, Schema.Number);
    }

    const result: BrowserViewportResizeResult = {
      heightControlledByAppWindow: true,
      panelWidth: nextPanelWidth,
      viewportWidth: Math.max(0, nextPanelWidth - RIGHT_SIDE_PANEL_RESIZE_HANDLE_WIDTH),
    };
    if (request.height !== undefined) {
      result.requestedHeight = request.height;
    }
    if (requestedPanelWidth !== undefined) {
      result.requestedPanelWidth = requestedPanelWidth;
    }
    if (request.width !== undefined) {
      result.requestedWidth = request.width;
    }
    return result;
  };
  const handleRightSidePanelResizePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    beginLayoutResizeInteraction();
    setRightSidePanelResizing(true);
    rightSidePanelResizePointerIdRef.current = event.pointerId;
    rightSidePanelResizeStateRef.current = {
      headerElement: dockedRightSidePanelHeaderRef.current,
      panelElement: rightSidePanelElementRef.current,
      pendingWidth: rightSidePanelWidthRef.current,
      rafId: null,
      startX: event.clientX,
      startWidth: rightSidePanelWidthRef.current,
    };
    applyResizablePanelWidth(rightSidePanelElementRef.current, rightSidePanelWidthRef.current);
    applyResizablePanelWidth(dockedRightSidePanelHeaderRef.current, rightSidePanelWidthRef.current);
    didResizeRightSidePanelDuringDragRef.current = false;
  };

  const handleRightSidePanelResizeKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!rightSidePanelOpen) {
      return;
    }
    const viewportWidth = chatViewportRef.current?.clientWidth ?? window.innerWidth;
    const currentWidth = rightSidePanelWidthRef.current;
    const step = event.shiftKey ? 96 : 32;

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      syncRightSidePanelWidth(currentWidth + step);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      syncRightSidePanelWidth(currentWidth - step);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      syncRightSidePanelWidth(viewportWidth);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      syncRightSidePanelWidth(0);
    }
  };
  const syncRightSidePanelWidthEvent = useEffectEvent((nextWidth: number) => {
    syncRightSidePanelWidth(nextWidth);
  });

  useEffect(() => {
    if (!rightSidePanelOpen) {
      return;
    }
    const handlePointerMove = (event: PointerEvent) => {
      if (rightSidePanelResizePointerIdRef.current !== null) {
        const resizeState = rightSidePanelResizeStateRef.current;
        if (!resizeState) {
          return;
        }
        const viewportWidth = chatViewportRef.current?.clientWidth ?? window.innerWidth;
        const nextWidth = clampRightSidePanelWidth(
          resizeState.startWidth + (resizeState.startX - event.clientX),
          viewportWidth,
        );
        rightSidePanelWidthRef.current = nextWidth;
        resizeState.pendingWidth = nextWidth;
        if (resizeState.rafId === null) {
          resizeState.rafId = window.requestAnimationFrame(() => {
            const activeResizeState = rightSidePanelResizeStateRef.current;
            if (!activeResizeState) {
              return;
            }
            activeResizeState.rafId = null;
            applyResizablePanelWidth(
              activeResizeState.panelElement,
              activeResizeState.pendingWidth,
            );
            applyResizablePanelWidth(
              activeResizeState.headerElement,
              activeResizeState.pendingWidth,
            );
          });
        }
        didResizeRightSidePanelDuringDragRef.current = true;
      }
    };
    const handlePointerEnd = () => {
      if (rightSidePanelResizePointerIdRef.current === null) {
        return;
      }
      const resizeState = rightSidePanelResizeStateRef.current;
      if (resizeState?.rafId !== null && resizeState?.rafId !== undefined) {
        window.cancelAnimationFrame(resizeState.rafId);
      }
      if (resizeState) {
        applyResizablePanelWidth(resizeState.panelElement, resizeState.pendingWidth);
        applyResizablePanelWidth(resizeState.headerElement, resizeState.pendingWidth);
      }
      rightSidePanelResizePointerIdRef.current = null;
      rightSidePanelResizeStateRef.current = null;
      if (!didResizeRightSidePanelDuringDragRef.current) {
        clearResizablePanelWidth(resizeState?.panelElement ?? null);
        clearResizablePanelWidth(resizeState?.headerElement ?? null);
        setRightSidePanelResizing(false);
        endLayoutResizeInteraction();
        return;
      }
      didResizeRightSidePanelDuringDragRef.current = false;
      syncRightSidePanelWidthEvent(rightSidePanelWidthRef.current);
      window.requestAnimationFrame(() => {
        setRightSidePanelResizing(false);
        window.requestAnimationFrame(() => {
          clearResizablePanelWidth(resizeState?.panelElement ?? null);
          clearResizablePanelWidth(resizeState?.headerElement ?? null);
          endLayoutResizeInteraction();
        });
      });
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [rightSidePanelOpen, setRightSidePanelWidth]);
  useEffect(() => {
    if (!ownsGlobalSideEffects) {
      return;
    }
    const resetResizeInteractions = () => {
      const workspaceResizeState = workspaceEditorSplitResizeStateRef.current;
      if (workspaceResizeState?.rafId !== null && workspaceResizeState?.rafId !== undefined) {
        window.cancelAnimationFrame(workspaceResizeState.rafId);
      }
      clearResizablePanelWidth(workspaceResizeState?.contentElement ?? null);
      workspaceEditorSplitResizePointerIdRef.current = null;
      workspaceEditorSplitResizeStateRef.current = null;
      if (didResizeWorkspaceEditorSplitDuringDragRef.current) {
        didResizeWorkspaceEditorSplitDuringDragRef.current = false;
        syncWorkspaceEditorSplitWidthEvent(workspaceEditorSplitWidthRef.current);
      }
      const bottomPanelResizeState = bottomPanelResizeStateRef.current;
      if (bottomPanelResizeState?.rafId !== null && bottomPanelResizeState?.rafId !== undefined) {
        window.cancelAnimationFrame(bottomPanelResizeState.rafId);
      }
      clearResizablePanelHeight(bottomPanelResizeState?.panelElement ?? null);
      clearResizablePanelHeight(bottomPanelResizeState?.contentElement ?? null);
      bottomPanelResizePointerIdRef.current = null;
      bottomPanelResizeStateRef.current = null;
      setBottomPanelResizing(false);
      if (didResizeBottomPanelDuringDragRef.current) {
        didResizeBottomPanelDuringDragRef.current = false;
        syncBottomPanelHeightEvent(
          bottomPanelResizeState?.pendingHeight ?? DEFAULT_THREAD_TERMINAL_HEIGHT,
        );
      }
      const rightPanelResizeState = rightSidePanelResizeStateRef.current;
      if (rightPanelResizeState?.rafId !== null && rightPanelResizeState?.rafId !== undefined) {
        window.cancelAnimationFrame(rightPanelResizeState.rafId);
      }
      clearResizablePanelWidth(rightPanelResizeState?.panelElement ?? null);
      clearResizablePanelWidth(rightPanelResizeState?.headerElement ?? null);
      rightSidePanelResizePointerIdRef.current = null;
      rightSidePanelResizeStateRef.current = null;
      setRightSidePanelResizing(false);
      if (didResizeRightSidePanelDuringDragRef.current) {
        didResizeRightSidePanelDuringDragRef.current = false;
        syncRightSidePanelWidthEvent(rightSidePanelWidthRef.current);
      }
      endLayoutResizeInteraction();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        resetResizeInteractions();
      }
    };
    window.addEventListener("blur", resetResizeInteractions);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", resetResizeInteractions);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [ownsGlobalSideEffects]);

  useLayoutEffect(() => {
    if (!rightSidePanelInteractive) {
      return;
    }
    const viewportWidth = chatViewportRef.current?.clientWidth ?? window.innerWidth;
    const clampedWidth = clampRightSidePanelWidth(storedRightSidePanelWidth, viewportWidth);
    rightSidePanelWidthRef.current = clampedWidth;
    lastSyncedRightSidePanelWidthRef.current = clampedWidth;
    setRightSidePanelWidth(clampedWidth);
  }, [rightSidePanelInteractive, setRightSidePanelWidth, storedRightSidePanelWidth]);

  useEffect(() => {
    if (!rightSidePanelInteractive || !rightSidePanelOpen || rightSidePanelFullscreen) {
      return;
    }

    let frameId: number | null = null;
    let pendingNativeResizeSync = false;
    const syncViewportWidth = () => {
      pendingNativeResizeSync = false;
      const viewportWidth = chatViewportRef.current?.clientWidth ?? window.innerWidth;
      const clampedWidth = clampRightSidePanelWidth(rightSidePanelWidthRef.current, viewportWidth);
      if (rightSidePanelWidthRef.current !== clampedWidth) {
        rightSidePanelWidthRef.current = clampedWidth;
        setRightSidePanelWidth(clampedWidth);
      }
      if (rightSidePanelResizePointerIdRef.current === null) {
        syncRightSidePanelWidthEvent(clampedWidth);
      }
    };
    const scheduleViewportWidthSync = () => {
      if (isLayoutResizeInProgress()) {
        pendingNativeResizeSync = true;
        return;
      }
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        syncViewportWidth();
      });
    };

    scheduleViewportWidthSync();
    const viewportElement = chatViewportRef.current;
    const resizeObserver =
      typeof ResizeObserver === "undefined" || !viewportElement
        ? null
        : new ResizeObserver(scheduleViewportWidthSync);
    if (resizeObserver && viewportElement) {
      resizeObserver.observe(viewportElement);
    } else {
      window.addEventListener("resize", scheduleViewportWidthSync);
    }
    const handleNativeWindowResizeEnd = () => {
      if (pendingNativeResizeSync) {
        scheduleViewportWidthSync();
      }
    };
    window.addEventListener("ace:native-window-resize-end", handleNativeWindowResizeEnd);
    window.addEventListener(SIDEBAR_RESIZE_END_EVENT, handleNativeWindowResizeEnd);
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      window.removeEventListener("ace:native-window-resize-end", handleNativeWindowResizeEnd);
      window.removeEventListener(SIDEBAR_RESIZE_END_EVENT, handleNativeWindowResizeEnd);
      resizeObserver?.disconnect();
      if (!resizeObserver) {
        window.removeEventListener("resize", scheduleViewportWidthSync);
      }
    };
  }, [
    rightSidePanelFullscreen,
    rightSidePanelInteractive,
    rightSidePanelOpen,
    setRightSidePanelWidth,
  ]);

  // createNewTerminal, createNewPanelTerminal, createSplitTerminal, activateTerminal,
  // activatePanelTerminal, moveTerminal, movePanelTerminal, setTerminalGroupSplitRatios,
  // setPanelTerminalGroupSplitRatios, readActiveTerminalState, closeTerminalTarget,
  // setTerminalAutoTitle, closeTerminal
  // are provided by useChatViewTerminalState hook above.
  const runProjectScript = async (
    script: ProjectScript,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      worktreePath?: string | null;
      preferNewTerminal?: boolean;
      rememberAsLastInvoked?: boolean;
    },
  ) => {
    const api = readNativeApi();
    if (!api || !activeThreadId || !activeProject || !activeThread) return;
    if (options?.rememberAsLastInvoked !== false) {
      setLastInvokedScriptByProjectId((current) => {
        if (current[activeProject.id] === script.id) return current;
        return { ...current, [activeProject.id]: script.id };
      });
    }
    const targetCwd = options?.cwd ?? gitCwd ?? activeProject.cwd;
    const currentTerminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      activeThreadId,
    );
    const baseTerminalId =
      currentTerminalState?.activeTerminalId ||
      currentTerminalState?.terminalIds[0] ||
      DEFAULT_THREAD_TERMINAL_ID;
    const isBaseTerminalBusy =
      currentTerminalState?.runningTerminalIds.includes(baseTerminalId) ?? false;
    const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
    const shouldCreateNewTerminal = wantsNewTerminal;
    const targetTerminalId = shouldCreateNewTerminal ? `terminal-${randomUUID()}` : baseTerminalId;

    setTerminalOpen(true);
    if (shouldCreateNewTerminal) {
      useTerminalStateStore.getState().newTerminal(activeThreadId, targetTerminalId);
    } else {
      useTerminalStateStore.getState().setActiveTerminal(activeThreadId, targetTerminalId);
    }
    setTerminalAutoTitle(targetTerminalId, deriveTerminalTitleFromCommand(script.command));
    setTerminalFocusRequestId((value) => value + 1);

    const runtimeEnv = projectScriptRuntimeEnv({
      project: {
        cwd: activeProject.cwd,
      },
      worktreePath: options?.worktreePath ?? activeThread.worktreePath ?? null,
      extraEnv: {
        ...script.env,
        ...options?.env,
      },
    });
    const envFilePath =
      script.envFilePath ??
      (script.runOnWorktreeCreate ? DEFAULT_PROJECT_SCRIPT_ENV_FILE_PATH : null);
    if (envFilePath && options?.worktreePath) {
      let envFileContents = formatProjectScriptEnvFile(script.env);
      try {
        const sourceEnvFile = await api.projects.readFile({
          cwd: activeProject.cwd,
          relativePath: envFilePath,
        });
        envFileContents = sourceEnvFile.contents;
      } catch {
        // If the source env file does not exist, fall back to the configured setup env values.
      }
      await api.projects.writeFile({
        cwd: targetCwd,
        relativePath: envFilePath,
        contents: envFileContents,
        overwrite: true,
      });
    }
    const openTerminalInput: TerminalOpenInput = shouldCreateNewTerminal
      ? {
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          cwd: targetCwd,
          env: runtimeEnv,
          cols: SCRIPT_TERMINAL_COLS,
          rows: SCRIPT_TERMINAL_ROWS,
        }
      : {
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          cwd: targetCwd,
          env: runtimeEnv,
        };

    try {
      await api.terminal.open(openTerminalInput);
      await api.terminal.write({
        threadId: activeThreadId,
        terminalId: targetTerminalId,
        data: `${script.command}\r`,
      });
    } catch (error) {
      setThreadError(
        activeThreadId,
        error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
      );
    }
  };

  const runProjectScriptRef = useRef(runProjectScript);
  useEffect(() => {
    runProjectScriptRef.current = runProjectScript;
  });

  useEffect(() => {
    if (!pendingPullRequestSetupRequest || !activeProject || !activeThreadId || !activeThread) {
      return;
    }
    if (pendingPullRequestSetupRequest.threadId !== activeThreadId) {
      return;
    }
    if (activeThread.worktreePath !== pendingPullRequestSetupRequest.worktreePath) {
      return;
    }

    const setupScript =
      activeProject.scripts.find(
        (script) => script.id === pendingPullRequestSetupRequest.scriptId,
      ) ?? null;
    dispatchChatViewDialogState({
      type: "set-pending-pull-request-setup-request",
      pendingPullRequestSetupRequest: null,
    });
    if (!setupScript) {
      return;
    }

    void runProjectScriptRef
      .current(setupScript, {
        cwd: pendingPullRequestSetupRequest.worktreePath,
        worktreePath: pendingPullRequestSetupRequest.worktreePath,
        rememberAsLastInvoked: false,
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Failed to run setup script.",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      });
  }, [activeProject, activeThread, activeThreadId, pendingPullRequestSetupRequest]);
  const saveProjectScript = async (input: NewProjectScriptInput) => {
    if (!activeProject) return;
    const nextId = nextProjectScriptId(
      input.name,
      activeProject.scripts.map((script) => script.id),
    );
    const nextScript: ProjectScript = {
      id: nextId,
      name: input.name,
      command: input.command,
      icon: input.icon,
      runOnWorktreeCreate: input.runOnWorktreeCreate,
      env: input.env,
    };
    const nextScripts = input.runOnWorktreeCreate
      ? [
          ...activeProject.scripts.map((script) =>
            script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
          ),
          nextScript,
        ]
      : [...activeProject.scripts, nextScript];

    await persistProjectScripts({
      projectId: activeProject.id,
      projectCwd: activeProject.cwd,
      previousScripts: activeProject.scripts,
      nextScripts,
      keybinding: input.keybinding,
      keybindingCommand: commandForProjectScript(nextId),
    });
  };
  const updateProjectScript = async (scriptId: string, input: NewProjectScriptInput) => {
    if (!activeProject) return;
    const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
    if (!existingScript) {
      throw new Error("Script not found.");
    }

    const updatedScript: ProjectScript = {
      ...existingScript,
      name: input.name,
      command: input.command,
      icon: input.icon,
      runOnWorktreeCreate: input.runOnWorktreeCreate,
      env: input.env,
    };
    const nextScripts = activeProject.scripts.map((script) =>
      script.id === scriptId
        ? updatedScript
        : input.runOnWorktreeCreate
          ? { ...script, runOnWorktreeCreate: false }
          : script,
    );

    await persistProjectScripts({
      projectId: activeProject.id,
      projectCwd: activeProject.cwd,
      previousScripts: activeProject.scripts,
      nextScripts,
      keybinding: input.keybinding,
      keybindingCommand: commandForProjectScript(scriptId),
    });
  };
  const deleteProjectScript = async (scriptId: string) => {
    if (!activeProject) return;
    const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);

    const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name;

    try {
      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: null,
        keybindingCommand: commandForProjectScript(scriptId),
      });
      toastManager.add({
        type: "success",
        title: `Deleted action "${deletedName ?? "Unknown"}"`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not delete action",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    }
  };

  const persistThreadSettingsForNextTurn = async (input: {
    threadId: ThreadId;
    createdAt: string;
    modelSelection?: ModelSelection;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }) => {
    if (!serverThread) {
      return;
    }
    const api = readNativeApi();
    if (!api) {
      return;
    }

    if (
      input.modelSelection !== undefined &&
      (input.modelSelection.model !== serverThread.modelSelection.model ||
        input.modelSelection.provider !== serverThread.modelSelection.provider ||
        (input.modelSelection.providerInstanceId ?? null) !==
          (serverThread.modelSelection.providerInstanceId ?? null) ||
        JSON.stringify(input.modelSelection.options ?? null) !==
          JSON.stringify(serverThread.modelSelection.options ?? null))
    ) {
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: input.threadId,
        modelSelection: input.modelSelection,
      });
    }

    if (input.runtimeMode !== serverThread.runtimeMode) {
      await api.orchestration.dispatchCommand({
        type: "thread.runtime-mode.set",
        commandId: newCommandId(),
        threadId: input.threadId,
        runtimeMode: input.runtimeMode,
        createdAt: input.createdAt,
      });
    }

    if (input.interactionMode !== serverThread.interactionMode) {
      await api.orchestration.dispatchCommand({
        type: "thread.interaction-mode.set",
        commandId: newCommandId(),
        threadId: input.threadId,
        interactionMode: input.interactionMode,
        createdAt: input.createdAt,
      });
    }
  };

  // Auto-scroll on new messages
  const timelineTailStickKey = (() => {
    const row = timelineRows.at(-1);
    if (row) {
      return [row.id, "contentVersion" in row ? row.contentVersion : row.createdAt].join(":");
    }
    return "empty";
  })();
  const timelineHydratedRowCount = timelineRows.length;
  const markMessagesAtBottom = useCallback(
    (scrollContainer: HTMLDivElement) => {
      lastKnownScrollTopRef.current = scrollContainer.scrollTop;
      shouldAutoScrollRef.current = true;
      pendingUserScrollUpIntentRef.current = false;
      isPointerScrollActiveRef.current = false;
      lastTouchClientYRef.current = null;
      setShowScrollToBottomIfChanged(false);
    },
    [setShowScrollToBottomIfChanged],
  );
  const scrollMessagesToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer) return;
      scrollContainerToBottom(scrollContainer, behavior);
      markMessagesAtBottom(scrollContainer);
    },
    [markMessagesAtBottom],
  );
  const jumpMessagesToBottom = useCallback(() => {
    scrollMessagesToBottom();
  }, [scrollMessagesToBottom]);
  const cancelPendingStickToBottom = useCallback(() => {
    const pendingFrame = pendingAutoScrollFrameRef.current;
    if (pendingFrame === null) return;
    pendingAutoScrollFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);
  const cancelInitialBottomPin = useCallback(() => {
    pendingInitialBottomScrollThreadIdRef.current = null;
    pendingInitialBottomPinResizeObserverRef.current?.disconnect();
    pendingInitialBottomPinResizeObserverRef.current = null;
    const pendingFrame = pendingInitialBottomPinFrameRef.current;
    if (pendingFrame === null) return;
    pendingInitialBottomPinFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);
  const scheduleStickToBottom = useCallback(() => {
    if (pendingAutoScrollFrameRef.current !== null) return;
    pendingAutoScrollFrameRef.current = window.requestAnimationFrame(() => {
      pendingAutoScrollFrameRef.current = null;
      scrollMessagesToBottom();
    });
  }, [scrollMessagesToBottom]);
  const stickToBottomBeforePaint = useCallback(() => {
    cancelPendingStickToBottom();
    scrollMessagesToBottom();
  }, [cancelPendingStickToBottom, scrollMessagesToBottom]);
  const forceStickToBottom = useCallback(
    (jumpImmediately = false) => {
      cancelPendingStickToBottom();
      if (jumpImmediately) {
        jumpMessagesToBottom();
      } else {
        scrollMessagesToBottom();
      }
      scheduleStickToBottom();
    },
    [
      cancelPendingStickToBottom,
      jumpMessagesToBottom,
      scheduleStickToBottom,
      scrollMessagesToBottom,
    ],
  );
  const followStreamingLayoutChange = useStableCallback(() => {
    if (!activeForSideEffects || !liveTurnInProgress) return;
    if (!shouldAutoScrollRef.current) return;
    if (pendingUserScrollUpIntentRef.current || isPointerScrollActiveRef.current) return;
    scheduleStickToBottom();
  });
  const startInitialBottomPin = useCallback(
    (activeThreadId: ThreadId) => {
      const pendingFrame = pendingInitialBottomPinFrameRef.current;
      if (pendingFrame !== null) {
        pendingInitialBottomPinFrameRef.current = null;
        window.cancelAnimationFrame(pendingFrame);
      }
      pendingInitialBottomPinResizeObserverRef.current?.disconnect();
      pendingInitialBottomPinResizeObserverRef.current = null;

      shouldAutoScrollRef.current = true;
      setShowScrollToBottomIfChanged(false);
      forceStickToBottom(true);

      const startedAtMs = performance.now();
      let lastScrollHeight = -1;
      let stableFrameCount = 0;
      let frameId: number | null = null;
      const canKeepBottomPinned = () =>
        previousThreadIdRef.current === activeThreadId &&
        shouldAutoScrollRef.current &&
        !pendingUserScrollUpIntentRef.current &&
        !isPointerScrollActiveRef.current;
      const pinCurrentBottom = () => {
        const scrollContainer = messagesScrollRef.current;
        if (!scrollContainer || !canKeepBottomPinned()) {
          return;
        }
        scrollMessagesToBottom();
      };
      if (typeof ResizeObserver !== "undefined") {
        const resizeObserver = new ResizeObserver(pinCurrentBottom);
        const scrollContainer = messagesScrollRef.current;
        if (scrollContainer) {
          resizeObserver.observe(scrollContainer);
          const contentElement = scrollContainer.firstElementChild;
          if (contentElement instanceof Element) {
            resizeObserver.observe(contentElement);
          }
        }
        pendingInitialBottomPinResizeObserverRef.current = resizeObserver;
      }
      const keepBottomPinnedThroughHydration = () => {
        const scrollContainer = messagesScrollRef.current;
        if (!scrollContainer) {
          frameId = null;
          return;
        }
        if (!canKeepBottomPinned()) {
          pendingInitialBottomPinFrameRef.current = null;
          pendingInitialBottomPinResizeObserverRef.current?.disconnect();
          pendingInitialBottomPinResizeObserverRef.current = null;
          return;
        }

        const elapsedMs = performance.now() - startedAtMs;
        const scrollHeightChanged = Math.abs(scrollContainer.scrollHeight - lastScrollHeight) >= 1;
        if (scrollHeightChanged || !isScrollContainerNearBottom(scrollContainer)) {
          scrollMessagesToBottom();
        }

        if (!scrollHeightChanged) {
          stableFrameCount += 1;
        } else {
          stableFrameCount = 0;
          lastScrollHeight = scrollContainer.scrollHeight;
        }

        if (
          elapsedMs >= INITIAL_THREAD_BOTTOM_PIN_MAX_MS ||
          (elapsedMs >= INITIAL_THREAD_BOTTOM_PIN_MIN_MS &&
            stableFrameCount >= INITIAL_THREAD_BOTTOM_PIN_STABLE_FRAMES)
        ) {
          pendingInitialBottomPinFrameRef.current = null;
          if (pendingInitialBottomScrollThreadIdRef.current === activeThreadId) {
            pendingInitialBottomScrollThreadIdRef.current = null;
          }
          pendingInitialBottomPinResizeObserverRef.current?.disconnect();
          pendingInitialBottomPinResizeObserverRef.current = null;
          return;
        }

        frameId = window.requestAnimationFrame(keepBottomPinnedThroughHydration);
        pendingInitialBottomPinFrameRef.current = frameId;
      };
      frameId = window.requestAnimationFrame(keepBottomPinnedThroughHydration);
      pendingInitialBottomPinFrameRef.current = frameId;
    },
    [forceStickToBottom, scrollMessagesToBottom, setShowScrollToBottomIfChanged],
  );
  const onMessagesScroll = useStableCallback(() => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    const activeThreadId = activeThread?.id ?? null;
    const currentScrollTop = scrollContainer.scrollTop;
    if (
      activeThreadId !== null &&
      pendingInitialBottomScrollThreadIdRef.current === activeThreadId &&
      !pendingUserScrollUpIntentRef.current &&
      !isPointerScrollActiveRef.current
    ) {
      if (hasScrolledUp(currentScrollTop, lastKnownScrollTopRef.current)) {
        shouldAutoScrollRef.current = false;
        pendingUserScrollUpIntentRef.current = true;
        cancelPendingStickToBottom();
        cancelInitialBottomPin();
        scheduleShowScrollToBottom(shouldShowScrollToBottomButton(scrollContainer));
        lastKnownScrollTopRef.current = currentScrollTop;
        return;
      }
      lastKnownScrollTopRef.current = currentScrollTop;
      shouldAutoScrollRef.current = true;
      scheduleShowScrollToBottom(false);
      scheduleStickToBottom();
      return;
    }
    const isNearBottom = isScrollContainerNearBottom(scrollContainer);
    const autoScrollDecision = resolveAutoScrollOnScroll({
      shouldAutoScroll: shouldAutoScrollRef.current,
      isNearBottom,
      currentScrollTop,
      previousScrollTop: lastKnownScrollTopRef.current,
      hasPendingUserScrollUpIntent: pendingUserScrollUpIntentRef.current,
      isPointerScrollActive: isPointerScrollActiveRef.current,
    });
    shouldAutoScrollRef.current = autoScrollDecision.shouldAutoScroll;

    if (autoScrollDecision.clearPendingUserScrollUpIntent) {
      pendingUserScrollUpIntentRef.current = false;
    }
    if (autoScrollDecision.cancelPendingStickToBottom) {
      cancelPendingStickToBottom();
      cancelInitialBottomPin();
    }
    if (autoScrollDecision.scheduleStickToBottom) {
      // Keep following output when layout shifts move the viewport slightly off-bottom.
      scheduleStickToBottom();
    }

    scheduleShowScrollToBottom(shouldShowScrollToBottomButton(scrollContainer));
    lastKnownScrollTopRef.current = currentScrollTop;
  });
  const onMessagesWheel = useStableCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      shouldAutoScrollRef.current = false;
      pendingUserScrollUpIntentRef.current = true;
      cancelPendingStickToBottom();
      cancelInitialBottomPin();
      const scrollContainer = messagesScrollRef.current;
      setShowScrollToBottomIfChanged(
        scrollContainer ? shouldShowScrollToBottomButton(scrollContainer) : true,
      );
    }
  });
  const onMessagesPointerDown = useStableCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = true;
  });
  const onMessagesPointerUp = useStableCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = false;
  });
  const onMessagesPointerCancel = useStableCallback(
    (_event: React.PointerEvent<HTMLDivElement>) => {
      isPointerScrollActiveRef.current = false;
    },
  );
  const onMessagesTouchStart = useStableCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    lastTouchClientYRef.current = touch.clientY;
  });
  const onMessagesTouchMove = useStableCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    const previousTouchY = lastTouchClientYRef.current;
    if (previousTouchY !== null && touch.clientY > previousTouchY + 1) {
      shouldAutoScrollRef.current = false;
      pendingUserScrollUpIntentRef.current = true;
      cancelPendingStickToBottom();
      cancelInitialBottomPin();
      const scrollContainer = messagesScrollRef.current;
      setShowScrollToBottomIfChanged(
        scrollContainer ? shouldShowScrollToBottomButton(scrollContainer) : true,
      );
    }
    lastTouchClientYRef.current = touch.clientY;
  });
  const onMessagesTouchEnd = useStableCallback((_event: React.TouchEvent<HTMLDivElement>) => {
    lastTouchClientYRef.current = null;
  });
  useEffect(() => {
    return () => {
      cancelPendingStickToBottom();
      cancelInitialBottomPin();
      cancelPendingShowScrollToBottom();
    };
  }, [cancelInitialBottomPin, cancelPendingShowScrollToBottom, cancelPendingStickToBottom]);
  useLayoutEffect(() => {
    if (!activeForSideEffects) return;
    const nextThreadId = activeThread?.id ?? null;
    if (!nextThreadId) return;
    const jumpImmediately =
      previousThreadIdRef.current !== null && previousThreadIdRef.current !== nextThreadId;
    previousThreadIdRef.current = nextThreadId;
    cancelPendingStickToBottom();
    pendingUserScrollUpIntentRef.current = false;
    isPointerScrollActiveRef.current = false;
    lastTouchClientYRef.current = null;
    lastKnownScrollTopRef.current = messagesScrollRef.current?.scrollTop ?? 0;
    shouldAutoScrollRef.current = true;
    pendingInitialBottomScrollThreadIdRef.current = nextThreadId;
    setShowScrollToBottomIfChanged(false);
    forceStickToBottom(jumpImmediately);
    startInitialBottomPin(nextThreadId);

    const timeout = window.setTimeout(() => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer) return;
      if (
        !shouldAutoScrollRef.current ||
        pendingUserScrollUpIntentRef.current ||
        isPointerScrollActiveRef.current
      ) {
        return;
      }
      if (isScrollContainerNearBottom(scrollContainer)) return;
      scheduleStickToBottom();
    }, THREAD_SWITCH_SCROLL_SETTLE_DELAY_MS);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    activeForSideEffects,
    activeThread?.id,
    cancelPendingStickToBottom,
    forceStickToBottom,
    scheduleStickToBottom,
    setShowScrollToBottomIfChanged,
    startInitialBottomPin,
  ]);
  useLayoutEffect(() => {
    if (!activeForSideEffects) return;
    const activeThreadId = activeThread?.id ?? null;
    if (!activeThreadId || pendingInitialBottomScrollThreadIdRef.current !== activeThreadId) {
      return;
    }
    if (timelineHydratedRowCount <= 0) {
      return;
    }
    if (pendingUserScrollUpIntentRef.current) {
      pendingInitialBottomScrollThreadIdRef.current = null;
      return;
    }

    startInitialBottomPin(activeThreadId);
  }, [activeForSideEffects, activeThread?.id, startInitialBottomPin, timelineHydratedRowCount]);
  useLayoutEffect(() => {
    if (!activeForSideEffects) return;
    if (!shouldAutoScrollRef.current) return;
    if (pendingUserScrollUpIntentRef.current || isPointerScrollActiveRef.current) return;
    stickToBottomBeforePaint();
  }, [activeForSideEffects, stickToBottomBeforePaint, timelineTailStickKey]);
  useLayoutEffect(() => {
    if (!activeForSideEffects) return;
    if (!liveTurnInProgress) return;
    if (!shouldAutoScrollRef.current) return;
    if (pendingUserScrollUpIntentRef.current || isPointerScrollActiveRef.current) return;
    scheduleStickToBottom();
  }, [activeForSideEffects, liveTurnInProgress, scheduleStickToBottom, timelineTailStickKey]);

  useEffect(() => {
    resetThreadScopedUi();
    if (!openSummaryOnNextThreadRef.current) {
      return;
    }
    openSummaryOnNextThreadRef.current = false;
    setRightSidePanelMode("summary");
    setRightSidePanelVisible(true);
  }, [activeThread?.id, setRightSidePanelMode, setRightSidePanelVisible]);

  useEffect(() => {
    if (!ownsGlobalSideEffects) return;
    if (!activeThread?.id || terminalState.terminalOpen) return;
    return scheduleComposerFocus();
  }, [ownsGlobalSideEffects, activeThread?.id, scheduleComposerFocus, terminalState.terminalOpen]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (serverMessageIdKey.length === 0) {
      return;
    }
    const serverIds = new Set(
      serverMessageIdKey.length > 0
        ? serverMessageIdKey.split("\0").map((messageId) => MessageId.makeUnsafe(messageId))
        : [],
    );
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setThreadOptimisticUserMessages(threadId, (existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    activeThread?.id,
    handoffAttachmentPreviews,
    serverMessageIdKey,
    optimisticUserMessages,
    setThreadOptimisticUserMessages,
    threadId,
  ]);

  const closeExpandedImage = () => {
    setExpandedImageState(null);
  };
  const navigateExpandedImage = useStableCallback((direction: -1 | 1) => {
    setExpandedImageState((existing) => {
      if (!existing || existing.threadId !== threadId || existing.preview.images.length <= 1) {
        return existing;
      }
      const nextIndex =
        (existing.preview.index + direction + existing.preview.images.length) %
        existing.preview.images.length;
      if (nextIndex === existing.preview.index) {
        return existing;
      }
      return { ...existing, preview: { ...existing.preview, index: nextIndex } };
    });
  });

  useEffect(() => {
    if (!expandedImage) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeExpandedImage();
        return;
      }
      if (expandedImage.images.length <= 1) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateExpandedImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateExpandedImage(1);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expandedImage, navigateExpandedImage]);

  const activeWorktreePath = activeThread?.worktreePath;
  const envMode: DraftThreadEnvMode = activeWorktreePath
    ? "worktree"
    : isLocalDraftThread
      ? (draftThread?.envMode ?? "local")
      : activeThread
        ? (threadEnvModeOverrideById[activeThread.id] ?? "local")
        : "local";

  const {
    setPrompt,
    addComposerImagesToDraft,
    addComposerTerminalContextsToDraft,
    handleComposerSubmit,
    handleQueueComposerMessage,
    onEditQueuedComposerMessage,
    onSteerQueuedComposerMessage,
    handleSubagentComposerSubmit,
    canSendQueuedComposerMessages,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    toggleInteractionMode,
    dismissPendingComposerComment,
    clearPendingComposerComments,
    pendingComposerComments,
    queuePreparedMessage,
    removeQueuedComposerMessage,
    clearQueuedComposerMessages,
    reorderQueuedComposerMessages,
    dispatchQueuedComposerMessage,
    ensureQueuedComposerThread,
    appendQueuedComposerMessage,
  } = useChatViewComposerActions({
    threadId,
    activeThread: activeThread as UseChatViewComposerActionsInput["activeThread"],
    isServerThread,
    isLocalDraftThread,
    liveTurnInProgress,
    isSendBusy,
    isConnecting,
    sendInFlight,
    activeProject: activeProject as UseChatViewComposerActionsInput["activeProject"],
    activeProjectId: activeProjectId ?? undefined,
    gitCwd,
    isGitRepo,
    envMode,
    selectedModelSelection,
    runtimeMode,
    interactionMode,
    providerStatuses: [...providerStatuses],
    modelSettings: {
      providers: Object.fromEntries(
        Object.entries(modelSettings.providers).map(([key, value]) => [
          key,
          { ...value, instances: [...value.instances] },
        ]),
      ),
    },
    composerProviderCommands: composerProviderCommands.map(({ name, kind, promptPrefix }) => ({
      name,
      ...(kind != null && { kind }),
      ...(promptPrefix != null && { promptPrefix }),
    })),
    composerModelOptions,
    selectedProvider,
    selectedProviderModels: [...selectedProviderModels],
    selectedModel,
    activeProposedPlan: activeProposedPlan as UseChatViewComposerActionsInput["activeProposedPlan"],
    showPlanFollowUpPrompt,
    workLogEntries,
    queryClient,
    optimisticQueuedDispatchMessageId,
    queuedComposerMessages,
    queuedSteerRequest,
    optimisticQueuedComposerStateRef,
    composerImagesRef,
    composerTerminalContextsRef,
    promptRef,
    sendInFlightRef,
    queuedDesignMessageEditRef,
    queuedComposerMessagesRef,
    queuedSteerRequestRef,
    composerPanelsRef,
    setThreadError,
    forceStickToBottom,
    scheduleComposerFocus,
    setThreadOptimisticUserMessages,
    setOptimisticQueuedDispatchState,
    pendingComposerCommentsByThreadId,
    setPendingComposerCommentsByThreadId,
    setThreadEnvModeOverrideById,
    beginLocalDispatch,
    resetLocalDispatch,
    setSendInFlightState,
    applyOptimisticQueuedComposerState,
    restoreOptimisticQueuedComposerState,
    setStickyComposerModelSelection,
    setComposerDraftModelSelection,
    setComposerDraftRuntimeMode,
    setComposerDraftInteractionMode,
    setDraftThreadContext,
    activePendingProgress,
    activePendingUserInput,
    activePendingResolvedAnswers,
    rightSidePanelEnabled,
    setRightSidePanelMode,
    setRightSidePanelVisible,
  });

  useEffect(() => {
    ensureQueuedComposerThreadRef.current = ensureQueuedComposerThread;
    appendQueuedComposerMessageRef.current = appendQueuedComposerMessage;
  }, [appendQueuedComposerMessage, ensureQueuedComposerThread]);

  // readCurrentComposerExecutionModeState, handleRuntimeModeChange,
  // handleInteractionModeChange, toggleInteractionMode
  // are provided by useChatViewComposerActions hook above.
  useEffect(() => {
    if (!ownsGlobalSideEffects) return;
    if (!shortcutsEnabled) return;
    if (!isElectron) return;
    return window.desktopBridge?.onMenuAction((action) => {
      if (!activeThreadId) {
        return;
      }

      if (action === "toggle-terminal") {
        toggleTerminalVisibility();
        return;
      }

      if (action === "open-review-tab") {
        onOpenRightSidePanelDiff();
        return;
      }

      if (action === "toggle-plan-mode") {
        toggleInteractionMode();
      }
    });
  }, [
    activeThreadId,
    ownsGlobalSideEffects,
    onOpenRightSidePanelDiff,
    shortcutsEnabled,
    toggleInteractionMode,
    toggleTerminalVisibility,
  ]);

  const pendingComposerCommentItems = pendingComposerComments.map((comment) => ({
    id: comment.id,
    sourceLabel: comment.source === "review" ? "Review comment" : "Browser comment",
    targetLabel: comment.targetLabel,
    body: comment.body,
    previewUrl: comment.image?.dataUrl ?? null,
  }));

  useLayoutEffect(() => {
    if (!activeThreadId) return;
    const current = Boolean(terminalState.terminalOpen);
    if (!ownsGlobalSideEffects) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      return;
    }
    const previous = terminalOpenByThreadRef.current[activeThreadId] ?? false;

    if (!previous && current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      return scheduleComposerFocus();
    }

    terminalOpenByThreadRef.current[activeThreadId] = current;
  }, [
    activeThreadId,
    ownsGlobalSideEffects,
    scheduleComposerFocus,
    setTerminalFocusRequestId,
    terminalState.terminalOpen,
  ]);

  const {
    terminalToggleShortcutLabel,
    newTerminalShortcutLabel,
    newTerminalTabShortcutLabel,
    rightSidePanelToggleShortcutLabel,
    rightSidePanelFullscreenShortcutLabel,
    rightSidePanelFloatingChatShortcutLabel,
    reviewPanelShortcutLabel,
    rightPanelEditorShortcutLabel,
    rightPanelTerminalShortcutLabel,
    togglePlanModeShortcutLabel,
    browserBackShortcutLabel,
    browserForwardShortcutLabel,
    browserReloadShortcutLabel,
    browserDevToolsShortcutLabel,
    browserNewTabShortcutLabel,
    browserDesignerAreaCommentShortcutLabel,
    browserDesignerElementCommentShortcutLabel,
  } = useChatViewKeyboardShortcuts({
    activeThreadId: activeThread?.id,
    ownsGlobalSideEffects,
    shortcutsEnabled,
    terminalOpen: Boolean(terminalState.terminalOpen),
    activeTerminalId: terminalState.activeTerminalId,
    rightSidePanelTerminalOpen,
    anyBrowserOpen,
    bottomBrowserInstanceId,
    rightBrowserInstanceId,
    browserControllerByThread,
    rightSidePanelOpen,
    rightSidePanelFullscreen,
    rightSidePanelMode,
    bottomPanelElementRef,
    rightSidePanelElementRef,
    keybindings,
    activeProject,
    toggleTerminalVisibility,
    setTerminalOpen,
    setBottomPanelMode,
    createNewTerminal,
    createNewPanelTerminal,
    createSplitTerminal,
    closeTerminal: closeTerminal as (terminalId: string | null) => void,
    onOpenRightSidePanelTerminal,
    onCloseRightSidePanelTerminal,
    onOpenBottomPanelDiff,
    onOpenRightSidePanelDiff,
    onToggleRightSidePanel,
    onToggleRightSidePanelFullscreen,
    onToggleRightSidePanelFloatingChat,
    openBrowser,
    onOpenBottomPanelBrowser,
    onOpenRightSidePanelBrowserTab,
    onOpenBottomPanelBrowserTab,
    toggleInteractionMode,
    toggleWorkspaceMode,
    onOpenBottomPanelEditor,
    onOpenRightSidePanelEditor,
    toggleHeaderVisibility,
    setTerminalFocusRequestId,
    runProjectScript,
    expandedImage: expandedImage as { images: { id: string }[] } | null,
    closeExpandedImage,
    navigateExpandedImage: navigateExpandedImage as (delta: number) => void,
    terminalOpenByThreadRef,
    scheduleComposerFocus,
    browserControllerRef,
  });

  const onRevertToTurnCount = async (turnCount: number) => {
    const api = readNativeApi();
    if (!api || !activeThread || isRevertingCheckpoint) return;

    if (liveTurnInProgress || isSendBusy || isConnecting) {
      setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
      return;
    }
    const confirmed = await api.dialogs.confirm(
      buildCheckpointRestoreConfirmation(activeThread.session?.provider, turnCount),
    );
    if (!confirmed) {
      return;
    }

    setIsRevertingCheckpoint(true);
    setThreadError(activeThread.id, null);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.checkpoint.revert",
        commandId: newCommandId(),
        threadId: activeThread.id,
        turnCount,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      setThreadError(
        activeThread.id,
        err instanceof Error
          ? err.message
          : checkpointRestoreFailureMessage(activeThread.session?.provider),
      );
    }
    setIsRevertingCheckpoint(false);
  };

  const dispatchComposerMessage = async (
    submission: {
      prompt: string;
      images: Array<ComposerImageAttachment | QueuedComposerImageAttachment>;
      terminalContexts: TerminalContextDraft[];
      modelSelection: ModelSelection;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    },
    options?: {
      onFailure?: () => void;
      restorePrompt?: string;
    },
  ) => {
    const api = readNativeApi();
    if (!api || !activeThread || sendInFlightRef.current) return false;
    if (!activeProject) return false;

    const promptForSend = stripComposerInlineMarkers(submission.prompt);
    const composerImagesSnapshot = [...submission.images];
    const composerTerminalContextsSnapshot = [...submission.terminalContexts];
    const threadIdForSend = activeThread.id;
    const submissionModelOptions = submission.modelSelection.options
      ? {
          [submission.modelSelection.provider]: submission.modelSelection.options,
        }
      : null;
    const submissionProviderModels = getProviderModels(
      providerStatuses,
      submission.modelSelection.provider,
      submission.modelSelection.providerInstanceId,
    );
    const submissionProviderState = getComposerProviderState({
      provider: submission.modelSelection.provider,
      model: submission.modelSelection.model,
      models: submissionProviderModels,
      prompt: promptForSend,
      modelOptions: submissionModelOptions,
    });
    const isFirstMessage = !isServerThread || activeThread.messages.length === 0;
    const baseBranchForWorktree =
      isFirstMessage && envMode === "worktree" && !activeThread.worktreePath
        ? activeThread.branch
        : null;

    const shouldCreateWorktree =
      isFirstMessage && envMode === "worktree" && !activeThread.worktreePath;
    if (shouldCreateWorktree && !activeThread.branch) {
      setStoreThreadError(
        threadIdForSend,
        "Select a base branch before sending in New worktree mode.",
      );
      return false;
    }

    const strippedPrompt = deriveDisplayedUserMessageState(promptForSend).visibleText.trim();
    const messageTextForSend = appendTerminalContextsToPrompt(
      promptForSend,
      composerTerminalContextsSnapshot,
    );
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = formatOutgoingPrompt({
      provider: submission.modelSelection.provider,
      model: submission.modelSelection.model,
      models: submissionProviderModels,
      effort: submissionProviderState.promptEffort,
      text: messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
    });
    const failureContext: ComposerDispatchFailureContext = {
      provider: submission.modelSelection.provider,
      model: submission.modelSelection.model,
      visiblePromptLength: strippedPrompt.length,
      outgoingPromptLength: outgoingMessageText.length,
      imageCount: composerImagesSnapshot.length,
      imageBytes: composerImagesSnapshot.reduce((total, image) => total + image.sizeBytes, 0),
      terminalContextCount: composerTerminalContextsSnapshot.length,
      terminalContextChars: composerTerminalContextsSnapshot.reduce(
        (total, context) => total + context.text.length,
        0,
      ),
    };
    const turnAttachmentsPromise = Promise.all(
      composerImagesSnapshot.map(async (image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: "dataUrl" in image ? image.dataUrl : await readFileAsDataUrl(image.file),
      })),
    );
    const optimisticAttachments = composerImagesSnapshot.map((image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    }));

    setSendInFlightState(true);
    beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });
    const optimisticUserMessage: ChatMessage = {
      id: messageIdForSend,
      role: "user",
      text: outgoingMessageText,
      ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
      createdAt: messageCreatedAt,
      streaming: false,
    };
    setThreadOptimisticUserMessages(threadIdForSend, (existing) => [
      ...existing,
      optimisticUserMessage,
    ]);
    primeOptimisticUserTimelineRow({
      threadId: threadIdForSend,
      message: optimisticUserMessage,
    });
    shouldAutoScrollRef.current = true;
    forceStickToBottom();

    setThreadError(threadIdForSend, null);

    let createdServerThreadForLocalDraft = false;
    let turnStartSucceeded = false;
    let nextThreadBranch = activeThread.branch;
    let nextThreadWorktreePath = activeThread.worktreePath;
    await (async () => {
      if (baseBranchForWorktree) {
        beginLocalDispatch({ preparingWorktree: true });
        const newBranch = buildTemporaryWorktreeBranchName();
        const result = await createWorktreeMutation.mutateAsync({
          connectionUrl: activeServerConnectionUrl,
          cwd: activeProject.cwd,
          branch: baseBranchForWorktree,
          newBranch,
        });
        nextThreadBranch = result.worktree.branch;
        nextThreadWorktreePath = result.worktree.path;
        if (isServerThread) {
          await api.orchestration.dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: threadIdForSend,
            branch: result.worktree.branch,
            worktreePath: result.worktree.path,
          });
          setStoreThreadBranch(threadIdForSend, result.worktree.branch, result.worktree.path);
        }
        setThreadEnvModeOverrideById((existing) => {
          const remaining = { ...existing };
          delete remaining[threadIdForSend];
          return remaining;
        });
      }

      let firstComposerImageName: string | null = null;
      if (composerImagesSnapshot.length > 0) {
        const firstComposerImage = composerImagesSnapshot[0];
        if (firstComposerImage) {
          firstComposerImageName = firstComposerImage.name;
        }
      }
      let titleSeed = strippedPrompt;
      if (!titleSeed) {
        if (firstComposerImageName) {
          titleSeed = `Image: ${firstComposerImageName}`;
        } else if (composerTerminalContextsSnapshot.length > 0) {
          titleSeed = formatTerminalContextLabel(composerTerminalContextsSnapshot[0]!);
        } else {
          titleSeed = DEFAULT_THREAD_TITLE;
        }
      }
      const title = truncate(titleSeed);
      const threadCreateModelSelection: ModelSelection = buildProviderModelSelection(
        submission.modelSelection.provider,
        submission.modelSelection.model ||
          activeProject.defaultModelSelection?.model ||
          DEFAULT_MODEL_BY_PROVIDER[submission.modelSelection.provider],
        submission.modelSelection.options,
        submission.modelSelection.providerInstanceId,
      );

      if (isLocalDraftThread) {
        const { orchestration } = api;

        await orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          projectId: activeProject.id,
          title,
          modelSelection: threadCreateModelSelection,
          runtimeMode: submission.runtimeMode,
          interactionMode: submission.interactionMode,
          branch: nextThreadBranch,
          worktreePath: nextThreadWorktreePath,
          createdAt: activeThread.createdAt,
        });
        createdServerThreadForLocalDraft = true;
      }

      let setupScript: ProjectScript | null = null;
      if (baseBranchForWorktree) {
        setupScript = setupProjectScript(activeProject.scripts);
      }
      if (setupScript) {
        let shouldRunSetupScript = false;
        if (isServerThread) {
          shouldRunSetupScript = true;
        } else if (createdServerThreadForLocalDraft) {
          shouldRunSetupScript = true;
        }
        if (shouldRunSetupScript) {
          const setupScriptOptions: Parameters<typeof runProjectScript>[1] = {
            worktreePath: nextThreadWorktreePath,
            rememberAsLastInvoked: false,
          };
          if (nextThreadWorktreePath) {
            setupScriptOptions.cwd = nextThreadWorktreePath;
          }
          await runProjectScript(setupScript, setupScriptOptions);
        }
      }

      if (isFirstMessage && isServerThread) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          title,
        });
      }

      if (isServerThread) {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          modelSelection: submission.modelSelection,
          runtimeMode: submission.runtimeMode,
          interactionMode: submission.interactionMode,
        });
      }

      beginLocalDispatch({ preparingWorktree: false });
      const turnAttachments = await turnAttachmentsPromise;
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          attachments: turnAttachments,
        },
        modelSelection: submission.modelSelection,
        titleSeed: title,
        runtimeMode: submission.runtimeMode,
        interactionMode: submission.interactionMode,
        createdAt: messageCreatedAt,
      });
      turnStartSucceeded = true;
    })().catch(async (err: unknown) => {
      const promptForRestore = options?.restorePrompt ?? promptForSend;
      if (
        !turnStartSucceeded &&
        promptRef.current.length === 0 &&
        composerImagesRef.current.length === 0 &&
        composerTerminalContextsRef.current.length === 0
      ) {
        setThreadOptimisticUserMessages(threadIdForSend, (existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        removeOptimisticUserTimelineRow({
          threadId: threadIdForSend,
          messageId: messageIdForSend,
        });
        promptRef.current = promptForRestore;
        setPrompt(promptForRestore);
        addComposerImagesToDraft(
          composerImagesSnapshot.flatMap((image) =>
            "dataUrl" in image ? [] : [cloneComposerImageForRetry(image)],
          ),
        );
        addComposerTerminalContextsToDraft(composerTerminalContextsSnapshot);
        composerPanelsRef.current?.resetUi(promptForRestore);
      }
      options?.onFailure?.();
      setThreadError(threadIdForSend, formatComposerDispatchFailureMessage(err, failureContext));
    });
    setSendInFlightState(false);
    if (!turnStartSucceeded) {
      resetLocalDispatch();
    }
    return turnStartSucceeded;
  };
  const sendQueuedComposerMessage = async (messageId: MessageId) => {
    if (!serverThread || liveTurnInProgress || isSendBusy || isConnecting) {
      return;
    }
    if (sendInFlightRef.current) {
      return;
    }
    if (!queuedComposerMessagesRef.current.some((message) => message.id === messageId)) {
      return;
    }
    const targetThreadId = serverThread.id;
    setOptimisticQueuedDispatchState({ threadId: targetThreadId, messageId });
    const succeeded = await dispatchQueuedComposerMessage(targetThreadId, messageId);
    if (!succeeded) {
      setOptimisticQueuedDispatchState((current) =>
        current?.threadId === targetThreadId && current.messageId === messageId ? null : current,
      );
    }
  };
  const submitWorkspaceAgentNote = async (input: {
    mode: "queue" | "send";
    prompt: string;
    threadId?: ThreadId;
  }) => {
    const trimmedPrompt = input.prompt.trim();
    if (trimmedPrompt.length === 0) {
      return false;
    }
    const activeComposerThreadId = activeThread?.id ?? threadId;
    const targetThreadId = input.threadId ?? activeComposerThreadId;
    if (input.mode === "queue") {
      return queuePreparedMessage(trimmedPrompt, [], { targetThreadId });
    }
    if (targetThreadId !== activeComposerThreadId) {
      return queuePreparedMessage(trimmedPrompt, [], { targetThreadId });
    }
    if (liveTurnInProgress || isSendBusy || isConnecting || sendInFlightRef.current) {
      return false;
    }
    return dispatchComposerMessage({
      prompt: trimmedPrompt,
      images: [],
      terminalContexts: [],
      modelSelection: selectedModelSelection,
      runtimeMode,
      interactionMode,
    });
  };

  const onForkConversation = useStableCallback(async () => {
    const api = readNativeApi();
    if (!api || !activeThread || !activeProject || !isServerThread) {
      return;
    }
    if (activeThread.messages.length === 0) {
      toastManager.add({
        type: "error",
        title: "Send a message before forking.",
      });
      return;
    }
    if (
      handoffInFlight ||
      liveTurnInProgress ||
      isSendBusy ||
      isConnecting ||
      sendInFlightRef.current
    ) {
      toastManager.add({
        type: "error",
        title: "Wait for the current turn to finish.",
      });
      return;
    }

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const modelSelection = activeThread.modelSelection;
    const nextThreadTitle = truncate(`${activeThread.title} fork`);

    setHandoffInFlight(true);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection,
        runtimeMode,
        interactionMode,
        branch: activeThread.branch,
        worktreePath: activeThread.worktreePath,
        fork: {
          sourceThreadId: activeThread.id,
          createdAt,
        },
        createdAt,
      });

      setComposerDraftModelSelection(nextThreadId, modelSelection);
      setStickyComposerModelSelection(modelSelection);

      try {
        const readModelThread = await hydrateThreadFromCache(nextThreadId, {
          expectedUpdatedAt: null,
        });
        startTransition(() => {
          hydrateThreadFromReadModel(readModelThread);
        });
      } catch (error) {
        console.error("Failed to hydrate new fork thread", error);
      }

      await navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not create fork thread",
        description:
          error instanceof Error
            ? error.message
            : "An error occurred while creating the fork thread.",
      });
      setHandoffInFlight(false);
      return;
    }
    setHandoffInFlight(false);
  });

  const clearPendingInterruptStopFallback = useCallback(() => {
    if (pendingInterruptStopFallbackRef.current === null) {
      return;
    }
    window.clearTimeout(pendingInterruptStopFallbackRef.current);
    pendingInterruptStopFallbackRef.current = null;
  }, []);

  const dispatchInterruptStopFallback = useCallback(
    async (targetThreadId: ThreadId, targetTurnId: TurnId | null) => {
      const api = readNativeApi();
      if (!api) {
        return;
      }

      const targetThread = getThreadById(useStore.getState().threads, targetThreadId);
      if (
        !shouldEscalateInterruptToSessionStop({
          thread: targetThread,
          interruptedTurnId: targetTurnId,
        })
      ) {
        return;
      }

      await api.orchestration
        .dispatchCommand({
          type: "thread.session.stop",
          commandId: newCommandId(),
          threadId: targetThreadId,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setStoreThreadError(
            targetThreadId,
            err instanceof Error ? err.message : "Failed to stop the thread session.",
          );
        });
    },
    [setStoreThreadError],
  );

  const scheduleInterruptStopFallback = (targetThreadId: ThreadId, targetTurnId: TurnId | null) => {
    clearPendingInterruptStopFallback();
    pendingInterruptStopFallbackRef.current = window.setTimeout(() => {
      pendingInterruptStopFallbackRef.current = null;
      void dispatchInterruptStopFallback(targetThreadId, targetTurnId);
    }, INTERRUPT_STOP_FALLBACK_DELAY_MS);
  };

  useEffect(() => {
    if (liveTurnInProgress) {
      return;
    }
    clearPendingInterruptStopFallback();
  }, [clearPendingInterruptStopFallback, liveTurnInProgress]);

  useEffect(() => () => clearPendingInterruptStopFallback(), [clearPendingInterruptStopFallback]);

  const onInterrupt = useStableCallback(async () => {
    const api = readNativeApi();
    if (!api || !activeThread) return;
    const interruptedTurnId =
      activeThread.session?.activeTurnId ?? activeLatestTurn?.turnId ?? null;
    const interruptedThreadId = activeThread.id;
    const createdAt = new Date().toISOString();
    setOptimisticInactiveTurnState({
      threadId: interruptedThreadId,
      turnId: interruptedTurnId,
      requestedAt: createdAt,
    });
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: newCommandId(),
        threadId: interruptedThreadId,
        createdAt,
      });
      scheduleInterruptStopFallback(interruptedThreadId, interruptedTurnId);
    } catch (err) {
      setOptimisticInactiveTurnState((current) =>
        current?.threadId === interruptedThreadId && current.turnId === interruptedTurnId
          ? null
          : current,
      );
      setStoreThreadError(
        interruptedThreadId,
        err instanceof Error ? err.message : "Failed to stop the current turn.",
      );
    }
  });

  const onRespondToApproval = async (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => {
    const api = readNativeApi();
    if (!api || !activeThreadId) return;

    setRespondingRequestIds((existing) =>
      existing.includes(requestId) ? existing : [...existing, requestId],
    );
    await api.orchestration
      .dispatchCommand({
        type: "thread.approval.respond",
        commandId: newCommandId(),
        threadId: activeThreadId,
        requestId,
        decision,
        createdAt: new Date().toISOString(),
      })
      .catch((err: unknown) => {
        setStoreThreadError(
          activeThreadId,
          err instanceof Error ? err.message : "Failed to submit approval decision.",
        );
      });
    setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
  };

  const onRespondToUserInput = async (
    requestId: ApprovalRequestId,
    answers: Record<string, unknown>,
  ) => {
    if (!activeThreadId) return;

    setRespondingUserInputRequestIds((existing) =>
      existing.includes(requestId) ? existing : [...existing, requestId],
    );
    const api = readNativeApi();
    if (!api) {
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
      return;
    }
    await api.orchestration
      .dispatchCommand({
        type: "thread.user-input.respond",
        commandId: newCommandId(),
        threadId: activeThreadId,
        requestId,
        answers,
        createdAt: new Date().toISOString(),
      })
      .catch((err: unknown) => {
        setStoreThreadError(
          activeThreadId,
          err instanceof Error ? err.message : "Failed to submit user input.",
        );
      });
    setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
  };

  const setActivePendingUserInputQuestionIndex = (nextQuestionIndex: number) => {
    if (!activePendingUserInput) {
      return;
    }
    setPendingUserInputQuestionIndexByRequestId((existing) => ({
      ...existing,
      [activePendingUserInput.requestId]: nextQuestionIndex,
    }));
  };

  const onSelectActivePendingUserInputOption = (questionId: string, optionLabel: string) => {
    if (!activePendingUserInput) {
      return;
    }
    const question = activePendingUserInput.questions.find((entry) => entry.id === questionId);
    if (!question) {
      return;
    }
    setPendingUserInputAnswersByRequestId((existing) => ({
      ...existing,
      [activePendingUserInput.requestId]: {
        ...existing[activePendingUserInput.requestId],
        [questionId]: selectPendingUserInputOption(
          question,
          existing[activePendingUserInput.requestId]?.[questionId],
          optionLabel,
        ),
      },
    }));
    promptRef.current = "";
    composerPanelsRef.current?.resetUi("");
  };

  const onChangeActivePendingUserInputCustomAnswer = (
    questionId: string,
    value: string,
    _nextCursor: number,
    _expandedCursor: number,
    _cursorAdjacentToMention: boolean,
  ) => {
    if (!activePendingUserInput) {
      return;
    }
    promptRef.current = value;
    setPendingUserInputAnswersByRequestId((existing) => ({
      ...existing,
      [activePendingUserInput.requestId]: {
        ...existing[activePendingUserInput.requestId],
        [questionId]: setPendingUserInputCustomAnswer(
          existing[activePendingUserInput.requestId]?.[questionId],
          value,
        ),
      },
    }));
  };

  const onAdvanceActivePendingUserInput = () => {
    if (!activePendingUserInput || !activePendingProgress) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  };

  const onPreviousActivePendingUserInputQuestion = () => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  };

  const onImplementPlanInNewThread = async () => {
    const api = readNativeApi();
    if (
      !api ||
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      sendInFlightRef.current
    ) {
      return;
    }

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: selectedProvider,
      model: selectedModel,
      models: selectedProviderModels,
      effort: readCurrentSelectedPromptEffort(),
      text: implementationPrompt,
    });
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = selectedModelSelection;

    setSendInFlightState(true);
    beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      setSendInFlightState(false);
      resetLocalDispatch();
    };

    await api.orchestration
      .dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        runtimeMode,
        interactionMode: "default",
        branch: activeThread.branch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      })
      .then(() => {
        return api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: selectedModelSelection,
          titleSeed: nextThreadTitle,
          runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        });
      })
      .then(() => {
        return waitForStartedServerThread(nextThreadId);
      })
      .then(() => {
        openSummaryOnNextThreadRef.current = true;
        return navigate({
          to: "/$threadId",
          params: { threadId: nextThreadId },
        });
      })
      .catch(async (err) => {
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: nextThreadId,
          })
          .catch((cleanupErr: unknown) => {
            reportBackgroundError(
              "Failed to clean up thread after plan implementation failure.",
              cleanupErr,
            );
          });
        toastManager.add({
          type: "error",
          title: "Could not start implementation thread",
          description:
            err instanceof Error ? err.message : "An error occurred while creating the new thread.",
        });
      })
      .then(finish, finish);
  };

  const onHandoffToProvider = async (provider: ProviderKind, _mode: ThreadHandoffMode) => {
    if (handoffDisabledReason) {
      toastManager.add({
        type: "error",
        title: handoffDisabledReason,
      });
      return;
    }
    const api = readNativeApi();
    if (!api || !activeThread || !activeProject || !isServerThread) {
      return;
    }
    if (handoffInFlight) {
      return;
    }
    const resolvedProvider = resolveSelectableProvider(providerStatuses, provider);
    if (resolvedProvider === activeThread.modelSelection.provider) {
      toastManager.add({
        type: "warning",
        title: "Choose a different provider to handoff.",
      });
      return;
    }

    const { selectedModel, modelOptions } = deriveEffectiveComposerModelState({
      draft: composerShellDraft,
      providers: providerStatuses,
      selectedProvider: resolvedProvider,
      threadModelSelection: activeThread.modelSelection,
      projectModelSelection: activeProject.defaultModelSelection,
      settings: modelSettings,
    });
    const resolvedProviderModels = getProviderModels(providerStatuses, resolvedProvider);
    const { modelOptionsForDispatch } = getComposerProviderState({
      provider: resolvedProvider,
      model: selectedModel,
      models: resolvedProviderModels,
      prompt: "",
      modelOptions,
    });
    const modelSelection = buildProviderModelSelection(
      resolvedProvider,
      selectedModel,
      modelOptionsForDispatch,
    );
    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const providerLabel = PROVIDER_DISPLAY_NAMES[resolvedProvider] ?? resolvedProvider;
    const nextThreadTitle = truncate(`${activeThread.title} \u2192 ${providerLabel}`);

    setHandoffInFlight(true);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection,
        runtimeMode,
        interactionMode,
        branch: activeThread.branch,
        worktreePath: activeThread.worktreePath,
        handoff: {
          sourceThreadId: activeThread.id,
          fromProvider: resolveHandoffSourceProvider(activeThread),
          toProvider: resolvedProvider,
          mode: "best",
          createdAt,
        },
        createdAt,
      });

      setComposerDraftModelSelection(nextThreadId, modelSelection);
      setStickyComposerModelSelection(modelSelection);

      try {
        const readModelThread = await hydrateThreadFromCache(nextThreadId, {
          expectedUpdatedAt: null,
        });
        startTransition(() => {
          hydrateThreadFromReadModel(readModelThread);
        });
      } catch (error) {
        console.error("Failed to hydrate new handoff thread", error);
      }

      await navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not create handoff thread",
        description:
          error instanceof Error
            ? error.message
            : "An error occurred while creating the handoff thread.",
      });
      setHandoffInFlight(false);
      return;
    }
    setHandoffInFlight(false);
  };

  const onEnvModeChange = (mode: DraftThreadEnvMode) => {
    if (isLocalDraftThread) {
      setDraftThreadContext(threadId, { envMode: mode });
    } else if (activeThread) {
      setThreadEnvModeOverrideById((existing) => ({
        ...existing,
        [activeThread.id]: mode,
      }));
    }
    scheduleComposerFocus();
  };
  const onNewWorktreeRequest = () => {
    if (!activeProject) {
      return;
    }
    const baseBranch = activeThread?.branch ?? activeThreadBranchName ?? null;
    void handleNewThread(activeProject.id, {
      branch: baseBranch,
      worktreePath: null,
      envMode: "worktree",
      connectionUrl: activeServerConnectionUrl,
    }).then(
      () => scheduleComposerFocus(),
      (error) => {
        toastManager.add({
          type: "error",
          title: "Could not start a new worktree",
          description:
            error instanceof Error
              ? error.message
              : "An error occurred while preparing the worktree draft.",
        });
      },
    );
  };
  const onToggleWorkGroup = useStableCallback(
    (groupId: TimelineDisclosureKey, defaultExpanded?: boolean) => {
      if (!activeThreadId) {
        return;
      }
      setExpandedWorkGroupsByThreadId((existingByThreadId) => {
        const existing = existingByThreadId[activeThreadId] ?? {};
        return {
          ...existingByThreadId,
          [activeThreadId]: toggleTimelineDisclosureExpansion(
            existing,
            groupId,
            defaultExpanded ?? false,
          ),
        };
      });
    },
  );
  const onExpandTimelineImage = useStableCallback((preview: ExpandedImagePreview) => {
    if (!resolveExpandedImageItem(preview)) {
      return;
    }
    setExpandedImageState({ threadId, preview });
  });
  const expandedImageItem = resolveExpandedImageItem(expandedImage);
  const onOpenTurnDiff = useStableCallback((turnId: TurnId, filePath?: string) => {
    if (!rightSidePanelEnabled) {
      return;
    }
    setRightSidePanelDiffOpenState(true);
    setRightSidePanelReviewOpen(true);
    setRightSidePanelMode("diff");
    setRightSidePanelVisible(true);
    setLocalDiffState({ open: true, turnId, filePath: filePath ?? null });
  });
  const onRevertUserMessage = useStableCallback((messageId: MessageId) => {
    const targetTurnCount = revertTurnCountByUserMessageId.get(messageId);
    if (typeof targetTurnCount !== "number") {
      return;
    }
    void onRevertToTurnCount(targetTurnCount);
  });
  const onRevertAssistantMessage = useStableCallback((messageId: MessageId) => {
    const targetTurnCount = revertTurnCountByAssistantMessageId.get(messageId);
    if (typeof targetTurnCount !== "number") {
      return;
    }
    void onRevertToTurnCount(targetTurnCount);
  });
  const onFixGitHubIssue = async (payload: {
    prompt: string;
    images: ComposerImageAttachment[];
  }) => {
    if (!activeThread) {
      return;
    }
    const { prompt: issuePrompt, images } = payload;
    if (
      liveTurnInProgress ||
      isSendBusy ||
      isConnecting ||
      sendInFlightRef.current ||
      activePendingProgress ||
      activePendingApproval
    ) {
      const queued = await queuePreparedMessage(issuePrompt, images);
      if (queued) {
        closeGitHubIssueDialog();
      }
      return;
    }

    closeGitHubIssueDialog();
    await dispatchComposerMessage({
      prompt: issuePrompt,
      images,
      terminalContexts: [],
      modelSelection: selectedModelSelection,
      runtimeMode,
      interactionMode,
    });
  };
  const onFixGitHubIssuesInParallelWorktrees = async (issueNumbers: ReadonlyArray<number>) => {
    const api = readNativeApi();
    if (!api || !activeThread || !activeProject) {
      return;
    }
    if (issueNumbers.length === 0) {
      return;
    }
    if (!gitCwd || !isGitRepo) {
      toastManager.add({
        type: "error",
        title: "GitHub issues are unavailable",
        description: "Open a Git repository to solve issues in parallel worktrees.",
      });
      return;
    }
    const activeThreadBranch = activeThread.branch;
    if (!activeThreadBranch) {
      toastManager.add({
        type: "warning",
        title: "Select a base branch first",
        description: "Parallel worktrees need a base branch to branch from.",
      });
      return;
    }

    const setupScript = setupProjectScript(activeProject.scripts);
    const startedIssueNumbers: number[] = [];
    const failureMessages: string[] = [];
    const startIssueInParallelWorktree = async (
      issueNumber: number,
    ): Promise<{ issueNumber: number; success: boolean; error?: Error | string }> => {
      const nextThreadId = newThreadId();
      let threadCreated = false;

      try {
        const payload = await buildGitHubIssueSelectionPayload({
          cwd: gitCwd,
          issueNumbers: [issueNumber],
          queryClient,
        });
        const issueThread = payload.threads[0];
        if (!issueThread) {
          return {
            issueNumber,
            success: false,
            error: `Issue #${issueNumber} did not return thread details.`,
          };
        }

        const createdAt = new Date().toISOString();
        const issueTitle = truncate(`#${issueThread.number} ${issueThread.title}`);
        const providerModels = getProviderModels(
          providerStatuses,
          selectedModelSelection.provider,
          selectedModelSelection.providerInstanceId,
        );
        const outgoingIssuePrompt = formatOutgoingPrompt({
          provider: selectedModelSelection.provider,
          model: selectedModelSelection.model,
          models: providerModels,
          effort: readCurrentSelectedPromptEffort(),
          text: payload.prompt,
        });
        const turnAttachments = await Promise.all(
          payload.images.map(async (image) => ({
            type: "image" as const,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl: await readFileAsDataUrl(image.file),
          })),
        );
        const worktreeResult = await createWorktreeMutation.mutateAsync({
          connectionUrl: activeServerConnectionUrl,
          cwd: activeProject.cwd,
          branch: activeThreadBranch,
          newBranch: buildTemporaryWorktreeBranchName(),
        });
        const { worktree } = worktreeResult;
        const { orchestration } = api;

        await orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId: nextThreadId,
          projectId: activeProject.id,
          title: issueTitle,
          modelSelection: selectedModelSelection,
          runtimeMode,
          interactionMode,
          branch: worktree.branch,
          worktreePath: worktree.path,
          createdAt,
        });
        threadCreated = true;

        if (setupScript) {
          await runProjectScript(setupScript, {
            cwd: worktree.path,
            worktreePath: worktreeResult.worktree.path,
            rememberAsLastInvoked: false,
          });
        }

        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingIssuePrompt,
            attachments: turnAttachments,
          },
          modelSelection: selectedModelSelection,
          titleSeed: issueTitle,
          runtimeMode,
          interactionMode,
          createdAt,
        });

        try {
          const readModelThread = await hydrateThreadFromCache(nextThreadId, {
            expectedUpdatedAt: null,
          });
          startTransition(() => {
            hydrateThreadFromReadModel(readModelThread);
          });
        } catch (error) {
          reportBackgroundError("Failed to hydrate issue worktree thread.", error);
        }

        return { issueNumber, success: true };
      } catch (error) {
        if (threadCreated) {
          await api.orchestration
            .dispatchCommand({
              type: "thread.delete",
              commandId: newCommandId(),
              threadId: nextThreadId,
            })
            .catch((cleanupError: unknown) => {
              reportBackgroundError(
                "Failed to clean up issue worktree thread after startup failure.",
                cleanupError,
              );
            });
        }
        return {
          issueNumber,
          success: false,
          error: error instanceof Error ? error.message : "Failed to start.",
        };
      }
    };

    const issueStartResults = await Promise.all(issueNumbers.map(startIssueInParallelWorktree));
    for (const result of issueStartResults) {
      if (result.success) {
        startedIssueNumbers.push(result.issueNumber);
      } else {
        failureMessages.push(
          result.error
            ? `#${result.issueNumber}: ${result.error}`
            : `#${result.issueNumber}: Failed to start.`,
        );
      }
    }

    if (startedIssueNumbers.length > 0) {
      closeGitHubIssueDialog();
    }

    if (startedIssueNumbers.length > 0 && failureMessages.length === 0) {
      toastManager.add({
        type: "success",
        title:
          startedIssueNumbers.length === 1
            ? `Started issue #${startedIssueNumbers[0]} in a worktree`
            : `Started ${startedIssueNumbers.length} issue threads in parallel`,
        description:
          startedIssueNumbers.length === 1
            ? "The agent is now working in a dedicated worktree thread."
            : "Each selected issue is running in its own dedicated worktree thread.",
      });
      return;
    }

    if (startedIssueNumbers.length > 0) {
      toastManager.add({
        type: "warning",
        title: `Started ${startedIssueNumbers.length} of ${issueNumbers.length} issue threads`,
        description: failureMessages[0] ?? "Some issue threads could not be started.",
      });
      return;
    }

    toastManager.add({
      type: "error",
      title: "Could not start issue worktree threads",
      description: failureMessages[0] ?? "Please try again.",
    });
  };

  const isLineageThread = Boolean(
    serverThread?.handoff ?? serverThread?.fork ?? activeThread?.handoff ?? activeThread?.fork,
  );
  const activeThreadIdValue = activeThread?.id ?? "";
  const activeThreadMessagesLength = activeThreadMessages.length;
  const activeThreadProvider = activeThread?.session?.provider;
  const activeThreadModelProvider = activeThread?.modelSelection.provider;
  const canForkActiveThread = isServerThread && activeThreadMessagesLength > 0;
  const activeThreadWorkspacePath = activeThread?.worktreePath ?? activeProject?.cwd ?? null;
  const activeThreadRouteHref = activeThread
    ? buildSingleThreadRouteHref(activeThread.id, { connectionUrl: activeServerConnectionUrl })
    : "/";
  const activeThreadAbsoluteHref =
    typeof window === "undefined"
      ? activeThreadRouteHref
      : new URL(activeThreadRouteHref, window.location.origin).toString();
  const [threadRenameDialogOpen, setThreadRenameDialogOpen] = useState(false);
  const submitActiveThreadRename = async (nextTitle: string) => {
    if (!activeThread || !isServerThread) {
      return true;
    }
    const trimmedTitle = nextTitle.trim();
    if (trimmedTitle.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Chat title cannot be empty",
      });
      return false;
    }
    if (trimmedTitle === activeThread.title) {
      return true;
    }
    const api = readNativeApi();
    if (!api) {
      return true;
    }
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: activeThread.id,
        title: trimmedTitle,
      });
      return true;
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to rename chat",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return false;
    }
  };
  const renameActiveThreadFromHeader = () => {
    if (!activeThread || !isServerThread) {
      return;
    }
    window.setTimeout(() => {
      setThreadRenameDialogOpen(true);
    }, 0);
  };
  const archiveActiveThreadFromHeader = () => {
    if (!activeThread) {
      return;
    }
    void archiveThread(activeThread.id).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Failed to archive chat",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  };
  const openActiveThreadSideChat = () => {
    if (!activeThread) {
      return;
    }
    if (activeServerConnectionUrl) {
      useHostConnectionStore
        .getState()
        .upsertThreadOwnership(activeServerConnectionUrl, activeThread.id);
    }
    useChatThreadBoardStore.getState().openThreadInBoard({
      allowDuplicate: true,
      connectionUrl: activeServerConnectionUrl,
      direction: "right",
      paneTitle: activeThread.title,
      threadId: activeThread.id,
    });
    startTransition(() => {
      void navigate({
        to: "/$threadId",
        params: { threadId: activeThread.id },
        search: buildSingleThreadRouteSearch({ connectionUrl: activeServerConnectionUrl }),
      });
    });
  };
  const openActiveThreadWindow = () => {
    if (!activeThread) {
      return;
    }
    window.open(activeThreadAbsoluteHref, "_blank", "noopener,noreferrer");
  };
  const headerMenuActions = activeThread
    ? {
        canArchive: isServerThread && !isWorking,
        canCopyWorkspacePath: Boolean(activeThreadWorkspacePath),
        canFork: canForkActiveThread && !isWorking && !handoffInFlight,
        canOpenSideChat: isServerThread,
        canOpenWindow: typeof window !== "undefined",
        onArchive: archiveActiveThreadFromHeader,
        onCopyLink: () => copyThreadMenuValue(activeThreadAbsoluteHref, { label: "Link" }),
        onCopyThreadId: () => copyThreadMenuValue(activeThread.id, { label: "Thread ID" }),
        onCopyTitle: () => copyThreadMenuValue(activeThread.title, { label: "Title" }),
        onCopyWorkspacePath: () => {
          if (activeThreadWorkspacePath) {
            copyThreadMenuValue(activeThreadWorkspacePath, { label: "Workspace path" });
          }
        },
        onFork: () => {
          void onForkConversation();
        },
        onOpenSideChat: openActiveThreadSideChat,
        onOpenWindow: openActiveThreadWindow,
        onRename: renameActiveThreadFromHeader,
        onTogglePinned: () => togglePinnedThread(activeThread.id),
        pinned: activeThreadPinned,
      }
    : null;
  const [targetMessageNavigation, setTargetMessageNavigation] = useState<{
    messageId: string;
    requestId: number;
    targetKind: "message" | "selection";
    selectedText?: string;
  } | null>(null);
  const jumpToTimelineMessage = (messageId: string, target: PinnedMessageNavigationTarget) => {
    setTargetMessageNavigation((current) => ({
      messageId,
      requestId: (current?.requestId ?? 0) + 1,
      targetKind: target.kind,
      ...(target.kind === "selection" && target.selectedText
        ? { selectedText: target.selectedText }
        : {}),
    }));
  };
  const openThreadDiagnostics = useStableCallback(() => {
    openDiagnostics("thread");
  });
  const messagesTimelineProps = {
    ...(activeThreadIdValue ? { activeThreadId: activeThreadIdValue } : {}),
    hasMessages:
      timelineRows.length > 0 ||
      isThreadHistoryMetadataOnly ||
      isThreadHistoryLoading ||
      isLineageThread,
    isWorking,
    onStartConversationFromMessage: scheduleComposerFocus,
    onContinueWithGitHubIssues: openGitHubIssueDialog,
    isContinueWithGitHubIssuesDisabled: !codingGitCwd || !isGitRepo,
    ...(!codingGitCwd || !isGitRepo
      ? {
          continueWithGitHubIssuesDisabledReason:
            "GitHub issues are available only for Git repositories.",
        }
      : {}),
    activeTurnInProgress: isWorking,
    activeTurnStartedAt: activeWorkStartedAt,
    stuckTurnSnapshot,
    onStopStuckTurn: onInterrupt,
    onOpenStuckTurnDiagnostics: openThreadDiagnostics,
    backgroundMarkdownPrewarm: activeForSideEffects,
    onStreamingLayoutChange: followStreamingLayoutChange,
    hideCompletedWorkMessages,
    liveTimers: activeForSideEffects,
    getScrollContainer: getMessagesScrollContainer,
    timelineCacheScope,
    rows: timelineRows,
    timelineRowsLoading: sourceTimelineRowsLoading,
    completionDividerBeforeEntryId,
    completionSummary,
    turnDiffSummaryByAssistantMessageId,
    expandedWorkGroups,
    onToggleWorkGroup,
    onOpenTurnDiff,
    revertTurnCountByUserMessageId,
    onRevertUserMessage,
    revertTurnCountByAssistantMessageId,
    onRevertAssistantMessage,
    revertActionTitle: checkpointRestoreActionTitle(activeThreadProvider),
    isRevertingCheckpoint,
    onImageExpand: onExpandTimelineImage,
    markdownCwd: codingGitCwd ?? undefined,
    onOpenBrowserUrl: isElectron ? openBrowserUrlInNewTab : null,
    onOpenFilePath: canOpenLocalMarkdownFiles ? openMarkdownFileInAppEditor : null,
    enableLocalFileLinks: canOpenLocalMarkdownFiles,
    providerCommands: composerProviderCommands,
    onForkConversation: canForkActiveThread ? onForkConversation : null,
    isForkConversationDisabled: isWorking || handoffInFlight,
    enableGoalWorkingState: (activeThreadProvider ?? activeThreadModelProvider) === "codex",
    resolvedTheme,
    targetMessageNavigation,
    timestampFormat,
    workspaceRoot: activeProject?.cwd ?? undefined,
  };
  const showDraftNewThreadLanding =
    activeThread !== undefined &&
    activeThread.messages.length === 0 &&
    optimisticUserMessages.length === 0 &&
    !isWorking &&
    (isLocalDraftThread || activeThread.title.trim() === DEFAULT_THREAD_TITLE);
  const [draftEnvironmentPanelExplicitOpen, setDraftEnvironmentPanelExplicitOpen] = useState(false);
  const [composerOverlayActive, setComposerOverlayActive] = useState(false);
  const workspaceSplitEditorOpen = workspaceMode === "split" && !editorHostedInRightPanel;
  const environmentPanelAvailableWidth = Math.max(
    0,
    workspaceViewportSize.width - (workspaceSplitEditorOpen ? workspaceEditorSplitWidth + 12 : 0),
  );
  const environmentPanelInlineGapPx = Math.round(
    Math.min(
      ENVIRONMENT_MINI_PANEL_MAX_GAP_PX,
      Math.max(ENVIRONMENT_MINI_PANEL_MIN_GAP_PX, environmentPanelAvailableWidth * 0.018),
    ),
  );
  const environmentPanelReservedWidthPx =
    ENVIRONMENT_MINI_PANEL_WIDTH_PX +
    ENVIRONMENT_MINI_PANEL_INLINE_INSET_PX +
    environmentPanelInlineGapPx;
  const environmentPanelCanUseInlineLayout =
    environmentPanelAvailableWidth >=
    environmentPanelReservedWidthPx + ENVIRONMENT_MINI_PANEL_MIN_CHAT_WIDTH_PX;
  const environmentPanelVisible = environmentPanelOpen && activeThread !== undefined;
  const environmentPanelCanOpenInline =
    !rightSidePanelFullscreen && (environmentPanelCanUseInlineLayout || composerOverlayActive);
  const environmentPanelInlineOpen = environmentPanelVisible && environmentPanelCanOpenInline;
  const draftEnvironmentPanelVisibleExplicitOpen =
    showDraftNewThreadLanding && environmentPanelVisible && draftEnvironmentPanelExplicitOpen;
  const environmentPanelPopoverOpen =
    environmentPanelVisible &&
    !environmentPanelInlineOpen &&
    (!showDraftNewThreadLanding || draftEnvironmentPanelVisibleExplicitOpen);
  const environmentPanelRenderedOpen = environmentPanelInlineOpen || environmentPanelPopoverOpen;
  const visibleEnvironmentPanelPopoverStyle = environmentPanelPopoverOpen
    ? environmentPanelPopoverStyle
    : null;
  useLayoutEffect(() => {
    if (!environmentPanelPopoverOpen) {
      return;
    }

    const updatePopoverPosition = () => {
      const trigger = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Toggle environment panel"]',
      );
      const triggerRect = trigger?.getBoundingClientRect();
      const panelWidth =
        environmentMiniPanelRef.current?.getBoundingClientRect().width ??
        ENVIRONMENT_MINI_PANEL_WIDTH_PX;
      const panelMargin = ENVIRONMENT_MINI_PANEL_INLINE_INSET_PX;
      const fallbackTop = 64;
      const workspaceRect =
        workspaceViewportRef.current?.getBoundingClientRect() ??
        chatViewportRef.current?.getBoundingClientRect() ??
        null;
      const minLeft = workspaceRect
        ? Math.max(panelMargin, workspaceRect.left + panelMargin)
        : panelMargin;
      const maxLeft = workspaceRect
        ? Math.min(
            window.innerWidth - panelWidth - panelMargin,
            workspaceRect.right - panelWidth - panelMargin,
          )
        : window.innerWidth - panelWidth - panelMargin;
      const clampLeft = (left: number) => Math.max(minLeft, Math.min(left, maxLeft));
      const maxPanelBottom = workspaceRect
        ? Math.min(window.innerHeight - panelMargin, workspaceRect.bottom - panelMargin)
        : window.innerHeight - panelMargin;
      const resolveMaxHeight = (top: number) => Math.max(160, maxPanelBottom - top);
      if (!triggerRect) {
        const top = fallbackTop;
        setEnvironmentPanelPopoverStyle({
          left: clampLeft(maxLeft),
          maxHeight: resolveMaxHeight(top),
          top,
        });
        return;
      }

      const preferredLeft = triggerRect.right - panelWidth;
      const left = clampLeft(preferredLeft);
      const top = Math.max(panelMargin, triggerRect.bottom + 8);
      setEnvironmentPanelPopoverStyle({ left, maxHeight: resolveMaxHeight(top), top });
    };

    updatePopoverPosition();
    const animationFrameId = requestAnimationFrame(updatePopoverPosition);
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePopoverPosition);
    if (workspaceViewportRef.current) {
      resizeObserver?.observe(workspaceViewportRef.current);
    }
    if (chatViewportRef.current) {
      resizeObserver?.observe(chatViewportRef.current);
    }
    if (environmentMiniPanelRef.current) {
      resizeObserver?.observe(environmentMiniPanelRef.current);
    }
    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);
    return () => {
      cancelAnimationFrame(animationFrameId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
    };
  }, [environmentPanelPopoverOpen, rightSidePanelOpen, rightSidePanelWidth]);
  useEffect(() => {
    if (!environmentPanelPopoverOpen) {
      return;
    }

    const handlePointerDownCapture = (event: PointerEvent) => {
      if (eventTargetIsInsideElement(event, environmentMiniPanelRef.current)) {
        return;
      }
      if (eventTargetIsInsideSelector(event, ENVIRONMENT_POPOVER_INTERACTIVE_LAYER_SELECTOR)) {
        return;
      }
      if (eventTargetIsInsideSelector(event, 'button[aria-label="Toggle environment panel"]')) {
        return;
      }

      setEnvironmentPanelOpen(false);
      setDraftEnvironmentPanelExplicitOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDownCapture, { capture: true });

    return () => {
      document.removeEventListener("pointerdown", handlePointerDownCapture, { capture: true });
    };
  }, [environmentPanelPopoverOpen, setEnvironmentPanelOpen]);
  const chatMessagesPaneProps = {
    messagesContainerRef: setMessagesScrollContainerRef,
    messagesTimelineProps,
    onMessagesPointerCancel,
    onMessagesPointerDown,
    onMessagesPointerUp,
    onMessagesScroll,
    onMessagesTouchEnd,
    onMessagesTouchMove,
    onMessagesTouchStart,
    onMessagesWheel,
    scrollMessagesToBottom,
    showScrollToBottom,
    timelineKey: activeThreadIdValue,
  };
  const branchToolbarProps =
    isGitRepo && activeThread
      ? {
          threadId: activeThread.id,
          connectionUrl: activeServerConnectionUrl,
          currentBranchName: activeThreadBranchName,
          onEnvModeChange,
          envModeOverride: envMode,
          envLocked,
          localEnvironmentLabel: activeRemoteHost?.name ?? "Locally",
          localEnvironmentIcon: activeEnvironmentIcon,
          onComposerFocusRequest: scheduleComposerFocus,
          onNewWorktreeRequest,
          ...(canCheckoutPullRequestIntoThread
            ? { onCheckoutPullRequestRequest: openPullRequestDialog }
            : {}),
        }
      : null;
  const environmentMiniPanelProps: Omit<
    ComponentProps<typeof EnvironmentMiniPanel>,
    "layoutMode"
  > | null = activeThread
    ? {
        activeProjectScripts: activeProject?.scripts,
        activePlan,
        activeSubagentThreadId: visibleActiveSubagentThreadId,
        activeThreadId: activeThread.id,
        branchToolbarProps,
        branchList: branchesData ?? null,
        editorStateInstanceId: workspaceEditorStateInstanceId,
        gitCwd,
        gitStatus: workspaceStatusData ?? null,
        gitStatusError: workspaceStatusError instanceof Error ? workspaceStatusError : null,
        isGitRepo,
        keybindings,
        preferredScriptId: activeProject
          ? (lastInvokedScriptByProjectId[activeProject.id] ?? null)
          : null,
        subagentThreads,
        workspaceChangeStat,
        workspaceMode: headerWorkspaceMode,
        onAddProjectScript: saveProjectScript,
        onDeleteProjectScript: deleteProjectScript,
        onOpenDiffPanel: onOpenRightSidePanelDiff,
        onJumpToMessage: jumpToTimelineMessage,
        onOpenEnvironmentSettings: () => {
          if (activeProject) {
            void navigate({
              to: "/settings/project-environment/$projectId",
              params: { projectId: activeProject.id },
            });
            return;
          }
          void navigate({ to: "/settings/environment" });
        },
        onOpenSummaryPanel: () => {
          setRightSidePanelMode("summary");
          setRightSidePanelVisible(true);
        },
        onRunProjectScript: (script) => {
          void runProjectScript(script);
        },
        onSelectSubagentThread: setActiveSubagentThreadId,
        onSubagentPanelOpen: () => {
          setRightSidePanelMode("subagent");
          setRightSidePanelVisible(true);
        },
        onUpdateProjectScript: updateProjectScript,
        onWorkspaceModeChange,
      }
    : null;
  const gitHubIssueDialogProps = gitHubIssueDialogOpen
    ? {
        open: true,
        cwd: codingGitCwd ?? activeProject?.cwd ?? null,
        initialIssueNumber: gitHubIssueDialogInitialIssueNumber,
        initialSelectedIssueNumbers: gitHubIssueDialogInitialSelectedIssueNumbers,
        onOpenChange: (open: boolean) => {
          if (!open) {
            closeGitHubIssueDialog();
          }
        },
        onFixIssue: onFixGitHubIssue,
        onFixIssuesInParallelWorktrees: onFixGitHubIssuesInParallelWorktrees,
      }
    : null;
  const pullRequestDialogProps = pullRequestDialogState
    ? {
        open: true,
        cwd: activeProject?.cwd ?? null,
        initialReference: pullRequestDialogState.initialReference,
        onOpenChange: (open: boolean) => {
          if (!open) {
            closePullRequestDialog();
          }
        },
        onPrepared: handlePreparedPullRequestThread,
      }
    : null;
  const expandedImageOverlay =
    expandedImage && expandedImageItem
      ? {
          expandedImage,
          expandedImageItem,
          closeExpandedImage,
          navigateExpandedImage,
        }
      : null;
  const requestedRightSidePanelMode = resolveRequestedRightSidePanelMode({
    rightSidePanelOpen,
    reviewOpen: rightSidePanelReviewOpen,
    selectedMode: rightSidePanelMode,
  });
  const activeRightSidePanelMode =
    requestedRightSidePanelMode === "browser" && !browserPanelAvailable
      ? "summary"
      : requestedRightSidePanelMode === "editor" && rightPanelEditorTabs.length === 0
        ? "summary"
        : requestedRightSidePanelMode;
  const visibleBottomPanelTabOrder = terminalState.terminalOpen
    ? terminalState.terminalIds.reduce<PanelTabOrderEntry[]>(
        (nextEntries, terminalId) => appendPanelTabOrder(nextEntries, `terminal:${terminalId}`),
        bottomPanelTabOrder.filter((entry) => {
          if (entry === "terminal") {
            return false;
          }
          if (!entry.startsWith("terminal:")) {
            return true;
          }
          return terminalState.terminalIds.includes(entry.slice("terminal:".length));
        }),
      )
    : removePanelTabOrderByMode(bottomPanelTabOrder, "terminal");
  const visibleBottomPanelMode = terminalState.terminalOpen
    ? (bottomPanelMode ?? "terminal")
    : bottomPanelMode === "terminal"
      ? null
      : bottomPanelMode;
  const bottomPanelHasContent = bottomPanelOpen;
  const requestedBottomPanelMode: DockPanelMode | null = bottomPanelHasContent
    ? (visibleBottomPanelMode ?? "terminal")
    : null;
  const activeBottomPanelMode =
    requestedBottomPanelMode === "browser" && !browserPanelAvailable
      ? null
      : requestedBottomPanelMode;
  const bottomPanelTerminalTabs = terminalState.terminalIds.map((terminalId) => ({
    id: terminalId,
    label: resolveTerminalDisplayTitle({
      autoTitle: terminalState.autoTerminalTitlesById[terminalId],
      cwd: gitCwd ?? activeProject?.cwd ?? "",
      isRunning: terminalState.runningTerminalIds.includes(terminalId),
      terminalId,
    }),
    running: terminalState.runningTerminalIds.includes(terminalId),
  }));
  const rightPanelTerminalTabs = rightTerminalPanelState.terminalIds.map((terminalId) => ({
    id: terminalId,
    label: resolveTerminalDisplayTitle({
      autoTitle: terminalState.autoTerminalTitlesById[terminalId],
      cwd: gitCwd ?? activeProject?.cwd ?? "",
      isRunning: terminalState.runningTerminalIds.includes(terminalId),
      terminalId,
    }),
    running: terminalState.runningTerminalIds.includes(terminalId),
  }));
  const avoidNativeBrowserPanelTransforms = isElectron && activeRightSidePanelMode === "browser";
  const rightSidePanelSurfaceAnimation = avoidNativeBrowserPanelTransforms
    ? {}
    : RIGHT_EDGE_PANEL_SPRING_ANIMATION;
  const showDockedRightSidePanelChrome = rightSidePanelOpen && !rightSidePanelFullscreen;
  const dockedRightSidePanelWidth = constrainedPanelWidth(
    rightSidePanelWidth,
    MIN_RIGHT_SIDE_PANEL_CHAT_WIDTH,
    MIN_RIGHT_SIDE_PANEL_WIDTH,
  );
  const rightSidePanelInlineWidth = rightSidePanelFullscreen ? "100%" : dockedRightSidePanelWidth;
  const rightSidePanelLayoutAnimation = rightSidePanelFullscreen
    ? PANEL_OPACITY_SPRING_ANIMATION
    : {
        initial: { width: 0 },
        animate: { width: dockedRightSidePanelWidth },
        exit: { width: 0 },
      };
  const dockedRightSidePanelHeaderLayoutAnimation = {
    initial: { width: 0 },
    animate: { width: dockedRightSidePanelWidth },
    exit: { width: 0 },
  };
  const rightSidePanelLayoutTransition = rightSidePanelResizing
    ? PANEL_RESIZE_LAYOUT_TRANSITION
    : PANEL_EDGE_LAYOUT_TRANSITION;
  const bottomPanelHeight = terminalState.terminalHeight + 48;
  const bottomPanelLayoutAnimation = {
    initial: { height: 0 },
    animate: { height: bottomPanelHeight },
    exit: { height: 0 },
  };
  const bottomPanelLayoutTransition = bottomPanelResizing
    ? PANEL_RESIZE_LAYOUT_TRANSITION
    : PANEL_EDGE_LAYOUT_TRANSITION;
  const bottomPanelContentHeightPx = `${terminalState.terminalHeight}px`;
  const dockedRightSidePanelSurfaceStyle = rightSidePanelResizing
    ? RESIZABLE_PANEL_WIDTH_STYLE
    : {
        minWidth: dockedRightSidePanelWidth,
        width: dockedRightSidePanelWidth,
      };
  const rightSidePanelSurfaceStyle = rightSidePanelFullscreen
    ? { width: rightSidePanelInlineWidth }
    : rightSidePanelResizing
      ? RESIZABLE_PANEL_WIDTH_STYLE
      : {
          minWidth: dockedRightSidePanelWidth,
          width: dockedRightSidePanelWidth,
        };
  const bottomPanelSurfaceStyle = bottomPanelResizing
    ? RESIZABLE_PANEL_HEIGHT_STYLE
    : { height: bottomPanelHeight };
  const rightSidePanelBodyDeferred =
    rightSidePanelContentDeferred && rightSidePanelOpen && !rightSidePanelResizing;
  const bottomPanelBodyDeferred =
    bottomPanelContentDeferred && bottomPanelOpen && !bottomPanelResizing;
  const rightSidePanelTabStrip = (className?: string) =>
    rightSidePanelOpen ? (
      <RightSidePanelTabStrip
        activeMode={activeRightSidePanelMode}
        activeBrowserTabId={activeRightPanelBrowserTabId}
        bottomPanelAvailable={activeProject !== undefined}
        bottomPanelOpen={bottomPanelOpen}
        bottomPanelToggleShortcutLabel={terminalToggleShortcutLabel}
        browserSession={activeRightPanelBrowserSession}
        browserAvailable={isElectron}
        browserShortcutLabel={browserNewTabShortcutLabel}
        className={className}
        diffAvailable={isGitRepo}
        editorShortcutLabel={rightPanelEditorShortcutLabel}
        editorTabs={rightPanelEditorTabs}
        activeEditorTabId={activeRightPanelEditorTabId}
        floatingChatShortcutLabel={rightSidePanelFloatingChatShortcutLabel}
        fullscreen={rightSidePanelFullscreen}
        fullscreenShortcutLabel={rightSidePanelFullscreenShortcutLabel}
        reviewShortcutLabel={reviewPanelShortcutLabel}
        reviewOpen={rightSidePanelReviewOpen}
        terminalNewShortcutLabel={newTerminalTabShortcutLabel}
        terminalShortcutLabel={rightPanelTerminalShortcutLabel}
        terminalOpen={rightSidePanelTerminalOpen}
        terminalTabs={rightPanelTerminalTabs}
        activeTerminalId={rightTerminalPanelState.activeTerminalId}
        activeSubagentThreadId={visibleActiveSubagentThreadId}
        floatingChatOpen={rightSidePanelFloatingChatOpen}
        onBrowserTabClose={onCloseRightSidePanelBrowserTab}
        onBrowserTabReorder={onReorderRightSidePanelBrowserTab}
        onBrowserTabSelect={onSelectRightSidePanelBrowserTab}
        onToggleBottomPanel={onToggleBottomPanel}
        onDiffClose={onCloseRightSidePanelDiff}
        onEditorTabClose={onCloseRightSidePanelEditorTab}
        onEditorTabReorder={onReorderRightSidePanelEditorTab}
        onEditorTabSelect={onSelectRightSidePanelEditorTab}
        onTerminalClose={onCloseRightSidePanelTerminal}
        onTerminalTabClose={closeTerminal}
        onTerminalTabReorder={onReorderRightSidePanelTerminalTab}
        onTerminalTabSelect={(terminalId) => {
          activatePanelTerminal(terminalId);
          onOpenRightSidePanelTerminal();
        }}
        onNewBrowserTab={onOpenRightSidePanelBrowserTab}
        onNewEditorTab={onNewRightSidePanelEditorTab}
        onNewTerminalTab={createNewPanelTerminal}
        onPanelTabOrderChange={reorderRightPanelTabOrder}
        onSelectMode={onSelectRightSidePanelMode}
        onSelectSubagentThread={setActiveSubagentThreadId}
        onTogglePanelVisibility={onToggleRightSidePanel}
        onToggleFloatingChat={() => {
          onToggleRightSidePanelFloatingChat();
        }}
        onToggleFullscreen={onToggleRightSidePanelFullscreen}
        panelToggleShortcutLabel={rightSidePanelToggleShortcutLabel}
        panelTabOrder={rightPanelTabOrder}
        subagentThreads={subagentThreads}
      />
    ) : null;
  const bottomPanelTabStrip = (className?: string) =>
    activeBottomPanelMode ? (
      <RightSidePanelTabStrip
        activeMode={activeBottomPanelMode}
        activeBrowserTabId={activeBottomPanelBrowserTabId}
        browserSession={activeBottomPanelBrowserSession}
        browserAvailable={isElectron}
        browserShortcutLabel={browserNewTabShortcutLabel}
        className={className}
        diffAvailable={isGitRepo}
        editorShortcutLabel={rightPanelEditorShortcutLabel}
        editorTabs={bottomPanelEditorTabs}
        activeEditorTabId={activeBottomPanelEditorTabId}
        floatingChatShortcutLabel={null}
        fullscreen={false}
        fullscreenShortcutLabel={null}
        reviewShortcutLabel={reviewPanelShortcutLabel}
        reviewOpen={bottomPanelReviewOpen}
        terminalNewShortcutLabel={newTerminalTabShortcutLabel}
        terminalShortcutLabel={terminalToggleShortcutLabel}
        terminalOpen={terminalState.terminalOpen}
        terminalTabs={bottomPanelTerminalTabs}
        activeTerminalId={terminalState.activeTerminalId}
        activeSubagentThreadId={visibleActiveSubagentThreadId}
        floatingChatOpen={false}
        onBrowserTabClose={onCloseBottomPanelBrowserTab}
        onBrowserTabReorder={onReorderBottomPanelBrowserTab}
        onBrowserTabSelect={onSelectBottomPanelBrowserTab}
        onDiffClose={onCloseBottomPanelDiff}
        onEditorTabClose={onCloseBottomPanelEditorTab}
        onEditorTabReorder={onReorderBottomPanelEditorTab}
        onEditorTabSelect={onSelectBottomPanelEditorTab}
        onTerminalClose={onCloseBottomPanelTerminal}
        onTerminalTabClose={closeTerminal}
        onTerminalTabReorder={onReorderBottomPanelTerminalTab}
        onTerminalTabSelect={(terminalId) => {
          activateTerminal(terminalId);
          onSelectBottomPanelMode("terminal");
        }}
        onNewBrowserTab={onOpenBottomPanelBrowserTab}
        onNewEditorTab={onNewBottomPanelEditorTab}
        onNewTerminalTab={createNewTerminal}
        onPanelTabOrderChange={reorderBottomPanelTabOrder}
        onSelectMode={onSelectBottomPanelMode}
        onSelectSubagentThread={setActiveSubagentThreadId}
        onTogglePanelVisibility={onToggleBottomPanel}
        onToggleFloatingChat={() => undefined}
        onToggleFullscreen={() => undefined}
        panelToggleShortcutLabel={null}
        panelTabOrder={visibleBottomPanelTabOrder}
        showPanelActions={false}
        showSummaryTab={false}
        subagentThreads={subagentThreads}
      />
    ) : null;
  const subagentComposerThreadId = (subagent: SubagentThread) =>
    ThreadId.makeUnsafe(`subagent:${activeThread?.id ?? threadId}:${subagent.id}`);
  const renderSubagentComposer = (subagent: SubagentThread) => {
    if (!activeThread) {
      return null;
    }
    const draftThreadId = subagentComposerThreadId(subagent);
    const draft = getComposerThreadDraft(draftThreadId);
    const { selectedModel } = deriveEffectiveComposerModelState({
      draft,
      providers: providerStatuses,
      selectedProvider: "codex",
      threadModelSelection: activeThread.modelSelection,
      projectModelSelection: activeProject?.defaultModelSelection,
      settings: modelSettings,
    });
    const providerInstanceId =
      draft.modelSelectionByProvider.codex?.providerInstanceId ??
      (activeThread.modelSelection.provider === "codex"
        ? activeThread.modelSelection.providerInstanceId
        : undefined);
    const codexModels = getProviderModels(providerStatuses, "codex", providerInstanceId);
    return (
      <ConnectedChatComposerPanels
        ref={subagentComposerPanelsRef}
        threadId={draftThreadId}
        activeForSideEffects={activeForSideEffects}
        gitCwd={gitCwd}
        isGitRepo={isGitRepo}
        modelSettings={modelSettings}
        providers={providerStatuses}
        isServerThread
        threadRuntimeMode={activeThread.runtimeMode}
        threadInteractionMode={activeThread.interactionMode}
        composerModelOptions={composerModelOptions}
        selectedProvider="codex"
        selectedProviderInstanceId={providerInstanceId}
        selectedModel={selectedModel}
        selectedProviderModels={codexModels}
        selectedProviderModelOptions={composerModelOptions?.codex}
        sessionConfigOptions={activeThread.session?.configOptions}
        providerCommands={composerProviderCommands}
        selectedModelForPickerWithCustomFallback={selectedModel}
        lockedProvider="codex"
        modelOptionsByProvider={modelOptionsByProvider}
        modelSelectionByProvider={draft.modelSelectionByProvider}
        providerInstancesByProvider={providerInstancesByProvider}
        handoffTargetProviders={[]}
        handoffDisabled={true}
        interactionModeShortcutLabel={togglePlanModeShortcutLabel}
        activeContextWindow={activeContextWindow}
        queuedComposerMessages={[]}
        queuedSteerMessageId={null}
        queuedDispatchingMessageId={null}
        canSendQueuedMessages={false}
        pendingComposerComments={[]}
        liveTurnInProgress={subagent.status === "running"}
        isConnecting={isConnecting}
        isPreparingWorktree={false}
        isSendBusy={false}
        allowQueueWhenSendable={false}
        activePendingApproval={null}
        pendingApprovalsCount={0}
        pendingUserInputs={[]}
        respondingApprovalRequestIds={[]}
        respondingUserInputRequestIds={[]}
        activePendingDraftAnswers={{}}
        activePendingQuestionIndex={0}
        activePendingProgress={null}
        activePendingIsResponding={false}
        activePendingResolvedAnswers={null}
        planFollowUpId={null}
        planFollowUpTitle={null}
        resolvedTheme={resolvedTheme}
        showFloatingDock={false}
        floatingDockFooter={null}
        floatingDockPortalHost={null}
        onComposerHeightChange={scheduleStickToBottom}
        onPreviewExpandedImage={onExpandTimelineImage}
        onIssuePreviewOpen={onComposerIssueTokenClick}
        onPendingUserInputCustomAnswerChange={() => {}}
        onSubmit={(event) => {
          void handleSubagentComposerSubmit(event, subagent);
        }}
        onRespondToApproval={async () => {}}
        onSelectPendingUserInputOption={() => {}}
        onAdvancePendingUserInput={() => {}}
        onHandoffToProvider={() => {}}
        onInteractionModeChange={(mode) => {
          setComposerDraftInteractionMode(draftThreadId, mode);
        }}
        onRuntimeModeChange={(mode) => {
          setComposerDraftRuntimeMode(draftThreadId, mode);
        }}
        onPreviousPendingQuestion={() => {}}
        onInterrupt={() => {}}
        onImplementPlanInNewThread={() => {}}
        onQueueMessage={() => {}}
        onEditQueuedComposerMessage={() => {}}
        onDeleteQueuedComposerMessage={() => {}}
        onClearQueuedComposerMessages={() => {}}
        onDismissPendingComposerComment={() => {}}
        onClearPendingComposerComments={() => {}}
        onReorderQueuedComposerMessages={() => {}}
        onSendQueuedComposerMessage={() => {}}
        onSteerQueuedComposerMessage={() => {}}
        onSetThreadError={setThreadError}
      />
    );
  };
  const draftNewThreadRecommendedPrompts = useNewThreadRecommendedPrompts(
    activeProjectId,
    activeProject?.cwd ?? null,
    selectedModelSelection,
  );
  const draftNewThreadTitle = activeProject
    ? `What should we build in ${activeProject.name}?`
    : "What should we build?";
  const onDraftNewThreadRecommendedPromptClick = (prompt: string) => {
    setPrompt(prompt);
    scheduleComposerFocus();
  };
  const onDraftNewThreadGitHubIssuesClick = () => {
    openGitHubIssueDialog();
  };
  const draftNewThreadQuickActionsNode =
    activeProject !== null && isGitRepo ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="new-thread-start-quick-action size-8 rounded-[var(--control-radius)] border border-transparent bg-transparent text-muted-foreground/80 shadow-none transition-colors hover:bg-foreground/[0.045] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/25"
              aria-label="Solve GitHub issue"
              onClick={onDraftNewThreadGitHubIssuesClick}
            />
          }
        >
          <GitHubIcon className="size-4" />
          <span className="sr-only">Solve GitHub issue</span>
        </TooltipTrigger>
        <TooltipPopup side="top">Solve GitHub issue</TooltipPopup>
      </Tooltip>
    ) : null;
  const draftNewThreadContextControlsNode = (
    <>
      <ProjectContextSwitcher
        activeProjectId={activeProjectId}
        onSelectProject={handleActiveProjectChange}
        variant="draft"
      />

      <Menu>
        <MenuTrigger
          render={
            <Button
              className={cn(DRAFT_CONTEXT_PILL_TRIGGER_CLASS_NAME, "max-w-[12rem] justify-start")}
              variant="ghost"
              size="default"
            />
          }
        >
          <span className={DRAFT_CONTEXT_PILL_ICON_CLASS_NAME}>
            {envMode === "local" ? (
              activeEnvironmentIcon ? (
                <ProjectGlyphIcon icon={activeEnvironmentIcon} className="size-3.5 opacity-80" />
              ) : (
                <LaptopIcon className="size-3.5 text-muted-foreground" />
              )
            ) : (
              <GitBranchPlusIcon className="size-3.5 text-muted-foreground" />
            )}
          </span>
          <span className="min-w-0 truncate">
            {envMode === "local" ? "Locally" : "New worktree"}
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/55" />
        </MenuTrigger>
        <MenuPopup align="start" className="w-48">
          <MenuGroup>
            <MenuRadioGroup
              value={envMode}
              onValueChange={(value) => onEnvModeChange(value as DraftThreadEnvMode)}
            >
              <MenuRadioItem value="local" className="text-xs">
                <span className="flex items-center gap-2">
                  {activeEnvironmentIcon ? (
                    <ProjectGlyphIcon
                      icon={activeEnvironmentIcon}
                      className="size-3.5 opacity-80"
                    />
                  ) : (
                    <LaptopIcon className="size-3.5" />
                  )}
                  Locally
                </span>
              </MenuRadioItem>
              <MenuRadioItem value="worktree" className="text-xs">
                <span className="flex items-center gap-2">
                  <GitBranchPlusIcon className="size-3.5" />
                  New worktree
                </span>
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      </Menu>
    </>
  );
  if (!activeThread) {
    return null;
  }
  const draftNewThreadBranchControlNode = (
    <DraftBranchToolbar branchToolbarProps={branchToolbarProps} />
  );
  const environmentMiniPanelPortal = (
    <EnvironmentMiniPanelPortal
      open={environmentPanelPopoverOpen}
      panelProps={environmentMiniPanelProps}
      panelRef={environmentMiniPanelRef}
      style={visibleEnvironmentPanelPopoverStyle}
    />
  );
  const rightSidePanelTabStripNode = rightSidePanelTabStrip("h-full bg-transparent px-2.5");
  const bottomPanelTabStripNode = bottomPanelTabStrip(
    "h-full min-w-0 flex-1 bg-transparent px-2.5",
  );
  const showRightPanelChatDock =
    rightSidePanelFullscreen && rightSidePanelFloatingChatOpen && activeRightSidePanelMode !== null;
  const dockedRightSidePanelHeader = (
    <AnimatePresence initial={false} mode="sync">
      {showDockedRightSidePanelChrome ? (
        <m.div
          key="thread-right-side-panel-top-bar"
          ref={dockedRightSidePanelHeaderRef}
          className={cn(
            "relative z-30 min-h-[44px] shrink-0 overflow-hidden will-change-[width,opacity]",
            !rightSidePanelInteractive && "pointer-events-none select-none",
          )}
          {...dockedRightSidePanelHeaderLayoutAnimation}
          {...(rightSidePanelResizing ? { style: RESIZABLE_PANEL_WIDTH_STYLE } : {})}
          transition={rightSidePanelLayoutTransition}
        >
          <m.div
            className="flex h-full min-h-[44px] items-stretch overflow-hidden border-b border-border/25 bg-background [-webkit-app-region:no-drag] transform-gpu will-change-[transform,opacity]"
            style={{
              ...dockedRightSidePanelSurfaceStyle,
              transformOrigin: "right center",
            }}
            {...RIGHT_EDGE_PANEL_SPRING_ANIMATION}
            transition={PANEL_SPRING_TRANSITION}
          >
            <div className="relative h-full w-3 shrink-0" aria-hidden="true">
              <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/75" />
            </div>
            <div className="min-w-0 flex-1 overflow-hidden">{rightSidePanelTabStripNode}</div>
          </m.div>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
  const fullscreenRightSidePanelHeader = (
    <AnimatePresence initial={false} mode="sync">
      {activeRightSidePanelMode && rightSidePanelFullscreen ? (
        <m.div
          key="thread-right-side-panel-fullscreen-top-bar"
          className={cn(
            "absolute inset-0 z-40 flex min-w-0 items-stretch overflow-hidden border-b border-border/25 bg-background [-webkit-app-region:no-drag]",
            !rightSidePanelInteractive && "pointer-events-none select-none",
          )}
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={PANEL_SPRING_TRANSITION}
        >
          <div className="min-w-0 flex-1 overflow-hidden">{rightSidePanelTabStripNode}</div>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
  const connectedChatComposerPanelsNode = (
    <ConnectedChatComposerPanels
      ref={composerPanelsRef}
      threadId={threadId}
      activeForSideEffects={activeForSideEffects}
      gitCwd={gitCwd}
      isGitRepo={isGitRepo}
      modelSettings={modelSettings}
      providers={providerStatuses}
      isServerThread={isServerThread}
      threadRuntimeMode={activeThread.runtimeMode}
      threadInteractionMode={activeThread.interactionMode}
      composerModelOptions={composerModelOptions}
      selectedProvider={selectedProvider}
      selectedProviderInstanceId={selectedModelSelection.providerInstanceId}
      selectedModel={selectedModel}
      selectedProviderModels={selectedProviderModels}
      selectedProviderModelOptions={composerModelOptions?.[selectedProvider]}
      sessionConfigOptions={activeThread.session?.configOptions}
      providerCommands={composerProviderCommands}
      selectedModelForPickerWithCustomFallback={selectedModelForPickerWithCustomFallback}
      lockedProvider={lockedProvider}
      modelOptionsByProvider={modelOptionsByProvider}
      modelSelectionByProvider={composerShellDraft.modelSelectionByProvider}
      providerInstancesByProvider={providerInstancesByProvider}
      handoffTargetProviders={handoffTargetProviders}
      handoffDisabled={handoffDisabled}
      interactionModeShortcutLabel={togglePlanModeShortcutLabel}
      activeContextWindow={activeContextWindow}
      queuedComposerMessages={queuedComposerMessages}
      queuedSteerMessageId={queuedSteerRequest?.messageId ?? null}
      queuedDispatchingMessageId={optimisticQueuedDispatchMessageId}
      canSendQueuedMessages={canSendQueuedComposerMessages}
      pendingComposerComments={pendingComposerCommentItems}
      liveTurnInProgress={liveTurnInProgress}
      isConnecting={isConnecting}
      isPreparingWorktree={isPreparingWorktree}
      isSendBusy={isSendBusy}
      allowQueueWhenSendable={!sendInFlight || isServerThread}
      activePendingApproval={activePendingApproval}
      pendingApprovalsCount={pendingApprovals.length}
      pendingUserInputs={pendingUserInputs}
      respondingApprovalRequestIds={respondingRequestIds}
      respondingUserInputRequestIds={respondingUserInputRequestIds}
      activePendingDraftAnswers={activePendingDraftAnswers}
      activePendingQuestionIndex={activePendingQuestionIndex}
      activePendingProgress={activePendingProgress}
      activePendingIsResponding={activePendingIsResponding}
      activePendingResolvedAnswers={activePendingResolvedAnswers}
      placeholderOverride={showDraftNewThreadLanding ? "Do anything" : undefined}
      planFollowUpId={activeProposedPlan?.id ?? null}
      planFollowUpTitle={
        activeProposedPlan ? (proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null) : null
      }
      resolvedTheme={resolvedTheme}
      showFloatingDock={showRightPanelChatDock}
      floatingDockFooter={null}
      floatingDockPortalHost={showRightPanelChatDock ? chatShellElement : null}
      onComposerOverlayActiveChange={setComposerOverlayActive}
      onComposerHeightChange={scheduleStickToBottom}
      onPreviewExpandedImage={onExpandTimelineImage}
      onIssuePreviewOpen={onComposerIssueTokenClick}
      onPendingUserInputCustomAnswerChange={onChangeActivePendingUserInputCustomAnswer}
      onSubmit={handleComposerSubmit}
      onRespondToApproval={onRespondToApproval}
      onSelectPendingUserInputOption={onSelectActivePendingUserInputOption}
      onAdvancePendingUserInput={onAdvanceActivePendingUserInput}
      onHandoffToProvider={onHandoffToProvider}
      onInteractionModeChange={handleInteractionModeChange}
      onRuntimeModeChange={handleRuntimeModeChange}
      onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
      onInterrupt={onInterrupt}
      onImplementPlanInNewThread={onImplementPlanInNewThread}
      onQueueMessage={handleQueueComposerMessage}
      onEditQueuedComposerMessage={onEditQueuedComposerMessage}
      onDeleteQueuedComposerMessage={removeQueuedComposerMessage}
      onClearQueuedComposerMessages={clearQueuedComposerMessages}
      onDismissPendingComposerComment={dismissPendingComposerComment}
      onClearPendingComposerComments={clearPendingComposerComments}
      onReorderQueuedComposerMessages={reorderQueuedComposerMessages}
      onSendQueuedComposerMessage={sendQueuedComposerMessage}
      onSteerQueuedComposerMessage={onSteerQueuedComposerMessage}
      onSetThreadError={setThreadError}
    />
  );
  const composerLayoutId = `thread-composer:${threadId}`;
  const trimmedActiveThreadTitle = activeThread.title.trim();
  const showThreadHeaderIdentity =
    !showDraftNewThreadLanding &&
    trimmedActiveThreadTitle.length > 0 &&
    trimmedActiveThreadTitle !== DEFAULT_THREAD_TITLE;

  return (
    <LazyMotion features={domAnimation}>
      {environmentMiniPanelPortal}
      <ThreadRenameDialog
        open={threadRenameDialogOpen && Boolean(activeThread) && isServerThread}
        initialTitle={activeThread?.title ?? ""}
        description="Update the title shown in the chat header and sidebar."
        onOpenChange={setThreadRenameDialogOpen}
        onSubmit={submitActiveThreadRename}
      />
      <div
        ref={setChatShellRef}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
      >
        {/* Persistent top bar — always visible regardless of workspace mode */}
        <ChatViewHeader
          showThreadHeaderIdentity={showThreadHeaderIdentity}
          isHeaderHidden={isHeaderHidden}
          rightSidePanelFullscreen={rightSidePanelFullscreen}
          showSidebarTrigger={showSidebarTrigger}
          paneControls={paneControls}
          activeThreadTitle={activeThread.title}
          terminalAvailable={activeProject !== undefined}
          terminalOpen={terminalState.terminalOpen}
          terminalToggleShortcutLabel={terminalToggleShortcutLabel}
          environmentPanelOpen={environmentPanelRenderedOpen}
          rightSidePanelToggleShortcutLabel={rightSidePanelToggleShortcutLabel}
          rightSidePanelOpen={rightSidePanelOpen}
          menuActions={showThreadHeaderIdentity ? headerMenuActions : undefined}
          pinnedThread={activeThreadPinned}
          onUnpinThread={() => {
            if (activeThreadPinned) {
              togglePinnedThread(activeThread.id);
            }
          }}
          onToggleEnvironmentPanel={() => {
            if (environmentPanelRenderedOpen) {
              setDraftEnvironmentPanelExplicitOpen(false);
              setEnvironmentPanelOpen(false);
              return;
            }
            if (showDraftNewThreadLanding) {
              setDraftEnvironmentPanelExplicitOpen(true);
            }
            setEnvironmentPanelOpen(true);
          }}
          onToggleTerminal={toggleTerminalVisibility}
          onToggleRightSidePanel={onToggleRightSidePanel}
          reliabilitySlot={
            reliabilityUxEnabled ? (
              <ConnectionHealthPill
                onOpenDiagnostics={() => openDiagnostics("connection")}
                onRefreshProviders={refreshProviderStatus}
              />
            ) : null
          }
          dockedRightSidePanelHeader={dockedRightSidePanelHeader}
          fullscreenRightSidePanelHeader={fullscreenRightSidePanelHeader}
        />

        <ConnectedComposerProviderStatusBanner
          threadId={threadId}
          hasThreadStarted={threadHasStarted(activeThread)}
          isServerThread={isServerThread}
          lockProvider={Boolean(activeThread.fork)}
          modelSettings={modelSettings}
          projectModelSelection={activeProject?.defaultModelSelection}
          providers={providerStatuses}
          recoveryActionsEnabled={reliabilityUxEnabled}
          sessionProvider={activeThread.session?.provider ?? null}
          threadModelSelection={activeThread.modelSelection}
          {...(reliabilityUxEnabled
            ? { onOpenDiagnostics: () => openDiagnostics("provider") }
            : {})}
        />

        {/* Error banner */}
        <ThreadErrorBanner
          error={activeThread.error}
          onDismiss={() => dismissThreadError(activeThread.id)}
          {...(reliabilityUxEnabled ? { onOpenDiagnostics: () => openDiagnostics("thread") } : {})}
        />
        {visibleDiagnosticsOpen ? (
          <ReliabilityDiagnosticsDialog
            open={visibleDiagnosticsOpen}
            onOpenChange={setDiagnosticsOpen}
            provider={activeProviderStatus}
            thread={activeThread}
            focus={diagnosticsFocus}
            turnRunning={liveTurnInProgress}
            onStopTurn={liveTurnInProgress ? onInterrupt : null}
          />
        ) : null}
        {/* Main content area with optional plan sidebar */}
        <div
          ref={chatViewportRef}
          className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
        >
          {/* Chat column */}
          <div
            ref={workspaceViewportRef}
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          >
            <>
              {workspaceMode === "editor" && !editorHostedInRightPanel ? (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  <Suspense
                    fallback={
                      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
                        <div className="border-b border-border/60 px-4 py-3">
                          <div className="h-5 w-44 rounded bg-foreground/6" />
                        </div>
                        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_4px_280px]">
                          <div className="bg-background" />
                          <div className="bg-border/60" />
                          <div className="border-l border-border/60 bg-foreground/3" />
                        </div>
                      </div>
                    }
                  >
                    <ThreadWorkspaceEditor
                      availableEditors={availableEditors}
                      branch={activeThreadBranchName}
                      connectionUrl={activeServerConnectionUrl}
                      gitCwd={gitCwd}
                      lspCwd={activeProject?.cwd ?? null}
                      keybindings={keybindings}
                      browserOpen={anyBrowserOpen}
                      workspaceMode={workspaceMode}
                      editorStateInstanceId={workspaceEditorStateInstanceId}
                      terminalOpen={terminalState.terminalOpen}
                      threadId={activeThread.id}
                      worktreePath={activeThread.worktreePath ?? null}
                      detachedReturnPlacement="workspace"
                      onDetached={() => onWorkspaceModeChange("chat")}
                      onSubmitAgentNote={submitWorkspaceAgentNote}
                    />
                  </Suspense>
                </div>
              ) : (
                <div
                  className={cn(
                    workspaceMode === "split" && !editorHostedInRightPanel
                      ? "flex min-h-0 min-w-0 flex-1 overflow-hidden"
                      : "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
                  )}
                >
                  <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                    <m.div
                      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                      animate={{
                        paddingRight: environmentPanelInlineOpen
                          ? environmentPanelReservedWidthPx
                          : 0,
                      }}
                      transition={PANEL_SPRING_TRANSITION}
                    >
                      <LayoutGroup id={`thread-layout:${threadId}`}>
                        <AnimatePresence initial={false} mode="popLayout">
                          {showDraftNewThreadLanding ? (
                            <m.div
                              key="draft-new-thread-start"
                              className="flex min-h-0 min-w-0 flex-1 flex-col"
                              initial={{ opacity: 0, y: 12, scale: 0.99 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, y: -28, scale: 0.985 }}
                              transition={PANEL_SPRING_TRANSITION}
                            >
                              <NewThreadStartSurface
                                branchControlNode={draftNewThreadBranchControlNode}
                                composerNode={
                                  <m.div
                                    layoutId={composerLayoutId}
                                    className="w-full"
                                    transition={PANEL_SPRING_TRANSITION}
                                  >
                                    {connectedChatComposerPanelsNode}
                                  </m.div>
                                }
                                contextControlsNode={draftNewThreadContextControlsNode}
                                hasProjects={activeProject !== null}
                                quickActionsNode={draftNewThreadQuickActionsNode}
                                recommendedPrompts={draftNewThreadRecommendedPrompts}
                                title={draftNewThreadTitle}
                                onRecommendedPromptClick={onDraftNewThreadRecommendedPromptClick}
                              />
                            </m.div>
                          ) : (
                            <m.div
                              key="thread-conversation"
                              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                              initial={{ opacity: 0, y: 24 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: 12 }}
                              transition={PANEL_SPRING_TRANSITION}
                            >
                              <ChatMessagesPane {...chatMessagesPaneProps} />
                              <m.div
                                layoutId={composerLayoutId}
                                transition={PANEL_SPRING_TRANSITION}
                              >
                                {connectedChatComposerPanelsNode}
                              </m.div>
                            </m.div>
                          )}
                        </AnimatePresence>
                      </LayoutGroup>

                      <ChatConversationExtras
                        gitHubIssueDialogProps={gitHubIssueDialogProps}
                        pullRequestDialogKey={pullRequestDialogState?.key ?? null}
                        pullRequestDialogProps={pullRequestDialogProps}
                      />
                      {issuePreviewNumber !== null ? (
                        <GitHubIssuePreviewDialog
                          open
                          issueNumber={issuePreviewNumber}
                          cwd={gitCwd ?? activeProject?.cwd ?? null}
                          onOpenChange={(open) => {
                            if (!open) {
                              dispatchChatViewDialogState({
                                type: "set-issue-preview-number",
                                issuePreviewNumber: null,
                              });
                            }
                          }}
                        />
                      ) : null}
                    </m.div>
                    <InlineEnvironmentMiniPanel
                      open={environmentPanelInlineOpen}
                      panelProps={environmentMiniPanelProps}
                    />
                  </div>
                  {workspaceMode === "split" && !editorHostedInRightPanel ? (
                    <m.div
                      key="workspace-split-editor"
                      className="flex h-full min-h-0 shrink-0 overflow-hidden"
                      initial={{ width: 0, opacity: 0, x: 18 }}
                      animate={{ width: "auto", opacity: 1, x: 0 }}
                      transition={WORKSPACE_SIDE_PANEL_TRANSITION}
                    >
                      <hr
                        aria-orientation="vertical"
                        aria-label="Resize workspace editor panel"
                        className="group relative z-20 h-auto w-3 shrink-0 cursor-col-resize touch-none select-none border-0 bg-transparent before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border/80 before:transition-colors before:content-[''] after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2 after:rounded-full after:bg-transparent after:content-[''] hover:before:bg-primary/55 hover:after:bg-primary/10"
                        onPointerDown={handleWorkspaceEditorSplitResizePointerDown}
                      />
                      <div
                        ref={workspaceEditorSplitPanelRef}
                        className="flex h-full min-h-0 min-w-0 shrink-0 flex-col overflow-hidden"
                        style={{
                          width: constrainedPanelWidth(
                            workspaceEditorSplitWidth,
                            MIN_WORKSPACE_CHAT_SPLIT_WIDTH,
                          ),
                          minWidth: constrainedPanelWidth(
                            workspaceEditorSplitWidth,
                            MIN_WORKSPACE_CHAT_SPLIT_WIDTH,
                          ),
                        }}
                      >
                        <Suspense
                          fallback={
                            <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
                              <div className="border-b border-border/60 px-4 py-3">
                                <div className="h-5 w-44 rounded bg-foreground/6" />
                              </div>
                              <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_4px_280px]">
                                <div className="bg-background" />
                                <div className="bg-border/60" />
                                <div className="border-l border-border/60 bg-foreground/3" />
                              </div>
                            </div>
                          }
                        >
                          <ThreadWorkspaceEditor
                            availableEditors={availableEditors}
                            branch={activeThreadBranchName}
                            connectionUrl={activeServerConnectionUrl}
                            gitCwd={gitCwd}
                            lspCwd={activeProject?.cwd ?? null}
                            keybindings={keybindings}
                            browserOpen={anyBrowserOpen}
                            workspaceMode={workspaceMode}
                            editorStateInstanceId={workspaceEditorStateInstanceId}
                            terminalOpen={terminalState.terminalOpen}
                            threadId={activeThread.id}
                            worktreePath={activeThread.worktreePath ?? null}
                            detachedReturnPlacement="workspace"
                            onDetached={() => onWorkspaceModeChange("chat")}
                            onSubmitAgentNote={submitWorkspaceAgentNote}
                          />
                        </Suspense>
                      </div>
                    </m.div>
                  ) : null}
                </div>
              )}
            </>
          </div>
          {/* end chat column */}

          <AnimatePresence initial={false}>
            {rightSidePanelOpen ? (
              <m.div
                key="thread-right-side-panel"
                ref={rightSidePanelElementRef}
                className={cn(
                  "ace-right-side-panel-shell h-full min-h-0 overflow-hidden will-change-[width,opacity]",
                  (!rightSidePanelInteractive || rightSidePanelMotionActive) &&
                    "pointer-events-none select-none",
                  rightSidePanelFullscreen
                    ? "absolute inset-y-0 right-0 z-40"
                    : "relative shrink-0",
                )}
                data-panel-motion={rightSidePanelMotionActive ? "active" : undefined}
                {...rightSidePanelLayoutAnimation}
                {...(rightSidePanelResizing && !rightSidePanelFullscreen
                  ? { style: RESIZABLE_PANEL_WIDTH_STYLE }
                  : rightSidePanelFullscreen
                    ? { style: { width: rightSidePanelInlineWidth } }
                    : {})}
                onAnimationComplete={endRightSidePanelMotion}
                onAnimationStart={beginRightSidePanelMotion}
                transition={rightSidePanelLayoutTransition}
              >
                <m.div
                  className={cn(
                    "ace-right-side-panel-surface flex h-full min-h-0 min-w-0 overflow-hidden bg-background",
                    avoidNativeBrowserPanelTransforms
                      ? "will-change-[opacity]"
                      : "transform-gpu will-change-[transform,opacity]",
                  )}
                  style={{
                    ...rightSidePanelSurfaceStyle,
                    transformOrigin: "right center",
                  }}
                  {...rightSidePanelSurfaceAnimation}
                  transition={PANEL_SPRING_TRANSITION}
                >
                  {!rightSidePanelFullscreen ? (
                    <button
                      type="button"
                      aria-label="Resize right side panel"
                      tabIndex={0}
                      className="group relative z-20 h-auto w-3 shrink-0 cursor-col-resize touch-none select-none border-0 bg-transparent outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border/75 before:transition-colors before:duration-200 before:ease-out before:content-[''] after:absolute after:inset-y-1 after:left-1/2 after:w-2 after:-translate-x-1/2 after:rounded-full after:bg-transparent after:transition-[background-color,transform] after:duration-200 after:ease-out after:content-[''] hover:before:bg-border hover:after:scale-x-100 hover:after:bg-foreground/5 focus-visible:before:bg-border focus-visible:after:scale-x-100 focus-visible:after:bg-foreground/5"
                      onKeyDown={handleRightSidePanelResizeKeyDown}
                      onPointerDown={handleRightSidePanelResizePointerDown}
                    />
                  ) : null}
                  <div
                    className={cn(
                      "ace-panel-content flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
                      (rightSidePanelResizing || rightSidePanelMotionActive) &&
                        "pointer-events-none select-none",
                    )}
                  >
                    <ChatViewRightSidePanelContent
                      rightSidePanelBodyDeferred={rightSidePanelBodyDeferred}
                      activeRightSidePanelMode={activeRightSidePanelMode}
                      activePlan={activePlan}
                      sidebarProposedPlan={sidebarProposedPlan}
                      activeGeneratedWorkspaceSummary={activeGeneratedWorkspaceSummary}
                      activeThread={activeThread}
                      gitCwd={gitCwd}
                      isGitRepo={isGitRepo}
                      canOpenLocalMarkdownFiles={canOpenLocalMarkdownFiles}
                      localDiffState={localDiffState}
                      addDiffReviewComment={addDiffReviewComment}
                      setLocalDiffState={setLocalDiffState}
                      visibleActiveSubagentThreadId={visibleActiveSubagentThreadId}
                      renderSubagentComposer={renderSubagentComposer}
                      messagesTimelineProps={messagesTimelineProps}
                      subagentThreads={subagentThreads}
                      threadTerminalRuntimeEnv={threadTerminalRuntimeEnv}
                      terminalFocusRequestId={terminalFocusRequestId}
                      activeForSideEffects={activeForSideEffects}
                      createNewPanelTerminal={createNewPanelTerminal}
                      newTerminalShortcutLabel={newTerminalShortcutLabel}
                      rightPanelTerminalShortcutLabel={rightPanelTerminalShortcutLabel}
                      activatePanelTerminal={activatePanelTerminal}
                      movePanelTerminal={movePanelTerminal}
                      setPanelTerminalGroupSplitRatios={setPanelTerminalGroupSplitRatios}
                      setTerminalAutoTitle={setTerminalAutoTitle}
                      closeTerminal={closeTerminal}
                      toggleTerminalVisibility={toggleTerminalVisibility}
                      onCloseRightSidePanelTerminal={onCloseRightSidePanelTerminal}
                      setRightPanelTerminalHeight={setRightPanelTerminalHeight}
                      addTerminalContextToDraft={addTerminalContextToDraft}
                      openBrowserUrlInNewTab={openBrowserUrlInNewTab}
                      openMarkdownFileInAppEditor={openMarkdownFileInAppEditor}
                      activeRightPanelEditorTabId={activeRightPanelEditorTabId}
                      rightPanelFallbackEditorStateInstanceId={
                        rightPanelFallbackEditorStateInstanceId
                      }
                      availableEditors={availableEditors}
                      activeThreadBranchName={activeThreadBranchName}
                      activeServerConnectionUrl={activeServerConnectionUrl}
                      keybindings={keybindings}
                      anyBrowserOpen={anyBrowserOpen}
                      terminalState={terminalState}
                      activeProject={activeProject}
                      onCloseRightSidePanelEditor={onCloseRightSidePanelEditor}
                      submitWorkspaceAgentNote={submitWorkspaceAgentNote}
                      rightBrowserPanelInstanceIds={rightBrowserPanelInstanceIds}
                      bottomBrowserInstanceId={bottomBrowserInstanceId}
                      bottomPanelBrowserOpen={bottomPanelBrowserOpen}
                      bottomPanelMotionActive={bottomPanelMotionActive}
                      browserBackShortcutLabel={browserBackShortcutLabel}
                      browserDesignerAreaCommentShortcutLabel={
                        browserDesignerAreaCommentShortcutLabel
                      }
                      browserDesignerElementCommentShortcutLabel={
                        browserDesignerElementCommentShortcutLabel
                      }
                      browserDevToolsShortcutLabel={browserDevToolsShortcutLabel}
                      browserForwardShortcutLabel={browserForwardShortcutLabel}
                      browserReloadShortcutLabel={browserReloadShortcutLabel}
                      browserViewMode={browserViewMode as "full" | "split"}
                      closeBrowser={closeBrowser}
                      detachBottomPanelBrowser={detachBottomPanelBrowser}
                      detachRightSidePanelBrowser={detachRightSidePanelBrowser}
                      handleBrowserRuntimeStateChange={handleBrowserRuntimeStateChange}
                      isThreadHistoryLoading={isThreadHistoryLoading}
                      onBrowserSessionChange={onBrowserSessionChange}
                      onCloseBottomPanelBrowser={onCloseBottomPanelBrowser}
                      onToggleRightSidePanelFloatingChat={onToggleRightSidePanelFloatingChat}
                      onToggleRightSidePanelFullscreen={onToggleRightSidePanelFullscreen}
                      queueBrowserDesignRequest={queueBrowserDesignRequest}
                      resolveBrowserThreadConnectionUrl={resolveBrowserThreadConnectionUrl}
                      resizeBrowserViewportForBridge={resizeBrowserViewportForBridge}
                      rightBrowserInstanceId={rightBrowserInstanceId}
                      rightBrowserOpen={rightBrowserOpen}
                      rightSidePanelMotionActive={rightSidePanelMotionActive}
                      rightSidePanelInteractive={rightSidePanelInteractive}
                      setBrowserController={setBrowserController}
                    />
                  </div>
                </m.div>
              </m.div>
            ) : null}
          </AnimatePresence>

          <ChatViewPanels browserPanel={null} expandedImageOverlay={expandedImageOverlay} />
        </div>
        {/* end horizontal flex container */}

        <AnimatePresence initial={false}>
          {activeBottomPanelMode ? (
            <m.div
              key="thread-bottom-dock-panel"
              ref={bottomPanelElementRef}
              className="ace-bottom-panel-shell relative min-h-0 min-w-0 shrink-0 overflow-hidden shadow-[0_-1px_0_color-mix(in_oklch,var(--border)_42%,transparent)] will-change-[height,opacity]"
              data-panel-motion={bottomPanelMotionActive ? "active" : undefined}
              {...bottomPanelLayoutAnimation}
              {...(bottomPanelResizing ? { style: RESIZABLE_PANEL_HEIGHT_STYLE } : {})}
              onAnimationComplete={endBottomPanelMotion}
              onAnimationStart={beginBottomPanelMotion}
              transition={bottomPanelLayoutTransition}
            >
              <m.div
                className="ace-bottom-panel-surface flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background transform-gpu will-change-[transform,opacity]"
                style={{
                  ...bottomPanelSurfaceStyle,
                  transformOrigin: "center bottom",
                }}
                {...BOTTOM_EDGE_PANEL_SPRING_ANIMATION}
                transition={PANEL_SPRING_TRANSITION}
              >
                <button
                  type="button"
                  aria-label="Resize bottom panel"
                  tabIndex={0}
                  className="group absolute inset-x-0 top-0 z-30 h-2 cursor-row-resize touch-none select-none border-0 bg-transparent outline-none before:absolute before:inset-x-8 before:top-0 before:h-px before:bg-transparent before:transition-colors before:content-[''] after:absolute after:inset-x-0 after:top-0 after:h-2 after:bg-transparent after:transition-colors after:content-[''] hover:before:bg-border/65 hover:after:bg-foreground/4 focus-visible:before:bg-border/75 focus-visible:after:bg-foreground/5"
                  onPointerDown={handleBottomPanelResizePointerDown}
                />
                <div
                  className={cn(
                    "ace-panel-content flex min-h-0 flex-1 flex-col overflow-hidden",
                    (bottomPanelResizing || bottomPanelMotionActive) &&
                      "pointer-events-none select-none",
                  )}
                >
                  <ChatViewBottomPanelContent
                    bottomPanelBodyDeferred={bottomPanelBodyDeferred}
                    bottomPanelTabStripNode={bottomPanelTabStripNode}
                    bottomPanelContentElementRef={bottomPanelContentElementRef}
                    bottomPanelResizing={bottomPanelResizing}
                    bottomPanelContentHeightPx={bottomPanelContentHeightPx}
                    activeBottomPanelMode={activeBottomPanelMode}
                    activePlan={activePlan}
                    sidebarProposedPlan={sidebarProposedPlan}
                    activeGeneratedWorkspaceSummary={activeGeneratedWorkspaceSummary}
                    activeThread={activeThread}
                    gitCwd={gitCwd}
                    isGitRepo={isGitRepo}
                    canOpenLocalMarkdownFiles={canOpenLocalMarkdownFiles}
                    onOpenBottomPanelDiff={onOpenBottomPanelDiff}
                    handleRegenerateSummary={handleRegenerateSummary}
                    openBrowserUrlInNewTab={openBrowserUrlInNewTab}
                    openMarkdownFileInAppEditor={openMarkdownFileInAppEditor}
                    localDiffState={localDiffState}
                    addDiffReviewComment={addDiffReviewComment}
                    setLocalDiffState={setLocalDiffState}
                    visibleActiveSubagentThreadId={visibleActiveSubagentThreadId}
                    renderSubagentComposer={renderSubagentComposer}
                    messagesTimelineProps={messagesTimelineProps}
                    subagentThreads={subagentThreads}
                    threadTerminalRuntimeEnv={threadTerminalRuntimeEnv}
                    terminalFocusRequestId={terminalFocusRequestId}
                    activeForSideEffects={activeForSideEffects}
                    createNewTerminal={createNewTerminal}
                    newTerminalShortcutLabel={newTerminalShortcutLabel}
                    terminalToggleShortcutLabel={terminalToggleShortcutLabel}
                    activateTerminal={activateTerminal}
                    moveTerminal={moveTerminal}
                    setTerminalGroupSplitRatios={setTerminalGroupSplitRatios}
                    setTerminalAutoTitle={setTerminalAutoTitle}
                    closeTerminal={closeTerminal}
                    toggleTerminalVisibility={toggleTerminalVisibility}
                    onCloseBottomPanelTerminal={onCloseBottomPanelTerminal}
                    setTerminalHeight={setTerminalHeight}
                    addTerminalContextToDraft={addTerminalContextToDraft}
                    activeBottomPanelEditorTabId={activeBottomPanelEditorTabId}
                    bottomPanelFallbackEditorStateInstanceId={
                      bottomPanelFallbackEditorStateInstanceId
                    }
                    availableEditors={availableEditors}
                    activeThreadBranchName={activeThreadBranchName}
                    activeServerConnectionUrl={activeServerConnectionUrl}
                    keybindings={keybindings}
                    anyBrowserOpen={anyBrowserOpen}
                    terminalState={terminalState}
                    activeProject={activeProject}
                    onCloseBottomPanelEditor={onCloseBottomPanelEditor}
                    submitWorkspaceAgentNote={submitWorkspaceAgentNote}
                    bottomBrowserPanelInstanceIds={bottomBrowserPanelInstanceIds}
                    bottomBrowserInstanceId={bottomBrowserInstanceId}
                    bottomPanelBrowserOpen={bottomPanelBrowserOpen}
                    bottomPanelMotionActive={bottomPanelMotionActive}
                    browserBackShortcutLabel={browserBackShortcutLabel}
                    browserDesignerAreaCommentShortcutLabel={
                      browserDesignerAreaCommentShortcutLabel
                    }
                    browserDesignerElementCommentShortcutLabel={
                      browserDesignerElementCommentShortcutLabel
                    }
                    browserDevToolsShortcutLabel={browserDevToolsShortcutLabel}
                    browserForwardShortcutLabel={browserForwardShortcutLabel}
                    browserReloadShortcutLabel={browserReloadShortcutLabel}
                    browserViewMode={browserViewMode as "full" | "split"}
                    closeBrowser={closeBrowser}
                    detachBottomPanelBrowser={detachBottomPanelBrowser}
                    detachRightSidePanelBrowser={detachRightSidePanelBrowser}
                    handleBrowserRuntimeStateChange={handleBrowserRuntimeStateChange}
                    isThreadHistoryLoading={isThreadHistoryLoading}
                    onBrowserSessionChange={onBrowserSessionChange}
                    onCloseBottomPanelBrowser={onCloseBottomPanelBrowser}
                    onToggleRightSidePanelFloatingChat={onToggleRightSidePanelFloatingChat}
                    onToggleRightSidePanelFullscreen={onToggleRightSidePanelFullscreen}
                    queueBrowserDesignRequest={queueBrowserDesignRequest}
                    resolveBrowserThreadConnectionUrl={resolveBrowserThreadConnectionUrl}
                    resizeBrowserViewportForBridge={resizeBrowserViewportForBridge}
                    rightBrowserInstanceId={rightBrowserInstanceId}
                    rightBrowserOpen={rightBrowserOpen}
                    rightSidePanelMotionActive={rightSidePanelMotionActive}
                    rightSidePanelInteractive={rightSidePanelInteractive}
                    setBrowserController={setBrowserController}
                  />
                </div>
              </m.div>
            </m.div>
          ) : null}
        </AnimatePresence>
      </div>
    </LazyMotion>
  );
}

export default function ChatView(props: ChatViewProps) {
  return useChatViewComponent(props);
}
