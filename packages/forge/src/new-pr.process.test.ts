import { afterEach, expect, test } from "vitest";
import { fakeGh, pr, sha, nextSha, type Fixtures } from "./testing/fixtures.ts";

const signal = () => new AbortController().signal;
const cleanups: (() => Promise<void>)[] = [];
async function setup(fixtures: Fixtures) {
  const gh = await fakeGh(fixtures);
  cleanups.push(gh.cleanup);
  return gh;
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const commit = (n: number) => ({
  sha: n.toString(16).padStart(40, "c"),
  html_url: `https://github.com/octo/ace/commit/${n}`,
  commit: { message: `Commit ${n}`, author: { name: "Octo", date: "2026-10-01T00:00:00Z" } },
  author: { login: "octo", avatar_url: "https://avatars/octo" },
});
/** GitHub's open PRs from `owner:branch` into `base`, as the compare's lookup reads them. */
const openFrom = (owner: string, branch: string, numbers: number[] = []) => ({
  [`repos/octo/ace/pulls?${new URLSearchParams({ state: "open", head: `${owner}:${branch}`, base: "main", per_page: "10" })}`]:
    [
      {
        body: numbers.map((number) => ({
          ...pr,
          number,
          head: { sha, ref: branch },
          base: { ref: "main" },
        })),
      },
    ],
});
const file = (n: number) => ({
  filename: `src/file-${n}.ts`,
  status: "modified",
  additions: 1,
  deletions: 0,
  patch: "@@ -1 +1 @@\n-a\n+b",
});

test("a comparison lists its commits oldest first and its files a page at a time", async () => {
  const files = Array.from({ length: 30 }, (_, i) => file(i));
  const gh = await setup({
    ...openFrom("octo", "feature/card", [41]),
    "repos/octo/ace/compare/main...feature/card": [
      {
        body: {
          status: "ahead",
          ahead_by: 2,
          behind_by: 0,
          total_commits: 2,
          merge_base_commit: { sha },
          commits: [commit(1), commit(2)],
          files,
        },
      },
    ],
  });
  const first = await gh.forge.compare(
    "main",
    { owner: "octo", name: "ace", branch: "feature/card" },
    1,
    signal(),
  );
  expect(first.commits.map((c) => c.message)).toEqual(["Commit 1", "Commit 2"]);
  expect(first.headSha).toBe(commit(2).sha);
  expect(first.files).toHaveLength(25);
  expect(first).toMatchObject({ totalFiles: 30, nextPage: 2, truncated: false, aheadBy: 2 });
  // The branch already has #41 into main: the page says so before anything is created.
  expect(first.existingPr).toBe(41);
  const second = await gh.forge.compare(
    "main",
    { owner: "octo", name: "ace", branch: "feature/card" },
    2,
    signal(),
  );
  expect(second.files.map((f) => f.path)).toEqual(files.slice(25).map((f) => f.filename));
  expect(second.nextPage).toBeUndefined();
});

test("a fork's branch is compared as owner:branch", async () => {
  const gh = await setup({
    ...openFrom("fork", "card"),
    "repos/octo/ace/compare/main...fork:card": [
      {
        body: {
          status: "identical",
          ahead_by: 0,
          behind_by: 0,
          total_commits: 0,
          merge_base_commit: { sha: nextSha },
          commits: [],
          files: [],
        },
      },
    ],
  });
  const result = await gh.forge.compare(
    "main",
    { owner: "fork", name: "ace", branch: "card" },
    1,
    signal(),
  );
  expect(result).toMatchObject({ status: "identical", headSha: nextSha, totalCommits: 0 });
  expect(result.existingPr).toBeUndefined();
});

const templates = (list: unknown[] | null) => ({
  body: { data: { repository: { pullRequestTemplates: list } } },
});

test("the repository's default template is chosen when it has several, and none when it has none", async () => {
  const gh = await setup({
    "graphql:pullRequestTemplates": [
      templates([
        { filename: ".github/PULL_REQUEST_TEMPLATE/bug.md", body: "Bug" },
        { filename: ".github/pull_request_template.md", body: "## Summary" },
      ]),
      templates([]),
      templates([
        { filename: "a.md", body: "A" },
        { filename: "b.md", body: "B" },
      ]),
    ],
  });
  expect(await gh.forge.prTemplate(signal())).toBe("## Summary");
  expect(await gh.forge.prTemplate(signal())).toBeNull();
  // Several named templates and no default: the person picks on GitHub, so none is guessed.
  expect(await gh.forge.prTemplate(signal())).toBeNull();
});

test("branches list the default first, and options read labels, people and open milestones", async () => {
  const gh = await setup({
    "repos/octo/ace/branches?per_page=100": [
      {
        body: [
          { name: "zeta", commit: { sha } },
          { name: "main", commit: { sha: nextSha } },
          { name: "alpha", commit: { sha } },
        ],
      },
    ],
    "repos/octo/ace/labels?per_page=100": [
      {
        body: [
          { name: "bug", color: "d73a4a", description: "Broken" },
          { name: "x", color: "zz" },
        ],
      },
    ],
    "repos/octo/ace/assignees?per_page=100": [{ body: [{ login: "octo", avatar_url: "a" }] }],
    "repos/octo/ace/milestones?state=open&sort=due_on&direction=asc&per_page=100": [
      { body: [{ number: 2, title: "v1", state: "open", due_on: null }] },
    ],
  });
  expect((await gh.forge.branches("main", signal())).branches.map((b) => b.name)).toEqual([
    "main",
    "alpha",
    "zeta",
  ]);
  expect(await gh.forge.prOptions(signal())).toEqual({
    labels: [
      { name: "bug", color: "d73a4a", description: "Broken" },
      { name: "x", description: "" },
    ],
    assignable: [{ login: "octo", avatarUrl: "a" }],
    milestones: [{ number: 2, title: "v1", state: "open", dueOn: null }],
    truncated: false,
  });
});

test("a branch name git wouldn't take never reaches GitHub", async () => {
  const gh = await setup({});
  for (const branch of ["a/../b", "..", "-x", "a b", "x.lock"]) {
    await expect(
      gh.forge.compare("main", { owner: "octo", name: "ace", branch }, 1, signal()),
    ).rejects.toMatchObject({ kind: "unprocessable" });
    await expect(
      gh.forge.openPr({ branch, base: "main", title: "T", body: "", draft: false }, signal()),
    ).rejects.toMatchObject({ kind: "unprocessable" });
  }
  await expect(
    gh.forge.compare("../main", { owner: "octo", name: "ace", branch: "fix" }, 1, signal()),
  ).rejects.toMatchObject({ kind: "unprocessable" });
  // Nor does a repository name of `.` or `..`, which would climb the URL path.
  for (const name of [".", ".."])
    await expect(
      gh.forge.compare("main", { owner: "octo", name, branch: "fix" }, 1, signal()),
    ).rejects.toMatchObject({ kind: "unprocessable" });
});

test("a comparison GitHub cuts at 250 commits still names the branch's newest as its head", async () => {
  // Without paging parameters GitHub lists 250 commits and the last is the comparison's newest.
  const commits = Array.from({ length: 250 }, (_, i) => commit(i + 1));
  const gh = await setup({
    ...openFrom("octo", "big"),
    "repos/octo/ace/compare/main...big": [
      {
        body: {
          status: "ahead",
          ahead_by: 300,
          behind_by: 0,
          total_commits: 300,
          merge_base_commit: { sha },
          commits,
          files: [],
        },
      },
    ],
  });
  const result = await gh.forge.compare(
    "main",
    { owner: "octo", name: "ace", branch: "big" },
    1,
    signal(),
  );
  expect(result).toMatchObject({ headSha: commit(250).sha, truncated: true, totalCommits: 300 });
  const compared = (await gh.requests()).find((request) => request.path.includes("/compare/"));
  expect(compared?.path).not.toContain("page");
});

test("a fork with the parent's owner is compared at its own branch's commit, read from the fork", async () => {
  const forkHead = "c".repeat(40);
  const gh = await setup({
    ...openFrom("octo", "card"),
    "repos/octo/ace-fork/git/ref/heads/card": [{ body: { object: { sha: forkHead } } }],
    [`repos/octo/ace/compare/main...${forkHead}`]: [
      {
        body: {
          status: "ahead",
          ahead_by: 1,
          behind_by: 0,
          total_commits: 1,
          merge_base_commit: { sha },
          commits: [commit(1)],
          files: [file(1)],
        },
      },
    ],
  });
  const result = await gh.forge.compare(
    "main",
    { owner: "octo", name: "ace-fork", branch: "card" },
    1,
    signal(),
  );
  expect(result).toMatchObject({ aheadBy: 1, totalFiles: 1 });
  // Never `main...card`, which is the parent's own branch.
  expect(
    (await gh.requests()).some((request) => request.path.endsWith("/compare/main...card")),
  ).toBe(false);
});

test("a later page compares page 1's head commit, never the branch read again", async () => {
  const pinned = "d".repeat(40);
  const gh = await setup({
    [`repos/octo/ace/compare/main...${pinned}`]: [
      {
        body: {
          status: "ahead",
          ahead_by: 1,
          behind_by: 0,
          total_commits: 1,
          merge_base_commit: { sha },
          commits: [commit(1)],
          files: Array.from({ length: 30 }, (_, i) => file(i)),
        },
      },
    ],
  });
  const second = await gh.forge.compare(
    "main",
    { owner: "octo", name: "ace-fork", branch: "card" },
    2,
    signal(),
    pinned,
  );
  expect(second.files).toHaveLength(5);
  expect((await gh.requests()).some((request) => request.path.includes("/git/ref/"))).toBe(false);
});
