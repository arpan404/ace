import { createPublicKey, verify } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { appStandingText } from "@ace/client/standing";
import { standingKeys, type Sealer } from "./standing-key.ts";

/*
 * The person's standing key main keeps (ADR 0190, amendment 1): encrypted at rest, per account,
 * signing only an app-standing challenge, gone on sign-out.
 */

const origin = "https://acehq.dev";
/** `safeStorage` as the keychain-held key seals: what's written is never the clear text. */
const sealer: Sealer = {
  available: () => true,
  seal: (text) => Buffer.from(Buffer.from(text, "utf8").map((byte) => byte ^ 0x5a)),
  open: (bytes) => Buffer.from(bytes.map((byte) => byte ^ 0x5a)).toString("utf8"),
};
const challenge = appStandingText({
  host: "H".repeat(52),
  nonce: "nonce_1",
  binding: undefined,
  deviceId: "window-1",
});

/** Whether `proof` is `key`'s signature over `text`, as the daemon checks it. */
function verifies(key: string, proof: string, text: string) {
  const point = Buffer.from(key, "base64url");
  const publicKey = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  return verify(
    "sha256",
    Buffer.from(text),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(proof, "base64url"),
  );
}

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ace-standing-key-"));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

test("the key signs a socket's challenge for its own account, survives a restart and is never on disk in the clear", async () => {
  const key = await standingKeys(directory, sealer).key(origin, "user_1");
  // Another start of the app reads the same key back.
  const later = standingKeys(directory, sealer);
  expect(await later.key(origin, "user_1")).toBe(key);
  const signed = await later.sign(origin, "user_1", challenge);
  expect(signed?.key).toBe(key);
  expect(verifies(key, signed?.proof ?? "", challenge)).toBe(true);
  const onDisk = await readFile(join(directory, "ace-standing-key.enc"), "utf8");
  expect(onDisk).not.toContain("user_1");
  expect(() => JSON.parse(onDisk) as unknown).toThrow();
});

test("it signs nothing but a standing challenge, and nothing for another account", async () => {
  const keys = standingKeys(directory, sealer);
  await keys.key(origin, "user_1");
  await expect(keys.sign(origin, "user_1", "transfer all credits")).rejects.toThrow();
  await expect(keys.sign(origin, "user_1", `${challenge}\nextra`)).rejects.toThrow();
  expect(await keys.sign(origin, "user_2", challenge)).toBeNull();
  // Another account signing in replaces the key: the old one signs nothing again.
  const next = await keys.key(origin, "user_2");
  expect(await keys.sign(origin, "user_1", challenge)).toBeNull();
  expect((await keys.sign(origin, "user_2", challenge))?.key).toBe(next);
});

test("signing out forgets the key, and a store that can't seal writes nothing", async () => {
  const keys = standingKeys(directory, sealer);
  await keys.key(origin, "user_1");
  await keys.forget(origin);
  expect(await keys.sign(origin, "user_1", challenge)).toBeNull();
  const plain = standingKeys(directory, { ...sealer, available: () => false });
  await expect(plain.key(origin, "user_1")).rejects.toThrow("Secure storage is unavailable");
  await expect(readFile(join(directory, "ace-standing-key.enc"))).rejects.toThrow();
});
