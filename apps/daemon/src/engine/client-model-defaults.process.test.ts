import { expect, test } from "vitest";
import { Client, ModelClient, webSocketTransport } from "@ace/client";
import { ModelCatalog, ModelInstance, normalizeCodex, normalizeOpenCodeV2 } from "@ace/models";
import { DeviceId, type ProviderConfigurations } from "@ace/protocol";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { harness, scriptFrames, start, end } from "./test-support.ts";
import { token } from "../socket-test-support.ts";

const storage = () => ({ load: () => [], replace() {}, remove() {}, close() {} });
const native = (model: string, efforts: string[] = []) => ({
  id: model,
  model,
  displayName: model,
  isDefault: false,
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
    reasoningEffort,
    description: reasoningEffort,
  })),
  defaultReasoningEffort: "high",
});
const openCode = (providerID: string, enabled = true) => ({
  id: `${providerID}/muse-spark-1.3-contributor`,
  providerID,
  modelID: "muse-spark-1.3-contributor",
  name: "Muse Spark",
  enabled,
  status: "active",
  limit: { context: 1000, output: 500 },
  capabilities: { input: { text: true } },
  variants: [],
});
async function modelClient(h: Awaited<ReturnType<typeof harness>>) {
  let saved: string | null = null;
  let nextId = 0;
  const client = new Client({
    deviceId: DeviceId.parse("model-picker"),
    transport: () => webSocketTransport(() => new WebSocket(h.url)),
    credential: async () => token,
    storage: {
      load: async () => saved,
      save: async (value) => {
        saved = value;
      },
    },
    scheduler: { set: (delay, callback) => h.clock.setTimer(callback, delay) },
    random: () => 0.5,
    id: () => `picker-${++nextId}`,
  });
  await client.start();
  const state = client.connectionState();
  if (state.getSnapshot() !== "ready")
    await new Promise<void>((resolve) => {
      const stop = state.subscribe(() => {
        if (state.getSnapshot() === "ready") {
          stop();
          resolve();
        }
      });
    });
  return { models: new ModelClient(client), client };
}

test("choosing the work account before its model launches the work default and preserves account capabilities", async () => {
  const instances = ["personal", "work"].map((id) =>
    ModelInstance.parse({
      id,
      provider: "codex",
      loginRevision: "test",
      executable: "unused",
      cwd: process.cwd(),
    }),
  );
  const preferences: ProviderConfigurations = [
    { provider: "codex", instance: "personal", defaultModel: "gpt-6-sol" },
    { provider: "codex", instance: "work", defaultModel: "gpt-5" },
  ];
  const catalog = new ModelCatalog({
    instances,
    storage: storage(),
    now: () => 1000,
    deadline: () => () => {},
    preferences: () => preferences,
    discover: async (config) =>
      normalizeCodex(
        { data: [native("gpt-6-sol", config.id === "work" ? [] : ["high"]), native("gpt-5")] },
        config,
      ),
  });
  await catalog.refresh();
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    models: catalog,
  });
  const { models: client, client: wire } = await modelClient(h);
  try {
    expect(
      (await client.list({ provider: "codex", instance: "personal" })).models[0],
    ).toMatchObject({
      id: "gpt-6-sol",
      instance: "personal",
      isDefault: true,
      reasoningEfforts: ["high"],
    });
    const scope = { provider: "codex", instance: "work" } as const;
    const work = await client.list(scope);
    expect(work.models.find((row) => row.id === "gpt-6-sol")).toMatchObject({
      instance: "work",
      isDefault: false,
      reasoningEfforts: [],
    });
    const selection = await client.commandSelection(scope);
    expect(selection).toMatchObject({ accountId: "work", model: "gpt-5" });
    const receipt = await wire.command({
      type: "thread.create",
      workspaceId: h.workspace,
      ...selection,
      input: [{ type: "text", text: "synthetic" }],
    });
    expect(receipt.ok).toBe(true);
    await h.engine.flush();
    expect(h.contexts[0]).toMatchObject({ instanceId: "work", model: "gpt-5" });
    expect(receipt.threadId && h.store.getThread(receipt.threadId)?.execution).toMatchObject({
      instanceId: "work",
      model: "gpt-5",
    });
  } finally {
    await wire.close();
    await h.close();
    await catalog.close();
  }
});

