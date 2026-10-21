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
  labels: [{ name: "bug", color: "d73a4a" }],
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
/** A commit as GitHub's GraphQL `pullRequest.commits` lists it. */
const commitNode = (oid: string, message = "Handle empty input") => ({
  commit: {
    oid,
    message,
    url: `${pr.html_url}/commits/${oid}`,
    additions: 8,
    deletions: 3,
    author: { name: "Contributor", date: "2026-10-01", user: { login: "contributor" } },
  },
});
/** One newest-first page of a PR's commits; `before` is the cursor of the next older page. */
const commitPage = (
  nodes: unknown[],
  options: { head?: string; before?: string; total?: number } = {},
) => ({
  body: {
    data: {
      repository: {
        pullRequest: {
          headRefOid: options.head ?? sha,
          baseRefOid: nextSha,
          commits: {
            totalCount: options.total ?? nodes.length,
            pageInfo: {
              hasPreviousPage: options.before !== undefined,
              startCursor: options.before ?? null,
            },
            nodes,
          },
        },
      },
    },
  },
});
const commitsQuery = "graphql:query PrCommits(";

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

test("a search for your own PRs or reviews asked of you leaves GitHub to resolve @me", async () => {
  for (const [filter, qualifier] of [
    [{ author: "@me" }, "author:@me"],
    [{ reviewer: "@me" }, "review-requested:@me"],
  ] as const) {
    const params = new URLSearchParams({
      q: `repo:octo/ace is:pr is:open draft:false ${qualifier}`,
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
                  statusCheckRollup: null,
                },
              },
            },
          },
        },
      ],
    });
    try {
      const result = await f.forge.listPrs(ForgePrSearch.parse(filter), signal());
      expect(result.items.map((item) => item.ref.number)).toEqual([7]);
    } finally {
      await f.cleanup();
    }
  }
  expect(ForgePrSearch.safeParse({ author: "@you" }).success).toBe(false);
});

test("a listed PR carries its label colours, people, branches, review decision, size and conflicts", async () => {
  const query = ForgePrSearch.parse({
    state: "all",
    assignee: "@me",
    labels: ["bug"],
    review: "approved",
    ci: "success",
  });
  const params = new URLSearchParams({
    q: 'repo:octo/ace is:pr "fix" assignee:@me label:"bug" review:approved status:success',
    sort: "updated",
    order: "desc",
    per_page: "25",
    page: "1",
  });
  const f = await fakeGh({
    [`search/issues?${params}`]: [
      {
        body: {
          total_count: 1,
          incomplete_results: false,
          items: [
            {
              ...row,
              draft: false,
              created_at: "2026-09-30T00:00:00Z",
              user: { login: "octo", avatar_url: "https://avatars.example/octo" },
              labels: [
                { name: "bug", color: "d73a4a" },
                { name: "odd", color: "not a colour" },
              ],
              assignees: [{ login: "you", avatar_url: "https://avatars.example/you" }],
            },
          ],
        },
      },
    ],
    graphql: [
      {
        body: {
          data: {
            ...counts.data,
            viewer: { login: "you" },
            repository: {
              p0: {
                comments: { totalCount: 1 },
                reviews: { totalCount: 1 },
                statusCheckRollup: { state: "SUCCESS" },
                reviewDecision: "APPROVED",
                headRefName: "fix/build",
                baseRefName: "main",
                additions: 12,
                deletions: 3,
                mergeable: "CONFLICTING",
                reviewRequests: {
                  nodes: [{ requestedReviewer: { login: "mira", avatarUrl: "https://a/mira" } }],
                },
              },
            },
          },
        },
      },
    ],
  });
  try {
    const result = await f.forge.listPrs({ ...query, search: "fix" }, signal());
    expect(result.viewer).toBe("you");
    expect(result.items[0]).toMatchObject({
      labelColors: { bug: "d73a4a" },
      createdAt: "2026-09-30T00:00:00Z",
      assignees: ["you"],
      reviewers: ["mira"],
      avatars: {
        octo: "https://avatars.example/octo",
        you: "https://avatars.example/you",
        mira: "https://a/mira",
      },
      reviewDecision: "APPROVED",
      headBranch: "fix/build",
      baseBranch: "main",
      additions: 12,
      deletions: 3,
      conflicting: true,
      ci: "success",
    });
    expect(result.items[0]?.labelColors).not.toHaveProperty("odd");
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
      labels: ["bug"],
      labelColors: { bug: "d73a4a" },
    });
  } finally {
    await f.cleanup();
  }
});

