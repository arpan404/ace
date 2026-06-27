import { type ThreadId } from "@ace/contracts";
import { startTransition, useCallback, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  clampBottomPanelHeight,
  type DockPanelMode,
  type PanelTabOrderEntry,
} from "./chatViewTypes";
import { removePanelTabOrder } from "./chatViewTypes";
import { PANEL_CONTENT_MOUNT_DEFER_AFTER_MOTION_MS } from "./chatViewConstants";
import { type RightSidePanelMode } from "~/lib/rightSidePanelState";
import { type Thread } from "~/types";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { useStableCallback } from "~/hooks/useStableCallback";
import { beginLayoutResizeInteraction, endLayoutResizeInteraction } from "~/lib/desktopChrome";
import { applyResizablePanelHeight } from "./chatViewUtils";
import { randomUUID } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { reportBackgroundError } from "~/lib/async";
import {
  type TerminalContextSelection,
  insertInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
} from "~/lib/terminalContext";
import { collapseExpandedComposerCursor } from "../../composer-logic";
import type { ConnectedChatComposerPanelsHandle } from "./ConnectedChatComposerPanels";

export interface UseChatViewTerminalStateInput {
  threadId: ThreadId;
  activeThread: Thread | undefined;
  setBottomPanelMode: React.Dispatch<React.SetStateAction<DockPanelMode | null>>;
  rightSidePanelMode: RightSidePanelMode | null;
  setRightSidePanelMode: (
    mode: RightSidePanelMode | ((prev: RightSidePanelMode | null) => RightSidePanelMode | null),
  ) => void;
  setRightSidePanelTerminalOpen: (open: boolean) => void;
  composerPanelsRef: React.RefObject<ConnectedChatComposerPanelsHandle | null>;
  promptRef: React.MutableRefObject<string>;
  composerTerminalContextsRef: React.MutableRefObject<TerminalContextDraft[]>;
  insertComposerDraftTerminalContext: (
    threadId: ThreadId,
    prompt: string,
    context: TerminalContextDraft,
    contextIndex: number,
  ) => boolean;
  terminalFocusRequestId: number;
  setTerminalFocusRequestId: React.Dispatch<React.SetStateAction<number>>;
  appendRightPanelTabOrder: (entry: PanelTabOrderEntry) => void;
  removeRightPanelTabOrder: (mode: RightSidePanelMode) => void;
  appendBottomPanelTabOrder: (entry: PanelTabOrderEntry) => void;
  removeBottomPanelTabOrder: (mode: RightSidePanelMode) => void;
  setBottomPanelTabOrder: React.Dispatch<React.SetStateAction<PanelTabOrderEntry[]>>;
  setRightPanelTabOrder: React.Dispatch<React.SetStateAction<PanelTabOrderEntry[]>>;
  bottomPanelContentElementRef: React.RefObject<HTMLDivElement | null>;
  bottomPanelElementRef: React.RefObject<HTMLDivElement | null>;
  bottomPanelResizePointerIdRef: React.MutableRefObject<number | null>;
  bottomPanelResizeStateRef: React.MutableRefObject<{
    contentElement: HTMLElement | null;
    handleElement: HTMLElement | null;
    panelElement: HTMLElement | null;
    pendingHeight: number;
    rafId: number | null;
    startHeight: number;
    startY: number;
  } | null>;
  didResizeBottomPanelDuringDragRef: React.MutableRefObject<boolean>;
  setBottomPanelResizing: (resizing: boolean) => void;
  setBottomPanelContentDeferred: (deferred: boolean) => void;
  setBottomPanelMotionActive: (active: boolean) => void;
  bottomPanelMotionActiveRef: React.MutableRefObject<boolean>;
}

export interface UseChatViewTerminalStateOutput {
  terminalState: {
    terminalOpen: boolean;
    terminalHeight: number;
    activeTerminalId: string;
    terminalIds: string[];
    terminalGroups: ReadonlyArray<{ id: string; terminalIds: string[] }>;
    runningTerminalIds: string[];
    autoTerminalTitlesById: Record<string, string>;
  };
  rightTerminalPanelState: {
    terminalIds: string[];
    activeTerminalId: string;
    terminalGroups: ReadonlyArray<{ id: string; terminalIds: string[] }>;
  };

