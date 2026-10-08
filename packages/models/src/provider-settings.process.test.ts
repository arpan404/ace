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

test("custom names and configured ordering survive names that resemble snapshots or versions", async () => {
  const { catalog, settings } = await setup();
  await catalog.refresh();
  await settings.set(
    "providers.configuration",
    [
      {
        provider: "codex",
        customModels: [
          { id: "custom-0", displayName: "Custom 0" },
          { id: "custom-127", displayName: "Office preview 20261006" },
          { id: "gpt-6", displayName: "gpt-6" },
        ],
      },
    ],
    { kind: "global" },
  );
  expect(catalog.list().models.filter((model) => model.custom)).toMatchObject([
    { id: "custom-0", displayName: "Custom 0" },
    { id: "custom-127", displayName: "Office preview 20261006" },
    { id: "gpt-6", displayName: "gpt-6" },
  ]);
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
    env: {
      FAKE_PROVIDER: "opencode",
      FAKE_CONNECTIONS: JSON.stringify([
        { id: "local", connections: [{ type: "env" }] },
        { id: "credential", connections: [{ type: "credential" }] },
        { id: "unconnected", connections: [] },
      ]),
    },
  };
  const discover = createModelDiscovery({
    opencode: async () => ({
      location: { directory: home.path },
      data: [
        native("unconnected"),
        native("local", "legacy"),
        native("local", "legacy"),
        native("credential"),
      ],
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
    {
      id: "credential/model",
      nativeProviderId: "credential",
      displayName: "Provider supplied name",
      deprecated: false,
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
        ...Array.from({ length: 600 }, (_, index) => `other/m${index}`),
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

test("malformed metadata from unconnected OpenCode providers does not reject connected models", async () => {
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
      data: [
        { ...native("unconnected"), limit: { context: 1000 } },
        { ...native("local"), extension: { future: true } },
      ],
    }),
  });
  expect(await discover(config, new AbortController().signal)).toMatchObject([
    {
      id: "local/model",
      contextWindow: 1000,
      displayName: "Provider supplied name",
      raw: { json: expect.stringContaining('"future":true') },
    },
  ]);
});

test("a manually configured OpenCode id remains an explicit opt-in with no discovered connections", async () => {
  const home = await workspace();
  cleanup.push(home.close);
  const config = { ...instance("opencode"), cwd: home.path };
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(home.path, "custom.sqlite")),
    instances: [config],
    now: () => 1,
    deadline: () => () => {},
    discover: async () => [],
    preferences: () => [
      {
        provider: "opencode",
        customModels: [{ id: "unconnected/exact-ID", displayName: "My router" }],
      },
    ],
  });
  cleanup.push(() => catalog.close());
  await catalog.refresh();
  expect(catalog.list().models).toMatchObject([
    { id: "unconnected/exact-ID", nativeProviderId: "unconnected", custom: true, hidden: false },
  ]);
  expect(
    catalog.resolve({ provider: "opencode", role: "worker", model: "unconnected/exact-ID" }),
  ).toMatchObject({ ok: true, model: { id: "unconnected/exact-ID", custom: true } });
});

test("paged cached models retain row order and update visibility across preference and discovery revisions", async () => {
  const home = await workspace();
  cleanup.push(home.close);
  const config = { ...instance(), cwd: home.path };
  const nativeRows = normalizeCodex(
    { data: Array.from({ length: 512 }, (_, index) => codexPayload(`m${index}`).data[0]) },
    config,
  );
  let preferences: ProviderConfigurations = [
    {
      provider: "codex",
      hiddenModels: nativeRows.map((row) => row.id),
      customModels: Array.from({ length: 128 }, (_, index) => ({
        id: `custom-${index}`,
        displayName: `Custom ${index}`,
      })),
    },
  ];
  let discovered = nativeRows;
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(home.path, "pages.sqlite")),
    instances: [config],
    now: () => 1,
    deadline: () => () => {},
    preferences: () => preferences,
    discover: async () => discovered,
  });
  cleanup.push(() => catalog.close());
  await catalog.refresh();
  const custom = catalog.list({ limit: 1, offset: 512 }).models[0];
  if (!custom) throw new Error("Missing custom fixture row");
  expect(() => {
    custom.displayName = "Changed";
  }).toThrow(TypeError);
  expect(() => custom.reasoningEfforts.push("invented")).toThrow(TypeError);
  expect(catalog.list({ limit: 1, offset: 512 }).models[0]).toMatchObject({
    displayName: "Custom 0",
    reasoningEfforts: [],
  });
  for (let repeat = 0; repeat < 2; repeat++) {
    expect(catalog.list({ limit: 1, offset: 511 })).toMatchObject({
      models: [{ id: "m511", hidden: true }],
      nextOffset: 512,
    });
    expect(catalog.list({ limit: 1, offset: 512 })).toMatchObject({
      models: [{ id: "custom-0", hidden: false }],
      nextOffset: 513,
    });
    const last = catalog.list({ limit: 1, offset: 639 });
    expect(last).toMatchObject({
      models: [{ id: "custom-127" }],
    });
    expect(last.nextOffset).toBeUndefined();
  }
  preferences = [{ provider: "codex", favourites: ["m511"], shownModels: ["m511"] }];
  catalog.configurationChanged();
  const updated = catalog.list({ limit: 1, offset: 511 });
  expect(updated).toMatchObject({
    models: [{ id: "m511", hidden: false, favourite: true }],
  });
  expect(updated.nextOffset).toBeUndefined();
  discovered = normalizeCodex(codexPayload("replacement"), config);
  await catalog.refresh();
  const refreshed = catalog.list({ limit: 1 });
  expect(refreshed).toMatchObject({
    models: [{ id: "replacement", hidden: false, favourite: false }],
  });
  expect(refreshed.nextOffset).toBeUndefined();
});

test("OpenCode without connections discovers only verified free Zen models", async () => {
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
    opencode: async () => ({
      location: { directory: home.path },
      data: [
        { ...native("opencode"), cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] },
        {
          ...native("opencode"),
          id: "opencode/paid",
          modelID: "paid",
          cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }],
        },
        { ...native("openai"), cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] },
      ],
    }),
  });
  const models = await discover(config, new AbortController().signal);
  expect(models.map((model) => model.id)).toEqual(["opencode/model"]);
  expect(models[0]?.source).toMatchObject({ requiresAuth: false });
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

test("a binary revision rejects a late discovery even before its change notification arrives", async () => {
  const home = await workspace();
  cleanup.push(home.close);
  const config = { ...instance(), cwd: home.path };
  let preferences: ProviderConfigurations = [{ provider: "codex", binaryPath: "/old-cli" }];
  const old = deferred<ReturnType<typeof normalizeCodex>>();
  const started = deferred<void>();
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(home.path, "late.sqlite")),
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
  // Do not notify/abort: this exercises revision validation independently of cancellation.
  preferences = [{ provider: "codex", binaryPath: "/new-cli" }];
  old.resolve(normalizeCodex(codexPayload("old-model"), config));
  await flight;
  expect(catalog.list().models.map((row) => row.id)).not.toContain("old-model");
  await catalog.refresh();
  expect(catalog.list().models.map((row) => row.id)).toEqual(["new-model"]);
});
