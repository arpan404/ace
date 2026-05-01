import { WS_METHODS, WsRpcGroup } from "@ace/contracts";
import { Cause, Effect, Exit, Scope, Stream, Duration, Option } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { WsClientConnectionIdentity, WsRpcProtocolClient } from "./wsRpcProtocol";
import {
  DEFAULT_RELAY_MAX_FRAME_BYTES,
  createRelayRouteAuthProof,
  type RelayConnectionMetadata,
  type RelayStoredDeviceIdentity,
  RELAY_REKEY_AFTER_ACTIVE_MS,
  RELAY_REKEY_AFTER_BYTES,
  buildRelayFrameAssociatedData,
  createRelayEphemeralKeyPair,
  createRelayHandshakeNonce,
  decryptRelayFrame,
  deriveNextRelayEpochKey,
  deriveRelayPairingAuthKey,
  deriveRelayRouteKeys,
  encryptRelayFrame,
  normalizeRelayWebSocketUrl,
  parseRelayConnectionUrl,
} from "./relay";

const DEFAULT_REQUEST_RETRY_LIMIT = 2;
const DEFAULT_REQUEST_RETRY_DELAY_MS = 250;
const DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS = 250;
const DEFAULT_SUBSCRIPTION_RETRY_MULTIPLIER = 2;
const DEFAULT_SUBSCRIPTION_MAX_RETRY_DELAY_MS = 30_000;

function normalizeRpcProtocolMessageForJson(message: unknown): unknown {
  if (Array.isArray(message)) {
    return message.map((item) => normalizeRpcProtocolMessageForJson(item));
  }
  if (typeof message !== "object" || message === null) {
    return message;
  }
  const protocolMessage = {
    ...(message as Record<string, unknown>),
  };
  if (protocolMessage._tag === "Request") {
    const headers = protocolMessage.headers;
    protocolMessage.headers = Array.isArray(headers)
      ? headers
      : typeof headers === "object" && headers !== null
        ? Object.entries(headers as Record<string, unknown>)
        : [];
  }
  return protocolMessage;
}

