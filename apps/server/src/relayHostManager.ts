import { type ServerRelayStatus, type RelayRegistrationSnapshot } from "@ace/contracts";
import {
  DEFAULT_RELAY_MAX_FRAME_BYTES,
  RELAY_REKEY_AFTER_ACTIVE_MS,
  RELAY_REKEY_AFTER_BYTES,
  buildRelayFrameAssociatedData,
  createRelayEphemeralKeyPair,
  createRelayHandshakeNonce,
  decryptRelayFrame,
  deriveNextRelayEpochKey,
  deriveRelayRouteKeys,
  encryptRelayFrame,
  resolveConfiguredRelayWebSocketUrl,
} from "@ace/shared/relay";
import { resolveWebSocketAuthConnection } from "@ace/shared/wsAuth";
import { Effect, Layer, PubSub, ServiceMap, Stream } from "effect";
import { approveRelayPairingRequest, persistPairingSessionsToDatabase } from "./pairing";
import { ServerConfig } from "./config";
import { PairingSessionRepository } from "./persistence/Services/PairingSessions";
import { getRelayDeviceIdentity } from "./relayIdentity";
import { ServerSettingsService } from "./serverSettings";

interface RelayWebSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { readonly code?: number; readonly reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface RelayWebSocketConstructor {
  new (url: string, protocols?: string | ReadonlyArray<string>): RelayWebSocketLike;
}

interface RelayRouteBridge {
  readonly routeId: string;
  readonly relayUrl: string;
  readonly viewerDeviceId: string;
  readonly viewerIdentityPublicKey: string;
  readonly clientSessionId: string;
  readonly connectionId: string;
  readonly relaySocket: RelayWebSocketLike;
  readonly localSocket: RelayWebSocketLike;
  readonly exporterKey: Uint8Array;
  sendKey: Uint8Array;
  receiveKey: Uint8Array;
  previousReceiveKey: Uint8Array | null;
  previousReceiveEpoch: number | null;
  sendEpoch: number;
  receiveEpoch: number;
  sendSequence: number;
  receiveSequence: number;
  sentBytesInEpoch: number;
  sendKeyUpdatedAtMs: number;
}

interface PendingRelayRoute {
  readonly routeId: string;
  readonly viewerDeviceId: string;
  readonly viewerIdentityPublicKey: string;
  readonly clientSessionId: string;
  readonly connectionId: string;
}

interface ManagedRelayRegistration {
  readonly relayUrl: string;
  socket: RelayWebSocketLike | null;
  status: RelayRegistrationSnapshot["status"];
  connectedAt: string | null;
  lastError: string | null;
  active: boolean;
  connecting: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  routes: Map<string, RelayRouteBridge>;
  pendingRoutes: Map<string, PendingRelayRoute>;
}

export interface RelayHostManagerShape {
  readonly getStatus: Effect.Effect<ServerRelayStatus>;
  readonly refreshRegistrations: Effect.Effect<void>;
  readonly streamChanges: Stream.Stream<ServerRelayStatus>;
}

export class RelayHostManagerService extends ServiceMap.Service<
  RelayHostManagerService,
  RelayHostManagerShape
>()("ace/relayHostManager") {}

const ACTIVE_RELAY_LIMIT = 1;

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function resolveRelayWebSocketConstructor(): RelayWebSocketConstructor {
  const candidate = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (!candidate) {
    throw new Error("WebSocket is unavailable in this runtime.");
  }
  return candidate as RelayWebSocketConstructor;
}

function openWebSocketConnection(
  target: string,
  protocols?: ReadonlyArray<string>,
): Promise<RelayWebSocketLike> {
  return new Promise((resolve, reject) => {
    const WebSocketCtor = resolveRelayWebSocketConstructor();
    const socket = new WebSocketCtor(target, protocols);
    socket.onopen = () => {
      socket.onopen = null;
      socket.onerror = null;
      socket.onclose = null;
      resolve(socket);
    };
    socket.onerror = () => {
      reject(new Error(`Unable to connect to ${target}.`));
    };
    socket.onclose = (event) => {
      reject(new Error(`Socket closed before opening (code ${String(event.code ?? 0)}).`));
    };
  });
}

function parseRelayMessage(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") {
    return null;
  }
  if (Buffer.byteLength(data, "utf8") > DEFAULT_RELAY_MAX_FRAME_BYTES) {
    throw new Error("Relay message exceeded the maximum allowed size.");
  }
  try {
    const parsed = JSON.parse(data) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function encodeRelayEnvelope(envelope: Record<string, unknown>): string {
  return JSON.stringify(envelope);
}

function readSocketText(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return null;
}

function buildLocalServerUrl(config: {
  readonly port: number;
  readonly authToken: string | undefined;
  readonly clientSessionId: string;
  readonly connectionId: string;
}): { readonly url: string; readonly protocols?: ReadonlyArray<string> } {
  const localUrl = new URL(`/ws`, `ws://127.0.0.1:${String(config.port)}`);
  if (config.authToken?.trim()) {
    localUrl.searchParams.set("token", config.authToken.trim());
  }
  return resolveWebSocketAuthConnection(localUrl.toString(), {
    clientSessionId: config.clientSessionId,
    connectionId: config.connectionId,
  });
}

function createRegistration(relayUrl: string): ManagedRelayRegistration {
  return {
    relayUrl,
    socket: null,
    status: "connecting",
    connectedAt: null,
    lastError: null,
    active: true,
    connecting: false,
    reconnectTimer: null,
    routes: new Map(),
    pendingRoutes: new Map(),
  };
}

function safelyCloseSocket(socket: RelayWebSocketLike | null, code: number, reason: string): void {
  try {
    socket?.close(code, reason);
  } catch {
    // Ignore close failures during relay cleanup.
  }
}

function rotateSendKeyIfNeeded(route: RelayRouteBridge): void {
  const nowMs = Date.now();
  if (
    route.sendSequence === 0 ||
    (route.sentBytesInEpoch < RELAY_REKEY_AFTER_BYTES &&
      nowMs - route.sendKeyUpdatedAtMs < RELAY_REKEY_AFTER_ACTIVE_MS)
  ) {
    return;
  }
  route.sendKey = deriveNextRelayEpochKey({
    currentKey: route.sendKey,
    exporterKey: route.exporterKey,
    epoch: route.sendEpoch,
    direction: "send",
  });
  route.sendEpoch += 1;
  route.sentBytesInEpoch = 0;
  route.sendKeyUpdatedAtMs = nowMs;
}

function advanceReceiveKey(route: RelayRouteBridge, targetEpoch: number): Uint8Array | null {
  if (targetEpoch === route.receiveEpoch) {
    return route.receiveKey;
  }
  if (targetEpoch < route.receiveEpoch) {
    return targetEpoch === route.previousReceiveEpoch ? route.previousReceiveKey : null;
  }
  let nextKey = route.receiveKey;
  let nextEpoch = route.receiveEpoch;
  while (nextEpoch < targetEpoch) {
    nextKey = deriveNextRelayEpochKey({
      currentKey: nextKey,
      exporterKey: route.exporterKey,
      epoch: nextEpoch,
      direction: "receive",
    });
    nextEpoch += 1;
  }
  route.previousReceiveKey = route.receiveKey;
  route.previousReceiveEpoch = route.receiveEpoch;
  route.receiveKey = nextKey;
  route.receiveEpoch = nextEpoch;
  return route.receiveKey;
}

const makeRelayHostManager = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const config = yield* ServerConfig;
  const relayIdentity = yield* getRelayDeviceIdentity();
  const pairingSessionRepository = yield* PairingSessionRepository;
  const changesPubSub = yield* PubSub.unbounded<ServerRelayStatus>();
  const services = yield* Effect.services();
  const runFork = Effect.runForkWith(services);

  const initialSettings = yield* serverSettings.getSettings.pipe(Effect.orDie);
  const initialDefaultRelayUrl = resolveConfiguredRelayWebSocketUrl({
    ...(process.env.ACE_RELAY_URL ? { envRelayUrl: process.env.ACE_RELAY_URL } : {}),
    persistedRelayUrl: initialSettings.remoteRelay.defaultUrl,
    allowInsecureLocalUrls: initialSettings.remoteRelay.allowInsecureLocalUrls,
  });
  let statusSnapshot: ServerRelayStatus = {
    deviceId: relayIdentity.deviceId,
    defaultRelayUrl: initialDefaultRelayUrl,
    activeRelayLimit: ACTIVE_RELAY_LIMIT,
    registrations: [],
  };

  let currentDefaultRelayUrl = initialDefaultRelayUrl;
  const registrations = new Map<string, ManagedRelayRegistration>();

  const buildStatus = (): ServerRelayStatus => ({
    deviceId: relayIdentity.deviceId,
    defaultRelayUrl: currentDefaultRelayUrl,
    activeRelayLimit: ACTIVE_RELAY_LIMIT,
    registrations: Array.from(registrations.values())
      .map((registration) => ({
        relayUrl: registration.relayUrl,
        status: registration.status,
        ...(registration.connectedAt ? { connectedAt: registration.connectedAt } : {}),
        ...(registration.lastError ? { lastError: registration.lastError } : {}),
      }))
      .toSorted((left, right) => left.relayUrl.localeCompare(right.relayUrl)),
  });

  const publishStatus = () => {
    statusSnapshot = buildStatus();
    runFork(PubSub.publish(changesPubSub, statusSnapshot).pipe(Effect.ignoreCause({ log: true })));
  };

  const closeRoute = (
    registration: ManagedRelayRegistration,
    routeId: string,
    options?: {
      readonly reason?: string;
      readonly closeLocal?: boolean;
      readonly notifyRemote?: boolean;
    },
  ) => {
    registration.pendingRoutes.delete(routeId);
    const route = registration.routes.get(routeId);
    if (!route) {
      publishStatus();
      return;
    }
    registration.routes.delete(routeId);
    if (options?.closeLocal !== false) {
      try {
        route.localSocket.close(1_000, options?.reason);
      } catch {
        // Ignore local close failures during cleanup.
      }
    }
    if (options?.notifyRemote !== false) {
      try {
        route.relaySocket.send(
          encodeRelayEnvelope({
            version: 1,
            type: "relay.route.close",
            routeId,
            ...(options?.reason ? { reason: options.reason } : {}),
          }),
        );
      } catch {
        // Ignore remote close failures during cleanup.
      }
    }
    publishStatus();
  };

  const scheduleReconnect = (registration: ManagedRelayRegistration) => {
    if (!registration.active || registration.connecting || registration.reconnectTimer) {
      return;
    }
    registration.status = "connecting";
    registration.reconnectTimer = setTimeout(() => {
      registration.reconnectTimer = null;
      void connectRegistration(registration);
    }, 1_500);
    publishStatus();
  };

  const handleRelayFrameToLocal = (
    registration: ManagedRelayRegistration,
    route: RelayRouteBridge,
    message: Record<string, unknown>,
  ) => {
    if (
      typeof message.sequence !== "number" ||
      typeof message.keyEpoch !== "number" ||
      typeof message.ciphertext !== "string" ||
      typeof message.nonce !== "string"
    ) {
      closeRoute(registration, route.routeId, {
        reason: "relay-invalid-frame",
      });
      return;
    }
    if (message.sequence !== route.receiveSequence) {
      closeRoute(registration, route.routeId, {
        reason: "relay-sequence-error",
      });
      return;
    }
    const receiveKey = advanceReceiveKey(route, message.keyEpoch);
    if (!receiveKey) {
      closeRoute(registration, route.routeId, {
        reason: "relay-epoch-error",
      });
      return;
    }
    const associatedData = buildRelayFrameAssociatedData({
      routeId: route.routeId,
      direction: "viewer_to_host",
      keyEpoch: message.keyEpoch,
      sequence: message.sequence,
      frameKind: "rpc",
    });
    let plaintext: Uint8Array;
    try {
      plaintext = decryptRelayFrame({
        key: receiveKey,
        nonce: message.nonce,
        ciphertext: message.ciphertext,
        associatedData,
      });
    } catch (error) {
      registration.lastError = formatErrorMessage(error);
      closeRoute(registration, route.routeId, {
        reason: "relay-decrypt-error",
      });
      return;
    }
    route.receiveSequence += 1;
    route.localSocket.send(new TextDecoder().decode(plaintext));
  };

  const attachLocalBridge = async (
    registration: ManagedRelayRegistration,
    routeId: string,
    input: {
      readonly relaySocket: RelayWebSocketLike;
      readonly viewerDeviceId: string;
      readonly viewerIdentityPublicKey: string;
      readonly clientSessionId: string;
      readonly connectionId: string;
      readonly remoteEphemeralPublicKey: string;
      readonly remoteHandshakeNonce: string;
    },
  ): Promise<void> => {
    const localConnection = buildLocalServerUrl({
      port: config.port,
      authToken: config.authToken,
      clientSessionId: input.clientSessionId,
      connectionId: input.connectionId,
    });
    const localSocket = await openWebSocketConnection(
      localConnection.url,
      localConnection.protocols,
    );
    const localEphemeral = createRelayEphemeralKeyPair();
    const localNonce = createRelayHandshakeNonce();
    const routeKeys = deriveRelayRouteKeys({
      relayUrl: registration.relayUrl,
      routeId,
      hostDeviceId: relayIdentity.deviceId,
      viewerDeviceId: input.viewerDeviceId,
      localRole: "host",
      localStaticSecretKey: relayIdentity.secretKey,
      localEphemeralSecretKey: localEphemeral.secretKey,
      remoteStaticPublicKey: input.viewerIdentityPublicKey,
      remoteEphemeralPublicKey: input.remoteEphemeralPublicKey,
      localHandshakeNonce: localNonce,
      remoteHandshakeNonce: input.remoteHandshakeNonce,
    });

    const route: RelayRouteBridge = {
      routeId,
      relayUrl: registration.relayUrl,
      viewerDeviceId: input.viewerDeviceId,
      viewerIdentityPublicKey: input.viewerIdentityPublicKey,
      clientSessionId: input.clientSessionId,
      connectionId: input.connectionId,
      relaySocket: input.relaySocket,
      localSocket,
      exporterKey: routeKeys.exporterKey,
      sendKey: routeKeys.sendKey,
      receiveKey: routeKeys.receiveKey,
      previousReceiveKey: null,
      previousReceiveEpoch: null,
      sendEpoch: 0,
      receiveEpoch: 0,
      sendSequence: 0,
      receiveSequence: 0,
      sentBytesInEpoch: 0,
      sendKeyUpdatedAtMs: Date.now(),
    };
    registration.routes.set(routeId, route);
    registration.pendingRoutes.delete(routeId);
    publishStatus();

    localSocket.onmessage = (event) => {
      const plaintext = readSocketText(event.data);
      if (plaintext === null) {
        return;
      }
      rotateSendKeyIfNeeded(route);
      const associatedData = buildRelayFrameAssociatedData({
        routeId,
        direction: "host_to_viewer",
        keyEpoch: route.sendEpoch,
        sequence: route.sendSequence,
        frameKind: "rpc",
      });
      try {
        const encoded = new TextEncoder().encode(plaintext);
        const encrypted = encryptRelayFrame({
          key: route.sendKey,
          plaintext: encoded,
          associatedData,
        });
        input.relaySocket.send(
          encodeRelayEnvelope({
            version: 1,
            type: "relay.encryptedFrame",
            routeId,
            keyEpoch: route.sendEpoch,
            sequence: route.sendSequence,
            direction: "host_to_viewer",
            ciphertext: encrypted.ciphertext,
            nonce: encrypted.nonce,
            sentAt: new Date().toISOString(),
          }),
        );
        route.sendSequence += 1;
        route.sentBytesInEpoch += encoded.length;
      } catch (error) {
        registration.lastError = formatErrorMessage(error);
        closeRoute(registration, routeId, {
          reason: "relay-encrypt-error",
        });
      }
    };
    localSocket.onclose = () => {
      closeRoute(registration, routeId, {
        reason: "local-ws-closed",
        closeLocal: false,
      });
    };
    localSocket.onerror = () => {
      closeRoute(registration, routeId, {
        reason: "local-ws-error",
        closeLocal: false,
      });
    };

    input.relaySocket.send(
      encodeRelayEnvelope({
        version: 1,
        type: "relay.route.handshakeAck",
        routeId,
        ephemeralPublicKey: localEphemeral.publicKey,
        handshakeNonce: localNonce,
      }),
    );
  };

  const handleRelayMessage = async (
    registration: ManagedRelayRegistration,
    socket: RelayWebSocketLike,
    rawData: unknown,
  ): Promise<void> => {
    let message: Record<string, unknown> | null;
    try {
      message = parseRelayMessage(rawData);
    } catch (error) {
      registration.lastError = formatErrorMessage(error);
      publishStatus();
      safelyCloseSocket(socket, 1_009, "relay-message-too-large");
      return;
    }
    if (!message) {
      return;
    }
    if (message.type === "relay.ping") {
      socket.send(
        encodeRelayEnvelope({
          version: 1,
          type: "relay.pong",
          sentAt: new Date().toISOString(),
        }),
      );
      return;
    }
    if (message.type === "relay.route.close" && typeof message.routeId === "string") {
      closeRoute(registration, message.routeId, {
        ...(typeof message.reason === "string" ? { reason: message.reason } : {}),
        notifyRemote: false,
        closeLocal: true,
      });
      return;
    }
    if (
      message.type === "relay.route.request" &&
      typeof message.routeId === "string" &&
      typeof message.viewerDeviceId === "string" &&
      typeof message.viewerIdentityPublicKey === "string" &&
      typeof message.pairingId === "string" &&
      typeof message.routeAuthIssuedAt === "string" &&
      typeof message.routeAuthProof === "string" &&
      typeof message.clientSessionId === "string" &&
      typeof message.connectionId === "string"
    ) {
      const approved = approveRelayPairingRequest({
        sessionId: message.pairingId,
        viewerDeviceId: message.viewerDeviceId,
        viewerIdentityPublicKey: message.viewerIdentityPublicKey,
        routeId: message.routeId,
        clientSessionId: message.clientSessionId,
        connectionId: message.connectionId,
        routeAuthIssuedAt: message.routeAuthIssuedAt,
        routeAuthProof: message.routeAuthProof,
        ...(typeof message.viewerDeviceName === "string"
          ? { requesterName: message.viewerDeviceName }
          : {}),
      });
      if (!approved.ok) {
        socket.send(
          encodeRelayEnvelope({
            version: 1,
            type: "relay.route.ready",
            routeId: message.routeId,
            state: "closed",
            hostDeviceId: relayIdentity.deviceId,
            hostIdentityPublicKey: relayIdentity.publicKey,
            error: approved.message,
          }),
        );
        return;
      }
      await persistPairingSessionsToDatabase(pairingSessionRepository).catch((error) => {
        registration.lastError = formatErrorMessage(error);
      });
      registration.pendingRoutes.set(message.routeId, {
        routeId: message.routeId,
        viewerDeviceId: message.viewerDeviceId,
        viewerIdentityPublicKey: message.viewerIdentityPublicKey,
        clientSessionId: message.clientSessionId,
        connectionId: message.connectionId,
      });
      publishStatus();
      socket.send(
        encodeRelayEnvelope({
          version: 1,
          type: "relay.route.ready",
          routeId: message.routeId,
          state: "ready",
          hostDeviceId: relayIdentity.deviceId,
          hostIdentityPublicKey: relayIdentity.publicKey,
        }),
      );
      return;
    }
    if (
      message.type === "relay.route.handshakeInit" &&
      typeof message.routeId === "string" &&
      typeof message.ephemeralPublicKey === "string" &&
      typeof message.handshakeNonce === "string"
    ) {
      const pendingRoute = registration.pendingRoutes.get(message.routeId);
      if (!pendingRoute) {
        socket.send(
          encodeRelayEnvelope({
            version: 1,
            type: "relay.route.close",
            routeId: message.routeId,
            reason: "Relay route is not authorized.",
          }),
        );
        return;
      }
      await attachLocalBridge(registration, message.routeId, {
        relaySocket: socket,
        viewerDeviceId: pendingRoute.viewerDeviceId,
        viewerIdentityPublicKey: pendingRoute.viewerIdentityPublicKey,
        clientSessionId: pendingRoute.clientSessionId,
        connectionId: pendingRoute.connectionId,
        remoteEphemeralPublicKey: message.ephemeralPublicKey,
        remoteHandshakeNonce: message.handshakeNonce,
      });
      return;
    }
    if (
      message.type === "relay.encryptedFrame" &&
      message.direction === "viewer_to_host" &&
      typeof message.routeId === "string"
    ) {
      const route = registration.routes.get(message.routeId);
      if (route) {
        handleRelayFrameToLocal(registration, route, message);
      }
    }
  };

  const connectRegistration = async (registration: ManagedRelayRegistration): Promise<void> => {
    if (!registration.active || registration.socket || registration.connecting) {
      return;
    }
    registration.connecting = true;
    registration.status = "connecting";
    registration.lastError = null;
    publishStatus();
    try {
      const socket = await openWebSocketConnection(registration.relayUrl);
      registration.connecting = false;
      registration.socket = socket;
      registration.status = "connected";
      registration.connectedAt = new Date().toISOString();
      registration.lastError = null;
      publishStatus();

      socket.onmessage = (event) => {
        void handleRelayMessage(registration, socket, event.data).catch((error) => {
          registration.lastError = formatErrorMessage(error);
          publishStatus();
        });
      };
      socket.onerror = () => {
        registration.lastError = "Relay connection error.";
        publishStatus();
      };
      socket.onclose = (event) => {
        registration.socket = null;
        registration.connecting = false;
        registration.status = "disconnected";
        registration.connectedAt = null;
        registration.lastError = `Relay disconnected (code ${String(event.code ?? 0)}).`;
        registration.pendingRoutes.clear();
        for (const routeId of Array.from(registration.routes.keys())) {
          closeRoute(registration, routeId, {
            reason: "relay-disconnected",
            notifyRemote: false,
            closeLocal: true,
          });
        }
        publishStatus();
        scheduleReconnect(registration);
      };

      socket.send(
        encodeRelayEnvelope({
          version: 1,
          type: "relay.host.register",
          deviceId: relayIdentity.deviceId,
          deviceName: "ace host",
          identityPublicKey: relayIdentity.publicKey,
        }),
      );
    } catch (error) {
      registration.connecting = false;
      registration.socket = null;
      registration.status = "disconnected";
      registration.connectedAt = null;
      registration.lastError = formatErrorMessage(error);
      publishStatus();
      scheduleReconnect(registration);
    }
  };

  const refreshRegistrations = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    currentDefaultRelayUrl = resolveConfiguredRelayWebSocketUrl({
      ...(process.env.ACE_RELAY_URL ? { envRelayUrl: process.env.ACE_RELAY_URL } : {}),
      persistedRelayUrl: settings.remoteRelay.defaultUrl,
      allowInsecureLocalUrls: settings.remoteRelay.allowInsecureLocalUrls,
    });
    const desiredRelayUrlSet = settings.remoteRelay.enabled
      ? new Set([currentDefaultRelayUrl])
      : new Set<string>();

    for (const [relayUrl, registration] of registrations.entries()) {
      if (desiredRelayUrlSet.has(relayUrl)) {
        continue;
      }
      registration.active = false;
      if (registration.reconnectTimer) {
        clearTimeout(registration.reconnectTimer);
        registration.reconnectTimer = null;
      }
      registration.pendingRoutes.clear();
      for (const routeId of Array.from(registration.routes.keys())) {
        closeRoute(registration, routeId, {
          reason: "relay-disabled",
          notifyRemote: true,
          closeLocal: true,
        });
      }
      safelyCloseSocket(registration.socket, 1_000, "relay-disabled");
      registrations.delete(relayUrl);
    }

    if (!settings.remoteRelay.enabled) {
      publishStatus();
      return;
    }

    for (const relayUrl of desiredRelayUrlSet) {
      let registration = registrations.get(relayUrl);
      if (!registration) {
        registration = createRegistration(relayUrl);
        registrations.set(relayUrl, registration);
      }
      registration.active = true;
      registration.lastError = null;
      if (!registration.socket && !registration.connecting && !registration.reconnectTimer) {
        void connectRegistration(registration);
      }
    }

    publishStatus();
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const registration of registrations.values()) {
        registration.active = false;
        if (registration.reconnectTimer) {
          clearTimeout(registration.reconnectTimer);
          registration.reconnectTimer = null;
        }
        registration.pendingRoutes.clear();
        for (const routeId of Array.from(registration.routes.keys())) {
          closeRoute(registration, routeId, {
            reason: "relay-shutdown",
            notifyRemote: false,
            closeLocal: true,
          });
        }
        safelyCloseSocket(registration.socket, 1_000, "relay-shutdown");
      }
      registrations.clear();
    }),
  );

  yield* refreshRegistrations;
  yield* Stream.runForEach(serverSettings.streamChanges, () => refreshRegistrations).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );

  return {
    getStatus: Effect.sync(() => statusSnapshot),
    refreshRegistrations,
    streamChanges: Stream.fromPubSub(changesPubSub),
  } satisfies RelayHostManagerShape;
});

export const RelayHostManagerLive = Layer.effect(RelayHostManagerService, makeRelayHostManager);
