import { expect, test } from "vitest";
import { ForgeIssueSearch } from "@ace/protocol/forge-issues";
import { fakeGh, repository, issueRecord, issuePermissions } from "./testing/fixtures.ts";
const signal = () => new AbortController().signal;

test("issue search applies repository, literal search, labels and assignment filters with bounded counts", async () => {
  const query = ForgeIssueSearch.parse({
    state: "closed",
    search: "retry repo:other/private",
    labels: ["bug", "needs review"],
    author: "author",
    assignee: "maintainer",
    milestone: "Release",
    page: 40,
  });
  const params = new URLSearchParams({
    q: 'repo:octo/ace is:issue is:closed "retry" "repo:other/private" author:author assignee:maintainer label:"bug" label:"needs review" milestone:"Release"',
    sort: "updated",
    order: "desc",
    per_page: "25",
    page: "40",
  });
  const gh = await fakeGh({
    [`search/issues?${params}`]: [
      {
        body: {
          total_count: 1005,
          incomplete_results: true,
          items: [{ ...issueRecord, state: "closed" }],
        },
      },
    ],
    graphql: [{ body: { data: { open: { issueCount: 3 }, closed: { issueCount: 1005 } } } }],
    "repos/octo/ace": [{ body: { archived: false, has_issues: true } }],
  });
  try {
    const result = await gh.forge.listIssues(query, signal());
    expect(result).toMatchObject({
      items: [
        {
          ref: { repository, number: 7 },
          state: "closed",
          assignees: ["maintainer"],
          milestone: "Release",
        },
      ],
      counts: { open: 3, closed: 1005 },
      truncated: true,
      incomplete: true,
      canCreate: true,
    });
    expect(result.nextPage).toBeUndefined();
  } finally {
    await gh.cleanup();
  }
});

test("issue detail keeps Markdown and unknown fields and reports viewer permissions", async () => {
  const gh = await fakeGh({
    "repos/octo/ace/issues/7": [{ body: issueRecord }],
    graphql: [{ body: issuePermissions(false) }],
  });
  try {
    expect(await gh.forge.issueDetail(7, signal())).toMatchObject({
      body: issueRecord.body,
      raw: { future: { retained: true } },
      permissions: { edit: false, close: false, reopen: false, comment: true },
      relatedThreads: [],
    });
  } finally {
    await gh.cleanup();
  }
});

test("ordered timeline distinguishes issue comments and PR references and retains future activity", async () => {
  const gh = await fakeGh({
    "repos/octo/ace/issues/7/timeline?per_page=25&page=1": [
      {
        body: [
          {
            id: 2,
            event: "future_event",
            actor: { login: "bot" },
            created_at: "2026-10-02",
            future: true,
          },
          {
            id: 1,
            event: "commented",
            user: { login: "author" },
            body: "**Context**",
            created_at: "2026-10-01",
          },
          {
            id: 3,
            event: "cross-referenced",
            created_at: "2026-10-03",
            source: { issue: { pull_request: { html_url: "https://github.com/octo/ace/pull/8" } } },
          },
        ],
        headers: {
          link: '<https://api.github.com/repos/octo/ace/issues/7/timeline?per_page=25&page=2>; rel="next"',
        },
      },
    ],
  });
  try {
    expect(await gh.forge.issueTimeline(7, 1, signal())).toMatchObject({
      events: [
        { kind: "issue_comment", body: "**Context**" },
        { kind: "activity", raw: { future: true } },
        { pullRequestUrl: "https://github.com/octo/ace/pull/8" },
      ],
      nextPage: 2,
      truncated: false,
    });
  } finally {
    await gh.cleanup();
  }
});

test("stale issue edits and forbidden state changes leave GitHub unchanged", async () => {
  const gh = await fakeGh({
    "repos/octo/ace/issues/7": [{ body: issueRecord }],
    graphql: [{ body: issuePermissions(false) }],
  });
  try {
    await expect(
      gh.forge.writeIssue(
        { action: "edit", number: 7, title: "Change", body: "text", expectedUpdatedAt: "earlier" },
        "action",
        signal(),
      ),
    ).rejects.toMatchObject({ kind: "conflict" });
    await expect(
      gh.forge.writeIssue(
        { action: "state", number: 7, state: "closed", expectedUpdatedAt: issueRecord.updated_at },
        "state",
        signal(),
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect((await gh.requests()).filter((request) => request.args.includes("PATCH"))).toEqual([]);
  } finally {
    await gh.cleanup();
  }
});

test("a lost issue creation can be recovered from its marker without another POST", async () => {
  const gh = await fakeGh({
    "repos/octo/ace": [{ body: { archived: false, has_issues: true } }],
    "repos/octo/ace/issues": [{ status: 500, body: { message: "response lost" } }],
    "repos/octo/ace/issues?state=all&sort=created&direction=desc&per_page=100&page=1": [
      { body: [{ ...issueRecord, body: "Draft\n\n<!-- ace-issue-action:create-once -->" }] },
    ],
  });
  try {
    const input = { action: "create", title: "Handle retries", body: "Draft" } as const;
    await expect(gh.forge.writeIssue(input, "create-once", signal())).rejects.toMatchObject({
      kind: "cli",
    });
    expect(await gh.forge.reconcileIssue(input, "create-once", signal())).toEqual({
      repository,
      number: 7,
    });
    const writes = (await gh.requests()).filter((request) => request.args.includes("POST"));
    expect(writes.map((request) => request.body)).toEqual([
      { title: "Handle retries", body: "Draft\n\n<!-- ace-issue-action:create-once -->" },
    ]);
  } finally {
    await gh.cleanup();
  }
});
