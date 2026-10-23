import { expect, test } from "vitest";
import { inlineDraft, reviewFixtures, sha, type Fixtures } from "@ace/forge/testing";
import { setupReview } from "./hosted-review-test-support.ts";

const pageInfo = { hasNextPage: false, endCursor: null };
const comments = "repos/octo/ace/issues/7/comments?per_page=100";
const visibility = "graphql:query CommentVisibility(";
const minimize = "graphql:mutation($input:MinimizeCommentInput!";
const unminimize = "graphql:mutation($input:UnminimizeCommentInput!";
const shown = {
  body: { data: { node: { isMinimized: false, minimizedReason: null, viewerCanMinimize: true } } },
};
function hideFixtures(): Fixtures {
  const fixtures = reviewFixtures();
  fixtures[comments] = [
    {
      body: [
        { id: 5, node_id: "IC_5", body: "Old note", user: { login: "reviewer" } },
        { id: 6, node_id: "IC_6", body: "Other", user: { login: "reviewer" } },
      ],
    },
  ];
  fixtures[visibility] = [shown];
  return fixtures;
}

test("a line comment posts on its own and leaves every pending draft unsent and saved", async () => {
  const fixtures = reviewFixtures();
  fixtures["repos/octo/ace/pulls/7/comments"] = [
    {
      status: 201,
      body: { id: 30, body: "Rename", path: "src/main.ts", user: { login: "reviewer" } },
    },
  ];
  const review = await setupReview(fixtures);
  try {
    await review.send("save", { kind: "draft.save", draft: inlineDraft });
    const anchor = { commit: sha, path: "src/main.ts", line: 1, side: "RIGHT" as const };
    expect(
      await review.send("line", { kind: "line.comment", headSha: sha, anchor, body: "Rename" }),
    ).toMatchObject({ ok: true });
    const state = await review.state();
    expect(state.drafts).toEqual([inlineDraft]);
    expect(state.operations).toEqual([{ id: "line", state: "accepted" }]);
    const writes = (await review.gh.requests()).filter(
      (r) => r.path !== "graphql" && r.args.includes("POST"),
    );
    expect(writes.map((r) => r.path)).toEqual(["repos/octo/ace/pulls/7/comments"]);
    expect(JSON.stringify(writes[0]?.body)).not.toContain(inlineDraft.body);
  } finally {
    await review.cleanup();
  }
});

test("while hiding a comment is uncertain, showing that comment waits but another comment can still be hidden", async () => {
  const fixtures = hideFixtures();
  fixtures[minimize] = [
    { status: 502 },
    { body: { data: { minimizeComment: { clientMutationId: "x" } } } },
  ];
  fixtures[unminimize] = [{ body: { data: { unminimizeComment: { clientMutationId: "y" } } } }];
  const review = await setupReview(fixtures);
  try {
    expect(
      await review.send("hide", {
        kind: "comment.hide",
        commentId: 5,
        source: "issue",
        reason: "outdated",
      }),
    ).toMatchObject({ ok: false, error: "action_outcome_uncertain" });
    expect(
      await review.send("show", { kind: "comment.unhide", commentId: 5, source: "issue" }),
    ).toMatchObject({ ok: false, error: "action_outcome_uncertain" });
    expect(
      (await review.gh.requests()).some((r) =>
        String(JSON.stringify(r.body)).includes("unminimizeComment"),
      ),
    ).toBe(false);
    expect(
      await review.send("other", {
        kind: "comment.hide",
        commentId: 6,
        source: "issue",
        reason: "spam",
      }),
    ).toMatchObject({ ok: true });
    expect((await review.state()).operations).toEqual([
      { id: "hide", state: "uncertain" },
      { id: "other", state: "accepted" },
    ]);
  } finally {
    await review.cleanup();
  }
});

test("review state lists hidden comments and the ones the viewer may hide, and loads when they can't be read", async () => {
  const fixtures = reviewFixtures();
  fixtures["graphql:query PrReactions("] = [
    {
      body: {
        data: {
          repository: {
            pullRequest: {
              reactionGroups: [],
              comments: {
                nodes: [
                  {
                    databaseId: 5,
                    reactionGroups: [],
                    isMinimized: true,
                    minimizedReason: "outdated",
                    viewerCanMinimize: true,
                  },
                ],
                pageInfo,
              },
            },
          },
        },
      },
    },
    { status: 502 },
  ];
  fixtures["graphql:query PrReviewReactions("] = [
    { body: { data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo } } } } } },
  ];
  const review = await setupReview(fixtures);
  try {
    expect(await review.state()).toMatchObject({
      hidden: [{ source: "issue", commentId: 5, reason: "outdated" }],
      hideable: [{ source: "issue", commentId: 5 }],
    });
    expect(await review.state()).toMatchObject({ hidden: null, hideable: null, canComment: true });
  } finally {
    await review.cleanup();
  }
});
