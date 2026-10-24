import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AccountRegistry, createInstance } from "@ace/accounts";
import { ModelCatalog, openModelStorage, type ModelCatalogApi } from "@ace/models";
import {
  AgentControlOperation,
  CatalogModel,
  ThreadId,
  type AccessModeOffer,
  type McpAttribution,
  type ProviderKind,
} from "@ace/protocol";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { createAgentControlPort } from "@ace/daemon";
import { mcpAwareness } from "../mcp-awareness.ts";
import { scriptedEfforts, scriptedModelInstance } from "../testing/models.ts";
import { setup } from "./test-support.ts";

const signal = () => new AbortController().signal;
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function model(
  provider: ProviderKind,
  instance: string,
  id: string,
  displayName: string,
  extra: Partial<CatalogModel> = {},
) {
  return CatalogModel.parse({
    id,
    nativeModelId: id,
    displayName,
    provider,
    instance,
    efforts: scriptedEfforts,
    defaultEffort: "medium",
    serviceTiers: [],
    inputModalities: [],
    isDefault: false,
    hidden: false,
    deprecated: false,
    raw: { json: "{}", truncated: false },
    ...extra,
  });
}

function childOf(result: { data?: unknown }) {
  const [childId] = (result.data as { threadIds: string[] }).threadIds;
  if (!childId) throw new Error("No child started");
  return childId;
}

type Served = readonly [
  id: string,
  name: string,
  family?: string | undefined,
  tier?: string | undefined,
  isDefault?: boolean,
];

/**
 * The default Claude and Codex logins plus added Claude accounts, each serving its own models.
 * An account `serves` leaves out runs the scripted default model; discovery fails for an account
 * whose id starts with "broken-". `discoveries` counts discovery runs per account.
 */
