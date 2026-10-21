import { expect, test } from "vitest";
import { fakeGh, reviewFixtures } from "./testing/fixtures.ts";
const signal = () => new AbortController().signal;
const allowed = () => true;
const groups = (heart: number, viewer = false) => [
  { content: "HEART", viewerHasReacted: viewer, reactors: { totalCount: heart } },
  { content: "THUMBS_DOWN", viewerHasReacted: false, reactors: { totalCount: 0 } },
  { content: "FUTURE_KIND", viewerHasReacted: false, reactors: { totalCount: 3 } },
];
const pageInfo = (hasNextPage: boolean, endCursor: string | null) => ({ hasNextPage, endCursor });

test("reactions read for the description, conversation and inline comments, with the viewer's own", async () => {
  const fixtures = reviewFixtures();
  fixtures["graphql:query PrReactions("] = [
    {
      body: {
        data: {
          repository: {
            pullRequest: {
              reactionGroups: groups(2, true),
              comments: {
                nodes: [{ databaseId: 5, reactionGroups: groups(0) }],
                pageInfo: pageInfo(true, "c1"),
              },
            },
          },
        },
      },
    },
    {
      body: {
        data: {
          repository: {
            pullRequest: {
              reactionGroups: groups(2, true),
              comments: {
                nodes: [{ databaseId: 6, reactionGroups: groups(1) }],
                pageInfo: pageInfo(false, null),
              },
            },
          },
        },
      },
    },
  ];
  fixtures["graphql:query PrReviewReactions("] = [
    {
      body: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{ comments: { nodes: [{ databaseId: 9, reactionGroups: groups(4) }] } }],
                pageInfo: pageInfo(false, null),
              },
            },
          },
        },
      },
    },
  ];
  const f = await fakeGh(fixtures);
  try {
    expect(await f.forge.reviews.reactions(7, signal())).toEqual([
      { subject: { kind: "pr" }, groups: [{ content: "heart", count: 2, viewer: true }] },
      {
        subject: { kind: "issue", commentId: 6 },
        groups: [{ content: "heart", count: 1, viewer: false }],
      },
      {
        subject: { kind: "inline", commentId: 9 },
        groups: [{ content: "heart", count: 4, viewer: false }],
      },
    ]);
  } finally {
    await f.cleanup();
  }
});

test("adding a reaction posts to the endpoint of what it's on and reconciles from GitHub's list", async () => {
  const cases = [
    { subject: { kind: "pr" as const }, path: "repos/octo/ace/issues/7/reactions" },
    {
      subject: { kind: "issue" as const, commentId: 5 },
      path: "repos/octo/ace/issues/comments/5/reactions",
    },
    {
      subject: { kind: "inline" as const, commentId: 5 },
      path: "repos/octo/ace/pulls/comments/5/reactions",
    },
  ];
  for (const { subject, path } of cases) {
    const fixtures = reviewFixtures();
    const comment = { id: 5, body: "Nice", user: { login: "author" } };
    fixtures["repos/octo/ace/issues/7/comments?per_page=100"] = [{ body: [comment] }];
    fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [{ body: [comment] }];
    const reaction = { id: 40, content: "rocket", user: { login: "reviewer" } };
    fixtures[path] = [{ status: 201, body: reaction }];
    fixtures[`${path}?content=rocket&per_page=100`] = [
      { body: [{ id: 41, content: "rocket", user: { login: "author" } }, reaction] },
    ];
    const action = { kind: "reaction.add" as const, subject, content: "rocket" as const };
    const f = await fakeGh(fixtures);
    try {
      await f.forge.reviews.write(7, action, [], "react", signal(), allowed);
      expect(
        (await f.requests()).find((r) => r.path === path && r.args.includes("POST"))?.body,
      ).toEqual({ content: "rocket" });
      expect(await f.forge.reviews.reconcile(7, action, "react", signal())).toBe(true);
    } finally {
      await f.cleanup();
    }
  }
});

test("removing a reaction deletes only the viewer's own, and reconciles once it's gone", async () => {
  const fixtures = reviewFixtures();
  const list = "repos/octo/ace/issues/7/reactions?content=%2B1&per_page=100";
  fixtures[list] = [
    {
      body: [
        { id: 41, content: "+1", user: { login: "author" } },
        { id: 42, content: "+1", user: { login: "reviewer" } },
      ],
    },
    { body: [{ id: 41, content: "+1", user: { login: "author" } }] },
  ];
  fixtures["repos/octo/ace/issues/7/reactions/42"] = [{ status: 204 }];
  const action = { kind: "reaction.remove" as const, subject: { kind: "pr" as const }, content: "+1" as const };
  const f = await fakeGh(fixtures);
  try {
    await f.forge.reviews.write(7, action, [], "unreact", signal(), allowed);
    expect(await f.forge.reviews.reconcile(7, action, "unreact", signal())).toBe(true);
    const deletes = (await f.requests()).filter((r) => r.args.includes("DELETE"));
    expect(deletes.map((r) => r.path)).toEqual(["repos/octo/ace/issues/7/reactions/42"]);
  } finally {
    await f.cleanup();
  }
});

test("a reaction on a comment from another PR is refused without writing", async () => {
  const fixtures = reviewFixtures();
  fixtures["repos/octo/ace/issues/7/comments?per_page=100"] = [{ body: [] }];
  const f = await fakeGh(fixtures);
  try {
    await expect(
      f.forge.reviews.write(
        7,
        { kind: "reaction.add", subject: { kind: "issue", commentId: 99 }, content: "eyes" },
        [],
        "react",
        signal(),
        allowed,
      ),
    ).rejects.toMatchObject({ kind: "not_found" });
    expect((await f.requests()).some((r) => r.path.includes("reactions"))).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("requesting reviewers posts them to the PR and reconciles from its requested reviewers", async () => {
  const fixtures = reviewFixtures();
  const path = "repos/octo/ace/pulls/7/requested_reviewers";
  fixtures[path] = [
    { status: 201, body: { number: 7, requested_reviewers: [{ login: "Ana" }] } },
    { body: { users: [{ login: "Ana" }, { login: "bo" }], teams: [] } },
  ];
  const action = { kind: "reviewers.request" as const, reviewers: ["ana", "bo"] };
  const f = await fakeGh(fixtures);
  try {
    await f.forge.reviews.write(7, action, [], "request", signal(), allowed);
    expect(await f.forge.reviews.reconcile(7, action, "request", signal())).toBe(true);
    expect(
      (await f.requests()).find((r) => r.path === path && r.args.includes("POST"))?.body,
    ).toEqual({ reviewers: ["ana", "bo"] });
  } finally {
    await f.cleanup();
  }
});
