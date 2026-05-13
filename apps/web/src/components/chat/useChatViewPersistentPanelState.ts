import { type ThreadId } from "@ace/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useMemo, useReducer } from "react";
import {
  THREAD_WORKSPACE_LAYOUT_BY_THREAD_ID_STORAGE_KEY,
  THREAD_WORKSPACE_MODE_BY_THREAD_ID_STORAGE_KEY,
  ThreadWorkspaceLayoutByThreadIdSchema,
  ThreadWorkspaceModeByThreadIdSchema,
} from "~/threadWorkspaceMode";
import {
  BROWSER_SPLIT_WIDTH_STORAGE_KEY,
  DEFAULT_BROWSER_SPLIT_WIDTH,
  clampBrowserSplitWidth,
} from "~/lib/chat/browserSplit";
import {
  DEFAULT_RIGHT_SIDE_PANEL_WIDTH,
  clampRightSidePanelWidth,
} from "~/lib/chat/rightSidePanelWidth";
import {
  DEFAULT_WORKSPACE_EDITOR_SPLIT_WIDTH,
  WORKSPACE_EDITOR_SPLIT_WIDTH_STORAGE_KEY,
  clampWorkspaceEditorSplitWidth,
} from "~/lib/chat/workspaceSplit";
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
  type RightSidePanelMode,
} from "~/lib/rightSidePanelState";
import { useLocalStorage } from "~/hooks/useLocalStorage";

const RIGHT_SIDE_PANEL_FLOATING_CHAT_OPEN_STORAGE_KEY =
  "ace:chat:right-side-panel-floating-chat:v1";
const BrowserPanelModeSchema = Schema.Literals(["closed", "full", "split"]);

type ChatViewPanelState = {
  showScrollToBottom: boolean;
  revertingCheckpointThreadId: ThreadId | null;
  isHeaderHidden: boolean;
  terminalFocusRequestId: number;
  handoffInFlight: boolean;
  browserDevToolsOpen: boolean;
  browserSplitWidth: number;
  workspaceEditorSplitWidth: number;
  rightSidePanelWidth: number;
};

type ChatViewPanelAction =
  | { type: "set-show-scroll-to-bottom"; showScrollToBottom: boolean }
  | { type: "set-reverting-checkpoint-thread-id"; revertingCheckpointThreadId: ThreadId | null }
  | { type: "toggle-header-hidden" }
  | { type: "set-header-hidden"; isHeaderHidden: boolean }
  | { type: "bump-terminal-focus-request-id" }
  | { type: "set-handoff-in-flight"; handoffInFlight: boolean }
  | { type: "set-browser-devtools-open"; browserDevToolsOpen: boolean }
  | { type: "set-browser-split-width"; browserSplitWidth: number | ((current: number) => number) }
  | {
      type: "set-workspace-editor-split-width";
      workspaceEditorSplitWidth: number | ((current: number) => number);
    }
  | {
      type: "set-right-side-panel-width";
      rightSidePanelWidth: number | ((current: number) => number);
    };

function createInitialChatViewPanelState(input: {
  storedBrowserSplitWidth: number;
  storedRightSidePanelWidth: number;
  storedWorkspaceEditorSplitWidth: number;
}): ChatViewPanelState {
  return {
    showScrollToBottom: false,
    revertingCheckpointThreadId: null,
    isHeaderHidden: false,
    terminalFocusRequestId: 0,
    handoffInFlight: false,
    browserDevToolsOpen: false,
    browserSplitWidth: clampBrowserSplitWidth(input.storedBrowserSplitWidth, 0),
    workspaceEditorSplitWidth: clampWorkspaceEditorSplitWidth(
      input.storedWorkspaceEditorSplitWidth,
      0,
    ),
    rightSidePanelWidth: clampRightSidePanelWidth(input.storedRightSidePanelWidth, 0),
  };
}

function chatViewPanelStateReducer(
  state: ChatViewPanelState,
  action: ChatViewPanelAction,
): ChatViewPanelState {
  switch (action.type) {
    case "set-show-scroll-to-bottom":
      return state.showScrollToBottom === action.showScrollToBottom
        ? state
        : { ...state, showScrollToBottom: action.showScrollToBottom };
    case "set-reverting-checkpoint-thread-id":
      return state.revertingCheckpointThreadId === action.revertingCheckpointThreadId
        ? state
        : { ...state, revertingCheckpointThreadId: action.revertingCheckpointThreadId };
    case "toggle-header-hidden":
      return { ...state, isHeaderHidden: !state.isHeaderHidden };
    case "set-header-hidden":
      return state.isHeaderHidden === action.isHeaderHidden
        ? state
        : { ...state, isHeaderHidden: action.isHeaderHidden };
    case "bump-terminal-focus-request-id":
      return { ...state, terminalFocusRequestId: state.terminalFocusRequestId + 1 };
    case "set-handoff-in-flight":
      return state.handoffInFlight === action.handoffInFlight
        ? state
        : { ...state, handoffInFlight: action.handoffInFlight };
    case "set-browser-devtools-open":
      return state.browserDevToolsOpen === action.browserDevToolsOpen
        ? state
        : { ...state, browserDevToolsOpen: action.browserDevToolsOpen };
    case "set-browser-split-width": {
      const browserSplitWidth =
        typeof action.browserSplitWidth === "function"
          ? action.browserSplitWidth(state.browserSplitWidth)
          : action.browserSplitWidth;
      return browserSplitWidth === state.browserSplitWidth
        ? state
        : { ...state, browserSplitWidth };
    }
    case "set-workspace-editor-split-width": {
      const workspaceEditorSplitWidth =
        typeof action.workspaceEditorSplitWidth === "function"
          ? action.workspaceEditorSplitWidth(state.workspaceEditorSplitWidth)
          : action.workspaceEditorSplitWidth;
      return workspaceEditorSplitWidth === state.workspaceEditorSplitWidth
        ? state
        : { ...state, workspaceEditorSplitWidth };
    }
    case "set-right-side-panel-width": {
      const rightSidePanelWidth =
        typeof action.rightSidePanelWidth === "function"
          ? action.rightSidePanelWidth(state.rightSidePanelWidth)
          : action.rightSidePanelWidth;
      return rightSidePanelWidth === state.rightSidePanelWidth
        ? state
        : { ...state, rightSidePanelWidth };
    }
    default:
      return state;
  }
}

