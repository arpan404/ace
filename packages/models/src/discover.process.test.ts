import { join } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import { afterEach, expect, test } from "vitest";
import { spawnSupervised } from "@ace/provider-kit/process";
import {
  ModelCatalog,
  createModelDiscovery,
  normalizeCodex,
  normalizeClaude,
  normalizeAcp,
  normalizeOpenCode,
  openModelStorage,
} from "./index.ts";
import { Clock, codexPayload, deferred, fakeCli, instance, workspace } from "./testing/support.ts";
import type { ModelInstance } from "./types.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function launch(provider: ModelInstance["provider"], payload: unknown) {
  const work = await workspace();
  cleanups.push(work.close);
  const script = await fakeCli(work.path);
  const config = {
    ...instance(provider),
    cwd: work.path,
    args: [script],
    env: { FAKE_PROVIDER: provider, FAKE_PAYLOAD: JSON.stringify(payload) },
  };
  return { work, config };
}
async function cursorFixture(): Promise<unknown> {
  const stream = createReadStream(
    new URL("../../../fixtures/cursor/2026.09.26-dd393fe/tool-read.jsonl", import.meta.url),
  );
  const lines = createInterface({ input: stream });
  const frame = z.object({
    data: z.object({
      result: z.object({ models: z.unknown(), configOptions: z.unknown() }).passthrough(),
    }),
  });
  try {
    for await (const line of lines) {
      const parsed = frame.safeParse(JSON.parse(line));
      if (parsed.success) return parsed.data.data.result;
    }
    throw new Error("Fixture has no model options");
  } finally {
    lines.close();
    stream.destroy();
  }
}

test("Codex discovery pages model/list without ever starting a turn", async () => {
  const first = { ...codexPayload("first"), nextCursor: "second-page" };
  const { config } = await launch("codex", [first, codexPayload("second", false)]);
  const rows = await createModelDiscovery()(config, new AbortController().signal);
  expect(rows.map((row) => row.id)).toEqual(["first", "second"]);
  expect(rows[0]).toMatchObject({
    nativeModelId: "first",
    reasoningEfforts: ["low", "high"],
    defaultEffort: "high",
    contextWindow: 200000,
    inputModalities: ["text", "image"],
    serviceTiers: [
      { id: "priority", name: "Fast", speed: "fast", parameters: { serviceTier: "priority" } },
    ],
    defaultTier: "priority",
  });
});

test("Claude discovery initializes only and keeps resolved aliases and supported Fast mode", async () => {
  const { config } = await launch("claude", {
    models: [
      {
        value: "opus",
        resolvedModel: "claude-opus-test",
        displayName: "Opus",
        description: "Alias",
        supportsFastMode: true,
        supportedEffortLevels: ["high", "max"],
        extraFutureCapability: "retained",
      },
    ],
  });
  const rows = await createModelDiscovery()(config, new AbortController().signal);
  expect(rows[0]).toMatchObject({
    id: "opus",
    resolvedModelId: "claude-opus-test",
    reasoningEfforts: ["high", "max"],
    serviceTiers: [{ id: "fast", parameters: { fastMode: true } }],
  });
  expect(rows[0]?.raw.json).toContain("extraFutureCapability");
});

test("OpenCode v2 metadata keeps provider/model IDs and image capability", async () => {
  const native = {
    id: "local/some/model",
    modelID: "some/model",
    providerID: "local",
    name: "Local model",
    limit: { context: 131072, output: 8192 },
    capabilities: { input: { text: true, image: true, audio: false } },
    variants: [{ id: "high" }],
    enabled: true,
    status: "deprecated",
  };
  const { config } = await launch("opencode", [native]);
  const rows = await createModelDiscovery({
    opencode: async () => ({ location: { directory: config.cwd }, data: [native] }),
  })(config, new AbortController().signal);
  expect(rows[0]).toMatchObject({
    id: "local/some/model",
    nativeProviderId: "local",
    nativeModelId: "some/model",
    contextWindow: 131072,
    inputModalities: ["text", "image"],
    reasoningEfforts: ["high"],
    deprecated: true,
  });
});

test("shared discovery keeps OpenCode metadata without starting an unprofiled ACP agent", async () => {
  const work = await workspace();
  cleanups.push(work.close);
  const executable = join(work.path, "not-authorized-to-start");
  const discover = createModelDiscovery({
    opencode: async (entry) => ({
      location: { directory: entry.cwd },
      data: [
        {
          id: "local/merged-model",
          providerID: "local",
          modelID: "merged-model",
          name: "Merged model",
          limit: { context: 131072, output: 8192 },
          capabilities: { input: { text: true } },
          variants: [{ id: "high" }],
          enabled: true,
          status: "active",
        },
      ],
    }),
  });
  const signal = new AbortController().signal;
  const openCode = await discover({ ...instance("opencode"), executable, cwd: work.path }, signal);
  const acp = await discover({ ...instance("acp"), executable, cwd: work.path }, signal);
  expect(openCode).toEqual([
    expect.objectContaining({
      id: "local/merged-model",
      nativeProviderId: "local",
      nativeModelId: "merged-model",
      contextWindow: 131072,
      reasoningEfforts: ["high"],
    }),
  ]);
  expect(acp).toEqual([]);
});