export function encodeRpcProtocolMessage(message: unknown): string {
  return JSON.stringify(normalizeRpcProtocolMessageForJson(message), (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

export function reviveRpcProtocolMessage(message: unknown): unknown {
  if (typeof message !== "object" || message === null) {
    return message;
  }
  const protocolMessage = message as {
    _tag?: unknown;
    id?: unknown;
    requestId?: unknown;
    exit?: unknown;
  };
  if (typeof protocolMessage.id === "string") {
    protocolMessage.id = BigInt(protocolMessage.id);
  }
  if (typeof protocolMessage.requestId === "string") {
    protocolMessage.requestId = BigInt(protocolMessage.requestId);
  }
  if (protocolMessage._tag === "Exit") {
    protocolMessage.exit = reviveRpcExit(protocolMessage.exit);
  }
  return protocolMessage;
}

function reviveRpcCause(cause: unknown): Cause.Cause<unknown> {
  if (Cause.isCause(cause)) {
    return cause;
  }
  if (Array.isArray(cause)) {
    return Cause.fromReasons(cause as ReadonlyArray<Cause.Reason<unknown>>);
  }
  if (typeof cause === "object" && cause !== null) {
    const maybeReasons = (cause as { reasons?: unknown }).reasons;
    if (Array.isArray(maybeReasons)) {
      return Cause.fromReasons(maybeReasons as ReadonlyArray<Cause.Reason<unknown>>);
    }
  }
  return Cause.die(cause);
}

function reviveRpcExit(exit: unknown): unknown {
  if (typeof exit !== "object" || exit === null) {
    return exit;
  }
  const encodedExit = exit as {
    _tag?: unknown;
    value?: unknown;
    cause?: unknown;
  };
  if (encodedExit._tag === "Success") {
    return Exit.succeed(encodedExit.value);
  }
  if (encodedExit._tag === "Failure") {
    return Exit.failCause(reviveRpcCause(encodedExit.cause));
  }
  return exit;
}

interface RelayWebSocketLike {
  readyState: number;
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

interface RelayRouteContext {
  readonly socket: RelayWebSocketLike;
  readonly routeId: string;
  readonly viewerIdentity: RelayStoredDeviceIdentity;
  readonly receiveExporterKey: Uint8Array;
  readonly sendExporterKey: Uint8Array;
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

export interface RelayTransportConnectionState {
  readonly kind: "disconnected" | "reconnected";
  readonly error?: string;
}

export interface RelayRpcTransportOptions {
  readonly connectionUrl: string;
  readonly clientSessionId: string;
  readonly connectionId: string;
  readonly deviceName?: string;
  readonly loadIdentity: () => Promise<RelayStoredDeviceIdentity>;
  readonly resolveConnectionUrl?: (connectionUrl: string) => Promise<string>;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function createRandomId(): string {
  const cryptoObject = globalThis.crypto as
    | {
        readonly randomUUID?: () => string;
      }
    | undefined;
  if (typeof cryptoObject?.randomUUID === "function") {
    return cryptoObject.randomUUID();
  }
  return `relay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function resolveRelayWebSocketConstructor(): RelayWebSocketConstructor {
  const candidate = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (!candidate) {
    throw new Error("WebSocket is unavailable in this runtime.");
  }
  return candidate as RelayWebSocketConstructor;
}

function parseRelayMessage(data: unknown): Record<string, unknown> | null {
  const text = typeof data === "string" ? data : null;
  if (!text) {
    return null;
  }
  if (byteLengthOfString(text) > DEFAULT_RELAY_MAX_FRAME_BYTES) {
    throw new Error("Relay message exceeded the maximum allowed size.");
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function openRelayWebSocket(url: string): Promise<RelayWebSocketLike> {
  return new Promise((resolve, reject) => {
    const WebSocketCtor = resolveRelayWebSocketConstructor();
    const socket = new WebSocketCtor(url);
    socket.onopen = () => {
      socket.onopen = null;
      resolve(socket);
    };
    socket.onerror = () => {
      reject(new Error(`Unable to connect to relay ${url}.`));
    };
    socket.onclose = (event) => {
      reject(
        new Error(`Relay connection closed before route setup (code ${String(event.code ?? 0)}).`),
      );
    };
  });
}

function encodeRelayEnvelope(envelope: Record<string, unknown>): string {
  return JSON.stringify(envelope);
}

function byteLengthOfString(value: string): number {
  return new TextEncoder().encode(value).length;
}

function resolveRetryDelayMs(retryDelay: Duration.Input | undefined): number {
  const parsedDuration = retryDelay
    ? Duration.fromInput(retryDelay)
    : Option.some(Duration.millis(DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS));
  return Option.match(parsedDuration, {
    onNone: () => DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS,
    onSome: (duration) => {
      const millis = Duration.toMillis(duration);
      return Number.isFinite(millis) && millis > 0 ? millis : DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS;
    },
  });
}

export class RelayRpcTransport {
  private metadata: RelayConnectionMetadata;
  private readonly parser = RpcSerialization.json.makeUnsafe();
  private readonly scope = Effect.runSync(Scope.make());
  private readonly identity: WsClientConnectionIdentity;
  private readonly deviceName: string | undefined;
  private readonly connectionUrl: string;
  private readonly loadIdentity: () => Promise<RelayStoredDeviceIdentity>;
  private readonly resolveConnectionUrl: ((connectionUrl: string) => Promise<string>) | undefined;
  private readonly clientStatePromise: Promise<{
    readonly client: WsRpcProtocolClient;
    readonly write: (message: unknown) => Promise<void>;
  }>;
  private readonly connectionStateListeners = new Set<
    (state: RelayTransportConnectionState) => void
  >();
  private activeRoute: RelayRouteContext | null = null;
  private routePromise: Promise<RelayRouteContext> | null = null;
  private disposed = false;
  private hasConnected = false;
  private disconnected = false;

  constructor(options: RelayRpcTransportOptions) {
    const metadata = parseRelayConnectionUrl(options.connectionUrl);
    if (!metadata) {
      throw new Error("Relay connection URL is invalid or missing relay metadata.");
    }
    this.metadata = {
      ...metadata,
      relayUrl: normalizeRelayWebSocketUrl(metadata.relayUrl),
    };
    this.connectionUrl = options.connectionUrl;
    this.identity = {
      clientSessionId: options.clientSessionId,
      connectionId: options.connectionId,
    };
    this.deviceName = options.deviceName?.trim() ? options.deviceName.trim() : undefined;
    this.loadIdentity = options.loadIdentity;
    this.resolveConnectionUrl = options.resolveConnectionUrl;
    this.clientStatePromise = Effect.runPromise(
      Scope.provide(this.scope)(
        RpcClient.makeNoSerialization(WsRpcGroup, {
          onFromClient: ({ message }) =>
            Effect.promise(() => this.sendRpcMessage(message as unknown)),
        }),
      ).pipe(
        Effect.map(({ client, write }) => ({
          client: client as unknown as WsRpcProtocolClient,
          write: (message: unknown) => Effect.runPromise(write(message as never)),
        })),
      ),
    );
  }

  getConnectionIdentity(): WsClientConnectionIdentity {
    return { ...this.identity };
  }

  onConnectionStateChange(listener: (state: RelayTransportConnectionState) => void): () => void {
    this.connectionStateListeners.add(listener);
    return () => {
      this.connectionStateListeners.delete(listener);
    };
  }

  private emitConnectionState(state: RelayTransportConnectionState): void {
    for (const listener of this.connectionStateListeners) {
      try {
        listener(state);
      } catch {
        // Ignore listener failures so transport state remains stable.
      }
    }
  }

  private noteConnected(): void {
    if (!this.hasConnected) {
      this.hasConnected = true;
      this.disconnected = false;
      this.emitConnectionState({ kind: "reconnected" });
      return;
    }
    if (!this.disconnected) {
      return;
    }
    this.disconnected = false;
    this.emitConnectionState({ kind: "reconnected" });
  }

  private noteDisconnected(error: unknown): void {
    if (!this.hasConnected || this.disposed || this.disconnected) {
      return;
    }
    this.disconnected = true;
    this.emitConnectionState({
      kind: "disconnected",
      error: formatErrorMessage(error),
    });
  }

  private closeActiveRoute(reason?: string): void {
    const route = this.activeRoute;
    this.activeRoute = null;
    this.routePromise = null;
    if (!route) {
      return;
    }
    try {
      route.socket.close(1_000, reason);
    } catch {
      // Ignore close failures during teardown.
    }
  }

  private async resolveConnectionMetadata(): Promise<RelayConnectionMetadata> {
    if (this.metadata.pairingAuthKey || this.metadata.pairingSecret || !this.resolveConnectionUrl) {
      return this.metadata;
    }
    const resolvedConnectionUrl = await this.resolveConnectionUrl(this.connectionUrl);
    const resolvedMetadata = parseRelayConnectionUrl(resolvedConnectionUrl);
    if (!resolvedMetadata) {
      throw new Error("Resolved relay connection URL is invalid or missing relay metadata.");
    }
    this.metadata = {
      ...resolvedMetadata,
      relayUrl: normalizeRelayWebSocketUrl(resolvedMetadata.relayUrl),
    };
    return this.metadata;
  }

  private async connectRoute(): Promise<RelayRouteContext> {
    const metadata = await this.resolveConnectionMetadata();
    const viewerIdentity = await this.loadIdentity();
    const socket = await openRelayWebSocket(metadata.relayUrl);
    const routeId = createRandomId();
    const pairingAuthKey =
      metadata.pairingAuthKey ??
      (metadata.pairingSecret
        ? deriveRelayPairingAuthKey({
            pairingId: metadata.pairingId,
            pairingSecret: metadata.pairingSecret,
            hostDeviceId: metadata.hostDeviceId,
            hostIdentityPublicKey: metadata.hostIdentityPublicKey,
            viewerDeviceId: viewerIdentity.deviceId,
            viewerIdentityPublicKey: viewerIdentity.publicKey,
          })
        : null);
    if (!pairingAuthKey) {
      throw new Error("Relay connection metadata is missing pairing authorization material.");
    }
    const routeAuthIssuedAt = new Date().toISOString();
    const routeAuthProof = createRelayRouteAuthProof({
      pairingAuthKey,
      routeId,
      clientSessionId: this.identity.clientSessionId,
      connectionId: this.identity.connectionId,
      viewerDeviceId: viewerIdentity.deviceId,
      viewerIdentityPublicKey: viewerIdentity.publicKey,
      issuedAt: routeAuthIssuedAt,
    });

    const routeReady = await new Promise<RelayRouteContext>((resolve, reject) => {
      let settled = false;
      let localEphemeral: {
        readonly secretKey: string;
        readonly publicKey: string;
        readonly nonce: string;
      } | null = null;

      const finish = (result: "resolve" | "reject", value: RelayRouteContext | Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (result === "resolve") {
          resolve(value as RelayRouteContext);
        } else {
          try {
            socket.close(1_011, "relay-route-failed");
          } catch {
            // Ignore close failures while rejecting route setup.
          }
          reject(value);
        }
      };

      socket.onmessage = (event) => {
        let message: Record<string, unknown> | null;
        try {
          message = parseRelayMessage(event.data);
        } catch (error) {
          finish("reject", error instanceof Error ? error : new Error(String(error)));
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
        if (typeof message.routeId === "string" && message.routeId !== routeId) {
          return;
        }
        if (message.type === "relay.error") {
          finish(
            "reject",
            new Error(
              typeof message.message === "string"
                ? message.message
                : "Relay rejected the connection.",
            ),
          );
          return;
        }
        if (message.type === "relay.route.close") {
          finish(
            "reject",
            new Error(
              typeof message.reason === "string"
                ? message.reason
                : "Relay route closed during setup.",
            ),
          );
          return;
        }
        if (message.type === "relay.route.ready") {
          if (
            message.state !== "ready" ||
            typeof message.hostIdentityPublicKey !== "string" ||
            typeof message.hostDeviceId !== "string"
          ) {
            finish(
              "reject",
              new Error(
                typeof message.error === "string" ? message.error : "Relay host is unavailable.",
              ),
            );
            return;
          }
          const ephemeral = createRelayEphemeralKeyPair();
          const nonce = createRelayHandshakeNonce();
          localEphemeral = {
            ...ephemeral,
            nonce,
          };
          socket.send(
            encodeRelayEnvelope({
              version: 1,
              type: "relay.route.handshakeInit",
              routeId,
              ephemeralPublicKey: ephemeral.publicKey,
              handshakeNonce: nonce,
            }),
          );
          return;
        }
        if (message.type === "relay.route.handshakeAck") {
          if (
            !localEphemeral ||
            typeof message.ephemeralPublicKey !== "string" ||
            typeof message.handshakeNonce !== "string"
          ) {
            finish("reject", new Error("Relay handshake did not complete."));
            return;
          }
          const routeKeys = deriveRelayRouteKeys({
            relayUrl: metadata.relayUrl,
            routeId,
            hostDeviceId: metadata.hostDeviceId,
            viewerDeviceId: viewerIdentity.deviceId,
            localRole: "viewer",
            localStaticSecretKey: viewerIdentity.secretKey,
            localEphemeralSecretKey: localEphemeral.secretKey,
            remoteStaticPublicKey: metadata.hostIdentityPublicKey,
            remoteEphemeralPublicKey: message.ephemeralPublicKey,
            localHandshakeNonce: localEphemeral.nonce,
            remoteHandshakeNonce: message.handshakeNonce,
          });
          finish("resolve", {
            socket,
            routeId,
            viewerIdentity,
            sendKey: routeKeys.sendKey,
            receiveKey: routeKeys.receiveKey,
            previousReceiveKey: null,
            previousReceiveEpoch: null,
            sendExporterKey: routeKeys.exporterKey,
            receiveExporterKey: routeKeys.exporterKey,
            sendEpoch: 0,
            receiveEpoch: 0,
            sendSequence: 0,
            receiveSequence: 0,
            sentBytesInEpoch: 0,
            sendKeyUpdatedAtMs: Date.now(),
          });
        }
      };

      socket.onerror = () => {
        finish("reject", new Error("Relay route setup failed."));
      };
      socket.onclose = (event) => {
        finish(
          "reject",
          new Error(`Relay route closed during setup (code ${String(event.code ?? 0)}).`),
        );
      };

      socket.send(
        encodeRelayEnvelope({
          version: 1,
          type: "relay.viewer.register",
          deviceId: viewerIdentity.deviceId,
          ...(this.deviceName ? { deviceName: this.deviceName } : {}),
          identityPublicKey: viewerIdentity.publicKey,
        }),
      );
      socket.send(
        encodeRelayEnvelope({
          version: 1,
          type: "relay.route.open",
          routeId,
          hostDeviceId: metadata.hostDeviceId,
          viewerDeviceId: viewerIdentity.deviceId,
          clientSessionId: this.identity.clientSessionId,
          connectionId: this.identity.connectionId,
          pairingId: metadata.pairingId,
          routeAuthIssuedAt,
          routeAuthProof,
        }),
      );
    });

    const clientState = await this.clientStatePromise;
    socket.onmessage = (event) => {
      void this.handleSteadyStateMessage(routeReady, clientState.write, event.data).catch(
        (error) => {
          this.noteDisconnected(error);
          this.closeActiveRoute("relay-message-error");
        },
      );
    };
    socket.onerror = () => {
      const error = new Error("Relay transport disconnected.");
      this.noteDisconnected(error);
      this.closeActiveRoute("relay-error");
    };
    socket.onclose = (event) => {
      const error = new Error(
        `Relay transport closed (code ${String(event.code ?? 0)}${event.reason ? `: ${event.reason}` : ""}).`,
      );
      this.noteDisconnected(error);
      this.closeActiveRoute("relay-closed");
    };

    this.activeRoute = routeReady;
    this.noteConnected();
    return routeReady;
  }

  private async ensureRoute(): Promise<RelayRouteContext> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }
    if (this.activeRoute) {
      return this.activeRoute;
    }
    if (!this.routePromise) {
      this.routePromise = this.connectRoute().catch((error) => {
        this.routePromise = null;
        throw error;
      });
    }
    return this.routePromise;
  }

  private rotateSendKeyIfNeeded(route: RelayRouteContext): void {
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
      exporterKey: route.sendExporterKey,
      epoch: route.sendEpoch,
      direction: "send",
    });
    route.sendEpoch += 1;
    route.sentBytesInEpoch = 0;
    route.sendKeyUpdatedAtMs = nowMs;
  }

  private async sendRpcMessage(message: unknown): Promise<void> {
    const route = await this.ensureRoute();
    const encoded = encodeRpcProtocolMessage(message);
    this.rotateSendKeyIfNeeded(route);
    const associatedData = buildRelayFrameAssociatedData({
      routeId: route.routeId,
      direction: "viewer_to_host",
      keyEpoch: route.sendEpoch,
      sequence: route.sendSequence,
      frameKind: "rpc",
    });
    const plaintext = new TextEncoder().encode(encoded);
    const encrypted = encryptRelayFrame({
      key: route.sendKey,
      plaintext,
      associatedData,
    });
    route.socket.send(
      encodeRelayEnvelope({
        version: 1,
        type: "relay.encryptedFrame",
        routeId: route.routeId,
        keyEpoch: route.sendEpoch,
        sequence: route.sendSequence,
        direction: "viewer_to_host",
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        sentAt: new Date().toISOString(),
      }),
    );
    route.sendSequence += 1;
    route.sentBytesInEpoch += plaintext.length;
  }

  private advanceReceiveKey(route: RelayRouteContext, targetEpoch: number): Uint8Array | null {
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
        exporterKey: route.receiveExporterKey,
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

  private async handleSteadyStateMessage(
    route: RelayRouteContext,
    writeMessage: (message: unknown) => Promise<void>,
    rawData: unknown,
  ): Promise<void> {
    const message = parseRelayMessage(rawData);
    if (!message) {
      return;
    }
    if (message.type === "relay.ping") {
      route.socket.send(
        encodeRelayEnvelope({
          version: 1,
          type: "relay.pong",
          sentAt: new Date().toISOString(),
        }),
      );
      return;
    }
    if (message.type === "relay.route.close") {
      this.closeActiveRoute("relay-route-close");
      this.noteDisconnected(new Error("Relay route closed by host."));
      return;
    }
    if (
      message.type !== "relay.encryptedFrame" ||
      message.routeId !== route.routeId ||
      message.direction !== "host_to_viewer" ||
      typeof message.keyEpoch !== "number" ||
      typeof message.sequence !== "number" ||
      typeof message.ciphertext !== "string" ||
      typeof message.nonce !== "string"
    ) {
      return;
    }
    if (message.sequence !== route.receiveSequence) {
      this.closeActiveRoute("relay-sequence-error");
      throw new Error("Relay frame sequence mismatch.");
    }
    const receiveKey = this.advanceReceiveKey(route, message.keyEpoch);
    if (!receiveKey) {
      this.closeActiveRoute("relay-epoch-error");
      throw new Error("Relay frame key epoch was invalid.");
    }
    const associatedData = buildRelayFrameAssociatedData({
      routeId: route.routeId,
      direction: "host_to_viewer",
      keyEpoch: message.keyEpoch,
      sequence: message.sequence,
      frameKind: "rpc",
    });
    const plaintext = decryptRelayFrame({
      key: receiveKey,
      nonce: message.nonce,
      ciphertext: message.ciphertext,
      associatedData,
    });
    const decoded = new TextDecoder().decode(plaintext);
    for (const rpcMessage of this.parser.decode(decoded)) {
      await writeMessage(reviveRpcProtocolMessage(rpcMessage));
    }
    route.receiveSequence += 1;
  }

  async request<TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    let attempt = 0;
    for (;;) {
      try {
        const clientState = await this.clientStatePromise;
        const result = await Effect.runPromise(execute(clientState.client));
        this.noteConnected();
        return result;
      } catch (error) {
        if (this.disposed) {
          throw new Error("Transport disposed", { cause: error });
        }
        this.noteDisconnected(error);
        this.closeActiveRoute("relay-request-retry");
        if (attempt >= DEFAULT_REQUEST_RETRY_LIMIT) {
          throw error;
        }
        attempt += 1;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, DEFAULT_REQUEST_RETRY_DELAY_MS * attempt),
        );
      }
    }
  }

  async requestStream<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
  ): Promise<void> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }
    const clientState = await this.clientStatePromise;
    await Effect.runPromise(
      Stream.runForEach(connect(clientState.client), (value) =>
        Effect.sync(() => {
          if (!this.disposed) {
            listener(value);
          }
        }),
      ),
    );
  }

  subscribe<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: { readonly retryDelay?: Duration.Input },
  ): () => void {
    if (this.disposed) {
      return () => undefined;
    }
    let active = true;
    let retryCount = 0;
    let sawValueSinceRetry = false;
    const baseRetryDelayMs = resolveRetryDelayMs(options?.retryDelay);
    const maxRetryDelayMs = Math.max(baseRetryDelayMs, DEFAULT_SUBSCRIPTION_MAX_RETRY_DELAY_MS);

    const loop = async () => {
      while (active && !this.disposed) {
        try {
          const clientState = await this.clientStatePromise;
          sawValueSinceRetry = false;
          await Effect.runPromise(
            Stream.runForEach(connect(clientState.client), (value) =>
              Effect.sync(() => {
                if (!active || this.disposed) {
                  return;
                }
                sawValueSinceRetry = true;
                listener(value);
              }),
            ),
          );
          if (!active || this.disposed) {
            return;
          }
          throw new Error("Relay subscription ended.");
        } catch (error) {
          if (!active || this.disposed) {
            return;
          }
          if (sawValueSinceRetry) {
            retryCount = 0;
          }
          retryCount += 1;
          this.noteDisconnected(error);
          this.closeActiveRoute("relay-subscribe-retry");
          const delayMs = Math.min(
            baseRetryDelayMs * Math.pow(DEFAULT_SUBSCRIPTION_RETRY_MULTIPLIER, retryCount - 1),
            maxRetryDelayMs,
          );
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
      }
    };

    void loop();
    return () => {
      active = false;
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const route = this.activeRoute;
    if (route && this.hasConnected) {
      try {
        const clientState = await this.clientStatePromise;
        await Effect.runPromise(
          clientState.client[WS_METHODS.serverDisconnect]({
            clientSessionId: this.identity.clientSessionId,
            connectionId: this.identity.connectionId,
          }),
        ).catch(() => undefined);
      } catch {
        // Ignore disconnect RPC failures during disposal.
      }
    }
    this.closeActiveRoute("relay-dispose");
    await Effect.runPromise(Scope.close(this.scope, Exit.void));
  }
}
