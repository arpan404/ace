import { safeStorage } from "electron";

/**
 * What the app keeps encrypted with the OS keychain's key (Electron `safeStorage`): ace account
 * sessions and the app's keys for daemons it didn't start (ADR 0178 §12.8). Never in the clear:
 * Linux's `basic_text` fallback encrypts with a fixed key, so it counts as unavailable.
 */
export interface SecretBox {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(bytes: Buffer): string;
}

export const secureStorage: SecretBox = {
  available: () =>
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (bytes) => safeStorage.decryptString(bytes),
};
