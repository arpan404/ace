import { beforeEach, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgePrDetail, ThreadId, WorkspaceId, type GitConflictFile } from "@ace/protocol";
import { workbench } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";
import { openPullRequest } from "./test-support.ts";

await import("./pr-panel-tab.tsx");
const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const workspaceId = WorkspaceId.parse("api");
const host = ThreadId.parse("thread-retry-budget");
const head = "a".repeat(40);
const detail = ForgePrDetail.parse({
  status: {
    ref: { repository, number: 42 },
    title: "Retry reconnects",
    url: "https://github.com/acme/api/pull/42",
    headSha: head,
    state: "open",
    mergeability: "conflicting",
    ci: "success",
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
  reviewDecision: null,
  commits: 1,
  changedFiles: 1,
  relatedThreads: [{ id: host, title: "Linked task", archived: false }],
  relatedThreadsTruncated: false,
});
const shared: GitConflictFile = {
  path: "src/retry.ts",
  stages: { base: true, ours: true, theirs: true },
  content: {
    kind: "text",
    revision: "f".repeat(64),
    segments: [
      { kind: "text", text: "start\n" },
      {
        kind: "conflict",
        ours: "retry(3)\n",
        base: "retry(1)\n",
        theirs: "retry(5)\n",
        markers: {
          ours: "<<<<<<< HEAD\n",
          base: "||||||| base\n",
          separator: "=======\n",
          theirs: ">>>>>>> main\n",
        },
      },
      { kind: "text", text: "end\n" },
    ],
  },
};
beforeEach(() => localStorage.clear());

async function openConflicts() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId, number: 42 },
    { resource: "prDetail", value: detail },
  );
  app.daemon.workspace.conflicts.seed(host, head, [shared]);
  await openPullRequest(app, { project: "api", number: 42 });
  const panel = within(
    await screen.findByRole("article", { name: "Pull request #42" }, { timeout: 10_000 }),
  );
  await userEvent.click(await panel.findByRole("button", { name: "Resolve conflicts" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Resolve conflicts" }));
  await userEvent.click(await dialog.findByRole("button", { name: "Merge main" }));
  const hunk = within(await dialog.findByRole("group", { name: "Conflict 1 of 1" }));
  return { app, dialog, hunk };
}

test("the PR's conflicts show three ways, and a hunk taken from theirs is written and pushed", async () => {
  const { app, dialog, hunk } = await openConflicts();
  expect(dialog.getByRole("region", { name: "src/retry.ts" })).toBeTruthy();
  expect(hunk.getByText("Ours · fix/reconnect")).toBeTruthy();
  expect(hunk.getByText("retry(3)")).toBeTruthy();
  expect(hunk.getByText("retry(1)")).toBeTruthy();
  expect(hunk.getByText("retry(5)")).toBeTruthy();
  await userEvent.click(hunk.getByRole("button", { name: "Use theirs" }));
  expect(await dialog.findByText("Every conflict is resolved.")).toBeTruthy();
  expect(app.daemon.workspace.conflicts.written).toEqual([
    { path: "src/retry.ts", content: "start\nretry(5)\nend\n" },
  ]);
  await userEvent.click(dialog.getByRole("button", { name: "Commit and push to fix/reconnect" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Resolve conflicts" })).toBeNull(),
  );
  expect(app.daemon.workspace.conflicts.read(host)).toMatchObject({ merging: false });
});

test("an edited hunk starts from both sides and writes exactly what the person typed", async () => {
  const { app, hunk } = await openConflicts();
  await userEvent.click(hunk.getByRole("button", { name: "Edit" }));
  const editor = hunk.getByRole("textbox", { name: "Conflict 1 of 1: resolved text" });
  expect((editor as HTMLTextAreaElement).value).toBe("retry(3)\nretry(5)\n");
  await userEvent.clear(editor);
  await userEvent.type(editor, "retry(4)\n");
  await userEvent.click(hunk.getByRole("button", { name: "Save resolution" }));
  await waitFor(() =>
    expect(app.daemon.workspace.conflicts.written).toEqual([
      { path: "src/retry.ts", content: "start\nretry(4)\nend\n" },
    ]),
  );
});

test("aborting the merge leaves nothing to resolve and offers the merge again", async () => {
  const { app, dialog } = await openConflicts();
  await userEvent.click(dialog.getByRole("button", { name: "Abort merge" }));
  expect(await dialog.findByRole("button", { name: "Merge main" })).toBeTruthy();
  expect(app.daemon.workspace.conflicts.read(host)).toMatchObject({ merging: false, files: [] });
});
