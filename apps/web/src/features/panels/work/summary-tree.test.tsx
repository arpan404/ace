import {
  coldStartReplay,
  delegatedDocs,
  delegatedDocsIds,
  facts,
  failingSubagent,
  nestedDelegation,
  nestedDelegationIds,
  nestedQuestion,
  type Scenario,
} from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { agentRow, isBreathing, openWorkPanel, summaryStatus } from "@/test/open-work.ts";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-reduce-motion");
});

async function openThread(app: ReturnType<typeof harness>, path: string) {
  await app.open(path);
  return openWorkPanel();
}

/** The rows directly inside a row's own group, by the order the tree shows them. */
const level = (row: HTMLElement) => Number(row.getAttribute("aria-level"));

async function openNested() {
  const app = harness();
  for (const scenario of nestedDelegation()) app.play(scenario).runUntilBlocked();
  return { app, work: await openThread(app, `/t/${nestedDelegationIds.parent}`) };
}

test("a delegated thread's own delegations and their subagents show under it, at every depth", async () => {
  const { work } = await openNested();
  const build = await agentRow(work, "Projects-inbox-overlay-panel");
  const review = await agentRow(work, "GPT review of the paging");
  const limits = await agentRow(work, "Check daemon search limits");
  const settings = await agentRow(work, "Settings › General row");
  expect([level(build), level(review), level(limits), level(settings)]).toEqual([2, 3, 4, 3]);
  // Each hangs in its parent's branch: the grandchild thread's subagent is inside the review's.
  expect(review.closest("li")?.contains(limits)).toBe(true);
  expect(build.closest("li")?.contains(review)).toBe(true);
  // The command the delegated thread started hangs under it too.
  const dev = within(work).getByRole("treeitem", {
    name: "$ bun run dev:fake --port 5394: running",
  });
  expect(build.closest("li")?.contains(dev)).toBe(true);
  expect(await summaryStatus(work)).toMatch(/^Working/);
});

test("every row above a great-grandchild that still works stays live, never done", async () => {
  const { app, work } = await openNested();
  const limits = await agentRow(work, "Check daemon search limits");
  // Everything else in the chain stops: only the great-grandchild still runs.
  act(() => {
    app.daemon.apply(nestedDelegationIds.build, [
      facts.endTurn("settings"),
      { type: "background.ended", task: "dev", status: "stopped" },
      facts.endTurn("root"),
    ]);
    app.daemon.apply(nestedDelegationIds.review, [facts.endTurn("root")]);
    app.daemon.apply(nestedDelegationIds.parent, [facts.endTurn("root")]);
  });
  await waitFor(async () =>
    expect(isBreathing(await agentRow(work, "Settings › General row"))).toBe(false),
  );
  expect(isBreathing(limits)).toBe(true);
  for (const name of ["Claude Code", "Projects-inbox-overlay-panel", "GPT review of the paging"]) {
    const row = await agentRow(work, name);
    expect(isBreathing(row)).toBe(true);
    expect(row.getAttribute("aria-label")).not.toMatch(/: finished/);
  }
  expect(await summaryStatus(work)).not.toMatch(/^Done/);
});

