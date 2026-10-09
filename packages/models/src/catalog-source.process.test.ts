import { afterEach, expect, test } from "vitest";
import { createModelDiscovery, parseOpenCodeConnections, discoveryError } from "./index.ts";
import { instance, fakeCli, workspace } from "./testing/support.ts";
const native = (providerID: string, modelID: string) => ({
  id: `${providerID}/${modelID}`,
  providerID,
  modelID,
  name: modelID,
  enabled: true,
  status: "active",
  limit: { context: 1000, output: 500 },
  capabilities: { input: { text: true } },
  variants: [],
});

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

test("OpenCode's non-secret connection data groups local, subscriptions, API keys and configured providers", () => {
  const groups = parseOpenCodeConnections([
    { id: "ollama", connections: [] },
    { id: "lmstudio", connections: [] },
    { id: "llama.cpp", connections: [] },
    { id: "my-local", name: "Office server", baseURL: "http://127.0.0.1:8080/v1", connections: [] },
    { id: "opencode-go", connections: [{ type: "credential" }] },
    { id: "opencode", connections: [{ type: "credential" }] },
    { id: "anthropic", connections: [{ type: "env" }] },
    { id: "openai", connections: [{ type: "credential", authType: "api_key" }] },
    { id: "custom", connections: [{ type: "configured" }] },
    { id: "not-connected", connections: [] },
    { id: "remote-ollama", baseURL: "https://cloud.example/v1", connections: [{ type: "env" }] },
  ]);
  expect([...groups.values()]).toEqual([
    { kind: "local", id: "ollama", label: "Ollama" },
    { kind: "local", id: "lmstudio", label: "LM Studio" },
    { kind: "local", id: "llama.cpp", label: "llama.cpp" },
    { kind: "local", id: "my-local", label: "Office server" },
    { kind: "subscription", id: "opencode-go", label: "OpenCode Go", service: "opencode_go" },
    { kind: "api_key", id: "opencode", label: "OpenCode Zen", service: "opencode_zen" },
    { kind: "api_key", id: "anthropic", label: "Anthropic" },
    { kind: "api_key", id: "openai", label: "OpenAI" },
    { kind: "other", id: "custom", label: "custom" },
    { kind: "api_key", id: "remote-ollama", label: "remote-ollama" },
  ]);
});
test("Pi discovers models on its logged-in providers without changing their execution routes", async () => {
  const work = await workspace();
  cleanups.push(work.close);
  const config = {
    ...instance("pi"),
    cwd: work.path,
    args: [await fakeCli(work.path)],
    env: {
      HOME: work.path,
      FAKE_PROVIDER: "pi",
      FAKE_PAYLOAD: JSON.stringify({
        currentModel: { provider: "github-copilot", id: "gpt-6.1-sol" },
        models: [
          { provider: "github-copilot", id: "gpt-6.1-sol", name: "GPT-6.1 Sol", input: ["text"] },
          { provider: "anthropic", id: "claude-opus-5-5", name: "Opus 5.5", input: ["text"] },
        ],
      }),
    },
  };
  const models = await createModelDiscovery()(config, new AbortController().signal);
  expect(models).toMatchObject([
    {
      id: "github-copilot/gpt-6.1-sol",
      nativeModelId: "gpt-6.1-sol",
      source: { id: "github-copilot", label: "GitHub Copilot" },
    },
    {
      id: "anthropic/claude-opus-5-5",
      nativeModelId: "claude-opus-5-5",
      source: { id: "anthropic", label: "Anthropic" },
    },
  ]);
});
test("OpenCode CLI connection flags survive discovery and a malformed connection reports its own error", async () => {
  const work = await workspace();
  cleanups.push(work.close);
  const config = {
    ...instance("opencode"),
    cwd: work.path,
    args: [await fakeCli(work.path)],
    env: {
      HOME: work.path,
      FAKE_PROVIDER: "opencode",
      FAKE_CONNECTIONS: JSON.stringify([
        { id: "ollama", connections: [] },
        { id: "opencode-go", connections: [{ type: "credential" }] },
        { id: "anthropic", connections: [{ type: "env" }] },
      ]),
    },
  };
  const models = await createModelDiscovery({
    opencode: async () => ({
      location: { directory: config.cwd },
      data: [
        native("ollama", "qwen3-235b-a22b"),
        native("opencode-go", "muse-spark-1.3-contributor"),
        { providerID: "anthropic", modelID: "claude-opus-5-5" },
      ],
    }),
  })(config, new AbortController().signal);
  expect(models).toMatchObject([
    { nativeModelId: "ollama/qwen3-235b-a22b", source: { kind: "local", id: "ollama" } },
    {
      nativeModelId: "opencode-go/muse-spark-1.3-contributor",
      source: { kind: "subscription", id: "opencode-go" },
    },
  ]);
  expect(models.sources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: expect.objectContaining({ id: "anthropic" }),
        status: "stale",
        error: expect.objectContaining({
          code: "parse_failure",
          hint: expect.stringContaining("Update"),
        }),
      }),
    ]),
  );
});
test("a connected OpenCode source with no enabled chat models reports fresh information", async () => {
  const work = await workspace();
  cleanups.push(work.close);
  const config = {
    ...instance("opencode"),
    cwd: work.path,
    args: [await fakeCli(work.path)],
    env: {
      HOME: work.path,
      FAKE_PROVIDER: "opencode",
      FAKE_CONNECTIONS: JSON.stringify([{ id: "anthropic", connections: [{ type: "env" }] }]),
    },
  };
  const models = await createModelDiscovery({
    opencode: async () => ({ location: { directory: config.cwd }, data: [] }),
  })(config, new AbortController().signal);
  expect(models).toEqual([]);
  expect(models.sources).toMatchObject([
    {
      source: { id: "anthropic" },
      status: "fresh",
      error: {
        code: "no_models",
        message: "The connected source has no chat models enabled.",
        hint: "Enable models for it in OpenCode, then Refresh.",
      },
    },
  ]);
});
test.each([
  ["auth_expired", { data: [], errors: [{ providerID: "anthropic", error: { status: 401 } }] }],
  ["parse_failure", { data: [{ providerID: "anthropic", modelID: "claude-opus-5-5" }] }],
])("OpenCode's cached ID listing cannot hide a %s connection failure", async (code, payload) => {
  const work = await workspace();
  cleanups.push(work.close);
  const config = {
    ...instance("opencode"),
    cwd: work.path,
    args: [await fakeCli(work.path)],
    env: {
      HOME: work.path,
      FAKE_PROVIDER: "opencode",
      FAKE_MODEL_IDS: "anthropic/claude-opus-5-5",
      FAKE_CONNECTIONS: JSON.stringify([{ id: "anthropic", connections: [{ type: "env" }] }]),
    },
  };
  const models = await createModelDiscovery({
    opencode: async () => ({ location: { directory: config.cwd }, ...payload }),
  })(config, new AbortController().signal);
  expect(models).toEqual([]);
  expect(models.sources).toMatchObject([
    { source: { id: "anthropic" }, status: "stale", error: { code } },
  ]);
});
test("OpenCode's ID fallback restores missing metadata while preserving another source's error", async () => {
  const work = await workspace();
  cleanups.push(work.close);
  const config = {
    ...instance("opencode"),
    cwd: work.path,
    args: [await fakeCli(work.path)],
    env: {
      HOME: work.path,
      FAKE_PROVIDER: "opencode",
      FAKE_MODEL_IDS: "anthropic/claude-opus-5-5\nollama/qwen3-235b-a22b",
      FAKE_CONNECTIONS: JSON.stringify([
        { id: "anthropic", connections: [{ type: "env" }] },
        { id: "ollama", connections: [] },
      ]),
    },
  };
  const models = await createModelDiscovery({
    opencode: async () => ({
      location: { directory: config.cwd },
      data: [],
      errors: [{ providerID: "anthropic", error: { status: 401 } }],
    }),
  })(config, new AbortController().signal);
  expect(models.map((model) => model.id)).toEqual(["ollama/qwen3-235b-a22b"]);
  expect(models.sources).toMatchObject([
    { source: { id: "anthropic" }, status: "stale", error: { code: "auth_expired" } },
    { source: { id: "ollama" }, status: "fresh" },
  ]);
});
test.each([
  [Object.assign(new Error("secret"), { status: 403 }), "auth_expired"],
  [new Error("ECONNREFUSED with private diagnostics"), "unreachable"],
  [new Error("unsupported version with private diagnostics"), "cli_too_old"],
  [Object.assign(new Error("secret"), { status: 429 }), "rate_limited"],
  [new SyntaxError("private payload"), "parse_failure"],
])("discovery categorizes failures without exposing diagnostics", (error, code) => {
  expect(discoveryError(error)).toMatchObject({
    code,
    message: expect.any(String),
    hint: expect.any(String),
  });
  expect(JSON.stringify(discoveryError(error))).not.toContain("private");
  expect(JSON.stringify(discoveryError(error))).not.toContain("secret");
});

