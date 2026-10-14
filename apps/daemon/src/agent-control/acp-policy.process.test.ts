import { expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { AccountRegistry, createAcpInstance } from "@ace/accounts";
import { AgentCatalogInput, DelegationRequest } from "@ace/protocol";
import { setup } from "./test-support.ts";
import { start, end } from "../engine/test-support.ts";
import { scriptedModelInstance, seedScriptedModels } from "../testing/models.ts";

const one = { acpAgentId: "local:one", installationId: "approved-one", instanceId: "one:default" };
const two = { acpAgentId: "local:two", installationId: "approved-two", instanceId: "two:default" };
async function install(h: ReturnType<typeof setup>, reportedInstance?: string) {
  const capabilities = {
    ...h.registry.get("claude").capabilities,
    permissionModes: [
      {
        id: "plan",
        label: "Plan",
        description: "Installation-specific opaque mode",
        risk: "low" as const,
      },
    ],
  };
  const adapter = createScriptedAdapter({
    provider: "acp",
    capabilities,
    createTranslator: () => ({ translate: h.frames.translate, tick: () => [] }),
    steps: [{ on: "send", frames: [h.frames.frame(start, end)] }],
  });
  h.registry.register(
    {
      ...adapter,
      backend: "acp",
      acceptsIdentity: (identity) =>
        [one.installationId, two.installationId].includes(identity.installationId),
      openSession: (context) => {
        if (reportedInstance)
          context.onSessionIdentity?.({ backend: "acp", instanceId: reportedInstance });
        h.contexts.set(context.threadId, context);
        return adapter.openSession(context);
      },
    },
    { installed: true, auth: "unknown", loginHint: "synthetic" },
  );
  for (const [index, identity] of [one, two].entries()) {
    const catalogId = `acp-${String(index).repeat(64)}`;
    await seedScriptedModels(h.catalog, {
      ...scriptedModelInstance("acp", h.home, catalogId),
      ...identity,
    });
    h.catalog.updatePermissionModes(catalogId, capabilities.permissionModes);
  }
}
const request = (requestId: string, identity: typeof one) =>
  DelegationRequest.parse({
    requestId,
    provider: "acp",
    ...identity,
    role: "reader",
    task: "Inspect",
  });

test("an unprofiled ACP agent's own default policy cannot cross approved installations before or after SQLite restart", async () => {
  const h = setup();
  await install(h);
  const created = h.service.command("acp-parent", {
    type: "thread.create",
    provider: "acp",
    ...one,
    workspaceId: h.store.createWorkspace(h.home, "project"),
    input: [{ type: "text", text: "Plan" }],
  });
  if (!created.ok || !created.threadId) throw new Error("Parent missing");
  await h.engine.flush();
  const caller = h.caller(created.threadId);
  const child = h.service.delegate(caller, request("same-policy", one));
  await h.engine.flush();
  expect(h.contexts.get(child.childId)?.permissionMode).toBeUndefined();
  expect(() => h.service.delegate(caller, request("different-policy", two))).toThrow(
    "permission_ceiling_unverifiable",
  );
  expect(h.store.listThreads()).toHaveLength(2);
  await h.close();
  const reopened = setup({}, h.dbPath);
  await install(reopened);
  const restoredCaller = reopened.caller(created.threadId);
  expect(
    reopened.service.command("retain-captured-policy", {
      type: "thread.permission.set",
      threadId: child.childId,
      access: null,
    }).ok,
  ).toBe(true);
  expect(() =>
    reopened.service.delegate(restoredCaller, request("different-after-restart", two)),
  ).toThrow("permission_ceiling_unverifiable");
  for (const [index, difference] of [
    { ...one, acpAgentId: "local:other" },
    { ...one, installationId: "other-install" },
    { ...one, instanceId: "other-account" },
  ].entries())
    expect(() =>
      reopened.service.delegate(restoredCaller, request(`different-identity-${index}`, difference)),
    ).toThrow("permission_ceiling_unverifiable");
  const entry = reopened.registry.get("acp");
  const { backend: _backend, ...changedBackend } = entry.source;
  reopened.registry.register(changedBackend, entry.discovery);
  expect(() =>
    reopened.service.delegate(restoredCaller, request("different-backend", one)),
  ).toThrow("permission_ceiling_unverifiable");
  expect(reopened.store.listThreads()).toHaveLength(2);
  expect(reopened.contexts.has(child.childId)).toBe(false);
});

test("a captured ACP account ceiling survives restart and remains binding after its caller switches to unrestricted execution", async () => {
  const h = setup();
  await install(h);
  const created = h.service.command("captured-parent", {
    type: "thread.create",
    provider: "acp",
    ...one,
    workspaceId: h.store.createWorkspace(h.home, "project"),
    input: [{ type: "text", text: "Plan" }],
  });
  if (!created.ok || !created.threadId) throw new Error("Parent missing");
  await h.engine.flush();
  const child = h.service.delegate(h.caller(created.threadId), request("captured-child", one));
  await h.engine.flush();
  expect(h.contexts.get(child.childId)).toMatchObject({ acpIdentity: one });
  expect(h.contexts.get(child.childId)?.permissionMode).toBeUndefined();
  await h.close();
  const reopened = setup({}, h.dbPath);
  await install(reopened, two.instanceId);
  expect(
    reopened.service.command("broaden-provider", {
      type: "thread.switch",
      threadId: created.threadId,
      selection: { provider: "codex" },
    }).ok,
  ).toBe(true);
  await reopened.engine.flush();
  expect(
    reopened.service.command("broaden-mode", {
      type: "thread.permission.set",
      threadId: created.threadId,
      access: "full-access",
    }).ok,
  ).toBe(true);
  reopened.service.command("apply-broad-mode", {
    type: "thread.send",
    threadId: created.threadId,
    input: [{ type: "text", text: "Continue" }],
  });
  await reopened.engine.flush();
  expect(reopened.store.getThread(created.threadId)?.permission?.effective).toBe("full-access");
  expect(
    reopened.service.message(
      reopened.caller(created.threadId),
      "reopen-child",
      child.childId,
      "Must not run on the other account",
      "queue",
    ).ok,
  ).toBe(true);
  await reopened.engine.flush();
  expect(reopened.contexts.has(child.childId)).toBe(false);
  expect(reopened.engine.queue(child.childId)).toMatchObject({ paused: true, reason: "not_sent" });
});

test("ACP discovery uses the account identity for auth, labels, availability and enablement while retaining its catalog digest", async () => {
  const db = new DatabaseSync(":memory:"),
    accounts = new AccountRegistry(db);
  const h = setup(
    {},
    undefined,
    false,
    undefined,
    false,
    accounts,
    undefined,
    undefined,
    undefined,
    (provider, instance) => provider !== "acp" || instance !== one.instanceId,
  );
  try {
    await accounts.register(
      createAcpInstance({ identity: one, label: "Approved One", userHome: h.home }),
    );
    accounts.recordAcpAuth(one.instanceId, "logged_out", 1000);
    await install(h);
    const parent = await h.parent();
    const catalog = h.service.catalog(
      parent,
      AgentCatalogInput.parse({ provider: "acp", instanceId: one.instanceId }),
    );
    expect(catalog.instances).toHaveLength(1);
    expect(catalog.instances[0]).toMatchObject({
      instance: `acp-${"0".repeat(64)}`,
      instanceId: one.instanceId,
      accountLabel: "Approved One",
      auth: "logged_out",
      availability: "logged_out",
      enabled: false,
    });
  } finally {
    await h.close();
    db.close();
  }
});
