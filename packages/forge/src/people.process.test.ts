import { expect, test } from "vitest";
import { fakeGh, reviewFixtures, reviewHost } from "./testing/fixtures.ts";
import type { ForgeReviewAction } from "@ace/protocol/forge-review";
import { ForgeError } from "./index.ts";

const signal = () => new AbortController().signal;
const allowed = () => true;
const requested = "repos/octo/ace/pulls/7/requested_reviewers";
const pr = { number: 7, html_url: "https://github.com/octo/ace/pull/7" };

function reviewers(permission: string, state = "OPEN") {
  return {
    data: {
      repository: {
        viewerPermission: permission,
        pullRequest: {
          state,
          viewerCanUpdate: true,
          author: { login: "author" },
          reviewRequests: {
            nodes: [
              { requestedReviewer: { kind: "User", login: "ola", avatarUrl: "https://a/ola" } },
              { requestedReviewer: { kind: "Team", slug: "core", name: "Core" } },
              { requestedReviewer: null },
            ],
          },
          latestReviews: {
            nodes: [
              {
                databaseId: 31,
                state: "CHANGES_REQUESTED",
                submittedAt: "2026-10-20T10:00:00Z",
                author: { login: "mira", avatarUrl: "https://a/mira" },
              },
              { databaseId: 32, state: "SOMETHING_NEW", submittedAt: null, author: { login: "x" } },
            ],
          },
          suggestedReviewers: [
            { isAuthor: false, isCommenter: true, reviewer: { login: "jonas", name: "Jonas" } },
          ],
        },
      },
    },
  };
}

test("a PR's reviewers read who is asked (people and teams), each latest review and GitHub's suggestions", async () => {
  const f = await fakeGh({
    "graphql:query AcePrReviewers": [
      { body: reviewers("WRITE") },
      { body: reviewers("READ") },
      { body: reviewers("ADMIN", "MERGED") },
    ],
  });
  try {
    const value = await f.forge.prReviewers(7, signal());
    expect(value.requested).toEqual([
      { kind: "user", login: "ola", avatarUrl: "https://a/ola" },
      { kind: "team", slug: "core", name: "Core" },
    ]);
    // A review state GitHub adds later is left out rather than failing the read.
    expect(value.reviews).toEqual([
      {
        id: 31,
        login: "mira",
        avatarUrl: "https://a/mira",
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-10-20T10:00:00Z",
      },
    ]);
    expect(value.suggested).toEqual([
      { login: "jonas", name: "Jonas", isAuthor: false, isCommenter: true },
    ]);
    expect(value).toMatchObject({ author: "author", canRequest: true, canDismiss: true });
    // Read access can't dismiss; nothing changes on a merged PR.
    expect(await f.forge.prReviewers(7, signal())).toMatchObject({ canDismiss: false });
    expect(await f.forge.prReviewers(7, signal())).toMatchObject({
      canRequest: false,
      canDismiss: false,
    });
  } finally {
    await f.cleanup();
  }
});

