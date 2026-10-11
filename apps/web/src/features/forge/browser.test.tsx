import { beforeEach, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgePrDetail, ForgePrSearch, WorkspaceId, ThreadId } from "@ace/protocol";
import { workbench } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";
const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const other = { ...repository, name: "web" };
const detail = (
  repo: import("@ace/protocol").ForgeRepository = repository,
  title = "Retry reconnects",
) =>
  ForgePrDetail.parse({
    status: {
      ref: { repository: repo, number: 42 },
      title,
      url: `https://github.com/${repo.owner}/${repo.name}/pull/42`,
      headSha: "a".repeat(40),
      state: "open",
      mergeability: "unknown",
      ci: "none",
      checks: [],
      comments: [
        {
          kind: "issue",
          id: 1,
          author: "reviewer",
          body: "**Keep the context.**",
          file: null,
          line: null,
          updatedAt: "2026-10-10",
          replyTo: null,
        },
      ],
      reviewThreads: [],
      raw: {},
    },
    body: "## Hosted description\n\nPreserve reconnect ordering.",
    author: "author",
    headBranch: "fix/reconnect",
    baseBranch: "main",
    baseSha: "b".repeat(40),
    headRepository: repo,
    labels: ["bug"],
    reviewers: ["reviewer"],
    reviewDecision: "REVIEW_REQUIRED",
    commits: 1,
    changedFiles: 1,
    relatedThreads: [],
    relatedThreadsTruncated: false,
  });
beforeEach(() => localStorage.clear());

test("a successful merge followed by a failed detail refresh stays disabled until reconciliation", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const value = detail();
  value.status.mergeability = "mergeable";
  value.relatedThreads = [
    { id: ThreadId.parse("thread-retry-budget"), title: "Linked task", archived: false },
  ];
  app.daemon.seedServices({ pullRequests: { "thread-retry-budget": value.status } });
  const operation = {
    op: "forge.pr.detail",
    workspaceId: WorkspaceId.parse("api"),
    number: 42,
  } as const;
  app.daemon.workspace.setForgeRead(operation, { resource: "prDetail", value });
  await app.open("/pull-requests?project=api&number=42");
  const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Merge PR" });
  await waitFor(() => expect(button.disabled).toBe(false));
  app.daemon.failRequests("workspace.request");
  await userEvent.click(button);
  await screen.findByRole("button", { name: "Reconcile action" });
  await waitFor(() => expect(button.disabled).toBe(true));
  const view = app.daemon.snapshot({
    kind: "thread",
    threadId: ThreadId.parse("thread-retry-budget"),
  });
  expect(view && "thread" in view && view.thread.details?.linkedPr?.state).toBe("merged");
  const reviewers = screen.getByRole("textbox", { name: "Reviewers" });
  await userEvent.type(reviewers, "octo{Enter}");
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Enable auto-merge" }).disabled,
  ).toBe(true);
  app.daemon.restoreRequests();
  app.daemon.workspace.setForgeRead(operation, {
    resource: "prDetail",
    value: { ...value, status: { ...value.status, state: "merged" } },
  });
  await userEvent.click(screen.getByRole("button", { name: "Reconcile action" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Reconcile action" })).toBeNull(),
  );
  expect(button.disabled).toBe(true);
});

test("an uncertain write blocks controls on a newly opened detail until GitHub confirms its outcome", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const value = detail();
  value.status.mergeability = "mergeable";
  value.writeState = "uncertain";
  value.relatedThreads = [
    { id: ThreadId.parse("thread-retry-budget"), title: "Linked task", archived: false },
  ];
  const operation = {
    op: "forge.pr.detail",
    workspaceId: WorkspaceId.parse("api"),
    number: 42,
  } as const;
  app.daemon.workspace.setForgeRead(operation, { resource: "prDetail", value });
  await app.open("/pull-requests?project=api&number=42");
  expect(
    (await screen.findByRole<HTMLButtonElement>("button", { name: "Merge PR" })).disabled,
  ).toBe(true);
  await userEvent.type(screen.getByRole("textbox", { name: "Reviewers" }), "octo{Enter}");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Request review" }).disabled).toBe(
    true,
  );
  app.daemon.workspace.setForgeRead(operation, {
    resource: "prDetail",
    value: { ...value, writeState: undefined },
  });
  await userEvent.click(screen.getByRole("button", { name: "Reconcile action" }));
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Merge PR" }).disabled).toBe(
      false,
    ),
  );
});

