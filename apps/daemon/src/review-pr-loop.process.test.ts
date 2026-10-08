import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { reviewPrFixture } from "./review-pr-test-support.ts";
import { until } from "./projects-test-support.ts";
import { queue } from "./thread-creation-test-support.ts";

const threadId = ThreadId.parse("review-thread");
const repository = { forge: "github", host: "github.com", owner: "octo", name: "ace" } as const;

test("production reviews queue a user turn and apply a suggestion in the isolated checkout", async () => {
  const f = await reviewPrFixture();
  try {
    expect(
      await f.send({
        type: "thread.prepare",
        title: "Review thread",
        threadId,
        workspaceId: f.workspaceId,
        provider: "codex",
        mode: "worktree",
        baseBranch: "main",
      }),
    ).toMatchObject({ ok: true });
    const details = f.daemon.store.getThread(threadId)?.details;
    const worktree = details?.worktree;
    if (!worktree) throw new Error("Missing prepared worktree");
    const q = await queue(f.client, threadId);
    expect(
      await f.send({ type: "queue.pause", threadId, expectedRevision: q.revision }),
    ).toMatchObject({ ok: true });
    await writeFile(join(worktree, "file.ts"), "before\nwrong\nafter\n");
    const opened = await f.send({
      type: "review.open",
      source: {
        workspaceId: f.workspaceId,
        threadId,
        from: { kind: "commit", ref: "HEAD" },
        to: { kind: "working-tree" },
      },
    });
    if (opened.type !== "commandResult" || !opened.review?.session)
      throw new Error("Review didn't open");
    const sessionId = opened.review.session.id;
    const added = await f.send({
      type: "review.comment",
      sessionId,
      position: { file: "file.ts", side: "new", start: 2, end: 2 },
      text: "Replace wrong with fixed",
      suggestion: "fixed",
    });
    if (added.type !== "commandResult" || !added.review?.comment)
      throw new Error("Missing comment");
    const commentId = added.review.comment.id;
    expect(added.review.comment.anchor.fingerprint.lines).toEqual(["wrong"]);
    const payload = {
      type: "review.sendToAgent",
      sessionId,
      threadId,
      commentIds: [commentId],
    } as const;
    expect(
      await f.send({ ...payload, commentIds: [...payload.commentIds] }, "send-review"),
    ).toMatchObject({ ok: true });
    expect(
      await f.send({ ...payload, commentIds: [...payload.commentIds] }, "send-review"),
    ).toMatchObject({ ok: true });
    const queued = await queue(f.client, threadId);
    expect(queued.total).toBe(1);
    expect(queued.messages[0]?.input).toEqual([
      { type: "text", text: expect.stringContaining("file.ts:2-2 (new side)") },
    ]);
    expect(queued.messages[0]?.input).toEqual([
      { type: "text", text: expect.stringContaining('"worktree":"' + worktree + '"') },
    ]);
    expect(f.daemon.store.getThread(threadId)?.status.state).not.toBe("done");
    expect(await f.send({ type: "review.applySuggestion", sessionId, commentId })).toMatchObject({
      ok: true,
    });
    expect(await readFile(join(worktree, "file.ts"), "utf8")).toBe("before\nfixed\nafter\n");
    expect(await readFile(join(f.repo, "file.ts"), "utf8")).toBe("before\noriginal\nafter\n");
    expect(await f.send({ type: "review.list", threadId, cursor: "", limit: 20 })).toMatchObject({
      ok: true,
      review: { sessions: [{ id: sessionId }] },
    });
    expect(
      await f.send({
        type: "review.list",
        threadId: ThreadId.parse("other"),
        cursor: "",
        limit: 20,
      }),
    ).toMatchObject({ ok: true, review: { sessions: [] } });
    expect(await f.send({ type: "review.askReviewer", sessionId, threadId })).toMatchObject({
      ok: false,
      error: "review_reviewer_unavailable",
    });
  } finally {
    await f.close();
  }
});

