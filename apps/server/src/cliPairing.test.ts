import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CliPairingCommandError,
  createCliPairingSession,
  listCliPairingSessions,
  revokeCliPairingSession,
} from "./cliPairing";

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("cliPairing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates pairing links from host pairing endpoints", async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/api/pairing/sessions") && init?.method === "POST") {
        return jsonResponse(200, {
          sessionId: "session-1",
          name: "Workstation",
          createdAt: "2026-04-15T22:59:00.000Z",
          status: "waiting-claim",
          expiresAt: "2026-04-15T23:00:00.000Z",
          secret: "secret-1",
          claimUrl: "https://host.example/api/pairing/claims",
          pollingUrl: "https://host.example/api/pairing/sessions/session-1",
        });
      }
      if (input.includes("/api/pairing/advertised-endpoint") && init?.method === "GET") {
        return jsonResponse(200, {
          wsUrl: "ws://192.168.1.10:3773/ws",
        });
      }
      return jsonResponse(404, { error: "Unexpected URL" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const created = await createCliPairingSession({
      wsUrl: "http://localhost:3773",
      authToken: "token-1",
      name: "Workstation",
    });

    expect(created.sessionId).toBe("session-1");
    expect(created.advertisedWsUrl).toBe("ws://192.168.1.10:3773/ws");
    expect(created.connectionString.startsWith("ace://pair?p=")).toBe(true);
    const encoded = new URL(created.connectionString).searchParams.get("p");
    expect(encoded).toBeTruthy();
    const decoded = Buffer.from(encoded ?? "", "base64url").toString("utf8");
    expect(decoded).toContain('"name":"Workstation"');
    expect(decoded).toContain('"wsUrl":"ws://192.168.1.10:3773/ws"');
  });

  it("revokes pairing sessions", async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/api/pairing/sessions/session-1/revoke") && init?.method === "POST") {
        return jsonResponse(200, {
          sessionId: "session-1",
          name: "Workstation",
          createdAt: "2026-04-15T22:59:00.000Z",
          status: "rejected",
          expiresAt: "2026-04-15T23:00:00.000Z",
        });
      }
      return jsonResponse(404, { error: "Unexpected URL" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const revoked = await revokeCliPairingSession({
      wsUrl: "ws://host.example:3773/ws",
      authToken: "token-1",
      sessionId: "session-1",
    });

    expect(revoked.status).toBe("rejected");
    expect(revoked.sessionId).toBe("session-1");
  });

  it("lists pairing sessions", async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/api/pairing/sessions") && init?.method === "GET") {
        return jsonResponse(200, [
          {
            sessionId: "session-1",
            name: "Workstation",
            createdAt: "2026-04-15T22:59:00.000Z",
            status: "approved",
            expiresAt: "2026-04-15T23:00:00.000Z",
            requesterName: "Arpan Laptop",
            claimId: "claim-1",
          },
        ]);
      }
      return jsonResponse(404, { error: "Unexpected URL" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const sessions = await listCliPairingSessions({
      wsUrl: "ws://host.example:3773/ws",
      authToken: "token-1",
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual({
      sessionId: "session-1",
      name: "Workstation",
      createdAt: "2026-04-15T22:59:00.000Z",
      status: "approved",
      expiresAt: "2026-04-15T23:00:00.000Z",
      requesterName: "Arpan Laptop",
      claimId: "claim-1",
    });
  });

  it("surfaces server pairing errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: "Unauthorized pairing request." })),
    );

    await expect(
      createCliPairingSession({
        wsUrl: "ws://host.example:3773/ws",
        name: "Host",
      }),
    ).rejects.toEqual(
      new CliPairingCommandError({
        message: "Unauthorized pairing request.",
      }),
    );
  });
});
