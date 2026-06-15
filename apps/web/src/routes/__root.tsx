import { OrchestrationEvent, ThreadId, type OrchestrationShellStreamItem } from "@ace/contracts";
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
import {
  clearPromotedDraftThread,
  clearPromotedDraftThreads,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { terminalRunningSubprocessFromEvent } from "../terminalActivity";
import { useSetting } from "../hooks/useSettings";
import { UiTypographyBridge } from "../components/UiTypographyBridge";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { projectQueryKeys } from "../lib/projectReactQuery";
import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";
import { deriveOrchestrationBatchEffects } from "../orchestrationEventEffects";
import { coalesceOrchestrationUiEvents } from "../orchestrationUiEvents";
import { resetWsRpcClient } from "../wsRpcClient";
import { getRouteRpcClient, subscribeToRemoteRelayConnectionState } from "../lib/remoteWsRouter";
import { parseHostConnectionQrPayload, resolveLocalDeviceWsUrl } from "../lib/remoteHosts";
import { queueDesktopPairingLink } from "../lib/desktopPairingLinks";
import { parseRelayConnectionUrl } from "@ace/shared/relay";
import { shouldForwardDesktopNotificationOrchestrationEvent } from "@ace/shared/notifications";
import {
  dispatchDetachedWindowReturnRequest,
  resolveDetachedWindowReturnThreadId,
} from "../lib/detachedWindowReturn";
import { DesktopCliInstallToastBridge } from "./-DesktopCliInstallToastBridge";
import { DetachedBrowserWindow } from "./-DetachedBrowserWindow";
import { DetachedEditorWindow } from "./-DetachedEditorWindow";
import { RootRouteErrorView } from "./-RootRouteErrorView";

const BACKGROUND_DOMAIN_EVENT_FLUSH_DELAY_MS = 100;
const PENDING_SCOPED_EVENT_BUFFER_LIMIT = 1_024;
const PENDING_THREAD_EVENT_BUFFER_LIMIT = 512;
const APPLIED_EVENT_SEQUENCE_CACHE_LIMIT = 4_096;

function appendBoundedEvent(
  events: OrchestrationEvent[],
  event: OrchestrationEvent,
  limit: number,
) {
  events.push(event);
  if (events.length > limit) {
    events.splice(0, events.length - limit);
  }
}

function addBoundedSequence(sequences: Set<number>, sequence: number) {
  sequences.add(sequence);
  while (sequences.size > APPLIED_EVENT_SEQUENCE_CACHE_LIMIT) {
    const oldestSequence = sequences.values().next().value;
    if (typeof oldestSequence !== "number") {
      return;
    }
    sequences.delete(oldestSequence);
  }
}

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

function useScopedEventRouterLifecycle() {
  const applyOrchestrationEvents = useStore((store) => store.applyOrchestrationEvents);
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const applyShellEvent = useStore((store) => store.applyShellEvent);
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
  const appliedEventSequencesRef = useRef<Set<number>>(new Set());
  const appliedShellEventSequencesRef = useRef<Set<number>>(new Set());
  const threadLatestSequenceByIdRef = useRef<Map<ThreadId, number>>(new Map());
  const shellSnapshotSequenceRef = useRef(0);

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

  const applyScopedEvents = useCallback(
    (events: ReadonlyArray<OrchestrationEvent>) => {
      const dedupedEvents: OrchestrationEvent[] = [];
      for (const event of events) {
        if (appliedEventSequencesRef.current.has(event.sequence)) {
          continue;
        }
        addBoundedSequence(appliedEventSequencesRef.current, event.sequence);
        dedupedEvents.push(event);
      }
      if (dedupedEvents.length === 0) {
        return;
      }

      const batchEffects = deriveOrchestrationBatchEffects(dedupedEvents);
      const uiEvents = coalesceOrchestrationUiEvents(dedupedEvents);
      unstable_batchedUpdates(() => {
        applyOrchestrationEvents(uiEvents);
        if (
          dedupedEvents.some(
            (event) =>
              event.type === "project.created" ||
              event.type === "project.meta-updated" ||
              event.type === "project.deleted",
          )
        ) {
          const projects = useStore.getState().projects;
          syncProjects(projects.map((project) => ({ id: project.id, cwd: project.cwd })));
        }
        if (
          dedupedEvents.some(
            (event) => event.type === "thread.created" || event.type === "thread.deleted",
          )
        ) {
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
      });

      if (batchEffects.needsProviderInvalidation) {
        void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
      }
    },
    [
      applyOrchestrationEvents,
      clearThreadUi,
      queryClient,
      removeTerminalState,
      syncProjects,
      syncThreads,
    ],
  );

  useEffect(() => {
    const localConnectionUrl = resolveLocalDeviceWsUrl();
    const localRpcClient = getRouteRpcClient(localConnectionUrl);
    let disposed = false;
    let shellBootstrapped = false;
    let pendingShellEvents: Array<Exclude<OrchestrationShellStreamItem, { kind: "snapshot" }>> = [];
    let flushHandle: number | null = null;

    const flushPendingShellEvents = () => {
      flushHandle = null;
      if (disposed || pendingShellEvents.length === 0) {
        return;
      }
      const events = pendingShellEvents;
      pendingShellEvents = [];
      try {
        unstable_batchedUpdates(() => {
          for (const event of events) {
            if (appliedShellEventSequencesRef.current.has(event.sequence)) {
              continue;
            }
            addBoundedSequence(appliedShellEventSequencesRef.current, event.sequence);
            applyShellEvent(event);
          }
          reconcileSnapshotDerivedState();
        });
      } catch (error) {
        reportBackgroundError("Failed to apply scoped orchestration shell events.", error);
      }
    };

    const scheduleFlush = () => {
      if (flushHandle !== null) {
        return;
      }
      flushHandle = window.setTimeout(
        flushPendingShellEvents,
        BACKGROUND_DOMAIN_EVENT_FLUSH_DELAY_MS,
      );
    };

    const applyShellSnapshot = (
      snapshot: Awaited<ReturnType<typeof localRpcClient.orchestration.getShellSnapshot>>,
    ) => {
      shellSnapshotSequenceRef.current = snapshot.snapshotSequence;
      syncServerShellSnapshot(snapshot);
      reconcileSnapshotDerivedState();
      appliedShellEventSequencesRef.current.clear();
      const firstCachedSequence = Math.max(
        0,
        snapshot.snapshotSequence - APPLIED_EVENT_SEQUENCE_CACHE_LIMIT + 1,
      );
      for (
        let sequence = firstCachedSequence;
        sequence <= snapshot.snapshotSequence;
        sequence += 1
      ) {
        addBoundedSequence(appliedShellEventSequencesRef.current, sequence);
      }
    };

    const unsubscribeConnectionState = localRpcClient.subscribeConnectionState((state) => {
      logLoadDiagnostic({
        phase: "ws",
        level: state.kind === "disconnected" ? "warning" : "success",
        message: `Connection state changed: ${state.kind}`,
        detail: state.error,
      });
      applyTransportConnectionHealthState(state);
      if (state.kind === "disconnected") {
        pendingShellEvents = [];
        if (flushHandle !== null) {
          window.clearTimeout(flushHandle);
          flushHandle = null;
        }
      }
    });

    const unsubscribeShell = localRpcClient.orchestration.subscribeShell((item) => {
      if (disposed) {
        return;
      }
      if (item.kind === "snapshot") {
        applyShellSnapshot(item.snapshot);
        shellBootstrapped = true;
        scheduleFlush();
        return;
      }
      pendingShellEvents.push(item);
      if (pendingShellEvents.length > PENDING_SCOPED_EVENT_BUFFER_LIMIT) {
        pendingShellEvents.splice(0, pendingShellEvents.length - PENDING_SCOPED_EVENT_BUFFER_LIMIT);
      }
      if (shellBootstrapped) {
        scheduleFlush();
      }
    });

    const unsubscribeNotifications = localRpcClient.orchestration.onDomainEvent((event) => {
      if (
        typeof window === "undefined" ||
        !window.desktopBridge?.sendOrchestrationEvent ||
        !shouldForwardDesktopNotificationOrchestrationEvent(event)
      ) {
        return;
      }
      try {
        window.desktopBridge.sendOrchestrationEvent(event);
      } catch (error) {
        reportBackgroundError("Failed to forward orchestration event to desktop bridge.", error);
      }
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

    void localRpcClient.orchestration
      .getShellSnapshot()
      .then((snapshot) => {
        if (!disposed) {
          applyShellSnapshot(snapshot);
        }
      })
      .catch((error) => {
        reportBackgroundError("Failed to load orchestration shell snapshot.", error);
      });

    return () => {
      disposed = true;
      if (flushHandle !== null) {
        window.clearTimeout(flushHandle);
      }
      pendingShellEvents = [];
      unsubscribeConnectionState();
      unsubscribeShell();
      unsubscribeNotifications();
      unsubscribeTerminal();
      void localRpcClient.orchestration.unsubscribeShell().catch(() => undefined);
    };
  }, [applyShellEvent, reconcileSnapshotDerivedState, syncServerShellSnapshot]);

  useEffect(() => {
    const threadId = routeThreadId;
    if (!threadId) {
      return;
    }
    const localConnectionUrl = resolveLocalDeviceWsUrl();
    const localRpcClient = getRouteRpcClient(localConnectionUrl);
    let threadBootstrapped = false;
    let pendingThreadEvents: OrchestrationEvent[] = [];
    let replayInFlight = false;
    let bootstrapReplayInFlight = false;
    const applyThreadEvents = (events: ReadonlyArray<OrchestrationEvent>) => {
      const latestSequence = threadLatestSequenceByIdRef.current.get(threadId) ?? -1;
      const nextEvents = events
        .filter(
          (event) =>
            event.aggregateKind === "thread" &&
            event.aggregateId === threadId &&
            event.sequence > latestSequence,
        )
        .toSorted((left, right) => left.sequence - right.sequence);
      if (nextEvents.length === 0) {
        return;
      }
      threadLatestSequenceByIdRef.current.set(
        threadId,
        nextEvents.at(-1)?.sequence ?? latestSequence,
      );
      applyScopedEvents(nextEvents);
    };
    const replayThreadEvents = async () => {
      if (replayInFlight || !threadBootstrapped) {
        return;
      }
      const fromSequenceExclusive = threadLatestSequenceByIdRef.current.get(threadId);
      if (fromSequenceExclusive === undefined) {
        return;
      }
      replayInFlight = true;
      try {
        const replayedEvents = await localRpcClient.orchestration.replayEvents({
          fromSequenceExclusive,
        });
        applyThreadEvents(replayedEvents);
      } catch (error) {
        reportBackgroundError("Failed to replay scoped thread events.", error);
      } finally {
        replayInFlight = false;
      }
    };
    const recoverThreadBootstrapFromReplay = async () => {
      if (bootstrapReplayInFlight || threadBootstrapped || pendingThreadEvents.length === 0) {
        return;
      }
      const firstPendingSequence = pendingThreadEvents[0]?.sequence;
      if (firstPendingSequence === undefined) {
        return;
      }
      bootstrapReplayInFlight = true;
      try {
        const replayedEvents = await localRpcClient.orchestration.replayEvents({
          fromSequenceExclusive: Math.min(
            shellSnapshotSequenceRef.current,
            Math.max(0, firstPendingSequence - PENDING_THREAD_EVENT_BUFFER_LIMIT),
          ),
        });
        const events = [...replayedEvents, ...pendingThreadEvents];
        pendingThreadEvents = [];
        if (
          events.some((event) => event.type === "thread.created" && event.aggregateId === threadId)
        ) {
          threadBootstrapped = true;
          applyThreadEvents(events);
        } else {
          pendingThreadEvents = events
            .filter((event) => event.aggregateKind === "thread" && event.aggregateId === threadId)
            .slice(-PENDING_THREAD_EVENT_BUFFER_LIMIT);
        }
      } catch (error) {
        reportBackgroundError("Failed to recover scoped thread bootstrap events.", error);
      } finally {
        bootstrapReplayInFlight = false;
      }
    };
    const shouldCatchUpThread = () => {
      const thread = useStore.getState().threadsById?.[threadId];
      return (
        thread?.session?.status === "running" ||
        thread?.session?.status === "connecting" ||
        thread?.latestTurn?.state === "running"
      );
    };
    const catchupInterval = window.setInterval(() => {
      if (shouldCatchUpThread()) {
        void replayThreadEvents();
      }
    }, 1_500);
    const unsubscribeThread = localRpcClient.orchestration.subscribeThread({ threadId }, (item) => {
      if (item.kind === "snapshot") {
        syncServerThreadDetailHotPath(item.snapshot.thread, {
          connectionUrl: localConnectionUrl,
          hydrateThreadId: threadId,
        });
        threadBootstrapped = true;
        if (pendingThreadEvents.length > 0) {
          const events = pendingThreadEvents;
          pendingThreadEvents = [];
          applyThreadEvents(events);
        }
        const latestAppliedSequence = threadLatestSequenceByIdRef.current.get(threadId);
        if (
          latestAppliedSequence === undefined ||
          latestAppliedSequence < item.snapshot.snapshotSequence
        ) {
          threadLatestSequenceByIdRef.current.set(threadId, item.snapshot.snapshotSequence);
        }
        return;
      }
      if (!threadBootstrapped) {
        appendBoundedEvent(pendingThreadEvents, item.event, PENDING_THREAD_EVENT_BUFFER_LIMIT);
        if (item.event.type === "thread.created" && item.event.payload.threadId === threadId) {
          const events = pendingThreadEvents;
          pendingThreadEvents = [];
          threadBootstrapped = true;
          applyThreadEvents(events);
        } else {
          void recoverThreadBootstrapFromReplay();
        }
        return;
      }
      try {
        applyThreadEvents([item.event]);
      } catch (error) {
        reportBackgroundError("Failed to apply scoped thread event.", error);
      }
    });
    return () => {
      window.clearInterval(catchupInterval);
      pendingThreadEvents = [];
      unsubscribeThread();
      void localRpcClient.orchestration.unsubscribeThread({ threadId }).catch(() => undefined);
    };
  }, [applyScopedEvents, routeThreadId, syncServerThreadDetailHotPath]);
}

function EventRouter() {
  useScopedEventRouterLifecycle();
  return null;
}

function DesktopProjectBootstrap() {
  // Desktop hydration runs through EventRouter project + orchestration sync.
  return null;
}
