import { facts, workCardScenario } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openDoneAgents, openWorkPanel, summaryStatus } from "@/test/open-work.ts";

beforeEach(() => localStorage.clear());
async function open() {
  const app = harness();
  const scenario = workCardScenario("changes");
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${scenario.thread.id}`);
  return { app, scenario, work: await openWorkPanel() };
}

test("opening the panel defaults to Summary with agents and automations, the checkout left to the details card", async () => {
  const app = harness();
  const scenario = workCardScenario("changes");
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${scenario.thread.id}`);
  await userEvent.click(await screen.findByRole("button", { name: "Right panel" }));
  const work = await screen.findByRole("tabpanel", { name: "Summary" });
  expect(screen.getByRole("tab", { name: "Summary", selected: true })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Agents" })).toBeNull();
  expect(screen.getAllByRole("tab")[0]?.textContent).toBe("Summary");
  expect(await within(work).findByRole("tree", { name: "Agent tree" })).toBeTruthy();
  expect(within(work).getByRole("button", { name: "Show bun run dev output" })).toBeTruthy();
  expect(within(work).getByRole("button", { name: "Stop" })).toBeTruthy();
  expect(within(work).queryByRole("button", { name: /^Branch / })).toBeNull();
  expect(within(work).queryByRole("button", { name: "More git actions" })).toBeNull();
});

test("an idle thread shows its outcome, not the person's message, and no empty sections", async () => {
  const app = harness();
  const scenario = workCardScenario("worktree");
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${scenario.thread.id}`);
  const work = await openWorkPanel();
  expect(
    await within(work).findByText(/^Restarts now back off and stop after six attempts\./),
  ).toBeTruthy();
  expect(within(work).queryByText("Give the restart loop a retry budget.")).toBeNull();
  expect(await summaryStatus(work)).toMatch(/^Done · /);
  // One section needs no label; nothing says it is empty.
  expect(within(work).queryAllByRole("heading")).toHaveLength(0);
  expect(within(work).queryByRole("tree")).toBeNull();
  expect(within(work).queryByRole("region", { name: "Needs you" })).toBeNull();
  expect(within(work).queryByRole("region", { name: "Automations" })).toBeNull();
  expect(within(work).queryByText("No scheduled tasks")).toBeNull();
  // No narrating lines; the status line names what the thread runs on.
  expect(work.textContent).not.toMatch(/Working for|Nothing running/);
  expect(within(work).getByTitle(/^Codex/)).toBeTruthy();
});

test("a working tree says each agent's status once and folds the completed ones into N done", async () => {
  const { work } = await open();
  expect(await within(work).findByRole("heading", { name: "Working" })).toBeTruthy();
  expect(within(work).getByRole("region", { name: "Background" })).toBeTruthy();
  expect(within(work).queryByRole("treeitem", { name: "Read restart history: Idle" })).toBeNull();
  const tree = await openDoneAgents(work);
  const done = await within(tree).findByRole("treeitem", { name: "Read restart history: Idle" });
  expect(within(done).getAllByText("Completed")).toHaveLength(1);
  const working = within(work).getByRole("treeitem", { name: /^Check supervisor logs: / });
  expect(working.textContent).not.toMatch(/Completed|Needs you/);
});

test("the Automations section is left out when the project has none", async () => {
  const { work } = await open();
  await within(work).findByRole("tree", { name: "Agent tree" });
  expect(within(work).queryByRole("region", { name: "Automations" })).toBeNull();
  expect(within(work).queryByRole("button", { name: "Automation settings" })).toBeNull();
  expect(within(work).queryByText("No scheduled tasks")).toBeNull();
});

test("a background command row offers Stop and Open in terminal", async () => {
  const { work } = await open();
  const background = await within(work).findByRole("region", { name: "Background" });
  const row = within(background).getByRole("listitem", { name: /^Watch the restart tests: / });
  expect(within(row).getByRole("button", { name: "Stop" })).toBeTruthy();
  await userEvent.click(within(row).getByRole("button", { name: "Open in terminal" }));
  expect(await screen.findByRole("tab", { name: /^Watch/, selected: true })).toBeTruthy();
});

test("Needs you lists a pending question, Show takes it to the composer, and it goes once answered", async () => {
  const { app, scenario, work } = await open();
  expect(within(work).queryByRole("region", { name: "Needs you" })).toBeNull();
  act(() =>
    app.daemon.apply(scenario.thread.id, [
      {
        type: "interaction.opened",
        agent: "root",
        interaction: "scope-question",
        blocking: true,
        request: {
          kind: "question",
          questions: [
            {
              id: "scope",
              text: "Which cases?",
              multiSelect: false,
              allowOther: true,
              options: [],
            },
          ],
        },
      },
    ]),
  );
  const needs = await within(work).findByRole("region", { name: "Needs you" });
  const row = within(needs).getByRole("listitem", { name: "Which cases?" });
  await userEvent.click(within(row).getByRole("button", { name: "Show Which cases?" }));
  await waitFor(() =>
    expect(document.activeElement?.closest("[data-composer-strip]")).toBeTruthy(),
  );
  act(() =>
    app.daemon.apply(scenario.thread.id, [
      {
        type: "interaction.closed",
        interaction: "scope-question",
        state: "resolved",
        resolution: { kind: "question", answers: { scope: ["all"] } },
      },
    ]),
  );
  await waitFor(() => expect(within(work).queryByRole("region", { name: "Needs you" })).toBeNull());
});

test("Needs you lists a failed subagent with Open", async () => {
  const app = harness();
  const scenario = workCardScenario("failed");
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${scenario.thread.id}`);
  const work = await openWorkPanel();
  const needs = await within(work).findByRole("region", { name: "Needs you" });
  const row = within(needs).getByRole("listitem", { name: "Check supervisor logs failed" });
  expect(row.textContent).toContain("The test command failed. Check its output.");
  await userEvent.click(within(row).getByRole("button", { name: "Open Check supervisor logs" }));
  expect(
    await screen.findByRole("heading", { level: 1, name: "Check supervisor logs" }),
  ).toBeTruthy();
});

