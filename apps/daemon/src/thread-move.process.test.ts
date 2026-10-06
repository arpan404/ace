import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, DeviceId, ThreadId, WorkspaceId, type CommandPayload } from "@ace/protocol";
import { harness, scriptFrames, start, end, task, until } from "./engine/test-support.ts";
import { Client, token } from "./socket-test-support.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { startServer } from "./server.ts";
import { Store } from "./store.ts";
import { ProjectStorage } from "./project-storage.ts";

async function world(background = false) {
  const frames = scriptFrames();
  const h = await harness(
    [{ on: "send", frames: [frames.frame(start, ...(background ? [task] : []), end)] }],
    frames,
  );
  const runtime = new WorkspaceRuntime(h.store, h.home, h.clock.now, {
    changeWorkspace: (id, commandId, effect, reservation, commit) =>
      h.engine.changeWorkspace(id, commandId, effect, reservation, commit),
  });
  const server = await startServer({
    store: h.store,
    engine: h.engine,
    handler: h.engine.handler,
    workspaceActions: runtime,
    port: 0,
    token,
    hostId: "host",
    now: h.clock.now,
  });
  const clients: Client[] = [];
  async function connect(device = "device") {
    const client = new Client(server.url);
    clients.push(client);
    await once(client.socket, "open");
    client.send({ type: "hello", protocolVersion: 1, token, deviceId: DeviceId.parse(device) });
    await client.next();
    return client;
  }
  const targetPath = join(h.home, "destination");
  await mkdir(targetPath);
  const target = h.store.createWorkspace(targetPath, "Destination");
  const id = await h.create();
  const client = await connect();
  let sequence = 0;
  async function command(
    payload: CommandPayload,
    commandId = `command-${++sequence}`,
    sender = client,
    deviceId = "device",
  ) {
    sender.send({ type: "command", command: Command.parse({ id: commandId, deviceId, payload }) });
    return until(
      sender,
      (message) => message.type === "commandResult" && message.commandId === commandId,
    );
  }
  return {
    ...h,
    runtime,
    target,
    targetPath,
    id,
    client,
    connect,
    command,
    async close() {
      for (const c of clients) await c.close();
      await server.close();
      await runtime.close();
      await h.close();
    },
  };
}

