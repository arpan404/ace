import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { SettingsService } from "@ace/settings";
import { ProviderConfigurations, type CatalogModel, type ProviderKind } from "@ace/protocol";
import {
  ModelCatalog,
  createModelDiscovery,
  normalizeAcp,
  normalizeCodex,
  normalizeClaude,
  configuredModels,
  openModelStorage,
} from "./index.ts";
import { Clock, codexPayload, fakeCli, instance, workspace } from "./testing/support.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
const codex = (id: string, extra = {}) => ({ ...codexPayload(id).data[0], ...extra });
const claude = (value: string, extra = {}) => ({ value, displayName: value, ...extra });
const openCode = (providerID: string, modelID: string, extra = {}) => ({
  id: `${providerID}/${modelID}`,
  providerID,
  modelID,
  name: modelID,
  enabled: true,
  status: "active",
  limit: { context: 1000, output: 500 },
  capabilities: { input: { text: true } },
  variants: [],
  ...extra,
});
const selector = (value: string, extra = {}) => ({ value, name: value, ...extra });
const acpPayload = {
  configOptions: [
    {
      id: "model",
      category: "model",
      type: "select",
      currentValue: "gpt-6.1-sol",
      options: [
        {
          group: "recent",
          options: [
            selector("gpt-6.1-sol"),
            selector("default"),
            selector("text-embedding-3-large"),
          ],
        },
        {
          group: "all",
          options: [selector("gpt-6.1-sol"), selector("gpt-5", { status: "deprecated" })],
        },
      ],
    },
  ],
};
async function catalogFor(
  provider: ProviderKind,
  payload: unknown,
  openCodeData: Record<string, unknown> = {},
) {
  const home = await workspace();
  cleanup.push(home.close);
  const config = {
    ...instance(provider),
    ...(provider === "acp"
      ? { acpAgentId: "local:fixture", installationId: "fixture", instanceId: "account" }
      : {}),
    cwd: home.path,
    args: [await fakeCli(home.path)],
    env: {
      HOME: home.path,
      FAKE_PROVIDER: provider,
      FAKE_PAYLOAD: JSON.stringify(payload),
      ...(provider === "opencode"
        ? {
            FAKE_CONNECTIONS: JSON.stringify([
              { id: "opencode-go", connections: [{ type: "credential" }] },
              { id: "anthropic", connections: [{ type: "env" }] },
            ]),
          }
        : {}),
    },
  };
  const discovery = createModelDiscovery({
    opencode: async () => ({ location: { directory: home.path }, ...openCodeData }),
  });
  const clock = new Clock();
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(home.path, "models.sqlite")),
    instances: [config],
    discover: provider === "acp" ? async () => normalizeAcp(payload, config) : discovery,
    now: () => clock.now,
    deadline: clock.deadline,
  });
  cleanup.push(() => catalog.close());
  if (provider === "acp") await catalog.updateFromSession(config, payload);
  else await catalog.refresh();
  expect(catalog.list().instances[0]?.error).toBeUndefined();
  return { catalog, home, config, clock };
}
function chosen(catalog: ModelCatalog, provider?: ProviderKind, model?: string) {
  const result = catalog.resolve({ role: "coder", provider, model });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.model.id;
}

test("Claude canonical choices merge family aliases and resolve the Opus default without pseudo rows", async () => {
  const { catalog } = await catalogFor("claude", {
    models: [
      claude("default", { displayName: "Default (recommended)" }),
      claude("sonnet", { resolvedModel: "claude-sonnet-5-2" }),
      claude("claude-sonnet-5-2"),
      claude("opus", { resolvedModel: "claude-opus-5-5", supportsFastMode: true }),
      claude("claude-opus-5-5", { supportsFastMode: true }),
      claude("claude-opus-4-8", { deprecated: true }),
      claude("internal-router"),
    ],
  });
  expect(catalog.list().models).toMatchObject([
    {
      id: "claude-opus-5-5",
      displayName: "Claude Opus 5.5",
      aliases: ["opus"],
      isDefault: true,
      defaultSource: "built-in",
    },
    { id: "claude-sonnet-5-2", aliases: ["sonnet"], isDefault: false },
    { id: "claude-opus-4-8", group: "legacy", hidden: true },
  ]);
  expect(chosen(catalog, "claude", "opus")).toBe("claude-opus-5-5");
  expect(chosen(catalog, "claude", "default")).toBe("claude-opus-5-5");
  expect(chosen(catalog, "claude")).toBe("claude-opus-5-5");
});

