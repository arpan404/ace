import { git, repository, connect, command, queue } from "./thread-creation-test-support.ts";
import { DeliveryNotStarted } from "./engine/delivery.ts";
import { GitError } from "@ace/git";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { transitionHarness } from "./engine/transition-test-support.ts";
import { startServer } from "./server.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { token } from "./socket-test-support.ts";
import { until } from "./projects-test-support.ts";

test("worktree creation refuses an unusable repository before accepting the first message and the same draft can be retried", async () => {
  const h = transitionHarness({
    prepareWorkspace: async () => {
      throw new Error("Accepted prepared root must be ready");
    },
  });
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
      trigger: "schedule" as const,
      origin: { kind: "automation" as const },
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
    expect(
      h.store
        .readItems(threadId, h.store.headSeq() + 1, 20)
        .items.filter((item) => item.type === "message" && item.role === "user"),
    ).toEqual([
      expect.objectContaining({
        origin: { kind: "person", commandId: "create" },
        parts: input,
      }),
    ]);
    const created = h.store.getThread(threadId);
    const cwd = h.sessions[0]?.context.cwd;
    expect(cwd).toBe(created?.details?.worktree);
    expect(cwd).not.toBe(await realpath(h.home));
    expect((await runtime.git.listWorktrees(h.home)).slice(1)).toEqual([
      expect.objectContaining({ path: cwd, branch: created?.details?.branch }),
    ]);
    expect(cwd).toBe(await realpath(runtime.root(threadId)));
    if (!cwd) throw new Error("Missing provider root");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("Synthetic\n");
    expect((await git("git", ["-C", cwd, "rev-parse", "--show-toplevel"])).stdout.trim()).toBe(cwd);
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

test("a prepared workspace retains its first draft while admission is quarantined and delivers it after recovery", async () => {
  let quarantined = true;
  const h = transitionHarness({
    prepareWorkspace: async () => {
      throw new Error("Prepared workspace must not be prepared again");
    },
    assertWorkspaceAvailable: async () => {
      if (quarantined) throw new GitError("git_quarantined", "Cleanup is unconfirmed");
    },
  });
  const server = await startServer({
    store: h.store,
    engine: h.engine,
    handler: h.engine.handler,
    port: 0,
    hostId: "host",
    token,
  });
  const client = await connect(server.url);
  const threadId = ThreadId.parse("quarantined");
  const input = [{ type: "text" as const, text: "Keep this prepared draft" }];
  try {
    expect(
      await command(client, "create", {
        type: "thread.create",
        threadId,
        workspaceId: h.workspace,
        provider: "codex",
        input,
      }),
    ).toMatchObject({ ok: true, threadId });
    await h.engine.flush();
    expect(h.inputs).toEqual([]);
    expect(await queue(client, threadId)).toMatchObject({
      paused: true,
      messages: [{ id: "create", state: "queued", input }],
    });
    quarantined = false;
    expect(
      await command(client, "resume", {
        type: "queue.resume",
        threadId,
        expectedRevision: (await queue(client, threadId)).revision,
      }),
    ).toMatchObject({ ok: true });
    await h.engine.flush();
    expect(h.inputs.map((entry) => entry.text)).toEqual(["Keep this prepared draft"]);
    expect((await queue(client, threadId)).messages).toEqual([]);
  } finally {
    await client.close();
    await server.close();
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
  const serve = () =>
    startServer({
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
  let server = await serve();
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
    const beforeReopen = await queue(client, threadId);
    expect(
      await command(client, "edit-before-reopen", {
        type: "queue.edit",
        threadId,
        messageId: Command.shape.id.parse("create"),
        expectedRevision: beforeReopen.revision,
        input: [{ type: "text", text: "First message edited before restart" }],
      }),
    ).toMatchObject({ ok: true });
    await client.close();
    await server.close();
    await h.reopen();
    server = await serve();
    client = await connect(server.url);
    const held = await queue(client, threadId);
    expect(held.messages[0]?.input).toEqual([
      { type: "text", text: "First message edited before restart" },
    ]);
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

test("acknowledged input never becomes resendable after a transport failure or database reopen", async () => {
  const h = transitionHarness();
  const original = h.registry.get("codex");
  h.registry.register(
    {
      ...original.adapter,
      async openSession(context) {
        const session = await original.adapter.openSession(context);
        return {
          ...session,
          async send(...args: Parameters<typeof session.send>) {
            await session.send(...args);
            throw new DeliveryNotStarted("Reply lost after consumption");
          },
        };
      },
    },
    original.discovery,
  );
  const serve = () =>
    startServer({
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
  let server = await serve(),
    client = await connect(server.url);
  const id = ThreadId.parse("acknowledged");
  try {
    expect(
      await command(client, "ack", {
        type: "thread.create",
        threadId: id,
        workspaceId: h.workspace,
        provider: "codex",
        input: [{ type: "text", text: "Consumed once" }],
      }),
    ).toMatchObject({ ok: true });
    await h.engine.flush();
    expect((await queue(client, id)).messages).toEqual([]);
    await client.close();
    await server.close();
    await h.reopen();
    server = await serve();
    client = await connect(server.url);
    expect((await queue(client, id)).messages).toEqual([]);
    expect(
      await command(client, "following", {
        type: "thread.send",
        threadId: id,
        input: [{ type: "text", text: "Following input" }],
      }),
    ).toMatchObject({ ok: true });
    await h.engine.flush();
    expect(h.inputs.map((entry) => entry.text)).toEqual(["Consumed once", "Following input"]);
    expect((await queue(client, id)).messages).toEqual([]);
  } finally {
    await client.close();
    await server.close();
    await h.close();
  }
});
