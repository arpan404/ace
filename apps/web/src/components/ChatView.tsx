import {
  type ApprovalRequestId,
  type ClientOrchestrationCommand,
  type CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  type MessageId,
  type ModelSelection,
  type ProjectScript,
  type ProviderKind,
  type ProjectEntry,
  type ProjectId,
  type ProviderApprovalDecision,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_DISPLAY_NAMES,
  type ThreadHandoffMode,
  type ThreadId,
  type TurnId,
  type KeybindingCommand,
  type GitHubIssue,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  RuntimeMode,
  TerminalOpenInput,
} from "@ace/contracts";
import * as Schema from "effect/Schema";
import { buildProviderModelSelection } from "@ace/shared/model";
import { truncate } from "@ace/shared/String";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  lazy,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import {
  gitBranchesQueryOptions,
  gitCreateWorktreeMutationOptions,
  gitGitHubIssuesQueryOptions,
  gitStatusQueryOptions,
} from "~/lib/gitReactQuery";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { isElectron } from "../env";
import { parseDiffRouteSearch } from "../diffRouteSearch";
import {
  normalizeThreadWorkspaceLayoutMode,
  THREAD_WORKSPACE_LAYOUT_BY_THREAD_ID_STORAGE_KEY,
  THREAD_WORKSPACE_MODE_BY_THREAD_ID_STORAGE_KEY,
  ThreadWorkspaceLayoutByThreadIdSchema,
  ThreadWorkspaceModeByThreadIdSchema,
  type ThreadWorkspaceMode,
} from "../threadWorkspaceMode";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  extendReplacementRangeForTrailingSpace,
  parseComposerIssuesCommand,
  parseStandaloneComposerSlashCommand,
  replaceTextRange,
} from "../composer-logic";
import {
  createMarkedIssueReferenceToken,
  extractIssueReferenceNumbers,
  stripIssueReferenceMarkers,
} from "../composer-editor-mentions";
import {
  deriveCompletionDividerBeforeEntryId,
  derivePhase,
  deriveActiveWorkStartedAt,
  deriveVisibleWorkTurnId,
  deriveActivePlanState,
  findSidebarProposedPlan,
  findLatestProposedPlan,
  hasLiveTurn,
  hasActionableProposedPlan,
  isLatestTurnSettled,
  summarizeActivePlan,
  formatElapsed,
} from "../session-logic";
import {
  isScrollContainerNearBottom,
  resolveAutoScrollOnScroll,
  shouldPreserveInteractionAnchorOnClick,
  scrollContainerToBottom,
} from "../chat-scroll";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  selectPendingUserInputOption,
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { type AppState, getThreadById, useStore } from "../store";
import { useProjectById, useThreadById } from "../storeSelectors";
import { useUiStateStore } from "../uiStateStore";
import { useHostConnectionStore } from "../hostConnectionStore";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  proposedPlanTitle,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import { shouldEscalateInterruptToSessionStop } from "../lib/chat/interruptFallback";
import { getDefaultServerModel } from "../providerModels";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ChatMessage,
  type QueuedComposerImageAttachment,
  type Thread,
} from "../types";
import { isMemoryPressureAtLeast, subscribeToMemoryPressure } from "../lib/memoryPressure";
import {
  hydrateThreadFromCache,
  readCachedHydratedThread,
  resolveThreadHydrationRetryDelayMs,
} from "../lib/threadHydrationCache";

