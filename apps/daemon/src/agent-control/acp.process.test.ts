import { expect, test } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import type { SessionContext } from "@ace/engine-api";
import { start, end } from "../engine/test-support.ts";
import { setup } from "./test-support.ts";
import { AgentCatalogPage, AgentControlOperation } from "@ace/protocol";
import { createAgentControlPort } from "./tools.ts";
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
    role: "acp-run-task",
    wait: false,
    estimatedLoad: 0,
  };
  const child = h.service.delegate(parent, request);
  await h.engine.flush();
  expect(h.store.getThread(child.childId)).toMatchObject({ provider: "acp", ...identity });
  expect(contexts[0]?.acpIdentity).toEqual(identity);
  expect(contexts[0]?.model).toBe("chosen-model");
  for (const mismatch of [
    { installationId: "not-approved" },
    { instanceId: "other:default", accountId: "other:default" },
    { acpAgentId: "local:other" },
  ])
    expect(() =>
      h.service.delegate(parent, {
        ...request,
        requestId: `unapproved-${Object.keys(mismatch)[0]}`,
        ...mismatch,
      }),
    ).toThrow(/no valid configured default/);
  expect(h.store.listThreads()).toHaveLength(2);
});

test("an ACP login's account id from the catalog, with a loose model name, delegates there", async () => {
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
  // Production keys an ACP catalog by an opaque digest, never by the login's id.
  await seedScriptedModels(h.catalog, {
    ...scriptedModelInstance("acp", h.home, "acp-production-catalog-digest"),
    ...identity,
  });
  const port = createAgentControlPort(h.store, h.service);
  const run = (operation: Record<string, unknown>) =>
    port.execute(parent, AgentControlOperation.parse(operation), new AbortController().signal);
  // What the agent reads: the login and the model, each with the account id delegate takes.
  const page = AgentCatalogPage.parse(
    (await run({ op: "agents.catalog", provider: "acp", query: "scripted" })).data,
  );
  const accountId = page.instances[0]?.accountId;
  expect(accountId).toBe(identity.instanceId);
  expect(page.models[0]?.accounts).toEqual([identity.instanceId]);
  const result = await run({
    op: "delegate_task",
    tasks: [
      {
        requestId: "acp-loose",
        task: "work",
        role: "acp-loose-name-task",
        provider: "acp",
        accountId,
        model: "Scripted Model",
      },
    ],
  });
  expect(result).toMatchObject({ ok: true });
  await h.engine.flush();
  expect(contexts[0]?.acpIdentity).toEqual(identity);
  expect(contexts[0]?.model).toBe("chosen-model");
});
