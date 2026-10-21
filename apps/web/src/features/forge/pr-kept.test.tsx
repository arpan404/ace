import { beforeEach, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { ForgePrDetail, WorkspaceId } from "@ace/protocol";
import { workbench } from "@ace/fake-daemon";
import { createQueryClient } from "@/app.tsx";
import { restoreQueries } from "@/lib/query-persistence.ts";
import { harness } from "@/test/harness.tsx";
import { openPullRequest } from "./test-support.ts";
import { prDetailKey } from "@/lib/forge-pr-detail.ts";

await import("./pr-panel-tab.tsx");
const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const workspaceId = WorkspaceId.parse("api");
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
  relatedThreads: [],
  relatedThreadsTruncated: false,
});
beforeEach(() => localStorage.clear());
const panel = () => within(screen.getByRole("article", { name: "Pull request #42" }));

test("a PR kept by an earlier session paints before GitHub answers, holds writes until it does, then shows the new answer", async () => {
  const queries = createQueryClient();
  const kept = { ...detail, status: { ...detail.status, title: "Retry reconnects, as kept" } };
  restoreQueries(queries, [
    { key: [...prDetailKey(workspaceId, undefined, 42)], data: kept, at: 1 },
  ]);
  const app = harness({ queryClient: queries });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const operation = { op: "forge.pr.detail", workspaceId, number: 42 } as const;
  app.daemon.workspace.setForgeRead(operation, { resource: "prDetail", value: detail });
  const release = app.daemon.workspace.holdForgeRead(operation);
  await openPullRequest(app, { project: "api", number: 42 });
  await screen.findByRole("article", { name: "Pull request #42" }, { timeout: 10_000 });
  // GitHub hasn't answered: what was kept shows, and nothing may be written from it.
  expect(await panel().findByText("Retry reconnects, as kept")).toBeTruthy();
  const fix = () =>
    within(panel().getByRole("region", { name: "Needs attention" })).getByRole<HTMLButtonElement>(
      "button",
      { name: "Fix with agent: links" },
    );
  await waitFor(() => fix(), { timeout: 10_000 });
  expect(fix().disabled).toBe(true);
  release();
  await waitFor(() => expect(panel().queryByText("Retry reconnects, as kept")).toBeNull(), {
    timeout: 10_000,
  });
  expect(panel().getByText("Retry reconnects")).toBeTruthy();
  await waitFor(() => expect(fix().disabled).toBe(false), { timeout: 10_000 });
});
