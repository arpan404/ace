import { beforeEach, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ForgePrDetail,
  ForgeLifecycleState,
  ThreadId,
  WorkspaceId,
  type ForgeReviewState,
} from "@ace/protocol";
import { workbench } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";
import { openPullRequest } from "./test-support.ts";

// The PR tab loads on first use; load it up front so no test's wait includes the import.
await import("./pr-panel-tab.tsx");
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
/** GitHub confirms PR #42 is in no native stack, so its merge isn't held for stack rules. */
const notStacked = (app: ReturnType<typeof harness>, workspaceId = "api") =>
  app.daemon.workspace.setForgeRead(
    {
      op: "forge.pr.stack-memberships",
      workspaceId: WorkspaceId.parse(workspaceId),
      repository,
      numbers: [42],
    },
    { resource: "prStackMemberships", value: [{ number: 42, stack: null }] },
  );

test("checkout copied from another repository names that repository instead of the project's origin", async () => {
  const user = userEvent.setup();
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId: WorkspaceId.parse("api"), repository: other, number: 42 },
    { resource: "prDetail", value: detail(other, "Other repository PR") },
  );
  await openPullRequest(app, { project: "api", repository: other, number: 42 });
  await screen.findByRole("heading", { name: "Other repository PR" }, { timeout: 10_000 });
  await user.click(screen.getByRole("button", { name: "Copy checkout command" }));
  expect(await navigator.clipboard.readText()).toBe("gh pr checkout 42 --repo github.com/acme/web");
  await screen.findByRole("button", { name: "Checkout command copied" });
});

/** The PR panel, apart from the thread's own work card and sidebar. */
const panel = () => within(screen.getByRole("article", { name: "Pull request #42" }));
const panelOpen = () =>
  screen.findByRole("article", { name: "Pull request #42" }, { timeout: 10_000 });

/** Open the ⋯ menu and find one of its rows. */
async function menuItem(name: string | RegExp) {
  await userEvent.click(await screen.findByRole("button", { name: "Pull request actions" }));
  return screen.findByRole("menuitem", { name });
}

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
  notStacked(app);
  await openPullRequest(app, { project: "api", number: 42 });
  await panelOpen();
  const merge = await panel().findByRole<HTMLButtonElement>("button", {
    name: "Squash and merge",
  });
  await waitFor(() => expect(merge.disabled).toBe(false));
  await userEvent.click(merge);
  const commit = within(
    await screen.findByRole("dialog", { name: "Squash and merge into main" }, { timeout: 10_000 }),
  );
  // The commit prefill is already shown; only the refresh after merging should fail.
  app.daemon.failRequests("workspace.request");
  await userEvent.click(commit.getByRole("button", { name: "Confirm squash and merge" }));
  await screen.findByRole("button", { name: "Reconcile action" });
  await waitFor(() =>
    expect(
      panel().getByRole<HTMLButtonElement>("button", { name: "Squash and merge" }).disabled,
    ).toBe(true),
  );
  const view = app.daemon.snapshot({
    kind: "thread",
    threadId: ThreadId.parse("thread-retry-budget"),
  });
  expect(view && "thread" in view && view.thread.details?.linkedPr?.state).toBe("merged");
  expect((await menuItem("Request review…")).getAttribute("aria-disabled")).toBe("true");
  expect(
    screen.getByRole("menuitem", { name: /^Enable auto-merge/ }).getAttribute("aria-disabled"),
  ).toBe("true");
  await userEvent.keyboard("{Escape}");
  app.daemon.restoreRequests();
  app.daemon.workspace.setForgeRead(operation, {
    resource: "prDetail",
    value: { ...value, status: { ...value.status, state: "merged" } },
  });
  await userEvent.click(screen.getByRole("button", { name: "Reconcile action" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Reconcile action" })).toBeNull(),
  );
  // Merged: the state shows where the merge button was.
  // The state badge and the gates both say so.
  expect(await panel().findAllByText("Merged")).not.toHaveLength(0);
  expect(panel().queryByRole("button", { name: "Squash and merge" })).toBeNull();
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
  notStacked(app);
  await openPullRequest(app, { project: "api", number: 42 });
  await panelOpen();
  const merge = await panel().findByRole<HTMLButtonElement>("button", {
    name: "Squash and merge",
  });
  expect(merge.disabled).toBe(true);
  expect((await menuItem("Request review…")).getAttribute("aria-disabled")).toBe("true");
  await userEvent.keyboard("{Escape}");
  app.daemon.workspace.setForgeRead(operation, {
    resource: "prDetail",
    value: { ...value, writeState: undefined },
  });
  await userEvent.click(screen.getByRole("button", { name: "Reconcile action" }));
  await waitFor(() =>
    expect(
      panel().getByRole<HTMLButtonElement>("button", { name: "Squash and merge" }).disabled,
    ).toBe(false),
  );
});

