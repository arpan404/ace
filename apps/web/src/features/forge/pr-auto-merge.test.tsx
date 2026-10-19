import { beforeEach, expect, test } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgeMergeState, ForgePrDetail, ThreadId, WorkspaceId } from "@ace/protocol";
import { workbench } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";
import { openPullRequest } from "./test-support.ts";

// The PR tab loads on first use; load it up front so no test's wait includes the import.
await import("./pr-panel-tab.tsx");
const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const detail = () =>
  ForgePrDetail.parse({
    status: {
      ref: { repository, number: 42 },
      title: "Retry reconnects",
      url: "https://github.com/acme/api/pull/42",
      headSha: "a".repeat(40),
      state: "open",
      mergeability: "unknown",
      ci: "none",
      checks: [],
      comments: [],
      reviewThreads: [],
      raw: {},
    },
    body: "",
    author: "author",
    headBranch: "fix/reconnect",
    baseBranch: "main",
    baseSha: "b".repeat(40),
    headRepository: repository,
    labels: [],
    reviewers: [],
    reviewDecision: "REVIEW_REQUIRED",
    commits: 1,
    changedFiles: 1,
    relatedThreads: [],
    relatedThreadsTruncated: false,
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
beforeEach(() => localStorage.clear());

const panel = () => within(screen.getByRole("article", { name: "Pull request #42" }));

/** Open the ⋯ menu and find one of its rows. */
async function menuItem(name: string | RegExp) {
  await userEvent.click(screen.getByRole("button", { name: "Pull request actions" }));
  return screen.findByRole("menuitem", { name });
}
const disabled = (item: HTMLElement) => item.getAttribute("aria-disabled") === "true";

/** The PR open in its linked task's side panel, with GitHub reporting `state`. */
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
  await screen.findByRole("article", { name: "Pull request #42" });
  return { app, seed };
}

test("armed auto-merge and queue membership show in the header and clear on refresh", async () => {
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
  const state = mergeState({
    autoMerge: armed,
    queue: queued,
    canEnable: false,
    canDisable: true,
    canDequeue: true,
  });
  app.daemon.workspace.setForgeRead(operation, { resource: "prMergeState", value: state });
  await openPullRequest(app, { project: "api", number: 42 });
  await screen.findByRole("article", { name: "Pull request #42" });
  expect(await panel().findByText("Auto-merge (squash)")).toBeTruthy();
  expect(panel().queryByRole("button", { name: "Squash and merge" })).toBeNull();
  // Without a linked task, GitHub writes wait for a link.
  expect(disabled(await menuItem(/^Disable auto-merge/))).toBe(true);
  expect(disabled(screen.getByRole("menuitem", { name: /^Leave merge queue/ }))).toBe(true);
  await userEvent.keyboard("{Escape}");
  app.daemon.workspace.setForgeRead(operation, {
    resource: "prMergeState",
    value: { ...state, autoMerge: null, queue: null, canDisable: false, canDequeue: false },
  });
  await userEvent.click(await menuItem("Refresh"));
  expect(await panel().findByRole("button", { name: "Squash and merge" })).toBeTruthy();
  expect(panel().queryByText("Auto-merge (squash)")).toBeNull();
});

test("linked workspace controls cancel auto-merge and queue membership separately", async () => {
  await linkedControls(
    mergeState({
      autoMerge: armed,
      queue: queued,
      canEnable: false,
      canDisable: true,
      canDequeue: true,
    }),
  );
  expect(await panel().findByText("Auto-merge (squash)")).toBeTruthy();
  const cancel = await menuItem(/^Disable auto-merge/);
  await waitFor(() => expect(disabled(cancel)).toBe(false));
  await userEvent.click(cancel);
  // Auto-merge is off; the PR is still queued.
  expect(await panel().findByText("In merge queue · 3")).toBeTruthy();
  const leave = await menuItem(/^Leave merge queue/);
  await waitFor(() => expect(disabled(leave)).toBe(false));
  await userEvent.click(leave);
  expect(await panel().findByRole("button", { name: "Squash and merge" })).toBeTruthy();
  expect(panel().queryByText(/In merge queue/)).toBeNull();
});

test("a clear refusal shows its reason and leaves the merge-state controls usable", async () => {
  const { app } = await linkedControls(mergeState());
  const enable = await menuItem(/^Enable auto-merge/);
  await waitFor(() => expect(disabled(enable)).toBe(false));
  app.daemon.refuseCommands("forge_rate_limit", "forge.pr.merge-state.change");
  await userEvent.click(enable);
  expect(
    await screen.findByText("GitHub's rate limit was reached: wait a few minutes, then retry."),
  ).toBeTruthy();
  const again = await menuItem(/^Enable auto-merge/);
  await waitFor(() => expect(disabled(again)).toBe(false));
});

test("an uncertain receipt blocks further writes until a fresh read reconciles the host state", async () => {
  const { app, seed } = await linkedControls(mergeState());
  const enable = await menuItem(/^Enable auto-merge/);
  await waitFor(() => expect(disabled(enable)).toBe(false));
  app.daemon.refuseCommands("action_outcome_uncertain", "forge.pr.merge-state.change");
  await userEvent.click(enable);
  const check = await screen.findByRole<HTMLButtonElement>("button", {
    name: "Check auto-merge result",
  });
  // Stays fenced after the post-write read, until the person checks on purpose.
  await waitFor(() => expect(check.disabled).toBe(false));
  expect(disabled(await menuItem(/^Enable auto-merge/))).toBe(true);
  await userEvent.keyboard("{Escape}");
  seed(mergeState({ autoMerge: armed, canEnable: false, canDisable: true }));
  app.daemon.restoreRequests();
  await userEvent.click(check);
  expect(await panel().findByText("Auto-merge (squash)")).toBeTruthy();
  const cancel = await menuItem(/^Disable auto-merge/);
  await waitFor(() => expect(disabled(cancel)).toBe(false));
  await userEvent.click(cancel);
  expect(await panel().findByRole("button", { name: "Squash and merge" })).toBeTruthy();
});

test("reconnecting reads external cancellation before re-enabling controls", async () => {
  const { app, seed } = await linkedControls(
    mergeState({
      autoMerge: armed,
      queue: queued,
      canEnable: false,
      canDisable: true,
      canDequeue: true,
    }),
  );
  await panel().findByText("Auto-merge (squash)");
  act(() => app.daemon.refuseConnections(true));
  await waitFor(() => expect(app.client.state).not.toBe("ready"));
  expect(disabled(await menuItem(/^Disable auto-merge/))).toBe(true);
  await userEvent.keyboard("{Escape}");
  seed(mergeState());
  act(() => app.daemon.refuseConnections(false));
  expect(await panel().findByRole("button", { name: "Squash and merge" })).toBeTruthy();
  expect(panel().queryByText(/In merge queue/)).toBeNull();
  const enable = await menuItem(/^Enable auto-merge/);
  await waitFor(() => expect(disabled(enable)).toBe(false));
});