test("recorded Cursor model options apply session parameters only to its current model", async () => {
  const { config } = await launch("cursor", await cursorFixture());
  const rows = await createModelDiscovery()(config, new AbortController().signal);
  const current = rows.find((row) => row.isDefault);
  expect(current).toMatchObject({
    id: "grok-4.7",
    contextWindow: 256000,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    serviceTiers: [{ id: "fast", parameters: { fast: "true" } }],
  });
  const other = rows.find((row) => row.id === "claude-opus-5-5");
  expect(other?.reasoningEfforts).toEqual([]);
  expect(other?.serviceTiers).toEqual([]);
  expect(rows.length).toBeGreaterThan(30);
});

for (const provider of ["antigravity"] as const) {
  test(`${provider} discovers legacy session model options without a prompt`, async () => {
    const { config } = await launch(provider, {
      models: {
        currentModelId: "gemini",
        availableModels: [
          { modelId: "gemini", name: "Gemini" },
          { modelId: "claude", name: "Claude" },
        ],
      },
    });
    const rows = await createModelDiscovery()(config, new AbortController().signal);
    expect(rows.map((row) => [row.id, row.isDefault])).toEqual([
      ["gemini", true],
      ["claude", false],
    ]);
    expect(rows[0]?.provider).toBe(provider);
  });
}

test("ACP grouped model options and per-model effort configuration remain distinct", () => {
  const rows = normalizeAcp(
    {
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "a",
          options: [
            {
              group: "local",
              name: "Local",
              options: [
                {
                  value: "a",
                  name: "A",
                  configOptions: [
                    {
                      id: "reasoning_effort",
                      type: "select",
                      currentValue: "high",
                      options: [{ value: "high", name: "High" }],
                    },
                  ],
                },
                { value: "b", name: "B" },
              ],
            },
          ],
        },
      ],
    },
    instance("acp"),
  );
  expect(rows[0]?.reasoningEfforts).toEqual(["high"]);
  expect(rows[1]?.reasoningEfforts).toEqual([]);
});

test("single flight coalesces real app-server spawns", async () => {
  const { work, config } = await launch("codex", codexPayload());
  let spawns = 0;
  const discovery = createModelDiscovery({
    spawn(options) {
      spawns++;
      return spawnSupervised(options);
    },
  });
  const clock = new Clock();
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(work.path, "cache.sqlite")),
    instances: [config],
    discover: discovery,
    now: () => clock.now,
    deadline: clock.deadline,
  });
  cleanups.push(() => catalog.close());
  const pending = [catalog.refresh(), catalog.refresh(), catalog.refresh()];
  await Promise.all(pending);
  expect(spawns).toBe(1);
  expect(catalog.list().models[0]?.id).toBe("coder");
});

test("an injected deadline stops a hung CLI while a different app-server succeeds", async () => {
  const { work, config } = await launch("codex", codexPayload());
  const clock = new Clock();
  const started = deferred<void>();
  const discovery = createModelDiscovery({
    spawn(options) {
      const proc = spawnSupervised(options);
      if (options.env.FAKE_PROVIDER === "hang") started.resolve();
      return proc;
    },
  });
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(work.path, "cache.sqlite")),
    instances: [config, { ...config, id: "hang", env: { FAKE_PROVIDER: "hang" } }],
    discover: discovery,
    now: () => clock.now,
    deadline: clock.deadline,
  });
  cleanups.push(() => catalog.close());
  const hung = catalog.refresh({ instance: "hang" });
  await started.promise;
  await catalog.refresh({ instance: "codex" });
  expect(catalog.list({ instance: "codex" }).models).toHaveLength(1);
  clock.expire();
  expect(await hung).toMatchObject([{ error: "timeout" }]);
});

test("malformed native model metadata is rejected instead of producing picker choices", async () => {
  const payload = { data: [{ model: "bad", displayName: 23 }] };
  const { config } = await launch("codex", payload);
  await expect(createModelDiscovery()(config, new AbortController().signal)).rejects.toThrow();
  expect(() =>
    normalizeClaude(
      { models: [{ value: "opus", displayName: "Opus", supportedEffortLevels: [42] }] },
      instance("claude"),
    ),
  ).toThrow();
  expect(() =>
    normalizeAcp(
      { configOptions: [{ id: "model", type: "select", options: [{ value: 5, name: "Bad" }] }] },
      instance("acp"),
    ),
  ).toThrow();
  expect(() =>
    normalizeOpenCode(
      'local/a\n{"id":"b","providerID":"local","name":"Bad"}',
      instance("opencode"),
    ),
  ).toThrow();
});

test("raw metadata retains extensions but caps multibyte content and redacts credentials", () => {
  const payload = codexPayload();
  const rows = normalizeCodex(
    {
      data: payload.data.map((model) =>
        Object.assign({}, model, {
          secretToken: "never-store",
          metadata: { api_key: "never-store", future: "preserved" },
          long: "😀".repeat(3000),
        }),
      ),
    },
    instance(),
  );
  const raw = rows[0]?.raw;
  expect(raw?.truncated).toBe(true);
  expect(Buffer.byteLength(raw?.json ?? "")).toBeLessThanOrEqual(2048);
  expect(raw?.json).not.toContain("never-store");
  expect(raw?.json).toContain("preserved");
});

