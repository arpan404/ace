import { expect, it } from "vitest";
import { ClientError } from "@ace/client";
import {
  createPairingTransport,
  unavailablePairingTransport,
  type PinnedHttpBinding,
} from "./pairing-transport.ts";
import type { PinnedRequest, PinnedResponse } from "../security/pinned-transport.ts";
import { PinnedTransportError } from "../security/pinned-transport.ts";
import { preparePairing, redeemConfirmedPairing, PairingFlowError } from "./pairing-flow.ts";
import { PAIRING_UNAVAILABLE_MESSAGE } from "./pairing-view.ts";

const PIN = "9f".repeat(32);
const TOKEN = "e0".repeat(32);
const LINK = `https://192.168.1.20:4243/pair#code=abc123&fingerprint=${PIN}&scopes=read,operate`;

function credentialBody(): string {
  return JSON.stringify({
    device: {
      id: "device-1",
      name: "My phone",
      scopes: ["read", "operate"],
      createdAt: 1,
      lastSeenAt: 1,
      revokedAt: null,
    },
    token: TOKEN,
  });
}

function identityBody(): string {
  return JSON.stringify({ hostId: "host-1", displayName: "Studio", version: "1.0" });
}

interface RedeemCall {
  binding: PinnedHttpBinding;
  request: PinnedRequest;
}

function fakeBinding(response: PinnedResponse | Error): {
  calls: RedeemCall[];
  bindings: PinnedHttpBinding[];
  deps: Parameters<typeof createPairingTransport>[0];
} {
  const calls: RedeemCall[] = [];
  const bindings: PinnedHttpBinding[] = [];
  return {
    calls,
    bindings,
    deps: {
      httpFor: (binding: PinnedHttpBinding) => {
        bindings.push(binding);
        return async (request: PinnedRequest): Promise<PinnedResponse> => {
          calls.push({ binding, request });
          if (response instanceof Error) throw response;
          return response;
        };
      },
      readIdentity: async () => JSON.parse(identityBody()) as unknown,
    },
  };
}

it("posts the code only in the POST body to /v1/pair on the bound origin", async () => {
  const fake = fakeBinding({ status: 200, body: credentialBody() });
  const transport = createPairingTransport(fake.deps);
  const confirmed = preparePairing(LINK);
  await redeemConfirmedPairing(confirmed, "My phone", transport);
  expect(fake.bindings).toHaveLength(1);
  expect(fake.bindings[0]).toEqual({ origin: "https://192.168.1.20:4243/", fingerprint: PIN });
  expect(fake.calls).toHaveLength(1);
  const call = fake.calls[0];
  expect(call).toBeDefined();
  if (!call) return;
  expect(call.request.method).toBe("POST");
  expect(call.request.path).toBe("/v1/pair");
  expect(call.binding.origin).not.toContain("#");
  expect(call.binding.origin).not.toContain("abc123");
  const body = JSON.parse(call.request.body ?? "{}") as Record<string, unknown>;
  expect(body).toEqual({ code: "abc123", name: "My phone" });
});

it("binds the authenticated host identity instead of the link hostname", async () => {
  const fake = fakeBinding({ status: 200, body: credentialBody() });
  const transport = createPairingTransport({
    ...fake.deps,
    readIdentity: async () => ({ hostId: "stable-host-id", displayName: "X", version: "1" }),
  });
  const paired = await redeemConfirmedPairing(preparePairing(LINK), "My phone", transport);
  expect(paired.identity.hostId).toBe("stable-host-id");
  expect(paired.target).toEqual({
    kind: "direct",
    url: "wss://192.168.1.20:4243/",
    fingerprint: PIN,
  });
});

it("refuses before the native bridge is touched when the pin is malformed", async () => {
  const fake = fakeBinding({ status: 200, body: credentialBody() });
  const transport = createPairingTransport(fake.deps);
  const confirmed = preparePairing(LINK);
  const tampered = { ...confirmed, link: { ...confirmed.link, fingerprint: "not-a-pin" } };
  await expect(redeemConfirmedPairing(tampered, "My phone", transport)).rejects.toMatchObject({
    failure: "invalid-link",
  });
  expect(fake.bindings).toHaveLength(0);
  expect(fake.calls).toHaveLength(0);
});

it("rejects an empty device name before the native bridge is touched", async () => {
  const fake = fakeBinding({ status: 200, body: credentialBody() });
  const transport = createPairingTransport(fake.deps);
  await expect(
    redeemConfirmedPairing(preparePairing(LINK), "   ", transport),
  ).rejects.toMatchObject({ failure: "invalid-name" });
  expect(fake.bindings).toHaveLength(0);
});

