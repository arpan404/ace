import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@ace/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useEffectEvent } from "~/hooks/useEffectEvent";
import { useStableCallback } from "~/hooks/useStableCallback";
import { reportBackgroundError } from "~/lib/async";
import {
  subscribeToBrowserLaunchRequests,
  takePendingBrowserLaunchRequest,
} from "~/lib/browser/launcher";
import {
  evictExpiredRecentBrowserInstances,
  resolveNextRecentBrowserInstanceExpiry,
  type RecentBrowserInstanceEntry,
} from "~/lib/browser/liveInstanceCache";
import {
  clearBrowserSessionStorage,
  setActiveBrowserTab,
  type BrowserSessionStorage,
} from "~/lib/browser/session";
import {
  clearBrowserSessions,
  deleteBrowserSession,
  getBrowserSession,
  setBrowserSession,
  useBrowserSession,
} from "~/lib/browser/sessionStore";
import { type BrowserDesignRequestSubmission } from "~/lib/browser/types";
import { clampBrowserSplitWidth } from "~/lib/chat/browserSplit";
import { type PendingComposerComment } from "~/lib/chat/commentAccumulation";
import { resolveBrowserOpenRightSidePanelWidth } from "~/lib/chat/rightSidePanelWidth";
import { isLayoutResizeInProgress, SIDEBAR_RESIZE_END_EVENT } from "~/lib/desktopChrome";
import { isMemoryPressureAtLeast, subscribeToMemoryPressure } from "~/lib/memoryPressure";
import { type RightSidePanelMode } from "~/lib/rightSidePanelState";
import {
  appendBrowserDesignContextToPrompt,
  buildBrowserDesignContextBlock,
} from "~/lib/terminalContext";
import { newMessageId, randomUUID } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { type Thread } from "~/types";
import { type ActiveBrowserRuntimeState, type InAppBrowserController } from "../InAppBrowser";
import {
  BROWSER_BRIDGE_CONTROLLER_POLL_MS,
  BROWSER_BRIDGE_CONTROLLER_WAIT_MS,
  CACHED_BROWSER_INSTANCE_TTL_MS,
} from "./chatViewConstants";
import {
  type DockPanelMode,
  type PanelTabOrderEntry,
  type QueuedComposerMessage,
} from "./chatViewTypes";
import {
  applyResizablePanelWidth,
  clearResizablePanelWidth,
  describeBrowserDesignCommentTarget,
  onBrowserSessionChange,
  resolveBrowserInstanceId,
  waitForBrowserBridgeController,
} from "./chatViewUtils";

export interface UseChatViewBrowserStateInput {
  threadId: ThreadId;
  activeThread: Thread | undefined;
  activeForSideEffects: boolean;
  ownsGlobalSideEffects: boolean;
  isElectron: boolean;
  windowStateInstanceId: string;
  splitPane: boolean;
  routeWorkspaceMode: string;

  browserMode: string;
  setBrowserMode: (mode: string) => void;
  setBrowserDevToolsOpen: (open: boolean) => void;

  rightSidePanelEnabled: boolean;
  rightSidePanelInteractive: boolean;
  rightSidePanelVisible: boolean;
  setRightSidePanelVisible: (visible: boolean) => void;
  rightSidePanelMode: RightSidePanelMode;
  setRightSidePanelMode: (
    mode: RightSidePanelMode | ((prev: RightSidePanelMode | null) => RightSidePanelMode | null),
  ) => void;
  rightSidePanelWidth: number;
  rightSidePanelFullscreen: boolean;
  rightSidePanelDiffOpen: boolean;
  rightSidePanelOpen: boolean;
  setRightSidePanelDiffOpenState: (open: boolean) => void;
  setRightSidePanelReviewOpen: (open: boolean) => void;
  setRightSidePanelEditorOpen: (open: boolean) => void;

  browserSplitWidth: number;
  setBrowserSplitWidth: (width: number | ((current: number) => number)) => void;
  storedBrowserSplitWidth: number;
  setStoredBrowserSplitWidth: (width: number) => void;

