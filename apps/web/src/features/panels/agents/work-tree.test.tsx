import {
  coldStartReplay,
  delegatedDocs,
  delegatedDocsIds,
  facts,
  failingSubagent,
  type Scenario,
} from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("the agent tree shows subagents as they spawn and marks the one that fails", async () => {
  const app = harness();
  const script = app.play(failingSubagent());
  script.step();
  await app.open("/t/thread-settings");
  await screen.findByRole("heading", { level: 1, name: "Migrate settings schema" });

  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(within(panel).getByRole("tab", { name: "Summary", selected: true })).toBeTruthy();
  await within(panel).findByRole("treeitem", { name: "Main agent: Working" });
  expect(within(panel).queryByRole("treeitem", { name: /migration-tester/ })).toBeNull();

  await act(async () => script.runThrough("workers-spawned"));
  await within(panel).findByRole("treeitem", { name: "schema-writer: Working" });
  await within(panel).findByRole("treeitem", { name: "migration-tester: Working" });

  await act(async () => script.runThrough("tester-failed"));
  const failed = await within(panel).findByRole("treeitem", { name: "migration-tester: Failed" });
  expect(within(failed).getByText("Couldn't finish. Open the agent for details.")).toBeTruthy();
  expect(within(failed).queryByText(/Context window exceeded/)).toBeNull();
  expect(within(panel).getByRole("treeitem", { name: "schema-writer: Working" })).toBeTruthy();
  // Opening it shows it as the whole chat, its status bar saying how it ended.
  await userEvent.click(failed);
  await screen.findByRole("heading", { level: 1, name: "migration-tester" });
  const bar = screen.getByRole("group", { name: "Subagent" });
  expect(within(bar).getByText(/^Failed/)).toBeTruthy();
});

test("the Summary tree shows what each agent is doing, the background shell, and why the thread isn't done", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });

  const root = await within(panel).findByRole("treeitem", {
    name: "Main agent: Waiting on subagents",
  });
  expect(within(root).getByText("Claude Code")).toBeTruthy();
  expect(within(root).getByText("waiting for subagents")).toBeTruthy();
  const audit = within(panel).getByRole("treeitem", { name: "resume-sweep: Working" });
  // Its running browser call is what it is doing (the Preview tab names it as the driver).
  expect(within(audit).getByText("Pair a phone on localhost:5173/settings/devices")).toBeTruthy();
  const tester = within(panel).getByRole("treeitem", { name: "ack-buffer-test: Working" });
  expect(within(tester).getByText("Run the outbox tests")).toBeTruthy();

  expect(
    within(panel).getByRole("listitem", { name: "bun run relay:soak --clients 2: running" }),
  ).toBeTruthy();
  expect(within(panel).queryByRole("region", { name: "Why isn't this done?" })).toBeNull();
});

test("Stop ends a background shell, and the thread settles once nothing else is running", async () => {
  const app = harness();
  const script = app.play(coldStartReplay());
  script.runThrough("root-replied");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  const shell = within(panel).getByRole("listitem", {
    name: "bun run relay:soak --clients 2: running",
  });
  await userEvent.click(within(shell).getByRole("button", { name: "Stop" }));
  // Once stopped it leaves the panel, which lists only what is still running.
  await within(panel).findByRole("treeitem", { name: "Main agent: Idle" });
  expect(within(panel).queryByRole("listitem", { name: /^bun run relay:soak/ })).toBeNull();
  expect(within(panel).queryByRole("button", { name: "Stop" })).toBeNull();
  expect(within(panel).queryByText(/The thread settles when/)).toBeNull();
});

test("Stop on a subagent interrupts only that subagent", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  const audit = await within(panel).findByRole("treeitem", { name: "resume-sweep: Working" });
  await userEvent.hover(audit);
  await userEvent.click(within(panel).getByRole("button", { name: "Stop resume-sweep" }));
  await within(panel).findByRole("treeitem", { name: "resume-sweep: Interrupted" });
  expect(within(panel).getByRole("treeitem", { name: "ack-buffer-test: Working" })).toBeTruthy();
  expect(within(panel).queryByRole("region", { name: "Why isn't this done?" })).toBeNull();
});

test("a message queued in the composer shows in the Agents tab without extra explanatory prose", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole("treeitem", { name: "Main agent: Waiting on subagents" });
  // Each agent row carries its provider.
  const audit = within(panel).getByRole("treeitem", { name: "resume-sweep: Working" });
  expect(within(audit).getByRole("img", { name: "Claude Code" })).toBeTruthy();
  expect(within(panel).queryByRole("listitem", { name: /queued message/ })).toBeNull();

  await userEvent.type(
    screen.getByRole("combobox", { name: "Message" }),
    "Also check the iOS cold-start path{Enter}",
  );

  // The pill above the composer and the Agents tab read the same queue.
  expect(await screen.findByRole("list", { name: "Queued messages" })).toBeTruthy();
  expect(
    await within(panel).findByRole("listitem", { name: "1 queued message: waiting for the agent" }),
  ).toBeTruthy();
  expect(within(panel).queryByRole("region", { name: "Why isn't this done?" })).toBeNull();
});

async function openAgents(app: ReturnType<typeof harness>, path: string) {
  await app.open(path);
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  return screen.findByRole("region", { name: "Thread panel" });
}

