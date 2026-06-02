import {
  type ApprovalRequestId,
  type ClientOrchestrationCommand,
  type CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  type MessageId,
  type ModelSelection,
  type ProjectScript,
  type ProviderKind,
  type ProjectId,
  type ProviderApprovalDecision,
  type ServerProvider,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ThreadHandoffMode,
  ThreadId,
  TrimmedNonEmptyString,
  type TurnId,
  type KeybindingCommand,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  RuntimeMode,
  TerminalOpenInput,
} from "@ace/contracts";
import * as Schema from "effect/Schema";
import { buildProviderModelSelection } from "@ace/shared/model";
import {
  mergeProviderSlashCommands,
  providerFallbackSlashCommands,
} from "@ace/shared/providerSlashCommands";
import { truncate } from "@ace/shared/String";
import { DEFAULT_UNIFIED_SETTINGS } from "@ace/contracts/settings";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ComponentProps,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  Profiler,
  Suspense,
  lazy,
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { AnimatePresence, LazyMotion, domAnimation, m } from "motion/react";
import {
  DiffIcon,
  FolderIcon,
  GlobeIcon,
  ListTodoIcon,
  SquareTerminalIcon,
  type LucideIcon,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import {
  gitBranchesQueryOptions,
  gitCreateWorktreeMutationOptions,
  gitStatusQueryOptions,
} from "~/lib/gitReactQuery";
import { isElectron } from "../env";
import { parseDiffRouteSearch } from "../diffRouteSearch";
import {
  normalizeThreadWorkspaceLayoutMode,
  type ThreadWorkspaceMode,
} from "../threadWorkspaceMode";
import {
  collapseExpandedComposerCursor,
  parseComposerIssuesCommand,
  parseProviderComposerSlashCommand,
  parseStandaloneComposerSlashCommand,
} from "../composer-logic";
import {
  extractIssueReferenceNumbers,
  stripComposerInlineMarkers,
} from "../composer-editor-mentions";
import {
  deriveCompletionDividerBeforeEntryId,
  derivePhase,
  deriveActiveWorkStartedAt,
  deriveVisibleWorkTurnId,
  deriveActivePlanState,
  deriveLatestGeneratedWorkspaceSummary,
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
import {
  useHostConnectionStore,
  useProjectConnectionUrl,
  useThreadConnectionUrl,
} from "../hostConnectionStore";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  proposedPlanTitle,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import { shouldEscalateInterruptToSessionStop } from "../lib/chat/interruptFallback";
import { BOTTOM_PANEL_SPRING_TRANSITION, PANEL_SPRING_TRANSITION } from "../lib/panelMotion";
import { getDefaultServerModel } from "../providerModels";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
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
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useTheme } from "../hooks/useTheme";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
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
import { reportBackgroundError } from "~/lib/async";
import {
  isRenderProfilingEnabled,
  measureRenderWork,
  recordReactRenderProfile,
} from "~/lib/renderProfiling";
import {
  deriveTerminalTitleFromCommand,
  resolveTerminalDisplayTitle,
} from "~/lib/terminalPresentation";
import { useSetting } from "../hooks/useSettings";
import { getProviderModels, resolveSelectableProvider } from "../providerModels";
import { isTerminalFocused } from "../lib/terminalFocus";
import {
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  type ModelSelectionByProvider,
  deriveEffectiveComposerExecutionModeState,
  deriveEffectiveComposerModelState,
  getComposerThreadDraft,
  getComposerThreadDraftState,
  useComposerDraftStore,
} from "../composerDraftStore";
import {
  appendBrowserDesignContextToPrompt,
  appendTerminalContextsToPrompt,
  buildBrowserDesignContextBlock,
  deriveDisplayedUserMessageState,
  formatTerminalContextLabel,
  insertInlineTerminalContextPlaceholder,
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
import { THREAD_ROUTE_CONNECTION_SEARCH_PARAM } from "../lib/connectionRouting";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useEditorStateStore } from "../editorStateStore";
import { ChatHeader } from "./chat/ChatHeader";
import { ChatConversationExtras } from "./chat/ChatConversationExtras";
import { EnvironmentMiniPanel } from "./chat/EnvironmentMiniPanel";
import { GitHubIssuePreviewDialog } from "./GitHubIssuePreviewDialog";
import { ThreadHistoryLoadingNotice } from "./GitHubIssueSkeletons";
import { ChatMessagesPane } from "./chat/ChatMessagesPane";
import { PlanSummaryPanel } from "./PlanSummaryPanel";
import type { DiffReviewCommentInput } from "./DiffPanel";
import { ChatViewPanels } from "./chat/ChatViewPanels";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import { type ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { NewThreadLanding } from "./chat/NewThreadLanding";
import {
  ConnectedChatComposerPanels,
  type ConnectedChatComposerPanelsHandle,
  ConnectedComposerProviderStatusBanner,
} from "./chat/ConnectedChatComposerPanels";
import {
  InAppBrowser,
  type ActiveBrowserRuntimeState,
  type BrowserViewportResizeRequest,
  type BrowserViewportResizeResult,
  type InAppBrowserController,
  type InAppBrowserMode,
} from "./InAppBrowser";
import { LocalDiffPanel, RightSidePanelTabStrip } from "./chat/ChatViewRightSidePanels";
import { SubagentWorkspacePanel } from "./chat/SubagentThreadsPanel";
import { deriveSubagentThreads, type SubagentThread } from "./chat/subagentThreads";
import { useChatViewProviderSelectionState } from "./chat/useChatViewModelState";
import { useChatViewPersistentPanelState } from "./chat/useChatViewPersistentPanelState";
import { getComposerProviderState } from "./chat/composerProviderRegistry";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import { ConnectionHealthPill } from "./reliability/ConnectionHealthPill";
import { ReliabilityDiagnosticsDialog } from "./reliability/ReliabilityDiagnosticsDialog";
import { useConnectionHealth } from "~/lib/reliability/connectionHealth";
import { deriveStuckTurnSnapshot } from "~/lib/reliability/stuckTurn";
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
import {
  buildAccumulatedCommentsPrompt,
  mergePendingCommentImages,
  type PendingComposerComment,
} from "~/lib/chat/commentAccumulation";
import { useThreadPlanCatalog } from "~/lib/chat/threadPlanCatalog";
import { clampBrowserSplitWidth } from "~/lib/chat/browserSplit";
import {
  DEFAULT_RIGHT_SIDE_PANEL_WIDTH,
  MIN_RIGHT_SIDE_PANEL_CHAT_WIDTH,
  MIN_RIGHT_SIDE_PANEL_WIDTH,
  RIGHT_SIDE_PANEL_RESIZE_HANDLE_WIDTH,
  clampRightSidePanelWidth,
  constrainedPanelWidth,
  resolveBrowserOpenRightSidePanelWidth,
} from "~/lib/chat/rightSidePanelWidth";
import {
  MIN_WORKSPACE_CHAT_SPLIT_WIDTH,
  clampWorkspaceEditorSplitWidth,
} from "~/lib/chat/workspaceSplit";
import type { BrowserSessionStorage } from "~/lib/browser/session";
import {
  clearBrowserSessions,
  deleteBrowserSession,
  getBrowserSession,
  setBrowserSession,
  useBrowserSession,
} from "~/lib/browser/sessionStore";
import {
  buildHandoffTimeline,
  type HandoffLineageResult,
  resolveHandoffLineage,
  resolveHandoffSourceProvider,
  resolveThreadLineageSourceThreadId,
} from "~/lib/chat/handoff";
import {
  subscribeToBrowserLaunchRequests,
  takePendingBrowserLaunchRequest,
} from "~/lib/browser/launcher";
import {
  evictExpiredRecentBrowserInstances,
  resolveNextRecentBrowserInstanceExpiry,
  touchRecentBrowserInstance,
  type RecentBrowserInstanceEntry,
} from "~/lib/browser/liveInstanceCache";
import { resolveScopedBrowserStorageKey } from "~/lib/browser/storage";
import {
  RIGHT_SIDE_PANEL_WIDTH_STORAGE_KEY,
  resolveRightSidePanelModeAfterDiffClose,
  shouldApplyThreadBrowserViewportResizeToVisiblePanel,
  type RightSidePanelMode,
} from "~/lib/rightSidePanelState";
import { type BrowserDesignRequestSubmission } from "~/lib/browser/types";
import { useLocalDispatchState } from "~/hooks/useLocalDispatchState";
import { useEffectEvent } from "~/hooks/useEffectEvent";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "~/hooks/useLocalStorage";
import {
  useConnectionServerConfig,
  resolveThreadOriginConnectionUrl,
} from "~/hooks/useConnectionServerProviders";
import { useServerAvailableEditors, useServerKeybindings } from "~/rpc/serverState";
import {
  loadRemoteHostInstances,
  normalizeWsUrl,
  resolveHostConnectionWsUrl,
} from "~/lib/remoteHosts";
import { resolveWorkspaceEditorFilePath } from "~/markdown-links";

const ThreadWorkspaceEditor = lazy(() => import("./editor/ThreadWorkspaceEditor"));

const WORKSPACE_SIDE_PANEL_TRANSITION = {
  opacity: { duration: 0.16, ease: [0.16, 1, 0.3, 1] },
  width: { duration: 0 },
  x: { duration: 0.18, ease: [0.16, 1, 0.3, 1] },
} as const;
const ENVIRONMENT_MINI_PANEL_WIDTH_PX = 288;
const ENVIRONMENT_MINI_PANEL_GAP_PX = 12;
const ENVIRONMENT_MINI_PANEL_RESERVED_WIDTH_PX =
  ENVIRONMENT_MINI_PANEL_WIDTH_PX + ENVIRONMENT_MINI_PANEL_GAP_PX;
const ENVIRONMENT_POPOVER_INTERACTIVE_LAYER_SELECTOR = [
  '[data-slot="combobox-positioner"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="menu-positioner"]',
  '[data-slot="menu-popup"]',
  '[data-slot="popover-positioner"]',
  '[data-slot="popover-popup"]',
  '[data-slot="select-positioner"]',
  '[data-slot="select-popup"]',
].join(",");

function isAbsoluteFilesystemPath(path: string): boolean {
  return /^(?:\/|\\\\|[A-Za-z]:[\\/])/.test(path);
}

function eventTargetIsInsideElement(event: Event, element: HTMLElement | null): boolean {
  if (!element) {
    return false;
  }
  return event.composedPath().includes(element);
}

function eventTargetIsInsideSelector(event: Event, selector: string): boolean {
  const target = event.target;
  if (!(target instanceof Element)) {
    return false;
  }
  return target.closest(selector) !== null;
}

const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;
const CACHED_BROWSER_INSTANCE_TTL_MS = 300_000;

function applyResizablePanelWidth(element: HTMLElement | null, width: number): void {
  if (!element) {
    return;
  }
  const widthPx = `${Math.round(width)}px`;
  element.style.cssText += `;width:${widthPx};min-width:${widthPx};`;
}

function clearResizablePanelWidth(element: HTMLElement | null): void {
  if (!element) {
    return;
  }
  element.style.removeProperty("width");
  element.style.removeProperty("min-width");
}
const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_PROVIDER_STATUSES: ReadonlyArray<ServerProvider> = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const EMPTY_QUEUED_COMPOSER_MESSAGES: Thread["queuedComposerMessages"] = [];
const EMPTY_COMPOSER_MODEL_SELECTIONS: ModelSelectionByProvider = Object.freeze({});
const EMPTY_PENDING_COMPOSER_COMMENTS: readonly PendingComposerComment[] = Object.freeze([]);
const THREAD_SWITCH_SCROLL_SETTLE_DELAY_MS = 96;

const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;
const MIN_BOTTOM_PANEL_HEIGHT = 180;
const MAX_BOTTOM_PANEL_HEIGHT_RATIO = 0.75;
type DockPanelMode = RightSidePanelMode;

interface PanelEditorTab {
  id: string;
  label: string;
}

function createPanelEditorTab(index: number): PanelEditorTab {
  return {
    id: `editor-${randomUUID()}`,
    label: index <= 1 ? "Editor" : `Editor ${index}`,
  };
}

interface PanelChooserOption {
  description: string;
  disabled?: boolean | undefined;
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  shortcutLabel?: string | null | undefined;
}

function PanelChooser(props: { className?: string | undefined; options: PanelChooserOption[] }) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center overflow-auto bg-background px-6 py-8",
        props.className,
      )}
    >
      <div className="flex w-full max-w-[360px] flex-col gap-3">
        {props.options.map((option) => {
          const Icon = option.icon;
          return (
            <button
              key={option.label}
              type="button"
              disabled={option.disabled}
              className={cn(
                "group flex min-h-[116px] w-full flex-col items-center justify-center rounded-lg border border-border/35 bg-card/70 px-5 py-5 text-center transition-colors hover:border-border hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                option.disabled &&
                  "cursor-not-allowed opacity-45 hover:border-border/35 hover:bg-card/70",
              )}
              onClick={option.onSelect}
            >
              <Icon className="mb-3 size-6 text-muted-foreground transition-colors group-hover:text-foreground" />
              <span className="text-[15px] font-semibold text-foreground">{option.label}</span>
              <span className="mt-1 text-[13px] text-muted-foreground">{option.description}</span>
              {option.shortcutLabel ? (
                <span className="mt-3 rounded-md bg-muted px-2 py-0.5 text-[12px] font-medium text-muted-foreground">
                  {option.shortcutLabel}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function maxBottomPanelHeight(): number {
  if (typeof window === "undefined") return DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.max(
    MIN_BOTTOM_PANEL_HEIGHT,
    Math.floor(window.innerHeight * MAX_BOTTOM_PANEL_HEIGHT_RATIO),
  );
}

function clampBottomPanelHeight(height: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.min(
    Math.max(Math.round(safeHeight), MIN_BOTTOM_PANEL_HEIGHT),
    maxBottomPanelHeight(),
  );
}
type ThreadTerminalDrawerProps = ComponentProps<typeof ThreadTerminalDrawer>;

interface RetainedThreadTerminalDrawerEntry {
  readonly threadId: ThreadId;
  readonly props: ThreadTerminalDrawerProps;
}

function upsertRetainedThreadTerminalDrawerEntry(
  entries: readonly RetainedThreadTerminalDrawerEntry[],
  nextEntry: RetainedThreadTerminalDrawerEntry,
): RetainedThreadTerminalDrawerEntry[] {
  const filteredEntries = entries.filter((entry) => entry.threadId !== nextEntry.threadId);
  return [...filteredEntries, nextEntry];
}

// Preserve a small set of recent terminal drawers so thread switches can reuse
// the mounted xterm instance instead of reopening it on every navigation.
function RetainedThreadTerminalDrawers(props: {
  activeThreadId: ThreadId;
  activeDrawerProps: ThreadTerminalDrawerProps | null;
}) {
  const { activeDrawerProps, activeThreadId } = props;
  const [retainedEntries, setRetainedEntries] = useState<RetainedThreadTerminalDrawerEntry[]>([]);
  const previousVisibleEntryRef = useRef<RetainedThreadTerminalDrawerEntry | null>(null);
  const previousVisibleEntry = previousVisibleEntryRef.current;
  const renderEntries = (() => {
    const hiddenEntries = retainedEntries.filter((entry) => entry.threadId !== activeThreadId);
    const nextEntries =
      previousVisibleEntry &&
      previousVisibleEntry.threadId !== activeThreadId &&
      !hiddenEntries.some((entry) => entry.threadId === previousVisibleEntry.threadId)
        ? [...hiddenEntries, previousVisibleEntry]
        : hiddenEntries;

    if (!activeDrawerProps) {
      return nextEntries;
    }

    return [
      ...nextEntries,
      {
        threadId: activeThreadId,
        props: activeDrawerProps,
      },
    ];
  })();

  useEffect(() => {
    const previousEntry = previousVisibleEntryRef.current;
    if (previousEntry && previousEntry.threadId !== activeThreadId) {
      setRetainedEntries((currentEntries) =>
        upsertRetainedThreadTerminalDrawerEntry(currentEntries, previousEntry),
      );
    }
    if (activeDrawerProps === null) {
      setRetainedEntries((currentEntries) => {
        const nextEntries = currentEntries.filter((entry) => entry.threadId !== activeThreadId);
        return nextEntries.length === currentEntries.length ? currentEntries : nextEntries;
      });
    }
    previousVisibleEntryRef.current = activeDrawerProps
      ? {
          threadId: activeThreadId,
          props: activeDrawerProps,
        }
      : null;
  }, [activeDrawerProps, activeThreadId]);

  return (
    <m.div
      className="min-w-0 shrink-0 overflow-hidden"
      initial={false}
      animate={
        activeDrawerProps ? { height: "auto", opacity: 1, y: 0 } : { height: 0, opacity: 0, y: 18 }
      }
      transition={PANEL_SPRING_TRANSITION}
    >
      {renderEntries.map((entry) => {
        const isActive = activeDrawerProps !== null && entry.threadId === activeThreadId;
        return (
          <div
            key={entry.threadId}
            className={isActive ? "min-w-0" : "hidden"}
            aria-hidden={!isActive}
          >
            <ThreadTerminalDrawer {...(isActive ? activeDrawerProps : entry.props)} />
          </div>
        );
      })}
    </m.div>
  );
}

interface ConnectedRetainedThreadTerminalDrawersProps {
  activeThreadId: ThreadId;
  activeProjectAvailable: boolean;
  cwd: string | null;
  runtimeEnv: Record<string, string> | undefined;
  focusRequestId: number;
  interactive: boolean;
  newShortcutLabel?: string | undefined;
  toggleShortcutLabel?: string | undefined;
  onNewTerminal: () => void;
  onActiveTerminalChange: (terminalId: string) => void;
  onMoveTerminal: (terminalId: string, targetGroupId: string, targetIndex: number) => void;
  onSplitRatiosChange: (groupId: string, ratios: number[]) => void;
  onAutoTerminalTitleChange: (terminalId: string, title: string | null) => void;
  onCloseTerminal: (terminalId: string) => void;
  onToggleTerminal: () => void;
  onHeightChange: (height: number) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

interface ConnectedThreadTerminalPanelProps extends ConnectedRetainedThreadTerminalDrawersProps {
  onClosePanelTerminal: () => void;
}

function ConnectedRetainedThreadTerminalDrawers({
  activeThreadId,
  activeProjectAvailable,
  cwd,
  runtimeEnv,
  focusRequestId,
  interactive,
  newShortcutLabel,
  toggleShortcutLabel,
  onNewTerminal,
  onActiveTerminalChange,
  onMoveTerminal,
  onSplitRatiosChange,
  onAutoTerminalTitleChange,
  onCloseTerminal,
  onToggleTerminal,
  onHeightChange,
  onAddTerminalContext,
}: ConnectedRetainedThreadTerminalDrawersProps) {
  const terminalDrawerState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, activeThreadId),
  );
  const activeDrawerProps: ThreadTerminalDrawerProps | null =
    terminalDrawerState.terminalOpen && activeProjectAvailable && cwd
      ? {
          threadId: activeThreadId,
          cwd,
          ...(runtimeEnv ? { runtimeEnv } : {}),
          height: terminalDrawerState.terminalHeight,
          terminalIds: terminalDrawerState.terminalIds,
          activeTerminalId: terminalDrawerState.activeTerminalId,
          terminalGroups: terminalDrawerState.terminalGroups,
          runningTerminalIds: terminalDrawerState.runningTerminalIds,
          autoTerminalTitlesById: terminalDrawerState.autoTerminalTitlesById,
          splitRatiosByGroupId: terminalDrawerState.splitRatiosByGroupId,
          focusRequestId,
          interactive,
          onNewTerminal,
          newShortcutLabel,
          toggleShortcutLabel,
          onActiveTerminalChange,
          onMoveTerminal,
          onSplitRatiosChange,
          onAutoTerminalTitleChange,
          onCloseTerminal,
          onToggleTerminal,
          onHeightChange,
          onAddTerminalContext,
        }
      : null;

  return (
    <RetainedThreadTerminalDrawers
      activeThreadId={activeThreadId}
      activeDrawerProps={activeDrawerProps}
    />
  );
}

function ConnectedThreadTerminalPanel({
  activeThreadId,
  activeProjectAvailable,
  cwd,
  runtimeEnv,
  focusRequestId,
  interactive,
  newShortcutLabel,
  toggleShortcutLabel,
  onNewTerminal,
  onActiveTerminalChange,
  onMoveTerminal,
  onSplitRatiosChange,
  onAutoTerminalTitleChange,
  onCloseTerminal,
  onClosePanelTerminal,
  onHeightChange,
  onAddTerminalContext,
}: ConnectedThreadTerminalPanelProps) {
  const terminalDrawerState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, activeThreadId),
  );

  if (!activeProjectAvailable || !cwd) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-terminal px-4 text-center text-[13px] text-muted-foreground">
        Terminal is unavailable until this thread has an active project.
      </div>
    );
  }

  return (
    <ThreadTerminalDrawer
      threadId={activeThreadId}
      cwd={cwd}
      {...(runtimeEnv ? { runtimeEnv } : {})}
      layout="panel"
      height={terminalDrawerState.terminalHeight}
      terminalIds={terminalDrawerState.terminalIds}
      activeTerminalId={terminalDrawerState.activeTerminalId}
      terminalGroups={terminalDrawerState.terminalGroups}
      runningTerminalIds={terminalDrawerState.runningTerminalIds}
      autoTerminalTitlesById={terminalDrawerState.autoTerminalTitlesById}
      splitRatiosByGroupId={terminalDrawerState.splitRatiosByGroupId}
      focusRequestId={focusRequestId}
      interactive={interactive}
      onNewTerminal={onNewTerminal}
      newShortcutLabel={newShortcutLabel}
      toggleShortcutLabel={toggleShortcutLabel}
      onActiveTerminalChange={onActiveTerminalChange}
      onMoveTerminal={onMoveTerminal}
      onSplitRatiosChange={onSplitRatiosChange}
      onAutoTerminalTitleChange={onAutoTerminalTitleChange}
      onCloseTerminal={onCloseTerminal}
      onToggleTerminal={onClosePanelTerminal}
      onHeightChange={onHeightChange}
      onAddTerminalContext={onAddTerminalContext}
    />
  );
}

const BROWSER_BRIDGE_CONTROLLER_WAIT_MS = 5_000;
const BROWSER_BRIDGE_CONTROLLER_POLL_MS = 50;

async function waitForBrowserBridgeController<TResult>(options: {
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly readController: () => TResult | null;
}): Promise<TResult | null> {
  const deadline = Date.now() + options.timeoutMs;
  const poll = async (): Promise<TResult | null> => {
    const controller = options.readController();
    if (controller !== null) {
      return controller;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, options.pollMs);
    });
    return poll();
  };
  return poll();
}

