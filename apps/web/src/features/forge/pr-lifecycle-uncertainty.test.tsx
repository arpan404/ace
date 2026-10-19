import { beforeEach, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgeLifecycleState, ForgePrDetail, WorkspaceId } from "@ace/protocol";
import { workbench } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";
import { openPullRequest } from "./test-support.ts";

await import("./pr-panel-tab.tsx");
const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const workspaceId = WorkspaceId.parse("api");
const headSha = "a".repeat(40);
const detail = ForgePrDetail.parse({
  status: {
    ref: { repository, number: 42 },
    title: "Review",
    url: "https://github.com/acme/api/pull/42",
    headSha,
    state: "open",
    mergeability: "unknown",
    ci: "none",
    checks: [],
    comments: [],
    reviewThreads: [],
    raw: {},
  },
  body: "Description",
  author: "author",
  headBranch: "feature",
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
const lifecycle = { op: "forge.pr.lifecycle", workspaceId, repository, number: 42 } as const;
const state = ForgeLifecycleState.parse({
  snapshot: {
    pr: detail.status.ref,
    id: "PR_42",
    version: "a".repeat(64),
    headSha,
    baseSha: detail.baseSha,
    state: "open",
    metadata: {
      title: detail.status.title,
      body: detail.body,
      baseBranch: "main",
      labels: [],
      assignees: [],
    },
    editableFields: ["body"],
    actions: ["close"],
    unsupported: [],
  },
  operations: [],
});
beforeEach(() => localStorage.clear());

test("an uncertain metadata edit keeps its text and holds lifecycle writes until its result is checked", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.detail", workspaceId, number: 42 },
    { resource: "prDetail", value: detail },
  );
  app.daemon.workspace.setForgeRead(lifecycle, { resource: "prLifecycle", value: state });
  app.daemon.refuseCommands("action_outcome_uncertain", "forge.hosted.lifecycle");
  await openPullRequest(app, { project: "api", number: 42 });
  await userEvent.click(await screen.findByRole("button", { name: "Pull request actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit details…" }));
  const description = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "PR description",
  });
  await userEvent.clear(description);
  await userEvent.type(description, "Keep my metadata edit");
  const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save PR metadata" });
  await waitFor(() => expect(save.disabled).toBe(false));
  await userEvent.click(save);
  expect(
    await screen.findAllByText(
      /The daemon lost track of the result: check the checkout or GitHub before retrying/,
    ),
  ).not.toHaveLength(0);
  // The form stays open with the edit.
  expect(description.value).toBe("Keep my metadata edit");
  await userEvent.keyboard("{Escape}");
  // GitHub now reports the write as unresolved: the panel offers to check it and holds others.
  app.daemon.restoreRequests();
  app.daemon.workspace.setForgeRead(lifecycle, {
    resource: "prLifecycle",
    value: { ...state, operations: [{ id: "edit-1", kind: "edit", state: "uncertain" }] },
  });
  await userEvent.click(await screen.findByRole("button", { name: "Pull request actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Refresh" }));
  const strip = await screen.findByRole("group", { name: "Unconfirmed changes" });
  expect(within(strip).getByText("Edit pull request · Outcome unknown")).toBeTruthy();
  expect(within(strip).getByRole("button", { name: "Check action result" })).toBeTruthy();
  await userEvent.click(await screen.findByRole("button", { name: "Pull request actions" }));
  const close = await screen.findByRole("menuitem", { name: /^Close pull request/ });
  expect(close.getAttribute("aria-disabled")).toBe("true");
  await userEvent.keyboard("{Escape}");
  // Opened again, the edit not yet confirmed is still there.
  await userEvent.click(await screen.findByRole("button", { name: "Pull request actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit details…" }));
  expect(
    (await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "PR description" })).value,
  ).toBe("Keep my metadata edit");
});
