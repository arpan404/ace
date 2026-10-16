import { afterEach, expect, test } from "vitest";
import { lstat, mkdir, realpath, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { ProviderInstance } from "@ace/protocol/accounts";
import { assertManagedHome, ensureManagedHomeSkeleton } from "./managed-home.ts";
import { createInstance } from "./instances.ts";
import { cleanup, temp } from "./test-support.ts";
afterEach(cleanup);

test("the skeleton creates every tool-facing directory with private modes", async () => {
  const homeDir = await realpath(await temp());
  await ensureManagedHomeSkeleton(homeDir);
  for (const dir of [
    "user",
    "user/.config",
    "user/.ssh",
    "appdata",
    "config",
    "data",
    "state",
    "cache",
  ]) {
    const entry = await lstat(join(homeDir, dir));
    expect(entry.isDirectory()).toBe(true);
    expect(entry.isSymbolicLink()).toBe(false);
    expect((await stat(join(homeDir, dir))).mode & 0o777).toBe(0o700);
  }
});

test("a symlinked skeleton path is refused instead of followed", async () => {
  const homeDir = await realpath(await temp());
  await mkdir(join(homeDir, "user"), { recursive: true, mode: 0o700 });
  await symlink(join(homeDir, "elsewhere"), join(homeDir, "user", ".ssh"));
  await expect(ensureManagedHomeSkeleton(homeDir)).rejects.toThrow("Managed home refused");
});

test("managed-home validation still passes after the skeleton is created", async () => {
  const dataDir = await temp();
  const parent = join(await realpath(dataDir), "account-homes");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const homeDir = join(parent, "skel");
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  const instance = ProviderInstance.parse({
    ...createInstance({ id: "skel", provider: "codex", label: "skel", homeDir }),
    managed: true,
  });
  await ensureManagedHomeSkeleton(homeDir);
  await assertManagedHome(dataDir, instance);
});
