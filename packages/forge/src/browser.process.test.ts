import { expect, test } from "vitest";
import { ForgePrSearch } from "@ace/protocol/forge-browser";
import { fakeGh, standard, repository, pr, sha, nextSha, threads } from "./testing/fixtures.ts";
const signal = () => new AbortController().signal;
const richPr = {
  ...pr,
  body: "## Hosted description\n\nReview the actual head.",
  user: { login: "octo" },
  labels: [{ name: "bug" }],
  base: { ref: "main", sha: nextSha },
  head: { ...pr.head, repo: { name: "fork", owner: { login: "contributor" } } },
  requested_reviewers: [{ login: "reviewer" }],
  commits: 2,
  changed_files: 2,
};
const row = {
  number: 7,
  title: "Fix build",
  html_url: pr.html_url,
  user: { login: "octo" },
  state: "open",
  draft: true,
  labels: [{ name: "bug" }],
  updated_at: "2026-10-01T00:00:00Z",
  pull_request: { merged_at: null },
};
const counts = {
  data: {
    open: { issueCount: 2 },
    draft: { issueCount: 1 },
    closed: { issueCount: 3 },
    merged: { issueCount: 4 },
  },
};
const file = {
  filename: "src/main.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-old\n+new",
  unknown: "retained",
};
const commit = {
  sha,
  html_url: pr.html_url,
  author: { login: "contributor" },
  commit: { message: "Handle empty input", author: { name: "Contributor", date: "2026-10-01" } },
};

test("repository search keeps literal words scoped and returns counts, draft rows and incomplete bounded pages", async () => {
  const query = ForgePrSearch.parse({
    state: "draft",
    search: "retry repo:other/private",
    author: "octo",
    reviewer: "reviewer",
    page: 2,
    sort: "created",
    order: "asc",
  });
  const params = new URLSearchParams({
    q: 'repo:octo/ace is:pr is:open draft:true "retry" "repo:other/private" author:octo review-requested:reviewer',
    sort: "created",
    order: "asc",
    per_page: "25",
    page: "2",
  });
  const f = await fakeGh({
    [`search/issues?${params}`]: [
      { body: { total_count: 1020, incomplete_results: true, items: [row] } },
    ],
    graphql: [{ body: counts }],
  });
  try {
    const result = await f.forge.listPrs(query, signal());
    expect(result).toMatchObject({
      repository,
      items: [{ ref: { repository, number: 7 }, state: "draft", author: "octo", labels: ["bug"] }],
      nextPage: 3,
      total: 1020,
      counts: { open: 2, draft: 1, closed: 3, merged: 4 },
      incomplete: true,
      truncated: true,
    });
  } finally {
    await f.cleanup();
  }
});

test("full PR detail includes hosted branch identities, description, reviews and fork identity", async () => {
  const fixtures = standard();
  fixtures["repos/octo/ace/pulls/7"] = [{ body: richPr }];
  fixtures.graphql = [
    { body: threads() },
    {
      body: {
        data: {
          repository: { pullRequest: { reviewDecision: "CHANGES_REQUESTED", headRefOid: sha } },
        },
      },
    },
  ];
  const f = await fakeGh(fixtures);
  try {
    expect(await f.forge.prDetail(7, signal())).toMatchObject({
      status: { ref: { repository, number: 7 }, headSha: sha },
      body: richPr.body,
      baseBranch: "main",
      headBranch: "feat/fix",
      baseSha: nextSha,
      headRepository: { owner: "contributor", name: "fork" },
      reviewers: ["reviewer"],
      reviewDecision: "CHANGES_REQUESTED",
    });
  } finally {
    await f.cleanup();
  }
});