test("a finished branch folds to one line saying what is inside, and the person's fold sticks", async () => {
  const { work } = await openNested();
  // The two finished siblings share one "2 done" line; opened, each shows its own row.
  await userEvent.click(within(work).getByRole("treeitem", { name: "2 done" }));
  const shell = await agentRow(work, "Rail-shell-web-sidebar");
  expect(shell.getAttribute("aria-expanded")).toBe("false");
  expect(shell.getAttribute("aria-label")).toMatch(/ · 1 done$/);
  expect(within(work).queryByRole("treeitem", { name: /^Find the sidebar frame:/ })).toBeNull();
  const caret = shell.querySelector("[data-caret]");
  if (!(caret instanceof HTMLElement)) throw new Error("No caret on a row with children");
  await userEvent.click(caret);
  expect(await agentRow(work, "Find the sidebar frame")).toBeTruthy();
  // A live branch is open until the person folds it; their fold outlives a tab switch.
  const build = await agentRow(work, "Projects-inbox-overlay-panel");
  build.focus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(build.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  const again = await openWorkPanel();
  expect(
    (await agentRow(again, "Projects-inbox-overlay-panel")).getAttribute("aria-expanded"),
  ).toBe("false");
  expect((await agentRow(again, "Rail-shell-web-sidebar")).getAttribute("aria-expanded")).toBe(
    "true",
  );
});

test("Now names the agent four threads down that needs the person, and Open goes to it", async () => {
  const { app, work } = await openNested();
  await agentRow(work, "Check daemon search limits");
  act(() => app.daemon.apply(nestedDelegationIds.review, [nestedQuestion()]));
  const status = await within(work).findByRole("status", {
    name: "Thread status: Check daemon search limits needs your answer",
  });
  expect(status.getAttribute("data-tone")).toBe("needs-you");
  expect(within(work).getByText(/^Asks: Keep 3 days as the default\?/)).toBeTruthy();
  const row = await agentRow(work, "Check daemon search limits");
  expect(row.getAttribute("aria-label")).toBe(
    "Check daemon search limits: asks: Keep 3 days as the default?",
  );
  await userEvent.click(
    within(work).getByRole("button", { name: "Open Check daemon search limits" }),
  );
  expect(
    await screen.findByRole("heading", { level: 1, name: "Check daemon search limits" }),
  ).toBeTruthy();
});

test("with reduced motion the live marks hold still", async () => {
  const { work } = await openNested();
  const limits = await agentRow(work, "Check daemon search limits");
  expect(isBreathing(limits)).toBe(true);
  act(() => document.documentElement.setAttribute("data-reduce-motion", ""));
  await waitFor(() => expect(isBreathing(limits)).toBe(false));
  expect(work.querySelector("[data-breathing]")).toBeNull();
});

test("the tree shows subagents as they spawn and the one that fails in red", async () => {
  const app = harness();
  const script = app.play(failingSubagent());
  script.step();
  const work = await openThread(app, "/t/thread-settings");
  expect(within(work).queryByRole("tree")).toBeNull();
  await act(async () => script.runThrough("workers-spawned"));
  expect(isBreathing(await agentRow(work, "schema-writer"))).toBe(true);
  expect(isBreathing(await agentRow(work, "migration-tester"))).toBe(true);
  await act(async () => script.runThrough("tester-failed"));
  await waitFor(async () =>
    expect(isBreathing(await agentRow(work, "migration-tester"))).toBe(false),
  );
  const failed = await agentRow(work, "migration-tester");
  expect(failed.querySelector("[data-tone=failed]")).toBeTruthy();
  expect(failed.textContent).not.toMatch(/Context window exceeded/);
  await waitFor(async () =>
    expect(within(work).getByText(/^1 agent working · 1 done$/)).toBeTruthy(),
  );
  await userEvent.click(failed);
  await screen.findByRole("heading", { level: 1, name: "migration-tester" });
  expect(within(screen.getByRole("group", { name: "Subagent" })).getByText(/^Failed/)).toBeTruthy();
});

test("each row says what its agent is doing, and a running command shows under its agent", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  const work = await openThread(app, "/t/thread-cold-start");
  const audit = await agentRow(work, "resume-sweep");
  expect(audit.getAttribute("aria-label")).toBe(
    "resume-sweep: Pair a phone on localhost:5173/settings/devices",
  );
  expect((await agentRow(work, "ack-buffer-test")).getAttribute("aria-label")).toBe(
    "ack-buffer-test: running bun run test outbox",
  );
  expect(
    within(work).getByRole("treeitem", { name: "$ bun run relay:soak --clients 2: running" }),
  ).toBeTruthy();
});

test("Stop ends a background command, and the thread settles once nothing else runs", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("root-replied");
  const work = await openThread(app, "/t/thread-cold-start");
  const shell = await within(work).findByRole("treeitem", {
    name: "$ bun run relay:soak --clients 2: running",
  });
  await userEvent.click(
    within(shell.parentElement as HTMLElement).getByRole("button", { name: "Stop" }),
  );
  await waitFor(async () => expect(await summaryStatus(work)).toMatch(/^Done/));
  expect(within(work).queryByRole("treeitem", { name: /^\$ bun run relay:soak/ })).toBeNull();
  expect(within(work).queryByRole("button", { name: "Stop" })).toBeNull();
});

test("Stop on a subagent interrupts only that subagent", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  const work = await openThread(app, "/t/thread-cold-start");
  await agentRow(work, "resume-sweep");
  await userEvent.click(within(work).getByRole("button", { name: "Stop resume-sweep" }));
  await waitFor(async () => expect(isBreathing(await agentRow(work, "resume-sweep"))).toBe(false));
  expect(isBreathing(await agentRow(work, "ack-buffer-test"))).toBe(true);
});

test("a message queued in the composer reads under Now", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  const work = await openThread(app, "/t/thread-cold-start");
  await agentRow(work, "resume-sweep");
  expect(within(work).queryByText(/queued message/)).toBeNull();
  // The main agent only waits, so Enter would send now: ⌘↵ queues it instead.
  await userEvent.type(
    screen.getByRole("combobox", { name: "Message" }),
    "Also check the iOS cold-start path{Meta>}{Enter}{/Meta}",
  );
  expect(await screen.findByRole("list", { name: "Queued messages" })).toBeTruthy();
  expect(
    await within(work).findByText("1 queued message · sends when the agent is free"),
  ).toBeTruthy();
});

