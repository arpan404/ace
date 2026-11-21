import type { SecureStoreOptions } from "expo-secure-store";
import type { CredentialStore } from "./credentials.ts";

/**
 * Keystore-backed device-token storage for Android production pairing.
 *
 * `expo-secure-store` keeps values as AES-GCM ciphertext in the app-private
 * `SecureStore` SharedPreferences, with the key held by the Android Keystore
 * (`setUserAuthenticationRequired(false)` because `requireAuthentication`
 * is always false here). Keystore keys never leave the device, so entries
 * are this device only and never synchronized. It is the Android counterpart
 * of the iOS Keychain store (`apps/ios/Sources/Host/SecretStore.swift`),
 * which uses `AfterFirstUnlockThisDeviceOnly` and a non-synchronizable
 * generic password.
 *
 * `keychainAccessible` is iOS-only (`@platform ios` in SecureStore's
 * options docs) and is ignored by the Android native module, whose options
 * record carries only `authenticationPrompt`, `keychainService` and
 * `requireAuthentication`. This adapter therefore never sends it; claiming
 * an iOS accessibility level on Android would imply a protection the native
 * module does not read.
 *
 * Wiring:
 * - `secure-store.ts` passes the real `expo-secure-store` module into
 *   `createKeystoreCredentialStore`. Tests inject fakes, so this file never
 *   touches the device and behavior stays hermetic.
 * - `app.json` keeps the `expo-secure-store` config plugin with
 *   `configureAndroidBackup: true`, which excludes the `SecureStore`
 *   preferences from Auto Backup (verified in `backup.test.ts` against the
 *   checked-in config). A backup therefore restores no token and the phone
 *   pairs again; uninstalls always wipe tokens. Whether the generated
 *   manifest actually carries the exclusion rules is only proven by a
 *   prebuild inspection, which no hermetic test can do (see README).
 * - `requireAuthentication` is always false here. Tokens must be readable
 *   after a permitted restart without a biometric prompt; the separate app
 *   lock (parity task A02.07) gates the UI, not the credential read.
 *
 * Fail-closed rules: backend errors propagate unchanged so the contract
 * layer (`credentials.ts`) maps them to generic messages without credential
 * material. Missing or invalidated entries read as `null`, which the
 * contract layer reports as "needs pairing again". This adapter never logs.
 */

export const KEYSTORE_SERVICE = "app.ace.android.device-token";

const STORAGE_KEY_PREFIX = "ace-device-token.";

/** Storage-key bound in UTF-8 bytes, matching the iOS directory bound. */
const MAX_KEY_BYTES = 1024;

const keyEncoder = new TextEncoder();

/** Minimal `expo-secure-store` shape. The real module satisfies this. */
export interface SecureStoreBackend {
  getItemAsync(key: string, options?: SecureStoreOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: SecureStoreOptions): Promise<void>;
  deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void>;
}

/**
 * Options used for every backend call: isolated service, no auth prompt.
 * Only Android-meaningful fields: `keychainAccessible` is iOS-only and the
 * Android native module ignores it, so it is deliberately never sent.
 */
export function keystoreOptions(): SecureStoreOptions {
  return {
    keychainService: KEYSTORE_SERVICE,
    requireAuthentication: false,
  };
}

const BASE64_URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Base64url (no padding) of UTF-8 bytes: `[A-Za-z0-9-_]` only. */
function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = index + 1 < bytes.length ? (bytes[index + 1] ?? 0) : 0;
    const third = index + 2 < bytes.length ? (bytes[index + 2] ?? 0) : 0;
    const group = (first << 16) | (second << 8) | third;
    out += BASE64_URL_ALPHABET.charAt((group >> 18) & 63);
    out += BASE64_URL_ALPHABET.charAt((group >> 12) & 63);
    if (index + 1 < bytes.length) out += BASE64_URL_ALPHABET.charAt((group >> 6) & 63);
    if (index + 2 < bytes.length) out += BASE64_URL_ALPHABET.charAt(group & 63);
  }
  return out;
}

/**
 * Map a credential-store key to a SecureStore-safe storage key. The mapping
 * is injective, so one host/device pair can never read another's token, and
 * the output alphabet stays within SecureStore's documented key charset.
 */
export function encodeStorageKey(key: string): string {
  if (key === "" || keyEncoder.encode(key).length > MAX_KEY_BYTES)
    throw new Error("Invalid credential key");
  return `${STORAGE_KEY_PREFIX}${base64UrlEncode(keyEncoder.encode(key))}`;
}

/**
 * Build the production `CredentialStore` over an injected SecureStore
 * backend. Values pass through verbatim; token shape and key bounds are
 * enforced by `credentials.ts`, and backend failures propagate for that
 * layer to map without leaking material.
 */
export function createKeystoreCredentialStore(backend: SecureStoreBackend): CredentialStore {
  const options = keystoreOptions();
  return {
    get: async (key: string) => backend.getItemAsync(encodeStorageKey(key), options),
    set: async (key: string, value: string) =>
      backend.setItemAsync(encodeStorageKey(key), value, options),
    remove: async (key: string) => backend.deleteItemAsync(encodeStorageKey(key), options),
  };
}
