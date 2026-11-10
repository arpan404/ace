import { test, expect } from "vitest";
import { TeaReviews, teaReviewWrites } from "./tea-reviews.ts";
import { isAdmittedApiRequest } from "./read-only-api.ts";
import { WriteDispatch } from "./write-dispatch.ts";
const head = "a".repeat(40),
  base = "b".repeat(40);
const signal = new AbortController().signal;
const pr = {
  number: 7,
  title: "Feature",
  state: "open",
  user: { login: "author" },
  head: { sha: head, ref: "feature" },
  base: { sha: base, ref: "main" },
};
const comment = {
  id: 3,
  body: "Discussion",
  user: { login: "alice" },
  created_at: "2026-01-01",
  updated_at: "2026-01-02",
};
const review = {
  ...comment,
  id: 4,
  state: "COMMENT",
  submitted_at: "2026-01-01",
  comments_count: 1,
};
const inline = {
  ...comment,
  id: 5,
  path: "app.ts",
  position: 12,
  original_position: 10,
  commit_id: head,
  original_commit_id: base,
  resolver: { login: "alice" },
};
for (const forge of ["gitea", "forgejo"] as const) {
  function fixture() {
    const writes: { path: string | undefined; body: unknown }[] = [];
    let moved = false;
    let posted = "";
    const adapter = new TeaReviews({
      repository: { forge, host: "git.example", owner: "team", name: "app" },
      login: "work",
      runner: async (r) => {
        expect(isAdmittedApiRequest("tea", r, "work", teaReviewWrites)).toBe(true);
        const path = r.args[1] ?? "";
        let body: unknown;
        if (r.input) {
          r.dispatch?.prepare?.();
          r.dispatch?.record();
          posted = JSON.parse(r.input).body;
          writes.push({ path, body: JSON.parse(r.input) });
          body = { id: 6 };
        } else if (path === "user") body = { login: "alice" };
        else if (path === "repos/team/app") body = { archived: false, permissions: { push: true } };
        else if (path.includes("/reviews/4/comments?")) body = [inline];
        else if (path.includes("/reviews?")) body = [review];
        else if (path.includes("/comments?")) body = [{ ...comment, body: posted || comment.body }];
        else body = { ...pr, head: { ...pr.head, sha: moved ? base : head } };
        return {
          code: 0,
          stdout: JSON.stringify(body),
          truncated: false,
          http: { status: 200, headers: { "x-total-count": "1" } },
        };
      },
    });
    return {
      adapter,
      writes,
      move: () => {
        moved = true;
      },
    };
  }
  test(`${forge} maps conversation and inline comments with resolution and original anchors`, async () => {
    const { adapter } = fixture();
    expect(await adapter.conversation(7, signal)).toMatchObject({
      comments: [
        { kind: "issue", id: 3 },
        { kind: "review", id: 4 },
        { kind: "inline", id: 5 },
      ],
      reviewThreads: [
        {
          id: "5",
          resolved: true,
          file: "app.ts",
          line: 12,
          originalLine: 10,
          originalCommit: base,
        },
      ],
    });
  });
  test(`${forge} posts comments and replies only to inline comments on this PR`, async () => {
    const { adapter, writes } = fixture();
    await adapter.write(
      7,
      { kind: "conversation", body: "Hello" },
      [],
      "new",
      signal,
      () => true,
      new WriteDispatch(),
    );
    await adapter.write(
      7,
      { kind: "reply", commentId: 5, body: "Reply" },
      [],
      "reply",
      signal,
      () => true,
      new WriteDispatch(),
    );
    expect(writes).toMatchObject([
      {
        path: "repos/team/app/issues/7/comments",
        body: { body: "Hello\n\n<!-- ace-review-action:new -->" },
      },
      { path: "repos/team/app/pulls/7/comments/5/replies" },
    ]);
    await expect(
      adapter.write(
        7,
        { kind: "reply", commentId: 999, body: "Wrong" },
        [],
        "wrong",
        signal,
        () => true,
      ),
    ).rejects.toMatchObject({ kind: "not_found" });
    expect(writes).toHaveLength(2);
  });
  test(`${forge} pins new inline comments to the requested head and recovers a marked comment`, async () => {
    const { adapter, writes, move } = fixture();
    const action = {
      kind: "line.comment",
      headSha: head,
      body: "Line",
      anchor: { commit: head, path: "app.ts", line: 12, side: "RIGHT" },
    } as const;
    await adapter.write(7, action, [], "line", signal, () => true);
    expect(writes[0]).toMatchObject({
      path: "repos/team/app/pulls/7/reviews",
      body: {
        commit_id: head,
        event: "COMMENT",
        comments: [{ new_position: 12, old_position: 0 }],
      },
    });
    expect(await adapter.reconcile(7, action, "line", signal, [])).toBe(true);
    move();
    await expect(adapter.write(7, action, [], "stale", signal, () => true)).rejects.toMatchObject({
      kind: "head_moved",
    });
    expect(writes).toHaveLength(1);
  });
  test(`${forge} refuses changed permissions and header or method substitutions`, async () => {
    const { adapter, writes } = fixture();
    await expect(
      adapter.write(7, { kind: "conversation", body: "No" }, [], "denied", signal, () => false),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(writes).toEqual([]);
    for (const w of teaReviewWrites) {
      const endpoint = w.endpoint.source.includes("replies")
        ? "repos/team/app/pulls/7/comments/5/replies"
        : w.endpoint.source.includes("reviews")
          ? "repos/team/app/pulls/7/reviews"
          : "repos/team/app/issues/7/comments";
      const args = [
        "api",
        endpoint,
        "--method",
        "POST",
        "--login",
        "work",
        "--include",
        "--data",
        "@-",
      ];
      expect(isAdmittedApiRequest("tea", { command: "tea", args, input: "{}" }, "work", [w])).toBe(
        true,
      );
      expect(
        isAdmittedApiRequest(
          "tea",
          { command: "tea", args: [...args, "-H", "X-Test: value"], input: "{}" },
          "work",
          [w],
        ),
      ).toBe(false);
    }
  });
}
