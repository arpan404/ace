import { facts, workbench, type Scenario } from "@ace/fake-daemon";
import { ForgePrStatus, ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const checkout = {
  workspace: { id: "api", name: "api", path: "/Users/dev/api" },
  mode: "local" as const,
  worktree: "/Users/dev/api",
  branch: "fix/replay-cursor",
  head: "c".repeat(40),
  ahead: 0,
  behind: 0,
  baseBranch: "main",
  repository,
  machine: { host: "fake-host", name: "This Mac" },
};
type Details = NonNullable<Scenario["thread"]["details"]>;

function idle(id: string, details: Details): Scenario {
  return {
    thread: {
      id,
      workspaceId: "api",
      title: "Retry the replay cursor",
      provider: "claude",
      details,
    },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("claude"),
          facts.turn("root"),
          facts.message("root", "request", "user", "Fix replay"),
          facts.endTurn("root"),
        ],
      },
    ],
  };
}

const check = (name: string, status: "success" | "failure" | "pending") => ({
  id: name,
  name,
  status,
  conclusion: status === "pending" ? null : status,
  completedAt: null,
  jobId: null,
  url: `https://github.com/acme/api/actions/runs/${name.length}`,
});
const pr = (patch: Partial<ForgePrStatus> = {}) =>
  ForgePrStatus.parse({
    ref: { repository, number: 42 },
    title: "Retry the replay cursor",
    url: "https://github.com/acme/api/pull/42",
    headSha: "c".repeat(40),
    state: "open",
    mergeability: "mergeable",
    ci: "success",
    checks: [check("lint", "success"), check("test", "success")],
    comments: [],
    reviewThreads: [],
    raw: {},
    ...patch,
  });

/** A thread on `checkout` with PR #42 linked as the forge reports `status`. */
async function withPr(status: ForgePrStatus | undefined, details: Partial<Details> = {}) {
  const app = harness();
  app.play(idle("thread-pr", { ...checkout, ...details })).runUntilBlocked();
  if (status) app.daemon.seedServices({ pullRequests: { "thread-pr": status } });
  await app.open("/t/thread-pr");
  await screen.findByRole("feed", { name: "Transcript" });
  return app;
}

async function openCard() {
  const header = document.querySelector("header");
  if (!header) throw new Error("No header");
  await userEvent.click(within(header).getByRole("button", { name: "Work card" }));
  return screen.findByRole("complementary", { name: "Work card" });
}

/** The work card's PR row, opened into its popover. */
async function openPr(number = 42) {
  const card = await openCard();
  const prs = within(card).getByRole("region", { name: "Pull requests" });
  await userEvent.click(
    await within(prs).findByRole("button", { name: new RegExp(`^Pull request #${number}`) }),
  );
  return screen.findByRole("region", { name: `Pull request #${number}` });
}

const linked = (app: ReturnType<typeof harness>) => {
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-pr") });
  return view && "thread" in view ? view.thread.details?.linkedPr : undefined;
};

test("a PR with failing checks lists them with their logs, and Merge says to fix them first", async () => {
  await withPr(
    pr({ ci: "failure", checks: [check("lint", "success"), check("test (pdf)", "failure")] }),
  );
  const popover = await openPr();
  expect(await within(popover).findByText("1 of 2 checks failed")).toBeTruthy();
  const checks = within(popover).getByRole("list", { name: "Checks" });
  expect(within(checks).getAllByRole("listitem")[0]?.textContent).toContain("test (pdf)");
  expect(within(checks).getByRole("button", { name: "Open the test (pdf) logs" })).toBeTruthy();
  expect(within(popover).getByText("No conflicts with main")).toBeTruthy();
  const merge = within(popover).getByRole("button", { name: "Squash and merge" });
  expect(merge.getAttribute("aria-disabled")).toBe("true");
  expect(merge.getAttribute("aria-description")).toBe("Fix the failing checks first");
});

test("a conflicting PR can't merge or auto-merge, and names the base it conflicts with", async () => {
  await withPr(
    pr({
      mergeability: "conflicting",
      ci: "pending",
      checks: [check("test", "pending")],
      reviewThreads: [
        { id: "t1", resolved: false, outdated: false, file: "a.ts", line: 3, comments: [] },
        { id: "t2", resolved: true, outdated: false, file: "a.ts", line: 9, comments: [] },
      ],
    }),
  );
  const popover = await openPr();
  expect(await within(popover).findByText("Conflicts with main")).toBeTruthy();
  expect(within(popover).getByText("1 unresolved review thread")).toBeTruthy();
  const merge = within(popover).getByRole("button", { name: "Squash and merge" });
  expect(merge.getAttribute("aria-description")).toBe("Resolve the conflicts with main first");
  await userEvent.click(within(popover).getByRole("button", { name: "Merge options" }));
  const auto = await screen.findByRole("menuitem", { name: /Auto-merge when checks pass/ });
  expect(auto.getAttribute("aria-disabled")).toBe("true");
});