  appendRightPanelTabOrder: (entry: PanelTabOrderEntry) => void;
  removeRightPanelTabOrder: (mode: RightSidePanelMode) => void;
  appendBottomPanelTabOrder: (entry: PanelTabOrderEntry) => void;
  removeBottomPanelTabOrder: (mode: RightSidePanelMode) => void;
  setTerminalOpen: (open: boolean) => void;

  bottomPanelMode: DockPanelMode | null;
  setBottomPanelMode: (
    mode: DockPanelMode | null | ((prev: DockPanelMode | null) => DockPanelMode | null),
  ) => void;
  bottomPanelBrowserOpen: boolean;
  setBottomPanelBrowserOpen: (open: boolean) => void;
  bottomPanelOpen: boolean;

  commentSubmissionMode: string;
  selectedModelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  ensureQueuedComposerThread: (options: {
    titleSeed: string;
    modelSelection: ModelSelection;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }) => Promise<ThreadId | null>;
  appendQueuedComposerMessage: (
    targetThreadId: ThreadId,
    message: QueuedComposerMessage,
  ) => Promise<boolean>;
  pendingComposerCommentsByThreadId: Record<ThreadId, PendingComposerComment[]>;
  setPendingComposerCommentsByThreadId: (
    value:
      | Record<ThreadId, PendingComposerComment[]>
      | ((
          current: Record<ThreadId, PendingComposerComment[]>,
        ) => Record<ThreadId, PendingComposerComment[]>),
  ) => void;

  syncRightSidePanelWidth: (width: number) => void;

  chatViewportRef: React.RefObject<HTMLDivElement | null>;
}

export interface UseChatViewBrowserStateOutput {
  browserControllerRef: React.MutableRefObject<InAppBrowserController | null>;
  browserControllerByThread: Map<string, InAppBrowserController>;
  browserRuntimeStateByThread: Map<string, ActiveBrowserRuntimeState>;
  mountedBrowserInstances: readonly RecentBrowserInstanceEntry<string>[];

  browserOpen: boolean;
  rightBrowserInstanceId: string | null;
  bottomBrowserInstanceId: string | null;
  rightBrowserOpen: boolean;
  anyBrowserOpen: boolean;
  activeBrowserInstanceIds: string[];
  primaryBrowserInstanceId: string | null;
  browserViewMode: "full" | "split";
  browserPanelAvailable: boolean;

  closeBrowser: () => void;
  openBrowser: () => void;
  openBrowserUrl: (url: string, options?: { newTab?: boolean }) => void;
  openBrowserUrlInNewTab: (url: string) => void;
  detachBottomPanelBrowser: () => void;
  detachRightSidePanelBrowser: () => void;
  setBrowserController: (
    browserInstanceId: string,
    controller: InAppBrowserController | null,
  ) => void;
  handleBrowserRuntimeStateChange: (
    browserInstanceId: string,
    state: ActiveBrowserRuntimeState,
  ) => void;
  onBrowserSessionChange: (browserInstanceId: string, session: BrowserSessionStorage) => void;
  queueBrowserDesignRequest: (
    browserThreadId: ThreadId,
    submission: BrowserDesignRequestSubmission,
  ) => Promise<void>;
  handleBrowserLaunchRequest: () => void;

  onOpenRightSidePanelBrowserTab: () => void;
  onOpenBottomPanelBrowser: () => void;
  onOpenBottomPanelBrowserTab: () => void;
  onSelectRightSidePanelBrowserTab: (tabId: string) => void;
  onSelectBottomPanelBrowserTab: (tabId: string) => void;
  onCloseRightSidePanelBrowserTab: (tabId: string) => void;
  onReorderRightSidePanelBrowserTab: (draggedTabId: string, targetTabId: string) => void;
  onCloseBottomPanelBrowser: () => void;
  onCloseBottomPanelBrowserTab: (tabId: string) => void;
  onReorderBottomPanelBrowserTab: (draggedTabId: string, targetTabId: string) => void;