test("Claude missing preferred Opus falls back to the newest available Opus before Sonnet", async () => {
  const { catalog } = await catalogFor("claude", {
    models: [
      claude("claude-sonnet-5-5", { isDefault: true }),
      claude("claude-opus-4-8"),
      claude("claude-opus-5-4"),
    ],
  });
  expect(chosen(catalog)).toBe("claude-opus-5-4");
});

test("Codex pages deduplicate model slugs and remove embedding and internal endpoints", async () => {
  const { catalog } = await catalogFor("codex", [
    {
      data: [
        codex("default"),
        codex("gpt-6-sol"),
        codex("gpt-6.1-sol", { isDefault: false }),
        codex("text-embedding-3-large"),
      ],
      nextCursor: "next",
    },
    {
      data: [
        codex("gpt-6.1-sol", { isDefault: false }),
        codex("internal-router"),
        codex("gpt-5", { deprecated: true }),
        codex("gpt-image-1"),
      ],
      nextCursor: null,
    },
  ]);
  expect(catalog.list().models.map((row) => row.id)).toEqual(["gpt-6.1-sol", "gpt-6-sol", "gpt-5"]);
  expect(catalog.list().models[0]).toMatchObject({
    displayName: "GPT-6.1 Sol",
    isDefault: true,
    defaultSource: "built-in",
  });
  expect(chosen(catalog, "codex", "default")).toBe("gpt-6.1-sol");
});

test("Codex missing preferred Sol selects the next Sol over a different GPT family", async () => {
  const { catalog } = await catalogFor("codex", {
    data: [codex("gpt-6.2-mini"), codex("gpt-6-sol", { isDefault: false })],
  });
  expect(chosen(catalog)).toBe("gpt-6-sol");
});

test("Cursor uses its reported Auto selector and falls back when Auto is unavailable", async () => {
  const payload = {
    models: {
      currentModelId: "gpt-6.1-sol",
      availableModels: [
        { modelId: "default", name: "Default (recommended)" },
        { modelId: "auto", name: "Auto" },
        { modelId: "gpt-6.1-sol", name: "gpt-6.1-sol" },
        { modelId: "text-embedding-3-large", name: "Embedding" },
      ],
    },
  };
  const { catalog } = await catalogFor("cursor", payload);
  expect(
    catalog
      .list()
      .models.map((row) => row.id)
      .toSorted(),
  ).toEqual(["auto", "gpt-6.1-sol"]);
  expect(chosen(catalog)).toBe("auto");
  const fallback = await catalogFor("cursor", {
    models: {
      ...payload.models,
      availableModels: payload.models.availableModels.filter((row) => row.modelId !== "auto"),
    },
  });
  expect(chosen(fallback.catalog)).toBe("gpt-6.1-sol");
});

test("OpenCode honors its scoped native default before the connected Muse preference", async () => {
  const data = [
    openCode("opencode-go", "muse-spark-1.3-contributor"),
    openCode("anthropic", "claude-opus-5-5"),
    openCode("anthropic", "text-embedding-3"),
    openCode("anthropic", "default"),
    openCode("anthropic", "claude-opus-5-5"),
    openCode("anthropic", "claude-opus-4-8", { status: "legacy" }),
    openCode("disconnected", "gpt-6.1-sol"),
  ];
  const { catalog } = await catalogFor(
    "opencode",
    {},
    { data, configuredDefault: "anthropic/claude-opus-5-5" },
  );
  expect(catalog.list().models.map((row) => row.id)).toEqual([
    "opencode-go/muse-spark-1.3-contributor",
    "anthropic/claude-opus-5-5",
    "anthropic/claude-opus-4-8",
  ]);
  expect(chosen(catalog)).toBe("anthropic/claude-opus-5-5");
  const fallback = await catalogFor(
    "opencode",
    {},
    { data, configuredDefault: "disconnected/gpt-6.1-sol" },
  );
  expect(chosen(fallback.catalog)).toBe("opencode-go/muse-spark-1.3-contributor");
  const noMuse = await catalogFor(
    "opencode",
    {},
    { data: data.filter((row) => row.providerID !== "opencode-go") },
  );
  expect(chosen(noMuse.catalog)).toBe("anthropic/claude-opus-5-5");
});

