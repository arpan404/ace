import { expect, test } from "vitest";
import {
  AgentControlOperation,
  CatalogModel,
  DelegationRequest,
  type ThreadId,
} from "@ace/protocol";
import { ModelCatalog, ModelInstance, openModelStorage, createModelDiscovery } from "@ace/models";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { start, end } from "../engine/test-support.ts";
import { AccountRegistry, createInstance } from "@ace/accounts";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setup } from "./test-support.ts";
import { createAgentControlPort } from "./tools.ts";

test("delegation carries the discovered OpenCode model to child launch without a second provider prefix", async () => {
  const initial = setup();
  // Run the double in place: it imports the adapter's contract by relative path.
  const executable = fileURLToPath(
    new URL("../../../../packages/adapter-opencode/src/testing/cli-v2.mjs", import.meta.url),
  );
  // The double reports opencode-go as connected; discovery lists only connected upstreams.
  const env = {
    HOME: initial.home,
    ACE_TEST_OPENCODE_CONNECTIONS: JSON.stringify([
      { id: "opencode-go", connections: [{ type: "credential" }] },
    ]),
  };
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(initial.home, "models.sqlite")),
    instances: [
      ModelInstance.parse({
        id: "opencode-cli-default",
        provider: "opencode",
        executable,
        cwd: initial.home,
        env,
        loginRevision: "test",
      }),
    ],
    now: () => initial.clock.now(),
    deadline: (fn, ms) => initial.clock.setTimer(fn, ms),
    discover: createModelDiscovery(),
  });
  await catalog.refresh();
  await initial.close();
  const f = setup({}, initial.dbPath, false, undefined, false, undefined, undefined, catalog);
  const creates: unknown[] = [];
  const adapter = createOpenCodeAdapter({
    discovery: { overrides: { opencode: executable }, env },
    runtime: {
      fetch: async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (
          url.pathname === "/api/session" &&
          init?.method === "POST" &&
          typeof init.body === "string"
        )
          creates.push(JSON.parse(init.body));
        return fetch(input, init);
      },
    },
  });
  f.registry.register(adapter, {
    installed: true,
    auth: "logged_in",
    loginHint: "unused",
    version: "2.0.22",
  });
  try {
    const parent = await f.parent();
    const child = f.service.delegate(
      parent,
      DelegationRequest.parse({
        requestId: "opencode-child",
        task: "Synthetic task",
        role: "opencode-child-task",
        provider: "opencode",
        model: "opencode-go/muse-spark-1.3-contributor",
      }),
    );
    await f.engine.flush();
    expect(creates).toEqual([
      expect.objectContaining({
        model: { providerID: "opencode-go", id: "muse-spark-1.3-contributor" },
      }),
    ]);
    expect(f.store.getThread(child.childId)?.execution?.model).toBe(
      "opencode-go/muse-spark-1.3-contributor",
    );
  } finally {
    await f.close();
    await adapter.close();
    await catalog.close();
  }
});

