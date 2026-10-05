import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { ModelCatalog, openModelStorage, normalizeCodex, createModelDiscovery } from "@ace/models";
import type { ProviderConfigurations } from "@ace/protocol";
import { SettingsService } from "@ace/settings";
import { Clock, codexPayload, instance, workspace, deferred, fakeCli } from "./testing/support.ts";

const native = (providerID: string, status = "active") => ({
  id: `${providerID}/model`,
  providerID,
  modelID: "model",
  name: "Provider supplied name",
  enabled: true,
  status,
  limit: { context: 1000, output: 500 },
  capabilities: { input: { text: true } },
  variants: [],
});

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function setup() {
  const home = await workspace();
  cleanup.push(home.close);
  const clock = new Clock();
  const config = { ...instance(), cwd: home.path };
  const settings = new SettingsService({ dataDir: home.path });
  cleanup.push(() => settings.close());
  let preferences: ProviderConfigurations = [];
  const stop = await settings.subscribe(
    { scope: {}, keys: ["providers.configuration"] },
    (notification) => {
      if (notification.type === "changed")
        preferences = ProviderConfigurationsSchema.parse(notification.entries[0]?.value);
    },
  );
  cleanup.push(async () => stop());
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(home.path, "models.sqlite")),
    instances: [config],
    now: () => clock.now,
    deadline: clock.deadline,
    preferences: () => preferences,
    discover: async () => normalizeCodex(codexPayload(), config),
  });
  cleanup.push(() => catalog.close());
  return { catalog, settings, config, clock };
}
import { ProviderConfigurations as ProviderConfigurationsSchema } from "@ace/protocol";

test("hidden selections still resolve explicitly while automatic selection obeys visibility", async () => {
  const { catalog, settings } = await setup();
  await catalog.refresh();
  await settings.set(
    "providers.configuration",
    [
      {
        provider: "codex",
        hiddenModels: ["coder"],
        customModels: [{ id: "router/raw-id", displayName: "My model" }],
      },
    ],
    { kind: "global" },
  );
  expect(catalog.list().models).toMatchObject([
    { id: "coder", hidden: true, visibilityReason: "model_hidden" },
    { id: "router/raw-id", displayName: "My model", custom: true },
  ]);
  expect(catalog.resolve({ role: "worker", provider: "codex", model: "coder" })).toMatchObject({
    ok: true,
    model: { hidden: true, id: "coder" },
  });
  expect(catalog.resolve({ role: "worker", provider: "codex" })).toMatchObject({
    ok: true,
    model: { id: "router/raw-id" },
  });
  await settings.set("providers.configuration", [{ provider: "codex", enabled: false }], {
    kind: "global",
  });
  expect(catalog.list().models[0]).toMatchObject({ hidden: true, providerEnabled: false });
  expect(catalog.resolve({ role: "worker", provider: "codex", model: "coder" }).ok).toBe(false);
});

test("account overrides replace only supplied fields and favourites restrict automatic choices", async () => {
  const { catalog, settings } = await setup();
  await catalog.refresh();
  await settings.set(
    "providers.configuration",
    [
      { provider: "codex", hiddenModels: ["coder"] },
      {
        provider: "codex",
        instance: "codex",
        hiddenModels: [],
        favourites: ["coder"],
        showOnlyFavourites: true,
      },
    ],
    { kind: "global" },
  );
  expect(catalog.list().models[0]).toMatchObject({ id: "coder", hidden: false, favourite: true });
  await settings.set("providers.configuration", [{ provider: "codex", showOnlyFavourites: true }], {
    kind: "global",
  });
  expect(catalog.resolve({ role: "worker" }).ok).toBe(false);
  expect(catalog.resolve({ role: "worker", model: "coder" })).toMatchObject({
    ok: true,
    model: { visibilityReason: "not_favourite" },
  });
});

test("disabled discovery does no CLI work and refresh exposes progress, success and sanitized failure", async () => {
  const home = await workspace();
  cleanup.push(home.close);
  const clock = new Clock();
  const config = { ...instance(), cwd: home.path };
  let preferences: ProviderConfigurations = [{ provider: "codex", enabled: false }];
  let gate = deferred<ReturnType<typeof normalizeCodex>>();
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(home.path, "cache.sqlite")),
    instances: [config],
    now: () => clock.now,
    deadline: clock.deadline,
    preferences: () => preferences,
    discover: async (selected) => {
      if (selected.executable !== "/fixture/custom-cli")
        throw new Error("Incorrect binary or disabled discovery ran");
      return gate.promise;
    },
  });
  cleanup.push(() => catalog.close());
  await catalog.refresh();
  expect(catalog.list().instances[0]).toMatchObject({ enabled: false, refreshing: false });
  expect(catalog.list().instances[0]?.error).toBeUndefined();
  preferences = [{ provider: "codex", binaryPath: "/fixture/custom-cli" }];
  const refresh = catalog.refresh();
  expect(catalog.list().instances[0]?.refreshing).toBe(true);
  gate.resolve(normalizeCodex(codexPayload(), config));
  await refresh;
  expect(catalog.list().instances[0]).toMatchObject({ refreshing: false, lastRefreshedAt: 1000 });
  gate = deferred();
  const failed = catalog.refresh();
  gate.reject(new Error("secret provider detail"));
  await failed;
  expect(catalog.list().models[0]?.id).toBe("coder");
  expect(catalog.list().instances[0]?.error).toBe("discovery_failed");
});

