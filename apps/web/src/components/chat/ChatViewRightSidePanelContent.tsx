import React, { type ComponentProps, type ReactNode, Suspense, lazy } from "react";
import { AnimatePresence, m } from "motion/react";
import type { EditorId, ResolvedKeybindingsConfig, ThreadId, TurnId } from "@ace/contracts";
import { cn } from "~/lib/utils";
import {
  type ActivePlanState,
  type LatestProposedPlanState,
  type GeneratedWorkspaceSummary,
} from "~/session-logic";
import { PlanSummaryPanel } from "../PlanSummaryPanel";
import { LocalDiffPanel } from "./ChatViewRightSidePanels";
import { SubagentWorkspacePanel } from "./SubagentThreadsPanel";
import { ConnectedThreadTerminalPanel } from "./ConnectedThreadTerminalPanel";
import { BrowserPanelInstanceList } from "./BrowserPanelInstanceList";
import type { SubagentThread } from "./subagentThreads";
import type { DiffReviewCommentInput } from "../DiffPanel";
import type {
  ActiveBrowserRuntimeState,
  BrowserViewportResizeRequest,
  BrowserViewportResizeResult,
  InAppBrowserController,
} from "../InAppBrowser";
import type { BrowserSessionStorage } from "~/lib/browser/session";
import type { BrowserDesignRequestSubmission } from "~/lib/browser/types";
import type { TerminalContextSelection } from "~/lib/terminalContext";
import type { Thread } from "~/types";
import type { LocalDiffState } from "./chatViewTypes";
import type { MessagesTimeline } from "./MessagesTimeline";

const ThreadWorkspaceEditor = lazy(() => import("../editor/ThreadWorkspaceEditor"));

function DeferredPanelBodyPlaceholder() {
  return (
    <div aria-hidden="true" className="h-full min-h-0 flex-1 overflow-hidden bg-background">
      <div className="h-full bg-foreground/[0.025]" />
    </div>
  );
}

export interface ChatViewRightSidePanelContentProps {
  rightSidePanelBodyDeferred: boolean;
  activeRightSidePanelMode: string | null;

  activePlan: ActivePlanState | null;
  sidebarProposedPlan: LatestProposedPlanState | null;
  activeGeneratedWorkspaceSummary: GeneratedWorkspaceSummary | null;
  workspaceDiffSummary?: {
    additions: number;
    deletions: number;
    fileCount: number;
  } | null;
  activeThread: Thread | undefined;
  gitCwd: string | null;
  isGitRepo: boolean;
  canOpenLocalMarkdownFiles: boolean;
  isElectron?: boolean;
  openBrowserUrlInNewTab: (url: string) => void;
  openMarkdownFileInAppEditor: (path: string) => void | Promise<void>;
  handleRegenerateSummary?: () => void;
  activeProject: { cwd: string } | undefined;
  setRightSidePanelMode?: (mode: string) => void;

  localDiffState: { filePath: string | null; open: boolean; turnId: TurnId | null };
  addDiffReviewComment: (comment: DiffReviewCommentInput) => void;
  setLocalDiffState: (state: LocalDiffState | ((state: LocalDiffState) => LocalDiffState)) => void;

  visibleActiveSubagentThreadId: string | null;
  renderSubagentComposer: (thread: SubagentThread) => ReactNode;
  messagesTimelineProps: ComponentProps<typeof MessagesTimeline>;
  subagentThreads: ReadonlyArray<SubagentThread>;

  threadTerminalRuntimeEnv: Record<string, string> | undefined;
  terminalFocusRequestId: number;
  activeForSideEffects: boolean;
  createNewPanelTerminal: () => void;
  newTerminalShortcutLabel: string | null | undefined;
  rightPanelTerminalShortcutLabel: string | null | undefined;
  activatePanelTerminal: (terminalId: string) => void;
  movePanelTerminal: (terminalId: string, targetGroupId: string, targetIndex: number) => void;
  setPanelTerminalGroupSplitRatios: (groupId: string, ratios: number[]) => void;
  setTerminalAutoTitle: (terminalId: string, title: string | null) => void;
  closeTerminal: (terminalId: string) => void;
  toggleTerminalVisibility: () => void;
  onCloseRightSidePanelTerminal: () => void;
  setRightPanelTerminalHeight: (height: number) => void;
  addTerminalContextToDraft: (selection: TerminalContextSelection) => void;

  activeRightPanelEditorTabId: string | null | undefined;
  rightPanelFallbackEditorStateInstanceId: string | undefined;
  availableEditors: ReadonlyArray<EditorId>;
  activeThreadBranchName: string | null;
  activeServerConnectionUrl: string;
  keybindings: ResolvedKeybindingsConfig;
  anyBrowserOpen: boolean;
  terminalState: { terminalOpen: boolean };
  onCloseRightSidePanelEditor: () => void;
  submitWorkspaceAgentNote: (input: {
    mode: "queue" | "send";
    prompt: string;
    threadId?: ThreadId;
  }) => Promise<boolean>;