test("Pi preserves get_state's configured default and falls back to an available chat model", async () => {
  const models = [
    { provider: "anthropic", id: "claude-opus-5-5", name: "claude-opus-5-5" },
    { provider: "openai", id: "gpt-6.1-sol", name: "gpt-6.1-sol" },
    { provider: "openai", id: "gpt-6.1-sol", name: "gpt-6.1-sol" },
    { provider: "openai", id: "default", name: "Default" },
    { provider: "openai", id: "text-embedding-3-large", name: "Embedding" },
  ];
  const { catalog } = await catalogFor("pi", {
    models,
    currentModel: { provider: "openai", id: "gpt-6.1-sol" },
  });
  expect(catalog.list().models.map((row) => row.id)).toEqual([
    "anthropic/claude-opus-5-5",
    "openai/gpt-6.1-sol",
  ]);
  expect(chosen(catalog)).toBe("openai/gpt-6.1-sol");
  const fallback = await catalogFor("pi", {
    models,
    currentModel: { provider: "missing", id: "absent" },
  });
  expect(chosen(fallback.catalog)).toBe("anthropic/claude-opus-5-5");
});

test("ACP session fixtures deduplicate options across groups and remove pseudo and non-chat selectors", async () => {
  const { catalog, config } = await catalogFor("acp", acpPayload);
  expect(catalog.list().models).toMatchObject([
    {
      id: "gpt-6.1-sol",
      isDefault: true,
      defaultSource: "built-in",
      modelConfigId: "model",
      selectorMethod: "session/set_config_option",
    },
    { id: "gpt-5", group: "legacy", hidden: true },
  ]);
  expect(chosen(catalog, "acp", "Default (recommended)")).toBe("gpt-6.1-sol");
  await catalog.updateFromSession(config, {
    configOptions: [
      {
        id: "model",
        category: "model",
        type: "select",
        currentValue: "gpt-6.1-sol",
        options: [
          { group: "current", options: [selector("gpt-6.1-sol")] },
          { group: "legacy", options: [selector("gpt-6.1-sol"), selector("old-chat")] },
        ],
      },
    ],
  });
  expect(catalog.list().models).toMatchObject([
    { id: "gpt-6.1-sol", group: "current", hidden: false },
    { id: "old-chat", group: "legacy", hidden: true },
  ]);
  const fallback = await catalogFor("acp", {
    configOptions: [
      {
        id: "model",
        category: "model",
        type: "select",
        currentValue: "missing",
        options: [{ value: "real", name: "Real" }],
      },
    ],
  });
  expect(chosen(fallback.catalog)).toBe("real");
  await catalog.updateFromSession(config, {
    configOptions: [
      {
        id: "model",
        category: "model",
        type: "select",
        currentValue: "route-alias",
        options: [selector("route-alias", { resolvedModel: "real-chat" })],
      },
    ],
  });
  expect(
    catalog.resolve({ role: "selector", provider: "acp", model: "route-alias" }),
  ).toMatchObject({
    ok: true,
    model: { id: "real-chat", nativeModelId: "route-alias", modelConfigId: "model" },
  });
});

