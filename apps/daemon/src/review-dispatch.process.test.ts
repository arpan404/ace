import { expect, it } from "vitest";
import { reviewFixture } from "./review-test-support.ts";
import { createDevThread } from "./commands.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

it("a saturated retry cannot replace the successful receipt of a waiting reviewer", async () => {
  const entered = Promise.withResolvers<void>();
  const output = Promise.withResolvers<unknown>();
  const f = await reviewFixture({
    async fix() {},
    async review() {
      entered.resolve();
      return output.promise;
    },
  });
  try {
    const payload = { type: "review.askReviewer", sessionId: f.sessionId, threadId: f.a.thread.id };
    const original = f.send(payload, "waiting-reviewer");
    await entered.promise;
    const queued = Array.from({ length: 15 }, () =>
      f.send({ type: "review.status", sessionId: f.sessionId, status: "open" }),
    );
    expect(await f.send(payload, "waiting-reviewer")).toMatchObject({
      ok: false,
      error: "review_busy",
    });
    const fresh = { type: "review.list", sessionId: f.sessionId };
    expect(await f.send(fresh, "not-admitted")).toMatchObject({ ok: false, error: "review_busy" });
    output.resolve({
      comments: [
        { position: { file: "file.ts", side: "new", start: 2, end: 2 }, text: "Durable finding" },
      ],
    });
    const completed = await original;
    expect(completed.ok).toBe(true);
    await Promise.all(queued);
    expect(await f.send(payload, "waiting-reviewer")).toEqual(completed);
    expect((await f.send(fresh, "not-admitted")).ok).toBe(true);
    const listed = await f.send({ type: "review.list", sessionId: f.sessionId });
    expect(listed.review?.comments?.map((c) => c.text)).toEqual(["Durable finding"]);
  } finally {
    output.resolve({ comments: [] });
    await f.close();
  }
});

it("a target in the same workspace must use the reviewed worktree", async () => {
  const received: unknown[] = [];
  const f = await reviewFixture({
    async fix(intent) {
      received.push(intent);
    },
    async review(intent) {
      received.push(intent);
      return { comments: [] };
    },
  });
  try {
    const path = join(f.directory, "isolated");
    await promisify(execFile)("git", ["worktree", "add", "--detach", path, "HEAD"], {
      cwd: f.a.root,
    });
    const target = createDevThread(f.store, f.a.workspaceId);
    f.threadWorktrees.set(target.id, path);
    expect(
      await f.send({ type: "review.askReviewer", sessionId: f.sessionId, threadId: target.id }),
    ).toMatchObject({ ok: false, error: "review_target_mismatch" });
    expect(received).toEqual([]);
  } finally {
    await f.close();
  }
});

it("findings never reach an executor for another repository with identical filenames", async () => {
  const received: unknown[] = [];
  const f = await reviewFixture({
    async fix(intent) {
      received.push(intent);
    },
    async review(intent) {
      received.push(intent);
      return { comments: [] };
    },
  });
  try {
    const comment = await f.send({
      type: "review.comment",
      sessionId: f.sessionId,
      position: { file: "file.ts", side: "new", start: 2, end: 2 },
      text: "Fix A",
      suggestion: "correct",
    });
    for (const action of [
      { type: "review.sendToAgent", commentIds: [comment.review?.comment?.id] },
      { type: "review.askReviewer" },
    ])
      expect(
        await f.send({ ...action, sessionId: f.sessionId, threadId: f.b.thread.id }),
      ).toMatchObject({ ok: false, error: "review_target_mismatch" });
    expect(received).toEqual([]);
    expect(
      (
        await f.send({
          type: "review.sendToAgent",
          sessionId: f.sessionId,
          threadId: f.a.thread.id,
          commentIds: [comment.review?.comment?.id],
        })
      ).ok,
    ).toBe(true);
    expect(received).toMatchObject([
      { source: { workspaceId: f.a.workspaceId, threadId: f.a.thread.id, worktree: f.a.root } },
    ]);
  } finally {
    await f.close();
  }
});