type QueuedComposerMessage = Thread["queuedComposerMessages"][number];

function describeBrowserDesignCommentTarget(submission: BrowserDesignRequestSubmission): {
  targetLabel: string;
  detailLabel: string | null;
} {
  const targetLabel = submission.pagePath.trim() || submission.pageUrl.trim() || "Browser";
  const targetElement = submission.targetElement ?? submission.mainContainer;
  const textSnippet = targetElement?.textSnippet?.trim();
  const selector = targetElement?.selector?.trim();
  const tagName = targetElement?.tagName?.trim().toLowerCase();
  const detailLabel =
    textSnippet && textSnippet.length > 0
      ? truncate(textSnippet.replace(/\s+/g, " "), 90)
      : selector && selector.length > 0
        ? truncate(selector, 90)
        : tagName && tagName.length > 0
          ? tagName
          : null;
  return { targetLabel, detailLabel };
}

interface ChatViewProps {
  activeInBoard?: boolean;
  connectionUrl?: string | null;
  paneControls?: ReactNode;
  shortcutsEnabled?: boolean;
  showSidebarTrigger?: boolean;
  splitPane?: boolean;
  threadId: ThreadId;
  visibleBoardThreadIds?: ReadonlyArray<ThreadId>;
}

const EMPTY_VISIBLE_BOARD_THREAD_IDS: readonly ThreadId[] = [];

type BrowserPanelInstance = {
  key: ThreadId;
  inAppBrowserProps: ComponentProps<typeof InAppBrowser>;
};

const RetainedBrowserInstances = memo(function RetainedBrowserInstances({
  instances,
}: {
  instances: readonly BrowserPanelInstance[];
}) {
  const content = (
    <>
      {instances.map((instance) => (
        <InAppBrowser key={instance.key} {...instance.inAppBrowserProps} />
      ))}
    </>
  );

  return isRenderProfilingEnabled() ? (
    <Profiler
      id="retained-browser-instances"
      onRender={(_id, phase, actualDuration) => {
        recordReactRenderProfile("retained-browser-instances", phase, actualDuration);
      }}
    >
      {content}
    </Profiler>
  ) : (
    content
  );
}, browserPanelInstancesEqual);

function shallowObjectEqual(left: object, right: object): boolean {
  if (left === right) {
    return true;
  }
  const leftKeys = Object.keys(left) as Array<keyof typeof left>;
  const rightKeys = Object.keys(right) as Array<keyof typeof right>;
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (
      !Object.prototype.hasOwnProperty.call(right, key) ||
      !Object.is(left[key], right[key as keyof typeof right])
    ) {
      return false;
    }
  }
  return true;
}

