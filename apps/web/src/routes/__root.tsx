import { OrchestrationEvent, ThreadId, type ServerLifecycleWelcomePayload } from "@ace/contracts";
import {
  Outlet,
  createRootRouteWithContext,
  useNavigate,
  useLocation,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";

import { resolveAppStartupMessage, resolveAppStartupState } from "../appStartup";
import {
  METADATA_SNAPSHOT_RECOVERY_INPUT,
  resolveWelcomeBootstrapPlan,
} from "../bootstrapRecovery";
import { APP_BASE_NAME } from "../branding";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { AgentAttentionNotificationBridge } from "../components/AgentAttentionNotificationBridge";
import { AppStartupScreen } from "../components/AppStartupScreen";
import { RemoteAutoConnectBootstrap } from "../components/RemoteAutoConnectBootstrap";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import { useEditorStateStore } from "../editorStateStore";
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
import {
  canUseSnapshotAsAuthoritative,
  createOrchestrationRecoveryCoordinator,
} from "../orchestrationRecovery";
import { resetWsRpcClient } from "../wsRpcClient";
import { getRouteRpcClient, subscribeToRemoteRelayConnectionState } from "../lib/remoteWsRouter";
import { parseHostConnectionQrPayload, resolveLocalDeviceWsUrl } from "../lib/remoteHosts";
import { useHostConnectionStore } from "../hostConnectionStore";
import { queueDesktopPairingLink } from "../lib/desktopPairingLinks";
import { parseRelayConnectionUrl } from "@ace/shared/relay";
import { shouldForwardDesktopNotificationOrchestrationEvent } from "@ace/shared/notifications";
import { newCommandId, newMessageId, randomUUID } from "../lib/utils";
import {
  dispatchDetachedWindowReturnRequest,
  resolveDetachedWindowReturnThreadId,
} from "../lib/detachedWindowReturn";
import { DesktopCliInstallToastBridge } from "./-DesktopCliInstallToastBridge";
import { DetachedBrowserWindow } from "./-DetachedBrowserWindow";
import { DetachedEditorWindow } from "./-DetachedEditorWindow";
import { DetachedWindowMessage } from "./-DetachedWindowMessage";
import { RootRouteErrorView } from "./-RootRouteErrorView";

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
  const handleRemoteBootstrapSettled = () => {
    setRemoteBootstrapSettled(true);
  };

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
  const disconnectedConnectionUrlsRef = useRef<Set<string>>(null!);
  if (disconnectedConnectionUrlsRef.current === null) {
    disconnectedConnectionUrlsRef.current = new Set<string>();
  }

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

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

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

  const handleWelcome = (payload: ServerLifecycleWelcomePayload) => {
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
  };

  const handleServerConfigUpdated = ({
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
                description: error instanceof Error ? error.message : "Unknown error opening file.",
              });
            });
        },
      },
    });
  };

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
        hydrateThreadId: METADATA_SNAPSHOT_RECOVERY_INPUT.hydrateThreadId,
      });

      try {
        const snapshot = await localRpcClient.orchestration.getSnapshot(
          METADATA_SNAPSHOT_RECOVERY_INPUT,
        );
        if (!disposed) {
          const recoveryStateBeforeMerge = recovery.getState();
          const canReplaceWithSnapshot = canUseSnapshotAsAuthoritative(
            recoveryStateBeforeMerge,
            snapshot.snapshotSequence,
          );
          const localOwnership = useHostConnectionStore.getState().getOwnership(localConnectionUrl);
          if (localOwnership && canReplaceWithSnapshot) {
            removeReadModelEntities(localOwnership);
          }
          if (canReplaceWithSnapshot) {
            useHostConnectionStore.getState().upsertSnapshotOwnership(localConnectionUrl, snapshot);
          } else {
            useHostConnectionStore.getState().mergeSnapshotOwnership(localConnectionUrl, snapshot);
          }
          mergeServerReadModel(snapshot, {
            ...METADATA_SNAPSHOT_RECOVERY_INPUT,
            connectionUrl: localConnectionUrl,
          });
          reconcileSnapshotDerivedState();
          phase.success("Snapshot recovery applied", {
            reason,
            snapshotSequence: snapshot.snapshotSequence,
            latestAppliedSequence: recoveryStateBeforeMerge.latestSequence,
            authoritative: canReplaceWithSnapshot,
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
      if (action === "defer") {
        // Full snapshot recovery can be slow for large threads. Live domain events
        // are still self-contained enough to update the UI immediately; the
        // snapshot/replay path will reconcile durable history afterward.
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
