import { facts, workbench, type Scenario } from "@ace/fake-daemon";
import { ForgePrStatus, ThreadId, WorkspaceId } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

// These interactions exercise the form, after its first-use lazy import has finished.
await import("./header/pr-field-dialog.tsx");
configure({ asyncUtilTimeout: 10000 });

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
  if (status) {
    app.daemon.seedServices({ pullRequests: { "thread-pr": status } });
    app.daemon.workspace.setForgeRead(
      {
        op: "forge.pr.stack-memberships",
        workspaceId: WorkspaceId.parse("api"),
        repository: status.ref.repository,
        numbers: [status.ref.number],
      },
      { resource: "prStackMemberships", value: [{ number: status.ref.number, stack: null }] },
    );
  }
  await app.open("/t/thread-pr");
  await screen.findByRole("feed", { name: "Transcript" });
  return app;
}

async function openCard() {
  const header = document.querySelector("header");
  if (!header) throw new Error("No header");
  await userEvent.click(within(header).getByRole("button", { name: /^Work card/ }));
  return screen.findByRole("complementary", { name: /^Work card/ });
}

/** The work card's PR row, opened into its popover. */
async function openPr(number = 42) {
  const card = await openCard();
  const prs = within(card).getByRole("region", { name: "Pull requests" });
  await userEvent.click(
    await within(prs).findByRole("button", { name: new RegExp(`^Pull request #${number}`) }),
  );
  const popover = await screen.findByRole("region", { name: `Pull request #${number}` });
  // Wait for the host membership read before inspecting independent-PR action availability.
  await waitFor(() =>
    expect(
      within(popover)
        .queryByRole("button", { name: "Squash and merge" })
        ?.getAttribute("aria-description"),
    ).not.toBe("Open the full PR workspace to inspect native stack merge rules."),
  );
  return popover;
}

async function linkField(card: HTMLElement) {
  await userEvent.click(within(card).getByRole("button", { name: "Project actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Link a pull request" }));
  return within(card).getByRole("textbox", { name: "Link pull request…" });
}
async function unlink(card: HTMLElement, number: number, index = 0) {
  const button = within(card).getAllByRole("button", { name: `PR #${number} actions` })[index];
  if (!button) throw new Error("No pull request actions");
  await userEvent.click(button);
  await userEvent.click(await screen.findByRole("menuitem", { name: `Unlink PR #${number}` }));
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
  expect(await screen.findByRole("img", { name: "Work needs you" })).toBeTruthy();
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
  const confirm = await screen.findByRole("dialog", { name: "Merge PR #42?" });
  expect(linked(app)).toMatchObject({ state: "open" });
  await userEvent.click(within(confirm).getByRole("button", { name: "Merge" }));
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
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Enable auto-merge PR #42?" })).getByRole(
      "button",
      { name: "Enable auto-merge" },
    ),
  );
  expect(
    await screen.findByText("Auto-merge on: #42 will squash and merge once checks pass"),
  ).toBeTruthy();
  expect(linked(app)).toMatchObject({ state: "open" });

  // The checks pass on the forge: GitHub merges it, and the card follows.
  app.daemon.seedServices({ pullRequests: { "thread-pr": pr() } });
  await waitFor(() => expect(linked(app)).toMatchObject({ state: "merged" }));
  const card = screen.getByRole("complementary", { name: /^Work card/ });
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
  expect(within(card).queryByRole("textbox", { name: "Link pull request…" })).toBeNull();
  const field = await linkField(card);
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
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Merge PR #42?" })).getByRole("button", {
      name: "Merge",
    }),
  );
  expect(await screen.findAllByText(/Sign in to GitHub: run/)).not.toHaveLength(0);
  expect(await screen.findAllByText("gh auth login")).not.toHaveLength(0);
  expect(await screen.findAllByText(/, then retry\./)).not.toHaveLength(0);
});