test("a conflicting PR offers to resolve its conflicts instead of merging", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const value = detail();
  value.status.mergeability = "conflicting";
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId: WorkspaceId.parse("api"), number: 42 },
    { resource: "prDetail", value },
  );
  notStacked(app);
  await openPullRequest(app, { project: "api", number: 42 });
  await panelOpen();
  expect(await panel().findByRole("button", { name: "Resolve conflicts" })).toBeTruthy();
  expect(panel().queryByRole("button", { name: "Squash and merge" })).toBeNull();
  const merge = await menuItem(/^Merge now/);
  expect(merge.getAttribute("aria-disabled")).toBe("true");
  expect(merge.textContent).toContain("Resolve the conflicts with main first");
});

test("the Summary holds only reviewers, labels, description, checks and comments", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId: WorkspaceId.parse("api"), number: 42 },
    { resource: "prDetail", value: detail() },
  );
  notStacked(app);
  await openPullRequest(app, { project: "api", number: 42 });
  await screen.findByRole("heading", { name: "Retry reconnects" });
  expect(
    screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-label"))
      .filter((name) => ["Description", "Checks", "Comments"].includes(name ?? "")),
  ).toEqual(["Description", "Checks", "Comments"]);
  expect(panel().getByText("Preserve reconnect ordering.")).toBeTruthy();
  expect(panel().getByText("Keep the context.")).toBeTruthy();
  // Checks start folded; no Summary control refreshes anything.
  expect(panel().queryByText("No checks reported.")).toBeNull();
  await userEvent.click(panel().getByRole("button", { name: "Checks" }));
  expect(panel().getByText("No checks reported.")).toBeTruthy();
  expect(panel().queryByRole("button", { name: /^Refresh/ })).toBeNull();
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
      page: 1,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
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
  await openPullRequest(app, { project: "api", repository: other, number: 42 });
  expect(await screen.findByRole("heading", { name: /^Different repository PR$/ })).toBeTruthy();
  await userEvent.click(screen.getByRole("tab", { name: "Code" }));
  const files = await screen.findByRole("region", { name: "Hosted PR diff" });
  expect(await within(files).findByRole("region", { name: "src/page.ts" })).toBeTruthy();
  expect(await within(files).findByText("before")).toBeTruthy();
  expect(await within(files).findByText("after")).toBeTruthy();
});

test("Work on PR opens a project-scoped task with its review description and a pinned isolated environment", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const pr = detail();
  // A registered project: a new task can only be prepared in one the daemon lists.
  const workspaceId = WorkspaceId.parse("relay");
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId, number: 42 },
    { resource: "prDetail", value: pr },
  );
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId, repository, number: 42 },
    { resource: "prDetail", value: pr },
  );
  await openPullRequest(app, { project: "relay", number: 42 });
  await screen.findByRole("heading", { name: "Retry reconnects" });
  await userEvent.click(await menuItem("Work on PR in a new task"));
  expect(await screen.findByText(/Isolated worktree · PR #42 · aaaaaaaaaaaa/)).toBeTruthy();
  expect((await screen.findByRole("combobox", { name: /Message/i })).textContent).toContain(
    "Work on GitHub PR #42: Retry reconnects",
  );
  expect(screen.queryByRole("checkbox", { name: "Worktree" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Start from:/ })).toBeNull();
});

