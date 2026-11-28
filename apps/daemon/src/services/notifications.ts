import { join } from "node:path";
import { logError } from "@ace/diagnostics";
import type { NotificationTransport, PushGatewayTransport } from "@ace/notify";
import { repeatableWarmup } from "./warmup.ts";
import { loadNotificationChannels, pushTarget } from "../notification-config.ts";
import { followRemotePushSetting } from "../notification-live-activity.ts";
import { createDaemonNotifications } from "../notifications.ts";
import type { ServiceContext } from "./types.ts";

/** The push transport's Live Activity operations, when it is ace's gateway (ADR 0223). */
function activityGateway(
  push: NotificationTransport | undefined,
): PushGatewayTransport | undefined {
  if (typeof (push as Partial<PushGatewayTransport> | undefined)?.registerActivity !== "function")
    return undefined;
  return push as PushGatewayTransport;
}
export async function startNotifications(context: ServiceContext): Promise<void> {
  const { config, options, store, resources, services, log, onListen } = context;

  const configured = options.notificationChannels
    ? { channels: options.notificationChannels, close: () => {} }
    : await loadNotificationChannels({ dataDir: config.dataDir, settings: services.settings });
  resources.own(configured.close);
  const gateway = activityGateway(configured.channels.push);
  const settings = services.settings;
  // An organization's host never stores or registers a personal phone's activity tokens: its
  // counts would be the host's whole inbox (ADR 0221). The socket already refuses members.
  const liveActivityAllowed = () => context.orgHost?.org() === undefined;
  // Nothing saved needs delivery while no client is connected: the worker starts when one does.
  const retained = notificationsRetained(join(config.dataDir, "notifications.sqlite"));
  const notifications = createDaemonNotifications(
    config.dataDir,
    store,
    (error) => log.log("error", "Notification service failure", logError(error)),
    configured.channels,
    5000,
    {
      signal: context.signal,
      slept: !retained,
      ...(options.notificationWorker ? { spawn: options.notificationWorker } : {}),
      ...(gateway
        ? {
            liveActivity: {
              gateway,
              target: () => pushTarget(settings),
              allowed: liveActivityAllowed,
            },
          }
        : {}),
    },
  );
  resources.onShutdown(notifications.stop);
  resources.own(() => notifications.close());
  if (gateway) {
    // Push settings are read live and followed, so turning push off removes the tokens without
    // waiting for the phone to sync again.
    if (settings) {
      try {
        const stopSetting = await followRemotePushSetting(
          settings,
          (enabled) => notifications.service.liveActivitySetting(enabled),
          (error) => log.log("error", "Live Activity settings follow failed", logError(error)),
        );
        resources.own(stopSetting);
      } catch (error) {
        // The alert service must still come up; activity registration waits for a retry.
        log.log("warn", `Live Activity settings are unavailable: ${String(error)}`);
      }
    }
    // An organization's host keeps no personal phone's activity tokens: their counts would be
    // the host's whole inbox, and a member's phone may register none at all (ADR 0221).
    const clearForOrg = () => {
      if (context.orgHost?.org() === undefined) return;
      void notifications.service
        .clearLiveActivity()
        .catch((error: unknown) => log.log("error", "Live Activity clear failed", logError(error)));
    };
    clearForOrg();
    const stopOrg = context.orgHost?.onChange?.(clearForOrg);
    if (stopOrg) resources.own(stopOrg);
  }
  // A cursor reply proves the worker has opened its store, even when the log is empty.
  if (retained) await notifications.open();
  services.notifications = notifications.service;
  if ("publicKey" in configured && typeof configured.publicKey === "string")
    services.notificationPublicKey = configured.publicKey;
  // Sign-in requests reach admin phones through the same gateway and the same device table.
  const access = "access" in configured ? configured.access : undefined;
  if (access)
    services.accessPush = {
      addresses: (devices) => notifications.service.pushAddresses(devices),
      send: (device, alert, signal) => access.sendAccess(device, alert, signal),
    };
  onListen.push(async (server) => {
    notifications.setSender(server.notify);
    notifications.setConnected(server.notificationDevices);
    // Clients can connect through the endpoint before feature startup completes.
    for (const device of server.notificationDevices())
      await notifications.service.connectDevice(device);
    // Repeatable: `ready()` wakes the worker again after a failure, and `activate()` does
    // nothing the second time, so a run after a failure resumes rather than starts twice.
    // The warmup logs its own failure and reports the status.
    void repeatableWarmup(context, "notifications", async () => {
      if (retained) await notifications.ready();
      notifications.activate();
    }).catch(() => {});
  });
}

