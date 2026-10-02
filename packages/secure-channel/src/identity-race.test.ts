import {
  appendFile,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadOrCreateHostKeys } from "@ace/secure-channel/node";
import type { OpenHostIdentity } from "@ace/secure-channel/node";
import { fingerprint, keyPair } from "./index.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function identity() {
  const dir = await mkdtemp(join(tmpdir(), "ace-key-race-"));
  directories.push(dir);
  const path = join(dir, "noise-static.key");
  const bytes = new Uint8Array(32).fill(27);
  await writeFile(path, bytes, { mode: 0o600 });
  return { dir, path, bytes };
}

// Use actual read-only descriptors and actual competing filesystem writes. Only their
// ordering is controlled at the injected opener, without timers or polling.
function orderedIdentityReader(hooks: {
  afterFirstStat?: () => Promise<void>;
  afterRead?: (bytes: number, position: number) => Promise<void>;
}): OpenHostIdentity {
  return async (path, flags) => {
    const file = await open(path, flags);
    let firstStat = true;
    return {
      async stat() {
        const info = await file.stat();
        if (firstStat) {
          firstStat = false;
          await hooks.afterFirstStat?.();
        }
        return info;
      },
      async read(buffer, offset, length, position) {
        const result = await file.read(buffer, offset, length, position);
        await hooks.afterRead?.(result.bytesRead, position);
        return result;
      },
      close: () => file.close(),
    };
  };
}

it.each([31, 33])(
  "an identity changed to %i bytes after validation rejects instead of publishing keys",
  async (size) => {
    const { dir, path } = await identity();
    const opener = orderedIdentityReader({ afterFirstStat: () => truncate(path, size) });
    await expect(loadOrCreateHostKeys(dir, opener)).rejects.toThrow("Invalid stored static key");
    expect((await stat(path)).size).toBe(size);
  },
);

it("a trailing byte observed during reading rejects even when the file returns to 32 bytes", async () => {
  const { dir, path, bytes } = await identity();
  const opener = orderedIdentityReader({
    afterFirstStat: () => appendFile(path, new Uint8Array([42])),
    async afterRead(_length, position) {
      if (position === 0) await truncate(path, 32);
    },
  });
  await expect(loadOrCreateHostKeys(dir, opener)).rejects.toThrow("Invalid stored static key");
  expect(await readFile(path)).toEqual(Buffer.from(bytes));
});

it.each([31, 33])(
  "an identity changed to %i bytes after EOF rejects before returning a key",
  async (size) => {
    const { dir, path } = await identity();
    const opener = orderedIdentityReader({
      async afterRead(length, position) {
        if (length === 0 && position === 32) await truncate(path, size);
      },
    });
    await expect(loadOrCreateHostKeys(dir, opener)).rejects.toThrow("Invalid stored static key");
    expect((await stat(path)).size).toBe(size);
  },
);

const shortReads: OpenHostIdentity = async (path, flags) => {
  const file = await open(path, flags);
  return {
    stat: () => file.stat(),
    read: (buffer, offset, length, position) =>
      file.read(buffer, offset, Math.min(length, 7), position),
    close: () => file.close(),
  };
};

it("short descriptor reads still reconstruct the complete unchanged identity", async () => {
  const { dir, bytes } = await identity();
  const keys = await loadOrCreateHostKeys(dir, shortReads);
  expect(fingerprint(keys.publicKey)).toBe(fingerprint(keyPair(bytes).publicKey));
});