test("OpenCode lists free Zen and local LM Studio choices even when connected metadata is complete", async () => {
  const work = await workspace();
  cleanups.push(work.close);
  const config = {
    ...instance("opencode"),
    cwd: work.path,
    args: [await fakeCli(work.path)],
    env: {
      HOME: work.path,
      FAKE_PROVIDER: "opencode",
      FAKE_MODEL_IDS:
        "opencode/big-pickle\nopencode/exo-free\nopencode/grok-code-preview-free\nlmstudio/qwen3-coder\nopenai/paid-model\nopencode-go/muse-spark-1.3-contributor",
      FAKE_CONNECTIONS: JSON.stringify([
        { id: "opencode-go", connections: [{ type: "credential" }] },
      ]),
    },
  };
  const models = await createModelDiscovery({
    opencode: async () => ({
      location: { directory: config.cwd },
      data: [native("opencode-go", "muse-spark-1.3-contributor")],
    }),
  })(config, new AbortController().signal);
  expect(models.map((model) => model.id)).toEqual([
    "opencode-go/muse-spark-1.3-contributor",
    "opencode/big-pickle",
    "opencode/exo-free",
    "opencode/grok-code-preview-free",
    "lmstudio/qwen3-coder",
  ]);
  expect(models.filter((model) => model.free).map((model) => model.source)).toEqual(
    Array.from({ length: 3 }, () => ({
      id: "opencode",
      label: "OpenCode Zen",
      kind: "api_key",
      service: "opencode_zen",
      requiresAuth: false,
    })),
  );
  expect(models.find((model) => model.id === "lmstudio/qwen3-coder")?.source).toMatchObject({
    kind: "local",
    label: "LM Studio",
    requiresAuth: false,
  });
  expect(models.find((model) => model.id === "opencode/grok-code-preview-free")).toMatchObject({
    displayName: "Grok Code",
  });
});

