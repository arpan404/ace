import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { OrchestrationEvent } from "@ace/contracts";

import { APP_DISPLAY_NAME } from "../branding";
import { LEAN_SNAPSHOT_RECOVERY_INPUT } from "../bootstrapRecovery";
import { useHostConnectionStore } from "../hostConnectionStore";
import { useStore } from "../store";
import {
  buildAgentAttentionDesktopNotificationInput,
  buildAgentAttentionNotificationCopy,
  collectAgentAttentionRequestsToNotify,
  deriveAgentAttentionRequests,
  filterAgentAttentionRequestsBySettings,
  getAgentAttentionDesktopNotificationBridge,
  getAgentAttentionNotificationConstructor,
  isAppWindowFocused,
  readAgentAttentionNotificationPermission,
  resolveAgentAttentionNotificationReply,
  requestAgentAttentionNotificationPermission,
  shouldOfferAgentAttentionNotificationPermission,
  type AgentAttentionNotificationPermission,
} from "../lib/agentAttentionNotifications";
import { resolveLocalConnectionUrl } from "../lib/connectionRouting";
import { buildSingleThreadRouteSearch } from "../lib/chatThreadBoardRouteSearch";
import {
  CONNECTED_REMOTE_HOST_IDS_CHANGED_EVENT,
  loadConnectedRemoteHostIds,
  loadRemoteHostInstances,
  normalizeWsUrl,
  REMOTE_HOSTS_CHANGED_EVENT,
  resolveHostConnectionWsUrl,
} from "../lib/remoteHosts";
import { getRouteRpcClient, routeOrchestrationGetSnapshotFromRemote } from "../lib/remoteWsRouter";
import { newCommandId } from "../lib/utils";
import { useSettings } from "../hooks/useSettings";
import { toastManager } from "./ui/toast";

function closeNotification(notification: Notification | undefined): void {
  notification?.close();
}

function describeNotificationError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

type ScopedAgentAttentionRequest = ReturnType<typeof deriveAgentAttentionRequests>[number] & {
  connectionUrl: string;
};

const REMOTE_NOTIFICATION_WARMUP_DELAY_MS = 1_500;
const REMOTE_ATTENTION_REFRESH_DEBOUNCE_MS = 450;
const REMOTE_ATTENTION_REFRESH_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.activity-appended",
  "thread.archived",
  "thread.created",
  "thread.deleted",
  "thread.meta-updated",
  "thread.session-set",
  "thread.unarchived",
]);

function shouldRefreshRemoteAttentionFromEvent(event: OrchestrationEvent): boolean {
  return REMOTE_ATTENTION_REFRESH_EVENT_TYPES.has(event.type);
}

