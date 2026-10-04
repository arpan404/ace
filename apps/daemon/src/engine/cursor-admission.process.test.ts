import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { cursorCapabilities } from "@ace/adapter-cursor";
import { Command, ThreadId, type CommandPayload } from "@ace/protocol";
import { Store, Engine, AdapterRegistry } from "@ace/daemon";
import { realpath } from "node:fs/promises";
import { scriptFrames, start, end } from "./test-support.ts";
import { startServer } from "../server.ts";
import { token } from "../socket-test-support.ts";
import { connect, command as socketCommand } from "../thread-creation-test-support.ts";

it.each([
  ["thread.create", "ask"],
  ["thread.create", "auto-review"],
  ["thread.prepare", "ask"],
  ["thread.prepare", "auto-review"],
] as const)(
  "%s admits Cursor's Limited %s mode through socket admission and preserves input",
  async (type, mode) => {
    const home = await mkdtemp(join(tmpdir(), "cursor-limited-admission-"));
    const store = new Store(join(home, "state.sqlite"));
    const workspaceId = store.createWorkspace(home, "Workspace");
    const frames = scriptFrames();
    const adapter = createScriptedAdapter({
      provider: "cursor",
      capabilities: cursorCapabilities,
      steps: [{ on: "send", frames: [frames.frame(start, end)] }],
      createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
    });
    const registry = new AdapterRegistry();
    let effective: import("@ace/protocol").PermissionMode | undefined;
    registry.register(
      {
        ...adapter,
        backend: "cursor-sdk",
        async openSession(context) {
          effective = context.permissionMode;
          return adapter.openSession(context);
        },
      },
      { installed: true, auth: "logged_in", loginHint: "Synthetic boundary" },
    );
    const engine = new Engine(store, { registry, selectInstance: () => "private-sdk" });
    await engine.ready();
    const server = await startServer({
      store,
      engine,
      handler: engine.handler,
      port: 0,
      hostId: "host",
      token,
    });
    const client = await connect(server.url);
    const threadId = ThreadId.parse("limited-thread");
    const input = [{ type: "text" as const, text: "Preserve this first message" }];
    try {
      const selection = {
        threadId,
        workspaceId,
        provider: "cursor" as const,
        permissionMode: mode,
      };
      expect(
        await socketCommand(
          client,
          "create",
          type === "thread.create"
            ? { type, ...selection, input }
            : { type, ...selection, title: "Limited prepared thread" },
        ),
      ).toMatchObject({ ok: true, threadId });
      if (type === "thread.prepare")
        expect(
          await socketCommand(client, "first-input", {
            type: "thread.send",
            threadId,
            input,
            delivery: "queue",
          }),
        ).toMatchObject({ ok: true });
      await engine.flush();
      expect(effective).toBe(mode);
      expect(adapter.commands.filter((entry) => entry.type === "send")).toEqual([
        { type: "send", input, delivery: "queue" },
      ]);
      expect(engine.sessionMetadata(threadId)).toMatchObject({
        backend: "cursor-sdk",
        instanceId: "private-sdk",
      });
      expect(store.getThread(threadId)).toMatchObject({
        status: { state: "done" },
        capabilities: {
          permissions: {
            nativeAutoReview: false,
            guarantees: [{ mode: "auto-review", level: "tool-selection" }],
          },
        },
      });
    } finally {
      await client.close();
      await server.close();
      await engine.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

it("rejects oversized SDK input before creating a thread and fences the durable input backlog", async () => {
  const home = await mkdtemp(join(tmpdir(), "cursor-admission-"));
  const store = new Store(join(home, "state.sqlite"));
  const workspace = store.createWorkspace(home, "Workspace");
  const adapter = createScriptedAdapter({
    provider: "cursor",
    capabilities: cursorCapabilities,
    steps: [],
    createTranslator: () => ({ translate: () => [], tick: () => [] }),
  });
  const registry = new AdapterRegistry();
  registry.register(
    { ...adapter, backend: "cursor-sdk" },
    { installed: false, auth: "unknown", loginHint: "unused" },
  );
  const engine = new Engine(store, {
    registry,
    threadId: () => "bounded-sdk-thread",
    limits: { maxInputBytes: 256, maxPendingInputs: 2 },
  });
  let sequence = 0;
  const command = (payload: CommandPayload) =>
    engine.handler.handle(
      Command.parse({ id: `input-${++sequence}`, deviceId: "device", payload }),
      store,
    );
  try {
    expect(
      command({
        type: "thread.create",
        provider: "cursor",
        workspaceId: workspace,
        input: [{ type: "text", text: "x".repeat(512) }],
      }),
    ).toMatchObject({ ok: false, error: "provider_input_budget_exceeded" });
    expect(store.listThreads()).toEqual([]);
    expect(
      command({
        type: "thread.create",
        provider: "cursor",
        workspaceId: workspace,
        input: [{ type: "text", text: "first" }],
      }),
    ).toMatchObject({ ok: true });
    const send = {
      type: "thread.send",
      delivery: "queue",
      threadId: ThreadId.parse("bounded-sdk-thread"),
      input: [{ type: "text", text: "queued" }],
    } satisfies CommandPayload;
    expect(command(send)).toMatchObject({ ok: true });
    expect(command(send)).toMatchObject({ ok: false, error: "provider_input_queue_full" });
    expect(command({ ...send, input: [{ type: "text", text: "x".repeat(512) }] })).toMatchObject({
      ok: false,
      error: "provider_input_budget_exceeded",
    });
  } finally {
    await engine.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("pins SDK account and backend before worktree preparation and checkpoints before delivering input", async () => {
  const home = await mkdtemp(join(tmpdir(), "cursor-worktree-admission-"));
  const worktree = join(home, "prepared");
  await mkdir(worktree);
  const preparedPath = await realpath(worktree);
  const store = new Store(join(home, "state.sqlite"));
  const workspaceId = store.createWorkspace(home, "Project");
  const frames = scriptFrames();
  const adapter = createScriptedAdapter({
    provider: "cursor",
    nativeSessionId: "sdk-agent",
    capabilities: cursorCapabilities,
    createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
    steps: [{ on: "send", frames: [frames.frame(start, end)] }],
  });
  const preparing = Promise.withResolvers<void>();
  const prepared = Promise.withResolvers<string>();
  const checkpointing = Promise.withResolvers<void>();
  const checkpointed = Promise.withResolvers<void>();
  const registry = new AdapterRegistry();
  let hostCwd: string | undefined;
  let permissionMode: import("@ace/engine-api").SessionContext["permissionMode"];
  registry.register(
    {
      ...adapter,
      backend: "cursor-sdk",
      async openSession(context) {
        hostCwd = context.cwd;
        permissionMode = context.permissionMode;
        return adapter.openSession(context);
      },
    },
    { installed: true, auth: "logged_in", loginHint: "Offline boundary" },
  );
  const threadId = ThreadId.parse("worktree-sdk-thread");
  const engine = new Engine(store, {
    registry,
    selectInstance: () => "pinned-sdk-account",
    prepareWorkspace: async () => {
      preparing.resolve();
      return prepared.promise;
    },
    beforeSend: async () => {
      checkpointing.resolve();
      await checkpointed.promise;
    },
    machine: { host: "daemon", name: "Local daemon" },
  });
  try {
    expect(
      engine.handler.handle(
        Command.parse({
          id: "worktree-input",
          deviceId: "remote-client",
          payload: {
            type: "thread.create",
            threadId,
            workspaceId,
            provider: "cursor",
            mode: "worktree",
            model: "composer-2.5",
            permissionMode: "auto-review",
            input: [{ type: "text", text: "offline" }],
          },
        }),
        store,
      ),
    ).toMatchObject({ ok: true });
    await preparing.promise;
    expect(adapter.sessions).toHaveLength(0);
    expect(engine.sessionMetadata(threadId)).toMatchObject({
      backend: "cursor-sdk",
      instanceId: "pinned-sdk-account",
      workspaceReady: false,
    });
    const pendingAccount = store.getThread(threadId)?.live?.account;
    prepared.resolve(preparedPath);
    await checkpointing.promise;
    expect(hostCwd).toBe(preparedPath);
    expect(permissionMode).toBe("auto-review");
    expect(adapter.commands).toEqual([]);
    checkpointed.resolve();
    await engine.flush();
    expect(pendingAccount).toBe("pinned-sdk-account");
    expect(adapter.commands.filter((command) => command.type === "send")).toEqual([
      { type: "send", input: [{ type: "text", text: "offline" }], delivery: "queue" },
    ]);
    expect(engine.sessionMetadata(threadId)).toMatchObject({
      backend: "cursor-sdk",
      nativeSessionId: "sdk-agent",
      instanceId: "pinned-sdk-account",
      cwd: preparedPath,
      workspaceReady: true,
    });
    expect(store.getThread(threadId)).toMatchObject({
      backend: "cursor-sdk",
      status: { state: "done" },
      details: { mode: "worktree", machine: { host: "daemon", name: "Local daemon" } },
      live: { account: "pinned-sdk-account" },
    });
    expect(Object.values(store.snapshotThread(threadId).runs)).toMatchObject([{ ordinal: 1 }]);
  } finally {
    prepared.resolve(preparedPath);
    checkpointed.resolve();
    await engine.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
