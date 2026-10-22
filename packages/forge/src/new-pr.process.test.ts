import { afterEach, expect, test } from "vitest";
import { fakeGh, sha, nextSha, type Fixtures } from "./testing/fixtures.ts";

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
  const first = await gh.forge.compare("main", { owner: "octo", branch: "feature/card" }, 1, signal());
  expect(first.commits.map((c) => c.message)).toEqual(["Commit 1", "Commit 2"]);
  expect(first.headSha).toBe(commit(2).sha);
  expect(first.files).toHaveLength(25);
  expect(first).toMatchObject({ totalFiles: 30, nextPage: 2, truncated: false, aheadBy: 2 });
  const second = await gh.forge.compare("main", { owner: "octo", branch: "feature/card" }, 2, signal());
  expect(second.files.map((f) => f.path)).toEqual(files.slice(25).map((f) => f.filename));
  expect(second.nextPage).toBeUndefined();
});

test("a fork's branch is compared as owner:branch", async () => {
  const gh = await setup({
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
  const result = await gh.forge.compare("main", { owner: "fork", branch: "card" }, 1, signal());
  expect(result).toMatchObject({ status: "identical", headSha: nextSha, totalCommits: 0 });
});

test("the repository's default template is chosen when it has several, and none when it has none", async () => {
  const templates = (list: unknown[] | null) => ({
    body: { data: { repository: { pullRequestTemplates: list } } },
  });
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
      { body: [{ name: "bug", color: "d73a4a", description: "Broken" }, { name: "x", color: "zz" }] },
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
