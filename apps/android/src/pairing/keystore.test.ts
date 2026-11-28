import { expect, it, vi } from "vitest";
import type { SecureStoreOptions } from "expo-secure-store";
import {
  deleteCredential,
  loadCredential,
  pairedCredentialKey,
  saveCredential,
} from "./credentials.ts";
import {
  KEYSTORE_SERVICE,
  createKeystoreCredentialStore,
  encodeStorageKey,
  type SecureStoreBackend,
} from "./keystore.ts";

const ENTRY_A = { hostId: "host-1", deviceId: "device-1" };
const ENTRY_B = { hostId: "host-1", deviceId: "device-2" };
const TOKEN_A = "e0".repeat(32);
const TOKEN_B = "f1".repeat(32);

interface Call {
  method: string;
  key: string;
  value?: string;
  options: SecureStoreOptions | undefined;
}

function createFake() {
  const values = new Map<string, string>();
  const calls: Call[] = [];
  const failures = new Map<string, Error>();
  const backend: SecureStoreBackend = {
    getItemAsync: async (key: string, options?: SecureStoreOptions) => {
      calls.push({ method: "get", key, options });
      const failure = failures.get("get");
      if (failure) throw failure;
      return values.get(key) ?? null;
    },
    setItemAsync: async (key: string, value: string, options?: SecureStoreOptions) => {
      calls.push({ method: "set", key, value, options });
      const failure = failures.get("set");
      if (failure) throw failure;
      values.set(key, value);
    },
    deleteItemAsync: async (key: string, options?: SecureStoreOptions) => {
      calls.push({ method: "delete", key, options });
      const failure = failures.get("delete");
      if (failure) throw failure;
      values.delete(key);
    },
  };
  return { backend, values, calls, failures };
}

it("survives a permitted restart across adapter instances on one backend", async () => {
  const fake = createFake();
  await saveCredential(createKeystoreCredentialStore(fake.backend), ENTRY_A, TOKEN_A);
  const restarted = createKeystoreCredentialStore(fake.backend);
  await expect(loadCredential(restarted, ENTRY_A)).resolves.toBe(TOKEN_A);
  await deleteCredential(restarted, ENTRY_A);
  await expect(
    loadCredential(createKeystoreCredentialStore(fake.backend), ENTRY_A),
  ).rejects.toThrow("needs pairing again");
});

it("passes the isolated service and no-auth options on every call", async () => {
  const fake = createFake();
  const store = createKeystoreCredentialStore(fake.backend);
  await saveCredential(store, ENTRY_A, TOKEN_A);
  await loadCredential(store, ENTRY_A);
  await deleteCredential(store, ENTRY_A);
  expect(fake.calls.length).toBe(3);
  for (const call of fake.calls) {
    expect(call.options).toEqual({
      keychainService: KEYSTORE_SERVICE,
      requireAuthentication: false,
    });
  }
  expect(KEYSTORE_SERVICE).toBe("app.ace.android.device-token");
});

it("never sends the iOS-only accessibility marker the Android module ignores", async () => {
  const seen: (SecureStoreOptions | undefined)[] = [];
  const backend: SecureStoreBackend = {
    getItemAsync: async (key: string, options?: SecureStoreOptions) => {
      seen.push(options);
      return null;
    },
    setItemAsync: async (key: string, value: string, options?: SecureStoreOptions) => {
      seen.push(options);
    },
    deleteItemAsync: async (key: string, options?: SecureStoreOptions) => {
      seen.push(options);
    },
  };
  const store = createKeystoreCredentialStore(backend);
  await saveCredential(store, ENTRY_A, TOKEN_A);
  await expect(loadCredential(store, ENTRY_A)).rejects.toThrow("needs pairing again");
  await deleteCredential(store, ENTRY_A);
  expect(seen.length).toBe(3);
  for (const options of seen) {
    expect(options?.keychainService).toBe(KEYSTORE_SERVICE);
    expect(options?.requireAuthentication).toBe(false);
    expect(options).not.toHaveProperty("keychainAccessible");
  }
});

it("keeps storage keys in the SecureStore charset and apart per host and device", async () => {
  const fake = createFake();
  const store = createKeystoreCredentialStore(fake.backend);
  const encodedA = encodeStorageKey(pairedCredentialKey(ENTRY_A));
  const encodedB = encodeStorageKey(pairedCredentialKey(ENTRY_B));
  expect(encodedA).toMatch(/^[A-Za-z0-9._-]+$/);
  expect(encodedB).toMatch(/^[A-Za-z0-9._-]+$/);
  expect(encodedA).not.toBe(encodedB);
  await saveCredential(store, ENTRY_A, TOKEN_A);
  expect([...fake.values.keys()]).toEqual([encodedA]);
  expect([...fake.values.keys()]).not.toContain(pairedCredentialKey(ENTRY_A));
  await expect(loadCredential(store, ENTRY_B)).rejects.toThrow("needs pairing again");
  await expect(loadCredential(store, ENTRY_A)).resolves.toBe(TOKEN_A);
});

