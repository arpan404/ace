import { describe, expect, test } from "vitest";
import { ClientError } from "@ace/client";
import {
  connectionProblem,
  pairedCredential,
  pairingProblem,
  redeemPairing,
  TrustMonitor,
  type PinnedRequest,
} from "./access.ts";

const token = "a".repeat(64);
const device = {
  id: "device-1",
  name: "Arpan's iPhone",
  scopes: ["read", "operate"],
  createdAt: 1,
  lastSeenAt: 1,
  revokedAt: null,
};

function recorder(reply: (request: PinnedRequest) => { status: number; body: string } | Error) {
  const requests: PinnedRequest[] = [];
  const http = async (request: PinnedRequest) => {
    requests.push(request);
    const value = reply(request);
    if (value instanceof Error) throw value;
    return value;
  };
  return { http, requests };
}
async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected a failure");
}

describe("pairing redemption", () => {
  test("the code travels only in the POST body and yields the issued device identity", async () => {
    const code = "c0de".repeat(16);
    const { http, requests } = recorder(() => ({
      status: 200,
      body: JSON.stringify({ device, token }),
    }));
    const credential = await redeemPairing(http, code, "Arpan's iPhone");
    expect(credential.device.id).toBe("device-1");
    expect(credential.token).toBe(token);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/v1/pair");
    expect(requests[0]?.path).not.toContain(code);
    expect(requests[0]?.token).toBeUndefined();
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({ code, name: "Arpan's iPhone" });
  });

  test("an expired or already used code asks for a new link", async () => {
    const { http } = recorder(() => ({ status: 401, body: '{"error":"Invalid pairing code"}' }));
    const error = await failure(redeemPairing(http, "used", "Phone"));
    expect(pairingProblem(error).code).toBe("expired");
  });

  test("remote access turned off and rate limits get their own guidance", async () => {
    const off = await failure(
      redeemPairing(recorder(() => ({ status: 409, body: "{}" })).http, "c", "n"),
    );
    const busy = await failure(
      redeemPairing(recorder(() => ({ status: 429, body: "{}" })).http, "c", "n"),
    );
    expect(pairingProblem(off).code).toBe("disabled");
    expect(pairingProblem(busy).code).toBe("rate");
  });

  test("a changed TLS key reads as a pin mismatch, not as an expired link", async () => {
    const trust = new TrustMonitor();
    const { http } = recorder(() => new Error("pin"));
    const error = await failure(redeemPairing(http, "code", "Phone", trust));
    expect(pairingProblem(error, trust).code).toBe("pin");
  });

  test("a redirect refused by the native transport is reported as such", async () => {
    const error = await failure(
      redeemPairing(recorder(() => new Error("redirect")).http, "c", "n"),
    );
    expect(pairingProblem(error).code).toBe("redirect");
  });

  test("an unreachable computer is reported as unreachable", async () => {
    const error = await failure(redeemPairing(recorder(() => new Error("offline")).http, "c", "n"));
    expect(pairingProblem(error).code).toBe("unreachable");
  });
});

describe("socket credentials for a paired device", () => {
  test("every connection attempt exchanges the stored token for a fresh ticket", async () => {
    let issued = 0;
    const { http, requests } = recorder(() => ({
      status: 200,
      body: JSON.stringify({ ticket: String(++issued).repeat(64), expiresAt: 60_000 }),
    }));
    const credential = pairedCredential(http, async () => token);
    const first = await credential();
    const second = await credential();
    expect(first.ticket).not.toBe(second.ticket);
    expect(requests.map((request) => [request.method, request.path, request.token])).toEqual([
      ["POST", "/v1/tickets", token],
      ["POST", "/v1/tickets", token],
    ]);
  });

  test("an unreachable host stays retryable so the SDK reconnects", async () => {
    const credential = pairedCredential(
      recorder(() => new Error("offline")).http,
      async () => token,
    );
    const error = await failure(credential());
    expect(error).toBeInstanceOf(ClientError);
    expect(error instanceof ClientError && error.code).toBe("offline");
    expect(connectionProblem("reconnecting", undefined)?.code).toBe("unreachable");
  });

  test("a revoked device is fatal and asks to pair again", async () => {
    const credential = pairedCredential(
      recorder(() => ({ status: 401, body: '{"error":"unauthorized"}' })).http,
      async () => token,
    );
    const error = await failure(credential());
    expect(error instanceof ClientError && error.code).toBe("auth");
    expect(connectionProblem("fatal", new ClientError("auth"))?.code).toBe("revoked");
  });

  test("a pin failure during the ticket exchange is not mistaken for revocation", async () => {
    const trust = new TrustMonitor();
    const credential = pairedCredential(
      recorder(() => new Error("pin")).http,
      async () => token,
      trust,
    );
    await failure(credential());
    expect(connectionProblem("fatal", new ClientError("auth"), trust)?.code).toBe("pin");
  });

  test("a missing Keychain token fails without any network request", async () => {
    const { http, requests } = recorder(() => ({ status: 200, body: "{}" }));
    const credential = pairedCredential(http, async () => "");
    const error = await failure(credential());
    expect(error instanceof ClientError && error.code).toBe("auth");
    expect(requests).toHaveLength(0);
  });

  test("a ready connection has no problem to show", () => {
    expect(connectionProblem("ready", undefined)).toBeNull();
    expect(connectionProblem("offline", undefined)?.code).toBe("offline");
  });
});