test("an agent ace delegated opens its own thread from the tree", async () => {
  const app = harness();
  for (const scenario of delegatedDocs()) app.play(scenario).runUntilBlocked();
  const panel = await openAgents(app, `/t/${delegatedDocsIds.parent}`);
  await userEvent.click(await within(panel).findByRole("treeitem", { name: /^protocol-docs:/ }));
  await screen.findByRole("heading", { level: 1, name: "Relay protocol reference" });
  expect(screen.getByRole("link", { name: "Relay docs for 0.9" })).toBeTruthy();
});

test("the agent tree is one Tab stop: arrows move and fold, Enter opens an agent, S reaches its Stop", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  const tree = await within(panel).findByRole("tree", { name: "Agent tree" });
  const root = within(tree).getByRole("treeitem", { name: /^Main agent/ });
  expect(root.getAttribute("aria-expanded")).toBe("true");
  expect(
    within(tree)
      .getAllByRole("treeitem")
      .filter((item) => item.tabIndex === 0),
  ).toEqual([root]);

  root.focus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(root.getAttribute("aria-expanded")).toBe("false");
  expect(within(tree).queryByRole("treeitem", { name: /^resume-sweep/ })).toBeNull();
  await userEvent.keyboard("{ArrowRight}{ArrowDown}");
  const sweep = within(tree).getByRole("treeitem", { name: /^resume-sweep/ });
  expect(document.activeElement).toBe(sweep);
  expect(sweep.getAttribute("aria-level")).toBe("2");

  await userEvent.keyboard("s");
  expect(document.activeElement).toBe(
    within(panel).getByRole("button", { name: "Stop resume-sweep" }),
  );
  await userEvent.keyboard("{Escape}");
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

test("a click on a nested agent's chevron folds its subagents without opening it; the rest of the row opens it", async () => {
  const app = harness();
  app.play(nested).runUntilBlocked();
  const panel = await openAgents(app, "/t/thread-nested");
  const sweep = await within(panel).findByRole("treeitem", { name: /^resume-sweep:/ });
  expect(sweep.getAttribute("aria-expanded")).toBe("true");
  // The chevron is a pointer target only (the row folds with ← → from the keyboard).
  const chevron = sweep.querySelector("[data-capsule-fold]");
  if (!(chevron instanceof HTMLElement)) throw new Error("No chevron on a row with subagents");
  await userEvent.click(chevron);
  expect(sweep.getAttribute("aria-expanded")).toBe("false");
  expect(within(panel).queryByRole("treeitem", { name: /^web-probe:/ })).toBeNull();
  // Folding opened nothing: the thread is still the chat.
  expect(screen.getByRole("heading", { level: 1, name: "Sweep the resume callers" })).toBeTruthy();
  await userEvent.click(chevron);
  expect(await within(panel).findByRole("treeitem", { name: /^web-probe:/ })).toBeTruthy();

  await userEvent.click(within(sweep).getByText("resume-sweep"));
  expect(await screen.findByRole("heading", { level: 1, name: "resume-sweep" })).toBeTruthy();
});

test("Stop on an agent with subagents says how many go with it and asks first", async () => {
  const app = harness();
  app.play(nested).runUntilBlocked();
  const panel = await openAgents(app, "/t/thread-nested");
  await userEvent.click(await within(panel).findByRole("treeitem", { name: /^resume-sweep:/ }));
  await screen.findByRole("heading", { level: 1, name: "resume-sweep" });
  const bar = screen.getByRole("group", { name: "Subagent" });
  const stop = within(bar).getByRole("button", { name: "Stop resume-sweep and its 1 subagent" });
  await userEvent.click(stop);
  const ask = await screen.findByRole("dialog", { name: "Stop resume-sweep and its 1 subagent?" });
  await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(await within(bar).findByRole("button", { name: /^Stop resume-sweep/ })).toBeTruthy();

  await userEvent.click(within(bar).getByRole("button", { name: /^Stop resume-sweep/ }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: /^Stop resume-sweep/ })).getByRole("button", {
      name: "Stop all",
    }),
  );
  expect(await within(bar).findByText(/^Stopped after/)).toBeTruthy();
  // Its subagent stopped with it.
  const tree = await screen.findByRole("region", { name: "Thread panel" });
  expect(
    await within(tree).findByRole("treeitem", { name: "resume-sweep: Interrupted" }),
  ).toBeTruthy();
  expect(
    await within(tree).findByRole("treeitem", { name: "web-probe: Interrupted" }),
  ).toBeTruthy();
});

test("in the tree, Stop on an agent with subagents asks the same question, and a row owns its subagents", async () => {
  const app = harness();
  app.play(nested).runUntilBlocked();
  const panel = await openAgents(app, "/t/thread-nested");
  const sweep = await within(panel).findByRole("treeitem", { name: /^resume-sweep:/ });
  // The row owns the group its subagents are in.
  const group = document.getElementById(sweep.getAttribute("aria-owns") ?? "");
  expect(group?.getAttribute("role")).toBe("group");
  expect(within(group as HTMLElement).getByRole("treeitem", { name: /^web-probe:/ })).toBeTruthy();

  sweep.focus();
  await userEvent.keyboard("s");
  await userEvent.keyboard("{Enter}");
  const ask = await screen.findByRole("dialog", { name: "Stop resume-sweep and its 1 subagent?" });
  await userEvent.click(within(ask).getByRole("button", { name: "Stop all" }));
  expect(
    await within(panel).findByRole("treeitem", { name: "web-probe: Interrupted" }),
  ).toBeTruthy();
  expect(within(panel).getByRole("treeitem", { name: "resume-sweep: Interrupted" })).toBeTruthy();
});