async function harness(
  added: Record<string, string>,
  serves: Record<string, readonly Served[]>,
  /** What every account reports as its access modes, in place of what discovery found. */
  accessModes?: AccessModeOffer[],
) {
  const home = mkdtempSync(join(tmpdir(), "ace-account-reach-"));
  homes.push(home);
  const db = new DatabaseSync(":memory:");
  const accounts = new AccountRegistry(db);
  const ids = ["claude-cli-default", "codex-cli-default", ...Object.keys(added)];
  const fallback: readonly Served[] = [
    ["chosen-model", "Scripted model", undefined, undefined, true],
  ];
  const discoveries = new Map<string, number>();
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(home, "models.sqlite")),
    instances: ids.map((id) =>
      scriptedModelInstance(id.startsWith("codex") ? "codex" : "claude", home, id),
    ),
    now: () => 1000,
    deadline: () => () => {},
    discover: async (target) => {
      discoveries.set(target.id, (discoveries.get(target.id) ?? 0) + 1);
      if (target.id.startsWith("broken-")) throw new Error("CLI not installed");
      return (serves[target.id] ?? fallback).map(([id, name, family, tier, isDefault]) =>
        model(target.provider, target.id, id, name, {
          ...(family ? { family } : {}),
          ...(tier === "legacy" ? { tier: "legacy" as const } : {}),
          isDefault: isDefault === true,
        }),
      );
    },
  });
  // The catalog as the daemon reads it, optionally reporting other access modes per account.
  const reported: ModelCatalogApi = accessModes
    ? new Proxy(catalog, {
        get(target, key) {
          if (key === "list")
            return (options: Parameters<ModelCatalog["list"]>[0]) => {
              const page = target.list(options);
              return {
                ...page,
                instances: page.instances.map((entry) => Object.assign({}, entry, { accessModes })),
              };
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      })
    : catalog;
  const h = setup({}, undefined, false, undefined, false, accounts, undefined, reported);
  for (const [id, label] of Object.entries(added)) {
    await accounts.register(
      createInstance({ id, provider: "claude", label, homeDir: join(h.home, id) }),
    );
    accounts.ingest(id, {
      provider: "claude",
      payload: new ProviderPayload(JSON.stringify({ auth: "logged_in" })),
      observedAt: 1000,
      timeZone: "UTC",
    });
  }
  await catalog.refresh();
  const port = createAgentControlPort(h.store, h.service);
  const run = (caller: McpAttribution, operation: Record<string, unknown>) =>
    port.execute(caller, AgentControlOperation.parse(operation), signal());
  const delegate = (caller: McpAttribution, task: Record<string, unknown>) =>
    run(caller, {
      op: "delegate_task",
      tasks: [{ task: "Review the change", provider: "claude", ...task }],
    });
  const childModel = async (result: { data?: unknown }) => {
    const childId = childOf(result);
    await h.engine.flush();
    const child = [...h.contexts.values()].find((context) => context.threadId === childId);
    return { instance: child?.instanceId, model: child?.model };
  };
  const close = async () => {
    await h.close();
    await catalog.close();
    db.close();
  };
  return { h, catalog, discoveries, run, delegate, childModel, close };
}

// "346" serves Opus 5.5; "Work" serves Opus 4.8 and, as its default, Sonnet 5.5.
const added = { "claude-346": "346", "claude-work": "Work" };
const serves: Record<string, readonly Served[]> = {
  "claude-346": [["claude-opus-5-5", "Opus 5.5", "claude-opus", "current", true]],
  "claude-work": [
    ["claude-opus-4-8", "Opus 4.8", "claude-opus", "legacy"],
    ["claude-sonnet-5-5", "Sonnet 5.5", "claude-sonnet", "current", true],
  ],
};

test("one catalog read lists every account an agent can delegate to", async () => {
  const { h, run, close } = await harness(added, serves);
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

test("sixty accounts with long labels and large native permission selectors fit one catalog read", async () => {
  const many = Object.fromEntries(
    Array.from({ length: 60 }, (_, index) => [`claude-${index}`, `${"label ".repeat(20)}${index}`]),
  );
  // Each mode's native selector near its largest: sixty accounts of these alone exceed the budget.
  const selectors = (["read-only", "ask", "auto-review", "full-access"] as const).map((mode) => ({
    mode,
    native: `${mode}:${"n".repeat(4000)}`,
  }));
  const { h, run, close } = await harness(many, {}, selectors);
  try {
    const parent = await h.parent();
    const page = await run(parent, { op: "agents.catalog", limit: 20 });
    expect(page.ok).toBe(true);
    expect((page.data as { instances: unknown[] }).instances).toHaveLength(62);
    expect(page.data).not.toHaveProperty("instancesOmitted");
  } finally {
    await close();
  }
});

test("a search returns each model once with all its accounts, so many accounts hide nothing", async () => {
  const many = Object.fromEntries(
    Array.from({ length: 21 }, (_, index) => [`claude-${index}`, `Account ${index}`]),
  );
  const luna = Object.fromEntries(
    Object.keys(many).map((id): [string, readonly Served[]] => [
      id,
      [["gpt-6-luna", "GPT-6 Luna"]],
    ]),
  );
  const { h, run, close } = await harness(
    { ...many, "claude-astra": "Astra" },
    { ...luna, "claude-astra": [["gpt-6-astra", "GPT-6 Astra"]] },
  );
  try {
    const parent = await h.parent();
    const page = await run(parent, { op: "agents.catalog", query: "gpt 6", limit: 20 });
    const models = (page.data as { models: { id: string; accounts?: string[] }[] }).models;
    expect(models.map((entry) => entry.id).toSorted()).toEqual(["gpt-6-astra", "gpt-6-luna"]);
    expect(models.find((entry) => entry.id === "gpt-6-luna")?.accounts).toHaveLength(21);
    const none = await run(parent, { op: "agents.catalog", query: "nothing like it" });
    expect((none.data as { models: unknown[] }).models).toEqual([]);
  } finally {
    await close();
  }
});

test("a loose name on a named account means that account's model, never another account's", async () => {
  const { h, delegate, childModel, close } = await harness(added, serves);
  try {
    const parent = await h.parent();
    const result = await delegate(parent, {
      requestId: "on-work",
      role: "review-on-work-account",
      model: "opus",
      accountId: "work",
    });
    expect(await childModel(result)).toEqual({
      instance: "claude-work",
      model: "claude-opus-4-8",
    });
  } finally {
    await close();
  }
});

test("a named model only one account serves runs there when no account is named", async () => {
  const { h, delegate, childModel, close } = await harness(added, serves);
  try {
    const parent = await h.parent();
    for (const [requestId, name, instance, id] of [
      ["newest", "Opus 5.5", "claude-346", "claude-opus-5-5"],
      ["older", "opus 4.8", "claude-work", "claude-opus-4-8"],
    ] as const) {
      const result = await delegate(parent, {
        requestId,
        role: `review-${requestId}`,
        model: name,
      });
      expect(await childModel(result)).toEqual({ instance, model: id });
    }
  } finally {
    await close();
  }
});

test("a model the named account lacks is refused, never swapped for its default", async () => {
  const { h, delegate, close } = await harness(added, serves);
  try {
    const parent = await h.parent();
    const before = h.store.listThreads().length;
    await expect(
      delegate(parent, {
        requestId: "missing",
        role: "review-missing-model",
        model: "claude-opus-5-5",
        accountId: "Work",
      }),
    ).rejects.toThrow(/account claude-work: requested model claude-opus-5-5 is unavailable/);
    await expect(
      delegate(parent, { requestId: "reversed", role: "review-reversed", model: "opus 8.4" }),
    ).rejects.toThrow(/requested model opus 8.4 is unavailable/);
    expect(h.store.listThreads()).toHaveLength(before);
  } finally {
    await close();
  }
});

test("configuring a thread takes a loose model name on the thread's own account", async () => {
  const { h, run, delegate, childModel, close } = await harness(added, serves);
  try {
    const parent = await h.parent();
    const result = await delegate(parent, {
      requestId: "configured",
      role: "review-then-switch",
      model: "sonnet",
      accountId: "Work",
    });
    expect(await childModel(result)).toMatchObject({ model: "claude-sonnet-5-5" });
    const childId = childOf(result);
    await h.complete(ThreadId.parse(childId), "Reviewed");
    expect(
      await run(parent, {
        op: "thread.configure",
        threadId: childId,
        requestId: "switch",
        model: "Opus 4.8",
      }),
    ).toMatchObject({ ok: true });
    await h.engine.flush();
    const thread = h.store.listThreads().find((entry) => entry.id === childId);
    expect(thread?.execution).toMatchObject({
      model: "claude-opus-4-8",
      instanceId: "claude-work",
    });
  } finally {
    await close();
  }
});

test("a loose name on an account whose model list never loaded is matched once it loads", async () => {
  const { h, catalog, delegate, childModel, close } = await harness(added, serves);
  try {
    const parent = await h.parent();
    await catalog.invalidate({ instance: "claude-work" });
    const result = await delegate(parent, {
      requestId: "cold-work",
      role: "review-on-cold-account",
      model: "Opus 4.8",
      accountId: "Work",
    });
    expect(await childModel(result)).toEqual({
      instance: "claude-work",
      model: "claude-opus-4-8",
    });
  } finally {
    await close();
  }
});

test("a model on the last of thousands of catalog rows is still found by search and by name", async () => {
  const many = Object.fromEntries(
    Array.from({ length: 55 }, (_, index) => [`claude-${index}`, `Account ${index}`]),
  );
  const filler = Array.from({ length: 100 }, (_, index): Served => [
    `filler-${index}`,
    `Filler ${index}`,
  ]);
  const rows = Object.fromEntries(
    Object.keys(many).map((id): [string, readonly Served[]] => [id, filler]),
  );
  rows["claude-54"] = [...filler.slice(1), ["needle-model", "Needle Model"]];
  const { h, run, delegate, childModel, close } = await harness(many, rows);
  try {
    const parent = await h.parent();
    const page = await run(parent, { op: "agents.catalog", query: "needle", limit: 20 });
    expect((page.data as { models: { id: string }[] }).models.map((entry) => entry.id)).toEqual([
      "needle-model",
    ]);
    const result = await delegate(parent, {
      requestId: "needle",
      role: "review-needle",
      model: "needle",
    });
    expect(await childModel(result)).toEqual({ instance: "claude-54", model: "needle-model" });
  } finally {
    await close();
  }
});

test("a cold account's exact fit wins over a loaded account's longer variant", async () => {
  const { h, catalog, delegate, childModel, close } = await harness(
    { "claude-346": "346", "claude-work": "Work" },
    {
      "claude-346": [
        ["claude-opus-4-8-contributor", "Opus 4.8 Contributor", "claude-opus", "current", true],
      ],
      "claude-work": [["claude-opus-4-8", "Opus 4.8", "claude-opus", "current", true]],
    },
  );
  try {
    const parent = await h.parent();
    await catalog.invalidate({ instance: "claude-work" });
    // No provider named either: the caller runs Codex, and Claude's accounts are searched.
    const result = await delegate(parent, {
      requestId: "exact-on-cold",
      role: "review-exact-on-cold",
      provider: undefined,
      model: "opus 4.8",
    });
    expect(await childModel(result)).toEqual({ instance: "claude-work", model: "claude-opus-4-8" });
  } finally {
    await close();
  }
});

test("an account whose discovery failed is not probed again on every unknown model name", async () => {
  const { h, discoveries, delegate, close } = await harness({ "broken-claude": "Broken" }, {});
  try {
    const parent = await h.parent();
    const before = discoveries.get("broken-claude") ?? 0;
    for (const requestId of ["first", "second", "third"])
      await expect(
        delegate(parent, { requestId, role: `review-${requestId}`, model: "nothing like it" }),
      ).rejects.toThrow(/unavailable/);
    expect(discoveries.get("broken-claude") ?? 0).toBe(before);
  } finally {
    await close();
  }
});