test("an agent ace delegated opens its own thread from the tree", async () => {
  const app = harness();
  for (const scenario of delegatedDocs()) app.play(scenario).runUntilBlocked();
  const work = await openThread(app, `/t/${delegatedDocsIds.parent}`);
  await userEvent.click(await agentRow(work, "protocol-docs"));
  await screen.findByRole("heading", { level: 1, name: "Relay protocol reference" });
  expect(screen.getByRole("link", { name: "Relay docs for 0.9" })).toBeTruthy();
});

test("the agent tree is one Tab stop: arrows move and fold, Enter opens an agent, S reaches its Stop and Escape or ← come back", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  const work = await openThread(app, "/t/thread-cold-start");
  const tree = await within(work).findByRole("tree", { name: "Agent tree" });
  const root = await agentRow(work, "Claude Code");
  expect(root.getAttribute("aria-expanded")).toBe("true");
  expect(
    within(tree)
      .getAllByRole("treeitem")
      .filter((item) => item.tabIndex === 0),
  ).toEqual([root]);
  // Reach the tree's one Tab stop by keyboard.
  for (let step = 0; step < 80 && document.activeElement !== root; step++) await userEvent.tab();
  expect(document.activeElement).toBe(root);
  await userEvent.keyboard("{ArrowLeft}");
  expect(root.getAttribute("aria-expanded")).toBe("false");
  expect(within(tree).queryByRole("treeitem", { name: /^resume-sweep/ })).toBeNull();
  await userEvent.keyboard("{ArrowRight}{ArrowDown}");
  const sweep = await agentRow(work, "resume-sweep");
  expect(document.activeElement).toBe(sweep);
  expect(sweep.getAttribute("aria-level")).toBe("2");
  const stop = within(work).getByRole("button", { name: "Stop resume-sweep" });
  await userEvent.keyboard("s");
  expect(document.activeElement).toBe(stop);
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(sweep);
  await userEvent.keyboard("S");
  expect(document.activeElement).toBe(stop);
  await userEvent.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(sweep);
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("heading", { level: 1, name: "resume-sweep" });
});

const spawn = (agent: string, item: string, child: string) =>
  facts.tool(agent, item, {
    kind: "agent.spawn",
    title: `Start ${child}`,
    detail: { kind: "agent.spawn", description: `Start ${child}`, childAgent: child },
  });

const nested: Scenario = {
  thread: {
    id: "thread-nested",
    workspaceId: "relay",
    title: "Sweep the resume callers",
    provider: "claude",
  },
  steps: [
    {
      kind: "facts",
      facts: [
        facts.rootAgent("claude"),
        facts.turn("root"),
        spawn("root", "spawn-audit", "audit"),
        facts.subagent("claude", "audit", "resume-sweep", "spawn-audit"),
        facts.turn("audit", "spawn"),
        spawn("audit", "spawn-probe", "probe"),
        facts.subagent("claude", "probe", "web-probe", "spawn-probe", { parent: "audit" }),
        facts.turn("probe", "spawn"),
      ],
    },
  ],
};

test("a click on a row's caret folds its children without opening it; the rest of the row opens it", async () => {
  const app = harness();
  app.play(nested).runUntilBlocked();
  const work = await openThread(app, "/t/thread-nested");
  const sweep = await agentRow(work, "resume-sweep");
  expect(sweep.getAttribute("aria-expanded")).toBe("true");
  const caret = sweep.querySelector("[data-caret]");
  if (!(caret instanceof HTMLElement)) throw new Error("No caret on a row with subagents");
  await userEvent.click(caret);
  expect(sweep.getAttribute("aria-expanded")).toBe("false");
  expect(within(work).queryByRole("treeitem", { name: /^web-probe:/ })).toBeNull();
  // Folding opened nothing: the thread is still the chat.
  expect(screen.getByRole("heading", { level: 1, name: "Sweep the resume callers" })).toBeTruthy();
  await userEvent.click(caret);
  expect(await agentRow(work, "web-probe")).toBeTruthy();
  await userEvent.click(within(sweep).getByText("resume-sweep"));
  expect(await screen.findByRole("heading", { level: 1, name: "resume-sweep" })).toBeTruthy();
});

test("Stop on an agent with subagents in the tree says how many go with it and asks first", async () => {
  const app = harness();
  app.play(nested).runUntilBlocked();
  const work = await openThread(app, "/t/thread-nested");
  const sweep = await agentRow(work, "resume-sweep");
  sweep.focus();
  await userEvent.keyboard("s");
  await userEvent.keyboard("{Enter}");
  const ask = await screen.findByRole("dialog", { name: "Stop resume-sweep and its 1 subagent?" });
  await waitFor(() =>
    expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Cancel" })),
  );
  await userEvent.click(within(ask).getByRole("button", { name: "Stop all" }));
  // Both stopped: the branch settles and folds to say what it holds.
  await waitFor(async () =>
    expect((await agentRow(work, "resume-sweep")).getAttribute("aria-label")).toMatch(/ · 1 done$/),
  );
  expect(isBreathing(await agentRow(work, "resume-sweep"))).toBe(false);
});
