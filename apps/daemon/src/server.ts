import { shutdownDeadline } from "./shutdown.ts";
import { startTransports, startLocalTransports } from "./services/transports.ts";
import { createSocketRegistry, parseSocketMessage } from "./services/registry.ts";
import type { SocketMessage } from "./services/socket.ts";
import { createDaemonPreview, type DaemonPreview } from "./preview.ts";
import { MaintenanceGate } from "@ace/service";
import { systemDeliveryRuntime } from "./delivery-runtime.ts";
import { generateSecret, systemCredentials } from "./credential-runtime.ts";
import { z } from "zod";
import { defaultTicketLimits } from "./ticket-pool.ts";
import type { Server } from "node:http";
import { createServer as httpsServer } from "node:https";
import { httpChains } from "./server-http.ts";
import { webOriginAllowlist } from "./web-origins.ts";
import { PreAuthAdmission } from "./socket-admission.ts";
import { allows, type Device } from "./devices.ts";
import { RemoteAuth } from "./remote-auth.ts";
import { urlHost } from "./network.ts";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { HostId, DeviceId, type ServerMessage, type Notification } from "@ace/protocol";
import type { PluginServerMessage } from "@ace/protocol/plugins";
import { defaultPressure, Outbox } from "./outbox.ts";
import { SocketInput } from "./socket-input.ts";
import { CommandLanes } from "./command-lanes.ts";
import { readCore } from "./socket-reads.ts";
import { admitUpgrades } from "./socket-upgrade.ts";
import { enrollNotifications, helloActor } from "./socket-hello.ts";
import { admitCommand } from "./socket-commands.ts";
import { isPing, closeRecord } from "./socket-liveness.ts";
import { WireEncoder } from "./wire-encoder.ts";
import { bindListener as bind, closeListener } from "./listener.ts";
import { remoteRuntime } from "./remote-runtime.ts";
export type { ServerOptions } from "./server-options.ts";
import type { ServerOptions } from "./server-options.ts";
import { computerName } from "./computer-name.ts";
import { remoteDeflate } from "./compression-policy.ts";
export async function startServer(options: ServerOptions): Promise<{
  relayHostId?: string | undefined;
  maintenance: MaintenanceGate;
  url: string;
  notify(device: DeviceId, notification: Notification): boolean;
  notificationDevices(): readonly DeviceId[];
  preview?: DaemonPreview;
  httpUrl: string;
  diagnosticsQueues(): { socketInput: number; healthRequests: number };
  remoteUrl?: string | undefined;
  fingerprint?: string | undefined;
  close(): Promise<void>;
}> {
  options.hostName ??= await computerName();
  const runtime = {
    ...systemDeliveryRuntime,
    ...options.runtime,
    now: options.now ?? options.runtime?.now ?? systemDeliveryRuntime.now,
  };
  const hostId = HostId.parse(options.hostId);
  if (!/^[0-9a-f]{64}$/.test(options.token)) throw new Error("Invalid server token");
  const auth = new RemoteAuth(
    options.store.devices,
    options.token,
    {
      now: runtime.now,
      secret: () => generateSecret(options.entropy ?? systemCredentials.randomBytes),
    },
    z
      .object({
        global: z.number().int().positive(),
        perDevice: z.number().int().positive(),
        perMinute: z.number().int().positive(),
      })
      .parse({ ...defaultTicketLimits, ...options.ticketLimits }),
  );
  let remoteOrigin: string | undefined;
  const pairing = () =>
    options.remote && remoteOrigin
      ? { origin: remoteOrigin, fingerprint: options.remote.identity.fingerprint }
      : dynamicRemote?.pairing();
  let dynamicRemote: ReturnType<typeof remoteRuntime> | undefined;
  let preview: DaemonPreview | undefined;
  const maintenance = new MaintenanceGate(() => options.store.updateBlockers());
  let ready = options.ready === undefined;
  void options.ready?.then(() => {
    ready = true;
  });
  if (options.maintenance) maintenance.enter();
  const access = {
    auth,
    pairing,
    remoteStatus: () =>
      dynamicRemote?.status() ?? {
        enabled: remoteOrigin !== undefined || options.relay !== undefined,
        transport: options.relay ? "relay" : remoteOrigin ? "lan" : "local",
        listenOverride: null,
        relayOverride: false,
      },
    allowedOrigins: webOriginAllowlist(options.webOrigins),
    ...(options.pairingAddress ? { sourceAddress: options.pairingAddress } : {}),
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.eventLoop ? { eventLoop: options.eventLoop } : {}),
    ...(options.serviceStatus ? { serviceStatus: options.serviceStatus } : {}),
    ...(options.engine
      ? { providerProcesses: () => options.engine?.providerProcesses() ?? [] }
      : {}),
    ready: () => ready,
  };
  const { local, remoteHttp } = httpChains(options, auth, access, maintenance, () => preview);
  const remote = options.remote
    ? httpsServer({ ...options.remote.identity, minVersion: "TLSv1.2" }, remoteHttp())
    : undefined;
  for (const listener of [local, remote])
    if (listener) {
      listener.requestTimeout = 0;
      listener.headersTimeout = 10_000;
    }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  // Remote peers (LAN, Tailscale) get per-message deflate, each message alone; loopback doesn't.
  const remoteWss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: remoteDeflate,
  });
  const servers = [wss, remoteWss];
  /** Both socket servers closed; the first error either reported. */
  const closeServers = async () =>
    (
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<Error | undefined>((resolve) => server.close((error) => resolve(error))),
        ),
      )
    ).find((error) => error !== undefined);
  const remoteSockets = new Set<WebSocket>();
  const preAuth = new PreAuthAdmission(options.preAuth ?? {}, runtime.delay);
  const attach = (listener: Server, isLocal: boolean) =>
    admitUpgrades(listener, isLocal, {
      wss: isLocal ? wss : remoteWss,
      allowedOrigins: access.allowedOrigins,
      preAuth,
      full: () => cleanups.size >= 256,
      remoteSockets,
    });
  attach(local, true);
  if (remote) attach(remote, false);
  const authenticated = new Map<WebSocket, Device & { revocable: boolean }>();
  const stopRevocation = auth.onRevoke((id) => {
    preview?.revokeDevice(id);
    void options.notifications
      ?.revoke?.(DeviceId.parse(id))
      .catch(() => options.log?.(new Error("Notification revocation failed")));
    for (const [socket, device] of authenticated)
      if (device.revocable && device.id === id) {
        cleanups.get(socket)?.();
        socket.close(4003, "Device revoked");
        socket.terminate();
      }
  });
  const createServiceSessions = createSocketRegistry();
  const serviceTasks = new Set<Promise<void>>();
  const serviceSessions = new Map<WebSocket, ReturnType<typeof createServiceSessions>>();
  const input = new SocketInput();
  const lanes = new CommandLanes();
  const cleanups = new Map<WebSocket, () => void>();
  let disconnects = Promise.resolve();
  const receivers = new Map<DeviceId, Map<WebSocket, (message: ServerMessage) => void>>();
  // A suspended phone can keep its socket open, so a frame sent there is not a delivery.
  const backgrounded = new WeakSet<WebSocket>();
  const encoder = new WireEncoder();
  const ticks = new Map<WebSocket, () => void>();
  const connected = (socket: WebSocket, isLocal: boolean) => {
    socket.on("error", (error) => {
      options.log?.(error);
      // A protocol error (an oversized frame is 1009) already started a close with its code;
      // give that frame a moment to reach the peer so it can tell why, then drop the socket.
      if (socket.readyState === WebSocket.CLOSING) {
        const stop = runtime.delay(() => socket.terminate(), 1000);
        socket.once("close", stop);
      } else socket.terminate();
    });
    if (cleanups.size >= 256) {
      socket.terminate();
      return;
    }
    const sessionId = z.string().min(1).max(200).parse(runtime.id());
    let device: DeviceId | undefined;
    let hasPresence = false;
    let stopEnrollment: (() => void) | undefined;
    let cleaned = false;
    let welcomed = false;
    const flights = { count: 0 };
    let lastActivity = auth.now();
    socket.on("message", () => {
      lastActivity = auth.now();
    });
    const subscriptions = new Map<string, () => void>();
    const outbox = new Outbox(
      socket,
      { ...defaultPressure, ...options.pressure },
      runtime.now,
      encoder,
    );
    const send = (message: ServerMessage | PluginServerMessage) => outbox.send(message);
    const fail = (
      code: string,
      message: string,
      close = false,
      scope: { requestId?: string; subscriptionId?: string } = {},
    ) => {
      send({ type: "error", code, message, ...scope });
      if (close) socket.close(4001, code);
    };
    const authorize = (scope: import("@ace/protocol").DeviceScope) => {
      const actor = authenticated.get(socket);
      const current = actor?.revocable ? options.store.devices.get(actor.id) : actor;
      return current?.revokedAt === null && allows(current, scope);
    };
    const sessions = createServiceSessions({
      options,
      socket,
      sessionId,
      local: isLocal,
      canSubmitSecret: () => isLocal && authenticated.get(socket)?.revocable === false,
      onPresence: (update) => {
        if (update.appState === "background") backgrounded.add(socket);
        else backgrounded.delete(socket);
        hasPresence = true;
      },
      subscriptions,
      tasks: serviceTasks,
      maintenance,
      device: () => device,
      authorize,
      authorityLease: (scope) => {
        const actor = authenticated.get(socket);
        return () => {
          const current = actor?.revocable ? options.store.devices.get(actor.id) : actor;
          return current?.revokedAt === null && allows(current, scope);
        };
      },
      canReadThread: (thread) =>
        device !== undefined && options.canReadThread?.(device, thread) !== false,
      hostCredential: () => authenticated.get(socket)?.revocable === false,
      connected: () => socket.readyState === WebSocket.OPEN && authenticated.has(socket),
      send,
      fail,
    });
    serviceSessions.set(socket, sessions);
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      stopEnrollment?.();
      for (const service of sessions) service.close?.();
      serviceSessions.delete(socket);
      for (const stop of subscriptions.values()) stop();
      subscriptions.clear();
      outbox.clear();
      if (device) {
        const connections = receivers.get(device);
        connections?.delete(socket);
        if (!connections?.size) receivers.delete(device);
      }
      if (hasPresence) {
        // Retain this socket's admission slot until removal is acknowledged. Active
        // sockets plus queued removals therefore remain bounded at 256 under churn.
        disconnects = disconnects
          .then(() => options.notifications?.disconnect(sessionId))
          .catch((error: unknown) => {
            options.log?.(error);
          })
          .finally(() => cleanups.delete(socket));
      } else cleanups.delete(socket);
      ticks.delete(socket);
      authenticated.delete(socket);
    };
    cleanups.set(socket, cleanup);
    ticks.set(socket, () => {
      if (auth.now() - lastActivity > (options.idleTimeoutMs ?? 60_000))
        socket.close(4008, "Idle timeout");
      outbox.tick();
    });
    const opened = auth.now();
    socket.on("close", (code: number, reason: Buffer) => {
      cleanup();
      const record = closeRecord(code, reason, auth.now() - opened, device !== undefined);
      if (record) options.warn?.("WebSocket closed", record);
      options.onDisconnect?.(device);
    });
    const receive = async (data: RawData, binary: boolean) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      lastActivity = auth.now();
      let message: SocketMessage;
      try {
        if (binary) {
          const frame = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data);
          if (!device || !sessions.some((service) => service.binary?.(frame)))
            throw new Error("No binary channel");
          return;
        }
        message = parseSocketMessage(JSON.parse(data.toString()));
      } catch {
        fail(
          device ? "invalid_message" : "unauthorized",
          "Message does not match the protocol",
          !device,
        );
        return;
      }
      if (!device) {
        if (message.type !== "hello") {
          fail("unauthorized", "Valid hello required", true);
          return;
        }
        const actor = helloActor(message, auth, isLocal);
        if (!actor) {
          fail("unauthorized", "Valid hello required", true);
          return;
        }
        device = actor.id;
        preAuth.authenticated(socket);
        authenticated.set(socket, actor);
        try {
          // HTTP discovery is available while listener features initialize. A
          // welcome promises the socket can use the published service registry.
          if (message.channel === undefined && !ready) send({ type: "starting" });
          await options.ready;
          const notifications = options.notifications;
          if (authorize("read") && notifications)
            enrollNotifications(actor.id, {
              connect: (id) => notifications.connectDevice(id),
              active: () => !cleaned && authorize("read"),
              delay: runtime.delay,
              log: (error) => options.log?.(error),
              tasks: serviceTasks,
              scheduled: (stop) => {
                stopEnrollment = stop;
              },
            });
        } catch {
          fail("device_unavailable", "Device unavailable", true);
          return;
        }
        // Authentication may finish after disconnect, revocation or daemon shutdown.
        if (socket.readyState !== WebSocket.OPEN || !cleanups.has(socket)) return;
        // A dedicated channel (devices, files, browser, screen) speaks only its own frames, so
        // notifications and broadcasts go to the device's main sockets.
        if (message.channel === undefined && authorize("read")) {
          let connections = receivers.get(device);
          if (!connections) {
            connections = new Map();
            receivers.set(device, connections);
          }
          connections.set(socket, send);
        }
        try {
          for (const service of sessions) service.authenticated?.(message.channel);
        } catch (error) {
          const limit = error instanceof Error && "code" in error && error.code === "limit";
          const code = limit ? "connection_limit" : "service_unavailable";
          socket.close(limit ? 4013 : 1011, code);
          return;
        }
        welcomed = true;
        send({
          type: "welcome",
          hostId,
          protocolVersion: 1,
          headSeq: options.store.headSeq(),
        });
        return;
      }
      for (const service of sessions) if (await service.handle?.(message, device)) return;
      const actor = device;
      switch (message.type) {
        case "hello":
          fail("unauthorized", "Hello is only valid once", true);
          return;
        case "ping":
          send({ type: "pong" });
          return;
        case "command":
          await admitCommand(message.command, {
            options,
            device: actor,
            routes: sessions.flatMap((service) => (service.command ? [service.command] : [])),
            maintenance,
            lanes,
            flights,
            open: () => socket.readyState === WebSocket.OPEN && authenticated.has(socket),
            authorize,
            send,
            delay: runtime.delay,
          });
          return;
      }
      readCore(message, {
        options,
        device: actor,
        subscriptions,
        authorize,
        send,
        fail,
        delay: runtime.delay,
        encoder,
        lanes,
      });
    };
    input.listen(
      socket,
      receive,
      (error) => options.log?.(error),
      (data, binary) => {
        // Pong right away once welcomed: it changes no state and must not wait on handlers.
        if (!welcomed || binary || socket.readyState !== WebSocket.OPEN || !isPing(data))
          return false;
        lastActivity = auth.now();
        send({ type: "pong" });
        return true;
      },
    );
  };
  for (const server of servers) server.on("connection", connected);
  const stopTimer = runtime.every(
    () => {
      for (const tick of ticks.values()) {
        try {
          tick();
        } catch (error) {
          try {
            options.log?.(error);
          } catch {
            /* Keep peers and the next timer pass alive. */
          }
        }
      }
    },
    Math.max(10, Math.min(1000, (options.idleTimeoutMs ?? 60_000) / 2)),
  );
  let port: number;
  let transports: Awaited<ReturnType<typeof startTransports>> | undefined;
  try {
    port = await bind(local, "127.0.0.1", options.port);
    if (remote && options.remote) {
      const remotePort = await bind(remote, options.remote.host, options.remote.port);
      remoteOrigin = `https://${urlHost(options.remote.advertisedHost)}:${remotePort}`;
    }
    transports = options.remoteConfig
      ? await startLocalTransports(options)
      : await startTransports(options, auth);
    if (options.remoteConfig) {
      dynamicRemote = remoteRuntime(
        options,
        auth,
        remoteHttp(),
        (listener) => attach(listener, false),
        () => {
          for (const socket of remoteSockets) socket.terminate();
        },
      );
      options.applyRemoteSetting = dynamicRemote.set;
      await dynamicRemote.start();
    }
    if (options.preview)
      preview = await createDaemonPreview(options.store, options.preview, auth.now);
  } catch (error) {
    stopTimer();
    await dynamicRemote?.close();
    await transports?.close();
    await preview?.close();
    stopRevocation();
    await closeListener(local);
    if (remote) await closeListener(remote);
    await closeServers();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    ...(preview ? { preview } : {}),
    get relayHostId() {
      return dynamicRemote?.relayHostId ?? transports?.relayHostId;
    },
    maintenance,
    url: `ws://127.0.0.1:${port}`,
    httpUrl: `http://127.0.0.1:${port}`,
    diagnosticsQueues: () => ({
      socketInput: input.depth(),
      healthRequests: [...serviceSessions.values()].reduce(
        (count, sessions) =>
          count + sessions.reduce((sum, service) => sum + (service.healthPending?.() ?? 0), 0),
        0,
      ),
    }),
    get remoteUrl() {
      return pairing()?.origin.replace("https:", "wss:");
    },
    get fingerprint() {
      return pairing()?.fingerprint;
    },
    notificationDevices: () => [...receivers.keys()],
    notify(device, notification) {
      let delivered = false;
      for (const [socket, send] of receivers.get(device) ?? []) {
        if (socket.readyState === WebSocket.OPEN && !backgrounded.has(socket)) {
          send({ type: "notification", notification });
          delivered = true;
        }
      }
      return delivered;
    },
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        stopTimer();
        stopRevocation();
        for (const cleanup of cleanups.values()) cleanup();
        for (const server of servers)
          for (const socket of server.clients) {
            socket.close(1001, "Daemon shutdown");
            socket.terminate();
          }
        void Promise.all([
          closeListener(local),
          ...(remote ? [closeListener(remote)] : []),
          preview?.close(),
          transports?.close(),
          dynamicRemote?.close(),
        ]).then(
          () =>
            closeServers().then((error) => {
              void shutdownDeadline(
                "Socket tasks",
                Promise.all([Promise.allSettled(serviceTasks), lanes.settled(), disconnects]),
                runtime.delay,
                5_000,
              ).then(() => {
                if (error) reject(error);
                else resolve();
              }, reject);
            }),
          reject,
        );
      });
      return closing;
    },
  };
}
