import { gitAction, openWorkCard } from "@/test/open-work.ts";
import { facts, type Scenario } from "@ace/fake-daemon";
import { ForgePrStatus, ThreadId } from "@ace/protocol";
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

// The commit and PR forms load on first use; warm them before behavioural deadlines.
await import("./header/git-dialog.tsx");
configure({ asyncUtilTimeout: 10000 });
beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const checkout = {
  workspace: { id: "api", name: "api", path: "/Users/dev/api" },
  mode: "local" as const,
  worktree: "/Users/dev/api",
  branch: "fix/replay-cursor",
  head: "c".repeat(40),
  ahead: 1,
  behind: 0,
  baseBranch: "main",
  repository,
  machine: { host: "fake-host", name: "This Mac" },
  diff: { files: 1, additions: 3, deletions: 1 },
};
type Details = NonNullable<Scenario["thread"]["details"]>;

const scenario = (details: Details): Scenario => ({
  thread: {
    id: "thread-git",
    workspaceId: "api",
    title: "Retry the replay cursor",
    provider: "claude",
    details,
  },
  steps: [{ kind: "facts", facts: [facts.rootAgent("claude")] }],
});

async function openThread(details: Details = checkout, prepare?: (app: App) => void) {
  const app = harness();
  app.play(scenario(details)).runUntilBlocked();
  prepare?.(app);
  await app.open("/t/thread-git");
  await screen.findByRole("feed", { name: "Transcript" });
  return app;
}
type App = ReturnType<typeof harness>;

const pr = (patch: Partial<ForgePrStatus> = {}) =>
  ForgePrStatus.parse({
    ref: { repository, number: 42 },
    title: "Retry the replay cursor",
    url: "https://github.com/acme/api/pull/42",
    headSha: "c".repeat(40),
    state: "open",
    mergeability: "mergeable",
    ci: "success",
    checks: [],
    comments: [],
    reviewThreads: [],
    raw: {},
    ...patch,
  });
const running = {
  id: "test",
  name: "test",
  status: "pending" as const,
  conclusion: null,
  completedAt: null,
  jobId: null,
  url: null,
};

const details = (app: App) => {
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-git") });
  return view && "thread" in view ? view.thread.details : undefined;
};

/** Open the commit form with its push option on, and submit it. */
async function commitAndPush() {
  await gitAction(/^Commit & push/);
  const form = await screen.findByRole("dialog", { name: /^Commit to / });
  await within(form).findByRole("list", { name: "Files to commit" });
  await userEvent.click(within(form).getByRole("button", { name: /^Commit & push/ }));
  return form;
}

