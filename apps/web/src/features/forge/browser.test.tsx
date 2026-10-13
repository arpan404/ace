import { beforeEach, expect, test } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ForgePrDetail,
  ForgeLifecycleState,
  ForgeMergeState,
  ThreadId,
  WorkspaceId,
} from "@ace/protocol";
import { workbench } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";
import { openPullRequest } from "./test-support.ts";
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
  await screen.findByRole("heading", { name: "Other repository PR" });
  await user.click(screen.getByRole("button", { name: "Copy checkout command" }));
  expect(await navigator.clipboard.readText()).toBe("gh pr checkout 42 --repo github.com/acme/web");
  await screen.findByRole("button", { name: "Checkout command copied" });
});

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
  await userEvent.click(await screen.findByRole("button", { name: "Pull request actions" }));
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
  notStacked(app);
  await openPullRequest(app, { project: "api", number: 42 });
  await userEvent.click(await screen.findByRole("button", { name: "Pull request actions" }));
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
  await userEvent.click(await screen.findByRole("link", { name: "Work on PR in a new task" }));
  expect(await screen.findByText(/Isolated worktree · PR #42 · aaaaaaaaaaaa/)).toBeTruthy();
  expect((await screen.findByRole("combobox", { name: /Message/i })).textContent).toContain(
    "Work on GitHub PR #42: Retry reconnects",
  );
  expect(screen.queryByRole("checkbox", { name: "Worktree" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Start from:/ })).toBeNull();
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
  await openPullRequest(app, { project: "api", number: 42 });
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

const mergeState = (patch: Partial<ForgeMergeState> = {}) =>
  ForgeMergeState.parse({
    headSha: "a".repeat(40),
    state: "OPEN",
    mergeState: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    checksState: "SUCCESS",
    autoMerge: null,
    queue: null,
    canEnable: true,
    canDisable: false,
    canDequeue: false,
    blockers: ["Required reviews are outstanding."],
    raw: {},
    ...patch,
  });
const armed = { method: "SQUASH", actor: "octo", enabledAt: "2026-10-11" };
const queued = { id: "QUEUE_42", state: "AWAITING_CHECKS", position: 3, enqueuedAt: "2026-10-11" };
async function linkedControls(state: ForgeMergeState) {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const hosted = detail();
  const seed = (value: ForgeMergeState) =>
    app.daemon.seedServices({
      pullRequests: { "thread-retry-budget": { ...hosted.status, mergeState: value } },
    });
  seed(state);
  app.daemon.workspace.setForgeRead(
    {
      op: "forge.pr.stack-memberships",
      workspaceId: WorkspaceId.parse("relay"),
      repository,
      numbers: [42],
    },
    { resource: "prStackMemberships", value: [{ number: 42, stack: null }] },
  );
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId: WorkspaceId.parse("relay"), number: 42 },
    {
      resource: "prDetail",
      value: {
        ...hosted,
        relatedThreads: [
          { id: ThreadId.parse("thread-retry-budget"), title: "Retry budget", archived: false },
        ],
      },
    },
  );
  await openPullRequest(app, { project: "relay", number: 42 });
  const section = within(await screen.findByRole("region", { name: "Auto-merge and merge queue" }));
  await section.findByText("Required reviews are outstanding.");
  return { app, section, seed };
}

test("linked workspace controls cancel auto-merge and queue membership separately", async () => {
  const { section } = await linkedControls(
    mergeState({
      autoMerge: armed,
      queue: queued,
      canEnable: false,
      canDisable: true,
      canDequeue: true,
    }),
  );
  const cancel = section.getByRole<HTMLButtonElement>("button", { name: "Cancel auto-merge" });
  await waitFor(() => expect(cancel.disabled).toBe(false));
  await userEvent.click(cancel);
  expect(await section.findByText("Auto-merge is disabled.")).toBeTruthy();
  expect(section.getByText(/AWAITING_CHECKS, position 3/)).toBeTruthy();
  const leave = section.getByRole<HTMLButtonElement>("button", { name: "Leave merge queue" });
  await waitFor(() => expect(leave.disabled).toBe(false));
  await userEvent.click(leave);
  expect(await section.findByText("Not in the merge queue.")).toBeTruthy();
  expect(section.getByText("Auto-merge is disabled.")).toBeTruthy();
});

