import { expect, it } from "vitest";
import {
  preparePairing,
  redeemConfirmedPairing,
  PairingFlowError,
  type PairingTransport,
} from "./pairing-flow.ts";

const PIN = "9f".repeat(32);
const LINK = `https://192.168.1.20:4243/pair#code=abc123&fingerprint=${PIN}&scopes=read,operate`;
const TOKEN = "e0".repeat(32);

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

function transport(overrides: Partial<PairingTransport> = {}): PairingTransport & {
  calls: { origin: string; fingerprint: string; code: string; name: string }[];
  identityCalls: { origin: string; fingerprint: string }[];
} {
  const calls: { origin: string; fingerprint: string; code: string; name: string }[] = [];
  const identityCalls: { origin: string; fingerprint: string }[] = [];
  return {
    calls,
    identityCalls,
    redeem: async (input: { origin: string; fingerprint: string; code: string; name: string }) => {
      calls.push({
        origin: input.origin,
        fingerprint: input.fingerprint,
        code: input.code,
        name: input.name,
      });
      if (calls.length > 1) throw new Error("the code redeems exactly once");
      return credential();
    },
    readIdentity: async (input: { origin: string; fingerprint: string }) => {
      identityCalls.push({ origin: input.origin, fingerprint: input.fingerprint });
      return identity();
    },
    ...overrides,
  };
}

it("prepares the confirmation the person checks before anything is sent", () => {
  const confirmed = preparePairing(LINK);
  expect(confirmed.displayHost).toBe("192.168.1.20:4243");
  expect(confirmed.accessSummary).toBe("View and act");
  expect(confirmed.fingerprintGroups.split(" ")).toHaveLength(16);
  expect(confirmed.link.code).toBe("abc123");
});

it("rejects pasted text with the link's actionable message", () => {
  try {
    preparePairing("nota link");
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(PairingFlowError);
    expect((error as PairingFlowError).failure).toBe("invalid-link");
    expect((error as Error).message).toContain("ace pair");
  }
});

it("redeems once over the stripped origin and binds the authenticated identity", async () => {
  const confirmed = preparePairing(LINK);
  const sender = transport();
  const paired = await redeemConfirmedPairing(confirmed, "My phone", sender);
  expect(sender.calls).toHaveLength(1);
  expect(sender.calls[0]?.origin).toBe("https://192.168.1.20:4243/");
  expect(sender.calls[0]?.origin).not.toContain("#");
  expect(sender.calls[0]?.origin).not.toContain("abc123");
  expect(sender.calls[0]?.fingerprint).toBe(PIN);
  expect(sender.identityCalls).toHaveLength(1);
  expect(sender.identityCalls[0]?.fingerprint).toBe(PIN);
  expect(sender.identityCalls[0]?.origin).toBe("https://192.168.1.20:4243/");
  expect(paired.deviceId).toBe("device-1");
  expect(paired.token).toBe(TOKEN);
  expect(paired.identity.hostId).toBe("host-1");
  expect(paired.target).toEqual({
    kind: "direct",
    url: "wss://192.168.1.20:4243/",
    fingerprint: PIN,
  });
});

it("never infers the host identity from the link hostname", async () => {
  const confirmed = preparePairing(LINK);
  const paired = await redeemConfirmedPairing(
    confirmed,
    "My phone",
    transport({ readIdentity: async () => ({ ...identity(), hostId: "stable-host-id" }) }),
  );
  expect(paired.identity.hostId).toBe("stable-host-id");
});

it("requires a device name before redeeming", async () => {
  const confirmed = preparePairing(LINK);
  const sender = transport();
  await expect(redeemConfirmedPairing(confirmed, "   ", sender)).rejects.toMatchObject({
    failure: "invalid-name",
  });
  expect(sender.calls).toHaveLength(0);
});

it("requires pin validation before the code is sent", async () => {
  const confirmed = preparePairing(LINK);
  const tampered = { ...confirmed, link: { ...confirmed.link, fingerprint: "not-a-pin" } };
  const sender = transport();
  await expect(redeemConfirmedPairing(tampered, "My phone", sender)).rejects.toMatchObject({
    failure: "invalid-link",
  });
  expect(sender.calls).toHaveLength(0);
  expect(sender.identityCalls).toHaveLength(0);
});

it("redacts echoed secrets from daemon refusals", async () => {
  const confirmed = preparePairing(LINK);
  const refused = transport({
    redeem: async () => {
      const error = new Error(`HTTP 401: code abc123 with token ${TOKEN} already used`) as Error & {
        code: string;
      };
      error.code = "auth";
      throw error;
    },
  });
  try {
    await redeemConfirmedPairing(confirmed, "My phone", refused);
    expect.unreachable();
  } catch (error) {
    expect((error as PairingFlowError).failure).toBe("auth");
    expect((error as Error).message).toContain("already used");
    expect((error as Error).message).not.toContain("abc123");
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as Error).message).not.toContain(PIN);
  }
});

it("maps post-redeem failures to consumed so a dead link is never retried", async () => {
  const confirmed = preparePairing(LINK);
  const offlineIdentity = transport({
    readIdentity: async () => {
      const error = new Error("down") as Error & { code: string };
      error.code = "offline";
      throw error;
    },
  });
  await expect(
    redeemConfirmedPairing(confirmed, "My phone", offlineIdentity),
  ).rejects.toMatchObject({ failure: "consumed" });
  const unreadableIdentity = transport({ readIdentity: async () => ({ hostId: 42 }) });
  await expect(
    redeemConfirmedPairing(confirmed, "My phone", unreadableIdentity),
  ).rejects.toMatchObject({ failure: "consumed" });
  const unreadableCredential = transport({ redeem: async () => ({ device: null }) });
  await expect(
    redeemConfirmedPairing(confirmed, "My phone", unreadableCredential),
  ).rejects.toMatchObject({ failure: "consumed" });
  try {
    await redeemConfirmedPairing(
      confirmed,
      "My phone",
      transport({
        readIdentity: async () => {
          const error = new Error("down") as Error & { code: string };
          error.code = "offline";
          throw error;
        },
      }),
    );
    expect.unreachable();
  } catch (error) {
    expect((error as Error).message).toContain("unused entry");
    expect((error as Error).message).not.toContain("abc123");
  }
});

it("maps transport outcomes without leaking the code or token", async () => {
  const confirmed = preparePairing(LINK);
  const refused = transport({
    redeem: async () => {
      const error = new Error("HTTP 401: pairing link already used") as Error & { code: string };
      error.code = "auth";
      throw error;
    },
  });
  try {
    await redeemConfirmedPairing(confirmed, "My phone", refused);
    expect.unreachable();
  } catch (error) {
    expect((error as PairingFlowError).failure).toBe("auth");
    expect((error as Error).message).toContain("already used");
    expect((error as Error).message).not.toContain("abc123");
    expect((error as Error).message).not.toContain(TOKEN);
  }
  const offline = transport({
    redeem: async () => {
      const error = new Error("down") as Error & { code: string };
      error.code = "offline";
      throw error;
    },
  });
  await expect(redeemConfirmedPairing(confirmed, "My phone", offline)).rejects.toMatchObject({
    failure: "offline",
  });
  const unreadable = transport({ redeem: async () => ({ device: null }) });
  await expect(redeemConfirmedPairing(confirmed, "My phone", unreadable)).rejects.toMatchObject({
    failure: "consumed",
  });
});
