import { beforeEach, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ForgeComment,
  ForgeMergeState,
  ForgePrDetail,
  WorkspaceId,
  type ForgeCheckRun,
} from "@ace/protocol";
import { workbench } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";
import { createIdleTask } from "@/test/tasks.ts";
import { reviewState } from "./review-harness.tsx";

const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const workspaceId = WorkspaceId.parse("api");
const asked = ForgeComment.parse({
  kind: "review",
  id: 20,
  body: "The reconnect loop has no backoff. Add a jittered retry.",
  author: "mira",
  file: null,
  line: null,
  replyTo: null,
  createdAt: "2026-10-10T09:00:00Z",
  updatedAt: "2026-10-10T09:00:00Z",
  reviewState: "CHANGES_REQUESTED",
});
const failing = {
  id: "check:7",
  name: "test (web)",
  status: "failure",
  conclusion: "failure",
  completedAt: "2026-10-10T10:00:00Z",
  startedAt: "2026-10-10T09:57:30Z",
  jobId: null,
  url: null,
} as const;
const detail = (patch: Partial<ForgePrDetail> = {}) =>
  ForgePrDetail.parse({
    status: {
      ref: { repository, number: 42 },
      title: "Reconnect the client worker after sleep",
      url: "https://github.com/acme/api/pull/42",
      headSha: "a".repeat(40),
      state: "open",
      mergeability: "mergeable",
      ci: "failure",
      checks: [failing, { ...failing, id: "lint", name: "lint", status: "success" }],
      comments: [asked],
      reviewThreads: [
        {
          id: "T1",
          resolved: false,
          outdated: false,
          file: "src/socket.ts",
          line: 42,
          comments: [
            {
              ...asked,
              kind: "inline",
              id: 21,
              body: "Which timeout is this?",
              file: "src/socket.ts",
              line: 42,
              reviewState: undefined,
            },
          ],
        },
      ],
      raw: {},
    },
    body: "",
    author: "sam",
    headBranch: "fix/worker-sleep",
    baseBranch: "main",
    baseSha: "b".repeat(40),
    headRepository: repository,
    labels: [],
    reviewers: ["mira"],
    reviewDecision: "CHANGES_REQUESTED",
    commits: 2,
    changedFiles: 1,
    relatedThreads: [],
    relatedThreadsTruncated: false,
    ...patch,
  });
const run: ForgeCheckRun = {
  id: 7,
  name: "test (web)",
  status: "failure",
  conclusion: "failure",
  url: null,
  output: { title: null, summary: null, text: null },
  workflow: null,
  log: null,
  logUnavailable: false,
  annotations: [
    {
      path: "src/socket.test.ts",
      startLine: 40,
      endLine: 40,
      level: "failure",
      title: "",
      message: "reconnects after visibility change: expected 1 call, got 0",
    },
  ],
  annotationsTruncated: false,
};
const mergeState = (patch: Partial<ForgeMergeState> = {}) =>
  ForgeMergeState.parse({
    headSha: "a".repeat(40),
    state: "OPEN",
    mergeState: "CLEAN",
    reviewDecision: "APPROVED",
    checksState: "SUCCESS",
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

/** The PR as a page of its own, with GitHub answering `value` and the repository's `merge`. */
async function openPage(value: ForgePrDetail, merge = mergeState()) {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  // New thread starts only in a registered project: give the daemon one in `api`.
  createIdleTask(app.daemon, {
    id: "api-task",
    title: "Earlier API work",
    workspaceId: "api",
    provider: "codex",
  });
  for (const read of [
    { op: "forge.pr.detail", workspaceId, number: 42 },
    { op: "forge.pr.detail", workspaceId, repository, number: 42 },
  ] as const)
    app.daemon.workspace.setForgeRead(read, { resource: "prDetail", value });
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.check", workspaceId, repository, checkRunId: 7 },
    { resource: "prCheck", value: run },
  );
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.merge-state", workspaceId, repository, number: 42 },
    { resource: "prMergeState", value: merge },
  );
  // GitHub said which comments are hidden (none), so their words may show and reach an agent.
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.review-state", workspaceId, repository, number: 42 },
    { resource: "prReviewState", value: reviewState({ headSha: "a".repeat(40) }) },
  );
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.stack-memberships", workspaceId, repository, numbers: [42] },
    { resource: "prStackMemberships", value: [{ number: 42, stack: null }] },
  );
  await app.open("/pulls/api/42");
  const page = within(
    await screen.findByRole("article", { name: "Pull request #42" }, { timeout: 10_000 }),
  );
  return { app, page };
}

const blocking = (page: ReturnType<typeof within>) =>
  within(page.getByRole("region", { name: "Merge status" }));

