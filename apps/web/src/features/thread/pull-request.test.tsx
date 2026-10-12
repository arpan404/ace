import { currentCheckout, gitAction, machineRow, openWorkCard } from "@/test/open-work.ts";
import { facts, workbench, type Scenario } from "@ace/fake-daemon";
import { ForgePrStatus, ForgeMergeState, ThreadId, type CommandPayload } from "@ace/protocol";
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
const mergeState = (patch: Partial<ForgeMergeState> = {}) =>
  ForgeMergeState.parse({
    headSha: "c".repeat(40),
    state: "OPEN",
    mergeState: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    checksState: "SUCCESS",
    autoMerge: null,
    queue: null,
    canEnable: false,
    canDisable: false,
    canDequeue: false,
    blockers: ["Required reviews are outstanding."],
    raw: {},
    ...patch,
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
    mergeState: mergeState(),
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

/** The details card's PR line Merge for PR `number`. */
async function merge(number = 42) {
  const card = await openWorkCard();
  await userEvent.click(
    await within(card).findByRole("button", { name: `Merge pull request #${number}` }),
  );
}

/** The link form, from the details card's More git actions. */
async function linkField() {
  await gitAction("Link a pull request…");
  const dialog = await screen.findByRole("dialog", { name: "Link an existing pull request" });
  return { dialog, field: within(dialog).getByRole("textbox", { name: "Pull request" }) };
}
async function link(reference: string) {
  const { field } = await linkField();
  await userEvent.type(field, `${reference}{Enter}`);
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Link an existing pull request" })).toBeNull(),
  );
}

const linked = (app: ReturnType<typeof harness>) => {
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-pr") });
  return view && "thread" in view ? view.thread.details?.linkedPr : undefined;
};
const links = (app: ReturnType<typeof harness>) => {
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-pr") });
  return view && "thread" in view ? view.thread.details?.linkedPrs : undefined;
};

test.each([
  {
    name: "failing checks",
    status: pr({ ci: "failure", checks: [check("lint", "success"), check("test", "failure")] }),
    reason: "Fix the failing checks first",
  },
  {
    name: "conflicts",
    status: pr({ mergeability: "conflicting", ci: "pending", checks: [check("test", "pending")] }),
    reason: "Resolve the conflicts with main first",
  },
])("Merge on a PR with $name says what to fix and leaves it open", async ({ status, reason }) => {
  const app = await withPr(status);
  await merge();
  expect(await screen.findByText(reason)).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "Merge PR #42?" })).toBeNull();
  expect(linked(app)).toMatchObject({ number: 42, state: "open" });
});

test("a passing PR merges from its line after confirmation, and the thread's PR reads merged", async () => {
  const app = await withPr(pr());
  const card = await openWorkCard();
  expect(
    await within(card).findByRole("button", {
      name: "Open pull request #42: Retry the replay cursor, open · checks passed",
    }),
  ).toBeTruthy();
  await merge();
  const confirm = await screen.findByRole("dialog", { name: "Merge PR #42?" });
  expect(linked(app)).toMatchObject({ state: "open" });
  await userEvent.click(within(confirm).getByRole("button", { name: "Merge" }));
  expect(await screen.findByText("Merged #42")).toBeTruthy();
  await waitFor(() => expect(linked(app)).toMatchObject({ number: 42, state: "merged" }));
  expect(
    within(await openWorkCard()).queryByRole("button", { name: "Merge pull request #42" }),
  ).toBeNull();
});

test("a merge method picked from More git actions merges after confirmation", async () => {
  const app = await withPr(pr());
  await gitAction("Rebase and merge");
  const confirm = await screen.findByRole("dialog", { name: "Merge PR #42?" });
  expect(linked(app)).toMatchObject({ state: "open" });
  await userEvent.click(within(confirm).getByRole("button", { name: "Merge" }));
  await waitFor(() => expect(linked(app)).toMatchObject({ number: 42, state: "merged" }));
});

test("a draft PR can't merge from its line", async () => {
  await withPr(pr({ state: "draft" }));
  const card = await openWorkCard();
  const button = await within(card).findByRole("button", { name: "Merge pull request #42" });
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(button.getAttribute("title")).toBe("Mark this PR ready on GitHub before merging");
});

