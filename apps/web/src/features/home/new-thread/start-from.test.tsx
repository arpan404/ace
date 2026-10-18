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
import { harness } from "@/test/harness.tsx";

const repository = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
const workspaceId = WorkspaceId.parse("ace");

function pr(number: number, title: string, ci: "success" | "failure" | "pending") {
  return {
    ref: { repository, number },
    title,
    url: `https://github.com/acme/ace/pull/${number}`,
    author: "dev",
    state: "open" as const,
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

function withOpenWork() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const lists = { total: 2, incomplete: false, truncated: false };
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.list", workspaceId, query: ForgePrSearch.parse({}) },
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
  await userEvent.click(await within(work).findByRole("tab", { name: "Issues" }));
  const row = await within(work).findByRole("button", { name: /Sidebar loses scroll position/ });
  expect(row.textContent).toContain("bug");
  await userEvent.click(row);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message" }).textContent).toContain(
      "Switching threads jumps the sidebar to the top.",
    ),
  );
});
