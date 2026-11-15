import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The OS keychain behind Electron's `safeStorage`: every touch of it is counted. */
const keychain = vi.hoisted(() => ({ touches: 0, available: true }));
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => {
      keychain.touches++;
      return keychain.available;
    },
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (text: string) => Buffer.from(`sealed:${text}`),
    decryptString: (bytes: Buffer) => bytes.toString().replace(/^sealed:/, ""),
  },
}));
const { accountSecrets } = await import("./account-secrets.ts");

const token = "t".repeat(43);
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ace-account-secrets-"));
  keychain.touches = 0;
  keychain.available = true;
});
afterEach(() => rm(directory, { recursive: true, force: true }));

describe("account sessions", () => {
  it("someone who never signed in has none, and the keychain is never touched for it", async () => {
    const secrets = accountSecrets(directory);
    expect(await secrets.all()).toEqual({});
    expect(await secrets.read("https://acehq.dev")).toBeNull();
    expect(keychain.touches).toBe(0);
  });

  it("a saved session is read back through the keychain", async () => {
    const secrets = accountSecrets(directory);
    await secrets.write("https://acehq.dev", token);
    expect(await accountSecrets(directory).read("https://acehq.dev")).toBe(token);
  });

  it("a first sign-in is refused when secure storage is unavailable, never written in the clear", async () => {
    keychain.available = false;
    const secrets = accountSecrets(directory);
    await expect(secrets.write("https://acehq.dev", token)).rejects.toThrow("unavailable");
  });

  it("a saved file is refused when secure storage is unavailable", async () => {
    await writeFile(join(directory, "ace-account.enc"), "sealed:{}");
    keychain.available = false;
    await expect(accountSecrets(directory).all()).rejects.toThrow("unavailable");
  });
});
