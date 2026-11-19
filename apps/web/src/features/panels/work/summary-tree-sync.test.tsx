import type { Fact } from "@ace/core";
import { facts, nestedDelegation, nestedDelegationIds, type Scenario } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { gatedClient, memoryReadSnapshots, type Gate } from "@/test/gated-client.ts";
import { harness } from "@/test/harness.tsx";
import {
  agentRow,
  isBreathing,
  openWorkPanel,
  showFinished,
  summaryStatus,
} from "@/test/open-work.ts";

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
  const missing = await within(work).findByRole("treeitem", { name: /not loaded$/ });
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

/** A delegate in `parent`'s tree whose work is the thread `child`, which already finished. */
const delegated = (agent: string, child: string, name: string): Fact[] => [
  facts.tool("root", `delegate-${agent}`, {
    kind: "agent.spawn",
    title: `Delegate ${name}`,
    detail: { kind: "agent.spawn", prompt: name, agentType: "claude", childAgent: agent },
  }),
  {
    type: "agent.seen",
    agent,
    parent: "root",
    spawnedBy: `delegate-${agent}`,
    origin: "ace",
    fidelity: "full",
    native: { provider: "claude", nativeId: agent },
    cwd: "/Users/dev/acme",
    name,
  },
  { type: "agent.external", agent, threadId: ThreadId.parse(child), status: { state: "done" } },
];

/** A thread of the chain, and the delegate it hands its work to. */
interface ChainLink {
  id: string;
  parent: string | undefined;
  next: readonly [agent: string, child: string, name: string] | undefined;
}

/** Three threads, each delegating to the next, all of them finished. */
const chain: ChainLink[] = [
  { id: "thread-cold", parent: undefined, next: ["build", "thread-cold-build", "Cold build"] },
  {
    id: "thread-cold-build",
    parent: "thread-cold",
    next: ["check", "thread-cold-check", "Cold check"],
  },
  { id: "thread-cold-check", parent: "thread-cold-build", next: undefined },
];

const finishedChain = (): Scenario[] =>
  chain.map(({ id, parent, next }) => ({
    thread: {
      id,
      workspaceId: "acme",
      title: id,
      provider: "claude",
      ...(parent ? { parentThreadId: parent } : {}),
    },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("claude"),
          facts.turn("root"),
          ...(next ? delegated(next[0], next[1], next[2]) : []),
          facts.endTurn("root"),
        ],
      },
    ],
  }));

/** Six delegates that finished before the Summary opened, so a kept copy paints all six at once. */
const settledIds = Array.from({ length: 6 }, (_, index) => `thread-settled-${index}`);
const settledTree = (): Scenario[] => [
  {
    thread: {
      id: "thread-settled",
      workspaceId: "acme",
      title: "Settled delegates",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("claude"),
          facts.turn("root"),
          ...settledIds.flatMap((id, index) =>
            delegated(`settled-${index}`, id, `Settled ${index}`),
          ),
          facts.endTurn("root"),
        ],
      },
    ],
  },
  ...settledIds.map((id, index): Scenario => ({
    thread: {
      id,
      workspaceId: "acme",
      title: `Settled ${index}`,
      provider: "claude",
      parentThreadId: "thread-settled",
    },
    steps: [
      {
        kind: "facts",
        facts: [facts.rootAgent("claude"), facts.turn("root"), facts.endTurn("root")],
      },
    ],
  })),
];

test("a delegated thread whose first snapshot hasn't come is syncing: never done, and neither is anything above it", async () => {
  const gate: Gate = { held: false, queue: [], newWires: true };
  const app = harness({ client: (daemon) => gatedClient(daemon, memoryReadSnapshots(), gate) });
  for (const scenario of finishedChain()) app.play(scenario).runUntilBlocked();
  await app.open("/t/thread-cold");
  await screen.findByRole("heading", { level: 1, name: "thread-cold" });
  // Every delegated thread the Summary subscribes to from here on starts cold and held back.
  gate.held = true;
  const work = await openWorkPanel();
  const build = await agentRow(work, "Cold build");
  expect(build.getAttribute("aria-label")).toBe("Cold build: syncing");
  expect(isBreathing(build)).toBe(false);
  expect(await summaryStatus(work)).toBe("Syncing");

  // The build thread arrives; the check thread under it is still cold.
  act(() => {
    for (const deliver of gate.queue.splice(0)) deliver();
  });
  await waitFor(() => expect(build.getAttribute("aria-expanded")).toBe("false"));
  // Its own thread is confirmed, but something under it isn't: still not finished.
  expect(build.getAttribute("aria-label")).toBe("Cold build: syncing");
  expect(await summaryStatus(work)).toBe("Syncing");

  act(() => {
    gate.held = false;
    for (const deliver of gate.queue.splice(0)) deliver();
  });
  await waitFor(async () => expect(await summaryStatus(work)).toMatch(/^Done/));
  expect(build.getAttribute("aria-label")).not.toMatch(/syncing/);
});

