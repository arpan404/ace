import { expect, test } from "vitest";
import { CatalogModel, DelegationRequest } from "@ace/protocol";
import { ModelCatalog, ModelInstance, openModelStorage } from "@ace/models";
import { AccountRegistry, createInstance } from "@ace/accounts";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { join } from "node:path";
import { setup } from "./test-support.ts";
import { createAgentControlPort } from "./tools.ts";

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
              reasoningEfforts: [],
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
              reasoningEfforts: [],
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
      const request = DelegationRequest.parse({
        requestId: "greeter",
        task: "Say hello",
        role: "greeter",
        provider: "claude",
        model,
      });
      const child = f.service.delegate(parent, request);
      await f.engine.flush();
      expect(f.contexts.get(child.childId)?.model).toBe("claude-opus-5-5");
      expect(f.service.delegate(parent, request).childId).toBe(child.childId);
    } finally {
      await f.close();
      await catalog.close();
    }
  },
);

test("a configured user choice wins over an invalid agent guess", async () => {
  const { f, catalog } = await fixture();
  try {
    const parent = await f.parent();
    const child = f.service.delegate(
      parent,
      DelegationRequest.parse({
        requestId: "configured",
        task: "Say hello",
        role: "greeter",
        provider: "claude",
        model: "opus-5.5",
      }),
      "opus",
    );
    await f.engine.flush();
    expect(f.contexts.get(child.childId)?.model).toBe("claude-opus-5-5");
  } finally {
    await f.close();
    await catalog.close();
  }
});

test("delegation resolves against the chosen account even when another account knows the guessed alias", async () => {
  const { f, catalog, accountDb } = await fixture(true, true);
  try {
    const parent = await f.parent();
    // Remove selected metadata to exercise a cold target alongside a warm foreign catalog.
    await catalog.invalidate({ instance: "selected" });
    const port = createAgentControlPort(f.store, f.service);
    const result = await port.execute(
      parent,
      {
        op: "delegate_task",
        requestId: "account-scoped",
        task: "Say hello",
        role: "greeter",
        provider: "claude",
        model: "claude-opus-5-5",
        accountId: "selected",
        wait: false,
        estimatedLoad: 0,
      },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    await f.engine.flush();
    const child = f.service.journal.receipt(parent.threadId, "account-scoped");
    if (!child) throw new Error("Missing delegated thread");
    expect(f.contexts.get(child.childId)).toMatchObject({
      model: "sonnet",
      instanceId: "selected",
    });
  } finally {
    await f.close();
    await catalog.close();
    accountDb?.close();
  }
});

test("an unavailable model without a valid default reports an error before creating a child", async () => {
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
          role: "greeter",
          provider: "claude",
          model: "opus-5.5",
          wait: false,
          estimatedLoad: 0,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Cannot delegate to claude.*no valid configured default/);
    expect(f.store.listThreads()).toEqual(before);
    expect(f.service.journal.activeCount()).toBe(0);
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
        role: "worker",
        provider: "claude",
        model: "default",
      }),
    );
    await f.engine.flush();
    expect(f.contexts.get(child.childId)?.model).toBe("sonnet");
  } finally {
    await f.close();
    await catalog.close();
  }
});