import { basenameOfPath } from "../vscode-icons";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useTheme } from "../hooks/useTheme";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { defaultShortcutLabelForCommand } from "~/lib/keybindingRegistry";
import { AppPageTopBar } from "./AppPageTopBar";
import { cn, randomUUID } from "~/lib/utils";
import { resolveSidebarNewThreadOptions } from "~/lib/sidebar";
import { toastManager } from "./ui/toast";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { type NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptCwd,
  projectScriptRuntimeEnv,
  projectScriptIdFromCommand,
  setupProjectScript,
} from "~/projectScripts";
import { newCommandId, newMessageId, newThreadId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { reportBackgroundError, runAsyncTask } from "~/lib/async";
import { deriveTerminalTitleFromCommand } from "~/lib/terminalPresentation";
import { getProviderModels, resolveSelectableProvider } from "../providerModels";
import { useSetting } from "../hooks/useSettings";
import { resolveAppModelSelection } from "../modelSelection";
import { isTerminalFocused } from "../lib/terminalFocus";
import {
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  type PersistedComposerImageAttachment,
  deriveEffectiveComposerModelState,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../composerDraftStore";
import {
  appendBrowserDesignContextToPrompt,
  appendTerminalContextsToPrompt,
  deriveDisplayedUserMessageState,
  formatTerminalContextLabel,
  insertInlineTerminalContextPlaceholder,
  removeInlineTerminalContextPlaceholder,
  syncTerminalContextsByIds,
  terminalContextIdListsEqual,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import { deriveLatestContextWindowSnapshot } from "../lib/contextWindow";
import { buildGitHubIssueSelectionPayload } from "~/lib/chat/githubIssueSelection";
import { SIDEBAR_RESIZE_END_EVENT, isLayoutResizeInProgress } from "~/lib/desktopChrome";
import {
  deriveThreadActivityRenderState,
  deriveThreadTimelineRenderState,
} from "~/lib/chat/threadRenderState";
import {
  resolveComposerFooterContentWidth,
  shouldForceCompactComposerFooterForFit,
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
} from "~/lib/composer/footerLayout";
import { THREAD_ROUTE_CONNECTION_SEARCH_PARAM } from "../lib/connectionRouting";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { ChatHeader } from "./chat/ChatHeader";
import { ChatConversationExtras } from "./chat/ChatConversationExtras";
import { GitHubIssuePreviewDialog } from "./GitHubIssuePreviewDialog";
import { ThreadHistoryLoadingNotice } from "./GitHubIssueSkeletons";
import { ChatMessagesPane } from "./chat/ChatMessagesPane";
import { PlanSummaryPanel } from "./PlanSummaryPanel";
import { ChatComposerPanel } from "./chat/ChatComposerPanel";
import { ChatViewPanels } from "./chat/ChatViewPanels";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { NewThreadLanding } from "./chat/NewThreadLanding";
import { AVAILABLE_PROVIDER_OPTIONS } from "./chat/ProviderModelPicker";
import {
  InAppBrowser,
  type ActiveBrowserRuntimeState,
  type InAppBrowserController,
  type InAppBrowserMode,
} from "./InAppBrowser";
import { ComposerCommandItem } from "./chat/ComposerCommandMenu";
import { LocalDiffPanel, RightSidePanelTabStrip } from "./chat/ChatViewRightSidePanels";
import { useChatViewModelState } from "./chat/useChatViewModelState";
import { getComposerProviderState } from "./chat/composerProviderRegistry";
import { ProviderStatusBanner } from "./chat/ProviderStatusBanner";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import {
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  buildTemporaryWorktreeBranchName,
  appendHiddenBrowserDesignContextFromOriginalPrompt,
  cloneComposerImageForRetry,
  collectUserMessageBlobPreviewUrls,
  deriveComposerSendState,
  deriveHydratedThreadHistoryKeepIds,
  deriveQueuedComposerMessageDraftForEditing,
  formatOutgoingPrompt,
  queuedComposerImageToDraftAttachment,
  revokeComposerImagePreviewUrls,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  PullRequestDialogState,
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
import { useThreadPlanCatalog } from "~/lib/chat/threadPlanCatalog";
import {
  BROWSER_SPLIT_WIDTH_STORAGE_KEY,
  DEFAULT_BROWSER_SPLIT_WIDTH,
  clampBrowserSplitWidth,
} from "~/lib/chat/browserSplit";
import {
  DEFAULT_WORKSPACE_EDITOR_SPLIT_WIDTH,
  MIN_WORKSPACE_CHAT_SPLIT_WIDTH,
  WORKSPACE_EDITOR_SPLIT_WIDTH_STORAGE_KEY,
  clampWorkspaceEditorSplitWidth,
} from "~/lib/chat/workspaceSplit";
import type { BrowserSessionStorage } from "~/lib/browser/session";
import {
  buildHandoffTimeline,
  type HandoffLineageResult,
  resolveHandoffLineage,
} from "~/lib/chat/handoff";
import {
  subscribeToBrowserLaunchRequests,
  takePendingBrowserLaunchRequest,
} from "~/lib/browser/launcher";
import { touchRecentBrowserInstanceId } from "~/lib/browser/liveInstanceCache";
import { resolveScopedBrowserStorageKey } from "~/lib/browser/storage";
import {
  BROWSER_PANEL_MODE_STORAGE_KEY,
  RIGHT_SIDE_PANEL_DIFF_OPEN_STORAGE_KEY,
  RIGHT_SIDE_PANEL_EDITOR_OPEN_STORAGE_KEY,
  RIGHT_SIDE_PANEL_FULLSCREEN_STORAGE_KEY,
  RIGHT_SIDE_PANEL_LAST_NON_DIFF_MODE_STORAGE_KEY,
  RIGHT_SIDE_PANEL_MODE_STORAGE_KEY,
  RIGHT_SIDE_PANEL_REVIEW_OPEN_STORAGE_KEY,
  RIGHT_SIDE_PANEL_VISIBLE_STORAGE_KEY,
  RIGHT_SIDE_PANEL_WIDTH_STORAGE_KEY,
  RightSidePanelModeStorageSchema,
  resolveRightSidePanelModeAfterDiffClose,
  type RightSidePanelMode,
} from "~/lib/rightSidePanelState";
import { type BrowserDesignRequestSubmission } from "~/lib/browser/types";
import { useLocalDispatchState } from "~/hooks/useLocalDispatchState";
import { useEffectEvent } from "~/hooks/useEffectEvent";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  useConnectionServerProviders,
  resolveThreadOriginConnectionUrl,
} from "~/hooks/useConnectionServerProviders";
import { useServerAvailableEditors, useServerKeybindings } from "~/rpc/serverState";
import {
  loadRemoteHostInstances,
  normalizeWsUrl,
  resolveHostConnectionWsUrl,
} from "~/lib/remoteHosts";

const ThreadWorkspaceEditor = lazy(() => import("./editor/ThreadWorkspaceEditor"));

const WORKSPACE_SIDE_PANEL_TRANSITION = {
  opacity: { duration: 0.16, ease: [0.16, 1, 0.3, 1] },
  width: { duration: 0 },
  x: { duration: 0.18, ease: [0.16, 1, 0.3, 1] },
} as const;
const RIGHT_SIDE_PANEL_TRANSITION = {
  opacity: { duration: 0.18, ease: [0.16, 1, 0.3, 1] },
  width: { duration: 0 },
  x: { duration: 0.22, ease: [0.16, 1, 0.3, 1] },
} as const;
const RIGHT_SIDE_PANEL_CONTENT_TRANSITION = {
  delay: 0.06,
  duration: 0.18,
  ease: [0.16, 1, 0.3, 1],
} as const;
const TERMINAL_DRAWER_TRANSITION = {
  duration: 0.2,
  ease: [0.16, 1, 0.3, 1],
} as const;

const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;
const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_GITHUB_ISSUES: readonly GitHubIssue[] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const EMPTY_QUEUED_COMPOSER_MESSAGES: Thread["queuedComposerMessages"] = [];
const THREAD_SWITCH_SCROLL_SETTLE_DELAY_MS = 96;
const BrowserPanelModeSchema = Schema.Literals(["closed", "full", "split"]);

const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;
const DEFAULT_RIGHT_SIDE_PANEL_WIDTH = 512;
const MIN_RIGHT_SIDE_PANEL_WIDTH = 416;
const MIN_RIGHT_SIDE_PANEL_CHAT_WIDTH = 420;
const MAX_CACHED_BROWSER_INSTANCES = 3;

function clampRightSidePanelWidth(width: number, viewportWidth: number): number {
  const safeViewportWidth = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 0;
  const maxWidth = Math.max(
    MIN_RIGHT_SIDE_PANEL_WIDTH,
    safeViewportWidth - MIN_RIGHT_SIDE_PANEL_CHAT_WIDTH,
  );
  const normalizedWidth = Number.isFinite(width)
    ? Math.round(width)
    : DEFAULT_RIGHT_SIDE_PANEL_WIDTH;
  return Math.min(maxWidth, Math.max(MIN_RIGHT_SIDE_PANEL_WIDTH, normalizedWidth));
}

function constrainedPanelWidth(
  width: number,
  minimumRemainingWidth: number,
  minimumPanelWidth = 0,
): string {
  const roundedWidth = Math.round(width);
  if (minimumPanelWidth > 0) {
    return `min(100vw, clamp(${minimumPanelWidth}px, ${roundedWidth}px, calc(100vw - ${minimumRemainingWidth}px)))`;
  }
  return `min(${roundedWidth}px, calc(100vw - ${minimumRemainingWidth}px))`;
}

type QueuedComposerMessage = Thread["queuedComposerMessages"][number];

interface ChatViewProps {
  connectionUrl?: string | null;
  shortcutsEnabled?: boolean;
  showSidebarTrigger?: boolean;
  splitPane?: boolean;
  threadId: ThreadId;
}

function handoffLineageResultsEqual(
  left: HandoffLineageResult | null,
  right: HandoffLineageResult | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null) {
    return false;
  }
  if (left.hasCycle !== right.hasCycle || left.missingThreadId !== right.missingThreadId) {
    return false;
  }
  if (left.threads.length !== right.threads.length) {
    return false;
  }
  for (let index = 0; index < left.threads.length; index += 1) {
    if (left.threads[index] !== right.threads[index]) {
      return false;
    }
  }
  return true;
}

function createHandoffLineageSelector(sourceThreadId: ThreadId | null) {
  let previousResult: HandoffLineageResult | null = null;
  return (state: AppState): HandoffLineageResult | null => {
    if (!sourceThreadId) {
      previousResult = null;
      return null;
    }
    const nextResult = resolveHandoffLineage({
      sourceThreadId,
      threads: state.threads,
    });
    if (handoffLineageResultsEqual(previousResult, nextResult)) {
      return previousResult;
    }
    previousResult = nextResult;
    return nextResult;
  };
}

interface LocalDiffState {
  filePath: string | null;
  open: boolean;
  turnId: TurnId | null;
}

const DEFAULT_LOCAL_DIFF_STATE: LocalDiffState = {
  filePath: null,
  open: false,
  turnId: null,
};

const INTERRUPT_STOP_FALLBACK_DELAY_MS = 3_000;

interface PendingPullRequestSetupRequest {
  threadId: ThreadId;
  worktreePath: string;
  scriptId: string;
}

export default function ChatView({
  connectionUrl = null,
  shortcutsEnabled = true,
  showSidebarTrigger = true,
  splitPane = false,
  threadId,
}: ChatViewProps) {
  const serverThread = useThreadById(threadId);
  const setStoreThreadError = useStore((store) => store.setError);
  const dismissStoreThreadError = useStore((store) => store.dismissThreadError);
  const setStoreThreadBranch = useStore((store) => store.setThreadBranch);
  const hydrateThreadFromReadModel = useStore((store) => store.hydrateThreadFromReadModel);
  const pruneHydratedThreadHistories = useStore((store) => store.pruneHydratedThreadHistories);
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const trackActiveThread = useUiStateStore((store) => store.trackActiveThread);
  const trackedActiveThreadId = useUiStateStore((store) => store.activeThreadId);
  const previousActiveThreadId = useUiStateStore((store) => store.previousActiveThreadId);
  const activeThreadLastVisitedAt = useUiStateStore(
    (store) => store.threadLastVisitedAtById[threadId],
  );
  const defaultThreadEnvMode = useSetting("defaultThreadEnvMode");
  const enableThinkingStreaming = useSetting("enableThinkingStreaming");
  const enableToolStreaming = useSetting("enableToolStreaming");
  const providerSettings = useSetting("providers");
  const timestampFormat = useSetting("timestampFormat");
  const workspaceEditorOpenMode = useSetting("workspaceEditorOpenMode");
  const modelSettings = useMemo(() => ({ providers: providerSettings }), [providerSettings]);
  const {
    activeDraftThread: currentRouteDraftThread,
    activeThread: currentRouteThread,
    defaultProjectId,
    handleNewThread,
  } = useHandleNewThread();
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const navigate = useNavigate();
  const locationSearch = useLocation({ select: (location) => location.searchStr });
  const rawSearch = useSearch({
    strict: false,
    select: (params) => parseDiffRouteSearch(params),
  });
  const [localDiffStateByThreadId, setLocalDiffStateByThreadId] = useState<
    Record<ThreadId, LocalDiffState>
  >({});
  const rightSidePanelModeStorageKey = useMemo(
    () => resolveScopedBrowserStorageKey(RIGHT_SIDE_PANEL_MODE_STORAGE_KEY, threadId),
    [threadId],
  );
  const rightSidePanelLastNonDiffModeStorageKey = useMemo(
    () => resolveScopedBrowserStorageKey(RIGHT_SIDE_PANEL_LAST_NON_DIFF_MODE_STORAGE_KEY, threadId),
    [threadId],
  );
  const rightSidePanelReviewOpenStorageKey = useMemo(
    () => resolveScopedBrowserStorageKey(RIGHT_SIDE_PANEL_REVIEW_OPEN_STORAGE_KEY, threadId),
    [threadId],
  );
  const rightSidePanelEditorOpenStorageKey = useMemo(
    () => resolveScopedBrowserStorageKey(RIGHT_SIDE_PANEL_EDITOR_OPEN_STORAGE_KEY, threadId),
    [threadId],
  );
  const rightSidePanelFullscreenStorageKey = useMemo(
    () => resolveScopedBrowserStorageKey(RIGHT_SIDE_PANEL_FULLSCREEN_STORAGE_KEY, threadId),
    [threadId],
  );
  const rightSidePanelDiffOpenStorageKey = useMemo(
    () => resolveScopedBrowserStorageKey(RIGHT_SIDE_PANEL_DIFF_OPEN_STORAGE_KEY, threadId),
    [threadId],
  );
  const rightSidePanelVisibleStorageKey = useMemo(
    () => resolveScopedBrowserStorageKey(RIGHT_SIDE_PANEL_VISIBLE_STORAGE_KEY, threadId),
    [threadId],
  );
  const browserPanelModeStorageKey = useMemo(
    () => resolveScopedBrowserStorageKey(BROWSER_PANEL_MODE_STORAGE_KEY, threadId),
    [threadId],
  );
  const rightSidePanelWidthStorageKey = useMemo(
    () => resolveScopedBrowserStorageKey(RIGHT_SIDE_PANEL_WIDTH_STORAGE_KEY, threadId),
    [threadId],
  );
  const [rightSidePanelMode, setRightSidePanelMode] = useLocalStorage(
    rightSidePanelModeStorageKey,
    null,
    RightSidePanelModeStorageSchema,
  );
  const [rightSidePanelLastNonDiffMode, setRightSidePanelLastNonDiffMode] = useLocalStorage(
    rightSidePanelLastNonDiffModeStorageKey,
    "summary" satisfies Exclude<RightSidePanelMode, "diff">,
    Schema.Literals(["browser", "editor", "summary"]),
  );
  const [rightSidePanelDiffOpen, setRightSidePanelDiffOpenState] = useLocalStorage(
    rightSidePanelDiffOpenStorageKey,
    false,
    Schema.Boolean,
  );
  const [rightSidePanelReviewOpen, setRightSidePanelReviewOpen] = useLocalStorage(
    rightSidePanelReviewOpenStorageKey,
    false,
    Schema.Boolean,
  );
  const [rightSidePanelEditorOpen, setRightSidePanelEditorOpen] = useLocalStorage(
    rightSidePanelEditorOpenStorageKey,
    false,
    Schema.Boolean,
  );
  const [rightSidePanelFullscreen, setRightSidePanelFullscreen] = useLocalStorage(
    rightSidePanelFullscreenStorageKey,
    false,
    Schema.Boolean,
  );
  const [rightSidePanelVisible, setRightSidePanelVisible] = useLocalStorage(
    rightSidePanelVisibleStorageKey,
    true,
    Schema.Boolean,
  );
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const createWorktreeMutation = useMutation(gitCreateWorktreeMutationOptions({ queryClient }));
  const composerDraft = useComposerThreadDraft(threadId);
  const prompt = composerDraft.prompt;
  const composerImages = composerDraft.images;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const persistedComposerAttachments = composerDraft.persistedAttachments;
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        terminalContexts: composerTerminalContexts,
      }),
    [composerImages.length, composerTerminalContexts, prompt],
  );
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftProviderModelOptions = useComposerDraftStore(
    (store) => store.setProviderModelOptions,
  );
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const addComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.addTerminalContexts,
  );
  const removeComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.removeTerminalContext,
  );
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
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
  const promptRef = useRef(prompt);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>(composerTerminalContexts);
  const [localDraftErrorsByThreadId, setLocalDraftErrorsByThreadId] = useState<
    Record<ThreadId, string | null>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const [isHeaderHidden, setIsHeaderHidden] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
  const openSummaryOnNextThreadRef = useRef(false);
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [gitHubIssueDialogOpen, setGitHubIssueDialogOpen] = useState(false);
  const [gitHubIssueDialogInitialIssueNumber, setGitHubIssueDialogInitialIssueNumber] = useState<
    number | null
  >(null);
  const [
    gitHubIssueDialogInitialSelectedIssueNumbers,
    setGitHubIssueDialogInitialSelectedIssueNumbers,
  ] = useState<number[]>([]);
  const [issuePreviewNumber, setIssuePreviewNumber] = useState<number | null>(null);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [pendingPullRequestSetupRequest, setPendingPullRequestSetupRequest] =
    useState<PendingPullRequestSetupRequest | null>(null);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const [messagesScrollElement, setMessagesScrollElement] = useState<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const previousThreadIdRef = useRef<ThreadId | null>(null);
  const directThreadHydrationInFlightRef = useRef<ThreadId | null>(null);
  const directThreadHydrationFailureCountRef = useRef(0);
  const [directThreadHydrationRetryAt, setDirectThreadHydrationRetryAt] = useState<number | null>(
    null,
  );
  const lastKnownScrollTopRef = useRef(0);
  const isPointerScrollActiveRef = useRef(false);
  const lastTouchClientYRef = useRef<number | null>(null);
  const pendingUserScrollUpIntentRef = useRef(false);
  const pendingAutoScrollFrameRef = useRef<number | null>(null);
  const pendingInteractionAnchorRef = useRef<{
    element: HTMLElement;
    top: number;
  } | null>(null);
  const pendingInteractionAnchorFrameRef = useRef<number | null>(null);
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerFormHeightRef = useRef(0);
  const composerFooterRef = useRef<HTMLDivElement>(null);
  const composerFooterLeadingRef = useRef<HTMLDivElement>(null);
  const composerFooterActionsRef = useRef<HTMLDivElement>(null);
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const dismissedComposerTriggerRef = useRef<{
    kind: ComposerTrigger["kind"];
    rangeStart: number;
  } | null>(null);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewHandoffTimeoutByMessageIdRef = useRef<Record<string, number>>({});
  const pendingInterruptStopFallbackRef = useRef<number | null>(null);
  const sendInFlightRef = useRef(false);
  const queuedDesignMessageEditRef = useRef<QueuedComposerMessage | null>(null);
  const [handoffInFlight, setHandoffInFlight] = useState(false);
  const dragDepthRef = useRef(0);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});
  const setMessagesScrollContainerRef = useCallback((element: HTMLDivElement | null) => {
    messagesScrollRef.current = element;
    setMessagesScrollElement(element);
  }, []);
  useEffect(() => {
    if (
      prompt.length === 0 &&
      composerImages.length === 0 &&
      composerTerminalContexts.length === 0 &&
      !sendInFlightRef.current
    ) {
      queuedDesignMessageEditRef.current = null;
    }
  }, [composerImages.length, composerTerminalContexts.length, prompt]);

  const threadTerminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, threadId),
  );
  const storeSetTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const storeSetTerminalHeight = useTerminalStateStore((s) => s.setTerminalHeight);
  const storeSetTerminalSidebarWidth = useTerminalStateStore((s) => s.setTerminalSidebarWidth);
  const storeSetTerminalSidebarDensity = useTerminalStateStore((s) => s.setTerminalSidebarDensity);
  const storeSplitTerminal = useTerminalStateStore((s) => s.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((s) => s.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((s) => s.setActiveTerminal);
  const storeMoveTerminal = useTerminalStateStore((s) => s.moveTerminal);
  const storeMoveTerminalToNewGroup = useTerminalStateStore((s) => s.moveTerminalToNewGroup);
  const storeRenameTerminal = useTerminalStateStore((s) => s.renameTerminal);
  const storeSetTerminalAutoTitle = useTerminalStateStore((s) => s.setTerminalAutoTitle);
  const storeSetTerminalIcon = useTerminalStateStore((s) => s.setTerminalIcon);
  const storeSetTerminalColor = useTerminalStateStore((s) => s.setTerminalColor);
  const storeSetTerminalGroupSplitRatios = useTerminalStateStore(
    (s) => s.setTerminalGroupSplitRatios,
  );
  const storeCloseTerminal = useTerminalStateStore((s) => s.closeTerminal);
  const storeClearTerminalState = useTerminalStateStore((s) => s.clearTerminalState);

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(threadId, nextPrompt);
    },
    [setComposerDraftPrompt, threadId],
  );
  const detectComposerTriggerWithDismissal = useCallback(
    (text: string, expandedCursor: number): ComposerTrigger | null => {
      const detected = detectComposerTrigger(text, expandedCursor);
      if (!detected) {
        dismissedComposerTriggerRef.current = null;
        return null;
      }
      const dismissed = dismissedComposerTriggerRef.current;
      if (
        dismissed &&
        dismissed.kind === detected.kind &&
        dismissed.rangeStart === detected.rangeStart
      ) {
        return null;
      }
      dismissedComposerTriggerRef.current = null;
      return detected;
    },
    [],
  );
  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      addComposerDraftImage(threadId, image);
    },
    [addComposerDraftImage, threadId],
  );
  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      addComposerDraftImages(threadId, images);
    },
    [addComposerDraftImages, threadId],
  );
  const addComposerTerminalContextsToDraft = useCallback(
    (contexts: TerminalContextDraft[]) => {
      addComposerDraftTerminalContexts(threadId, contexts);
    },
    [addComposerDraftTerminalContexts, threadId],
  );
  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      removeComposerDraftImage(threadId, imageId);
    },
    [removeComposerDraftImage, threadId],
  );
  const removeComposerTerminalContextFromDraft = useCallback(
    (contextId: string) => {
      const contextIndex = composerTerminalContexts.findIndex(
        (context) => context.id === contextId,
      );
      if (contextIndex < 0) {
        return;
      }
      const nextPrompt = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
      promptRef.current = nextPrompt.prompt;
      setPrompt(nextPrompt.prompt);
      removeComposerDraftTerminalContext(threadId, contextId);
      setComposerCursor(nextPrompt.cursor);
      setComposerTrigger(
        detectComposerTriggerWithDismissal(
          nextPrompt.prompt,
          expandCollapsedComposerCursor(nextPrompt.prompt, nextPrompt.cursor),
        ),
      );
    },
    [
      composerTerminalContexts,
      detectComposerTriggerWithDismissal,
      removeComposerDraftTerminalContext,
      setPrompt,
      threadId,
    ],
  );

  const threadConnectionById = useHostConnectionStore((store) => store.threadConnectionById);
  const projectConnectionById = useHostConnectionStore((store) => store.projectConnectionById);
  const routeConnectionUrl = useMemo(() => {
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
  }, [locationSearch]);
  const activeServerConnectionUrl = useMemo(
    () =>
      resolveThreadOriginConnectionUrl({
        threadId,
        explicitConnectionUrl: connectionUrl,
        routeConnectionUrl,
        projectId: serverThread?.projectId ?? draftThread?.projectId ?? null,
        threadConnectionById,
        projectConnectionById,
      }),
    [
      connectionUrl,
      draftThread?.projectId,
      projectConnectionById,
      routeConnectionUrl,
      serverThread?.projectId,
      threadConnectionById,
      threadId,
    ],
  );
  const resolveBrowserThreadConnectionUrl = useCallback(
    (browserThreadId: ThreadId): string => {
      const browserThread =
        browserThreadId === threadId
          ? (serverThread ?? draftThread ?? null)
          : (getThreadById(useStore.getState().threads, browserThreadId) ?? null);
      return resolveThreadOriginConnectionUrl({
        threadId: browserThreadId,
        explicitConnectionUrl: browserThreadId === threadId ? connectionUrl : null,
        routeConnectionUrl,
        projectId: browserThread?.projectId ?? null,
        threadConnectionById,
        projectConnectionById,
      });
    },
    [
      connectionUrl,
      draftThread,
      projectConnectionById,
      routeConnectionUrl,
      serverThread,
      threadConnectionById,
      threadId,
    ],
  );
  const fallbackDraftProject = useProjectById(draftThread?.projectId);
  const localDraftError = serverThread ? null : (localDraftErrorsByThreadId[threadId] ?? null);
  const providerStatuses = useConnectionServerProviders(activeServerConnectionUrl);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            fallbackDraftProject?.defaultModelSelection ?? {
              provider: "codex",
              model: getDefaultServerModel(providerStatuses, "codex"),
            },
            localDraftError,
          )
        : undefined,
    [
      draftThread,
      fallbackDraftProject?.defaultModelSelection,
      localDraftError,
      providerStatuses,
      threadId,
    ],
  );
  const activeThread = serverThread ?? localDraftThread;
  const runtimeMode =
    composerDraft.runtimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode =
    composerDraft.interactionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE;
  const isServerThread = serverThread !== undefined;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const handoffLineageSelector = useMemo(
    () =>
      createHandoffLineageSelector(
        isServerThread ? (activeThread?.handoff?.sourceThreadId ?? null) : null,
      ),
    [activeThread?.handoff?.sourceThreadId, isServerThread],
  );
  const handoffLineage = useStore(handoffLineageSelector);
  const handoffSourceThreadIds = useMemo(
    () => handoffLineage?.threads.map((thread) => thread.id) ?? [],
    [handoffLineage],
  );
  const handoffMissingThreadId = handoffLineage?.missingThreadId ?? null;
  const handoffHasCycle = handoffLineage?.hasCycle ?? false;
  const isThreadHistoryLoading = isServerThread && activeThread?.historyLoaded === false;
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
  const diffOpen = splitPane ? localDiffState.open : rightSidePanelDiffOpen;
  const hasRightSidePanelContent = diffOpen || rightSidePanelMode !== null;
  const rightSidePanelOpen = rightSidePanelVisible && hasRightSidePanelContent;
  const activeThreadId = activeThread?.id ?? null;
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const sourceProposedPlanThreadId = activeLatestTurn?.sourceProposedPlan?.threadId ?? null;
  const sourcePlanThread = useThreadById(sourceProposedPlanThreadId);
  const sourcePlanHydrationInFlightRef = useRef<ThreadId | null>(null);
  const handoffHydrationInFlightRef = useRef<Set<ThreadId>>(new Set());
  const recentThreadHistoryKeepId =
    trackedActiveThreadId === activeThreadId ? previousActiveThreadId : trackedActiveThreadId;
  const recentThreadHistoryThread = useThreadById(recentThreadHistoryKeepId);
  const recentThreadHistoryHydrationInFlightRef = useRef<ThreadId | null>(null);
  const hydratedThreadHistoryKeepIds = useMemo<ThreadId[]>(
    () =>
      deriveHydratedThreadHistoryKeepIds({
        activeThreadId,
        sourceProposedPlanThreadId,
        previousThreadId: recentThreadHistoryKeepId,
        handoffSourceThreadIds,
      }),
    [activeThreadId, recentThreadHistoryKeepId, sourceProposedPlanThreadId, handoffSourceThreadIds],
  );
  const memoryPressureHydratedThreadHistoryKeepIds = useMemo<ThreadId[]>(
    () =>
      deriveHydratedThreadHistoryKeepIds({
        activeThreadId,
        sourceProposedPlanThreadId,
        previousThreadId: null,
        handoffSourceThreadIds,
      }),
    [activeThreadId, sourceProposedPlanThreadId, handoffSourceThreadIds],
  );
  const criticalHydratedThreadHistoryKeepIds = useMemo<ThreadId[]>(
    () => (activeThreadId ? [activeThreadId, ...handoffSourceThreadIds] : []),
    [activeThreadId, handoffSourceThreadIds],
  );

  // Update this before the next interaction so rapid thread switches keep the just-viewed history warm.
  useLayoutEffect(() => {
    trackActiveThread(activeThreadId);
  }, [activeThreadId, trackActiveThread]);

  useEffect(() => {
    directThreadHydrationFailureCountRef.current = 0;
    setDirectThreadHydrationRetryAt(null);
    directThreadHydrationInFlightRef.current = null;
  }, [serverThread?.id, serverThread?.updatedAt]);

  useEffect(() => {
    if (directThreadHydrationRetryAt === null) {
      return;
    }
    const remainingDelay = Math.max(0, directThreadHydrationRetryAt - Date.now());
    const timer = window.setTimeout(() => {
      setDirectThreadHydrationRetryAt((current) =>
        current === directThreadHydrationRetryAt ? null : current,
      );
    }, remainingDelay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [directThreadHydrationRetryAt]);

  useEffect(() => {
    if (
      !serverThread ||
      serverThread.historyLoaded !== false ||
      directThreadHydrationRetryAt !== null
    ) {
      return;
    }
    const cachedHydratedThread = serverThread.updatedAt
      ? readCachedHydratedThread(serverThread.id, serverThread.updatedAt)
      : null;
    if (cachedHydratedThread) {
      directThreadHydrationFailureCountRef.current = 0;
      setDirectThreadHydrationRetryAt(null);
      startTransition(() => {
        hydrateThreadFromReadModel(cachedHydratedThread);
      });
      return;
    }
    if (directThreadHydrationInFlightRef.current === serverThread.id) {
      return;
    }

    let canceled = false;
    directThreadHydrationInFlightRef.current = serverThread.id;
    void (async () => {
      try {
        const readModelThread = await hydrateThreadFromCache(serverThread.id, {
          expectedUpdatedAt: serverThread.updatedAt ?? null,
        });
        if (canceled) {
          return;
        }
        startTransition(() => {
          hydrateThreadFromReadModel(readModelThread);
        });
        directThreadHydrationFailureCountRef.current = 0;
        setDirectThreadHydrationRetryAt(null);
      } catch {
        if (!canceled) {
          const nextFailureCount = directThreadHydrationFailureCountRef.current + 1;
          directThreadHydrationFailureCountRef.current = nextFailureCount;
          setDirectThreadHydrationRetryAt(
            Date.now() + resolveThreadHydrationRetryDelayMs(nextFailureCount),
          );
        }
      } finally {
        if (directThreadHydrationInFlightRef.current === serverThread.id) {
          directThreadHydrationInFlightRef.current = null;
        }
      }
    })();

    return () => {
      canceled = true;
    };
  }, [directThreadHydrationRetryAt, hydrateThreadFromReadModel, serverThread]);

  useEffect(() => {
    if (
      !recentThreadHistoryKeepId ||
      recentThreadHistoryKeepId === activeThreadId ||
      recentThreadHistoryThread === undefined ||
      recentThreadHistoryThread.historyLoaded !== false
    ) {
      return;
    }

    const cachedHydratedThread =
      recentThreadHistoryThread.updatedAt === undefined
        ? null
        : readCachedHydratedThread(recentThreadHistoryKeepId, recentThreadHistoryThread.updatedAt);
    if (cachedHydratedThread) {
      startTransition(() => {
        hydrateThreadFromReadModel(cachedHydratedThread);
      });
      return;
    }

    if (recentThreadHistoryHydrationInFlightRef.current === recentThreadHistoryKeepId) {
      return;
    }

    recentThreadHistoryHydrationInFlightRef.current = recentThreadHistoryKeepId;
    let canceled = false;
    void (async () => {
      try {
        const readModelThread = await hydrateThreadFromCache(recentThreadHistoryKeepId, {
          expectedUpdatedAt: recentThreadHistoryThread.updatedAt ?? null,
        });
        if (canceled) {
          return;
        }
        startTransition(() => {
          hydrateThreadFromReadModel(readModelThread);
        });
      } catch (error) {
        if (!canceled) {
          console.error("Failed to hydrate recent thread history", error);
        }
      } finally {
        if (
          !canceled &&
          recentThreadHistoryHydrationInFlightRef.current === recentThreadHistoryKeepId
        ) {
          recentThreadHistoryHydrationInFlightRef.current = null;
        }
      }
    })();

    return () => {
      canceled = true;
      if (recentThreadHistoryHydrationInFlightRef.current === recentThreadHistoryKeepId) {
        recentThreadHistoryHydrationInFlightRef.current = null;
      }
    };
  }, [
    activeThreadId,
    hydrateThreadFromReadModel,
    recentThreadHistoryKeepId,
    recentThreadHistoryThread,
  ]);

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
  const threadPlanCatalog = useThreadPlanCatalog(
    useMemo(() => {
      const threadIds: ThreadId[] = [];
      if (activeThread?.id) {
        threadIds.push(activeThread.id);
      }
      const sourceThreadId = sourceProposedPlanThreadId;
      if (sourceThreadId && sourceThreadId !== activeThread?.id) {
        threadIds.push(sourceThreadId);
      }
      return threadIds;
    }, [activeThread?.id, sourceProposedPlanThreadId]),
  );
  useEffect(() => {
    if (
      sourceProposedPlanThreadId === null ||
      sourceProposedPlanThreadId === activeThread?.id ||
      sourcePlanThread === undefined ||
      sourcePlanThread.historyLoaded !== false
    ) {
      return;
    }

    const cachedHydratedThread =
      sourcePlanThread.updatedAt === undefined
        ? null
        : readCachedHydratedThread(sourceProposedPlanThreadId, sourcePlanThread.updatedAt);
    if (cachedHydratedThread) {
      startTransition(() => {
        hydrateThreadFromReadModel(cachedHydratedThread);
      });
      return;
    }

    if (sourcePlanHydrationInFlightRef.current === sourceProposedPlanThreadId) {
      return;
    }

    sourcePlanHydrationInFlightRef.current = sourceProposedPlanThreadId;
    let canceled = false;
    void (async () => {
      try {
        const readModelThread = await hydrateThreadFromCache(sourceProposedPlanThreadId, {
          expectedUpdatedAt: sourcePlanThread.updatedAt ?? null,
        });
        if (canceled) {
          return;
        }
        startTransition(() => {
          hydrateThreadFromReadModel(readModelThread);
        });
      } catch (error) {
        if (!canceled) {
          console.error("Failed to hydrate source proposed-plan thread", error);
        }
      } finally {
        if (!canceled && sourcePlanHydrationInFlightRef.current === sourceProposedPlanThreadId) {
          sourcePlanHydrationInFlightRef.current = null;
        }
      }
    })();

    return () => {
      canceled = true;
      if (sourcePlanHydrationInFlightRef.current === sourceProposedPlanThreadId) {
        sourcePlanHydrationInFlightRef.current = null;
      }
    };
  }, [activeThread?.id, hydrateThreadFromReadModel, sourcePlanThread, sourceProposedPlanThreadId]);

  useEffect(() => {
    if (!activeThread?.handoff || !isServerThread || handoffHasCycle) {
      return;
    }

    if (handoffSourceThreadIds.length === 0 && handoffMissingThreadId === null) {
      return;
    }

    let canceled = false;
    const pendingThreadIds = new Set(handoffSourceThreadIds);
    if (handoffMissingThreadId) {
      pendingThreadIds.add(handoffMissingThreadId);
    }

    for (const threadIdToHydrate of pendingThreadIds) {
      const thread = getThreadById(useStore.getState().threads, threadIdToHydrate);
      if (thread && thread.historyLoaded !== false) {
        continue;
      }
      if (handoffHydrationInFlightRef.current.has(threadIdToHydrate)) {
        continue;
      }
      const cachedHydratedThread =
        thread?.updatedAt === undefined
          ? null
          : readCachedHydratedThread(threadIdToHydrate, thread.updatedAt);
      if (cachedHydratedThread) {
        startTransition(() => {
          if (!canceled) {
            hydrateThreadFromReadModel(cachedHydratedThread);
          }
        });
        continue;
      }

      handoffHydrationInFlightRef.current.add(threadIdToHydrate);
      void (async () => {
        try {
          const readModelThread = await hydrateThreadFromCache(threadIdToHydrate, {
            expectedUpdatedAt: thread?.updatedAt ?? null,
          });
          if (canceled) {
            return;
          }
          startTransition(() => {
            hydrateThreadFromReadModel(readModelThread);
          });
        } catch (error) {
          if (!canceled) {
            console.error("Failed to hydrate handoff history", error);
          }
        } finally {
          handoffHydrationInFlightRef.current.delete(threadIdToHydrate);
        }
      })();
    }

    return () => {
      canceled = true;
    };
  }, [
    activeThread?.handoff,
    handoffHasCycle,
    handoffMissingThreadId,
    handoffSourceThreadIds,
    hydrateThreadFromReadModel,
    isServerThread,
  ]);
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const liveTurnInProgress = hasLiveTurn(activeLatestTurn, activeThread?.session ?? null);
  const activeProject = useProjectById(activeThread?.projectId);
  const activeProjectId = activeProject?.id ?? null;
  const activeRemoteHost = useMemo(
    () =>
      loadRemoteHostInstances().find(
        (host) => resolveHostConnectionWsUrl(host) === activeServerConnectionUrl,
      ) ?? null,
    [activeServerConnectionUrl],
  );
  useEffect(() => {
    if (!activeThread?.id) {
      return;
    }
    const store = useHostConnectionStore.getState();
    store.upsertThreadOwnership(activeServerConnectionUrl, activeThread.id);
    if (activeProjectId) {
      store.upsertProjectOwnership(activeServerConnectionUrl, activeProjectId);
    }
  }, [activeProjectId, activeServerConnectionUrl, activeThread?.id]);
  const activeEnvironmentIcon =
    activeRemoteHost && (activeRemoteHost.iconGlyph || activeRemoteHost.iconColor)
      ? {
          glyph: activeRemoteHost.iconGlyph ?? "folder",
          color: activeRemoteHost.iconColor ?? "slate",
        }
      : null;
  const terminalState = threadTerminalState;
  const handleActiveProjectChange = useCallback(
    (projectId: ProjectId) => {
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
    },
    [currentRouteDraftThread, currentRouteThread, defaultThreadEnvMode, handleNewThread],
  );
  const queuedComposerMessages =
    serverThread?.queuedComposerMessages ?? EMPTY_QUEUED_COMPOSER_MESSAGES;
  const queuedSteerRequest = serverThread?.queuedSteerRequest ?? null;
  const queuedComposerMessagesRef = useRef(queuedComposerMessages);
  queuedComposerMessagesRef.current = queuedComposerMessages;

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      });
      setComposerHighlightedItemId(null);
    },
    [canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

  const openGitHubIssueDialog = useCallback(
    (options?: {
      initialIssueNumber?: number | null;
      initialSelectedIssueNumbers?: ReadonlyArray<number>;
    }) => {
      setGitHubIssueDialogInitialIssueNumber(options?.initialIssueNumber ?? null);
      setGitHubIssueDialogInitialSelectedIssueNumbers([
        ...(options?.initialSelectedIssueNumbers ?? []),
      ]);
      setGitHubIssueDialogOpen(true);
      setComposerHighlightedItemId(null);
    },
    [],
  );

  const closeGitHubIssueDialog = useCallback(() => {
    setGitHubIssueDialogOpen(false);
    setGitHubIssueDialogInitialIssueNumber(null);
    setGitHubIssueDialogInitialSelectedIssueNumbers([]);
  }, []);

  const onComposerIssueTokenClick = useCallback((issueNumber: number) => {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return;
    }
    setIssuePreviewNumber(issueNumber);
  }, []);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: { branch: string; worktreePath: string | null; envMode: DraftThreadEnvMode }) => {
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
    },
    [
      activeProject,
      clearProjectDraftThreadId,
      getDraftThread,
      getDraftThreadByProjectId,
      isServerThread,
      navigate,
      setDraftThreadContext,
      setProjectDraftThreadId,
      threadId,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: { branch: string; worktreePath: string | null }) => {
      const targetThreadId = await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
      });
      const setupScript =
        input.worktreePath && activeProject ? setupProjectScript(activeProject.scripts) : null;
      if (targetThreadId && input.worktreePath && setupScript) {
        setPendingPullRequestSetupRequest({
          threadId: targetThreadId,
          worktreePath: input.worktreePath,
          scriptId: setupScript.id,
        });
      } else {
        setPendingPullRequestSetupRequest(null);
      }
    },
    [activeProject, openOrReuseProjectDraftThread],
  );

  useEffect(() => {
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
    latestTurnSettled,
    markThreadVisited,
    serverThread?.id,
  ]);

  const hasThreadStarted = threadHasStarted(activeThread);
  const {
    activeProviderStatus,
    composerModelOptions,
    composerProviderState,
    handoffTargetProviders,
    lockedProvider,
    modelOptionsByProvider,
    selectedModel,
    selectedModelForPickerWithCustomFallback,
    selectedModelSelection,
    selectedPromptEffort,
    selectedProvider,
    selectedProviderModels,
  } = useChatViewModelState({
    hasThreadStarted,
    isServerThread,
    modelSettings,
    projectModelSelection: activeProject?.defaultModelSelection,
    prompt,
    providers: providerStatuses,
    selectedProviderByThreadId: composerDraft.activeProvider ?? null,
    sessionProvider: activeThread?.session?.provider ?? null,
    threadId,
    threadModelSelection: activeThread?.modelSelection,
  });
  const activeContextWindow = useMemo(() => {
    if (!hasThreadStarted) {
      return null;
    }
    return deriveLatestContextWindowSnapshot(activeThread?.activities ?? []);
  }, [activeThread?.activities, hasThreadStarted]);
  const phase = derivePhase(activeThread?.session ?? null);
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const activityVisibilitySettings = useMemo(
    () => ({
      enableToolStreaming,
      enableThinkingStreaming,
    }),
    [enableThinkingStreaming, enableToolStreaming],
  );
  const { visibleThreadActivities, workLogEntries, pendingApprovals, pendingUserInputs } = useMemo(
    () => deriveThreadActivityRenderState(threadActivities, activityVisibilitySettings),
    [activityVisibilitySettings, threadActivities],
  );
  const activeWorkTurnId = useMemo(
    () =>
      deriveVisibleWorkTurnId(
        activeLatestTurn,
        activeThread?.session ?? null,
        visibleThreadActivities,
      ),
    [activeLatestTurn, activeThread?.session, visibleThreadActivities],
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const sidebarProposedPlan = useMemo(
    () =>
      findSidebarProposedPlan({
        threads: threadPlanCatalog,
        latestTurn: activeLatestTurn,
        latestTurnSettled,
        threadId: activeThread?.id ?? null,
      }),
    [activeLatestTurn, activeThread?.id, latestTurnSettled, threadPlanCatalog],
  );
  const activePlan = useMemo(
    () => deriveActivePlanState(threadActivities, activeWorkTurnId),
    [activeWorkTurnId, threadActivities],
  );
  const activePlanProgress = useMemo(() => summarizeActivePlan(activePlan), [activePlan]);
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
  const isComposerApprovalState = activePendingApproval !== null;
  const hasComposerHeader =
    isComposerApprovalState ||
    pendingUserInputs.length > 0 ||
    (showPlanFollowUpPrompt && activeProposedPlan !== null);
  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  const composerFooterActionLayoutKey = useMemo(() => {
    if (activePendingProgress) {
      return `pending:${activePendingProgress.questionIndex}:${activePendingProgress.isLastQuestion}:${activePendingIsResponding}`;
    }
    if (liveTurnInProgress) {
      return "running";
    }
    if (showPlanFollowUpPrompt) {
      return prompt.trim().length > 0 ? "plan:refine" : "plan:implement";
    }
    return `idle:${composerSendState.hasSendableContent}:${isSendBusy}:${isConnecting}:${isPreparingWorktree}`;
  }, [
    activePendingIsResponding,
    activePendingProgress,
    composerSendState.hasSendableContent,
    isConnecting,
    isPreparingWorktree,
    isSendBusy,
    liveTurnInProgress,
    prompt,
    showPlanFollowUpPrompt,
  ]);
  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);
  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      lastSyncedPendingInputRef.current = null;
      return;
    }
    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const nextCursor = collapseExpandedComposerCursor(nextCustomAnswer, nextCustomAnswer.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(
      detectComposerTriggerWithDismissal(
        nextCustomAnswer,
        expandCollapsedComposerCursor(nextCustomAnswer, nextCursor),
      ),
    );
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.customAnswer,
    activePendingUserInput?.requestId,
    activePendingProgress?.activeQuestion?.id,
    detectComposerTriggerWithDismissal,
  ]);
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
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    for (const previewUrl of previousPreviewUrls) {
      if (!previewUrls.includes(previewUrl)) {
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
  const serverMessages = activeThread?.messages;
  const activeThreadMessages = useMemo(() => {
    const messages = serverMessages ?? [];
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
  }, [serverMessages, attachmentPreviewHandoffByMessageId, optimisticUserMessages]);
  const handoffTimeline = useMemo(() => {
    if (!activeThread) {
      return {
        messages: activeThreadMessages,
        proposedPlans: [],
        workEntries: [],
        historicalMessageIds: new Set<MessageId>(),
      };
    }
    if (!isServerThread) {
      return {
        messages: activeThreadMessages,
        proposedPlans: activeThread.proposedPlans ?? [],
        workEntries: workLogEntries,
        historicalMessageIds: new Set<MessageId>(),
      };
    }
    return buildHandoffTimeline({
      activeThread,
      activeThreadMessages,
      activeThreadWorkEntries: workLogEntries,
      handoffLineage,
      activityVisibility: activityVisibilitySettings,
    });
  }, [
    activeThread,
    activeThreadMessages,
    activityVisibilitySettings,
    handoffLineage,
    isServerThread,
    workLogEntries,
  ]);
  const timelineMessages = handoffTimeline.messages;
  const timelineProposedPlans = handoffTimeline.proposedPlans;
  const timelineWorkEntries = handoffTimeline.workEntries;
  const activeThreadMessageIds = useMemo(
    () => new Set(activeThreadMessages.map((message) => message.id)),
    [activeThreadMessages],
  );
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const { timelineEntries, turnDiffSummaryByAssistantMessageId } = useMemo(
    () =>
      deriveThreadTimelineRenderState({
        messages: timelineMessages,
        proposedPlans: timelineProposedPlans,
        workLogEntries: timelineWorkEntries,
        turnDiffSummaries,
      }),
    [timelineMessages, timelineProposedPlans, timelineWorkEntries, turnDiffSummaries],
  );
  const revertTurnCountByUserMessageId = useMemo(() => {
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
  }, [
    activeThreadMessageIds,
    inferredCheckpointTurnCountByTurnId,
    timelineEntries,
    turnDiffSummaryByAssistantMessageId,
  ]);

  const completionSummary = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurn?.startedAt) return null;
    if (!activeLatestTurn.completedAt) return null;

    const elapsed = formatElapsed(activeLatestTurn.startedAt, activeLatestTurn.completedAt);
    return elapsed ? `Worked for ${elapsed}` : null;
  }, [activeLatestTurn?.completedAt, activeLatestTurn?.startedAt, latestTurnSettled]);
  const completionDividerBeforeEntryId = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!completionSummary) return null;
    return deriveCompletionDividerBeforeEntryId(timelineEntries, activeLatestTurn);
  }, [activeLatestTurn, completionSummary, latestTurnSettled, timelineEntries]);
  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.cwd },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  const codingGitCwd = gitCwd;
  const workspaceStatusPollingMs = latestTurnSettled ? 10_000 : 5_000;
  const workspaceStatusQuery = useQuery({
    ...gitStatusQueryOptions(codingGitCwd),
    enabled: codingGitCwd !== null,
    staleTime: workspaceStatusPollingMs,
    refetchInterval: workspaceStatusPollingMs,
    refetchIntervalInBackground: false,
  });
  const workspaceChangeStat = useMemo(() => {
    const workingTree = workspaceStatusQuery.data?.workingTree;
    if (!workingTree || (workingTree.insertions === 0 && workingTree.deletions === 0)) {
      return null;
    }
    return {
      additions: workingTree.insertions,
      deletions: workingTree.deletions,
    };
  }, [workspaceStatusQuery.data?.workingTree]);
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const issueTriggerQuery = composerTrigger?.kind === "issue" ? composerTrigger.query : "";
  const isPathTrigger = composerTriggerKind === "path";
  const isIssueTrigger = composerTriggerKind === "issue";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    pathTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectivePathQuery = pathTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const branchesQuery = useQuery(gitBranchesQueryOptions(codingGitCwd));
  // Default true while loading to avoid toolbar flicker.
  const rawIsGitRepo = branchesQuery.data?.isRepo ?? true;
  const isGitRepo = rawIsGitRepo;
  const activeThreadBranchName =
    activeThread?.branch ??
    branchesQuery.data?.branches.find((branch) => branch.current)?.name ??
    null;
  const keybindings = useServerKeybindings();
  const availableEditors = useServerAvailableEditors();
  const handoffDisabledReason = useMemo(() => {
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
  }, [activeThread, handoffInFlight, handoffTargetProviders.length, isServerThread, isWorking]);
  const handoffDisabled = handoffDisabledReason !== null;
  const searchableModelOptions = useMemo(
    () =>
      AVAILABLE_PROVIDER_OPTIONS.filter(
        (option) => lockedProvider === null || option.value === lockedProvider,
      ).flatMap((option) =>
        modelOptionsByProvider[option.value].map(({ slug, name }) => ({
          provider: option.value,
          providerLabel: option.label,
          slug,
          name,
          searchSlug: slug.toLowerCase(),
          searchName: name.toLowerCase(),
          searchProvider: option.label.toLowerCase(),
        })),
      ),
    [lockedProvider, modelOptionsByProvider],
  );
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: gitCwd,
      query: effectivePathQuery,
      enabled: isPathTrigger,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
  const canLookupIssueTags = isGitRepo;
  const issueTriggerLookupQuery = useQuery(
    gitGitHubIssuesQueryOptions({
      cwd: codingGitCwd,
      limit: 120,
      state: "all",
      enabled: isIssueTrigger && canLookupIssueTags,
    }),
  );
  const issueTriggerMatches = useMemo(() => {
    const issues = issueTriggerLookupQuery.data?.issues ?? EMPTY_GITHUB_ISSUES;
    if (issueTriggerQuery.length === 0) {
      return issues;
    }
    return issues.filter((issue) => String(issue.number).startsWith(issueTriggerQuery));
  }, [issueTriggerLookupQuery.data?.issues, issueTriggerQuery]);
  const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      return workspaceEntries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.parentPath ?? "",
      }));
    }

    if (composerTrigger.kind === "issue") {
      return issueTriggerMatches.map((issue) => ({
        id: `issue:${issue.number}`,
        type: "issue",
        issueNumber: issue.number,
        label: `#${issue.number} ${issue.title}`,
        description: issue.state === "open" ? "Open issue" : "Closed issue",
      }));
    }

    if (composerTrigger.kind === "slash-command") {
      const slashCommandItems = [
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch response model for this thread",
        },
        {
          id: "slash:plan",
          type: "slash-command",
          command: "plan",
          label: "/plan",
          description: "Switch this thread into plan mode",
        },
        {
          id: "slash:default",
          type: "slash-command",
          command: "default",
          label: "/default",
          description: "Switch this thread back to normal chat mode",
        },
        {
          id: "slash:issues",
          type: "slash-command",
          command: "issues",
          label: "/issues",
          description: "Attach GitHub issue context to this message",
        },
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const query = composerTrigger.query.trim().toLowerCase();
      if (!query) {
        return [...slashCommandItems];
      }
      return slashCommandItems.filter(
        (item) => item.command.includes(query) || item.label.slice(1).includes(query),
      );
    }

    return searchableModelOptions
      .filter(({ searchSlug, searchName, searchProvider }) => {
        const query = composerTrigger.query.trim().toLowerCase();
        if (!query) return true;
        return (
          searchSlug.includes(query) || searchName.includes(query) || searchProvider.includes(query)
        );
      })
      .map(({ provider, providerLabel, slug, name }) => ({
        id: `model:${provider}:${slug}`,
        type: "model",
        provider,
        model: slug,
        label: name,
        description: `${providerLabel} · ${slug}`,
      }));
  }, [composerTrigger, issueTriggerMatches, searchableModelOptions, workspaceEntries]);
  const composerMenuOpen = Boolean(composerTrigger);
  const activeComposerMenuItem = useMemo(
    () =>
      composerMenuItems.find((item) => item.id === composerHighlightedItemId) ??
      composerMenuItems[0] ??
      null,
    [composerHighlightedItemId, composerMenuItems],
  );
  composerMenuOpenRef.current = composerMenuOpen;
  composerMenuItemsRef.current = composerMenuItems;
  activeComposerMenuItemRef.current = activeComposerMenuItem;
  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(nonPersistedComposerImageIds),
    [nonPersistedComposerImageIds],
  );
  const activeProjectCwd = activeProject?.cwd ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const threadTerminalRuntimeEnv = useMemo(() => {
    if (!activeProjectCwd) return {};
    return projectScriptRuntimeEnv({
      project: {
        cwd: activeProjectCwd,
      },
      worktreePath: activeThreadWorktreePath,
    });
  }, [activeProjectCwd, activeThreadWorktreePath]);
  const terminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: true,
        terminalOpen: Boolean(terminalState.terminalOpen),
      },
    }),
    [terminalState.terminalOpen],
  );
  const nonTerminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: false,
        terminalOpen: Boolean(terminalState.terminalOpen),
      },
    }),
    [terminalState.terminalOpen],
  );
  const terminalToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.toggle"),
    [keybindings],
  );
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const rightSidePanelToggleShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "rightPanel.toggle", nonTerminalShortcutLabelOptions) ??
      defaultShortcutLabelForCommand("rightPanel.toggle"),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const reviewPanelShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(
        keybindings,
        "rightPanel.review.open",
        nonTerminalShortcutLabelOptions,
      ) ?? defaultShortcutLabelForCommand("rightPanel.review.open"),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const rightPanelBrowserShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(
        keybindings,
        "rightPanel.browser.open",
        nonTerminalShortcutLabelOptions,
      ) ?? defaultShortcutLabelForCommand("rightPanel.browser.open"),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const rightPanelEditorShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(
        keybindings,
        "rightPanel.editor.open",
        nonTerminalShortcutLabelOptions,
      ) ?? defaultShortcutLabelForCommand("rightPanel.editor.open"),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const browserActionShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: false,
        terminalOpen: Boolean(terminalState.terminalOpen),
        browserOpen: true,
      },
    }),
    [terminalState.terminalOpen],
  );
  const browserBackShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "browser.back", browserActionShortcutLabelOptions),
    [browserActionShortcutLabelOptions, keybindings],
  );
  const browserForwardShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "browser.forward", browserActionShortcutLabelOptions),
    [browserActionShortcutLabelOptions, keybindings],
  );
  const browserReloadShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "browser.reload", browserActionShortcutLabelOptions),
    [browserActionShortcutLabelOptions, keybindings],
  );
  const browserDevToolsShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "browser.devtools", browserActionShortcutLabelOptions),
    [browserActionShortcutLabelOptions, keybindings],
  );
  const browserNewTabShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "browser.newTab", nonTerminalShortcutLabelOptions) ??
      defaultShortcutLabelForCommand("browser.newTab") ??
      rightPanelBrowserShortcutLabel,
    [rightPanelBrowserShortcutLabel, keybindings, nonTerminalShortcutLabelOptions],
  );
  const browserDesignerCursorShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(
        keybindings,
        "browser.designer.cursor",
        browserActionShortcutLabelOptions,
      ),
    [browserActionShortcutLabelOptions, keybindings],
  );
  const browserDesignerAreaCommentShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(
        keybindings,
        "browser.designer.areaComment",
        browserActionShortcutLabelOptions,
      ),
    [browserActionShortcutLabelOptions, keybindings],
  );
  const browserDesignerDrawCommentShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(
        keybindings,
        "browser.designer.drawComment",
        browserActionShortcutLabelOptions,
      ),
    [browserActionShortcutLabelOptions, keybindings],
  );
  const browserDesignerElementCommentShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(
        keybindings,
        "browser.designer.elementComment",
        browserActionShortcutLabelOptions,
      ),
    [browserActionShortcutLabelOptions, keybindings],
  );
  const [browserMode, setBrowserMode] = useLocalStorage(
    browserPanelModeStorageKey,
    "closed" as const,
    BrowserPanelModeSchema,
  );
  const [, setBrowserDevToolsOpen] = useState(false);
  const [storedBrowserSplitWidth, setStoredBrowserSplitWidth] = useLocalStorage(
    BROWSER_SPLIT_WIDTH_STORAGE_KEY,
    DEFAULT_BROWSER_SPLIT_WIDTH,
    Schema.Number,
  );
  const [browserSplitWidth, setBrowserSplitWidth] = useState(() =>
    clampBrowserSplitWidth(storedBrowserSplitWidth, 0),
  );
  const [storedWorkspaceEditorSplitWidth, setStoredWorkspaceEditorSplitWidth] = useLocalStorage(
    WORKSPACE_EDITOR_SPLIT_WIDTH_STORAGE_KEY,
    DEFAULT_WORKSPACE_EDITOR_SPLIT_WIDTH,
    Schema.Number,
  );
  const [storedRightSidePanelWidth, setStoredRightSidePanelWidth] = useLocalStorage(
    rightSidePanelWidthStorageKey,
    DEFAULT_RIGHT_SIDE_PANEL_WIDTH,
    Schema.Number,
  );
  const [, setWorkspaceModeByThreadId] = useLocalStorage(
    THREAD_WORKSPACE_MODE_BY_THREAD_ID_STORAGE_KEY,
    {},
    ThreadWorkspaceModeByThreadIdSchema,
  );
  const [workspaceLayoutByThreadId, setWorkspaceLayoutByThreadId] = useLocalStorage(
    THREAD_WORKSPACE_LAYOUT_BY_THREAD_ID_STORAGE_KEY,
    {},
    ThreadWorkspaceLayoutByThreadIdSchema,
  );
  const [workspaceEditorSplitWidth, setWorkspaceEditorSplitWidth] = useState(() =>
    clampWorkspaceEditorSplitWidth(storedWorkspaceEditorSplitWidth, 0),
  );
  const [rightSidePanelWidth, setRightSidePanelWidth] = useState(() =>
    clampRightSidePanelWidth(storedRightSidePanelWidth, 0),
  );
  const browserControllerRef = useRef<InAppBrowserController | null>(null);
  const browserControllerByThreadRef = useRef(new Map<ThreadId, InAppBrowserController>());
  const browserRuntimeStateByThreadRef = useRef(new Map<ThreadId, { devToolsOpen: boolean }>());
  const [browserSessionByThreadId, setBrowserSessionByThreadId] = useState<
    Record<string, BrowserSessionStorage>
  >({});
  const browserControllerChangeHandlerByThreadRef = useRef(
    new Map<ThreadId, (controller: InAppBrowserController | null) => void>(),
  );
  const browserRuntimeStateChangeHandlerByThreadRef = useRef(
    new Map<ThreadId, (state: ActiveBrowserRuntimeState) => void>(),
  );
  const activeBrowserThreadIdRef = useRef<ThreadId | null>(activeThreadId);
  const pendingBrowserOpenUrlRef = useRef<string | null>(null);
  const chatViewportRef = useRef<HTMLDivElement | null>(null);
  const workspaceViewportRef = useRef<HTMLDivElement | null>(null);
  const browserSplitWidthRef = useRef(browserSplitWidth);
  const browserSplitResizePointerIdRef = useRef<number | null>(null);
  const browserSplitResizeStateRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);
  const didResizeBrowserSplitDuringDragRef = useRef(false);
  const lastSyncedBrowserSplitWidthRef = useRef(browserSplitWidth);
  const [mountedBrowserThreadIds, setMountedBrowserThreadIds] = useState<readonly ThreadId[]>([]);
  const previousMountedBrowserThreadIdsRef = useRef<readonly ThreadId[]>([]);
  const workspaceEditorSplitWidthRef = useRef(workspaceEditorSplitWidth);
  const workspaceEditorSplitResizePointerIdRef = useRef<number | null>(null);
  const workspaceEditorSplitResizeStateRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);
  const didResizeWorkspaceEditorSplitDuringDragRef = useRef(false);
  const lastSyncedWorkspaceEditorSplitWidthRef = useRef(workspaceEditorSplitWidth);
  const rightSidePanelWidthRef = useRef(rightSidePanelWidth);
  const rightSidePanelResizePointerIdRef = useRef<number | null>(null);
  const rightSidePanelResizeStateRef = useRef<{
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
    rightSidePanelMode === "editor" || workspaceMode === "editor" || workspaceMode === "split";
  const headerWorkspaceMode: ThreadWorkspaceMode = editorHostedInRightPanel
    ? "split"
    : workspaceMode;
  const browserOpen = browserMode !== "closed";
  useEffect(() => {
    if (rightSidePanelMode !== "diff" || rightSidePanelDiffOpen) {
      return;
    }
    setRightSidePanelDiffOpenState(true);
    setRightSidePanelReviewOpen(true);
    setLocalDiffState((previous) => ({ ...previous, open: true }));
  }, [
    rightSidePanelDiffOpen,
    rightSidePanelMode,
    setLocalDiffState,
    setRightSidePanelDiffOpenState,
    setRightSidePanelReviewOpen,
  ]);
  useEffect(() => {
    if (diffOpen) {
      setRightSidePanelReviewOpen(true);
    }
  }, [diffOpen, setRightSidePanelReviewOpen]);
  useEffect(() => {
    if (!rightSidePanelMode || rightSidePanelMode === "diff") {
      return;
    }
    if (rightSidePanelLastNonDiffMode === rightSidePanelMode) {
      return;
    }
    setRightSidePanelLastNonDiffMode(rightSidePanelMode);
  }, [rightSidePanelLastNonDiffMode, rightSidePanelMode, setRightSidePanelLastNonDiffMode]);
  useEffect(() => {
    if (browserOpen && isElectron && !diffOpen && rightSidePanelMode === null) {
      setRightSidePanelMode("browser");
    }
  }, [browserOpen, diffOpen, rightSidePanelMode, setRightSidePanelMode]);
  useEffect(() => {
    if (!splitPane && (routeWorkspaceMode === "editor" || routeWorkspaceMode === "split")) {
      setRightSidePanelEditorOpen(true);
      setRightSidePanelMode("editor");
      setRightSidePanelVisible(true);
    }
  }, [
    routeWorkspaceMode,
    setRightSidePanelEditorOpen,
    setRightSidePanelMode,
    setRightSidePanelVisible,
    splitPane,
  ]);
  useEffect(() => {
    activeBrowserThreadIdRef.current = activeThreadId;
    browserControllerRef.current = activeThreadId
      ? (browserControllerByThreadRef.current.get(activeThreadId) ?? null)
      : null;
    setBrowserDevToolsOpen(
      activeThreadId
        ? (browserRuntimeStateByThreadRef.current.get(activeThreadId)?.devToolsOpen ?? false)
        : false,
    );
  }, [activeThreadId]);
  useEffect(() => {
    if (!isElectron || !activeThreadId) {
      browserControllerByThreadRef.current.clear();
      browserRuntimeStateByThreadRef.current.clear();
      browserControllerChangeHandlerByThreadRef.current.clear();
      browserRuntimeStateChangeHandlerByThreadRef.current.clear();
      browserControllerRef.current = null;
      setMountedBrowserThreadIds([]);
      return;
    }
    if (!browserOpen) {
      setMountedBrowserThreadIds([]);
      return;
    }
    setMountedBrowserThreadIds((current) =>
      touchRecentBrowserInstanceId(current, activeThreadId, MAX_CACHED_BROWSER_INSTANCES),
    );
  }, [activeThreadId, browserOpen]);
  useEffect(() => {
    if (!isElectron || !activeThreadId || !browserOpen) {
      return;
    }

    const trimBackgroundBrowserCache = () => {
      if (document.visibilityState !== "hidden") {
        return;
      }
      setMountedBrowserThreadIds((current) =>
        current.length <= 1 || current[0] === activeThreadId
          ? current.slice(0, 1)
          : [activeThreadId],
      );
    };

    window.addEventListener("blur", trimBackgroundBrowserCache);
    document.addEventListener("visibilitychange", trimBackgroundBrowserCache);

    return () => {
      window.removeEventListener("blur", trimBackgroundBrowserCache);
      document.removeEventListener("visibilitychange", trimBackgroundBrowserCache);
    };
  }, [activeThreadId, browserOpen]);
  useEffect(() => {
    const previousThreadIds = previousMountedBrowserThreadIdsRef.current;
    previousMountedBrowserThreadIdsRef.current = mountedBrowserThreadIds;

    for (const previousThreadId of previousThreadIds) {
      if (mountedBrowserThreadIds.includes(previousThreadId)) {
        continue;
      }
      browserControllerByThreadRef.current.delete(previousThreadId);
      browserRuntimeStateByThreadRef.current.delete(previousThreadId);
      browserControllerChangeHandlerByThreadRef.current.delete(previousThreadId);
      browserRuntimeStateChangeHandlerByThreadRef.current.delete(previousThreadId);
      if (activeBrowserThreadIdRef.current === previousThreadId) {
        browserControllerRef.current = null;
        setBrowserDevToolsOpen(false);
      }
    }
  }, [mountedBrowserThreadIds]);
  useEffect(() => {
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
        setRightSidePanelMode(null);
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
      if (splitPane) {
        return;
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
  }, []);
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
        setRightSidePanelMode(nextDiffOpen ? "diff" : "summary");
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
    if (diffOpen) {
      setRightSidePanelDiffOpenState(true);
      setRightSidePanelReviewOpen(true);
      setRightSidePanelMode("diff");
      setRightSidePanelVisible(true);
      return;
    }
    setRightSidePanelDiffOpen(true);
  }, [
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
  const activeTerminalGroup =
    terminalState.terminalGroups.find(
      (group) => group.id === terminalState.activeTerminalGroupId,
    ) ??
    terminalState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
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
    },
    [setStoreThreadError],
  );
  const dismissThreadError = useCallback(
    (targetThreadId: ThreadId | null) => {
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
    },
    [dismissStoreThreadError],
  );

  const focusComposer = useCallback(() => {
    return composerEditorRef.current?.focusAtEnd() ?? false;
  }, []);
  const scheduleComposerFocus = useCallback(
    (attempts = 4) => {
      let frameId: number | null = null;
      const requestFocus = (remainingAttempts: number) => {
        frameId = window.requestAnimationFrame(() => {
          frameId = null;
          if (focusComposer() || remainingAttempts <= 1) {
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
    },
    [focusComposer],
  );
  const toQueuedComposerCommandMessage = useCallback((message: QueuedComposerMessage) => {
    return {
      id: message.id,
      prompt: message.prompt,
      images: message.images.map((image) => ({
        type: "image" as const,
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: image.dataUrl,
      })),
      terminalContexts: message.terminalContexts.map((context) => ({ ...context })),
      modelSelection: message.modelSelection,
      runtimeMode: message.runtimeMode,
      interactionMode: message.interactionMode,
    };
  }, []);
  const dispatchQueuedComposerCommand = useCallback(
    async (
      targetThreadId: ThreadId,
      buildCommand: (input: {
        commandId: CommandId;
        threadId: ThreadId;
      }) => ClientOrchestrationCommand,
    ) => {
      const api = readNativeApi();
      if (!api) {
        return false;
      }
      try {
        await api.orchestration.dispatchCommand(
          buildCommand({
            commandId: newCommandId(),
            threadId: targetThreadId,
          }),
        );
        return true;
      } catch (error) {
        setThreadError(
          targetThreadId,
          error instanceof Error ? error.message : "Failed to update queued messages.",
        );
        return false;
      }
    },
    [setThreadError],
  );
  const appendQueuedComposerMessage = useCallback(
    async (
      targetThreadId: ThreadId,
      message: QueuedComposerMessage,
      options?: { steerRequest?: Thread["queuedSteerRequest"] },
    ) =>
      await dispatchQueuedComposerCommand(targetThreadId, ({ commandId, threadId }) => ({
        type: "thread.queue.append",
        commandId,
        threadId,
        message: toQueuedComposerCommandMessage(message),
        position: options?.steerRequest ? "front" : "back",
        ...(options?.steerRequest ? { steerRequest: options.steerRequest } : {}),
      })),
    [dispatchQueuedComposerCommand, toQueuedComposerCommandMessage],
  );
  const deleteQueuedComposerMessage = useCallback(
    async (targetThreadId: ThreadId, messageId: MessageId) =>
      await dispatchQueuedComposerCommand(targetThreadId, ({ commandId, threadId }) => ({
        type: "thread.queue.delete",
        commandId,
        threadId,
        messageId,
      })),
    [dispatchQueuedComposerCommand],
  );
  const clearQueuedComposerState = useCallback(
    async (targetThreadId: ThreadId) =>
      await dispatchQueuedComposerCommand(targetThreadId, ({ commandId, threadId }) => ({
        type: "thread.queue.clear",
        commandId,
        threadId,
      })),
    [dispatchQueuedComposerCommand],
  );
  const steerQueuedComposerMessage = useCallback(
    async (
      targetThreadId: ThreadId,
      messageId: MessageId,
      options: { baselineWorkLogEntryCount: number; interruptRequested?: boolean },
    ) =>
      await dispatchQueuedComposerCommand(targetThreadId, ({ commandId, threadId }) => ({
        type: "thread.queue.steer",
        commandId,
        threadId,
        messageId,
        baselineWorkLogEntryCount: options.baselineWorkLogEntryCount,
        interruptRequested: options.interruptRequested ?? false,
      })),
    [dispatchQueuedComposerCommand],
  );
  const ensureQueuedComposerThread = useCallback(
    async (options: {
      titleSeed: string;
      modelSelection: ModelSelection;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }): Promise<ThreadId | null> => {
      if (serverThread) {
        return serverThread.id;
      }
      const api = readNativeApi();
      const projectId = activeProject?.id ?? defaultProjectId;
      if (!api || !projectId) {
        return null;
      }
      const targetThreadId = activeThread?.id ?? threadId;
      const normalizedTitleSeed = options.titleSeed.trim().replace(/\s+/gu, " ");
      const title = truncate(normalizedTitleSeed.length > 0 ? normalizedTitleSeed : "New thread");
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId: targetThreadId,
          projectId,
          title,
          modelSelection: options.modelSelection,
          runtimeMode: options.runtimeMode,
          interactionMode: options.interactionMode,
          branch: activeThread?.branch ?? null,
          worktreePath: activeThread?.worktreePath ?? null,
          createdAt: activeThread?.createdAt ?? new Date().toISOString(),
        });
      } catch (error) {
        reportBackgroundError(
          "Failed to create a thread before queueing a composer message.",
          error,
        );
      }
      return targetThreadId;
    },
    [activeProject?.id, activeThread, defaultProjectId, serverThread, threadId],
  );
  const buildQueuedComposerImages = useCallback(
    async (
      images: ReadonlyArray<ComposerImageAttachment>,
    ): Promise<QueuedComposerImageAttachment[]> => {
      const persistedAttachmentById = new Map(
        persistedComposerAttachments.map((attachment) => [attachment.id, attachment] as const),
      );
      return await Promise.all(
        images.map(async (image) => {
          const persistedAttachment = persistedAttachmentById.get(image.id);
          const dataUrl = persistedAttachment?.dataUrl ?? (await readFileAsDataUrl(image.file));
          return {
            type: "image" as const,
            id: image.id,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl,
            previewUrl: image.previewUrl || dataUrl,
            file: image.file,
          };
        }),
      );
    },
    [persistedComposerAttachments],
  );
  const removeQueuedComposerMessage = useCallback(
    async (messageId: MessageId) => {
      if (!serverThread) {
        return;
      }
      const removedMessage =
        queuedComposerMessages.find((message) => message.id === messageId) ?? null;
      if (!removedMessage) {
        return;
      }
      if (!(await deleteQueuedComposerMessage(serverThread.id, messageId))) {
        return;
      }
      revokeComposerImagePreviewUrls(removedMessage.images);
    },
    [deleteQueuedComposerMessage, queuedComposerMessages, serverThread],
  );
  const clearQueuedComposerMessages = useCallback(async () => {
    if (!serverThread || queuedComposerMessages.length === 0) {
      return;
    }
    if (!(await clearQueuedComposerState(serverThread.id))) {
      return;
    }
    for (const queuedMessage of queuedComposerMessages) {
      revokeComposerImagePreviewUrls(queuedMessage.images);
    }
  }, [clearQueuedComposerState, queuedComposerMessages, serverThread]);
  const restoreQueuedComposerMessageToDraft = useCallback(
    (message: QueuedComposerMessage, restoredImages: ReadonlyArray<ComposerImageAttachment>) => {
      promptRef.current = message.prompt;
      setPrompt(message.prompt);
      addComposerImagesToDraft([...restoredImages]);
      setComposerDraftTerminalContexts(
        threadId,
        message.terminalContexts.map((context) => ({ ...context, threadId })),
      );
      setComposerDraftModelSelection(threadId, message.modelSelection);
      setComposerDraftRuntimeMode(threadId, message.runtimeMode);
      setComposerDraftInteractionMode(threadId, message.interactionMode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, {
          runtimeMode: message.runtimeMode,
          interactionMode: message.interactionMode,
        });
      }
      const nextCursor = collapseExpandedComposerCursor(message.prompt, message.prompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTriggerWithDismissal(message.prompt, message.prompt.length));
      setComposerHighlightedItemId(null);
      scheduleComposerFocus();
    },
    [
      addComposerImagesToDraft,
      detectComposerTriggerWithDismissal,
      isLocalDraftThread,
      scheduleComposerFocus,
      setComposerDraftInteractionMode,
      setComposerDraftModelSelection,
      setComposerDraftRuntimeMode,
      setComposerDraftTerminalContexts,
      setDraftThreadContext,
      setPrompt,
      threadId,
    ],
  );
  const onEditQueuedComposerMessage = useCallback(
    async (messageId: MessageId) => {
      const nextMessage = queuedComposerMessagesRef.current.find(
        (message) => message.id === messageId,
      );
      if (!nextMessage) {
        return;
      }
      const messageDraft = deriveQueuedComposerMessageDraftForEditing(nextMessage);
      let restoredImages: ComposerImageAttachment[] = [];
      if (messageDraft.includeImages) {
        try {
          restoredImages = await Promise.all(
            nextMessage.images.map((image) => queuedComposerImageToDraftAttachment(image)),
          );
        } catch (error) {
          setThreadError(
            threadId,
            error instanceof Error ? error.message : "Failed to restore queued images.",
          );
          return;
        }
      }
      if (!serverThread || !(await deleteQueuedComposerMessage(serverThread.id, messageId))) {
        return;
      }
      queuedDesignMessageEditRef.current = messageDraft.includeImages ? null : nextMessage;
      restoreQueuedComposerMessageToDraft(
        {
          ...nextMessage,
          prompt: messageDraft.prompt,
          images: messageDraft.includeImages ? nextMessage.images : [],
          terminalContexts: messageDraft.includeTerminalContexts
            ? nextMessage.terminalContexts
            : [],
        },
        restoredImages,
      );
    },
    [
      serverThread,
      deleteQueuedComposerMessage,
      setThreadError,
      restoreQueuedComposerMessageToDraft,
      threadId,
    ],
  );
  const queueCurrentComposerMessage = useCallback(
    async (mode: "queue" | "steer" = "queue") => {
      const hiddenDesignMessage = queuedDesignMessageEditRef.current;
      const { sendableTerminalContexts, expiredTerminalContextCount, hasSendableContent } =
        deriveComposerSendState({
          prompt: promptRef.current,
          imageCount: composerImages.length,
          terminalContexts: composerTerminalContexts,
        });
      if (!hasSendableContent) {
        if (expiredTerminalContextCount > 0) {
          const toastCopy = buildExpiredTerminalContextToastCopy(
            expiredTerminalContextCount,
            "empty",
          );
          toastManager.add({
            type: "warning",
            title: toastCopy.title,
            description: toastCopy.description,
          });
        }
        return false;
      }

      let queuedImages: QueuedComposerImageAttachment[];
      try {
        queuedImages = await buildQueuedComposerImages(composerImages);
      } catch (error) {
        setThreadError(
          threadId,
          error instanceof Error ? error.message : "Failed to queue message attachments.",
        );
        return false;
      }
      const promptForQueue =
        hiddenDesignMessage === null
          ? promptRef.current
          : appendHiddenBrowserDesignContextFromOriginalPrompt(
              promptRef.current,
              hiddenDesignMessage.prompt,
            );
      const mergedQueuedImages =
        hiddenDesignMessage === null
          ? queuedImages
          : [...hiddenDesignMessage.images, ...queuedImages].filter(
              (image, index, allImages) =>
                allImages.findIndex((candidate) => candidate.id === image.id) === index,
            );
      const queuedTerminalContexts = sendableTerminalContexts.map((context) => ({
        id: context.id,
        createdAt: context.createdAt,
        terminalId: context.terminalId,
        terminalLabel: context.terminalLabel,
        lineStart: context.lineStart,
        lineEnd: context.lineEnd,
        text: context.text,
      }));
      const mergedQueuedTerminalContexts =
        hiddenDesignMessage === null
          ? queuedTerminalContexts
          : [...hiddenDesignMessage.terminalContexts, ...queuedTerminalContexts].filter(
              (context, index, allContexts) =>
                allContexts.findIndex((candidate) => candidate.id === context.id) === index,
            );
      const queuedMessage: QueuedComposerMessage = {
        id: newMessageId(),
        prompt: promptForQueue,
        images: mergedQueuedImages,
        terminalContexts: mergedQueuedTerminalContexts,
        modelSelection: selectedModelSelection,
        runtimeMode,
        interactionMode,
      };
      const targetThreadId = await ensureQueuedComposerThread({
        titleSeed: promptRef.current,
        modelSelection: selectedModelSelection,
        runtimeMode,
        interactionMode,
      });
      if (!targetThreadId) {
        return false;
      }
      const appendOptions =
        mode === "steer"
          ? {
              steerRequest: {
                messageId: queuedMessage.id,
                baselineWorkLogEntryCount: workLogEntries.length,
                interruptRequested: false,
              },
            }
          : undefined;
      if (!(await appendQueuedComposerMessage(targetThreadId, queuedMessage, appendOptions))) {
        return false;
      }

      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "omitted",
        );
        toastManager.add({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        });
      }

      promptRef.current = "";
      clearComposerDraftContent(threadId);
      queuedDesignMessageEditRef.current = null;
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
      return true;
    },
    [
      buildQueuedComposerImages,
      clearComposerDraftContent,
      composerImages,
      composerTerminalContexts,
      ensureQueuedComposerThread,
      interactionMode,
      appendQueuedComposerMessage,
      runtimeMode,
      selectedModelSelection,
      setThreadError,
      workLogEntries.length,
      threadId,
    ],
  );
  const queuePreparedMessage = useCallback(
    async (preparedPrompt: string, images: ReadonlyArray<ComposerImageAttachment> = []) => {
      const queuedImages = images.length === 0 ? [] : await buildQueuedComposerImages([...images]);
      const queuedMessage: QueuedComposerMessage = {
        id: newMessageId(),
        prompt: preparedPrompt,
        images: queuedImages,
        terminalContexts: [],
        modelSelection: selectedModelSelection,
        runtimeMode,
        interactionMode,
      };
      const targetThreadId = await ensureQueuedComposerThread({
        titleSeed: preparedPrompt,
        modelSelection: selectedModelSelection,
        runtimeMode,
        interactionMode,
      });
      if (!targetThreadId) {
        return false;
      }
      return appendQueuedComposerMessage(targetThreadId, queuedMessage);
    },
    [
      appendQueuedComposerMessage,
      buildQueuedComposerImages,
      ensureQueuedComposerThread,
      interactionMode,
      runtimeMode,
      selectedModelSelection,
    ],
  );
  const queueBrowserDesignRequest = useEffectEvent(
    async (submission: BrowserDesignRequestSubmission) => {
      const trimmedInstructions = submission.instructions.trim();
      const normalizedMimeType =
        submission.imageMimeType.trim().length > 0 ? submission.imageMimeType : "image/png";
      const fileExtension = /^image\/([a-z0-9.+-]+)$/i.exec(normalizedMimeType)?.[1] ?? "png";
      const imageAttachment: QueuedComposerImageAttachment = {
        type: "image",
        id: randomUUID(),
        name: `designer-comment.${fileExtension}`,
        mimeType: normalizedMimeType,
        sizeBytes: submission.imageSizeBytes,
        dataUrl: submission.imageDataUrl,
        previewUrl: submission.imageDataUrl,
      };
      const promptWithContext = appendBrowserDesignContextToPrompt(trimmedInstructions, {
        requestId: submission.requestId,
        pageUrl: submission.pageUrl,
        pagePath: submission.pagePath,
        selection: submission.selection,
        targetElement: submission.targetElement,
        mainContainer: submission.mainContainer,
      });
      const queuedMessage: QueuedComposerMessage = {
        id: newMessageId(),
        prompt: promptWithContext,
        images: [imageAttachment],
        terminalContexts: [],
        modelSelection: selectedModelSelection,
        runtimeMode,
        interactionMode,
      };
      const targetThreadId = await ensureQueuedComposerThread({
        titleSeed: trimmedInstructions || "Designer comment",
        modelSelection: selectedModelSelection,
        runtimeMode,
        interactionMode,
      });
      if (!targetThreadId) {
        throw new Error("Failed to add the comment.");
      }
      const persisted = await appendQueuedComposerMessage(targetThreadId, queuedMessage);
      if (!persisted) {
        throw new Error("Failed to add the comment.");
      }
    },
  );
  const onSteerQueuedComposerMessage = useCallback(
    async (messageId: MessageId) => {
      const nextMessage = queuedComposerMessagesRef.current.find(
        (message) => message.id === messageId,
      );
      if (!nextMessage) {
        return;
      }
      const nextIndex = queuedComposerMessagesRef.current.findIndex(
        (message) => message.id === messageId,
      );
      if (nextIndex < 0) {
        return;
      }
      if (!serverThread) {
        return;
      }
      await steerQueuedComposerMessage(serverThread.id, messageId, {
        baselineWorkLogEntryCount: workLogEntries.length,
        interruptRequested: false,
      });
    },
    [serverThread, steerQueuedComposerMessage, workLogEntries.length],
  );
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      if (!activeThread) {
        return;
      }
      const snapshot = composerEditorRef.current?.readSnapshot() ?? {
        value: promptRef.current,
        cursor: composerCursor,
        expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
        terminalContextIds: composerTerminalContexts.map((context) => context.id),
      };
      const insertion = insertInlineTerminalContextPlaceholder(
        snapshot.value,
        snapshot.expandedCursor,
      );
      const nextCollapsedCursor = collapseExpandedComposerCursor(
        insertion.prompt,
        insertion.cursor,
      );
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
      setComposerCursor(nextCollapsedCursor);
      setComposerTrigger(detectComposerTriggerWithDismissal(insertion.prompt, insertion.cursor));
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCollapsedCursor);
      });
    },
    [
      activeThread,
      composerCursor,
      composerTerminalContexts,
      detectComposerTriggerWithDismissal,
      insertComposerDraftTerminalContext,
    ],
  );
  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadId) return;
      storeSetTerminalOpen(activeThreadId, open);
    },
    [activeThreadId, storeSetTerminalOpen],
  );
  const setTerminalHeight = useCallback(
    (height: number) => {
      if (!activeThreadId) return;
      storeSetTerminalHeight(activeThreadId, height);
    },
    [activeThreadId, storeSetTerminalHeight],
  );
  const setTerminalSidebarWidth = useCallback(
    (width: number) => {
      if (!activeThreadId) return;
      storeSetTerminalSidebarWidth(activeThreadId, width);
    },
    [activeThreadId, storeSetTerminalSidebarWidth],
  );
  const setTerminalSidebarDensity = useCallback(
    (density: "compact" | "comfortable") => {
      if (!activeThreadId) return;
      storeSetTerminalSidebarDensity(activeThreadId, density);
    },
    [activeThreadId, storeSetTerminalSidebarDensity],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadId) return;
    setTerminalOpen(!terminalState.terminalOpen);
  }, [activeThreadId, setTerminalOpen, terminalState.terminalOpen]);
  const openBrowser = useCallback(() => {
    if (!isElectron) return;
    setRightSidePanelMode("browser");
    setBrowserMode("split");
    setRightSidePanelVisible(true);
  }, [setBrowserMode, setRightSidePanelMode, setRightSidePanelVisible]);
  const closeBrowser = useCallback(() => {
    setBrowserMode("closed");
    setBrowserDevToolsOpen(false);
    setRightSidePanelMode((current) => (current === "browser" ? null : current));
  }, [setBrowserMode, setRightSidePanelMode]);
  const onToggleRightSidePanel = useCallback(() => {
    if (rightSidePanelOpen) {
      setRightSidePanelVisible(false);
      return;
    }
    setRightSidePanelVisible(true);
    if (!hasRightSidePanelContent) {
      setRightSidePanelMode("summary");
    }
  }, [
    hasRightSidePanelContent,
    rightSidePanelOpen,
    setRightSidePanelMode,
    setRightSidePanelVisible,
  ]);
  const onOpenRightSidePanelEditor = useCallback(() => {
    setRightSidePanelEditorOpen(true);
    setRightSidePanelMode("editor");
    setRightSidePanelVisible(true);
  }, [setRightSidePanelEditorOpen, setRightSidePanelMode, setRightSidePanelVisible]);
  const onSelectRightSidePanelMode = useCallback(
    (mode: RightSidePanelMode) => {
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
      onOpenRightSidePanelEditor();
    },
    [
      onOpenRightSidePanelDiff,
      onOpenRightSidePanelEditor,
      openBrowser,
      setRightSidePanelMode,
      setRightSidePanelVisible,
    ],
  );
  const onOpenRightSidePanelBrowserTab = useCallback(() => {
    openBrowser();
    browserControllerRef.current?.openNewTab();
  }, [openBrowser]);
  const onSelectRightSidePanelBrowserTab = useCallback(
    (tabId: string) => {
      openBrowser();
      const session = activeThreadId ? browserSessionByThreadId[activeThreadId] : null;
      const index = session?.tabs.findIndex((tab) => tab.id === tabId) ?? -1;
      if (index >= 0) {
        browserControllerRef.current?.setActiveTabByIndex(index);
      }
    },
    [activeThreadId, browserSessionByThreadId, openBrowser],
  );
  const onCloseRightSidePanelBrowserTab = useCallback(
    (tabId: string) => {
      const session = activeThreadId ? browserSessionByThreadId[activeThreadId] : null;
      if (session?.tabs.length === 1) {
        closeBrowser();
        if (rightSidePanelMode === "browser") {
          setRightSidePanelMode("summary");
        }
        return;
      }
      browserControllerRef.current?.closeTab(tabId);
      if (rightSidePanelMode === "browser" && session?.tabs.length === 1) {
        setRightSidePanelMode("summary");
      }
    },
    [
      activeThreadId,
      browserSessionByThreadId,
      closeBrowser,
      rightSidePanelMode,
      setRightSidePanelMode,
    ],
  );
  const onReorderRightSidePanelBrowserTab = useCallback(
    (draggedTabId: string, targetTabId: string) => {
      browserControllerRef.current?.reorderTabs(draggedTabId, targetTabId);
    },
    [],
  );
  const onCloseRightSidePanelEditor = useCallback(() => {
    setRightSidePanelEditorOpen(false);
    if (rightSidePanelMode === "editor") {
      setRightSidePanelMode("summary");
    }
  }, [rightSidePanelMode, setRightSidePanelEditorOpen, setRightSidePanelMode]);
  const onCloseRightSidePanelDiff = useCallback(() => {
    setRightSidePanelDiffOpenState(false);
    setRightSidePanelReviewOpen(false);
    setRightSidePanelMode((current) =>
      resolveRightSidePanelModeAfterDiffClose({
        activeMode: current,
        lastNonDiffMode: rightSidePanelLastNonDiffMode,
      }),
    );
    setLocalDiffState((previous) => ({ ...previous, open: false }));
  }, [
    rightSidePanelLastNonDiffMode,
    setLocalDiffState,
    setRightSidePanelDiffOpenState,
    setRightSidePanelMode,
    setRightSidePanelReviewOpen,
  ]);
  const onToggleRightSidePanelFullscreen = useCallback(() => {
    setRightSidePanelFullscreen((current) => !current);
  }, [setRightSidePanelFullscreen]);
  const onBrowserSessionChange = useCallback(
    (browserThreadId: ThreadId, session: BrowserSessionStorage) => {
      setBrowserSessionByThreadId((current) =>
        current[browserThreadId] === session
          ? current
          : {
              ...current,
              [browserThreadId]: session,
            },
      );
    },
    [],
  );
  const setBrowserController = useCallback(
    (browserThreadId: ThreadId, controller: InAppBrowserController | null) => {
      if (controller) {
        browserControllerByThreadRef.current.set(browserThreadId, controller);
      } else {
        browserControllerByThreadRef.current.delete(browserThreadId);
      }
      if (activeBrowserThreadIdRef.current !== browserThreadId) {
        return;
      }
      browserControllerRef.current = controller;
      if (!controller) {
        setBrowserDevToolsOpen(false);
        return;
      }
      const pendingUrl = pendingBrowserOpenUrlRef.current;
      if (!pendingUrl) {
        return;
      }
      pendingBrowserOpenUrlRef.current = null;
      controller.openUrl(pendingUrl, { newTab: true });
    },
    [],
  );
  const handleBrowserRuntimeStateChange = useCallback(
    (browserThreadId: ThreadId, state: { devToolsOpen: boolean }) => {
      browserRuntimeStateByThreadRef.current.set(browserThreadId, state);
      if (activeBrowserThreadIdRef.current !== browserThreadId) {
        return;
      }
      setBrowserDevToolsOpen(state.devToolsOpen);
    },
    [],
  );
  const getBrowserControllerChangeHandler = useCallback(
    (browserThreadId: ThreadId) => {
      const existingHandler =
        browserControllerChangeHandlerByThreadRef.current.get(browserThreadId);
      if (existingHandler) {
        return existingHandler;
      }
      const handler = (controller: InAppBrowserController | null) => {
        setBrowserController(browserThreadId, controller);
      };
      browserControllerChangeHandlerByThreadRef.current.set(browserThreadId, handler);
      return handler;
    },
    [setBrowserController],
  );
  const getBrowserRuntimeStateChangeHandler = useCallback(
    (browserThreadId: ThreadId) => {
      const existingHandler =
        browserRuntimeStateChangeHandlerByThreadRef.current.get(browserThreadId);
      if (existingHandler) {
        return existingHandler;
      }
      const handler = (state: ActiveBrowserRuntimeState) => {
        handleBrowserRuntimeStateChange(browserThreadId, state);
      };
      browserRuntimeStateChangeHandlerByThreadRef.current.set(browserThreadId, handler);
      return handler;
    },
    [handleBrowserRuntimeStateChange],
  );
  const openBrowserUrl = useCallback(
    (url: string, options?: { newTab?: boolean }) => {
      if (!isElectron || typeof url !== "string" || url.length === 0) return;
      setRightSidePanelMode("browser");
      setBrowserMode("split");
      setRightSidePanelVisible(true);
      const controller = browserControllerRef.current;
      if (!controller) {
        pendingBrowserOpenUrlRef.current = url;
        return;
      }
      controller.openUrl(url, options);
    },
    [setBrowserMode, setRightSidePanelMode, setRightSidePanelVisible],
  );
  const openBrowserUrlInNewTab = useCallback(
    (url: string) => {
      openBrowserUrl(url, { newTab: true });
    },
    [openBrowserUrl],
  );

  const handleBrowserLaunchRequest = useCallback(() => {
    if (!isElectron) {
      return;
    }

    const request = takePendingBrowserLaunchRequest();
    if (!request) {
      return;
    }

    if (request.url) {
      openBrowserUrl(
        request.url,
        request.newTab === undefined ? undefined : { newTab: request.newTab },
      );
      return;
    }

    openBrowser();
  }, [openBrowser, openBrowserUrl]);

  useEffect(() => {
    if (!isElectron) return;
    return window.desktopBridge?.onBrowserOpenUrl?.((url) => {
      if (typeof url !== "string" || url.length === 0) return;
      openBrowserUrl(url, { newTab: true });
    });
  }, [openBrowserUrl]);

  useEffect(() => {
    if (!isElectron) {
      return;
    }

    handleBrowserLaunchRequest();
    return subscribeToBrowserLaunchRequests(handleBrowserLaunchRequest);
  }, [handleBrowserLaunchRequest]);

  const syncBrowserSplitWidth = useCallback(
    (nextWidth: number) => {
      const viewportWidth = chatViewportRef.current?.clientWidth ?? window.innerWidth;
      const clampedWidth = clampBrowserSplitWidth(nextWidth, viewportWidth);
      if (lastSyncedBrowserSplitWidthRef.current === clampedWidth) {
        return;
      }
      lastSyncedBrowserSplitWidthRef.current = clampedWidth;
      setStoredBrowserSplitWidth(clampedWidth);
    },
    [setStoredBrowserSplitWidth],
  );

  const handleBrowserSplitResizePointerMove = useCallback((event: PointerEvent) => {
    const resizeState = browserSplitResizeStateRef.current;
    if (!resizeState) {
      return;
    }
    const viewportWidth = chatViewportRef.current?.clientWidth ?? window.innerWidth;
    const nextWidth = clampBrowserSplitWidth(
      resizeState.startWidth + (resizeState.startX - event.clientX),
      viewportWidth,
    );
    browserSplitWidthRef.current = nextWidth;
    setBrowserSplitWidth(nextWidth);
    didResizeBrowserSplitDuringDragRef.current = true;
  }, []);

  const handleBrowserSplitResizePointerEnd = useCallback(() => {
    browserSplitResizePointerIdRef.current = null;
    browserSplitResizeStateRef.current = null;
    if (!didResizeBrowserSplitDuringDragRef.current) {
      return;
    }
    didResizeBrowserSplitDuringDragRef.current = false;
    syncBrowserSplitWidth(browserSplitWidthRef.current);
  }, [syncBrowserSplitWidth]);

  const handleBrowserSplitResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      browserSplitResizePointerIdRef.current = event.pointerId;
      browserSplitResizeStateRef.current = {
        startX: event.clientX,
        startWidth: browserSplitWidthRef.current,
      };
      didResizeBrowserSplitDuringDragRef.current = false;
    },
    [],
  );
  const handleBrowserSplitResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (browserMode !== "split") {
        return;
      }
      const viewportWidth = chatViewportRef.current?.clientWidth ?? window.innerWidth;
      const currentWidth = browserSplitWidthRef.current;
      const step = event.shiftKey ? 96 : 32;

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        syncBrowserSplitWidth(currentWidth + step);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        syncBrowserSplitWidth(currentWidth - step);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        syncBrowserSplitWidth(viewportWidth);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        syncBrowserSplitWidth(0);
      }
    },
    [browserMode, syncBrowserSplitWidth],
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (browserSplitResizePointerIdRef.current !== null) {
        handleBrowserSplitResizePointerMove(event);
      }
    };
    const handlePointerEnd = () => {
      if (browserSplitResizePointerIdRef.current === null) {
        return;
      }
      handleBrowserSplitResizePointerEnd();
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [handleBrowserSplitResizePointerEnd, handleBrowserSplitResizePointerMove]);

  useEffect(() => {
    const viewportWidth = chatViewportRef.current?.clientWidth ?? window.innerWidth;
    const clampedWidth = clampBrowserSplitWidth(storedBrowserSplitWidth, viewportWidth);
    browserSplitWidthRef.current = clampedWidth;
    lastSyncedBrowserSplitWidthRef.current = clampedWidth;
    setBrowserSplitWidth(clampedWidth);
  }, [storedBrowserSplitWidth]);

  useEffect(() => {
    if (browserMode !== "split") {
      return;
    }

    let frameId: number | null = null;
    let pendingNativeResizeSync = false;
    const syncViewportWidth = () => {
      pendingNativeResizeSync = false;
      const viewportWidth = chatViewportRef.current?.clientWidth ?? window.innerWidth;
      const clampedWidth = clampBrowserSplitWidth(browserSplitWidthRef.current, viewportWidth);
      if (browserSplitWidthRef.current !== clampedWidth) {
        browserSplitWidthRef.current = clampedWidth;
        setBrowserSplitWidth(clampedWidth);
      }
      if (browserSplitResizePointerIdRef.current === null) {
        syncBrowserSplitWidth(clampedWidth);
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

    syncViewportWidth();
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
  }, [browserMode, syncBrowserSplitWidth]);

  const syncWorkspaceEditorSplitWidth = useCallback(
    (nextWidth: number) => {
      const viewportWidth = workspaceViewportRef.current?.clientWidth ?? window.innerWidth;
      const clampedWidth = clampWorkspaceEditorSplitWidth(nextWidth, viewportWidth);
      if (lastSyncedWorkspaceEditorSplitWidthRef.current === clampedWidth) {
        return;
      }
      lastSyncedWorkspaceEditorSplitWidthRef.current = clampedWidth;
      setStoredWorkspaceEditorSplitWidth(clampedWidth);
    },
    [setStoredWorkspaceEditorSplitWidth],
  );

  const handleWorkspaceEditorSplitResizePointerMove = useCallback((event: PointerEvent) => {
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
    setWorkspaceEditorSplitWidth(nextWidth);
    didResizeWorkspaceEditorSplitDuringDragRef.current = true;
  }, []);

  const handleWorkspaceEditorSplitResizePointerEnd = useCallback(() => {
    workspaceEditorSplitResizePointerIdRef.current = null;
    workspaceEditorSplitResizeStateRef.current = null;
    if (!didResizeWorkspaceEditorSplitDuringDragRef.current) {
      return;
    }
    didResizeWorkspaceEditorSplitDuringDragRef.current = false;
    syncWorkspaceEditorSplitWidth(workspaceEditorSplitWidthRef.current);
  }, [syncWorkspaceEditorSplitWidth]);

  const handleWorkspaceEditorSplitResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      workspaceEditorSplitResizePointerIdRef.current = event.pointerId;
      workspaceEditorSplitResizeStateRef.current = {
        startX: event.clientX,
        startWidth: workspaceEditorSplitWidthRef.current,
      };
      didResizeWorkspaceEditorSplitDuringDragRef.current = false;
    },
    [],
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (workspaceEditorSplitResizePointerIdRef.current !== null) {
        handleWorkspaceEditorSplitResizePointerMove(event);
      }
    };
    const handlePointerEnd = () => {
      if (workspaceEditorSplitResizePointerIdRef.current === null) {
        return;
      }
      handleWorkspaceEditorSplitResizePointerEnd();
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [handleWorkspaceEditorSplitResizePointerEnd, handleWorkspaceEditorSplitResizePointerMove]);

  useEffect(() => {
    const viewportWidth = workspaceViewportRef.current?.clientWidth ?? window.innerWidth;
    const clampedWidth = clampWorkspaceEditorSplitWidth(
      storedWorkspaceEditorSplitWidth,
      viewportWidth,
    );
    workspaceEditorSplitWidthRef.current = clampedWidth;
    lastSyncedWorkspaceEditorSplitWidthRef.current = clampedWidth;
    setWorkspaceEditorSplitWidth(clampedWidth);
  }, [storedWorkspaceEditorSplitWidth]);

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
        syncWorkspaceEditorSplitWidth(clampedWidth);
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

    syncViewportWidth();
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
  }, [editorHostedInRightPanel, syncWorkspaceEditorSplitWidth, workspaceMode]);

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
    [setStoredRightSidePanelWidth],
  );

  const handleRightSidePanelResizePointerMove = useCallback((event: PointerEvent) => {
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
    setRightSidePanelWidth(nextWidth);
    didResizeRightSidePanelDuringDragRef.current = true;
  }, []);

  const handleRightSidePanelResizePointerEnd = useCallback(() => {
    rightSidePanelResizePointerIdRef.current = null;
    rightSidePanelResizeStateRef.current = null;
    if (!didResizeRightSidePanelDuringDragRef.current) {
      return;
    }
    didResizeRightSidePanelDuringDragRef.current = false;
    syncRightSidePanelWidth(rightSidePanelWidthRef.current);
  }, [syncRightSidePanelWidth]);

  const handleRightSidePanelResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      rightSidePanelResizePointerIdRef.current = event.pointerId;
      rightSidePanelResizeStateRef.current = {
        startX: event.clientX,
        startWidth: rightSidePanelWidthRef.current,
      };
      didResizeRightSidePanelDuringDragRef.current = false;
    },
    [],
  );

  const handleRightSidePanelResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
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
    },
    [rightSidePanelOpen, syncRightSidePanelWidth],
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (rightSidePanelResizePointerIdRef.current !== null) {
        handleRightSidePanelResizePointerMove(event);
      }
    };
    const handlePointerEnd = () => {
      if (rightSidePanelResizePointerIdRef.current === null) {
        return;
      }
      handleRightSidePanelResizePointerEnd();
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [handleRightSidePanelResizePointerEnd, handleRightSidePanelResizePointerMove]);

  useEffect(() => {
    const viewportWidth = chatViewportRef.current?.clientWidth ?? window.innerWidth;
    const clampedWidth = clampRightSidePanelWidth(storedRightSidePanelWidth, viewportWidth);
    rightSidePanelWidthRef.current = clampedWidth;
    lastSyncedRightSidePanelWidthRef.current = clampedWidth;
    setRightSidePanelWidth(clampedWidth);
  }, [storedRightSidePanelWidth]);

  useEffect(() => {
    if (!rightSidePanelOpen || rightSidePanelFullscreen) {
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
        syncRightSidePanelWidth(clampedWidth);
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

    syncViewportWidth();
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
  }, [rightSidePanelFullscreen, rightSidePanelOpen, syncRightSidePanelWidth]);

  const splitTerminal = useCallback(() => {
    if (!activeThreadId || hasReachedSplitLimit) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeSplitTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, hasReachedSplitLimit, storeSplitTerminal]);
  const createNewTerminal = useCallback(() => {
    if (!activeThreadId) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeNewTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, storeNewTerminal]);
  const activateTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId) return;
      storeSetActiveTerminal(activeThreadId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, storeSetActiveTerminal],
  );
  const moveTerminal = useCallback(
    (terminalId: string, targetGroupId: string, targetIndex: number) => {
      if (!activeThreadId) return;
      storeMoveTerminal(activeThreadId, terminalId, targetGroupId, targetIndex);
    },
    [activeThreadId, storeMoveTerminal],
  );
  const unsplitTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId) return;
      const sourceGroupIndex = terminalState.terminalGroups.findIndex((group) =>
        group.terminalIds.includes(terminalId),
      );
      const sourceGroup =
        sourceGroupIndex >= 0 ? terminalState.terminalGroups[sourceGroupIndex] : null;
      if (!sourceGroup || sourceGroup.terminalIds.length <= 1) {
        return;
      }
      storeMoveTerminalToNewGroup(activeThreadId, terminalId, sourceGroupIndex + 1);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, storeMoveTerminalToNewGroup, terminalState.terminalGroups],
  );
  const renameTerminal = useCallback(
    (terminalId: string, title: string) => {
      if (!activeThreadId) return;
      storeRenameTerminal(activeThreadId, terminalId, title);
    },
    [activeThreadId, storeRenameTerminal],
  );
  const clearTerminal = useCallback(
    (terminalId: string) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;
      storeSetTerminalAutoTitle(activeThreadId, terminalId, null);
      runAsyncTask(
        api.terminal.clear({
          threadId: activeThreadId,
          terminalId,
        }),
        "Failed to clear the terminal from ChatView.",
      );
    },
    [activeThreadId, storeSetTerminalAutoTitle],
  );
  const closeTerminalTarget = useCallback(
    (targetTerminalId: string) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal
          .write({
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            data: "exit\n",
          })
          .catch((error) => {
            reportBackgroundError(
              "Failed to write the terminal exit fallback from ChatView.",
              error,
            );
          });
      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal
              .clear({
                threadId: activeThreadId,
                terminalId: targetTerminalId,
              })
              .catch((error) => {
                reportBackgroundError(
                  "Failed to clear the final terminal before closing it from ChatView.",
                  error,
                );
              });
          }
          await api.terminal.close({
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            deleteHistory: true,
          });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }
      storeCloseTerminal(activeThreadId, targetTerminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, storeCloseTerminal, terminalState.terminalIds.length],
  );
  const restartTerminal = useCallback(
    (terminalId: string) => {
      const api = readNativeApi();
      if (!activeThreadId || !api || !activeProject) return;
      void api.terminal
        .restart({
          threadId: activeThreadId,
          terminalId,
          cwd: gitCwd ?? activeProject.cwd,
          env: threadTerminalRuntimeEnv,
          cols: SCRIPT_TERMINAL_COLS,
          rows: SCRIPT_TERMINAL_ROWS,
        })
        .then(() => {
          setTerminalFocusRequestId((value) => value + 1);
        })
        .catch((err: unknown) => {
          reportBackgroundError("Failed to restart the terminal from ChatView.", err);
        });
    },
    [activeProject, activeThreadId, gitCwd, threadTerminalRuntimeEnv],
  );
  const setTerminalAutoTitle = useCallback(
    (terminalId: string, title: string | null) => {
      if (!activeThreadId) return;
      storeSetTerminalAutoTitle(activeThreadId, terminalId, title);
    },
    [activeThreadId, storeSetTerminalAutoTitle],
  );
  const setTerminalIcon = useCallback(
    (terminalId: string, icon: Parameters<typeof storeSetTerminalIcon>[2]) => {
      if (!activeThreadId) return;
      storeSetTerminalIcon(activeThreadId, terminalId, icon);
    },
    [activeThreadId, storeSetTerminalIcon],
  );
  const setTerminalColor = useCallback(
    (terminalId: string, color: Parameters<typeof storeSetTerminalColor>[2]) => {
      if (!activeThreadId) return;
      storeSetTerminalColor(activeThreadId, terminalId, color);
    },
    [activeThreadId, storeSetTerminalColor],
  );
  const setTerminalGroupSplitRatios = useCallback(
    (groupId: string, ratios: number[]) => {
      if (!activeThreadId) return;
      storeSetTerminalGroupSplitRatios(activeThreadId, groupId, ratios);
    },
    [activeThreadId, storeSetTerminalGroupSplitRatios],
  );
  const duplicateTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId) return;
      const sourceGroup = terminalState.terminalGroups.find((group) =>
        group.terminalIds.includes(terminalId),
      );
      const sourceIndex = sourceGroup?.terminalIds.indexOf(terminalId) ?? -1;
      const nextTerminalId = `terminal-${randomUUID()}`;

      if (sourceGroup && sourceGroup.terminalIds.length < MAX_TERMINALS_PER_GROUP) {
        storeNewTerminal(activeThreadId, nextTerminalId);
        storeMoveTerminal(
          activeThreadId,
          nextTerminalId,
          sourceGroup.id,
          Math.max(sourceIndex + 1, 0),
        );
      } else {
        storeNewTerminal(activeThreadId, nextTerminalId);
      }

      const icon = terminalState.terminalIconsById[terminalId] ?? null;
      const color = terminalState.terminalColorsById[terminalId] ?? null;
      if (icon) {
        storeSetTerminalIcon(activeThreadId, nextTerminalId, icon);
      }
      if (color) {
        storeSetTerminalColor(activeThreadId, nextTerminalId, color);
      }
      setTerminalFocusRequestId((value) => value + 1);
    },
    [
      activeThreadId,
      storeMoveTerminal,
      storeNewTerminal,
      storeSetTerminalColor,
      storeSetTerminalIcon,
      terminalState.terminalColorsById,
      terminalState.terminalGroups,
      terminalState.terminalIconsById,
    ],
  );
  const clearAllTerminals = useCallback(() => {
    const api = readNativeApi();
    if (!activeThreadId || !api) return;
    for (const terminalId of terminalState.terminalIds) {
      storeSetTerminalAutoTitle(activeThreadId, terminalId, null);
      runAsyncTask(
        api.terminal.clear({ threadId: activeThreadId, terminalId }),
        "Failed to clear a terminal while clearing all terminals from ChatView.",
      );
    }
  }, [activeThreadId, storeSetTerminalAutoTitle, terminalState.terminalIds]);
  const closeAllTerminals = useCallback(() => {
    const api = readNativeApi();
    if (!activeThreadId || !api) return;
    runAsyncTask(
      api.terminal.close({ threadId: activeThreadId, deleteHistory: true }),
      "Failed to close all terminals from ChatView.",
    );
    storeClearTerminalState(activeThreadId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, storeClearTerminalState]);
  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId) return;
      closeTerminalTarget(terminalId);
    },
    [activeThreadId, closeTerminalTarget],
  );
  const runProjectScript = useCallback(
    async (
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
      const baseTerminalId =
        terminalState.activeTerminalId ||
        terminalState.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = terminalState.runningTerminalIds.includes(baseTerminalId);
      const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const shouldCreateNewTerminal = wantsNewTerminal;
      const targetTerminalId = shouldCreateNewTerminal
        ? `terminal-${randomUUID()}`
        : baseTerminalId;

      setTerminalOpen(true);
      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadId, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadId, targetTerminalId);
      }
      storeSetTerminalAutoTitle(
        activeThreadId,
        targetTerminalId,
        deriveTerminalTitleFromCommand(script.command) ?? script.name,
      );
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.cwd,
        },
        worktreePath: options?.worktreePath ?? activeThread.worktreePath ?? null,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
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
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      gitCwd,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetTerminalAutoTitle,
      storeSetActiveTerminal,
      setLastInvokedScriptByProjectId,
      terminalState.activeTerminalId,
      terminalState.runningTerminalIds,
      terminalState.terminalIds,
    ],
  );

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
    setPendingPullRequestSetupRequest(null);
    if (!setupScript) {
      return;
    }

    void runProjectScript(setupScript, {
      cwd: pendingPullRequestSetupRequest.worktreePath,
      worktreePath: pendingPullRequestSetupRequest.worktreePath,
      rememberAsLastInvoked: false,
    }).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Failed to run setup script.",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, [
    activeProject,
    activeThread,
    activeThreadId,
    pendingPullRequestSetupRequest,
    runProjectScript,
  ]);
  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ProjectScript[];
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readNativeApi();
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        await api.server.upsertKeybinding(keybindingRule);
      }
    },
    [],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
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
    },
    [activeProject, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
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
    },
    [activeProject, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
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
    },
    [activeProject, persistProjectScripts],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
      threadId,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftThread,
      scheduleComposerFocus,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
      threadId,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode]);
  useEffect(() => {
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
    onOpenRightSidePanelDiff,
    shortcutsEnabled,
    toggleInteractionMode,
    toggleTerminalVisibility,
  ]);
  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
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
    },
    [serverThread],
  );

  // Auto-scroll on new messages
  const messageCount = timelineMessages.length;
  const markMessagesAtBottom = useCallback((scrollContainer: HTMLDivElement) => {
    lastKnownScrollTopRef.current = scrollContainer.scrollTop;
    shouldAutoScrollRef.current = true;
    pendingUserScrollUpIntentRef.current = false;
    isPointerScrollActiveRef.current = false;
    lastTouchClientYRef.current = null;
    setShowScrollToBottom(false);
  }, []);
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
  const cancelPendingInteractionAnchorAdjustment = useCallback(() => {
    const pendingFrame = pendingInteractionAnchorFrameRef.current;
    if (pendingFrame === null) return;
    pendingInteractionAnchorFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);
  const scheduleStickToBottom = useCallback(() => {
    if (pendingAutoScrollFrameRef.current !== null) return;
    pendingAutoScrollFrameRef.current = window.requestAnimationFrame(() => {
      pendingAutoScrollFrameRef.current = null;
      scrollMessagesToBottom();
    });
  }, [scrollMessagesToBottom]);
  const onMessagesClickCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer || !(event.target instanceof Element)) return;
      if (!shouldPreserveInteractionAnchorOnClick(event.detail)) {
        pendingInteractionAnchorRef.current = null;
        cancelPendingInteractionAnchorAdjustment();
        return;
      }

      const trigger = event.target.closest<HTMLElement>(
        "button, summary, [role='button'], [data-scroll-anchor-target]",
      );
      if (!trigger || !scrollContainer.contains(trigger)) return;
      if (trigger.closest("[data-scroll-anchor-ignore]")) return;

      pendingInteractionAnchorRef.current = {
        element: trigger,
        top: trigger.getBoundingClientRect().top,
      };

      cancelPendingInteractionAnchorAdjustment();
      pendingInteractionAnchorFrameRef.current = window.requestAnimationFrame(() => {
        pendingInteractionAnchorFrameRef.current = null;
        const anchor = pendingInteractionAnchorRef.current;
        pendingInteractionAnchorRef.current = null;
        const activeScrollContainer = messagesScrollRef.current;
        if (!anchor || !activeScrollContainer) return;
        if (!anchor.element.isConnected || !activeScrollContainer.contains(anchor.element)) return;

        const nextTop = anchor.element.getBoundingClientRect().top;
        const delta = nextTop - anchor.top;
        if (Math.abs(delta) < 0.5) return;

        activeScrollContainer.scrollTop += delta;
        lastKnownScrollTopRef.current = activeScrollContainer.scrollTop;
      });
    },
    [cancelPendingInteractionAnchorAdjustment],
  );
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
  const onMessagesScroll = useCallback(() => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    const currentScrollTop = scrollContainer.scrollTop;
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
    }
    if (autoScrollDecision.scheduleStickToBottom) {
      // Keep following output when layout shifts move the viewport slightly off-bottom.
      scheduleStickToBottom();
    }

    setShowScrollToBottom(!shouldAutoScrollRef.current);
    lastKnownScrollTopRef.current = currentScrollTop;
  }, [cancelPendingStickToBottom, scheduleStickToBottom]);
  const onMessagesWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (event.deltaY < 0) {
        pendingUserScrollUpIntentRef.current = true;
        cancelPendingStickToBottom();
      }
    },
    [cancelPendingStickToBottom],
  );
  const onMessagesPointerDown = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = true;
  }, []);
  const onMessagesPointerUp = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = false;
  }, []);
  const onMessagesPointerCancel = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = false;
  }, []);
  const onMessagesTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    lastTouchClientYRef.current = touch.clientY;
  }, []);
  const onMessagesTouchMove = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const touch = event.touches[0];
      if (!touch) return;
      const previousTouchY = lastTouchClientYRef.current;
      if (previousTouchY !== null && touch.clientY > previousTouchY + 1) {
        pendingUserScrollUpIntentRef.current = true;
        cancelPendingStickToBottom();
      }
      lastTouchClientYRef.current = touch.clientY;
    },
    [cancelPendingStickToBottom],
  );
  const onMessagesTouchEnd = useCallback((_event: React.TouchEvent<HTMLDivElement>) => {
    lastTouchClientYRef.current = null;
  }, []);
  useEffect(() => {
    return () => {
      cancelPendingStickToBottom();
      cancelPendingInteractionAnchorAdjustment();
    };
  }, [cancelPendingInteractionAnchorAdjustment, cancelPendingStickToBottom]);
  useLayoutEffect(() => {
    const nextThreadId = activeThread?.id ?? null;
    if (!nextThreadId) return;
    const jumpImmediately =
      previousThreadIdRef.current !== null && previousThreadIdRef.current !== nextThreadId;
    previousThreadIdRef.current = nextThreadId;
    cancelPendingStickToBottom();
    cancelPendingInteractionAnchorAdjustment();
    pendingInteractionAnchorRef.current = null;
    pendingUserScrollUpIntentRef.current = false;
    isPointerScrollActiveRef.current = false;
    lastTouchClientYRef.current = null;
    lastKnownScrollTopRef.current = messagesScrollRef.current?.scrollTop ?? 0;
    shouldAutoScrollRef.current = true;
    setShowScrollToBottom(false);
    forceStickToBottom(jumpImmediately);

    const timeout = window.setTimeout(() => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer) return;
      if (isScrollContainerNearBottom(scrollContainer)) return;
      scheduleStickToBottom();
    }, THREAD_SWITCH_SCROLL_SETTLE_DELAY_MS);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    activeThread?.id,
    cancelPendingInteractionAnchorAdjustment,
    cancelPendingStickToBottom,
    forceStickToBottom,
    scheduleStickToBottom,
  ]);
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;
    const measureFooterCompactness = () => {
      const composerFormWidth = measureComposerFormWidth();
      const heuristicFooterCompact = shouldUseCompactComposerFooter(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      });
      const footer = composerFooterRef.current;
      const footerStyle = footer ? window.getComputedStyle(footer) : null;
      const footerContentWidth = resolveComposerFooterContentWidth({
        footerWidth: footer?.clientWidth ?? null,
        paddingLeft: footerStyle ? Number.parseFloat(footerStyle.paddingLeft) : null,
        paddingRight: footerStyle ? Number.parseFloat(footerStyle.paddingRight) : null,
      });
      const fitInput = {
        footerContentWidth,
        leadingContentWidth: composerFooterLeadingRef.current?.scrollWidth ?? null,
        actionsWidth: composerFooterActionsRef.current?.scrollWidth ?? null,
      };
      const nextFooterCompact =
        heuristicFooterCompact || shouldForceCompactComposerFooterForFit(fitInput);
      const nextPrimaryActionsCompact =
        nextFooterCompact &&
        shouldUseCompactComposerPrimaryActions(composerFormWidth, {
          hasWideActions: composerFooterHasWideActions,
        });

      return {
        primaryActionsCompact: nextPrimaryActionsCompact,
        footerCompact: nextFooterCompact,
      };
    };

    composerFormHeightRef.current = composerForm.getBoundingClientRect().height;
    const initialCompactness = measureFooterCompactness();
    setIsComposerPrimaryActionsCompact(initialCompactness.primaryActionsCompact);
    setIsComposerFooterCompact(initialCompactness.footerCompact);
    if (typeof ResizeObserver === "undefined") return;

    let pendingComposerHeight: number | null = null;
    let frameId: number | null = null;
    let pendingDeferredComposerMeasurement = false;
    const applyComposerMeasurement = () => {
      frameId = null;
      const nextCompactness = measureFooterCompactness();
      setIsComposerPrimaryActionsCompact((previous) =>
        previous === nextCompactness.primaryActionsCompact
          ? previous
          : nextCompactness.primaryActionsCompact,
      );
      setIsComposerFooterCompact((previous) =>
        previous === nextCompactness.footerCompact ? previous : nextCompactness.footerCompact,
      );

      const nextHeight = pendingComposerHeight;
      pendingComposerHeight = null;
      if (nextHeight === null) return;

      const previousHeight = composerFormHeightRef.current;
      composerFormHeightRef.current = nextHeight;

      if (previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) return;
      if (!shouldAutoScrollRef.current) return;
      scheduleStickToBottom();
    };
    const scheduleComposerMeasurement = (nextHeight: number) => {
      if (isLayoutResizeInProgress()) {
        pendingDeferredComposerMeasurement = true;
        pendingComposerHeight = nextHeight;
        return;
      }
      pendingComposerHeight = nextHeight;
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(applyComposerMeasurement);
    };
    const handleLayoutResizeEnd = () => {
      if (!pendingDeferredComposerMeasurement) {
        return;
      }
      pendingDeferredComposerMeasurement = false;
      const nextHeight = composerForm.getBoundingClientRect().height;
      scheduleComposerMeasurement(nextHeight);
    };

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;
      scheduleComposerMeasurement(entry.contentRect.height);
    });

    observer.observe(composerForm);
    window.addEventListener("ace:native-window-resize-end", handleLayoutResizeEnd);
    window.addEventListener(SIDEBAR_RESIZE_END_EVENT, handleLayoutResizeEnd);
    return () => {
      observer.disconnect();
      window.removeEventListener("ace:native-window-resize-end", handleLayoutResizeEnd);
      window.removeEventListener(SIDEBAR_RESIZE_END_EVENT, handleLayoutResizeEnd);
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [
    activeThread?.id,
    composerFooterActionLayoutKey,
    composerFooterHasWideActions,
    scheduleStickToBottom,
  ]);
  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [messageCount, scheduleStickToBottom]);
  useEffect(() => {
    if (!liveTurnInProgress) return;
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [liveTurnInProgress, scheduleStickToBottom, timelineEntries]);

  useEffect(() => {
    setExpandedWorkGroups({});
    setGitHubIssueDialogOpen(false);
    setGitHubIssueDialogInitialIssueNumber(null);
    setGitHubIssueDialogInitialSelectedIssueNumbers([]);
    setPullRequestDialogState(null);
    if (openSummaryOnNextThreadRef.current) {
      openSummaryOnNextThreadRef.current = false;
      setRightSidePanelMode("summary");
      setRightSidePanelVisible(true);
    }
    dismissedComposerTriggerRef.current = null;
  }, [activeThread?.id, setRightSidePanelMode, setRightSidePanelVisible]);

  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      return;
    }
    setComposerHighlightedItemId((existing) =>
      existing && composerMenuItems.some((item) => item.id === existing)
        ? existing
        : (composerMenuItems[0]?.id ?? null),
    );
  }, [composerMenuItems, composerMenuOpen]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id || terminalState.terminalOpen) return;
    return scheduleComposerFocus();
  }, [activeThread?.id, scheduleComposerFocus, terminalState.terminalOpen]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages]);

  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) {
      return;
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
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
  }, [activeThread?.id, activeThread?.messages, handoffAttachmentPreviews, optimisticUserMessages]);

  useEffect(() => {
    promptRef.current = prompt;
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
  }, [prompt]);

  useEffect(() => {
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    resetLocalDispatch();
    setComposerHighlightedItemId(null);
    setComposerCursor(collapseExpandedComposerCursor(promptRef.current, promptRef.current.length));
    setComposerTrigger(
      detectComposerTriggerWithDismissal(promptRef.current, promptRef.current.length),
    );
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    setExpandedImage(null);
  }, [detectComposerTriggerWithDismissal, resetLocalDispatch, threadId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(threadId);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ?? [];
      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
        await Promise.all(
          composerImages.map(async (image) => {
            try {
              const dataUrl = await readFileAsDataUrl(image.file);
              stagedAttachmentById.set(image.id, {
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
              });
            } catch {
              const existingPersisted = existingPersistedById.get(image.id);
              if (existingPersisted) {
                stagedAttachmentById.set(image.id, existingPersisted);
              }
            }
          }),
        );
        const serialized = Array.from(stagedAttachmentById.values());
        if (cancelled) {
          return;
        }
        // Stage attachments in persisted draft state first so persist middleware can write them.
        syncComposerDraftPersistedAttachments(threadId, serialized);
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        const fallbackPersistedIds = fallbackPersistedAttachments
          .map((attachment) => attachment.id)
          .filter((id) => currentImageIds.has(id));
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) {
          return;
        }
        syncComposerDraftPersistedAttachments(threadId, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    clearComposerDraftPersistedAttachments,
    composerImages,
    syncComposerDraftPersistedAttachments,
    threadId,
  ]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);
  const navigateExpandedImage = useCallback((direction: -1 | 1) => {
    setExpandedImage((existing) => {
      if (!existing || existing.images.length <= 1) {
        return existing;
      }
      const nextIndex =
        (existing.index + direction + existing.images.length) % existing.images.length;
      if (nextIndex === existing.index) {
        return existing;
      }
      return { ...existing, index: nextIndex };
    });
  }, []);

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
  }, [closeExpandedImage, expandedImage, navigateExpandedImage]);

  const activeWorktreePath = activeThread?.worktreePath;
  const envMode: DraftThreadEnvMode = activeWorktreePath
    ? "worktree"
    : isLocalDraftThread
      ? (draftThread?.envMode ?? "local")
      : "local";

  useEffect(() => {
    if (!activeThreadId) return;
    const previous = terminalOpenByThreadRef.current[activeThreadId] ?? false;
    const current = Boolean(terminalState.terminalOpen);

    if (!previous && current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      return scheduleComposerFocus();
    }

    terminalOpenByThreadRef.current[activeThreadId] = current;
  }, [activeThreadId, scheduleComposerFocus, terminalState.terminalOpen]);

  useEffect(() => {
    if (!shortcutsEnabled) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || event.defaultPrevented) return;
      if (
        event.key === "Escape" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        browserOpen
      ) {
        browserControllerRef.current?.toggleDesignerTool("cursor");
      }
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: Boolean(terminalState.terminalOpen),
        browserOpen,
      };

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) return;
        closeTerminal(terminalState.activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (command === "rightPanel.review.open") {
        event.preventDefault();
        event.stopPropagation();
        onOpenRightSidePanelDiff();
        return;
      }

      if (command === "rightPanel.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleRightSidePanel();
        return;
      }

      if (command === "rightPanel.browser.open") {
        event.preventDefault();
        event.stopPropagation();
        openBrowser();
        return;
      }

      if (command === "browser.back") {
        event.preventDefault();
        event.stopPropagation();
        browserControllerRef.current?.goBack();
        return;
      }

      if (command === "browser.forward") {
        event.preventDefault();
        event.stopPropagation();
        browserControllerRef.current?.goForward();
        return;
      }

      if (command === "browser.reload") {
        event.preventDefault();
        event.stopPropagation();
        browserControllerRef.current?.reload();
        return;
      }

      if (command === "browser.devtools") {
        event.preventDefault();
        event.stopPropagation();
        browserControllerRef.current?.toggleDevTools();
        return;
      }

      if (command === "browser.newTab") {
        event.preventDefault();
        event.stopPropagation();
        if (!browserOpen || !browserControllerRef.current) {
          onOpenRightSidePanelBrowserTab();
          return;
        }
        browserControllerRef.current.openNewTab();
        return;
      }

      if (command === "browser.closeTab") {
        event.preventDefault();
        event.stopPropagation();
        browserControllerRef.current?.closeActiveTab();
        return;
      }

      if (command === "browser.focusAddressBar") {
        event.preventDefault();
        event.stopPropagation();
        browserControllerRef.current?.focusAddressBar();
        return;
      }

      if (command === "browser.previousTab") {
        event.preventDefault();
        event.stopPropagation();
        browserControllerRef.current?.goToPreviousTab();
        return;
      }

      if (command === "browser.nextTab") {
        event.preventDefault();
        event.stopPropagation();
        browserControllerRef.current?.goToNextTab();
        return;
      }

      if (command === "browser.designer.cursor") {
        event.preventDefault();
        event.stopPropagation();
        browserControllerRef.current?.toggleDesignerTool("cursor");
        return;
      }

      if (command === "browser.designer.areaComment") {
        event.preventDefault();
        event.stopPropagation();
        browserControllerRef.current?.toggleDesignerTool("area-comment");
        return;
      }

      if (command === "browser.designer.drawComment") {
        event.preventDefault();
        event.stopPropagation();
        browserControllerRef.current?.toggleDesignerTool("draw-comment");
        return;
      }

      if (command === "browser.designer.elementComment") {
        event.preventDefault();
        event.stopPropagation();
        browserControllerRef.current?.toggleDesignerTool("element-comment");
        return;
      }

      if (command === "chat.togglePlanMode") {
        event.preventDefault();
        event.stopPropagation();
        toggleInteractionMode();
        return;
      }

      if (command === "chat.toggleWorkspaceMode") {
        event.preventDefault();
        event.stopPropagation();
        toggleWorkspaceMode();
        return;
      }

      if (command === "rightPanel.editor.open") {
        event.preventDefault();
        event.stopPropagation();
        onOpenRightSidePanelEditor();
        return;
      }

      if (command === "chat.toggleHeader") {
        event.preventDefault();
        event.stopPropagation();
        toggleHeaderVisibility();
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeProject,
    browserOpen,
    terminalState.terminalOpen,
    terminalState.activeTerminalId,
    activeThreadId,
    openBrowser,
    closeTerminal,
    createNewTerminal,
    setTerminalOpen,
    runProjectScript,
    splitTerminal,
    keybindings,
    onOpenRightSidePanelBrowserTab,
    onToggleRightSidePanel,
    onOpenRightSidePanelEditor,
    onOpenRightSidePanelDiff,
    shortcutsEnabled,
    toggleInteractionMode,
    toggleWorkspaceMode,
    toggleHeaderVisibility,
    toggleTerminalVisibility,
  ]);

  const addComposerImages = useEffectEvent((files: File[]) => {
    if (!activeThreadId || files.length === 0) return;

    if (pendingUserInputs.length > 0) {
      toastManager.add({
        type: "error",
        title: "Attach images after answering plan questions.",
      });
      return;
    }

    const nextImages: ComposerImageAttachment[] = [];
    let nextImageCount = composerImagesRef.current.length;
    let error: string | null = null;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
        continue;
      }
      if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        error = `'${file.name}' exceeds the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`;
        continue;
      }
      if (nextImageCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
        break;
      }

      const previewUrl = URL.createObjectURL(file);
      nextImages.push({
        type: "image",
        id: randomUUID(),
        name: file.name || "image",
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl,
        file,
      });
      nextImageCount += 1;
    }

    if (nextImages.length === 1 && nextImages[0]) {
      addComposerImage(nextImages[0]);
    } else if (nextImages.length > 1) {
      addComposerImagesToDraft(nextImages);
    }
    setThreadError(activeThreadId, error);
  });

  const removeComposerImage = useCallback(
    (imageId: string) => {
      removeComposerImageFromDraft(imageId);
    },
    [removeComposerImageFromDraft],
  );

  const onComposerPaste = useCallback((event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) {
      return;
    }
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    addComposerImages(imageFiles);
  }, []);

  const onComposerDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOverComposer(true);
  }, []);

  const onComposerDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverComposer(true);
  }, []);

  const onComposerDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOverComposer(false);
    }
  }, []);

  const onComposerDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes("Files")) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragOverComposer(false);
      const files = Array.from(event.dataTransfer.files);
      addComposerImages(files);
      scheduleComposerFocus();
    },
    [scheduleComposerFocus],
  );

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
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
    },
    [
      activeThread,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      liveTurnInProgress,
      setThreadError,
    ],
  );

  const dispatchComposerMessage = useCallback(
    async (
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

      const promptForSend = stripIssueReferenceMarkers(submission.prompt);
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

      sendInFlightRef.current = true;
      beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });
      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
          createdAt: messageCreatedAt,
          streaming: false,
        },
      ]);
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
            titleSeed = "New thread";
          }
        }
        const title = truncate(titleSeed);
        const threadCreateModelSelection: ModelSelection = buildProviderModelSelection(
          submission.modelSelection.provider,
          submission.modelSelection.model ||
            activeProject.defaultModelSelection?.model ||
            DEFAULT_MODEL_BY_PROVIDER[submission.modelSelection.provider],
          submission.modelSelection.options,
        );

        if (isLocalDraftThread) {
          await api.orchestration.dispatchCommand({
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
        if (createdServerThreadForLocalDraft && !turnStartSucceeded) {
          await api.orchestration
            .dispatchCommand({
              type: "thread.delete",
              commandId: newCommandId(),
              threadId: threadIdForSend,
            })
            .catch((cleanupErr: unknown) => {
              reportBackgroundError("Failed to clean up thread after send failure.", cleanupErr);
            });
        }
        if (
          !turnStartSucceeded &&
          promptRef.current.length === 0 &&
          composerImagesRef.current.length === 0 &&
          composerTerminalContextsRef.current.length === 0
        ) {
          setOptimisticUserMessages((existing) => {
            const removed = existing.filter((message) => message.id === messageIdForSend);
            for (const message of removed) {
              revokeUserMessagePreviewUrls(message);
            }
            const next = existing.filter((message) => message.id !== messageIdForSend);
            return next.length === existing.length ? existing : next;
          });
          promptRef.current = promptForRestore;
          setPrompt(promptForRestore);
          setComposerCursor(
            collapseExpandedComposerCursor(promptForRestore, promptForRestore.length),
          );
          addComposerImagesToDraft(
            composerImagesSnapshot.flatMap((image) =>
              "dataUrl" in image ? [] : [cloneComposerImageForRetry(image)],
            ),
          );
          addComposerTerminalContextsToDraft(composerTerminalContextsSnapshot);
          setComposerTrigger(
            detectComposerTriggerWithDismissal(promptForRestore, promptForRestore.length),
          );
        }
        options?.onFailure?.();
        setThreadError(
          threadIdForSend,
          err instanceof Error ? err.message : "Failed to send message.",
        );
      });
      sendInFlightRef.current = false;
      if (!turnStartSucceeded) {
        resetLocalDispatch();
      }
      return turnStartSucceeded;
    },
    [
      activeProject,
      activeThread,
      addComposerImagesToDraft,
      addComposerTerminalContextsToDraft,
      beginLocalDispatch,
      createWorktreeMutation,
      envMode,
      forceStickToBottom,
      isLocalDraftThread,
      isServerThread,
      detectComposerTriggerWithDismissal,
      persistThreadSettingsForNextTurn,
      providerStatuses,
      resetLocalDispatch,
      runProjectScript,
      setPrompt,
      setStoreThreadBranch,
      setStoreThreadError,
      setThreadError,
    ],
  );
  const onSend = useEffectEvent(async (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    const api = readNativeApi();
    if (!api || !activeThread || sendInFlightRef.current) return;
    if (activePendingProgress) {
      onAdvanceActivePendingUserInput();
      return;
    }
    if (liveTurnInProgress || isSendBusy || isConnecting) {
      await queueCurrentComposerMessage();
      return;
    }
    const promptForSend = promptRef.current;
    const promptForSendWithoutIssueMarkers = stripIssueReferenceMarkers(promptForSend);
    const hiddenDesignMessage = queuedDesignMessageEditRef.current;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSendWithoutIssueMarkers,
      imageCount: composerImages.length,
      terminalContexts: composerTerminalContexts,
    });
    if (showPlanFollowUpPrompt && activeProposedPlan) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      promptRef.current = "";
      clearComposerDraftContent(activeThread.id);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
      await onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      });
      return;
    }
    const standaloneSlashCommand =
      composerImages.length === 0 && sendableComposerTerminalContexts.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand) {
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(activeThread.id);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
      return;
    }
    const composerIssuesCommandPayload =
      composerImages.length === 0 && sendableComposerTerminalContexts.length === 0
        ? parseComposerIssuesCommand(trimmed)
        : null;
    const isIssuesCommandText =
      composerImages.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      /^\/issues\b/i.test(trimmed);
    if (isIssuesCommandText && composerIssuesCommandPayload === null) {
      toastManager.add({
        type: "warning",
        title: "Use valid issue tags",
        description: "Use /issues followed by tags like #123 #456.",
      });
      return;
    }
    if (composerIssuesCommandPayload !== null) {
      if (composerIssuesCommandPayload.issueNumbers.length === 0) {
        toastManager.add({
          type: "warning",
          title: "Tag at least one issue",
          description: "Use /issues #123 #456, then add your message if needed.",
        });
        return;
      }
      if (!gitCwd || !isGitRepo) {
        toastManager.add({
          type: "error",
          title: "GitHub issues are unavailable",
          description: "Open a Git repository to use /issues.",
        });
        return;
      }
      try {
        const payload = await buildGitHubIssueSelectionPayload({
          cwd: gitCwd,
          issueNumbers: composerIssuesCommandPayload.issueNumbers,
          queryClient,
          includeSummaryLines: false,
        });
        const composedPrompt =
          payload.prompt.length > 0 ? `${trimmed}\n\n${payload.prompt}` : trimmed;
        promptRef.current = "";
        clearComposerDraftContent(activeThread.id);
        setComposerHighlightedItemId(null);
        setComposerCursor(0);
        setComposerTrigger(null);
        await onFixGitHubIssue({ prompt: composedPrompt, images: payload.images });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to load GitHub issue context.",
          description: error instanceof Error ? error.message : "Please try again.",
        });
      }
      return;
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        });
      }
      return;
    }
    if (!activeProject) return;
    let promptWithIssueContext = promptForSendWithoutIssueMarkers;
    let imagesWithIssueContext: Array<ComposerImageAttachment | QueuedComposerImageAttachment> =
      hiddenDesignMessage === null
        ? composerImages
        : [...hiddenDesignMessage.images, ...composerImages].filter(
            (image, index, allImages) =>
              allImages.findIndex((candidate) => candidate.id === image.id) === index,
          );
    if (composerIssuesCommandPayload === null && gitCwd && isGitRepo) {
      const inlineIssueNumbers = extractIssueReferenceNumbers(promptForSend);
      if (inlineIssueNumbers.length > 0) {
        try {
          const payload = await buildGitHubIssueSelectionPayload({
            cwd: gitCwd,
            issueNumbers: inlineIssueNumbers,
            queryClient,
            includeSummaryLines: false,
          });
          if (payload.prompt.length > 0) {
            promptWithIssueContext = `${promptForSendWithoutIssueMarkers}\n\n${payload.prompt}`;
          }
          if (payload.images.length > 0) {
            const seenImageIds = new Set<string>();
            imagesWithIssueContext = [...composerImages, ...payload.images].filter((image) => {
              if (seenImageIds.has(image.id)) {
                return false;
              }
              seenImageIds.add(image.id);
              return true;
            });
          }
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to load GitHub issue context.",
            description: error instanceof Error ? error.message : "Please try again.",
          });
          return;
        }
      }
    }
    const promptWithHiddenDesignContext =
      hiddenDesignMessage === null
        ? promptWithIssueContext
        : appendHiddenBrowserDesignContextFromOriginalPrompt(
            promptWithIssueContext,
            hiddenDesignMessage.prompt,
          );
    const terminalContextsForDispatch =
      hiddenDesignMessage === null
        ? sendableComposerTerminalContexts
        : [
            ...hiddenDesignMessage.terminalContexts.map((context) => ({
              ...context,
              threadId: activeThread.id,
            })),
            ...sendableComposerTerminalContexts,
          ].filter(
            (context, index, allContexts) =>
              allContexts.findIndex((candidate) => candidate.id === context.id) === index,
          );
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add({
        type: "warning",
        title: toastCopy.title,
        description: toastCopy.description,
      });
    }
    promptRef.current = "";
    clearComposerDraftContent(activeThread.id);
    queuedDesignMessageEditRef.current = null;
    setComposerHighlightedItemId(null);
    setComposerCursor(0);
    setComposerTrigger(null);

    await dispatchComposerMessage(
      {
        prompt: promptWithHiddenDesignContext,
        images: imagesWithIssueContext,
        terminalContexts: terminalContextsForDispatch,
        modelSelection: selectedModelSelection,
        runtimeMode,
        interactionMode,
      },
      {
        restorePrompt: promptForSend,
        onFailure: () => {
          queuedDesignMessageEditRef.current = hiddenDesignMessage;
        },
      },
    );
  });

  const clearPendingInterruptStopFallback = useEffectEvent(() => {
    if (pendingInterruptStopFallbackRef.current === null) {
      return;
    }
    window.clearTimeout(pendingInterruptStopFallbackRef.current);
    pendingInterruptStopFallbackRef.current = null;
  });

  const dispatchInterruptStopFallback = useEffectEvent(
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
  );

  const scheduleInterruptStopFallback = useEffectEvent(
    (targetThreadId: ThreadId, targetTurnId: TurnId | null) => {
      clearPendingInterruptStopFallback();
      pendingInterruptStopFallbackRef.current = window.setTimeout(() => {
        pendingInterruptStopFallbackRef.current = null;
        void dispatchInterruptStopFallback(targetThreadId, targetTurnId);
      }, INTERRUPT_STOP_FALLBACK_DELAY_MS);
    },
  );

  useEffect(() => {
    if (!liveTurnInProgress) {
      clearPendingInterruptStopFallback();
    }
  }, [liveTurnInProgress]);

  useEffect(() => () => clearPendingInterruptStopFallback(), []);

  const onInterrupt = useEffectEvent(async () => {
    const api = readNativeApi();
    if (!api || !activeThread) return;
    const interruptedTurnId = activeLatestTurn?.turnId ?? null;
    await api.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId: activeThread.id,
      createdAt: new Date().toISOString(),
    });
    scheduleInterruptStopFallback(activeThread.id, interruptedTurnId);
  });

  const onRespondToApproval = useEffectEvent(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
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
    },
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
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
    },
    [activeThreadId, setStoreThreadError],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
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
      setComposerCursor(0);
      setComposerTrigger(null);
    },
    [activePendingUserInput],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
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
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTriggerWithDismissal(value, expandedCursor),
      );
    },
    [activePendingUserInput, detectComposerTriggerWithDismissal],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
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
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      interactionMode: nextInteractionMode,
    }: {
      text: string;
      interactionMode: "default" | "plan";
    }) => {
      const api = readNativeApi();
      if (
        !api ||
        !activeThread ||
        !isServerThread ||
        isSendBusy ||
        isConnecting ||
        sendInFlightRef.current
      ) {
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const outgoingMessageText = formatOutgoingPrompt({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        effort: selectedPromptEffort,
        text: trimmed,
      });

      sendInFlightRef.current = true;
      beginLocalDispatch({ preparingWorktree: false });
      setThreadError(threadIdForSend, null);
      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          createdAt: messageCreatedAt,
          streaming: false,
        },
      ]);
      shouldAutoScrollRef.current = true;
      forceStickToBottom();

      try {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          modelSelection: selectedModelSelection,
          runtimeMode,
          interactionMode: nextInteractionMode,
        });

        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(threadIdForSend, nextInteractionMode);

        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: [],
          },
          modelSelection: selectedModelSelection,
          titleSeed: activeThread.title,
          runtimeMode,
          interactionMode: nextInteractionMode,
          ...(nextInteractionMode === "default" && activeProposedPlan
            ? {
                sourceProposedPlan: {
                  threadId: activeThread.id,
                  planId: activeProposedPlan.id,
                },
              }
            : {}),
          createdAt: messageCreatedAt,
        });
        // Switch to the summary surface when implementing so live plan and todo updates
        // stay in the same right-panel destination.
        if (nextInteractionMode === "default") {
          setRightSidePanelMode("summary");
          setRightSidePanelVisible(true);
        }
        sendInFlightRef.current = false;
      } catch (err) {
        setOptimisticUserMessages((existing) =>
          existing.filter((message) => message.id !== messageIdForSend),
        );
        setThreadError(
          threadIdForSend,
          err instanceof Error ? err.message : "Failed to send plan follow-up.",
        );
        sendInFlightRef.current = false;
        resetLocalDispatch();
      }
    },
    [
      activeThread,
      activeProposedPlan,
      beginLocalDispatch,
      forceStickToBottom,
      isConnecting,
      isSendBusy,
      isServerThread,
      persistThreadSettingsForNextTurn,
      resetLocalDispatch,
      runtimeMode,
      selectedPromptEffort,
      selectedModelSelection,
      selectedProvider,
      selectedProviderModels,
      setComposerDraftInteractionMode,
      setRightSidePanelMode,
      setRightSidePanelVisible,
      setThreadError,
      selectedModel,
    ],
  );

  const onImplementPlanInNewThread = useEffectEvent(async () => {
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
      effort: selectedPromptEffort,
      text: implementationPrompt,
    });
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = selectedModelSelection;

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      sendInFlightRef.current = false;
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
  });

  const onHandoffToProvider = useEffectEvent(
    async (provider: ProviderKind, mode: ThreadHandoffMode) => {
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
        draft: composerDraft,
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
            fromProvider: activeThread.modelSelection.provider,
            toProvider: resolvedProvider,
            mode,
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
      } finally {
        setHandoffInFlight(false);
      }
    },
  );

  const onProviderModelSelect = useEffectEvent((provider: ProviderKind, model: string) => {
    if (!activeThread) return;
    if (lockedProvider !== null && provider !== lockedProvider) {
      scheduleComposerFocus();
      return;
    }
    const resolvedProvider = resolveSelectableProvider(providerStatuses, provider);
    const resolvedModel = resolveAppModelSelection(
      resolvedProvider,
      modelSettings,
      providerStatuses,
      model,
    );
    const nextModelSelection: ModelSelection = {
      provider: resolvedProvider,
      model: resolvedModel,
    };
    if (resolvedProvider === "cursor") {
      setComposerDraftProviderModelOptions(activeThread.id, "cursor", undefined, {
        persistSticky: true,
      });
    }
    setComposerDraftModelSelection(activeThread.id, nextModelSelection);
    setStickyComposerModelSelection(nextModelSelection);
    scheduleComposerFocus();
  });
  const setPromptFromTraits = useCallback(
    (nextPrompt: string) => {
      const currentPrompt = promptRef.current;
      if (nextPrompt === currentPrompt) {
        scheduleComposerFocus();
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTriggerWithDismissal(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [detectComposerTriggerWithDismissal, scheduleComposerFocus, setPrompt],
  );
  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { envMode: mode });
      }
      scheduleComposerFocus();
    },
    [isLocalDraftThread, scheduleComposerFocus, setDraftThreadContext, threadId],
  );

  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string },
    ): boolean => {
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInput) {
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingUserInput.requestId]: {
            ...existing[activePendingUserInput.requestId],
            [activePendingQuestion.id]: setPendingUserInputCustomAnswer(
              existing[activePendingUserInput.requestId]?.[activePendingQuestion.id],
              next.text,
            ),
          },
        }));
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        detectComposerTriggerWithDismissal(
          next.text,
          expandCollapsedComposerCursor(next.text, nextCursor),
        ),
      );
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCursor);
      });
      return true;
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      detectComposerTriggerWithDismissal,
      setPrompt,
    ],
  );

  const readComposerSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    };
  }, [composerCursor, composerTerminalContexts]);

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: detectComposerTriggerWithDismissal(snapshot.value, snapshot.expandedCursor),
    };
  }, [detectComposerTriggerWithDismissal, readComposerSnapshot]);

  const onSelectComposerItem = useEffectEvent((item: ComposerCommandItem) => {
    if (composerSelectLockRef.current) return;
    composerSelectLockRef.current = true;
    window.requestAnimationFrame(() => {
      composerSelectLockRef.current = false;
    });
    const { snapshot, trigger } = resolveActiveComposerTrigger();
    if (!trigger) return;
    if (item.type === "path") {
      const replacement = `@${item.path} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        setComposerHighlightedItemId(null);
      }
      return;
    }
    if (item.type === "issue") {
      const replacement = `${createMarkedIssueReferenceToken(item.issueNumber)} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        setComposerHighlightedItemId(null);
      }
      return;
    }
    if (item.type === "slash-command") {
      if (item.command === "model" || item.command === "issues") {
        const replacement = item.command === "model" ? "/model " : "/issues ";
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          {
            expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
          },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
      const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
        expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
      });
      if (applied) {
        setComposerHighlightedItemId(null);
      }
      return;
    }
    onProviderModelSelect(item.provider, item.model);
    const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
      expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
    });
    if (applied) {
      setComposerHighlightedItemId(null);
    }
  });
  const onComposerMenuItemHighlighted = useCallback((itemId: string | null) => {
    setComposerHighlightedItemId(itemId);
  }, []);
  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) {
        return;
      }
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [composerHighlightedItemId, composerMenuItems],
  );
  const isComposerMenuLoading =
    (composerTriggerKind === "path" &&
      ((pathTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
        workspaceEntriesQuery.isLoading ||
        workspaceEntriesQuery.isFetching)) ||
    (composerTriggerKind === "issue" &&
      (issueTriggerLookupQuery.isLoading || issueTriggerLookupQuery.isFetching));
  const showIssuesCommandExamplesHint =
    !isComposerApprovalState &&
    pendingUserInputs.length === 0 &&
    /^\/issues\s*$/i.test(prompt.trimStart());
  const showIssuesCommandExamplesPopover = showIssuesCommandExamplesHint && !composerMenuOpen;

  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      terminalContextIds: string[],
    ) => {
      if (activePendingProgress?.activeQuestion && activePendingUserInput) {
        onChangeActivePendingUserInputCustomAnswer(
          activePendingProgress.activeQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
        setComposerDraftTerminalContexts(
          threadId,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        );
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention
          ? null
          : detectComposerTriggerWithDismissal(nextPrompt, expandedCursor),
      );
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      composerTerminalContexts,
      detectComposerTriggerWithDismissal,
      onChangeActivePendingUserInputCustomAnswer,
      setPrompt,
      setComposerDraftTerminalContexts,
      threadId,
    ],
  );

  const onComposerCommandKey = useEffectEvent(
    (key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Escape", event: KeyboardEvent) => {
      if (key === "Tab" && event.shiftKey) {
        toggleInteractionMode();
        return true;
      }

      const { trigger } = resolveActiveComposerTrigger();
      const menuIsActive = composerMenuOpenRef.current || trigger !== null;
      if (key === "Escape" && menuIsActive) {
        const dismissedTrigger = trigger ?? composerTrigger;
        if (dismissedTrigger) {
          dismissedComposerTriggerRef.current = {
            kind: dismissedTrigger.kind,
            rangeStart: dismissedTrigger.rangeStart,
          };
        }
        setComposerTrigger(null);
        setComposerHighlightedItemId(null);
        return true;
      }

      if (menuIsActive) {
        const currentItems = composerMenuItemsRef.current;
        if (key === "ArrowDown" && currentItems.length > 0) {
          nudgeComposerMenuHighlight("ArrowDown");
          return true;
        }
        if (key === "ArrowUp" && currentItems.length > 0) {
          nudgeComposerMenuHighlight("ArrowUp");
          return true;
        }
        if (key === "Tab" || key === "Enter") {
          const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
          if (selectedItem) {
            onSelectComposerItem(selectedItem);
            return true;
          }
        }
      }

      if (key === "Enter" && !event.shiftKey) {
        void onSend();
        return true;
      }
      return false;
    },
  );
  const onToggleWorkGroup = useCallback((groupId: string) => {
    setExpandedWorkGroups((existing) => ({
      ...existing,
      [groupId]: !existing[groupId],
    }));
  }, []);
  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const expandedImageItem = expandedImage ? expandedImage.images[expandedImage.index] : null;
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      setRightSidePanelDiffOpenState(true);
      setRightSidePanelReviewOpen(true);
      setRightSidePanelMode("diff");
      setRightSidePanelVisible(true);
      setLocalDiffState({ open: true, turnId, filePath: filePath ?? null });
    },
    [
      setLocalDiffState,
      setRightSidePanelDiffOpenState,
      setRightSidePanelMode,
      setRightSidePanelReviewOpen,
      setRightSidePanelVisible,
    ],
  );
  const onRevertUserMessage = useCallback(
    (messageId: MessageId) => {
      const targetTurnCount = revertTurnCountByUserMessageId.get(messageId);
      if (typeof targetTurnCount !== "number") {
        return;
      }
      void onRevertToTurnCount(targetTurnCount);
    },
    [onRevertToTurnCount, revertTurnCountByUserMessageId],
  );
  const onFixGitHubIssue = useCallback(
    async (payload: { prompt: string; images: ComposerImageAttachment[] }) => {
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
    },
    [
      activePendingApproval,
      activePendingProgress,
      activeThread,
      closeGitHubIssueDialog,
      dispatchComposerMessage,
      interactionMode,
      isConnecting,
      isSendBusy,
      liveTurnInProgress,
      queuePreparedMessage,
      runtimeMode,
      selectedModelSelection,
    ],
  );

  if (!activeThread) {
    return <NewThreadLanding />;
  }

  const isHandoffThread =
    serverThread?.handoff !== undefined || activeThread?.handoff !== undefined;
  const messagesTimelineProps = useMemo(
    () => ({
      hasMessages:
        timelineEntries.length > 0 ||
        (isThreadHistoryLoading && activeThread.messages.length > 0) ||
        isHandoffThread,
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
      activeTurnInProgress: isWorking || !latestTurnSettled,
      activeTurnStartedAt: activeWorkStartedAt,
      scrollContainer: messagesScrollElement,
      timelineEntries,
      completionDividerBeforeEntryId,
      completionSummary,
      turnDiffSummaryByAssistantMessageId,
      expandedWorkGroups,
      onToggleWorkGroup,
      onOpenTurnDiff,
      revertTurnCountByUserMessageId,
      onRevertUserMessage,
      revertActionTitle: checkpointRestoreActionTitle(activeThread.session?.provider),
      isRevertingCheckpoint,
      onImageExpand: onExpandTimelineImage,
      markdownCwd: codingGitCwd ?? undefined,
      onOpenBrowserUrl: isElectron ? openBrowserUrlInNewTab : null,
      resolvedTheme,
      timestampFormat,
      workspaceRoot: activeProject?.cwd ?? undefined,
    }),
    [
      activeProject?.cwd,
      activeThread.messages.length,
      activeThread.session?.provider,
      activeWorkStartedAt,
      completionDividerBeforeEntryId,
      completionSummary,
      expandedWorkGroups,
      codingGitCwd,
      isGitRepo,
      isHandoffThread,
      isRevertingCheckpoint,
      isThreadHistoryLoading,
      isWorking,
      latestTurnSettled,
      messagesScrollElement,
      onExpandTimelineImage,
      onOpenTurnDiff,
      onRevertUserMessage,
      onToggleWorkGroup,
      openGitHubIssueDialog,
      openBrowserUrlInNewTab,
      resolvedTheme,
      revertTurnCountByUserMessageId,
      scheduleComposerFocus,
      timelineEntries,
      timestampFormat,
      turnDiffSummaryByAssistantMessageId,
    ],
  );
  const loadingNotice = useMemo(
    () => (isThreadHistoryLoading ? <ThreadHistoryLoadingNotice /> : null),
    [isThreadHistoryLoading],
  );
  const chatMessagesPaneProps = useMemo(
    () => ({
      loadingNotice,
      messagesContainerRef: setMessagesScrollContainerRef,
      messagesTimelineProps,
      onMessagesClickCapture,
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
      timelineKey: `${activeThread.id}:${activeThread.historyLoaded === false ? "lean" : "hydrated"}`,
    }),
    [
      activeThread.historyLoaded,
      activeThread.id,
      loadingNotice,
      messagesTimelineProps,
      onMessagesClickCapture,
      onMessagesPointerCancel,
      onMessagesPointerDown,
      onMessagesPointerUp,
      onMessagesScroll,
      onMessagesTouchEnd,
      onMessagesTouchMove,
      onMessagesTouchStart,
      onMessagesWheel,
      scrollMessagesToBottom,
      setMessagesScrollContainerRef,
      showScrollToBottom,
    ],
  );
  const branchToolbarProps = isGitRepo
    ? {
        threadId: activeThread.id,
        onEnvModeChange,
        envLocked,
        localEnvironmentLabel: activeRemoteHost?.name ?? "Local",
        localEnvironmentIcon: activeEnvironmentIcon,
        runtimeMode,
        onRuntimeModeChange: handleRuntimeModeChange,
        onComposerFocusRequest: scheduleComposerFocus,
        ...(canCheckoutPullRequestIntoThread
          ? { onCheckoutPullRequestRequest: openPullRequestDialog }
          : {}),
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
  const browserPanel =
    isElectron && activeThreadId
      ? (() => {
          const orderedBrowserThreadIds = [
            ...(browserOpen ? [activeThreadId] : []),
            ...mountedBrowserThreadIds.filter(
              (browserThreadId) => browserThreadId !== activeThreadId,
            ),
          ].slice(0, MAX_CACHED_BROWSER_INSTANCES);
          if (orderedBrowserThreadIds.length === 0) {
            return null;
          }
          const browserViewMode: InAppBrowserMode = browserMode === "full" ? "full" : "split";
          return {
            mode: browserViewMode,
            splitWidth: browserSplitWidth,
            onResizeKeyDown: handleBrowserSplitResizeKeyDown,
            onResizePointerDown: handleBrowserSplitResizePointerDown,
            instances: orderedBrowserThreadIds.map((browserThreadId) => {
              const isActiveBrowserThread = browserThreadId === activeThreadId;
              const browserConnectionUrl = resolveBrowserThreadConnectionUrl(browserThreadId);
              return {
                key: browserThreadId,
                inAppBrowserProps: {
                  open: true,
                  activeInstance: isActiveBrowserThread && browserOpen,
                  connectionUrl: browserConnectionUrl,
                  visible: isActiveBrowserThread && browserOpen,
                  mode: browserViewMode,
                  onClose: closeBrowser,
                  onBrowserSessionChange: (session: BrowserSessionStorage) => {
                    onBrowserSessionChange(browserThreadId, session);
                  },
                  onControllerChange: getBrowserControllerChangeHandler(browserThreadId),
                  onActiveRuntimeStateChange: getBrowserRuntimeStateChangeHandler(browserThreadId),
                  backShortcutLabel: browserBackShortcutLabel,
                  designerAreaCommentShortcutLabel: browserDesignerAreaCommentShortcutLabel,
                  designerCursorShortcutLabel: browserDesignerCursorShortcutLabel,
                  designerDrawCommentShortcutLabel: browserDesignerDrawCommentShortcutLabel,
                  designerElementCommentShortcutLabel: browserDesignerElementCommentShortcutLabel,
                  devToolsShortcutLabel: browserDevToolsShortcutLabel,
                  forwardShortcutLabel: browserForwardShortcutLabel,
                  reloadShortcutLabel: browserReloadShortcutLabel,
                  scopeId: browserThreadId,
                  onQueueDesignRequest: queueBrowserDesignRequest,
                },
              };
            }),
          };
        })()
      : null;
  const terminalDrawerProps =
    terminalState.terminalOpen && activeProject
      ? {
          threadId: activeThread.id,
          cwd: gitCwd ?? activeProject.cwd,
          runtimeEnv: threadTerminalRuntimeEnv,
          height: terminalState.terminalHeight,
          sidebarWidth: terminalState.terminalSidebarWidth,
          sidebarDensity: terminalState.terminalSidebarDensity,
          terminalIds: terminalState.terminalIds,
          activeTerminalId: terminalState.activeTerminalId,
          terminalGroups: terminalState.terminalGroups,
          activeTerminalGroupId: terminalState.activeTerminalGroupId,
          runningTerminalIds: terminalState.runningTerminalIds,
          customTerminalTitlesById: terminalState.customTerminalTitlesById,
          autoTerminalTitlesById: terminalState.autoTerminalTitlesById,
          terminalIconsById: terminalState.terminalIconsById,
          terminalColorsById: terminalState.terminalColorsById,
          splitRatiosByGroupId: terminalState.splitRatiosByGroupId,
          focusRequestId: terminalFocusRequestId,
          onSplitTerminal: splitTerminal,
          onUnsplitTerminal: unsplitTerminal,
          onNewTerminal: createNewTerminal,
          splitShortcutLabel: splitTerminalShortcutLabel ?? undefined,
          newShortcutLabel: newTerminalShortcutLabel ?? undefined,
          closeShortcutLabel: closeTerminalShortcutLabel ?? undefined,
          onActiveTerminalChange: activateTerminal,
          onMoveTerminal: moveTerminal,
          onDuplicateTerminal: duplicateTerminal,
          onRenameTerminal: renameTerminal,
          onClearTerminal: clearTerminal,
          onClearAllTerminals: clearAllTerminals,
          onRestartTerminal: restartTerminal,
          onCloseAllTerminals: closeAllTerminals,
          onAutoTerminalTitleChange: setTerminalAutoTitle,
          onTerminalIconChange: setTerminalIcon,
          onTerminalColorChange: setTerminalColor,
          onSplitRatiosChange: setTerminalGroupSplitRatios,
          onCloseTerminal: closeTerminal,
          onHeightChange: setTerminalHeight,
          onSidebarWidthChange: setTerminalSidebarWidth,
          onSidebarDensityChange: setTerminalSidebarDensity,
          onAddTerminalContext: addTerminalContextToDraft,
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
  const requestedRightSidePanelMode: RightSidePanelMode | null = rightSidePanelOpen
    ? (rightSidePanelMode ?? (diffOpen ? "diff" : null))
    : null;
  const activeRightSidePanelMode =
    requestedRightSidePanelMode === "browser" && !browserPanel ? null : requestedRightSidePanelMode;
  const activeRightPanelBrowserSession =
    browserOpen && activeThreadId ? (browserSessionByThreadId[activeThreadId] ?? null) : null;
  const activeRightPanelBrowserTabId = activeRightPanelBrowserSession?.activeTabId ?? null;

  const handleComposerImagePreview = useCallback(
    (imageId: string) => {
      const preview = buildExpandedImagePreview(composerImages, imageId);
      if (!preview) {
        return;
      }
      setExpandedImage(preview);
    },
    [composerImages],
  );
  const handleQueueComposerMessage = useCallback(() => {
    queueCurrentComposerMessage(liveTurnInProgress ? "steer" : "queue");
  }, [liveTurnInProgress, queueCurrentComposerMessage]);
  const handleComposerSubmit = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    void onSend(event);
  }, []);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Persistent top bar — always visible regardless of workspace mode */}
      <div
        className={cn(
          "overflow-hidden transition-[max-height,opacity] duration-200 ease-out",
          isHeaderHidden ? "max-h-0 opacity-0" : "max-h-28 opacity-100",
        )}
      >
        <AppPageTopBar
          className={cn(
            "after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-px after:origin-right after:bg-border/70 after:transition-[opacity,transform] after:duration-300 after:ease-[cubic-bezier(0.16,1,0.3,1)]",
            rightSidePanelOpen
              ? "after:scale-x-100 after:opacity-100"
              : "after:scale-x-0 after:opacity-0",
          )}
          showSidebarTrigger={showSidebarTrigger}
        >
          <ChatHeader
            activeThreadId={activeThread.id}
            activeThreadTitle={activeThread.title}
            activeProjectId={activeProject?.id ?? null}
            activeProjectName={activeProject?.name}
            isGitRepo={isGitRepo}
            activeProjectScripts={activeProject?.scripts}
            preferredScriptId={
              activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
            }
            keybindings={keybindings}
            terminalAvailable={activeProject !== undefined}
            terminalOpen={terminalState.terminalOpen}
            terminalToggleShortcutLabel={terminalToggleShortcutLabel}
            rightSidePanelToggleShortcutLabel={rightSidePanelToggleShortcutLabel}
            gitCwd={gitCwd}
            activePlanProgress={activePlanProgress}
            isAgentWorking={isWorking}
            workspaceChangeStat={workspaceChangeStat}
            rightSidePanelOpen={rightSidePanelOpen}
            workspaceMode={headerWorkspaceMode}
            onRunProjectScript={(script) => {
              void runProjectScript(script);
            }}
            onAddProjectScript={saveProjectScript}
            onUpdateProjectScript={updateProjectScript}
            onDeleteProjectScript={deleteProjectScript}
            onActiveProjectChange={isLocalDraftThread ? handleActiveProjectChange : null}
            onToggleTerminal={toggleTerminalVisibility}
            onToggleRightSidePanel={onToggleRightSidePanel}
            onWorkspaceModeChange={onWorkspaceModeChange}
          />
        </AppPageTopBar>
      </div>

      <ProviderStatusBanner status={activeProviderStatus} />

      {/* Error banner */}
      <ThreadErrorBanner
        error={activeThread.error}
        onDismiss={() => dismissThreadError(activeThread.id)}
      />
      {/* Main content area with optional plan sidebar */}
      <div ref={chatViewportRef} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
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
                      <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr]">
                        <div className="border-r border-border/60 bg-foreground/3" />
                        <div className="bg-background" />
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
                    browserOpen={browserOpen}
                    workspaceMode={workspaceMode}
                    terminalOpen={terminalState.terminalOpen}
                    threadId={activeThread.id}
                    worktreePath={activeThread.worktreePath ?? null}
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
                  {/* Messages Wrapper */}
                  <ChatMessagesPane {...chatMessagesPaneProps} />

                  <ChatComposerPanel
                    threadId={threadId}
                    isGitRepo={isGitRepo}
                    isDragOverComposer={isDragOverComposer}
                    hasComposerHeader={hasComposerHeader}
                    isComposerApprovalState={isComposerApprovalState}
                    isComposerFooterCompact={isComposerFooterCompact}
                    isComposerPrimaryActionsCompact={isComposerPrimaryActionsCompact}
                    isComposerMenuLoading={isComposerMenuLoading}
                    composerMenuOpen={composerMenuOpen}
                    showIssuesCommandExamplesPopover={showIssuesCommandExamplesPopover}
                    isConnecting={isConnecting}
                    isPreparingWorktree={isPreparingWorktree}
                    liveTurnInProgress={liveTurnInProgress}
                    isSendBusy={isSendBusy}
                    showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                    prompt={prompt}
                    composerCursor={composerCursor}
                    composerTriggerKind={composerTriggerKind}
                    composerMenuItems={composerMenuItems}
                    activeComposerMenuItemId={activeComposerMenuItem?.id ?? null}
                    composerImages={composerImages}
                    nonPersistedComposerImageIdSet={nonPersistedComposerImageIdSet}
                    composerTerminalContexts={composerTerminalContexts}
                    queuedComposerMessages={queuedComposerMessages}
                    queuedSteerMessageId={queuedSteerRequest?.messageId ?? null}
                    composerProviderState={composerProviderState}
                    selectedProvider={selectedProvider}
                    selectedModel={selectedModel}
                    selectedProviderModels={selectedProviderModels}
                    selectedProviderModelOptions={composerModelOptions?.[selectedProvider]}
                    selectedModelForPickerWithCustomFallback={
                      selectedModelForPickerWithCustomFallback
                    }
                    lockedProvider={lockedProvider}
                    providers={providerStatuses}
                    modelOptionsByProvider={modelOptionsByProvider}
                    isServerThread={isServerThread}
                    handoffTargetProviders={handoffTargetProviders}
                    handoffDisabled={handoffDisabled}
                    interactionMode={interactionMode}
                    runtimeMode={runtimeMode}
                    activeContextWindow={activeContextWindow}
                    promptHasText={prompt.trim().length > 0}
                    hasSendableContent={composerSendState.hasSendableContent}
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
                    planFollowUpId={activeProposedPlan?.id ?? null}
                    planFollowUpTitle={
                      activeProposedPlan
                        ? (proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null)
                        : null
                    }
                    resolvedTheme={resolvedTheme}
                    composerFormRef={composerFormRef}
                    composerEditorRef={composerEditorRef}
                    composerFooterRef={composerFooterRef}
                    composerFooterLeadingRef={composerFooterLeadingRef}
                    composerFooterActionsRef={composerFooterActionsRef}
                    onSubmit={handleComposerSubmit}
                    onComposerDragEnter={onComposerDragEnter}
                    onComposerDragOver={onComposerDragOver}
                    onComposerDragLeave={onComposerDragLeave}
                    onComposerDrop={onComposerDrop}
                    onHighlightedItemChange={onComposerMenuItemHighlighted}
                    onSelectComposerItem={onSelectComposerItem}
                    onEditQueuedComposerMessage={onEditQueuedComposerMessage}
                    onDeleteQueuedComposerMessage={removeQueuedComposerMessage}
                    onClearQueuedComposerMessages={clearQueuedComposerMessages}
                    onSteerQueuedComposerMessage={onSteerQueuedComposerMessage}
                    onPreviewComposerImage={handleComposerImagePreview}
                    onRemoveComposerImage={removeComposerImage}
                    onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                    onPromptChange={onPromptChange}
                    onCommandKeyDown={onComposerCommandKey}
                    onIssueTokenClick={onComposerIssueTokenClick}
                    onPaste={onComposerPaste}
                    onRespondToApproval={onRespondToApproval}
                    onSelectPendingUserInputOption={onSelectActivePendingUserInputOption}
                    onAdvancePendingUserInput={onAdvanceActivePendingUserInput}
                    onProviderModelSelect={onProviderModelSelect}
                    onHandoffToProvider={onHandoffToProvider}
                    onToggleInteractionMode={toggleInteractionMode}
                    onRuntimeModeChange={handleRuntimeModeChange}
                    onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                    onInterrupt={onInterrupt}
                    onImplementPlanInNewThread={onImplementPlanInNewThread}
                    onQueueMessage={handleQueueComposerMessage}
                    onPromptChangeFromTraits={setPromptFromTraits}
                  />

                  <ChatConversationExtras
                    branchToolbarProps={branchToolbarProps}
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
                        if (!open) setIssuePreviewNumber(null);
                      }}
                    />
                  ) : null}
                </div>
                {workspaceMode === "split" && !editorHostedInRightPanel ? (
                  <motion.div
                    key="workspace-split-editor"
                    className="flex h-full min-h-0 shrink-0 overflow-hidden"
                    initial={{ width: 0, opacity: 0, x: 18 }}
                    animate={{ width: "auto", opacity: 1, x: 0 }}
                    transition={WORKSPACE_SIDE_PANEL_TRANSITION}
                  >
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="Resize workspace editor panel"
                      className="group relative z-20 w-3 shrink-0 cursor-col-resize touch-none select-none"
                      onPointerDown={handleWorkspaceEditorSplitResizePointerDown}
                    >
                      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/80 transition-colors group-hover:bg-primary/55" />
                      <div className="absolute inset-y-0 left-1/2 w-2 -translate-x-1/2 rounded-full bg-transparent group-hover:bg-primary/10" />
                    </div>
                    <div
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
                            <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr]">
                              <div className="border-r border-border/60 bg-foreground/3" />
                              <div className="bg-background" />
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
                          browserOpen={browserOpen}
                          workspaceMode={workspaceMode}
                          terminalOpen={terminalState.terminalOpen}
                          threadId={activeThread.id}
                          worktreePath={activeThread.worktreePath ?? null}
                        />
                      </Suspense>
                    </div>
                  </motion.div>
                ) : null}
              </div>
            )}
          </>
        </div>
        {/* end chat column */}

        <AnimatePresence initial={false}>
          {activeRightSidePanelMode ? (
            <motion.div
              key="thread-right-side-panel"
              className={cn(
                "flex h-full min-h-0 transform-gpu overflow-hidden bg-background will-change-[width,transform,opacity]",
                rightSidePanelFullscreen ? "absolute inset-y-0 right-0 z-40" : "relative shrink-0",
              )}
              initial={{ width: 0, opacity: 0, x: 24 }}
              animate={{
                width: rightSidePanelFullscreen
                  ? "100%"
                  : constrainedPanelWidth(
                      rightSidePanelWidth,
                      MIN_RIGHT_SIDE_PANEL_CHAT_WIDTH,
                      MIN_RIGHT_SIDE_PANEL_WIDTH,
                    ),
                opacity: 1,
                x: 0,
              }}
              exit={{ width: 0, opacity: 0, x: 24 }}
              transition={RIGHT_SIDE_PANEL_TRANSITION}
            >
              {!rightSidePanelFullscreen ? (
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize right side panel"
                  tabIndex={0}
                  className="group relative z-20 w-3 shrink-0 cursor-col-resize touch-none select-none outline-none"
                  onKeyDown={handleRightSidePanelResizeKeyDown}
                  onPointerDown={handleRightSidePanelResizePointerDown}
                >
                  <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/75 transition-colors duration-200 ease-out group-hover:bg-border group-focus-visible:bg-border" />
                  <div className="absolute inset-y-1 left-1/2 w-2 -translate-x-1/2 rounded-full bg-transparent transition-[background-color,transform] duration-200 ease-out group-hover:scale-x-100 group-hover:bg-foreground/5 group-focus-visible:scale-x-100 group-focus-visible:bg-foreground/5" />
                </div>
              ) : null}
              <motion.div
                className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 6 }}
                transition={RIGHT_SIDE_PANEL_CONTENT_TRANSITION}
              >
                <RightSidePanelTabStrip
                  activeMode={activeRightSidePanelMode}
                  activeBrowserTabId={activeRightPanelBrowserTabId}
                  browserSession={activeRightPanelBrowserSession}
                  browserAvailable={isElectron}
                  browserShortcutLabel={browserNewTabShortcutLabel}
                  diffAvailable={isGitRepo}
                  editorShortcutLabel={rightPanelEditorShortcutLabel}
                  editorOpen={rightSidePanelEditorOpen}
                  fullscreen={rightSidePanelFullscreen}
                  reviewShortcutLabel={reviewPanelShortcutLabel}
                  reviewOpen={rightSidePanelReviewOpen}
                  onBrowserTabClose={onCloseRightSidePanelBrowserTab}
                  onBrowserTabReorder={onReorderRightSidePanelBrowserTab}
                  onBrowserTabSelect={onSelectRightSidePanelBrowserTab}
                  onDiffClose={onCloseRightSidePanelDiff}
                  onEditorClose={onCloseRightSidePanelEditor}
                  onNewBrowserTab={onOpenRightSidePanelBrowserTab}
                  onSelectMode={onSelectRightSidePanelMode}
                  onToggleFullscreen={onToggleRightSidePanelFullscreen}
                />
                <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
                  <AnimatePresence mode="wait" initial={false}>
                    {activeRightSidePanelMode !== "browser" ? (
                      <motion.div
                        key={`thread-right-side-panel-content-${activeRightSidePanelMode}`}
                        className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
                        initial={{ opacity: 0, x: 8 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -6 }}
                        transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                      >
                        {activeRightSidePanelMode === "summary" ? (
                          <PlanSummaryPanel
                            activePlan={activePlan}
                            activeProposedPlan={sidebarProposedPlan}
                            activeProvider={activeThread?.session?.provider ?? null}
                            markdownCwd={gitCwd ?? undefined}
                            onOpenBrowserUrl={isElectron ? openBrowserUrlInNewTab : null}
                            workspaceRoot={activeProject?.cwd ?? undefined}
                          />
                        ) : activeRightSidePanelMode === "diff" ? (
                          <LocalDiffPanel
                            threadId={activeThread.id}
                            diffState={localDiffState}
                            onDiffStateChange={setLocalDiffState}
                          />
                        ) : activeRightSidePanelMode === "editor" ? (
                          <Suspense
                            fallback={
                              <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
                                <div className="border-b border-border/60 px-4 py-3">
                                  <div className="h-5 w-44 rounded bg-foreground/6" />
                                </div>
                                <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr]">
                                  <div className="border-r border-border/60 bg-foreground/3" />
                                  <div className="bg-background" />
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
                              browserOpen={browserOpen}
                              workspaceMode="split"
                              terminalOpen={terminalState.terminalOpen}
                              threadId={activeThread.id}
                              worktreePath={activeThread.worktreePath ?? null}
                            />
                          </Suspense>
                        ) : null}
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                  {browserPanel ? (
                    <div
                      className={cn(
                        "absolute inset-0 min-h-0 min-w-0",
                        activeRightSidePanelMode === "browser"
                          ? "z-10"
                          : "pointer-events-none invisible z-0",
                      )}
                    >
                      {browserPanel.instances.map((instance) => (
                        <InAppBrowser key={instance.key} {...instance.inAppBrowserProps} />
                      ))}
                    </div>
                  ) : null}
                </div>
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <ChatViewPanels browserPanel={null} expandedImageOverlay={expandedImageOverlay} />
      </div>
      {/* end horizontal flex container */}

      <AnimatePresence initial={false}>
        {terminalDrawerProps ? (
          <motion.div
            key={terminalState.terminalOpen && activeProject ? activeProject.id : "terminal"}
            className="min-w-0 shrink-0 overflow-hidden"
            initial={{ height: 0, opacity: 0, y: 18 }}
            animate={{ height: "auto", opacity: 1, y: 0 }}
            exit={{ height: 0, opacity: 0, y: 18 }}
            transition={TERMINAL_DRAWER_TRANSITION}
          >
            <ThreadTerminalDrawer {...terminalDrawerProps} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
