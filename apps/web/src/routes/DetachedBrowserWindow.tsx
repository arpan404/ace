import { ThreadId } from "@ace/contracts";
import { useEffect, useRef, useState } from "react";

import { InAppBrowser, type InAppBrowserController } from "../components/InAppBrowser";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import { UiTypographyBridge } from "../components/UiTypographyBridge";
import { clearBrowserSessionStorage } from "../lib/browser/session";
import { resolveBrowserThreadIdFromScopeId } from "../lib/browser/scope";
import type { BrowserDesignRequestSubmission } from "../lib/browser/types";
import { appendBrowserDesignContextToPrompt } from "../lib/terminalContext";
import { newCommandId, newMessageId, randomUUID } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { DetachedThreadSnapshotBootstrap } from "./DetachedThreadSnapshotBootstrap";

function resolveThreadIdFromBrowserScope(scopeId: string | null): ThreadId | null {
  const threadId = resolveBrowserThreadIdFromScopeId(scopeId);
  return threadId ? ThreadId.makeUnsafe(threadId) : null;
}

export function DetachedBrowserWindow(props: {
  search: { kind: "browser"; scopeId: string | null; initialUrl: string | null };
}) {
  const openedInitialUrlRef = useRef(false);
  const returningToMainWindowRef = useRef(false);
  const [controller, setController] = useState<InAppBrowserController | null>(null);
  const threadId = resolveThreadIdFromBrowserScope(props.search.scopeId);
  const thread = useStore((store) =>
    threadId
      ? (store.threadsById?.[threadId] ??
        store.threads.find((candidate) => candidate.id === threadId) ??
        null)
      : null,
  );
  const queueDetachedBrowserDesignRequest = async (submission: BrowserDesignRequestSubmission) => {
    if (!threadId || !thread) {
      toastManager.add({
        type: "error",
        title: "Could not queue design note",
        description: "This browser window is not linked to a chat thread.",
      });
      return;
    }
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Could not queue design note",
        description: "The desktop API is unavailable.",
      });
      return;
    }
    const trimmedInstructions = submission.instructions.trim();
    const normalizedMimeType =
      submission.imageMimeType.trim().length > 0 ? submission.imageMimeType : "image/png";
    const fileExtension = /^image\/([a-z0-9.+-]+)$/i.exec(normalizedMimeType)?.[1] ?? "png";
    const prompt = appendBrowserDesignContextToPrompt(
      trimmedInstructions || "Review this browser screenshot.",
      {
        requestId: submission.requestId,
        pageUrl: submission.pageUrl,
        pagePath: submission.pagePath,
        selection: submission.selection,
        targetElement: submission.targetElement,
        mainContainer: submission.mainContainer,
      },
    );
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.queue.append",
        commandId: newCommandId(),
        threadId,
        position: "back",
        message: {
          id: newMessageId(),
          prompt,
          images: [
            {
              type: "image",
              id: randomUUID(),
              name: `designer-comment.${fileExtension}`,
              mimeType: normalizedMimeType,
              sizeBytes: submission.imageSizeBytes,
              dataUrl: submission.imageDataUrl,
            },
          ],
          terminalContexts: [],
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
        },
      });
      toastManager.add({
        type: "success",
        title: "Design note queued",
        description: "It was added to the linked chat.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not queue design note",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    }
  };
  const moveBrowserBackToAce = async () => {
    const returnDetachedWindow = window.desktopBridge?.returnDetachedWindow;
    if (!returnDetachedWindow) {
      return;
    }
    const returned = await returnDetachedWindow({
      kind: "browser",
      ...(props.search.scopeId ? { scopeId: props.search.scopeId } : {}),
    });
    if (returned) {
      returningToMainWindowRef.current = true;
      window.close();
      return;
    }
    toastManager.add({
      type: "error",
      title: "Could not move browser back",
      description: "The desktop app did not restore the browser panel.",
    });
  };

  useEffect(() => {
    const clearDetachedBrowserState = () => {
      if (returningToMainWindowRef.current) {
        return;
      }
      if (props.search.scopeId) {
        clearBrowserSessionStorage(props.search.scopeId);
      }
    };
    window.addEventListener("pagehide", clearDetachedBrowserState);
    window.addEventListener("beforeunload", clearDetachedBrowserState);
    return () => {
      window.removeEventListener("pagehide", clearDetachedBrowserState);
      window.removeEventListener("beforeunload", clearDetachedBrowserState);
    };
  }, [props.search.scopeId]);

  useEffect(() => {
    if (openedInitialUrlRef.current || !controller || !props.search.initialUrl) {
      return;
    }
    openedInitialUrlRef.current = true;
    controller.openUrl(props.search.initialUrl);
  }, [controller, props.search.initialUrl]);

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <UiTypographyBridge />
        {threadId ? (
          <DetachedThreadSnapshotBootstrap connectionUrl={null} threadId={threadId} />
        ) : null}
        <div className="relative h-dvh min-h-0 overflow-hidden bg-background text-foreground">
          <InAppBrowser
            open
            activeInstance
            visible
            detachEnabled={false}
            mode="full"
            {...(props.search.scopeId ? { scopeId: props.search.scopeId } : {})}
            onClose={() => {
              window.close();
            }}
            onReturnToMainWindow={() => {
              void moveBrowserBackToAce();
            }}
            onControllerChange={setController}
            {...(thread ? { onQueueDesignRequest: queueDetachedBrowserDesignRequest } : {})}
          />
        </div>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}