test("a GitLab checkout says merge requests aren't supported before anything is tried", async () => {
  await withPr(undefined, {
    repository: { forge: "gitlab", host: "gitlab.com", owner: "acme", name: "api" },
  });
  const card = await openCard();
  expect(within(card).queryByRole("button", { name: "Create PR" })).toBeNull();
  expect(within(card).queryByRole("button", { name: "Link a pull request" })).toBeNull();
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
  expect(within(card).getByRole("heading", { level: 2 }).textContent).toContain("Local");
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
  const work = screen.getByRole("complementary", { name: /^Work card/ });
  expect(within(work).queryByText("open", { exact: true })).toBeNull();
  expect(within(work).getByRole("button", { name: /Pull request #214.*Unavailable/ })).toBeTruthy();
  expect(within(popover).queryByRole("button", { name: "Squash and merge" })).toBeNull();
  await unlink(work, 214);
  expect(await screen.findByText("Pull request unlinked")).toBeTruthy();
  await waitFor(() => expect(linked(app)).toBeNull());
  expect(within(work).queryByRole("button", { name: /Pull request #214/ })).toBeNull();
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
  await userEvent.click(await within(card).findByRole("button", { name: "Project actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Commit & push…" }));
  const dialog = await screen.findByRole("dialog", { name: /^Commit to / });
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
  let input = await linkField(card);
  await userEvent.type(input, "#284{Enter}");
  await userEvent.click(await within(card).findByRole("button", { name: "Show 1 more" }));
  expect(await within(card).findByRole("button", { name: "PR #283 actions" })).toBeTruthy();
  expect(await within(card).findByRole("button", { name: "PR #284 actions" })).toBeTruthy();
  input = await linkField(card);
  await userEvent.type(input, "#284{Enter}");
  await waitFor(() => {
    const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-pr") });
    expect(view && "thread" in view && view.thread.details?.linkedPrs).toHaveLength(2);
  });
  await unlink(card, 283);
  await waitFor(() =>
    expect(within(card).queryByRole("button", { name: "PR #283 actions" })).toBeNull(),
  );
  await userEvent.click(within(card).getByRole("button", { name: "PR #284 actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Unlink all" }));
  const dialog = await screen.findByRole("dialog", { name: "Unlink all pull requests?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(within(card).getByRole("button", { name: "PR #284 actions" })).toBeTruthy();
  await userEvent.click(within(card).getByRole("button", { name: "PR #284 actions" }));
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
  await userEvent.click(await within(card).findByRole("button", { name: "Show 1 more" }));
  expect(await within(card).findByRole("button", { name: "PR #283 actions" })).toBeTruthy();
  expect(await within(card).findByRole("button", { name: "PR #284 actions" })).toBeTruthy();
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
  const field = await linkField(card);
  await userEvent.click(field);
  await userEvent.paste("https://github.com/other/docs/pull/283");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    const snapshot = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-pr") });
    expect(snapshot && "thread" in snapshot && snapshot.thread.details?.linkedPrs).toHaveLength(2);
  });
  await userEvent.click(await within(card).findByRole("button", { name: "Show 1 more" }));
  const secondary = within(card).getAllByRole("button", { name: /^Pull request #283/ })[1];
  if (!secondary) throw new Error("The second linked pull request is missing");
  await userEvent.click(secondary);
  const details = within(card).getByRole("region", { name: "Pull request #283" });
  expect(await within(details).findByText("2 checks passed")).toBeTruthy();
  expect(within(details).getByRole("button", { name: "Refresh" })).toBeTruthy();
  expect(within(details).getByRole("button", { name: "Squash and merge" })).toBeTruthy();
  await userEvent.click(secondary);
  await unlink(card, 283);
  await waitFor(() => {
    const snapshot = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-pr") });
    expect(snapshot && "thread" in snapshot && snapshot.thread.details?.linkedPrs).toMatchObject([
      { number: 283, repo: repository },
    ]);
  });
});

test("an inline merge confirms the selected repository and leaves another linked PR untouched", async () => {
  const otherRepository = { ...repository, owner: "other", name: "docs" };
  const app = await withPr(pr({ ref: { repository, number: 283 } }));
  app.daemon.seedServices({
    pullRequests: {
      "thread-pr": pr({ ref: { repository: otherRepository, number: 284 }, title: "Docs fix" }),
    },
  });
  const card = await openCard();
  await userEvent.click(await within(card).findByRole("button", { name: "Show 1 more" }));
  await userEvent.click(within(card).getByRole("button", { name: "Merge PR #283" }));
  const confirm = await screen.findByRole("dialog", { name: "Merge PR #283?" });
  expect(confirm.textContent).toContain("acme/api#283");
  const links = () => {
    const snapshot = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-pr") });
    return snapshot && "thread" in snapshot ? snapshot.thread.details?.linkedPrs : undefined;
  };
  expect(links()?.every((link) => link.state === "open")).toBe(true);
  await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  expect(links()?.every((link) => link.state === "open")).toBe(true);
  await userEvent.click(within(card).getByRole("button", { name: "Merge PR #283" }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Merge PR #283?" })).getByRole("button", {
      name: "Merge",
    }),
  );
  await waitFor(() =>
    expect(links()).toMatchObject([
      { number: 284, repo: otherRepository, state: "open" },
      { number: 283, repo: repository, state: "merged" },
    ]),
  );
  expect(await screen.findByText("Merged #283")).toBeTruthy();
});

test("a host-confirmed native layer is grouped in linked controls and sends merge actions to the full workspace", async () => {
  const app = await withPr(pr());
  app.daemon.workspace.setForgeRead(
    {
      op: "forge.pr.stack-memberships",
      workspaceId: WorkspaceId.parse("api"),
      repository,
      numbers: [42],
    },
    {
      resource: "prStackMemberships",
      value: [
        { number: 42, stack: { id: "STACK_9", number: 9, trunk: "main", size: 3, position: 2 } },
      ],
    },
  );
  const card = await openCard();
  expect(await within(card).findByRole("button", { name: "#42 · layer 2" })).toBeTruthy();
  await userEvent.click(within(card).getByRole("button", { name: /^Pull request #42/ }));
  const popover = await screen.findByRole("region", { name: "Pull request #42" });
  const merge = await within(popover).findByRole("button", { name: "Squash and merge" });
  expect(merge.getAttribute("aria-disabled")).toBe("true");
  expect(merge.getAttribute("aria-description")).toBe(
    "Open the full PR workspace to inspect native stack merge rules.",
  );
  await userEvent.click(within(popover).getByRole("button", { name: "Merge options" }));
  expect(
    (await screen.findByRole("menuitem", { name: /Auto-merge when checks pass/ })).getAttribute(
      "aria-disabled",
    ),
  ).toBe("true");
});
