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

it("an abort racing the directory write surfaces consumed, never silent success", async () => {
  const { machines } = setup();
  const confirmed = preparePairing(LINK);
  const ctrl = new AbortController();
  // Redeem succeeds (the code is burned), then the caller aborts before the
  // directory add: the pair must fail consumed so the person checks the
  // computer's devices instead of retrying a dead link.
  const blocking = {
    redeem: async () => credential(),
    readIdentity: async () => identity(),
  };
  const pending = machines.pair(confirmed, "My phone", blocking, ctrl.signal);
  ctrl.abort();
  await expect(pending).rejects.toMatchObject({ failure: "consumed" });
  expect(await machines.load()).toHaveLength(0);
});

it("a pre-redeem abort stays offline, never consumed", async () => {
  // The code was never sent (the transport aborted before redeem resolved),
  // so the link is still valid: report retryable offline, not consumed.
  const { machines } = setup();
  const confirmed = preparePairing(LINK);
  const ctrl = new AbortController();
  ctrl.abort();
  const aborted = {
    redeem: async (_input: unknown) => {
      const error = new Error("aborted") as Error & { code: string };
      error.code = "aborted";
      void _input;
      throw error;
    },
    readIdentity: async () => identity(),
  };
  await expect(machines.pair(confirmed, "My phone", aborted, ctrl.signal)).rejects.toMatchObject({
    failure: "offline",
  });
  expect(await machines.load()).toHaveLength(0);
});

it("an abort during the directory save cannot undo it: the entry still lands", async () => {
  // `MachineDirectory.add` takes no signal, so an abort firing mid-save
  // cannot cancel the serialized write. The save runs to completion and the
  // entry is returned — success means saved, never a silent background add.
  const storage = memoryStorage();
  const credentials = createMemoryCredentialStore();
  const machines = createPairingMachines({ storage, credentials });
  const confirmed = preparePairing(LINK);
  const ctrl = new AbortController();
  let releaseSave!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const realSave = storage.save.bind(storage);
  storage.save = async (value: string) => {
    ctrl.abort();
    await gate;
    await realSave(value);
  };
  const pending = machines.pair(
    confirmed,
    "My phone",
    { redeem: async () => credential(), readIdentity: async () => identity() },
    ctrl.signal,
  );
  await Promise.resolve();
  await Promise.resolve();
  releaseSave();
  const entry = await pending;
  expect(entry.hostId).toBe("host-1");
  expect(await machines.load()).toHaveLength(1);
});