  createNewTerminal: () => void;
  createNewPanelTerminal: () => void;
  createSplitTerminal: () => void;
  activateTerminal: (terminalId: string) => void;
  activatePanelTerminal: (terminalId: string) => void;
  moveTerminal: (terminalId: string, targetGroupId: string, targetIndex: number) => void;
  movePanelTerminal: (terminalId: string, targetGroupId: string, targetIndex: number) => void;
  setTerminalGroupSplitRatios: (groupId: string, ratios: number[]) => void;
  setPanelTerminalGroupSplitRatios: (groupId: string, ratios: number[]) => void;
  closeTerminal: (terminalId: string) => void;
  setTerminalAutoTitle: (terminalId: string, title: string | null) => void;
  setTerminalHeight: (height: number) => void;
  setRightPanelTerminalHeight: (height: number) => void;
  toggleTerminalVisibility: () => void;
  setTerminalOpen: (open: boolean) => void;
  onCloseRightSidePanelTerminal: () => void;
  onCloseBottomPanelTerminal: () => void;
  onReorderRightSidePanelTerminalTab: (draggedTerminalId: string, targetTerminalId: string) => void;
  onReorderBottomPanelTerminalTab: (draggedTerminalId: string, targetTerminalId: string) => void;
  addTerminalContextToDraft: (selection: TerminalContextSelection) => void;

  beginBottomPanelMotion: () => void;
  endBottomPanelMotion: () => void;

  handleBottomPanelResizePointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  clearPendingBottomPanelTerminalOpenTimer: () => void;
}

