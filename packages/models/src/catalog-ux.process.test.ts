import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import {
  type ProviderConfigurations,
  type CatalogModel,
  type ModelSourceStatus,
} from "@ace/protocol";
import {
  ModelCatalog,
  openModelStorage,
  normalizeClaude,
  normalizeCodex,
  normalizeOpenCodeReport,
  parseOpenCodeConnections,
  type DiscoverModels,
} from "./index.ts";
import { Clock, instance, workspace, deferred, codexPayload } from "./testing/support.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function setup(
  discover: DiscoverModels,
  preferences: () => ProviderConfigurations = () => [],
  provider: CatalogModel["provider"] = "codex",
) {
  const work = await workspace();
  cleanups.push(work.close);
  const clock = new Clock();
  const config = instance(provider);
  const path = join(work.path, "models.sqlite");
  const catalog = new ModelCatalog({
    storage: openModelStorage(path),
    discover,
    preferences,
    instances: [config],
    now: () => clock.now,
    deadline: clock.deadline,
  });
  cleanups.push(() => catalog.close());
  return { catalog, clock, path, config };
}
const codex = (id = "gpt-6.1-sol") => normalizeCodex(codexPayload(id), instance());

test("an unversioned persisted catalog serves clean names immediately and publishes the background replacement", async () => {
  const work = await workspace();
  cleanups.push(work.close);
  const path = join(work.path, "models.sqlite");
  const config = instance("claude");
  const models = normalizeClaude(
    {
      models: [
        { value: "claude-haiku-4-5-20251001", displayName: "claude-haiku-4-5-20251001" },
        { value: "claude-opus-5-5", displayName: "claude-opus-5-5" },
      ],
    },
    config,
  );
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE model_catalog(instance TEXT PRIMARY KEY, payload TEXT NOT NULL)");
  db.prepare("INSERT INTO model_catalog VALUES (?,?)").run(
    config.id,
    JSON.stringify({
      provider: "claude",
      instance: config.id,
      revision: config.loginRevision,
      refreshedAt: 1000,
      models,
    }),
  );
  db.close();
  const replacement = deferred<readonly CatalogModel[]>();
  const changed = deferred<void>();
  const catalog = new ModelCatalog({
    storage: openModelStorage(path),
    instances: [config],
    discover: () => replacement.promise,
    now: () => 1000,
    deadline: () => () => {},
  });
  cleanups.push(() => catalog.close());
  const stop = catalog.listen(() => {
    if (catalog.list().models.some((model) => model.id === "claude-opus-6-1")) changed.resolve();
  });
  expect(catalog.list()).toMatchObject({
    models: [
      { id: "claude-opus-5-5", isDefault: true },
      { displayName: "Haiku 4.5", detail: "20251001" },
    ],
    instances: [{ status: "refreshing", lastRefreshedAt: 1000 }],
  });
  replacement.resolve(
    normalizeClaude(
      { models: [{ value: "claude-opus-6-1", displayName: "claude-opus-6-1" }] },
      config,
    ),
  );
  await changed.promise;
  expect(catalog.list()).toMatchObject({
    models: [{ id: "claude-opus-6-1", isDefault: true }],
    instances: [{ status: "fresh" }],
  });
  stop();
});
test("a failed fresh refresh keeps good models and persists a safe source error", async () => {
  let fail = false;
  const { catalog, path, clock } = await setup(async () => {
    if (fail) throw Object.assign(new Error("secret upstream body"), { status: 401 });
    return codex();
  });
  await catalog.refresh();
  fail = true;
  await catalog.refresh();
  expect(catalog.list()).toMatchObject({
    models: [{ id: "gpt-6.1-sol" }],
    instances: [
      {
        status: "stale",
        lastRefreshedAt: 1000,
        errorDetail: { code: "auth_expired", hint: expect.stringContaining("Sign in") },
        sources: [{ status: "stale", error: { code: "auth_expired" } }],
      },
    ],
  });
  expect(JSON.stringify(catalog.list())).not.toContain("secret upstream body");
  await catalog.close();
  const next = deferred<readonly CatalogModel[]>();
  const restarted = new ModelCatalog({
    storage: openModelStorage(path),
    instances: [instance()],
    discover: () => next.promise,
    now: () => clock.now,
    deadline: clock.deadline,
  });
  cleanups.push(() => restarted.close());
  expect(restarted.list()).toMatchObject({
    models: [{ id: "gpt-6.1-sol" }],
    instances: [{ sources: [{ lastRefreshedAt: 1000, error: { code: "auth_expired" } }] }],
  });
  next.resolve(codex());
  await restarted.refresh();
});
test("maximum age and explicit invalidation serve old data while discovery replaces it", async () => {
  let model = "gpt-6.1-sol";
  const { catalog, clock } = await setup(async () => codex(model));
  await catalog.refresh();
  clock.now += 21_600_000;
  model = "gpt-6.2-sol";
  expect(catalog.list()).toMatchObject({
    models: [{ id: "gpt-6.1-sol" }],
    instances: [{ status: "refreshing", stale: true }],
  });
  await catalog.refresh();
  expect(catalog.list().models[0]?.id).toBe("gpt-6.2-sol");
  model = "gpt-6.3-sol";
  await catalog.invalidate();
  expect(catalog.list().models[0]?.id).toBe("gpt-6.2-sol");
  await catalog.refresh();
  expect(catalog.list().models[0]?.id).toBe("gpt-6.3-sol");
  model = "gpt-6.4-sol";
  await catalog.refresh();
  expect(catalog.list().models[0]?.id).toBe("gpt-6.4-sol");
});
test("CLI version and provider settings invalidate only the selected provider while keeping its good rows", async () => {
  let preferences: ProviderConfigurations = [];
  const { catalog } = await setup(
    async () => codex(),
    () => preferences,
  );
  await catalog.refresh();
  catalog.installationChanged("codex", "1.0.0");
  expect(catalog.list()).toMatchObject({
    models: [{ id: "gpt-6.1-sol" }],
    instances: [{ status: "refreshing" }],
  });
  await catalog.refresh();
  catalog.installationChanged("codex", "1.0.0");
  expect(catalog.list().instances[0]?.status).toBe("fresh");
  preferences = [{ provider: "claude", binaryPath: "/unused" }];
  catalog.configurationChanged();
  expect(catalog.list().instances[0]?.status).toBe("fresh");
  preferences = [{ provider: "codex", defaultModel: "default", binaryPath: "/fake-cli" }];
  catalog.configurationChanged();
  expect(catalog.list().models[0]?.id).toBe("gpt-6.1-sol");
  expect(catalog.list().instances[0]?.status).toBe("refreshing");
  await catalog.refresh();
});
test("a login identity change revokes the previous account before the new discovery finishes", async () => {
  const next = deferred<readonly CatalogModel[]>();
  const { catalog } = await setup(async (config) =>
    config.loginRevision === "account-1" ? codex() : next.promise,
  );
  await catalog.refresh();
  const flight = catalog.loginChanged("codex", "account-2");
  expect(catalog.list().models).toEqual([]);
  next.resolve(codex("gpt-6.2-sol"));
  await flight;
  expect(catalog.list().models[0]?.id).toBe("gpt-6.2-sol");
});
function openModel(providerID: string, modelID: string) {
  return {
    id: `${providerID}/${modelID}`,
    providerID,
    modelID,
    name: modelID,
    enabled: true,
    status: "active",
    limit: { context: 1000, output: 500 },
    capabilities: { input: { text: true } },
    variants: [],
  };
}
test("a failing OpenCode connection keeps its models beside healthy replacements and a source error", async () => {
  const config = instance("opencode");
  const connections = parseOpenCodeConnections([
    { id: "anthropic", connections: [{ type: "env" }] },
    { id: "openai", connections: [{ type: "env" }] },
  ]);
  let fail = false;
  const logs: unknown[] = [];
  const work = await workspace();
  cleanups.push(work.close);
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(work.path, "models.sqlite")),
    instances: [config],
    now: () => (fail ? 2000 : 1000),
    deadline: () => () => {},
    onError: (provider, instanceId, error, source) =>
      logs.push({ provider, instance: instanceId, error, source }),
    discover: async () => {
      const report = normalizeOpenCodeReport(
        {
          location: { directory: config.cwd },
          data: fail
            ? [openModel("openai", "gpt-6.2-sol")]
            : [openModel("anthropic", "claude-opus-5-5"), openModel("openai", "gpt-6.1-sol")],
          ...(fail
            ? {
                errors: [
                  {
                    providerID: "anthropic",
                    error: { status: 429, message: "private rate limit details" },
                  },
                ],
              }
            : {}),
        },
        config,
        connections,
      );
      return Object.assign([...report.models], { sources: report.sources });
    },
  });
  cleanups.push(() => catalog.close());
  await catalog.refresh();
  fail = true;
  await catalog.refresh();
  expect(catalog.list().models.map((model) => model.id)).toEqual([
    "anthropic/claude-opus-5-5",
    "openai/gpt-6.2-sol",
  ]);
  expect(catalog.list().instances[0]).toMatchObject({
    status: "stale",
    sources: [
      {
        source: { id: "anthropic" },
        status: "stale",
        lastRefreshedAt: 1000,
        error: { code: "rate_limited" },
      },
      { source: { id: "openai" }, status: "fresh", lastRefreshedAt: 2000 },
    ],
  });
  expect(logs).toContainEqual(
    expect.objectContaining({
      provider: "opencode",
      source: "anthropic",
      error: expect.objectContaining({ code: "rate_limited" }),
    }),
  );
  expect(JSON.stringify(catalog.list())).not.toContain("private rate limit details");
});
test.each(["opencode", "pi"] as const)(
  "%s connection metadata changes refresh choices while unchanged metadata leaves the catalog fresh",
  async (provider) => {
    const work = await workspace();
    cleanups.push(work.close);
    let connected = true;
    const config = instance(provider);
    const source = {
      kind: "subscription",
      id: "github-copilot",
      label: "GitHub Copilot",
    } satisfies NonNullable<CatalogModel["source"]>;
    let fingerprint = "changed";
    const catalog = new ModelCatalog({
      storage: openModelStorage(join(work.path, "models.sqlite")),
      instances: [config],
      discover: async () =>
        Object.assign(
          connected
            ? codex().map((model) =>
                Object.assign({}, model, {
                  provider,
                  instance: config.id,
                  source,
                  nativeProviderId: source.id,
                }),
              )
            : [],
          { sources: connected ? [{ source, status: "fresh" } satisfies ModelSourceStatus] : [] },
        ),
      revisionProbe: async () => fingerprint,
      now: () => 1000,
      deadline: () => () => {},
    });
    cleanups.push(() => catalog.close());
    await catalog.refresh();
    // Read the persisted public storage boundary to reuse the CLI revision, not a private helper.
    await catalog.close();
    const storage = openModelStorage(join(work.path, "models.sqlite"));
    fingerprint = storage.load()[0]?.connectionRevision ?? "";
    await storage.close();
    const resumed = new ModelCatalog({
      storage: openModelStorage(join(work.path, "models.sqlite")),
      instances: [config],
      discover: async () =>
        Object.assign(
          connected
            ? codex().map((model) =>
                Object.assign({}, model, {
                  provider,
                  instance: config.id,
                  source,
                  nativeProviderId: source.id,
                }),
              )
            : [],
          { sources: connected ? [{ source, status: "fresh" } satisfies ModelSourceStatus] : [] },
        ),
      revisionProbe: async () => fingerprint,
      now: () => 1000,
      deadline: () => () => {},
    });
    cleanups.push(() => resumed.close());
    await resumed.refresh();
    await resumed.reconcileConnections();
    expect(resumed.list().instances[0]?.status).toBe("fresh");
    connected = false;
    fingerprint = "disconnected";
    await resumed.reconcileConnections();
    expect(resumed.list().models).toEqual([]);
  },
);