test("an empty scoped catalog supplies no fake Default choice or command model", async () => {
  const catalog = new ModelCatalog({
    instances: [],
    storage: storage(),
    now: () => 1000,
    discover: async () => [],
    deadline: () => () => {},
  });
  const h = await harness([], scriptFrames(), { models: catalog });
  const { models: client, client: wire } = await modelClient(h);
  try {
    const scope = { provider: "codex", instance: "work" } as const;
    expect((await client.list(scope)).models).toEqual([]);
    await expect(client.commandSelection(scope)).rejects.toMatchObject({ code: "daemon" });
  } finally {
    await wire.close();
    await h.close();
    await catalog.close();
  }
});

test("the OpenCode client default keeps its connected provider route through the engine and fake CLI", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-model-route-"));
  const config = ModelInstance.parse({
    id: "opencode-cli-default",
    provider: "opencode",
    loginRevision: "test",
    executable: "unused",
    cwd: home,
  });
  const catalog = new ModelCatalog({
    instances: [config],
    storage: storage(),
    now: () => 1000,
    deadline: () => () => {},
    discover: async () =>
      normalizeOpenCodeV2(
        {
          location: { directory: home },
          data: [openCode("opencode-go"), openCode("other")],
        },
        config,
      ),
  });
  await catalog.refresh();
  const bodies: unknown[] = [];
  const cli = fileURLToPath(
    new URL("../../../../packages/adapter-opencode/src/testing/cli-v2.mjs", import.meta.url),
  );
  const adapter = createOpenCodeAdapter({
    discovery: { env: { HOME: home } },
    runtime: {
      discoverProvider: async () => ({
        installed: true,
        path: cli,
        version: "2.0.22",
        auth: "unknown",
        loginHint: "unused",
      }),
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === "/api/session" && request.method === "POST")
          bodies.push(await request.clone().json());
        return fetch(request);
      },
    },
  });
  const frames = scriptFrames();
  const h = await harness([], frames, {
    provider: "opencode",
    // The adapter's capabilities, including permission modes, depend on the discovered version.
    discovery: { installed: true, auth: "logged_in", loginHint: "unused", version: "2.0.22" },
    models: catalog,
    nativeAdapter: adapter,
  });
  const { models: client, client: wire } = await modelClient(h);
  try {
    const scope = { provider: "opencode", instance: config.id } as const;
    expect((await client.list(scope)).models.map((row) => row.id)).toEqual([
      "opencode-go/muse-spark-1.3-contributor",
      "other/muse-spark-1.3-contributor",
    ]);
    const selection = await client.commandSelection(scope);
    expect(selection.model).toBe("opencode-go/muse-spark-1.3-contributor");
    expect(
      (
        await wire.command({
          type: "thread.create",
          workspaceId: h.workspace,
          ...selection,
          input: [{ type: "text", text: "synthetic" }],
        })
      ).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.contexts[0]?.model).toBe("opencode-go/muse-spark-1.3-contributor");
    const payload = z
      .object({ model: z.object({ providerID: z.string(), id: z.string() }) })
      .parse(bodies[0]);
    expect(payload.model).toEqual({ providerID: "opencode-go", id: "muse-spark-1.3-contributor" });
    expect(h.errors).toEqual([]);
  } finally {
    await wire.close();
    await h.close();
    await adapter.close();
    await catalog.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("unknown and disconnected explicit engine models are refused before any provider session opens", async () => {
  const config = ModelInstance.parse({
    id: "opencode-cli-default",
    provider: "opencode",
    loginRevision: "test",
    executable: "unused",
    cwd: process.cwd(),
  });
  const catalog = new ModelCatalog({
    instances: [config],
    storage: storage(),
    now: () => 1000,
    deadline: () => () => {},
    discover: async () =>
      normalizeOpenCodeV2(
        {
          location: { directory: config.cwd },
          data: [openCode("opencode-go"), openCode("disconnected", false)],
        },
        config,
      ),
  });
  await catalog.refresh();
  const frames = scriptFrames();
  const h = await harness([], frames, { models: catalog, provider: "opencode" });
  try {
    const before = h.store.listThreads();
    for (const model of ["missing/model", "disconnected/muse-spark-1.3-contributor"]) {
      expect(
        h.command({
          type: "thread.create",
          workspaceId: h.workspace,
          provider: "opencode",
          model,
          input: [{ type: "text", text: "synthetic" }],
        }),
      ).toMatchObject({ ok: false, error: "model_unavailable" });
    }
    await h.engine.flush();
    expect(h.contexts).toEqual([]);
    expect(h.store.listThreads()).toEqual(before);
  } finally {
    await h.close();
    await catalog.close();
  }
});
