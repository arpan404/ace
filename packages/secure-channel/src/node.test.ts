import { afterEach, expect, it } from "vitest";
import { mkdtemp, stat, chmod, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateHostKeys } from "./node.ts";
import { fingerprint } from "./index.ts";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "ace-relay-keys-"));
  dirs.push(dir);
  return dir;
}
it("concurrent starts and restarts use the same static identity stored with mode 0600", async () => {
  const dir = await directory();
  const keys = await Promise.all(Array.from({ length: 8 }, () => loadOrCreateHostKeys(dir)));
  const restarted = await loadOrCreateHostKeys(dir);
  for (const key of keys) expect(fingerprint(key.publicKey)).toBe(fingerprint(restarted.publicKey));
  expect((await stat(join(dir, "noise-static.key"))).mode & 0o777).toBe(0o600);
});
it("unsafe permissions and corrupt stored keys fail without silently rotating pairing identity", async () => {
  const dir = await directory();
  const original = await loadOrCreateHostKeys(dir);
  const path = join(dir, "noise-static.key");
  await chmod(path, 0o644);
  await expect(loadOrCreateHostKeys(dir)).rejects.toThrow("0600");
  await chmod(path, 0o600);
  expect((await loadOrCreateHostKeys(dir)).publicKey).toEqual(original.publicKey);
  await writeFile(path, new Uint8Array(3));
  await expect(loadOrCreateHostKeys(dir)).rejects.toThrow("Invalid stored");
});
it("a symlink cannot redirect loading of the daemon static secret", async () => {
  const dir = await directory();
  const outside = join(dir, "outside.key");
  await writeFile(outside, new Uint8Array(32), { mode: 0o600 });
  await symlink(outside, join(dir, "noise-static.key"));
  await expect(loadOrCreateHostKeys(dir)).rejects.toThrow();
});
