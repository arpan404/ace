import { Store } from "@ace/daemon";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
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

test("a local thread cannot switch a root owned by another live thread", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  try {
    const first = await h.create();
    const second = await peerThread(h);
    // Drive the public send edge so the second tree is live, rather than changing its projection.
    h.command({ type: "thread.send", threadId: second, input: [{ type: "text", text: "hold" }] });
    let changed = false;
    await expect(
      h.engine.changeWorkspace(first, "peer", async () => {
        changed = true;
        return { mode: "local", worktree: h.home };
      }),
    ).rejects.toThrow("thread_tree_is_live");
    expect(changed).toBe(false);
  } finally {
    await h.close();
  }
});

test("source and destination roots fence peer sends, preparation and uncertain recovery", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  try {
    const first = await h.create();
    const peer = await peerThread(h);
    const root = h.store.executionWorkspace(first).path;
    const destination = join(root, "destination");
    await mkdir(destination);
    const workspaceId = h.store.createWorkspace(destination, "Destination");
    const prepared = h.command({
      type: "thread.prepare",
      workspaceId,
      provider: "codex",
      threadId: ThreadId.parse("destination-peer"),
      title: "Destination",
    });
    if (!prepared.threadId) throw new Error("Prepared thread missing");
    const gate = Promise.withResolvers<void>();
    const change = h.engine.changeWorkspace(
      first,
      "roots",
      async () => {
        await gate.promise;
        throw new Error("uncertain");
      },
      { roots: [root, destination], hasOwnedWork: () => false },
    );
    const failed = expect(change).rejects.toThrow("uncertain");
    for (const threadId of [peer, prepared.threadId]) {
      expect(
        h.command({ type: "thread.send", threadId, input: [{ type: "text", text: "racing" }] }),
      ).toMatchObject({ ok: false });
      expect(() => h.store.executionWorkspace(threadId)).toThrow("workspace_change_in_progress");
    }
    expect(
      h.command({
        type: "thread.prepare",
        workspaceId,
        provider: "codex",
        threadId: ThreadId.parse("racing-preparation"),
        title: "Racing",
      }),
    ).toMatchObject({
      ok: false,
      error: "workspace_change_in_progress",
    });
    gate.resolve();
    await failed;
    const reopened = new Store(h.path);
    try {
      expect(() => reopened.executionWorkspace(peer)).toThrow("workspace_change_in_progress");
      expect(() => reopened.executionWorkspace(prepared.threadId ?? first)).toThrow(
        "workspace_change_in_progress",
      );
    } finally {
      await reopened.close();
    }
    expect(
      h.command({
        type: "thread.send",
        threadId: peer,
        input: [{ type: "text", text: "after uncertainty" }],
      }),
    ).toMatchObject({ ok: false });
    expect(() => h.store.executionWorkspace(prepared.threadId ?? first)).toThrow(
      "workspace_change_in_progress",
    );
  } finally {
    await h.close();
  }
});

test("terminal ownership on a peer root rejects switching before any Git effect", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  try {
    const first = await h.create();
    const peer = await peerThread(h);
    let changed = false;
    await expect(
      h.engine.changeWorkspace(
        first,
        "terminal",
        async () => {
          changed = true;
          return { worktree: h.home };
        },
        {
          roots: [h.store.executionWorkspace(first).path],
          hasOwnedWork: (id) => id === peer,
        },
      ),
    ).rejects.toThrow("terminal_owned");
    expect(changed).toBe(false);
  } finally {
    await h.close();
  }
});

async function peerThread(h: Awaited<ReturnType<typeof harness>>) {
  const result = h.command({
    type: "thread.create",
    threadId: ThreadId.parse("peer"),
    workspaceId: h.workspace,
    provider: "codex",
    input: [{ type: "text", text: "peer" }],
  });
  if (!result.threadId) throw new Error("Peer creation failed");
  await h.engine.flush();
  return result.threadId;
}
