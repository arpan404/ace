import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { fingerprint } from "./index.ts";
import { loadOrCreateHostKeys } from "./node.ts";

const windows = process.platform === "win32";

async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "ace-relay-keys-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

it.runIf(windows)(
  "on Windows, concurrent starts and a restart share one relay identity",
  async () => {
    const dir = await directory();
    const keys = await Promise.all(Array.from({ length: 8 }, () => loadOrCreateHostKeys(dir)));
    const restarted = await loadOrCreateHostKeys(dir);
    for (const key of keys)
      expect(fingerprint(key.publicKey)).toBe(fingerprint(restarted.publicKey));
  },
);

it.runIf(windows)(
  "on Windows, a corrupt relay key fails instead of silently rotating the identity",
  async () => {
    const dir = await directory();
    await loadOrCreateHostKeys(dir);
    await writeFile(join(dir, "noise-static.key"), new Uint8Array(31));
    await expect(loadOrCreateHostKeys(dir)).rejects.toThrow("Invalid stored static key");
  },
);

it.runIf(windows)(
  "on Windows, a relay key that is a symbolic link is refused, not followed",
  async ({ skip }) => {
    const dir = await directory();
    const other = await directory();
    await writeFile(join(other, "real.key"), new Uint8Array(32));
    const linked = await symlink(join(other, "real.key"), join(dir, "noise-static.key"), "file")
      .then(() => true)
      .catch((error: unknown) => {
        // Only the missing privilege means "not available here"; anything else is a failure.
        if (error instanceof Error && "code" in error && error.code === "EPERM") return false;
        throw error;
      });
    if (!linked)
      skip("Creating file symbolic links needs Developer Mode or an administrator (EPERM)");
    await expect(loadOrCreateHostKeys(dir)).rejects.toThrow("regular file");
  },
);
