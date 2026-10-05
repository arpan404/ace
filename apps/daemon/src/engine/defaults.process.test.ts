import { expect, test } from "vitest";
import { Engine, Store } from "@ace/daemon";
import { ModelCatalog, normalizeCodex } from "@ace/models";
import type { ProviderConfigurations } from "@ace/protocol";
import { ModelInstance } from "@ace/models";
import { commandContext } from "../commands.ts";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const native = (model: string, isDefault: boolean) => ({
  id: model,
  model,
  displayName: model,
  isDefault,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: "high",
});

function models() {
  let preferences: ProviderConfigurations = [];
  const config = ModelInstance.parse({
    id: "codex-cli-default",
    provider: "codex",
    loginRevision: "test",
    executable: "unused",
    cwd: process.cwd(),
  });

  const catalog = new ModelCatalog({
    instances: [config],
    storage: { load: () => [], replace() {}, remove() {}, close() {} },
    discover: async () =>
      normalizeCodex({ data: [native("gpt-6.1-sol", true), native("gpt-6-sol", false)] }, config),
    now: () => 1000,
    deadline: () => () => {},
    preferences: () => preferences,
  });
  return {
    catalog,
    override() {
      preferences = [{ provider: "codex", defaultModel: "gpt-6-sol" }];
    },
  };
}

test("new threads and legacy next-turn default selections launch the synced concrete default", async () => {
  const m = models();
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
    { models: m.catalog },
  );
  const delivered: string[] = [];
  const original = h.registry.get("codex").adapter;
  h.registry.register(
    {
      ...original,
      async openSession(context) {
        const session = await original.openSession(context);
        let model = context.model;
        return {
          ...session,
          async configure(selection) {
            model = selection.model;
          },
          async send(input, mode, command) {
            delivered.push(model ?? "absent");
            await session.send(input, mode, command);
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  try {
    const receipt = h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "codex",
      input: [{ type: "text", text: "synthetic" }],
    });
    expect(receipt.ok).toBe(true);
    if (!receipt.threadId) throw new Error("No created thread");
    await h.engine.flush();
    expect(h.contexts[0]?.model).toBe("gpt-6.1-sol");
    expect(h.store.getThread(receipt.threadId)?.execution?.model).toBe("gpt-6.1-sol");
    m.override();
    h.command({
      type: "thread.send",
      threadId: receipt.threadId,
      model: "default",
      input: [{ type: "text", text: "synthetic" }],
    });
    await h.engine.flush();
    expect(delivered).toEqual(["gpt-6.1-sol", "gpt-6-sol"]);
    expect(h.store.getThread(receipt.threadId)?.execution?.model).toBe("gpt-6-sol");
    expect(Object.values(h.store.snapshotThread(receipt.threadId).agents)[0]?.model).toBe(
      "gpt-6-sol",
    );
  } finally {
    await h.close();
    await m.catalog.close();
  }
});

test("cached legacy default rows migrate for display and resume without sending the sentinel to the CLI", async () => {
  const m = models();
  await m.catalog.refresh();
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  let cold: Store | undefined;
  let engine: Engine | undefined;
  try {
    const id = await h.create();
    await h.engine.close();
    // Fixture of the pre-defaults persisted selection, preserving its native checkpoint.
    h.store.atomic((db) => {
      db.prepare("UPDATE engine_sessions SET model='default' WHERE thread_id=?").run(id);
      db.prepare(
        "UPDATE engine_transitions SET value=json_set(value, '$.selection.model', 'default') WHERE thread_id=?",
      ).run(id);
    });
    h.store.appendEvents(
      id,
      [{ type: "thread.updated", execution: { provider: "codex", model: "default", options: {} } }],
      1001,
    );
    m.override();
    cold = new Store(h.path);
    engine = new Engine(cold, { registry: h.registry, models: m.catalog, clock: h.clock });
    await engine.ready();
    expect(cold.getThread(id)?.execution?.model).toBe("gpt-6-sol");
    expect(Object.values(cold.snapshotThread(id).agents)[0]?.model).toBe("gpt-6-sol");
    const { Command } = await import("@ace/protocol");
    const receipt = engine.handler.handle(
      Command.parse({
        id: "resume-default",
        deviceId: "test",
        payload: {
          type: "thread.send",
          threadId: id,
          input: [{ type: "text", text: "synthetic" }],
        },
      }),
      commandContext(cold),
    );
    expect(receipt.ok).toBe(true);
    await engine.flush();
    expect(h.contexts[1]?.model).toBe("gpt-6-sol");
    await engine.close();
    cold.close();
    cold = undefined;
    const restarted = new Store(h.path);
    try {
      expect(restarted.getThread(id)?.execution?.model).toBe("gpt-6-sol");
    } finally {
      restarted.close();
    }
  } finally {
    await engine?.close();
    cold?.close();
    await h.close();
    await m.catalog.close();
  }
});

test("a native thread without an account does not borrow another account's default", async () => {
  const config = ModelInstance.parse({
    id: "other-account",
    provider: "codex",
    loginRevision: "test",
    executable: "unused",
    cwd: process.cwd(),
  });
  const catalog = new ModelCatalog({
    instances: [config],
    storage: { load: () => [], replace() {}, remove() {}, close() {} },
    discover: async () => normalizeCodex({ data: [native("other-account-model", true)] }, config),
    now: () => 1000,
    deadline: () => () => {},
  });
  await catalog.refresh();
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    models: catalog,
  });
  try {
    const receipt = h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "codex",
      input: [{ type: "text", text: "synthetic" }],
    });
    expect(receipt.ok).toBe(true);
    await h.engine.flush();
    expect(h.contexts).toHaveLength(1);
    expect(h.contexts[0]?.model).toBeUndefined();
    expect(
      receipt.threadId && h.store.getThread(receipt.threadId)?.execution?.model,
    ).toBeUndefined();
  } finally {
    await h.close();
    await catalog.close();
  }
});

