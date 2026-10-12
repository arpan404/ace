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

test("opening the panel defaults to Work with environment, agents and automations together", async () => {
  const app = harness();
  const scenario = workCardScenario("changes");
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${scenario.thread.id}`);
  await userEvent.click(await screen.findByRole("button", { name: "Right panel" }));
  const work = await screen.findByRole("tabpanel", { name: "Work" });
  expect(screen.getByRole("tab", { name: "Work", selected: true })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Agents" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Work card/ })).toBeNull();
  expect(screen.getAllByRole("tab")[0]?.textContent).toBe("Work");
  await within(work).findByRole("region", { name: "Environment" });
  expect(within(work).getByRole("tree", { name: "Agent tree" })).toBeTruthy();
  await within(work).findByRole("region", { name: "Automations" });
  expect(within(work).getByRole("button", { name: "Show bun run dev output" })).toBeTruthy();
  expect(within(work).getByRole("button", { name: "Stop" })).toBeTruthy();
});

test.each(["completed", "interrupted"] as const)(
  "an %s parent stays waiting until its child finishes",
  async (outcome) => {
    const { app, scenario, work } = await open();
    act(() => app.daemon.apply(scenario.thread.id, [facts.endTurn("worker-0", outcome)]));
    await within(work).findByRole("treeitem", { name: "Write retry tests: Waiting on work" });
    expect(within(work).queryByRole("treeitem", { name: "Write retry tests: Done" })).toBeNull();
    expect(within(work).getByRole("status").textContent).toContain("2 active · 1 done");
    act(() => app.daemon.apply(scenario.thread.id, [facts.endTurn("worker-1")]));
    await within(work).findByRole("treeitem", {
      name: `Write retry tests: ${outcome === "completed" ? "Done" : "Stopped"}`,
    });
  },
);

test("an idle main agent keeps waiting while an ambient command is running, then settles after Stop", async () => {
  const { app, scenario, work } = await open();
  act(() =>
    app.daemon.apply(scenario.thread.id, [facts.endTurn("worker-0"), facts.endTurn("worker-1")]),
  );
  await within(work).findByRole("treeitem", { name: "Main agent: Waiting on work" });
  expect(
    within(work).queryByText("Every agent has finished and nothing is running in the background."),
  ).toBeNull();
  await userEvent.click(within(work).getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(within(work).queryByRole("region", { name: "Background" })).toBeNull(),
  );
  await within(work).findByRole("treeitem", { name: "Main agent: Done" });
});

test("PR state shares one row and unavailable stack metadata stays quiet", async () => {
  const { work } = await open();
  const pr = await within(work).findByRole("button", { name: /^Pull request #188/ });
  expect(pr.parentElement?.textContent).toContain("#188 Retry budgetopen");
  expect(within(work).getAllByText(/#188/)).toHaveLength(1);
  expect(
    within(work).queryByText(/Stack membership unavailable|missing or inaccessible/),
  ).toBeNull();
});