it("maps a pin refusal to an auth failure that sends nothing", async () => {
  // createPinnedHttp-bound functions throw typed PinnedTransportErrors, so
  // the fake mirrors that contract (raw native errors never reach accessJson).
  const fake = fakeBinding(new PinnedTransportError("pin"));
  const transport = createPairingTransport(fake.deps);
  try {
    await redeemConfirmedPairing(preparePairing(LINK), "My phone", transport);
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(PairingFlowError);
    expect((error as PairingFlowError).failure).toBe("auth");
    expect((error as Error).message).not.toContain("abc123");
    expect((error as Error).message).not.toContain(PIN);
  }
  expect(fake.calls).toHaveLength(1);
});

it("maps a redirect refusal to a daemon failure", async () => {
  const fake = fakeBinding(new PinnedTransportError("redirect"));
  const transport = createPairingTransport(fake.deps);
  await expect(
    redeemConfirmedPairing(preparePairing(LINK), "My phone", transport),
  ).rejects.toMatchObject({ failure: "daemon" });
});

it("maps HTTP statuses the way the SDK access policy does", async () => {
  const refused = fakeBinding({ status: 401, body: '{"error":"Expired pairing"}' });
  await expect(
    redeemConfirmedPairing(preparePairing(LINK), "My phone", createPairingTransport(refused.deps)),
  ).rejects.toMatchObject({ failure: "auth" });
  const throttled = fakeBinding({ status: 429, body: "{}" });
  await expect(
    redeemConfirmedPairing(
      preparePairing(LINK),
      "My phone",
      createPairingTransport(throttled.deps),
    ),
  ).rejects.toMatchObject({ failure: "offline" });
});

it("marks an unreadable credential reply as consumed so the dead link is never retried", async () => {
  const fake = fakeBinding({ status: 200, body: '{"device":null}' });
  const transport = createPairingTransport(fake.deps);
  await expect(
    redeemConfirmedPairing(preparePairing(LINK), "My phone", transport),
  ).rejects.toMatchObject({ failure: "consumed" });
});

it("marks a post-redeem identity failure as consumed instead of retrying a burned code", async () => {
  const fake = fakeBinding({ status: 200, body: credentialBody() });
  const transport = createPairingTransport({
    ...fake.deps,
    readIdentity: async () => {
      throw new ClientError("offline", "down");
    },
  });
  await expect(
    redeemConfirmedPairing(preparePairing(LINK), "My phone", transport),
  ).rejects.toMatchObject({ failure: "consumed" });
});

it("validates the pin before delegating the identity read", async () => {
  let delegated = 0;
  const transport = createPairingTransport({
    httpFor: () => {
      throw new Error("must not redeem in this test");
    },
    readIdentity: async () => {
      delegated += 1;
      return {};
    },
  });
  await expect(
    transport.readIdentity({ origin: "https://192.168.1.20:4243/", fingerprint: "bad" }),
  ).rejects.toMatchObject({ failure: "invalid-link" });
  expect(delegated).toBe(0);
});

it("sends nothing when already aborted before redemption", async () => {
  let bindings = 0;
  const transport = createPairingTransport({
    httpFor: () => {
      bindings += 1;
      throw new Error("must not touch the bridge when already aborted");
    },
    readIdentity: async () => ({}),
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    redeemConfirmedPairing(preparePairing(LINK), "My phone", transport, controller.signal),
  ).rejects.toMatchObject({ failure: "daemon" });
  expect(bindings).toBe(0);
});

it("treats an abort racing redemption as consumed since the code may be burned", async () => {
  const calls: PinnedRequest[] = [];
  const transport = createPairingTransport({
    httpFor:
      () =>
      async (request: PinnedRequest): Promise<PinnedResponse> => {
        calls.push(request);
        return new Promise<PinnedResponse>(() => {});
      },
    readIdentity: async () => ({}),
  });
  const controller = new AbortController();
  const pending = redeemConfirmedPairing(
    preparePairing(LINK),
    "My phone",
    transport,
    controller.signal,
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ failure: "consumed" });
  expect(calls).toHaveLength(1);
});

it("does not start the identity read when already aborted", async () => {
  let delegated = 0;
  const transport = createPairingTransport({
    httpFor: () => {
      throw new Error("must not redeem in this test");
    },
    readIdentity: async () => {
      delegated += 1;
      return {};
    },
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    transport.readIdentity({
      origin: "https://192.168.1.20:4243/",
      fingerprint: PIN,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(delegated).toBe(0);
});

it("stays fail-closed without wiring: the unavailable transport sends nothing", async () => {
  const transport = unavailablePairingTransport();
  const confirmed = preparePairing(LINK);
  try {
    await redeemConfirmedPairing(confirmed, "My phone", transport);
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(PairingFlowError);
    expect((error as PairingFlowError).failure).toBe("daemon");
    expect((error as Error).message).toBe(PAIRING_UNAVAILABLE_MESSAGE);
  }
  await expect(
    transport.readIdentity({ origin: "https://192.168.1.20:4243/", fingerprint: PIN }),
  ).rejects.toMatchObject({ failure: "daemon" });
});
