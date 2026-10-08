import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
import { GitService } from "@ace/git";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { transitionHarness } from "./engine/transition-test-support.ts";
import { startServer } from "./server.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { token } from "./socket-test-support.ts";
import { until } from "./projects-test-support.ts";
import { git, repository, connect, command } from "./thread-creation-test-support.ts";

class GatedGit extends GitService {
  entered = Promise.withResolvers<void>();
  proceed = Promise.withResolvers<void>();
  cleaned = Promise.withResolvers<void>();
  override async createWorktree(options: Parameters<GitService["createWorktree"]>[0]) {
    const tree = await super.createWorktree(options);
    this.entered.resolve();
    await this.proceed.promise;
    return tree;
  }
  override async deleteBranch(options: Parameters<GitService["deleteBranch"]>[0]) {
    await super.deleteBranch(options);
    this.cleaned.resolve();
  }
}

test("two sockets cannot borrow another repository's in-flight worktree and preparation holds engine capacity", async () => {
  const h = transitionHarness({ maxActiveThreads: 1 });
  const gitService = new GatedGit();
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "data"), () => 1000, { gitService });
  const secondRepo = join(h.home, "other");
  await mkdir(secondRepo);
  await repository(h.home);
  await repository(secondRepo);
  await writeFile(join(secondRepo, "file.txt"), "Other repository\n");
  await git("git", ["-C", secondRepo, "add", "file.txt"]);
  await git("git", [
    "-C",
    secondRepo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@ace.local",
    "commit",
    "-m",
    "Other",
  ]);
  const other = h.store.createWorkspace(secondRepo, "Other");
  const server = await startServer({
    store: h.store,
    get engine() {
      return h.engine;
    },
    get handler() {
      return h.engine.handler;
    },
    workspaceActions: runtime,
    port: 0,
    hostId: "host",
    token,
  });
  const a = await connect(server.url),
    b = await connect(server.url);
  const id = ThreadId.parse("shared");
  const payload = {
    type: "thread.create" as const,
    threadId: id,
    provider: "codex" as const,
    workspaceId: h.workspace,
    mode: "worktree" as const,
    input: [{ type: "text" as const, text: "A" }],
  };
  try {
    const first = command(a, "a", payload);
    await gitService.entered.promise;
    expect(await command(b, "b", { ...payload, workspaceId: other })).toMatchObject({
      ok: false,
      error: "thread_creation_in_progress",
    });
    expect(
      await command(b, "capacity", {
        ...payload,
        threadId: ThreadId.parse("capacity"),
        workspaceId: other,
      }),
    ).toMatchObject({ ok: false, error: "engine_capacity_exceeded" });
    expect(await gitService.listWorktrees(secondRepo)).toHaveLength(1);
    gitService.proceed.resolve();
    expect(await first).toMatchObject({ ok: true, threadId: id });
    await h.engine.flush();
    const cwd = h.sessions[0]?.context.cwd;
    if (!cwd) throw new Error("No session root");
    expect(cwd).toBe(runtime.root(id));
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("Synthetic\n");
    expect(h.store.getThread(id)?.workspaceId).toBe(h.workspace);
    await h.restart();
    expect(
      await command(b, "b-retry", {
        ...payload,
        threadId: ThreadId.parse("other"),
        workspaceId: other,
      }),
    ).toMatchObject({ ok: true });
    await h.engine.flush();
    const secondCwd = h.sessions.at(-1)?.context.cwd;
    if (!secondCwd) throw new Error("No second root");
    expect(await readFile(join(secondCwd, "file.txt"), "utf8")).toBe("Other repository\n");
  } finally {
    gitService.proceed.resolve();
    await a.close();
    await b.close();
    await server.close();
    await runtime.close();
    await h.close();
  }
});

test("invalid worktree creates leave no Git branches or worktrees and a corrected draft is accepted", async () => {
  const h = transitionHarness();
  await repository(h.home);
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
  const before = (
    await git("git", ["-C", h.home, "for-each-ref", "refs/heads", "--format=%(refname)"])
  ).stdout;
  const payload = {
    type: "thread.create" as const,
    provider: "codex" as const,
    workspaceId: h.workspace,
    mode: "worktree" as const,
    input: [{ type: "text" as const, text: "Draft" }],
    instanceId: "a",
    accountId: "b",
  };
  try {
    for (let n = 0; n < 20; n++)
      expect(
        await command(client, `rejected-${n}`, {
          ...payload,
          threadId: ThreadId.parse(`rejected-${n}`),
        }),
      ).toMatchObject({ ok: false, error: "conflicting_account_selection" });
    expect(await runtime.git.listWorktrees(h.home)).toHaveLength(1);
    expect(
      (await git("git", ["-C", h.home, "for-each-ref", "refs/heads", "--format=%(refname)"]))
        .stdout,
    ).toBe(before);
    const { accountId: _account, instanceId: _instance, ...corrected } = payload;
    expect(
      await command(client, "rejected-0", { ...corrected, threadId: ThreadId.parse("rejected-0") }),
    ).toMatchObject({ ok: true });
  } finally {
    await client.close();
    await server.close();
    await runtime.close();
    await h.close();
  }
});

