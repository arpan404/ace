import { copyFile, chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import {
  createModelDiscovery,
  createModelRevisionProbe,
  ModelCatalog,
  openModelStorage,
} from "@ace/models";
import { fixture } from "./socket-test-support.ts";
import { ProviderStatuses } from "./provider-status.ts";
import { hasUnauthenticatedOpenCodeModels } from "./provider-model-availability.ts";
import { harness, scriptFrames } from "./engine/test-support.ts";

const freeIds = ["opencode/big-pickle", "opencode/ling-3.0-tiny-free", "opencode/mimo-v2.5-free"];
const zero = { input: 0, output: 0, cache: { read: 0, write: 0 } };

async function setup(onTestFinished: (close: () => Promise<void>) => void, connections = "[]") {
  const home = await mkdtemp(join(tmpdir(), "ace-free-models-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const executable = join(home, "opencode");
  await copyFile(
    new URL("../../../packages/adapter-opencode/src/testing/cli-v2.mjs", import.meta.url),
    executable,
  );
  await chmod(executable, 0o700);
  const env = {
    HOME: home,
    ACE_TEST_OPENCODE_CONNECTIONS: connections,
    ACE_TEST_FREE_MODELS: "1",
    ACE_TEST_COMPLETE_INPUT: "1",
  };
  const instance = {
    id: "opencode-cli-default",
    provider: "opencode" as const,
    executable,
    cwd: home,
    loginRevision: "1",
    args: [],
    env,
  };
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(home, "models.sqlite")),
    instances: [instance],
    discover: createModelDiscovery(),
    revisionProbe: createModelRevisionProbe(),
    now: () => 1000,
    deadline: () => () => {},
  });
  onTestFinished(() => catalog.close());
  return { home, executable, env, instance, catalog };
}

test("OpenCode lists and resolves free Zen models without auth, and reports ready without a sign-in blocker", async ({
  onTestFinished,
}) => {
  const { home, executable, env, catalog } = await setup(onTestFinished);
  const statuses = new ProviderStatuses(
    {
      env: { ...env, PATH: `${home}:${dirname(process.execPath)}` },
      overrides: { opencode: executable },
      modelsAvailable: () => hasUnauthenticatedOpenCodeModels(catalog),
    },
    { now: () => 1000, schedule: () => () => {} },
  );
  onTestFinished(() => statuses.close());
  const server = await fixture({ models: catalog, providerStatuses: statuses });
  onTestFinished(server.close);
  await catalog.refresh();
  await statuses.refresh();
  const client = await server.connect();
  await client.next();
  client.send({
    type: "models.list",
    requestId: "free",
    options: { provider: "opencode", offset: 0, limit: 100 },
  });
  expect(await client.next()).toMatchObject({
    type: "models.result",
    requestId: "free",
    result: {
      models: freeIds.map((id) => ({
        id,
        free: true,
        source: { service: "opencode_zen", requiresAuth: false },
      })),
      instances: [{ status: "fresh", sources: [{ source: { id: "opencode" }, status: "fresh" }] }],
    },
  });
  client.send({ type: "providers.request", requestId: "ready", operation: "readiness" });
  const readiness = await client.next();
  if (readiness.type !== "providers.result" || !readiness.result.ok)
    throw new Error("No provider statuses");
  const opencode = readiness.result.providers.find((row) => row.provider === "opencode");
  expect(opencode).toMatchObject({
    installed: true,
    auth: "logged_out",
    modelsAvailable: true,
    readiness: "signed_in",
  });
  expect(opencode?.state).toBeUndefined();
  expect(opencode?.actionId).toBeUndefined();
  client.send({
    type: "models.resolve",
    requestId: "select",
    roleSpec: {
      role: "worker",
      provider: "opencode",
      model: "opencode/big-pickle",
      selection: "default",
      preferenceOrder: [],
      imageInput: false,
    },
  });
  expect(await client.next()).toMatchObject({
    type: "models.result",
    result: { ok: true, model: { nativeModelId: "opencode/big-pickle" } },
  });
});

test("connected paid OpenCode upstreams remain alongside free Zen models", async ({
  onTestFinished,
}) => {
  const connections = JSON.stringify(
    ["opencode-go", "opencode"].map((id) => ({ id, connections: [{ type: "credential" }] })),
  );
  const { catalog } = await setup(onTestFinished, connections);
  await catalog.refresh();
  const server = await fixture({ models: catalog });
  onTestFinished(server.close);
  const client = await server.connect();
  await client.next();
  client.send({
    type: "models.list",
    requestId: "both",
    options: { provider: "opencode", offset: 0, limit: 100 },
  });
  const response = await client.next();
  if (response.type !== "models.result" || !("models" in response.result))
    throw new Error("No models");
  expect(response.result.models.map((row) => row.id).toSorted()).toEqual(
    [...freeIds, "opencode/paid-test", "opencode-go/muse-spark-1.3-contributor"].toSorted(),
  );
  expect(
    response.result.models
      .filter((row) => row.free)
      .map((row) => row.id)
      .toSorted(),
  ).toEqual(freeIds);
  expect(
    response.result.models.find((row) => row.id === "opencode/paid-test")?.source,
  ).toMatchObject({ service: "opencode_zen" });
  expect(
    response.result.models.find((row) => row.id.startsWith("opencode-go/"))?.source,
  ).toMatchObject({ service: "opencode_go" });
});

