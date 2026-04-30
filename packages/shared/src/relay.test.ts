import { describe, expect, it } from "vitest";
import { DEFAULT_MANAGED_RELAY_URL } from "@ace/contracts";

import {
  buildRelayConnectionUrl,
  createRelayRouteAuthProof,
  deriveRelayPairingAuthKey,
  parseRelayConnectionUrl,
  resolveConfiguredRelayWebSocketUrl,
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

    expect(parsed?.pairingAuthKey).toBe(pairingAuthKey);
    expect(parsed?.pairingSecret).toBeUndefined();
    expect(parsed?.hostName).toBe("Primary host");
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
});
