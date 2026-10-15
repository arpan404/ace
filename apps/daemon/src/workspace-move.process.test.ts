import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, type ThreadId } from "@ace/protocol";
import { transitionHarness } from "./engine/transition-test-support.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const execute = promisify(execFile);
async function git(root: string, ...args: string[]) {
  return (await execute("git", ["-C", root, ...args])).stdout.trim();
}
async function fixture() {
  const h = transitionHarness();
  await git(h.home, "init", "-b", "main");
  await git(h.home, "config", "user.name", "ace test");
  await git(h.home, "config", "user.email", "test@ace.local");
  await writeFile(join(h.home, "file.txt"), "project\n");
  // The harness keeps its database in the project folder; it is not the project's work.
  await writeFile(join(h.home, ".gitignore"), "events.sqlite*\n");
  await git(h.home, "add", ".");
  await git(h.home, "commit", "-m", "Initial");
  await h.engine.ready();
  const data = await mkdtemp(join(tmpdir(), "ace-move-data-"));
  const open = () =>
    new WorkspaceRuntime(h.store, data, () => 1000, {
      changeWorkspace: (id, commandId, effect, reservation, commit) =>
        h.engine.changeWorkspace(id, commandId, effect, reservation, commit),
    });
  let runtime = open();
  let serial = 0;
  const local = () => {
    const created = h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "codex",
      mode: "local",
      input: [{ type: "text", text: "start" }],
    });
    if (!created.threadId) throw new Error("Missing thread");
    return created.threadId;
  };
  const run = (payload: Record<string, unknown>) =>
    runtime.execute(Command.parse({ id: `move-${++serial}`, deviceId: "device", payload }));
  const send = (threadId: ThreadId, text: string) =>
    h.command({ type: "thread.send", threadId, input: [{ type: "text", text }] });
  return {
    h,
    data,
    local,
    run,
    send,
    get runtime() {
      return runtime;
    },
    async restart() {
      await runtime.close();
      runtime = open();
    },
    async close() {
      await runtime.close();
      await h.close();
      await rm(data, { recursive: true, force: true });
    },
  };
}

