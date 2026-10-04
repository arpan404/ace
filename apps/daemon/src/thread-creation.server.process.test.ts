import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, DeviceId, ThreadId, type CommandPayload } from "@ace/protocol";
import { transitionHarness } from "./engine/transition-test-support.ts";
import { startServer } from "./server.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { Client, token } from "./socket-test-support.ts";
import { until } from "./projects-test-support.ts";

const git = promisify(execFile);
async function repository(home: string) {
  await git("git", ["init", "-b", "main", home]);
  await writeFile(join(home, "file.txt"), "Synthetic\n");
  await git("git", ["-C", home, "add", "file.txt"]);
  await git("git", [
    "-C",
    home,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@ace.local",
    "commit",
    "-m",
    "Initial",
  ]);
}
async function connect(url: string) {
  const client = new Client(url);
  await once(client.socket, "open");
  client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("device"), token });
  expect(await client.next()).toMatchObject({ type: "welcome" });
  return client;
}
async function command(client: Client, id: string, payload: CommandPayload) {
  client.send({ type: "command", command: Command.parse({ id, deviceId: "device", payload }) });
  return until(client, (message) => message.type === "commandResult" && message.commandId === id);
}
async function queue(client: Client, threadId: ThreadId) {
  client.send({ type: "queue.get", requestId: "queue", threadId });
  const result = await until(client, (message) => message.type === "queue.result");
  if (result.type !== "queue.result") throw new Error("Expected queue");
  return result.queue;
}

test("worktree creation refuses an unusable repository before accepting the first message and the same draft can be retried", async () => {
  const h = transitionHarness();
  await h.engine.ready();
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "data"), () => 1000);
  const server = await startServer({
    store: h.store,
    engine: h.engine,
    handler: h.engine.handler,
    workspaceActions: runtime,
    port: 0,
    hostId: "host",
    token,
  });
  const client = await connect(server.url);
  const threadId = ThreadId.parse("first");
  const input = [{ type: "text" as const, text: "Do not lose this draft" }];
  try {
    const payload = {
      type: "thread.create" as const,
      threadId,
      provider: "codex" as const,
      workspaceId: h.workspace,
      mode: "worktree" as const,
      input,
    };
    expect(await command(client, "create", payload)).toMatchObject({
      ok: false,
      error: "workspace_unavailable",
    });
    client.send({ type: "subscribe", subscriptionId: "empty", scope: { kind: "threads" } });
    expect(await until(client, (message) => message.type === "snapshot")).toMatchObject({
      view: { threads: {} },
    });
    await repository(h.home);
    expect(await command(client, "create", payload)).toMatchObject({ ok: true, threadId });
    await h.engine.flush();
    expect(h.inputs.map((entry) => entry.text)).toEqual(["Do not lose this draft"]);
    expect(h.sessions[0]?.context.cwd).not.toBe(h.home);
    expect(await command(client, "create", payload)).toMatchObject({ ok: true, threadId });
    await h.engine.flush();
    expect(h.inputs).toHaveLength(1);
  } finally {
    await client.close();
    await server.close();
    await runtime.close();
    await h.close();
  }
});

test("an accepted first message survives late preparation failure and restart and can be edited and delivered", async () => {
  let runtime: WorkspaceRuntime | undefined;
  let fail = true;
  const h = transitionHarness({
    prepareWorkspace: async (id) => {
      if (fail) throw new Error("Workspace temporarily unavailable");
      if (!runtime) throw new Error("Missing runtime");
      return runtime.prepare(id);
    },
  });
  await h.engine.ready();
  // Prepared threads and internally admitted creates can only finish physical preparation later.
  const server = await startServer({
    store: h.store,
    get engine() {
      return h.engine;
    },
    get handler() {
      return h.engine.handler;
    },
    port: 0,
    hostId: "host",
    token,
  });
  let client = await connect(server.url);
  const threadId = ThreadId.parse("late");
  try {
    expect(
      await command(client, "create", {
        type: "thread.create",
        threadId,
        workspaceId: h.workspace,
        provider: "codex",
        mode: "worktree",
        input: [{ type: "text", text: "Original first message" }],
      }),
    ).toMatchObject({ ok: true, threadId });
    await h.engine.flush();
    expect(await queue(client, threadId)).toMatchObject({
      paused: true,
      messages: [
        {
          id: "create",
          state: "queued",
          input: [{ type: "text", text: "Original first message" }],
        },
      ],
    });
    client.send({
      type: "subscribe",
      subscriptionId: "recoverable",
      scope: { kind: "thread", threadId },
    });
    expect(await until(client, (message) => message.type === "snapshot")).toMatchObject({
      view: { thread: { status: { state: "waiting", on: "queue" } } },
    });
    await client.close();
    await h.restart();
    client = await connect(server.url);
    const held = await queue(client, threadId);
    expect(held.messages[0]?.input).toEqual([{ type: "text", text: "Original first message" }]);
    expect(
      await command(client, "edit", {
        type: "queue.edit",
        threadId,
        messageId: Command.shape.id.parse("create"),
        expectedRevision: held.revision,
        input: [{ type: "text", text: "Edited first message" }],
      }),
    ).toMatchObject({ ok: true });
    // Give late preparation a usable repository without launching a real provider CLI.
    await repository(h.home);
    runtime = new WorkspaceRuntime(h.store, join(h.home, "data"), () => 1000);
    fail = false;
    expect(
      await command(client, "resume", {
        type: "queue.resume",
        threadId,
        expectedRevision: (await queue(client, threadId)).revision,
      }),
    ).toMatchObject({ ok: true });
    await h.engine.flush();
    expect(h.inputs.map((entry) => entry.text)).toEqual(["Edited first message"]);
    expect((await queue(client, threadId)).messages).toEqual([]);
  } finally {
    await client.close();
    await server.close();
    await runtime?.close();
    await h.close();
  }
});