test("synced account defaults override provider defaults, survive restart and fall back when unavailable", async () => {
  const home = await workspace();
  cleanup.push(home.close);
  const settings = new SettingsService({ dataDir: home.path });
  cleanup.push(() => settings.close());
  let preferences: ProviderConfigurations = [];
  const stop = await settings.subscribe(
    { scope: {}, keys: ["providers.configuration"] },
    (notice) => {
      if (notice.type === "changed")
        preferences = ProviderConfigurations.parse(notice.entries[0]?.value);
    },
  );
  cleanup.push(async () => stop());
  const clock = new Clock();
  const instances = [
    { ...instance(), id: "personal", cwd: home.path },
    { ...instance(), id: "work", cwd: home.path },
  ];
  const storage = join(home.path, "synced.sqlite");
  const options = {
    storage: openModelStorage(storage),
    instances,
    preferences: () => preferences,
    discover: async (config: (typeof instances)[number]): Promise<CatalogModel[]> =>
      normalizeCodex({ data: [codex("gpt-6.1-sol"), codex("gpt-6-sol"), codex("gpt-5")] }, config),
    now: () => clock.now,
    deadline: clock.deadline,
  };
  const catalog = new ModelCatalog(options);
  cleanup.push(() => catalog.close());
  await catalog.refresh();
  await settings.set(
    "providers.configuration",
    [
      { provider: "codex", defaultModel: "gpt-6-sol" },
      { provider: "codex", instance: "work", defaultModel: "gpt-5" },
    ],
    { kind: "global" },
  );
  expect(
    catalog
      .list()
      .models.filter((row) => row.isDefault)
      .map((row) => [row.instance, row.id, row.defaultSource]),
  ).toEqual([
    ["personal", "gpt-6-sol", "user"],
    ["work", "gpt-5", "user"],
  ]);
  await catalog.close();
  const restarted = new SettingsService({ dataDir: home.path });
  cleanup.push(() => restarted.close());
  preferences = ProviderConfigurations.parse(
    (await restarted.get("providers.configuration")).value,
  );
  const cold = new ModelCatalog({ ...options, storage: openModelStorage(storage) });
  cleanup.push(() => cold.close());
  expect(cold.resolve({ role: "new thread", provider: "codex", instance: "work" })).toMatchObject({
    ok: true,
    model: { id: "gpt-5", defaultSource: "user" },
  });
  await settings.set("providers.configuration", [{ provider: "codex", defaultModel: "absent" }], {
    kind: "global",
  });
  expect(cold.resolve({ role: "new thread", instance: "work", model: "default" })).toMatchObject({
    ok: true,
    model: { id: "gpt-6.1-sol", defaultSource: "built-in" },
  });
  expect(cold.resolve({ role: "explicit", instance: "work", model: "absent" }).ok).toBe(false);
  await settings.set(
    "providers.configuration",
    [
      { provider: "codex", defaultModel: "gpt-6-sol", hiddenModels: ["gpt-6-sol"] },
      { provider: "codex", instance: "work", defaultModel: null },
    ],
    { kind: "global" },
  );
  expect(cold.resolve({ role: "new thread", instance: "work" })).toMatchObject({
    ok: true,
    model: { id: "gpt-6.1-sol", defaultSource: "built-in" },
  });
});

