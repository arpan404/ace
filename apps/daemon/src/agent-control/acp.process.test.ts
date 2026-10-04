import { expect, test } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import type { SessionContext } from "@ace/engine-api";
import { start, end } from "../engine/test-support.ts";
import { setup } from "./test-support.ts";
import { scriptedModelInstance, seedScriptedModels } from "../testing/models.ts";

test("delegation resolves an approved ACP catalog by installation and account identity instead of catalog id", async () => {
  const h = setup();
  const identity = {
    acpAgentId: "local:agent",
    installationId: "approved",
    instanceId: "approved:default",
  };
  const contexts: SessionContext[] = [];
  const fake = createScriptedAdapter({
    provider: "acp",
    capabilities: h.registry.get("claude").capabilities,
    createTranslator: () => ({ translate: h.frames.translate, tick: () => [] }),
    steps: [{ on: "send", frames: [h.frames.frame(start, end)] }],
  });
  h.registry.register(
    {
      ...fake,
      acceptsIdentity: (selected) => selected.installationId === identity.installationId,
      openSession: (ctx) => {
        contexts.push(ctx);
        return fake.openSession(ctx);
      },
    },
    { installed: true, auth: "unknown", loginHint: "synthetic" },
  );
  const parent = await h.parent();
  await seedScriptedModels(h.catalog, {
    ...scriptedModelInstance("acp", h.home, "acp-production-catalog-digest"),
    ...identity,
  });
  const request = {
    requestId: "acp",
    provider: "acp" as const,
    ...identity,
    accountId: identity.instanceId,
    task: "work",
    role: "worker",
    wait: false,
    estimatedLoad: 0,
  };
  const child = h.service.delegate(parent, request);
  await h.engine.flush();
  expect(h.store.getThread(child.childId)).toMatchObject({ provider: "acp", ...identity });
  expect(contexts[0]?.acpIdentity).toEqual(identity);
  expect(contexts[0]?.model).toBe("chosen-model");
  for (const mismatch of [{ installationId: "not-approved" }, { instanceId: "other:default", accountId: "other:default" }, { acpAgentId: "local:other" }])
  expect(() =>
    h.service.delegate(parent, {
      ...request,
      requestId: `unapproved-${Object.keys(mismatch)[0]}`,
      ...mismatch,
    }),
  ).toThrow(/no valid configured default/);
  expect(h.store.listThreads()).toHaveLength(2);
});