  rightBrowserPanelInstanceIds: readonly string[];
  bottomBrowserInstanceId: string | null;
  bottomPanelBrowserOpen: boolean;
  bottomPanelMotionActive: boolean;
  browserBackShortcutLabel: string | null;
  browserDesignerAreaCommentShortcutLabel: string | null;
  browserDesignerElementCommentShortcutLabel: string | null;
  browserDevToolsShortcutLabel: string | null;
  browserForwardShortcutLabel: string | null;
  browserReloadShortcutLabel: string | null;
  browserViewMode: ComponentProps<typeof BrowserPanelInstanceList> extends {
    browserViewMode: infer M;
  }
    ? M
    : unknown;
  closeBrowser: () => void;
  detachBottomPanelBrowser: () => void;
  detachRightSidePanelBrowser: () => void;
  handleBrowserRuntimeStateChange: (
    browserInstanceId: string,
    state: ActiveBrowserRuntimeState,
  ) => void;
  onBrowserSessionChange: (browserInstanceId: string, session: BrowserSessionStorage) => void;
  onCloseBottomPanelBrowser: () => void;
  onToggleRightSidePanelFloatingChat: () => void;
  onToggleRightSidePanelFullscreen: () => void;
  queueBrowserDesignRequest: (
    browserThreadId: ThreadId,
    submission: BrowserDesignRequestSubmission,
  ) => Promise<void>;
  resolveBrowserThreadConnectionUrl: (browserThreadId: ThreadId) => string;
  resizeBrowserViewportForBridge: (
    browserThreadId: ThreadId,
    request: BrowserViewportResizeRequest,
  ) => BrowserViewportResizeResult;
  isThreadHistoryLoading: boolean;
  rightBrowserInstanceId: string | null;
  rightBrowserOpen: boolean;
  rightSidePanelMotionActive: boolean;
  rightSidePanelInteractive: boolean;
  setBrowserController: (
    browserInstanceId: string,
    controller: InAppBrowserController | null,
  ) => void;
}