test("creating an existing PR links it and forge actions return fresh status", async () => {
  const f = await reviewPrFixture();
  try {
    expect(
      await f.send({
        type: "thread.prepare",
        title: "Review thread",
        threadId,
        workspaceId: f.workspaceId,
        provider: "codex",
      }),
    ).toMatchObject({ ok: true });
    await f.forgeState({ branch: "main" });
    const result = await f.send({
      type: "forge.pr.create",
      threadId,
      repository,
      input: {
        branch: "main",
        base: "main",
        title: "New title",
        summary: "Review",
        template: { title: "{{title}}", body: "{{summary}}" },
        draft: false,
      },
    });
    expect(result).toMatchObject({
      ok: true,
      pr: { number: 42 },
      prStatus: { title: "Existing review PR", ci: "pending" },
    });
    const calls = (await readFile(join(f.home, "gh-calls"), "utf8")).split("\n");
    expect(calls.some((line) => line.includes('"repos/octo/ace/pulls"'))).toBe(false);
    expect(f.daemon.store.getThread(threadId)?.details?.linkedPr?.number).toBe(42);
    const link = { threadId, pr: { repository, number: 42 } };
    await f.forgeState({ ci: "success" });
    expect(await f.send({ type: "forge.pr.status", link })).toMatchObject({
      ok: true,
      prStatus: { ci: "success" },
    });
    expect(await f.send({ type: "forge.pr.link", link })).toMatchObject({
      ok: true,
      pr: { number: 42 },
      prStatus: { ci: "success" },
    });
    expect(
      await f.send({ type: "forge.comment.reply", link, commentId: 1, body: "Fixed" }),
    ).toMatchObject({ ok: true, prStatus: { state: "open" } });
    expect(
      await f.send({ type: "forge.review.request", link, reviewers: ["reviewer"] }),
    ).toMatchObject({ ok: true, prStatus: { state: "open" } });
    expect(
      await f.send({
        type: "forge.pr.auto-merge",
        link,
        headSha: "a".repeat(40),
        method: "squash",
      }),
    ).toMatchObject({ ok: true, prStatus: { state: "open" } });
    expect(
      await f.send({ type: "forge.pr.merge", link, headSha: "a".repeat(40), method: "squash" }),
    ).toMatchObject({ ok: true, prStatus: { state: "merged" } });
    expect(f.daemon.store.getThread(threadId)?.details?.linkedPr?.state).toBe("merged");
  } finally {
    await f.close();
  }
});

test("forge failures retain their categories over sockets and GitLab is refused before gh runs", async () => {
  const f = await reviewPrFixture();
  try {
    expect(
      await f.send({
        type: "thread.prepare",
        title: "Review thread",
        threadId,
        workspaceId: f.workspaceId,
        provider: "codex",
      }),
    ).toMatchObject({ ok: true });
    const link = { threadId, pr: { repository, number: 42 } };
    await f.forgeState({ branch: "main" });
    expect(await f.send({ type: "forge.pr.link", link })).toMatchObject({ ok: true });
    for (const [http, code] of [
      [404, "not_found"],
      [403, "forbidden"],
      [401, "forbidden"],
      [429, "rate_limit"],
      [409, "conflict"],
      ["cli", "cli"],
    ] as const) {
      await f.forgeState({ code: http });
      expect(await f.send({ type: "forge.pr.status", link })).toMatchObject({
        ok: false,
        error: `forge_${code}`,
      });
      const requestId = `poll-${code}-${http}`;
      f.client.send({
        type: "workspace.request",
        requestId,
        operation: { op: "pr.status", threadId },
      });
      expect(
        await until(
          f.client,
          (message) => message.type === "workspace.result" && message.requestId === requestId,
        ),
      ).toMatchObject({ result: { kind: "error", code: `forge_${code}` } });
    }
    // Removing a broken link is local and still works when the forge refuses reads.
    expect(await f.send({ type: "forge.pr.unlink", threadId })).toMatchObject({ ok: true });
    expect(f.daemon.store.getThread(threadId)?.details?.linkedPr).toBeNull();
    f.client.send({
      type: "workspace.request",
      requestId: "unlinked-status",
      operation: { op: "pr.status", threadId },
    });
    expect(
      await until(
        f.client,
        (message) => message.type === "workspace.result" && message.requestId === "unlinked-status",
      ),
    ).toMatchObject({ result: { kind: "pr", status: null } });
    await f.runGit("remote", "set-url", "origin", "https://gitlab.com/octo/ace.git");
    const before = await readFile(join(f.home, "gh-calls"), "utf8");
    expect(
      await f.send({
        type: "forge.pr.link",
        link: {
          threadId,
          pr: { repository: { ...repository, forge: "gitlab", host: "gitlab.com" }, number: 42 },
        },
      }),
    ).toMatchObject({ ok: false, error: "forge_unsupported" });
    expect(await readFile(join(f.home, "gh-calls"), "utf8")).toBe(before);
  } finally {
    await f.close();
  }
});