async function fixture(defaultAvailable = true, scopedAccounts = false, defaultModel?: string) {
  const h = setup();
  const accountDb = scopedAccounts ? new DatabaseSync(join(h.home, "accounts.sqlite")) : undefined;
  const accounts = accountDb ? new AccountRegistry(accountDb) : undefined;
  if (accounts) {
    for (const id of ["selected", "foreign"]) {
      await accounts.register(
        createInstance({ id, provider: "claude", label: id, homeDir: join(h.home, id) }),
      );
      accounts.ingest(id, {
        provider: "claude",
        payload: new ProviderPayload('{"auth":"logged_in"}'),
        observedAt: 1000,
        timeZone: "UTC",
      });
    }
  }
  const instance = ModelInstance.parse({
    id: scopedAccounts ? "selected" : "claude-cli-default",
    provider: "claude",
    executable: "unused",
    cwd: h.home,
    loginRevision: "test",
  });
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(h.home, "models.sqlite")),
    preferences: () => (defaultModel ? [{ provider: "claude", defaultModel }] : []),
    instances: [instance, ...(scopedAccounts ? [{ ...instance, id: "foreign" }] : [])],
    now: () => h.clock.now(),
    deadline: (fn, ms) => h.clock.setTimer(fn, ms),
    discover: async (target) => [
      ...(defaultAvailable && (!scopedAccounts || target.id === "foreign")
        ? [
            CatalogModel.parse({
              id: "opus",
              nativeModelId: "opus",
              resolvedModelId: "claude-opus-5-5",
              displayName: "Opus",
              provider: "claude",
              instance: target.id,
              efforts: [],
              serviceTiers: [],
              inputModalities: [],
              isDefault: false,
              hidden: false,
              deprecated: false,
              raw: { json: "{}", truncated: false },
            }),
          ]
        : []),
      ...(defaultAvailable && target.id !== "foreign"
        ? [
            CatalogModel.parse({
              id: "sonnet",
              nativeModelId: "sonnet",
              displayName: "Sonnet",
              provider: "claude",
              instance: target.id,
              efforts: [],
              serviceTiers: [],
              inputModalities: [],
              isDefault: true,
              hidden: false,
              deprecated: false,
              raw: { json: "{}", truncated: false },
            }),
          ]
        : []),
    ],
  });
  await catalog.refresh(scopedAccounts ? { instance: "foreign" } : {});
  // An independent engine owns each temporary database.
  await h.close();
  const f = setup({}, h.dbPath, false, undefined, false, accounts, undefined, catalog);
  return { f, catalog, accountDb };
}

test.each(["opus", "claude-opus-5-5", "opus-5.5"])(
  "delegating %s launches a catalog model and preserves retry identity",
  async (model) => {
    const { f, catalog } = await fixture();
    try {
      const parent = await f.parent();
      const port = createAgentControlPort(f.store, f.service);
      const operation = {
        op: "delegate_task",
        tasks: [
          {
            requestId: "greeter",
            task: "Say hello",
            role: "greet-user-choice",
            provider: "claude",
            model,
          },
        ],
      } as const;
      const delegate = async () => {
        const result = await port.execute(
          parent,
          AgentControlOperation.parse(operation),
          new AbortController().signal,
        );
        const [threadId] = (result.data as { threadIds: ThreadId[] }).threadIds;
        if (!threadId) throw new Error("No child started");
        return threadId;
      };
      const child = await delegate();
      await f.engine.flush();
      expect(f.contexts.get(child)?.model).toBe("claude-opus-5-5");
      expect(await delegate()).toBe(child);
    } finally {
      await f.close();
      await catalog.close();
    }
  },
);

/** A greeting task for Claude, naming `model` when given. */
function greeting(requestId: string, model?: string) {
  return DelegationRequest.parse({
    requestId,
    task: "Say hello",
    role: `greet-${requestId}`,
    provider: "claude",
    ...(model ? { model } : {}),
  });
}

test("the person's role model fills an open choice but never replaces a model the agent named", async () => {
  const { f, catalog } = await fixture();
  try {
    const parent = await f.parent();
    const child = f.service.delegate(parent, greeting("open-choice"), "opus");
    await f.engine.flush();
    expect(f.contexts.get(child.childId)?.model).toBe("claude-opus-5-5");
    const before = f.store.listThreads();
    expect(() => f.service.delegate(parent, greeting("named", "missing-model"), "opus")).toThrow(
      /requested model missing-model is unavailable there\. Settings → Roles names claude-opus-5-5 for claude/,
    );
    expect(f.store.listThreads()).toEqual(before);
  } finally {
    await f.close();
    await catalog.close();
  }
});