test("an enabled workspace action submits a command and shows its classified error receipt", async () => {
  const { app, section } = await linkedControls(mergeState());
  const enable = section.getByRole<HTMLButtonElement>("button", { name: "Enable auto-merge" });
  await waitFor(() => expect(enable.disabled).toBe(false));
  app.daemon.refuseCommands("forge_rate_limit", "forge.pr.merge-state.change");
  await userEvent.click(enable);
  expect(
    await section.findByText("GitHub's rate limit was reached. Wait before refreshing."),
  ).toBeTruthy();
  expect(enable.disabled).toBe(true);
});

test("an uncertain receipt blocks further writes until a fresh read reconciles the host state", async () => {
  const { app, section, seed } = await linkedControls(mergeState());
  const enable = section.getByRole<HTMLButtonElement>("button", { name: "Enable auto-merge" });
  await waitFor(() => expect(enable.disabled).toBe(false));
  app.daemon.refuseCommands("action_outcome_uncertain", "forge.pr.merge-state.change");
  await userEvent.click(enable);
  expect(await section.findByText(/The action may have reached GitHub/)).toBeTruthy();
  expect(enable.disabled).toBe(true);
  seed(mergeState({ autoMerge: armed, canEnable: false, canDisable: true }));
  app.daemon.restoreRequests();
  await userEvent.click(section.getByRole("button", { name: "Refresh merge state" }));
  expect(await section.findByText(/squash by octo/)).toBeTruthy();
  const cancel = section.getByRole<HTMLButtonElement>("button", { name: "Cancel auto-merge" });
  await waitFor(() => expect(cancel.disabled).toBe(false));
  await userEvent.click(cancel);
  expect(await section.findByText("Auto-merge is disabled.")).toBeTruthy();
});

test("reconnecting reads external cancellation before re-enabling controls", async () => {
  const { app, section, seed } = await linkedControls(
    mergeState({
      autoMerge: armed,
      queue: queued,
      canEnable: false,
      canDisable: true,
      canDequeue: true,
    }),
  );
  await section.findByText(/squash by octo/);
  act(() => app.daemon.refuseConnections(true));
  await waitFor(() => expect(app.client.state).not.toBe("ready"));
  expect(
    section.getByRole<HTMLButtonElement>("button", { name: "Cancel auto-merge" }).disabled,
  ).toBe(true);
  seed(mergeState());
  act(() => app.daemon.refuseConnections(false));
  expect(await section.findByText("Auto-merge is disabled.")).toBeTruthy();
  expect(section.getByText("Not in the merge queue.")).toBeTruthy();
  await waitFor(() =>
    expect(
      section.getByRole<HTMLButtonElement>("button", { name: "Enable auto-merge" }).disabled,
    ).toBe(false),
  );
});

test("the repository workspace shows current lifecycle permissions and reconciles outside changes on refresh", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const workspaceId = WorkspaceId.parse("api");
  const draft = detail();
  draft.status.state = "draft";
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId, number: 42 },
    { resource: "prDetail", value: draft },
  );
  const state = ForgeLifecycleState.parse({
    snapshot: {
      pr: draft.status.ref,
      id: "PR_42",
      version: "a".repeat(64),
      headSha: draft.status.headSha,
      baseSha: draft.baseSha,
      state: "draft",
      metadata: {
        title: draft.status.title,
        body: draft.body,
        baseBranch: "main",
        labels: [],
        assignees: [],
      },
      editableFields: ["title", "body"],
      actions: ["ready"],
      unsupported: ["revert"],
    },
    operations: [],
  });
  const operation = { op: "forge.pr.lifecycle", workspaceId, repository, number: 42 } as const;
  app.daemon.workspace.setForgeRead(operation, { resource: "prLifecycle", value: state });
  await openPullRequest(app, { project: "api", number: 42 });
  const region = await screen.findByRole("region", { name: "Pull request metadata and lifecycle" });
  expect(await within(region).findByRole("button", { name: "Mark ready for review" })).toBeTruthy();
  expect(within(region).queryByRole("button", { name: "Close PR" })).toBeNull();
  expect(within(region).getByText(/host does not support: Create revert PR/)).toBeTruthy();
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
  await userEvent.click(within(region).getByRole("button", { name: "Refresh lifecycle" }));
  expect(await screen.findByRole("heading", { name: "Closed on GitHub" })).toBeTruthy();
  expect(await within(region).findByRole("button", { name: "Reopen PR" })).toBeTruthy();
  expect(within(region).queryByRole("button", { name: "Mark ready for review" })).toBeNull();
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
    {
      resource: "prLifecycle",
      value: ForgeLifecycleState.parse({
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
        },
        operations: [],
      }),
    },
  );
  await openPullRequest(app, { project: "api", number: 42 });
  await screen.findByText(/Current state: open/);
  await userEvent.click(screen.getByText("Edit PR metadata"));
  const body = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "PR description" });
  await userEvent.clear(body);
  await userEvent.type(body, "Retain my description");
  await userEvent.click(screen.getByRole("button", { name: "Save PR metadata" }));
  expect(await screen.findByText("This daemon can't do that yet: update the daemon.")).toBeTruthy();
  expect(body.value).toBe("Retain my description");
});

