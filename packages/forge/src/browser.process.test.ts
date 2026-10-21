import { expect, test } from "vitest";
import { ForgePrSearch } from "@ace/protocol/forge-browser";
import { fakeGh, standard, repository, pr, sha, nextSha, threads } from "./testing/fixtures.ts";
const signal = () => new AbortController().signal;
const richPr = {
  ...pr,
  body: "## Hosted description\n\nReview the actual head.",
  user: { login: "octo", avatar_url: "https://github.com/octo.png" },
  updated_at: "2026-10-11T12:00:00Z",
  created_at: "2026-10-10T12:00:00Z",
  additions: 62,
  deletions: 9,
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
    graphql: [
      {
        body: {
          data: {
            ...counts.data,
            repository: {
              p0: {
                comments: { totalCount: 3 },
                reviews: { totalCount: 2 },
                statusCheckRollup: { state: "FAILURE" },
                unknown: "kept",
              },
            },
          },
        },
      },
    ],
  });
  try {
    const result = await f.forge.listPrs(query, signal());
    expect(result).toMatchObject({
      repository,
      items: [
        {
          ref: { repository, number: 7 },
          state: "draft",
          author: "octo",
          labels: ["bug"],
          commentCount: 3,
          reviewCount: 2,
          ci: "failure",
          raw: { indicators: { unknown: "kept" } },
        },
      ],
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

test("an active search finds open PRs drafts included, and a failing-checks search asks GitHub for failures", async () => {
  const query = ForgePrSearch.parse({ state: "active", ci: "failure" });
  const params = new URLSearchParams({
    q: "repo:octo/ace is:pr is:open status:failure",
    sort: "updated",
    order: "desc",
    per_page: "25",
    page: "1",
  });
  const f = await fakeGh({
    [`search/issues?${params}`]: [
      { body: { total_count: 1, incomplete_results: false, items: [row] } },
    ],
    graphql: [
      {
        body: {
          data: {
            ...counts.data,
            repository: {
              p0: {
                comments: { totalCount: 0 },
                reviews: { totalCount: 0 },
                statusCheckRollup: { state: "FAILURE" },
              },
            },
          },
        },
      },
    ],
  });
  try {
    const result = await f.forge.listPrs(query, signal());
    expect(result).toMatchObject({
      items: [{ ref: { repository, number: 7 }, state: "draft", ci: "failure" }],
      total: 1,
      counts: { open: 2, draft: 1, closed: 3, merged: 4 },
    });
  } finally {
    await f.cleanup();
  }
});

test("full PR detail includes hosted branch identities, description, reviews and fork identity", async () => {
  const fixtures = standard();
  fixtures["repos/octo/ace/pulls/7"] = [{ body: richPr }];
  fixtures.graphql = [{ body: threads() }];
  fixtures["graphql:reviewDecision headRefOid"] = [
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
      authorAvatarUrl: "https://github.com/octo.png",
      updatedAt: "2026-10-11T12:00:00Z",
      additions: 62,
      deletions: 9,
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

test("hosted file pages identify the base and head and leave out, whole, patches that don't fit", async () => {
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
          { ...file, filename: "src/small.ts" },
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
      // Every listed file is there; only patches are withheld, and the page diffs those itself.
      truncated: false,
      files: [
        { path: "src/main.ts", patch: null, truncated: true },
        { path: "logo.png", patch: null, truncated: true },
        { path: "src/small.ts", patch: file.patch, truncated: false },
      ],
    });
  } finally {
    await f.cleanup();
  }
});

test("a head that changes during diff preparation cannot return a ready diff for the old head", async () => {
  const f = await fakeGh({
    [`repos/octo/ace/compare/${nextSha}...${sha}`]: [
      { body: { merge_base_commit: { sha: nextSha } } },
    ],
    // The head moved while the files were read: the check after them sees it.
    "repos/octo/ace/pulls/7": [{ body: { ...richPr, head: { ...richPr.head, sha: nextSha } } }],
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
    "repos/octo/ace/pulls/7/commits?per_page=25&page=1": [
      { status: 429, headers: { "retry-after": "60" } },
    ],
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

test("a push during a commit-list read cannot label the new commits with the previously selected head", async () => {
  const f = await fakeGh({
    // The push landed while the list was read: the check after it sees the new head.
    "repos/octo/ace/pulls/7": [{ body: { ...richPr, head: { ...richPr.head, sha: nextSha } } }],
    "repos/octo/ace/pulls/7/commits?per_page=25&page=1": [{ body: [{ ...commit, sha: nextSha }] }],
    graphql: [
      { body: { data: { repository: { c0: { oid: nextSha, additions: 8, deletions: 3 } } } } },
    ],
  });
  try {
    await expect(f.forge.prCommits(7, 1, sha, signal())).rejects.toMatchObject({
      kind: "conflict",
    });
  } finally {
    await f.cleanup();
  }
});

test("commit pages expose per-commit statistics and preserve authors and next-page navigation", async () => {
  const path = "repos/octo/ace/pulls/7/commits?per_page=25&page=1";
  const f = await fakeGh({
    "repos/octo/ace/pulls/7": [{ body: richPr }],
    graphql: [{ body: { data: { repository: { c0: { oid: sha, additions: 8, deletions: 3 } } } } }],
    [path]: [
      {
        body: [commit],
        headers: {
          link: '<https://api.github.com/repos/octo/ace/pulls/7/commits?per_page=25&page=2>; rel="next"',
        },
      },
    ],
  });
  try {
    expect(await f.forge.prCommits(7, 1, sha, signal())).toMatchObject({
      commits: [
        { sha, author: "contributor", message: "Handle empty input", additions: 8, deletions: 3 },
      ],
      nextPage: 2,
      truncated: false,
    });
  } finally {
    await f.cleanup();
  }
});

test("GitHub's last listed page goes on to the tree listing only when the PR has more files", async () => {
  for (const changedFiles of [3000, 3001]) {
    const f = await fakeGh({
      "repos/octo/ace/pulls/7": [{ body: { ...richPr, changed_files: changedFiles } }],
      "repos/octo/ace/pulls/7/files?per_page=25&page=120": [{ body: [file] }],
      [`repos/octo/ace/compare/${nextSha}...${sha}`]: [
        { body: { merge_base_commit: { sha: nextSha } } },
      ],
    });
    try {
      const result = await f.forge.prFiles(
        { number: 7, page: 120, headSha: sha, baseSha: nextSha },
        signal(),
      );
      expect(result.truncated).toBe(false);
      expect(result.nextPage).toBe(changedFiles > 3000 ? 121 : undefined);
      expect(result.files[0]).toMatchObject({ patch: file.patch, truncated: false });
    } finally {
      await f.cleanup();
    }
  }
});

test("a PR's file cap does not label a complete individual-commit diff as truncated", async () => {
  const f = await fakeGh({
    "repos/octo/ace/pulls/7": [{ body: { ...richPr, changed_files: 3001 } }],
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
    ).toMatchObject({ truncated: false, files: [{ truncated: false }] });
  } finally {
    await f.cleanup();
  }
});
test("checkout metadata resolves a fork head and refuses a moved or deleted source branch", async () => {
  for (const scenario of ["valid", "moved", "missing"]) {
    const fixtures = standard();
    fixtures["repos/octo/ace/pulls/7"] = [{ body: richPr }];
    fixtures["repos/contributor/fork/git/ref/heads/feat%2Ffix"] =
      scenario === "missing"
        ? [{ status: 404, body: { message: "Not Found" } }]
        : [{ body: { object: { sha: scenario === "moved" ? nextSha : sha } } }];
    const gh = await fakeGh(fixtures);
    try {
      if (scenario === "valid")
        expect(await gh.forge.prCheckout(7, signal())).toMatchObject({
          ref: { repository, number: 7 },
          headSha: sha,
          baseSha: nextSha,
          headRepository: { owner: "contributor", name: "fork" },
        });
      else
        await expect(gh.forge.prCheckout(7, signal())).rejects.toMatchObject({
          kind: scenario === "moved" ? "head_moved" : "head_missing",
        });
    } finally {
      await gh.cleanup();
    }
  }
});

test("timeline events preserve unknown kinds and fields while exposing actor, label and commit identities", async () => {
  const future = {
    id: 91,
    event: "future_provider_event",
    created_at: "2026-10-11T12:05:00Z",
    actor: { login: "octo", avatar_url: "https://github.com/octo.png", future: true },
    extra: { retained: true },
  };
  const f = await fakeGh({
    "repos/octo/ace/issues/7/timeline?per_page=25&page=1": [
      {
        body: [
          future,
          { id: 92, event: "labeled", actor: null, label: { name: "bug" }, created_at: null },
          { id: 93, event: "committed", sha, actor: { login: "contributor" } },
        ],
      },
    ],
  });
  try {
    expect(await f.forge.prActivity(7, 1, signal())).toMatchObject({
      events: [
        {
          id: "91",
          event: "future_provider_event",
          actor: "octo",
          actorAvatarUrl: "https://github.com/octo.png",
          at: future.created_at,
          raw: future,
        },
        { id: "92", event: "labeled", actor: "GitHub", subject: "bug", at: null },
        { id: "93", event: "committed", commitSha: sha, at: null },
      ],
      truncated: false,
    });
  } finally {
    await f.cleanup();
  }
});