it("rejects empty and oversized keys before touching the backend", async () => {
  const fake = createFake();
  const store = createKeystoreCredentialStore(fake.backend);
  const wide = "é".repeat(600);
  for (const key of ["", "x".repeat(1025)]) {
    await expect(store.get(key)).rejects.toThrow("Invalid credential key");
    await expect(store.set(key, TOKEN_A)).rejects.toThrow("Invalid credential key");
    await expect(store.remove(key)).rejects.toThrow("Invalid credential key");
  }
  await expect(
    saveCredential(store, { hostId: wide, deviceId: "device-1" }, TOKEN_A),
  ).rejects.toThrow("Invalid credential key");
  expect(fake.calls).toEqual([]);
  expect(fake.values.size).toBe(0);
});

it("fails closed without leaking material when the backend is locked", async () => {
  const fake = createFake();
  const secret = "c2".repeat(32);
  const store = createKeystoreCredentialStore(fake.backend);
  await saveCredential(store, ENTRY_A, TOKEN_A);
  const locked = new Error(`locked with ${secret}`);
  fake.failures.set("get", locked);
  fake.failures.set("set", locked);
  fake.failures.set("delete", locked);
  await expect(loadCredential(store, ENTRY_A)).rejects.toThrow("unavailable");
  await expect(saveCredential(store, ENTRY_A, TOKEN_B)).rejects.toThrow("could not be saved");
  await expect(deleteCredential(store, ENTRY_A)).rejects.toThrow("could not be removed");
  for (const run of [
    loadCredential(store, ENTRY_A),
    saveCredential(store, ENTRY_A, TOKEN_B),
    deleteCredential(store, ENTRY_A),
  ]) {
    await expect(run).rejects.toSatisfy((error: Error) => {
      return !error.message.includes(secret) && !error.message.includes(TOKEN_A);
    });
  }
});

it("treats missing, invalidated and malformed entries as pairing again", async () => {
  const fake = createFake();
  const store = createKeystoreCredentialStore(fake.backend);
  await expect(loadCredential(store, ENTRY_A)).rejects.toThrow("needs pairing again");
  const malformed = [
    "not-a-token",
    "",
    TOKEN_A.slice(0, 63),
    TOKEN_A.toUpperCase(),
    ` ${TOKEN_A}\n`,
  ];
  for (const raw of malformed) {
    fake.values.set(encodeStorageKey(pairedCredentialKey(ENTRY_A)), raw);
    try {
      await loadCredential(store, ENTRY_A);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe("This machine needs pairing again");
      if (raw !== "") expect((error as Error).message).not.toContain(raw);
    }
  }
  fake.values.delete(encodeStorageKey(pairedCredentialKey(ENTRY_A)));
  await expect(loadCredential(store, ENTRY_A)).rejects.toThrow("needs pairing again");
});

it("deletes exactly one credential and tolerates missing entries", async () => {
  const fake = createFake();
  const store = createKeystoreCredentialStore(fake.backend);
  await saveCredential(store, ENTRY_A, TOKEN_A);
  await saveCredential(store, ENTRY_B, TOKEN_B);
  await deleteCredential(store, ENTRY_A);
  await expect(loadCredential(store, ENTRY_A)).rejects.toThrow("needs pairing again");
  await expect(loadCredential(store, ENTRY_B)).resolves.toBe(TOKEN_B);
  await expect(deleteCredential(store, ENTRY_A)).resolves.toBeUndefined();
  expect(fake.values.size).toBe(1);
});

it("routes a restored backup without tokens to pairing again, then re-pairs", async () => {
  const fake = createFake();
  const store = createKeystoreCredentialStore(fake.backend);
  await saveCredential(store, ENTRY_A, TOKEN_A);
  fake.values.clear();
  await expect(loadCredential(store, ENTRY_A)).rejects.toThrow("needs pairing again");
  await saveCredential(store, ENTRY_A, TOKEN_B);
  await expect(loadCredential(store, ENTRY_A)).resolves.toBe(TOKEN_B);
});

it("writes nothing to diagnostic output while saving, loading and removing", async () => {
  const fake = createFake();
  const store = createKeystoreCredentialStore(fake.backend);
  const logs = { count: 0 };
  const methods = ["log", "warn", "error", "info", "debug"] as const;
  const spies = methods.map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {
      logs.count += 1;
    }),
  );
  try {
    await saveCredential(store, ENTRY_A, TOKEN_A);
    await loadCredential(store, ENTRY_A);
    await deleteCredential(store, ENTRY_A);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  expect(logs.count).toBe(0);
});
