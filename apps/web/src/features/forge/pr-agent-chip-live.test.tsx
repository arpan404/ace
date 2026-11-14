import { flakyCheckout, workbench } from "@ace/fake-daemon";
import { ForgePrDetail, WorkspaceId } from "@ace/protocol";
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openPullRequest } from "./test-support.ts";

await import("./pr-panel-tab.tsx");
configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const workspaceId = WorkspaceId.parse("api");
const detail = ForgePrDetail.parse({
  status: {
    ref: {
      repository: { forge: "github", host: "github.com", owner: "acme", name: "api" },
      number: 42,
    },
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
  },
  body: "",
  author: "author",
  headBranch: "fix/reconnect",
  baseBranch: "main",
  baseSha: "b".repeat(40),
  headRepository: { forge: "github", host: "github.com", owner: "acme", name: "api" },
  labels: [],
  reviewers: [],
  reviewDecision: null,
  commits: 1,
  changedFiles: 1,
  relatedThreads: [{ id: "thread-checkout", title: "Fix flaky checkout test", archived: false }],
  relatedThreadsTruncated: false,
});

test("while reconnecting, a pull request's agent chip claims no status for its linked task", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.play(flakyCheckout()).runThrough("explorer-spawned");
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId, number: 42 },
    { resource: "prDetail", value: detail },
  );
  await openPullRequest(app, { project: "api", number: 42 });
  const panel = await screen.findByRole("article", { name: "Pull request #42" });
  const chip = /^Fix flaky checkout test: Claude Code · /;
  const block = "Open thread: Fix flaky checkout test";
  expect(await within(panel).findByRole("button", { name: chip })).toBeTruthy();
  expect(within(panel).getByRole("button", { name: block })).toBeTruthy();
  act(() => app.daemon.refuseConnections(true));

  await waitFor(() => expect(within(panel).queryByRole("button", { name: chip })).toBeNull());
  // Its block in the details says nothing of it either: no "waiting", "working" or "done".
  expect(within(panel).queryByRole("button", { name: block })).toBeNull();

  act(() => app.daemon.refuseConnections(false));
  act(() => app.client.reconnectNow());
  expect(await within(panel).findByRole("button", { name: chip })).toBeTruthy();
});
