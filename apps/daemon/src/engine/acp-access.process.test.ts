import { expect, test } from "vitest";
import { antigravityQuirks, genericQuirks } from "@ace/adapter-acp";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { ModelCatalog } from "@ace/models";
import type { AccessMode, NativePermissionMode } from "@ace/protocol";
import { scriptedModelDiscovery, scriptedModelInstance } from "../testing/models.ts";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const mode = (id: string): NativePermissionMode => ({
  id,
  label: id,
  description: id,
  risk: "medium",
});

/** An Antigravity daemon whose catalog row exists but knows no session modes yet. */
async function antigravity(refuseMode = false, defaultAccess?: AccessMode) {
  const frames = scriptFrames();
  const instance = scriptedModelInstance("antigravity", process.cwd());
  const catalog = new ModelCatalog({
    instances: [instance],
    storage: { load: () => [], replace() {}, remove() {}, close() {} },
    discover: scriptedModelDiscovery(),
    now: () => 1000,
    deadline: () => () => {},
  });
  await catalog.refresh();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "close" },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
    {
      provider: "antigravity",
      capabilities: antigravityQuirks.capabilities("1.2.1"),
      models: catalog,
      ...(defaultAccess ? { permissionSettings: async () => ({ access: defaultAccess }) } : {}),
      ...(refuseMode
        ? {
            // The daemon's default, so the thread's own row starts with no mode in effect.
            permissionSettings: async () => ({ access: "full-access" as const }),
            nativeAdapter: {
              ...createScriptedAdapter({
                provider: "antigravity",
                capabilities: antigravityQuirks.capabilities("1.2.1"),
                createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
                steps: [],
              }),
              openSession: () => Promise.reject(new Error("ACP mode selection unavailable")),
            },
          }
        : {}),
    },
  );
  return Object.assign(h, { catalog });
}

function createFullAccess(h: Awaited<ReturnType<typeof antigravity>>) {
  const created = h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider: "antigravity",
    access: "full-access",
    input: [{ type: "text", text: "first" }],
  });
  if (!created.ok || !created.threadId) throw new Error(created.error);
  return created.threadId;
}

test("Full access chosen on an Antigravity thread runs as yolo while its catalog knows no modes", async () => {
  const h = await antigravity();
  try {
    const id = createFullAccess(h);
    await h.engine.flush();
    expect(h.contexts.at(-1)?.permissionMode).toBe("yolo");
    expect(h.store.getThread(id)?.permission).toMatchObject({
      override: "full-access",
      effective: "full-access",
      pending: false,
    });
  } finally {
    await h.close();
  }
});

test("an access choice the agent no longer offers says so instead of staying pending", async () => {
  const h = await antigravity();
  try {
    const id = createFullAccess(h);
    await h.engine.flush();
    expect(h.contexts.at(-1)?.permissionMode).toBe("yolo");
    // The agent's next session reports no yolo: Full access can't run there.
    h.catalog.updatePermissionModes("antigravity-cli-default", [mode("default")]);
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "second" }] });
    await h.engine.flush();
    expect(h.contexts).toHaveLength(2);
    expect(h.contexts.at(-1)?.permissionMode).toBeUndefined();
    expect(h.store.getThread(id)?.permission).toMatchObject({ effective: null, pending: false });
    const notices = Object.values(h.store.snapshotThread(id).items).filter(
      (item) => item.type === "notice" && item.code === "access_mode_unavailable",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      text: "This agent doesn't offer Full access, so it runs with its own default.",
    });
  } finally {
    await h.close();
  }
});

test("a session that refuses its access mode never shows that mode as applied", async () => {
  const h = await antigravity(true);
  try {
    const created = h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "antigravity",
      input: [{ type: "text", text: "first" }],
    });
    if (!created.ok || !created.threadId) throw new Error(created.error);
    await h.engine.flush();
    expect(h.store.getThread(created.threadId)?.permission?.effective).toBeNull();
  } finally {
    await h.close();
  }
});

test("Full access chosen while an ACP turn runs reaches the agent in that turn", async () => {
  const frames = scriptFrames();
  const base = genericQuirks.capabilities();
  const permissionModes = [mode("plan"), mode("yolo")];
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames, {
    provider: "acp",
    capabilities: {
      ...base,
      permissionModes,
      accessModes: [
        { mode: "read-only", native: "plan" },
        { mode: "full-access", native: "yolo" },
      ],
      permissions: {
        modes: ["plan", "yolo"],
        permissionModes,
        nativeAutoReview: false,
        toolGate: true,
      },
    },
  });
  const original = h.registry.get("acp").adapter;
  const selected: string[] = [];
  h.registry.register(
    {
      ...original,
      acceptsIdentity: () => true,
      async openSession(context) {
        const session = await original.openSession(context);
        return Object.assign(session, {
          async setMode(native: string) {
            selected.push(native);
          },
        });
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  try {
    const created = h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "acp",
      acpAgentId: "test-agent",
      installationId: "test-install",
      instanceId: "test-instance",
      access: "read-only",
      input: [{ type: "text", text: "work" }],
    });
    if (!created.ok || !created.threadId) throw new Error(created.error);
    await h.engine.flush();
    expect(h.contexts.at(-1)?.permissionMode).toBe("plan");
    expect(h.store.getThread(created.threadId)?.status?.state).toBe("working");
    expect(
      h.command({
        type: "thread.permission.set",
        threadId: created.threadId,
        access: "full-access",
      }).ok,
    ).toBe(true);
    await expect.poll(() => selected).toEqual(["yolo"]);
    await h.engine.flush();
    expect(h.store.getThread(created.threadId)?.permission).toMatchObject({
      override: "full-access",
      effective: "full-access",
      pending: false,
    });
    expect(h.store.getThread(created.threadId)?.status?.state).toBe("working");
    expect(h.contexts).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("an Antigravity thread whose default is Read-only runs with Full access and says so once", async () => {
  const h = await antigravity(false, "read-only");
  try {
    const created = h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "antigravity",
      input: [{ type: "text", text: "first" }],
    });
    if (!created.ok || !created.threadId) throw new Error(created.error);
    const id = created.threadId;
    await h.engine.flush();
    expect(h.contexts.at(-1)?.permissionMode).toBe("yolo");
    expect(h.store.getThread(id)?.permission).toMatchObject({
      override: null,
      effective: "full-access",
      pending: false,
    });
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "second" }] });
    await h.engine.flush();
    expect(h.contexts.at(-1)?.permissionMode).toBe("yolo");
    const notices = Object.values(h.store.snapshotThread(id).items).filter(
      (item) => item.type === "notice" && item.code === "access_mode_unavailable",
    );
    expect(notices.map((notice) => notice.type === "notice" && notice.text)).toEqual([
      "This agent doesn't offer Read-only, so it runs with Full access.",
    ]);
  } finally {
    await h.close();
  }
});
