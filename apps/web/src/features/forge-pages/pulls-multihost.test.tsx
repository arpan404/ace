import { prQuery, readinessQueries } from "@ace/ui-core";
import { seedForgeBrowse, workbench } from "@ace/fake-daemon";
import { ForgePrDetail, WorkspaceId, type ForgePrRow } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const ace = WorkspaceId.parse("ace");

function withRepository() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  seedForgeBrowse(app.daemon, Date.now());
  return app;
}

const githubRepo = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
const gitlabRepo = {
  forge: "gitlab",
  host: "gitlab.example.com",
  owner: "acme",
  name: "ace",
} as const;

function row(
  repository: typeof githubRepo | typeof gitlabRepo,
  number: number,
  title: string,
): ForgePrRow {
  return {
    ref: { repository: { ...repository }, number },
    title,
    url: `https://${repository.host}/${repository.owner}/${repository.name}/pull/${number}`,
    author: "sam",
    state: "open",
    labels: [],
    updatedAt: new Date(Date.now() - number * 60_000).toISOString(),
  };
}

test("same owner/name/number on distinct forge/host lists both rows", async () => {
  const app = withRepository();
  const query = prQuery({ project: "ace", sort: "updated" }, 1);
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.list", workspaceId: ace, query: { ...query, page: 1 } },
    {
      resource: "prList",
      value: {
        repository: { ...githubRepo },
        items: [
          row(githubRepo, 500, "GitHub same number"),
          row(gitlabRepo, 500, "GitLab same number"),
        ],
        total: 2,
        counts: { open: 2, draft: 0, closed: 0, merged: 0 },
        viewer: "you",
        incomplete: false,
        truncated: false,
      },
    },
  );
  await app.open("/pulls?project=ace&sort=updated");
  const list = await screen.findByRole("navigation", { name: "Pull requests" });
  expect(await within(list).findByRole("link", { name: /GitHub same number/ })).toBeTruthy();
  expect(await within(list).findByRole("link", { name: /GitLab same number/ })).toBeTruthy();
  expect(within(list).getAllByRole("listitem").length).toBe(2);
  const hosted = within(list)
    .getAllByRole("listitem")
    .find((item) => within(item).queryByRole("link", { name: /GitLab same number/ }) !== null);
  if (!hosted) throw new Error("Missing hosted review row");
  expect(within(hosted).getByText("Review status unavailable")).toBeTruthy();
  expect(within(hosted).queryByText("Ready to merge")).toBeNull();
  expect(within(hosted).getByRole("button", { name: /^View:/ })).toBeTruthy();
});

const listNav = async () => screen.findByRole("navigation", { name: "Pull requests" });

function detail(repository: typeof githubRepo | typeof gitlabRepo, number: number, title: string) {
  const hosted = repository.forge !== "github";
  return ForgePrDetail.parse({
    ...(hosted ? { readOnly: true, unavailableResources: ["comments", "checks", "reviews"] } : {}),
    status: {
      ref: { repository: { ...repository }, number },
      title,
      url: hosted
        ? `https://${repository.host}/acme/ace/-/merge_requests/${number}`
        : `https://${repository.host}/acme/ace/pull/${number}`,
      headSha: "a".repeat(40),
      state: "open",
      mergeability: hosted ? "unknown" : "mergeable",
      ci: hosted ? "unknown" : "success",
      checks: [],
      comments: [],
      reviewThreads: [],
      raw: {},
    },
    body: "",
    author: "sam",
    headBranch: "fix",
    baseBranch: "main",
    baseSha: "b".repeat(40),
    headRepository: { ...repository },
    labels: [],
    reviewers: [],
    reviewDecision: hosted ? null : "APPROVED",
    commits: 1,
    changedFiles: 1,
    relatedThreads: [],
    relatedThreadsTruncated: false,
  });
}

