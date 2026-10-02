import { afterEach, expect, it, vi } from "vitest";
import { repository } from "./test-support.ts";
import { parseReviewerOutput, buildFixIntent } from "./index.ts";
import { ThreadId } from "@ace/protocol";
vi.setConfig({ testTimeout: 30_000 });
const repos: Awaited<ReturnType<typeof repository>>[] = [];
const setup = async (executor?: Parameters<typeof repository>[0]) => {
  const repo = await repository(executor);
  repos.push(repo);
  return repo;
};
afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.close()));
});

it("applies a suggestion through git and leaves it pending human review", async () => {
  const repo = await setup();
  const comment = await repo.comment("const value = right;");
  const result = await repo.send(
    { type: "review.applySuggestion", sessionId: repo.session.id, commentId: comment.id },
    "apply-once",
  );
  expect(result.ok).toBe(true);
  expect(await repo.read()).toBe("first\nbefore\nconst value = right;\nafter\nlast\n");
  expect(result.review?.comment?.anchor.state).toBe("addressed-pending-review");
  expect(result.review?.comment?.resolved).toBe(false);
  expect(
    await repo.send(
      { type: "review.applySuggestion", sessionId: repo.session.id, commentId: comment.id },
      "apply-once",
    ),
  ).toEqual(result);
});
it("conflicts leave files and comment state unchanged", async () => {
  const repo = await setup();
  const comment = await repo.comment("const value = right;");
  const edited = "first\nbefore\nconst value = human;\nafter\nlast\n";
  await repo.write(edited);
  expect(
    (
      await repo.send({
        type: "review.applySuggestion",
        sessionId: repo.session.id,
        commentId: comment.id,
      })
    ).ok,
  ).toBe(false);
  expect(await repo.read()).toBe(edited);
  const listed = await repo.send({ type: "review.list", sessionId: repo.session.id });
  expect(listed.review?.comments?.[0]?.anchor.state).toBe("active");
});
it("a suggestion can delete the selected line", async () => {
  const repo = await setup();
  const comment = await repo.comment("");
  expect(
    (
      await repo.send({
        type: "review.applySuggestion",
        sessionId: repo.session.id,
        commentId: comment.id,
      })
    ).ok,
  ).toBe(true);
  expect(await repo.read()).toBe("first\nbefore\nafter\nlast\n");
});
it("comments replies resolution and approvals survive reopening SQLite", async () => {
  const repo = await setup();
  const comment = await repo.comment();
  await repo.send({
    type: "review.reply",
    sessionId: repo.session.id,
    commentId: comment.id,
    text: "Please keep the type",
  });
  await repo.send({
    type: "review.resolve",
    sessionId: repo.session.id,
    commentId: comment.id,
    resolved: true,
  });
  await repo.send({ type: "review.status", sessionId: repo.session.id, status: "approved" });
  repo.reopen();
  const list = await repo.send({ type: "review.list", sessionId: repo.session.id });
  expect(list.review?.comments?.[0]?.text).toBe("Fix the value");
  expect(list.review?.comments?.[0]?.resolved).toBe(true);
  expect(list.review?.session?.status).toBe("approved");
  expect(
    (await repo.send({ type: "review.list", sessionId: repo.session.id, commentId: comment.id }))
      .review?.replies?.[0]?.text,
  ).toBe("Please keep the type");
  expect(
    (
      await repo.send({
        type: "review.resolve",
        sessionId: repo.session.id,
        commentId: comment.id,
        resolved: false,
      })
    ).review?.comment?.resolved,
  ).toBe(false);
});
it("freezes moving commit refs at session creation", async () => {
  const repo = await setup();
  const opened = await repo.send({
    type: "review.open",
    source: {
      workspaceId: "workspace",
      from: { kind: "commit", ref: "HEAD" },
      to: { kind: "working-tree" },
    },
  });
  await repo.git("add", "file.ts");
  await repo.git("commit", "-qm", "new head");
  const result = await repo.send({
    type: "review.comment",
    sessionId: opened.review?.session?.id,
    position: { file: "file.ts", side: "old", start: 3, end: 3 },
    text: "Original value",
  });
  expect(result.review?.comment?.anchor.fingerprint.lines).toEqual(["const value = original;"]);
});
it("refresh marks touched findings pending review and preserves their original evidence", async () => {
  const repo = await setup();
  const comment = await repo.comment();
  await repo.write("first\nbefore\nconst value = right;\nafter\nlast\n");
  expect(
    (
      await repo.send({
        type: "review.refresh",
        sessionId: repo.session.id,
        from: repo.session.source.from,
        to: { kind: "working-tree" },
      })
    ).ok,
  ).toBe(true);
  const updated = (await repo.send({ type: "review.list", sessionId: repo.session.id })).review
    ?.comments?.[0];
  expect(updated?.anchor.state).toBe("addressed-pending-review");
  expect(updated?.originalAnchor).toEqual(comment.originalAnchor);
  expect(updated?.resolved).toBe(false);
});
it("selected comments reach the executor as a structured bounded intent", async () => {
  const delivered: unknown[] = [];
  const repo = await setup({
    async fix(intent) {
      delivered.push(intent);
    },
    async review() {
      return { comments: [] };
    },
  });
  const comment = await repo.comment("const value = right;");
  const result = await repo.send(
    {
      type: "review.sendToAgent",
      sessionId: repo.session.id,
      threadId: "thread",
      commentIds: [comment.id],
    },
    "fix-once",
  );
  expect(result.review?.session?.status).toBe("changes-requested");
  expect(delivered).toEqual([
    {
      kind: "review-fix",
      requestId: "fix-once",
      sessionId: repo.session.id,
      threadId: "thread",
      comments: [
        {
          id: comment.id,
          position: comment.anchor.position,
          text: "Fix the value",
          suggestion: "const value = right;",
          excerpt: "first\nbefore\nconst value = wrong;\nafter\nlast",
        },
      ],
    },
  ]);
  repo.reopen();
  await repo.send(
    {
      type: "review.sendToAgent",
      sessionId: repo.session.id,
      threadId: "thread",
      commentIds: [comment.id],
    },
    "fix-once",
  );
  expect(delivered).toHaveLength(1);
});
it("fix payloads cap excerpts and reject excessive aggregate size and unavailable selections", async () => {
  const repo = await setup();
  const comment = await repo.comment();
  const huge = {
    ...comment,
    anchor: {
      ...comment.anchor,
      fingerprint: { before: [], lines: ["x".repeat(8192)], after: [] },
    },
  };
  expect(
    buildFixIntent("fix", repo.session.id, ThreadId.parse("thread"), [huge]).comments[0]?.excerpt,
  ).toHaveLength(2048);
  expect(() =>
    buildFixIntent(
      "fix",
      repo.session.id,
      ThreadId.parse("thread"),
      Array.from({ length: 20 }, (_, n) => ({
        ...comment,
        id: `finding-${n}`,
        suggestion: "x".repeat(8192),
      })),
    ),
  ).toThrow("review_fix_too_large");
  expect(() =>
    buildFixIntent("fix", repo.session.id, ThreadId.parse("thread"), [
      { ...comment, resolved: true },
    ]),
  ).toThrow("review_comment_unavailable");
});
it("reviewer output rejects malformed comments and unsafe paths", () => {
  for (const comments of [
    [{ text: "Missing position" }],
    [{ position: { file: "../escape", side: "new", start: 1, end: 1 }, text: "Unsafe" }],
    [{ position: { file: "file.ts", side: "new", start: 9, end: 1 }, text: "Backward" }],
  ])
    expect(() => parseReviewerOutput({ comments })).toThrow();
});
it("reviewer findings are anchored and imported atomically", async () => {
  let valid = false;
  const repo = await setup({
    async fix() {},
    async review() {
      return {
        comments: [
          {
            position: { file: "file.ts", side: "new", start: 3, end: 3 },
            text: "Reviewer finding",
          },
          ...(valid
            ? []
            : [
                {
                  position: { file: "file.ts", side: "new", start: 99, end: 99 },
                  text: "Invisible",
                },
              ]),
        ],
      };
    },
  });
  expect(
    (
      await repo.send({
        type: "review.askReviewer",
        sessionId: repo.session.id,
        threadId: "thread",
      })
    ).ok,
  ).toBe(false);
  expect(
    (await repo.send({ type: "review.list", sessionId: repo.session.id })).review?.comments,
  ).toEqual([]);
  valid = true;
  expect(
    (
      await repo.send({
        type: "review.askReviewer",
        sessionId: repo.session.id,
        threadId: "thread",
      })
    ).ok,
  ).toBe(true);
  expect(
    (await repo.send({ type: "review.list", sessionId: repo.session.id })).review?.comments?.[0]
      ?.text,
  ).toBe("Reviewer finding");
});
it("list cursors do not repeat comments and cross-session replies are rejected", async () => {
  const repo = await setup();
  const first = await repo.comment();
  await repo.comment();
  const page = (await repo.send({ type: "review.list", sessionId: repo.session.id, limit: 1 }))
    .review;
  const next = await repo.send({
    type: "review.list",
    sessionId: repo.session.id,
    limit: 1,
    cursor: page?.nextCursor,
  });
  expect(next.review?.comments?.[0]?.id).not.toBe(first.id);
  const opened = await repo.send({ type: "review.open", source: repo.session.source });
  expect(
    (
      await repo.send({
        type: "review.reply",
        sessionId: opened.review?.session?.id,
        commentId: first.id,
        text: "Wrong review",
      })
    ).ok,
  ).toBe(false);
});
