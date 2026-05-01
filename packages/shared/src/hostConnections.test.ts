import { describe, expect, it } from "vitest";

import {
  buildRelayHostConnectionDraft,
  describeHostConnection,
  parseHostConnectionQrPayload,
  parseHostDraftFromQrPayload,
  requestPairingClaim,
  resolveHostDisplayName,
  waitForPairingApproval,
  type PairingClaimReceipt,
} from "./hostConnections";

function mockResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

function encodeBase64UrlUtf8(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

describe("hostConnections", () => {
  it("parses legacy direct host payloads", () => {
    const direct = parseHostConnectionQrPayload("ws://localhost:3773/ws?token=abc");
    expect(direct).toEqual({
      kind: "direct",
      draft: {
        wsUrl: "ws://localhost:3773/ws?token=abc",
      },
    });
    expect(parseHostDraftFromQrPayload("localhost:3773")).toEqual({
      wsUrl: "localhost:3773",
    });
  });

  it("rejects legacy JSON payloads", () => {
    const parsed = parseHostConnectionQrPayload(
      JSON.stringify({
        wsUrl: "ws://localhost:3773/ws",
        token: "abc",
      }),
    );
    expect(parsed).toBeNull();
  });

  it("parses encoded pairing payloads", () => {
    const encoded = encodeBase64UrlUtf8(
      JSON.stringify({
        name: "Primary host",
        wsUrl: "ws://192.168.0.12:3773/ws",
        sessionId: "session-1",
        secret: "secret-1",
        claimUrl: "https://example.com/api/pairing/claims",
      }),
    );
    const parsed = parseHostConnectionQrPayload(`ace://pair?p=${encoded}`);
    expect(parsed).toEqual({
      kind: "pairing",
      pairing: {
        name: "Primary host",
        wsUrl: "ws://192.168.0.12:3773/ws",
        sessionId: "session-1",
        secret: "secret-1",
        claimUrl: "https://example.com/api/pairing/claims",
      },
    });
  });

  it("parses relay pairing payloads", () => {
    const encoded = encodeBase64UrlUtf8(
      JSON.stringify({
        name: "Primary host",
        relayUrl: "wss://relay.example.com/v1/ws",
        hostDeviceId: "host-device-1",
        hostIdentityPublicKey: "host-public-key-1",
        sessionId: "session-1",
        secret: "secret-1",
        expiresAt: "2026-05-01T00:00:00.000Z",
      }),
    );
    const parsed = parseHostConnectionQrPayload(`ace://pair?p=${encoded}`);
    expect(parsed).toEqual({
      kind: "pairing",
      pairing: {
        name: "Primary host",
        relayUrl: "wss://relay.example.com/v1/ws",
        hostDeviceId: "host-device-1",
        hostIdentityPublicKey: "host-public-key-1",
        sessionId: "session-1",
        secret: "secret-1",
        expiresAt: "2026-05-01T00:00:00.000Z",
      },
    });
  });

  it("describes relay-backed connections with relay metadata", () => {
    const draft = buildRelayHostConnectionDraft({
      pairing: {
        name: "Primary host",
        relayUrl: "wss://relay.example.com/v1/ws",
        hostDeviceId: "host-device-1",
        hostIdentityPublicKey: "host-public-key-1",
        sessionId: "session-1",
        secret: "secret-1",
      },
      viewerIdentity: {
        deviceId: "viewer-device-1",
        publicKey: "viewer-public-key-1",
      },
    });
    const descriptor = describeHostConnection({ wsUrl: draft.wsUrl });

    expect(descriptor.kind).toBe("relay");
    expect(descriptor.summary).toBe("Relay via relay.example.com");
    expect(descriptor.detail).toBe("Host host-device-1");
    expect(descriptor.selectorValues).toContain("relay.example.com");
    expect(resolveHostDisplayName(undefined, descriptor.connectionUrl)).toBe("ace @ Primary host");
  });

  it("requests claim and waits for pairing approval", async () => {
    const pairing = {
      wsUrl: "ws://192.168.0.12:3773/ws",
      sessionId: "session-1",
      secret: "secret-1",
      claimUrl: "https://example.com/api/pairing/claims",
    } as const;
    let pollCount = 0;
    const fetch = async (input: string, init?: { method?: string; body?: string }) => {
      if (input === pairing.claimUrl && init?.method === "POST") {
        return mockResponse(200, {
          claimId: "claim-1",
          pollUrl: "https://example.com/api/pairing/claims/claim-1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      if (input === "https://example.com/api/pairing/claims/claim-1") {
        pollCount += 1;
        if (pollCount < 2) {
          return mockResponse(200, {
            claimId: "claim-1",
            status: "pending",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        }
        return mockResponse(200, {
          claimId: "claim-1",
          status: "approved",
          host: {
            name: "Primary host",
            wsUrl: "ws://192.168.0.12:3773/ws",
            authToken: "secret-token",
          },
        });
      }
      return mockResponse(404, {
        error: "Unexpected URL",
      });
    };
    const receipt = await requestPairingClaim(pairing, { fetch, requesterName: "ace mobile" });
    expect(receipt.claimId).toBe("claim-1");
    const hostDraft = await waitForPairingApproval(receipt as PairingClaimReceipt, {
      fetch,
      pollIntervalMs: 1,
      timeoutMs: 2_000,
    });
    expect(hostDraft).toEqual({
      name: "Primary host",
      wsUrl: "ws://192.168.0.12:3773/ws",
      authToken: "secret-token",
    });
  });
});
