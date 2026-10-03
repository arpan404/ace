import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { expect, test } from "vitest";
import { GitError } from "@ace/git";
import { harness, scriptFrames, start, end, task } from "./test-support.ts";

test("changing workspace fences sends until a fresh session can use the new root", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  try {
    const id = await h.create();
    const root = join(h.home, "worktree");
    await mkdir(root);
    let release = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const change = h.engine.changeWorkspace(id, "switch", async () => {
      await gate;
      return { mode: "worktree", worktree: root, branch: "feature" };
    });
    expect(h.store.getThread(id)?.details?.workspaceChange?.state).toBe("preparing");
    expect(
      h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "racing" }] }),
    ).toMatchObject({ ok: false, error: "workspace_change_in_progress" });
    expect(() => h.store.executionWorkspace(id)).toThrow("workspace_change_in_progress");
    release();
    await change;
    expect(h.store.executionWorkspace(id)).toMatchObject({ path: root, ready: true });
    expect(h.store.getThread(id)?.details).toMatchObject({
      mode: "worktree",
      branch: "feature",
      workspaceChange: { state: "applied", lossy: true },
    });
    expect(
      h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "next" }] }),
    ).toMatchObject({ ok: true });
    await h.engine.flush();
    expect(h.contexts.at(-1)).toMatchObject({ cwd: root });
    expect(h.contexts.at(-1)?.resume).toBeUndefined();
  } finally {
    await h.close();
  }
});

test("dirty validation preserves the original binding but an uncertain mutation keeps sends fenced", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  try {
    const id = await h.create();
    const before = h.store.executionWorkspace(id).path;
    await expect(
      h.engine.changeWorkspace(id, "dirty", async () => {
        throw new GitError("dirty_worktree", "Dirty");
      }),
    ).rejects.toMatchObject({ code: "dirty_worktree" });
    expect(h.store.executionWorkspace(id).path).toBe(before);
    expect(h.store.getThread(id)?.details?.workspaceChange).toMatchObject({
      state: "failed",
      error: "git_dirty_worktree",
      uncertain: false,
    });
    await expect(
      h.engine.changeWorkspace(id, "uncertain", async () => {
        throw new Error("private path and secret");
      }),
    ).rejects.toThrow();
    expect(h.store.getThread(id)?.details?.workspaceChange).toMatchObject({
      state: "failed",
      error: "workspace_change_failed",
      uncertain: true,
    });
    expect(
      h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "next" }] }),
    ).toMatchObject({ ok: false });
    expect(() => h.store.executionWorkspace(id)).toThrow();
  } finally {
    await h.close();
  }
});

test("a background shell prevents workspace switching after its foreground turn finishes", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, task, end)] }], frames);
  try {
    const id = await h.create();
    let changed = false;
    await expect(
      h.engine.changeWorkspace(id, "switch", async () => {
        changed = true;
        return { worktree: h.home, mode: "local" };
      }),
    ).rejects.toThrow("thread_tree_is_live");
    expect(changed).toBe(false);
    expect(h.store.getThread(id)?.status.state).not.toBe("done");
  } finally {
    await h.close();
  }
});

function noop() {}
