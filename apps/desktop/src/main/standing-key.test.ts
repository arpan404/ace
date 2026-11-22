import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { statementText, verifyStatement } from "@ace/account-grant/person-statement";
import { standingKeys, type DeviceKey, type Sealer } from "./standing-key.ts";

/*
 * This device's key (ADR 0190, amendment 1): sealed at rest, one per account backend, signing
 * only a person's statement for its own account and device, gone when forgotten.
 */

const origin = "https://acehq.dev";
const session = "a".repeat(64);
/** `safeStorage` as the keychain-held key seals: what's written is never the clear text. */
const sealer: Sealer = {
  available: () => true,
  seal: (text) => Buffer.from(Buffer.from(text, "utf8").map((byte) => byte ^ 0x5a)),
  open: (bytes) => Buffer.from(bytes.map((byte) => byte ^ 0x5a)).toString("utf8"),
};
const statement = (key: DeviceKey, account = key.account) =>
  statementText({
    account,
    device: key.id,
    purpose: "standing",
    action: "socket",
    target: "t".repeat(43),
    audience: "H".repeat(52),
    nonce: "n".repeat(43),
    iat: 1_000,
    exp: 31_000,
  });

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ace-standing-key-"));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

test("the key signs its own statement, any verifier with its public half checks it, and it is never on disk in the clear", async () => {
  const made = await standingKeys(directory, sealer).make(origin, "user_1", session);
  // Another start of the app reads the same key back.
  const later = standingKeys(directory, sealer);
  expect((await later.held(origin))?.publicKey).toBe(made.publicKey);
  const text = statement(made);
  const proof = await later.sign(origin, text);
  expect(
    await verifyStatement({ text, proof: proof ?? "", publicKey: made.publicKey, now: 2_000 }),
  ).toMatchObject({ account: "user_1", device: made.id, purpose: "standing" });
  const onDisk = await readFile(join(directory, "ace-standing-key.enc"), "utf8");
  expect(onDisk).not.toContain("user_1");
  expect(() => JSON.parse(onDisk) as unknown).toThrow();
});

test("it signs nothing but its own account's statement", async () => {
  const keys = standingKeys(directory, sealer);
  const made = await keys.make(origin, "user_1", session);
  await expect(keys.sign(origin, "transfer all credits")).rejects.toThrow();
  await expect(keys.sign(origin, `${statement(made)}\nextra=1`)).rejects.toThrow();
  await expect(keys.sign(origin, statement(made, "user_2"))).rejects.toThrow();
  // A key made since replaces it: a statement naming the old device signs nothing.
  await keys.make(origin, "user_1", session);
  await expect(keys.sign(origin, statement(made))).rejects.toThrow();
});

test("forgetting the key ends it, and a store that can't seal writes nothing", async () => {
  const keys = standingKeys(directory, sealer);
  const made = await keys.make(origin, "user_1", session);
  await keys.forget(origin);
  expect(await keys.sign(origin, statement(made))).toBeNull();
  const plain = standingKeys(directory, { ...sealer, available: () => false });
  await expect(plain.make(origin, "user_1", session)).rejects.toThrow(
    "Secure storage is unavailable",
  );
  await expect(readFile(join(directory, "ace-standing-key.enc"))).rejects.toThrow();
});