test("move to worktree from a branch makes its own branch, fences no shared root and ignores busy siblings", async () => {
  const f = await fixture();
  try {
    await git(f.h.home, "checkout", "-b", "feature");
    const thread = f.local();
    const sibling = f.local();
    await f.h.engine.flush();
    f.h.held.add(sibling);
    expect(f.send(sibling, "keep working")).toMatchObject({ ok: true });
    await f.h.engine.flush();
    expect(
      await f.run({ type: "thread.workspace.set", threadId: thread, mode: "worktree" }),
    ).toMatchObject({ ok: true });
    const details = f.h.store.getThread(thread)?.details;
    expect(details).toMatchObject({ mode: "worktree", workspaceChange: { state: "applied" } });
    expect(details?.branch).toMatch(/^ace\//);
    expect(details?.worktree).not.toBe(await realpath(f.h.home));
    expect(await git(f.h.home, "branch", "--show-current")).toBe("feature");
    expect(f.h.store.workspaceReservations.reserved(await realpath(f.h.home))).toBe(false);
  } finally {
    await f.close();
  }
});

test("a move Git would refuse is turned down before any write and leaves siblings able to send", async () => {
  const f = await fixture();
  try {
    const thread = f.local();
    const sibling = f.local();
    await f.h.engine.flush();
    expect(
      await f.run({
        type: "thread.workspace.set",
        threadId: thread,
        mode: "worktree",
        branch: "main",
      }),
    ).toMatchObject({ ok: false, error: "git_branch_checked_out" });
    expect(f.h.store.getThread(thread)?.details?.workspaceChange).toMatchObject({
      state: "failed",
      error: "git_branch_checked_out",
      uncertain: false,
      mode: "worktree",
      branch: "main",
    });
    expect(f.h.store.workspaceReservations.reserved(await realpath(f.h.home))).toBe(false);
    expect(f.send(sibling, "still free")).toMatchObject({ ok: true });
    expect(f.send(thread, "and me")).toMatchObject({ ok: true });
    await f.h.engine.flush();
    expect(f.h.inputs.some((input) => input.text.endsWith("still free"))).toBe(true);
  } finally {
    await f.close();
  }
});

test("a worktree deleted while the daemon was down is reported missing, then moves to local or is remade", async () => {
  const f = await fixture();
  try {
    const thread = f.local();
    await f.h.engine.flush();
    expect(
      await f.run({ type: "thread.workspace.set", threadId: thread, mode: "worktree" }),
    ).toMatchObject({ ok: true });
    const tree = f.h.store.getThread(thread)?.details?.worktree ?? "";
    const branch = f.h.store.getThread(thread)?.details?.branch;
    await rm(tree, { recursive: true, force: true });
    await f.restart();
    expect(await f.runtime.details(thread)).toMatchObject({ worktreeMissing: true });
    expect(
      await f.run({ type: "thread.workspace.set", threadId: thread, mode: "local" }),
    ).toMatchObject({ ok: true });
    expect(f.h.store.executionWorkspace(thread).path).toBe(await realpath(f.h.home));
    expect(
      await f.run({ type: "thread.workspace.set", threadId: thread, mode: "worktree" }),
    ).toMatchObject({ ok: true });
    const remade = f.h.store.getThread(thread)?.details;
    expect(remade).toMatchObject({ worktree: tree, branch });
    expect(remade?.worktreeMissing).toBeUndefined();
    expect(f.send(thread, "back in my worktree")).toMatchObject({ ok: true });
    await f.h.engine.flush();
    expect(f.h.sessions.at(-1)?.context.cwd).toBe(tree);
  } finally {
    await f.close();
  }
});

test("a thread whose worktree storage cleanup removed works again once its worktree is remade", async () => {
  const f = await fixture();
  try {
    const thread = f.local();
    await f.h.engine.flush();
    expect(
      await f.run({ type: "thread.workspace.set", threadId: thread, mode: "worktree" }),
    ).toMatchObject({ ok: true });
    const tree = f.h.store.getThread(thread)?.details?.worktree ?? "";
    // What archive and storage cleanup leave behind: the checkout gone, its root retired.
    await git(f.h.home, "worktree", "remove", "--force", tree);
    f.h.store.atomic((db) =>
      db.prepare("INSERT OR REPLACE INTO storage_removed_roots VALUES (?,?)").run(tree, 1),
    );
    expect(() => f.h.store.executionWorkspace(thread)).toThrow("workspace_removed");
    expect(await f.runtime.details(thread)).toMatchObject({ worktreeMissing: true });
    expect(
      await f.run({ type: "thread.workspace.set", threadId: thread, mode: "worktree" }),
    ).toMatchObject({ ok: true });
    expect(f.h.store.executionWorkspace(thread)).toMatchObject({ path: tree, ready: true });
    expect(f.send(thread, "after unarchive")).toMatchObject({ ok: true });
    await f.h.engine.flush();
    expect(f.h.inputs.at(-1)?.text.endsWith("after unarchive")).toBe(true);
    expect(f.h.sessions.at(-1)?.context.cwd).toBe(tree);
  } finally {
    await f.close();
  }
});

test("file changes reach only the threads running in the changed checkout", async () => {
  const f = await fixture();
  try {
    const inRoot = f.local();
    const inWorktree = f.local();
    await f.h.engine.flush();
    expect(
      await f.run({ type: "thread.workspace.set", threadId: inWorktree, mode: "worktree" }),
    ).toMatchObject({ ok: true });
    const tree = f.h.store.getThread(inWorktree)?.details?.worktree ?? "";
    const seen: string[] = [];
    const stop = f.h.store.subscribe((events) => {
      for (const event of events)
        if (event.payload.type === "workspace.files_changed") seen.push(event.threadId);
    });
    try {
      f.h.store.recordWorkspaceFileChange(f.h.workspace, tree, {
        id: "change-1",
        op: "write",
        path: "file.txt",
        version: "v1",
      });
      expect(seen).toEqual([inWorktree]);
      seen.length = 0;
      f.h.store.recordWorkspaceFileChange(f.h.workspace, await realpath(f.h.home), {
        id: "change-2",
        op: "write",
        path: "file.txt",
        version: "v2",
      });
      expect(seen).toEqual([inRoot]);
    } finally {
      stop();
    }
  } finally {
    await f.close();
  }
});

test("git.status reports the HEAD it read, so a terminal commit is not committed over", async () => {
  const f = await fixture();
  try {
    const thread = f.local();
    await f.h.engine.flush();
    await writeFile(join(f.h.home, "terminal.txt"), "made in a terminal\n");
    await git(f.h.home, "add", "terminal.txt");
    await git(f.h.home, "commit", "-m", "Terminal commit");
    const result = await f.runtime.read({
      type: "workspace.request",
      requestId: "status",
      operation: { op: "git.status", threadId: thread },
    });
    expect(result.result).toMatchObject({
      kind: "gitStatus",
      head: await git(f.h.home, "rev-parse", "HEAD"),
    });
  } finally {
    await f.close();
  }
});
