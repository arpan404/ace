import { expect, it } from "vitest";
import {
  createMemoryCredentialStore,
  deleteCredential,
  loadCredential,
  pairedCredentialKey,
  saveCredential,
} from "./credentials.ts";

const ENTRY = { hostId: "host-1", deviceId: "device-1" };
const TOKEN = "e0".repeat(32);

it("round-trips a device token outside SQLite, logs and drafts", async () => {
  const store = createMemoryCredentialStore();
  await expect(loadCredential(store, ENTRY)).rejects.toThrow("needs pairing again");
  await saveCredential(store, ENTRY, TOKEN);
  await expect(loadCredential(store, ENTRY)).resolves.toBe(TOKEN);
  await deleteCredential(store, ENTRY);
  await expect(loadCredential(store, ENTRY)).rejects.toThrow("needs pairing again");
});

it("removes authority without failing when nothing is stored", async () => {
  await expect(deleteCredential(createMemoryCredentialStore(), ENTRY)).resolves.toBeUndefined();
});

it("measures the storage-key bound in UTF-8 bytes like iOS", async () => {
  const store = createMemoryCredentialStore();
  const wideHost = "é".repeat(600);
  await expect(
    saveCredential(store, { hostId: wideHost, deviceId: "device-1" }, TOKEN),
  ).rejects.toThrow("Invalid credential key");
});

it("shares the SDK storage key so one host and device own one token", () => {
  expect(pairedCredentialKey(ENTRY)).toBe(JSON.stringify(["host-1", "device-1"]));
  expect(pairedCredentialKey({ hostId: "host-1", deviceId: "device-2" })).not.toBe(
    pairedCredentialKey(ENTRY),
  );
});

it("refuses malformed tokens and unavailable stores without leaking material", async () => {
  const store = createMemoryCredentialStore();
  const secret = "f1".repeat(32);
  await expect(saveCredential(store, ENTRY, "not-a-token")).rejects.toThrow();
  await store.set(pairedCredentialKey(ENTRY), "not-a-token");
  try {
    await loadCredential(store, ENTRY);
    expect.unreachable();
  } catch (error) {
    expect((error as Error).message).not.toContain("not-a-token");
  }
  const broken = {
    get: async () => {
      throw new Error("locked");
    },
    set: async () => {
      throw new Error(`locked with ${secret}`);
    },
    remove: async () => {
      throw new Error("locked");
    },
  };
  await expect(loadCredential(broken, ENTRY)).rejects.toThrow("unavailable");
  await expect(saveCredential(broken, ENTRY, TOKEN)).rejects.toThrow("could not be saved");
  await expect(deleteCredential(broken, ENTRY)).rejects.toThrow("could not be removed");
  try {
    await saveCredential(broken, ENTRY, TOKEN);
    expect.unreachable();
  } catch (error) {
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain(TOKEN);
  }
});
