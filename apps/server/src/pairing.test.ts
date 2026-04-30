import { createRelayRouteAuthProof, deriveRelayPairingAuthKey } from "@ace/shared/relay";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetPairingStoreForTests,
  approveRelayPairingRequest,
  createPairingSession,
  persistPairingSessionsToDatabase,
} from "./pairing";

describe("pairing relay auth hardening", () => {
  beforeEach(() => {
    __resetPairingStoreForTests();
  });

  it("persists a derived relay auth key and clears the bootstrap secret after approval", async () => {
    const created = createPairingSession({
      relayUrl: "wss://relay.example.com/v1/ws",
      hostDeviceId: "host-device-1",
      hostIdentityPublicKey: "host-public-key-1",
      name: "Primary host",
      nowMs: Date.parse("2026-04-30T12:00:00.000Z"),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const pairingAuthKey = deriveRelayPairingAuthKey({
      pairingId: created.value.sessionId,
      pairingSecret: created.value.secret,
      hostDeviceId: "host-device-1",
      hostIdentityPublicKey: "host-public-key-1",
      viewerDeviceId: "viewer-device-1",
      viewerIdentityPublicKey: "viewer-public-key-1",
    });
    const routeAuthIssuedAt = "2026-04-30T12:00:30.000Z";
    const routeAuthProof = createRelayRouteAuthProof({
      pairingAuthKey,
      routeId: "route-1",
      clientSessionId: "client-session-1",
      connectionId: "connection-1",
      viewerDeviceId: "viewer-device-1",
      viewerIdentityPublicKey: "viewer-public-key-1",
      issuedAt: routeAuthIssuedAt,
    });

    const approved = approveRelayPairingRequest({
      sessionId: created.value.sessionId,
      viewerDeviceId: "viewer-device-1",
      viewerIdentityPublicKey: "viewer-public-key-1",
      routeId: "route-1",
      clientSessionId: "client-session-1",
      connectionId: "connection-1",
      routeAuthIssuedAt,
      routeAuthProof,
      requesterName: "Remote device",
      nowMs: Date.parse("2026-04-30T12:00:31.000Z"),
    });
    expect(approved.ok).toBe(true);

    const upserts: Array<{
      readonly secret: string;
      readonly relayAuthKey: string | null;
      readonly viewerDeviceId: string | null;
    }> = [];
    await persistPairingSessionsToDatabase({
      upsert: (session) =>
        Effect.sync(() => {
          upserts.push({
            secret: session.secret,
            relayAuthKey: session.relayAuthKey,
            viewerDeviceId: session.viewerDeviceId,
          });
        }),
    });

    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.secret).toBe("");
    expect(upserts[0]?.relayAuthKey).toBe(pairingAuthKey);
    expect(upserts[0]?.viewerDeviceId).toBe("viewer-device-1");
  });

  it("rejects relay route authorization from a different viewer device after binding", () => {
    const created = createPairingSession({
      relayUrl: "wss://relay.example.com/v1/ws",
      hostDeviceId: "host-device-1",
      hostIdentityPublicKey: "host-public-key-1",
      nowMs: Date.parse("2026-04-30T12:00:00.000Z"),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const pairingAuthKey = deriveRelayPairingAuthKey({
      pairingId: created.value.sessionId,
      pairingSecret: created.value.secret,
      hostDeviceId: "host-device-1",
      hostIdentityPublicKey: "host-public-key-1",
      viewerDeviceId: "viewer-device-1",
      viewerIdentityPublicKey: "viewer-public-key-1",
    });
    const approved = approveRelayPairingRequest({
      sessionId: created.value.sessionId,
      viewerDeviceId: "viewer-device-1",
      viewerIdentityPublicKey: "viewer-public-key-1",
      routeId: "route-1",
      clientSessionId: "client-session-1",
      connectionId: "connection-1",
      routeAuthIssuedAt: "2026-04-30T12:00:30.000Z",
      routeAuthProof: createRelayRouteAuthProof({
        pairingAuthKey,
        routeId: "route-1",
        clientSessionId: "client-session-1",
        connectionId: "connection-1",
        viewerDeviceId: "viewer-device-1",
        viewerIdentityPublicKey: "viewer-public-key-1",
        issuedAt: "2026-04-30T12:00:30.000Z",
      }),
      nowMs: Date.parse("2026-04-30T12:00:31.000Z"),
    });
    expect(approved.ok).toBe(true);

    const otherViewerAuthKey = deriveRelayPairingAuthKey({
      pairingId: created.value.sessionId,
      pairingSecret: created.value.secret,
      hostDeviceId: "host-device-1",
      hostIdentityPublicKey: "host-public-key-1",
      viewerDeviceId: "viewer-device-2",
      viewerIdentityPublicKey: "viewer-public-key-2",
    });
    const rejected = approveRelayPairingRequest({
      sessionId: created.value.sessionId,
      viewerDeviceId: "viewer-device-2",
      viewerIdentityPublicKey: "viewer-public-key-2",
      routeId: "route-2",
      clientSessionId: "client-session-2",
      connectionId: "connection-2",
      routeAuthIssuedAt: "2026-04-30T12:00:35.000Z",
      routeAuthProof: createRelayRouteAuthProof({
        pairingAuthKey: otherViewerAuthKey,
        routeId: "route-2",
        clientSessionId: "client-session-2",
        connectionId: "connection-2",
        viewerDeviceId: "viewer-device-2",
        viewerIdentityPublicKey: "viewer-public-key-2",
        issuedAt: "2026-04-30T12:00:35.000Z",
      }),
      nowMs: Date.parse("2026-04-30T12:00:36.000Z"),
    });

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.code).toBe("already-claimed");
    }
  });
});