export function useChatViewPersistentPanelState(threadId: ThreadId) {
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
  const rightSidePanelFloatingChatOpenStorageKey = useMemo(
    () => resolveScopedBrowserStorageKey(RIGHT_SIDE_PANEL_FLOATING_CHAT_OPEN_STORAGE_KEY, threadId),
    [threadId],
  );
  const [rightSidePanelFloatingChatOpen, setRightSidePanelFloatingChatOpen] = useLocalStorage(
    rightSidePanelFloatingChatOpenStorageKey,
    false,
    Schema.Boolean,
  );
  const [browserMode, setBrowserMode] = useLocalStorage(
    browserPanelModeStorageKey,
    "closed" as const,
    BrowserPanelModeSchema,
  );
  const [storedBrowserSplitWidth, setStoredBrowserSplitWidth] = useLocalStorage(
    BROWSER_SPLIT_WIDTH_STORAGE_KEY,
    DEFAULT_BROWSER_SPLIT_WIDTH,
    Schema.Number,
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
  const [chatViewPanelState, dispatchChatViewPanelState] = useReducer(
    chatViewPanelStateReducer,
    {
      storedBrowserSplitWidth,
      storedWorkspaceEditorSplitWidth,
      storedRightSidePanelWidth,
    },
    createInitialChatViewPanelState,
  );
  const {
    showScrollToBottom,
    revertingCheckpointThreadId,
    isHeaderHidden,
    terminalFocusRequestId,
    handoffInFlight,
    browserSplitWidth,
    workspaceEditorSplitWidth,
    rightSidePanelWidth,
  } = chatViewPanelState;
  const setShowScrollToBottom = useCallback((showScrollToBottom: boolean) => {
    dispatchChatViewPanelState({ type: "set-show-scroll-to-bottom", showScrollToBottom });
  }, []);
  const setIsRevertingCheckpoint = useCallback(
    (isRevertingCheckpoint: boolean) => {
      dispatchChatViewPanelState({
        type: "set-reverting-checkpoint-thread-id",
        revertingCheckpointThreadId: isRevertingCheckpoint ? threadId : null,
      });
    },
    [threadId],
  );
  const setIsHeaderHidden = useCallback((next: boolean | ((previous: boolean) => boolean)) => {
    if (typeof next === "function") {
      dispatchChatViewPanelState({ type: "toggle-header-hidden" });
      return;
    }
    dispatchChatViewPanelState({ type: "set-header-hidden", isHeaderHidden: next });
  }, []);
  const setTerminalFocusRequestId = useCallback((_next: number | ((value: number) => number)) => {
    dispatchChatViewPanelState({ type: "bump-terminal-focus-request-id" });
  }, []);
  const setHandoffInFlight = useCallback((handoffInFlight: boolean) => {
    dispatchChatViewPanelState({ type: "set-handoff-in-flight", handoffInFlight });
  }, []);
  const setBrowserDevToolsOpen = useCallback((browserDevToolsOpen: boolean) => {
    dispatchChatViewPanelState({ type: "set-browser-devtools-open", browserDevToolsOpen });
  }, []);
  const setBrowserSplitWidth = useCallback(
    (browserSplitWidth: number | ((current: number) => number)) => {
      dispatchChatViewPanelState({ type: "set-browser-split-width", browserSplitWidth });
    },
    [],
  );
  const setWorkspaceEditorSplitWidth = useCallback(
    (workspaceEditorSplitWidth: number | ((current: number) => number)) => {
      dispatchChatViewPanelState({
        type: "set-workspace-editor-split-width",
        workspaceEditorSplitWidth,
      });
    },
    [],
  );
  const setRightSidePanelWidth = useCallback(
    (rightSidePanelWidth: number | ((current: number) => number)) => {
      dispatchChatViewPanelState({ type: "set-right-side-panel-width", rightSidePanelWidth });
    },
    [],
  );

  return {
    browserSplitWidth,
    browserMode,
    handoffInFlight,
    isHeaderHidden,
    isRevertingCheckpoint: revertingCheckpointThreadId === threadId,
    rightSidePanelDiffOpen,
    rightSidePanelEditorOpen,
    rightSidePanelFloatingChatOpen,
    rightSidePanelFullscreen,
    rightSidePanelLastNonDiffMode,
    rightSidePanelMode,
    rightSidePanelReviewOpen,
    rightSidePanelVisible,
    rightSidePanelWidth,
    setBrowserDevToolsOpen,
    setBrowserMode,
    setBrowserSplitWidth,
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
  };
}