test("git failures retain actionable codes over sockets", async () => {
  const f = await reviewPrFixture();
  try {
    expect(
      await f.send({
        type: "thread.prepare",
        title: "Review thread",
        threadId,
        workspaceId: f.workspaceId,
        provider: "codex",
      }),
    ).toMatchObject({ ok: true });
    const head = (await f.runGit("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(f.repo, "file.ts"), "before\nchanged\nafter\n");
    expect(
      await f.send({
        type: "git.commit",
        threadId,
        expectedHead: "0".repeat(40),
        message: "Change",
      }),
    ).toMatchObject({ ok: false, error: "git_head_moved" });
    await writeFile(join(f.repo, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    expect(
      await f.send({ type: "git.commit", threadId, expectedHead: head, message: "Change" }),
    ).toMatchObject({ ok: false, error: "git_hook_failed" });
    f.failGit("CONFLICT: resolve your current index");
    expect(
      await f.send({ type: "git.commit", threadId, expectedHead: head, message: "Change" }),
    ).toMatchObject({ ok: false, error: "git_conflicts" });
    f.failGit("Authentication failed");
    expect(await f.send({ type: "git.push", threadId, remote: "origin" })).toMatchObject({
      ok: false,
      error: "git_auth_failed",
    });
    f.failGit("Could not resolve host: fixture.invalid");
    expect(await f.send({ type: "git.push", threadId, remote: "origin" })).toMatchObject({
      ok: false,
      error: "git_remote_unreachable",
    });
  } finally {
    await f.close();
  }
});

test("branch switch offers carry-over and the thread can return to the local checkout", async () => {
  const f = await reviewPrFixture();
  try {
    await f.runGit("branch", "topic");
    expect(
      await f.send({
        type: "thread.prepare",
        title: "Review thread",
        threadId,
        workspaceId: f.workspaceId,
        provider: "codex",
      }),
    ).toMatchObject({ ok: true });
    await writeFile(join(f.repo, "file.ts"), "before\ncarry me\nafter\n");
    expect(
      await f.send({
        type: "thread.workspace.set",
        threadId,
        mode: "local",
        branch: "topic",
        allowUncommitted: false,
      }),
    ).toMatchObject({ ok: false, error: "git_dirty_worktree" });
    expect(
      await f.send({
        type: "thread.workspace.set",
        threadId,
        mode: "local",
        branch: "topic",
        allowUncommitted: true,
      }),
    ).toMatchObject({ ok: true, threadId });
    expect((await f.runGit("branch", "--show-current")).stdout.trim()).toBe("topic");
    expect(await readFile(join(f.repo, "file.ts"), "utf8")).toContain("carry me");
    await f.runGit("add", ".");
    await f.runGit("commit", "-qm", "Carried changes");
    expect(
      await f.send({
        type: "thread.workspace.set",
        threadId,
        mode: "worktree",
        branch: "main",
        allowUncommitted: false,
      }),
    ).toMatchObject({ ok: true });
    expect(f.daemon.store.getThread(threadId)?.details?.mode).toBe("worktree");
    expect(
      await f.send({
        type: "thread.workspace.set",
        threadId,
        mode: "local",
        allowUncommitted: false,
      }),
    ).toMatchObject({ ok: true, threadId });
    expect(f.daemon.store.getThread(threadId)?.details?.worktree).toBe(f.repo);
  } finally {
    await f.close();
  }
});

test("a review suggestion cannot patch an old worktree after the thread moves", async () => {
  const f = await reviewPrFixture();
  try {
    expect(
      await f.send({
        type: "thread.prepare",
        title: "Review thread",
        threadId,
        workspaceId: f.workspaceId,
        provider: "codex",
        mode: "worktree",
        baseBranch: "main",
      }),
    ).toMatchObject({ ok: true });
    const worktree = f.daemon.store.getThread(threadId)?.details?.worktree;
    if (!worktree) throw new Error("Missing worktree");
    await writeFile(join(worktree, "file.ts"), "before\nwrong\nafter\n");
    const opened = await f.send({
      type: "review.open",
      source: {
        workspaceId: f.workspaceId,
        threadId,
        from: { kind: "commit", ref: "HEAD" },
        to: { kind: "working-tree" },
      },
    });
    if (opened.type !== "commandResult") throw new Error("Missing review result");
    const sessionId = opened.review?.session?.id;
    if (!sessionId) throw new Error("Missing review session");
    const added = await f.send({
      type: "review.comment",
      sessionId,
      position: { file: "file.ts", side: "new", start: 2, end: 2 },
      text: "Fix this",
      suggestion: "fixed",
    });
    if (added.type !== "commandResult") throw new Error("Missing comment result");
    const commentId = added.review?.comment?.id;
    if (!commentId) throw new Error("Missing comment");
    const moved = await f.send({
      type: "thread.workspace.set",
      threadId,
      mode: "local",
      allowUncommitted: true,
    });
    expect(moved).toMatchObject({ ok: true });
    expect(await f.send({ type: "review.applySuggestion", sessionId, commentId })).toMatchObject({
      ok: false,
      error: "review_target_mismatch",
    });
    expect(await readFile(join(worktree, "file.ts"), "utf8")).toBe("before\nwrong\nafter\n");
    expect(await readFile(join(f.repo, "file.ts"), "utf8")).toBe("before\noriginal\nafter\n");
  } finally {
    await f.close();
  }
});
