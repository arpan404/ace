import * as SecureStore from "expo-secure-store";
import type { CredentialStore } from "./credentials.ts";
import { createKeystoreCredentialStore } from "./keystore.ts";

/**
 * Production credential store: the Keystore-backed adapter over the real
 * `expo-secure-store` module. Fail-closed like the contract layer expects:
 * missing entries read as `null`, backend errors reject, and nothing is
 * logged. Imported only by production startup, never by tests.
 */
export function createProductionCredentialStore(): CredentialStore {
  return createKeystoreCredentialStore(SecureStore);
}
