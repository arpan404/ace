import { beforeEach, expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgePrDetail, WorkspaceId } from "@ace/protocol";
import { workbench } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";
import { openPullRequest } from "./test-support.ts";

await import("./pr-panel-tab.tsx");
const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const workspaceId = WorkspaceId.parse("api");
const detail = (body: string) =>
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
    },
    body,
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

test("a pull request of another repository linked from a PR opens in a tab beside it", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId, number: 42 },
    {
      resource: "prDetail",
      value: detail("Needs [the docs change](https://github.com/acme/docs/pull/283) first."),
    },
  );
  await openPullRequest(app, { project: "api", number: 42 });
  const pr = await screen.findByRole("article", { name: "Pull request #42" }, { timeout: 10_000 });
  await userEvent.click(await within(pr).findByRole("link", { name: "the docs change" }));

  const side = screen.getByRole("region", { name: "Thread panel" });
  expect(await within(side).findByRole("tab", { name: "#283", selected: true })).toBeTruthy();
  expect(within(side).getByRole("tab", { name: "#42" })).toBeTruthy();
}, 30_000);