test("the Summary leads with what blocks the merge, each in its author's words", async () => {
  const { page } = await openPage(detail());
  await waitFor(() => page.getByRole("region", { name: "Merge status" }), {
    timeout: 10_000,
  });
  const rows = blocking(page);
  // The reviewer's own words, the open conversation, and the failing check's first failure.
  expect(
    await rows.findByText(
      "The reconnect loop has no backoff. Add a jittered retry.",
      {},
      { timeout: 10_000 },
    ),
  ).toBeTruthy();
  expect(await rows.findByText("Which timeout is this?", {}, { timeout: 10_000 })).toBeTruthy();
  expect(
    await rows.findByText("reconnects after visibility change: expected 1 call, got 0"),
  ).toBeTruthy();
  // Each gate heads its section of the merge box.
  const facts = within(page.getByRole("navigation", { name: "Merge gates" }));
  expect(facts.getByRole("button", { name: "Checks: 1 failing · 1 ok" })).toBeTruthy();
  // Show in code opens the conversation's file in the Code tab.
  await userEvent.click(rows.getByRole("button", { name: "Show in code: src/socket.ts:42" }));
  await waitFor(() =>
    expect(page.getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true"),
  );
});

test("Open log takes a failing check to the Checks tab, failures first, with how long it ran, and selects it", async () => {
  const { page } = await openPage(detail());
  await waitFor(() => page.getByRole("region", { name: "Merge status" }), {
    timeout: 10_000,
  });
  await userEvent.click(blocking(page).getByRole("button", { name: "Open log" }));
  await waitFor(() =>
    expect(page.getByRole("tab", { name: "Checks" }).getAttribute("aria-selected")).toBe("true"),
  );
  const checks = within(page.getByRole("region", { name: "Checks" }));
  const rows = checks.getAllByRole("button", { name: /: (Failed|Passed)$/ });
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    "test (web): Failed",
    "lint: Passed",
  ]);
  expect(rows[0]?.textContent).toContain("2m 30s");
  // Opened from there, the failing check is the one shown beside the list.
  expect(rows[0]?.getAttribute("aria-current")).toBe("true");
  expect(rows[1]?.getAttribute("aria-current")).toBeNull();
  expect(
    within(checks.getByRole("region", { name: "Check" })).getByRole("heading", {
      name: "test (web)",
    }),
  ).toBeTruthy();
});

test("Fix with agent on a PR no thread works on starts a new thread with the request in its composer", async () => {
  const { page } = await openPage(detail());
  await waitFor(() => page.getByRole("region", { name: "Merge status" }), {
    timeout: 10_000,
  });
  const fix = () =>
    blocking(page).getByRole<HTMLButtonElement>("button", {
      name: "Fix with agent: The reconnect loop has no backoff. Add a jittered retry.",
    });
  await waitFor(() => expect(fix().disabled).toBe(false), { timeout: 10_000 });
  await userEvent.click(fix());
  const message = await screen.findByRole("combobox", { name: "Message" }, { timeout: 10_000 });
  await waitFor(() =>
    expect(message.textContent).toContain("Address mira's requested changes on PR #42"),
  );
  expect(message.textContent).toContain("Add a jittered retry.");
  // Nothing was sent for the person.
  expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
});

test("Merge offers only the methods the repository allows, beside the button", async () => {
  const ready = detail({
    status: { ...detail().status, ci: "success", checks: [], comments: [], reviewThreads: [] },
    reviewDecision: "APPROVED",
  });
  const { page } = await openPage(ready, mergeState({ methods: ["merge", "rebase"] }));
  // Squash isn't allowed here, so the merge doesn't offer it.
  expect(await page.findByRole("button", { name: "Merge" }, { timeout: 10_000 })).toBeTruthy();
  await userEvent.click(page.getByRole("button", { name: /^Merge method:/ }));
  const choices = screen.getAllByRole("menuitemradio").map((item) => item.textContent);
  expect(choices).toEqual(["Create a merge commit", "Rebase and merge"]);
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Rebase and merge" }));
  expect(await page.findByRole("button", { name: "Rebase and merge" })).toBeTruthy();
});

test("a repository with one merge method shows no method choice", async () => {
  const ready = detail({
    status: { ...detail().status, ci: "success", checks: [], comments: [], reviewThreads: [] },
    reviewDecision: "APPROVED",
  });
  const { page } = await openPage(ready, mergeState({ methods: ["rebase"] }));
  expect(
    await page.findByRole("button", { name: "Rebase and merge" }, { timeout: 10_000 }),
  ).toBeTruthy();
  expect(page.queryByRole("button", { name: /^Merge method:/ })).toBeNull();
});