test("withdrawing review requests deletes them, people and teams, and is confirmed once gone", async () => {
  const fixtures = reviewFixtures();
  fixtures[requested] = [
    { body: pr },
    { body: { users: [{ login: "ola" }], teams: [] } },
    { body: { users: [], teams: [] } },
  ];
  const f = await fakeGh(fixtures);
  const action: ForgeReviewAction = {
    kind: "reviewers.remove",
    reviewers: ["ola"],
    teams: ["core"],
  };
  try {
    await f.forge.reviews.write(7, action, [], "remove", signal(), allowed);
    const write = (await f.requests()).find((r) => r.path === requested);
    expect(write?.args).toContain("DELETE");
    expect(write?.body).toEqual({ reviewers: ["ola"], team_reviewers: ["core"] });
    // Still asked: not confirmed. Gone: confirmed.
    expect(await f.forge.reviews.reconcile(7, action, "remove", signal())).toBe(false);
    expect(await f.forge.reviews.reconcile(7, action, "remove", signal())).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("asking a team to review sends it as a team reviewer and confirms it is asked", async () => {
  const fixtures = reviewFixtures();
  fixtures[requested] = [
    { body: pr },
    { body: { users: [{ login: "Mira" }], teams: [{ slug: "core" }] } },
  ];
  const f = await fakeGh(fixtures);
  const action: ForgeReviewAction = {
    kind: "reviewers.request",
    reviewers: ["mira"],
    teams: ["core"],
  };
  try {
    await f.forge.reviews.write(7, action, [], "ask", signal(), allowed);
    const write = (await f.requests()).find((r) => r.path === requested);
    expect(write?.args).toContain("POST");
    expect(write?.body).toEqual({ reviewers: ["mira"], team_reviewers: ["core"] });
    expect(await f.forge.reviews.reconcile(7, action, "ask", signal())).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("dismissing takes back an approval with its reason, and refuses a review with no verdict", async () => {
  const fixtures = reviewFixtures();
  fixtures["repos/octo/ace/pulls/7/reviews/31"] = [
    { body: { id: 31, state: "APPROVED" } },
    { body: { id: 31, state: "DISMISSED" } },
  ];
  fixtures["repos/octo/ace/pulls/7/reviews/31/dismissals"] = [
    { body: { id: 31, state: "DISMISSED" } },
  ];
  fixtures["repos/octo/ace/pulls/7/reviews/32"] = [{ body: { id: 32, state: "COMMENTED" } }];
  const f = await fakeGh(fixtures);
  const dismiss = { kind: "review.dismiss", reviewId: 31, message: "Out of date" } as const;
  try {
    await f.forge.reviews.write(7, dismiss, [], "dismiss", signal(), allowed);
    const write = (await f.requests()).find((r) => r.path.endsWith("/dismissals"));
    expect(write?.args).toContain("PUT");
    expect(write?.body).toEqual({ message: "Out of date", event: "DISMISS" });
    expect(await f.forge.reviews.reconcile(7, dismiss, "dismiss", signal())).toBe(true);
    const comment = { kind: "review.dismiss", reviewId: 32, message: "No" } as const;
    await expect(f.forge.reviews.write(7, comment, [], "c", signal(), allowed)).rejects.toEqual(
      new ForgeError("conflict"),
    );
    expect((await f.requests()).filter((r) => r.path.endsWith("/dismissals"))).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("reviewer changes on a closed PR are refused before anything is sent", async () => {
  const fixtures = reviewFixtures();
  fixtures["graphql:viewer { login }"] = [{ body: reviewHost({ state: "CLOSED" }) }];
  const f = await fakeGh(fixtures);
  try {
    await expect(
      f.forge.reviews.write(
        7,
        { kind: "reviewers.remove", reviewers: ["ola"] },
        [],
        "x",
        signal(),
        allowed,
      ),
    ).rejects.toEqual(new ForgeError("conflict"));
    expect((await f.requests()).some((r) => r.path === requested)).toBe(false);
  } finally {
    await f.cleanup();
  }
});

const node = (number: number, kind: string, state: string, isDraft = false) => ({
  kind,
  number,
  title: `Item ${number}`,
  state,
  ...(kind === "PullRequest" ? { isDraft } : {}),
});

test("references put an exact number first, then open, then recent, each once, and keep searches in the repository", async () => {
  const f = await fakeGh({
    "graphql:query AceReferences": [
      {
        body: {
          data: {
            open: { nodes: [node(12, "PullRequest", "OPEN", true), node(3, "Issue", "OPEN")] },
            recent: {
              nodes: [
                node(3, "Issue", "OPEN"),
                node(9, "PullRequest", "MERGED"),
                { kind: "Discussion" },
              ],
            },
            repository: { issueOrPullRequest: node(9, "PullRequest", "MERGED") },
          },
        },
      },
    ],
  });
  try {
    expect(await f.forge.references("9", signal())).toEqual([
      { number: 9, title: "Item 9", kind: "pr", state: "merged" },
      { number: 12, title: "Item 12", kind: "pr", state: "draft" },
      { number: 3, title: "Item 3", kind: "issue", state: "open" },
    ]);
    await f.forge.references("repo:other/x fix", signal());
    const [exact, words] = (await f.requests()).map(
      (r) => (r.body as { variables: Record<string, unknown> }).variables,
    );
    expect(exact).toMatchObject({
      number: 9,
      exact: true,
      open: "repo:octo/ace sort:updated-desc is:open",
    });
    // A qualifier typed in the search can't point it at another repository.
    expect(words).toMatchObject({
      exact: false,
      recent: "repo:octo/ace sort:updated-desc repo other x fix",
    });
  } finally {
    await f.cleanup();
  }
});

test("people are searched once per query and reused while fresh", async () => {
  const f = await fakeGh({
    "graphql:query AcePeople": [
      {
        body: {
          data: {
            repository: {
              mentionableUsers: {
                nodes: [{ login: "mira", name: "Mira", avatarUrl: null }, null, { login: "milo" }],
              },
            },
          },
        },
      },
    ],
  });
  try {
    expect(await f.forge.people("mi", signal())).toEqual([
      { login: "mira", name: "Mira" },
      { login: "milo" },
    ]);
    await f.forge.people("MI ", signal());
    expect(await f.requests()).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});
