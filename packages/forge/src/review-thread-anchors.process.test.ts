import { expect, it } from "vitest";
import { fakeGh, standard, threads } from "./testing/fixtures.ts";

const signal = () => new AbortController().signal;
const node = (overrides: Record<string, unknown> = {}) => ({
  id: "T1",
  isResolved: false,
  isOutdated: false,
  path: "src/main.ts",
  line: 14,
  startLine: 12,
  diffSide: "RIGHT",
  comments: {
    nodes: [
      {
        databaseId: 1,
        body: "Split this block",
        updatedAt: "2026-10-02T10:05:00Z",
        createdAt: "2026-10-02T10:00:00Z",
        author: { login: "alice", avatarUrl: "https://avatars.example/alice" },
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  ...overrides,
});

it("a multi-line thread reports its side, first line, and each comment's avatar and creation time", async () => {
  const fixtures = standard();
  fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [{ body: [] }];
  fixtures.graphql = [{ body: threads([node()]) }];
  const fake = await fakeGh(fixtures);
  try {
    const [thread] = (await fake.forge.status(7, signal())).reviewThreads;
    expect(thread).toMatchObject({ file: "src/main.ts", line: 14, startLine: 12, side: "RIGHT" });
    expect(thread?.comments[0]).toMatchObject({
      author: "alice",
      authorAvatarUrl: "https://avatars.example/alice",
      createdAt: "2026-10-02T10:00:00Z",
    });
  } finally {
    await fake.cleanup();
  }
});

it("a thread whose side changes between polls is reported with the new side", async () => {
  const fixtures = standard();
  fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [{ body: [] }];
  fixtures.graphql = [
    { body: threads([node()]) },
    { body: threads([node({ diffSide: "LEFT", startLine: null })]) },
  ];
  const fake = await fakeGh(fixtures);
  try {
    expect((await fake.forge.status(7, signal())).reviewThreads[0]?.side).toBe("RIGHT");
    const after = (await fake.forge.status(7, signal())).reviewThreads[0];
    expect(after).toMatchObject({ side: "LEFT", startLine: null });
  } finally {
    await fake.cleanup();
  }
});

it("a thread from a host that reports no side leaves the side unknown", async () => {
  const fixtures = standard();
  fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [{ body: [] }];
  fixtures.graphql = [{ body: threads([node({ diffSide: undefined, startLine: undefined })]) }];
  const fake = await fakeGh(fixtures);
  try {
    const [thread] = (await fake.forge.status(7, signal())).reviewThreads;
    expect(thread?.side).toBeUndefined();
    expect(thread?.startLine).toBeNull();
  } finally {
    await fake.cleanup();
  }
});

it("a thread that starts on the deleted side and ends on the added side reports both sides", async () => {
  const fixtures = standard();
  fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [{ body: [] }];
  fixtures.graphql = [
    { body: threads([node({ startLine: 9, startDiffSide: "LEFT", diffSide: "RIGHT" })]) },
  ];
  const fake = await fakeGh(fixtures);
  try {
    const [thread] = (await fake.forge.status(7, signal())).reviewThreads;
    expect(thread).toMatchObject({ startLine: 9, startSide: "LEFT", side: "RIGHT", line: 14 });
  } finally {
    await fake.cleanup();
  }
});
