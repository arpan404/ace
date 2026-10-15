import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitError, GitService } from "@ace/git";
import { Command, ThreadId, type CommandPayload, type WorkspaceId } from "@ace/protocol";
import { transitionHarness } from "./engine/transition-test-support.ts";
import { WorkspaceRuntime, type WorkspaceRuntimeOptions } from "./workspace-runtime.ts";
import { startServer } from "./server.ts";
import { token, type Client } from "./socket-test-support.ts";
import { connect, git, repository } from "./thread-creation-test-support.ts";
import { until } from "./projects-test-support.ts";

type Harness = ReturnType<typeof transitionHarness>;
async function serve(h: Harness, options: WorkspaceRuntimeOptions = {}) {
  let now = 1000;
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "data"), () => (now += 1000), options);
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
  return {
    runtime,
    server,
    client,
    async close() {
      await client.close();
      await server.close();
      await runtime.close();
    },
  };
}
function create(id: string, workspaceId: WorkspaceId, extra: Partial<CommandPayload> = {}) {
  return Command.parse({
    id,
    deviceId: "device",
    payload: {
      type: "thread.create",
      threadId: `thread-${id}`,
      workspaceId,
      provider: "codex",
      mode: "worktree",
      base: { ref: "main" },
      input: [{ type: "text", text: `first message of ${id}` }],
      ...extra,
    },
  });
}
function receipt(client: Client, id: string) {
  return until(client, (message) => message.type === "commandResult" && message.commandId === id);
}
async function commit(home: string, message: string) {
  await git("git", ["-C", home, "add", "-A"]);
  await git("git", [
    "-C",
    home,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@ace.local",
    "commit",
    "-m",
    message,
  ]);
}

test("seventeen failed worktree starts never block the next one, before or after a restart", async () => {
  const h = transitionHarness();
  await repository(h.home);
  await h.engine.ready();
  let daemon = await serve(h);
  try {
    for (let index = 0; index < 17; index++) {
      const failed = create(`missing-${index}`, h.workspace, { base: { ref: "no-such-branch" } });
      daemon.client.send({ type: "command", command: failed });
      expect(await receipt(daemon.client, failed.id)).toMatchObject({
        ok: false,
        error: "worktree_base_not_found",
        title: "Branch not found",
      });
    }
    const first = create("after-failures", h.workspace);
    daemon.client.send({ type: "command", command: first });
    expect(await receipt(daemon.client, first.id)).toMatchObject({ ok: true });
    await daemon.close();
    daemon = await serve(h);
    const second = create("after-restart", h.workspace);
    daemon.client.send({ type: "command", command: second });
    expect(await receipt(daemon.client, second.id)).toMatchObject({ ok: true });
    await h.engine.flush();
    expect(h.inputs.map((input) => input.text)).toEqual([
      "first message of after-failures",
      "first message of after-restart",
    ]);
  } finally {
    await daemon.close();
    await h.close();
  }
});

test("a replay after the socket drops mid-checkout attaches to the same start and delivers its message once", async () => {
  const h = transitionHarness();
  await repository(h.home);
  await Promise.all(
    Array.from({ length: 1024 }, (_, index) =>
      writeFile(join(h.home, `fixture-${index}.txt`), `Synthetic ${index}\n`),
    ),
  );
  await commit(h.home, "Many files");
  await h.engine.ready();
  const daemon = await serve(h);
  try {
    const start = create("replayed", h.workspace);
    daemon.client.send({ type: "command", command: start });
    await until(
      daemon.client,
      (message) => message.type === "worktree.creation.progress" && message.step === "creating",
    );
    await daemon.client.close();
    const again = await connect(daemon.server.url);
    try {
      again.send({ type: "command", command: start });
      expect(await receipt(again, start.id)).toMatchObject({
        ok: true,
        threadId: "thread-replayed",
      });
      await h.engine.flush();
      expect(h.inputs.map((input) => input.text)).toEqual(["first message of replayed"]);
      expect(
        h.store.listThreads().filter((thread) => thread.id === "thread-replayed"),
      ).toHaveLength(1);
      const cwd = h.sessions[0]?.context.cwd;
      expect(cwd).toBe(h.store.getThread(ThreadId.parse("thread-replayed"))?.details?.worktree);
      expect(cwd).not.toBe(await realpath(h.home));
    } finally {
      await again.close();
    }
  } finally {
    await daemon.close();
    await h.close();
  }
});

