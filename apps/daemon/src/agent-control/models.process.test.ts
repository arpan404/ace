import { expect, test } from "vitest";
import { CatalogModel, DelegationRequest } from "@ace/protocol";
import { ModelCatalog, ModelInstance, openModelStorage } from "@ace/models";
import { join } from "node:path";
import { setup } from "./test-support.ts";
import { createAgentControlPort } from "./tools.ts";

async function fixture(defaultAvailable = true) {
  const h = setup();
  const instance = ModelInstance.parse({
    id: "claude-cli-default",
    provider: "claude",
    executable: "unused",
    cwd: h.home,
    loginRevision: "test",
  });
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(h.home, "models.sqlite")),
    instances: [instance],
    now: () => h.clock.now(),
    deadline: (fn, ms) => h.clock.setTimer(fn, ms),
    discover: async () => [
      CatalogModel.parse({
        id: "opus",
        nativeModelId: "opus",
        resolvedModelId: "claude-opus-5-5",
        displayName: "Opus",
        provider: "claude",
        instance: instance.id,
        reasoningEfforts: [],
        serviceTiers: [],
        inputModalities: [],
        isDefault: false,
        hidden: false,
        deprecated: false,
        raw: { json: "{}", truncated: false },
      }),
      ...(defaultAvailable
        ? [
            CatalogModel.parse({
              id: "sonnet",
              nativeModelId: "sonnet",
              displayName: "Sonnet",
              provider: "claude",
              instance: instance.id,
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
  await catalog.refresh();
  // An independent engine owns each temporary database.
  await h.close();
  const f = setup({}, h.dbPath, false, undefined, false, undefined, undefined, catalog);
  return { f, catalog };
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
      expect(f.contexts.get(child.childId)?.model).toBe(model === "opus-5.5" ? "sonnet" : "opus");
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
    expect(f.contexts.get(child.childId)?.model).toBe("opus");
  } finally {
    await f.close();
    await catalog.close();
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