export function AgentAttentionNotificationBridge() {
  const navigate = useNavigate();
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const localConnectionUrl = useMemo(() => resolveLocalConnectionUrl(), []);
  const [remoteConnectionsReady, setRemoteConnectionsReady] = useState(false);
  const notificationSettings = useSettings((settings) => ({
    notifyOnAgentCompletion: settings.notifyOnAgentCompletion,
    notifyOnApprovalRequired: settings.notifyOnApprovalRequired,
    notifyOnUserInputRequired: settings.notifyOnUserInputRequired,
  }));
  const [attentionRequestsByConnection, setAttentionRequestsByConnection] = useState<
    Record<string, ReadonlyArray<ScopedAgentAttentionRequest>>
  >({});
  const attentionRequests = useMemo(
    () =>
      filterAgentAttentionRequestsBySettings(
        Object.values(attentionRequestsByConnection).flat(),
        notificationSettings,
      ),
    [attentionRequestsByConnection, notificationSettings],
  );
  const attentionRequestByKey = useMemo(
    () => new Map(attentionRequests.map((request) => [request.key, request])),
    [attentionRequests],
  );
  const desktopNotificationBridge = useMemo(
    () =>
      typeof window === "undefined"
        ? null
        : getAgentAttentionDesktopNotificationBridge(window.desktopBridge),
    [],
  );
  const [isAppFocused, setIsAppFocused] = useState(() =>
    typeof document === "undefined" ? true : isAppWindowFocused(document),
  );
  const [notificationPermission, setNotificationPermission] =
    useState<AgentAttentionNotificationPermission>(() =>
      desktopNotificationBridge ? "default" : readAgentAttentionNotificationPermission(),
    );
  const activeBrowserNotificationsRef = useRef(new Map<string, Notification>());
  const activeDesktopNotificationIdsRef = useRef(new Set<string>());
  const failedDesktopNotificationRequestKeysRef = useRef(new Set<string>());
  const notifiedRequestKeysRef = useRef(new Set<string>());
  const attentionRequestByKeyRef = useRef(attentionRequestByKey);
  const hasPromptedForPermissionRef = useRef(false);
  const notificationSessionStartedAtRef = useRef(new Date().toISOString());
  const lastKnownFocusStateRef = useRef(isAppFocused);
  const connectionUnsubscribeByUrlRef = useRef(new Map<string, () => void>());
  const refreshTimerByConnectionUrlRef = useRef(new Map<string, number>());
  const refreshInFlightByConnectionUrlRef = useRef(new Map<string, Promise<void>>());
  const refreshQueuedByConnectionUrlRef = useRef(new Set<string>());

  const resolveTrackedConnectionUrls = useMemo(
    () => () => {
      const nextConnectionUrls = new Set<string>([localConnectionUrl]);
      if (!remoteConnectionsReady) {
        return nextConnectionUrls;
      }
      const connectedHostIds = new Set(loadConnectedRemoteHostIds());
      for (const host of loadRemoteHostInstances()) {
        if (!connectedHostIds.has(host.id)) {
          continue;
        }
        const connectionUrl = normalizeWsUrl(resolveHostConnectionWsUrl(host));
        nextConnectionUrls.add(connectionUrl);
      }
      return nextConnectionUrls;
    },
    [localConnectionUrl, remoteConnectionsReady],
  );

  useEffect(() => {
    if (!bootstrapComplete) {
      setRemoteConnectionsReady(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setRemoteConnectionsReady(true);
    }, REMOTE_NOTIFICATION_WARMUP_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [bootstrapComplete]);

  const refreshConnectionAttentionRequests = useMemo(
    () => async (connectionUrl: string) => {
      const normalizedConnectionUrl = normalizeWsUrl(connectionUrl);
      try {
        const snapshot = await routeOrchestrationGetSnapshotFromRemote(
          normalizedConnectionUrl,
          LEAN_SNAPSHOT_RECOVERY_INPUT,
        );
        useHostConnectionStore
          .getState()
          .upsertSnapshotOwnership(normalizedConnectionUrl, snapshot);
        const scopedRequests = deriveAgentAttentionRequests(snapshot.threads).map((request) =>
          Object.assign({}, request, {
            key: `${normalizedConnectionUrl}:${request.key}`,
            connectionUrl: normalizedConnectionUrl,
          }),
        );
        setAttentionRequestsByConnection((current) => {
          const previousRequests = current[normalizedConnectionUrl] ?? [];
          const nextRequests =
            previousRequests.length === scopedRequests.length &&
            previousRequests.every(
              (request, index) => scopedRequests[index]?.key === request.key,
            ) &&
            previousRequests.every(
              (request, index) =>
                scopedRequests[index]?.createdAt === request.createdAt &&
                scopedRequests[index]?.body === request.body,
            )
              ? previousRequests
              : scopedRequests;
          if (nextRequests === previousRequests) {
            return current;
          }
          return {
            ...current,
            [normalizedConnectionUrl]: nextRequests,
          };
        });
      } catch {
        // Keep the last known attention state for this connection during transient failures.
      }
    },
    [],
  );

  const queueConnectionAttentionRefresh = useMemo(
    () => (connectionUrl: string) => {
      const normalizedConnectionUrl = normalizeWsUrl(connectionUrl);
      const existingTimer = refreshTimerByConnectionUrlRef.current.get(normalizedConnectionUrl);
      if (existingTimer !== undefined) {
        return;
      }
      const timer = window.setTimeout(() => {
        refreshTimerByConnectionUrlRef.current.delete(normalizedConnectionUrl);
        const runRefresh = () => {
          const existingRequest =
            refreshInFlightByConnectionUrlRef.current.get(normalizedConnectionUrl);
          if (existingRequest) {
            refreshQueuedByConnectionUrlRef.current.add(normalizedConnectionUrl);
            return;
          }
          const refreshRequest = refreshConnectionAttentionRequests(normalizedConnectionUrl)
            .catch(() => undefined)
            .finally(() => {
              refreshInFlightByConnectionUrlRef.current.delete(normalizedConnectionUrl);
              if (refreshQueuedByConnectionUrlRef.current.delete(normalizedConnectionUrl)) {
                runRefresh();
              }
            });
          refreshInFlightByConnectionUrlRef.current.set(normalizedConnectionUrl, refreshRequest);
        };
        runRefresh();
      }, REMOTE_ATTENTION_REFRESH_DEBOUNCE_MS);
      refreshTimerByConnectionUrlRef.current.set(normalizedConnectionUrl, timer);
    },
    [refreshConnectionAttentionRequests],
  );

  useEffect(() => {
    let cancelled = false;
    const connectionUnsubscribeByUrl = connectionUnsubscribeByUrlRef.current;
    const refreshTimerByConnectionUrl = refreshTimerByConnectionUrlRef.current;
    const refreshInFlightByConnectionUrl = refreshInFlightByConnectionUrlRef.current;
    const refreshQueuedByConnectionUrl = refreshQueuedByConnectionUrlRef.current;
    const reconcileConnections = () => {
      if (cancelled) {
        return;
      }
      const nextConnectionUrls = resolveTrackedConnectionUrls();
      for (const [connectionUrl, unsubscribe] of connectionUnsubscribeByUrl) {
        if (nextConnectionUrls.has(connectionUrl)) {
          continue;
        }
        unsubscribe();
        connectionUnsubscribeByUrl.delete(connectionUrl);
        const timer = refreshTimerByConnectionUrl.get(connectionUrl);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          refreshTimerByConnectionUrl.delete(connectionUrl);
        }
        refreshQueuedByConnectionUrl.delete(connectionUrl);
        refreshInFlightByConnectionUrl.delete(connectionUrl);
        setAttentionRequestsByConnection((current) => {
          if (!Object.prototype.hasOwnProperty.call(current, connectionUrl)) {
            return current;
          }
          const next = { ...current };
          delete next[connectionUrl];
          return next;
        });
      }

      for (const connectionUrl of nextConnectionUrls) {
        if (connectionUnsubscribeByUrl.has(connectionUrl)) {
          continue;
        }
        const unsubscribe = getRouteRpcClient(connectionUrl).orchestration.onDomainEvent(
          (event) => {
            if (!shouldRefreshRemoteAttentionFromEvent(event)) {
              return;
            }
            queueConnectionAttentionRefresh(connectionUrl);
          },
        );
        connectionUnsubscribeByUrl.set(connectionUrl, unsubscribe);
        queueConnectionAttentionRefresh(connectionUrl);
      }
    };

    if (typeof window === "undefined") {
      return;
    }

    const handleHostConnectionsChanged = () => {
      reconcileConnections();
    };
    const handleStorage = () => {
      reconcileConnections();
    };
    reconcileConnections();
    window.addEventListener(REMOTE_HOSTS_CHANGED_EVENT, handleHostConnectionsChanged);
    window.addEventListener(CONNECTED_REMOTE_HOST_IDS_CHANGED_EVENT, handleHostConnectionsChanged);
    window.addEventListener("storage", handleStorage);
    return () => {
      cancelled = true;
      window.removeEventListener(REMOTE_HOSTS_CHANGED_EVENT, handleHostConnectionsChanged);
      window.removeEventListener(
        CONNECTED_REMOTE_HOST_IDS_CHANGED_EVENT,
        handleHostConnectionsChanged,
      );
      window.removeEventListener("storage", handleStorage);
      for (const [connectionUrl, unsubscribe] of connectionUnsubscribeByUrl) {
        unsubscribe();
        const timer = refreshTimerByConnectionUrl.get(connectionUrl);
        if (timer !== undefined) {
          window.clearTimeout(timer);
        }
      }
      connectionUnsubscribeByUrl.clear();
      refreshTimerByConnectionUrl.clear();
      refreshInFlightByConnectionUrl.clear();
      refreshQueuedByConnectionUrl.clear();
    };
  }, [queueConnectionAttentionRefresh, resolveTrackedConnectionUrls]);

  const navigateToRequestThread = useMemo(
    () => (threadId: string, connectionUrl: string) => {
      const normalizedConnectionUrl = normalizeWsUrl(connectionUrl);
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: buildSingleThreadRouteSearch({
          connectionUrl:
            normalizedConnectionUrl !== localConnectionUrl ? normalizedConnectionUrl : null,
        }),
      });
    },
    [localConnectionUrl, navigate],
  );

  useEffect(() => {
    attentionRequestByKeyRef.current = attentionRequestByKey;
  }, [attentionRequestByKey]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    const syncWindowState = () => {
      const nextIsFocused = isAppWindowFocused(document);
      if (lastKnownFocusStateRef.current && !nextIsFocused) {
        notificationSessionStartedAtRef.current = new Date().toISOString();
      }
      lastKnownFocusStateRef.current = nextIsFocused;
      setIsAppFocused(nextIsFocused);
      if (
        desktopNotificationBridge &&
        typeof window.desktopBridge?.getNotificationPermission === "function"
      ) {
        void window.desktopBridge
          .getNotificationPermission()
          .then((permission) => {
            setNotificationPermission(permission);
          })
          .catch(() => {
            setNotificationPermission("unsupported");
          });
        return;
      }
      setNotificationPermission(readAgentAttentionNotificationPermission());
    };

    syncWindowState();
    document.addEventListener("visibilitychange", syncWindowState);
    window.addEventListener("focus", syncWindowState);
    window.addEventListener("blur", syncWindowState);

    return () => {
      document.removeEventListener("visibilitychange", syncWindowState);
      window.removeEventListener("focus", syncWindowState);
      window.removeEventListener("blur", syncWindowState);
    };
  }, [desktopNotificationBridge]);

  useEffect(() => {
    const activeRequestKeys = new Set(attentionRequests.map((request) => request.key));

    for (const requestKey of notifiedRequestKeysRef.current) {
      if (!activeRequestKeys.has(requestKey)) {
        notifiedRequestKeysRef.current.delete(requestKey);
      }
    }
    for (const requestKey of failedDesktopNotificationRequestKeysRef.current) {
      if (!activeRequestKeys.has(requestKey)) {
        failedDesktopNotificationRequestKeysRef.current.delete(requestKey);
      }
    }

    for (const [requestKey, notification] of activeBrowserNotificationsRef.current) {
      if (activeRequestKeys.has(requestKey)) {
        continue;
      }

      closeNotification(notification);
      activeBrowserNotificationsRef.current.delete(requestKey);
    }
    if (!desktopNotificationBridge) {
      return;
    }

    for (const requestKey of activeDesktopNotificationIdsRef.current) {
      if (activeRequestKeys.has(requestKey)) {
        continue;
      }

      activeDesktopNotificationIdsRef.current.delete(requestKey);
      void desktopNotificationBridge.closeNotification(requestKey);
    }
  }, [attentionRequests, desktopNotificationBridge]);

  useEffect(() => {
    if (!isAppFocused) {
      return;
    }

    for (const notification of activeBrowserNotificationsRef.current.values()) {
      closeNotification(notification);
    }
    activeBrowserNotificationsRef.current.clear();

    if (!desktopNotificationBridge) {
      return;
    }

    for (const notificationId of activeDesktopNotificationIdsRef.current) {
      void desktopNotificationBridge.closeNotification(notificationId);
    }
    activeDesktopNotificationIdsRef.current.clear();
  }, [desktopNotificationBridge, isAppFocused]);

  useEffect(() => {
    if (!desktopNotificationBridge) {
      return;
    }

    return desktopNotificationBridge.onNotificationClick((event) => {
      activeDesktopNotificationIdsRef.current.delete(event.id);
      window.focus();

      const request = attentionRequestByKeyRef.current.get(event.id);
      if (!request) {
        return;
      }

      navigateToRequestThread(request.threadId, request.connectionUrl);
    });
  }, [desktopNotificationBridge, navigateToRequestThread]);

  useEffect(() => {
    if (!desktopNotificationBridge) {
      return;
    }

    return desktopNotificationBridge.onNotificationReply((event) => {
      activeDesktopNotificationIdsRef.current.delete(event.id);
      const request = attentionRequestByKeyRef.current.get(event.id);
      if (!request) {
        return;
      }
      if (request.kind !== "user-input") {
        window.focus();
        navigateToRequestThread(request.threadId, request.connectionUrl);
        return;
      }

      const reply = resolveAgentAttentionNotificationReply(request, event.response);
      if (!reply) {
        window.focus();
        navigateToRequestThread(request.threadId, request.connectionUrl);
        return;
      }

      void getRouteRpcClient(request.connectionUrl)
        .orchestration.dispatchCommand({
          type: "thread.user-input.respond",
          commandId: newCommandId(),
          threadId: request.threadId,
          requestId: request.requestId,
          answers: reply.answers,
          createdAt: new Date().toISOString(),
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Unable to submit notification reply",
            description: describeNotificationError(
              error,
              "Unknown error submitting notification reply.",
            ),
          });
        });
    });
  }, [desktopNotificationBridge, navigateToRequestThread]);

  useEffect(() => {
    if (!desktopNotificationBridge) {
      return;
    }

    let canceled = false;
    for (const request of collectAgentAttentionRequestsToNotify({
      requests: attentionRequests,
      notifiedRequestKeys: notifiedRequestKeysRef.current,
      isAppFocused,
      notificationSessionStartedAt: notificationSessionStartedAtRef.current,
    })) {
      void desktopNotificationBridge
        .showNotification(buildAgentAttentionDesktopNotificationInput(request))
        .then((shown) => {
          if (canceled) {
            return;
          }
          if (shown) {
            activeDesktopNotificationIdsRef.current.add(request.key);
            notifiedRequestKeysRef.current.add(request.key);
            failedDesktopNotificationRequestKeysRef.current.delete(request.key);
            return;
          }

          activeDesktopNotificationIdsRef.current.delete(request.key);
          if (failedDesktopNotificationRequestKeysRef.current.has(request.key)) {
            return;
          }
          failedDesktopNotificationRequestKeysRef.current.add(request.key);
          toastManager.add({
            type: "warning",
            title: "Unable to send desktop notification",
            description:
              "Desktop notifications may be blocked by operating system settings for this app.",
          });
        })
        .catch((error: unknown) => {
          if (canceled) {
            return;
          }
          if (failedDesktopNotificationRequestKeysRef.current.has(request.key)) {
            return;
          }
          failedDesktopNotificationRequestKeysRef.current.add(request.key);
          toastManager.add({
            type: "error",
            title: "Unable to send desktop notification",
            description: describeNotificationError(
              error,
              "Unknown error creating a desktop notification.",
            ),
          });
        });
    }

    return () => {
      canceled = true;
    };
  }, [attentionRequests, desktopNotificationBridge, isAppFocused]);

  useEffect(() => {
    if (desktopNotificationBridge) {
      return;
    }

    if (notificationPermission !== "granted") {
      return;
    }

    const notificationConstructor = getAgentAttentionNotificationConstructor();
    if (!notificationConstructor) {
      return;
    }

    for (const request of collectAgentAttentionRequestsToNotify({
      requests: attentionRequests,
      notifiedRequestKeys: notifiedRequestKeysRef.current,
      isAppFocused,
      notificationSessionStartedAt: notificationSessionStartedAtRef.current,
    })) {
      const { title, body, tag } = buildAgentAttentionNotificationCopy(request);
      const existingNotification = activeBrowserNotificationsRef.current.get(request.key);
      if (existingNotification) {
        closeNotification(existingNotification);
        activeBrowserNotificationsRef.current.delete(request.key);
      }

      try {
        const notification = new notificationConstructor(title, {
          body,
          tag,
          requireInteraction: true,
        });

        const handleClick = () => {
          window.focus();
          notification.close();
          activeBrowserNotificationsRef.current.delete(request.key);
          navigateToRequestThread(request.threadId, request.connectionUrl);
        };

        const handleClose = () => {
          if (activeBrowserNotificationsRef.current.get(request.key) === notification) {
            activeBrowserNotificationsRef.current.delete(request.key);
          }
        };

        notification.addEventListener("click", handleClick);
        notification.addEventListener("close", handleClose);
        activeBrowserNotificationsRef.current.set(request.key, notification);
        notifiedRequestKeysRef.current.add(request.key);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Unable to send agent notification",
          description: describeNotificationError(
            error,
            "Unknown error creating a browser notification.",
          ),
        });
        break;
      }
    }
  }, [
    attentionRequests,
    desktopNotificationBridge,
    isAppFocused,
    navigateToRequestThread,
    notificationPermission,
  ]);

  useEffect(() => {
    if (desktopNotificationBridge) {
      return;
    }

    if (
      !shouldOfferAgentAttentionNotificationPermission({
        permission: notificationPermission,
        hasPendingRequests: attentionRequests.length > 0,
        isAppFocused,
        hasPromptedForPermission: hasPromptedForPermissionRef.current,
      })
    ) {
      return;
    }

    hasPromptedForPermissionRef.current = true;
    toastManager.add({
      type: "info",
      title: "Enable agent notifications",
      description: `${APP_DISPLAY_NAME} can alert you when agent work finishes or needs input while this window is in the background.`,
      actionProps: {
        children: "Enable notifications",
        onClick: () => {
          void requestAgentAttentionNotificationPermission()
            .then((nextPermission) => {
              setNotificationPermission(nextPermission);
              if (nextPermission === "granted") {
                toastManager.add({
                  type: "success",
                  title: "Notifications enabled",
                  description: `${APP_DISPLAY_NAME} will now alert you when agent work finishes or needs input in the background.`,
                });
                return;
              }

              toastManager.add({
                type: "warning",
                title: "Notifications not enabled",
                description: "Notifications remain disabled for this session.",
              });
            })
            .catch((error) => {
              toastManager.add({
                type: "error",
                title: "Unable to enable notifications",
                description: describeNotificationError(
                  error,
                  "Unknown error requesting notification permission.",
                ),
              });
            });
        },
      },
    });
  }, [attentionRequests.length, desktopNotificationBridge, isAppFocused, notificationPermission]);

  useEffect(() => {
    const activeBrowserNotifications = activeBrowserNotificationsRef.current;
    const activeDesktopNotificationIds = activeDesktopNotificationIdsRef.current;
    return () => {
      for (const notification of activeBrowserNotifications.values()) {
        closeNotification(notification);
      }
      activeBrowserNotifications.clear();

      if (desktopNotificationBridge) {
        for (const notificationId of activeDesktopNotificationIds) {
          void desktopNotificationBridge.closeNotification(notificationId);
        }
      }
      activeDesktopNotificationIds.clear();
    };
  }, [desktopNotificationBridge]);

  return null;
}