test("OpenCode discovers only credential and environment connected upstreams and deduplicates qualified ids", async () => {
  const home = await workspace();
  cleanup.push(home.close);
  const script = await fakeCli(home.path);
  const config = {
    ...instance("opencode"),
    cwd: home.path,
    args: [script],
    env: { FAKE_PROVIDER: "opencode" },
  };
  const discover = createModelDiscovery({
    opencode: async () => ({
      location: { directory: home.path },
      data: [native("unconnected"), native("local", "legacy"), native("local", "legacy")],
    }),
  });
  expect(await discover(config, new AbortController().signal)).toMatchObject([
    {
      id: "local/model",
      nativeProviderId: "local",
      displayName: "Provider supplied name",
      legacy: true,
      deprecated: true,
    },
  ]);
});

test("provider configuration survives a restart and rejects unsafe values and non-global writes", async () => {
  const { settings, config } = await setup();
  await expect(
    settings.set(
      "providers.configuration",
      [{ provider: "codex", binaryPath: "codex; rm something" }],
      { kind: "global" },
    ),
  ).rejects.toMatchObject({ code: "validation" });
  await expect(
    settings.set(
      "providers.configuration",
      [{ provider: "codex", customModels: [{ id: "model\ninvalid", displayName: "Bad" }] }],
      { kind: "global" },
    ),
  ).rejects.toMatchObject({ code: "validation" });
  await expect(
    settings.set("providers.configuration", [{ provider: "codex" }, { provider: "codex" }], {
      kind: "global",
    }),
  ).rejects.toMatchObject({ code: "validation" });
  await expect(
    settings.set("providers.configuration", [], { kind: "workspace", workspace: config.cwd }),
  ).rejects.toMatchObject({ code: "validation" });
  const value = [{ provider: "codex" as const, enabled: false, favourites: ["coder"] }];
  await settings.set("providers.configuration", value, { kind: "global" });
  const restarted = new SettingsService({ dataDir: config.cwd });
  cleanup.push(() => restarted.close());
  expect((await restarted.get("providers.configuration")).value).toEqual(value);
});

test("OpenCode's id-only fallback excludes unconnected providers before imposing the result cap", async () => {
  const home = await workspace();
  cleanup.push(home.close);
  const script = await fakeCli(home.path);
  const config = {
    ...instance("opencode"),
    cwd: home.path,
    args: [script],
    env: {
      FAKE_PROVIDER: "opencode",
      FAKE_MODEL_IDS: [
        "other/not-usable",
        "local/muse-spark-1.3-contributor",
        "local/muse-spark-1.3-contributor",
      ].join("\n"),
    },
  };
  const discover = createModelDiscovery({
    opencode: async () => ({ location: { directory: home.path }, data: [] }),
  });
  expect(await discover(config, new AbortController().signal)).toMatchObject([
    {
      id: "local/muse-spark-1.3-contributor",
      nativeProviderId: "local",
      displayName: "Muse Spark 1.3 Contributor",
    },
  ]);
});

test("OpenCode's empty connection status never expands into the global catalog", async () => {
  const home = await workspace();
  cleanup.push(home.close);
  const script = await fakeCli(home.path);
  const config = {
    ...instance("opencode"),
    cwd: home.path,
    args: [script],
    env: { FAKE_PROVIDER: "opencode", FAKE_CONNECTIONS: "[]" },
  };
  const discover = createModelDiscovery({
    opencode: async () => {
      throw new Error("Catalog should not run without connections");
    },
  });
  expect(await discover(config, new AbortController().signal)).toEqual([]);
});

test("a binary change fences an older refresh and retains only metadata from the new executable", async () => {
  const home = await workspace();
  cleanup.push(home.close);
  const config = { ...instance(), cwd: home.path };
  let preferences: ProviderConfigurations = [{ provider: "codex", binaryPath: "/old-cli" }];
  const old = deferred<ReturnType<typeof normalizeCodex>>();
  const started = deferred<void>();
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(home.path, "cache.sqlite")),
    instances: [config],
    now: () => 1,
    deadline: () => () => {},
    preferences: () => preferences,
    discover: async (selected) => {
      if (selected.executable === "/old-cli") {
        started.resolve();
        return old.promise;
      }
      return normalizeCodex(codexPayload("new-model"), config);
    },
  });
  cleanup.push(() => catalog.close());
  const flight = catalog.refresh();
  await started.promise;
  preferences = [{ provider: "codex", binaryPath: "/new-cli" }];
  catalog.configurationChanged();
  old.resolve(normalizeCodex(codexPayload("old-model"), config));
  await flight;
  await catalog.refresh();
  expect(catalog.list().models.map((row) => row.id)).toEqual(["new-model"]);
});
