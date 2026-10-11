import { FakeDaemon, ScenarioPlayer, coldStartReplay } from "@ace/fake-daemon";
import { Command, ThreadId, ThreadView, WorkspaceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { fakeClient } from "@/test/harness.tsx";
import { LocalStore } from "../store.ts";
import { refreshDrafts, saveDraft, sendDrafts, type ReviewDraft } from "./drafts.ts";
import {
  daemonWorkspaceSource,
  WorkspaceError,
} from "@/features/thread/sources/workspace-source.ts";

async function fixture() {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, coldStartReplay()).runUntilBlocked();
  const client = fakeClient(daemon);
  const ready = new Promise<void>((resolve) => {
    const stop = client.connectionState().subscribe(() => {
      if (client.state === "ready") {
        stop();
        resolve();
      }
    });
  });
  await client.start();
  await ready;
  const chunks: Uint8Array[] = [];
  for await (const chunk of client.downloadFile({
    threadId: ThreadId.parse("thread-cold-start"),
    op: "download",
    path: "apps/server/src/replay.ts",
    offset: 0,
  }))
    chunks.push(chunk);
  const fileLines = new TextDecoder().decode(Buffer.concat(chunks)).split("\n");
  let serial = 0;
  const remote = (payload: unknown) =>
    daemon.command(Command.parse({ id: `remote-${++serial}`, deviceId: "other-device", payload }));
  return { daemon, client, remote, fileLines };
}

/** Review turns are observable transcript inputs, including ones queued for the agent. */
function reviewTurns(f: Awaited<ReturnType<typeof fixture>>) {
  const view = ThreadView.parse(
    f.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-cold-start") }),
  );
  return view.itemOrder.flatMap((id) => {
    const item = view.items[id];
    if (item?.type !== "message" || item.role !== "user") return [];
    const text = item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    return text.startsWith("Review comments to address:\n")
      ? [text.split("\n").filter((line) => line.startsWith("- "))]
      : [];
  });
}

test("an empty device discovers daemon review comments and follows resolution from another device", async () => {
  const f = await fixture();
  try {
    const threadId = ThreadId.parse("thread-cold-start");
    const opened = f.remote({
      type: "review.open",
      source: {
        workspaceId: "ace",
        threadId,
        from: { kind: "commit", ref: "HEAD" },
        to: { kind: "working-tree" },
      },
    });
    const sessionId = opened.review?.session?.id;
    const added = f.remote({
      type: "review.comment",
      sessionId,
      position: { file: "apps/server/src/replay.ts", side: "new", start: 2, end: 3 },
      text: "Comment from another device",
    });
    const store = new LocalStore<readonly ReviewDraft[]>([]);
    saveDraft(store, {
      threadId,
      file: "draft.ts",
      side: "new",
      line: 1,
      text: "Unsent local draft",
      createdAt: 1,
    });
    await refreshDrafts(f.client, store, threadId);
    expect(store.get()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "Unsent local draft", state: "draft" }),
        expect.objectContaining({
          text: "Comment from another device",
          state: "draft",
          commentId: added.review?.comment?.id,
        }),
      ]),
    );
    expect(
      f.remote({
        type: "review.resolve",
        sessionId,
        commentId: added.review?.comment?.id,
        resolved: true,
      }),
    ).toMatchObject({ ok: true });
    await refreshDrafts(f.client, store, threadId);
    expect(store.get()).toHaveLength(2);
    expect(store.get().find((draft) => draft.commentId === added.review?.comment?.id)?.state).toBe(
      "resolved",
    );
  } finally {
    await f.client.close();
  }
});

test("checkout errors keep their code and tell the person how to recover", async () => {
  const f = await fixture();
  try {
    const source = daemonWorkspaceSource(f.client);
    const thread = { id: "thread-cold-start", workspaceId: "ace", title: "Review" };
    for (const [code, fix] of [
      ["git_hook_failed", /^A Git hook rejected the change: fix what the hook reports/],
      ["git_auth_failed", /run `gh auth login`/],
      ["git_conflicts", /resolve them in the checkout/],
      ["git_head_moved", /refresh the changes/],
      ["git_remote_unreachable", /check your connection/],
      ["git_quarantined", /cleanup is still pending/],
      ["forge_not_found", /check its number/],
      ["forge_forbidden", /permissions on the repository/],
      ["forge_rate_limit", /wait a few minutes/],
      ["forge_cli", /install `gh` and run `gh auth login`/],
      ["forge_auth", /^Sign in to GitHub: run `gh auth login`/],
      ["forge_unsupported", /open the pull request on its website/],
      ["forge_conflict", /Refresh, then retry/],
    ] as const) {
      f.daemon.refuseCommands(code, "git.push");
      const error = await source.push(thread).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(WorkspaceError);
      expect(error).toMatchObject({ code });
      expect(error instanceof Error ? error.message : "").toMatch(fix);
    }
  } finally {
    await f.client.close();
  }
});

