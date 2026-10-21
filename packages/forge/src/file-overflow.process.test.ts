import { expect, test } from "vitest";
import { fakeGh, pr, sha, nextSha } from "./testing/fixtures.ts";

const signal = () => new AbortController().signal;
const id = (digit: string) => digit.repeat(40);
const blob = (path: string, digit: string) => ({ path, type: "blob", sha: id(digit) });
const tree = (path: string, digit: string) => ({ path, type: "tree", sha: id(digit) });
const listed = (filename: string) => ({
  filename,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-old\n+new",
});
const big = {
  ...pr,
  base: { ref: "main", sha: nextSha },
  head: { ...pr.head, repo: null },
  body: null,
  user: null,
  labels: [],
  requested_reviewers: [],
  commits: 1,
  changed_files: 3_004,
};
const fixtures = {
  [`repos/octo/ace/compare/${nextSha}...${sha}`]: [
    { body: { merge_base_commit: { sha: nextSha } } },
  ],
  "repos/octo/ace/pulls/7": [{ body: big }],
  "repos/octo/ace/pulls/7/files?per_page=25&page=120": [{ body: [listed("src/m.ts")] }],
  [`repos/octo/ace/git/commits/${nextSha}`]: [{ body: { sha: nextSha, tree: { sha: id("1") } } }],
  [`repos/octo/ace/git/commits/${sha}`]: [{ body: { sha, tree: { sha: id("2") } } }],
  [`repos/octo/ace/git/trees/${id("1")}`]: [
    { body: { sha: id("1"), tree: [tree("src", "3"), blob("README.md", "9")] } },
  ],
  [`repos/octo/ace/git/trees/${id("2")}`]: [
    {
      body: {
        sha: id("2"),
        tree: [tree("src", "4"), blob("README.md", "9"), tree("zz", "5")],
      },
    },
  ],
  [`repos/octo/ace/git/trees/${id("3")}`]: [
    {
      body: {
        sha: id("3"),
        tree: [blob("a.ts", "a"), blob("m.ts", "b"), blob("old.ts", "c")],
      },
    },
  ],
  [`repos/octo/ace/git/trees/${id("4")}`]: [
    {
      body: {
        sha: id("4"),
        tree: [blob("a.ts", "d"), blob("m.ts", "e"), blob("n.ts", "f")],
      },
    },
  ],
  [`repos/octo/ace/git/trees/${id("5")}?recursive=1`]: [
    { body: { sha: id("5"), tree: [tree("deep", "6"), blob("deep/x.bin", "7")] } },
  ],
};

test("a PR past GitHub's 3,000 files keeps listing the rest from its trees", async () => {
  const f = await fakeGh(fixtures);
  try {
    const listedEnd = await f.forge.prFiles(
      { number: 7, page: 120, headSha: sha, baseSha: nextSha },
      signal(),
    );
    expect(listedEnd).toMatchObject({ nextPage: 121, truncated: false });
    const rest = await f.forge.prFiles(
      { number: 7, page: 121, headSha: sha, baseSha: nextSha },
      signal(),
    );
    // Only paths after GitHub's last listed one, in git's order; the unchanged README never.
    expect(rest.files.map((file) => [file.path, file.status, file.patch])).toEqual([
      ["src/n.ts", "added", null],
      ["src/old.ts", "removed", null],
      ["zz/deep/x.bin", "added", null],
    ]);
    expect(rest).toMatchObject({ baseSha: nextSha, headSha: sha, truncated: false });
    expect(rest.nextPage).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test("listing past 3,000 files is refused for a head that moved since the read began", async () => {
  const f = await fakeGh({
    ...fixtures,
    "repos/octo/ace/pulls/7": [{ body: { ...big, head: { ...big.head, sha: id("8") } } }],
  });
  try {
    await expect(
      f.forge.prFiles({ number: 7, page: 121, headSha: sha, baseSha: nextSha }, signal()),
    ).rejects.toMatchObject({ kind: "conflict" });
  } finally {
    await f.cleanup();
  }
});
