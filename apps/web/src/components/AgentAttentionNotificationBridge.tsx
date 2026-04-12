import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { APP_DISPLAY_NAME } from "../branding";
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
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { useSettings } from "../hooks/useSettings";
import { toastManager } from "./ui/toast";

function closeNotification(notification: Notification | undefined): void {
  notification?.close();
}

function describeNotificationError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function AgentAttentionNotificationBridge() {
  const threads = useStore((store) => store.threads);
  const navigate = useNavigate();
  const notificationSettings = useSettings((settings) => ({
    notifyOnAgentCompletion: settings.notifyOnAgentCompletion,
    notifyOnApprovalRequired: settings.notifyOnApprovalRequired,
    notifyOnUserInputRequired: settings.notifyOnUserInputRequired,
  }));
  const attentionRequests = useMemo(
    () =>
      filterAgentAttentionRequestsBySettings(
        deriveAgentAttentionRequests(threads),
        notificationSettings,
      ),
    [notificationSettings, threads],
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
      desktopNotificationBridge ? "granted" : readAgentAttentionNotificationPermission(),
    );
  const activeBrowserNotificationsRef = useRef(new Map<string, Notification>());
  const activeDesktopNotificationIdsRef = useRef(new Set<string>());
  const failedDesktopNotificationRequestKeysRef = useRef(new Set<string>());
  const notifiedRequestKeysRef = useRef(new Set<string>());
  const attentionRequestByKeyRef = useRef(attentionRequestByKey);
  const hasPromptedForPermissionRef = useRef(false);
  const notificationSessionStartedAtRef = useRef(new Date().toISOString());

  useEffect(() => {
    attentionRequestByKeyRef.current = attentionRequestByKey;
  }, [attentionRequestByKey]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    const syncWindowState = () => {
      setIsAppFocused(isAppWindowFocused(document));
      setNotificationPermission(
        desktopNotificationBridge ? "granted" : readAgentAttentionNotificationPermission(),
      );
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

      void navigate({
        to: "/$threadId",
        params: { threadId: request.threadId },
      });
    });
  }, [desktopNotificationBridge, navigate]);

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
        void navigate({
          to: "/$threadId",
          params: { threadId: request.threadId },
        });
        return;
      }

      const reply = resolveAgentAttentionNotificationReply(request, event.response);
      if (!reply) {
        window.focus();
        void navigate({
          to: "/$threadId",
          params: { threadId: request.threadId },
        });
        return;
      }

      const api = readNativeApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Unable to submit notification reply",
          description: "The orchestration API is unavailable in the current app session.",
        });
        return;
      }

      void api.orchestration
        .dispatchCommand({
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
  }, [desktopNotificationBridge, navigate]);

  useEffect(() => {
    if (!desktopNotificationBridge) {
      return;
    }

    for (const request of collectAgentAttentionRequestsToNotify({
      requests: attentionRequests,
      notifiedRequestKeys: notifiedRequestKeysRef.current,
      isAppFocused,
      notificationSessionStartedAt: notificationSessionStartedAtRef.current,
    })) {
      const notificationInput = buildAgentAttentionDesktopNotificationInput(request);
      void desktopNotificationBridge
        .showNotification(notificationInput)
        .then((shown) => {
          if (!shown) {
            if (!failedDesktopNotificationRequestKeysRef.current.has(request.key)) {
              failedDesktopNotificationRequestKeysRef.current.add(request.key);
              toastManager.add({
                type: "error",
                title: "Unable to send agent notification",
                description: "Desktop notifications are unavailable in the current app session.",
              });
            }
            return;
          }

          failedDesktopNotificationRequestKeysRef.current.delete(request.key);
          notifiedRequestKeysRef.current.add(request.key);
          activeDesktopNotificationIdsRef.current.add(request.key);
        })
        .catch((error) => {
          if (!failedDesktopNotificationRequestKeysRef.current.has(request.key)) {
            failedDesktopNotificationRequestKeysRef.current.add(request.key);
            toastManager.add({
              type: "error",
              title: "Unable to send agent notification",
              description: describeNotificationError(
                error,
                "Unknown error creating a desktop notification.",
              ),
            });
          }
        });
    }
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
          void navigate({
            to: "/$threadId",
            params: { threadId: request.threadId },
          });
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
    navigate,
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
                description: "Browser notifications remain disabled for this session.",
              });
            })
            .catch((error) => {
              toastManager.add({
                type: "error",
                title: "Unable to enable notifications",
                description: describeNotificationError(
                  error,
                  "Unknown error requesting browser notification permission.",
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
