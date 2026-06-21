import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

export const RelayClientRole = Schema.Literals(["host", "viewer"]);
export type RelayClientRole = typeof RelayClientRole.Type;

export const RelayRouteState = Schema.Literals(["pending", "ready", "closed"]);
export type RelayRouteState = typeof RelayRouteState.Type;

export const RelayRegistrationState = Schema.Literals(["connecting", "connected", "disconnected"]);
export type RelayRegistrationState = typeof RelayRegistrationState.Type;

export const RelayClientHello = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.client.hello"),
  role: RelayClientRole,
  deviceId: TrimmedNonEmptyString,
  deviceName: Schema.optional(TrimmedNonEmptyString),
  identityPublicKey: TrimmedNonEmptyString,
});
export type RelayClientHello = typeof RelayClientHello.Type;

export const RelayRegisterHost = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.host.register"),
  deviceId: TrimmedNonEmptyString,
  deviceName: Schema.optional(TrimmedNonEmptyString),
  identityPublicKey: TrimmedNonEmptyString,
});
export type RelayRegisterHost = typeof RelayRegisterHost.Type;

export const RelayRegisterViewer = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.viewer.register"),
  deviceId: TrimmedNonEmptyString,
  deviceName: Schema.optional(TrimmedNonEmptyString),
  identityPublicKey: TrimmedNonEmptyString,
});
export type RelayRegisterViewer = typeof RelayRegisterViewer.Type;

export const RelayRouteOpen = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.route.open"),
  routeId: TrimmedNonEmptyString,
  hostDeviceId: TrimmedNonEmptyString,
  viewerDeviceId: TrimmedNonEmptyString,
  clientSessionId: TrimmedNonEmptyString,
  connectionId: TrimmedNonEmptyString,
  pairingId: TrimmedNonEmptyString,
  routeAuthIssuedAt: IsoDateTime,
  routeAuthProof: TrimmedNonEmptyString,
});
export type RelayRouteOpen = typeof RelayRouteOpen.Type;

export const RelayRouteRequest = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.route.request"),
  routeId: TrimmedNonEmptyString,
  hostDeviceId: TrimmedNonEmptyString,
  viewerDeviceId: TrimmedNonEmptyString,
  clientSessionId: TrimmedNonEmptyString,
  connectionId: TrimmedNonEmptyString,
  viewerDeviceName: Schema.optional(TrimmedNonEmptyString),
  viewerIdentityPublicKey: TrimmedNonEmptyString,
  pairingId: TrimmedNonEmptyString,
  routeAuthIssuedAt: IsoDateTime,
  routeAuthProof: TrimmedNonEmptyString,
});
export type RelayRouteRequest = typeof RelayRouteRequest.Type;

export const RelayRouteReady = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.route.ready"),
  routeId: TrimmedNonEmptyString,
  state: RelayRouteState,
  hostDeviceId: TrimmedNonEmptyString,
  hostIdentityPublicKey: TrimmedNonEmptyString,
  error: Schema.optional(TrimmedNonEmptyString),
});
export type RelayRouteReady = typeof RelayRouteReady.Type;

export const RelayRouteClose = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.route.close"),
  routeId: TrimmedNonEmptyString,
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type RelayRouteClose = typeof RelayRouteClose.Type;

export const RelayHandshakeInit = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.route.handshakeInit"),
  routeId: TrimmedNonEmptyString,
  ephemeralPublicKey: TrimmedNonEmptyString,
  handshakeNonce: TrimmedNonEmptyString,
});
export type RelayHandshakeInit = typeof RelayHandshakeInit.Type;

export const RelayHandshakeAck = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.route.handshakeAck"),
  routeId: TrimmedNonEmptyString,
  ephemeralPublicKey: TrimmedNonEmptyString,
  handshakeNonce: TrimmedNonEmptyString,
});
export type RelayHandshakeAck = typeof RelayHandshakeAck.Type;

export const RelayEncryptedFrame = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.encryptedFrame"),
  routeId: TrimmedNonEmptyString,
  keyEpoch: NonNegativeInt,
  sequence: NonNegativeInt,
  direction: Schema.Literals(["viewer_to_host", "host_to_viewer"]),
  ciphertext: TrimmedNonEmptyString,
  nonce: TrimmedNonEmptyString,
  sentAt: IsoDateTime,
});
export type RelayEncryptedFrame = typeof RelayEncryptedFrame.Type;

export const RelayPing = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.ping"),
  sentAt: IsoDateTime,
});
export type RelayPing = typeof RelayPing.Type;

export const RelayPong = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.pong"),
  sentAt: IsoDateTime,
});
export type RelayPong = typeof RelayPong.Type;

export const RelayError = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("relay.error"),
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  routeId: Schema.optional(TrimmedNonEmptyString),
});
export type RelayError = typeof RelayError.Type;

export const RelayEnvelope = Schema.Union([
  RelayClientHello,
  RelayRegisterHost,
  RelayRegisterViewer,
  RelayRouteOpen,
  RelayRouteRequest,
  RelayRouteReady,
  RelayRouteClose,
  RelayHandshakeInit,
  RelayHandshakeAck,
  RelayEncryptedFrame,
  RelayPing,
  RelayPong,
  RelayError,
]);
export type RelayEnvelope = typeof RelayEnvelope.Type;

export const RelayRegistrationSnapshot = Schema.Struct({
  relayUrl: TrimmedNonEmptyString,
  status: RelayRegistrationState,
  connectedAt: Schema.optional(IsoDateTime),
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type RelayRegistrationSnapshot = typeof RelayRegistrationSnapshot.Type;

export const ServerRelayStatus = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  defaultRelayUrl: TrimmedNonEmptyString,
  activeRelayLimit: NonNegativeInt,
  registrations: Schema.Array(RelayRegistrationSnapshot),
});
export type ServerRelayStatus = typeof ServerRelayStatus.Type;