test("Refresh PR reloads metadata and permissions when title, head and state are unchanged", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const workspaceId = WorkspaceId.parse("api");
  const pr = detail();
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId, number: 42 },
    { resource: "prDetail", value: pr },
  );
  const operation = { op: "forge.pr.lifecycle", workspaceId, repository, number: 42 } as const;
  const state = ForgeLifecycleState.parse({
    snapshot: {
      pr: pr.status.ref,
      id: "PR_42",
      version: "a".repeat(64),
      headSha: pr.status.headSha,
      baseSha: pr.baseSha,
      state: "open",
      metadata: {
        title: pr.status.title,
        body: "Original",
        baseBranch: "main",
        labels: [],
        assignees: [],
      },
      editableFields: ["body", "baseBranch", "labels", "assignees"],
      actions: ["close"],
      unsupported: [],
    },
    operations: [],
  });
  app.daemon.workspace.setForgeRead(operation, { resource: "prLifecycle", value: state });
  await openPullRequest(app, { project: "api", number: 42 });
  await screen.findByText(/Current state: open/);
  await userEvent.click(screen.getByText("Edit PR metadata"));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "PR description" }).value).toBe(
    "Original",
  );
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
        editableFields: [],
        actions: [],
      },
    },
  });
  await userEvent.click(screen.getByRole("button", { name: "Pull request actions" }));
  await userEvent.click(screen.getByRole("button", { name: "Refresh PR" }));
  await waitFor(() =>
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "PR description" }).value).toBe(
      "Changed externally",
    ),
  );
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Base branch" }).value).toBe(
    "release",
  );
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "PR labels" }).value).toBe(
    "urgent",
  );
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "PR assignees" }).value).toBe(
    "alice",
  );
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", { name: "PR description" }).disabled,
  ).toBe(true);
  expect(screen.queryByRole("button", { name: "Close PR" })).toBeNull();
});

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
      value: {
        viewer: "reviewer",
        headSha: "a".repeat(40),
        drafts: [
          {
            id: "draft",
            body: "Keep this unsent finding",
            anchor: { commit: "b".repeat(40), path: "src/main.ts", line: 1, side: "RIGHT" },
          },
        ],
        viewed: null,
        canReview: true,
        canComment: true,
        resolvableThreads: [],
        operations: [],
      },
    },
  );
  const first = await openPullRequest(app, { project: "api", number: 42 });
  expect(await screen.findByText("Keep this unsent finding")).toBeTruthy();
  expect(screen.getByText(/Outdated anchor/)).toBeTruthy();
  for (const name of ["Submit comment review", "Approve on GitHub", "Request changes on GitHub"])
    expect(screen.getByRole<HTMLButtonElement>("button", { name }).disabled).toBe(true);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Review summary" }),
    "Preserve my summary",
  );
  // Closed and opened again, the PR keeps the summary not yet sent.
  first.unmount();
  await openPullRequest(app, { project: "api", number: 42 });
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
    {
      resource: "prReviewState",
      value: {
        viewer: "reviewer",
        headSha: "a".repeat(40),
        drafts: [],
        viewed: null,
        canReview: true,
        canComment: true,
        resolvableThreads: [],
        operations: [],
      },
    },
  );
  await openPullRequest(app, { project: "api", number: 42 });
  const summary = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "Review summary",
  });
  await userEvent.type(summary, "Keep my unsent review");
  await userEvent.click(screen.getByRole("button", { name: "Submit comment review" }));
  expect(await screen.findByText("This daemon can't do that yet: update the daemon.")).toBeTruthy();
  expect(summary.value).toBe("Keep my unsent review");
});