test("PR detail returns the head and the file list from one GraphQL request", async () => {
  const fixtures = standard();
  fixtures["repos/octo/ace/pulls/7"] = [{ body: richPr }];
  fixtures.graphql = [{ body: threads() }];
  fixtures["graphql:reviewDecision headRefOid"] = [
    {
      body: {
        data: {
          repository: {
            pullRequest: {
              reviewDecision: "APPROVED",
              headRefOid: sha,
              files: {
                nodes: [
                  { path: "src/main.ts", additions: 3, deletions: 1, changeType: "MODIFIED" },
                  { path: "new.ts", additions: 5, deletions: 0, changeType: "ADDED" },
                  { path: "old.ts", additions: 0, deletions: 4, changeType: "DELETED" },
                ],
              },
            },
          },
        },
      },
    },
  ];
  const f = await fakeGh(fixtures);
  try {
    expect(await f.forge.prDetail(7, signal())).toMatchObject({
      status: { ref: { repository, number: 7 }, headSha: sha },
      reviewDecision: "APPROVED",
      files: [
        { path: "src/main.ts", additions: 3, deletions: 1, status: "modified" },
        { path: "new.ts", additions: 5, deletions: 0, status: "added" },
        { path: "old.ts", additions: 0, deletions: 4, status: "removed" },
      ],
    });
    const decision = (await f.requests()).filter(
      (request) =>
        request.path === "graphql" && JSON.stringify(request.body ?? "").includes("reviewDecision"),
    );
    expect(decision).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("PR detail still loads when the file list is missing or malformed", async () => {
  for (const files of [undefined, null, { nodes: [{ path: 7 }] }]) {
    const fixtures = standard();
    fixtures["repos/octo/ace/pulls/7"] = [{ body: richPr }];
    fixtures.graphql = [{ body: threads() }];
    fixtures["graphql:reviewDecision headRefOid"] = [
      {
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewDecision: "APPROVED",
                headRefOid: sha,
                ...(files === undefined ? {} : { files }),
              },
            },
          },
        },
      },
    ];
    const f = await fakeGh(fixtures);
    try {
      const read = await f.forge.prDetail(7, signal());
      expect(read).toMatchObject({ status: { headSha: sha }, reviewDecision: "APPROVED" });
      expect(read.files).toBeUndefined();
    } finally {
      await f.cleanup();
    }
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
    [commitsQuery]: [commitPage([commitNode(sha)])],
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
    await expect(f.forge.prCommits(7, undefined, sha, cancelled.signal)).rejects.toMatchObject({
      kind: "cancelled",
    });
  } finally {
    await f.cleanup();
  }
  const limited = await fakeGh({
    [commitsQuery]: [{ status: 429, headers: { "retry-after": "60" } }],
  });
  try {
    await expect(limited.forge.prCommits(7, undefined, sha, signal())).rejects.toMatchObject({
      kind: "rate_limit",
      retryAt: 61_000,
    });
  } finally {
    await limited.cleanup();
  }
});

test("a push during a commit-list read cannot label the new commits with the previously selected head", async () => {
  // The push landed before the page was read: the page names the new head.
  const f = await fakeGh({
    [commitsQuery]: [commitPage([commitNode(nextSha)], { head: nextSha })],
  });
  try {
    await expect(f.forge.prCommits(7, undefined, sha, signal())).rejects.toMatchObject({
      kind: "conflict",
    });
  } finally {
    await f.cleanup();
  }
});

