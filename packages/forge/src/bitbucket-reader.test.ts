import { expect, test } from "vitest";
import { ForgePrSearch } from "@ace/protocol/forge-browser";
import { BitbucketReader } from "./bitbucket-reader.ts";
import {
  base,
  bitbucketHost,
  head,
  pullRequest,
  repository,
  root,
} from "./testing/bitbucket-host.ts";

const signal = new AbortController().signal;
const reader = (replies: Record<string, unknown> = {}) =>
  new BitbucketReader({ repository, runner: bitbucketHost({ replies }).runner, login: "work" });
const status = (state: string, key = state, commit = head) => ({
  key,
  name: key,
  state,
  url: "https://ci.example/1",
  updated_on: "2026-11-02T10:00:00Z",
  links: { commit: { href: `https://api.bitbucket.org${root}/commit/${commit}` } },
});
const statuses = (...values: unknown[]) => ({
  [`${root}/pullrequests/7/statuses?pagelen=100`]: { values },
});

test("a pull request's head is the full commit Bitbucket's abbreviated hash names", async () => {
  const s = await reader().status(7, signal);
  expect(s).toMatchObject({ headSha: head, state: "open", mergeability: "unknown", ci: "none" });
  expect(s.url).toBe("https://bitbucket.org/team/app/pull-requests/7");
});

test("a head that isn't the commit the pull request names is never reported", async () => {
  const moved = {
    [`${root}/pullrequests/7/commits?pagelen=1`]: { values: [{ hash: "c".repeat(40) }] },
  };
  await expect(reader(moved).status(7, signal)).rejects.toMatchObject({ kind: "head_moved" });
});

test.each([
  [{ state: "OPEN", draft: true }, "draft"],
  [{ state: "MERGED" }, "merged"],
  [{ state: "DECLINED" }, "closed"],
  [{ state: "SUPERSEDED" }, "closed"],
  [{ state: "QUEUED" }, "unknown"],
])("Bitbucket state %o reads as %s", async (fields, expected) => {
  const s = await reader({ [`${root}/pullrequests/7`]: pullRequest(fields) }).status(7, signal);
  expect(s.state).toBe(expected);
});

test.each([
  [[status("SUCCESSFUL", "build"), status("INPROGRESS", "lint")], "pending"],
  [[status("SUCCESSFUL", "build"), status("PAUSED", "lint")], "unknown"],
  [[status("SUCCESSFUL", "build"), status("STOPPED", "lint")], "failure"],
  [[status("FAILED", "build")], "failure"],
  [[status("SUCCESSFUL", "build")], "success"],
  [[], "none"],
])(
  "build statuses %# roll up to %s CI, never success while any is running or unknown",
  async (values, ci) => {
    const s = await reader(statuses(...values)).status(7, signal);
    expect(s.ci).toBe(ci);
  },
);

test("a build status for an older commit is left out, and one naming no commit is unknown", async () => {
  const old = await reader(
    statuses(status("SUCCESSFUL", "build"), status("FAILED", "old", "d".repeat(40))),
  ).status(7, signal);
  expect(old.ci).toBe("success");
  expect(old.checks.map((c) => c.name)).toEqual(["build"]);
  const { links: _links, ...unplaced } = status("SUCCESSFUL", "build");
  const unknown = await reader(statuses(unplaced)).status(7, signal);
  expect(unknown.ci).toBe("unknown");
});

test("the open list leaves drafts out and says its counts are incomplete", async () => {
  const list = await reader({
    [`${root}/pullrequests?state=OPEN&sort=-updated_on&pagelen=25&page=1`]: {
      size: 30,
      page: 1,
      values: [
        pullRequest(),
        pullRequest({ id: 8, draft: true }),
        pullRequest({ id: 9, state: "NEW" }),
      ],
      next: `https://api.bitbucket.org${root}/pullrequests?page=2`,
    },
  }).listPrs(ForgePrSearch.parse({}), signal);
  expect(list.items.map((p) => [p.ref.number, p.state])).toEqual([[7, "open"]]);
  expect(list).toMatchObject({ total: 30, nextPage: 2, incomplete: true });
  // Rows carry no head: Bitbucket lists only abbreviated hashes.
  expect(list.items[0]?.headSha).toBeUndefined();
});

test("a list page Bitbucket answered for another page number is refused", async () => {
  const list = reader({
    [`${root}/pullrequests?state=MERGED&sort=-updated_on&pagelen=25&page=3`]: {
      page: 1,
      values: [],
    },
  }).listPrs(ForgePrSearch.parse({ state: "merged", page: 3 }), signal);
  await expect(list).rejects.toMatchObject({ kind: "invalid_data" });
});

