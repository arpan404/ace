import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountService, openRegistry } from "@ace/accounts";
import { expect, test } from "vitest";
import { AccountManagement } from "./account-management.ts";

for (const homeAlreadyRemoved of [false, true]) {
  test(`restart discards an abandoned login ${homeAlreadyRemoved ? "after its home was removed" : "with its private home"} without publishing an account`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-pending-restart-"));
    const dataDir = join(root, "data");
    await mkdir(dataDir);
    const path = join(dataDir, "accounts.sqlite");
    const env = { HOME: join(root, "normal"), PATH: "" };
    let registry = await openRegistry(path, dataDir);
    const management = () =>
      new AccountManagement({
        registry,
        dataDir,
        env,
        accounts: new AccountService({ registry, env, now: () => 1000, timeZone: "UTC" }),
        now: () => 1000,
        id: () => "staged",
        models: () => undefined,
      });
    const before = management();
    let after: AccountManagement | undefined;
    try {
      await before.initialize();
      const id = await before.addPending("codex", "Unfinished");
      expect(registry.summaries(1000).some((account) => account.id === id)).toBe(false);
      if (homeAlreadyRemoved) await rm(join(dataDir, "account-homes", id), { recursive: true });
      await before.close();
      registry.close();
      registry = await openRegistry(path, dataDir);
      after = management();
      await after.initialize();
      expect(registry.summaries(1000).some((account) => account.label === "Unfinished")).toBe(
        false,
      );
      expect(await readdir(join(dataDir, "account-homes"))).toEqual([]);
      // The normal CLI profile is just metadata: recovery never creates or changes its files.
      expect(await readdir(root)).toEqual(["data"]);
    } finally {
      await after?.close();
      registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
