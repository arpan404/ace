import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appKeyStore } from "./app-key-store.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function folder() {
  const root = await mkdtemp(join(tmpdir(), "ace-app-keys-"));
  roots.push(root);
  return root;
}

const mask = (bytes: Buffer) => Buffer.from(bytes.map((byte) => byte ^ 0x5a));
/** The OS keychain's encryption, as `safeStorage` gives it: reversible only with the box. */
function keychain(available = true) {
  return {
    available: () => available,
    encrypt: (text: string) => mask(Buffer.from(text)),
    decrypt: (bytes: Buffer) => mask(bytes).toString(),
  };
}
let seeds = 0;
const seed = () => new Uint8Array(32).fill(++seeds);

describe("the app's keys for daemons it didn't start", () => {
  it("keeps one key per daemon home, and gives it back on the next launch", async () => {
    const root = await folder();
    const first = await appKeyStore(root, keychain(), seed).pair("host-a");
    const again = await appKeyStore(root, keychain(), seed).pair("host-a");
    const elsewhere = await appKeyStore(root, keychain(), seed).pair("host-b");
    expect(again).toEqual(first);
    expect(elsewhere?.x).not.toBe(first?.x);
  });

  it("writes the private key only as the keychain encrypted it", async () => {
    const root = await folder();
    const pair = await appKeyStore(root, keychain(), seed).pair("host-a");
    const files = await readdir(root);
    expect(files).toEqual(["daemon-app-keys.enc"]);
    const bytes = await readFile(join(root, files[0] ?? ""));
    expect(bytes.toString()).not.toContain(pair?.d ?? "missing");
  });

  it("makes and keeps no key when the keychain can't encrypt (Linux's basic_text)", async () => {
    const root = await folder();
    expect(await appKeyStore(root, keychain(false), seed).pair("host-a")).toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });
});
