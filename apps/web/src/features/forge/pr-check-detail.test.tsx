import { beforeEach, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgeCheckRun, ForgePrDetail, ThreadId, WorkspaceId } from "@ace/protocol";
import { workbench } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";
import { openPullRequest } from "./test-support.ts";

await import("./pr-panel-tab.tsx");
const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const workspaceId = WorkspaceId.parse("api");
const failing = {
  id: "check:11",
  name: "test",
  status: "failure",
  conclusion: "failure",
  completedAt: "2026-10-10T10:00:00Z",
  jobId: 99,
  url: "https://github.com/acme/api/actions/runs/42/job/99",
} as const;
const detail = ForgePrDetail.parse({
  status: {
    ref: { repository, number: 42 },
    title: "Retry reconnects",
    url: "https://github.com/acme/api/pull/42",
    headSha: "a".repeat(40),
    state: "open",
    mergeability: "mergeable",
    ci: "failure",
    checks: [failing],
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
  reviewDecision: null,
  commits: 1,
  changedFiles: 1,
  relatedThreads: [
    { id: ThreadId.parse("thread-retry-budget"), title: "Linked task", archived: false },
  ],
  relatedThreadsTruncated: false,
});
const run = ForgeCheckRun.parse({
  id: 11,
  name: "test",
  status: "failure",
  conclusion: "failure",
  url: failing.url,
  output: { title: null, summary: null, text: null },
  workflow: {
    runId: 42,
    attempt: 1,
    jobId: 99,
    steps: [
      { number: 1, name: "Set up job", status: "success", line: 0 },
      { number: 2, name: "Run tests", status: "failure", line: 2 },
    ],
  },
  log: {
    text: [
      "Runner image",
      "ubuntu-24.04",
      "Run bun run test",
      "FAIL src/main.test.ts > handles empty input",
      "Process completed with exit code 1.",
    ].join("\n"),
    truncated: false,
    errors: [4],
    focus: 2,
  },
  logUnavailable: false,
  annotations: [
    {
      path: "src/main.ts",
      startLine: 12,
      endLine: 12,
      level: "failure",
      title: "main > handles empty input",
      message: "expected '' to be 'x'",
    },
  ],
  annotationsTruncated: false,
});
const detailRead = { op: "forge.pr.detail", workspaceId, number: 42 } as const;
const checkRead = {
  op: "forge.pr.check",
  workspaceId,
  repository,
  checkRunId: 11,
  jobId: 99,
} as const;

beforeEach(() => localStorage.clear());

const panel = () => within(screen.getByRole("article", { name: "Pull request #42" }));

async function openCheck() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setForgeRead(detailRead, { resource: "prDetail", value: detail });
  app.daemon.workspace.setForgeRead(checkRead, { resource: "prCheck", value: run });
  await openPullRequest(app, { project: "api", number: 42 });
  await screen.findByRole("article", { name: "Pull request #42" }, { timeout: 10_000 });
  const gate = await panel().findByRole("button", { name: /^Checks: 1 failing/ });
  await userEvent.click(gate);
  await userEvent.click(await panel().findByRole("button", { name: "test: Failed" }));
  await panel().findByRole("log", { name: "Log of test" }, { timeout: 10_000 });
  return app;
}

test("a check opens in the panel with its log, read only once it's opened, and its search finds lines", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setForgeRead(detailRead, { resource: "prDetail", value: detail });
  app.daemon.workspace.setForgeRead(checkRead, { resource: "prCheck", value: run });
  await openPullRequest(app, { project: "api", number: 42 });
  await screen.findByRole("article", { name: "Pull request #42" }, { timeout: 10_000 });
  await userEvent.click(await panel().findByRole("button", { name: /^Checks: 1 failing/ }));
  const row = await panel().findByRole("button", { name: "test: Failed" });
  expect(app.daemon.workspace.forgeReadCount(checkRead)).toBe(0);
  await userEvent.click(row);
  const log = await panel().findByRole("log", { name: "Log of test" }, { timeout: 10_000 });
  expect(within(log).getByText("Process completed with exit code 1.")).toBeTruthy();
  expect(app.daemon.workspace.forgeReadCount(checkRead)).toBe(1);
  const search = panel().getByRole("searchbox", { name: "Search the log of test" });
  await userEvent.type(search, "fail");
  expect(panel().getByText("1 of 1")).toBeTruthy();
  await userEvent.clear(search);
  await userEvent.type(search, "no such text");
  expect(panel().getByText("No matches")).toBeTruthy();
});

test("a check's annotation names its file and line and opens the file in the Code tab", async () => {
  await openCheck();
  const annotations = panel().getByRole("list", { name: "Annotations" });
  expect(within(annotations).getByText("expected '' to be 'x'")).toBeTruthy();
  await userEvent.click(
    within(annotations).getByRole("button", { name: "Open src/main.ts:12 in Code" }),
  );
  await waitFor(() =>
    expect(panel().getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true"),
  );
});

test("re-running a failed check's jobs asks the daemon for that run's attempt, then reads the PR again", async () => {
  const app = await openCheck();
  const before = app.daemon.workspace.forgeReadCount(detailRead);
  const rerun = panel().getByRole<HTMLButtonElement>("button", { name: "Re-run failed jobs" });
  await waitFor(() => expect(rerun.disabled).toBe(false), { timeout: 10_000 });
  await userEvent.click(rerun);
  await waitFor(() =>
    expect(app.daemon.workspace.checkReruns).toEqual([
      { kind: "rerun", runId: 42, attempt: 1, jobs: "failed" },
    ]),
  );
  await waitFor(() =>
    expect(app.daemon.workspace.forgeReadCount(detailRead)).toBeGreaterThan(before),
  );
});

test("Fix with agent on a failing check puts its failing step's log and annotations in the task's composer", async () => {
  await openCheck();
  const actions = panel().getAllByRole("button", { name: /Fix with agent/ });
  // The check's own button, after the Needs attention row's.
  const own = actions.at(-1);
  if (!own) throw new Error("No Fix with agent button");
  await userEvent.click(own);
  const message = await screen.findByRole("combobox", { name: /Message/i });
  await waitFor(() => expect(message.textContent).toContain('Log of the step "Run tests"'));
  expect(message.textContent).toContain("Process completed with exit code 1.");
  expect(message.textContent).toContain("src/main.ts:12: expected '' to be 'x'");
  expect(message.textContent).not.toContain("ubuntu-24.04");
});
