import { beforeEach, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ForgePrDetail,
  ForgePrSearch,
  ForgeStackWorkspace,
  ThreadId,
  WorkspaceId,
} from "@ace/protocol";
import { workbench } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";

const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const workspaceId = WorkspaceId.parse("api");
const threadId = ThreadId.parse("thread-dedupe-reconnect");
const layers = [
  {
    number: 41,
    position: 1,
    title: "Model",
    branch: "model",
    baseBranch: "main",
    headSha: "a".repeat(40),
    checksState: "SUCCESS",
    reviewDecision: "APPROVED",
    mergeState: "CLEAN",
  },
  {
    number: 42,
    position: 2,
    title: "API",
    branch: "api",
    baseBranch: "model",
    headSha: "b".repeat(40),
    checksState: "SUCCESS",
    reviewDecision: "REVIEW_REQUIRED",
    mergeState: "BLOCKED",
  },
  {
    number: 43,
    position: 3,
    title: "UI",
    branch: "ui",
    baseBranch: "api",
    headSha: "c".repeat(40),
    checksState: "PENDING",
    reviewDecision: "APPROVED",
    mergeState: "BEHIND",
  },
].map((layer) =>
  Object.assign({}, layer, {
    state: "OPEN",
    queueState: null,
    url: `https://github.com/acme/api/pull/${layer.number}`,
    requiredChecks: [{ name: "Tests", state: layer.checksState }],
  }),
);
const stack = ForgeStackWorkspace.parse({
  stack: { id: "STACK_2", number: 2, trunk: "main", layers, canMerge: true, raw: {} },
  local: null,
  localUnavailable: "Install the gh stack extension to rebase this checkout.",
  operation: null,
});
const detail = (number: number, linked = true) =>
  ForgePrDetail.parse({
    status: {
      ref: { repository, number },
      title: layers.find((layer) => layer.number === number)?.title ?? "PR",
      url: `https://github.com/acme/api/pull/${number}`,
      headSha: "b".repeat(40),
      state: "open",
      mergeability: "unknown",
      ci: "success",
      checks: [],
      comments: [],
      reviewThreads: [],
      raw: {},
    },
    body: "",
    author: "author",
    headBranch: "api",
    baseBranch: "model",
    baseSha: "a".repeat(40),
    headRepository: repository,
    labels: [],
    reviewers: [],
    reviewDecision: "REVIEW_REQUIRED",
    commits: 1,
    changedFiles: 1,
    relatedThreads: linked ? [{ id: threadId, title: "Stack task", archived: false }] : [],
    relatedThreadsTruncated: false,
  });
function setup(value = stack, linked = true) {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  for (const number of [41, 42, 43]) {
    app.daemon.workspace.setForgeRead(
      { op: "forge.pr.detail", workspaceId, number },
      { resource: "prDetail", value: detail(number, linked) },
    );
    app.daemon.workspace.setForgeRead(
      { op: "forge.pr.detail", workspaceId, repository, number },
      { resource: "prDetail", value: detail(number, linked) },
    );
    app.daemon.workspace.setForgeRead(
      { op: "forge.pr.stack", workspaceId, repository, ...(linked ? { threadId } : {}), number },
      { resource: "prStack", value },
    );
    app.daemon.workspace.setForgeRead(
      { op: "forge.pr.stack-memberships", workspaceId, repository, numbers: [number] },
      {
        resource: "prStackMemberships",
        value: [
          {
            number,
            stack: { id: "STACK_2", number: 2, trunk: "main", size: 3, position: number - 40 },
          },
        ],
      },
    );
  }
  return app;
}
beforeEach(() => localStorage.clear());

test("a middle layer shows downstack blockers and reviews the native merge scope and method before execution", async () => {
  const app = setup();
  await app.open("/pull-requests?project=api&number=42");
  const section = await screen.findByRole("region", { name: "Pull request stack" });
  expect(
    await within(section).findByText(/Reviews: REVIEW_REQUIRED.*GitHub merge rules: BLOCKED/),
  ).toBeTruthy();
  expect(within(section).getByText(/Native stacks do not support/)).toBeTruthy();
  expect(within(section).getAllByText("Reported required checks: Tests: SUCCESS")).toHaveLength(2);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Enable auto-merge" }).disabled,
  ).toBe(true);
  expect(
    within(section).getByRole<HTMLButtonElement>("button", { name: "Rebase local stack" }).disabled,
  ).toBe(true);
  await userEvent.selectOptions(
    within(section).getByRole("combobox", { name: "Stack merge method" }),
    "merge",
  );
  await userEvent.click(within(section).getByRole("button", { name: "Merge through #42" }));
  const confirmation = within(section).getByRole("group", { name: "Confirm stack action" });
  expect(within(confirmation).getByText(/Merge #41, #42 into main using merge/)).toBeTruthy();
  expect(within(confirmation).queryByText(/#43/)).toBeNull();
  await userEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
  expect(within(section).queryByRole("group", { name: "Confirm stack action" })).toBeNull();
  await userEvent.click(within(section).getByRole("button", { name: "Layer 1: #41 Model" }));
  expect(await screen.findByRole("heading", { name: "Model" })).toBeTruthy();
});

test("a refreshed uncertain request blocks another merge and remains visible after membership disappears", async () => {
  const app = setup(
    ForgeStackWorkspace.parse({
      ...stack,
      operation: {
        action: "merge",
        state: "uncertain",
        message: "Inspect GitHub before repeating this request.",
      },
    }),
  );
  await app.open("/pull-requests?project=api&number=42");
  const section = await screen.findByRole("region", { name: "Pull request stack" });
  expect(await within(section).findByText(/uncertain: Inspect GitHub/)).toBeTruthy();
  expect(
    within(section).getByRole<HTMLButtonElement>("button", { name: "Merge through #42" }).disabled,
  ).toBe(true);
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.stack", workspaceId, repository, threadId, number: 42 },
    {
      resource: "prStack",
      value: {
        ...stack,
        stack: null,
        operation: {
          action: "merge",
          state: "uncertain",
          message: "The original stack changed. Inspect GitHub.",
        },
      },
    },
  );
  await userEvent.click(within(section).getByRole("button", { name: "Refresh stack" }));
  expect(await within(section).findByText(/uncertain: The original stack changed/)).toBeTruthy();
  expect(within(section).queryByRole("button", { name: "Merge through #42" })).toBeNull();
});

test("no linked task leaves stack navigation available while remote writes require an explicit association", async () => {
  const app = setup(stack, false);
  await app.open("/pull-requests?project=api&number=42");
  const section = await screen.findByRole("region", { name: "Pull request stack" });
  await within(section).findByText(/Link the selected PR to a task/);
  expect(
    within(section).getByRole<HTMLButtonElement>("button", { name: "Merge through #42" }).disabled,
  ).toBe(true);
  await userEvent.click(within(section).getByRole("button", { name: "Layer 3: #43 UI" }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "UI" })).toBeTruthy());
});

