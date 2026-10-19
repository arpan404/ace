import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgePrDetail, ThreadId, WorkspaceId, type ForgePrStatus } from "@ace/protocol";
import { workbench } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";
import { openPullRequest } from "./test-support.ts";

const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const running = {
  id: "ci",
  name: "ci",
  status: "pending",
  conclusion: null,
  completedAt: null,
  jobId: null,
  url: null,
} as const;
const detail = (status: Partial<ForgePrStatus> = {}) =>
  ForgePrDetail.parse({
    status: {
      ref: { repository, number: 42 },
      title: "Retry reconnects",
      url: "https://github.com/acme/api/pull/42",
      headSha: "a".repeat(40),
      state: "open",
      mergeability: "mergeable",
      ci: "success",
      checks: [],
      comments: [],
      reviewThreads: [],
      raw: {},
      ...status,
    },
    body: "",
    author: "author",
    headBranch: "fix/reconnect",
    baseBranch: "main",
    baseSha: "b".repeat(40),
    headRepository: repository,
    labels: [],
    reviewers: [],
    reviewDecision: null,
    commits: 1,
    changedFiles: 1,
    relatedThreads: [
      { id: ThreadId.parse("thread-retry-budget"), title: "Linked task", archived: false },
    ],
    relatedThreadsTruncated: false,
  });
const operation = {
  op: "forge.pr.detail",
  workspaceId: WorkspaceId.parse("api"),
  number: 42,
} as const;

function open(value: ForgePrDetail) {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setForgeRead(operation, { resource: "prDetail", value });
  app.daemon.workspace.setForgeRead(
    {
      op: "forge.pr.stack-memberships",
      workspaceId: WorkspaceId.parse("api"),
      repository,
      numbers: [42],
    },
    { resource: "prStackMemberships", value: [{ number: 42, stack: null }] },
  );
  return app;
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

test("the PR panel's checks flip from running to passed on their own while CI runs", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const app = open(detail({ ci: "pending", checks: [running] }));
  await openPullRequest(app, { project: "api", number: 42 });
  await screen.findByRole("heading", { name: "Retry reconnects" }, { timeout: 10_000 });
  expect(await screen.findByText("Checks running · 0 of 1 done")).toBeTruthy();
  app.daemon.workspace.setForgeRead(operation, {
    resource: "prDetail",
    value: detail({ ci: "success", checks: [{ ...running, status: "success" }] }),
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16_000);
  });
  expect(await screen.findByText("1 check passed")).toBeTruthy();
  // A background poll neither shows the refresh banner nor holds writes.
  expect(screen.queryByText(/Refreshing GitHub/)).toBeNull();
});

test("checks GitHub couldn't read say so in the PR panel instead of claiming none", async () => {
  const app = open(detail({ ci: "unknown" }));
  await openPullRequest(app, { project: "api", number: 42 });
  expect(await screen.findByText("Checks unavailable")).toBeTruthy();
  expect(screen.queryByText("No checks reported")).toBeNull();
});

test("the merge button stays off while the shared merge gate holds it, and turns on once a refresh clears it", async () => {
  const app = open(detail({ ci: "failure", checks: [{ ...running, status: "failure" }] }));
  await openPullRequest(app, { project: "api", number: 42 });
  const panel = within(await screen.findByRole("article", { name: "Pull request #42" }));
  const merge = await panel.findByRole<HTMLButtonElement>("button", { name: "Squash and merge" });
  expect(merge.disabled).toBe(true);
  app.daemon.workspace.setForgeRead(operation, { resource: "prDetail", value: detail() });
  await userEvent.click(screen.getByRole("button", { name: "Pull request actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Refresh" }));
  await waitFor(() =>
    expect(
      panel.getByRole<HTMLButtonElement>("button", { name: "Squash and merge" }).disabled,
    ).toBe(false),
  );
});
