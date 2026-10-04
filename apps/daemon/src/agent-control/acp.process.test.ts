import { expect, test } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import type { SessionContext } from "@ace/engine-api";
import { start, end } from "../engine/test-support.ts";
import { setup } from "./test-support.ts";
import { scriptedModelInstance, seedScriptedModels } from "../testing/models.ts";

test("delegation carries approved ACP installation identity without inventing an account assignment", async () => {
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
    ...scriptedModelInstance("acp", h.home, identity.instanceId),
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
  expect(() =>
    h.service.delegate(parent, {
      ...request,
      requestId: "unapproved",
      installationId: "not-approved",
    }),
  ).toThrow(/no valid configured default/);
  expect(h.store.listThreads()).toHaveLength(2);
});
