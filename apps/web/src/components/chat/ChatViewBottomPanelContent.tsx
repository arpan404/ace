import type { ComponentProps, ReactNode, RefObject } from "react";
import React, { Suspense, lazy } from "react";
import type { EditorId, ResolvedKeybindingsConfig, ThreadId, TurnId } from "@ace/contracts";
import {
  type ActivePlanState,
  type LatestProposedPlanState,
  type GeneratedWorkspaceSummary,
} from "~/session-logic";
import { RESIZABLE_PANEL_HEIGHT_STYLE } from "./chatViewConstants";
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

function DeferredPanelTabStripPlaceholder() {
  return (
    <div aria-hidden="true" className="flex h-full min-w-0 flex-1 items-center gap-2 px-3">
      <div className="h-7 w-28 rounded-md bg-foreground/[0.055]" />
      <div className="h-7 w-20 rounded-md bg-foreground/[0.035]" />
    </div>
  );
}

export interface ChatViewBottomPanelContentProps {
  bottomPanelBodyDeferred: boolean;
  bottomPanelTabStripNode: ReactNode;
  bottomPanelContentElementRef: RefObject<HTMLDivElement | null>;
  bottomPanelResizing: boolean;
  bottomPanelContentHeightPx: string;
  activeBottomPanelMode: string | null;

  activePlan: ActivePlanState | null;
  sidebarProposedPlan: LatestProposedPlanState | null;
  activeGeneratedWorkspaceSummary: GeneratedWorkspaceSummary | null;
  workspaceDiffSummary?: { additions: number; deletions: number; fileCount: number } | null;
  activeThread: Thread | undefined;
  gitCwd: string | null | undefined;
  isGitRepo: boolean;
  canOpenLocalMarkdownFiles: boolean;
  isElectron?: boolean;
  openBrowserUrlInNewTab: (url: string) => void;
  openMarkdownFileInAppEditor: (path: string) => void | Promise<void>;
  handleRegenerateSummary: () => void;
  onOpenBottomPanelDiff: () => void;
  activeProject: { cwd: string } | undefined;

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
  createNewTerminal: () => void;
  newTerminalShortcutLabel: string | null | undefined;
  terminalToggleShortcutLabel: string | null | undefined;
  activateTerminal: (terminalId: string) => void;
  moveTerminal: (terminalId: string, targetGroupId: string, targetIndex: number) => void;
  setTerminalGroupSplitRatios: (groupId: string, ratios: number[]) => void;
  setTerminalAutoTitle: (terminalId: string, title: string | null) => void;
  closeTerminal: (terminalId: string) => void;
  toggleTerminalVisibility: () => void;
  onCloseBottomPanelTerminal: () => void;
  setTerminalHeight: (height: number) => void;
  addTerminalContextToDraft: (selection: TerminalContextSelection) => void;

  activeBottomPanelEditorTabId: string | null | undefined;
  bottomPanelFallbackEditorStateInstanceId: string | undefined;
  availableEditors: ReadonlyArray<EditorId>;
  activeThreadBranchName: string | null;
  activeServerConnectionUrl: string;
  keybindings: ResolvedKeybindingsConfig;
  anyBrowserOpen: boolean;
  terminalState: { terminalOpen: boolean };
  onCloseBottomPanelEditor: () => void;
  submitWorkspaceAgentNote: (input: {
    mode: "queue" | "send";
    prompt: string;
    threadId?: ThreadId;
  }) => boolean | Promise<boolean>;