test("a Git lock left by a stopped daemon is reported as git_quarantined with the repository to clear", async () => {
  const h = transitionHarness();
  await repository(h.home);
  await h.engine.ready();
  const real = new GitService();
  const locked: NonNullable<WorkspaceRuntimeOptions["gitService"]> = Object.assign(
    Object.create(real),
    {
      listWorktrees: async () => {
        throw new GitError(
          "git_quarantined",
          `Git changes in ${h.home}/.git are blocked: a Git operation was interrupted when the ace daemon running it stopped.`,
          { repository: `${h.home}/.git` },
        );
      },
    },
  );
  const daemon = await serve(h, { gitService: locked });
  try {
    const start = create("locked", h.workspace);
    daemon.client.send({ type: "command", command: start });
    const failed = await until(
      daemon.client,
      (message) => message.type === "worktree.creation.progress" && message.state === "failed",
    );
    expect(failed).toMatchObject({
      error: "git_quarantined",
      lockPath: `${h.home}/.git`,
      cleanupComplete: true,
      actions: ["retry", "local"],
    });
    expect(await receipt(daemon.client, start.id)).toMatchObject({
      ok: false,
      error: "git_quarantined",
      title: "Git is locked",
    });
  } finally {
    await daemon.close();
    await real.close();
    await h.close();
  }
});

test("a project in a repository subfolder runs in that subfolder of its new worktree", async () => {
  const h = transitionHarness();
  await repository(h.home);
  await mkdir(join(h.home, "packages", "app"), { recursive: true });
  await writeFile(join(h.home, "packages", "app", "index.ts"), "export {};\n");
  await commit(h.home, "App package");
  const project = h.store.createWorkspace(join(h.home, "packages", "app"), "App");
  await h.engine.ready();
  const daemon = await serve(h);
  try {
    const start = create("subfolder", project);
    daemon.client.send({ type: "command", command: start });
    expect(await receipt(daemon.client, start.id)).toMatchObject({ ok: true });
    await h.engine.flush();
    const cwd = h.sessions[0]?.context.cwd ?? "";
    expect(cwd.endsWith(join("packages", "app"))).toBe(true);
    expect(cwd.startsWith(await realpath(join(h.home, "data", "worktrees")))).toBe(true);
    expect(h.store.getThread(ThreadId.parse("thread-subfolder"))?.details?.worktree).toBe(cwd);
  } finally {
    await daemon.close();
    await h.close();
  }
});

test("a failed setup script keeps its worktree and Continue starts the thread there without setup", async () => {
  const h = transitionHarness();
  await repository(h.home);
  await writeFile(
    join(h.home, "package.json"),
    JSON.stringify({
      scripts: { setup: "node -e \"console.error('setup broke');process.exit(3)\"" },
    }),
  );
  await writeFile(join(h.home, "Makefile"), "setup:\n\t@touch make-setup-ran\n");
  await commit(h.home, "Setup scripts");
  await h.engine.ready();
  const daemon = await serve(h);
  try {
    const start = create("setup", h.workspace);
    daemon.client.send({ type: "command", command: start });
    const failed = await until(
      daemon.client,
      (message) => message.type === "worktree.creation.progress" && message.state === "failed",
    );
    expect(failed).toMatchObject({
      error: "setup_failed",
      actions: ["retry", "continue", "local"],
      cleanupComplete: true,
    });
    if (failed.type !== "worktree.creation.progress") throw new Error("Expected progress");
    expect(failed.details.join("\n")).toContain("setup broke");
    expect(await receipt(daemon.client, start.id)).toMatchObject({ error: "setup_failed" });
    expect(await daemon.runtime.git.listWorktrees(h.home)).toHaveLength(2);
    daemon.client.send({
      type: "worktree.creation.request",
      requestId: "continue",
      commandId: start.id,
      action: "continue",
    });
    expect(await receipt(daemon.client, start.id)).toMatchObject({ ok: true });
    await h.engine.flush();
    expect(h.inputs.map((input) => input.text)).toEqual(["first message of setup"]);
    const cwd = h.sessions[0]?.context.cwd ?? "";
    expect(cwd.startsWith(await realpath(join(h.home, "data", "worktrees")))).toBe(true);
    // Only package.json's setup ran: the Makefile's never did.
    await expect(realpath(join(cwd, "make-setup-ran"))).rejects.toThrow();
  } finally {
    await daemon.close();
    await h.close();
  }
});

test("a malformed package.json does not stop a worktree start", async () => {
  const h = transitionHarness();
  await repository(h.home);
  await writeFile(join(h.home, "package.json"), "{ not json");
  await commit(h.home, "Broken manifest");
  await h.engine.ready();
  const daemon = await serve(h);
  try {
    const start = create("manifest", h.workspace);
    daemon.client.send({ type: "command", command: start });
    expect(await receipt(daemon.client, start.id)).toMatchObject({ ok: true });
  } finally {
    await daemon.close();
    await h.close();
  }
});