test.each([
  { search: "fix" },
  { author: "bob" },
  { ci: "failure" },
  { review: "approved" },
  { labels: ["x"] },
])(
  "a search Bitbucket's list can't express is refused, never answered unfiltered: %o",
  async (query) => {
    await expect(reader().listPrs(ForgePrSearch.parse(query), signal)).rejects.toMatchObject({
      kind: "unsupported",
    });
  },
);

test("detail reads full base and head commits, and never claims a review decision", async () => {
  const detail = await reader().prDetail(7, signal);
  expect(detail).toMatchObject({
    baseSha: base,
    headBranch: "feature",
    baseBranch: "main",
    reviewDecision: "UNKNOWN",
    capabilities: expect.arrayContaining(["reviews.comments.write", "reviews.approvals.write"]),
  });
  expect(detail.capabilities).not.toContain("reviews.merge");
  expect(detail.unavailableResources).toEqual(["commits", "fileCount"]);
});

test("files are read only at the head and base the reader asked for", async () => {
  const replies = {
    [`${root}/pullrequests/7/diffstat?pagelen=25&page=1`]: {
      page: 1,
      values: [
        {
          status: "modified",
          lines_added: 3,
          lines_removed: 1,
          old: { path: "a.ts" },
          new: { path: "a.ts" },
        },
        {
          status: "renamed",
          lines_added: 0,
          lines_removed: 0,
          old: { path: "b.ts" },
          new: { path: "c.ts" },
        },
        { status: "removed", lines_added: 0, lines_removed: 4, old: { path: "d.ts" }, new: null },
      ],
    },
  };
  const files = await reader(replies).prFiles(
    { number: 7, page: 1, headSha: head, baseSha: base },
    signal,
  );
  expect(files.files.map((f) => [f.path, f.previousPath, f.status, f.patch])).toEqual([
    ["a.ts", undefined, "modified", null],
    ["c.ts", "b.ts", "renamed", null],
    ["d.ts", undefined, "removed", null],
  ]);
  const stale = reader(replies).prFiles(
    { number: 7, page: 1, headSha: "e".repeat(40), baseSha: base },
    signal,
  );
  await expect(stale).rejects.toMatchObject({ kind: "head_moved" });
});

/** A commit as GET …/pullrequests/<n>/commits lists it. */
const commitRow = (hash: string) => ({
  hash,
  message: "m",
  date: null,
  author: { raw: "Bob <b@x>" },
});

test("commits come in pages of 100, oldest first within a page, newest page first", async () => {
  const hashes = Array.from({ length: 150 }, (_, i) =>
    i === 0 ? head : i.toString(16).padStart(40, "0"),
  );
  const replies = {
    [`${root}/pullrequests/7/commits?pagelen=100`]: {
      values: hashes.slice(0, 100).map(commitRow),
      next: `https://api.bitbucket.org${root}/pullrequests/7/commits?pagelen=100&page=opaque2`,
    },
    [`${root}/pullrequests/7/commits?pagelen=100&page=opaque2`]: {
      values: hashes.slice(100).map(commitRow),
    },
  };
  const newest = await reader(replies).prCommits(7, undefined, head, signal);
  expect(newest).toMatchObject({ total: 150, before: "1" });
  expect(newest.commits.at(-1)?.sha).toBe(head);
  expect(newest.commits).toHaveLength(50);
  const older = await reader(replies).prCommits(7, "1", head, signal);
  expect(older.commits).toHaveLength(100);
  expect(older.before).toBeUndefined();
});

test("a next link to another host or path is never followed", async () => {
  const replies = {
    [`${root}/pullrequests/7/commits?pagelen=100`]: {
      values: [{ hash: head }],
      next: "https://evil.test/2.0/user",
    },
  };
  await expect(reader(replies).prCommits(7, undefined, head, signal)).rejects.toMatchObject({
    kind: "invalid_data",
  });
});

test("checking out a pull request from a fork names the fork as the head repository", async () => {
  const fork = pullRequest({
    source: {
      branch: { name: "feature" },
      commit: { hash: head.slice(0, 12) },
      repository: { full_name: "someone/app-fork" },
    },
  });
  const checkout = await reader({ [`${root}/pullrequests/7`]: fork }).prCheckout(7, signal);
  expect(checkout).toMatchObject({
    headSha: head,
    baseSha: base,
    headRepository: {
      forge: "bitbucket",
      host: "bitbucket.org",
      owner: "someone",
      name: "app-fork",
    },
  });
});
