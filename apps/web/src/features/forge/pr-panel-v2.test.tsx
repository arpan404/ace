import { beforeEach, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgePrDetail, ThreadId, WorkspaceId } from "@ace/protocol";
import { workbench } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";
import { openPullRequest } from "./test-support.ts";

await import("./pr-panel-tab.tsx");
const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const workspaceId = WorkspaceId.parse("api");
const host = ThreadId.parse("thread-retry-budget");
const failing = {
  id: "links",
  name: "links",
  status: "failure",
  conclusion: "failure",
  completedAt: "2026-10-10T10:00:00Z",
  jobId: null,
  url: null,
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
    checks: [failing, { ...failing, id: "lint", name: "lint", status: "success" }],
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
  reviewDecision: "CHANGES_REQUESTED",
  commits: 1,
  changedFiles: 1,
  relatedThreads: [{ id: host, title: "Linked task", archived: false }],
  relatedThreadsTruncated: false,
});
beforeEach(() => localStorage.clear());

async function open() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId, number: 42 },
    { resource: "prDetail", value: detail },
  );
  await openPullRequest(app, { project: "api", number: 42 });
  return within(await screen.findByRole("article", { name: "Pull request #42" }));
}

test("the merge gates say what blocks the merge, and the Checks gate opens the checks", async () => {
  const panel = await open();
  const gates = within(await panel.findByRole("navigation", { name: "Merge gates" }));
  expect(gates.getByRole("button", { name: "Checks: 1 failing · 1 ok" })).toBeTruthy();
  expect(gates.getByRole("button", { name: "Reviews: Changes requested" })).toBeTruthy();
  expect(gates.getByRole("button", { name: "Conflicts: None" })).toBeTruthy();
  // Checks start folded; the gate opens them.
  expect(panel.queryByRole("button", { name: "links: Failed" })).toBeNull();
  await userEvent.click(gates.getByRole("button", { name: "Checks: 1 failing · 1 ok" }));
  expect(await panel.findByRole("button", { name: "links: Failed" })).toBeTruthy();
});

test("Fix with agent shows the linked task's composer and puts the request there without sending it", async () => {
  const panel = await open();
  const attention = within(await panel.findByRole("region", { name: "Needs attention" }));
  await userEvent.click(attention.getByRole("button", { name: "Fix with agent: links" }));
  const message = await screen.findByRole("combobox", { name: /Message/i });
  await waitFor(() => expect(message.textContent).toContain('The check "links" fails on PR #42'));
  // Still a draft: nothing went to the agent.
  expect(await screen.findByText("Added to your message")).toBeTruthy();
});