test("a repository PR opens without a task and returning retains its filters and page", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const query = ForgePrSearch.parse({ state: "draft", search: "reconnect", page: 2 });
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.list", workspaceId: WorkspaceId.parse("api"), query },
    {
      resource: "prList",
      value: {
        repository,
        items: [
          {
            ref: { repository, number: 42 },
            title: "Retry reconnects",
            url: "https://github.com/acme/api/pull/42",
            author: "author",
            state: "draft",
            labels: [],
            updatedAt: "2026-10-10",
          },
        ],
        total: 26,
        counts: { open: 0, draft: 26, closed: 0, merged: 0 },
        incomplete: false,
        truncated: false,
      },
    },
  );
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId: WorkspaceId.parse("api"), number: 42 },
    { resource: "prDetail", value: detail() },
  );
  await app.open("/pull-requests?project=api&state=draft&search=reconnect&page=2");
  await userEvent.click(await screen.findByRole("button", { name: /Retry reconnects/ }));
  expect(await screen.findByRole("heading", { name: /Retry reconnects #42/ })).toBeTruthy();
  expect(await screen.findByText("Preserve reconnect ordering.")).toBeTruthy();
  expect(screen.getByText("No linked agent tasks.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Back to pull requests" }));
  expect(await screen.findByText("Page 2")).toBeTruthy();
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Search" }).value).toBe("reconnect");
  expect(screen.getByRole("tab", { name: "Draft 26" }).getAttribute("aria-selected")).toBe("true");
});

test("the same PR number in another repository gets independent full detail and hosted diffs", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId: WorkspaceId.parse("api"), repository: other, number: 42 },
    { resource: "prDetail", value: detail(other, "Different repository PR") },
  );
  app.daemon.workspace.setForgeRead(
    {
      op: "forge.pr.files",
      workspaceId: WorkspaceId.parse("api"),
      repository: other,
      number: 42,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      page: 1,
    },
    {
      resource: "prFiles",
      value: {
        ref: { repository: other, number: 42 },
        baseSha: "b".repeat(40),
        headSha: "a".repeat(40),
        files: [
          {
            path: "src/page.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: "@@ -1 +1 @@\n-before\n+after",
            truncated: false,
          },
        ],
        truncated: false,
      },
    },
  );
  await app.open("/pull-requests?project=api&repo=github.com/acme/web&number=42");
  expect(await screen.findByRole("heading", { name: /Different repository PR #42/ })).toBeTruthy();
  await userEvent.click(screen.getByRole("tab", { name: "Files changed 1" }));
  const files = await screen.findByRole("region", { name: "Hosted PR diff" });
  expect(await within(files).findByText("src/page.ts")).toBeTruthy();
  expect(within(files).getByText(/Local uncommitted changes/)).toBeTruthy();
  expect(within(files).getByText(/-before/)).toBeTruthy();
});

test("changing repositories replaces the old detail with an honest inaccessible state", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId: WorkspaceId.parse("api"), number: 42 },
    { resource: "prDetail", value: detail() },
  );
  await app.open("/pull-requests?project=api&number=42");
  await screen.findByRole("heading", { name: /Retry reconnects #42/ });
  await userEvent.type(
    screen.getByRole("textbox", { name: "PR URL or number" }),
    "https://github.com/acme/private/pull/42",
  );
  await userEvent.click(screen.getByRole("button", { name: "Open PR" }));
  await screen.findByText("This repository or pull request is missing or inaccessible.");
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: /Retry reconnects #42/ })).toBeNull(),
  );
});

test("the PR workspace renders authoritative auto-merge and queue state and removes externally cancelled requests on refresh", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId: WorkspaceId.parse("api"), number: 42 },
    { resource: "prDetail", value: detail() },
  );
  const operation = {
    op: "forge.pr.merge-state",
    workspaceId: WorkspaceId.parse("api"),
    repository,
    number: 42,
  } as const;
  const state = {
    headSha: "a".repeat(40),
    state: "OPEN",
    mergeState: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    checksState: "SUCCESS",
    autoMerge: { method: "SQUASH", actor: "octo", enabledAt: "2026-10-11" },
    queue: { id: "QUEUE_42", state: "AWAITING_CHECKS", position: 3, enqueuedAt: "2026-10-11" },
    canEnable: false,
    canDisable: true,
    canDequeue: true,
    blockers: ["Required reviews are outstanding."],
    raw: {},
  };
  app.daemon.workspace.setForgeRead(operation, { resource: "prMergeState", value: state });
  await app.open("/pull-requests?project=api&number=42");
  const section = within(await screen.findByRole("region", { name: "Auto-merge and merge queue" }));
  expect(await section.findByText(/squash by octo/)).toBeTruthy();
  expect(section.getByText(/AWAITING_CHECKS, position 3/)).toBeTruthy();
  expect(section.getByText("Required reviews are outstanding.")).toBeTruthy();
  expect(
    section.getByRole<HTMLButtonElement>("button", { name: "Cancel auto-merge" }).disabled,
  ).toBe(true);
  app.daemon.workspace.setForgeRead(operation, {
    resource: "prMergeState",
    value: { ...state, autoMerge: null, queue: null, canDisable: false, canDequeue: false },
  });
  await userEvent.click(section.getByRole("button", { name: "Refresh merge state" }));
  expect(await section.findByText("Auto-merge is disabled.")).toBeTruthy();
  expect(section.getByText("Not in the merge queue.")).toBeTruthy();
});
