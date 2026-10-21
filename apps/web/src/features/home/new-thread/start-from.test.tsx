import { workbench } from "@ace/fake-daemon";
import {
  ForgeIssueDetail,
  ForgeIssueSearch,
  ForgePrDetail,
  ForgePrSearch,
  WorkspaceId,
} from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { createMemoryHistory } from "@tanstack/react-router";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const repository = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
const workspaceId = WorkspaceId.parse("ace");

function pr(
  number: number,
  title: string,
  ci: "success" | "failure" | "pending",
  state: "open" | "draft" = "open",
) {
  return {
    ref: { repository, number },
    title,
    url: `https://github.com/acme/ace/pull/${number}`,
    author: "dev",
    state,
    labels: [],
    updatedAt: "2026-10-18T10:00:00Z",
    ci,
  };
}

const issue = {
  ref: { repository, number: 7 },
  title: "Sidebar loses scroll position",
  url: "https://github.com/acme/ace/issues/7",
  author: "dev",
  state: "open" as const,
  labels: ["bug"],
  assignees: [],
  milestone: null,
  createdAt: "2026-10-17T10:00:00Z",
  updatedAt: "2026-10-17T10:00:00Z",
};

type App = ReturnType<typeof harness>;

/** What the daemon answers for the project's open pull requests matching `search`. */
function seedPullRequests(app: App, search: string, items: ReturnType<typeof pr>[], total: number) {
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.list", workspaceId, query: ForgePrSearch.parse({ state: "active", search }) },
    {
      resource: "prList",
      value: {
        repository,
        items,
        total,
        counts: { open: total, draft: 0, closed: 0, merged: 0 },
        incomplete: false,
        truncated: false,
      },
    },
  );
}

/** A busy project: 25 of its 140 open pull requests loaded, newest first. */
function withManyPullRequests() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const loaded = Array.from({ length: 25 }, (_, index) =>
    pr(200 - index, `Change number ${200 - index}`, "success"),
  );
  seedPullRequests(app, "", loaded, 140);
  return app;
}

function withOpenWork(options: Parameters<typeof harness>[0] = {}) {
  const app = harness(options);
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const lists = { total: 2, incomplete: false, truncated: false };
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.list", workspaceId, query: ForgePrSearch.parse({ state: "active" }) },
    {
      resource: "prList",
      value: {
        ...lists,
        repository,
        // The daemon's order: newest activity first.
        items: [
          pr(12, "Tidy the settings page", "success"),
          pr(9, "Fix reconnect loop", "failure"),
        ],
        counts: { open: 2, draft: 0, closed: 0, merged: 0 },
      },
    },
  );
  app.daemon.workspace.setForgeRead(
    { op: "forge.issue.list", workspaceId, query: ForgeIssueSearch.parse({}) },
    {
      resource: "issueList",
      value: {
        ...lists,
        total: 1,
        repository,
        items: [issue],
        counts: { open: 1, closed: 0 },
        canCreate: true,
        unavailableReason: "",
      },
    },
  );
  return app;
}

test("open pull requests sit under the New thread composer, failing checks first", async () => {
  const app = withOpenWork();
  await app.open("/new?project=ace");
  const work = await screen.findByRole("region", { name: "Open work" });
  const rows = await within(work).findAllByRole("button");
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringMatching(/^#9Fix reconnect loopChecks failing/),
    expect.stringMatching(/^#12Tidy the settings page/),
  ]);
});

test("picking an open pull request fills the composer from it", async () => {
  const app = withOpenWork();
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId, repository, number: 9 },
    {
      resource: "prDetail",
      value: ForgePrDetail.parse({
        status: {
          ref: { repository, number: 9 },
          title: "Fix reconnect loop",
          url: "https://github.com/acme/ace/pull/9",
          headSha: "a".repeat(40),
          state: "open",
          mergeability: "unknown",
          ci: "failure",
          checks: [],
          comments: [],
          reviewThreads: [],
          raw: {},
        },
        body: "The client reconnects forever after a 401.",
        author: "dev",
        headBranch: "fix/reconnect",
        baseBranch: "main",
        baseSha: "b".repeat(40),
        headRepository: repository,
        labels: [],
        reviewers: [],
        reviewDecision: null,
        commits: 1,
        changedFiles: 1,
        relatedThreads: [],
        relatedThreadsTruncated: false,
      }),
    },
  );
  await app.open("/new?project=ace");
  const work = await screen.findByRole("region", { name: "Open work" });
  await userEvent.click(await within(work).findByRole("button", { name: /Fix reconnect loop/ }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message" }).textContent).toContain(
      "The client reconnects forever after a 401.",
    ),
  );
  expect(
    within(screen.getByRole("region", { name: "Open work" }))
      .getByRole("button", { name: /Fix reconnect loop/ })
      .getAttribute("aria-current"),
  ).toBe("true");
});

