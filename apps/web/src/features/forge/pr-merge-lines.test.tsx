import { beforeEach, expect, test, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgeMergeState, ForgePrDetail, ThreadId, WorkspaceId } from "@ace/protocol";
import { workbench } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";
import { openPullRequest } from "./test-support.ts";

// The PR tab loads on first use; load it up front so no test's wait includes the import.
await import("./pr-panel-tab.tsx");
const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const detail = (patch: Record<string, unknown> = {}) =>
  ForgePrDetail.parse({
    status: {
      ref: { repository, number: 42 },
      title: "Retry reconnects",
      url: "https://github.com/acme/api/pull/42",
      headSha: "a".repeat(40),
      state: "open",
      mergeability: "mergeable",
      ci: "failure",
      checks: [
        {
          id: "build",
          name: "build",
          status: "failure",
          conclusion: "failure",
          completedAt: "2026-10-11T00:00:00Z",
          jobId: null,
          url: null,
        },
        {
          id: "lint",
          name: "lint",
          status: "success",
          conclusion: "success",
          completedAt: "2026-10-11T00:00:00Z",
          jobId: null,
          url: null,
        },
      ],
      comments: [],
      reviewThreads: [],
      raw: {},
      ...patch,
    },
    body: "",
    author: "author",
    headBranch: "fix/reconnect",
    baseBranch: "main",
    baseSha: "b".repeat(40),
    headRepository: repository,
    labels: [],
    reviewers: [],
    reviewDecision: "CHANGES_REQUESTED",
    commits: 1,
    changedFiles: 1,
    relatedThreads: [
      { id: ThreadId.parse("thread-retry-budget"), title: "Retry budget", archived: false },
    ],
    relatedThreadsTruncated: false,
  });
const mergeState = (patch: Partial<ForgeMergeState> = {}) =>
  ForgeMergeState.parse({
    headSha: "a".repeat(40),
    state: "OPEN",
    mergeState: "BLOCKED",
    reviewDecision: "CHANGES_REQUESTED",
    checksState: "FAILURE",
    autoMerge: null,
    queue: null,
    canEnable: false,
    canDisable: false,
    canDequeue: false,
    blockers: [],
    raw: {},
    ...patch,
  });
beforeEach(() => localStorage.clear());

const panel = () => within(screen.getByRole("article", { name: "Pull request #42" }));

async function openSeeded(hosted: ForgePrDetail, state: ForgeMergeState) {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
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
    { resource: "prDetail", value: hosted },
  );
  app.daemon.workspace.setForgeRead(
    {
      op: "forge.pr.merge-state",
      workspaceId: WorkspaceId.parse("relay"),
      repository,
      number: 42,
    },
    { resource: "prMergeState", value: state },
  );
  await openPullRequest(app, { project: "relay", number: 42 });
  await screen.findByRole("article", { name: "Pull request #42" }, { timeout: 10_000 });
}

test("a merge held by branch rules names them without repeating the gates", async () => {
  await openSeeded(
    detail(),
    mergeState({
      blockers: ["A review requests changes.", "Checks: FAILURE.", "Signed commits required."],
      rules: ["Signed commits required."],
    }),
  );
  expect(await panel().findByText("Signed commits required.")).toBeTruthy();
  expect(panel().getByText("Changes requested")).toBeTruthy();
  expect(panel().queryByText("A review requests changes.")).toBeNull();
  expect(panel().queryByText("Checks: FAILURE.")).toBeNull();
});

test("a queued PR shows its queue state and opens a deployment in the browser", async () => {
  const launched = vi.spyOn(window, "open").mockImplementation(() => null);
  await openSeeded(
    detail({ ci: "success", checks: [] }),
    mergeState({
      mergeState: "CLEAN",
      reviewDecision: "APPROVED",
      checksState: "SUCCESS",
      queue: {
        id: "QUEUE_42",
        state: "AWAITING_CHECKS",
        position: 3,
        enqueuedAt: "2026-10-11T00:00:00Z",
        estimatedTimeToMerge: 150,
      },
      deployments: [
        { environment: "staging", state: "SUCCESS", url: "https://acme.example/staging" },
        { environment: "production", state: "IN_PROGRESS", url: null },
      ],
    }),
  );
  expect(await panel().findByText("Merge queue · Awaiting checks · ~3m")).toBeTruthy();
  expect(panel().getByText("production · In progress")).toBeTruthy();
  expect(panel().queryByRole("button", { name: /production/ })).toBeNull();
  await userEvent.click(panel().getByRole("button", { name: "staging · Success" }));
  await waitFor(() =>
    expect(launched).toHaveBeenCalledWith(
      "https://acme.example/staging",
      "_blank",
      "noopener,noreferrer",
    ),
  );
  launched.mockRestore();
});
