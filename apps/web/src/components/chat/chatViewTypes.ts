import type { ApprovalRequestId, MessageId, ProviderKind, ThreadId, TurnId } from "@ace/contracts";
import type { ReactNode } from "react";
import type { PullRequestDialogState } from "~/lib/chat/chatView";
import type { PendingComposerComment } from "~/lib/chat/commentAccumulation";
import type { TimelineDisclosureExpansionState } from "~/lib/chat/timelineDisclosureState";
import type { RightSidePanelMode } from "~/lib/rightSidePanelState";
import { randomUUID } from "~/lib/utils";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import { DEFAULT_THREAD_TERMINAL_HEIGHT, type Thread } from "../../types";
import type { PanelTabOrderEntry } from "./ChatViewRightSidePanels";
export type { PanelTabOrderEntry } from "./ChatViewRightSidePanels";

export type DockPanelMode = RightSidePanelMode;

export function appendPanelTabOrder(
  current: ReadonlyArray<PanelTabOrderEntry>,
  entry: PanelTabOrderEntry,
): PanelTabOrderEntry[] {
  return current.includes(entry) ? [...current] : [...current, entry];
}

export function removePanelTabOrder(
  current: ReadonlyArray<PanelTabOrderEntry>,
  entry: PanelTabOrderEntry,
): PanelTabOrderEntry[] {
  return current.filter((currentEntry) => currentEntry !== entry);
}

export function removePanelTabOrderByMode(
  current: ReadonlyArray<PanelTabOrderEntry>,
  mode: RightSidePanelMode,
): PanelTabOrderEntry[] {
  const modePrefix = `${mode}:`;
  return current.filter((entry) => entry !== mode && !entry.startsWith(modePrefix));
}

export function mergeVisiblePanelTabOrder(
  current: ReadonlyArray<PanelTabOrderEntry>,
  nextVisibleOrder: ReadonlyArray<PanelTabOrderEntry>,
): PanelTabOrderEntry[] {
  const visibleEntries = new Set(nextVisibleOrder);
  return [...nextVisibleOrder, ...current.filter((entry) => !visibleEntries.has(entry))];
}

export interface PanelEditorTab {
  id: string;
  label: string;
}

export function createPanelEditorTab(id = `editor-${randomUUID()}`): PanelEditorTab {
  return {
    id,
    label: "Editor",
  };
}

const MIN_BOTTOM_PANEL_HEIGHT = 180;
const MAX_BOTTOM_PANEL_HEIGHT_RATIO = 0.75;

function maxBottomPanelHeight(): number {
  if (typeof window === "undefined") return DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.max(
    MIN_BOTTOM_PANEL_HEIGHT,
    Math.floor(window.innerHeight * MAX_BOTTOM_PANEL_HEIGHT_RATIO),
  );
}

export function clampBottomPanelHeight(height: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.min(
    Math.max(Math.round(safeHeight), MIN_BOTTOM_PANEL_HEIGHT),
    maxBottomPanelHeight(),
  );
}

export type QueuedComposerMessage = Thread["queuedComposerMessages"][number];

export interface QueuedComposerState {
  readonly threadId: ThreadId;
  readonly messages: readonly QueuedComposerMessage[];
  readonly steerRequest: Thread["queuedSteerRequest"];
}

export interface OptimisticInactiveTurnState {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly requestedAt: string;
}

export interface OptimisticQueuedDispatchState {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}

export interface ComposerDispatchFailureContext {
  provider: ProviderKind;
  model: string | null;
  visiblePromptLength: number;
  outgoingPromptLength: number;
  imageCount: number;
  imageBytes: number;
  terminalContextCount: number;
  terminalContextChars: number;
}

export interface ChatViewProps {
  activeInBoard?: boolean;
  connectionUrl?: string | null;
  paneControls?: ReactNode;
  shortcutsEnabled?: boolean;
  showSidebarTrigger?: boolean;
  splitPane?: boolean;
  threadId: ThreadId;
  visibleBoardThreadIds?: ReadonlyArray<ThreadId>;
}

export interface LocalDiffState {
  filePath: string | null;
  open: boolean;
  turnId: TurnId | null;
}

export interface PendingPullRequestSetupRequest {
  threadId: ThreadId;
  worktreePath: string;
  scriptId: string;
}

export type ChatViewDialogState = {
  gitHubIssueDialogOpen: boolean;
  gitHubIssueDialogInitialIssueNumber: number | null;
  gitHubIssueDialogInitialSelectedIssueNumbers: number[];
  issuePreviewNumber: number | null;
  pullRequestDialogState: PullRequestDialogState | null;
  pendingPullRequestSetupRequest: PendingPullRequestSetupRequest | null;
};

export type ChatViewDialogAction =
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

export type ChatViewTransientState = {
  localDiffStateByThreadId: Record<ThreadId, LocalDiffState>;
  localDraftErrorsByThreadId: Record<ThreadId, string | null>;
  respondingRequestIds: ApprovalRequestId[];
  respondingUserInputRequestIds: ApprovalRequestId[];
  pendingUserInputAnswersByRequestId: Record<string, Record<string, PendingUserInputDraftAnswer>>;
  pendingUserInputQuestionIndexByRequestId: Record<string, number>;
  expandedWorkGroupsByThreadId: Record<ThreadId, TimelineDisclosureExpansionState>;
  attachmentPreviewHandoffByMessageId: Record<string, string[]>;
  pendingComposerCommentsByThreadId: Record<ThreadId, PendingComposerComment[]>;
};

export type ChatViewTransientAction =
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
      type: "set-expanded-work-groups-by-thread-id";
      expandedWorkGroupsByThreadId:
        | Record<ThreadId, TimelineDisclosureExpansionState>
        | ((
            current: Record<ThreadId, TimelineDisclosureExpansionState>,
          ) => Record<ThreadId, TimelineDisclosureExpansionState>);
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

export function chatViewDialogStateReducer(
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
      if (
        !state.gitHubIssueDialogOpen &&
        state.gitHubIssueDialogInitialIssueNumber === null &&
        state.gitHubIssueDialogInitialSelectedIssueNumbers.length === 0
      ) {
        return state;
      }
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
      if (state.pullRequestDialogState === null) {
        return state;
      }
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

export function chatViewTransientStateReducer(
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
    case "set-expanded-work-groups-by-thread-id": {
      const expandedWorkGroupsByThreadId = resolveStateUpdate(
        state.expandedWorkGroupsByThreadId,
        action.expandedWorkGroupsByThreadId,
      );
      return state.expandedWorkGroupsByThreadId === expandedWorkGroupsByThreadId
        ? state
        : { ...state, expandedWorkGroupsByThreadId };
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
