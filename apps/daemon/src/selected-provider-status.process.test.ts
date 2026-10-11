import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createInstance, openRegistryIndex } from "@ace/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { createLogger } from "@ace/diagnostics";
import { fixture } from "./socket-test-support.ts";
import { fakeCli } from "./provider-status-test-support.ts";
import { startProviderStatuses } from "./services/provider-status.ts";
import { Resources } from "./services/resources.ts";
import type { ServiceContext } from "./services/types.ts";
import { readConfig } from "./config.ts";
import { Onboarding } from "./onboarding.ts";
import { harness } from "./account-management-test-support.ts";
import { SettingsService } from "@ace/settings";
import { ProviderConfigurationsState } from "./provider-configurations.ts";

test("readiness and onboarding follow the selected account while retaining discovery errors", async () => {
  const f = await fixture();
  const registry = await openRegistryIndex(join(f.home, "accounts.sqlite"));
  const resources = new Resources();
  const log = createLogger({
    now: () => 100,
    redact: (line) => line,
    sink: { write: async () => {}, close: async () => {} },
  });
  let onboarding: Onboarding | undefined;
  try {
    const bin = join(f.home, "bin");
    await mkdir(bin);
    await fakeCli(bin, "codex", "codex-cli 0.159.1", "Not logged in", "login status");
    for (const [id, auth] of [
      ["signed-in", "logged_in"],
      ["signed-out", "logged_out"],
    ] as const) {
      const homeDir = join(f.home, id);
      await mkdir(homeDir);
      await registry.register(createInstance({ id, provider: "codex", label: id, homeDir }));
      registry.recordAuth(id, "browser", `${id}@example.test`);
      registry.ingest(id, {
        provider: "codex",
        payload: new ProviderPayload(JSON.stringify({ auth })),
        observedAt: 100,
        timeZone: "UTC",
      });
    }
    registry.selectProvider("codex", "signed-in");
    let failVersion = false;
    const context: ServiceContext = {
      signal: new AbortController().signal,
      config: readConfig({ ACE_HOME: f.home }),
      store: f.store,
      now: () => 100,
      id: () => "test-id",
      log,
      resources,
      services: { accountRegistry: registry },
      onListen: [],
      options: {
        providerStatus: {
          env: { HOME: f.home, PATH: bin },
          cursorSdk: async () => ({ installed: false, auth: "unknown", loginHint: "" }),
          probe: async (_path, args, options) => {
            if (args[0] === "--version") {
              if (failVersion) throw new Error("Discovery failed");
              return { code: 0, stdout: "codex-cli 0.159.1", stderr: "" };
            }
            return {
              code: 0,
              stdout:
                options?.env?.CODEX_HOME === join(f.home, "signed-in")
                  ? "Logged in using ChatGPT"
                  : "Not logged in",
              stderr: "",
            };
          },
        },
      },
    };
    startProviderStatuses(context);
    const statuses = context.services.providerStatuses;
    if (!statuses) throw new Error("Missing status service");
    await statuses.refresh();
    onboarding = new Onboarding(join(f.home, "onboarding.sqlite"), statuses);
    expect(statuses.readiness().find((row) => row.provider === "codex")).toMatchObject({
      auth: "logged_in",
      readiness: "signed_in",
      instanceId: "signed-in",
      accountLabel: "signed-in@example.test",
    });
    expect(statuses.list().find((row) => row.provider === "codex")).not.toHaveProperty("actionId");
    expect(onboarding.query("device", "query")).toMatchObject({ result: { ready: ["codex"] } });
    registry.selectProvider("codex", "signed-out");
    await statuses.refreshAfterMutation();
    expect(statuses.readiness().find((row) => row.provider === "codex")).toMatchObject({
      auth: "logged_out",
      readiness: "installed_signed_out",
      instanceId: "signed-out",
      accountLabel: "signed-out@example.test",
      actionId: "provider.sign_in",
    });
    registry.selectProvider("codex", "signed-in");
    failVersion = true;
    await statuses.refresh();
    expect(statuses.readiness().find((row) => row.provider === "codex")).toMatchObject({
      auth: "logged_in",
      readiness: "needs_attention",
      error: expect.any(String),
    });
    expect(onboarding.query("device", "error")).toMatchObject({ result: { ready: [] } });
  } finally {
    onboarding?.close();
    await resources.close();
    await log.close();
    registry.close();
    await f.close();
  }
});