export function useChatViewTerminalState(
  input: UseChatViewTerminalStateInput,
): UseChatViewTerminalStateOutput {
  const {
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
  } = input;

  const activeThreadId = activeThread?.id ?? null;

  const terminalState = useTerminalStateStore(
    useShallow((state) => {
      const selectedState = selectThreadTerminalState(state.terminalStateByThreadId, threadId);
      return {
        terminalOpen: selectedState.terminalOpen,
        terminalHeight: selectedState.terminalHeight,
        activeTerminalId: selectedState.activeTerminalId,
        terminalIds: selectedState.terminalIds,
        terminalGroups: selectedState.terminalGroups,
        runningTerminalIds: selectedState.runningTerminalIds,
        autoTerminalTitlesById: selectedState.autoTerminalTitlesById,
      };
    }),
  );
  const rightTerminalPanelState = useTerminalStateStore(
    useShallow((state) => {
      const selectedThreadState = selectThreadTerminalState(
        state.terminalStateByThreadId,
        threadId,
      );
      const selectedState = selectedThreadState.terminalPanelStateByPlacement.right;
      return {
        terminalIds: selectedState.terminalIds,
        activeTerminalId: selectedState.activeTerminalId,
        terminalGroups: selectedState.terminalGroups,
      };
    }),
  );

  const storeSetTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const storeSetTerminalHeight = useTerminalStateStore((s) => s.setTerminalHeight);
  const storeSetTerminalHeightForPanel = useTerminalStateStore((s) => s.setTerminalHeightForPanel);
  const storeSplitTerminal = useTerminalStateStore((s) => s.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((s) => s.newTerminal);
  const storeNewTerminalForPanel = useTerminalStateStore((s) => s.newTerminalForPanel);
  const storeSetActiveTerminal = useTerminalStateStore((s) => s.setActiveTerminal);
  const storeSetActiveTerminalForPanel = useTerminalStateStore((s) => s.setActiveTerminalForPanel);
  const storeMoveTerminal = useTerminalStateStore((s) => s.moveTerminal);
  const storeMoveTerminalForPanel = useTerminalStateStore((s) => s.moveTerminalForPanel);
  const storeSetTerminalGroupSplitRatios = useTerminalStateStore(
    (s) => s.setTerminalGroupSplitRatios,
  );
  const storeSetTerminalGroupSplitRatiosForPanel = useTerminalStateStore(
    (s) => s.setTerminalGroupSplitRatiosForPanel,
  );
  const storeSetTerminalAutoTitle = useTerminalStateStore((s) => s.setTerminalAutoTitle);
  const storeCloseTerminal = useTerminalStateStore((s) => s.closeTerminal);

  const pendingBottomPanelTerminalOpenRef = useRef(false);
  const pendingBottomPanelTerminalOpenTimerRef = useRef<number | null>(null);

  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadId) return;
      storeSetTerminalOpen(activeThreadId, open);
    },
    [activeThreadId, storeSetTerminalOpen],
  );

  const clearPendingBottomPanelTerminalOpenTimer = useStableCallback(() => {
    if (pendingBottomPanelTerminalOpenTimerRef.current === null) {
      return;
    }
    window.clearTimeout(pendingBottomPanelTerminalOpenTimerRef.current);
    pendingBottomPanelTerminalOpenTimerRef.current = null;
  });

  const flushPendingBottomPanelTerminalOpen = useStableCallback(() => {
    clearPendingBottomPanelTerminalOpenTimer();
    if (!pendingBottomPanelTerminalOpenRef.current) {
      return;
    }
    pendingBottomPanelTerminalOpenRef.current = false;
    startTransition(() => {
      setTerminalOpen(true);
    });
  });

  const schedulePendingBottomPanelTerminalOpen = useStableCallback(() => {
    if (
      !pendingBottomPanelTerminalOpenRef.current ||
      pendingBottomPanelTerminalOpenTimerRef.current !== null
    ) {
      return;
    }
    pendingBottomPanelTerminalOpenTimerRef.current = window.setTimeout(() => {
      pendingBottomPanelTerminalOpenTimerRef.current = null;
      flushPendingBottomPanelTerminalOpen();
    }, PANEL_CONTENT_MOUNT_DEFER_AFTER_MOTION_MS);
  });

  const beginBottomPanelMotion = useStableCallback(() => {
    if (bottomPanelMotionActiveRef.current) {
      return;
    }
    bottomPanelMotionActiveRef.current = true;
    setBottomPanelMotionActive(true);
    beginLayoutResizeInteraction();
  });

  const endBottomPanelMotion = useStableCallback(() => {
    if (!bottomPanelMotionActiveRef.current) {
      return;
    }
    bottomPanelMotionActiveRef.current = false;
    if (pendingBottomPanelTerminalOpenRef.current) {
      schedulePendingBottomPanelTerminalOpen();
    }
    setBottomPanelMotionActive(false);
    setBottomPanelContentDeferred(false);
    endLayoutResizeInteraction();
  });

  useEffect(
    () => () => {
      clearPendingBottomPanelTerminalOpenTimer();
    },
    [clearPendingBottomPanelTerminalOpenTimer],
  );

  const setTerminalHeight = (height: number) => {
    if (!activeThreadId) return;
    storeSetTerminalHeight(activeThreadId, clampBottomPanelHeight(height));
  };

  const setRightPanelTerminalHeight = (height: number) => {
    if (!activeThreadId) return;
    storeSetTerminalHeightForPanel(activeThreadId, "right", height);
  };

  const handleBottomPanelResizePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (!activeThreadId) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    beginLayoutResizeInteraction();
    setBottomPanelResizing(true);
    bottomPanelResizePointerIdRef.current = event.pointerId;
    bottomPanelResizeStateRef.current = {
      contentElement: bottomPanelContentElementRef.current,
      handleElement: event.currentTarget,
      panelElement: bottomPanelElementRef.current,
      pendingHeight: terminalState.terminalHeight,
      rafId: null,
      startHeight: terminalState.terminalHeight,
      startY: event.clientY,
    };
    applyResizablePanelHeight(bottomPanelElementRef.current, terminalState.terminalHeight + 48);
    applyResizablePanelHeight(bottomPanelContentElementRef.current, terminalState.terminalHeight);
    didResizeBottomPanelDuringDragRef.current = false;
  };

  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadId) return;
    const nextOpen = !terminalState.terminalOpen;
    beginBottomPanelMotion();
    pendingBottomPanelTerminalOpenRef.current = nextOpen;
    setBottomPanelContentDeferred(false);
    if (!nextOpen) {
      clearPendingBottomPanelTerminalOpenTimer();
      setTerminalOpen(false);
    }
    setBottomPanelMode((current) =>
      nextOpen ? "terminal" : current === "terminal" ? null : current,
    );
  }, [
    activeThreadId,
    beginBottomPanelMotion,
    clearPendingBottomPanelTerminalOpenTimer,
    setBottomPanelContentDeferred,
    setBottomPanelMode,
    setTerminalOpen,
    terminalState.terminalOpen,
  ]);

  const onCloseRightSidePanelTerminal = useCallback(() => {
    setRightSidePanelTerminalOpen(false);
    removeRightPanelTabOrder("terminal");
    if (rightSidePanelMode === "terminal") {
      setRightSidePanelMode("summary");
    }
  }, [
    removeRightPanelTabOrder,
    rightSidePanelMode,
    setRightSidePanelMode,
    setRightSidePanelTerminalOpen,
  ]);

  const onReorderRightSidePanelTerminalTab = (
    draggedTerminalId: string,
    targetTerminalId: string,
  ) => {
    if (!activeThreadId || draggedTerminalId === targetTerminalId) {
      return;
    }
    const targetGroup = rightTerminalPanelState.terminalGroups.find((group) =>
      group.terminalIds.includes(targetTerminalId),
    );
    if (!targetGroup) {
      return;
    }
    const targetIndex = targetGroup.terminalIds.indexOf(targetTerminalId);
    storeMoveTerminalForPanel(
      activeThreadId,
      "right",
      draggedTerminalId,
      targetGroup.id,
      targetIndex,
    );
  };

  const onReorderBottomPanelTerminalTab = (draggedTerminalId: string, targetTerminalId: string) => {
    if (!activeThreadId || draggedTerminalId === targetTerminalId) {
      return;
    }
    const targetGroup = terminalState.terminalGroups.find((group) =>
      group.terminalIds.includes(targetTerminalId),
    );
    if (!targetGroup) {
      return;
    }
    const targetIndex = targetGroup.terminalIds.indexOf(targetTerminalId);
    storeMoveTerminal(activeThreadId, draggedTerminalId, targetGroup.id, targetIndex);
  };

  const onCloseBottomPanelTerminal = () => {
    setTerminalOpen(false);
    removeBottomPanelTabOrder("terminal");
    setBottomPanelMode((current) => (current === "terminal" ? null : current));
  };

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

  const createNewTerminal = useCallback(() => {
    if (!activeThreadId) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeNewTerminal(activeThreadId, terminalId);
    appendBottomPanelTabOrder(`terminal:${terminalId}`);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, appendBottomPanelTabOrder, setTerminalFocusRequestId, storeNewTerminal]);

  const createNewPanelTerminal = useCallback(() => {
    if (!activeThreadId) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeNewTerminalForPanel(activeThreadId, "right", terminalId);
    appendRightPanelTabOrder(`terminal:${terminalId}`);
    setTerminalFocusRequestId((value) => value + 1);
  }, [
    activeThreadId,
    appendRightPanelTabOrder,
    setTerminalFocusRequestId,
    storeNewTerminalForPanel,
  ]);

  const createSplitTerminal = useCallback(() => {
    if (!activeThreadId) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeSplitTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, setTerminalFocusRequestId, storeSplitTerminal]);

  const activateTerminal = (terminalId: string) => {
    if (!activeThreadId) return;
    storeSetActiveTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  };

  const activatePanelTerminal = (terminalId: string) => {
    if (!activeThreadId) return;
    storeSetActiveTerminalForPanel(activeThreadId, "right", terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  };

  const moveTerminal = (terminalId: string, targetGroupId: string, targetIndex: number) => {
    if (!activeThreadId) return;
    storeMoveTerminal(activeThreadId, terminalId, targetGroupId, targetIndex);
  };

  const movePanelTerminal = (terminalId: string, targetGroupId: string, targetIndex: number) => {
    if (!activeThreadId) return;
    storeMoveTerminalForPanel(activeThreadId, "right", terminalId, targetGroupId, targetIndex);
  };

  const setTerminalGroupSplitRatios = (groupId: string, ratios: number[]) => {
    if (!activeThreadId) return;
    storeSetTerminalGroupSplitRatios(activeThreadId, groupId, ratios);
  };

  const setPanelTerminalGroupSplitRatios = (groupId: string, ratios: number[]) => {
    if (!activeThreadId) return;
    storeSetTerminalGroupSplitRatiosForPanel(activeThreadId, "right", groupId, ratios);
  };

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
      setBottomPanelTabOrder((current) =>
        removePanelTabOrder(current, `terminal:${targetTerminalId}`),
      );
      setRightPanelTabOrder((current) =>
        removePanelTabOrder(current, `terminal:${targetTerminalId}`),
      );
      setTerminalFocusRequestId((value) => value + 1);
    },
    [
      activeThreadId,
      readActiveTerminalState,
      setBottomPanelTabOrder,
      setRightPanelTabOrder,
      setTerminalFocusRequestId,
      storeCloseTerminal,
    ],
  );

  const setTerminalAutoTitle = (terminalId: string, title: string | null) => {
    if (!activeThreadId) return;
    storeSetTerminalAutoTitle(activeThreadId, terminalId, title);
  };

  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId) return;
      closeTerminalTarget(terminalId);
    },
    [activeThreadId, closeTerminalTarget],
  );

  return {
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
    addTerminalContextToDraft,
    beginBottomPanelMotion,
    endBottomPanelMotion,
    handleBottomPanelResizePointerDown,
    clearPendingBottomPanelTerminalOpenTimer,
  };
}
