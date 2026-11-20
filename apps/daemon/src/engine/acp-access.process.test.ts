import { expect, test } from "vitest";
import { antigravityQuirks, genericQuirks } from "@ace/adapter-acp";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { ModelCatalog } from "@ace/models";
import type { SessionContext, ProviderSession } from "@ace/engine-api";
import type {
  AccessMode,
  AccessModeOffer,
  Capabilities,
  NativePermissionMode,
  ThreadId,
} from "@ace/protocol";
import type { PermissionSettings } from "./permissions.ts";
import { AdapterRegistry } from "./registry.ts";
import { acpEngineOptions } from "../acp-engine.ts";
import { scriptedModelDiscovery, scriptedModelInstance } from "../testing/models.ts";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const noop = () => {};
const unused = (): never => {
  throw new Error("An Antigravity session uses no generic ACP launch");
};
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

/** ACP threads whose agent offers Read-only, Ask and Full access, with a held `setMode`. */
async function acpTree(
  options: {
    /** What a thread's session reports: its own offers, a refused mode, the mode it runs. */
    session?: (threadId: string) => Partial<ProviderSession>;
    /** Capabilities the daemon knows before any session opens (default: all three offers). */
    capabilities?: Capabilities;
    permissionSettings?: PermissionSettings;
  } = {},
) {
  const frames = scriptFrames();
  const h = await harness(
    Array.from({ length: 6 }, () => ({ on: "send" as const, frames: [frames.frame(start)] })),
    frames,
    {
      provider: "acp",
      capabilities: options.capabilities ?? treeCapabilities,
      ...(options.permissionSettings ? { permissionSettings: options.permissionSettings } : {}),
    },
  );
  const original = h.registry.get("acp").adapter;
  const calls: { thread: string; native: string }[] = [];
  const events: string[] = [];
  const contexts = new Map<string, SessionContext>();
  let gate: Promise<void> | undefined;
  h.registry.register(
    {
      ...original,
      acceptsIdentity: () => true,
      async openSession(context) {
        contexts.set(context.threadId, context);
        const session = await original.openSession(context);
        const send = session.send.bind(session);
        return Object.assign(session, options.session?.(context.threadId) ?? {}, {
          async setMode(native: string) {
            calls.push({ thread: context.threadId, native });
            events.push(`mode:${native}`);
            const wait = gate;
            if (wait) await wait;
          },
          send(...args: Parameters<typeof send>) {
            events.push("send");
            return send(...args);
          },
        });
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const create = async (access?: AccessMode, model?: string) => {
    const created = h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "acp",
      acpAgentId: "test-agent",
      installationId: "test-install",
      instanceId: "test-instance",
      ...(access ? { access } : {}),
      ...(model ? { model } : {}),
      input: [{ type: "text", text: "work" }],
    });
    if (!created.ok || !created.threadId) throw new Error(created.error);
    await h.engine.flush();
    return created.threadId;
  };
  const adopt = (parent: ThreadId, child: ThreadId) => {
    const thread = h.store.getThread(child);
    const agent = h.store.getThread(parent)?.rootAgentId;
    if (!thread || !agent) throw new Error("missing thread");
    h.engine.attachChild(parent, agent, thread, "worker", false);
  };
  const hold = () => {
    let release: () => void = noop;
    gate = new Promise<void>((resolve) => {
      release = () => {
        gate = undefined;
        resolve();
      };
    });
    return release;
  };
  const modes = (thread: string) =>
    calls.filter((call) => call.thread === thread).map((call) => call.native);
  const permission = (thread: ThreadId) => h.store.getThread(thread)?.permission;
  const notices = (thread: ThreadId, code: string) =>
    Object.values(h.store.snapshotThread(thread).items).filter(
      (item) => item.type === "notice" && item.code === code,
    );
  return { ...h, create, adopt, hold, modes, permission, notices, events, contexts };
}
const treeModes = [mode("plan"), mode("default"), mode("yolo")];
const treeOffers: AccessModeOffer[] = [
  { mode: "read-only", native: "plan" },
  { mode: "ask", native: "default" },
  { mode: "full-access", native: "yolo" },
];
const treeCapabilities: Capabilities = {
  ...genericQuirks.capabilities(),
  permissionModes: treeModes,
  accessModes: treeOffers,
  permissions: {
    modes: ["plan", "default", "yolo"],
    permissionModes: treeModes,
    nativeAutoReview: false,
    toolGate: true,
  },
};

test("a native mode asked for by name can't take a child past its parent", async () => {
  const h = await acpTree();
  try {
    const parent = await h.create("ask");
    const child = await h.create("ask");
    h.adopt(parent, child);
    const refused = h.command({ type: "thread.mode.set", threadId: child, mode: "yolo" });
    expect(refused).toMatchObject({ ok: false, error: "permission_ceiling_unverifiable" });
    await h.engine.flush();
    expect(h.modes(child)).toEqual([]);
    expect(h.permission(child)).toMatchObject({ effective: "ask", pending: false });
    // On a thread with no parent it is the same change as choosing Full access.
    expect(h.command({ type: "thread.mode.set", threadId: parent, mode: "yolo" }).ok).toBe(true);
    await expect.poll(() => h.modes(parent)).toEqual(["yolo"]);
    await h.engine.flush();
    expect(h.permission(parent)).toMatchObject({
      override: "full-access",
      effective: "full-access",
      pending: false,
    });
  } finally {
    await h.close();
  }
});

test("a parent tightening its access brings its running child's session down with it", async () => {
  const h = await acpTree();
  try {
    const parent = await h.create("full-access");
    const child = await h.create("full-access");
    h.adopt(parent, child);
    h.command({ type: "thread.permission.set", threadId: parent, access: "read-only" });
    await expect.poll(() => h.modes(child)).toEqual(["plan"]);
    await h.engine.flush();
    expect(h.permission(child)?.effective).toBe("read-only");
    expect(h.store.getThread(child)?.status?.state).toBe("working");
  } finally {
    await h.close();
  }
});

test("a running child whose agent has nothing as strict as its parent's new mode stops", async () => {
  const fullOnly: Partial<ProviderSession> = {
    effectiveCapabilities: { ...treeCapabilities, accessModes: [treeOffers[2]!] },
  };
  // The second session, the child's, reports it offers only Full access.
  let opened = 0;
  const h = await acpTree({ session: () => (++opened === 2 ? fullOnly : {}) });
  try {
    const parent = await h.create("full-access");
    const child = await h.create("full-access");
    h.adopt(parent, child);
    h.command({ type: "thread.permission.set", threadId: parent, access: "read-only" });
    await expect.poll(() => h.notices(child, "access_ceiling_stopped")).toHaveLength(1);
    await h.engine.flush();
    expect(h.store.getThread(child)?.status?.state).not.toBe("working");
    expect(h.modes(child)).toEqual([]);
  } finally {
    await h.close();
  }
});

test("a parent tightening while its child's mode change is on its way still contains the child", async () => {
  const h = await acpTree();
  try {
    const parent = await h.create("full-access");
    const child = await h.create("ask");
    h.adopt(parent, child);
    const release = h.hold();
    h.command({ type: "thread.permission.set", threadId: child, access: "full-access" });
    await expect.poll(() => h.modes(child)).toEqual(["yolo"]);
    h.command({ type: "thread.permission.set", threadId: parent, access: "ask" });
    release();
    await expect.poll(() => h.modes(child)).toEqual(["yolo", "default"]);
    await h.engine.flush();
    expect(h.permission(child)?.effective).toBe("ask");
  } finally {
    await h.close();
  }
});

test("Ask, Full access, Ask in quick succession leaves the session and the thread on Ask", async () => {
  const h = await acpTree();
  try {
    const id = await h.create("ask");
    const release = h.hold();
    h.command({ type: "thread.permission.set", threadId: id, access: "full-access" });
    await expect.poll(() => h.modes(id)).toEqual(["yolo"]);
    h.command({ type: "thread.permission.set", threadId: id, access: "ask" });
    release();
    await expect.poll(() => h.modes(id)).toEqual(["yolo", "default"]);
    await h.engine.flush();
    expect(h.permission(id)).toMatchObject({ override: "ask", effective: "ask", pending: false });
    expect(h.notices(id, "access_mode_unavailable")).toEqual([]);
  } finally {
    await h.close();
  }
});

test("a first session whose agent reports its modes only once open takes the thread's mode before any input", async () => {
  const offerless: Capabilities = {
    ...treeCapabilities,
    permissionModes: [],
    accessModes: [],
    permissions: { ...treeCapabilities.permissions!, modes: [], permissionModes: [] },
  };
  const h = await acpTree({
    capabilities: offerless,
    session: () => ({ effectiveCapabilities: treeCapabilities }),
    permissionSettings: async () => ({ access: "read-only" }),
  });
  try {
    const id = await h.create();
    expect(h.contexts.get(id)?.permissionMode).toBeUndefined();
    expect(h.events.slice(0, 2)).toEqual(["mode:plan", "send"]);
    expect(h.permission(id)?.effective).toBe("read-only");
  } finally {
    await h.close();
  }
});

test("an agent that switches its own mode shows it, and a child is brought back within its parent", async () => {
  const h = await acpTree();
  try {
    const parent = await h.create("read-only");
    const child = await h.create("read-only");
    h.adopt(parent, child);
    // Claude leaving plan mode on the parent: that is now what the thread runs.
    h.contexts.get(parent)?.onPermissionMode?.("default");
    await h.engine.flush();
    expect(h.permission(parent)).toMatchObject({ override: "ask", effective: "ask" });
    // The parent goes back to Read-only; its child then switching to Full access on its own
    // is brought back within it.
    h.command({ type: "thread.permission.set", threadId: parent, access: "read-only" });
    await expect.poll(() => h.modes(parent)).toEqual(["plan"]);
    await h.engine.flush();
    h.contexts.get(child)?.onPermissionMode?.("yolo");
    await expect.poll(() => h.modes(child)).toEqual(["plan"]);
    await h.engine.flush();
    expect(h.permission(child)?.effective).toBe("read-only");
  } finally {
    await h.close();
  }
});

test("a session that couldn't take its access mode records the mode it runs instead", async () => {
  const h = await acpTree({
    session: () => ({ refusedOptions: ["permissionMode"], permissionMode: "default" }),
    permissionSettings: async () => ({ access: "read-only" }),
  });
  try {
    const id = await h.create("read-only");
    expect(h.permission(id)).toMatchObject({ override: "ask", effective: "ask", pending: false });
    expect(h.notices(id, "access_mode_unavailable")).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("Read-only picked for a new Antigravity thread runs with Full access and says so", async () => {
  const h = await antigravity();
  try {
    const created = h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "antigravity",
      access: "read-only",
      input: [{ type: "text", text: "first" }],
    });
    if (!created.ok || !created.threadId) throw new Error(created.error);
    await h.engine.flush();
    expect(h.contexts.at(-1)?.permissionMode).toBe("yolo");
    // What runs replaces the pick, so it never reads as pending.
    expect(h.store.getThread(created.threadId)?.permission).toMatchObject({
      override: "full-access",
      effective: "full-access",
      pending: false,
    });
    const notices = Object.values(h.store.snapshotThread(created.threadId).items).filter(
      (item) => item.type === "notice" && item.code === "access_mode_unavailable",
    );
    expect(notices.map((notice) => notice.type === "notice" && notice.text)).toEqual([
      "This agent doesn't offer Read-only, so it runs with Full access.",
    ]);
  } finally {
    await h.close();
  }
});

test("an Antigravity session's reported models and levels refresh its catalog row", async () => {
  const h = await antigravity();
  try {
    const id = createFullAccess(h);
    await h.engine.flush();
    const context = await acpEngineOptions({
      registry: new AdapterRegistry(),
      agents: { has: () => false, resolve: unused, inventory: { list: () => [] } } as never,
      models: h.catalog,
      mcp: undefined as never,
      store: h.store,
      options: {},
      // An Antigravity session opens no probe folder.
      dataDir: "/nonexistent-ace-data",
      report: (error) => {
        throw error;
      },
    }).sessionContext?.(id, new AbortController().signal);
    context?.onSessionMetadata?.({
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "gemini-next",
          options: [{ value: "gemini-next", name: "Gemini Next" }],
        },
        {
          id: "thinking",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ],
    });
    await expect
      .poll(() =>
        h.catalog
          .list({ instance: "antigravity-cli-default" })
          .models.find((model) => model.id === "gemini-next")
          ?.efforts.map((effort) => effort.id),
      )
      .toEqual(["low", "high"]);
  } finally {
    await h.close();
  }
});

test("a saved model the agent no longer lists leaves the thread on the agent's default, and says so", async () => {
  const h = await acpTree({ session: () => ({ refusedOptions: ["model"] }) });
  try {
    const id = await h.create("ask", "retired-model");
    expect(h.contexts.get(id)?.model).toBe("retired-model");
    expect(h.store.getThread(id)?.execution?.model).toBeUndefined();
    expect(
      h.notices(id, "execution_option_refused").map((item) => item.type === "notice" && item.text),
    ).toEqual(["This agent didn't take model retired-model, so it runs at its default."]);
  } finally {
    await h.close();
  }
});
