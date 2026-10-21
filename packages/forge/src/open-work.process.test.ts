import { expect, test } from "vitest";
import { fakeGh, repository } from "./testing/fixtures.ts";

const signal = () => new AbortController().signal;
const pr = (number: number, fields: Record<string, unknown> = {}) => ({
  number,
  title: `Change ${number}`,
  url: `https://github.com/octo/ace/pull/${number}`,
  state: "OPEN",
  isDraft: false,
  updatedAt: "2026-10-18T10:00:00Z",
  author: { login: "octo", avatarUrl: "https://github.com/octo.png" },
  labels: { nodes: [{ name: "bug" }] },
  comments: { totalCount: 2 },
  reviews: { totalCount: 1 },
  statusCheckRollup: { state: "SUCCESS" },
  ...fields,
});
const issue = {
  number: 7,
  title: "Sidebar loses scroll position",
  url: "https://github.com/octo/ace/issues/7",
  state: "OPEN",
  createdAt: "2026-10-17T10:00:00Z",
  updatedAt: "2026-10-17T11:00:00Z",
  author: null,
  labels: { nodes: [{ name: "ui" }] },
  assignees: { nodes: [{ login: "maintainer" }] },
  milestone: { title: "Release" },
  futureField: "kept",
};

test("New thread's open PRs, failing PRs and issues come from one GitHub request, newest first", async () => {
  const gh = await fakeGh({
    "graphql:query OpenWork": [
      {
        body: {
          data: {
            pullRequests: {
              issueCount: 140,
              nodes: [pr(12, { isDraft: true, statusCheckRollup: null }), null, pr(9)],
            },
            failingPullRequests: {
              issueCount: 1,
              nodes: [pr(3, { author: null, statusCheckRollup: { state: "FAILURE" } })],
            },
            issues: { issueCount: 14, nodes: [issue] },
          },
        },
      },
    ],
  });
  try {
    const work = await gh.forge.openWork(signal());
    expect(work).toMatchObject({
      repository,
      pullRequests: {
        total: 140,
        items: [
          { ref: { repository, number: 12 }, state: "draft", ci: "none", labels: ["bug"] },
          {
            ref: { repository, number: 9 },
            state: "open",
            ci: "success",
            author: "octo",
            authorAvatarUrl: "https://github.com/octo.png",
            commentCount: 2,
            reviewCount: 1,
          },
        ],
      },
      failingPullRequests: {
        total: 1,
        items: [{ ref: { repository, number: 3 }, ci: "failure", author: "deleted user" }],
      },
      issues: {
        total: 14,
        items: [
          {
            ref: { repository, number: 7 },
            state: "open",
            author: "deleted user",
            labels: ["ui"],
            assignees: ["maintainer"],
            milestone: "Release",
            raw: { futureField: "kept" },
          },
        ],
      },
    });
    const requests = await gh.requests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      variables: {
        pullRequests: "repo:octo/ace is:pr is:open sort:updated-desc",
        failingPullRequests: "repo:octo/ace is:pr is:open status:failure sort:updated-desc",
        issues: "repo:octo/ace is:issue is:open sort:updated-desc",
      },
    });
  } finally {
    await gh.cleanup();
  }
});

test("a malformed open-work answer fails instead of showing partial lists", async () => {
  const gh = await fakeGh({
    "graphql:query OpenWork": [
      { body: { data: { pullRequests: { issueCount: 1, nodes: [{ number: "x" }] } } } },
    ],
  });
  try {
    await expect(gh.forge.openWork(signal())).rejects.toMatchObject({ kind: "invalid_data" });
  } finally {
    await gh.cleanup();
  }
});
