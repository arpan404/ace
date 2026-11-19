import { expect, test } from "vitest";
import { fakeGh, pr, sha, nextSha } from "./testing/fixtures.ts";

const signal = () => new AbortController().signal;
const old = "e".repeat(40);
const commitsQuery = "graphql:query PrCommits(";
const commitNode = (oid: string) => ({
  commit: {
    oid,
    message: "Push",
    url: `${pr.html_url}/commits/${oid}`,
    author: { name: "Contributor", date: "2026-10-01", user: { login: "contributor" } },
  },
});
const commits = {
  body: {
    data: {
      repository: {
        pullRequest: {
          headRefOid: sha,
          baseRefOid: nextSha,
          commits: {
            totalCount: 2,
            pageInfo: { hasPreviousPage: false, startCursor: null },
            nodes: [commitNode(old), commitNode(sha)],
          },
        },
      },
    },
  },
};
const record = (n: number) => ({
  filename: `src/file-${n}.ts`,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-old\n+new",
});
const compared = { body: { files: Array.from({ length: 30 }, (_, i) => record(i)) } };
const prBody = {
  ...pr,
  body: "",
  user: { login: "octo" },
  updated_at: "2026-10-11T12:00:00Z",
  created_at: "2026-10-10T12:00:00Z",
  additions: 1,
  deletions: 1,
  labels: [],
  base: { ref: "main", sha: nextSha },
  head: { ...pr.head, repo: { name: "ace", owner: { login: "octo" } } },
  requested_reviewers: [],
  commits: 2,
  changed_files: 30,
};

test("the changes between two of a PR's commits come from GitHub's comparison, 25 files a page", async () => {
  const f = await fakeGh({
    "repos/octo/ace/pulls/7": [{ body: prBody }, { body: prBody }],
    [commitsQuery]: [commits, commits, commits, commits],
    [`repos/octo/ace/compare/${old}...${sha}?per_page=1`]: [compared, compared],
  });
  try {
    const input = { number: 7, headSha: sha, baseSha: nextSha, commit: sha, since: old };
    const first = await f.forge.prFiles({ ...input, page: 1 }, signal());
    expect(first).toMatchObject({ baseSha: old, headSha: sha, commit: sha, since: old });
    expect(first.files).toHaveLength(25);
    expect(first.nextPage).toBe(2);
    const second = await f.forge.prFiles({ ...input, page: 2 }, signal());
    expect(second.files.map((file) => file.path)).toEqual(
      Array.from({ length: 5 }, (_, i) => `src/file-${i + 25}.ts`),
    );
    expect(second.nextPage).toBeUndefined();
    expect(second.truncated).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("a span that starts at a commit outside the PR is refused", async () => {
  const f = await fakeGh({
    "repos/octo/ace/pulls/7": [{ body: prBody }],
    [commitsQuery]: [commits],
  });
  try {
    await expect(
      f.forge.prFiles(
        { number: 7, page: 1, headSha: sha, baseSha: nextSha, commit: sha, since: "c".repeat(40) },
        signal(),
      ),
    ).rejects.toMatchObject({ kind: "not_found" });
    await expect(
      f.forge.prFiles({ number: 7, page: 1, headSha: sha, baseSha: nextSha, since: old }, signal()),
    ).rejects.toMatchObject({ kind: "not_found" });
  } finally {
    await f.cleanup();
  }
});
