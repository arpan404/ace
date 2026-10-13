import { facts, workCardScenario } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openWorkPanel } from "@/test/open-work.ts";

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

/** The Summary's first line: where the thread stands right now. */
const head = (work: HTMLElement) => work.querySelector("[data-summary-head]")?.textContent ?? "";

test("an idle thread shows one quiet line and no empty sections", async () => {
  const app = harness();
  const scenario = workCardScenario("worktree");
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${scenario.thread.id}`);
  const work = await openWorkPanel();
  await waitFor(() => expect(head(work)).toBe("Nothing running"));
  expect(within(work).queryAllByRole("heading")).toHaveLength(0);
  expect(within(work).queryByRole("tree")).toBeNull();
  expect(within(work).queryByRole("region", { name: "Automations" })).toBeNull();
  expect(within(work).queryByText("No scheduled tasks")).toBeNull();
});

test("a working tree leads with its live state and says each agent's status once", async () => {
  const { work } = await open();
  await waitFor(() => expect(head(work)).toMatch(/^Working/));
  expect(within(work).getByRole("heading", { name: "Agents" })).toBeTruthy();
  expect(within(work).getByRole("heading", { name: "Background" })).toBeTruthy();
  const done = await within(work).findByRole("treeitem", { name: "Read restart history: Idle" });
  expect(within(done).getAllByText("Completed")).toHaveLength(1);
  const working = within(work).getByRole("treeitem", { name: /^Check supervisor logs: / });
  expect(working.textContent).not.toMatch(/Completed|Needs you/);
});

test("the Automations section is left out when the project has none", async () => {
  const { work } = await open();
  await within(work).findByRole("tree", { name: "Agent tree" });
  await waitFor(() => expect(head(work)).toMatch(/^Working/));
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

test("a request waiting on the person heads the summary and Show takes focus to it", async () => {
  const { app, scenario, work } = await open();
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
  await waitFor(() => expect(head(work)).toMatch(/^Waiting for your answer/));
  await userEvent.click(within(work).getByRole("button", { name: "Show the request" }));
  await waitFor(() =>
    expect(document.activeElement?.closest("[data-composer-strip]")).toBeTruthy(),
  );
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
    expect(within(work).getByRole("status").textContent).toBe("1 working · 1 done");
    act(() => app.daemon.apply(scenario.thread.id, [facts.endTurn("worker-1")]));
    await within(work).findByRole("treeitem", {
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
  expect(
    within(work).queryByText("Every agent has finished and nothing is running in the background."),
  ).toBeNull();
  await userEvent.click(within(work).getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(within(work).queryByRole("region", { name: "Background" })).toBeNull(),
  );
  await within(work).findByRole("treeitem", { name: "Main agent: Idle" });
});