const lifecycleState = (pr: ForgePrDetail, patch: Record<string, unknown>) =>
  ForgeLifecycleState.parse({
    snapshot: {
      pr: pr.status.ref,
      id: "PR_42",
      version: "a".repeat(64),
      headSha: pr.status.headSha,
      baseSha: pr.baseSha,
      state: "open",
      metadata: {
        title: pr.status.title,
        body: pr.body,
        baseBranch: "main",
        labels: [],
        assignees: [],
      },
      editableFields: ["body"],
      actions: [],
      unsupported: [],
      ...patch,
    },
    operations: [],
  });

test("the ⋯ menu offers the lifecycle actions GitHub allows and follows outside changes on refresh", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const workspaceId = WorkspaceId.parse("api");
  const draft = detail();
  draft.status.state = "draft";
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId, number: 42 },
    { resource: "prDetail", value: draft },
  );
  const state = lifecycleState(draft, {
    state: "draft",
    editableFields: ["title", "body"],
    actions: ["ready"],
    unsupported: ["revert"],
  });
  const operation = { op: "forge.pr.lifecycle", workspaceId, repository, number: 42 } as const;
  app.daemon.workspace.setForgeRead(operation, { resource: "prLifecycle", value: state });
  await openPullRequest(app, { project: "api", number: 42 });
  await panelOpen();
  // A draft's primary action is to mark it ready.
  expect(await panel().findByRole("button", { name: "Ready for review" })).toBeTruthy();
  expect(await menuItem("Ready for review")).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: /^Close pull request/ })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: /^Revert changes/ })).toBeNull();
  await userEvent.keyboard("{Escape}");
  const closed = detail(repository, "Closed on GitHub");
  closed.status.state = "closed";
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId, number: 42 },
    { resource: "prDetail", value: closed },
  );
  app.daemon.workspace.setForgeRead(operation, {
    resource: "prLifecycle",
    value: {
      ...state,
      snapshot: {
        ...state.snapshot,
        version: "b".repeat(64),
        state: "closed",
        metadata: { ...state.snapshot.metadata, title: closed.status.title },
        actions: ["reopen"],
      },
    },
  });
  await userEvent.click(await menuItem("Refresh"));
  expect(await screen.findByRole("heading", { name: "Closed on GitHub" })).toBeTruthy();
  expect(await panel().findAllByText("Closed")).not.toHaveLength(0);
  expect(await menuItem("Reopen pull request")).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Ready for review" })).toBeNull();
});

test("a refused metadata write keeps its text and shows the daemon refusal", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const workspaceId = WorkspaceId.parse("api");
  const pr = detail();
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId, number: 42 },
    { resource: "prDetail", value: pr },
  );
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.lifecycle", workspaceId, repository, number: 42 },
    { resource: "prLifecycle", value: lifecycleState(pr, {}) },
  );
  await openPullRequest(app, { project: "api", number: 42 });
  await screen.findByRole("heading", { name: "Retry reconnects" });
  app.daemon.refuseCommands("unsupported_by_fake_daemon", "forge.hosted.lifecycle");
  await userEvent.click(await menuItem("Edit details…"));
  const body = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "PR description" });
  await userEvent.clear(body);
  await userEvent.type(body, "Retain my description");
  await userEvent.click(screen.getByRole("button", { name: "Save PR metadata" }));
  expect(
    await screen.findAllByText("This daemon can't do that yet: update the daemon."),
  ).not.toHaveLength(0);
  expect(body.value).toBe("Retain my description");
});