test("a partially published rebase offers a reviewed push without restarting the rebase", async () => {
  const value = ForgeStackWorkspace.parse({
    ...stack,
    localUnavailable: null,
    local: {
      trunk: "main",
      currentBranch: "ui",
      branches: layers.map((layer) => ({
        name: layer.branch,
        head: layer.headSha,
        base: "d".repeat(40),
        isCurrent: layer.number === 43,
        isMerged: false,
        isQueued: false,
        needsRebase: false,
        pr: { number: layer.number, url: layer.url, state: "OPEN" },
      })),
    },
    operation: {
      action: "rebase",
      state: "push_partial",
      message: "Some branches may have reached GitHub.",
    },
  });
  const app = setup(value);
  await app.open("/pull-requests?project=api&number=42");
  const section = await screen.findByRole("region", { name: "Pull request stack" });
  await within(section).findByText(/push_partial: Some branches/);
  expect(
    within(section).getByRole<HTMLButtonElement>("button", { name: "Rebase local stack" }).disabled,
  ).toBe(true);
  expect(within(section).queryByRole("button", { name: "Continue local rebase" })).toBeNull();
  expect(
    within(section).getByRole<HTMLButtonElement>("button", { name: "Retry stack push" }).disabled,
  ).toBe(true);
  expect(within(section).getByText(/Publication is disabled/)).toBeTruthy();
  expect(within(section).queryByRole("group", { name: "Confirm stack action" })).toBeNull();
});

test("repository lists group only host-confirmed layers and use host positions for navigation", async () => {
  const app = setup();
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.list", workspaceId, query: ForgePrSearch.parse({}) },
    {
      resource: "prList",
      value: {
        repository,
        items: [43, 41, 42].map((number) => ({
          ref: { repository, number },
          title: `Layer ${number}`,
          url: `https://github.com/acme/api/pull/${number}`,
          author: "author",
          state: "open",
          labels: [],
          updatedAt: "2026-10-11",
        })),
        total: 3,
        counts: { open: 3, draft: 0, closed: 0, merged: 0 },
        incomplete: false,
        truncated: false,
      },
    },
  );
  app.daemon.workspace.setForgeRead(
    { op: "forge.pr.stack-memberships", workspaceId, repository, numbers: [43, 41, 42] },
    {
      resource: "prStackMemberships",
      value: [
        { number: 43, stack: { id: "STACK_2", number: 2, trunk: "main", size: 3, position: 3 } },
        { number: 41, stack: { id: "STACK_2", number: 2, trunk: "main", size: 3, position: 1 } },
        { number: 42, stack: null },
      ],
    },
  );
  await app.open("/pull-requests?project=api");
  const groups = await screen.findByRole("region", { name: "Native pull request stacks" });
  await within(groups).findByText("Native stack #2 → main · 3 layers");
  expect(
    within(groups)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["#41 · layer 1", "#43 · layer 3"]);
  await userEvent.click(within(groups).getByRole("button", { name: "#43 · layer 3" }));
  expect(await screen.findByRole("heading", { name: "UI" })).toBeTruthy();
});

test.each([
  { error: "forge_forbidden", message: /This account cannot access the repository/ },
  { error: "forge_conflict", message: /The GitHub resource changed while reading/ },
])(
  "final stack confirmation submits the command and exposes its $error receipt",
  async ({ error, message }) => {
    const app = setup();
    app.daemon.refuseCommands(error, "forge.pr.stack.change");
    await app.open("/pull-requests?project=api&number=42");
    const section = await screen.findByRole("region", { name: "Pull request stack" });
    const merge = await within(section).findByRole<HTMLButtonElement>("button", {
      name: "Merge through #42",
    });
    await waitFor(() => expect(merge.disabled).toBe(false));
    await userEvent.click(merge);
    const confirmation = within(section).getByRole("group", { name: "Confirm stack action" });
    expect(within(confirmation).getByText(/Merge #41, #42 into main using squash/)).toBeTruthy();
    expect(within(section).queryByText(message)).toBeNull();
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "Confirm stack merge" }),
    );
    expect(await within(section).findByText(message)).toBeTruthy();
    await waitFor(() =>
      expect(within(section).queryByRole("group", { name: "Confirm stack action" })).toBeNull(),
    );
    expect(screen.getByRole("heading", { name: "API" })).toBeTruthy();
  },
);
