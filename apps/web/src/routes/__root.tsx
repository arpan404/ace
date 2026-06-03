import { OrchestrationEvent, ThreadId, type ServerLifecycleWelcomePayload } from "@ace/contracts";
import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  useNavigate,
  useLocation,
} from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";
import { ChevronDownIcon, CircleAlertIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react";

import { resolveAppStartupMessage, resolveAppStartupState } from "../appStartup";
import { LEAN_SNAPSHOT_RECOVERY_INPUT, resolveWelcomeBootstrapPlan } from "../bootstrapRecovery";
import { APP_BASE_NAME } from "../branding";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { AgentAttentionNotificationBridge } from "../components/AgentAttentionNotificationBridge";
import { AppStartupScreen } from "../components/AppStartupScreen";
import { InAppBrowser, type InAppBrowserController } from "../components/InAppBrowser";
import { LoadDiagnosticsConsole } from "../components/LoadDiagnosticsConsole";
import { RemoteAutoConnectBootstrap } from "../components/RemoteAutoConnectBootstrap";
import { Button } from "../components/ui/button";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import { resolveEditorInstanceStateScopeId, useEditorStateStore } from "../editorStateStore";
import { clearBrowserSessionStorage } from "../lib/browser/session";
import type { BrowserDesignRequestSubmission } from "../lib/browser/types";
import {
  applyTransportConnectionHealthState,
  setConnectionHealthToastsEnabled,
} from "../lib/reliability/connectionHealth";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { runAsyncTask } from "../lib/async";
import { beginLoadPhase, logLoadDiagnostic } from "../loadDiagnostics";
import { readNativeApi } from "../nativeApi";
import { isElectron } from "../env";
import {
  type ServerConfigUpdateSource,
  useServerAvailableEditors,
  useServerConfig,
  useServerConfigUpdatedSubscription,
  useServerKeybindings,
  useServerWelcomeSubscription,
} from "../rpc/serverState";
import { ServerStateBootstrap } from "../rpc/serverStateBootstrap";
import {
  clearPromotedDraftThread,
  clearPromotedDraftThreads,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { terminalRunningSubprocessFromEvent } from "../terminalActivity";
import { migrateLocalSettingsToServer, useSetting } from "../hooks/useSettings";
import { UiTypographyBridge } from "../components/UiTypographyBridge";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { projectQueryKeys } from "../lib/projectReactQuery";
import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";
import { deriveOrchestrationBatchEffects } from "../orchestrationEventEffects";
import {
  coalesceOrchestrationUiEvents,
  resolveOrchestrationUiEventFlushPriority,
} from "../orchestrationUiEvents";
import { createOrchestrationRecoveryCoordinator } from "../orchestrationRecovery";
import { useEffectEvent } from "../hooks/useEffectEvent";
import { resetWsRpcClient } from "../wsRpcClient";
import { useDesktopCliInstallState } from "../lib/desktopCliInstallReactQuery";
import { getRouteRpcClient, subscribeToRemoteRelayConnectionState } from "../lib/remoteWsRouter";
import { parseHostConnectionQrPayload, resolveLocalDeviceWsUrl } from "../lib/remoteHosts";
import { useHostConnectionStore } from "../hostConnectionStore";
import { queueDesktopPairingLink } from "../lib/desktopPairingLinks";
import { parseRelayConnectionUrl } from "@ace/shared/relay";
import { shouldForwardDesktopNotificationOrchestrationEvent } from "@ace/shared/notifications";
import { appendBrowserDesignContextToPrompt } from "../lib/terminalContext";
import { newCommandId, newMessageId, randomUUID } from "../lib/utils";
import {
  dispatchDetachedWindowReturnRequest,
  resolveDetachedWindowReturnThreadId,
} from "../lib/detachedWindowReturn";

const DetachedThreadWorkspaceEditor = lazy(
  () => import("../components/editor/ThreadWorkspaceEditor"),
);

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_BASE_NAME }],
  }),
});

function RootRouteView() {
  const detachedWindowSearch = useLocation({
    select: (location) => {
      const searchParams = new URLSearchParams(location.searchStr);
      if (searchParams.get("aceDetachedBrowser") === "1") {
        return {
          kind: "browser" as const,
          initialUrl: searchParams.get("initialUrl"),
          scopeId: searchParams.get("browserScope"),
        };
      }
      if (searchParams.get("aceDetachedEditor") === "1") {
        return {
          kind: "editor" as const,
          connectionUrl: searchParams.get("connectionUrl"),
          editorStateInstanceId: searchParams.get("editorStateInstanceId"),
          placement: searchParams.get("placement"),
          threadId: searchParams.get("threadId"),
          workspaceMode: searchParams.get("workspaceMode"),
        };
      }
      return null;
    },
  });
  if (detachedWindowSearch?.kind === "browser") {
    return <DetachedBrowserWindow search={detachedWindowSearch} />;
  }
  if (detachedWindowSearch?.kind === "editor") {
    return <DetachedEditorWindow search={detachedWindowSearch} />;
  }

  return <MainRootRouteView />;
}

