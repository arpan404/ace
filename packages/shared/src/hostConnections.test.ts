import { describe, expect, it } from "vitest";

import {
  buildPairingPayload,
  parseHostConnectionQrPayload,
  parseHostDraftFromQrPayload,
  requestPairingClaim,
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

  it("builds and parses pairing payloads", () => {
    const payload = buildPairingPayload({
      name: "Primary host",
      sessionId: "session-123",
      secret: "secret-456",
      claimUrl: "https://example.com/api/pairing/claims",
    });
    const parsed = parseHostConnectionQrPayload(payload);
    expect(parsed).toEqual({
      kind: "pairing",
      pairing: {
        name: "Primary host",
        sessionId: "session-123",
        secret: "secret-456",
        claimUrl: "https://example.com/api/pairing/claims",
      },
    });
  });

  it("requests claim and waits for pairing approval", async () => {
    const pairing = {
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
