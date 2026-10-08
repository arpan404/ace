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
  expect(within(panel).getByRole("tab", { name: "Agents", selected: true })).toBeTruthy();
  await within(panel).findByRole("treeitem", { name: "Main agent: Working" });
  expect(within(panel).queryByRole("treeitem", { name: /migration-tester/ })).toBeNull();

  await act(async () => script.runThrough("workers-spawned"));
  await within(panel).findByRole("treeitem", { name: "schema-writer: Working" });
  await within(panel).findByRole("treeitem", { name: "migration-tester: Working" });

  await act(async () => script.runThrough("tester-failed"));
  const failed = await within(panel).findByRole("treeitem", { name: "migration-tester: Failed" });
  expect(within(failed).getByText(/Context window exceeded/)).toBeTruthy();
  expect(within(panel).getByRole("treeitem", { name: "schema-writer: Working" })).toBeTruthy();
});

test("the Agents tab shows what each agent is doing, the background shell, and why the thread isn't done", async () => {
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
  expect(within(panel).getByRole("region", { name: "Why isn't this done?" }).textContent).toContain(
    "Two subagents are still running and one background shell is open.",
  );
});

test("Stop ends a background shell, and the thread settles once nothing else is running", async () => {
  const app = harness();
  const script = app.play(coldStartReplay());
  script.runThrough("root-replied");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  const why = await within(panel).findByRole("region", { name: "Why isn't this done?" });
  expect(why.textContent).toContain(
    "One background shell is open. The thread settles when the shell is stopped or finishes.",
  );

  const shell = within(panel).getByRole("listitem", {
    name: "bun run relay:soak --clients 2: running",
  });
  await userEvent.click(within(shell).getByRole("button", { name: "Stop" }));
  // Once stopped it leaves the panel, which lists only what is still running.
  const done = await within(panel).findByRole("region", { name: "Done" });
  expect(within(panel).queryByRole("listitem", { name: /^bun run relay:soak/ })).toBeNull();
  expect(within(panel).queryByRole("button", { name: "Stop" })).toBeNull();
  expect(done.textContent).toContain("Every agent has finished");
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
  expect(within(panel).getByRole("region", { name: "Why isn't this done?" }).textContent).toContain(
    "One subagent is still running",
  );
});

test("a message queued in the composer shows in the Agents tab and in why the thread isn't done", async () => {
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
  expect(within(panel).getByRole("region", { name: "Why isn't this done?" }).textContent).toContain(
    "a queued message has not been sent yet",
  );
});

async function openAgents(app: ReturnType<typeof harness>, path: string) {
  await app.open(path);
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  return screen.findByRole("region", { name: "Thread panel" });
}

test("a subagent opens as its own tab: who started it, what it was asked, and only its own work", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("audit-done");
  const panel = await openAgents(app, "/t/thread-cold-start");
  expect(within(panel).getByRole("status").textContent).toBe("1 active · 1 done");

  await userEvent.click(await within(panel).findByRole("treeitem", { name: /^resume-sweep:/ }));
  expect(within(panel).getByRole("tab", { name: "resume-sweep", selected: true })).toBeTruthy();
  const delegation = await within(panel).findByRole("region", { name: "Delegation" });
  expect(delegation.textContent).toContain(
    "Claude Code started it with Claude Code's own subagent tool.",
  );
  expect(delegation.textContent).toContain("Sweep the web and mobile resume callers");

  const transcript = within(panel).getByRole("feed", { name: "Agent transcript" });
  expect(within(transcript).getByText(/Three callers resume from seq 0/)).toBeTruthy();
  // The parent's own answer stays in the conversation.
  expect(within(transcript).queryByText(/replayFrom now treats seq 0/)).toBeNull();

  // A provider's own subagent can't be messaged directly; the composer says where to ask.
  const box = within(panel).getByRole("combobox", { name: "Message resume-sweep" });
  expect(box.hasAttribute("disabled")).toBe(true);
  expect(document.getElementById(box.getAttribute("aria-describedby") ?? "")?.textContent).toMatch(
    /take instructions only from the agent that started them/,
  );

  await userEvent.click(within(panel).getByRole("button", { name: /Back to agents/ }));
  expect(within(panel).getByRole("tab", { name: "Agents", selected: true })).toBeTruthy();
  // The agent's tab stays open beside the tree.
  expect(within(panel).getByRole("tab", { name: "resume-sweep" })).toBeTruthy();
});

test("an agent ace delegated shows its own thread and takes a follow-up there", async () => {
  const app = harness();
  for (const scenario of delegatedDocs()) app.play(scenario).runUntilBlocked();
  const panel = await openAgents(app, `/t/${delegatedDocsIds.parent}`);
  await userEvent.click(await within(panel).findByRole("treeitem", { name: /^protocol-docs:/ }));

  const delegation = await within(panel).findByRole("region", { name: "Delegation" });
  expect(delegation.textContent).toContain("delegated it through ace, as a thread of its own");
  expect(delegation.textContent).toContain("Write docs/protocol/relay.md from the wire schemas");
  const transcript = await within(panel).findByRole("feed", { name: "Agent transcript" });
  expect(within(transcript).getByText(/Drafted the frame table/)).toBeTruthy();

  // The thread composer's own shape: Enter sends.
  await userEvent.type(
    within(panel).getByRole("combobox", { name: "Message protocol-docs" }),
    "Add a table of close codes too.{Enter}",
  );
  // The child thread was settled, so the follow-up starts its next turn there.
  expect(await within(transcript).findByText("Add a table of close codes too.")).toBeTruthy();
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
  expect(within(panel).getByRole("tab", { name: "resume-sweep", selected: true })).toBeTruthy();
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

test("Stop on an agent with subagents says how many go with it and asks first", async () => {
  const app = harness();
  app.play(nested).runUntilBlocked();
  const panel = await openAgents(app, "/t/thread-nested");
  await userEvent.click(await within(panel).findByRole("treeitem", { name: /^resume-sweep:/ }));
  const stop = await within(panel).findByRole("button", {
    name: "Stop resume-sweep and its 1 subagent",
  });
  await userEvent.click(stop);
  const ask = await screen.findByRole("dialog", { name: "Stop resume-sweep and its 1 subagent?" });
  await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(await within(panel).findByRole("button", { name: /^Stop resume-sweep/ })).toBeTruthy();

  await userEvent.click(within(panel).getByRole("button", { name: /^Stop resume-sweep/ }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: /^Stop resume-sweep/ })).getByRole("button", {
      name: "Stop all",
    }),
  );
  await userEvent.click(within(panel).getByRole("button", { name: /Back to agents/ }));
  // Its subagent stopped with it.
  expect(
    await within(panel).findByRole("treeitem", { name: "resume-sweep: Interrupted" }),
  ).toBeTruthy();
  expect(
    await within(panel).findByRole("treeitem", { name: "web-probe: Interrupted" }),
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
