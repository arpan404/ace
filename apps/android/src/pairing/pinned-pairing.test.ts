import { expect, it } from "vitest";
import { preparePairing, redeemConfirmedPairing } from "./pairing-flow.ts";
import { createPinnedPairingTransport } from "./pinned-pairing.ts";
import type { ExpoPinnedBridge } from "../security/expo-bridge.ts";

const PIN = "9f".repeat(32);
const TOKEN = "e0".repeat(32);
const LINK = `https://192.168.1.20:4243/pair#code=abc123&fingerprint=${PIN}&scopes=read,operate`;
const ORIGIN = "https://192.168.1.20:4243/";

function credential() {
  return {
    device: {
      id: "device-1",
      name: "My phone",
      scopes: ["read", "operate"],
      createdAt: 1,
      lastSeenAt: 1,
      revokedAt: null,
    },
    token: TOKEN,
  };
}

function identity() {
  return { hostId: "host-1", displayName: "Studio", version: "1.0" };
}

function bridge(
  hooks: {
    fetch?: (input: {
      origin: string;
      fingerprint: string;
      method: string;
      path: string;
      body?: string | undefined;
      token?: string | undefined;
    }) => Promise<{ status: number; body: string }>;
  } = {},
): ExpoPinnedBridge & {
  fetched: {
    origin: string;
    fingerprint: string;
    method: string;
    path: string;
    body?: string | undefined;
    token?: string | undefined;
  }[];
} {
  const fetched: {
    origin: string;
    fingerprint: string;
    method: string;
    path: string;
    body?: string | undefined;
    token?: string | undefined;
  }[] = [];
  return {
    fetched,
    pinnedFetch: async (input) => {
      fetched.push(input);
      if (hooks.fetch !== undefined) return hooks.fetch(input);
      return { status: 200, body: JSON.stringify(credential()) };
    },
    pinnedSocketOpen: () => {},
    pinnedSocketSend: () => {},
    pinnedSocketClose: () => {},
    addSocketListener: () => () => {},
  };
}

it("redeems once over pinned HTTPS and binds the authenticated identity", async () => {
  const native = bridge();
  const confirmed = preparePairing(LINK);
  const transport = createPinnedPairingTransport({ bridge: native }, async (input) => {
    expect(input.fingerprint).toBe(PIN);
    expect(input.socketUrl).toBe("wss://192.168.1.20:4243/");
    expect(input.token).toBe(TOKEN);
    expect(input.deviceId).toBe("device-1");
    return identity();
  });
  const paired = await redeemConfirmedPairing(confirmed, "My phone", transport);
  expect(paired.identity.hostId).toBe("host-1");
  expect(paired.target).toMatchObject({ kind: "direct", fingerprint: PIN });
  expect(paired.token).toBe(TOKEN);
  expect(native.fetched).toHaveLength(1);
  expect(native.fetched[0]).toMatchObject({
    origin: ORIGIN,
    fingerprint: PIN,
    method: "POST",
    path: "/v1/pair",
  });
  expect(String(native.fetched[0]?.body)).toContain("abc123");
  expect(String(native.fetched[0]?.body)).not.toContain(PIN);
});

it("sends nothing when the pin is malformed", async () => {
  const native = bridge();
  const confirmed = preparePairing(LINK);
  const transport = createPinnedPairingTransport({ bridge: native });
  await expect(
    transport.redeem({ origin: ORIGIN, fingerprint: "bad", code: "abc123", name: "Phone" }),
  ).rejects.toMatchObject({ refusal: "invalid" });
  expect(native.fetched).toHaveLength(0);
  void confirmed;
});

it("refuses the identity read before a successful redeem", async () => {
  const native = bridge();
  const transport = createPinnedPairingTransport({ bridge: native }, async () => identity());
  await expect(transport.readIdentity({ origin: ORIGIN, fingerprint: PIN })).rejects.toMatchObject({
    code: "daemon",
  });
  expect(native.fetched).toHaveLength(0);
});

it("reports an expired link as auth without leaking the code", async () => {
  const native = bridge({
    fetch: async () => ({ status: 401, body: "expired" }),
  });
  const confirmed = preparePairing(LINK);
  const transport = createPinnedPairingTransport({ bridge: native }, async () => identity());
  await expect(redeemConfirmedPairing(confirmed, "My phone", transport)).rejects.toMatchObject({
    failure: "auth",
  });
});

it("marks a consumed link when the credential reply is unreadable", async () => {
  const native = bridge({
    fetch: async () => ({ status: 200, body: "{}" }),
  });
  const confirmed = preparePairing(LINK);
  const transport = createPinnedPairingTransport({ bridge: native }, async () => identity());
  await expect(redeemConfirmedPairing(confirmed, "My phone", transport)).rejects.toMatchObject({
    failure: "consumed",
  });
});

it("aborts pairing promptly without touching the network after cancel", async () => {
  const native = bridge();
  const transport = createPinnedPairingTransport({ bridge: native });
  const controller = new AbortController();
  controller.abort();
  await expect(
    transport.redeem({
      origin: ORIGIN,
      fingerprint: PIN,
      code: "abc123",
      name: "Phone",
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: "aborted" });
  expect(native.fetched).toHaveLength(0);
  const redeemTransport = createPinnedPairingTransport({ bridge: native }, async () => identity());
  const minted = preparePairing(LINK);
  await redeemConfirmedPairing(minted, "My phone", redeemTransport);
  const stop = new AbortController();
  stop.abort();
  await expect(
    redeemTransport.readIdentity({ origin: ORIGIN, fingerprint: PIN, signal: stop.signal }),
  ).rejects.toMatchObject({ code: "aborted" });
});

it("marks a consumed link when the identity read fails after redeem", async () => {
  const native = bridge();
  const confirmed = preparePairing(LINK);
  const transport = createPinnedPairingTransport({ bridge: native }, async () => {
    throw new Error("offline");
  });
  await expect(redeemConfirmedPairing(confirmed, "My phone", transport)).rejects.toMatchObject({
    failure: "consumed",
  });
});