test.each(["completed", "interrupted"] as const)(
  "an %s parent stays waiting until its child finishes",
  async (outcome) => {
    const { app, scenario, work } = await open();
    act(() => app.daemon.apply(scenario.thread.id, [facts.endTurn("worker-0", outcome)]));
    await within(work).findByRole("treeitem", {
      name: /^Write retry tests: Waiting on (work|subagents|background task)$/,
    });
    expect(within(work).queryByRole("treeitem", { name: "Write retry tests: Idle" })).toBeNull();
    // Its branch still counts as one subagent running.
    expect(await summaryStatus(work)).toMatch(/ · 1 agent running/);
    act(() => app.daemon.apply(scenario.thread.id, [facts.endTurn("worker-1")]));
    await within(await openDoneAgents(work)).findByRole("treeitem", {
      name: `Write retry tests: ${outcome === "completed" ? "Idle" : "Interrupted"}`,
    });
  },
);

test("an idle main agent keeps waiting while an ambient command is running, then settles after Stop", async () => {
  const { app, scenario, work } = await open();
  act(() =>
    app.daemon.apply(scenario.thread.id, [facts.endTurn("worker-0"), facts.endTurn("worker-1")]),
  );
  await within(work).findByRole("treeitem", {
    name: /^Main agent: Waiting on (work|background task)$/,
  });
  await userEvent.click(within(work).getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(within(work).queryByRole("region", { name: "Background" })).toBeNull(),
  );
  await waitFor(async () => expect(await summaryStatus(work)).toMatch(/^Done/));
  expect(within(work).queryByRole("treeitem", { name: /^Main agent/ })).toBeNull();
});