test("a selected free model starts and completes a turn through the fake OpenCode runtime while signed out", async ({
  onTestFinished,
}) => {
  const { executable, env, catalog } = await setup(onTestFinished);
  await catalog.refresh();
  const selected = catalog.resolve({
    role: "worker",
    provider: "opencode",
    model: "opencode/big-pickle",
    selection: "default",
    preferenceOrder: [],
    imageInput: false,
  });
  if (!selected.ok) throw new Error(selected.reason);
  const completed = Promise.withResolvers<void>();
  const requests: { path: string; body: unknown }[] = [];
  const adapter = createOpenCodeAdapter({
    discovery: { overrides: { opencode: executable }, env },
    runtime: {
      fetch: (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (init?.method === "POST" && typeof init.body === "string")
          requests.push({ path: url.pathname, body: JSON.parse(init.body) });
        return fetch(input, init);
      },
    },
  });
  onTestFinished(() => adapter.close());
  const h = await harness([], scriptFrames(), {
    provider: "opencode",
    models: catalog,
    discovery: {
      installed: true,
      auth: "logged_out",
      loginHint: "opencode auth login",
      version: "2.0.22",
    },
    nativeAdapter: {
      ...adapter,
      openSession: (ctx) =>
        adapter.openSession({
          ...ctx,
          onFrame: async (frame) => {
            await ctx.onFrame(frame);
            if (
              frame.channel === "sse" &&
              z.object({ type: z.literal("session.execution.succeeded") }).safeParse(frame.data)
                .success
            )
              completed.resolve();
          },
        }),
    },
  });
  onTestFinished(h.close);
  expect(
    h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "opencode",
      model: selected.model.id,
      input: [{ type: "text", text: "synthetic input" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  await completed.promise;
  await h.engine.flush();
  expect(requests.find((request) => request.path === "/api/session")?.body).toMatchObject({
    model: { providerID: "opencode", id: "big-pickle" },
  });
  expect(requests.some((request) => request.path.endsWith("/prompt"))).toBe(true);
  expect(h.store.listThreads()[0]?.status.state).toBe("done");
  expect(h.errors).toEqual([]);
});

test("missing, malformed, paid or disabled Zen pricing cannot unlock models, and other reported usable sources still work", async ({
  onTestFinished,
}) => {
  const { home, instance } = await setup(
    onTestFinished,
    JSON.stringify([{ id: "custom-local", local: true, connections: [] }]),
  );
  const native = {
    id: "opencode/new-free-model",
    providerID: "opencode",
    modelID: "new-free-model",
    name: "New free model",
    enabled: true,
    status: "active",
    limit: { context: 1000, output: 500 },
    capabilities: { input: ["text/plain"] },
    variants: [],
  };
  const rows = await createModelDiscovery({
    opencode: async () => ({
      location: { directory: home },
      data: [
        native,
        { ...native, modelID: "empty", cost: [] },
        { ...native, modelID: "malformed", cost: [{ input: "0", output: 0 }] },
        { ...native, modelID: "mixed", cost: [zero, { ...zero, output: 1 }] },
        { ...native, modelID: "cache-cost", cost: [{ ...zero, cache: { read: 1, write: 0 } }] },
        { ...native, modelID: "disabled", enabled: false, cost: [zero] },
        { ...native, modelID: "no-key", providerID: "unconnected-paid", cost: [zero] },
        { ...native, cost: [zero] },
        { ...native, providerID: "custom-local", modelID: "local-model" },
      ],
    }),
  })(instance, new AbortController().signal);
  expect(rows.map((row) => row.id)).toEqual([
    "custom-local/local-model",
    "opencode/new-free-model",
  ]);
});

test("free Zen models survive restart and unchanged connection polling does not refresh them", async ({
  onTestFinished,
}) => {
  const { home, instance } = await setup(onTestFinished);
  let discoveries = 0;
  const discover = createModelDiscovery();
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(home, "restart.sqlite")),
    instances: [instance],
    discover: async (...args) => {
      discoveries++;
      return discover(...args);
    },
    revisionProbe: createModelRevisionProbe(),
    now: () => 1000,
    deadline: () => () => {},
  });
  onTestFinished(() => catalog.close());
  await catalog.refresh();
  await catalog.reconcileConnections();
  expect(discoveries).toBe(1);
  expect(catalog.list().models.map((model) => model.id)).toEqual(freeIds);
  await catalog.close();
  const restarted = new ModelCatalog({
    storage: openModelStorage(join(home, "restart.sqlite")),
    instances: [instance],
    discover: async () => {
      throw new Error("Offline metadata");
    },
    now: () => 1000,
    deadline: () => () => {},
  });
  onTestFinished(() => restarted.close());
  expect(restarted.list().models.map((model) => [model.id, model.free])).toEqual(
    freeIds.map((id) => [id, true]),
  );
  await restarted.refresh();
  expect(restarted.list().models.map((model) => model.id)).toEqual(freeIds);
  expect(restarted.list().instances[0]?.errorDetail).toMatchObject({
    code: "unreachable",
    message: "Provider could not be reached.",
  });
  expect(JSON.stringify(restarted.list())).not.toContain("Offline metadata");
});
