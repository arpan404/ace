import { backup } from "node:sqlite";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { Engine, Store } from "@ace/daemon";
import { startServer } from "../server.ts";
import { token } from "../socket-test-support.ts";
import { syntheticProvider } from "../testing/long-thread-provider.ts";
import { harness, scriptFrames, start, question } from "./test-support.ts";

test("a SIGKILLed provider expires its approval, reports its stop and permits plain deletion", async () => {
  const provider = syntheticProvider();
  const h = await harness([], scriptFrames(), { nativeAdapter: provider.adapter });
  try {
    const id = await h.create();
    await provider.frame({ kind: "pending_approvals", first: 0, count: 1 });
    expect(h.store.getThread(id)?.status.state).toBe("needs_you");
    await provider.kill();
    await h.engine.flush();
    const view = h.store.snapshotThread(id);
    expect(view.thread.status.state).toBe("failed");
    expect(Object.values(view.interactions)).toEqual([
      expect.objectContaining({ state: "expired" }),
    ]);
    expect(Object.values(view.items)).toContainEqual(
      expect.objectContaining({
        type: "notice",
        text: "The agent stopped unexpectedly",
      }),
    );
    const client = await h.connect("device");
    client.send({
      type: "command",
      command: Command.parse({
        id: "delete-killed",
        deviceId: "device",
        payload: { type: "thread.delete", threadId: id },
      }),
    });
    expect(await client.next()).toMatchObject({ ok: true });
    expect(h.store.getThread(id)?.deletedAt).toBeDefined();
  } finally {
    await h.close();
  }
});

test("plain deletion reports the live agent and force deletion kills its process and cancels approval", async () => {
  const provider = syntheticProvider();
  const h = await harness([], scriptFrames(), { nativeAdapter: provider.adapter });
  try {
    const id = await h.create();
    await provider.frame({ kind: "pending_approvals", first: 0, count: 1 });
    const client = await h.connect("device");
    const remove = (commandId: string, force?: boolean) => {
      client.send({
        type: "command",
        command: Command.parse({
          id: commandId,
          deviceId: "device",
          payload: { type: "thread.delete", threadId: id, force },
        }),
      });
      return client.next();
    };
    expect(await remove("plain-live")).toMatchObject({
      ok: false,
      error: "thread_busy",
      alive: { agentsRunning: 1, terminalsOpen: 0 },
    });
    const pid = provider.pid;
    if (!pid) throw new Error("Missing fake provider PID");
    const receipt = await remove("force-live", true);
    expect(receipt).toMatchObject({ ok: true, threadId: id });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(h.store.getThread(id)?.deletedAt).toBeDefined();
    expect(
      Object.values(h.store.snapshotThread(id).interactions).every(
        (interaction) => interaction.state !== "pending",
      ),
    ).toBe(true);
    const head = h.store.headSeq();
    expect(await remove("force-live", true)).toEqual(receipt);
    expect(h.store.headSeq()).toBe(head);
  } finally {
    await h.close();
  }
});

test("restart stops a thread that needed a person, says so, holds its queued message and permits deletion", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, question)] }], frames);
  let store: Store | undefined;
  let engine: Engine | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const id = await h.create();
    h.command({
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text: "held follow-up" }],
      delivery: "queue",
    });
    await h.engine.flush();
    expect(h.store.getThread(id)?.status.state).toBe("needs_you");
    const path = join(h.home, "restart.sqlite");
    await backup(
      h.store.atomic((db) => db),
      path,
    );
    store = new Store(path);
    engine = new Engine(store, { registry: h.registry, clock: h.clock });
    await engine.flush();
    // Nothing asks for the person any more; the held message waits for an explicit resume.
    expect(store.getThread(id)?.status).toEqual({ state: "waiting", on: "queue" });
    expect(Object.values(store.snapshotThread(id).interactions)).toEqual([
      expect.objectContaining({ state: "expired" }),
    ]);
    expect(engine.queue(id)).toMatchObject({ paused: true });
    expect(engine.queue(id).messages).toHaveLength(1);
    expect(h.contexts).toHaveLength(1);
    expect(Object.values(store.snapshotThread(id).items)).toContainEqual(
      expect.objectContaining({ type: "notice", code: "agent_stopped" }),
    );
    server = await startServer({
      store,
      engine,
      handler: engine.handler,
      token,
      hostId: "restart",
      port: 0,
    });
    const { Client } = await import("../socket-test-support.ts");
    const { once } = await import("node:events");
    const client = new Client(server.url);
    try {
      await once(client.socket, "open");
      client.send({
        type: "hello",
        protocolVersion: 1,
        token,
        deviceId: Command.parse({
          id: "hello",
          deviceId: "device",
          payload: { type: "thread.delete", threadId: id },
        }).deviceId,
      });
      await client.next();
      client.send({
        type: "command",
        command: Command.parse({
          id: "delete-restart",
          deviceId: "device",
          payload: { type: "thread.delete", threadId: id },
        }),
      });
      expect(await client.next()).toMatchObject({ ok: true });
      expect(engine.queue(id).messages).toHaveLength(0);
    } finally {
      await client.close();
    }
  } finally {
    await server?.close();
    await engine?.close();
    await store?.close();
    await h.close();
  }
});

