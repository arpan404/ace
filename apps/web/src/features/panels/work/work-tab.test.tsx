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

test("opening the panel defaults to Work with agents and automations, the checkout left to the Work card", async () => {
  const app = harness();
  const scenario = workCardScenario("changes");
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${scenario.thread.id}`);
  await userEvent.click(await screen.findByRole("button", { name: "Right panel" }));
  const work = await screen.findByRole("tabpanel", { name: "Work" });
  expect(screen.getByRole("tab", { name: "Work", selected: true })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Agents" })).toBeNull();
  expect(screen.getAllByRole("tab")[0]?.textContent).toBe("Work");
  expect(await within(work).findByRole("tree", { name: "Agent tree" })).toBeTruthy();
  await within(work).findByRole("region", { name: "Automations" });
  expect(within(work).getByRole("button", { name: "Show bun run dev output" })).toBeTruthy();
  expect(within(work).getByRole("button", { name: "Stop" })).toBeTruthy();
  expect(within(work).queryByRole("button", { name: /^Branch / })).toBeNull();
  expect(within(work).queryByRole("button", { name: "More git actions" })).toBeNull();
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
    expect(within(work).getByRole("status").textContent).toContain("2 active · 1 done");
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