test("Link a pull request follows a valid address and explains malformed addresses", async () => {
  const app = await withPr(undefined);
  expect(screen.queryByRole("textbox", { name: "Pull request" })).toBeNull();
  const { dialog, field } = await linkField();
  await userEvent.type(field, "https://github.com/acme/api/issues/77{Enter}");
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "Enter a PR number like #42, or its HTTPS pull request address on GitHub",
  );
  await userEvent.clear(field);
  await userEvent.type(field, "https://github.com/acme/api/pull/77/files{Enter}");
  expect(await screen.findByText("Linked pull request #77")).toBeTruthy();
  await waitFor(() => expect(linked(app)).toMatchObject({ number: 77, state: "open" }));
  expect(
    await within(await openWorkCard()).findByRole("button", { name: /^Open pull request #77/ }),
  ).toBeTruthy();
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
  const card = await openWorkCard();
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
  await merge();
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
  const card = await openWorkCard();
  const create = await within(card).findByRole("button", { name: "Create PR" });
  expect(create.hasAttribute("disabled")).toBe(true);
  expect(create.getAttribute("title")).toBe(
    "GitLab merge requests aren't supported yet: open one on GitLab.",
  );
  await userEvent.click(within(card).getByRole("button", { name: "More git actions" }));
  const menu = await screen.findByRole("menu");
  expect(
    within(menu)
      .getByRole("menuitem", { name: /^Create PR…/ })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  expect(within(menu).queryByRole("menuitem", { name: /^Link a pull request/ })).toBeNull();
});

test("switching branch with uncommitted changes offers to bring them along", async () => {
  const app = await withPr(undefined, { diff: { files: 2, additions: 9, deletions: 1 } });
  const card = await openWorkCard();
  await userEvent.click(
    within(card).getByRole("button", { name: "Branch fix/replay-cursor, switch branch" }),
  );
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
  const card = await openWorkCard();
  await userEvent.click(within(card).getByRole("button", { name: machineRow }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Local" }));
  expect(await screen.findByText("Moved to the local checkout")).toBeTruthy();
  await waitFor(async () => expect(await currentCheckout()).toBe("Local"));
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-pr") });
  expect(view && "thread" in view && view.thread.details?.mode).toBe("local");
});

test("a linked PR GitHub can't read still shows on its line and can be unlinked", async () => {
  const app = await withPr(undefined, { linkedPr: { number: 214, state: "open" } });
  const card = await openWorkCard();
  expect(await within(card).findByRole("button", { name: /^Open pull request #214/ })).toBeTruthy();
  await gitAction("Unlink PR #214");
  expect(await screen.findByText("Pull request unlinked")).toBeTruthy();
  await waitFor(() => expect(linked(app)).toBeNull());
  expect(
    within(await openWorkCard()).queryByRole("button", { name: /^Open pull request #214/ }),
  ).toBeNull();
});

test("the commit dialog lists the supervisor checkout files and commits the selected changes", async () => {
  const app = harness();
  const scenario = workbench().find((entry) => entry.thread.id === "thread-retry-budget");
  if (!scenario) throw new Error("Missing retry budget scenario");
  app.play(scenario).runUntilBlocked();
  await app.open("/t/thread-retry-budget");
  await screen.findByRole("feed", { name: "Transcript" });
  await gitAction("Commit & push…");
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

test("a second linked PR leads the PR line, a duplicate link changes nothing, and unlinking it leaves the first", async () => {
  const app = await withPr(pr({ ref: { repository, number: 283 } }));
  await link("#284");
  expect(
    await within(await openWorkCard()).findByRole("button", { name: /^Open pull request #284/ }),
  ).toBeTruthy();
  await link("#284");
  await waitFor(() => expect(links(app)).toHaveLength(2));
  await gitAction("Unlink PR #284");
  await waitFor(() => expect(links(app)).toMatchObject([{ number: 283 }]));
  expect(
    await within(await openWorkCard()).findByRole("button", { name: /^Open pull request #283/ }),
  ).toBeTruthy();
});

test("a live link publication leads the card's PR line, and the sidebar counts both PRs", async () => {
  const app = await withPr(pr({ ref: { repository, number: 284 } }));
  const card = await openWorkCard();
  await within(card).findByRole("button", { name: /^Open pull request #284/ });
  app.daemon.seedServices({
    pullRequests: { "thread-pr": pr({ ref: { repository, number: 283 } }) },
  });
  expect(await within(card).findByRole("button", { name: /^Open pull request #283/ })).toBeTruthy();
  const sidebar = screen.getByRole("navigation", { name: "Threads" });
  const row = await within(sidebar).findByRole("link", { name: /^Retry the replay cursor/ });
  expect(row.textContent).toContain("#283+1");
  expect(
    within(row).getAllByRole("img", { name: /pull request #283, 1 more linked/i }),
  ).toHaveLength(1);
});

test("explicit PR addresses can link another repository and unlink only that association", async () => {
  const app = await withPr(pr({ ref: { repository, number: 283 } }));
  const { field } = await linkField();
  await userEvent.click(field);
  await userEvent.paste("https://github.com/other/docs/pull/283");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(links(app)).toHaveLength(2));
  await gitAction("Unlink PR #283");
  await waitFor(() => expect(links(app)).toMatchObject([{ number: 283, repo: repository }]));
});

test("the work card links a configured Enterprise address through the worker connection", async () => {
  const app = harness({ throughWorker: true });
  app.play(idle("thread-pr", checkout)).runUntilBlocked();
  await app.open("/t/thread-pr");
  await app.client.request({
    type: "settings.set",
    key: "sourceControl.preferences",
    layer: { kind: "global" },
    value: {
      hosts: [{ host: "github.com" }, { host: "git.example.com" }],
      host: "git.example.com",
      remote: "upstream",
    },
  });
  const { field } = await linkField();
  await userEvent.type(field, "https://git.example.com/octo/ace/pull/7{Enter}");
  await waitFor(() =>
    expect(links(app)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          number: 7,
          repo: { forge: "github", host: "git.example.com", owner: "octo", name: "ace" },
        }),
      ]),
    ),
  );
});

test("Create PR sends the selected remote and the same reviewed head to push and PR creation", async () => {
  const app = harness({ throughWorker: true });
  app.play(idle("selected-remote", checkout)).runUntilBlocked();
  app.daemon.services.settings.seed({
    "sourceControl.preferences": {
      hosts: [{ host: "github.com", account: "ada" }],
      host: "github.com",
      remote: "upstream",
    },
  });
  const frames: CommandPayload[] = [];
  const receive = app.daemon.command.bind(app.daemon);
  app.daemon.command = (command) => {
    frames.push(command.payload);
    return receive(command);
  };
  await app.open("/t/selected-remote");
  const card = await openWorkCard();
  await userEvent.click(await within(card).findByRole("button", { name: "Create PR" }));
  const dialog = await screen.findByRole("dialog", { name: "Open a pull request" });
  await userEvent.click(within(dialog).getByRole("button", { name: /^Create PR/ }));
  await waitFor(() =>
    expect(frames.find((frame) => frame.type === "forge.pr.create")).toMatchObject({
      repository,
      input: { branch: checkout.branch, expectedHead: checkout.head },
    }),
  );
  expect(frames.find((frame) => frame.type === "git.push")).toMatchObject({
    remote: "upstream",
    target: { repository, branch: checkout.branch, head: checkout.head },
  });
});

test("Merge on the PR line confirms its own repository and leaves another linked PR untouched", async () => {
  const otherRepository = { ...repository, owner: "other", name: "docs" };
  const app = await withPr(pr({ ref: { repository, number: 283 } }));
  app.daemon.seedServices({
    pullRequests: {
      "thread-pr": pr({ ref: { repository: otherRepository, number: 284 }, title: "Docs fix" }),
    },
  });
  await within(await openWorkCard()).findByRole("button", { name: /^Open pull request #284/ });
  await merge(284);
  const confirm = await screen.findByRole("dialog", { name: "Merge PR #284?" });
  expect(confirm.textContent).toContain("other/docs#284");
  expect(links(app)?.every((each) => each.state === "open")).toBe(true);
  await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  expect(links(app)?.every((each) => each.state === "open")).toBe(true);
  await merge(284);
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Merge PR #284?" })).getByRole("button", {
      name: "Merge",
    }),
  );
  await waitFor(() =>
    expect(links(app)).toMatchObject([
      { number: 284, repo: otherRepository, state: "merged" },
      { number: 283, repo: repository, state: "open" },
    ]),
  );
  expect(await screen.findByText("Merged #284")).toBeTruthy();
});