test("a socket disconnected before acceptance releases its worktree, branch and capacity", async () => {
  const h = transitionHarness({ maxActiveThreads: 1 });
  await repository(h.home);
  const gitService = new GatedGit();
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "data"), () => 1000, { gitService });
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
  const before = (
    await git("git", ["-C", h.home, "for-each-ref", "refs/heads", "--format=%(refname)"])
  ).stdout;
  try {
    client.send({
      type: "command",
      command: Command.parse({
        id: "disconnect",
        deviceId: "device",
        payload: {
          type: "thread.create",
          threadId: "disconnected",
          workspaceId: h.workspace,
          provider: "codex",
          mode: "worktree",
          input: [{ type: "text", text: "Draft remains local" }],
        },
      }),
    });
    await gitService.entered.promise;
    await client.close();
    gitService.proceed.resolve();
    await gitService.cleaned.promise;
    expect(await gitService.listWorktrees(h.home)).toHaveLength(1);
    expect(
      (await git("git", ["-C", h.home, "for-each-ref", "refs/heads", "--format=%(refname)"]))
        .stdout,
    ).toBe(before);
    const retry = await connect(server.url);
    expect(
      await command(retry, "disconnect", {
        type: "thread.create",
        threadId: ThreadId.parse("disconnected"),
        workspaceId: h.workspace,
        provider: "codex",
        mode: "worktree",
        input: [{ type: "text", text: "Draft remains local" }],
      }),
    ).toMatchObject({ ok: true });
    await h.engine.flush();
    expect(h.inputs.map((entry) => entry.text)).toEqual(["Draft remains local"]);
    await retry.close();
  } finally {
    gitService.proceed.resolve();
    await client.close();
    await server.close();
    await runtime.close();
    await h.close();
  }
});

test("a receipt-time admission rejection cleans only its uncommitted worktree and branch", async () => {
  const h = transitionHarness();
  await repository(h.home);
  const gitService = new GatedGit();
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "data"), () => 1000, { gitService });
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
  const original = h.registry.get("codex");
  const nativeModes = nativePermissionModes("codex");
  h.registry.register(
    {
      ...original.adapter,
      capabilities: () => ({
        ...original.capabilities,
        permissionModes: nativeModes,
        permissions: {
          modes: nativeModes.map((entry) => entry.id),
          permissionModes: nativeModes,
          nativeAutoReview: false,
          toolGate: true,
        },
      }),
    },
    original.discovery,
  );
  const before = (
    await git("git", ["-C", h.home, "for-each-ref", "refs/heads", "--format=%(refname)"])
  ).stdout;
  try {
    const result = command(client, "permission-change", {
      type: "thread.create",
      threadId: ThreadId.parse("permission-change"),
      workspaceId: h.workspace,
      provider: "codex",
      mode: "worktree",
      permissionMode: ":workspace",
      input: [{ type: "text", text: "Keep my draft" }],
    });
    await gitService.entered.promise;
    const permissionModes = nativeModes.filter((entry) => entry.id === ":read-only");
    h.registry.register(
      {
        ...original.adapter,
        capabilities: () => ({
          ...original.capabilities,
          permissionModes,
          permissions: {
            modes: permissionModes.map((entry) => entry.id),
            permissionModes,
            nativeAutoReview: false,
            toolGate: true,
          },
        }),
      },
      original.discovery,
    );
    gitService.proceed.resolve();
    expect(await result).toMatchObject({ ok: false, error: "permission_mode_unsupported" });
    await gitService.cleaned.promise;
    expect(await gitService.listWorktrees(h.home)).toHaveLength(1);
    expect(
      (await git("git", ["-C", h.home, "for-each-ref", "refs/heads", "--format=%(refname)"]))
        .stdout,
    ).toBe(before);
    client.send({ type: "subscribe", subscriptionId: "empty", scope: { kind: "threads" } });
    expect(await until(client, (message) => message.type === "snapshot")).toMatchObject({
      view: { threads: {} },
    });
    expect(h.inputs).toEqual([]);
  } finally {
    gitService.proceed.resolve();
    await client.close();
    await server.close();
    await runtime.close();
    await h.close();
  }
});

test("cleanup preserves a user commit made in an unaccepted worktree", async () => {
  const h = transitionHarness();
  await repository(h.home);
  const gitService = new GatedGit();
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "data"), () => 1000, { gitService });
  const failure = Promise.withResolvers<unknown>();
  const server = await startServer({
    store: h.store,
    engine: h.engine,
    handler: h.engine.handler,
    workspaceActions: runtime,
    port: 0,
    hostId: "host",
    token,
    log: (error) => failure.resolve(error),
  });
  const client = await connect(server.url);
  try {
    client.send({
      type: "command",
      command: Command.parse({
        id: "user-commit",
        deviceId: "device",
        payload: {
          type: "thread.create",
          threadId: "user-commit",
          workspaceId: h.workspace,
          provider: "codex",
          mode: "worktree",
          input: [{ type: "text", text: "Draft" }],
        },
      }),
    });
    await gitService.entered.promise;
    const tree = (await gitService.listWorktrees(h.home)).at(1);
    if (!tree?.branch) throw new Error("No unaccepted checkout");
    await writeFile(join(tree.path, "file.txt"), "User commit\n");
    await git("git", [
      "-C",
      tree.path,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@ace.local",
      "commit",
      "-am",
      "User work",
    ]);
    const head = (await git("git", ["-C", tree.path, "rev-parse", "HEAD"])).stdout;
    await client.close();
    gitService.proceed.resolve();
    expect(await failure.promise).toMatchObject({ message: "Worktree cleanup identity changed" });
    expect(await readFile(join(tree.path, "file.txt"), "utf8")).toBe("User commit\n");
    expect((await git("git", ["-C", h.home, "rev-parse", tree.branch])).stdout).toBe(head);
    expect(await gitService.listWorktrees(h.home)).toHaveLength(2);
    await expect(runtime.close()).rejects.toThrow("identity changed");
  } finally {
    gitService.proceed.resolve();
    await client.close();
    await server.close();
    await runtime.close().catch(() => {});
    await gitService.close();
    await h.close();
  }
});
