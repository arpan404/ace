import { describe, expect, it } from "vitest";
import { DEFAULT_MANAGED_RELAY_URL } from "@ace/contracts";

import {
  buildPublicRelayConnectionUrl,
  buildRelayConnectionUrl,
  createRelayEphemeralKeyPair,
  createRelayHandshakeNonce,
  createRelayRouteAuthProof,
  createRelayDeviceIdentity,
  deriveRelayRouteKeys,
  deriveRelayPairingAuthKey,
  parseRelayConnectionUrl,
  mergeRelayConnectionSecrets,
  resolveConfiguredRelayWebSocketUrl,
  splitRelayConnectionSecrets,
  validateRelayWebSocketUrl,
  verifyRelayRouteAuthProof,
} from "./relay";

describe("relay", () => {
  it("accepts secure relay URLs", () => {
    expect(validateRelayWebSocketUrl("wss://relay.example.com/v1/ws")).toBe(
      "wss://relay.example.com/v1/ws",
    );
  });

  it("rejects public insecure relay URLs", () => {
    expect(() => validateRelayWebSocketUrl("ws://relay.example.com/v1/ws")).toThrow(
      /Insecure relay URLs require/,
    );
  });

  it("allows localhost insecure relay URLs when explicitly enabled", () => {
    expect(
      validateRelayWebSocketUrl("ws://127.0.0.1:8788/v1/ws", {
        allowInsecureLocalUrls: true,
      }),
    ).toBe("ws://127.0.0.1:8788/v1/ws");
  });

  it("resolves relay URL precedence from explicit to env to settings to default", () => {
    expect(
      resolveConfiguredRelayWebSocketUrl({
        explicitRelayUrl: "wss://explicit.example.com/v1/ws",
        envRelayUrl: "wss://env.example.com/v1/ws",
        persistedRelayUrl: "wss://settings.example.com/v1/ws",
      }),
    ).toBe("wss://explicit.example.com/v1/ws");

    expect(
      resolveConfiguredRelayWebSocketUrl({
        envRelayUrl: "wss://env.example.com/v1/ws",
        persistedRelayUrl: "wss://settings.example.com/v1/ws",
      }),
    ).toBe("wss://env.example.com/v1/ws");

    expect(
      resolveConfiguredRelayWebSocketUrl({
        persistedRelayUrl: "wss://settings.example.com/v1/ws",
      }),
    ).toBe("wss://settings.example.com/v1/ws");

    expect(resolveConfiguredRelayWebSocketUrl()).toBe(DEFAULT_MANAGED_RELAY_URL);
  });

  it("builds relay metadata with a derived pairing auth key", () => {
    const pairingAuthKey = deriveRelayPairingAuthKey({
      pairingId: "session-1",
      pairingSecret: "secret-1",
      hostDeviceId: "host-device-1",
      hostIdentityPublicKey: "host-public-key-1",
      viewerDeviceId: "viewer-device-1",
      viewerIdentityPublicKey: "viewer-public-key-1",
    });
    const url = buildRelayConnectionUrl({
      version: 1,
      relayUrl: "wss://relay.example.com/v1/ws",
      hostDeviceId: "host-device-1",
      hostIdentityPublicKey: "host-public-key-1",
      pairingId: "session-1",
      pairingAuthKey,
      hostName: "Primary host",
    });
    const parsed = parseRelayConnectionUrl(url);
    const built = new URL(url);

    expect(built.searchParams.get("aceRelay")).toBeNull();
    expect(built.hash).toContain("aceRelay=");
    expect(parsed?.pairingAuthKey).toBe(pairingAuthKey);
    expect(parsed?.pairingSecret).toBeUndefined();
    expect(parsed?.hostName).toBe("Primary host");
  });

  it("parses legacy relay metadata from the query string for backward compatibility", () => {
    const legacyPayload = Buffer.from(
      JSON.stringify({
        version: 1,
        relayUrl: "wss://relay.example.com/v1/ws",
        hostDeviceId: "host-device-1",
        hostIdentityPublicKey: "host-public-key-1",
        pairingId: "session-1",
        pairingAuthKey: "pairing-auth-key-1",
      }),
      "utf8",
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const legacyUrl = `wss://relay.example.com/v1/ws?aceRelay=${legacyPayload}`;
    const parsed = parseRelayConnectionUrl(legacyUrl);

    expect(parsed).toMatchObject({
      version: 1,
      relayUrl: "wss://relay.example.com/v1/ws",
      hostDeviceId: "host-device-1",
      hostIdentityPublicKey: "host-public-key-1",
      pairingId: "session-1",
      pairingAuthKey: "pairing-auth-key-1",
    });
  });

  it("supports secretless relay metadata for public persistence", () => {
    const publicUrl = buildPublicRelayConnectionUrl({
      version: 1,
      relayUrl: "wss://relay.example.com/v1/ws",
      hostDeviceId: "host-device-1",
      hostIdentityPublicKey: "host-public-key-1",
      pairingId: "session-1",
      hostName: "Primary host",
    });

    expect(parseRelayConnectionUrl(publicUrl)).toEqual({
      version: 1,
      relayUrl: "wss://relay.example.com/v1/ws",
      hostDeviceId: "host-device-1",
      hostIdentityPublicKey: "host-public-key-1",
      pairingId: "session-1",
      hostName: "Primary host",
    });
  });

  it("splits relay secrets from persisted connection metadata and merges them back", () => {
    const fullUrl = buildRelayConnectionUrl({
      version: 1,
      relayUrl: "wss://relay.example.com/v1/ws",
      hostDeviceId: "host-device-1",
      hostIdentityPublicKey: "host-public-key-1",
      pairingId: "session-1",
      pairingAuthKey: "pairing-auth-key-1",
      hostName: "Primary host",
    });

    const split = splitRelayConnectionSecrets(fullUrl);
    expect(split.storageKey).toBe(
      "wss://relay.example.com/v1/ws\u0000host-device-1\u0000session-1",
    );
    expect(split.secrets).toEqual({
      pairingAuthKey: "pairing-auth-key-1",
    });
    expect(parseRelayConnectionUrl(split.connectionUrl)).toEqual({
      version: 1,
      relayUrl: "wss://relay.example.com/v1/ws",
      hostDeviceId: "host-device-1",
      hostIdentityPublicKey: "host-public-key-1",
      pairingId: "session-1",
      hostName: "Primary host",
    });
    expect(mergeRelayConnectionSecrets(split.connectionUrl, split.secrets)).toBe(fullUrl);
  });

  it("verifies relay route auth proofs and rejects stale ones", () => {
    const pairingAuthKey = deriveRelayPairingAuthKey({
      pairingId: "session-1",
      pairingSecret: "secret-1",
      hostDeviceId: "host-device-1",
      hostIdentityPublicKey: "host-public-key-1",
      viewerDeviceId: "viewer-device-1",
      viewerIdentityPublicKey: "viewer-public-key-1",
    });
    const issuedAt = "2026-04-30T12:00:00.000Z";
    const proof = createRelayRouteAuthProof({
      pairingAuthKey,
      routeId: "route-1",
      clientSessionId: "client-session-1",
      connectionId: "connection-1",
      viewerDeviceId: "viewer-device-1",
      viewerIdentityPublicKey: "viewer-public-key-1",
      issuedAt,
    });

    expect(
      verifyRelayRouteAuthProof({
        pairingAuthKey,
        routeId: "route-1",
        clientSessionId: "client-session-1",
        connectionId: "connection-1",
        viewerDeviceId: "viewer-device-1",
        viewerIdentityPublicKey: "viewer-public-key-1",
        issuedAt,
        proof,
        nowMs: Date.parse("2026-04-30T12:00:30.000Z"),
      }),
    ).toBe(true);

    expect(
      verifyRelayRouteAuthProof({
        pairingAuthKey,
        routeId: "route-1",
        clientSessionId: "client-session-1",
        connectionId: "connection-1",
        viewerDeviceId: "viewer-device-1",
        viewerIdentityPublicKey: "viewer-public-key-1",
        issuedAt,
        proof,
        nowMs: Date.parse("2026-04-30T12:05:00.000Z"),
      }),
    ).toBe(false);
  });

  it("derives matching session keys for host and viewer", () => {
    const viewerIdentity = createRelayDeviceIdentity("2026-04-30T00:00:00.000Z");
    const hostIdentity = createRelayDeviceIdentity("2026-04-30T00:00:00.000Z");
    const viewerEphemeral = createRelayEphemeralKeyPair();
    const hostEphemeral = createRelayEphemeralKeyPair();
    const viewerNonce = createRelayHandshakeNonce();
    const hostNonce = createRelayHandshakeNonce();

    const viewerKeys = deriveRelayRouteKeys({
      relayUrl: "wss://relay.example.com/v1/ws",
      routeId: "route-1",
      hostDeviceId: hostIdentity.deviceId,
      viewerDeviceId: viewerIdentity.deviceId,
      localRole: "viewer",
      localStaticSecretKey: viewerIdentity.secretKey,
      localEphemeralSecretKey: viewerEphemeral.secretKey,
      remoteStaticPublicKey: hostIdentity.publicKey,
      remoteEphemeralPublicKey: hostEphemeral.publicKey,
      localHandshakeNonce: viewerNonce,
      remoteHandshakeNonce: hostNonce,
    });
    const hostKeys = deriveRelayRouteKeys({
      relayUrl: "wss://relay.example.com/v1/ws",
      routeId: "route-1",
      hostDeviceId: hostIdentity.deviceId,
      viewerDeviceId: viewerIdentity.deviceId,
      localRole: "host",
      localStaticSecretKey: hostIdentity.secretKey,
      localEphemeralSecretKey: hostEphemeral.secretKey,
      remoteStaticPublicKey: viewerIdentity.publicKey,
      remoteEphemeralPublicKey: viewerEphemeral.publicKey,
      localHandshakeNonce: hostNonce,
      remoteHandshakeNonce: viewerNonce,
    });

    expect(Array.from(viewerKeys.sendKey)).toEqual(Array.from(hostKeys.receiveKey));
    expect(Array.from(viewerKeys.receiveKey)).toEqual(Array.from(hostKeys.sendKey));
    expect(Array.from(viewerKeys.exporterKey)).toEqual(Array.from(hostKeys.exporterKey));
  });
});