function browserPanelInstancesEqual(
  previous: { instances: readonly BrowserPanelInstance[] },
  next: { instances: readonly BrowserPanelInstance[] },
): boolean {
  if (previous.instances === next.instances) {
    return true;
  }
  if (previous.instances.length !== next.instances.length) {
    return false;
  }
  return previous.instances.every((previousInstance, index) => {
    const nextInstance = next.instances[index];
    return (
      nextInstance !== undefined &&
      previousInstance.key === nextInstance.key &&
      shallowObjectEqual(previousInstance.inAppBrowserProps, nextInstance.inAppBrowserProps)
    );
  });
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
    const nextResult = state.threadsById
      ? resolveHandoffLineageFromIndex(sourceThreadId, state.threadsById)
      : resolveHandoffLineage({
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

function resolveHandoffLineageFromIndex(
  sourceThreadId: ThreadId,
  threadsById: Readonly<Record<string, Thread>>,
): HandoffLineageResult {
  const lineageNewestFirst: Thread[] = [];
  const visited = new Set<string>();
  let currentThreadId: ThreadId | null = sourceThreadId;

  while (currentThreadId !== null) {
    const thread: Thread | undefined = threadsById[String(currentThreadId)];
    if (!thread) {
      return {
        threads: lineageNewestFirst.toReversed(),
        missingThreadId: currentThreadId,
        hasCycle: false,
      };
    }
    if (visited.has(thread.id)) {
      return {
        threads: lineageNewestFirst.toReversed(),
        missingThreadId: null,
        hasCycle: true,
      };
    }
    visited.add(thread.id);
    lineageNewestFirst.push(thread);
    currentThreadId = resolveThreadLineageSourceThreadId(thread);
  }

  return {
    threads: lineageNewestFirst.toReversed(),
    missingThreadId: null,
    hasCycle: false,
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

type ChatViewDialogState = {
  gitHubIssueDialogOpen: boolean;
  gitHubIssueDialogInitialIssueNumber: number | null;
  gitHubIssueDialogInitialSelectedIssueNumbers: number[];
  issuePreviewNumber: number | null;
  pullRequestDialogState: PullRequestDialogState | null;
  pendingPullRequestSetupRequest: PendingPullRequestSetupRequest | null;
};

type ChatViewDialogAction =
  | {
      type: "open-github-issue-dialog";
      gitHubIssueDialogInitialIssueNumber: number | null;
      gitHubIssueDialogInitialSelectedIssueNumbers: number[];
    }
  | { type: "close-github-issue-dialog" }
  | { type: "set-issue-preview-number"; issuePreviewNumber: number | null }
  | { type: "open-pull-request-dialog"; pullRequestDialogState: PullRequestDialogState }
  | { type: "close-pull-request-dialog" }
  | {
      type: "set-pending-pull-request-setup-request";
      pendingPullRequestSetupRequest: PendingPullRequestSetupRequest | null;
    };

type ChatViewTransientState = {
  localDiffStateByThreadId: Record<ThreadId, LocalDiffState>;
  localDraftErrorsByThreadId: Record<ThreadId, string | null>;
  respondingRequestIds: ApprovalRequestId[];
  respondingUserInputRequestIds: ApprovalRequestId[];
  pendingUserInputAnswersByRequestId: Record<string, Record<string, PendingUserInputDraftAnswer>>;
  pendingUserInputQuestionIndexByRequestId: Record<string, number>;
  expandedWorkGroups: Record<string, boolean>;
  attachmentPreviewHandoffByMessageId: Record<string, string[]>;
  pendingComposerCommentsByThreadId: Record<ThreadId, PendingComposerComment[]>;
};

type ChatViewTransientAction =
  | {
      type: "set-local-diff-state-by-thread-id";
      localDiffStateByThreadId:
        | Record<ThreadId, LocalDiffState>
        | ((current: Record<ThreadId, LocalDiffState>) => Record<ThreadId, LocalDiffState>);
    }
  | {
      type: "set-local-draft-errors-by-thread-id";
      localDraftErrorsByThreadId:
        | Record<ThreadId, string | null>
        | ((current: Record<ThreadId, string | null>) => Record<ThreadId, string | null>);
    }
  | {
      type: "set-responding-request-ids";
      respondingRequestIds:
        | ApprovalRequestId[]
        | ((current: ApprovalRequestId[]) => ApprovalRequestId[]);
    }
  | {
      type: "set-responding-user-input-request-ids";
      respondingUserInputRequestIds:
        | ApprovalRequestId[]
        | ((current: ApprovalRequestId[]) => ApprovalRequestId[]);
    }
  | {
      type: "set-pending-user-input-answers-by-request-id";
      pendingUserInputAnswersByRequestId:
        | Record<string, Record<string, PendingUserInputDraftAnswer>>
        | ((
            current: Record<string, Record<string, PendingUserInputDraftAnswer>>,
          ) => Record<string, Record<string, PendingUserInputDraftAnswer>>);
    }
  | {
      type: "set-pending-user-input-question-index-by-request-id";
      pendingUserInputQuestionIndexByRequestId:
        | Record<string, number>
        | ((current: Record<string, number>) => Record<string, number>);
    }
  | {
      type: "set-expanded-work-groups";
      expandedWorkGroups:
        | Record<string, boolean>
        | ((current: Record<string, boolean>) => Record<string, boolean>);
    }
  | {
      type: "set-attachment-preview-handoff-by-message-id";
      attachmentPreviewHandoffByMessageId:
        | Record<string, string[]>
        | ((current: Record<string, string[]>) => Record<string, string[]>);
    }
  | {
      type: "set-pending-composer-comments-by-thread-id";
      pendingComposerCommentsByThreadId:
        | Record<ThreadId, PendingComposerComment[]>
        | ((
            current: Record<ThreadId, PendingComposerComment[]>,
          ) => Record<ThreadId, PendingComposerComment[]>);
    };

const EMPTY_CHAT_VIEW_DIALOG_STATE: ChatViewDialogState = {
  gitHubIssueDialogOpen: false,
  gitHubIssueDialogInitialIssueNumber: null,
  gitHubIssueDialogInitialSelectedIssueNumbers: [],
  issuePreviewNumber: null,
  pullRequestDialogState: null,
  pendingPullRequestSetupRequest: null,
};

const EMPTY_CHAT_VIEW_TRANSIENT_STATE: ChatViewTransientState = {
  localDiffStateByThreadId: {},
  localDraftErrorsByThreadId: {},
  respondingRequestIds: [],
  respondingUserInputRequestIds: [],
  pendingUserInputAnswersByRequestId: {},
  pendingUserInputQuestionIndexByRequestId: {},
  expandedWorkGroups: {},
  attachmentPreviewHandoffByMessageId: {},
  pendingComposerCommentsByThreadId: {},
};

function chatViewDialogStateReducer(
  state: ChatViewDialogState,
  action: ChatViewDialogAction,
): ChatViewDialogState {
  switch (action.type) {
    case "open-github-issue-dialog":
      return {
        ...state,
        gitHubIssueDialogOpen: true,
        gitHubIssueDialogInitialIssueNumber: action.gitHubIssueDialogInitialIssueNumber,
        gitHubIssueDialogInitialSelectedIssueNumbers:
          action.gitHubIssueDialogInitialSelectedIssueNumbers,
      };
    case "close-github-issue-dialog":
      return {
        ...state,
        gitHubIssueDialogOpen: false,
        gitHubIssueDialogInitialIssueNumber: null,
        gitHubIssueDialogInitialSelectedIssueNumbers: [],
      };
    case "set-issue-preview-number":
      return {
        ...state,
        issuePreviewNumber: action.issuePreviewNumber,
      };
    case "open-pull-request-dialog":
      return {
        ...state,
        pullRequestDialogState: action.pullRequestDialogState,
      };
    case "close-pull-request-dialog":
      return {
        ...state,
        pullRequestDialogState: null,
      };
    case "set-pending-pull-request-setup-request":
      return {
        ...state,
        pendingPullRequestSetupRequest: action.pendingPullRequestSetupRequest,
      };
    default:
      return state;
  }
}

function resolveStateUpdate<T>(current: T, next: T | ((value: T) => T)): T {
  return typeof next === "function" ? (next as (value: T) => T)(current) : next;
}

function chatViewTransientStateReducer(
  state: ChatViewTransientState,
  action: ChatViewTransientAction,
): ChatViewTransientState {
  switch (action.type) {
    case "set-local-diff-state-by-thread-id": {
      const localDiffStateByThreadId = resolveStateUpdate(
        state.localDiffStateByThreadId,
        action.localDiffStateByThreadId,
      );
      return localDiffStateByThreadId === state.localDiffStateByThreadId
        ? state
        : { ...state, localDiffStateByThreadId };
    }
    case "set-local-draft-errors-by-thread-id": {
      const localDraftErrorsByThreadId = resolveStateUpdate(
        state.localDraftErrorsByThreadId,
        action.localDraftErrorsByThreadId,
      );
      return localDraftErrorsByThreadId === state.localDraftErrorsByThreadId
        ? state
        : { ...state, localDraftErrorsByThreadId };
    }
    case "set-responding-request-ids": {
      const respondingRequestIds = resolveStateUpdate(
        state.respondingRequestIds,
        action.respondingRequestIds,
      );
      return respondingRequestIds === state.respondingRequestIds
        ? state
        : { ...state, respondingRequestIds };
    }
    case "set-responding-user-input-request-ids": {
      const respondingUserInputRequestIds = resolveStateUpdate(
        state.respondingUserInputRequestIds,
        action.respondingUserInputRequestIds,
      );
      return respondingUserInputRequestIds === state.respondingUserInputRequestIds
        ? state
        : { ...state, respondingUserInputRequestIds };
    }
    case "set-pending-user-input-answers-by-request-id": {
      const pendingUserInputAnswersByRequestId = resolveStateUpdate(
        state.pendingUserInputAnswersByRequestId,
        action.pendingUserInputAnswersByRequestId,
      );
      return pendingUserInputAnswersByRequestId === state.pendingUserInputAnswersByRequestId
        ? state
        : { ...state, pendingUserInputAnswersByRequestId };
    }
    case "set-pending-user-input-question-index-by-request-id": {
      const pendingUserInputQuestionIndexByRequestId = resolveStateUpdate(
        state.pendingUserInputQuestionIndexByRequestId,
        action.pendingUserInputQuestionIndexByRequestId,
      );
      return pendingUserInputQuestionIndexByRequestId ===
        state.pendingUserInputQuestionIndexByRequestId
        ? state
        : { ...state, pendingUserInputQuestionIndexByRequestId };
    }
    case "set-expanded-work-groups": {
      const expandedWorkGroups = resolveStateUpdate(
        state.expandedWorkGroups,
        action.expandedWorkGroups,
      );
      return expandedWorkGroups === state.expandedWorkGroups
        ? state
        : { ...state, expandedWorkGroups };
    }
    case "set-attachment-preview-handoff-by-message-id": {
      const attachmentPreviewHandoffByMessageId = resolveStateUpdate(
        state.attachmentPreviewHandoffByMessageId,
        action.attachmentPreviewHandoffByMessageId,
      );
      return attachmentPreviewHandoffByMessageId === state.attachmentPreviewHandoffByMessageId
        ? state
        : { ...state, attachmentPreviewHandoffByMessageId };
    }
    case "set-pending-composer-comments-by-thread-id": {
      const pendingComposerCommentsByThreadId = resolveStateUpdate(
        state.pendingComposerCommentsByThreadId,
        action.pendingComposerCommentsByThreadId,
      );
      return pendingComposerCommentsByThreadId === state.pendingComposerCommentsByThreadId
        ? state
        : { ...state, pendingComposerCommentsByThreadId };
    }
    default:
      return state;
  }
}

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
  const trackActiveThread = useUiStateStore((store) => store.trackActiveThread);
  const trackedActiveThreadId = useUiStateStore((store) =>
    ownsGlobalSideEffects ? store.activeThreadId : null,
  );
  const previousActiveThreadId = useUiStateStore((store) =>
    ownsGlobalSideEffects ? store.previousActiveThreadId : null,
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
    setRightSidePanelLastNonDiffMode,
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
  const [rightPanelEditorTabs, setRightPanelEditorTabs] = useState<PanelEditorTab[]>(() =>
    rightSidePanelEditorOpen ? [createPanelEditorTab(1)] : [],
  );
  const [activeRightPanelEditorTabId, setActiveRightPanelEditorTabId] = useState<string | null>(
    () => (rightSidePanelEditorOpen ? (rightPanelEditorTabs[0]?.id ?? null) : null),
  );
  const [bottomPanelEditorTabs, setBottomPanelEditorTabs] = useState<PanelEditorTab[]>([]);
  const [activeBottomPanelEditorTabId, setActiveBottomPanelEditorTabId] = useState<string | null>(
    null,
  );
  const rightPanelEditorTabIndexRef = useRef(rightSidePanelEditorOpen ? 2 : 1);
  const bottomPanelEditorTabIndexRef = useRef(1);
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const createWorktreeMutation = useMutation(gitCreateWorktreeMutationOptions({ queryClient }));
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
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const addComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.addTerminalContexts,
  );
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
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
  const promptRef = useRef("");
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
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
    expandedWorkGroups,
    attachmentPreviewHandoffByMessageId,
    pendingComposerCommentsByThreadId,
  } = chatViewTransientState;
  const setLocalDiffStateByThreadId = useCallback(
    (
      localDiffStateByThreadId:
        | Record<ThreadId, LocalDiffState>
        | ((current: Record<ThreadId, LocalDiffState>) => Record<ThreadId, LocalDiffState>),
    ) => {
      dispatchChatViewTransientState({
        type: "set-local-diff-state-by-thread-id",
        localDiffStateByThreadId,
      });
    },
    [],
  );
  const setLocalDraftErrorsByThreadId = useCallback(
    (
      localDraftErrorsByThreadId:
        | Record<ThreadId, string | null>
        | ((current: Record<ThreadId, string | null>) => Record<ThreadId, string | null>),
    ) => {
      dispatchChatViewTransientState({
        type: "set-local-draft-errors-by-thread-id",
        localDraftErrorsByThreadId,
      });
    },
    [],
  );
  const setRespondingRequestIds = useCallback(
    (
      respondingRequestIds:
        | ApprovalRequestId[]
        | ((current: ApprovalRequestId[]) => ApprovalRequestId[]),
    ) => {
      dispatchChatViewTransientState({
        type: "set-responding-request-ids",
        respondingRequestIds,
      });
    },
    [],
  );
  const setRespondingUserInputRequestIds = useCallback(
    (
      respondingUserInputRequestIds:
        | ApprovalRequestId[]
        | ((current: ApprovalRequestId[]) => ApprovalRequestId[]),
    ) => {
      dispatchChatViewTransientState({
        type: "set-responding-user-input-request-ids",
        respondingUserInputRequestIds,
      });
    },
    [],
  );
  const setPendingUserInputAnswersByRequestId = useCallback(
    (
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
    },
    [],
  );
  const setPendingUserInputQuestionIndexByRequestId = useCallback(
    (
      pendingUserInputQuestionIndexByRequestId:
        | Record<string, number>
        | ((current: Record<string, number>) => Record<string, number>),
    ) => {
      dispatchChatViewTransientState({
        type: "set-pending-user-input-question-index-by-request-id",
        pendingUserInputQuestionIndexByRequestId,
      });
    },
    [],
  );
  const setExpandedWorkGroups = useCallback(
    (
      expandedWorkGroups:
        | Record<string, boolean>
        | ((current: Record<string, boolean>) => Record<string, boolean>),
    ) => {
      dispatchChatViewTransientState({
        type: "set-expanded-work-groups",
        expandedWorkGroups,
      });
    },
    [],
  );
  const setAttachmentPreviewHandoffByMessageId = useCallback(
    (
      attachmentPreviewHandoffByMessageId:
        | Record<string, string[]>
        | ((current: Record<string, string[]>) => Record<string, string[]>),
    ) => {
      dispatchChatViewTransientState({
        type: "set-attachment-preview-handoff-by-message-id",
        attachmentPreviewHandoffByMessageId,
      });
    },
    [],
  );
  const setPendingComposerCommentsByThreadId = useCallback(
    (
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
    },
    [],
  );
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const previousThreadIdRef = useRef<ThreadId | null>(null);
  const directThreadHydrationInFlightRef = useRef<ThreadId | null>(null);
  const directThreadHydrationFailureCountRef = useRef(0);
  const directThreadHydrationRetryTimeoutRef = useRef<number | null>(null);
  const directThreadHydrationRequestTokenRef = useRef(0);
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
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewHandoffTimeoutByMessageIdRef = useRef<Record<string, number>>({});
  const pendingInterruptStopFallbackRef = useRef<number | null>(null);
  const sendInFlightRef = useRef(false);
  const queuedDesignMessageEditRef = useRef<QueuedComposerMessage | null>(null);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});
  const composerPanelsRef = useRef<ConnectedChatComposerPanelsHandle>(null);
  const subagentComposerPanelsRef = useRef<ConnectedChatComposerPanelsHandle>(null);
  const chatShellRef = useRef<HTMLDivElement | null>(null);
  const setMessagesScrollContainerRef = useCallback((element: HTMLDivElement | null) => {
    messagesScrollRef.current = element;
  }, []);
  const getMessagesScrollContainer = useCallback(() => messagesScrollRef.current, []);
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

  const terminalState = useTerminalStateStore(
    useShallow((state) => {
      const selectedState = selectThreadTerminalState(state.terminalStateByThreadId, threadId);
      return {
        terminalOpen: selectedState.terminalOpen,
        terminalHeight: selectedState.terminalHeight,
        activeTerminalId: selectedState.activeTerminalId,
        terminalIds: selectedState.terminalIds,
        runningTerminalIds: selectedState.runningTerminalIds,
        autoTerminalTitlesById: selectedState.autoTerminalTitlesById,
      };
    }),
  );
  const storeSetTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const storeSetTerminalHeight = useTerminalStateStore((s) => s.setTerminalHeight);
  const storeSplitTerminal = useTerminalStateStore((s) => s.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((s) => s.newTerminal);
  const storeNewBackgroundTerminal = useTerminalStateStore((s) => s.newBackgroundTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((s) => s.setActiveTerminal);
  const storeMoveTerminal = useTerminalStateStore((s) => s.moveTerminal);
  const storeSetTerminalGroupSplitRatios = useTerminalStateStore(
    (s) => s.setTerminalGroupSplitRatios,
  );
  const storeSetTerminalAutoTitle = useTerminalStateStore((s) => s.setTerminalAutoTitle);
  const storeCloseTerminal = useTerminalStateStore((s) => s.closeTerminal);

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(threadId, nextPrompt);
    },
    [setComposerDraftPrompt, threadId],
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
  const pendingComposerComments = useMemo(
    () => pendingComposerCommentsByThreadId[threadId] ?? EMPTY_PENDING_COMPOSER_COMMENTS,
    [pendingComposerCommentsByThreadId, threadId],
  );
  const pendingComposerCommentItems = useMemo(
    () =>
      pendingComposerComments.map((comment) => ({
        id: comment.id,
        sourceLabel: comment.source === "review" ? "Review" : "Browser",
        targetLabel: comment.targetLabel,
        body: comment.body,
        previewUrl: comment.image?.previewUrl ?? null,
      })),
    [pendingComposerComments],
  );
  const dismissPendingComposerComment = useCallback(
    (commentId: string) => {
      setPendingComposerCommentsByThreadId((current) => {
        const existing = current[threadId] ?? [];
        const next = existing.filter((comment) => comment.id !== commentId);
        if (next.length === existing.length) {
          return current;
        }
        return {
          ...current,
          [threadId]: next,
        };
      });
    },
    [threadId],
  );
  const clearPendingComposerComments = useCallback(() => {
    setPendingComposerCommentsByThreadId((current) => {
      if ((current[threadId] ?? []).length === 0) {
        return current;
      }
      return {
        ...current,
        [threadId]: [],
      };
    });
  }, [threadId]);
  const addDiffReviewComment = useCallback(
    (comment: DiffReviewCommentInput) => {
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
    },
    [setPendingComposerCommentsByThreadId, threadId],
  );

  const threadConnectionUrl = useThreadConnectionUrl(threadId);
  const projectConnectionUrl = useProjectConnectionUrl(
    serverThread?.projectId ?? draftThread?.projectId,
  );
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
        explicitConnectionUrl: connectionUrl,
        projectConnectionUrl,
        routeConnectionUrl,
        threadConnectionUrl,
      }),
    [connectionUrl, projectConnectionUrl, routeConnectionUrl, threadConnectionUrl],
  );
  const canOpenLocalMarkdownFiles = activeServerConnectionUrl === null;
  const resolveBrowserThreadConnectionUrl = useCallback(
    (browserThreadId: ThreadId): string => {
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
    },
    [connectionUrl, draftThread, routeConnectionUrl, serverThread, threadId],
  );
  const fallbackDraftProject = useProjectById(draftThread?.projectId);
  const localDraftError = serverThread ? null : (localDraftErrorsByThreadId[threadId] ?? null);
  const connectionServerConfig = useConnectionServerConfig(activeServerConnectionUrl);
  const providerStatuses = useMemo(
    () => connectionServerConfig?.providers ?? EMPTY_PROVIDER_STATUSES,
    [connectionServerConfig?.providers],
  );
  const providerSettings =
    connectionServerConfig?.settings.providers ?? DEFAULT_UNIFIED_SETTINGS.providers;
  const modelSettings = useMemo(() => ({ providers: providerSettings }), [providerSettings]);
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
  const { runtimeMode, interactionMode } = useMemo(
    () =>
      deriveEffectiveComposerExecutionModeState({
        draft: composerShellDraft,
        threadRuntimeMode: activeThread?.runtimeMode ?? null,
        threadInteractionMode: activeThread?.interactionMode ?? null,
      }),
    [activeThread?.interactionMode, activeThread?.runtimeMode, composerShellDraft],
  );
  const isServerThread = serverThread !== undefined;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const activeThreadLineageSourceThreadId =
    isServerThread && activeThread ? resolveThreadLineageSourceThreadId(activeThread) : null;
  const handoffLineageSelector = useMemo(
    () => createHandoffLineageSelector(activeThreadLineageSourceThreadId),
    [activeThreadLineageSourceThreadId],
  );
  const handoffLineage = useStore(handoffLineageSelector);
  const lineageSourceThreadIds = useMemo(
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
  const rightSidePanelEnabled = true;
  const rightSidePanelInteractive = rightSidePanelEnabled;
  const effectiveRightSidePanelMode = rightSidePanelEnabled ? rightSidePanelMode : null;
  const diffOpen = rightSidePanelEnabled ? rightSidePanelDiffOpen : false;
  const rightSidePanelOpen = rightSidePanelEnabled && rightSidePanelVisible;
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
  const clearDirectThreadHydrationRetryTimeout = useCallback(() => {
    if (directThreadHydrationRetryTimeoutRef.current === null) {
      return;
    }
    window.clearTimeout(directThreadHydrationRetryTimeoutRef.current);
    directThreadHydrationRetryTimeoutRef.current = null;
  }, []);
  const syncHydratedThreadFromCache = useEffectEvent(
    (thread: Parameters<typeof hydrateThreadFromReadModel>[0]) => {
      directThreadHydrationFailureCountRef.current = 0;
      directThreadHydrationRequestTokenRef.current += 1;
      clearDirectThreadHydrationRetryTimeout();
      startTransition(() => {
        hydrateThreadFromReadModel(thread);
      });
    },
  );
  const attemptDirectThreadHydration = useEffectEvent(
    (thread: NonNullable<typeof serverThread>) => {
      if (thread.historyLoaded !== false) {
        return;
      }
      const cachedHydratedThread = thread.updatedAt
        ? readCachedHydratedThread(thread.id, thread.updatedAt)
        : null;
      if (cachedHydratedThread) {
        syncHydratedThreadFromCache(cachedHydratedThread);
        return;
      }
      if (
        directThreadHydrationInFlightRef.current === thread.id ||
        directThreadHydrationRetryTimeoutRef.current !== null
      ) {
        return;
      }

      const requestToken = ++directThreadHydrationRequestTokenRef.current;
      directThreadHydrationInFlightRef.current = thread.id;
      void (async () => {
        try {
          const readModelThread = await hydrateThreadFromCache(thread.id, {
            expectedUpdatedAt: thread.updatedAt ?? null,
          });
          if (directThreadHydrationRequestTokenRef.current !== requestToken) {
            return;
          }
          syncHydratedThreadFromCache(readModelThread);
        } catch {
          if (directThreadHydrationRequestTokenRef.current !== requestToken) {
            return;
          }
          const nextFailureCount = directThreadHydrationFailureCountRef.current + 1;
          directThreadHydrationFailureCountRef.current = nextFailureCount;
          clearDirectThreadHydrationRetryTimeout();
          directThreadHydrationRetryTimeoutRef.current = window.setTimeout(() => {
            if (directThreadHydrationRetryTimeoutRef.current !== null) {
              directThreadHydrationRetryTimeoutRef.current = null;
            }
            attemptDirectThreadHydration(thread);
          }, resolveThreadHydrationRetryDelayMs(nextFailureCount));
        } finally {
          if (
            directThreadHydrationInFlightRef.current === thread.id &&
            directThreadHydrationRequestTokenRef.current === requestToken
          ) {
            directThreadHydrationInFlightRef.current = null;
          }
        }
      })();
    },
  );
  const hydratedThreadHistoryKeepIds = useMemo<ThreadId[]>(
    () =>
      deriveHydratedThreadHistoryKeepIds({
        activeThreadId,
        sourceProposedPlanThreadId,
        previousThreadId: recentThreadHistoryKeepId,
        lineageSourceThreadIds,
        additionalThreadIds: visibleBoardThreadIds,
      }),
    [
      activeThreadId,
      recentThreadHistoryKeepId,
      sourceProposedPlanThreadId,
      lineageSourceThreadIds,
      visibleBoardThreadIds,
    ],
  );
  const memoryPressureHydratedThreadHistoryKeepIds = useMemo<ThreadId[]>(
    () =>
      deriveHydratedThreadHistoryKeepIds({
        activeThreadId,
        sourceProposedPlanThreadId,
        previousThreadId: null,
        lineageSourceThreadIds,
        additionalThreadIds: visibleBoardThreadIds,
      }),
    [activeThreadId, sourceProposedPlanThreadId, lineageSourceThreadIds, visibleBoardThreadIds],
  );
  const criticalHydratedThreadHistoryKeepIds = useMemo<ThreadId[]>(
    () =>
      deriveHydratedThreadHistoryKeepIds({
        activeThreadId,
        sourceProposedPlanThreadId: null,
        previousThreadId: null,
        lineageSourceThreadIds,
        additionalThreadIds: visibleBoardThreadIds,
      }),
    [activeThreadId, lineageSourceThreadIds, visibleBoardThreadIds],
  );

  // Update this before the next interaction so rapid thread switches keep the just-viewed history warm.
  useLayoutEffect(() => {
    if (!ownsGlobalSideEffects) return;
    trackActiveThread(activeThreadId);
  }, [activeThreadId, ownsGlobalSideEffects, trackActiveThread]);

  useEffect(() => {
    directThreadHydrationFailureCountRef.current = 0;
    directThreadHydrationRequestTokenRef.current += 1;
    clearDirectThreadHydrationRetryTimeout();
    directThreadHydrationInFlightRef.current = null;
  }, [clearDirectThreadHydrationRetryTimeout, serverThread?.id, serverThread?.updatedAt]);

  useEffect(() => {
    if (!serverThread || serverThread.historyLoaded !== false) {
      return;
    }
    attemptDirectThreadHydration(serverThread);
  }, [serverThread]);

  useEffect(() => {
    return clearDirectThreadHydrationRetryTimeout;
  }, [clearDirectThreadHydrationRetryTimeout]);

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
    activeThreadLineageSourceThreadId,
    handoffHasCycle,
    handoffMissingThreadId,
    lineageSourceThreadIds,
    hydrateThreadFromReadModel,
    isServerThread,
  ]);
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const liveTurnInProgress = hasLiveTurn(activeLatestTurn, activeThread?.session ?? null);
  const connectionHealth = useConnectionHealth();
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
  useEffect(() => {
    if (!reliabilityUxEnabled) {
      setDiagnosticsOpen(false);
    }
  }, [reliabilityUxEnabled]);
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
    if (!activeForSideEffects) {
      return;
    }
    if (!activeThread?.id) {
      return;
    }
    const store = useHostConnectionStore.getState();
    store.upsertThreadOwnership(activeServerConnectionUrl, activeThread.id);
    if (activeProjectId) {
      store.upsertProjectOwnership(activeServerConnectionUrl, activeProjectId);
    }
  }, [activeForSideEffects, activeProjectId, activeServerConnectionUrl, activeThread?.id]);
  const activeEnvironmentIcon =
    activeRemoteHost && (activeRemoteHost.iconGlyph || activeRemoteHost.iconColor)
      ? {
          glyph: activeRemoteHost.iconGlyph ?? "folder",
          color: activeRemoteHost.iconColor ?? "slate",
        }
      : null;
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
  const queuedSteerRequestRef = useRef(queuedSteerRequest);
  queuedSteerRequestRef.current = queuedSteerRequest;

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      dispatchChatViewDialogState({
        type: "open-pull-request-dialog",
        pullRequestDialogState: {
          initialReference: reference ?? null,
          key: Date.now(),
        },
      });
      composerPanelsRef.current?.resetUi();
    },
    [canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    dispatchChatViewDialogState({ type: "close-pull-request-dialog" });
  }, []);

  const openGitHubIssueDialog = useCallback(
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
    [],
  );

  const closeGitHubIssueDialog = useCallback(() => {
    dispatchChatViewDialogState({ type: "close-github-issue-dialog" });
  }, []);

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
    setExpandedWorkGroups({});
    closeGitHubIssueDialog();
    dispatchChatViewDialogState({ type: "close-pull-request-dialog" });
  });

  const onComposerIssueTokenClick = useCallback((issueNumber: number) => {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return;
    }
    dispatchChatViewDialogState({
      type: "set-issue-preview-number",
      issuePreviewNumber: issueNumber,
    });
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
    },
    [activeProject, openOrReuseProjectDraftThread],
  );

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
    browserControllerByThreadRef.current.get(activeThread.id)?.clearAgentPointers();
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.turnId,
    activeForSideEffects,
    activeThread?.id,
    latestTurnSettled,
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
  const providerInstancesByProvider = useMemo(
    () => ({
      codex: modelSettings.providers.codex.instances,
      claudeAgent: modelSettings.providers.claudeAgent.instances,
      githubCopilot: modelSettings.providers.githubCopilot.instances,
      cursor: modelSettings.providers.cursor.instances,
      pi: modelSettings.providers.pi.instances,
      gemini: modelSettings.providers.gemini.instances,
      opencode: modelSettings.providers.opencode.instances,
    }),
    [modelSettings.providers],
  );
  const composerProviderCommands = useMemo(() => {
    const commandProvider = activeThread?.session?.provider ?? selectedProvider;
    const selectedProviderCommands =
      providerStatuses.find((provider) => provider.provider === commandProvider)?.commands ?? [];
    return mergeProviderSlashCommands(
      activeThread?.session?.commands,
      selectedProviderCommands,
      providerFallbackSlashCommands(commandProvider),
    );
  }, [
    activeThread?.session?.commands,
    activeThread?.session?.provider,
    providerStatuses,
    selectedProvider,
  ]);
  const readCurrentSelectedPromptEffort = useCallback(() => {
    return getComposerProviderState({
      provider: selectedProvider,
      model: selectedModel,
      models: selectedProviderModels,
      prompt: promptRef.current,
      modelOptions: composerModelOptions,
    }).promptEffort;
  }, [composerModelOptions, selectedModel, selectedProvider, selectedProviderModels]);
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
  const activeGeneratedWorkspaceSummary = useMemo(
    () => deriveLatestGeneratedWorkspaceSummary(threadActivities),
    [threadActivities],
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
  const stuckTurnSnapshot = useMemo(
    () =>
      reliabilityUxEnabled && activeThread
        ? deriveStuckTurnSnapshot({
            latestTurn: activeLatestTurn,
            messages: activeThread.messages,
            activities: activeThread.activities,
            now: stuckTurnNow,
          })
        : { isLikelyStuck: false, runningForMs: 0, reason: null },
    [activeLatestTurn, activeThread, reliabilityUxEnabled, stuckTurnNow],
  );
  const openDiagnostics = useCallback(
    (focus: "connection" | "provider" | "thread") => {
      if (!reliabilityUxEnabled) {
        return;
      }
      setDiagnosticsFocus(focus);
      setDiagnosticsOpen(true);
    },
    [reliabilityUxEnabled],
  );
  const refreshProviderStatus = useCallback(() => {
    void readNativeApi()
      ?.server.refreshProviders()
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Provider refresh failed",
          description:
            error instanceof Error ? error.message : "Unable to refresh provider status.",
        });
      });
  }, []);
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
  const subagentProvider =
    activeThread?.session?.provider ?? activeThread?.modelSelection.provider ?? null;
  const subagentThreads = useMemo(
    () => deriveSubagentThreads(timelineWorkEntries, subagentProvider),
    [subagentProvider, timelineWorkEntries],
  );
  const [activeSubagentThreadId, setActiveSubagentThreadId] = useState<string | null>(null);
  const environmentMiniPanelRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (subagentThreads.length === 0) {
      if (activeSubagentThreadId !== null) {
        setActiveSubagentThreadId(null);
      }
      return;
    }
    if (
      !activeSubagentThreadId ||
      !subagentThreads.some((thread) => thread.id === activeSubagentThreadId)
    ) {
      setActiveSubagentThreadId(subagentThreads[0]?.id ?? null);
    }
  }, [activeSubagentThreadId, subagentThreads]);
  const activeThreadMessageIds = useMemo(
    () => new Set(activeThreadMessages.map((message) => message.id)),
    [activeThreadMessages],
  );
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const { timelineEntries, turnDiffSummaryByAssistantMessageId } = useMemo(
    () =>
      measureRenderWork("chat.deriveThreadTimelineRenderState", () =>
        deriveThreadTimelineRenderState({
          messages: timelineMessages,
          proposedPlans: timelineProposedPlans,
          workLogEntries: timelineWorkEntries,
          turnDiffSummaries,
        }),
      ),
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
  const revertTurnCountByAssistantMessageId = useMemo(() => {
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
  }, [inferredCheckpointTurnCountByTurnId, turnDiffSummaryByAssistantMessageId]);

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
    enabled: codingGitCwd !== null && activeForSideEffects,
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
  const workspaceDiffSummary = useMemo(() => {
    const workingTree = workspaceStatusQuery.data?.workingTree;
    if (!workingTree || (workingTree.insertions === 0 && workingTree.deletions === 0)) {
      return null;
    }
    return {
      additions: workingTree.insertions,
      deletions: workingTree.deletions,
      fileCount: workingTree.files.length,
    };
  }, [workspaceStatusQuery.data?.workingTree]);
  const handleRegenerateSummary = useCallback(async () => {
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
  }, [activeThread]);
  const branchesQuery = useQuery({
    ...gitBranchesQueryOptions(codingGitCwd),
    enabled: codingGitCwd !== null && activeForSideEffects,
  });
  // Default true while loading to avoid toolbar flicker.
  const rawIsGitRepo = branchesQuery.data?.isRepo ?? true;
  const isGitRepo = rawIsGitRepo;
  const activeThreadBranchName =
    activeThread?.branch ??
    branchesQuery.data?.branches.find((branch) => branch.current)?.name ??
    null;
  const keybindings = useServerKeybindings({ enabled: activeForSideEffects });
  const availableEditors = useServerAvailableEditors({ enabled: activeForSideEffects });
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
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const rightSidePanelToggleShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "rightPanel.toggle", nonTerminalShortcutLabelOptions),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const rightSidePanelShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: false,
        terminalOpen: Boolean(terminalState.terminalOpen),
        rightPanelOpen: rightSidePanelOpen,
        rightPanelFullscreen: rightSidePanelFullscreen,
      },
    }),
    [rightSidePanelFullscreen, rightSidePanelOpen, terminalState.terminalOpen],
  );
  const rightSidePanelFullscreenShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(
        keybindings,
        "rightPanel.fullscreen.toggle",
        rightSidePanelShortcutLabelOptions,
      ),
    [keybindings, rightSidePanelShortcutLabelOptions],
  );
  const rightSidePanelFloatingChatShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(
        keybindings,
        "rightPanel.floatingChat.toggle",
        rightSidePanelShortcutLabelOptions,
      ),
    [keybindings, rightSidePanelShortcutLabelOptions],
  );
  const reviewPanelShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(
        keybindings,
        "rightPanel.review.open",
        nonTerminalShortcutLabelOptions,
      ),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const rightPanelBrowserShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(
        keybindings,
        "rightPanel.browser.open",
        nonTerminalShortcutLabelOptions,
      ),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const rightPanelEditorShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(
        keybindings,
        "rightPanel.editor.open",
        nonTerminalShortcutLabelOptions,
      ),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const rightPanelTerminalShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(
        keybindings,
        "rightPanel.terminal.open",
        nonTerminalShortcutLabelOptions,
      ),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const togglePlanModeShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "chat.togglePlanMode", nonTerminalShortcutLabelOptions),
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
      rightPanelBrowserShortcutLabel,
    [rightPanelBrowserShortcutLabel, keybindings, nonTerminalShortcutLabelOptions],
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
  const browserDesignerElementCommentShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(
        keybindings,
        "browser.designer.elementComment",
        browserActionShortcutLabelOptions,
      ),
    [browserActionShortcutLabelOptions, keybindings],
  );
  const browserControllerRef = useRef<InAppBrowserController | null>(null);
  const browserControllerByThreadRef = useRef(new Map<ThreadId, InAppBrowserController>());
  const browserRuntimeStateByThreadRef = useRef(new Map<ThreadId, { devToolsOpen: boolean }>());
  const lastBrowserPointerClearedTurnRef = useRef<string | null>(null);
  const browserSessionChangeHandlerByThreadRef = useRef(
    new Map<ThreadId, (session: BrowserSessionStorage) => void>(),
  );
  const browserControllerChangeHandlerByThreadRef = useRef(
    new Map<ThreadId, (controller: InAppBrowserController | null) => void>(),
  );
  const browserRuntimeStateChangeHandlerByThreadRef = useRef(
    new Map<ThreadId, (state: ActiveBrowserRuntimeState) => void>(),
  );
  const browserViewportResizeHandlerByThreadRef = useRef(
    new Map<ThreadId, (request: BrowserViewportResizeRequest) => BrowserViewportResizeResult>(),
  );
  const activeBrowserThreadIdRef = useRef<ThreadId | null>(activeThreadId);
  const pendingBrowserOpenUrlRef = useRef<string | null>(null);
  const chatViewportRef = useRef<HTMLDivElement | null>(null);
  const [chatViewportSize, setChatViewportSize] = useState({ height: 0, width: 0 });
  const workspaceViewportRef = useRef<HTMLDivElement | null>(null);
  const browserSplitWidthRef = useRef(browserSplitWidth);
  const browserSplitResizePointerIdRef = useRef<number | null>(null);
  const browserSplitResizeStateRef = useRef<{
    contentElement: HTMLElement | null;
    pendingWidth: number;
    rafId: number | null;
    startX: number;
    startWidth: number;
  } | null>(null);
  const didResizeBrowserSplitDuringDragRef = useRef(false);
  const lastSyncedBrowserSplitWidthRef = useRef(browserSplitWidth);
  const [mountedBrowserInstances, setMountedBrowserInstances] = useState<
    readonly RecentBrowserInstanceEntry<ThreadId>[]
  >([]);
  const previousMountedBrowserInstancesRef = useRef<
    readonly RecentBrowserInstanceEntry<ThreadId>[]
  >([]);
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
    const viewportElement = chatViewportRef.current;
    if (!viewportElement) return;

    let frameId: number | null = null;
    const syncViewportSize = () => {
      frameId = null;
      const rect = viewportElement.getBoundingClientRect();
      const nextWidth = Math.floor(rect.width);
      const nextHeight = Math.floor(rect.height);
      setChatViewportSize((current) =>
        current.width === nextWidth && current.height === nextHeight
          ? current
          : { height: nextHeight, width: nextWidth },
      );
    };
    const scheduleSync = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(syncViewportSize);
    };

    scheduleSync();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleSync);
    resizeObserver?.observe(viewportElement);
    window.addEventListener("resize", scheduleSync, { passive: true });

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleSync);
    };
  }, []);
  const lastSyncedWorkspaceEditorSplitWidthRef = useRef(workspaceEditorSplitWidth);
  const rightSidePanelWidthRef = useRef(rightSidePanelWidth);
  const rightSidePanelElementRef = useRef<HTMLDivElement | null>(null);
  const dockedRightSidePanelHeaderRef = useRef<HTMLDivElement | null>(null);
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
  const browserOpen = browserMode !== "closed";
  const cleanupBrowserInstanceState = useCallback(
    (browserThreadId: ThreadId, options?: { resetVisibleState?: boolean }) => {
      browserControllerByThreadRef.current.delete(browserThreadId);
      browserRuntimeStateByThreadRef.current.delete(browserThreadId);
      browserSessionChangeHandlerByThreadRef.current.delete(browserThreadId);
      browserControllerChangeHandlerByThreadRef.current.delete(browserThreadId);
      browserRuntimeStateChangeHandlerByThreadRef.current.delete(browserThreadId);
      browserViewportResizeHandlerByThreadRef.current.delete(browserThreadId);
      deleteBrowserSession(browserThreadId);
      if (activeBrowserThreadIdRef.current !== browserThreadId) {
        return;
      }
      browserControllerRef.current = null;
      pendingBrowserOpenUrlRef.current = null;
      if (options?.resetVisibleState !== false) {
        setBrowserDevToolsOpen(false);
      }
    },
    [setBrowserDevToolsOpen],
  );
  const resetBrowserCacheState = useCallback(
    (options?: { resetVisibleState?: boolean }) => {
      browserControllerByThreadRef.current.clear();
      browserRuntimeStateByThreadRef.current.clear();
      browserSessionChangeHandlerByThreadRef.current.clear();
      browserControllerChangeHandlerByThreadRef.current.clear();
      browserRuntimeStateChangeHandlerByThreadRef.current.clear();
      browserViewportResizeHandlerByThreadRef.current.clear();
      clearBrowserSessions();
      activeBrowserThreadIdRef.current = null;
      browserControllerRef.current = null;
      pendingBrowserOpenUrlRef.current = null;
      previousMountedBrowserInstancesRef.current = [];
      if (options?.resetVisibleState !== false) {
        setBrowserDevToolsOpen(false);
      }
    },
    [setBrowserDevToolsOpen],
  );
  useEffect(() => {
    if (!rightSidePanelEnabled || rightSidePanelMode !== "diff" || rightSidePanelDiffOpen) {
      return;
    }
    openRightSidePanelDiff();
  }, [rightSidePanelDiffOpen, rightSidePanelEnabled, rightSidePanelMode]);
  useEffect(() => {
    if (rightSidePanelEnabled && diffOpen) {
      setRightSidePanelReviewOpen(true);
    }
  }, [diffOpen, rightSidePanelEnabled, setRightSidePanelReviewOpen]);
  useEffect(() => {
    if (!rightSidePanelEnabled) {
      return;
    }
    if (!rightSidePanelMode || rightSidePanelMode === "diff") {
      return;
    }
    if (rightSidePanelLastNonDiffMode === rightSidePanelMode) {
      return;
    }
    setRightSidePanelLastNonDiffMode(rightSidePanelMode);
  }, [
    rightSidePanelEnabled,
    rightSidePanelLastNonDiffMode,
    rightSidePanelMode,
    setRightSidePanelLastNonDiffMode,
  ]);
  useEffect(() => {
    if (
      rightSidePanelEnabled &&
      browserOpen &&
      isElectron &&
      !diffOpen &&
      bottomPanelMode !== "browser" &&
      rightSidePanelMode === null
    ) {
      setRightSidePanelMode("browser");
    }
  }, [
    bottomPanelMode,
    browserOpen,
    diffOpen,
    rightSidePanelEnabled,
    rightSidePanelMode,
    setRightSidePanelMode,
  ]);
  useEffect(() => {
    if (!splitPane && (routeWorkspaceMode === "editor" || routeWorkspaceMode === "split")) {
      ensureWorkspaceEditorPanelVisible();
    }
  }, [routeWorkspaceMode, splitPane]);
  useEffect(() => {
    if (!rightSidePanelInteractive) {
      activeBrowserThreadIdRef.current = null;
      browserControllerRef.current = null;
      return;
    }
    activeBrowserThreadIdRef.current = activeThreadId;
    browserControllerRef.current = activeThreadId
      ? (browserControllerByThreadRef.current.get(activeThreadId) ?? null)
      : null;
    setBrowserDevToolsOpen(
      activeThreadId
        ? (browserRuntimeStateByThreadRef.current.get(activeThreadId)?.devToolsOpen ?? false)
        : false,
    );
  }, [activeThreadId, rightSidePanelInteractive, setBrowserDevToolsOpen]);
  useEffect(() => {
    if (!rightSidePanelInteractive) {
      return;
    }
    if (!isElectron || !activeThreadId) {
      resetBrowserCacheState();
      setMountedBrowserInstances([]);
      return;
    }
    if (!browserOpen) {
      return;
    }
    setMountedBrowserInstances((current) =>
      touchRecentBrowserInstance(current, activeThreadId, Date.now(), Number.MAX_SAFE_INTEGER),
    );
  }, [activeThreadId, browserOpen, resetBrowserCacheState, rightSidePanelInteractive]);
  useEffect(() => {
    if (!rightSidePanelInteractive) {
      return;
    }
    if (!isElectron || mountedBrowserInstances.length === 0) {
      return;
    }

    const protectedThreadId = browserOpen ? activeThreadId : null;
    const pruneExpiredBrowserCache = () => {
      setMountedBrowserInstances((current) =>
        evictExpiredRecentBrowserInstances(
          current,
          Date.now(),
          CACHED_BROWSER_INSTANCE_TTL_MS,
          protectedThreadId,
        ),
      );
    };

    pruneExpiredBrowserCache();

    const nextExpiryAt = resolveNextRecentBrowserInstanceExpiry(
      mountedBrowserInstances,
      CACHED_BROWSER_INSTANCE_TTL_MS,
      protectedThreadId,
    );
    if (nextExpiryAt === null) {
      return;
    }

    const timeoutHandle = window.setTimeout(
      pruneExpiredBrowserCache,
      Math.max(0, nextExpiryAt - Date.now()),
    );

    return () => {
      window.clearTimeout(timeoutHandle);
    };
  }, [activeThreadId, browserOpen, mountedBrowserInstances, rightSidePanelInteractive]);
  useEffect(() => {
    if (!rightSidePanelInteractive) {
      return;
    }
    if (!isElectron || !activeThreadId) {
      return;
    }

    const trimBackgroundBrowserCache = () => {
      if (document.visibilityState !== "hidden") {
        return;
      }
      setMountedBrowserInstances((current) => {
        const activeEntry = current.find((entry) => entry.instanceId === activeThreadId);
        return activeEntry ? [activeEntry] : current.slice(0, 1);
      });
    };

    window.addEventListener("blur", trimBackgroundBrowserCache);
    document.addEventListener("visibilitychange", trimBackgroundBrowserCache);

    return () => {
      window.removeEventListener("blur", trimBackgroundBrowserCache);
      document.removeEventListener("visibilitychange", trimBackgroundBrowserCache);
    };
  }, [activeThreadId, rightSidePanelInteractive]);
  useEffect(() => {
    if (!rightSidePanelInteractive || !isElectron) {
      return;
    }

    return subscribeToMemoryPressure((snapshot) => {
      if (snapshot === null || !isMemoryPressureAtLeast("high", snapshot)) {
        return;
      }
      const protectedThreadId = browserOpen ? activeThreadId : null;
      setMountedBrowserInstances((current) =>
        protectedThreadId ? current.filter((entry) => entry.instanceId === protectedThreadId) : [],
      );
    });
  }, [activeThreadId, browserOpen, rightSidePanelInteractive]);
  useEffect(() => {
    const previousThreadIds = previousMountedBrowserInstancesRef.current.map(
      (entry) => entry.instanceId,
    );
    const mountedBrowserThreadIds = new Set(
      mountedBrowserInstances.map((entry) => entry.instanceId),
    );
    previousMountedBrowserInstancesRef.current = mountedBrowserInstances;

    for (const previousThreadId of previousThreadIds) {
      if (mountedBrowserThreadIds.has(previousThreadId)) {
        continue;
      }
      cleanupBrowserInstanceState(previousThreadId);
    }
  }, [cleanupBrowserInstanceState, mountedBrowserInstances]);
  useEffect(() => {
    return () => {
      resetBrowserCacheState({ resetVisibleState: false });
    };
  }, [resetBrowserCacheState]);
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
    return composerPanelsRef.current?.focusAtEnd() ?? false;
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
  const reorderQueuedComposerState = useCallback(
    async (targetThreadId: ThreadId, messageIds: ReadonlyArray<MessageId>) =>
      await dispatchQueuedComposerCommand(targetThreadId, ({ commandId, threadId }) => ({
        type: "thread.queue.reorder",
        commandId,
        threadId,
        messageIds: [...messageIds],
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
  const clearQueuedSteerRequest = useCallback(
    async (targetThreadId: ThreadId) =>
      await dispatchQueuedComposerCommand(targetThreadId, ({ commandId, threadId }) => ({
        type: "thread.queue.steer.clear",
        commandId,
        threadId,
      })),
    [dispatchQueuedComposerCommand],
  );
  const dispatchQueuedComposerMessage = useCallback(
    async (targetThreadId: ThreadId, messageId: MessageId) =>
      await dispatchQueuedComposerCommand(targetThreadId, ({ commandId, threadId }) => ({
        type: "thread.queue.dispatch",
        commandId,
        threadId,
        messageId,
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
        getComposerThreadDraft(threadId).persistedAttachments.map(
          (attachment) => [attachment.id, attachment] as const,
        ),
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
    [threadId],
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
  const reorderQueuedComposerMessages = useCallback(
    async (draggedMessageId: MessageId, targetMessageId: MessageId) => {
      if (!serverThread) {
        return;
      }
      const currentQueue = queuedComposerMessagesRef.current;
      const draggedIndex = currentQueue.findIndex((message) => message.id === draggedMessageId);
      const targetIndex = currentQueue.findIndex((message) => message.id === targetMessageId);
      if (draggedIndex < 0 || targetIndex < 0) {
        return;
      }

      const nextQueue = [...currentQueue];
      const [dragged] = nextQueue.splice(draggedIndex, 1);
      if (!dragged) return;
      nextQueue.splice(targetIndex, 0, dragged);
      let isUnchanged = true;
      for (const [index, message] of nextQueue.entries()) {
        if (message.id !== currentQueue[index]?.id) {
          isUnchanged = false;
          break;
        }
      }
      if (isUnchanged) {
        return;
      }

      const steerRequest = queuedSteerRequestRef.current;
      const nextMessageIds = nextQueue.map((message) => message.id);
      if (!(await reorderQueuedComposerState(serverThread.id, nextMessageIds))) {
        return;
      }
      if (steerRequest && !nextMessageIds.includes(steerRequest.messageId)) {
        return;
      }
    },
    [reorderQueuedComposerState, serverThread],
  );
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
      composerPanelsRef.current?.resetUi(message.prompt);
      scheduleComposerFocus();
    },
    [
      addComposerImagesToDraft,
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
      const api = readNativeApi();
      if (!api || !activeThread || (sendInFlightRef.current && !isServerThread)) {
        return false;
      }
      const hiddenDesignMessage = queuedDesignMessageEditRef.current;
      const composerImages = composerImagesRef.current;
      const pendingCommentsForQueue = pendingComposerComments;
      const hasPendingComposerComments = pendingCommentsForQueue.length > 0;
      const promptForQueueWithoutInlineMarkers = stripComposerInlineMarkers(promptRef.current);
      const composerTerminalContexts = composerTerminalContextsRef.current;
      const { sendableTerminalContexts, expiredTerminalContextCount, hasSendableContent } =
        deriveComposerSendState({
          prompt: promptForQueueWithoutInlineMarkers,
          imageCount: composerImages.length,
          terminalContexts: composerTerminalContexts,
        });
      if (!hasSendableContent && !hasPendingComposerComments) {
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
      const providerSlashCommandPayload =
        composerImages.length === 0 && sendableTerminalContexts.length === 0
          ? parseProviderComposerSlashCommand(
              promptForQueueWithoutInlineMarkers.trim(),
              composerProviderCommands,
            )
          : null;
      const promptForQueueBase =
        providerSlashCommandPayload?.promptText ?? promptForQueueWithoutInlineMarkers;
      const promptForQueue =
        hiddenDesignMessage === null
          ? buildAccumulatedCommentsPrompt(promptForQueueBase, pendingCommentsForQueue)
          : buildAccumulatedCommentsPrompt(
              appendHiddenBrowserDesignContextFromOriginalPrompt(
                promptForQueueBase,
                hiddenDesignMessage.prompt,
              ),
              pendingCommentsForQueue,
            );
      const mergedQueuedImagesBeforeComments =
        hiddenDesignMessage === null
          ? queuedImages
          : [...hiddenDesignMessage.images, ...queuedImages].filter(
              (image, index, allImages) =>
                allImages.findIndex((candidate) => candidate.id === image.id) === index,
            );
      const mergedQueuedImages = mergePendingCommentImages(
        mergedQueuedImagesBeforeComments,
        pendingCommentsForQueue,
      );
      if (mergedQueuedImages.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        toastManager.add({
          type: "warning",
          title: "Too many screenshots",
          description: `Send at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images at a time.`,
        });
        return false;
      }
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
        runtimeMode: activeThread.runtimeMode,
        interactionMode: activeThread.interactionMode,
      };
      const targetThreadId = await ensureQueuedComposerThread({
        titleSeed: promptForQueueBase || pendingCommentsForQueue[0]?.body || "Pending comments",
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
      if (hasPendingComposerComments) {
        setPendingComposerCommentsByThreadId((current) => ({
          ...current,
          [threadId]: [],
        }));
      }
      composerPanelsRef.current?.resetUi("");
      return true;
    },
    [
      buildQueuedComposerImages,
      clearComposerDraftContent,
      composerProviderCommands,
      ensureQueuedComposerThread,
      interactionMode,
      appendQueuedComposerMessage,
      pendingComposerComments,
      runtimeMode,
      selectedModelSelection,
      setThreadError,
      workLogEntries.length,
      isServerThread,
      activeThread,
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
      if (commentSubmissionMode === "accumulate") {
        const existingPendingComments = pendingComposerCommentsByThreadId[threadId] ?? [];
        if (existingPendingComments.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
          throw new Error(
            `You can accumulate up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} browser comments with screenshots.`,
          );
        }
        const target = describeBrowserDesignCommentTarget(submission);
        const hiddenContextBlock = buildBrowserDesignContextBlock({
          requestId: submission.requestId,
          pageUrl: submission.pageUrl,
          pagePath: submission.pagePath,
          selection: submission.selection,
          targetElement: submission.targetElement,
          mainContainer: submission.mainContainer,
        });
        setPendingComposerCommentsByThreadId((current) => ({
          ...current,
          [threadId]: [
            ...(current[threadId] ?? []),
            {
              id: randomUUID(),
              source: "browser",
              body: trimmedInstructions || "Review this browser screenshot.",
              targetLabel: target.targetLabel,
              detailLabel: target.detailLabel,
              hiddenContextBlock,
              image: imageAttachment,
              createdAt: new Date().toISOString(),
            },
          ],
        }));
        return;
      }
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
      const activeSteerRequest = queuedSteerRequestRef.current;
      if (activeSteerRequest?.messageId === messageId) {
        if (serverThread) {
          await clearQueuedSteerRequest(serverThread.id);
        }
        return;
      }
      if (activeSteerRequest) {
        return;
      }
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
    [clearQueuedSteerRequest, serverThread, steerQueuedComposerMessage, workLogEntries.length],
  );
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
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
      composerPanelsRef.current?.resetUi(insertion.prompt);
      window.requestAnimationFrame(() => {
        composerPanelsRef.current?.focusAt(nextCollapsedCursor);
      });
    },
    [activeThread, insertComposerDraftTerminalContext],
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
      storeSetTerminalHeight(activeThreadId, clampBottomPanelHeight(height));
    },
    [activeThreadId, storeSetTerminalHeight],
  );
  const handleBottomPanelResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!activeThreadId) return;
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = terminalState.terminalHeight;
      const handlePointerMove = (moveEvent: PointerEvent) => {
        const nextHeight = startHeight + (startY - moveEvent.clientY);
        storeSetTerminalHeight(activeThreadId, clampBottomPanelHeight(nextHeight));
      };
      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.dispatchEvent(new CustomEvent(SIDEBAR_RESIZE_END_EVENT));
      };
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
    },
    [activeThreadId, storeSetTerminalHeight, terminalState.terminalHeight],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadId) return;
    const nextOpen = !terminalState.terminalOpen;
    setTerminalOpen(nextOpen);
    setBottomPanelMode((current) =>
      nextOpen ? "terminal" : current === "terminal" ? null : current,
    );
  }, [activeThreadId, setTerminalOpen, terminalState.terminalOpen]);

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

  const ensureBrowserRightSidePanelOpenWidth = useCallback(() => {
    const viewportWidth = chatViewportRef.current?.clientWidth ?? window.innerWidth;
    const nextWidth = resolveBrowserOpenRightSidePanelWidth({
      currentWidth: rightSidePanelWidthRef.current,
      viewportWidth,
    });
    syncRightSidePanelWidth(nextWidth);
  }, [syncRightSidePanelWidth]);

  const openBrowser = useCallback(() => {
    if (!isElectron) return;
    setRightSidePanelMode("browser");
    setBrowserMode("split");
    setRightSidePanelVisible(true);
  }, [setBrowserMode, setRightSidePanelMode, setRightSidePanelVisible]);
  const ensureBrowserBridgeController = useCallback(
    async (requestThreadId: ThreadId): Promise<InAppBrowserController> => {
      const existingController = browserControllerByThreadRef.current.get(requestThreadId);
      if (existingController) {
        return existingController;
      }
      if (!isElectron) {
        throw new Error("Ace browser bridge is only available in the desktop app.");
      }
      if (requestThreadId !== activeThreadId) {
        throw new Error("Ace browser bridge can only control a mounted thread browser.");
      }

      ensureBrowserRightSidePanelOpenWidth();
      openBrowser();
      const controller = await waitForBrowserBridgeController({
        timeoutMs: BROWSER_BRIDGE_CONTROLLER_WAIT_MS,
        pollMs: BROWSER_BRIDGE_CONTROLLER_POLL_MS,
        readController: () => browserControllerByThreadRef.current.get(requestThreadId) ?? null,
      });
      if (controller) {
        return controller;
      }

      throw new Error("Ace browser bridge could not attach to the in-app browser.");
    },
    [activeThreadId, ensureBrowserRightSidePanelOpenWidth, openBrowser],
  );
  const closeBrowser = useCallback(() => {
    setBrowserMode("closed");
    setBrowserDevToolsOpen(false);
    setRightSidePanelMode((current) => (current === "browser" ? null : current));
  }, [setBrowserDevToolsOpen, setBrowserMode, setRightSidePanelMode]);
  const onToggleRightSidePanel = useCallback(() => {
    if (rightSidePanelOpen) {
      setRightSidePanelVisible(false);
      return;
    }
    setRightSidePanelVisible(true);
  }, [rightSidePanelOpen, setRightSidePanelVisible]);
  const onNewRightSidePanelEditorTab = useCallback(() => {
    const tab = createPanelEditorTab(rightPanelEditorTabIndexRef.current);
    rightPanelEditorTabIndexRef.current += 1;
    setRightPanelEditorTabs((current) => [...current, tab]);
    setActiveRightPanelEditorTabId(tab.id);
    setRightSidePanelEditorOpen(true);
    setRightSidePanelMode("editor");
    setRightSidePanelVisible(true);
  }, [setRightSidePanelEditorOpen, setRightSidePanelMode, setRightSidePanelVisible]);
  const onSelectRightSidePanelEditorTab = useCallback(
    (tabId: string) => {
      setActiveRightPanelEditorTabId(tabId);
      setRightSidePanelEditorOpen(true);
      setRightSidePanelMode("editor");
      setRightSidePanelVisible(true);
    },
    [setRightSidePanelEditorOpen, setRightSidePanelMode, setRightSidePanelVisible],
  );
  const onCloseRightSidePanelEditorTab = useCallback(
    (tabId: string) => {
      const tabIndex = rightPanelEditorTabs.findIndex((tab) => tab.id === tabId);
      if (tabIndex < 0) return;
      const nextTabs = rightPanelEditorTabs.filter((tab) => tab.id !== tabId);
      setRightPanelEditorTabs(nextTabs);
      if (nextTabs.length === 0) {
        setActiveRightPanelEditorTabId(null);
        setRightSidePanelEditorOpen(false);
        setRightSidePanelMode((current) => (current === "editor" ? null : current));
        return;
      }
      setActiveRightPanelEditorTabId((current) => {
        if (current && current !== tabId && nextTabs.some((tab) => tab.id === current)) {
          return current;
        }
        return nextTabs[Math.min(tabIndex, nextTabs.length - 1)]?.id ?? null;
      });
    },
    [
      rightPanelEditorTabs,
      setRightSidePanelEditorOpen,
      setRightSidePanelMode,
      setRightPanelEditorTabs,
    ],
  );
  const onOpenRightSidePanelEditor = useCallback(() => {
    if (rightPanelEditorTabs.length === 0) {
      onNewRightSidePanelEditorTab();
      return;
    }
    const activeEditorTabId = activeRightPanelEditorTabId ?? rightPanelEditorTabs[0]?.id ?? null;
    setActiveRightPanelEditorTabId(activeEditorTabId);
    setRightSidePanelEditorOpen(true);
    setRightSidePanelMode("editor");
    setRightSidePanelVisible(true);
  }, [
    activeRightPanelEditorTabId,
    onNewRightSidePanelEditorTab,
    rightPanelEditorTabs,
    setRightSidePanelEditorOpen,
    setRightSidePanelMode,
    setRightSidePanelVisible,
  ]);
  const onOpenRightSidePanelTerminal = useCallback(() => {
    setRightSidePanelTerminalOpen(true);
    setRightSidePanelMode("terminal");
    setRightSidePanelVisible(true);
    setTerminalFocusRequestId((value) => value + 1);
  }, [
    setRightSidePanelMode,
    setRightSidePanelTerminalOpen,
    setRightSidePanelVisible,
    setTerminalFocusRequestId,
  ]);
  const openEditorFile = useEditorStateStore((state) => state.openFile);
  const workspaceRootsForInAppFileOpen = useMemo(
    () =>
      [activeThread?.worktreePath, gitCwd, activeProject?.cwd].filter(
        (root): root is string => typeof root === "string" && root.trim().length > 0,
      ),
    [activeProject?.cwd, activeThread?.worktreePath, gitCwd],
  );
  const openMarkdownFileInAppEditor = useCallback(
    (targetPath: string) => {
      if (!activeThreadId) {
        return;
      }
      const normalizedTargetPath = targetPath.trim();
      if (normalizedTargetPath.length === 0) {
        return;
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
      onOpenRightSidePanelEditor();
      openEditorFile(activeThreadId, resolvedFilePath);
    },
    [activeThreadId, onOpenRightSidePanelEditor, openEditorFile, workspaceRootsForInAppFileOpen],
  );
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
      if (mode === "subagent") {
        setRightSidePanelMode("subagent");
        return;
      }
      if (mode === "terminal") {
        onOpenRightSidePanelTerminal();
        return;
      }
      onOpenRightSidePanelEditor();
    },
    [
      onOpenRightSidePanelDiff,
      onOpenRightSidePanelEditor,
      onOpenRightSidePanelTerminal,
      openBrowser,
      setRightSidePanelMode,
      setRightSidePanelVisible,
    ],
  );
  const onOpenRightSidePanelBrowserTab = useCallback(() => {
    openBrowser();
    browserControllerRef.current?.openNewTab();
  }, [openBrowser]);
  const onOpenBottomPanelBrowser = useCallback(() => {
    if (!isElectron) return;
    setBrowserMode("split");
    setBottomPanelBrowserOpen(true);
    setBottomPanelMode("browser");
  }, [setBrowserMode]);
  const onOpenBottomPanelBrowserTab = useCallback(() => {
    onOpenBottomPanelBrowser();
    browserControllerRef.current?.openNewTab();
  }, [onOpenBottomPanelBrowser]);
  const onSelectRightSidePanelBrowserTab = useCallback(
    (tabId: string) => {
      openBrowser();
      const session = getBrowserSession(activeThreadId);
      const index = session?.tabs.findIndex((tab) => tab.id === tabId) ?? -1;
      if (index >= 0) {
        browserControllerRef.current?.setActiveTabByIndex(index);
      }
    },
    [activeThreadId, openBrowser],
  );
  const onSelectBottomPanelBrowserTab = useCallback(
    (tabId: string) => {
      onOpenBottomPanelBrowser();
      const session = getBrowserSession(activeThreadId);
      const index = session?.tabs.findIndex((tab) => tab.id === tabId) ?? -1;
      if (index >= 0) {
        browserControllerRef.current?.setActiveTabByIndex(index);
      }
    },
    [activeThreadId, onOpenBottomPanelBrowser],
  );
  const onCloseRightSidePanelBrowserTab = useCallback(
    (tabId: string) => {
      const session = getBrowserSession(activeThreadId);
      if (session?.tabs.length === 1) {
        closeBrowser();
        if (rightSidePanelMode === "browser") {
          setRightSidePanelMode(null);
        }
        return;
      }
      browserControllerRef.current?.closeTab(tabId);
      if (rightSidePanelMode === "browser" && session?.tabs.length === 1) {
        setRightSidePanelMode(null);
      }
    },
    [activeThreadId, closeBrowser, rightSidePanelMode, setRightSidePanelMode],
  );
  const onReorderRightSidePanelBrowserTab = useCallback(
    (draggedTabId: string, targetTabId: string) => {
      browserControllerRef.current?.reorderTabs(draggedTabId, targetTabId);
    },
    [],
  );
  const onCloseRightSidePanelEditor = useCallback(() => {
    const activeEditorTabId = activeRightPanelEditorTabId ?? rightPanelEditorTabs[0]?.id ?? null;
    if (activeEditorTabId) {
      onCloseRightSidePanelEditorTab(activeEditorTabId);
      return;
    }
    setRightSidePanelEditorOpen(false);
    setRightSidePanelMode((current) => (current === "editor" ? null : current));
  }, [
    activeRightPanelEditorTabId,
    onCloseRightSidePanelEditorTab,
    rightPanelEditorTabs,
    setRightSidePanelEditorOpen,
    setRightSidePanelMode,
  ]);
  const onNewBottomPanelEditorTab = useCallback(() => {
    const tab = createPanelEditorTab(bottomPanelEditorTabIndexRef.current);
    bottomPanelEditorTabIndexRef.current += 1;
    setBottomPanelEditorTabs((current) => [...current, tab]);
    setActiveBottomPanelEditorTabId(tab.id);
    setBottomPanelMode("editor");
  }, []);
  const onSelectBottomPanelEditorTab = useCallback((tabId: string) => {
    setActiveBottomPanelEditorTabId(tabId);
    setBottomPanelMode("editor");
  }, []);
  const onCloseBottomPanelEditorTab = useCallback(
    (tabId: string) => {
      const tabIndex = bottomPanelEditorTabs.findIndex((tab) => tab.id === tabId);
      if (tabIndex < 0) return;
      const nextTabs = bottomPanelEditorTabs.filter((tab) => tab.id !== tabId);
      setBottomPanelEditorTabs(nextTabs);
      if (nextTabs.length === 0) {
        setActiveBottomPanelEditorTabId(null);
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
    },
    [bottomPanelEditorTabs, setTerminalOpen],
  );
  const onCloseBottomPanelEditor = useCallback(() => {
    const activeEditorTabId = activeBottomPanelEditorTabId ?? bottomPanelEditorTabs[0]?.id ?? null;
    if (activeEditorTabId) {
      onCloseBottomPanelEditorTab(activeEditorTabId);
      return;
    }
    setBottomPanelMode((current) => (current === "editor" ? "terminal" : current));
    setTerminalOpen(true);
  }, [
    activeBottomPanelEditorTabId,
    bottomPanelEditorTabs,
    onCloseBottomPanelEditorTab,
    setTerminalOpen,
  ]);
  const onOpenBottomPanelEditor = useCallback(() => {
    if (bottomPanelEditorTabs.length === 0) {
      onNewBottomPanelEditorTab();
      return;
    }
    setActiveBottomPanelEditorTabId(
      activeBottomPanelEditorTabId ?? bottomPanelEditorTabs[0]?.id ?? null,
    );
    setBottomPanelMode("editor");
  }, [activeBottomPanelEditorTabId, bottomPanelEditorTabs, onNewBottomPanelEditorTab]);
  const onCloseRightSidePanelTerminal = useCallback(() => {
    setRightSidePanelTerminalOpen(false);
    if (rightSidePanelMode === "terminal") {
      setRightSidePanelMode(null);
    }
  }, [rightSidePanelMode, setRightSidePanelMode, setRightSidePanelTerminalOpen]);
  const onCloseBottomPanelTerminal = useCallback(() => {
    setTerminalOpen(false);
    setBottomPanelMode((current) => (current === "terminal" ? null : current));
  }, [setTerminalOpen]);
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
  const onOpenBottomPanelDiff = useCallback(() => {
    setBottomPanelReviewOpen(true);
    setBottomPanelMode("diff");
    setLocalDiffState((previous) => ({ ...previous, open: true }));
  }, [setLocalDiffState]);
  const onCloseBottomPanelDiff = useCallback(() => {
    setBottomPanelReviewOpen(false);
    setBottomPanelMode((current) => (current === "diff" ? "terminal" : current));
    setLocalDiffState((previous) => ({ ...previous, open: false }));
    setTerminalOpen(true);
  }, [setLocalDiffState, setTerminalOpen]);
  const onCloseBottomPanelBrowser = useCallback(() => {
    setBottomPanelBrowserOpen(false);
    setBottomPanelMode((current) => (current === "browser" ? "terminal" : current));
    setTerminalOpen(true);
    if (!(rightSidePanelVisible && rightSidePanelMode === "browser")) {
      closeBrowser();
    }
  }, [closeBrowser, rightSidePanelMode, rightSidePanelVisible, setTerminalOpen]);
  const onCloseBottomPanelBrowserTab = useCallback(
    (tabId: string) => {
      const session = getBrowserSession(activeThreadId);
      if (session?.tabs.length === 1) {
        onCloseBottomPanelBrowser();
        return;
      }
      browserControllerRef.current?.closeTab(tabId);
      if (session?.tabs.length === 1) {
        setBottomPanelMode((current) => (current === "browser" ? "terminal" : current));
        setTerminalOpen(true);
      }
    },
    [activeThreadId, onCloseBottomPanelBrowser, setTerminalOpen],
  );
  const onReorderBottomPanelBrowserTab = useCallback(
    (draggedTabId: string, targetTabId: string) => {
      browserControllerRef.current?.reorderTabs(draggedTabId, targetTabId);
    },
    [],
  );
  const onSelectBottomPanelMode = useCallback(
    (mode: DockPanelMode) => {
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
    },
    [
      onOpenBottomPanelBrowser,
      onOpenBottomPanelDiff,
      onOpenBottomPanelEditor,
      setTerminalFocusRequestId,
      setTerminalOpen,
    ],
  );
  const bottomPanelOpen =
    bottomPanelMode !== null ||
    bottomPanelBrowserOpen ||
    bottomPanelEditorTabs.length > 0 ||
    bottomPanelReviewOpen ||
    terminalState.terminalOpen;
  const onToggleBottomPanel = useCallback(() => {
    if (bottomPanelOpen) {
      setBottomPanelMode(null);
      setBottomPanelBrowserOpen(false);
      setBottomPanelEditorTabs([]);
      setActiveBottomPanelEditorTabId(null);
      setBottomPanelReviewOpen(false);
      setTerminalOpen(false);
      return;
    }
    setBottomPanelMode("terminal");
    setTerminalOpen(true);
    setTerminalFocusRequestId((value) => value + 1);
  }, [bottomPanelOpen, setTerminalFocusRequestId, setTerminalOpen]);
  const onToggleRightSidePanelFullscreen = useCallback(() => {
    setRightSidePanelFullscreen((current) => !current);
  }, [setRightSidePanelFullscreen]);
  const onToggleRightSidePanelFloatingChat = useCallback(() => {
    if (!rightSidePanelFullscreen) return;
    setRightSidePanelFloatingChatOpen((current) => !current);
  }, [rightSidePanelFullscreen, setRightSidePanelFloatingChatOpen]);
  const onBrowserSessionChange = useCallback(
    (browserThreadId: ThreadId, session: BrowserSessionStorage) => {
      setBrowserSession(browserThreadId, session);
    },
    [],
  );
  const getBrowserSessionChangeHandler = useCallback(
    (browserThreadId: ThreadId) => {
      const existingHandler = browserSessionChangeHandlerByThreadRef.current.get(browserThreadId);
      if (existingHandler) {
        return existingHandler;
      }
      const handler = (session: BrowserSessionStorage) => {
        onBrowserSessionChange(browserThreadId, session);
      };
      browserSessionChangeHandlerByThreadRef.current.set(browserThreadId, handler);
      return handler;
    },
    [onBrowserSessionChange],
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
    [setBrowserDevToolsOpen],
  );
  const handleBrowserRuntimeStateChange = useCallback(
    (browserThreadId: ThreadId, state: { devToolsOpen: boolean }) => {
      browserRuntimeStateByThreadRef.current.set(browserThreadId, state);
      if (activeBrowserThreadIdRef.current !== browserThreadId) {
        return;
      }
      setBrowserDevToolsOpen(state.devToolsOpen);
    },
    [setBrowserDevToolsOpen],
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
    if (!ownsGlobalSideEffects || !rightSidePanelInteractive) {
      return;
    }
    if (!isElectron) {
      return;
    }

    handleBrowserLaunchRequest();
    return subscribeToBrowserLaunchRequests(handleBrowserLaunchRequest);
  }, [handleBrowserLaunchRequest, ownsGlobalSideEffects, rightSidePanelInteractive]);

  useEffect(() => {
    if (!ownsGlobalSideEffects || !rightSidePanelInteractive || !isElectron) {
      return;
    }
    const api = readNativeApi();
    if (!api) {
      return;
    }
    return api.browser.onBridgeRequest((request) => {
      void (async () => {
        try {
          const controller = await ensureBrowserBridgeController(request.threadId);
          const result = await controller.runBridgeRequest(request);
          await api.browser.resolveBridgeRequest({
            ok: true,
            requestId: request.requestId,
            result,
          });
        } catch (error) {
          await api.browser.resolveBridgeRequest({
            error:
              error instanceof Error && error.message ? error.message : "Browser bridge failed.",
            ok: false,
            requestId: request.requestId,
          });
        }
      })().catch((error: unknown) => {
        reportBackgroundError("Failed to resolve browser bridge request.", error);
      });
    });
  }, [ensureBrowserBridgeController, ownsGlobalSideEffects, rightSidePanelInteractive]);

  const syncBrowserSplitWidth = useCallback(
    (nextWidth: number) => {
      const viewportWidth = chatViewportRef.current?.clientWidth ?? window.innerWidth;
      const clampedWidth = clampBrowserSplitWidth(nextWidth, viewportWidth);
      browserSplitWidthRef.current = clampedWidth;
      setBrowserSplitWidth(clampedWidth);
      if (lastSyncedBrowserSplitWidthRef.current === clampedWidth) {
        return;
      }
      lastSyncedBrowserSplitWidthRef.current = clampedWidth;
      setStoredBrowserSplitWidth(clampedWidth);
    },
    [setBrowserSplitWidth, setStoredBrowserSplitWidth],
  );
  const syncBrowserSplitWidthEvent = useEffectEvent((nextWidth: number) => {
    syncBrowserSplitWidth(nextWidth);
  });

  const handleBrowserSplitResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const contentElement = event.currentTarget
        .closest<HTMLElement>("[data-chat-view-browser-split-panel]")
        ?.querySelector<HTMLElement>("[data-chat-view-browser-split-content]");
      browserSplitResizePointerIdRef.current = event.pointerId;
      browserSplitResizeStateRef.current = {
        contentElement: contentElement ?? null,
        pendingWidth: browserSplitWidthRef.current,
        rafId: null,
        startX: event.clientX,
        startWidth: browserSplitWidthRef.current,
      };
      applyResizablePanelWidth(contentElement ?? null, browserSplitWidthRef.current);
      didResizeBrowserSplitDuringDragRef.current = false;
    },
    [],
  );
  const handleBrowserSplitResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!rightSidePanelInteractive || browserMode !== "split") {
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
    [browserMode, rightSidePanelInteractive, syncBrowserSplitWidth],
  );

  useEffect(() => {
    if (!rightSidePanelInteractive || browserMode !== "split") {
      return;
    }
    const handlePointerMove = (event: PointerEvent) => {
      if (browserSplitResizePointerIdRef.current !== null) {
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
        resizeState.pendingWidth = nextWidth;
        if (resizeState.rafId === null) {
          resizeState.rafId = window.requestAnimationFrame(() => {
            const activeResizeState = browserSplitResizeStateRef.current;
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
        didResizeBrowserSplitDuringDragRef.current = true;
      }
    };
    const handlePointerEnd = () => {
      if (browserSplitResizePointerIdRef.current === null) {
        return;
      }
      const resizeState = browserSplitResizeStateRef.current;
      if (resizeState?.rafId !== null && resizeState?.rafId !== undefined) {
        window.cancelAnimationFrame(resizeState.rafId);
      }
      if (resizeState) {
        applyResizablePanelWidth(resizeState.contentElement, resizeState.pendingWidth);
      }
      browserSplitResizePointerIdRef.current = null;
      browserSplitResizeStateRef.current = null;
      if (!didResizeBrowserSplitDuringDragRef.current) {
        clearResizablePanelWidth(resizeState?.contentElement ?? null);
        return;
      }
      didResizeBrowserSplitDuringDragRef.current = false;
      syncBrowserSplitWidthEvent(browserSplitWidthRef.current);
      window.requestAnimationFrame(() => {
        clearResizablePanelWidth(resizeState?.contentElement ?? null);
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
  }, [browserMode, rightSidePanelInteractive, setBrowserSplitWidth]);
  useEffect(() => {
    if (!rightSidePanelInteractive) {
      return;
    }
    const viewportWidth = chatViewportRef.current?.clientWidth ?? window.innerWidth;
    const clampedWidth = clampBrowserSplitWidth(storedBrowserSplitWidth, viewportWidth);
    browserSplitWidthRef.current = clampedWidth;
    lastSyncedBrowserSplitWidthRef.current = clampedWidth;
    setBrowserSplitWidth(clampedWidth);
  }, [rightSidePanelInteractive, setBrowserSplitWidth, storedBrowserSplitWidth]);

  useEffect(() => {
    if (!rightSidePanelInteractive || browserMode !== "split") {
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
        syncBrowserSplitWidthEvent(clampedWidth);
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
  }, [browserMode, rightSidePanelInteractive, setBrowserSplitWidth]);

  const syncWorkspaceEditorSplitWidth = useCallback(
    (nextWidth: number) => {
      const viewportWidth = workspaceViewportRef.current?.clientWidth ?? window.innerWidth;
      const clampedWidth = clampWorkspaceEditorSplitWidth(nextWidth, viewportWidth);
      workspaceEditorSplitWidthRef.current = clampedWidth;
      setWorkspaceEditorSplitWidth(clampedWidth);
      if (lastSyncedWorkspaceEditorSplitWidthRef.current === clampedWidth) {
        return;
      }
      lastSyncedWorkspaceEditorSplitWidthRef.current = clampedWidth;
      setStoredWorkspaceEditorSplitWidth(clampedWidth);
    },
    [setStoredWorkspaceEditorSplitWidth, setWorkspaceEditorSplitWidth],
  );
  const syncWorkspaceEditorSplitWidthEvent = useEffectEvent((nextWidth: number) => {
    syncWorkspaceEditorSplitWidth(nextWidth);
  });

  const handleWorkspaceEditorSplitResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
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
    },
    [],
  );

  useEffect(() => {
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
        return;
      }
      didResizeWorkspaceEditorSplitDuringDragRef.current = false;
      syncWorkspaceEditorSplitWidthEvent(workspaceEditorSplitWidthRef.current);
      window.requestAnimationFrame(() => {
        clearResizablePanelWidth(resizeState?.contentElement ?? null);
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

  useEffect(() => {
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
  }, [editorHostedInRightPanel, setWorkspaceEditorSplitWidth, workspaceMode]);

  const resizeBrowserViewportForBridge = useCallback(
    (
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
    },
    [
      activeThreadId,
      rightSidePanelInteractive,
      setBrowserMode,
      setRightSidePanelFullscreen,
      setRightSidePanelMode,
      setRightSidePanelVisible,
      syncRightSidePanelWidth,
    ],
  );
  const resizeBrowserViewportForBridgeEvent = useEffectEvent(
    (browserThreadId: ThreadId, request: BrowserViewportResizeRequest) =>
      resizeBrowserViewportForBridge(browserThreadId, request),
  );
  const getBrowserViewportResizeHandler = useCallback(
    (browserThreadId: ThreadId) => {
      const existingHandler = browserViewportResizeHandlerByThreadRef.current.get(browserThreadId);
      if (existingHandler) {
        return existingHandler;
      }
      const handler = (request: BrowserViewportResizeRequest) =>
        resizeBrowserViewportForBridgeEvent(browserThreadId, request);
      browserViewportResizeHandlerByThreadRef.current.set(browserThreadId, handler);
      return handler;
    },
    [resizeBrowserViewportForBridgeEvent],
  );

  const handleRightSidePanelResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
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
      applyResizablePanelWidth(
        dockedRightSidePanelHeaderRef.current,
        rightSidePanelWidthRef.current,
      );
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
        return;
      }
      didResizeRightSidePanelDuringDragRef.current = false;
      syncRightSidePanelWidthEvent(rightSidePanelWidthRef.current);
      window.requestAnimationFrame(() => {
        clearResizablePanelWidth(resizeState?.panelElement ?? null);
        clearResizablePanelWidth(resizeState?.headerElement ?? null);
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
      const browserResizeState = browserSplitResizeStateRef.current;
      if (browserResizeState?.rafId !== null && browserResizeState?.rafId !== undefined) {
        window.cancelAnimationFrame(browserResizeState.rafId);
      }
      clearResizablePanelWidth(browserResizeState?.contentElement ?? null);
      browserSplitResizePointerIdRef.current = null;
      browserSplitResizeStateRef.current = null;
      if (didResizeBrowserSplitDuringDragRef.current) {
        didResizeBrowserSplitDuringDragRef.current = false;
        syncBrowserSplitWidthEvent(browserSplitWidthRef.current);
      }
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
      const rightPanelResizeState = rightSidePanelResizeStateRef.current;
      if (rightPanelResizeState?.rafId !== null && rightPanelResizeState?.rafId !== undefined) {
        window.cancelAnimationFrame(rightPanelResizeState.rafId);
      }
      clearResizablePanelWidth(rightPanelResizeState?.panelElement ?? null);
      clearResizablePanelWidth(rightPanelResizeState?.headerElement ?? null);
      rightSidePanelResizePointerIdRef.current = null;
      rightSidePanelResizeStateRef.current = null;
      if (didResizeRightSidePanelDuringDragRef.current) {
        didResizeRightSidePanelDuringDragRef.current = false;
        syncRightSidePanelWidthEvent(rightSidePanelWidthRef.current);
      }
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

  useEffect(() => {
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
  }, [
    rightSidePanelFullscreen,
    rightSidePanelInteractive,
    rightSidePanelOpen,
    setRightSidePanelWidth,
  ]);

  const createNewTerminal = useCallback(() => {
    if (!activeThreadId) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeNewTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, setTerminalFocusRequestId, storeNewTerminal]);
  const createNewPanelTerminal = useCallback(() => {
    if (!activeThreadId) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeNewBackgroundTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, setTerminalFocusRequestId, storeNewBackgroundTerminal]);
  const createSplitTerminal = useCallback(() => {
    if (!activeThreadId) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeSplitTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, setTerminalFocusRequestId, storeSplitTerminal]);
  const activateTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId) return;
      storeSetActiveTerminal(activeThreadId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, setTerminalFocusRequestId, storeSetActiveTerminal],
  );
  const moveTerminal = useCallback(
    (terminalId: string, targetGroupId: string, targetIndex: number) => {
      if (!activeThreadId) return;
      storeMoveTerminal(activeThreadId, terminalId, targetGroupId, targetIndex);
    },
    [activeThreadId, storeMoveTerminal],
  );
  const setTerminalGroupSplitRatios = useCallback(
    (groupId: string, ratios: number[]) => {
      if (!activeThreadId) return;
      storeSetTerminalGroupSplitRatios(activeThreadId, groupId, ratios);
    },
    [activeThreadId, storeSetTerminalGroupSplitRatios],
  );
  const readActiveTerminalState = useCallback(() => {
    if (!activeThreadId) {
      return null;
    }
    return selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      activeThreadId,
    );
  }, [activeThreadId]);
  const closeTerminalTarget = useCallback(
    (targetTerminalId: string) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;
      const currentTerminalState = readActiveTerminalState();
      const isFinalTerminal = (currentTerminalState?.terminalIds.length ?? 1) <= 1;
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
    [activeThreadId, readActiveTerminalState, setTerminalFocusRequestId, storeCloseTerminal],
  );
  const setTerminalAutoTitle = useCallback(
    (terminalId: string, title: string | null) => {
      if (!activeThreadId) return;
      storeSetTerminalAutoTitle(activeThreadId, terminalId, title);
    },
    [activeThreadId, storeSetTerminalAutoTitle],
  );
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
      const currentTerminalState = readActiveTerminalState();
      const baseTerminalId =
        currentTerminalState?.activeTerminalId ||
        currentTerminalState?.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy =
        currentTerminalState?.runningTerminalIds.includes(baseTerminalId) ?? false;
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
        deriveTerminalTitleFromCommand(script.command),
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
      readActiveTerminalState,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetTerminalAutoTitle,
      storeSetActiveTerminal,
      setLastInvokedScriptByProjectId,
      setTerminalFocusRequestId,
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
    dispatchChatViewDialogState({
      type: "set-pending-pull-request-setup-request",
      pendingPullRequestSetupRequest: null,
    });
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

  const readCurrentComposerExecutionModeState = useCallback(
    () =>
      deriveEffectiveComposerExecutionModeState({
        draft: getComposerThreadDraft(threadId),
        threadRuntimeMode: activeThread?.runtimeMode ?? null,
        threadInteractionMode: activeThread?.interactionMode ?? null,
      }),
    [activeThread?.interactionMode, activeThread?.runtimeMode, threadId],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      const currentRuntimeMode = readCurrentComposerExecutionModeState().runtimeMode;
      if (mode === currentRuntimeMode) return;
      setComposerDraftRuntimeMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      readCurrentComposerExecutionModeState,
      isLocalDraftThread,
      scheduleComposerFocus,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
      threadId,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      const currentInteractionMode = readCurrentComposerExecutionModeState().interactionMode;
      if (mode === currentInteractionMode) return;
      setComposerDraftInteractionMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      readCurrentComposerExecutionModeState,
      isLocalDraftThread,
      scheduleComposerFocus,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
      threadId,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    const currentInteractionMode = readCurrentComposerExecutionModeState().interactionMode;
    handleInteractionModeChange(currentInteractionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, readCurrentComposerExecutionModeState]);
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
    },
    [serverThread],
  );

  // Auto-scroll on new messages
  const messageCount = timelineMessages.length;
  const markMessagesAtBottom = useCallback(
    (scrollContainer: HTMLDivElement) => {
      lastKnownScrollTopRef.current = scrollContainer.scrollTop;
      shouldAutoScrollRef.current = true;
      pendingUserScrollUpIntentRef.current = false;
      isPointerScrollActiveRef.current = false;
      lastTouchClientYRef.current = null;
      setShowScrollToBottom(false);
    },
    [setShowScrollToBottom],
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
  }, [cancelPendingStickToBottom, scheduleStickToBottom, setShowScrollToBottom]);
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
    if (!activeForSideEffects) return;
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
    activeForSideEffects,
    activeThread?.id,
    cancelPendingInteractionAnchorAdjustment,
    cancelPendingStickToBottom,
    forceStickToBottom,
    scheduleStickToBottom,
    setShowScrollToBottom,
  ]);
  useEffect(() => {
    if (!activeForSideEffects) return;
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [activeForSideEffects, messageCount, scheduleStickToBottom]);
  useEffect(() => {
    if (!activeForSideEffects) return;
    if (!liveTurnInProgress) return;
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [activeForSideEffects, liveTurnInProgress, scheduleStickToBottom, timelineEntries]);

  useEffect(() => {
    resetThreadScopedUi();
    if (openSummaryOnNextThreadRef.current) {
      openSummaryOnNextThreadRef.current = false;
      if (rightSidePanelEnabled) {
        setRightSidePanelMode("summary");
        setRightSidePanelVisible(true);
      }
    }
  }, [activeThread?.id, rightSidePanelEnabled, setRightSidePanelMode, setRightSidePanelVisible]);

  useEffect(() => {
    if (!ownsGlobalSideEffects) return;
    if (!activeThread?.id || terminalState.terminalOpen) return;
    return scheduleComposerFocus();
  }, [ownsGlobalSideEffects, activeThread?.id, scheduleComposerFocus, terminalState.terminalOpen]);

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
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    resetLocalDispatch();
    queuedDesignMessageEditRef.current = null;
    setExpandedImage(null);
  }, [resetLocalDispatch, threadId]);

  const closeExpandedImage = useEffectEvent(() => {
    setExpandedImage(null);
  });
  const navigateExpandedImage = useEffectEvent((direction: -1 | 1) => {
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
  }, [expandedImage]);

  const activeWorktreePath = activeThread?.worktreePath;
  const envMode: DraftThreadEnvMode = activeWorktreePath
    ? "worktree"
    : isLocalDraftThread
      ? (draftThread?.envMode ?? "local")
      : "local";

  useEffect(() => {
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
  useEffect(() => {
    if (terminalState.terminalOpen) {
      setBottomPanelMode((current) => current ?? "terminal");
      return;
    }
    setBottomPanelMode((current) => (current === "terminal" ? null : current));
  }, [terminalState.terminalOpen]);

  useEffect(() => {
    if (!ownsGlobalSideEffects) return;
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
        browserControllerRef.current?.setDesignerModeActive(false);
      }
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: Boolean(terminalState.terminalOpen),
        browserOpen,
        rightPanelOpen: rightSidePanelOpen,
        rightPanelFullscreen: rightSidePanelFullscreen,
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

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        createSplitTerminal();
        return;
      }

      if (command === "rightPanel.review.open") {
        event.preventDefault();
        event.stopPropagation();
        onOpenRightSidePanelDiff();
        return;
      }

      if (command === "rightPanel.terminal.open") {
        event.preventDefault();
        event.stopPropagation();
        onOpenRightSidePanelTerminal();
        return;
      }

      if (command === "rightPanel.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleRightSidePanel();
        return;
      }

      if (command === "rightPanel.fullscreen.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!rightSidePanelOpen) return;
        onToggleRightSidePanelFullscreen();
        return;
      }

      if (command === "rightPanel.floatingChat.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleRightSidePanelFloatingChat();
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

      if (command === "browser.designer.areaComment") {
        event.preventDefault();
        event.stopPropagation();
        browserControllerRef.current?.toggleDesignerTool("area-comment");
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
    ownsGlobalSideEffects,
    terminalState.terminalOpen,
    terminalState.activeTerminalId,
    activeThreadId,
    openBrowser,
    closeTerminal,
    createNewTerminal,
    createSplitTerminal,
    setTerminalOpen,
    runProjectScript,
    keybindings,
    onOpenRightSidePanelBrowserTab,
    onToggleRightSidePanel,
    onToggleRightSidePanelFullscreen,
    onToggleRightSidePanelFloatingChat,
    onOpenRightSidePanelTerminal,
    onOpenRightSidePanelEditor,
    onOpenRightSidePanelDiff,
    rightSidePanelFullscreen,
    rightSidePanelOpen,
    shortcutsEnabled,
    toggleInteractionMode,
    toggleWorkspaceMode,
    toggleHeaderVisibility,
    toggleTerminalVisibility,
  ]);

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
      setIsRevertingCheckpoint,
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
          addComposerImagesToDraft(
            composerImagesSnapshot.flatMap((image) =>
              "dataUrl" in image ? [] : [cloneComposerImageForRetry(image)],
            ),
          );
          addComposerTerminalContextsToDraft(composerTerminalContextsSnapshot);
          composerPanelsRef.current?.resetUi(promptForRestore);
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
  const sendQueuedComposerMessage = useCallback(
    async (messageId: MessageId) => {
      if (!serverThread || liveTurnInProgress || isSendBusy || isConnecting) {
        return;
      }
      if (sendInFlightRef.current) {
        return;
      }
      if (!queuedComposerMessagesRef.current.some((message) => message.id === messageId)) {
        return;
      }
      await dispatchQueuedComposerMessage(serverThread.id, messageId);
    },
    [dispatchQueuedComposerMessage, isConnecting, isSendBusy, liveTurnInProgress, serverThread],
  );
  const submitWorkspaceAgentNote = useCallback(
    async (input: { mode: "queue" | "send"; prompt: string }) => {
      const trimmedPrompt = input.prompt.trim();
      if (trimmedPrompt.length === 0) {
        return false;
      }
      if (input.mode === "queue") {
        return queuePreparedMessage(trimmedPrompt);
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
    },
    [
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

  const onForkConversation = useEffectEvent(async () => {
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
    } finally {
      setHandoffInFlight(false);
    }
  });

  const onSend = useEffectEvent(async (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    const api = readNativeApi();
    if (!api || !activeThread) return;
    if (activePendingProgress) {
      onAdvanceActivePendingUserInput();
      return;
    }
    if (liveTurnInProgress || isSendBusy || isConnecting) {
      await queueCurrentComposerMessage();
      return;
    }
    if (sendInFlightRef.current) return;
    const promptForSend = promptRef.current;
    const promptForSendWithoutInlineMarkers = stripComposerInlineMarkers(promptForSend);
    const composerImages = composerImagesRef.current;
    const pendingCommentsForSend = pendingComposerComments;
    const hasPendingComposerComments = pendingCommentsForSend.length > 0;
    const composerTerminalContexts = composerTerminalContextsRef.current;
    const hiddenDesignMessage = queuedDesignMessageEditRef.current;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSendWithoutInlineMarkers,
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
      composerPanelsRef.current?.resetUi("");
      await onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      });
      return;
    }
    const providerSlashCommandPayload =
      composerImages.length === 0 && sendableComposerTerminalContexts.length === 0
        ? parseProviderComposerSlashCommand(trimmed, composerProviderCommands)
        : null;
    const standaloneSlashCommand =
      providerSlashCommandPayload === null ? parseStandaloneComposerSlashCommand(trimmed) : null;
    if (standaloneSlashCommand) {
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(activeThread.id);
      composerPanelsRef.current?.resetUi("");
      return;
    }
    const composerIssuesCommandPayload =
      providerSlashCommandPayload === null ? parseComposerIssuesCommand(trimmed) : null;
    const isIssuesCommandText =
      composerImages.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      providerSlashCommandPayload === null &&
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
        composerPanelsRef.current?.resetUi("");
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
    if (!hasSendableContent && !hasPendingComposerComments) {
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
    const promptForDispatchBase =
      providerSlashCommandPayload?.promptText ?? promptForSendWithoutInlineMarkers;
    let promptWithIssueContext = promptForDispatchBase;
    let imagesWithIssueContext: Array<ComposerImageAttachment | QueuedComposerImageAttachment> =
      hiddenDesignMessage === null
        ? composerImages
        : [...hiddenDesignMessage.images, ...composerImages].filter(
            (image, index, allImages) =>
              allImages.findIndex((candidate) => candidate.id === image.id) === index,
          );
    if (
      providerSlashCommandPayload === null &&
      composerIssuesCommandPayload === null &&
      gitCwd &&
      isGitRepo
    ) {
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
            promptWithIssueContext = `${promptForDispatchBase}\n\n${payload.prompt}`;
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
    const promptWithPendingComments = buildAccumulatedCommentsPrompt(
      promptWithHiddenDesignContext,
      pendingCommentsForSend,
    );
    imagesWithIssueContext = mergePendingCommentImages(
      imagesWithIssueContext,
      pendingCommentsForSend,
    );
    if (imagesWithIssueContext.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      toastManager.add({
        type: "warning",
        title: "Too many screenshots",
        description: `Send at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images at a time.`,
      });
      return;
    }
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
    composerPanelsRef.current?.resetUi("");

    const dispatched = await dispatchComposerMessage(
      {
        prompt: promptWithPendingComments,
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
    if (dispatched && hasPendingComposerComments) {
      setPendingComposerCommentsByThreadId((current) => ({
        ...current,
        [threadId]: [],
      }));
    }
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
      composerPanelsRef.current?.resetUi("");
    },
    [activePendingUserInput],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
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
    },
    [activePendingUserInput],
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
        effort: readCurrentSelectedPromptEffort(),
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
        if (rightSidePanelEnabled && nextInteractionMode === "default") {
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
      readCurrentSelectedPromptEffort,
      resetLocalDispatch,
      rightSidePanelEnabled,
      runtimeMode,
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
      effort: readCurrentSelectedPromptEffort(),
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
    async (provider: ProviderKind, _mode: ThreadHandoffMode) => {
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
      } finally {
        setHandoffInFlight(false);
      }
    },
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
      if (!rightSidePanelEnabled) {
        return;
      }
      setRightSidePanelDiffOpenState(true);
      setRightSidePanelReviewOpen(true);
      setRightSidePanelMode("diff");
      setRightSidePanelVisible(true);
      setLocalDiffState({ open: true, turnId, filePath: filePath ?? null });
    },
    [
      rightSidePanelEnabled,
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
  const onRevertAssistantMessage = useCallback(
    (messageId: MessageId) => {
      const targetTurnCount = revertTurnCountByAssistantMessageId.get(messageId);
      if (typeof targetTurnCount !== "number") {
        return;
      }
      void onRevertToTurnCount(targetTurnCount);
    },
    [onRevertToTurnCount, revertTurnCountByAssistantMessageId],
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
  const onFixGitHubIssuesInParallelWorktrees = useEffectEvent(
    async (issueNumbers: ReadonlyArray<number>) => {
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
    },
  );

  const isLineageThread = Boolean(
    serverThread?.handoff ?? serverThread?.fork ?? activeThread?.handoff ?? activeThread?.fork,
  );
  const activeThreadHistoryLoaded = activeThread?.historyLoaded;
  const activeThreadIdValue = activeThread?.id ?? "";
  const activeThreadMessagesLength = activeThread?.messages.length ?? 0;
  const activeThreadProvider = activeThread?.session?.provider;
  const activeThreadModelProvider = activeThread?.modelSelection.provider;
  const canForkActiveThread = isServerThread && activeThreadMessagesLength > 0;
  const messagesTimelineProps = useMemo(
    () => ({
      hasMessages:
        timelineEntries.length > 0 ||
        (isThreadHistoryLoading && activeThreadMessagesLength > 0) ||
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
      activeTurnInProgress: isWorking || !latestTurnSettled,
      activeTurnStartedAt: activeWorkStartedAt,
      stuckTurnSnapshot,
      onStopStuckTurn: onInterrupt,
      onOpenStuckTurnDiagnostics: () => openDiagnostics("thread"),
      backgroundMarkdownPrewarm: activeForSideEffects,
      hideCompletedWorkMessages,
      liveTimers: activeForSideEffects,
      getScrollContainer: getMessagesScrollContainer,
      timelineEntries,
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
      timestampFormat,
      workspaceRoot: activeProject?.cwd ?? undefined,
    }),
    [
      activeProject?.cwd,
      activeThreadMessagesLength,
      activeThreadProvider,
      activeThreadModelProvider,
      canForkActiveThread,
      activeForSideEffects,
      activeWorkStartedAt,
      stuckTurnSnapshot,
      canOpenLocalMarkdownFiles,
      completionDividerBeforeEntryId,
      completionSummary,
      expandedWorkGroups,
      codingGitCwd,
      composerProviderCommands,
      isGitRepo,
      isLineageThread,
      hideCompletedWorkMessages,
      handoffInFlight,
      isRevertingCheckpoint,
      isThreadHistoryLoading,
      isWorking,
      latestTurnSettled,
      getMessagesScrollContainer,
      onExpandTimelineImage,
      onOpenTurnDiff,
      openDiagnostics,
      onRevertAssistantMessage,
      onRevertUserMessage,
      onToggleWorkGroup,
      openGitHubIssueDialog,
      openBrowserUrlInNewTab,
      openMarkdownFileInAppEditor,
      resolvedTheme,
      revertTurnCountByAssistantMessageId,
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
  const environmentPanelCanUseInlineLayout = chatViewportSize.width >= 1120;
  const environmentPanelVisible = environmentPanelOpen && activeThread !== undefined;
  const environmentPanelInlineOpen =
    environmentPanelVisible && !rightSidePanelOpen && environmentPanelCanUseInlineLayout;
  const environmentPanelPopoverOpen = environmentPanelVisible && !environmentPanelInlineOpen;
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
    };

    document.addEventListener("pointerdown", handlePointerDownCapture, { capture: true });

    return () => {
      document.removeEventListener("pointerdown", handlePointerDownCapture, { capture: true });
    };
  }, [environmentPanelPopoverOpen, setEnvironmentPanelOpen]);
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
      timelineKey: `${activeThreadIdValue}:${activeThreadHistoryLoaded === false ? "lean" : "hydrated"}`,
    }),
    [
      activeThreadHistoryLoaded,
      activeThreadIdValue,
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
  const branchToolbarProps =
    isGitRepo && activeThread
      ? {
          threadId: activeThread.id,
          currentBranchName: activeThreadBranchName,
          onEnvModeChange,
          envLocked,
          localEnvironmentLabel: activeRemoteHost?.name ?? "Local",
          localEnvironmentIcon: activeEnvironmentIcon,
          onComposerFocusRequest: scheduleComposerFocus,
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
        activePlanProgress,
        activeSubagentThreadId,
        activeThreadId: activeThread.id,
        branchToolbarProps,
        gitCwd,
        isGitRepo,
        isAgentWorking: isWorking,
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
  const browserPanel =
    isElectron && activeThreadId
      ? (() => {
          const mountedBrowserThreadIds = mountedBrowserInstances.map((entry) => entry.instanceId);
          const orderedBrowserThreadIds = [
            ...(browserOpen ? [activeThreadId] : []),
            ...mountedBrowserThreadIds.filter(
              (browserThreadId) => browserThreadId !== activeThreadId,
            ),
          ];
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
                  activeInstance: isActiveBrowserThread && browserOpen && rightSidePanelInteractive,
                  connectionUrl: browserConnectionUrl,
                  visible: isActiveBrowserThread && browserOpen,
                  mode: browserViewMode,
                  onClose: closeBrowser,
                  onBrowserSessionChange: getBrowserSessionChangeHandler(browserThreadId),
                  onControllerChange: getBrowserControllerChangeHandler(browserThreadId),
                  onActiveRuntimeStateChange: getBrowserRuntimeStateChangeHandler(browserThreadId),
                  onResizeViewport: getBrowserViewportResizeHandler(browserThreadId),
                  onToggleRightPanelFloatingChat: onToggleRightSidePanelFloatingChat,
                  onToggleRightPanelFullscreen: onToggleRightSidePanelFullscreen,
                  backShortcutLabel: browserBackShortcutLabel,
                  designerAreaCommentShortcutLabel: browserDesignerAreaCommentShortcutLabel,
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
    ? (effectiveRightSidePanelMode ?? (diffOpen ? "diff" : null))
    : null;
  const activeRightSidePanelMode =
    requestedRightSidePanelMode === "browser" && !browserPanel
      ? null
      : requestedRightSidePanelMode === "editor" && rightPanelEditorTabs.length === 0
        ? null
        : requestedRightSidePanelMode;
  const bottomPanelHasContent = bottomPanelOpen;
  const requestedBottomPanelMode: DockPanelMode | null = bottomPanelHasContent
    ? (bottomPanelMode ?? "terminal")
    : null;
  const activeBottomPanelMode =
    requestedBottomPanelMode === "browser" && !browserPanel ? null : requestedBottomPanelMode;
  const activeRightPanelBrowserSession = useBrowserSession(browserOpen ? activeThreadId : null);
  const activeRightPanelBrowserTabId = activeRightPanelBrowserSession?.activeTabId ?? null;
  const rightPanelTerminalTabs = useMemo(
    () =>
      terminalState.terminalIds.map((terminalId) => ({
        id: terminalId,
        label: resolveTerminalDisplayTitle({
          autoTitle: terminalState.autoTerminalTitlesById[terminalId],
          cwd: gitCwd ?? activeProject?.cwd ?? "",
          isRunning: terminalState.runningTerminalIds.includes(terminalId),
          terminalId,
        }),
        running: terminalState.runningTerminalIds.includes(terminalId),
      })),
    [
      activeProject?.cwd,
      gitCwd,
      terminalState.autoTerminalTitlesById,
      terminalState.runningTerminalIds,
      terminalState.terminalIds,
    ],
  );
  const avoidNativeBrowserPanelTransforms = isElectron && activeRightSidePanelMode === "browser";
  const showDockedRightSidePanelChrome = rightSidePanelOpen && !rightSidePanelFullscreen;
  const dockedRightSidePanelWidth = constrainedPanelWidth(
    rightSidePanelWidth,
    MIN_RIGHT_SIDE_PANEL_CHAT_WIDTH,
    MIN_RIGHT_SIDE_PANEL_WIDTH,
  );
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
        terminalShortcutLabel={rightPanelTerminalShortcutLabel}
        terminalOpen={rightSidePanelTerminalOpen}
        terminalTabs={rightPanelTerminalTabs}
        activeTerminalId={terminalState.activeTerminalId}
        activeSubagentThreadId={activeSubagentThreadId}
        floatingChatOpen={rightSidePanelFloatingChatOpen}
        onBrowserTabClose={onCloseRightSidePanelBrowserTab}
        onBrowserTabReorder={onReorderRightSidePanelBrowserTab}
        onBrowserTabSelect={onSelectRightSidePanelBrowserTab}
        onToggleBottomPanel={onToggleBottomPanel}
        onDiffClose={onCloseRightSidePanelDiff}
        onEditorTabClose={onCloseRightSidePanelEditorTab}
        onEditorTabSelect={onSelectRightSidePanelEditorTab}
        onTerminalClose={onCloseRightSidePanelTerminal}
        onTerminalTabClose={closeTerminal}
        onTerminalTabSelect={(terminalId) => {
          activateTerminal(terminalId);
          onOpenRightSidePanelTerminal();
        }}
        onNewBrowserTab={onOpenRightSidePanelBrowserTab}
        onNewEditorTab={onNewRightSidePanelEditorTab}
        onNewTerminalTab={createNewPanelTerminal}
        onSelectMode={onSelectRightSidePanelMode}
        onSelectSubagentThread={setActiveSubagentThreadId}
        onTogglePanelVisibility={onToggleRightSidePanel}
        onToggleFloatingChat={() => {
          onToggleRightSidePanelFloatingChat();
        }}
        onToggleFullscreen={onToggleRightSidePanelFullscreen}
        panelToggleShortcutLabel={rightSidePanelToggleShortcutLabel}
        subagentThreads={subagentThreads}
      />
    ) : null;
  const bottomPanelTabStrip = (className?: string) =>
    activeBottomPanelMode ? (
      <RightSidePanelTabStrip
        activeMode={activeBottomPanelMode}
        activeBrowserTabId={activeRightPanelBrowserTabId}
        browserSession={bottomPanelBrowserOpen ? activeRightPanelBrowserSession : null}
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
        terminalShortcutLabel={terminalToggleShortcutLabel}
        terminalOpen={terminalState.terminalOpen}
        terminalTabs={rightPanelTerminalTabs}
        activeTerminalId={terminalState.activeTerminalId}
        activeSubagentThreadId={activeSubagentThreadId}
        floatingChatOpen={false}
        onBrowserTabClose={onCloseBottomPanelBrowserTab}
        onBrowserTabReorder={onReorderBottomPanelBrowserTab}
        onBrowserTabSelect={onSelectBottomPanelBrowserTab}
        onDiffClose={onCloseBottomPanelDiff}
        onEditorTabClose={onCloseBottomPanelEditorTab}
        onEditorTabSelect={onSelectBottomPanelEditorTab}
        onTerminalClose={onCloseBottomPanelTerminal}
        onTerminalTabClose={closeTerminal}
        onTerminalTabSelect={(terminalId) => {
          activateTerminal(terminalId);
          onSelectBottomPanelMode("terminal");
        }}
        onNewBrowserTab={onOpenBottomPanelBrowserTab}
        onNewEditorTab={onNewBottomPanelEditorTab}
        onNewTerminalTab={createNewTerminal}
        onSelectMode={onSelectBottomPanelMode}
        onSelectSubagentThread={setActiveSubagentThreadId}
        onTogglePanelVisibility={onToggleBottomPanel}
        onToggleFloatingChat={() => undefined}
        onToggleFullscreen={() => undefined}
        panelToggleShortcutLabel={null}
        showPanelActions={false}
        subagentThreads={subagentThreads}
      />
    ) : null;
  const rightPanelChooserOptions: PanelChooserOption[] = [
    {
      label: "Files",
      description: "Browse project files",
      icon: FolderIcon,
      shortcutLabel: rightPanelEditorShortcutLabel,
      onSelect: onOpenRightSidePanelEditor,
    },
    {
      label: "Summary",
      description: "Review thread context",
      icon: ListTodoIcon,
      onSelect: () => onSelectRightSidePanelMode("summary"),
    },
    {
      label: "Browser",
      description: "Open a website",
      icon: GlobeIcon,
      disabled: !isElectron,
      shortcutLabel: browserNewTabShortcutLabel,
      onSelect: onOpenRightSidePanelBrowserTab,
    },
    {
      label: "Review",
      description: "View code changes",
      icon: DiffIcon,
      disabled: !isGitRepo,
      shortcutLabel: reviewPanelShortcutLabel,
      onSelect: onOpenRightSidePanelDiff,
    },
    {
      label: "Terminal",
      description: "Start an interactive shell",
      icon: SquareTerminalIcon,
      shortcutLabel: rightPanelTerminalShortcutLabel,
      onSelect: onOpenRightSidePanelTerminal,
    },
  ];

  const handleQueueComposerMessage = useCallback(() => {
    queueCurrentComposerMessage(liveTurnInProgress ? "steer" : "queue");
  }, [liveTurnInProgress, queueCurrentComposerMessage]);
  const canSendQueuedComposerMessages =
    queuedComposerMessages.length > 0 &&
    !liveTurnInProgress &&
    !isSendBusy &&
    !isConnecting &&
    !sendInFlightRef.current;
  const subagentComposerThreadId = useCallback(
    (subagent: SubagentThread) =>
      ThreadId.makeUnsafe(`subagent:${activeThread?.id ?? threadId}:${subagent.id}`),
    [activeThread?.id, threadId],
  );
  const handleSubagentComposerSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>, subagent: SubagentThread) => {
      event.preventDefault();
      const api = readNativeApi();
      if (!api || !activeThread) return;
      const draftThreadId = subagentComposerThreadId(subagent);
      const draft = getComposerThreadDraft(draftThreadId);
      const promptForSend = draft.prompt;
      const promptForSendWithoutInlineMarkers = stripComposerInlineMarkers(promptForSend);
      const { sendableTerminalContexts, expiredTerminalContextCount, hasSendableContent } =
        deriveComposerSendState({
          prompt: promptForSendWithoutInlineMarkers,
          imageCount: draft.images.length,
          terminalContexts: draft.terminalContexts,
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
        return;
      }

      const { interactionMode, runtimeMode } = deriveEffectiveComposerExecutionModeState({
        draft,
        threadRuntimeMode: activeThread.runtimeMode,
        threadInteractionMode: activeThread.interactionMode,
      });
      const { selectedModel, modelOptions } = deriveEffectiveComposerModelState({
        draft,
        providers: providerStatuses,
        selectedProvider: "codex",
        threadModelSelection: activeThread.modelSelection,
        projectModelSelection: activeProject?.defaultModelSelection,
        settings: modelSettings,
      });
      const sideProviderInstanceId =
        draft.modelSelectionByProvider.codex?.providerInstanceId ??
        (activeThread.modelSelection.provider === "codex"
          ? activeThread.modelSelection.providerInstanceId
          : undefined);
      const sideProviderModels = getProviderModels(
        providerStatuses,
        "codex",
        sideProviderInstanceId,
      );
      const sideProviderState = getComposerProviderState({
        provider: "codex",
        model: selectedModel,
        models: sideProviderModels,
        prompt: promptForSendWithoutInlineMarkers,
        modelOptions,
      });
      const modelSelection = buildProviderModelSelection(
        "codex",
        selectedModel,
        sideProviderState.modelOptionsForDispatch,
        sideProviderInstanceId,
      );
      const textWithTerminalContext = appendTerminalContextsToPrompt(
        promptForSendWithoutInlineMarkers,
        sendableTerminalContexts,
      );
      const outgoingMessageText = formatOutgoingPrompt({
        provider: "codex",
        model: selectedModel,
        models: sideProviderModels,
        effort: sideProviderState.promptEffort,
        text: textWithTerminalContext,
      });
      let attachments: Array<{
        type: "image";
        name: string;
        mimeType: string;
        sizeBytes: number;
        dataUrl: string;
      }>;
      try {
        attachments = await Promise.all(
          draft.images.map(async (image) => ({
            type: "image" as const,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl:
              "dataUrl" in image && typeof image.dataUrl === "string"
                ? image.dataUrl
                : await readFileAsDataUrl(image.file),
          })),
        );
      } catch (error) {
        setThreadError(
          draftThreadId,
          error instanceof Error ? error.message : "Failed to read message attachments.",
        );
        return;
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
      const createdAt = new Date().toISOString();
      try {
        setThreadError(draftThreadId, null);
        await api.orchestration.dispatchCommand({
          type: "thread.subagent.turn.start",
          commandId: newCommandId(),
          threadId: activeThread.id,
          subagentThreadId: TrimmedNonEmptyString.makeUnsafe(subagent.id),
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingMessageText,
            attachments,
          },
          modelSelection,
          runtimeMode,
          interactionMode,
          createdAt,
        });
        clearComposerDraftContent(draftThreadId);
        subagentComposerPanelsRef.current?.resetUi("");
      } catch (error) {
        setThreadError(
          draftThreadId,
          error instanceof Error ? error.message : "Failed to send subagent message.",
        );
      }
    },
    [
      activeProject?.defaultModelSelection,
      activeThread,
      clearComposerDraftContent,
      modelSettings,
      providerStatuses,
      setThreadError,
      subagentComposerThreadId,
    ],
  );
  const renderSubagentComposer = useCallback(
    (subagent: SubagentThread) => {
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
    },
    [
      activeContextWindow,
      activeForSideEffects,
      activeProject?.defaultModelSelection,
      activeThread,
      composerModelOptions,
      composerProviderCommands,
      gitCwd,
      handleSubagentComposerSubmit,
      isConnecting,
      isGitRepo,
      modelOptionsByProvider,
      modelSettings,
      onComposerIssueTokenClick,
      onExpandTimelineImage,
      providerInstancesByProvider,
      providerStatuses,
      resolvedTheme,
      scheduleStickToBottom,
      setComposerDraftInteractionMode,
      setComposerDraftRuntimeMode,
      setThreadError,
      subagentComposerThreadId,
      togglePlanModeShortcutLabel,
    ],
  );
  const handleComposerSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    void onSend(event);
  }, []);
  if (!activeThread) {
    return <NewThreadLanding />;
  }
  const rightSidePanelTabStripNode = rightSidePanelTabStrip("h-full bg-transparent px-2.5");
  const bottomPanelTabStripNode = bottomPanelTabStrip("h-full bg-transparent px-2.5");
  const showRightPanelChatDock =
    rightSidePanelFullscreen && rightSidePanelFloatingChatOpen && activeRightSidePanelMode !== null;
  const dockedRightSidePanelHeader = (
    <AnimatePresence initial={false} mode="sync">
      {showDockedRightSidePanelChrome ? (
        <m.div
          key="thread-right-side-panel-top-bar"
          ref={dockedRightSidePanelHeaderRef}
          className={cn(
            "relative z-30 flex min-h-[44px] shrink-0 items-stretch overflow-hidden bg-sidebar [-webkit-app-region:no-drag]",
            !rightSidePanelInteractive && "pointer-events-none select-none",
          )}
          initial={{ width: 0, opacity: 0, x: 20 }}
          animate={{ width: dockedRightSidePanelWidth, opacity: 1, x: 0 }}
          exit={{ width: 0, opacity: 0, x: 20 }}
          transition={PANEL_SPRING_TRANSITION}
        >
          <div className="relative h-full w-3 shrink-0" aria-hidden="true">
            <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/75" />
          </div>
          <m.div
            className="min-w-0 flex-1 overflow-hidden"
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 8 }}
            transition={PANEL_SPRING_TRANSITION}
          >
            {rightSidePanelTabStripNode}
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
            "absolute inset-0 z-40 flex min-w-0 items-stretch overflow-hidden bg-sidebar [-webkit-app-region:no-drag]",
            !rightSidePanelInteractive && "pointer-events-none select-none",
          )}
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={PANEL_SPRING_TRANSITION}
        >
          <m.div
            className="min-w-0 flex-1 overflow-hidden"
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 8 }}
            transition={PANEL_SPRING_TRANSITION}
          >
            {rightSidePanelTabStripNode}
          </m.div>
        </m.div>
      ) : null}
    </AnimatePresence>
  );

  return (
    <LazyMotion features={domAnimation}>
      <div
        ref={chatShellRef}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
      >
        {/* Persistent top bar — always visible regardless of workspace mode */}
        <div
          className={cn(
            "relative flex shrink-0 items-stretch overflow-hidden bg-sidebar transition-[max-height,opacity] duration-200 ease-out after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border/70",
            isHeaderHidden ? "max-h-0 opacity-0" : "max-h-28 opacity-100",
          )}
        >
          <AppPageTopBar
            className="min-w-0 flex-1"
            desktopDragRegion={!rightSidePanelFullscreen}
            showSidebarTrigger={showSidebarTrigger}
          >
            <div className="flex min-w-0 flex-1 items-center overflow-hidden">
              {paneControls ? (
                <div className="mr-1 flex shrink-0 items-center gap-0.5">{paneControls}</div>
              ) : null}
              <div className="flex min-w-0 flex-1 items-center overflow-hidden">
                <ChatHeader
                  activeThreadTitle={activeThread.title}
                  activeProjectId={activeProject?.id ?? null}
                  activeProjectName={activeProject?.name}
                  isGitRepo={isGitRepo}
                  terminalAvailable={activeProject !== undefined}
                  terminalOpen={terminalState.terminalOpen}
                  terminalToggleShortcutLabel={terminalToggleShortcutLabel}
                  environmentPanelOpen={environmentPanelOpen}
                  rightSidePanelToggleShortcutLabel={rightSidePanelToggleShortcutLabel}
                  rightSidePanelOpen={rightSidePanelOpen}
                  onActiveProjectChange={isLocalDraftThread ? handleActiveProjectChange : null}
                  onToggleEnvironmentPanel={() => {
                    setEnvironmentPanelOpen((open) => !open);
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
                />
              </div>
            </div>
          </AppPageTopBar>
          {dockedRightSidePanelHeader}
          {fullscreenRightSidePanelHeader}
        </div>

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
        {reliabilityUxEnabled ? (
          <ReliabilityDiagnosticsDialog
            open={diagnosticsOpen}
            onOpenChange={setDiagnosticsOpen}
            connection={connectionHealth}
            provider={activeProviderStatus}
            thread={activeThread}
            focus={diagnosticsFocus}
            turnRunning={liveTurnInProgress}
            onStopTurn={liveTurnInProgress ? onInterrupt : null}
          />
        ) : null}
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
                          ? ENVIRONMENT_MINI_PANEL_RESERVED_WIDTH_PX
                          : 0,
                      }}
                      transition={PANEL_SPRING_TRANSITION}
                    >
                      {/* Messages Wrapper */}
                      <ChatMessagesPane {...chatMessagesPaneProps} />

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
                        selectedModelForPickerWithCustomFallback={
                          selectedModelForPickerWithCustomFallback
                        }
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
                        canSendQueuedMessages={canSendQueuedComposerMessages}
                        pendingComposerComments={pendingComposerCommentItems}
                        liveTurnInProgress={liveTurnInProgress}
                        isConnecting={isConnecting}
                        isPreparingWorktree={isPreparingWorktree}
                        isSendBusy={isSendBusy}
                        allowQueueWhenSendable={!sendInFlightRef.current || isServerThread}
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
                        showFloatingDock={showRightPanelChatDock}
                        floatingDockFooter={null}
                        floatingDockPortalHost={
                          showRightPanelChatDock ? chatShellRef.current : null
                        }
                        onComposerHeightChange={scheduleStickToBottom}
                        onPreviewExpandedImage={onExpandTimelineImage}
                        onIssuePreviewOpen={onComposerIssueTokenClick}
                        onPendingUserInputCustomAnswerChange={
                          onChangeActivePendingUserInputCustomAnswer
                        }
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
                    <AnimatePresence initial={false}>
                      {environmentPanelVisible && environmentMiniPanelProps ? (
                        <EnvironmentMiniPanel
                          key="environment-mini-panel"
                          ref={environmentMiniPanelRef}
                          {...environmentMiniPanelProps}
                          layoutMode={environmentPanelInlineOpen ? "inline" : "popover"}
                        />
                      ) : null}
                    </AnimatePresence>
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
                  "flex h-full min-h-0 overflow-hidden bg-background",
                  avoidNativeBrowserPanelTransforms
                    ? "will-change-[width,opacity]"
                    : "transform-gpu will-change-[width,transform,opacity]",
                  !rightSidePanelInteractive && "pointer-events-none select-none",
                  rightSidePanelFullscreen
                    ? "absolute inset-y-0 right-0 z-40"
                    : "relative shrink-0",
                )}
                initial={
                  avoidNativeBrowserPanelTransforms
                    ? { width: 0, opacity: 0 }
                    : { width: 0, opacity: 0, x: 24 }
                }
                animate={
                  avoidNativeBrowserPanelTransforms
                    ? {
                        width: rightSidePanelFullscreen
                          ? "100%"
                          : constrainedPanelWidth(
                              rightSidePanelWidth,
                              MIN_RIGHT_SIDE_PANEL_CHAT_WIDTH,
                              MIN_RIGHT_SIDE_PANEL_WIDTH,
                            ),
                        opacity: 1,
                      }
                    : {
                        width: rightSidePanelFullscreen
                          ? "100%"
                          : constrainedPanelWidth(
                              rightSidePanelWidth,
                              MIN_RIGHT_SIDE_PANEL_CHAT_WIDTH,
                              MIN_RIGHT_SIDE_PANEL_WIDTH,
                            ),
                        opacity: 1,
                        x: 0,
                      }
                }
                exit={
                  avoidNativeBrowserPanelTransforms
                    ? { width: 0, opacity: 0 }
                    : { width: 0, opacity: 0, x: 24 }
                }
                transition={PANEL_SPRING_TRANSITION}
              >
                {!rightSidePanelFullscreen ? (
                  <hr
                    aria-orientation="vertical"
                    aria-label="Resize right side panel"
                    tabIndex={0}
                    className="group relative z-20 h-auto w-3 shrink-0 cursor-col-resize touch-none select-none border-0 bg-transparent outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border/75 before:transition-colors before:duration-200 before:ease-out before:content-[''] after:absolute after:inset-y-1 after:left-1/2 after:w-2 after:-translate-x-1/2 after:rounded-full after:bg-transparent after:transition-[background-color,transform] after:duration-200 after:ease-out after:content-[''] hover:before:bg-border hover:after:scale-x-100 hover:after:bg-foreground/5 focus-visible:before:bg-border focus-visible:after:scale-x-100 focus-visible:after:bg-foreground/5"
                    onKeyDown={handleRightSidePanelResizeKeyDown}
                    onPointerDown={handleRightSidePanelResizePointerDown}
                  />
                ) : null}
                <m.div
                  className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                  initial={
                    avoidNativeBrowserPanelTransforms ? { opacity: 0 } : { opacity: 0, x: 8 }
                  }
                  animate={
                    avoidNativeBrowserPanelTransforms ? { opacity: 1 } : { opacity: 1, x: 0 }
                  }
                  exit={avoidNativeBrowserPanelTransforms ? { opacity: 0 } : { opacity: 0, x: 6 }}
                  transition={PANEL_SPRING_TRANSITION}
                >
                  <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
                    <AnimatePresence mode="wait" initial={false}>
                      {activeRightSidePanelMode === null ? (
                        <m.div
                          key="thread-right-side-panel-content-chooser"
                          className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
                          initial={{ opacity: 0, x: 8 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -6 }}
                          transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                        >
                          <PanelChooser options={rightPanelChooserOptions} />
                        </m.div>
                      ) : activeRightSidePanelMode !== "browser" ? (
                        <m.div
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
                              generatedWorkspaceSummary={activeGeneratedWorkspaceSummary}
                              activeProvider={activeThread?.session?.provider ?? null}
                              markdownCwd={gitCwd ?? undefined}
                              onOpenDiffPanel={
                                isGitRepo ? () => setRightSidePanelMode("diff") : null
                              }
                              onRegenerateSummary={handleRegenerateSummary}
                              onOpenBrowserUrl={isElectron ? openBrowserUrlInNewTab : null}
                              onOpenFilePath={
                                canOpenLocalMarkdownFiles ? openMarkdownFileInAppEditor : null
                              }
                              enableLocalFileLinks={canOpenLocalMarkdownFiles}
                              workspaceDiffSummary={workspaceDiffSummary}
                              workspaceRoot={activeProject?.cwd ?? undefined}
                            />
                          ) : activeRightSidePanelMode === "diff" ? (
                            <LocalDiffPanel
                              threadId={activeThread.id}
                              diffState={localDiffState}
                              onAddReviewComment={addDiffReviewComment}
                              onDiffStateChange={setLocalDiffState}
                            />
                          ) : activeRightSidePanelMode === "subagent" ? (
                            <SubagentWorkspacePanel
                              activeThreadId={activeSubagentThreadId}
                              composer={renderSubagentComposer}
                              timelineProps={messagesTimelineProps}
                              threads={subagentThreads}
                            />
                          ) : activeRightSidePanelMode === "terminal" ? (
                            <ConnectedThreadTerminalPanel
                              activeThreadId={activeThread.id}
                              activeProjectAvailable={activeProject !== undefined}
                              cwd={gitCwd ?? activeProject?.cwd ?? null}
                              runtimeEnv={threadTerminalRuntimeEnv}
                              focusRequestId={terminalFocusRequestId}
                              interactive={activeForSideEffects}
                              onNewTerminal={createNewPanelTerminal}
                              newShortcutLabel={newTerminalShortcutLabel ?? undefined}
                              toggleShortcutLabel={rightPanelTerminalShortcutLabel ?? undefined}
                              onActiveTerminalChange={activateTerminal}
                              onMoveTerminal={moveTerminal}
                              onSplitRatiosChange={setTerminalGroupSplitRatios}
                              onAutoTerminalTitleChange={setTerminalAutoTitle}
                              onCloseTerminal={closeTerminal}
                              onToggleTerminal={toggleTerminalVisibility}
                              onClosePanelTerminal={onCloseRightSidePanelTerminal}
                              onHeightChange={setTerminalHeight}
                              onAddTerminalContext={addTerminalContextToDraft}
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
                                key={activeRightPanelEditorTabId ?? "right-panel-editor"}
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
                                onDetached={onCloseRightSidePanelEditor}
                                onSubmitAgentNote={submitWorkspaceAgentNote}
                              />
                            </Suspense>
                          ) : null}
                        </m.div>
                      ) : null}
                    </AnimatePresence>
                    {browserPanel && activeBottomPanelMode !== "browser" ? (
                      <div
                        className={cn(
                          "absolute inset-0 min-h-0 min-w-0",
                          activeRightSidePanelMode === "browser"
                            ? "z-10"
                            : "pointer-events-none invisible z-0",
                        )}
                      >
                        <RetainedBrowserInstances instances={browserPanel.instances} />
                      </div>
                    ) : null}
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
              className="relative flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden border-t border-border/70 bg-background will-change-[height,opacity]"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: terminalState.terminalHeight + 48, opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={BOTTOM_PANEL_SPRING_TRANSITION}
            >
              <hr
                aria-orientation="horizontal"
                aria-label="Resize bottom panel"
                tabIndex={0}
                className="group absolute inset-x-0 top-0 z-30 h-2 cursor-row-resize touch-none select-none border-0 bg-transparent outline-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-border/75 before:transition-colors before:content-[''] after:absolute after:inset-x-0 after:top-0 after:h-2 after:bg-transparent after:transition-colors after:content-[''] hover:before:bg-border hover:after:bg-foreground/5 focus-visible:before:bg-border focus-visible:after:bg-foreground/5"
                onPointerDown={handleBottomPanelResizePointerDown}
              />
              <m.div
                className="flex min-h-0 flex-1 transform-gpu flex-col overflow-hidden will-change-[transform,opacity]"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={PANEL_SPRING_TRANSITION}
              >
                <div className="flex h-12 shrink-0 items-stretch border-b border-border/70 bg-sidebar">
                  {bottomPanelTabStripNode}
                </div>
                <div
                  className="min-h-0 flex-1 overflow-hidden"
                  style={{ height: `${terminalState.terminalHeight}px` }}
                >
                  {activeBottomPanelMode === "summary" ? (
                    <PlanSummaryPanel
                      activePlan={activePlan}
                      activeProposedPlan={sidebarProposedPlan}
                      generatedWorkspaceSummary={activeGeneratedWorkspaceSummary}
                      activeProvider={activeThread?.session?.provider ?? null}
                      markdownCwd={gitCwd ?? undefined}
                      onOpenDiffPanel={isGitRepo ? onOpenBottomPanelDiff : null}
                      onRegenerateSummary={handleRegenerateSummary}
                      onOpenBrowserUrl={isElectron ? openBrowserUrlInNewTab : null}
                      onOpenFilePath={
                        canOpenLocalMarkdownFiles ? openMarkdownFileInAppEditor : null
                      }
                      enableLocalFileLinks={canOpenLocalMarkdownFiles}
                      workspaceDiffSummary={workspaceDiffSummary}
                      workspaceRoot={activeProject?.cwd ?? undefined}
                    />
                  ) : activeBottomPanelMode === "diff" ? (
                    <LocalDiffPanel
                      threadId={activeThread.id}
                      diffState={localDiffState}
                      onAddReviewComment={addDiffReviewComment}
                      onDiffStateChange={setLocalDiffState}
                    />
                  ) : activeBottomPanelMode === "subagent" ? (
                    <SubagentWorkspacePanel
                      activeThreadId={activeSubagentThreadId}
                      composer={renderSubagentComposer}
                      timelineProps={messagesTimelineProps}
                      threads={subagentThreads}
                    />
                  ) : activeBottomPanelMode === "terminal" ? (
                    <ConnectedThreadTerminalPanel
                      activeThreadId={activeThread.id}
                      activeProjectAvailable={activeProject !== undefined}
                      cwd={gitCwd ?? activeProject?.cwd ?? null}
                      runtimeEnv={threadTerminalRuntimeEnv}
                      focusRequestId={terminalFocusRequestId}
                      interactive={activeForSideEffects}
                      onNewTerminal={createNewTerminal}
                      newShortcutLabel={newTerminalShortcutLabel ?? undefined}
                      toggleShortcutLabel={terminalToggleShortcutLabel ?? undefined}
                      onActiveTerminalChange={activateTerminal}
                      onMoveTerminal={moveTerminal}
                      onSplitRatiosChange={setTerminalGroupSplitRatios}
                      onAutoTerminalTitleChange={setTerminalAutoTitle}
                      onCloseTerminal={closeTerminal}
                      onToggleTerminal={toggleTerminalVisibility}
                      onClosePanelTerminal={onCloseBottomPanelTerminal}
                      onHeightChange={setTerminalHeight}
                      onAddTerminalContext={addTerminalContextToDraft}
                    />
                  ) : activeBottomPanelMode === "editor" ? (
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
                        key={activeBottomPanelEditorTabId ?? "bottom-panel-editor"}
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
                        onDetached={onCloseBottomPanelEditor}
                        onSubmitAgentNote={submitWorkspaceAgentNote}
                      />
                    </Suspense>
                  ) : activeBottomPanelMode === "browser" && browserPanel ? (
                    <RetainedBrowserInstances instances={browserPanel.instances} />
                  ) : null}
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