  bottomBrowserInstanceId: string | null;
  bottomPanelBrowserOpen: boolean;
  bottomPanelMotionActive: boolean;
  browserBackShortcutLabel: string | null;
  browserDesignerAreaCommentShortcutLabel: string | null;
  browserDesignerElementCommentShortcutLabel: string | null;
  browserDevToolsShortcutLabel: string | null;
  browserForwardShortcutLabel: string | null;
  bottomBrowserPanelInstanceIds: readonly string[];
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

export const ChatViewBottomPanelContent = React.memo(function ChatViewBottomPanelContent({
  bottomPanelBodyDeferred,
  bottomPanelTabStripNode,
  bottomPanelContentElementRef,
  bottomPanelResizing,
  bottomPanelContentHeightPx,
  activeBottomPanelMode,
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
  onOpenBottomPanelDiff,
  activeProject,
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
  createNewTerminal,
  newTerminalShortcutLabel,
  terminalToggleShortcutLabel,
  activateTerminal,
  moveTerminal,
  setTerminalGroupSplitRatios,
  setTerminalAutoTitle,
  closeTerminal,
  toggleTerminalVisibility,
  onCloseBottomPanelTerminal,
  setTerminalHeight,
  addTerminalContextToDraft,
  activeBottomPanelEditorTabId,
  bottomPanelFallbackEditorStateInstanceId,
  availableEditors,
  activeThreadBranchName,
  activeServerConnectionUrl,
  keybindings,
  anyBrowserOpen,
  terminalState,
  onCloseBottomPanelEditor,
  submitWorkspaceAgentNote,
  bottomBrowserInstanceId,
  bottomPanelBrowserOpen,
  bottomPanelMotionActive,
  browserBackShortcutLabel,
  browserDesignerAreaCommentShortcutLabel,
  browserDesignerElementCommentShortcutLabel,
  browserDevToolsShortcutLabel,
  browserForwardShortcutLabel,
  bottomBrowserPanelInstanceIds,
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
}: ChatViewBottomPanelContentProps) {
  return (
    <>
      <div className="flex h-12 shrink-0 items-stretch bg-background shadow-[0_1px_0_color-mix(in_oklch,var(--border)_26%,transparent)]">
        {bottomPanelBodyDeferred ? <DeferredPanelTabStripPlaceholder /> : bottomPanelTabStripNode}
      </div>
      <div
        ref={bottomPanelContentElementRef}
        className="min-h-0 flex-1 overflow-hidden"
        style={
          bottomPanelResizing
            ? RESIZABLE_PANEL_HEIGHT_STYLE
            : { height: bottomPanelContentHeightPx }
        }
      >
        {bottomPanelBodyDeferred ? (
          <DeferredPanelBodyPlaceholder />
        ) : activeBottomPanelMode === "summary" ? (
          <PlanSummaryPanel
            activePlan={activePlan}
            activeProposedPlan={sidebarProposedPlan}
            generatedWorkspaceSummary={activeGeneratedWorkspaceSummary}
            activeProvider={activeThread?.session?.provider ?? null}
            markdownCwd={gitCwd ?? undefined}
            onOpenDiffPanel={isGitRepo ? onOpenBottomPanelDiff : null}
            onRegenerateSummary={handleRegenerateSummary}
            onOpenBrowserUrl={isElectron ? openBrowserUrlInNewTab : null}
            onOpenFilePath={canOpenLocalMarkdownFiles ? openMarkdownFileInAppEditor : null}
            enableLocalFileLinks={canOpenLocalMarkdownFiles}
            workspaceDiffSummary={workspaceDiffSummary ?? null}
            workspaceRoot={activeProject?.cwd ?? undefined}
          />
        ) : activeBottomPanelMode === "diff" ? (
          <LocalDiffPanel
            threadId={activeThread!.id}
            diffState={localDiffState}
            onAddReviewComment={addDiffReviewComment}
            onDiffStateChange={setLocalDiffState}
          />
        ) : activeBottomPanelMode === "subagent" ? (
          <SubagentWorkspacePanel
            activeThreadId={visibleActiveSubagentThreadId}
            composer={renderSubagentComposer}
            timelineProps={messagesTimelineProps}
            threads={subagentThreads}
          />
        ) : activeBottomPanelMode === "terminal" ? (
          <ConnectedThreadTerminalPanel
            placement="bottom"
            activeThreadId={activeThread!.id}
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
            onOpenBrowserUrl={isElectron ? openBrowserUrlInNewTab : null}
            onOpenFilePath={canOpenLocalMarkdownFiles ? openMarkdownFileInAppEditor : null}
          />
        ) : activeBottomPanelMode === "editor" ? (
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
              key={activeBottomPanelEditorTabId ?? bottomPanelFallbackEditorStateInstanceId}
              availableEditors={availableEditors}
              branch={activeThreadBranchName}
              connectionUrl={activeServerConnectionUrl}
              gitCwd={gitCwd ?? null}
              lspCwd={activeProject?.cwd ?? null}
              keybindings={keybindings}
              browserOpen={anyBrowserOpen}
              workspaceMode="split"
              editorStateInstanceId={
                activeBottomPanelEditorTabId ?? bottomPanelFallbackEditorStateInstanceId
              }
              terminalOpen={terminalState.terminalOpen}
              threadId={activeThread!.id}
              worktreePath={activeThread?.worktreePath ?? null}
              detachedReturnPlacement="bottom"
              onDetached={onCloseBottomPanelEditor}
              onSubmitAgentNote={submitWorkspaceAgentNote}
            />
          </Suspense>
        ) : activeBottomPanelMode === "browser" && bottomBrowserPanelInstanceIds.length > 0 ? (
          <BrowserPanelInstanceList
            active={activeBottomPanelMode === "browser"}
            bottomBrowserInstanceId={bottomBrowserInstanceId}
            bottomPanelBrowserOpen={bottomPanelBrowserOpen}
            bottomPanelMotionActive={bottomPanelMotionActive}
            browserBackShortcutLabel={browserBackShortcutLabel}
            browserDesignerAreaCommentShortcutLabel={browserDesignerAreaCommentShortcutLabel}
            browserDesignerElementCommentShortcutLabel={browserDesignerElementCommentShortcutLabel}
            browserDevToolsShortcutLabel={browserDevToolsShortcutLabel}
            browserForwardShortcutLabel={browserForwardShortcutLabel}
            browserInstanceIds={bottomBrowserPanelInstanceIds}
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
        ) : null}
      </div>
    </>
  );
});
