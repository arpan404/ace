import { expect, it } from "vitest";
import type { Storage } from "@ace/client";
import { createPairingMachines } from "./machines.ts";
import { preparePairing } from "./pairing-flow.ts";
import { createMemoryCredentialStore, loadCredential } from "./credentials.ts";

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

function identity(hostId = "host-1") {
  return { hostId, displayName: "Studio", version: "1.0" };
}

function memoryStorage(initial: string | null = null): Storage & { saved: (string | null)[] } {
  let current = initial;
  const saved: (string | null)[] = [];
  return {
    saved,
    load: async () => current,
    save: async (value: string) => {
      current = value;
      saved.push(value);
    },
  };
}

function setup() {
  const storage = memoryStorage();
  const credentials = createMemoryCredentialStore();
  const machines = createPairingMachines({ storage, credentials });
  const transport = {
    redeem: async () => credential(),
    readIdentity: async () => identity(),
  };
  return { storage, credentials, machines, transport };
}

it("pairs a machine with its token outside the metadata", async () => {
  const { machines, credentials, transport } = setup();
  const entry = await machines.pair(preparePairing(LINK), "My phone", transport);
  expect(entry.hostId).toBe("host-1");
  expect(entry.deviceId).toBe("device-1");
  await expect(loadCredential(credentials, entry)).resolves.toBe(TOKEN);
  expect(await machines.load()).toHaveLength(1);
});

it("rejects a duplicate pairing and leaves no usable credential behind", async () => {
  const { machines, credentials, transport } = setup();
  const entry = await machines.pair(preparePairing(LINK), "My phone", transport);
  await expect(machines.pair(preparePairing(LINK), "My phone", transport)).rejects.toMatchObject({
    failure: "auth",
  });
  expect(await machines.load()).toHaveLength(1);
  await expect(loadCredential(credentials, entry)).resolves.toBe(TOKEN);
});

it("removes authority before metadata so a failed write cannot strand access", async () => {
  const { machines, credentials, transport, storage } = setup();
  const entry = await machines.pair(preparePairing(LINK), "My phone", transport);
  const failing = memoryStorage(storage.saved.at(-1) ?? null);
  const broken = createPairingMachines({ storage: failing, credentials });
  failing.save = async () => {
    throw new Error("disk full");
  };
  await expect(broken.remove("host-1")).rejects.toMatchObject({ failure: "daemon" });
  await expect(loadCredential(credentials, entry)).rejects.toThrow("needs pairing again");
});

it("removing an unknown machine is a no-op", async () => {
  const { machines } = setup();
  await expect(machines.remove("no-such-host")).resolves.toBeUndefined();
  expect(await machines.load()).toHaveLength(0);
});

it("removes with a single credential delete inside the directory", async () => {
  const { machines, credentials, transport, storage } = setup();
  const entry = await machines.pair(preparePairing(LINK), "My phone", transport);
  let deletes = 0;
  const counting = {
    get: (key: string) => credentials.get(key),
    set: (key: string, value: string) => credentials.set(key, value),
    remove: async (key: string) => {
      deletes++;
      await credentials.remove(key);
    },
  };
  const rebound = createPairingMachines({ storage, credentials: counting });
  await rebound.remove("host-1");
  expect(deletes).toBe(1);
  await expect(loadCredential(credentials, entry)).rejects.toThrow("needs pairing again");
  expect(await rebound.load()).toHaveLength(0);
});

it("maps credential-store failures to a pairing failure", async () => {
  const { machines, transport, storage } = setup();
  await machines.pair(preparePairing(LINK), "My phone", transport);
  const locked = {
    get: async (_key: string) => {
      throw new Error("locked");
    },
    set: async (_key: string, _value: string) => {},
    remove: async (_key: string) => {
      throw new Error("locked");
    },
  };
  const broken = createPairingMachines({ storage, credentials: locked });
  try {
    await broken.remove("host-1");
    expect.unreachable();
  } catch (error) {
    expect(error).toMatchObject({ failure: "daemon" });
    expect((error as Error).message).not.toContain(TOKEN);
  }
});

it("renames a machine locally without touching its credential", async () => {
  const { machines, credentials, transport } = setup();
  const entry = await machines.pair(preparePairing(LINK), "My phone", transport);
  await machines.rename("host-1", "  Studio Pro  ");
  expect((await machines.load())[0]?.displayName).toBe("Studio Pro");
  await expect(loadCredential(credentials, entry)).resolves.toBe(TOKEN);
  await expect(machines.rename("host-1", "   ")).rejects.toMatchObject({
    failure: "invalid-name",
  });
});