test("versioned Claude aliases share one choice and old settings still apply to the canonical model", () => {
  const config = instance("claude");
  const rows = normalizeClaude(
    {
      models: [
        claude("opus-5.5"),
        claude("opus"),
        claude("claude-opus-5-5"),
        claude("claude-sonnet-5-2"),
      ],
    },
    config,
  );
  const view = configuredModels(rows, "claude", config.id, {
    provider: "claude",
    defaultModel: "opus-5.5",
    hiddenModels: ["opus"],
    favourites: ["opus-5.5"],
    customModels: [{ id: "opus", displayName: "Duplicate" }],
  });
  expect(view.map((row) => row.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-2"]);
  expect(view[0]).toMatchObject({
    hidden: true,
    favourite: true,
    isDefault: false,
    aliases: ["opus-5.5", "opus"],
  });
  expect(view[1]).toMatchObject({ isDefault: true, defaultSource: "built-in" });
});

test("versioned Claude aliases do not select a different minor version with the same prefix", async () => {
  const { catalog } = await catalogFor("claude", {
    models: [claude("opus-5.5"), claude("claude-opus-5-5"), claude("claude-opus-5-50")],
  });
  expect(chosen(catalog, "claude", "opus-5.5")).toBe("claude-opus-5-5");
  expect(catalog.list().models.find((row) => row.id === "claude-opus-5-50")?.aliases).not.toContain(
    "opus-5.5",
  );
});

test("large ACP metadata cannot hide non-chat flags or erase aliases and legacy grouping", async () => {
  const notes = "x".repeat(5000);
  const { catalog } = await catalogFor("acp", {
    configOptions: [
      {
        id: "model",
        category: "model",
        type: "select",
        currentValue: "route-alias",
        options: [
          selector("private-router", { notes, internal: true }),
          selector("vector-service", { notes, type: "embedding" }),
          selector("route-alias", { notes, resolvedModel: "real-chat", aliases: ["old-chat"] }),
          { group: "legacy", options: [selector("old-model", { notes })] },
        ],
      },
    ],
  });
  expect(catalog.list().models.map((row) => row.id)).toEqual(["real-chat", "old-model"]);
  expect(catalog.list().models[0]).toMatchObject({
    aliases: ["old-chat", "route-alias"],
    raw: { truncated: true },
  });
  expect(catalog.list().models[1]).toMatchObject({ group: "legacy", hidden: true });
  expect(chosen(catalog, "acp", "old-chat")).toBe("real-chat");
});

test("malformed optional metadata does not suppress a valid non-chat classification", async () => {
  const { catalog } = await catalogFor("acp", {
    configOptions: [
      {
        id: "model",
        category: "model",
        type: "select",
        currentValue: "real-chat",
        options: [
          selector("private-router", { internal: true, aliases: 42 }),
          selector("real-chat"),
        ],
      },
    ],
  });
  expect(catalog.list().models.map((row) => row.id)).toEqual(["real-chat"]);
});

test("OpenCode current connected rows survive earlier legacy and internal duplicates", async () => {
  const { catalog } = await catalogFor(
    "opencode",
    {},
    {
      data: [
        openCode("opencode-go", "muse-spark-1.3-contributor", { status: "legacy" }),
        openCode("opencode-go", "muse-spark-1.3-contributor"),
        openCode("anthropic", "claude-opus-5-5", { internal: true }),
        openCode("anthropic", "claude-opus-5-5"),
      ],
    },
  );
  expect(chosen(catalog)).toBe("opencode-go/muse-spark-1.3-contributor");
  expect(catalog.list().models).toHaveLength(2);
  expect(catalog.list().models.every((row) => !row.hidden && row.group === "current")).toBe(true);
});

test("cached Claude aliases remain canonical across settings generations without discovery", async () => {
  const config = instance("claude");
  let preferences: ProviderConfigurations = [{ provider: "claude", favourites: ["opus"] }];
  const catalog = new ModelCatalog({
    instances: [config],
    storage: {
      load: () => [
        {
          provider: "claude",
          instance: config.id,
          revision: config.loginRevision,
          refreshedAt: 1000,
          models: normalizeClaude(
            {
              models: [
                claude("default"),
                claude("opus"),
                claude("claude-opus-5-5"),
                claude("claude-sonnet-5-2"),
              ],
            },
            config,
          ),
        },
      ],
      replace() {},
      remove() {},
      close() {},
    },
    discover: async () => {
      throw new Error("Discovery unavailable");
    },
    now: () => 1000,
    deadline: () => () => {},
    preferences: () => preferences,
  });
  try {
    expect(catalog.list({ limit: 1 }).models[0]).toMatchObject({
      id: "claude-opus-5-5",
      aliases: ["opus"],
      favourite: true,
      isDefault: true,
    });
    preferences = [
      { provider: "claude", defaultModel: "claude-sonnet-5-2", hiddenModels: ["opus"] },
    ];
    catalog.configurationChanged();
    expect(catalog.list().models.map((row) => [row.id, row.hidden, row.isDefault])).toEqual([
      ["claude-opus-5-5", true, false],
      ["claude-sonnet-5-2", false, true],
    ]);
    expect(chosen(catalog)).toBe("claude-sonnet-5-2");
    await catalog.refresh();
    expect(catalog.list().instances[0]?.error).toBe("discovery_failed");
    expect(chosen(catalog)).toBe("claude-sonnet-5-2");
  } finally {
    await catalog.close();
  }
});