test("moving a settled local thread updates every device and restarts in the destination with its history and pin", async () => {
  const f = await world();
  try {
    await f.command({ type: "thread.pin", threadId: f.id, pinned: true, order: 512.5 });
    f.store.appendEvents(f.id, [
      {
        type: "thread.client.updated",
        changes: {
          details: {
            mode: "local",
            worktree: f.home,
            branch: "old-branch",
            head: "a".repeat(40),
            linkedPr: { number: 1, state: "open" },
            diff: { files: 1, additions: 2, deletions: 0 },
          },
        },
      },
    ]);
    const original = f.store.snapshotThread(f.id);
    const phone = await f.connect("phone");
    phone.send({ type: "subscribe", subscriptionId: "sidebar", scope: { kind: "threads" } });
    await phone.next();
    const desktop = await f.connect("desktop");
    desktop.send({
      type: "subscribe",
      subscriptionId: "thread",
      scope: { kind: "thread", threadId: f.id },
    });
    await desktop.next();
    const payload = { type: "thread.move" as const, threadId: f.id, workspaceId: f.target };
    expect(await f.command(payload, "move")).toMatchObject({ ok: true, threadId: f.id });
    for (const reader of [phone, desktop]) {
      expect(
        await until(
          reader,
          (message) =>
            message.type === "events" &&
            message.events.some(
              (event) =>
                event.payload.type === "thread.updated" && event.payload.workspaceId === f.target,
            ),
        ),
      ).toMatchObject({
        events: expect.arrayContaining([
          expect.objectContaining({
            threadId: f.id,
            payload: expect.objectContaining({ workspaceId: f.target }),
          }),
        ]),
      });
    }
    expect(f.store.getThread(f.id)).toMatchObject({
      workspaceId: f.target,
      pinned: true,
      pinOrder: 512.5,
      details: {
        mode: "local",
        worktree: f.targetPath,
        workspace: { id: f.target, name: "Destination" },
      },
    });
    expect(f.store.getThread(f.id)?.details?.branch).toBeUndefined();
    expect(f.store.getThread(f.id)?.details?.linkedPr).toBeUndefined();
    expect(f.store.snapshotThread(f.id)?.items).toEqual(original?.items);
    const head = f.store.headSeq();
    expect(await f.command(payload, "move")).toMatchObject({ ok: true });
    expect(f.store.headSeq()).toBe(head);
    expect(await f.command(payload, "move", phone, "phone")).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    const reopened = new Store(f.path);
    try {
      expect(reopened.getThread(f.id)).toMatchObject({
        workspaceId: f.target,
        pinned: true,
        pinOrder: 512.5,
      });
      expect(reopened.executionWorkspace(f.id)).toMatchObject({ path: f.targetPath, ready: true });
      expect(reopened.snapshotThread(f.id)?.items).toEqual(original?.items);
      expect(
        reopened.commandReceipt(Command.shape.id.parse("move"), DeviceId.parse("device")),
      ).toMatchObject({ ok: true });
    } finally {
      await reopened.close();
    }
    expect(
      await f.command({
        type: "thread.send",
        threadId: f.id,
        input: [{ type: "text", text: "Continue here" }],
      }),
    ).toMatchObject({ ok: true });
    await f.engine.flush();
    expect(f.contexts.at(-1)).toMatchObject({ cwd: f.targetPath });
    expect(f.contexts.at(-1)?.resume).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("a live background shell refuses a move after its foreground turn ends", async () => {
  const f = await world(true);
  try {
    expect(
      await f.command({ type: "thread.move", threadId: f.id, workspaceId: f.target }),
    ).toMatchObject({ ok: false, error: "thread_busy" });
    expect(f.store.getThread(f.id)?.workspaceId).toBe(f.workspace);
    expect(f.store.executionWorkspace(f.id).path).toBe(f.home);
  } finally {
    await f.close();
  }
});

test("missing and removed destinations and isolated bindings refuse a move without changing history", async () => {
  const f = await world();
  try {
    const before = f.store.snapshotThread(f.id);
    const move = (workspaceId: WorkspaceId) =>
      f.command({ type: "thread.move", threadId: f.id, workspaceId });
    expect(await move(WorkspaceId.parse("missing"))).toMatchObject({
      ok: false,
      error: "workspace_not_found",
    });
    const projects = new ProjectStorage(f.store, f.clock.now);
    projects.remove(f.target, false, () => false);
    expect(await move(f.target)).toMatchObject({ ok: false, error: "workspace_not_found" });
    projects.register(f.targetPath, "Destination");
    await f.engine.changeWorkspace(f.id, "isolate", async () => ({
      mode: "worktree",
      worktree: f.targetPath,
      branch: "isolated",
    }));
    expect(await move(f.target)).toMatchObject({
      ok: false,
      error: "thread_move_requires_local_workspace",
    });
    expect(f.store.getThread(f.id)?.workspaceId).toBe(f.workspace);
    expect(f.store.snapshotThread(f.id)?.items).toEqual(before?.items);
    expect(
      await f.command({
        type: "thread.move",
        threadId: ThreadId.parse("missing"),
        workspaceId: f.target,
      }),
    ).toMatchObject({ ok: false });
  } finally {
    await f.close();
  }
});

test("owned terminals block moving even after exit until their owner closes them", async () => {
  const f = await world();
  try {
    f.client.send({
      type: "terminal.request",
      requestId: "open",
      operation: { op: "open", threadId: f.id, name: "Shell", cols: 80, rows: 24 },
    });
    const opened = await f.client.next();
    if (opened.type !== "terminal.result" || !opened.terminal) throw new Error("Terminal missing");
    const terminalId = opened.terminal.id;
    const payload = { type: "thread.move" as const, threadId: f.id, workspaceId: f.target };
    expect(await f.command(payload)).toMatchObject({ ok: false, error: "thread_busy" });
    const stream = f.runtime.terminal(terminalId, f.id).attach({ fromOffset: 0 });
    f.client.send({
      type: "terminal.request",
      requestId: "exit",
      operation: { op: "write", threadId: f.id, terminalId, data: "exit 0\r" },
    });
    await f.client.next();
    try {
      for await (const event of stream) if (event.type === "exit") break;
    } finally {
      stream.detach();
    }
    expect(await f.command(payload)).toMatchObject({ ok: false, error: "thread_busy" });
    f.client.send({
      type: "terminal.request",
      requestId: "close",
      operation: { op: "close", threadId: f.id, terminalId },
    });
    await f.client.next();
    expect(await f.command(payload)).toMatchObject({ ok: true });
  } finally {
    await f.close();
  }
});