test("a model the chosen account lacks is refused even when another account serves it, never swapped for the chosen account's default", async () => {
  const { f, catalog, accountDb } = await fixture(true, true);
  try {
    const parent = await f.parent();
    // Remove selected metadata to exercise a cold target alongside a warm foreign catalog.
    await catalog.invalidate({ instance: "selected" });
    const port = createAgentControlPort(f.store, f.service);
    const before = f.store.listThreads();
    await expect(
      port.execute(
        parent,
        {
          op: "delegate_task",
          requestId: "account-scoped",
          task: "Say hello",
          role: "greet-account-scoped",
          provider: "claude",
          model: "claude-opus-5-5",
          accountId: "selected",
          wait: false,
          estimatedLoad: 0,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/account selected: requested model claude-opus-5-5 is unavailable/);
    expect(f.store.listThreads()).toEqual(before);
  } finally {
    await f.close();
    await catalog.close();
    accountDb?.close();
  }
});

test("a named model the catalog lacks is refused before creating a child", async () => {
  const { f, catalog } = await fixture(false);
  try {
    const parent = await f.parent();
    const before = f.store.listThreads();
    const port = createAgentControlPort(f.store, f.service);
    await expect(
      port.execute(
        parent,
        {
          op: "delegate_task",
          requestId: "bad",
          task: "Say hello",
          role: "greet-bad-model",
          provider: "claude",
          model: "opus-5.5",
          wait: false,
          estimatedLoad: 0,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Cannot delegate to claude.*requested model opus-5\.5 is unavailable/);
    expect(f.store.listThreads()).toEqual(before);
    expect(f.service.journal.reservations()).toEqual([]);
  } finally {
    await f.close();
    await catalog.close();
  }
});

test("delegation without a model uses the synced provider default over a parent's selection", async () => {
  const { f, catalog } = await fixture(true, false, "sonnet");
  try {
    const parent = await f.parent();
    const child = f.service.delegate(
      parent,
      DelegationRequest.parse({
        requestId: "default-picker",
        task: "Synthetic",
        role: "pick-default-model",
        provider: "claude",
      }),
    );
    await f.engine.flush();
    expect(f.contexts.get(child.childId)?.model).toBe("sonnet");
  } finally {
    await f.close();
    await catalog.close();
  }
});

test("a signed-out OpenCode CLI can delegate an unauthenticated model but not an authenticated one", async () => {
  const initial = setup();
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(initial.home, "open-models.sqlite")),
    instances: [
      ModelInstance.parse({
        id: "opencode-cli-default",
        provider: "opencode",
        executable: "unused",
        cwd: initial.home,
        loginRevision: "synthetic",
      }),
    ],
    now: initial.clock.now,
    deadline: initial.clock.setTimer,
    discover: async (instance) =>
      ["public", "private"].map((id) =>
        CatalogModel.parse({
          id,
          nativeModelId: id,
          provider: "opencode",
          instance: instance.id,
          displayName: id,
          efforts: [],
          serviceTiers: [],
          inputModalities: [],
          isDefault: id === "public",
          free: id === "public",
          hidden: false,
          deprecated: false,
          raw: { json: "{}", truncated: false },
        }),
      ),
  });
  await initial.close();
  const h = setup({}, initial.dbPath, false, undefined, false, undefined, undefined, catalog);
  const adapter = createScriptedAdapter({
    provider: "opencode",
    capabilities: h.registry.get("claude").capabilities,
    createTranslator: () => ({ translate: h.frames.translate, tick: () => [] }),
    steps: [{ on: "send", frames: [h.frames.frame(start, end)] }],
  });
  h.registry.register(
    {
      ...adapter,
      openSession: (context) => {
        h.contexts.set(context.threadId, context);
        return adapter.openSession(context);
      },
    },
    { installed: true, auth: "logged_out", loginHint: "synthetic" },
  );
  try {
    const parent = await h.parent();
    const request = DelegationRequest.parse({
      requestId: "public",
      provider: "opencode",
      task: "Inspect",
      role: "inspect-public-catalog",
      model: "public",
    });
    const child = h.service.delegate(parent, request);
    await h.engine.flush();
    expect(h.contexts.get(child.childId)?.model).toBe("public");
    expect(() =>
      h.service.delegate(parent, { ...request, requestId: "private", model: "private" }),
    ).toThrow(/requires authentication/);
    expect(h.store.listThreads()).toHaveLength(2);
  } finally {
    await h.close();
    await catalog.close();
  }
});
