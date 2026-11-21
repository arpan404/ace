import { describe, expect, test } from "vitest";
import { ClientError } from "@ace/client";
import {
  connectionProblem,
  pairedCredential,
  pairingProblem,
  redeemedCredential,
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
function failing(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a failure");
}
async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected a failure");
}

// Swift makes the redemption request itself (ADR 0190 §7): the bridge holds neither the code nor
// the standing key, only the machine's answer or why the native transport refused it.
const answered = (status: number, body = "{}") => ({ status, body });

describe("pairing redemption", () => {
  test("the machine's answer yields the issued device identity", () => {
    const credential = redeemedCredential(answered(200, JSON.stringify({ device, token })));
    expect(credential.device.id).toBe("device-1");
    expect(credential.token).toBe(token);
  });

  test("an expired or already used code asks for a new link", () => {
    const error = failing(() =>
      redeemedCredential(answered(401, '{"error":"Invalid pairing code"}')),
    );
    expect(pairingProblem(error).code).toBe("expired");
  });

  test("remote access turned off and rate limits get their own guidance", () => {
    expect(pairingProblem(failing(() => redeemedCredential(answered(409)))).code).toBe("disabled");
    expect(pairingProblem(failing(() => redeemedCredential(answered(429)))).code).toBe("rate");
  });

  test("a changed TLS key reads as a pin mismatch, not as an expired link", () => {
    const trust = new TrustMonitor();
    const error = failing(() => redeemedCredential({ refused: "pin" }, trust));
    expect(pairingProblem(error, trust).code).toBe("pin");
  });

  test("a redirect refused by the native transport is reported as such", () => {
    const error = failing(() => redeemedCredential({ refused: "redirect" }));
    expect(pairingProblem(error).code).toBe("redirect");
  });

  test("an unreachable computer, or a refusal this build doesn't know, is unreachable", () => {
    for (const refused of ["offline", "something-new"]) {
      const error = failing(() => redeemedCredential({ refused }));
      expect(pairingProblem(error).code).toBe("unreachable");
    }
  });

  test("an answer that isn't a device credential pairs nothing", () => {
    const error = failing(() => redeemedCredential(answered(200, JSON.stringify({ device }))));
    expect(pairingProblem(error).code).toBe("unknown");
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
