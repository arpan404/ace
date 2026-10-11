import { expect, test } from "vitest";
import { fakeGh, sha, nextSha } from "./testing/fixtures.ts";
import { reviewWriteMarker } from "./index.ts";
const signal = () => new AbortController().signal;
const host = (head = sha, own = false) => ({
  data: {
    viewer: { login: "reviewer" },
    repository: {
      pullRequest: {
        id: "PR_7",
        headRefOid: head,
        state: "OPEN",
        viewerDidAuthor: own,
        locked: false,
        viewerCanUpdate: false,
        reviewThreads: {
          nodes: [
            { id: "T_7", isResolved: false, viewerCanResolve: true, viewerCanUnresolve: false },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  },
});
const draft = {
  id: "draft",
  body: "Preserve both lines",
  anchor: {
    commit: sha,
    path: "src/main.ts",
    side: "RIGHT",
    startSide: "RIGHT",
    startLine: 1,
    line: 2,
  },
} as const;
const result = {
  id: 77,
  body: "Reviewed",
  commit_id: sha,
  state: "COMMENTED",
  user: { login: "reviewer" },
};

test("a hosted review publishes the selected commit, side and line range as one review", async () => {
  const f = await fakeGh({
    graphql: [{ body: host() }],
    "repos/octo/ace/pulls/7/files?per_page=100": [
      { body: [{ filename: "src/main.ts", patch: "@@ -1 +1,2 @@\n-old\n+new\n+second" }] },
    ],
    "repos/octo/ace/pulls/7/reviews": [{ body: result }],
  });
  try {
    await f.forge.reviews.write(
      7,
      { kind: "submit", event: "COMMENT", headSha: sha, body: "Reviewed", draftIds: ["draft"] },
      [draft],
      "write-1",
      signal(),
      () => true,
    );
    const published = (await f.requests()).find((r) => r.path === "repos/octo/ace/pulls/7/reviews");
    expect(published?.body).toEqual({
      commit_id: sha,
      event: "COMMENT",
      body: `Reviewed\n\n${reviewWriteMarker("write-1")}`,
      comments: [
        {
          path: "src/main.ts",
          line: 2,
          side: "RIGHT",
          start_line: 1,
          start_side: "RIGHT",
          body: "Preserve both lines",
        },
      ],
    });
  } finally {
    await f.cleanup();
  }
});

test("a moved head and missing diff range never publish an inline review", async () => {
  for (const head of [nextSha, sha]) {
    const f = await fakeGh({
      graphql: [{ body: host(head) }],
      "repos/octo/ace/pulls/7/files?per_page=100": [
        { body: [{ filename: "src/main.ts", patch: "@@ -1 +1 @@\n-old\n+new" }] },
      ],
    });
    try {
      await expect(
        f.forge.reviews.write(
          7,
          { kind: "submit", event: "COMMENT", headSha: sha, body: "Review", draftIds: ["draft"] },
          [draft],
          "stale",
          signal(),
          () => true,
        ),
      ).rejects.toMatchObject({ kind: "conflict" });
      expect((await f.requests()).some((r) => r.path === "repos/octo/ace/pulls/7/reviews")).toBe(
        false,
      );
    } finally {
      await f.cleanup();
    }
  }
});

test("review reconciliation recognizes the original accepted write without publishing it again", async () => {
  const f = await fakeGh({
    graphql: [{ body: host() }],
    "repos/octo/ace/pulls/7/reviews?per_page=100": [
      { body: [{ ...result, body: `Reviewed\n\n${reviewWriteMarker("lost")}` }] },
    ],
  });
  try {
    expect(
      await f.forge.reviews.reconcile(
        7,
        { kind: "submit", event: "COMMENT", headSha: sha, body: "Reviewed", draftIds: [] },
        "lost",
        signal(),
      ),
    ).toBe(true);
    expect(
      (await f.requests()).every(
        (r) => !r.args.includes("PATCH") && (r.path === "graphql" || r.args.includes("GET")),
      ),
    ).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("another user's comment cannot be edited even when the client asks for it", async () => {
  const f = await fakeGh({
    graphql: [{ body: host() }],
    "repos/octo/ace/issues/7/comments?per_page=100": [
      { body: [{ id: 5, body: "Original", user: { login: "author" } }] },
    ],
  });
  try {
    await expect(
      f.forge.reviews.write(
        7,
        {
          kind: "comment.edit",
          source: "issue",
          commentId: 5,
          expectedBody: "Original",
          body: "Changed",
        },
        [],
        "edit",
        signal(),
        () => true,
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect((await f.requests()).some((r) => r.args.includes("PATCH"))).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("resolution only accepts a thread from the selected PR and host permission", async () => {
  const f = await fakeGh({ graphql: [{ body: host() }] });
  try {
    await expect(
      f.forge.reviews.write(
        7,
        { kind: "thread.resolve", threadId: "OTHER_PR" },
        [],
        "resolve",
        signal(),
        () => true,
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(
      (await f.requests()).some(
        (r) =>
          typeof r.body === "object" &&
          r.body !== null &&
          "query" in r.body &&
          typeof r.body.query === "string" &&
          r.body.query.trimStart().startsWith("mutation"),
      ),
    ).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("GitHub viewed marks are read from the host and checked against the selected head", async () => {
  const viewed = {
    data: {
      repository: {
        pullRequest: {
          headRefOid: sha,
          files: {
            nodes: [{ path: "src/main.ts", viewerViewedState: "VIEWED" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  };
  const f = await fakeGh({ graphql: [{ body: viewed }] });
  try {
    expect(await f.forge.reviews.viewed(7, sha, signal())).toEqual([
      { path: "src/main.ts", state: "VIEWED" },
    ]);
    await expect(f.forge.reviews.viewed(7, nextSha, signal())).rejects.toMatchObject({
      kind: "conflict",
    });
  } finally {
    await f.cleanup();
  }
});
