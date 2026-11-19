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
 * and a worktree folder that is gone says what Git still has of it, with the ways back.
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

test("a late worktree's failed setup shows its output, and Continue lets the thread start", async () => {
  const { app, details } = await open();
  app.daemon.workspace.setDetails(id, {
    worktreeSetup: { state: "failed", details: ["npm ERR! setup broke"], at: 1 },
  });
  const card = await openWorkCard();
  await within(card).findByText("Setup script failed");
  expect(within(card).getByRole("log", { name: "Setup output" }).textContent).toContain(
    "npm ERR! setup broke",
  );
  await userEvent.click(within(card).getByRole("button", { name: "Continue without setup" }));
  await waitFor(() => expect(details()?.worktreeSetup).toBeUndefined());
  expect(within(card).queryByText("Setup script failed")).toBeNull();
}, 30_000);

test("a Read-only thread's skipped setup says so in the Work card", async () => {
  const { app } = await open();
  app.daemon.workspace.setDetails(id, {
    worktreeSetup: { state: "skipped", reason: "read_only", details: [], at: 1 },
  });
  const card = await openWorkCard();
  expect(await within(card).findByText("Setup skipped: Read-only")).toBeTruthy();
  expect(within(card).queryByRole("button", { name: "Retry" })).toBeNull();
}, 30_000);

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
  await waitFor(() =>
    expect(details()).toMatchObject({ mode: "worktree", workspaceChange: { state: "applied" } }),
  );
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
  await waitFor(() => expect(details()).toMatchObject({ mode: "local" }));
  expect(details()?.worktreeMissing).toBeUndefined();
}, 60_000);

test("a worktree removed with its branch says so and offers only what can work", async () => {
  const { app, details } = await open();
  app.daemon.workspace.setDetails(id, {
    mode: "worktree",
    worktree: `/fake/worktrees/${id}`,
    branch: "ui/atmos",
    worktreeMissing: true,
    checkoutMissing: { kind: "worktree", branch: { name: "ui/atmos", state: "gone" } },
  });
  const card = await openWorkCard();
  const missing = await within(card).findByRole("group", {
    name: "Worktree and branch removed. ui/atmos was deleted too. A new worktree starts from main.",
  });
  // The branch's last sync state and the folder's actions would all be stale.
  expect(within(card).getByRole("group", { name: "Branch ui/atmos, deleted" })).toBeTruthy();
  expect(within(card).queryByText("Run a script")).toBeNull();
  expect(within(card).queryByText(/^Open in /)).toBeNull();
  expect(within(missing).queryByRole("button", { name: "Recreate worktree" })).toBeNull();
  await userEvent.click(within(missing).getByRole("button", { name: "New worktree" }));
  await waitFor(() => expect(details()?.checkoutMissing).toBeUndefined());
  expect(details()?.mode).toBe("worktree");
}, 60_000);