test("a restart during force deletion finishes cleanup and retains the successful receipt", async () => {
  const closing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const provider = syntheticProvider();
  const nativeAdapter = {
    ...provider.adapter,
    async openSession(ctx: Parameters<typeof provider.adapter.openSession>[0]) {
      const session = await provider.adapter.openSession(ctx);
      return {
        ...session,
        async close(reason: Parameters<typeof session.close>[0]) {
          closing.resolve();
          await release.promise;
          await session.close(reason);
        },
      };
    },
  };
  const h = await harness([], scriptFrames(), { nativeAdapter });
  let store: Store | undefined;
  let engine: Engine | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const id = await h.create();
    const client = await h.connect("device");
    const command = Command.parse({
      id: "durable-force",
      deviceId: "device",
      payload: { type: "thread.delete", threadId: id, force: true },
    });
    client.send({ type: "command", command });
    await closing.promise;
    expect(h.store.getThread(id)?.deletedAt).toBeUndefined();
    expect(
      h.command({
        type: "thread.send",
        threadId: id,
        input: [{ type: "text", text: "must not launch" }],
      }).error,
    ).toBe("thread_deleting");
    const path = join(h.home, "mid-delete.sqlite");
    await backup(
      h.store.atomic((db) => db),
      path,
    );
    store = new Store(path);
    engine = new Engine(store, { registry: h.registry, clock: h.clock });
    await engine.ready();
    server = await startServer({
      store,
      engine,
      handler: engine.handler,
      token,
      hostId: "restart",
      port: 0,
    });
    expect(store.getThread(id)?.deletedAt).toBeDefined();
    expect(store.commandReceipt(command.id, command.deviceId)).toMatchObject({
      ok: true,
      threadId: id,
    });
    expect(engine.queue(id).messages).toHaveLength(0);
    expect(h.contexts).toHaveLength(1);
    release.resolve();
    expect(await client.next()).toMatchObject({ ok: true });
  } finally {
    release.resolve();
    await server?.close();
    await engine?.close();
    await store?.close();
    await h.close();
  }
});

test("bulk deletion treats live and stopped threads independently", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, question)] }], frames);
  try {
    const stale = await h.create();
    const context = h.contexts[0];
    if (!context) throw new Error("Missing provider boundary");
    context.onExit({ deliberate: false });
    await h.engine.flush();
    const live = ThreadId.parse("live-bulk");
    expect(
      h.command({
        type: "thread.create",
        threadId: live,
        workspaceId: h.workspace,
        provider: "codex",
        input: [{ type: "text", text: "live" }],
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    const client = await h.connect("device");
    for (const threadId of [stale, live]) {
      client.send({
        type: "command",
        command: Command.parse({
          id: `bulk:${threadId}`,
          deviceId: "device",
          payload: { type: "thread.delete", threadId },
        }),
      });
    }
    const results = [await client.next(), await client.next()];
    expect(results).toContainEqual(
      expect.objectContaining({ commandId: `bulk:${stale}`, ok: true }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        commandId: `bulk:${live}`,
        error: "thread_busy",
        alive: expect.objectContaining({ agentsRunning: 1 }),
      }),
    );
    expect(h.store.getThread(ThreadId.parse(stale))?.deletedAt).toBeDefined();
    expect(h.store.getThread(ThreadId.parse(live))?.deletedAt).toBeUndefined();
  } finally {
    await h.close();
  }
});
