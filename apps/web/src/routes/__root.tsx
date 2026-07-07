import { ThreadId, type OrchestrationEvent } from "@ace/contracts";
import {
  Outlet,
  createRootRouteWithContext,
  useNavigate,
  useLocation,
  useParams,
} from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { unstable_batchedUpdates } from "react-dom";
import { QueryClient, useQueryClient } from "@tanstack/react-query";

import { resolveAppStartupMessage, resolveAppStartupState } from "../appStartup";
import { APP_BASE_NAME } from "../branding";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { AgentAttentionNotificationBridge } from "../components/AgentAttentionNotificationBridge";
import { AppStartupScreen } from "../components/AppStartupScreen";
import { RemoteAutoConnectBootstrap } from "../components/RemoteAutoConnectBootstrap";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import {
  applyTransportConnectionHealthState,
  setConnectionHealthToastsEnabled,
} from "../lib/reliability/connectionHealth";
import { reportBackgroundError, runAsyncTask } from "../lib/async";
import { logLoadDiagnostic } from "../loadDiagnostics";
import { readNativeApi } from "../nativeApi";
import { isElectron } from "../env";
import { ServerStateBootstrap } from "../rpc/serverStateBootstrap";
import { clearPromotedDraftThreads, useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { terminalRunningSubprocessFromEvent } from "../terminalActivity";
import { useSetting } from "../hooks/useSettings";
import { UiTypographyBridge } from "../components/UiTypographyBridge";
import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";
import { resetWsRpcClient } from "../wsRpcClient";
import { clearThreadHydrationCache } from "../lib/threadHydrationCache";
import { getRouteRpcClient, subscribeToRemoteRelayConnectionState } from "../lib/remoteWsRouter";
import { parseHostConnectionQrPayload, resolveLocalDeviceWsUrl } from "../lib/remoteHosts";
import { queueDesktopPairingLink } from "../lib/desktopPairingLinks";
import { parseRelayConnectionUrl } from "@ace/shared/relay";
import { shouldForwardDesktopNotificationOrchestrationEvent } from "@ace/shared/notifications";
import {
  dispatchDetachedWindowReturnRequest,
  resolveDetachedWindowReturnThreadId,
} from "../lib/detachedWindowReturn";
import { createOrchestrationUiEventFrameBatcher } from "../orchestrationUiEvents";
import { deriveOrchestrationBatchEffects } from "../orchestrationEventEffects";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { DesktopCliInstallToastBridge } from "./-DesktopCliInstallToastBridge";
import { DetachedBrowserWindow } from "./-DetachedBrowserWindow";
import { DetachedEditorWindow } from "./-DetachedEditorWindow";
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
      useStore.getState().resetToInitialState();
      clearThreadHydrationCache();
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

function shouldReconcileDerivedStateForEvents(events: readonly OrchestrationEvent[]): boolean {
  return events.some(
    (event) =>
      event.aggregateKind === "project" ||
      event.type === "thread.created" ||
      event.type === "thread.deleted",
  );
}

function useProjectionStreamRouterLifecycle() {
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const syncServerThreadDetailHotPath = useStore((store) => store.syncServerThreadDetailHotPath);
  const syncProjects = useUiStateStore((store) => store.syncProjects);
  const syncThreads = useUiStateStore((store) => store.syncThreads);
  const clearThreadUi = useUiStateStore((store) => store.clearThreadUi);
  const removeTerminalState = useTerminalStateStore((store) => store.removeTerminalState);
  const removeOrphanedTerminalStates = useTerminalStateStore(
    (store) => store.removeOrphanedTerminalStates,
  );
  const queryClient = useQueryClient();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });

  const reconcileSnapshotDerivedState = useCallback(() => {
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
    removeOrphanedTerminalStates(
      collectActiveTerminalThreadIds({
        snapshotThreads: threads.map((thread) => ({
          id: thread.id,
          deletedAt: null,
        })),
        draftThreadIds,
      }),
    );
  }, [removeOrphanedTerminalStates, syncProjects, syncThreads]);

  const applyDomainEventEffects = useCallback(
    (events: readonly OrchestrationEvent[]) => {
      const effects = deriveOrchestrationBatchEffects(events);
      if (effects.clearPromotedDraftThreadIds.length > 0) {
        clearPromotedDraftThreads(effects.clearPromotedDraftThreadIds);
      }
      for (const threadId of effects.clearDeletedThreadIds) {
        clearThreadUi(threadId);
      }
      for (const threadId of effects.removeTerminalStateThreadIds) {
        removeTerminalState(threadId);
      }
      if (effects.needsProviderInvalidation) {
        void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
      }
      if (shouldReconcileDerivedStateForEvents(events)) {
        reconcileSnapshotDerivedState();
      }
    },
    [clearThreadUi, queryClient, reconcileSnapshotDerivedState, removeTerminalState],
  );

  useEffect(() => {
    const localConnectionUrl = resolveLocalDeviceWsUrl();
    const localRpcClient = getRouteRpcClient(localConnectionUrl);
    let lastAppliedSequence = -1;
    const domainEventBatcher = createOrchestrationUiEventFrameBatcher((events) => {
      unstable_batchedUpdates(() => {
        useStore.getState().applyOrchestrationEvents(events);
        applyDomainEventEffects(events);
      });
    });

    const applyShellSnapshot = (
      snapshot: Awaited<ReturnType<typeof localRpcClient.orchestration.getShellSnapshot>>,
      sequence: number,
    ) => {
      if (sequence < lastAppliedSequence) {
        return;
      }
      lastAppliedSequence = sequence;
      unstable_batchedUpdates(() => {
        syncServerShellSnapshot(snapshot);
        reconcileSnapshotDerivedState();
      });
    };

    const unsubscribeConnectionState = localRpcClient.subscribeConnectionState((state) => {
      logLoadDiagnostic({
        phase: "ws",
        level: state.kind === "disconnected" ? "warning" : "success",
        message: `Connection state changed: ${state.kind}`,
        detail: state.error,
      });
      applyTransportConnectionHealthState(state);
    });

    const unsubscribeProjection = localRpcClient.orchestration.stream(
      { scope: { kind: "shell" } },
      (item) => {
        if (item.kind === "heartbeat") {
          lastAppliedSequence = Math.max(lastAppliedSequence, item.sequence);
          return;
        }
        if (
          item.kind === "snapshot" &&
          item.snapshot.scope.kind === "shell" &&
          "shell" in item.snapshot
        ) {
          applyShellSnapshot(item.snapshot.shell, item.snapshot.sequence);
          return;
        }
        if (
          item.kind === "reset" &&
          item.snapshot.scope.kind === "shell" &&
          "shell" in item.snapshot
        ) {
          applyShellSnapshot(item.snapshot.shell, item.snapshot.sequence);
          return;
        }
        if (item.kind === "patch" && item.patch.scope.kind === "shell" && "shell" in item.patch) {
          applyShellSnapshot(item.patch.shell, item.patch.sequence);
        }
      },
    );

    const unsubscribeDomainEvents = localRpcClient.orchestration.onDomainEvent((event) => {
      if (
        typeof window !== "undefined" &&
        window.desktopBridge?.sendOrchestrationEvent &&
        shouldForwardDesktopNotificationOrchestrationEvent(event)
      ) {
        try {
          window.desktopBridge.sendOrchestrationEvent(event);
        } catch (error) {
          reportBackgroundError("Failed to forward orchestration event to desktop bridge.", error);
        }
      }
      domainEventBatcher.enqueue(event);
    });

    const unsubscribeTerminal = localRpcClient.terminal.onEvent((event) => {
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
      unsubscribeConnectionState();
      unsubscribeProjection();
      unsubscribeDomainEvents();
      unsubscribeTerminal();
      domainEventBatcher.dispose();
    };
  }, [applyDomainEventEffects, reconcileSnapshotDerivedState, syncServerShellSnapshot]);

  useEffect(() => {
    const threadId = routeThreadId;
    if (!threadId) {
      return;
    }
    const localConnectionUrl = resolveLocalDeviceWsUrl();
    const localRpcClient = getRouteRpcClient(localConnectionUrl);
    let lastAppliedSequence = -1;

    const unsubscribeProjection = localRpcClient.orchestration.stream(
      { scope: { kind: "thread", threadId } },
      (item) => {
        if (item.kind === "heartbeat") {
          lastAppliedSequence = Math.max(lastAppliedSequence, item.sequence);
          return;
        }
        const projection =
          item.kind === "snapshot"
            ? item.snapshot
            : item.kind === "reset"
              ? item.snapshot
              : item.kind === "patch"
                ? item.patch
                : null;
        if (!projection || projection.scope.kind !== "thread" || !("thread" in projection)) {
          return;
        }
        if (projection.sequence < lastAppliedSequence) {
          return;
        }
        lastAppliedSequence = projection.sequence;
        const projectedThread = projection.thread;
        if (!projectedThread) {
          clearThreadUi(threadId);
          removeTerminalState(threadId);
          return;
        }
        unstable_batchedUpdates(() => {
          syncServerThreadDetailHotPath(projectedThread, {
            connectionUrl: localConnectionUrl,
            hydrateThreadId: threadId,
          });
          reconcileSnapshotDerivedState();
        });
      },
    );

    return () => {
      unsubscribeProjection();
    };
  }, [
    clearThreadUi,
    reconcileSnapshotDerivedState,
    removeTerminalState,
    routeThreadId,
    syncServerThreadDetailHotPath,
  ]);
}

function EventRouter() {
  useProjectionStreamRouterLifecycle();
  return null;
}

function DesktopProjectBootstrap() {
  // Desktop hydration runs through EventRouter project + orchestration sync.
  return null;
}