test("oversized CLI output is stopped even without a newline", async () => {
  const { config } = await launch("codex", {});
  await expect(
    createModelDiscovery()(
      { ...config, env: { FAKE_PROVIDER: "flood" } },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});

test("repeating Codex pagination cursor fails instead of growing the catalog indefinitely", async () => {
  const { config } = await launch("codex", { ...codexPayload(), nextCursor: "loop" });
  await expect(createModelDiscovery()(config, new AbortController().signal)).rejects.toThrow(
    "Repeated",
  );
});

test("otherwise valid model metadata exceeding the output cap is rejected", async () => {
  const { config } = await launch("codex", codexPayload());
  await expect(
    createModelDiscovery()(
      { ...config, env: { ...config.env, FAKE_LARGE: "1" } },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});

test("Cursor reads per-model parameter options when the listing extension is available", async () => {
  const { config } = await launch("cursor", {
    models: {
      currentModelId: "first",
      availableModels: [
        { modelId: "first", name: "First" },
        { modelId: "second", name: "Second" },
      ],
    },
  });
  const listing = {
    models: [
      { value: "first", name: "First", configOptions: [] },
      {
        value: "second",
        name: "Second",
        configOptions: [
          {
            id: "reasoning_effort",
            type: "select",
            currentValue: "high",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
          {
            id: "fast",
            type: "select",
            currentValue: "false",
            options: [
              { value: "true", name: "Fast" },
              { value: "false", name: "Normal" },
            ],
          },
        ],
      },
    ],
  };
  const rows = await createModelDiscovery()(
    { ...config, env: { ...config.env, FAKE_CURSOR_MODELS: JSON.stringify(listing) } },
    new AbortController().signal,
  );
  expect(rows.find((row) => row.id === "second")).toMatchObject({
    isDefault: false,
    reasoningEfforts: ["low", "high"],
    serviceTiers: [{ id: "fast", parameters: { fast: "true" } }],
  });
  expect(rows.find((row) => row.id === "first")?.reasoningEfforts).toEqual([]);
});

test("large normalized model metadata cannot inflate picker wire pages past their byte bound", async () => {
  const { config } = await launch("codex", {
    data: codexPayload().data.map((model) =>
      Object.assign({}, model, {
        supportedReasoningEfforts: Array.from({ length: 32 }, (_, index) => ({
          reasoningEffort: `${index}-${"x".repeat(200)}`,
        })),
        serviceTiers: Array.from({ length: 32 }, (_, index) => ({
          id: `${index}-${"y".repeat(200)}`,
          name: "z".repeat(200),
        })),
      }),
    ),
  });
  await expect(createModelDiscovery()(config, new AbortController().signal)).rejects.toThrow(
    "8 KiB",
  );
});

test("Claude SDK discovery stops its synthetic CLI after success, malformed metadata and cancellation", async () => {
  for (const mode of ["success", "malformed", "cancel"] as const) {
    const { config } = await launch("claude", {
      models:
        mode === "malformed"
          ? [{ value: 42 }]
          : [{ value: "sonnet", displayName: "Sonnet", future: 42 }],
    });
    const controller = new AbortController();
    const started = deferred<{ command: string; args: readonly string[] }>();
    let exited: Promise<unknown> | undefined;
    const discovery = createModelDiscovery({
      spawn(options) {
        const proc = spawnSupervised(options);
        exited = proc.exited;
        started.resolve({ command: options.command, args: options.args ?? [] });
        return proc;
      },
    });
    const rows = discovery(
      mode === "cancel" ? { ...config, env: { FAKE_PROVIDER: "hang" } } : config,
      controller.signal,
    );
    // Observe rejection immediately. A spawn failure must fail this test instead
    // of leaving the startup barrier pending until the process timeout.
    const outcome = rows.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    try {
      const options = await Promise.race([
        started.promise,
        outcome.then((result) => {
          throw new Error("Discovery ended before spawning", {
            cause: result.status === "rejected" ? result.error : undefined,
          });
        }),
      ]);
      expect(options.command).toBe(config.executable);
      const index = options.args.findIndex(
        (arg) => arg === "--setting-sources" || arg.startsWith("--setting-sources="),
      );
      const sources = options.args[index];
      expect(index).toBeGreaterThanOrEqual(0);
      expect(
        sources === "--setting-sources" ? options.args[index + 1] : sources?.split("=")[1],
      ).toBe("");
      expect(options.args).toContain("--strict-mcp-config");
      if (mode === "cancel") controller.abort();
      const result = await outcome;
      if (mode === "success") {
        if (result.status !== "fulfilled") throw result.error;
        expect(result.value[0]?.id).toBe("sonnet");
      } else expect(result.status).toBe("rejected");
      expect(exited).toBeDefined();
      await exited;
    } finally {
      controller.abort();
      await outcome;
      await exited;
    }
  }
});
