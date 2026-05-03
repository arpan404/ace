import { OrchestrationEvent, ThreadId, type ServerLifecycleWelcomePayload } from "@ace/contracts";
import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  useNavigate,
  useLocation,
} from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";

import { resolveAppStartupMessage, resolveAppStartupState } from "../appStartup";
import { LEAN_SNAPSHOT_RECOVERY_INPUT, resolveWelcomeBootstrapPlan } from "../bootstrapRecovery";
import { APP_DISPLAY_NAME } from "../branding";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { AgentAttentionNotificationBridge } from "../components/AgentAttentionNotificationBridge";
import { AppStartupScreen } from "../components/AppStartupScreen";
import { InAppBrowser, type InAppBrowserController } from "../components/InAppBrowser";
import { LoadDiagnosticsConsole } from "../components/LoadDiagnosticsConsole";
import { RemoteAutoConnectBootstrap } from "../components/RemoteAutoConnectBootstrap";
import { Button } from "../components/ui/button";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { runAsyncTask } from "../lib/async";
import { beginLoadPhase, logLoadDiagnostic } from "../loadDiagnostics";
import { readNativeApi } from "../nativeApi";
import { isElectron } from "../env";
import {
  type ServerConfigUpdateSource,
  useServerConfig,
  useServerConfigUpdatedSubscription,
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
import { migrateLocalSettingsToServer } from "../hooks/useSettings";
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

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
  const detachedBrowserSearch = useLocation({
    select: (location) => {
      const searchParams = new URLSearchParams(location.searchStr);
      if (searchParams.get("aceDetachedBrowser") !== "1") {
        return null;
      }
      return {
        initialUrl: searchParams.get("initialUrl"),
        scopeId: searchParams.get("browserScope"),
      };
    },
  });
  if (detachedBrowserSearch) {
    return <DetachedBrowserWindow search={detachedBrowserSearch} />;
  }

  return <MainRootRouteView />;
}

function MainRootRouteView() {
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const [remoteBootstrapSettled, setRemoteBootstrapSettled] = useState(
    import.meta.env.MODE === "test",
  );
  const [wsHostEpoch, setWsHostEpoch] = useState(0);
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
          message={resolveAppStartupMessage(startupStateForDisplay, APP_DISPLAY_NAME)}
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
                  message={resolveAppStartupMessage(startupState, APP_DISPLAY_NAME)}
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
  search: { scopeId: string | null; initialUrl: string | null };
}) {
  const openedInitialUrlRef = useRef(false);
  const [controller, setController] = useState<InAppBrowserController | null>(null);

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
            onControllerChange={setController}
          />
        </div>
      </AnchoredToastProvider>
    </ToastProvider>
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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <section className="relative w-full max-w-xl rounded-xl border border-border bg-card p-6 sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Something went wrong.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => reset()}>
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border bg-background">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="group-open:hidden">Show error details</span>
            <span className="hidden group-open:inline">Hide error details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border bg-muted/60 px-3 py-2 text-xs text-foreground">
            {details}
          </pre>
        </details>
      </section>
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

function EventRouter() {
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
      | { kind: "timeout"; handle: ReturnType<typeof setTimeout> }
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
      } else if (pendingDomainEventFlushHandle.kind === "timeout") {
        clearTimeout(pendingDomainEventFlushHandle.handle);
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
      pendingDomainEventFlushHandle = {
        kind: "timeout",
        handle: setTimeout(() => {
          flushPendingDomainEvents();
        }, 16),
      };
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
      if (typeof window !== "undefined" && window.desktopBridge?.sendOrchestrationEvent) {
        window.desktopBridge.sendOrchestrationEvent(event);
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

function DesktopProjectBootstrap() {
  // Desktop hydration runs through EventRouter project + orchestration sync.
  return null;
}