test("Refresh in the ⋯ menu reloads metadata and permissions when title, head and state are unchanged", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const workspaceId = WorkspaceId.parse("api");
  const pr = detail();
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId, number: 42 },
    { resource: "prDetail", value: pr },
  );
  const operation = { op: "forge.pr.lifecycle", workspaceId, repository, number: 42 } as const;
  const state = lifecycleState(pr, {
    metadata: {
      title: pr.status.title,
      body: "Original",
      baseBranch: "main",
      labels: [],
      assignees: [],
    },
    editableFields: ["body", "baseBranch", "labels", "assignees"],
    actions: ["close"],
  });
  app.daemon.workspace.setForgeRead(operation, { resource: "prLifecycle", value: state });
  await openPullRequest(app, { project: "api", number: 42 });
  await screen.findByRole("heading", { name: "Retry reconnects" });
  await userEvent.click(await menuItem("Edit details…"));
  expect(
    (await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "PR description" })).value,
  ).toBe("Original");
  await userEvent.keyboard("{Escape}");
  app.daemon.workspace.setForgeRead(operation, {
    resource: "prLifecycle",
    value: {
      ...state,
      snapshot: {
        ...state.snapshot,
        version: "b".repeat(64),
        metadata: {
          ...state.snapshot.metadata,
          body: "Changed externally",
          baseBranch: "release",
          labels: ["urgent"],
          assignees: ["alice"],
        },
        editableFields: ["body"],
        actions: [],
      },
    },
  });
  await userEvent.click(await menuItem("Refresh"));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  const edit = await menuItem("Edit details…");
  await waitFor(() =>
    expect(screen.queryByRole("menuitem", { name: /^Close pull request/ })).toBeNull(),
  );
  await userEvent.click(edit);
  expect(
    (await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "PR description" })).value,
  ).toBe("Changed externally");
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Base branch" }).value).toBe(
    "release",
  );
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "PR labels" }).value).toBe(
    "urgent",
  );
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "PR assignees" }).value).toBe(
    "alice",
  );
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Base branch" }).disabled).toBe(
    true,
  );
});

const reviewState = (drafts: ForgeReviewState["drafts"] = []): ForgeReviewState => ({
  viewer: "reviewer",
  headSha: "a".repeat(40),
  drafts,
  viewed: null,
  canReview: true,
  canComment: true,
  resolvableThreads: [],
  operations: [],
});

/** Open the header Review popover. */
async function openReview() {
  await userEvent.click(
    await screen.findByRole("button", { name: /^Review( · \d+ pending)?$/ }, { timeout: 10_000 }),
  );
}

test("new commits visibly invalidate durable hosted drafts and disable all review submission", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId: WorkspaceId.parse("api"), number: 42 },
    { resource: "prDetail", value: detail() },
  );
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.review-state", workspaceId: WorkspaceId.parse("api"), repository, number: 42 },
    {
      resource: "prReviewState",
      value: reviewState([
        {
          id: "draft",
          body: "Keep this unsent finding",
          anchor: { commit: "b".repeat(40), path: "src/main.ts", line: 1, side: "RIGHT" },
        },
      ]),
    },
  );
  const first = await openPullRequest(app, { project: "api", number: 42 });
  await openReview();
  expect(await screen.findByText("Keep this unsent finding")).toBeTruthy();
  expect(screen.getByText("Outdated")).toBeTruthy();
  expect(
    screen.getByText(/New commits moved the lines of outdated comments\. Remove them to submit\./),
  ).toBeTruthy();
  for (const verdict of ["Comment", "Approve", "Request changes"]) {
    await userEvent.click(screen.getByRole("radio", { name: verdict, exact: true }));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Submit review" }).disabled).toBe(
      true,
    );
  }
  await userEvent.type(
    screen.getByRole("textbox", { name: "Review summary" }),
    "Preserve my summary",
  );
  // Closed and opened again, the PR keeps the summary not yet sent.
  first.unmount();
  await openPullRequest(app, { project: "api", number: 42 });
  await openReview();
  expect(
    await screen
      .findByRole<HTMLTextAreaElement>("textbox", { name: "Review summary" })
      .then((field) => field.value),
  ).toBe("Preserve my summary");
});

test("a refused GitHub review shows the daemon refusal and retains the unsent summary", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const workspaceId = WorkspaceId.parse("api");
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId, number: 42 },
    { resource: "prDetail", value: detail() },
  );
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.review-state", workspaceId, repository, number: 42 },
    { resource: "prReviewState", value: reviewState() },
  );
  await openPullRequest(app, { project: "api", number: 42 });
  await openReview();
  const summary = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "Review summary",
  });
  app.daemon.refuseCommands("unsupported_by_fake_daemon", "forge.hosted.review");
  await userEvent.type(summary, "Keep my unsent review");
  await userEvent.click(screen.getByRole("button", { name: "Submit review" }));
  expect(
    await screen.findAllByText("This daemon can't do that yet: update the daemon."),
  ).not.toHaveLength(0);
  expect(summary.value).toBe("Keep my unsent review");
});
