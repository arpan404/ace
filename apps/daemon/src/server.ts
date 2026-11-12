import { shutdownDeadline, trackStage } from "./shutdown.ts";
import { relayPairing, relayRoute } from "./relay-route.ts";
import { isHostedRelay } from "./relay-account.ts";
import type { PairingConnection } from "./pairing-issue.ts";
import { startTransports, startLocalTransports } from "./services/transports.ts";
import { createSocketRegistry } from "./services/registry.ts";
import { decodeDeviceFrame, parseSocketMessage } from "./services/socket-message.ts";
import type { SocketMessage } from "./services/socket.ts";
import { createDaemonPreview, type DaemonPreview } from "./preview.ts";
import { MaintenanceGate } from "@ace/service";
import { AppUpdateBoard } from "./app-update-board.ts";
import { createMachineUpdates } from "./machine-update/create.ts";
import { UpdateHold } from "./update-hold.ts";
import { systemDeliveryRuntime } from "./delivery-runtime.ts";
import { generateSecret, systemCredentials } from "./credential-runtime.ts";
import { z } from "zod";
import { defaultTicketLimits } from "./ticket-pool.ts";
import type { IncomingMessage, Server } from "node:http";
import { createServer as httpsServer } from "node:https";
import { httpChains } from "./server-http.ts";
import { hostedWebOrigin, webOriginAllowlist } from "./web-origins.ts";
import { PreAuthAdmission } from "./socket-admission.ts";
import { activeDevice, allows, type SessionActor } from "./devices.ts";
import { RemoteAuth } from "./remote-auth.ts";
import { urlHost } from "./network.ts";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  HostId,
  DeviceId,
  DeviceRevokedClose,
  type ServerMessage,
  type Notification,
} from "@ace/protocol";
import type { PluginServerMessage } from "@ace/protocol/plugins";
import { busyRefusal } from "./busy-refusal.ts";
import { defaultPressure, Outbox } from "./outbox.ts";
import { orderedSocket } from "./ordered-socket.ts";
import { WireTrimmer } from "@ace/projection/wire-trim";
import { SocketInput } from "./socket-input.ts";
import { CommandLanes } from "./command-lanes.ts";
import { readCore } from "./socket-reads.ts";
import { admitUpgrades } from "./socket-upgrade.ts";
import { createSocketCloser } from "./server-socket-close.ts";
import { enrollNotifications, helloActor } from "./socket-hello.ts";
import { accountDeviceActor, accountHello } from "./relay-hello.ts";
import { accountGrantSocket, type AccountGrantSocket } from "./account-access/grant-socket.ts";
import {
  ACCESS_CHANGED_CLOSE,
  ACCESS_CHANGED_REASON,
  GRANT_EXPIRED_CLOSE,
  GRANT_EXPIRED_REASON,
} from "./account-access/grant-lease.ts";
import { admitCommand } from "./socket-commands.ts";
import { isPing, closeRecord, clientAgent, type ClosePeer } from "./socket-liveness.ts";
import { WireEncoder } from "./wire-encoder.ts";
import { bindListener as bind, closeListener } from "./listener.ts";
import { remoteRuntime } from "./remote-runtime.ts";
import { RelaySocket, type RelayedMain } from "./relay-socket.ts";
import type { MainSocket } from "./main-socket.ts";
export type { ServerOptions } from "./server-options.ts";
import type { ServerOptions } from "./server-options.ts";
import { computerName } from "./computer-name.ts";
import { unreachable, type ReachFacts } from "./external-mcp/reach.ts";
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
  /** Shutdown stages that started and have not finished. */
  pendingShutdown(): string[];
  outsideReach(): ReachFacts;
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
      id: () => runtime.id(),
    },
    z
      .object({
        global: z.number().int().positive(),
        perDevice: z.number().int().positive(),
        perMinute: z.number().int().positive(),
      })
      .parse({ ...defaultTicketLimits, ...options.ticketLimits }),
    options.store.pairingCodes,
  );
  let remoteOrigin: string | undefined;
  const pairing = (): PairingConnection | undefined =>
    options.remote && remoteOrigin
      ? { origin: remoteOrigin, fingerprint: options.remote.identity.fingerprint }
      : dynamicRemote
        ? dynamicRemote.pairing()
        : // A relay from launch options (`ACE_RELAY_URL`) is self-hosted unless it is ace's.
          options.relay && !isHostedRelay(options.relay.url, options.remoteConfig?.hostedRelayUrl)
          ? relayPairing(options.relay)
          : undefined;
  let dynamicRemote: ReturnType<typeof remoteRuntime> | undefined;
  let preview: DaemonPreview | undefined;
  const maintenance =
    options.maintenanceGate ??
    new MaintenanceGate(
      () => options.store.updateBlockers(),
      () => options.store.waitingBlockers(),
    );
  let ready = options.ready === undefined;
  void options.ready?.then(() => {
    ready = true;
  });
  const updateHold = new UpdateHold(maintenance, runtime);
  // A daemon started in the middle of an update holds until recovery releases it.
  if (options.maintenance || maintenance.held("update")) updateHold.persist();
  const appUpdate = options.appUpdate ?? new AppUpdateBoard(runtime);
  const machineUpdates = options.machineUpdate
    ? await createMachineUpdates({
        config: options.machineUpdate,
        version: options.version ?? "development",
        board: appUpdate,
        store: options.store,
        busy: () => maintenance.status().blockers,
        runtime,
        log: (error) => options.log?.(error),
      })
    : undefined;
  const access = {
    auth,
    pairing,
    remoteStatus: () => ({
      ...(dynamicRemote?.status() ?? {
        enabled: remoteOrigin !== undefined || options.relay !== undefined,
        transport: options.relay
          ? ("relay" as const)
          : remoteOrigin
            ? ("lan" as const)
            : ("local" as const),
        listenOverride: null,
        relayOverride: false,
        ...relayRoute(options.relay, options.hostId),
      }),
      ...(options.machineAccount ? { account: options.machineAccount.status() } : {}),
    }),
    account: () => options.machineAccount,
    allowedOrigins: webOriginAllowlist(options.webOrigins),
    // A failed settings read falls back to this computer's own link rather than failing pairing.
    // Both pairing paths call this before they read the address, so a Tailscale certificate
    // that failed is fetched again first: the link then names the ts.net host if it can.
    pairingApp: async () => {
      await dynamicRemote?.beforePairing();
      return (await options.settings?.get("remote.hostedPairingLink").catch(() => undefined))
        ?.value === true
        ? hostedWebOrigin
        : undefined;
    },
    ...(options.pairingAddress ? { sourceAddress: options.pairingAddress } : {}),
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.eventLoop ? { eventLoop: options.eventLoop } : {}),
    ...(options.serviceStatus ? { serviceStatus: options.serviceStatus } : {}),
    ...(options.engine
      ? { providerProcesses: () => options.engine?.providerProcesses() ?? [] }
      : {}),
    ready: () => ready,
    appUpdate,
    updateHold,
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
      servesRenderer: options.webRoot !== undefined,
      preAuth,
      full: () => cleanups.size >= 256,
      remoteSockets,
    });
  attach(local, true);
  if (remote) attach(remote, false);
  const authenticated = new Map<MainSocket, SessionActor>();
  /** One owner for every deliberate close frame; state lives here, not in a module global. */
  const closer = createSocketCloser(runtime.delay);
  const stopRevocation = auth.onRevoke((id) => {
    // Preview sessions name the credential that opened them, so the authority decides.
    void preview?.revalidate();
    void options.notifications
      ?.revoke?.(DeviceId.parse(id))
      .catch(() => options.log?.(new Error("Notification revocation failed")));
    for (const [socket, device] of authenticated)
      if (device.revocable && device.id === id) {
        cleanups.get(socket)?.();
        closer.gracefulClose(
          socket,
          DeviceRevokedClose.shape.code.value,
          DeviceRevokedClose.shape.reason.value,
        );
      }
  });
  // The same install paired again: sockets its old credential opened end without wiping
  // anything (4001, not 4003), and the client connects again with the credential it holds now.
  // Its account sockets are not the pairing's and stay.
  const stopReplaced = auth.onCredentialReplaced((id) => {
    // Its preview links, sessions and open streams were the old credential's (ADR 0115).
    void preview?.revalidate();
    for (const [socket, device] of authenticated)
      if (
        device.revocable &&
        device.id === id &&
        !options.store.devices.current(id, device.generation, auth.now())
      ) {
        cleanups.get(socket)?.();
        closer.gracefulClose(socket, 4001, "Credential replaced");
      }
  });
  // Account devices on any path keep access only while the machine stays on their account and
  // they hold the current machine code; an account change closes every path at once (ADR 0114).
  // Not as a revocation: the client reconnects and its next hello gets the refusal that fits.
  const accountSockets = new Map<MainSocket, () => boolean>();
  const stopAccountChange = options.machineAccount?.onChange(() => {
    for (const [socket, admitted] of accountSockets)
      if (!admitted()) {
        cleanups.get(socket)?.();
        closer.gracefulClose(socket, ACCESS_CHANGED_CLOSE, ACCESS_CHANGED_REASON);
      }
  });
  const createServiceSessions = createSocketRegistry();
  const serviceTasks = new Set<Promise<void>>();
  const serviceSessions = new Map<MainSocket, ReturnType<typeof createServiceSessions>>();
  const input = new SocketInput();
  const lanes = new CommandLanes();
  const cleanups = new Map<MainSocket, () => void>();
  let closing: Promise<void> | undefined;
  let disconnects = Promise.resolve();
  const receivers = new Map<DeviceId, Map<MainSocket, (message: ServerMessage) => void>>();
  // A suspended phone can keep its socket open, so a frame sent there is not a delivery.
  const backgrounded = new WeakSet<MainSocket>();
  const encoder = new WireEncoder();
  const ticks = new Map<MainSocket, () => void>();
  /** Main channels that came through the relay: no listener owns them, so shutdown closes them. */
  const relaySockets = new Set<MainSocket>();
  const connected = (
    socket: MainSocket,
    isLocal: boolean,
    request?: IncomingMessage,
    /** A relayed main channel, whose hello the relay host already authenticated. */
    relayed?: RelayedMain,
  ) => {
    const peer: ClosePeer = {
      client: clientAgent(request?.headers["user-agent"]),
      remote: !isLocal,
    };
    socket.on("error", (error) => {
      options.log?.(error);
      // A protocol error (an oversized frame is 1009) already started a close with its code;
      // give that frame a moment to reach the peer so it can tell why, then drop the socket.
      closer.boundClosingSocket(socket);
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
      runtime.delay,
    );
    // What this client's hello said it can put back stays out of its snapshots and pages.
    let trimmer = new WireTrimmer(undefined);
    const send = (message: ServerMessage | PluginServerMessage) => {
      for (const frame of trimmer.outgoing(busyRefusal(message))) outbox.send(frame);
    };
    const fail = (
      code: string,
      message: string,
      close = false,
      scope: { requestId?: string; subscriptionId?: string } = {},
    ) => {
      send({ type: "error", code, message, ...scope });
      if (close) socket.close(4001, code);
    };
    // An account device holds admin only while the machine stays on its account (ADR 0111),
    // whichever path its hello came by.
    let accountAdmitted = relayed?.stillAdmitted;
    let accountId = relayed?.account;
    // An account device's main socket stays open only while it holds an unexpired grant.
    let grant: AccountGrantSocket | undefined;
    const holdGrant = (expiresAt: number | undefined, deviceId: DeviceId) => {
      if (expiresAt === undefined || accountId === undefined) return;
      grant = accountGrantSocket({
        expiresAt,
        account: accountId,
        deviceId,
        machine: options.machineAccount,
        now: () => auth.now(),
      });
    };
    const stillAdmitted = () => accountAdmitted?.() !== false;
    // A paired device's authority is its credential's: once that credential is replaced or
    // revoked, nothing it opened authorizes anything (ADR 0115).
    const holds = (actor: SessionActor | undefined, scope: import("@ace/protocol").DeviceScope) => {
      const current = actor?.revocable
        ? options.store.devices.current(actor.id, actor.generation, auth.now())
        : actor;
      return activeDevice(current, auth.now()) && allows(current, scope);
    };
    const authorize = (scope: import("@ace/protocol").DeviceScope) =>
      stillAdmitted() && holds(authenticated.get(socket), scope);
    const sessions = createServiceSessions({
      options,
      // Every service write goes after what the outbox holds (`ordered-socket.ts`).
      socket: orderedSocket(socket, () => outbox.releaseHeld()),
      sessionId,
      local: isLocal,
      // The host's own credential only: an account device is never the host, on any path.
      canSubmitSecret: () =>
        isLocal && accountAdmitted === undefined && authenticated.get(socket)?.revocable === false,
      onPresence: (update) => {
        if (update.appState === "background") backgrounded.add(socket);
        else backgrounded.delete(socket);
        hasPresence = true;
      },
      subscriptions,
      tasks: serviceTasks,
      maintenance,
      appUpdate,
      ...(machineUpdates ? { machineUpdates } : {}),
      device: () => device,
      credentialGeneration: () => {
        const actor = authenticated.get(socket);
        return actor?.revocable ? actor.generation : undefined;
      },
      authorize,
      authorityLease: (scope) => {
        const actor = authenticated.get(socket);
        return () => stillAdmitted() && holds(actor, scope);
      },
      canReadThread: (thread) =>
        device !== undefined && options.canReadThread?.(device, thread) !== false,
      hostCredential: () =>
        relayed === undefined &&
        accountAdmitted === undefined &&
        authenticated.get(socket)?.revocable === false,
      accountDevice: () => accountId,
      access: {
        auth,
        pairing,
        pairingApp: access.pairingApp,
        remoteStatus: access.remoteStatus,
      },
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
      accountSockets.delete(socket);
    };
    cleanups.set(socket, cleanup);
    ticks.set(socket, () => {
      if (grant?.expired()) {
        cleanups.get(socket)?.();
        closer.gracefulClose(socket, GRANT_EXPIRED_CLOSE, GRANT_EXPIRED_REASON);
        return;
      }
      if (auth.now() - lastActivity > (options.idleTimeoutMs ?? 60_000))
        socket.close(4008, "Idle timeout");
      outbox.tick();
    });
    const opened = auth.now();
    socket.on("close", (code: number, reason: Buffer) => {
      cleanup();
      // The daemon's own shutdown closes every socket; that is not a client failure.
      const record = closing
        ? undefined
        : closeRecord(code, reason, auth.now() - opened, device !== undefined, peer);
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
        const frameValue: unknown = JSON.parse(data.toString());
        if (device) {
          const frame = decodeDeviceFrame(frameValue);
          if (frame.kind === "unsupported") {
            fail(
              "unsupported",
              "Request type is not supported by this daemon",
              false,
              frame.requestId ? { requestId: frame.requestId } : {},
            );
            return;
          }
          if (frame.kind === "invalid") {
            fail(
              "invalid_message",
              "Message does not match the protocol",
              false,
              frame.requestId ? { requestId: frame.requestId } : {},
            );
            return;
          }
          message = frame.message;
        } else message = parseSocketMessage(frameValue);
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
        let actor: SessionActor | undefined;
        if (relayed) actor = relayed.actor;
        else if (message.grant !== undefined) {
          // A signed-in device is admin on every path, even one also paired (ADR 0114).
          const admitted = await accountHello(message, message.grant, options.machineAccount);
          if (socket.readyState !== WebSocket.OPEN || !cleanups.has(socket)) return;
          if (!admitted.device) {
            if (admitted.refusal) send(admitted.refusal);
            // A machine code refusal closes as the relay route reports it, so the client asks.
            const code = admitted.refusal?.code ?? "unauthorized";
            socket.close(code.startsWith("machine_code") ? 4011 : 4001, code);
            return;
          }
          auth.accountDeviceSeen(message.deviceId, message.link);
          actor = accountDeviceActor(message.deviceId, auth.now());
          accountAdmitted = admitted.stillAdmitted;
          accountId = admitted.account;
          // Dedicated channels end with their main connection's access; the main socket refreshes.
          if (message.channel === undefined) holdGrant(admitted.grantExpiresAt, message.deviceId);
        } else actor = helloActor(message, auth, isLocal);
        if (!actor) {
          fail("unauthorized", "Valid hello required", true);
          return;
        }
        if (accountAdmitted) accountSockets.set(socket, accountAdmitted);
        if (relayed) holdGrant(relayed.grantExpiresAt, actor.id);
        device = actor.id;
        trimmer = new WireTrimmer(message.trims);
        // Only the main socket streams deltas, so only it packs frames (`frame-holder.ts`).
        if (message.channel === undefined && message.framing?.includes("lines"))
          outbox.packFrames();
        peer.access =
          relayed || accountAdmitted
            ? "paired"
            : !actor.revocable
              ? "host"
              : actor.scopes.includes("desktop") || actor.scopes.includes("user-browser")
                ? "desktop"
                : "paired";
        if (message.channel !== undefined) peer.channel = message.channel;
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
          for (const service of sessions) await service.authenticated?.(message.channel);
        } catch (error) {
          const limit = error instanceof Error && "code" in error && error.code === "limit";
          const code = limit ? "connection_limit" : "service_unavailable";
          socket.close(limit ? 4013 : 1011, code);
          return;
        }
        if (socket.readyState !== WebSocket.OPEN || !cleanups.has(socket)) return;
        welcomed = true;
        send({
          type: "welcome",
          hostId,
          protocolVersion: 1,
          headSeq: options.store.headSeq(),
          databaseId: options.store.sidebarToken(),
          ...(grant ? { grantTtlMs: grant.ttlMs() } : {}),
        });
        for (const service of sessions) service.welcomed?.();
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
        case "account.grant.refresh": {
          const { requestId } = message;
          const result = grant
            ? await grant.refresh(message.grant)
            : ({
                ok: false,
                code: "unsupported",
                message: "No account grant to refresh.",
              } as const);
          if (socket.readyState === WebSocket.OPEN && cleanups.has(socket))
            send({ type: "account.grant.refresh.result", requestId, result });
          return;
        }
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
  // The relay host hands its authenticated main channels here (`files-relay.ts`).
  options.relayMain = (entry) => {
    const socket = new RelaySocket(entry.channel, {
      deflate: entry.deflate,
      delay: runtime.delay,
    });
    relaySockets.add(socket);
    socket.once("close", () => relaySockets.delete(socket));
    connected(socket, false, undefined, entry);
    socket.start(entry.hello);
  };
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
          // A full shutdown already sent 1001 with a bounded terminate above; a
          // settings-only retire still drops remote sockets at once.
          if (closing) {
            for (const socket of remoteSockets)
              closer.gracefulClose(socket, 1001, "Daemon shutdown");
          } else {
            for (const socket of remoteSockets) socket.terminate();
          }
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
    appUpdate.close();
    machineUpdates?.close();
    updateHold.close();
    stopRevocation();
    stopReplaced();
    stopAccountChange?.();
    await closeListener(local);
    if (remote) await closeListener(remote);
    await closeServers();
    throw error;
  }
  const closingStages = new Set<string>();
  const stage = <T>(name: string, task: Promise<T> | undefined) =>
    trackStage(closingStages, name, task);
  return {
    pendingShutdown: () => [...closingStages],
    ...(preview ? { preview } : {}),
    get relayHostId() {
      return dynamicRemote?.relayHostId ?? transports?.relayHostId;
    },
    /** Tailscale and ace's relay as outside MCP clients reach them (ADR 0122). */
    outsideReach: () => dynamicRemote?.outsideReach() ?? unreachable,
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
      return pairing()?.origin?.replace("https:", "wss:");
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
        stopReplaced();
        stopAccountChange?.();
        machineUpdates?.close();
        for (const cleanup of cleanups.values()) cleanup();
        for (const socket of relaySockets) closer.gracefulClose(socket, 1001, "Daemon shutdown");
        for (const server of servers)
          for (const socket of server.clients) {
            closer.gracefulClose(socket, 1001, "Daemon shutdown");
          }
        void Promise.all([
          stage("local listener", closeListener(local)),
          ...(remote ? [stage("remote listener", closeListener(remote))] : []),
          stage("preview", preview?.close()),
          stage("transports", transports?.close()),
          stage("dynamic remote", dynamicRemote?.close()),
        ]).then(() => {
          // An upgrade can finish while listeners close; ws waits for every client to go.
          // Sockets already closing keep their code and bounded terminate; late
          // upgrades get the shutdown close with the same bound.
          for (const server of servers)
            for (const socket of server.clients)
              closer.gracefulClose(socket, 1001, "Daemon shutdown");
          return stage("socket servers", closeServers()).then((error) => {
            void shutdownDeadline(
              "Socket tasks",
              stage(
                "socket tasks",
                Promise.all([Promise.allSettled(serviceTasks), lanes.settled(), disconnects]),
              ),
              runtime.delay,
              5_000,
            ).then(() => {
              if (error) reject(error);
              else resolve();
            }, reject);
          });
        }, reject);
      });
      return closing;
    },
  };
}