test("a passing PR merges with the method picked, and the thread's PR reads merged", async () => {
  const app = await withPr(pr());
  const popover = await openPr();
  expect(await within(popover).findByText("2 checks passed")).toBeTruthy();
  await userEvent.click(within(popover).getByRole("button", { name: "Merge options" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Rebase and merge" }));
  await userEvent.click(within(popover).getByRole("button", { name: "Rebase and merge" }));
  expect(await screen.findByText("Merged #42")).toBeTruthy();
  await waitFor(() => expect(linked(app)).toMatchObject({ number: 42, state: "merged" }));
});

test("auto-merge waits for running checks, then the PR merges once they pass", async () => {
  const app = await withPr(
    pr({ ci: "pending", checks: [check("lint", "success"), check("test", "pending")] }),
  );
  const popover = await openPr();
  expect(await within(popover).findByText("Checks running · 1 of 2 done")).toBeTruthy();
  await userEvent.click(within(popover).getByRole("button", { name: "Merge options" }));
  await userEvent.click(
    await screen.findByRole("menuitem", { name: /Auto-merge when checks pass/ }),
  );
  expect(
    await screen.findByText("Auto-merge on: #42 will squash and merge once checks pass"),
  ).toBeTruthy();
  expect(linked(app)).toMatchObject({ state: "open" });

  // The checks pass on the forge: GitHub merges it, and the card follows.
  app.daemon.seedServices({ pullRequests: { "thread-pr": pr() } });
  await waitFor(() => expect(linked(app)).toMatchObject({ state: "merged" }));
  const card = screen.getByRole("complementary", { name: "Work card" });
  expect(
    await within(card).findByRole("button", { name: /^Pull request #42.*, merged/ }),
  ).toBeTruthy();
});

test("Request review asks the GitHub users typed, and refuses a name that can't be one", async () => {
  await withPr(pr());
  const popover = await openPr();
  await userEvent.click(within(popover).getByRole("button", { name: "Request review…" }));
  const dialog = await screen.findByRole("dialog", { name: "Request a review" });
  const field = within(dialog).getByRole("textbox", { name: "Reviewers" });
  await userEvent.type(field, "mira, acme/core{Enter}");
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "“acme/core” isn't a GitHub username",
  );
  await userEvent.clear(field);
  await userEvent.type(field, "@mira sam{Enter}");
  expect(await screen.findByText("Asked mira, sam to review")).toBeTruthy();
});

test("Link existing PR follows a valid address and explains malformed addresses", async () => {
  const app = await withPr(undefined);
  const card = await openCard();
  expect(within(card).getByText("None for this branch yet")).toBeTruthy();
  const field = within(card).getByRole("textbox", { name: "Link pull request…" });
  await userEvent.type(field, "https://github.com/acme/api/issues/77{Enter}");
  expect((await within(card).findByRole("alert")).textContent).toBe(
    "Enter a PR number like #42, or its HTTPS pull request address on GitHub",
  );
  await userEvent.clear(field);
  await userEvent.type(field, "https://github.com/acme/api/pull/77/files{Enter}");
  expect(await screen.findByText("Linked pull request #77")).toBeTruthy();
  await waitFor(() => expect(linked(app)).toMatchObject({ number: 77, state: "open" }));
});

test("Create PR links the branch's existing PR instead of opening another, and asks reviewers", async () => {
  const app = harness();
  app.play(idle("thread-pr", checkout)).runUntilBlocked();
  // Another thread on the same branch already opened PR #55 for it.
  app.play(idle("thread-other", checkout)).runUntilBlocked();
  app.daemon.seedServices({
    pullRequests: {
      "thread-other": pr({ ref: { repository, number: 55 }, title: "Replay cursor fix" }),
    },
  });
  await app.open("/t/thread-pr");
  await screen.findByRole("feed", { name: "Transcript" });
  const card = await openCard();
  await userEvent.click(await within(card).findByRole("button", { name: "Create PR" }));
  const dialog = await screen.findByRole(
    "dialog",
    { name: "Open a pull request" },
    { timeout: 10000 },
  );
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Reviewers" }), "mira");
  await userEvent.click(within(dialog).getByRole("button", { name: /^Create PR/ }));
  expect(
    await screen.findByText("Linked the branch's existing pull request #55 · asked mira to review"),
  ).toBeTruthy();
  await waitFor(() => expect(linked(app)).toMatchObject({ number: 55 }));
});

test("a forge refusal reads as a sentence with its fix, not its code", async () => {
  const app = await withPr(pr());
  app.daemon.refuseCommands("forge_auth", "forge.pr.merge");
  const popover = await openPr();
  await userEvent.click(await within(popover).findByRole("button", { name: "Squash and merge" }));
  expect(await screen.findAllByText("Couldn't merge")).not.toHaveLength(0);
  expect(await screen.findAllByText(/Sign in to GitHub: run/)).not.toHaveLength(0);
  expect(await screen.findAllByText("gh auth login")).not.toHaveLength(0);
  expect(await screen.findAllByText(/, then retry\./)).not.toHaveLength(0);
});

test("a GitLab checkout says merge requests aren't supported before anything is tried", async () => {
  await withPr(undefined, {
    repository: { forge: "gitlab", host: "gitlab.com", owner: "acme", name: "api" },
  });
  const card = await openCard();
  expect(within(card).getByText("GitLab merge requests aren't supported yet")).toBeTruthy();
  const create = await within(card).findByRole("button", { name: "Create PR" });
  expect(create.getAttribute("aria-description")).toBe(
    "GitLab merge requests aren't supported yet: open one on GitLab.",
  );
});

test("switching branch with uncommitted changes offers to bring them along", async () => {
  const app = await withPr(undefined, { diff: { files: 2, additions: 9, deletions: 1 } });
  const card = await openCard();
  await userEvent.click(within(card).getByRole("button", { name: "Project actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /Switch branch/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "develop" }));
  const dialog = await screen.findByRole("dialog", {
    name: "The checkout has uncommitted changes",
  });
  expect(within(dialog).getByText(/carries them to develop/)).toBeTruthy();
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Switch anyway, bringing changes along" }),
  );
  expect(await screen.findByText("Switched to develop")).toBeTruthy();
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-pr") });
  expect(view && "thread" in view && view.thread.details).toMatchObject({
    branch: "develop",
    diff: { files: 2 },
  });
});

test("a thread in its own worktree moves back to the local checkout", async () => {
  const app = await withPr(undefined, { mode: "worktree", worktree: "/fake/worktrees/thread-pr" });
  const card = await openCard();
  await userEvent.click(within(card).getByRole("button", { name: "Project actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /Move to local checkout/ }));
  expect(await screen.findByText("Moved to the local checkout")).toBeTruthy();
  const environment = await screen.findByRole("region", { name: "Checkout details" });
  expect(within(environment).getByText("Local checkout")).toBeTruthy();
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-pr") });
  expect(view && "thread" in view && view.thread.details?.mode).toBe("local");
});

test("a missing PR shows one explanation and can be unlinked without GitHub", async () => {
  const app = await withPr(undefined, { linkedPr: { number: 214, state: "open" } });
  const popover = await openPr(214);
  expect((await within(popover).findByRole("alert")).textContent).toContain(
    "GitHub couldn't find the pull request",
  );
  expect(within(popover).queryByText("No status from GitHub yet")).toBeNull();
  const work = screen.getByRole("complementary", { name: "Work card" });
  expect(within(work).queryByText("open", { exact: true })).toBeNull();
  expect(within(work).getByText("Unavailable")).toBeTruthy();
  expect(within(popover).queryByRole("button", { name: "Squash and merge" })).toBeNull();
  await userEvent.click(within(work).getByRole("button", { name: "Unlink PR #214" }));
  expect(await screen.findByText("Pull request unlinked")).toBeTruthy();
  await waitFor(() => expect(linked(app)).toBeNull());
  expect(await screen.findByText("None for this branch yet")).toBeTruthy();
});

test("a failed refresh replaces stale checks and a successful retry restores them", async () => {
  const app = await withPr(pr());
  app.daemon.refuseCommands("forge_not_found", "forge.pr.status");
  const popover = await openPr();
  await within(popover).findByRole("alert");
  expect(within(popover).queryByText("2 checks passed")).toBeNull();
  app.daemon.restoreRequests();
  await userEvent.click(within(popover).getByRole("button", { name: "Refresh" }));
  expect(await within(popover).findByText("2 checks passed")).toBeTruthy();
  expect(within(popover).queryByRole("alert")).toBeNull();
});

test("a truncated PR title can be read in its tooltip", async () => {
  const title = "Keep replay cursors stable across disconnects and background shell completions";
  await withPr(pr({ title }));
  const card = await openCard();
  await userEvent.hover(await within(card).findByText(title));
  expect((await screen.findByRole("tooltip")).textContent).toBe(title);
});

test("the commit dialog lists the supervisor checkout files and commits the selected changes", async () => {
  const app = harness();
  const scenario = workbench().find((entry) => entry.thread.id === "thread-retry-budget");
  if (!scenario) throw new Error("Missing retry budget scenario");
  app.play(scenario).runUntilBlocked();
  await app.open("/t/thread-retry-budget");
  await screen.findByRole("feed", { name: "Transcript" });
  const card = await openCard();
  await userEvent.click(await within(card).findByRole("button", { name: "Commit & push" }));
  const dialog = await screen.findByRole("dialog", { name: "Commit changes" });
  const files = await within(dialog).findByRole("list", { name: "Files to commit" });
  expect(files.textContent).toContain("src/supervisor/restart-budget.ts");
  expect(files.textContent).toContain("src/supervisor/supervisor.ts");
  expect(files.textContent).not.toMatch(/src\/config|src\/lib\/retry/);
  expect(
    within(files).getByRole("checkbox", { name: /restart-budget/, checked: true }),
  ).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: /^Commit & push/ }));
  expect(await screen.findByText("Committed and pushed")).toBeTruthy();
  expect(app.daemon.workspace.gitStatus("thread-retry-budget")).toEqual([]);
});

test("several pull requests stay linked, duplicates do nothing, and people can unlink one or all", async () => {
  const app = await withPr(pr({ ref: { repository, number: 283 } }));
  const card = await openCard();
  const input = within(card).getByRole("textbox", { name: "Link pull request…" });
  await userEvent.type(input, "#284{Enter}");
  expect(await within(card).findByRole("button", { name: "Unlink PR #283" })).toBeTruthy();
  expect(await within(card).findByRole("button", { name: "Unlink PR #284" })).toBeTruthy();
  await userEvent.type(input, "#284{Enter}");
  await waitFor(() => {
    const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-pr") });
    expect(view && "thread" in view && view.thread.details?.linkedPrs).toHaveLength(2);
  });
  await userEvent.click(within(card).getByRole("button", { name: "Unlink PR #283" }));
  await waitFor(() =>
    expect(within(card).queryByRole("button", { name: "Unlink PR #283" })).toBeNull(),
  );
  await userEvent.click(within(card).getByRole("button", { name: "Pull request actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Unlink all" }));
  const dialog = await screen.findByRole("dialog", { name: "Unlink all pull requests?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(within(card).getByRole("button", { name: "Unlink PR #284" })).toBeTruthy();
  await userEvent.click(within(card).getByRole("button", { name: "Pull request actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Unlink all" }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Unlink all pull requests?" })).getByRole(
      "button",
      { name: "Unlink all" },
    ),
  );
  await waitFor(() => expect(linked(app)).toBeNull());
});

test("a live link publication updates the work card and sidebar with both PRs", async () => {
  const app = await withPr(pr({ ref: { repository, number: 284 } }));
  const card = await openCard();
  app.daemon.seedServices({
    pullRequests: { "thread-pr": pr({ ref: { repository, number: 283 } }) },
  });
  expect(await within(card).findByRole("button", { name: "Unlink PR #283" })).toBeTruthy();
  expect(await within(card).findByRole("button", { name: "Unlink PR #284" })).toBeTruthy();
  const sidebar = screen.getByRole("navigation", { name: "Threads" });
  const row = await within(sidebar).findByRole("link", { name: /^Retry the replay cursor/ });
  expect(row.textContent).toContain("#283+1");
  expect(
    within(row).getAllByRole("img", { name: /pull request #283, 1 more linked/i }),
  ).toHaveLength(1);
});

test("explicit PR addresses can link another repository and unlink only that association", async () => {
  const app = await withPr(pr({ ref: { repository, number: 283 } }));
  const card = await openCard();
  const field = within(card).getByRole("textbox", { name: "Link pull request…" });
  await userEvent.type(field, "https://github.com/other/docs/pull/283{Enter}");
  await waitFor(() => {
    const snapshot = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-pr") });
    expect(snapshot && "thread" in snapshot && snapshot.thread.details?.linkedPrs).toHaveLength(2);
  });
  const section = within(card).getByRole("region", { name: "Pull requests" });
  await userEvent.click(
    within(section).getAllByRole("button", { name: "Unlink PR #283" })[0] ?? field,
  );
  await waitFor(() => {
    const snapshot = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-pr") });
    expect(snapshot && "thread" in snapshot && snapshot.thread.details?.linkedPrs).toMatchObject([
      { number: 283, repo: repository },
    ]);
  });
});