function MainRootRouteView() {
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const reliabilityUxEnabled = useSetting("reliabilityUxEnabled");
  const [remoteBootstrapSettled, setRemoteBootstrapSettled] = useState(
    import.meta.env.MODE === "test",
  );
  const [wsHostEpoch, setWsHostEpoch] = useState(0);
  const navigate = useNavigate();
  useEffect(() => {
    setConnectionHealthToastsEnabled(reliabilityUxEnabled);
  }, [reliabilityUxEnabled]);
  const handleRemoteBootstrapSettled = useCallback(() => {
    setRemoteBootstrapSettled(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleHostChange = () => {
      void resetWsRpcClient().finally(() => {
        setWsHostEpoch((current) => current + 1);
      });
    };
    window.addEventListener("ace:ws-host-changed", handleHostChange);
    return () => {
      window.removeEventListener("ace:ws-host-changed", handleHostChange);
    };
  }, []);

  useEffect(() => {
    if (!isElectron) {
      return;
    }
    return window.desktopBridge?.onDetachedWindowReturn?.((request) => {
      const returnThreadId = resolveDetachedWindowReturnThreadId(request);
      const dispatchRequest = () => dispatchDetachedWindowReturnRequest(request);
      if (!returnThreadId) {
        dispatchRequest();
        return;
      }
      runAsyncTask(
        Promise.resolve()
          .then(() =>
            navigate({
              to: "/$threadId",
              params: { threadId: returnThreadId },
              search: (previous) => previous,
            }),
          )
          .finally(dispatchRequest),
        "Detached window return navigation failed.",
      );
    });
  }, [navigate]);

  const startupState = resolveAppStartupState({
    bootstrapComplete,
    hasNativeApi: readNativeApi() !== undefined,
  });
  const startupStateForDisplay = remoteBootstrapSettled ? startupState : "connecting";

  return (
    <>
      <RemoteAutoConnectBootstrap
        key={`remote-bootstrap-${String(wsHostEpoch)}`}
        onSettled={handleRemoteBootstrapSettled}
      />
      <LoadDiagnosticsConsole />
      {!remoteBootstrapSettled || startupState === "connecting" ? (
        <AppStartupScreen
          state={startupStateForDisplay}
          message={resolveAppStartupMessage(startupStateForDisplay, APP_BASE_NAME)}
        />
      ) : (
        <>
          <ServerStateBootstrap key={`server-state-${String(wsHostEpoch)}`} />
          <ToastProvider>
            <AnchoredToastProvider>
              <UiTypographyBridge />
              <DesktopCliInstallToastBridge />
              <DesktopPairingLinkBridge />
              <RemoteRelayConnectionToastBridge />
              <EventRouter key={`event-router-${String(wsHostEpoch)}`} />
              <AgentAttentionNotificationBridge />
              {startupState === "ready" ? (
                <>
                  <DesktopProjectBootstrap />
                  <AppSidebarLayout>
                    <Outlet />
                  </AppSidebarLayout>
                </>
              ) : (
                <AppStartupScreen
                  state={startupState}
                  message={resolveAppStartupMessage(startupState, APP_BASE_NAME)}
                />
              )}
            </AnchoredToastProvider>
          </ToastProvider>
        </>
      )}
    </>
  );
}

function DetachedBrowserWindow(props: {
  search: { kind: "browser"; scopeId: string | null; initialUrl: string | null };
}) {
  const openedInitialUrlRef = useRef(false);
  const returningToMainWindowRef = useRef(false);
  const [controller, setController] = useState<InAppBrowserController | null>(null);
  const threadId = useMemo(
    () => resolveThreadIdFromBrowserScope(props.search.scopeId),
    [props.search.scopeId],
  );
  const thread = useStore((store) =>
    threadId
      ? (store.threadsById?.[threadId] ??
        store.threads.find((candidate) => candidate.id === threadId) ??
        null)
      : null,
  );
  const queueDetachedBrowserDesignRequest = useCallback(
    async (submission: BrowserDesignRequestSubmission) => {
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
    },
    [thread, threadId],
  );
  const moveBrowserBackToAce = useCallback(async () => {
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
  }, [props.search.scopeId]);

  useEffect(() => {
    const clearDetachedBrowserState = () => {
      if (returningToMainWindowRef.current) {
        return;
      }
      clearBrowserSessionStorage(props.search.scopeId);
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

function resolveThreadIdFromBrowserScope(scopeId: string | null): ThreadId | null {
  if (!scopeId) {
    return null;
  }
  const [threadId] = scopeId.split(":browser:");
  return threadId && threadId !== scopeId ? ThreadId.makeUnsafe(threadId) : null;
}

function DetachedEditorWindow(props: {
  search: {
    kind: "editor";
    threadId: string | null;
    connectionUrl: string | null;
    editorStateInstanceId: string | null;
    placement: string | null;
    workspaceMode: string | null;
  };
}) {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <UiTypographyBridge />
        <ServerStateBootstrap />
        <DetachedThreadSnapshotBootstrap
          connectionUrl={props.search.connectionUrl}
          threadId={props.search.threadId}
        />
        <DetachedEditorWindowContent
          connectionUrl={props.search.connectionUrl}
          editorStateInstanceId={props.search.editorStateInstanceId}
          placement={props.search.placement}
          threadId={props.search.threadId}
          workspaceMode={props.search.workspaceMode}
        />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function DetachedThreadSnapshotBootstrap(props: {
  threadId: string | null;
  connectionUrl: string | null;
}) {
  const mergeServerReadModel = useStore((store) => store.mergeServerReadModel);

  useEffect(() => {
    if (!props.threadId) {
      return;
    }
    const threadId = ThreadId.makeUnsafe(props.threadId);
    const connectionUrl = props.connectionUrl?.trim() || null;
    let disposed = false;

    runAsyncTask(
      (async () => {
        const snapshot = connectionUrl
          ? await getRouteRpcClient(connectionUrl).orchestration.getSnapshot({
              hydrateThreadId: threadId,
            })
          : await readNativeApi()?.orchestration.getSnapshot({ hydrateThreadId: threadId });
        if (!snapshot || disposed) {
          return;
        }
        mergeServerReadModel(snapshot, {
          hydrateThreadId: threadId,
          ...(connectionUrl ? { connectionUrl } : {}),
        });
      })(),
      "Detached editor snapshot bootstrap failed.",
    );

    return () => {
      disposed = true;
    };
  }, [mergeServerReadModel, props.connectionUrl, props.threadId]);

  return null;
}

function DetachedEditorWindowContent(props: {
  threadId: string | null;
  connectionUrl: string | null;
  editorStateInstanceId: string | null;
  placement: string | null;
  workspaceMode: string | null;
}) {
  const threadId = useMemo(
    () => (props.threadId ? ThreadId.makeUnsafe(props.threadId) : null),
    [props.threadId],
  );
  const thread = useStore((store) =>
    threadId
      ? (store.threadsById?.[threadId] ??
        store.threads.find((candidate) => candidate.id === threadId) ??
        null)
      : null,
  );
  const project = useStore((store) =>
    thread ? (store.projects.find((candidate) => candidate.id === thread.projectId) ?? null) : null,
  );
  const keybindings = useServerKeybindings();
  const availableEditors = useServerAvailableEditors();
  const clearEditorThreadState = useEditorStateStore((state) => state.clearThreadState);
  const returningToMainWindowRef = useRef(false);
  const editorStateInstanceId =
    typeof props.editorStateInstanceId === "string"
      ? props.editorStateInstanceId.trim() || undefined
      : undefined;
  const editorStateScopeId = useMemo(() => {
    if (!threadId || !thread || !project) {
      return null;
    }
    return resolveEditorInstanceStateScopeId({
      gitCwd: thread.worktreePath ?? project.cwd,
      instanceId: editorStateInstanceId,
      threadId,
    });
  }, [editorStateInstanceId, project, thread, threadId]);
  const moveEditorBackToAce = useCallback(async () => {
    const returnDetachedWindow = window.desktopBridge?.returnDetachedWindow;
    if (!returnDetachedWindow || !props.threadId) {
      return;
    }
    const placement =
      props.placement === "bottom" || props.placement === "right" || props.placement === "workspace"
        ? props.placement
        : undefined;
    const workspaceMode =
      props.workspaceMode === "editor" || props.workspaceMode === "split"
        ? props.workspaceMode
        : undefined;
    const returned = await returnDetachedWindow({
      kind: "editor",
      threadId: props.threadId,
      ...(props.connectionUrl ? { connectionUrl: props.connectionUrl } : {}),
      ...(editorStateInstanceId ? { editorStateInstanceId } : {}),
      ...(placement ? { placement } : {}),
      ...(workspaceMode ? { workspaceMode } : {}),
    });
    if (returned) {
      returningToMainWindowRef.current = true;
      window.close();
      return;
    }
    toastManager.add({
      type: "error",
      title: "Could not move editor back",
      description: "The desktop app did not restore the editor panel.",
    });
  }, [
    props.connectionUrl,
    editorStateInstanceId,
    props.placement,
    props.threadId,
    props.workspaceMode,
  ]);

  useEffect(() => {
    if (!editorStateScopeId) {
      return;
    }
    const clearDetachedEditorState = () => {
      if (returningToMainWindowRef.current) {
        return;
      }
      clearEditorThreadState(editorStateScopeId);
    };
    window.addEventListener("pagehide", clearDetachedEditorState);
    window.addEventListener("beforeunload", clearDetachedEditorState);
    return () => {
      window.removeEventListener("pagehide", clearDetachedEditorState);
      window.removeEventListener("beforeunload", clearDetachedEditorState);
    };
  }, [clearEditorThreadState, editorStateScopeId]);

  if (!threadId) {
    return <DetachedWindowMessage title="Editor unavailable" description="Missing thread id." />;
  }
  if (!thread || !project) {
    return (
      <DetachedWindowMessage title="Loading editor" description="Preparing workspace state..." />
    );
  }

  const gitCwd = thread.worktreePath ?? project.cwd;
  return (
    <div className="relative h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <Suspense
        fallback={<DetachedWindowMessage title="Loading editor" description="Starting editor..." />}
      >
        <DetachedThreadWorkspaceEditor
          availableEditors={availableEditors}
          branch={thread.branch}
          browserOpen={false}
          connectionUrl={props.connectionUrl}
          gitCwd={gitCwd}
          keybindings={keybindings}
          lspCwd={project.cwd}
          terminalOpen={false}
          threadId={threadId}
          worktreePath={thread.worktreePath}
          editorStateInstanceId={editorStateInstanceId}
          workspaceMode="editor"
          detachEnabled={false}
          onReturnToMainWindow={() => {
            void moveEditorBackToAce();
          }}
        />
      </Suspense>
    </div>
  );
}

function DetachedWindowMessage(props: { title: string; description: string }) {
  return (
    <div className="flex h-dvh min-h-0 items-center justify-center bg-background px-6 text-center text-foreground">
      <div>
        <h1 className="text-sm font-semibold">{props.title}</h1>
        <p className="mt-2 text-xs text-muted-foreground">{props.description}</p>
      </div>
    </div>
  );
}

function DesktopCliInstallToastBridge() {
  const cliInstallQuery = useDesktopCliInstallState();
  const cliInstallState = cliInstallQuery.data ?? null;
  const installToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);

  useEffect(() => {
    if (!cliInstallState || cliInstallState.status !== "installing") {
      if (installToastIdRef.current !== null) {
        toastManager.close(installToastIdRef.current);
        installToastIdRef.current = null;
      }
      return;
    }

    const progressPercent = Math.max(
      0,
      Math.min(100, Math.round(cliInstallState.progressPercent ?? 0)),
    );
    const toastPayload = {
      type: "loading" as const,
      title: "Installing ace CLI",
      description:
        cliInstallState.message ?? `Installing the \`ace\` CLI. (${String(progressPercent)}%)`,
      timeout: 0,
      data: {
        progressPercent,
      },
    };

    if (installToastIdRef.current === null) {
      installToastIdRef.current = toastManager.add(toastPayload);
      return;
    }

    toastManager.update(installToastIdRef.current, toastPayload);
  }, [cliInstallState]);

  useEffect(
    () => () => {
      if (installToastIdRef.current !== null) {
        toastManager.close(installToastIdRef.current);
        installToastIdRef.current = null;
      }
    },
    [],
  );

  return null;
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex h-12 items-center justify-between border-b border-border/55 px-4">
        <div className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-md border border-border/70 bg-muted/20 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
            {APP_BASE_NAME.slice(0, 1).toUpperCase()}
          </span>
          <span className="text-sm font-medium">{APP_BASE_NAME}</span>
        </div>
        <span className="text-[11px] text-muted-foreground">App error</span>
      </header>

      <main className="flex flex-1 items-start justify-center px-4 py-16 sm:px-6">
        <section className="w-full max-w-2xl overflow-hidden rounded-[var(--panel-radius)] border border-border/70 bg-background shadow-[0_1px_0_hsl(var(--foreground)/0.04)]">
          <div className="flex items-start gap-3 border-b border-border/55 bg-muted/10 px-4 py-3">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive">
              <CircleAlertIcon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-sm font-semibold leading-6">Something went wrong</h1>
              <p className="truncate text-xs leading-5 text-muted-foreground">{message}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <Button size="sm" variant="ghost" onClick={() => reset()}>
              <RotateCcwIcon className="size-4" />
              Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
              <RefreshCwIcon className="size-4" />
              Reload app
            </Button>
          </div>

          <details className="group border-t border-border/55">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/18 hover:text-foreground">
              <span className="group-open:hidden">Show error details</span>
              <span className="hidden group-open:inline">Hide error details</span>
              <ChevronDownIcon className="size-3.5 transition-transform group-open:rotate-180" />
            </summary>
            <pre className="max-h-72 overflow-auto border-t border-border/55 bg-muted/18 px-4 py-3 font-mono text-[11px] leading-5 text-muted-foreground">
              {details}
            </pre>
          </details>
        </section>
      </main>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

function DesktopPairingLinkBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isElectron) {
      return;
    }

    return window.desktopBridge?.onPairingUrl?.((url) => {
      const parsed = parseHostConnectionQrPayload(url);
      if (!parsed || parsed.kind !== "pairing") {
        toastManager.add({
          type: "error",
          title: "Unsupported pairing link.",
          description: "ace desktop only imports ace://pair links through the desktop protocol.",
        });
        return;
      }

      queueDesktopPairingLink(url);
      if (window.location.pathname === "/settings/devices") {
        return;
      }

      void navigate({ to: "/settings/devices" });
    });
  }, [navigate]);

  return null;
}

function RemoteRelayConnectionToastBridge() {
  const disconnectedConnectionUrlsRef = useRef(new Set<string>());

  useEffect(() => {
    return subscribeToRemoteRelayConnectionState((event) => {
      const relayMetadata = parseRelayConnectionUrl(event.connectionUrl);
      const relayHost = relayMetadata ? new URL(relayMetadata.relayUrl).host : null;
      const remoteLabel = relayHost ? `Relay via ${relayHost}` : "Remote relay";

      if (event.kind === "disconnected") {
        disconnectedConnectionUrlsRef.current.add(event.connectionUrl);
        toastManager.add({
          type: "warning",
          title: "Remote relay disconnected.",
          description: event.error?.trim().length
            ? `${remoteLabel} is unavailable. ${event.error}`
            : `${remoteLabel} is unavailable. ace will retry automatically.`,
        });
        return;
      }

      if (!disconnectedConnectionUrlsRef.current.delete(event.connectionUrl)) {
        return;
      }

      toastManager.add({
        type: "success",
        title: "Remote relay reconnected.",
        description: `${remoteLabel} is reachable again.`,
      });
    });
  }, []);

  return null;
}

function useEventRouterLifecycle() {
  const applyOrchestrationEvents = useStore((store) => store.applyOrchestrationEvents);
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const mergeServerReadModel = useStore((store) => store.mergeServerReadModel);
  const removeReadModelEntities = useStore((store) => store.removeReadModelEntities);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const syncProjects = useUiStateStore((store) => store.syncProjects);
  const syncThreads = useUiStateStore((store) => store.syncThreads);
  const clearThreadUi = useUiStateStore((store) => store.clearThreadUi);
  const removeTerminalState = useTerminalStateStore((store) => store.removeTerminalState);
  const removeOrphanedTerminalStates = useTerminalStateStore(
    (store) => store.removeOrphanedTerminalStates,
  );
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const pathnameRef = useRef(pathname);
  const handledBootstrapThreadIdRef = useRef<ThreadId | null>(null);
  const handledConfigReplayRef = useRef(false);
  const loggedBootstrapCompleteRef = useRef(false);
  const disposedRef = useRef(false);
  const bootstrapFromSnapshotRef = useRef<() => Promise<void>>(async () => undefined);
  const serverConfig = useServerConfig();

  pathnameRef.current = pathname;

  useEffect(() => {
    if (bootstrapComplete && !loggedBootstrapCompleteRef.current) {
      loggedBootstrapCompleteRef.current = true;
      const store = useStore.getState();
      logLoadDiagnostic({
        phase: "bootstrap",
        level: "success",
        message: "Bootstrap marked complete",
        detail: {
          projectCount: store.projects.length,
          threadCount: store.threads.length,
          pathname,
        },
      });
    }
  }, [bootstrapComplete, pathname]);

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload) => {
    logLoadDiagnostic({
      phase: "bootstrap",
      message: "Processing welcome payload",
      detail: {
        bootstrapProjectId: payload.bootstrapProjectId,
        bootstrapThreadId: payload.bootstrapThreadId,
      },
    });
    migrateLocalSettingsToServer();
    runAsyncTask(
      (async () => {
        const plan = resolveWelcomeBootstrapPlan({
          bootstrapComplete,
          pathname: pathnameRef.current,
          handledBootstrapThreadId: handledBootstrapThreadIdRef.current,
          payload,
        });

        if (plan.shouldBootstrapFromSnapshot) {
          await bootstrapFromSnapshotRef.current();
        }
        if (disposedRef.current) {
          return;
        }

        if (plan.expandProjectId === null) {
          return;
        }
        setProjectExpanded(plan.expandProjectId, true);

        if (plan.navigateToThreadId === null) {
          return;
        }
        await navigate({
          to: "/$threadId",
          params: { threadId: plan.navigateToThreadId },
          replace: true,
        });
        handledBootstrapThreadIdRef.current = plan.navigateToThreadId;
      })(),
      "Failed to navigate to the bootstrap thread.",
    );
  });

  const handleServerConfigUpdated = useEffectEvent(
    ({
      payload,
      source,
    }: {
      readonly payload: import("@ace/contracts").ServerConfigUpdatedPayload;
      readonly source: ServerConfigUpdateSource;
    }) => {
      if (typeof window !== "undefined" && window.desktopBridge?.sendServerConfigEvent) {
        window.desktopBridge.sendServerConfigEvent({ type: "settingsUpdated", payload });
      }
      const isReplay = !handledConfigReplayRef.current;
      handledConfigReplayRef.current = true;
      if (isReplay || source !== "keybindingsUpdated") {
        return;
      }

      const issue = payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
      if (!issue) {
        toastManager.add({
          type: "success",
          title: "Keybindings updated",
          description: "Keybindings configuration reloaded successfully.",
        });
        return;
      }

      toastManager.add({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: issue.message,
        actionProps: {
          children: "Open keybindings.json",
          onClick: () => {
            const api = readNativeApi();
            if (!api) {
              return;
            }

            void Promise.resolve(serverConfig ?? api.server.getConfig())
              .then((config) => {
                const editor = resolveAndPersistPreferredEditor(config.availableEditors);
                if (!editor) {
                  throw new Error("No available editors found.");
                }
                return api.shell.openInEditor(config.keybindingsConfigPath, editor);
              })
              .catch((error) => {
                toastManager.add({
                  type: "error",
                  title: "Unable to open keybindings file",
                  description:
                    error instanceof Error ? error.message : "Unknown error opening file.",
                });
              });
          },
        },
      });
    },
  );

  useEffect(() => {
    const localConnectionUrl = resolveLocalDeviceWsUrl();
    const localRpcClient = getRouteRpcClient(localConnectionUrl);
    logLoadDiagnostic({ phase: "bootstrap", message: "Event router mounted" });
    let disposed = false;
    disposedRef.current = false;
    const recovery = createOrchestrationRecoveryCoordinator();
    let needsProviderInvalidation = false;
    const pendingDomainEvents: OrchestrationEvent[] = [];
    let flushPendingDomainEventsScheduled = false;
    let pendingDomainEventMicrotaskVersion = 0;
    let pendingDomainEventFlushHandle:
      | { kind: "animation-frame"; handle: number }
      | { kind: "microtask"; handle: number }
      | null = null;
    let reconnectRecoveryRequested = false;

    const reconcileSnapshotDerivedState = () => {
      const threads = useStore.getState().threads;
      const projects = useStore.getState().projects;
      syncProjects(projects.map((project) => ({ id: project.id, cwd: project.cwd })));
      syncThreads(
        threads.map((thread) => ({
          id: thread.id,
          projectId: thread.projectId,
          seedVisitedAt: thread.updatedAt ?? thread.createdAt,
        })),
      );
      clearPromotedDraftThreads(threads.map((thread) => thread.id));
      const draftThreadIds = Object.keys(
        useComposerDraftStore.getState().draftThreadsByThreadId,
      ) as ThreadId[];
      const activeThreadIds = collectActiveTerminalThreadIds({
        snapshotThreads: threads.map((thread) => ({
          id: thread.id,
          deletedAt: null,
        })),
        draftThreadIds,
      });
      removeOrphanedTerminalStates(activeThreadIds);
    };

    const queryInvalidationThrottler = new Throttler(
      () => {
        if (!needsProviderInvalidation) {
          return;
        }
        needsProviderInvalidation = false;
        void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
        // Invalidate workspace entry queries so the @-mention file picker
        // reflects files created, deleted, or restored during this turn.
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
      },
      {
        wait: 100,
        leading: false,
        trailing: true,
      },
    );

    const applyEventBatch = (events: ReadonlyArray<OrchestrationEvent>) => {
      const nextEvents = recovery.markEventBatchApplied(events);
      if (nextEvents.length === 0) {
        return;
      }

      const batchEffects = deriveOrchestrationBatchEffects(nextEvents);
      const uiEvents = coalesceOrchestrationUiEvents(nextEvents);
      const needsProjectUiSync = nextEvents.some(
        (event) =>
          event.type === "project.created" ||
          event.type === "project.meta-updated" ||
          event.type === "project.deleted",
      );

      if (batchEffects.needsProviderInvalidation) {
        needsProviderInvalidation = true;
        void queryInvalidationThrottler.maybeExecute();
      }

      applyOrchestrationEvents(uiEvents);
      if (needsProjectUiSync) {
        const projects = useStore.getState().projects;
        syncProjects(projects.map((project) => ({ id: project.id, cwd: project.cwd })));
      }
      const needsThreadUiSync = nextEvents.some(
        (event) => event.type === "thread.created" || event.type === "thread.deleted",
      );
      if (needsThreadUiSync) {
        const threads = useStore.getState().threads;
        syncThreads(
          threads.map((thread) => ({
            id: thread.id,
            projectId: thread.projectId,
            seedVisitedAt: thread.updatedAt ?? thread.createdAt,
          })),
        );
      }
      const draftStore = useComposerDraftStore.getState();
      for (const threadId of batchEffects.clearPromotedDraftThreadIds) {
        clearPromotedDraftThread(threadId);
      }
      for (const threadId of batchEffects.clearDeletedThreadIds) {
        draftStore.clearDraftThread(threadId);
        clearThreadUi(threadId);
      }
      for (const threadId of batchEffects.removeTerminalStateThreadIds) {
        removeTerminalState(threadId);
      }
    };
    const flushPendingDomainEvents = () => {
      flushPendingDomainEventsScheduled = false;
      pendingDomainEventFlushHandle = null;
      if (disposed || pendingDomainEvents.length === 0) {
        return;
      }

      const events = pendingDomainEvents.splice(0, pendingDomainEvents.length);
      applyEventBatch(events);
    };
    const cancelPendingDomainEventFlush = () => {
      pendingDomainEventMicrotaskVersion += 1;
      if (pendingDomainEventFlushHandle === null) {
        flushPendingDomainEventsScheduled = false;
        return;
      }
      if (pendingDomainEventFlushHandle.kind === "animation-frame") {
        cancelAnimationFrame(pendingDomainEventFlushHandle.handle);
      }
      pendingDomainEventFlushHandle = null;
      flushPendingDomainEventsScheduled = false;
    };
    const schedulePendingDomainEventFlush = (priority: "animation-frame" | "microtask") => {
      if (flushPendingDomainEventsScheduled) {
        if (
          priority === "microtask" &&
          pendingDomainEventFlushHandle !== null &&
          pendingDomainEventFlushHandle.kind !== "microtask"
        ) {
          cancelPendingDomainEventFlush();
        } else {
          return;
        }
      }

      flushPendingDomainEventsScheduled = true;
      if (priority === "microtask") {
        const handle = pendingDomainEventMicrotaskVersion + 1;
        pendingDomainEventMicrotaskVersion = handle;
        pendingDomainEventFlushHandle = {
          kind: "microtask",
          handle,
        };
        queueMicrotask(() => {
          if (
            !flushPendingDomainEventsScheduled ||
            pendingDomainEventFlushHandle?.kind !== "microtask" ||
            pendingDomainEventFlushHandle.handle !== handle
          ) {
            return;
          }
          flushPendingDomainEvents();
        });
        return;
      }
      if (
        typeof requestAnimationFrame === "function" &&
        (typeof document === "undefined" || document.visibilityState === "visible")
      ) {
        pendingDomainEventFlushHandle = {
          kind: "animation-frame",
          handle: requestAnimationFrame(() => {
            flushPendingDomainEvents();
          }),
        };
        return;
      }
      const handle = pendingDomainEventMicrotaskVersion + 1;
      pendingDomainEventMicrotaskVersion = handle;
      pendingDomainEventFlushHandle = {
        kind: "microtask",
        handle,
      };
      queueMicrotask(() => {
        if (
          !flushPendingDomainEventsScheduled ||
          pendingDomainEventFlushHandle?.kind !== "microtask" ||
          pendingDomainEventFlushHandle.handle !== handle
        ) {
          return;
        }
        flushPendingDomainEvents();
      });
    };

    const recoverFromReplay = async (
      reason: "sequence-gap" | "transport-reconnected",
    ): Promise<void> => {
      if (!recovery.beginReplayRecovery(reason)) {
        return;
      }
      const phase = beginLoadPhase("replay", `Recovering from replay (${reason})`);

      try {
        const events = await localRpcClient.orchestration.replayEvents({
          fromSequenceExclusive: recovery.getState().latestSequence,
        });
        if (!disposed) {
          applyEventBatch(events);
          phase.success("Replay recovery applied", {
            reason,
            eventCount: events.length,
            latestSequence: recovery.getState().latestSequence,
          });
        }
      } catch {
        phase.error("Replay recovery failed", { reason });
        recovery.failReplayRecovery();
        void fallbackToSnapshotRecovery();
        return;
      }

      if (!disposed && recovery.completeReplayRecovery()) {
        void recoverFromReplay(reason);
      }
    };

    const runSnapshotRecovery = async (reason: "bootstrap" | "replay-failed"): Promise<void> => {
      if (!recovery.beginSnapshotRecovery(reason)) {
        return;
      }
      const phase = beginLoadPhase("snapshot", `Running snapshot recovery (${reason})`, {
        hydrateThreadId: LEAN_SNAPSHOT_RECOVERY_INPUT.hydrateThreadId,
      });

      try {
        const snapshot = await localRpcClient.orchestration.getSnapshot(
          LEAN_SNAPSHOT_RECOVERY_INPUT,
        );
        if (!disposed) {
          const localOwnership = useHostConnectionStore.getState().getOwnership(localConnectionUrl);
          if (localOwnership) {
            removeReadModelEntities(localOwnership);
          }
          useHostConnectionStore.getState().upsertSnapshotOwnership(localConnectionUrl, snapshot);
          mergeServerReadModel(snapshot, {
            ...LEAN_SNAPSHOT_RECOVERY_INPUT,
            connectionUrl: localConnectionUrl,
          });
          reconcileSnapshotDerivedState();
          phase.success("Snapshot recovery applied", {
            reason,
            snapshotSequence: snapshot.snapshotSequence,
            projectCount: snapshot.projects.length,
            threadCount: snapshot.threads.length,
          });
          if (recovery.completeSnapshotRecovery(snapshot.snapshotSequence)) {
            void recoverFromReplay("sequence-gap");
          }
        }
      } catch {
        phase.error("Snapshot recovery failed", { reason });
        // Keep prior state and wait for welcome or a later replay attempt.
        recovery.failSnapshotRecovery();
      }
    };

    const bootstrapFromSnapshot = async (): Promise<void> => {
      await runSnapshotRecovery("bootstrap");
    };
    bootstrapFromSnapshotRef.current = bootstrapFromSnapshot;

    const fallbackToSnapshotRecovery = async (): Promise<void> => {
      await runSnapshotRecovery("replay-failed");
    };
    const unsubscribeConnectionState = localRpcClient.subscribeConnectionState((state) => {
      if (disposed) {
        return;
      }
      logLoadDiagnostic({
        phase: "ws",
        level: state.kind === "disconnected" ? "warning" : "success",
        message: `Connection state changed: ${state.kind}`,
        detail: state.error,
      });
      applyTransportConnectionHealthState(state);
      if (state.kind === "disconnected") {
        reconnectRecoveryRequested = true;
        cancelPendingDomainEventFlush();
        pendingDomainEvents.length = 0;
        return;
      }
      if (!reconnectRecoveryRequested) {
        return;
      }
      reconnectRecoveryRequested = false;
      flushPendingDomainEvents();
      void recoverFromReplay("transport-reconnected");
    });
    const unsubDomainEvent = localRpcClient.orchestration.onDomainEvent((event) => {
      if (
        typeof window !== "undefined" &&
        window.desktopBridge?.sendOrchestrationEvent &&
        shouldForwardDesktopNotificationOrchestrationEvent(event)
      ) {
        window.desktopBridge.sendOrchestrationEvent(event);
      }
      const action = recovery.classifyDomainEvent(event.sequence);
      if (action === "apply") {
        pendingDomainEvents.push(event);
        schedulePendingDomainEventFlush(resolveOrchestrationUiEventFlushPriority(event));
        return;
      }
      if (action === "recover") {
        logLoadDiagnostic({
          phase: "replay",
          level: "warning",
          message: "Detected sequence gap while applying domain event",
          detail: { sequence: event.sequence, type: event.type },
        });
        flushPendingDomainEvents();
        void recoverFromReplay("sequence-gap");
      }
    });
    const unsubTerminalEvent = localRpcClient.terminal.onEvent((event) => {
      const hasRunningSubprocess = terminalRunningSubprocessFromEvent(event);
      if (hasRunningSubprocess === null) {
        return;
      }
      useTerminalStateStore
        .getState()
        .setTerminalActivity(
          ThreadId.makeUnsafe(event.threadId),
          event.terminalId,
          hasRunningSubprocess,
        );
    });
    return () => {
      disposed = true;
      disposedRef.current = true;
      logLoadDiagnostic({
        phase: "bootstrap",
        message: "Event router disposed",
      });
      needsProviderInvalidation = false;
      cancelPendingDomainEventFlush();
      pendingDomainEvents.length = 0;
      reconnectRecoveryRequested = false;
      queryInvalidationThrottler.cancel();
      unsubscribeConnectionState();
      unsubDomainEvent();
      unsubTerminalEvent();
    };
  }, [
    applyOrchestrationEvents,
    navigate,
    queryClient,
    removeTerminalState,
    removeOrphanedTerminalStates,
    clearThreadUi,
    setProjectExpanded,
    syncProjects,
    mergeServerReadModel,
    removeReadModelEntities,
    syncThreads,
  ]);

  useServerWelcomeSubscription(handleWelcome);
  useServerConfigUpdatedSubscription(handleServerConfigUpdated);

  return null;
}

function EventRouter() {
  useEventRouterLifecycle();
  return null;
}

function DesktopProjectBootstrap() {
  // Desktop hydration runs through EventRouter project + orchestration sync.
  return null;
}
