import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { expect, test } from "vitest";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { AccountManagement } from "./account-management.ts";
import { harness } from "./account-management-test-support.ts";
import { fakeCli } from "./provider-status-test-support.ts";

test("restart keeps a custom executable's signed-in account and model catalog despite a conflicting PATH CLI", async () => {
  const f = await harness();
  let restored: AccountManagement | undefined;
  try {
    const account = await f.add();
    const instance = f.registry.get(account.id)?.instance;
    if (!instance) throw new Error("Missing account");
    const customBin = join(f.root, "custom");
    await mkdir(customBin);
    const custom = join(customBin, "codex");
    await copyFile(join(f.bin, "codex"), custom);
    await writeFile(join(instance.homeDir, "fixture-signed-in"), "synthetic login");
    f.registry.ingest(instance.id, {
      provider: "codex",
      payload: new ProviderPayload('{"auth":"logged_in"}'),
      observedAt: 100,
      timeZone: "UTC",
    });
    await fakeCli(f.bin, "codex", "codex-cli 0.150.0", "Not logged in", "login status");
    await f.management.close();
    restored = new AccountManagement({
      registry: f.registry,
      accounts: f.accounts,
      dataDir: f.dataDir,
      env: f.env,
      now: () => 100,
      id: () => "unused",
      models: () => f.models,
      configuration: () => ({ binaryPath: custom }),
    });
    await restored.initialize();
    await restored.close();
    expect(f.registry.summary(instance.id, 100)?.quota.auth).toBe("logged_in");
    expect(
      f.models.list({ instance: instance.id }).models.map((row) => row.nativeModelId),
    ).toContain("fixture-account-model");
  } finally {
    await restored?.close();
    await f.close();
  }
});

test("managed login and logout use the configured executable absent from PATH and refresh through it", async () => {
  let binaryPath: string | undefined;
  const f = await harness(false, { configuration: () => ({ binaryPath }) });
  try {
    const customBin = join(f.root, "custom");
    await mkdir(customBin);
    binaryPath = join(customBin, "codex");
    await copyFile(join(f.bin, "codex"), binaryPath);
    await rm(join(f.bin, "codex"));
    const account = await f.add();
    await f.flow(account.id, "login");
    expect((await f.status(account.id))?.quota.auth).toBe("logged_in");
    expect(
      f.models.list({ instance: account.id }).models.map((row) => row.nativeModelId),
    ).toContain("fixture-account-model");
    await f.flow(account.id, "logout");
    expect((await f.status(account.id))?.quota.auth).toBe("logged_out");
    expect(f.models.list({ instance: account.id }).models).toEqual([]);
    const instance = f.registry.get(account.id)?.instance;
    if (!instance) throw new Error("Missing account");
    const launch = z
      .object({ args: z.array(z.string()), env: z.record(z.string(), z.string().nullable()) })
      .parse(JSON.parse(await readFile(join(instance.homeDir, "fixture-launch.json"), "utf8")));
    expect(launch).toMatchObject({
      args: ["logout"],
      env: {
        CODEX_HOME: instance.homeDir,
        HOME: join(instance.homeDir, "user"),
        OPENAI_API_KEY: null,
      },
    });
  } finally {
    await f.close();
  }
});

test.each(["configuration", "login revision"])(
  "an outdated restoration probe cannot sign out an account after its %s changes",
  async (change) => {
    const f = await harness();
    let restored: AccountManagement | undefined;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      const account = await f.add();
      const instance = f.registry.get(account.id)?.instance;
      if (!instance) throw new Error("Missing account");
      await writeFile(join(instance.homeDir, "fixture-signed-in"), "synthetic login");
      f.registry.ingest(instance.id, {
        provider: "codex",
        payload: new ProviderPayload('{"auth":"logged_in"}'),
        observedAt: 100,
        timeZone: "UTC",
      });
      await f.management.close();
      let binaryPath = join(f.bin, "codex");
      restored = new AccountManagement({
        registry: f.registry,
        accounts: f.accounts,
        dataDir: f.dataDir,
        env: f.env,
        now: () => 100,
        id: () => "unused",
        models: () => f.models,
        configuration: () => ({ binaryPath }),
        discovery: {
          probe: async (_path, args) => {
            if (args[0] === "--version")
              return { code: 0, stdout: "codex-cli 0.150.0", stderr: "" };
            entered.resolve();
            await release.promise;
            return { code: 0, stdout: "Not logged in", stderr: "" };
          },
        },
      });
      await restored.initialize();
      await entered.promise;
      if (change === "configuration") binaryPath = join(f.bin, "new-codex");
      else f.registry.loginChanged(instance.id);
      release.resolve();
      await restored.close();
      expect(f.registry.summary(instance.id, 100)?.quota.auth).toBe("logged_in");
      expect(f.models.hasInstance(instance.id)).toBe(true);
    } finally {
      release.resolve();
      await restored?.close();
      await f.close();
    }
  },
);
