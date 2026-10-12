import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ForgePrDetail,
  ForgePrSearch,
  ForgeMergeState,
  ThreadId,
  WorkspaceId,
} from "@ace/protocol";
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
afterEach(() => vi.unstubAllGlobals());

test("checkout copied from another repository names that repository instead of the project's origin", async () => {
  const user = userEvent.setup();
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId: WorkspaceId.parse("api"), repository: other, number: 42 },
    { resource: "prDetail", value: detail(other, "Other repository PR") },
  );
  await app.open("/pull-requests?project=api&repo=github.com/acme/web&number=42");
  await screen.findByRole("heading", { name: "Other repository PR" });
  await user.click(screen.getByRole("button", { name: "Copy checkout command" }));
  expect(await navigator.clipboard.readText()).toBe("gh pr checkout 42 --repo github.com/acme/web");
  await screen.findByRole("button", { name: "Checkout command copied" });
});

test("a dismissed phone PR sheet reopens its PR from More actions and an empty workspace opens its PR launcher", async () => {
  vi.stubGlobal("matchMedia", (media: string): MediaQueryList => ({
    matches: media.includes("max-width"),
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId: WorkspaceId.parse("api"), number: 42 },
    { resource: "prDetail", value: detail() },
  );
  await app.open("/pull-requests?project=api&number=42");
  await screen.findByRole("heading", { name: "Retry reconnects" });
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "Retry reconnects" })).toBeNull(),
  );
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Pull request workspace/ }));
  await screen.findByRole("heading", { name: "Retry reconnects" });
  expect(screen.queryByText("This tool isn't available")).toBeNull();
  const panel = await screen.findByRole("region", { name: "Pull request workspace" });
  await userEvent.click(within(panel).getByRole("button", { name: "Close #42" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Done" })).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Pull request workspace/ }));
  await screen.findByRole("textbox", { name: "New tab PR URL or number" });
  expect(screen.queryByText("This tool isn't available")).toBeNull();
});

test("new PR tabs keep independent repository identities and preserve the first tab's collapsed description", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId: WorkspaceId.parse("api"), number: 42 },
    { resource: "prDetail", value: detail(repository, "First repository PR") },
  );
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId: WorkspaceId.parse("api"), repository: other, number: 42 },
    { resource: "prDetail", value: detail(other, "Second repository PR") },
  );
  await app.open("/pull-requests?project=api&number=42");
  await screen.findByRole("heading", { name: "First repository PR" });
  const panel = await screen.findByRole("region", { name: "Pull request workspace" });
  await userEvent.click(within(panel).getByRole("button", { name: "Description" }));
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  await userEvent.type(
    await within(panel).findByRole("textbox", { name: "New tab PR URL or number" }),
    "https://github.com/acme/web/pull/42",
  );
  await userEvent.click(within(panel).getByRole("button", { name: "Open PR" }));
  await within(panel).findByRole("heading", { name: "Second repository PR" });
  const tabs = within(
    within(panel).getByRole("tablist", { name: "Pull request workspace tabs" }),
  ).getAllByRole("tab");
  const first = tabs[0];
  if (!first) throw new Error("The first PR tab was lost");
  await userEvent.click(first);
  await within(panel).findByRole("heading", { name: "First repository PR" });
  expect(
    within(panel).getByRole("button", { name: "Description" }).getAttribute("aria-expanded"),
  ).toBe("false");
  expect(within(panel).queryByText("Preserve reconnect ordering.")).toBeNull();
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
  await app.open("/pull-requests?project=api&number=42");
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
  await app.open("/pull-requests?project=api&number=42");
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
  expect(await screen.findByRole("heading", { name: /^Retry reconnects$/ })).toBeTruthy();
  expect(await screen.findByText("Preserve reconnect ordering.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Write a comment or review" })).toBeNull();
  expect(screen.getByRole("tab", { name: "Summary" }).getAttribute("aria-selected")).toBe("true");
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
  await app.open("/pull-requests?project=api&repo=github.com/acme/web&number=42");
  expect(await screen.findByRole("heading", { name: /^Different repository PR$/ })).toBeTruthy();
  await userEvent.click(screen.getByRole("tab", { name: "Code" }));
  const files = await screen.findByRole("region", { name: "Hosted PR diff" });
  expect(await within(files).findByRole("region", { name: "src/page.ts" })).toBeTruthy();
  expect(await within(files).findByText("before")).toBeTruthy();
  expect(await within(files).findByText("after")).toBeTruthy();
});

test("changing repositories replaces the old detail with an honest inaccessible state", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId: WorkspaceId.parse("api"), number: 42 },
    { resource: "prDetail", value: detail() },
  );
  await app.open("/pull-requests?project=api&number=42");
  await screen.findByRole("heading", { name: /^Retry reconnects$/ });
  await userEvent.type(
    screen.getByRole("textbox", { name: "PR URL or number" }),
    "https://github.com/acme/private/pull/42",
  );
  await userEvent.click(screen.getByRole("button", { name: "Open PR" }));
  await screen.findByText("This repository or pull request is missing or inaccessible.");
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: /^Retry reconnects$/ })).toBeNull(),
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
  await app.open("/pull-requests?project=relay&number=42");
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
  await app.open("/pull-requests?project=api&number=42");
  expect(await screen.findByText("Keep this unsent finding")).toBeTruthy();
  expect(screen.getByText(/Outdated anchor/)).toBeTruthy();
  for (const name of ["Submit comment review", "Approve on GitHub", "Request changes on GitHub"])
    expect(screen.getByRole<HTMLButtonElement>("button", { name }).disabled).toBe(true);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Review summary" }),
    "Preserve my summary",
  );
  await userEvent.click(screen.getByRole("button", { name: "Back to pull requests" }));
  await app.open("/pull-requests?project=api&number=42");
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
  await app.open("/pull-requests?project=api&number=42");
  const summary = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "Review summary",
  });
  await userEvent.type(summary, "Keep my unsent review");
  await userEvent.click(screen.getByRole("button", { name: "Submit comment review" }));
  expect(await screen.findByText("This daemon can't do that yet: update the daemon.")).toBeTruthy();
  expect(summary.value).toBe("Keep my unsent review");
});