test("the Issues tab lists open issues and picking one fills the composer from it", async () => {
  const app = withOpenWork();
  app.daemon.workspace.setForgeRead(
    { op: "forge.issue.detail", workspaceId, repository, number: 7 },
    {
      resource: "issueDetail",
      value: ForgeIssueDetail.parse({
        ...issue,
        body: "Switching threads jumps the sidebar to the top.",
        permissions: { edit: true, close: true, reopen: false, comment: true, reason: "" },
        relatedThreads: [],
        relatedThreadsTruncated: false,
      }),
    },
  );
  await app.open("/new?project=ace");
  const work = await screen.findByRole("region", { name: "Open work" });
  await userEvent.click(await within(work).findByRole("tab", { name: "Issues 1" }));
  const row = await within(work).findByRole("button", { name: /Sidebar loses scroll position/ });
  expect(row.textContent).toContain("bug");
  await userEvent.click(row);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message" }).textContent).toContain(
      "Switching threads jumps the sidebar to the top.",
    ),
  );
});

test("a long list shows its first rows and its total, and Show more reveals the rest it loaded", async () => {
  const app = withManyPullRequests();
  await app.open("/new?project=ace");
  const work = await screen.findByRole("region", { name: "Open work" });
  expect(await within(work).findByRole("tab", { name: "Pull requests 140" })).toBeTruthy();
  expect(within(work).getAllByRole("button", { name: /^#\d+/ })).toHaveLength(5);
  await userEvent.click(within(work).getByRole("button", { name: "Show 20 more" }));
  expect(within(work).getAllByRole("button", { name: /^#\d+/ })).toHaveLength(25);
  expect(within(work).queryByRole("button", { name: /^Show \d+ more$/ })).toBeNull();
});

test("searching a long list asks GitHub, and a search with no matches says so", async () => {
  const app = withManyPullRequests();
  seedPullRequests(app, "reconnect", [pr(9, "Fix reconnect loop", "failure")], 1);
  seedPullRequests(app, "nothing like this", [], 0);
  await app.open("/new?project=ace");
  const work = await screen.findByRole("region", { name: "Open work" });
  const search = await within(work).findByRole("searchbox", { name: "Search pull requests" });
  await userEvent.type(search, "reconnect");
  await waitFor(() =>
    expect(
      within(work)
        .getAllByRole("button", { name: /^#\d+/ })
        .map((row) => row.textContent),
    ).toEqual([expect.stringMatching(/^#9Fix reconnect loop/)]),
  );
  await userEvent.clear(search);
  await userEvent.type(search, "nothing like this");
  expect(await within(work).findByText("No open pull requests match.")).toBeTruthy();
  // Escape clears the search and brings the whole list back.
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(within(work).getAllByRole("button", { name: /^#\d+/ })).toHaveLength(5),
  );
});

test("a short list has no search box", async () => {
  const app = withOpenWork();
  await app.open("/new?project=ace");
  const work = await screen.findByRole("region", { name: "Open work" });
  await within(work).findByRole("tab", { name: "Pull requests 2" });
  expect(within(work).queryByRole("searchbox")).toBeNull();
});

test("a failing PR older than the first page leads the list, and drafts are listed", async () => {
  const app = withManyPullRequests();
  const stale = pr(3, "Old change with broken checks", "failure");
  app.daemon.workspace.setForgeRead(
    {
      op: "forge.pr.list",
      workspaceId,
      query: ForgePrSearch.parse({ state: "active", ci: "failure" }),
    },
    {
      resource: "prList",
      value: {
        repository,
        items: [stale],
        total: 1,
        counts: { open: 1, draft: 0, closed: 0, merged: 0 },
        incomplete: false,
        truncated: false,
      },
    },
  );
  seedPullRequests(app, "draft", [pr(150, "Sketch the new sidebar", "success", "draft")], 1);
  await app.open("/new?project=ace");
  const work = await screen.findByRole("region", { name: "Open work" });
  await waitFor(() =>
    expect(within(work).getAllByRole("button", { name: /^#\d+/ })[0]?.textContent).toMatch(
      /^#3Old change with broken checksChecks failing/,
    ),
  );
  // Still the first five rows, the failing one included.
  expect(within(work).getAllByRole("button", { name: /^#\d+/ })).toHaveLength(5);
  await userEvent.type(
    within(work).getByRole("searchbox", { name: "Search pull requests" }),
    "draft",
  );
  await waitFor(() =>
    expect(
      within(work)
        .getAllByRole("button", { name: /^#\d+/ })
        .map((row) => row.textContent),
    ).toEqual([expect.stringMatching(/^#150Sketch the new sidebarDraft/)]),
  );
});

test("the open pull requests are loaded before New thread opens, so it shows them without asking again", async () => {
  const storage = memoryKeyValue();
  storage.setItem("ace.home.newThread", JSON.stringify({ project: "ace" }));
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const app = withOpenWork({ storage, history });
  const openPrs = {
    op: "forge.pr.list",
    workspaceId,
    query: ForgePrSearch.parse({ state: "active" }),
  } as const;
  await app.open("/");
  await waitFor(() => expect(app.daemon.workspace.forgeReadCount(openPrs)).toBe(1), {
    timeout: 5_000,
  });
  history.push("/new?project=ace");
  const work = await screen.findByRole("region", { name: "Open work" });
  expect(
    within(work)
      .getAllByRole("button")
      .map((row) => row.textContent),
  ).toEqual([
    expect.stringMatching(/^#9Fix reconnect loop/),
    expect.stringMatching(/^#12Tidy the settings page/),
  ]);
  expect(app.daemon.workspace.forgeReadCount(openPrs)).toBe(1);
});
