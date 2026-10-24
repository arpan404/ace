import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AccountRegistry, createInstance } from "@ace/accounts";
import { AgentControlOperation, type McpAttribution } from "@ace/protocol";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { createAgentControlPort } from "@ace/daemon";
import { mcpAwareness } from "../mcp-awareness.ts";
import { scriptedModelInstance } from "../testing/models.ts";
import { setup } from "./test-support.ts";

const signal = () => new AbortController().signal;

/** A daemon with the default Claude and Codex logins plus two added Claude accounts. */
async function harness() {
  const db = new DatabaseSync(":memory:");
  const accounts = new AccountRegistry(db);
  const h = setup({}, undefined, false, undefined, false, accounts);
  for (const [id, label] of [
    ["claude-346", "346"],
    ["claude-work", "Work"],
  ] as const) {
    await accounts.register(
      createInstance({ id, provider: "claude", label, homeDir: join(h.home, id) }),
    );
    accounts.ingest(id, {
      provider: "claude",
      payload: new ProviderPayload(JSON.stringify({ auth: "logged_in" })),
      observedAt: 1000,
      timeZone: "UTC",
    });
    h.catalog.registerInstance(scriptedModelInstance("claude", h.home, id));
  }
  const port = createAgentControlPort(h.store, h.service);
  const run = (caller: McpAttribution, operation: Record<string, unknown>) =>
    port.execute(caller, AgentControlOperation.parse(operation), signal());
  const close = async () => {
    await h.close();
    db.close();
  };
  return { h, run, close };
}

test("one catalog read lists every account an agent can delegate to", async () => {
  const { h, run, close } = await harness();
  try {
    const parent = await h.parent();
    const page = await run(parent, { op: "agents.catalog", limit: 1 });
    const instances = (page.data as { instances: { instance: string }[] }).instances;
    expect(instances.map((entry) => entry.instance).toSorted()).toEqual([
      "claude-346",
      "claude-cli-default",
      "claude-work",
      "codex-cli-default",
    ]);
    const awareness = mcpAwareness({
      store: h.store,
      delegations: () => h.service,
      notes: () => [],
      machine: null,
    });
    const claude = awareness.delegates(parent).find((entry) => entry.provider === "claude");
    expect(claude?.accounts).toEqual(expect.arrayContaining(["346", "Work"]));
  } finally {
    await close();
  }
});

test("a model searched by name comes back from every account that serves it", async () => {
  const { h, run, close } = await harness();
  try {
    const parent = await h.parent();
    const page = await run(parent, { op: "agents.catalog", provider: "claude", query: "scripted" });
    const models = (page.data as { models: { id: string; instance: string }[] }).models;
    expect(models.every((model) => model.id === "chosen-model")).toBe(true);
    expect(models.map((model) => model.instance).toSorted()).toEqual([
      "claude-346",
      "claude-cli-default",
      "claude-work",
    ]);
    const none = await run(parent, { op: "agents.catalog", query: "nothing like it" });
    expect((none.data as { models: unknown[] }).models).toEqual([]);
  } finally {
    await close();
  }
});

test("a child runs on the account named by its label, from a loosely written model name", async () => {
  const { h, run, close } = await harness();
  try {
    const parent = await h.parent();
    const result = await run(parent, {
      op: "delegate_task",
      tasks: [
        {
          requestId: "on-work",
          task: "Review the change",
          role: "review-on-work-account",
          provider: "claude",
          model: "Scripted Model",
          accountId: "work",
        },
      ],
    });
    expect(result).toMatchObject({ ok: true });
    const [childId] = (result.data as { threadIds: string[] }).threadIds;
    await h.engine.flush();
    const child = [...h.contexts.values()].find((context) => context.threadId === childId);
    expect(child?.instanceId).toBe("claude-work");
  } finally {
    await close();
  }
});