test("a PR with more than 250 commits lists every one, newest page first, with statistics and authors", async () => {
  // GitHub lists the newest 250 of these 260; the comparison of base and head has them all.
  const shas = Array.from({ length: 260 }, (_, n) => n.toString(16).padStart(40, "0"));
  const compared = `repos/octo/ace/compare/${nextSha}...${sha}?per_page=100&page=1`;
  const f = await fakeGh({
    [commitsQuery]: [
      commitPage(
        shas.slice(160).map((oid) => commitNode(oid)),
        { before: "c160", total: 260 },
      ),
      commitPage(
        shas.slice(60, 160).map((oid) => commitNode(oid)),
        { before: "c60", total: 260 },
      ),
      commitPage(
        shas.slice(10, 60).map((oid) => commitNode(oid)),
        { total: 260 },
      ),
    ],
    [compared]: [
      {
        body: {
          total_commits: 260,
          commits: shas.slice(0, 100).map((oid) => Object.assign({}, commit, { sha: oid })),
          files: [file],
        },
      },
    ],
    "graphql:object(oid:": [
      {
        body: {
          data: {
            repository: Object.fromEntries(
              shas.slice(0, 10).map((oid, i) => [`c${i}`, { oid, additions: i, deletions: 1 }]),
            ),
          },
        },
      },
    ],
  });
  try {
    const newest = await f.forge.prCommits(7, undefined, sha, signal());
    expect(newest).toMatchObject({
      before: "c160",
      alongside: [`compare:1:10:${nextSha}`],
      total: 260,
      truncated: false,
    });
    expect(newest.commits.at(-1)).toMatchObject({
      sha: shas[259],
      author: "contributor",
      message: "Handle empty input",
      additions: 8,
      deletions: 3,
      date: "2026-10-01",
    });
    const middle = await f.forge.prCommits(7, newest.before, sha, signal());
    const listed = await f.forge.prCommits(7, middle.before, sha, signal());
    expect(listed.before).toBeUndefined();
    const older = await f.forge.prCommits(7, newest.alongside?.[0], sha, signal());
    expect(older.commits[3]).toMatchObject({
      sha: shas[3],
      author: "contributor",
      additions: 3,
      deletions: 1,
    });
    const all = [older, listed, middle, newest].flatMap((page) => page.commits);
    expect(all.map((c) => c.sha)).toEqual(shas);
    // Each listed page is asked for by the cursor the newer one named.
    const cursors = (await f.requests())
      .filter((request) => request.path === "graphql")
      .flatMap((request) => {
        const variables = (request.body as { variables?: { before: unknown } }).variables;
        return variables ? [variables.before] : [];
      });
    expect(cursors).toEqual([null, "c160", "c60"]);
  } finally {
    await f.cleanup();
  }
});

test("older commits read after a push to the base or head are refused, not mixed in", async () => {
  const compared = `repos/octo/ace/compare/${nextSha}...${sha}?per_page=100&page=1`;
  const f = await fakeGh({
    // Two more commits landed since the newest page counted 260.
    [compared]: [{ body: { total_commits: 262, commits: [{ ...commit, sha }] } }],
  });
  try {
    await expect(
      f.forge.prCommits(7, `compare:1:10:${nextSha}`, sha, signal()),
    ).rejects.toMatchObject({ kind: "conflict" });
  } finally {
    await f.cleanup();
  }
});

test("a commit older than the newest page still opens its own diff", async () => {
  const old = "d".repeat(40);
  const f = await fakeGh({
    "repos/octo/ace/pulls/7": [{ body: richPr }],
    [commitsQuery]: [
      commitPage([commitNode(sha)], { before: "c1", total: 301 }),
      commitPage([commitNode(old)], { total: 301 }),
    ],
    [`repos/octo/ace/commits/${old}?per_page=25&page=1`]: [
      { body: { ...commit, sha: old, parents: [{ sha: nextSha }], files: [file] } },
    ],
  });
  try {
    expect(
      await f.forge.prFiles(
        { number: 7, page: 1, headSha: sha, baseSha: nextSha, commit: old },
        signal(),
      ),
    ).toMatchObject({ commit: old, baseSha: nextSha, files: [{ patch: file.patch }] });
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
    [commitsQuery]: [commitPage([commitNode(sha)])],
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
    "repos/octo/ace/issues/7/timeline?per_page=100&page=1": [
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