  browserSplitWidthRef: React.MutableRefObject<number>;
  orderedBrowserInstanceIds: string[];
  activeRightPanelBrowserSession: BrowserSessionStorage | null;
  activeBottomPanelBrowserSession: BrowserSessionStorage | null;
  activeRightPanelBrowserTabId: string | null;
  activeBottomPanelBrowserTabId: string | null;
  rightBrowserPanelInstanceIds: string[];
  bottomBrowserPanelInstanceIds: string[];
}

export function useChatViewBrowserState(
  input: UseChatViewBrowserStateInput,
): UseChatViewBrowserStateOutput {
  const {
    threadId,
    activeThread,
    ownsGlobalSideEffects,
    isElectron,
    windowStateInstanceId,
    browserMode,
    setBrowserMode,
    setBrowserDevToolsOpen,
    rightSidePanelEnabled,
    rightSidePanelInteractive,
    setRightSidePanelVisible,
    rightSidePanelMode,
    setRightSidePanelMode,
    rightSidePanelWidth,
    rightSidePanelDiffOpen,
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
    commentSubmissionMode,
    selectedModelSelection,
    runtimeMode,
    interactionMode,
    ensureQueuedComposerThread,
    appendQueuedComposerMessage,
    pendingComposerCommentsByThreadId,
    setPendingComposerCommentsByThreadId,
    syncRightSidePanelWidth,
    chatViewportRef,
  } = input;

  const activeThreadId = activeThread?.id ?? null;
  const diffOpen = rightSidePanelEnabled ? rightSidePanelDiffOpen : false;
  const readChatViewportWidth = useCallback(
    () => chatViewportRef.current?.clientWidth ?? window.innerWidth,
    [chatViewportRef],
  );

  const browserControllerRef = useRef<InAppBrowserController | null>(null);
  const [browserControllerByThread] = useState(() => new Map<string, InAppBrowserController>());
  const browserControllerByThreadRef = useRef(browserControllerByThread);
  const [browserRuntimeStateByThread] = useState(
    () => new Map<string, ActiveBrowserRuntimeState>(),
  );
  const browserRuntimeStateByThreadRef = useRef(browserRuntimeStateByThread);
  const activeBrowserThreadIdRef = useRef<string | null>(null);
  const pendingBrowserOpenUrlRef = useRef<string | null>(null);
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
    readonly RecentBrowserInstanceEntry<string>[]
  >([]);
  const previousMountedBrowserInstancesRef = useRef<readonly RecentBrowserInstanceEntry<string>[]>(
    [],
  );

  const browserOpen = browserMode !== "closed";
  const rightBrowserInstanceId = activeThreadId
    ? resolveBrowserInstanceId(activeThreadId, "right", windowStateInstanceId)
    : null;
  const bottomBrowserInstanceId = activeThreadId
    ? resolveBrowserInstanceId(activeThreadId, "bottom", windowStateInstanceId)
    : null;
  const rightBrowserOpen = browserOpen;
  const anyBrowserOpen = rightBrowserOpen || bottomPanelBrowserOpen;
  const activeBrowserInstanceIds = [
    rightBrowserOpen ? rightBrowserInstanceId : null,
    bottomPanelBrowserOpen ? bottomBrowserInstanceId : null,
  ].filter((instanceId): instanceId is string => instanceId !== null);
  const primaryBrowserInstanceId = activeBrowserInstanceIds[0] ?? null;

  const cleanupBrowserInstanceState = useCallback(
    (
      browserInstanceId: string,
      options?: { clearPersistentSession?: boolean; resetVisibleState?: boolean },
    ) => {
      browserControllerByThreadRef.current.delete(browserInstanceId);
      browserRuntimeStateByThreadRef.current.delete(browserInstanceId);
      deleteBrowserSession(browserInstanceId);
      if (options?.clearPersistentSession) {
        clearBrowserSessionStorage(browserInstanceId);
      }
      if (activeBrowserThreadIdRef.current !== browserInstanceId) {
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

  useLayoutEffect(() => {
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
    isElectron,
    rightSidePanelEnabled,
    rightSidePanelMode,
    setRightSidePanelMode,
  ]);
  useLayoutEffect(() => {
    if (!rightSidePanelInteractive) {
      activeBrowserThreadIdRef.current = null;
      browserControllerRef.current = null;
      return;
    }
    activeBrowserThreadIdRef.current = primaryBrowserInstanceId;
    const activeController = primaryBrowserInstanceId
      ? (browserControllerByThreadRef.current.get(primaryBrowserInstanceId) ?? null)
      : null;
    browserControllerRef.current = activeController;
    setBrowserDevToolsOpen(
      primaryBrowserInstanceId
        ? (browserRuntimeStateByThreadRef.current.get(primaryBrowserInstanceId)?.devToolsOpen ??
            false)
        : false,
    );
    const pendingUrl = pendingBrowserOpenUrlRef.current;
    if (activeController && pendingUrl) {
      pendingBrowserOpenUrlRef.current = null;
      activeController.openUrl(pendingUrl);
    }
  }, [primaryBrowserInstanceId, rightSidePanelInteractive, setBrowserDevToolsOpen]);
  useLayoutEffect(() => {
    if (!rightSidePanelInteractive) {
      return;
    }
    if (!isElectron || !activeThreadId) {
      resetBrowserCacheState();
    }
  }, [activeThreadId, isElectron, resetBrowserCacheState, rightSidePanelInteractive]);
  useEffect(() => {
    if (!rightSidePanelInteractive) {
      return;
    }
    if (!isElectron || mountedBrowserInstances.length === 0) {
      return;
    }

    const protectedThreadId = primaryBrowserInstanceId;
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
  }, [isElectron, mountedBrowserInstances, primaryBrowserInstanceId, rightSidePanelInteractive]);
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
        const activeEntry = current.find((entry) => entry.instanceId === primaryBrowserInstanceId);
        return activeEntry ? [activeEntry] : current.slice(0, 1);
      });
    };

    window.addEventListener("blur", trimBackgroundBrowserCache);
    document.addEventListener("visibilitychange", trimBackgroundBrowserCache);

    return () => {
      window.removeEventListener("blur", trimBackgroundBrowserCache);
      document.removeEventListener("visibilitychange", trimBackgroundBrowserCache);
    };
  }, [activeThreadId, isElectron, primaryBrowserInstanceId, rightSidePanelInteractive]);
  useEffect(() => {
    if (!rightSidePanelInteractive || !isElectron) {
      return;
    }

    return subscribeToMemoryPressure((snapshot) => {
      if (snapshot === null || !isMemoryPressureAtLeast("high", snapshot)) {
        return;
      }
      const protectedThreadId = primaryBrowserInstanceId;
      setMountedBrowserInstances((current) =>
        protectedThreadId ? current.filter((entry) => entry.instanceId === protectedThreadId) : [],
      );
    });
  }, [activeThreadId, isElectron, primaryBrowserInstanceId, rightSidePanelInteractive]);
  useLayoutEffect(() => {
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

  const queueBrowserDesignRequest = async (
    targetThreadId: ThreadId,
    submission: BrowserDesignRequestSubmission,
  ) => {
    const trimmedInstructions = submission.instructions.trim();
    const normalizedMimeType =
      submission.imageMimeType.trim().length > 0 ? submission.imageMimeType : "image/png";
    const fileExtension = /^image\/([a-z0-9.+-]+)$/i.exec(normalizedMimeType)?.[1] ?? "png";
    const imageAttachment = {
      type: "image" as const,
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
      const existingPendingComments = pendingComposerCommentsByThreadId[targetThreadId] ?? [];
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
        [targetThreadId]: [
          ...(current[targetThreadId] ?? []),
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
    const activeComposerThreadId = activeThread?.id ?? threadId;
    const queueTargetThreadId =
      targetThreadId === activeComposerThreadId
        ? await ensureQueuedComposerThread({
            titleSeed: trimmedInstructions || "Designer comment",
            modelSelection: selectedModelSelection,
            runtimeMode,
            interactionMode,
          })
        : targetThreadId;
    if (!queueTargetThreadId) {
      throw new Error("Failed to add the comment.");
    }
    const persisted = await appendQueuedComposerMessage(queueTargetThreadId, queuedMessage);
    if (!persisted) {
      throw new Error("Failed to add the comment.");
    }
  };

  const ensureBrowserRightSidePanelOpenWidth = useCallback(() => {
    const viewportWidth = readChatViewportWidth();
    const nextWidth = resolveBrowserOpenRightSidePanelWidth({
      currentWidth: rightSidePanelWidth,
      viewportWidth,
    });
    syncRightSidePanelWidth(nextWidth);
  }, [readChatViewportWidth, rightSidePanelWidth, syncRightSidePanelWidth]);

  const openBrowser = useCallback(() => {
    if (!isElectron) return;
    appendRightPanelTabOrder("browser");
    setRightSidePanelMode("browser");
    setBrowserMode("split");
    setRightSidePanelVisible(true);
  }, [
    appendRightPanelTabOrder,
    isElectron,
    setBrowserMode,
    setRightSidePanelMode,
    setRightSidePanelVisible,
  ]);
  const ensureBrowserBridgeController = useCallback(
    async (requestThreadId: ThreadId): Promise<InAppBrowserController> => {
      const requestBrowserInstanceId = resolveBrowserInstanceId(
        requestThreadId,
        "right",
        windowStateInstanceId,
      );
      const existingController = browserControllerByThreadRef.current.get(requestBrowserInstanceId);
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
        readController: () =>
          browserControllerByThreadRef.current.get(requestBrowserInstanceId) ?? null,
      });
      if (controller) {
        return controller;
      }

      throw new Error("Ace browser bridge could not attach to the in-app browser.");
    },
    [
      activeThreadId,
      ensureBrowserRightSidePanelOpenWidth,
      isElectron,
      openBrowser,
      windowStateInstanceId,
    ],
  );
  const closeBrowser = () => {
    setBrowserMode("closed");
    setBrowserDevToolsOpen(false);
    removeRightPanelTabOrder("browser");
    setRightSidePanelMode((current) => (current === "browser" ? "summary" : current));
    if (rightBrowserInstanceId) {
      setMountedBrowserInstances((current) =>
        current.filter((entry) => entry.instanceId !== rightBrowserInstanceId),
      );
      cleanupBrowserInstanceState(rightBrowserInstanceId, { clearPersistentSession: true });
    }
  };
  const detachRightSidePanelBrowser = () => {
    setBrowserMode("closed");
    setBrowserDevToolsOpen(false);
    removeRightPanelTabOrder("browser");
    setRightSidePanelMode((current) => (current === "browser" ? "summary" : current));
    if (rightBrowserInstanceId) {
      setMountedBrowserInstances((current) =>
        current.filter((entry) => entry.instanceId !== rightBrowserInstanceId),
      );
      cleanupBrowserInstanceState(rightBrowserInstanceId);
    }
  };

  const onOpenRightSidePanelBrowserTab = useCallback(() => {
    openBrowser();
    if (rightBrowserInstanceId) {
      browserControllerByThreadRef.current.get(rightBrowserInstanceId)?.openNewTab();
    }
  }, [openBrowser, rightBrowserInstanceId]);
  const onOpenBottomPanelBrowser = useCallback(() => {
    if (!isElectron) return;
    appendBottomPanelTabOrder("browser");
    setBottomPanelBrowserOpen(true);
    setBottomPanelMode("browser");
  }, [appendBottomPanelTabOrder, isElectron, setBottomPanelBrowserOpen, setBottomPanelMode]);
  const onOpenBottomPanelBrowserTab = useCallback(() => {
    onOpenBottomPanelBrowser();
    if (bottomBrowserInstanceId) {
      browserControllerByThreadRef.current.get(bottomBrowserInstanceId)?.openNewTab();
    }
  }, [bottomBrowserInstanceId, onOpenBottomPanelBrowser]);
  const onSelectRightSidePanelBrowserTab = (tabId: string) => {
    if (!rightBrowserInstanceId) {
      return;
    }
    openBrowser();
    const session = getBrowserSession(rightBrowserInstanceId);
    if (!session?.tabs.some((tab) => tab.id === tabId)) {
      return;
    }
    setBrowserSession(rightBrowserInstanceId, setActiveBrowserTab(session, tabId));
    browserControllerByThreadRef.current.get(rightBrowserInstanceId)?.activateTab(tabId);
  };
  const onSelectBottomPanelBrowserTab = (tabId: string) => {
    if (!bottomBrowserInstanceId) {
      return;
    }
    onOpenBottomPanelBrowser();
    const session = getBrowserSession(bottomBrowserInstanceId);
    if (!session?.tabs.some((tab) => tab.id === tabId)) {
      return;
    }
    setBrowserSession(bottomBrowserInstanceId, setActiveBrowserTab(session, tabId));
    browserControllerByThreadRef.current.get(bottomBrowserInstanceId)?.activateTab(tabId);
  };
  const onCloseRightSidePanelBrowserTab = (tabId: string) => {
    if (!rightBrowserInstanceId) {
      return;
    }
    const session = getBrowserSession(rightBrowserInstanceId);
    if (session?.tabs.length === 1) {
      closeBrowser();
      if (rightSidePanelMode === "browser") {
        setRightSidePanelMode("summary");
      }
      return;
    }
    browserControllerByThreadRef.current.get(rightBrowserInstanceId)?.closeTab(tabId);
    if (rightSidePanelMode === "browser" && session?.tabs.length === 1) {
      setRightSidePanelMode("summary");
    }
  };
  const onReorderRightSidePanelBrowserTab = (draggedTabId: string, targetTabId: string) => {
    if (!rightBrowserInstanceId) {
      return;
    }
    browserControllerByThreadRef.current
      .get(rightBrowserInstanceId)
      ?.reorderTabs(draggedTabId, targetTabId);
  };

  const onCloseBottomPanelBrowser = () => {
    setBottomPanelBrowserOpen(false);
    removeBottomPanelTabOrder("browser");
    setBottomPanelMode((current) => (current === "browser" ? "terminal" : current));
    setTerminalOpen(true);
    if (bottomBrowserInstanceId) {
      setMountedBrowserInstances((current) =>
        current.filter((entry) => entry.instanceId !== bottomBrowserInstanceId),
      );
      cleanupBrowserInstanceState(bottomBrowserInstanceId, { clearPersistentSession: true });
    }
  };
  const detachBottomPanelBrowser = () => {
    setBottomPanelBrowserOpen(false);
    removeBottomPanelTabOrder("browser");
    setBottomPanelMode((current) => (current === "browser" ? "terminal" : current));
    setTerminalOpen(true);
    if (bottomBrowserInstanceId) {
      setMountedBrowserInstances((current) =>
        current.filter((entry) => entry.instanceId !== bottomBrowserInstanceId),
      );
      cleanupBrowserInstanceState(bottomBrowserInstanceId);
    }
  };
  const onCloseBottomPanelBrowserTab = (tabId: string) => {
    if (!bottomBrowserInstanceId) {
      return;
    }
    const session = getBrowserSession(bottomBrowserInstanceId);
    if (session?.tabs.length === 1) {
      onCloseBottomPanelBrowser();
      return;
    }
    browserControllerByThreadRef.current.get(bottomBrowserInstanceId)?.closeTab(tabId);
    if (session?.tabs.length === 1) {
      setBottomPanelMode((current) => (current === "browser" ? "terminal" : current));
      setTerminalOpen(true);
    }
  };
  const onReorderBottomPanelBrowserTab = (draggedTabId: string, targetTabId: string) => {
    if (!bottomBrowserInstanceId) {
      return;
    }
    browserControllerByThreadRef.current
      .get(bottomBrowserInstanceId)
      ?.reorderTabs(draggedTabId, targetTabId);
  };

  const setBrowserController = (
    browserInstanceId: string,
    controller: InAppBrowserController | null,
  ) => {
    const previousController = browserControllerByThreadRef.current.get(browserInstanceId) ?? null;
    if (previousController === controller) {
      return;
    }
    if (controller) {
      browserControllerByThreadRef.current.set(browserInstanceId, controller);
    } else {
      browserControllerByThreadRef.current.delete(browserInstanceId);
    }
    if (activeBrowserThreadIdRef.current !== browserInstanceId) {
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
    controller.openUrl(pendingUrl);
  };
  const handleBrowserRuntimeStateChange = (
    browserInstanceId: string,
    state: ActiveBrowserRuntimeState,
  ) => {
    const previousState = browserRuntimeStateByThreadRef.current.get(browserInstanceId) ?? null;
    if (
      previousState?.devToolsOpen === state.devToolsOpen &&
      previousState.loading === state.loading
    ) {
      return;
    }
    browserRuntimeStateByThreadRef.current.set(browserInstanceId, state);
    if (activeBrowserThreadIdRef.current !== browserInstanceId) {
      return;
    }
    if ((previousState?.devToolsOpen ?? false) === state.devToolsOpen) {
      return;
    }
    setBrowserDevToolsOpen(state.devToolsOpen);
  };
  const openBrowserUrl = useCallback(
    (url: string, options?: { newTab?: boolean }) => {
      if (!isElectron || typeof url !== "string" || url.length === 0) return;
      setRightSidePanelMode("browser");
      setBrowserMode("split");
      setRightSidePanelVisible(true);
      const controller = rightBrowserInstanceId
        ? (browserControllerByThreadRef.current.get(rightBrowserInstanceId) ?? null)
        : null;
      if (!controller) {
        pendingBrowserOpenUrlRef.current = url;
        return;
      }
      controller.openUrl(url, options);
    },
    [
      isElectron,
      rightBrowserInstanceId,
      setBrowserMode,
      setRightSidePanelMode,
      setRightSidePanelVisible,
    ],
  );
  const openBrowserUrlInNewTab = useStableCallback((url: string) => {
    openBrowserUrl(url, { newTab: true });
  });

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
  }, [isElectron, openBrowser, openBrowserUrl]);

  useEffect(() => {
    if (!ownsGlobalSideEffects || !rightSidePanelInteractive) {
      return;
    }
    if (!isElectron) {
      return;
    }

    return subscribeToBrowserLaunchRequests(handleBrowserLaunchRequest);
  }, [handleBrowserLaunchRequest, isElectron, ownsGlobalSideEffects, rightSidePanelInteractive]);

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
  }, [ensureBrowserBridgeController, isElectron, ownsGlobalSideEffects, rightSidePanelInteractive]);

  const syncBrowserSplitWidth = (nextWidth: number) => {
    const viewportWidth = readChatViewportWidth();
    const clampedWidth = clampBrowserSplitWidth(nextWidth, viewportWidth);
    browserSplitWidthRef.current = clampedWidth;
    setBrowserSplitWidth(clampedWidth);
    if (lastSyncedBrowserSplitWidthRef.current === clampedWidth) {
      return;
    }
    lastSyncedBrowserSplitWidthRef.current = clampedWidth;
    setStoredBrowserSplitWidth(clampedWidth);
  };
  const syncBrowserSplitWidthEvent = useEffectEvent((nextWidth: number) => {
    syncBrowserSplitWidth(nextWidth);
  });

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
        const viewportWidth = readChatViewportWidth();
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
  }, [browserMode, readChatViewportWidth, rightSidePanelInteractive, setBrowserSplitWidth]);
  useLayoutEffect(() => {
    if (!rightSidePanelInteractive) {
      return;
    }
    const viewportWidth = readChatViewportWidth();
    const clampedWidth = clampBrowserSplitWidth(storedBrowserSplitWidth, viewportWidth);
    browserSplitWidthRef.current = clampedWidth;
    lastSyncedBrowserSplitWidthRef.current = clampedWidth;
    setBrowserSplitWidth(clampedWidth);
  }, [
    readChatViewportWidth,
    rightSidePanelInteractive,
    setBrowserSplitWidth,
    storedBrowserSplitWidth,
  ]);

  useEffect(() => {
    if (!rightSidePanelInteractive || browserMode !== "split") {
      return;
    }

    let frameId: number | null = null;
    let pendingNativeResizeSync = false;
    const syncViewportWidth = () => {
      pendingNativeResizeSync = false;
      const viewportWidth = readChatViewportWidth();
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
    browserMode,
    chatViewportRef,
    readChatViewportWidth,
    rightSidePanelInteractive,
    setBrowserSplitWidth,
  ]);

  const mountedBrowserInstanceIds = mountedBrowserInstances.map((entry) => entry.instanceId);
  const orderedBrowserInstanceIds =
    isElectron && activeThreadId
      ? [
          ...activeBrowserInstanceIds,
          ...mountedBrowserInstanceIds.filter(
            (browserInstanceId) => !activeBrowserInstanceIds.includes(browserInstanceId),
          ),
        ]
      : [];
  const browserViewMode = browserMode === "full" ? "full" : "split";
  const browserPanelAvailable = orderedBrowserInstanceIds.length > 0;

  const activeRightPanelBrowserSession = useBrowserSession(
    rightBrowserOpen ? rightBrowserInstanceId : null,
  );
  const activeBottomPanelBrowserSession = useBrowserSession(
    bottomPanelBrowserOpen ? bottomBrowserInstanceId : null,
  );
  const activeRightPanelBrowserTabId = activeRightPanelBrowserSession?.activeTabId ?? null;
  const activeBottomPanelBrowserTabId = activeBottomPanelBrowserSession?.activeTabId ?? null;
  const rightBrowserPanelInstanceIds = rightBrowserInstanceId
    ? orderedBrowserInstanceIds.filter(
        (browserInstanceId) => browserInstanceId === rightBrowserInstanceId,
      )
    : [];
  const bottomBrowserPanelInstanceIds = bottomBrowserInstanceId
    ? orderedBrowserInstanceIds.filter(
        (browserInstanceId) => browserInstanceId === bottomBrowserInstanceId,
      )
    : [];

  return {
    browserControllerRef,
    browserControllerByThread,
    browserRuntimeStateByThread,
    mountedBrowserInstances,

    browserOpen,
    rightBrowserInstanceId,
    bottomBrowserInstanceId,
    rightBrowserOpen,
    anyBrowserOpen,
    activeBrowserInstanceIds,
    primaryBrowserInstanceId,
    browserViewMode,
    browserPanelAvailable,

    closeBrowser,
    openBrowser,
    openBrowserUrl,
    openBrowserUrlInNewTab,
    detachBottomPanelBrowser,
    detachRightSidePanelBrowser,
    setBrowserController,
    handleBrowserRuntimeStateChange,
    onBrowserSessionChange,
    queueBrowserDesignRequest,
    handleBrowserLaunchRequest,

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

    browserSplitWidthRef,
    orderedBrowserInstanceIds,
    activeRightPanelBrowserSession,
    activeBottomPanelBrowserSession,
    activeRightPanelBrowserTabId,
    activeBottomPanelBrowserTabId,
    rightBrowserPanelInstanceIds,
    bottomBrowserPanelInstanceIds,
  };
}