export const ChatViewRightSidePanelContent = React.memo(function ChatViewRightSidePanelContent({
  rightSidePanelBodyDeferred,
  activeRightSidePanelMode,
  activePlan,
  sidebarProposedPlan,
  activeGeneratedWorkspaceSummary,
  workspaceDiffSummary,
  activeThread,
  gitCwd,
  isGitRepo,
  canOpenLocalMarkdownFiles,
  isElectron,
  openBrowserUrlInNewTab,
  openMarkdownFileInAppEditor,
  handleRegenerateSummary,
  activeProject,
  setRightSidePanelMode,
  localDiffState,
  addDiffReviewComment,
  setLocalDiffState,
  visibleActiveSubagentThreadId,
  renderSubagentComposer,
  messagesTimelineProps,
  subagentThreads,
  threadTerminalRuntimeEnv,
  terminalFocusRequestId,
  activeForSideEffects,
  createNewPanelTerminal,
  newTerminalShortcutLabel,
  rightPanelTerminalShortcutLabel,
  activatePanelTerminal,
  movePanelTerminal,
  setPanelTerminalGroupSplitRatios,
  setTerminalAutoTitle,
  closeTerminal,
  toggleTerminalVisibility,
  onCloseRightSidePanelTerminal,
  setRightPanelTerminalHeight,
  addTerminalContextToDraft,
  activeRightPanelEditorTabId,
  rightPanelFallbackEditorStateInstanceId,
  availableEditors,
  activeThreadBranchName,
  activeServerConnectionUrl,
  keybindings,
  anyBrowserOpen,
  terminalState,
  onCloseRightSidePanelEditor,
  submitWorkspaceAgentNote,
  rightBrowserPanelInstanceIds,
  bottomBrowserInstanceId,
  bottomPanelBrowserOpen,
  bottomPanelMotionActive,
  browserBackShortcutLabel,
  browserDesignerAreaCommentShortcutLabel,
  browserDesignerElementCommentShortcutLabel,
  browserDevToolsShortcutLabel,
  browserForwardShortcutLabel,
  browserReloadShortcutLabel,
  browserViewMode,
  closeBrowser,
  detachBottomPanelBrowser,
  detachRightSidePanelBrowser,
  handleBrowserRuntimeStateChange,
  onBrowserSessionChange,
  onCloseBottomPanelBrowser,
  onToggleRightSidePanelFloatingChat,
  onToggleRightSidePanelFullscreen,
  queueBrowserDesignRequest,
  resolveBrowserThreadConnectionUrl,
  resizeBrowserViewportForBridge,
  isThreadHistoryLoading,
  rightBrowserInstanceId,
  rightBrowserOpen,
  rightSidePanelMotionActive,
  rightSidePanelInteractive,
  setBrowserController,
}: ChatViewRightSidePanelContentProps) {
  if (rightSidePanelBodyDeferred) {
    return <DeferredPanelBodyPlaceholder />;
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <AnimatePresence mode="wait" initial={false}>
        {activeRightSidePanelMode !== "browser" ? (
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
                  isGitRepo && setRightSidePanelMode ? () => setRightSidePanelMode("diff") : null
                }
                onRegenerateSummary={handleRegenerateSummary ?? null}
                onOpenBrowserUrl={isElectron ? openBrowserUrlInNewTab : null}
                onOpenFilePath={canOpenLocalMarkdownFiles ? openMarkdownFileInAppEditor : null}
                enableLocalFileLinks={canOpenLocalMarkdownFiles}
                workspaceDiffSummary={workspaceDiffSummary ?? null}
                workspaceRoot={activeProject?.cwd ?? undefined}
              />
            ) : activeRightSidePanelMode === "diff" ? (
              <LocalDiffPanel
                threadId={activeThread!.id}
                diffState={localDiffState}
                onAddReviewComment={addDiffReviewComment}
                onDiffStateChange={setLocalDiffState}
              />
            ) : activeRightSidePanelMode === "subagent" ? (
              <SubagentWorkspacePanel
                activeThreadId={visibleActiveSubagentThreadId}
                composer={renderSubagentComposer}
                timelineProps={messagesTimelineProps}
                threads={subagentThreads}
              />
            ) : activeRightSidePanelMode === "terminal" ? (
              <ConnectedThreadTerminalPanel
                placement="right"
                activeThreadId={activeThread!.id}
                activeProjectAvailable={activeProject !== undefined}
                cwd={gitCwd ?? activeProject?.cwd ?? null}
                runtimeEnv={threadTerminalRuntimeEnv}
                focusRequestId={terminalFocusRequestId}
                interactive={activeForSideEffects}
                onNewTerminal={createNewPanelTerminal}
                newShortcutLabel={newTerminalShortcutLabel ?? undefined}
                toggleShortcutLabel={rightPanelTerminalShortcutLabel ?? undefined}
                onActiveTerminalChange={activatePanelTerminal}
                onMoveTerminal={movePanelTerminal}
                onSplitRatiosChange={setPanelTerminalGroupSplitRatios}
                onAutoTerminalTitleChange={setTerminalAutoTitle}
                onCloseTerminal={closeTerminal}
                onToggleTerminal={toggleTerminalVisibility}
                onClosePanelTerminal={onCloseRightSidePanelTerminal}
                onHeightChange={setRightPanelTerminalHeight}
                onAddTerminalContext={addTerminalContextToDraft}
                onOpenBrowserUrl={isElectron ? openBrowserUrlInNewTab : null}
                onOpenFilePath={canOpenLocalMarkdownFiles ? openMarkdownFileInAppEditor : null}
              />
            ) : activeRightSidePanelMode === "editor" ? (
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
                  key={activeRightPanelEditorTabId ?? rightPanelFallbackEditorStateInstanceId}
                  availableEditors={availableEditors}
                  branch={activeThreadBranchName}
                  connectionUrl={activeServerConnectionUrl}
                  gitCwd={gitCwd}
                  lspCwd={activeProject?.cwd ?? null}
                  keybindings={keybindings}
                  browserOpen={anyBrowserOpen}
                  workspaceMode="split"
                  editorStateInstanceId={
                    activeRightPanelEditorTabId ?? rightPanelFallbackEditorStateInstanceId
                  }
                  terminalOpen={terminalState.terminalOpen}
                  threadId={activeThread!.id}
                  worktreePath={activeThread!.worktreePath ?? null}
                  detachedReturnPlacement="right"
                  onDetached={onCloseRightSidePanelEditor}
                  onSubmitAgentNote={submitWorkspaceAgentNote}
                />
              </Suspense>
            ) : null}
          </m.div>
        ) : null}
      </AnimatePresence>
      {rightBrowserPanelInstanceIds.length > 0 ? (
        <div
          className={cn(
            "absolute inset-0 min-h-0 min-w-0",
            activeRightSidePanelMode === "browser" ? "z-10" : "pointer-events-none invisible z-0",
          )}
        >
          <BrowserPanelInstanceList
            active={activeRightSidePanelMode === "browser"}
            bottomBrowserInstanceId={bottomBrowserInstanceId}
            bottomPanelBrowserOpen={bottomPanelBrowserOpen}
            bottomPanelMotionActive={bottomPanelMotionActive}
            browserBackShortcutLabel={browserBackShortcutLabel}
            browserDesignerAreaCommentShortcutLabel={browserDesignerAreaCommentShortcutLabel}
            browserDesignerElementCommentShortcutLabel={browserDesignerElementCommentShortcutLabel}
            browserDevToolsShortcutLabel={browserDevToolsShortcutLabel}
            browserForwardShortcutLabel={browserForwardShortcutLabel}
            browserInstanceIds={rightBrowserPanelInstanceIds}
            browserReloadShortcutLabel={browserReloadShortcutLabel}
            browserViewMode={browserViewMode}
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
            rightPanelMotionActive={rightSidePanelMotionActive}
            rightSidePanelInteractive={rightSidePanelInteractive}
            setBrowserController={setBrowserController}
          />
        </div>
      ) : null}
    </div>
  );
});