test("selected account discovery uses its executable and enabled setting instead of PATH or saved auth from another executable", async () => {
  const f = await harness();
  const resources = new Resources();
  const log = createLogger({
    now: () => 100,
    redact: (value) => value,
    sink: { write: async () => {}, close: async () => {} },
  });
  let onboarding: Onboarding | undefined;
  try {
    const account = await f.add();
    const instance = f.registry.get(account.id)?.instance;
    if (!instance) throw new Error("Missing managed account");
    const custom = join(f.root, "custom");
    await mkdir(custom);
    const executable = join(custom, "codex");
    await copyFile(join(f.bin, "codex"), executable);
    await rm(join(f.bin, "codex"));
    await writeFile(join(instance.homeDir, "fixture-signed-in"), "synthetic login");
    const replacement = await fakeCli(
      custom,
      "other-codex",
      "codex-cli 0.159.1",
      "Not logged in",
      "login status",
    );
    f.registry.ingest(instance.id, {
      provider: "codex",
      payload: new ProviderPayload('{"auth":"logged_in"}'),
      observedAt: 100,
      timeZone: "UTC",
    });
    f.registry.selectProvider("codex", instance.id);
    const settings = new SettingsService({ dataDir: f.dataDir });
    resources.own(() => settings.close());
    await settings.set(
      "providers.configuration",
      [{ provider: "codex", instance: instance.id, binaryPath: executable }],
      { kind: "global" },
    );
    const configurations = new ProviderConfigurationsState();
    resources.own(await configurations.start(settings));
    const context: ServiceContext = {
      signal: new AbortController().signal,
      config: readConfig({ ACE_HOME: f.dataDir }),
      store: f.store,
      now: () => 100,
      id: () => "test-id",
      log,
      resources,
      onListen: [],
      services: { accountRegistry: f.registry, providerConfigurations: configurations },
      options: {
        providerStatus: {
          env: f.env,
          cursorSdk: async () => ({ installed: false, auth: "unknown", loginHint: "" }),
          versions: async () => ({}),
        },
      },
    };
    startProviderStatuses(context);
    const statuses = context.services.providerStatuses;
    if (!statuses) throw new Error("Missing provider statuses");
    await statuses.refresh();
    onboarding = new Onboarding(join(f.dataDir, "onboarding.sqlite"), statuses);
    expect(statuses.readiness().find((row) => row.provider === "codex")).toMatchObject({
      installed: true,
      auth: "logged_in",
      readiness: "signed_in",
      instanceId: instance.id,
      path: executable,
    });
    expect(onboarding.query("device", "ready")).toMatchObject({ result: { ready: ["codex"] } });
    await settings.set(
      "providers.configuration",
      [{ provider: "codex", instance: instance.id, binaryPath: executable, enabled: false }],
      { kind: "global" },
    );
    expect(statuses.readiness().find((row) => row.provider === "codex")).toMatchObject({
      enabled: false,
      readiness: "disabled",
    });
    expect(onboarding.query("device", "disabled")).toMatchObject({ result: { ready: [] } });
    await settings.set(
      "providers.configuration",
      [{ provider: "codex", instance: instance.id, binaryPath: replacement }],
      { kind: "global" },
    );
    expect(statuses.readiness().find((row) => row.provider === "codex")?.readiness).not.toBe(
      "signed_in",
    );
    await statuses.refreshAfterMutation();
    expect(statuses.readiness().find((row) => row.provider === "codex")).toMatchObject({
      installed: true,
      auth: "logged_out",
      readiness: "installed_signed_out",
      path: replacement,
    });
    expect(onboarding.query("device", "signed-out")).toMatchObject({ result: { ready: [] } });
  } finally {
    onboarding?.close();
    await resources.close();
    await log.close();
    await f.close();
  }
});