test("Pi names ChatGPT and keeps Ollama cloud models out of the local group", async () => {
  const work = await workspace();
  cleanups.push(work.close);
  const config = {
    ...instance("pi"),
    cwd: work.path,
    args: [await fakeCli(work.path)],
    env: {
      HOME: work.path,
      FAKE_PROVIDER: "pi",
      FAKE_PAYLOAD: JSON.stringify({
        models: [
          { provider: "openai-codex", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
          { provider: "ollama", id: "qwen3-coder:480b-cloud", name: "Qwen3 Coder" },
          { provider: "ollama", id: "qwen3:cloud", name: "Qwen3" },
          { provider: "ollama", id: "qwen3:8b", name: "Qwen3 8B" },
        ],
      }),
    },
  };
  const models = await createModelDiscovery()(config, new AbortController().signal);
  expect(models.map((model) => [model.source?.label, model.source?.kind])).toEqual([
    ["ChatGPT / Codex", "subscription"],
    ["Ollama Cloud", "api_key"],
    ["Ollama Cloud", "api_key"],
    ["Ollama", "local"],
  ]);
  expect(models.map((model) => model.nativeModelId)).toEqual([
    "gpt-6.1-sol",
    "qwen3-coder:480b-cloud",
    "qwen3:cloud",
    "qwen3:8b",
  ]);
});

test.each([
  ["disabled", { enabled: false, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }],
  ["paid", { cost: [{ input: 0, output: 1, cache: { read: 0, write: 0 } }] }],
  ["missing-price", {}],
  ["malformed-price", { cost: [{ input: "0", output: 0 }] }],
] as const)(
  "OpenCode ID fallback cannot restore %s Zen metadata as credential-free",
  async (reason, metadata) => {
    const work = await workspace();
    cleanups.push(work.close);
    const id = `${reason}-free`;
    const config = {
      ...instance("opencode"),
      cwd: work.path,
      args: [await fakeCli(work.path)],
      env: {
        HOME: work.path,
        FAKE_PROVIDER: "opencode",
        FAKE_MODEL_IDS: `opencode/${id}`,
        FAKE_CONNECTIONS: "[]",
      },
    };
    const models = await createModelDiscovery({
      opencode: async () => ({
        location: { directory: config.cwd },
        data: [{ ...native("opencode", id), ...metadata }],
      }),
    })(config, new AbortController().signal);
    expect(models.map((model) => model.id)).toEqual([]);
  },
);