test("the card's checks flip from running to passed on their own while CI runs", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const app = await openThread(
    { ...checkout, ahead: 0, diff: { files: 0, additions: 0, deletions: 0 } },
    (fake) =>
      fake.daemon.seedServices({
        pullRequests: { "thread-git": pr({ ci: "pending", checks: [running] }) },
      }),
  );
  const card = await openWorkCard();
  expect(
    await within(card).findByRole("button", { name: /^Open pull request #42: .*checks running$/ }),
  ).toBeTruthy();
  app.daemon.seedServices({
    pullRequests: {
      "thread-git": pr({ ci: "success", checks: [{ ...running, status: "success" }] }),
    },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16_000);
  });
  expect(
    await within(card).findByRole("button", { name: /^Open pull request #42: .*checks passed$/ }),
  ).toBeTruthy();
});

test("unreadable checks read as unavailable, and Merge says why it is off", async () => {
  await openThread(
    { ...checkout, ahead: 0, diff: { files: 0, additions: 0, deletions: 0 } },
    (app) => app.daemon.seedServices({ pullRequests: { "thread-git": pr({ ci: "unknown" }) } }),
  );
  const card = await openWorkCard();
  expect(
    await within(card).findByRole("button", {
      name: /^Open pull request #42: .*checks unavailable$/,
    }),
  ).toBeTruthy();
  expect(within(card).getByRole("button", { name: "Merge pull request #42" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(within(card).getByText(/^Can't merge: Checks unavailable/)).toBeTruthy();
});

test("a failed checkout read says so with the daemon's reason, and Retry reads it again", async () => {
  const app = harness();
  // No published details: the card depends on reading the checkout.
  const { details: _none, ...thread } = scenario(checkout).thread;
  app.play({ ...scenario(checkout), thread }).runUntilBlocked();
  app.daemon.refuseRequests("workspace_unavailable", "workspace.request");
  await app.open("/t/thread-git");
  await screen.findByRole("feed", { name: "Transcript" });
  const card = await openWorkCard();
  expect(await within(card).findByText("Couldn't read the checkout")).toBeTruthy();
  expect(within(card).getByText(/The thread has no checkout yet/)).toBeTruthy();
  expect(within(card).queryByText("Not a git checkout")).toBeNull();
  app.daemon.restoreRequests();
  await userEvent.click(within(card).getByRole("button", { name: "Retry" }));
  expect(await within(card).findByText("Not a git checkout")).toBeTruthy();
});

test("when only the push fails, the commit is reported made and the form offers the push alone", async () => {
  const app = await openThread();
  app.daemon.refuseCommands("git_auth_failed", "git.push");
  const form = await commitAndPush();
  expect((await within(form).findByRole("alert")).textContent).toMatch(
    /^Committed aaaaaaa; push failed: Git couldn't sign in/,
  );
  expect(details(app)?.ahead).toBe(2);
  app.daemon.restoreRequests();
  await userEvent.click(within(form).getByRole("button", { name: /^Push/ }));
  expect(await screen.findByText("Pushed")).toBeTruthy();
  // One commit: retrying pushed it, it didn't commit again.
  expect(details(app)?.ahead).toBe(0);
  expect(details(app)?.head).toBe("a".repeat(40));
});

test("a push the remote rejects after a rebase offers a force push leased to the remote's revision", async () => {
  const app = await openThread(
    { ...checkout, diff: { files: 0, additions: 0, deletions: 0 } },
    (fake) => fake.daemon.workspace.setRemoteDiverged("thread-git", "b".repeat(40)),
  );
  const card = await openWorkCard();
  await userEvent.click(within(card).getByRole("button", { name: "Push" }));
  const confirm = await screen.findByRole("dialog", { name: /^Push fix\/replay-cursor/ });
  await userEvent.click(within(confirm).getByRole("button", { name: "Push" }));
  expect((await within(confirm).findByRole("alert")).textContent).toMatch(
    /The remote has commits this branch doesn't/,
  );
  expect(within(confirm).getByText("bbbbbbb")).toBeTruthy();
  await userEvent.click(within(confirm).getByRole("button", { name: "Force push (with lease)" }));
  expect(await screen.findByText("Force pushed")).toBeTruthy();
  expect(details(app)?.ahead).toBe(0);
});

test("the commit form says when Git hooks won't run for the commit", async () => {
  await openThread(checkout, (app) => app.daemon.workspace.setHooksSkipped("thread-git"));
  await gitAction(/^Commit & push/);
  const form = await screen.findByRole("dialog", { name: /^Commit to / });
  expect(await within(form).findByText(/^Git hooks won't run for this commit/)).toBeTruthy();
});

test("Create PR while the daemon is unreachable asks to reconnect", async () => {
  const app = await openThread({
    ...checkout,
    ahead: 0,
    diff: { files: 0, additions: 0, deletions: 0 },
  });
  await gitAction(/^Create PR/);
  const form = await screen.findByRole("dialog", { name: "Open a pull request" });
  app.daemon.refuseConnections(true);
  await userEvent.click(within(form).getByRole("button", { name: /^Create PR/ }));
  expect((await within(form).findByRole("alert")).textContent).toMatch(/reconnect/i);
  app.daemon.refuseConnections(false);
});

test("a PR that opens when asking for review fails is reported open, with the review failure", async () => {
  const app = await openThread({
    ...checkout,
    ahead: 0,
    diff: { files: 0, additions: 0, deletions: 0 },
  });
  app.daemon.refuseCommands("forge_forbidden", "forge.review.request");
  await gitAction(/^Create PR/);
  const form = await screen.findByRole("dialog", { name: "Open a pull request" });
  await userEvent.type(within(form).getByRole("textbox", { name: /Reviewers/ }), "mira");
  await userEvent.click(within(form).getByRole("button", { name: /^Create PR/ }));
  expect(await screen.findAllByText("PR #1 opened; review request failed")).not.toHaveLength(0);
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Open a pull request" })).toBeNull(),
  );
  expect(details(app)?.linkedPrs?.[0]?.number).toBe(1);
});
