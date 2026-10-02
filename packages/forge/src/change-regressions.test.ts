import { expect, it } from "vitest";
import { ReviewIndex } from "./index.ts";
import { fakeGh, standard, comment, repository, threads } from "./testing/fixtures.ts";

it("editing one page preserves other feedback versions and current candidate identities", async () => {
  const fixtures = standard();
  const first = Array.from({ length: 100 }, (_, i) => ({ ...comment, id: i + 1 }));
  const later = Array.from({ length: 100 }, (_, i) => ({ ...comment, id: i + 101 }));
  fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [
    {
      body: first,
      headers: {
        Link: '<https://api.github.com/repos/octo/ace/pulls/7/comments?page=2>; rel="next"',
      },
    },
    {
      body: [{ ...comment, id: 1, body: "Edited feedback" }, ...first.slice(1)],
      headers: {
        Link: '<https://api.github.com/repos/octo/ace/pulls/7/comments?page=2>; rel="next"',
      },
    },
  ];
  fixtures["repos/octo/ace/pulls/7/comments?page=2"] = [
    { body: later, headers: { ETag: '"later"' } },
    { status: 304, raw: "" },
  ];
  fixtures.graphql = [{ body: threads() }];
  const fake = await fakeGh(fixtures);
  try {
    const before = await fake.forge.status(7, new AbortController().signal);
    const index = new ReviewIndex(
      { link: { threadId: "change", pr: { repository, number: 7 } }, generation: 1 },
      new Set(),
      fake.forge.revisions,
    );
    index.update(before);
    const candidates = [...index.pending()];
    for (const item of candidates) index.observe(item.key);
    const stable = candidates.find((item) => item.type === "review" && item.comment.id === 101);
    if (!stable) throw new Error("Missing stable feedback");
    const after = await fake.forge.status(7, new AbortController().signal);
    expect(after.comments[100]).toBe(before.comments[100]);
    expect(after.comments[1]).toBe(before.comments[1]);
    index.update(after);
    expect(index.get(stable.key)).toBe(stable);
    expect(
      [...index.pending()].map((item) => (item.type === "review" ? item.comment.body : "CI")),
    ).toEqual(["Edited feedback"]);
  } finally {
    await fake.cleanup();
  }
});

it("resolving one review thread preserves other feedback versions and candidate identities", async () => {
  const fixtures = standard();
  fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [{ body: [] }];
  const nodes = Array.from({ length: 2 }, (_, index) => ({
    id: `T${index}`,
    isResolved: false,
    isOutdated: false,
    path: "src/main.ts",
    line: 12,
    comments: {
      nodes: [
        {
          databaseId: index + 1,
          body: `Feedback ${index}`,
          updatedAt: "now",
          author: { login: "alice" },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  }));
  fixtures.graphql = [
    { body: threads(nodes) },
    {
      body: threads(
        nodes.map((node, index) =>
          index === 0 ? Object.assign({}, node, { isResolved: true }) : node,
        ),
      ),
    },
  ];
  const fake = await fakeGh(fixtures);
  try {
    const before = await fake.forge.status(7, new AbortController().signal);
    const index = new ReviewIndex(
      { link: { threadId: "threads", pr: { repository, number: 7 } }, generation: 1 },
      new Set(),
      fake.forge.revisions,
    );
    index.update(before);
    const all = [...index.pending()];
    for (const candidate of all) index.observe(candidate.key);
    const first = all.find((item) => item.type === "review" && item.comment.id === 1);
    const stable = all.find((item) => item.type === "review" && item.comment.id === 2);
    if (!first || !stable) throw new Error("Missing review feedback");
    const after = await fake.forge.status(7, new AbortController().signal);
    expect(after.reviewThreads[0]?.resolved).toBe(true);
    expect(after.reviewThreads[1]).toBe(before.reviewThreads[1]);
    index.update(after);
    expect(index.get(first.key)).toBeUndefined();
    expect(index.get(stable.key)).toBe(stable);
    expect([...index.pending()]).toEqual([]);
  } finally {
    await fake.cleanup();
  }
});
