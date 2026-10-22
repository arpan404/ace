import { expect, test } from "vitest";
import { fakeGh, reviewFixtures, type Fixtures } from "./testing/fixtures.ts";
const signal = () => new AbortController().signal;
const allowed = () => true;
const pageInfo = { hasNextPage: false, endCursor: null };
const visibility = "graphql:query CommentVisibility(";
const state = (isMinimized: boolean, minimizedReason: string | null, viewerCanMinimize = true) => ({
  body: { data: { node: { isMinimized, minimizedReason, viewerCanMinimize } } },
});
const mutations = async (f: Awaited<ReturnType<typeof fakeGh>>) =>
  (await f.requests())
    .map((r) => r.body)
    .filter(
      (b): b is { query: string; variables: unknown } =>
        typeof b === "object" &&
        b !== null &&
        "query" in b &&
        typeof b.query === "string" &&
        b.query.startsWith("mutation"),
    );
const node = (databaseId: number, isMinimized: boolean, reason: string | null, can: boolean) => ({
  databaseId,
  reactionGroups: [],
  isMinimized,
  minimizedReason: reason,
  viewerCanMinimize: can,
});
function withComment(source: "issue" | "inline"): Fixtures {
  const fixtures = reviewFixtures();
  const comment = { id: 5, node_id: "IC_5", body: "Old note", user: { login: "reviewer" } };
  fixtures[`repos/octo/ace/${source === "inline" ? "pulls" : "issues"}/7/comments?per_page=100`] = [
    { body: [comment] },
  ];
  for (const name of ["minimizeComment", "unminimizeComment"])
    fixtures[`graphql:mutation($input:${name[0]?.toUpperCase()}${name.slice(1)}Input!`] = [
      { body: { data: { [name]: { clientMutationId: name } } } },
    ];
  return fixtures;
}

test("hiding a comment minimizes it by node id with GitHub's classifier, and unhiding shows it again", async () => {
  for (const source of ["issue", "inline"] as const) {
    const fixtures = withComment(source);
    fixtures[visibility] = [
      state(false, null),
      state(true, "OFF_TOPIC"),
      state(true, "off-topic"),
      state(false, null),
    ];
    const f = await fakeGh(fixtures);
    const hide = { kind: "comment.hide", commentId: 5, source, reason: "off-topic" } as const;
    const unhide = { kind: "comment.unhide", commentId: 5, source } as const;
    try {
      await f.forge.reviews.write(7, hide, [], "hide", signal(), allowed);
      expect(await f.forge.reviews.reconcile(7, hide, "hide", signal())).toBe(true);
      await f.forge.reviews.write(7, unhide, [], "unhide", signal(), allowed);
      expect(await f.forge.reviews.reconcile(7, unhide, "unhide", signal())).toBe(true);
      expect(await mutations(f)).toEqual([
        {
          query: expect.stringContaining("minimizeComment(input:$input)"),
          variables: {
            input: { subjectId: "IC_5", classifier: "OFF_TOPIC", clientMutationId: "hide" },
          },
        },
        {
          query: expect.stringContaining("unminimizeComment(input:$input)"),
          variables: { input: { subjectId: "IC_5", clientMutationId: "unhide" } },
        },
      ]);
    } finally {
      await f.cleanup();
    }
  }
});

test("a comment hidden for another reason doesn't reconcile as this hide", async () => {
  const fixtures = withComment("issue");
  fixtures[visibility] = [state(true, "spam")];
  const f = await fakeGh(fixtures);
  try {
    const hide = {
      kind: "comment.hide",
      commentId: 5,
      source: "issue",
      reason: "outdated",
    } as const;
    expect(await f.forge.reviews.reconcile(7, hide, "hide", signal())).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("hiding is refused without a mutation when the viewer can't, or the comment isn't this PR's", async () => {
  const forbidden = withComment("issue");
  forbidden[visibility] = [state(false, null, false)];
  const foreign = withComment("issue");
  const hide = { kind: "comment.hide", source: "issue", reason: "outdated" } as const;
  for (const [fixtures, commentId, kind] of [
    [forbidden, 5, "forbidden"],
    [foreign, 99, "not_found"],
  ] as const) {
    const f = await fakeGh(fixtures);
    try {
      await expect(
        f.forge.reviews.write(7, { ...hide, commentId }, [], "hide", signal(), allowed),
      ).rejects.toMatchObject({ kind });
      expect(await mutations(f)).toEqual([]);
    } finally {
      await f.cleanup();
    }
  }
});

test("review decorations report hidden comments with their reason and the ones the viewer may hide", async () => {
  const fixtures = reviewFixtures();
  fixtures["graphql:query PrReactions("] = [
    {
      body: {
        data: {
          repository: {
            pullRequest: {
              reactionGroups: [],
              comments: {
                nodes: [node(5, true, "OUTDATED", true), node(6, false, null, false)],
                pageInfo,
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
                nodes: [{ comments: { nodes: [node(9, true, "abuse", false)] } }],
                pageInfo,
              },
            },
          },
        },
      },
    },
  ];
  const f = await fakeGh(fixtures);
  try {
    const read = await f.forge.reviews.decorations(7, signal());
    expect(read.hidden).toEqual([
      { source: "issue", commentId: 5, reason: "outdated" },
      { source: "inline", commentId: 9, reason: "abuse" },
    ]);
    expect(read.hideable).toEqual([{ source: "issue", commentId: 5 }]);
  } finally {
    await f.cleanup();
  }
});

test("a host that doesn't report comment visibility leaves hidden and hideable unread", async () => {
  const fixtures = reviewFixtures();
  fixtures["graphql:query PrReactions("] = [
    {
      body: {
        data: {
          repository: {
            pullRequest: {
              reactionGroups: [],
              comments: { nodes: [{ databaseId: 5, reactionGroups: [] }], pageInfo },
            },
          },
        },
      },
    },
  ];
  fixtures["graphql:query PrReviewReactions("] = [
    { body: { data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo } } } } } },
  ];
  const f = await fakeGh(fixtures);
  try {
    expect(await f.forge.reviews.decorations(7, signal())).toEqual({
      reactions: [],
      hidden: null,
      hideable: null,
    });
  } finally {
    await f.cleanup();
  }
});

test("a comment whose node id isn't one GitHub issues is never sent to a mutation", async () => {
  const fixtures = withComment("issue");
  fixtures["repos/octo/ace/issues/7/comments?per_page=100"] = [
    { body: [{ id: 5, node_id: "IC_5 } bad", body: "Old note", user: { login: "reviewer" } }] },
  ];
  fixtures[visibility] = [state(false, null)];
  const f = await fakeGh(fixtures);
  try {
    const hide = { kind: "comment.hide", commentId: 5, source: "issue", reason: "spam" } as const;
    await expect(
      f.forge.reviews.write(7, hide, [], "hide", signal(), allowed),
    ).rejects.toMatchObject({ kind: "invalid_data" });
    expect(await mutations(f)).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
