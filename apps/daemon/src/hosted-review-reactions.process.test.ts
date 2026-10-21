import { expect, test } from "vitest";
import { reviewFixtures } from "@ace/forge/testing";
import { setupReview } from "./hosted-review-test-support.ts";

const empty = { hasNextPage: false, endCursor: null };
const heart = [{ content: "HEART", viewerHasReacted: true, reactors: { totalCount: 1 } }];

test("review state carries the PR's reactions, and still loads when they can't be read", async () => {
  const fixtures = reviewFixtures();
  fixtures["graphql:query PrReactions("] = [
    {
      body: {
        data: {
          repository: {
            pullRequest: { reactionGroups: heart, comments: { nodes: [], pageInfo: empty } },
          },
        },
      },
    },
    { status: 502 },
  ];
  fixtures["graphql:query PrReviewReactions("] = [
    {
      body: {
        data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: empty } } } },
      },
    },
  ];
  const review = await setupReview(fixtures);
  try {
    expect((await review.state()).reactions).toEqual([
      { subject: { kind: "pr" }, groups: [{ content: "heart", count: 1, viewer: true }] },
    ]);
    const degraded = await review.state();
    expect(degraded.reactions).toBeNull();
    expect(degraded.canComment).toBe(true);
  } finally {
    await review.cleanup();
  }
});

test("a reviewer is requested from the PR panel's workspace without any linked task", async () => {
  const fixtures = reviewFixtures();
  fixtures["repos/octo/ace/pulls/7/requested_reviewers"] = [
    { status: 201, body: { number: 7, requested_reviewers: [{ login: "ana" }] } },
  ];
  const review = await setupReview(fixtures);
  try {
    expect(
      await review.send("request", { kind: "reviewers.request", reviewers: ["ana"] }),
    ).toMatchObject({ ok: true });
    expect((await review.state()).operations).toEqual([{ id: "request", state: "accepted" }]);
  } finally {
    await review.cleanup();
  }
});