test("cold legacy rows wait for their own resume to discover a concrete model", async () => {
  const m = models();
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  let cold: Store | undefined;
  let engine: Engine | undefined;
  try {
    const id = await h.create();
    await h.engine.close();
    h.store.atomic((db) => {
      db.prepare("UPDATE engine_sessions SET model='default' WHERE thread_id=?").run(id);
      db.prepare(
        "UPDATE engine_transitions SET value=json_set(value, '$.selection.model', 'default') WHERE thread_id=?",
      ).run(id);
    });
    h.store.appendEvents(
      id,
      [{ type: "thread.updated", execution: { provider: "codex", model: "default", options: {} } }],
      1001,
    );
    cold = new Store(h.path);
    engine = new Engine(cold, { registry: h.registry, models: m.catalog, clock: h.clock });
    await engine.ready();
    expect(cold.getThread(id)?.execution?.model).toBe("default");
    expect(
      m.catalog.resolveCached({ role: "thread", provider: "codex", instance: "codex-cli-default" })
        .ok,
    ).toBe(false);
    const { Command } = await import("@ace/protocol");
    const receipt = engine.handler.handle(
      Command.parse({
        id: "cold-resume-default",
        deviceId: "test",
        payload: {
          type: "thread.send",
          threadId: id,
          input: [{ type: "text", text: "synthetic" }],
        },
      }),
      commandContext(cold),
    );
    expect(receipt.ok).toBe(true);
    await engine.flush();
    expect(h.contexts[1]?.model).toBe("gpt-6.1-sol");
    expect(cold.getThread(id)?.execution?.model).toBe("gpt-6.1-sol");
  } finally {
    await engine?.close();
    cold?.close();
    await h.close();
    await m.catalog.close();
  }
});

test("ACP creation and next-turn defaults stay within the selected installation", async () => {
  let preferences: ProviderConfigurations = [];
  const configs = ["other-install", "test-install"].map((installationId) =>
    ModelInstance.parse({
      id: `catalog-${installationId}`,
      provider: "acp",
      acpAgentId: "test-agent",
      installationId,
      instanceId: "test-instance",
      loginRevision: "test",
      executable: "unused",
      cwd: process.cwd(),
    }),
  );
  const catalog = new ModelCatalog({
    instances: configs,
    storage: { load: () => [], replace() {}, remove() {}, close() {} },
    discover: async () => [],
    now: () => 1000,
    deadline: () => () => {},
    preferences: () => preferences,
  });
  for (const config of configs)
    await catalog.updateFromSession(config, {
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: `${config.installationId}-model`,
          options: [
            { value: `${config.installationId}-model`, name: `${config.installationId}-model` },
            {
              value: `${config.installationId}-alternate`,
              name: `${config.installationId}-alternate`,
            },
          ],
        },
      ],
    });
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
    { provider: "acp", models: catalog },
  );
  const delivered: (string | undefined)[] = [];
  const original = h.registry.get("acp").adapter;
  h.registry.register(
    {
      ...original,
      async openSession(context) {
        const session = await original.openSession(context);
        let model = context.model;
        return {
          ...session,
          async configure(selection) {
            model = selection.model;
          },
          async send(input, mode, command) {
            delivered.push(model);
            await session.send(input, mode, command);
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  try {
    const receipt = h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "acp",
      acpAgentId: "test-agent",
      installationId: "test-install",
      instanceId: "test-instance",
      input: [{ type: "text", text: "synthetic" }],
    });
    expect(receipt.ok).toBe(true);
    if (!receipt.threadId) throw new Error("No created thread");
    await h.engine.flush();
    expect(h.contexts[0]?.model).toBe("test-install-model");
    preferences = [
      { provider: "acp", instance: "catalog-test-install", defaultModel: "test-install-alternate" },
    ];
    h.command({
      type: "thread.send",
      threadId: receipt.threadId,
      model: "default",
      input: [{ type: "text", text: "synthetic" }],
    });
    await h.engine.flush();
    expect(delivered).toEqual(["test-install-model", "test-install-alternate"]);
    expect(h.store.getThread(receipt.threadId)?.execution?.model).toBe("test-install-alternate");
  } finally {
    await h.close();
    await catalog.close();
  }
});
