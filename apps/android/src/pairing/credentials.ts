import { machineSecretKey, type MachineEntry } from "@ace/client/machines";
import { DeviceToken } from "@ace/protocol";

/**
 * Device-token storage for Android production pairing.
 *
 * Rules, aligned with the iOS Keychain store
 * (`apps/ios/Sources/Host/SecretStore.swift`):
 * device tokens live only here, never in SQLite, files, drafts or logs.
 * Pairing codes, tickets and tokens are never written to diagnostic output;
 * errors from this module never contain credential material.
 *
 * The store is injected so the logic stays testable without the device:
 * production wiring passes the Keystore-backed adapter
 * (`./keystore.ts` over `expo-secure-store`, via `./secure-store.ts`;
 * AES-GCM ciphertext in the app-private `SecureStore` preferences with the
 * key held by the Android Keystore, this device only, never synchronized
 * or restored to another phone), while tests use the memory store.
 */

export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Storage key shared with the SDK's `machineSecretKey`: `[hostId, deviceId]` JSON. */
export function pairedCredentialKey(entry: { hostId: string; deviceId: string }): string {
  return machineSecretKey(entry as Pick<MachineEntry, "hostId" | "deviceId">);
}

/** Maximum storage-key size in UTF-8 bytes, matching the iOS directory bound. */
const MAX_KEY_BYTES = 1024;

const keyEncoder = new TextEncoder();

function checkKey(key: string): void {
  if (key === "" || keyEncoder.encode(key).length > MAX_KEY_BYTES)
    throw new Error("Invalid credential key");
}

/** Read the device token for a paired machine. Throws when it is missing or malformed. */
export async function loadCredential(
  store: CredentialStore,
  entry: { hostId: string; deviceId: string },
): Promise<string> {
  const key = pairedCredentialKey(entry);
  checkKey(key);
  let raw: string | null;
  try {
    raw = await store.get(key);
  } catch {
    throw new Error("The device credential store is unavailable");
  }
  const parsed = DeviceToken.safeParse(raw);
  if (!parsed.success) throw new Error("This machine needs pairing again");
  return parsed.data;
}

/**
 * Persist the device token issued at redemption. Validates the token before
 * writing so a malformed value never reaches the store.
 */
export async function saveCredential(
  store: CredentialStore,
  entry: { hostId: string; deviceId: string },
  token: string,
): Promise<void> {
  const key = pairedCredentialKey(entry);
  checkKey(key);
  const parsed = DeviceToken.safeParse(token);
  if (!parsed.success) throw new Error("Invalid device token");
  try {
    await store.set(key, parsed.data);
  } catch {
    throw new Error("The device credential could not be saved");
  }
}

/**
 * Remove a machine's authority first: delete its token before removing its
 * metadata, so a failed metadata write leaves a visible entry that needs
 * pairing again rather than a usable credential without metadata.
 */
export async function deleteCredential(
  store: CredentialStore,
  entry: { hostId: string; deviceId: string },
): Promise<void> {
  const key = pairedCredentialKey(entry);
  checkKey(key);
  try {
    await store.remove(key);
  } catch {
    throw new Error("The device credential could not be removed");
  }
}

/** Hermetic store for tests. Production must use the Keystore-backed adapter. */
export function createMemoryCredentialStore(): CredentialStore {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value);
    },
    remove: async (key: string) => {
      values.delete(key);
    },
  };
}
