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
  registry.register(
    {
      ...adapter,
      backend: "cursor-sdk",
      async openSession(context) {
        hostCwd = context.cwd;
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
            options: { sandbox: "restricted" },
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
      options: { sandbox: "restricted" },
    });
    const pendingAccount = store.getThread(threadId)?.live?.account;
    prepared.resolve(preparedPath);
    await checkpointing.promise;
    expect(hostCwd).toBe(preparedPath);
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
