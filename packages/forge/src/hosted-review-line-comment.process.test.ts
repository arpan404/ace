import { expect, test } from "vitest";
import { fakeGh, inlineDraft, reviewFixtures, reviewHost, sha } from "./testing/fixtures.ts";
import { reviewWriteMarker } from "./index.ts";
const signal = () => new AbortController().signal;
const allowed = () => true;
const write = "repos/octo/ace/pulls/7/comments";
const action = {
  kind: "line.comment" as const,
  headSha: sha,
  anchor: { commit: sha, path: "src/main.ts", line: 1, side: "RIGHT" as const },
  body: "Rename this",
};

test("a line comment posts exactly one inline comment at its anchor and never submits a review", async () => {
  const fixtures = reviewFixtures();
  const body = `Rename this\n\n${reviewWriteMarker("line")}`;
  const posted = { id: 30, body, path: "src/main.ts", user: { login: "reviewer" } };
  fixtures[write] = [{ status: 201, body: posted }];
  fixtures[`${write}?per_page=100`] = [{ body: [posted] }];
  const f = await fakeGh(fixtures);
  try {
    await f.forge.reviews.write(7, action, [], "line", signal(), allowed);
    expect(await f.forge.reviews.reconcile(7, action, "line", signal())).toBe(true);
    const requests = await f.requests();
    const posts = requests.filter((r) => r.path !== "graphql" && r.args.includes("POST"));
    expect(posts.map((r) => [r.path, r.body])).toEqual([
      [write, { commit_id: sha, path: "src/main.ts", line: 1, side: "RIGHT", body }],
    ]);
    expect(requests.some((r) => r.path.includes("/reviews"))).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("a multi-line comment sends its start line and side", async () => {
  const fixtures = reviewFixtures();
  fixtures["repos/octo/ace/pulls/7/files?per_page=100"] = [
    { body: [{ filename: "src/main.ts", patch: "@@ -1,2 +1,2 @@\n-a\n-b\n+c\n+d" }] },
  ];
  fixtures[write] = [{ status: 201, body: { id: 31, body: "x", user: { login: "reviewer" } } }];
  const f = await fakeGh(fixtures);
  try {
    await f.forge.reviews.write(
      7,
      { ...action, anchor: { ...action.anchor, line: 2, startLine: 1 } },
      [],
      "range",
      signal(),
      allowed,
    );
    expect((await f.requests()).find((r) => r.path === write)?.body).toMatchObject({
      line: 2,
      side: "RIGHT",
      start_line: 1,
      start_side: "RIGHT",
    });
  } finally {
    await f.cleanup();
  }
});

test("a line comment is refused without writing when it is handed drafts, the head moved, or the line isn't in the patch", async () => {
  const cases = [
    { name: "drafts", drafts: [inlineDraft], move: false, anchor: action.anchor },
    { name: "moved", drafts: [], move: true, anchor: action.anchor },
    { name: "off-patch", drafts: [], move: false, anchor: { ...action.anchor, line: 9 } },
  ];
  for (const c of cases) {
    const fixtures = reviewFixtures();
    if (c.move)
      fixtures["graphql:viewer { login }"] = [{ body: reviewHost({ headRefOid: "f".repeat(40) }) }];
    fixtures[write] = [{ status: 201, body: { id: 32, body: "x", user: { login: "reviewer" } } }];
    const f = await fakeGh(fixtures);
    try {
      await expect(
        f.forge.reviews.write(
          7,
          { ...action, anchor: c.anchor },
          c.drafts,
          c.name,
          signal(),
          allowed,
        ),
      ).rejects.toMatchObject({ kind: "conflict" });
      expect((await f.requests()).some((r) => r.path === write)).toBe(false);
    } finally {
      await f.cleanup();
    }
  }
});

test("a line comment reconciles only from the viewer's comment carrying its marker", async () => {
  const fixtures = reviewFixtures();
  fixtures[`${write}?per_page=100`] = [
    {
      body: [
        { id: 33, body: "Rename this", path: "src/main.ts", user: { login: "reviewer" } },
        {
          id: 34,
          body: `copied ${reviewWriteMarker("line")}`,
          path: "src/main.ts",
          user: { login: "someone" },
        },
      ],
    },
  ];
  const f = await fakeGh(fixtures);
  try {
    expect(await f.forge.reviews.reconcile(7, action, "line", signal())).toBe(false);
  } finally {
    await f.cleanup();
  }
});
