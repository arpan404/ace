import { facts, type Scenario } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { machineRow, openWorkCard } from "@/test/open-work.ts";

configure({ asyncUtilTimeout: 20000 });

/*
 * The Work card when the thread's checkout is stuck: a move that failed keeps Retry and Clear,
 * and a worktree folder that is gone offers Move to local and Recreate worktree.
 */

const id = "thread-idle";
const scenario: Scenario = {
  thread: {
    id,
    workspaceId: "scratch",
    title: "Sketch a parser",
    provider: "claude",
    details: {
      workspace: { id: "scratch", name: "scratch", path: "/Users/dev/scratch" },
      mode: "local",
      worktree: "/Users/dev/scratch",
      branch: "main",
      head: "a".repeat(40),
      ahead: 0,
      behind: 0,
      baseBranch: "main",
      machine: { host: "fake-host", name: "This Mac" },
    },
  },
  steps: [{ kind: "facts", facts: [facts.rootAgent("claude")] }],
};

async function open() {
  const app = harness();
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${id}`);
  await screen.findByRole("feed", { name: "Transcript" });
  const details = () => {
    const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(id) });
    return view && "thread" in view ? view.thread.details : undefined;
  };
  return { app, details };
}

async function moveToWorktree() {
  const card = await openWorkCard();
  await userEvent.click(within(card).getByRole("button", { name: machineRow }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Worktree/ }));
}

test("a failed move to a worktree keeps Retry, which asks for the same move again", async () => {
  const { app, details } = await open();
  app.daemon.workspace.failMoves("workspace_preparation_collision");
  await moveToWorktree();
  await screen.findAllByText("Couldn't move the checkout");
  // The move names no branch: the daemon makes the worktree a branch of its own.
  expect(details()?.workspaceChange).toMatchObject({ state: "failed", mode: "worktree" });
  expect(details()?.workspaceChange?.branch).toBeUndefined();

  const card = await openWorkCard();
  const failed = await within(card).findByRole("group", { name: /^Checkout move failed/ });
  app.daemon.workspace.failMoves(undefined);
  await userEvent.click(within(failed).getByRole("button", { name: "Retry" }));
  await screen.findByText("Moved to a worktree");
  expect(details()).toMatchObject({ mode: "worktree", workspaceChange: { state: "applied" } });
  const after = await openWorkCard();
  expect(within(after).queryByRole("group", { name: /^Checkout move failed/ })).toBeNull();
}, 60_000);

test("Clear releases a failed move once the person confirms", async () => {
  const { app, details } = await open();
  app.daemon.workspace.failMoves("workspace_preparation_collision");
  await moveToWorktree();
  await screen.findAllByText("Couldn't move the checkout");
  const card = await openWorkCard();
  const failed = await within(card).findByRole("group", { name: /^Checkout move failed/ });
  await userEvent.click(within(failed).getByRole("button", { name: "Clear" }));
  const confirm = await screen.findByRole("dialog", { name: "Clear the failed move?" });
  await userEvent.click(within(confirm).getByRole("button", { name: "Clear move" }));
  await screen.findByText("Move cleared");
  await waitFor(() => expect(details()?.workspaceChange).toBeUndefined());
  expect(details()?.mode).toBe("local");
}, 60_000);

test("a missing worktree offers Move to local, which puts the thread back on the checkout", async () => {
  const { app, details } = await open();
  app.daemon.workspace.setDetails(id, {
    mode: "worktree",
    worktree: `/fake/worktrees/${id}`,
    worktreeMissing: true,
  });
  const card = await openWorkCard();
  const missing = await within(card).findByRole("group", { name: "Worktree missing" });
  expect(within(missing).getByRole("button", { name: "Recreate worktree" })).toBeTruthy();
  await userEvent.click(within(missing).getByRole("button", { name: "Move to local" }));
  await screen.findByText("Moved to the local checkout");
  expect(details()).toMatchObject({ mode: "local" });
  expect(details()?.worktreeMissing).toBeUndefined();
}, 60_000);