test("each same-numbered row opens its own provider's review", async () => {
  const app = withRepository();
  const query = prQuery({ project: "ace", sort: "updated" }, 1);
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.list", workspaceId: ace, query: { ...query, page: 1 } },
    {
      resource: "prList",
      value: {
        repository: { ...githubRepo },
        items: [
          row(githubRepo, 500, "GitHub same number"),
          row(gitlabRepo, 500, "GitLab same number"),
        ],
        total: 2,
        counts: { open: 2, draft: 0, closed: 0, merged: 0 },
        viewer: "you",
        incomplete: false,
        truncated: false,
      },
    },
  );
  for (const [repository, title] of [
    [githubRepo, "GitHub same number"],
    [gitlabRepo, "GitLab same number"],
  ] as const)
    app.daemon.workspace.setForgeRead(
      { op: "forge.pr.detail", workspaceId: ace, repository: { ...repository }, number: 500 },
      { resource: "prDetail", value: detail(repository, 500, title) },
    );
  await app.open("/pulls?project=ace&sort=updated");
  // View on the GitLab row opens the GitLab merge request, read only.
  const hosted = within(await listNav())
    .getAllByRole("listitem")
    .find((item) => within(item).queryByRole("link", { name: /GitLab same number/ }) !== null);
  if (!hosted) throw new Error("Missing hosted review row");
  await userEvent.click(within(hosted).getByRole("button", { name: /^View:/ }));
  const gitlabPage = await screen.findByRole("article", { name: "Pull request #500" });
  expect(await within(gitlabPage).findByText("GitLab same number")).toBeTruthy();
  expect(within(gitlabPage).getByText(/Read only in ace/)).toBeTruthy();
  expect(within(gitlabPage).getByRole("link", { name: "Open on GitLab" })).toHaveProperty(
    "href",
    "https://gitlab.example.com/acme/ace/-/merge_requests/500",
  );
  expect(within(gitlabPage).queryByRole("button", { name: /merge/i })).toBeNull();
  expect(within(gitlabPage).queryByText("GitHub same number")).toBeNull();
  await userEvent.click(within(gitlabPage).getByRole("button", { name: "Back to pull requests" }));
  // The GitHub row's title opens the GitHub pull request, with GitHub's page.
  await userEvent.click(
    await within(await listNav()).findByRole("link", { name: /GitHub same number/ }),
  );
  const githubPage = await screen.findByRole("article", { name: "Pull request #500" });
  expect(await within(githubPage).findByText("GitHub same number")).toBeTruthy();
  await within(githubPage).findByRole("tablist", { name: "Pull request detail" });
  expect(within(githubPage).queryByText(/Read only in ace/)).toBeNull();
  expect(within(githubPage).queryByText("GitLab same number")).toBeNull();
});

test("incomplete totals are suppressed and noticed instead of showing zero or complete", async () => {
  const app = withRepository();
  const query = prQuery({ project: "ace", sort: "updated" }, 1);
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.list", workspaceId: ace, query: { ...query, page: 1 } },
    {
      resource: "prList",
      value: {
        repository: { ...githubRepo },
        items: [row(githubRepo, 501, "Only row known so far")],
        total: 99,
        counts: { open: 99, draft: 0, closed: 0, merged: 0 },
        viewer: "you",
        incomplete: true,
        truncated: false,
      },
    },
  );
  await app.open("/pulls?project=ace&sort=updated");
  const list = await screen.findByRole("navigation", { name: "Pull requests" });
  await within(list).findByRole("link", { name: /Only row known so far/ });
  expect(await screen.findByText("Some totals are incomplete.")).toBeTruthy();
  const states = await screen.findByRole("group", { name: "State" });
  expect(within(states).getByRole("button", { name: "Open" }).textContent).not.toMatch(/\d/);
  expect(within(states).getByRole("button", { name: "Merged" }).textContent).not.toMatch(/\d/);
});

test("a ranked read failure falls back to the listed rows", async () => {
  const app = withRepository();
  const listedQuery = prQuery({ project: "ace" }, 1);
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.list", workspaceId: ace, query: { ...listedQuery, page: 1 } },
    {
      resource: "prList",
      value: {
        repository: { ...githubRepo },
        items: [row(githubRepo, 502, "Listed row when ranking fails")],
        total: 30,
        nextPage: 2,
        counts: { open: 30, draft: 0, closed: 0, merged: 0 },
        viewer: "you",
        incomplete: false,
        truncated: false,
      },
    },
  );
  const firstReady = readinessQueries({ project: "ace" })[0];
  if (!firstReady) throw new Error("No readiness query");
  app.daemon.workspace.failForgeRead(
    {
      op: "forge.pr.list",
      workspaceId: ace,
      query: { ...firstReady, page: 1 },
    },
    "forge_rate_limit",
  );
  await app.open("/pulls?project=ace");
  const list = await screen.findByRole("navigation", { name: "Pull requests" });
  await waitFor(async () =>
    expect(
      await within(list).findByRole("link", { name: /Listed row when ranking fails/ }),
    ).toBeTruthy(),
  );
});
