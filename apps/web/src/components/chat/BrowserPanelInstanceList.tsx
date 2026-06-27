import type { ComponentProps } from "react";
import type { ThreadId } from "@ace/contracts";
import {
  InAppBrowser,
  type InAppBrowserController,
  type ActiveBrowserRuntimeState,
  type BrowserViewportResizeRequest,
  type BrowserViewportResizeResult,
} from "../InAppBrowser";
import type { BrowserSessionStorage } from "~/lib/browser/session";
import type { BrowserDesignRequestSubmission } from "~/lib/browser/types";
import {
  RetainedBrowserInstances,
  type BrowserPanelInstance,
} from "./ChatViewBrowserRetainedInstances";
import { resolveBrowserThreadIdFromInstanceId } from "./chatViewUtils";

interface BrowserPanelInstanceListProps {
  active: boolean;
  bottomBrowserInstanceId: string | null;
  bottomPanelBrowserOpen: boolean;
  bottomPanelMotionActive: boolean;
  browserBackShortcutLabel: string | null;
  browserDesignerAreaCommentShortcutLabel: string | null;
  browserDesignerElementCommentShortcutLabel: string | null;
  browserDevToolsShortcutLabel: string | null;
  browserForwardShortcutLabel: string | null;
  browserInstanceIds: readonly string[];
  browserReloadShortcutLabel: string | null;
  browserViewMode: ComponentProps<typeof InAppBrowser>["mode"];
  closeBrowser: () => void;
  detachBottomPanelBrowser: () => void;
  detachRightSidePanelBrowser: () => void;
  handleBrowserRuntimeStateChange: (
    browserInstanceId: string,
    state: ActiveBrowserRuntimeState,
  ) => void;
  isThreadHistoryLoading: boolean;
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
  rightBrowserInstanceId: string | null;
  rightBrowserOpen: boolean;
  rightPanelMotionActive: boolean;
  rightSidePanelInteractive: boolean;
  setBrowserController: (
    browserInstanceId: string,
    controller: InAppBrowserController | null,
  ) => void;
}

export function BrowserPanelInstanceList({
  active,
  bottomBrowserInstanceId,
  bottomPanelBrowserOpen,
  bottomPanelMotionActive,
  browserBackShortcutLabel,
  browserDesignerAreaCommentShortcutLabel,
  browserDesignerElementCommentShortcutLabel,
  browserDevToolsShortcutLabel,
  browserForwardShortcutLabel,
  browserInstanceIds,
  browserReloadShortcutLabel,
  browserViewMode,
  closeBrowser,
  detachBottomPanelBrowser,
  detachRightSidePanelBrowser,
  handleBrowserRuntimeStateChange,
  isThreadHistoryLoading,
  onBrowserSessionChange,
  onCloseBottomPanelBrowser,
  onToggleRightSidePanelFloatingChat,
  onToggleRightSidePanelFullscreen,
  queueBrowserDesignRequest,
  resolveBrowserThreadConnectionUrl,
  resizeBrowserViewportForBridge,
  rightBrowserInstanceId,
  rightBrowserOpen,
  rightPanelMotionActive,
  rightSidePanelInteractive,
  setBrowserController,
}: BrowserPanelInstanceListProps) {
  if (!active || browserInstanceIds.length === 0) {
    return null;
  }
  const instances: readonly BrowserPanelInstance[] = browserInstanceIds.map((browserInstanceId) => {
    const browserThreadId = resolveBrowserThreadIdFromInstanceId(browserInstanceId);
    const isRightBrowserInstance = browserInstanceId === rightBrowserInstanceId;
    const isBottomBrowserInstance = browserInstanceId === bottomBrowserInstanceId;
    const isVisibleBrowserInstance =
      (isRightBrowserInstance && rightBrowserOpen) ||
      (isBottomBrowserInstance && bottomPanelBrowserOpen);
    const browserPanelMotionActive =
      (isRightBrowserInstance && rightPanelMotionActive) ||
      (isBottomBrowserInstance && bottomPanelMotionActive);
    const browserConnectionUrl = resolveBrowserThreadConnectionUrl(browserThreadId);
    return {
      key: browserInstanceId,
      inAppBrowserProps: {
        open: true,
        activeInstance:
          isVisibleBrowserInstance && rightSidePanelInteractive && !browserPanelMotionActive,
        connectionUrl: browserConnectionUrl,
        deferWebviewMount: isThreadHistoryLoading,
        visible: isVisibleBrowserInstance,
        mode: browserViewMode,
        scopeId: browserInstanceId,
        onClose: isBottomBrowserInstance ? onCloseBottomPanelBrowser : closeBrowser,
        onDetached: isBottomBrowserInstance
          ? detachBottomPanelBrowser
          : detachRightSidePanelBrowser,
        onBrowserSessionChange: (session: BrowserSessionStorage) => {
          onBrowserSessionChange(browserInstanceId, session);
        },
        onControllerChange: (controller: InAppBrowserController | null) => {
          setBrowserController(browserInstanceId, controller);
        },
        onActiveRuntimeStateChange: (state: ActiveBrowserRuntimeState) => {
          handleBrowserRuntimeStateChange(browserInstanceId, state);
        },
        onResizeViewport: (request: BrowserViewportResizeRequest) =>
          resizeBrowserViewportForBridge(browserThreadId, request),
        onToggleRightPanelFloatingChat: onToggleRightSidePanelFloatingChat,
        onToggleRightPanelFullscreen: onToggleRightSidePanelFullscreen,
        backShortcutLabel: browserBackShortcutLabel,
        designerAreaCommentShortcutLabel: browserDesignerAreaCommentShortcutLabel,
        designerElementCommentShortcutLabel: browserDesignerElementCommentShortcutLabel,
        devToolsShortcutLabel: browserDevToolsShortcutLabel,
        forwardShortcutLabel: browserForwardShortcutLabel,
        reloadShortcutLabel: browserReloadShortcutLabel,
        onQueueDesignRequest: (submission: BrowserDesignRequestSubmission) =>
          queueBrowserDesignRequest(browserThreadId, submission),
      },
    };
  });

  return <RetainedBrowserInstances instances={instances} />;
}
