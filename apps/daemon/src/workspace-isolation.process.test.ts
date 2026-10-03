import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "@ace/git";
import { Command, CommandId } from "@ace/protocol";
import { transitionHarness } from "./engine/transition-test-support.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
const execute = promisify(execFile);
async function git(root: string, ...args: string[]) {
  return (await execute("git", ["-C", root, ...args])).stdout.trim();
}
function gate() {
  let resolve: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}
async function repository(root: string) {
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "ace test");
  await git(root, "config", "user.email", "test@ace.local");
  await writeFile(join(root, "file.txt"), "project\n");
  await writeFile(join(root, "Procfile"), "verify: printf isolated > script-result\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "Initial");
}

test("worktree actions refuse admission until preparation finishes and forks use the provider's isolated repository", async () => {
  const preparation = gate(),
    entered = gate();
  let runtime: WorkspaceRuntime | undefined;
  const h = transitionHarness({
    prepareWorkspace: async (id) => {
      entered.resolve();
      await preparation.promise;
      if (!runtime) throw new Error("Missing runtime");
      return runtime.prepare(id);
    },
  });
  const data = await mkdtemp(join(tmpdir(), "ace-isolation-data-"));
  await repository(h.home);
  runtime = new WorkspaceRuntime(h.store, data, () => 1000);
  try {
    const created = h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "codex",
      mode: "worktree",
      baseBranch: "main",
      input: [{ type: "text", text: "Synthetic" }],
    });
    if (!created.threadId) throw new Error("Missing thread ID");
    await entered.promise;
    const id = created.threadId;
    await expect(
      runtime.read({
        type: "workspace.request",
        requestId: "early",
        operation: { op: "scripts.list", threadId: id },
      }),
    ).rejects.toThrow("workspace_preparing");
    await expect(runtime.openTerminal(id, "early shell")).rejects.toThrow("workspace_preparing");
    await writeFile(join(h.home, "project-only.txt"), "Do not commit me\n");
    expect(
      (
        await runtime.execute(
          Command.parse({
            id: "early-commit",
            deviceId: "device",
            payload: {
              type: "git.commit",
              threadId: id,
              expectedHead: await git(h.home, "rev-parse", "HEAD"),
              message: "Refuse",
            },
          }),
        )
      ).ok,
    ).toBe(false);
    expect(h.store.getThread(id)?.details?.worktree).toBeUndefined();
    preparation.resolve();
    await h.engine.flush();
    const isolated = h.sessions.find((entry) => entry.context.threadId === id)?.context.cwd;
    if (!isolated || isolated === h.home) throw new Error("Expected isolated provider root");
    await writeFile(join(isolated, "file.txt"), "isolated\n");
    const fork = await h.fork(id);
    expect(h.sessions.find((entry) => entry.context.threadId === fork)?.context.cwd).toBe(isolated);
    expect(h.store.getThread(fork)?.details).toMatchObject({
      mode: "worktree",
      machine: runtime.machine,
      branch: h.store.getThread(id)?.details?.branch,
      baseBranch: "main",
      worktree: isolated,
    });
    expect((await runtime.details(fork)).workspace).toMatchObject({
      id: h.workspace,
      path: h.home,
    });
    await runtime.checkpoints.beforeSend(fork, CommandId.parse("checkpoint"));
    const checkpoints = await runtime.git.listCheckpoints({ repo: isolated, threadId: fork });
    expect(checkpoints).toHaveLength(1);
    const checkpoint = checkpoints[0];
    if (!checkpoint) throw new Error("Missing checkpoint");
    expect(await git(isolated, "show", `${checkpoint.sha}:file.txt`)).toBe("isolated");
    expect(await readFile(join(h.home, "file.txt"), "utf8")).toBe("project\n");
    const originalHead = await git(h.home, "rev-parse", "HEAD");
    const committed = await runtime.execute(
      Command.parse({
        id: "fork-commit",
        deviceId: "device",
        payload: {
          type: "git.commit",
          threadId: fork,
          expectedHead: originalHead,
          message: "Isolated change",
        },
      }),
    );
    expect(committed.ok).toBe(true);
    expect(await git(h.home, "rev-parse", "HEAD")).toBe(originalHead);
    expect(await git(isolated, "show", "HEAD:file.txt")).toBe("isolated");
    const result = await runtime.execute(
      Command.parse({
        id: "fork-script",
        deviceId: "device",
        payload: { type: "workspace.script.run", threadId: fork, scriptId: "Procfile:verify" },
      }),
    );
    if (!result.terminalId) throw new Error("Missing script terminal");
    const stream = runtime.terminal(result.terminalId, fork).attach({ fromOffset: 0 });
    try {
      for await (const event of stream)
        if (event.type === "exit") {
          expect(event.status.code).toBe(0);
          break;
        }
    } finally {
      stream.detach();
    }
    expect(await readFile(join(isolated, "script-result"), "utf8")).toBe("isolated");
    await expect(readFile(join(h.home, "script-result"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    preparation.resolve();
    await h.engine.flush();
    await runtime.close();
    await h.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("a delayed refresh cannot restore a stale projected root after isolated preparation", async () => {
  const h = transitionHarness();
  const data = await mkdtemp(join(tmpdir(), "ace-refresh-data-"));
  await repository(h.home);
  const entered = gate(),
    release = gate();
  let delayed = false;
  class DelayedGit extends GitService {
    override async repositoryInfo(root: string) {
      const result = await super.repositoryInfo(root);
      if (delayed) {
        entered.resolve();
        await release.promise;
      }
      return result;
    }
  }
  const gitService = new DelayedGit();
  const runtime = new WorkspaceRuntime(h.store, data, () => 1000, { gitService });
  try {
    const id = await h.create();
    // Imported/replayed client metadata is a projection, not execution authority.
    h.store.appendEvents(id, [
      {
        type: "thread.client.updated",
        changes: {
          details: { mode: "worktree", worktree: h.home, baseBranch: "main" },
        },
      },
    ]);
    delayed = true;
    const refresh = runtime.details(id);
    await entered.promise;
    h.store.atomic((db) =>
      db.prepare("UPDATE engine_sessions SET workspace_ready=0 WHERE thread_id=?").run(id),
    );
    const isolated = await runtime.prepare(id);
    release.resolve();
    expect((await refresh).worktree).toBe(isolated);
    expect(runtime.root(id)).toBe(isolated);
    expect(h.store.getThread(id)?.details?.worktree).toBe(isolated);
  } finally {
    release.resolve();
    await runtime.close();
    await h.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("legacy pending worktrees fail closed after restart even when the registered project uses a filesystem alias", async () => {
  const h = transitionHarness();
  let runtime: WorkspaceRuntime | undefined;
  try {
    const id = await h.create();
    const cwd = h.sessions[0]?.context.cwd;
    if (!cwd) throw new Error("Missing provider cwd");
    await h.engine.close();
    const alias = join(h.home, "alias");
    await symlink(cwd, alias);
    h.store.appendEvents(id, [
      {
        type: "thread.client.updated",
        changes: { details: { mode: "worktree", worktree: cwd, branch: "main" } },
      },
    ]);
    // Restore the pre-readiness database format and a crash before provider admission.
    h.store.atomic((db) => {
      db.exec("ALTER TABLE engine_sessions DROP COLUMN workspace_ready");
      db.prepare("UPDATE engine_sessions SET native_session_id=NULL WHERE thread_id=?").run(id);
      db.prepare("UPDATE workspaces SET path=? WHERE id=?").run(alias, h.workspace);
    });
    await h.restart();
    runtime = new WorkspaceRuntime(h.store, h.home, () => 1000);
    await expect(
      runtime.read({
        type: "workspace.request",
        requestId: "legacy",
        operation: { op: "scripts.list", threadId: id },
      }),
    ).rejects.toThrow("workspace_preparing");
    expect(h.store.getThread(id)?.deletedAt).toBeUndefined();
  } finally {
    await runtime?.close();
    await h.close();
  }
});

test("prepared threads retain mode and base branch and workspace commands rebind subsequent provider sessions", async () => {
  const h = transitionHarness();
  const data = await mkdtemp(join(tmpdir(), "ace-workspace-switch-"));
  await writeFile(join(h.home, ".gitignore"), "events.sqlite*\n");
  await repository(h.home);
  await git(h.home, "branch", "feature");
  const runtime = new WorkspaceRuntime(h.store, data, () => 1000, {
    changeWorkspace: (id, commandId, effect) => h.engine.changeWorkspace(id, commandId, effect),
  });
  try {
    const threadId = ThreadId.parse("prepared");
    expect(
      h.command({
        type: "thread.prepare",
        threadId,
        workspaceId: h.workspace,
        provider: "codex",
        title: "Prepared",
        mode: "worktree",
        baseBranch: "main",
      }).ok,
    ).toBe(true);
    expect(h.store.getThread(threadId)?.details).toMatchObject({
      mode: "worktree",
      baseBranch: "main",
    });
    expect(h.sessions).toHaveLength(0);
    const prepared = await runtime.prepare(threadId);
    expect(prepared).not.toBe(h.home);
    const switchTo = (
      id: string,
      payload: { mode: "local" | "worktree"; branch: string; allowUncommitted?: boolean },
    ) =>
      runtime.execute(
        Command.parse({
          id,
          deviceId: "device",
          payload: { type: "thread.workspace.set", threadId, ...payload },
        }),
      );
    expect(await switchTo("local", { mode: "local", branch: "feature" })).toMatchObject({
      ok: true,
    });
    expect(h.store.executionWorkspace(threadId)).toMatchObject({ path: h.home, ready: true });
    expect(h.store.getThread(threadId)?.details).toMatchObject({
      mode: "local",
      branch: "feature",
      workspaceChange: { state: "applied" },
    });
    await writeFile(join(h.home, "file.txt"), "dirty\n");
    expect(await switchTo("dirty", { mode: "local", branch: "main" })).toMatchObject({
      ok: false,
      error: "git_dirty_worktree",
    });
    expect(await git(h.home, "branch", "--show-current")).toBe("feature");
    expect(
      await switchTo("allowed", { mode: "local", branch: "main", allowUncommitted: true }),
    ).toMatchObject({ ok: true });
    expect(await readFile(join(h.home, "file.txt"), "utf8")).toBe("dirty\n");
    expect(
      h.command({
        type: "thread.send",
        threadId,
        input: [{ type: "text", text: "Synthetic next turn" }],
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.sessions.at(-1)?.context.cwd).toBe(h.home);
    expect(h.sessions.at(-1)?.context.resume).toBeUndefined();
  } finally {
    await runtime.close();
    await h.close();
    await rm(data, { recursive: true, force: true });
  }
});
import { ThreadId } from "@ace/protocol";
