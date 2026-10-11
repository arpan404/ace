import { mkdtemp, mkdir, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { ProviderInstance } from "@ace/protocol/accounts";
import { createInstance, openRegistryIndex } from "./index.ts";

test.each(["physical", "ancestor alias"])(
  "a signed-in managed account remains usable after reopening through its %s data root",
  async (pathKind) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ace-managed-restart-")));
    const physical = join(root, "physical");
    await mkdir(physical);
    const alias = join(root, "alias");
    await symlink(physical, alias);
    const dataDir = join(pathKind === "physical" ? physical : alias, "data");
    await mkdir(dataDir);
    const homeDir = join(physical, "data", "account-homes", "managed-codex");
    await mkdir(join(homeDir, "user"), { recursive: true });
    const instance: ProviderInstance = {
      ...createInstance({ id: "managed-codex", provider: "codex", label: "Selected", homeDir }),
      managed: true,
    };
    const path = join(dataDir, "accounts.sqlite");
    let registry = await openRegistryIndex(path, undefined, dataDir);
    try {
      await registry.register(instance);
      registry.ingest(instance.id, {
        provider: "codex",
        payload: new ProviderPayload('{"auth":"logged_in"}'),
        observedAt: 10,
        timeZone: "UTC",
      });
      await expect(registry.validateHome(instance)).resolves.toBeUndefined();
      registry.close();
      registry = await openRegistryIndex(path, undefined, dataDir);
      await registry.ready;
      expect(registry.summary(instance.id, 10)).toMatchObject({
        availability: "available",
        quota: { auth: "logged_in", blockers: {} },
      });
      expect(registry.summary(instance.id, 10)?.quota.blockers).toEqual({});
      await expect(registry.validateHome(instance)).resolves.toBeUndefined();
    } finally {
      registry.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  "foreign owner",
  "data root symlink",
  "data root alias",
  "parent symlink",
  "account symlink",
])("reopening refuses a managed account with a %s", async (scenario) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-managed-refusal-")));
  const dataDir = join(root, "data");
  const parent = join(dataDir, "account-homes");
  const homeDir = join(parent, "managed-codex");
  await mkdir(join(homeDir, "user"), { recursive: true });
  const instance: ProviderInstance = {
    ...createInstance({ id: "managed-codex", provider: "codex", label: "Work", homeDir }),
    managed: true,
  };
  const path = join(root, "accounts.sqlite");
  let registry = await openRegistryIndex(path, undefined, dataDir);
  try {
    await registry.register(instance);
    registry.close();
    let owner = dataDir;
    if (scenario === "foreign owner") {
      owner = join(root, "other-data");
      await mkdir(owner);
    } else if (scenario === "data root alias") {
      // The stored physical home remains valid; only the injected data root is an alias.
      owner = join(root, "alias-data");
      await symlink(dataDir, owner);
    } else {
      const target =
        scenario === "data root symlink"
          ? dataDir
          : scenario === "parent symlink"
            ? parent
            : homeDir;
      const moved = join(root, "moved");
      await rename(target, moved);
      await symlink(moved, target);
    }
    registry = await openRegistryIndex(path, undefined, owner);
    await registry.ready;
    expect(registry.summary(instance.id, 10)?.availability).toBe("unknown");
    expect(registry.summary(instance.id, 10)?.quota.blockers.homeUnavailable).toBe(
      scenario === "foreign owner" ? "foreign_home" : "home_unreadable",
    );
    await expect(registry.validateHome(instance)).rejects.toThrow();
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