test("hosted file pages identify the base and head and visibly bound oversized or missing patches", async () => {
  const path = "repos/octo/ace/pulls/7/files?per_page=25&page=1";
  const f = await fakeGh({
    [`repos/octo/ace/compare/${nextSha}...${sha}`]: [
      { body: { merge_base_commit: { sha: nextSha } } },
    ],
    "repos/octo/ace/pulls/7": [{ body: richPr }],
    [path]: [
      {
        body: [
          { ...file, patch: "x".repeat(300_000) },
          { ...file, filename: "logo.png", patch: undefined },
        ],
        headers: {
          link: '<https://api.github.com/repos/octo/ace/pulls/7/files?per_page=25&page=2>; rel="next"',
        },
      },
    ],
  });
  try {
    const result = await f.forge.prFiles(
      { number: 7, page: 1, headSha: sha, baseSha: nextSha },
      signal(),
    );
    expect(result).toMatchObject({
      ref: { repository, number: 7 },
      baseSha: nextSha,
      headSha: sha,
      nextPage: 2,
      truncated: true,
      files: [
        { path: "src/main.ts", truncated: true },
        { path: "logo.png", patch: null, truncated: true },
      ],
    });
    expect(result.files[0]?.patch?.length).toBe(262_144);
  } finally {
    await f.cleanup();
  }
});

test("a head that changes during diff preparation cannot return a ready diff for the old head", async () => {
  const f = await fakeGh({
    [`repos/octo/ace/compare/${nextSha}...${sha}`]: [
      { body: { merge_base_commit: { sha: nextSha } } },
    ],
    "repos/octo/ace/pulls/7": [
      { body: richPr },
      { body: { ...richPr, head: { ...richPr.head, sha: nextSha } } },
    ],
    "repos/octo/ace/pulls/7/files?per_page=25&page=1": [{ body: [file] }],
  });
  try {
    await expect(
      f.forge.prFiles({ number: 7, page: 1, headSha: sha, baseSha: nextSha }, signal()),
    ).rejects.toMatchObject({ kind: "conflict" });
  } finally {
    await f.cleanup();
  }
});

test("individual commit diffs use the commit's first parent and reject unrelated commits", async () => {
  const f = await fakeGh({
    [`repos/octo/ace/compare/${nextSha}...${sha}`]: [
      { body: { merge_base_commit: { sha: nextSha } } },
    ],
    "repos/octo/ace/pulls/7": [{ body: richPr }],
    "repos/octo/ace/pulls/7/commits?per_page=100&page=1": [{ body: [commit] }],
    [`repos/octo/ace/commits/${sha}?per_page=25&page=1`]: [
      { body: { ...commit, parents: [{ sha: nextSha }], files: [file] } },
    ],
  });
  try {
    expect(
      await f.forge.prFiles(
        { number: 7, page: 1, headSha: sha, baseSha: nextSha, commit: sha },
        signal(),
      ),
    ).toMatchObject({
      commit: sha,
      baseSha: nextSha,
      headSha: sha,
      files: [{ patch: file.patch }],
    });
    await expect(
      f.forge.prFiles(
        { number: 7, page: 1, headSha: sha, baseSha: nextSha, commit: "c".repeat(40) },
        signal(),
      ),
    ).rejects.toMatchObject({ kind: "not_found" });
  } finally {
    await f.cleanup();
  }
});

test("malformed pagination and cancelled or rate-limited reads never produce partial success", async () => {
  const path = "repos/octo/ace/pulls/7/files?per_page=25&page=1";
  const f = await fakeGh({
    [`repos/octo/ace/compare/${nextSha}...${sha}`]: [
      { body: { merge_base_commit: { sha: nextSha } } },
    ],
    "repos/octo/ace/pulls/7": [{ body: richPr }],
    [path]: [{ body: [file], headers: { link: '<https://other.test/private>; rel="next"' } }],
  });
  try {
    await expect(
      f.forge.prFiles({ number: 7, page: 1, headSha: sha, baseSha: nextSha }, signal()),
    ).rejects.toMatchObject({ kind: "invalid_data" });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(f.forge.prCommits(7, 1, sha, cancelled.signal)).rejects.toMatchObject({
      kind: "cancelled",
    });
  } finally {
    await f.cleanup();
  }
  const limited = await fakeGh({
    "repos/octo/ace/pulls/7": [{ status: 429, headers: { "retry-after": "60" } }],
  });
  try {
    await expect(limited.forge.prCommits(7, 1, sha, signal())).rejects.toMatchObject({
      kind: "rate_limit",
      retryAt: 61_000,
    });
  } finally {
    await limited.cleanup();
  }
});
