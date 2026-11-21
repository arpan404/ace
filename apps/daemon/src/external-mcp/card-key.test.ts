import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { cardKeys } from "./card-key.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ace-card-key-"));
  dirs.push(dir);
  return dir;
}

function pem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return String(privateKey.export({ type: "pkcs8", format: "pem" }));
}

test("a card key replaced on disk is the one used next, without a restart", () => {
  const dir = dataDir();
  const keys = cardKeys(dir);
  const first = keys.current().jwk.kid;
  expect(keys.current().jwk.kid).toBe(first);

  // Another file put in its place, as a tool rotating it atomically does.
  writeFileSync(join(dir, "a2a-card-key.pem.new"), pem(), { mode: 0o600 });
  renameSync(join(dir, "a2a-card-key.pem.new"), join(dir, "a2a-card-key.pem"));
  const second = keys.current().jwk.kid;
  expect(second).not.toBe(first);

  // New contents written over it.
  writeFileSync(join(dir, "a2a-card-key.pem"), pem(), { mode: 0o600 });
  expect(keys.current().jwk.kid).not.toBe(second);
});

test("rotating the card key keeps the new key for this run and the next", () => {
  const dir = dataDir();
  const keys = cardKeys(dir);
  const before = keys.current().jwk.kid;
  const rotated = keys.rotate().jwk.kid;
  expect(rotated).not.toBe(before);
  expect(keys.current().jwk.kid).toBe(rotated);
  expect(cardKeys(dir).current().jwk.kid).toBe(rotated);
});