test("facts settling from a kept copy fold at once: no finished row plays an exit", async () => {
  const gate: Gate = { held: false, queue: [], newWires: true };
  const app = harness({ client: (daemon) => gatedClient(daemon, memoryReadSnapshots(), gate) });
  for (const scenario of settledTree()) app.play(scenario).runUntilBlocked();
  await app.open("/t/thread-settled");
  let work = await openWorkPanel();
  // The first look confirms the delegates and folds them.
  await within(work).findByRole("treeitem", { name: "6 done" });

  // Closed, the Summary lets the delegated threads go; what the client keeps is unconfirmed.
  await closeSummary();
  gate.held = true;
  work = await openWorkPanel();
  expect((await agentRow(work, "Settled 0")).getAttribute("aria-label")).toBe("Settled 0: syncing");
  expect(within(work).queryByRole("treeitem", { name: "6 done" })).toBeNull();

  // The daemon confirms them: nothing finished while the person watched, so the fold shows at
  // once. No row fades out and the done line does not rise in.
  act(() => {
    gate.held = false;
    for (const deliver of gate.queue.splice(0)) deliver();
  });
  const done = await within(work).findByRole("treeitem", { name: "6 done" });
  expect(work.querySelector(".fx-fade-out")).toBeNull();
  expect(done.closest("li")?.className ?? "").not.toContain("fx-rise-in");
});

test("when the focused agent finishes and folds into the done line, focus moves to that line", async () => {
  const app = harness();
  app.play(fleet).runUntilBlocked();
  await app.open("/t/thread-fold");
  const work = await openWorkPanel();
  const root = await agentRow(work, "Claude Code");
  for (let step = 0; step < 80 && document.activeElement !== root; step++) await userEvent.tab();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(await agentRow(work, "Task 0"));

  act(() => app.daemon.apply("thread-fold", [facts.endTurn("s0")]));
  const done = await within(work).findByRole("treeitem", { name: "20 done" });
  await waitFor(() => expect(document.activeElement).toBe(done));
  expect(done.tabIndex).toBe(0);
  // The keys still work from there: → opens the line, ↓ reaches the agent that just finished.
  await userEvent.keyboard("{ArrowRight}{ArrowDown}");
  expect(document.activeElement).toBe(await agentRow(work, "Task 0"));
});

test("when the viewed thread's own subscription fails, the done it kept is not shown as current", async () => {
  const gate: Gate = { held: false, queue: [], subscriptions: new Map() };
  const app = harness({ client: (daemon) => gatedClient(daemon, memoryReadSnapshots(), gate) });
  for (const scenario of finishedChain()) app.play(scenario).runUntilBlocked();
  await app.open("/t/thread-cold-check");
  const work = await openWorkPanel();
  await waitFor(async () => expect(await summaryStatus(work)).toMatch(/^Done/));
  const subscriptionId = gate.subscriptions?.get("thread-cold-check");
  if (!subscriptionId || !gate.deliver) throw new Error("The thread's subscription never opened");
  const deliver = gate.deliver;
  act(() =>
    deliver(
      JSON.stringify({ type: "error", code: "internal", message: "Lost it", subscriptionId }),
    ),
  );
  // Its metadata still says done; nothing repeats that as fact. The thread says it couldn't be
  // opened and keeps no side panel, so no Summary is left to call it done.
  expect(await screen.findByRole("alert")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("tabpanel", { name: "Summary" })).toBeNull());
  expect(screen.queryByRole("status", { name: /^Thread status/ })).toBeNull();
});

/** Tab into the tree at its one stop, go Home, then ↓ until the row named `name` has focus. */
async function focusRow(work: HTMLElement, name: string) {
  const tree = await within(work).findByRole("tree", { name: "Agent tree" });
  for (let step = 0; step < 80 && !tree.contains(document.activeElement); step++)
    await userEvent.tab();
  await userEvent.keyboard("{Home}");
  const target = await agentRow(work, name);
  for (let step = 0; step < 40 && document.activeElement !== target; step++)
    await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(target);
}

test("when the focused agent finishes into an open done line, focus stays on its row there", async () => {
  const app = harness();
  app.play(fleet).runUntilBlocked();
  await app.open("/t/thread-fold");
  const work = await openWorkPanel();
  const done = await within(work).findByRole("treeitem", { name: "19 done" });
  await userEvent.click(done);
  expect(done.getAttribute("aria-expanded")).toBe("true");
  await focusRow(work, "Task 0");

  act(() => app.daemon.apply("thread-fold", [facts.endTurn("s0")]));
  await within(work).findByRole("treeitem", { name: "20 done" });
  // Its row now sits in the open line, a new element: the keyboard is still on it.
  await waitFor(async () => expect(document.activeElement).toBe(await agentRow(work, "Task 0")));
  expect((await agentRow(work, "Task 0")).tabIndex).toBe(0);
});

test("after the person clicks away from the tree, a row folding away never pulls focus back", async () => {
  const app = harness();
  app.play(fleet).runUntilBlocked();
  await app.open("/t/thread-fold");
  const work = await openWorkPanel();
  await focusRow(work, "Task 0");
  // A click on background that takes no focus: the row blurs with nowhere to go.
  await userEvent.click(document.body);
  expect(document.activeElement).toBe(document.body);

  act(() => app.daemon.apply("thread-fold", [facts.endTurn("s0")]));
  await within(work).findByRole("treeitem", { name: "20 done" });
  expect(document.activeElement).toBe(document.body);
});
