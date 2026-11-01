import { facts, nestedDelegation, nestedDelegationIds, type Scenario } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { gatedClient, memoryReadSnapshots, type Gate } from "@/test/gated-client.ts";
import { harness } from "@/test/harness.tsx";
import { agentRow, isBreathing, openWorkPanel, showFinished } from "@/test/open-work.ts";

/*
 * The Summary's tree across threads when a delegated thread's facts aren't current (AGENTS.md
 * priority 1), when the client has no room for it, and when many siblings finished.
 */

beforeEach(() => localStorage.clear());

const shellRow = "Rail-shell-web-sidebar";

async function closeSummary() {
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  await waitFor(() => expect(screen.queryByRole("tabpanel", { name: "Summary" })).toBeNull());
}

test("a delegated branch whose facts aren't confirmed reads as syncing, never finished, and holds still", async () => {
  const gate: Gate = { held: false, queue: [], newWires: true };
  const app = harness({ client: (daemon) => gatedClient(daemon, memoryReadSnapshots(), gate) });
  for (const scenario of nestedDelegation()) app.play(scenario).runUntilBlocked();
  await app.open(`/t/${nestedDelegationIds.parent}`);
  let work = await openWorkPanel();
  await userEvent.click(await within(work).findByRole("treeitem", { name: "2 done" }));
  expect((await agentRow(work, shellRow)).getAttribute("aria-label")).toMatch(/: finished/);

  // Closed, the Summary lets the delegated threads go; what the client keeps is unconfirmed.
  await closeSummary();
  gate.held = true;
  work = await openWorkPanel();
  const shell = await agentRow(work, shellRow);
  expect(shell.getAttribute("aria-label")).toBe(`${shellRow}: syncing`);
  expect(isBreathing(shell)).toBe(false);
  // Unconfirmed, it never folds into the finished line either.
  expect(within(work).queryByRole("treeitem", { name: "2 done" })).toBeNull();

  // Once the daemon confirms it, it reads finished again.
  act(() => {
    gate.held = false;
    for (const deliver of gate.queue.splice(0)) deliver();
  });
  await waitFor(() => expect(within(work).getByRole("treeitem", { name: "2 done" })).toBeTruthy());
});

test("a delegated thread gives its room to threads the person opens, shows not loaded, and loads once room frees", async () => {
  const app = harness({
    client: (daemon) =>
      gatedClient(daemon, memoryReadSnapshots(), undefined, { threads: 8, threadReserve: 2 }),
  });
  for (const scenario of nestedDelegation()) app.play(scenario).runUntilBlocked();
  await app.open(`/t/${nestedDelegationIds.parent}`);
  const work = await openWorkPanel();
  await agentRow(work, "Check daemon search limits");
  expect(within(work).queryByRole("treeitem", { name: /not loaded/ })).toBeNull();

  // The person opens other threads until the client is full: a delegated thread gives way.
  const opened: ReturnType<typeof app.client.thread>[] = [];
  for (let index = 0; index < 12; index++) {
    const id = `thread-open-${index}`;
    app.daemon.createThread({ id, workspaceId: "acme", title: `Open ${index}`, provider: "codex" });
    act(() => void opened.push(app.client.thread(id)));
    if (within(work).queryByRole("treeitem", { name: /not loaded/ })) break;
  }
  const missing = await within(work).findByRole("treeitem", { name: /: .* · not loaded$/ });
  const name = (missing.getAttribute("aria-label") ?? "").split(":")[0] ?? "";
  expect(missing.getAttribute("aria-expanded")).toBeNull();
  for (const lease of opened) expect(lease.store.error).toBeUndefined();

  // They close: there is room again, and the delegated thread comes back without a reopen.
  act(() => {
    for (const lease of opened.splice(0)) lease.release();
  });
  await waitFor(() =>
    expect(within(work).queryByRole("treeitem", { name: /not loaded/ })).toBeNull(),
  );
  // Back with its thread's facts, whether it now shows on its own or among the finished.
  await showFinished(work);
  expect((await agentRow(work, name)).getAttribute("aria-expanded")).not.toBeNull();
});

const spawn = (index: number): Scenario["steps"][number] => ({
  kind: "facts",
  facts: [
    facts.tool("root", `spawn-${index}`, {
      kind: "agent.spawn",
      title: `Task ${index}`,
      detail: { kind: "agent.spawn", description: `Task ${index}`, childAgent: `s${index}` },
    }),
    facts.subagent("claude", `s${index}`, `Task ${index}`, `spawn-${index}`),
    facts.turn(`s${index}`, "spawn"),
    // Nine still work; nineteen finished.
    ...(index >= 9 ? [facts.endTurn(`s${index}`)] : []),
  ],
});

const fleet: Scenario = {
  thread: { id: "thread-fold", workspaceId: "relay", title: "Many subagents", provider: "claude" },
  steps: [
    { kind: "facts", facts: [facts.rootAgent("claude"), facts.turn("root")] },
    ...Array.from({ length: 28 }, (_, index) => spawn(index)),
  ],
};

test("nineteen finished siblings fold into one 19 done line below the live ones, which opens in place and stays open", async () => {
  const app = harness();
  app.play(fleet).runUntilBlocked();
  await app.open("/t/thread-fold");
  const work = await openWorkPanel();
  const tree = await within(work).findByRole("tree", { name: "Agent tree" });
  const done = await within(tree).findByRole("treeitem", { name: "19 done" });
  const rows = within(tree).getAllByRole("treeitem");
  // The main agent, its nine working subagents, then the one line for the finished.
  expect(rows).toHaveLength(11);
  expect(rows.at(-1)).toBe(done);
  expect(within(tree).queryByRole("treeitem", { name: /^Task 20:/ })).toBeNull();

  await userEvent.click(done);
  expect(await agentRow(work, "Task 20")).toBeTruthy();
  expect(within(tree).getAllByRole("treeitem")).toHaveLength(30);

  await closeSummary();
  const again = await openWorkPanel();
  expect(
    (await within(again).findByRole("treeitem", { name: "19 done" })).getAttribute("aria-expanded"),
  ).toBe("true");
  expect(await agentRow(again, "Task 20")).toBeTruthy();
});
