import { afterEach, expect, test } from "vitest";
import { GitHubForge, identityRunner } from "./index.ts";
import {
  check,
  fakeGh,
  nextSha,
  pr,
  repository,
  sha,
  standard,
  threads,
  type Fixtures,
} from "./testing/fixtures.ts";

// Each GitHub round trip costs about half a second, so a PR panel is as fast as its longest
// chain of requests that wait on one another. These tests hold one answer back and prove the
// read already asked for what does not depend on it.

const signal = () => new AbortController().signal;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup(fixtures: Fixtures) {
  const gh = await fakeGh(fixtures);
  cleanups.push(gh.cleanup);
  return gh;
}
const checksAt = (head: string) =>
  `repos/octo/ace/commits/${head}/check-runs?per_page=100&filter=latest`;
const decision = (head: string) => ({
  body: {
    data: { repository: { pullRequest: { reviewDecision: "APPROVED", headRefOid: head } } },
  },
});
const detailPr = {
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
  commits: 1,
  changed_files: 1,
};

test("a PR read again asks for its last head's checks without waiting for the PR itself", async () => {
  const fixtures = standard();
  const [answer] = fixtures["repos/octo/ace/pulls/7"] ?? [];
  fixtures["repos/octo/ace/pulls/7"] = [{ ...answer }, { ...answer, barrier: "pr" }];
  const gh = await setup(fixtures);
  await gh.forge.status(7, signal());
  const again = gh.forge.status(7, signal());
  // The PR's own answer is still held back here.
  await gh.waitForRequests(
    (requests) => requests.filter((request) => request.path === checksAt(sha)).length === 2,
  );
  await gh.release("pr");
  expect((await again).checks.map((entry) => entry.name)).toEqual(["test"]);
});

test("checks guessed for a head that has since moved are never shown", async () => {
  const fixtures = standard();
  fixtures["repos/octo/ace/pulls/7"] = [
    { body: pr },
    { body: { ...pr, head: { ...pr.head, sha: nextSha } } },
  ];
  fixtures[checksAt(nextSha)] = [
    { body: { check_runs: [{ ...check, id: 12, name: "lint", conclusion: "success" }] } },
  ];
  fixtures[`repos/octo/ace/commits/${nextSha}/statuses?per_page=100`] = [{ body: [] }];
  const gh = await setup(fixtures);
  expect((await gh.forge.status(7, signal())).checks.map((entry) => entry.name)).toEqual([
    "test",
  ]);
  const moved = await gh.forge.status(7, signal());
  expect(moved.headSha).toBe(nextSha);
  expect(moved.checks.map((entry) => [entry.name, entry.status])).toEqual([["lint", "success"]]);
});

test("PR detail asks for the review decision while the PR itself is still being read", async () => {
  const fixtures = standard();
  fixtures["repos/octo/ace/pulls/7"] = [{ body: detailPr, barrier: "pr" }];
  fixtures.graphql = [{ body: threads() }];
  fixtures["graphql:reviewDecision headRefOid"] = [decision(sha)];
  const gh = await setup(fixtures);
  const detail = gh.forge.prDetail(7, signal());
  await gh.waitForRequests((requests) =>
    requests.some((request) => JSON.stringify(request.body ?? "").includes("reviewDecision")),
  );
  await gh.release("pr");
  expect(await detail).toMatchObject({ status: { headSha: sha }, reviewDecision: "APPROVED" });
});

test("PR detail reads again when a push lands between its status and its review decision", async () => {
  const fixtures = standard();
  fixtures["repos/octo/ace/pulls/7"] = [{ body: detailPr }];
  fixtures.graphql = [{ body: threads() }];
  fixtures["graphql:reviewDecision headRefOid"] = [decision(nextSha), decision(sha)];
  const gh = await setup(fixtures);
  expect(await gh.forge.prDetail(7, signal())).toMatchObject({
    status: { headSha: sha },
    reviewDecision: "APPROVED",
  });
  fixtures["graphql:reviewDecision headRefOid"] = [decision(nextSha)];
  const moving = await setup(fixtures);
  await expect(moving.forge.prDetail(7, signal())).rejects.toMatchObject({ kind: "conflict" });
});

test("a file page reads its merge base beside the files and checks the head once, after them", async () => {
  const files = "repos/octo/ace/pulls/7/files?per_page=25&page=1";
  const gh = await setup({
    "repos/octo/ace/pulls/7": [{ body: detailPr }],
    [files]: [{ body: [{ filename: "a.ts", status: "added", additions: 1, deletions: 0 }] }],
    [`repos/octo/ace/compare/${nextSha}...${sha}`]: [
      { body: { merge_base_commit: { sha: nextSha } }, barrier: "base" },
    ],
  });
  const page = gh.forge.prFiles({ number: 7, page: 1, headSha: sha, baseSha: nextSha }, signal());
  // The comparison is still held back here.
  await gh.waitForRequest(files);
  await gh.release("base");
  expect(await page).toMatchObject({ baseSha: nextSha, headSha: sha, files: [{ path: "a.ts" }] });
  const paths = (await gh.requests()).map((request) => request.path);
  expect(paths.filter((path) => path === "repos/octo/ace/pulls/7")).toHaveLength(1);
  expect(paths.at(-1)).toBe("repos/octo/ace/pulls/7");
});

test("commit statistics are read beside the head check that proves the list current", async () => {
  const gh = await setup({
    "repos/octo/ace/pulls/7": [{ body: detailPr, barrier: "head" }],
    "repos/octo/ace/pulls/7/commits?per_page=25&page=1": [
      {
        body: [
          {
            sha,
            html_url: pr.html_url,
            author: { login: "octo" },
            commit: { message: "Fix", author: { name: "Octo", date: "2026-10-01" } },
          },
        ],
      },
    ],
    graphql: [{ body: { data: { repository: { c0: { oid: sha, additions: 4, deletions: 2 } } } } }],
  });
  const page = gh.forge.prCommits(7, 1, sha, signal());
  await gh.waitForRequest("graphql");
  await gh.release("head");
  expect((await page).commits).toMatchObject([{ sha, additions: 4, deletions: 2 }]);
});

test("a read runs beside its identity probe and is answered only once the probe proves the account", async () => {
  const fixtures = standard();
  fixtures.user = [{ body: { login: "octo" }, barrier: "who" }];
  const gh = await setup(fixtures);
  const forge = new GitHubForge({
    repository,
    now: () => 1_000,
    runner: identityRunner(
      (request) => gh.runner({ ...request, command: gh.executable }),
      repository.host,
      "octo",
      () => {},
      { now: () => 1_000 },
    ),
  });
  let answered = false;
  const status = forge.status(7, signal()).then((value) => {
    answered = true;
    return value;
  });
  await gh.waitForRequest("repos/octo/ace/pulls/7");
  expect(answered).toBe(false);
  await gh.release("who");
  expect((await status).ref.number).toBe(7);
});