import type { SocketContext, SocketService } from "./socket.ts";
import { notificationsRetained, linkedLimit } from "@ace/notify";
import { capLinked, emptyMemberFeed, memberFeed, visibleFeed } from "../notification-feed-view.ts";
export function createNotificationsSession({
  options,
  authorize,
  canReadThread,
  orgHost,
  memberStanding,
  sessionId,
  onPresence,
  fail,
  send,
}: SocketContext): SocketService {
  let warnedCut = false;
  return {
    async handle(message, device) {
      if (message.type === "notification.config") {
        if (!authorize("read")) {
          fail("forbidden", "Read scope required", false, { requestId: message.requestId });
          return true;
        }
        try {
          const preferences = (await options.notifications?.getPreferences?.(device)) ?? {
            quietHours: null,
            includePreview: false,
          };
          send({
            type: "notification.config.result",
            requestId: message.requestId,
            publicKey: options.notificationPublicKey ?? null,
            preferences,
          });
        } catch {
          fail("notification_rejected", "Could not read notification settings", false, {
            requestId: message.requestId,
          });
        }
        return true;
      }
      if (message.type === "notification.feed") {
        const correlation = { requestId: message.requestId };
        if (!authorize("read")) {
          fail("forbidden", "Read scope required", false, correlation);
          return true;
        }
        if (!options.notifications?.feed) {
          fail("notifications_unavailable", "Notifications unavailable", false, correlation);
          return true;
        }
        // A member has no inbox until pushes are filtered per member (ADR 0221): the same empty
        // answer to every read and receipt, never the host's global head.
        if (memberStanding?.()) {
          send({
            type: "notification.feed.result",
            requestId: message.requestId,
            ...emptyMemberFeed,
          });
          return true;
        }
        try {
          // One phone reached directly and over its account relay reads one feed: its saved
          // cursor covers both ids, so neither route's read can skip the other's alerts.
          const all = options.store.devices.linked(device, (options.now ?? Date.now)());
          const { ids: linked, cut } = capLinked(all, linkedLimit);
          // The stalest pairings are the ones dropped; say so once per socket.
          if (cut > 0 && !warnedCut) {
            warnedCut = true;
            options.log?.(
              new Error(`Notification feed linked ${cut} stalest device ids beyond ${linkedLimit}`),
            );
          }
          const feed = await options.notifications.feed(
            device,
            message.afterCursor,
            message.checkpoint,
            linked,
          );
          const visible = orgHost?.()
            ? memberFeed(feed, canReadThread)
            : visibleFeed(feed, canReadThread);
          send({ type: "notification.feed.result", requestId: message.requestId, ...visible });
        } catch {
          fail("notification_rejected", "Could not read missed notifications", false, correlation);
        }
        return true;
      }
      if (message.type === "notification.ack") {
        // A phone took the live alert frame: the router may skip its push. The ack names the
        // alert only; the device comes from this authenticated socket, so one phone's ack
        // never stands in for another's.
        if (!authorize("read")) {
          fail("forbidden", "Read scope required", false, {});
          return true;
        }
        options.notifications?.acknowledge?.(device, message.id);
        return true;
      }
      if (message.type === "notification.unregister") {
        const correlation = message.requestId ? { requestId: message.requestId } : {};
        if (!authorize("read")) {
          fail("forbidden", "Read scope required", false, correlation);
          return true;
        }
        if (!options.notifications?.unregister) {
          fail("notifications_unavailable", "Notifications unavailable", false, correlation);
          return true;
        }
        try {
          await options.notifications.unregister(device);
          if (message.requestId)
            send({ type: "notification.unregister.result", requestId: message.requestId });
        } catch {
          fail("notification_rejected", "Notification update rejected", false, correlation);
        }
        return true;
      }
      switch (message.type) {
        case "presence.update":
        case "notification.register":
        case "notification.preferences":
        case "notification.snooze": {
          const correlation =
            message.type === "notification.register" && message.requestId
              ? { requestId: message.requestId }
              : {};
          const scope = message.type === "notification.snooze" ? "operate" : "read";
          if (!authorize(scope)) {
            fail(
              "forbidden",
              `${scope === "read" ? "Read" : "Operate"} scope required`,
              false,
              correlation,
            );
            return true;
          }
          if (!options.notifications) {
            fail("notifications_unavailable", "Notifications unavailable", false, correlation);
            return true;
          }
          try {
            if (message.type === "presence.update") {
              onPresence(message);
              await options.notifications.updatePresence(sessionId, device, message);
            } else if (message.type === "notification.register") {
              await options.notifications.register(device, message.device);
              // Persisted before the phone hears success. One install's linked ids share the
              // tokens (ADR 0115), and an older daemon may not store them at all.
              if (options.notifications.syncLiveActivity) {
                const { ids: linked } = capLinked(
                  options.store.devices.linked(device, (options.now ?? Date.now)()),
                  linkedLimit,
                );
                await options.notifications.syncLiveActivity(device, linked, message.liveActivity);
              }
              if (message.requestId)
                send({ type: "notification.register.result", requestId: message.requestId });
            } else if (message.type === "notification.preferences")
              await options.notifications.preferences(device, message.preferences);
            else await options.notifications.snooze(message.threadId, message.until);
          } catch {
            fail("notification_rejected", "Notification update rejected", false, correlation);
          }
          return true;
        }
      }
      return false;
    },
  };
}
