import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { accountSecrets, type SecretCipher } from "./account-secrets.ts";

/** A keychain identity: bytes one identity wrote decrypt to noise under another. */
function identity(key: number, available = true): () => Promise<SecretCipher> {
  const flip = (bytes: Buffer) => Buffer.from(bytes.map((byte) => byte ^ key));
  return async () => ({
    available: () => available,
    encrypt: (text) => flip(Buffer.from(text)),
    decrypt: (bytes) => flip(bytes).toString(),
  });
}

const origin = "https://acehq.dev";
const token = "a".repeat(43);
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ace-account-secrets-"));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

it("reads back the session it saved", async () => {
  const secrets = accountSecrets(directory, identity(0x5a));
  await secrets.write(origin, token);
  expect(await secrets.read(origin)).toBe(token);
  expect(await secrets.read("https://other.example")).toBeNull();
});

it("asks for sign-in again under a new keychain identity, and keeps the old session's file", async () => {
  await accountSecrets(directory, identity(0x5a)).write(origin, token);
  const before = await readFile(join(directory, "ace-account.enc"));
  const renamed = accountSecrets(directory, identity(0x33));
  // Unreadable: the app treats it as signed out and asks to sign in.
  await expect(renamed.read(origin)).rejects.toThrow("Couldn't read your ace account session");
  const fresh = "b".repeat(43);
  await renamed.write(origin, fresh);
  expect(await renamed.read(origin)).toBe(fresh);
  const kept = (await readdir(directory)).filter((name) =>
    name.startsWith("ace-account.unreadable-"),
  );
  expect(kept).toHaveLength(1);
  expect(await readFile(join(directory, kept[0] ?? ""))).toEqual(before);
});

it("refuses to store sessions where only plaintext storage exists", async () => {
  const secrets = accountSecrets(directory, identity(0x5a, false));
  await expect(secrets.write(origin, token)).rejects.toThrow(
    "Secure account storage is unavailable",
  );
  expect(await readdir(directory)).toEqual([]);
});
