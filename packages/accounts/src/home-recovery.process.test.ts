import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { createInstance, openRegistry } from "./index.ts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { ProviderInstance } from "@ace/protocol/accounts";

test.each(["default", "managed"])(
  "recovering a %s Cursor folder survives restart and does not retain its lost sign-in",
  async (kind) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "account-repair-")));
    const homeDir = join(root, kind === "managed" ? "account-homes" : "instances", "cursor-work");
    const instance: ProviderInstance = {
      ...createInstance({ id: "cursor-work", provider: "cursor", label: "Work", homeDir }),
      ...(kind === "managed" ? { managed: true } : {}),
    };
    await mkdir(join(homeDir, "user"), { recursive: true });
    const path = join(root, "accounts.sqlite");
    let registry = await openRegistry(path);
    try {
      await registry.register(instance);
      registry.ingest(instance.id, {
        provider: "cursor",
        payload: new ProviderPayload('{"auth":"logged_in"}'),
        observedAt: 1,
        timeZone: "UTC",
      });
      registry.close();
      await rm(dirname(homeDir), { recursive: true });
      registry = await openRegistry(path);
      expect(registry.summary(instance.id, 1)?.quota.blockers.homeUnavailable).toBe("home_missing");
      await registry.restoreCursorHome(instance.id);
      expect(registry.summary(instance.id, 1)?.quota.auth).toBe("unknown");
      expect(registry.summary(instance.id, 1)?.quota.blockers.homeUnavailable).toBeUndefined();
      expect((await lstat(join(homeDir, "user"))).isDirectory()).toBe(true);
      registry.close();
      registry = await openRegistry(path);
      await expect(registry.validateHome(instance)).resolves.toBeUndefined();
      expect(registry.summary(instance.id, 1)?.quota.blockers.homeUnavailable).toBeUndefined();
    } finally {
      registry.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["parent", "home", "user", "sdk", "foreign"])(
  "Cursor recovery refuses a %s redirect and leaves the other folder untouched",
  async (redirect) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "account-repair-refused-")));
    const dataDir = join(root, "daemon");
    const homeDir = join(dataDir, "account-homes", "cursor-work");
    const outside = join(root, "outside");
    await mkdir(join(homeDir, "user"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "untouched");
    const instance: ProviderInstance = {
      ...createInstance({ id: "cursor-work", provider: "cursor", label: "Work", homeDir }),
      managed: true,
    };
    const path = join(dataDir, "accounts.sqlite");
    let registry = await openRegistry(path);
    try {
      await registry.register(instance);
      registry.close();
      await rm(homeDir, { recursive: true });
      const owner = redirect === "foreign" ? outside : dataDir;
      registry = await openRegistry(path, owner);
      if (redirect !== "foreign") {
        const target =
          redirect === "parent"
            ? dirname(homeDir)
            : redirect === "home"
              ? homeDir
              : redirect === "user"
                ? join(homeDir, "user")
                : join(homeDir, "user", ".cursor", "sdk");
        await rm(target, { recursive: true, force: true });
        await mkdir(dirname(target), { recursive: true });
        await symlink(outside, target);
      }
      await expect(registry.restoreCursorHome(instance.id)).rejects.toThrow();
      expect(registry.summary(instance.id, 1)?.quota.blockers.homeUnavailable).toBeDefined();
      expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("untouched");
      await expect(lstat(join(outside, "user"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      registry.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