test("checkout wiring carries uncommitted changes only when the person opts in", async () => {
  const f = await fixture();
  try {
    f.daemon.createThread({
      id: "checkout",
      workspaceId: "ace",
      provider: "codex",
      title: "Checkout",
      details: { mode: "local", branch: "main", diff: { files: 1, additions: 1, deletions: 0 } },
    });
    const source = daemonWorkspaceSource(f.client);
    const thread = { id: "checkout", workspaceId: "ace", title: "Review" };
    await expect(
      source.setCheckout(thread, { mode: "local", branch: "develop" }),
    ).rejects.toMatchObject({ code: "git_dirty_worktree" });
    await expect(
      source.setCheckout(thread, { mode: "local", branch: "develop", allowUncommitted: true }),
    ).resolves.toBeUndefined();
    expect(await source.details(thread)).toMatchObject({ mode: "local", branch: "develop" });
  } finally {
    await f.client.close();
  }
});

test("retrying an admitted review comment reuses its session without duplicating the comment", async () => {
  const f = await fixture();
  try {
    const thread = {
      id: ThreadId.parse("thread-cold-start"),
      workspaceId: WorkspaceId.parse("ace"),
    };
    const store = new LocalStore<readonly ReviewDraft[]>([]);
    saveDraft(store, {
      threadId: thread.id,
      file: "apps/server/src/replay.ts",
      side: "new",
      line: 2,
      fingerprint: { before: [], lines: f.fileLines.slice(1, 2), after: [] },
      text: "Retry this review",
      createdAt: 1,
    });
    const keys = store.get().map((draft) => draft.key);
    f.daemon.refuseCommands("review_queue_rejected", "review.sendToAgent");
    await sendDrafts(f.client, store, thread, keys);
    expect(store.get()[0]?.state).toBe("failed");
    const recorded = f.daemon.review.comments()[0];
    f.daemon.restoreRequests();
    await sendDrafts(f.client, store, thread, keys);
    expect(store.get()[0]?.state).toBe("sent");
    expect(f.daemon.review.comments()).toEqual([
      expect.objectContaining({ id: recorded?.id, sent: true }),
    ]);
  } finally {
    await f.client.close();
  }
});

test.each([1, 20, 21])("sending %i comments delivers each recorded comment once", async (count) => {
  const f = await fixture();
  try {
    const thread = {
      id: ThreadId.parse("thread-cold-start"),
      workspaceId: WorkspaceId.parse("ace"),
    };
    const store = new LocalStore<readonly ReviewDraft[]>([]);
    for (let line = 1; line <= count; line++)
      saveDraft(store, {
        threadId: thread.id,
        file: "apps/server/src/replay.ts",
        side: "new",
        line,
        fingerprint: { before: [], lines: f.fileLines.slice(line - 1, line), after: [] },
        text: `Finding ${line}`,
        createdAt: line,
      });
    await sendDrafts(
      f.client,
      store,
      thread,
      store.get().map((draft) => draft.key),
    );
    expect(store.get().every((draft) => draft.state === "sent")).toBe(true);
    expect(f.daemon.review.comments()).toHaveLength(count);
    expect(f.daemon.review.comments().every((comment) => comment.sent)).toBe(true);
  } finally {
    await f.client.close();
  }
});

test("a failed delivery batch retries only pending comments without recording duplicates", async () => {
  const f = await fixture();
  try {
    const thread = {
      id: ThreadId.parse("thread-cold-start"),
      workspaceId: WorkspaceId.parse("ace"),
    };
    const store = new LocalStore<readonly ReviewDraft[]>([]);
    for (let line = 1; line <= 21; line++)
      saveDraft(store, {
        threadId: thread.id,
        file: "apps/server/src/replay.ts",
        side: "new",
        line,
        fingerprint: { before: [], lines: f.fileLines.slice(line - 1, line), after: [] },
        text: `Finding ${line}`,
        createdAt: line,
      });
    const stop = store.subscribe(() => {
      if (store.get().filter((draft) => draft.state === "sent").length === 20)
        f.daemon.refuseCommands("review_queue_rejected", "review.sendToAgent");
    });
    const keys = store.get().map((draft) => draft.key);
    await sendDrafts(f.client, store, thread, keys);
    stop();
    expect(store.get().filter((draft) => draft.state === "sent")).toHaveLength(20);
    expect(store.get().filter((draft) => draft.state === "failed")).toHaveLength(1);
    const firstBatch = Array.from(
      { length: 20 },
      (_, index) => `- apps/server/src/replay.ts:${index + 1} (new side): Finding ${index + 1}`,
    );
    expect(reviewTurns(f)).toEqual([firstBatch]);
    const comments = f.daemon.review.comments();
    f.daemon.restoreRequests();
    await sendDrafts(f.client, store, thread, keys);
    expect(store.get().every((draft) => draft.state === "sent")).toBe(true);
    expect(f.daemon.review.comments().map((comment) => comment.id)).toEqual(
      comments.map((comment) => comment.id),
    );
    expect(f.daemon.review.comments().every((comment) => comment.sent)).toBe(true);
    expect(reviewTurns(f)).toEqual([
      firstBatch,
      ["- apps/server/src/replay.ts:21 (new side): Finding 21"],
    ]);
  } finally {
    await f.client.close();
  }
});
