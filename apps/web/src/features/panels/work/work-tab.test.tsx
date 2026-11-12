import { facts, workCardScenario } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import {
  agentRow,
  agentTree,
  isBreathing,
  liveRow,
  openWorkPanel,
  showFinished,
  stillRunning,
} from "@/test/open-work.ts";

beforeEach(() => localStorage.clear());
async function open() {
  const app = harness();
  const scenario = workCardScenario("changes");
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${scenario.thread.id}`);
  return { app, scenario, work: await openWorkPanel() };
}

test("opening the panel defaults to Summary with what still runs, and the full tree one click away", async () => {
  const app = harness();
  const scenario = workCardScenario("changes");
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${scenario.thread.id}`);
  await userEvent.click(await screen.findByRole("button", { name: "Right panel" }));
  const work = await screen.findByRole("tabpanel", { name: "Summary" });
  expect(screen.getByRole("tab", { name: "Summary", selected: true })).toBeTruthy();
  // The panel's own strip: the sidebar's Inbox tabs are tabs too.
  const strip = screen.getByRole("tablist", { name: "Thread panel tabs" });
  expect(within(strip).getAllByRole("tab")[0]?.textContent).toBe("Summary");
  const command = await liveRow(work, "$ bun run dev: running");
  expect(
    within(command.parentElement as HTMLElement).getByRole("button", { name: "Stop" }),
  ).toBeTruthy();
  // The tree is folded away until asked for, then holds the command under its agent.
  expect(within(work).queryByRole("tree")).toBeNull();
  const tree = await agentTree(work);
  expect(within(tree).getByRole("treeitem", { name: "$ bun run dev: running" })).toBeTruthy();
  expect(within(work).queryByRole("button", { name: "More git actions" })).toBeNull();
});

test("an idle thread shows nothing running and no empty sections", async () => {
  const app = harness();
  const scenario = workCardScenario("worktree");
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${scenario.thread.id}`);
  const work = await openWorkPanel();
  // The thread's own state and model are the composer's; the Summary repeats neither.
  expect(within(work).queryByRole("status", { name: /^Thread status/ })).toBeNull();
  expect(within(work).queryByText("Give the restart loop a retry budget.")).toBeNull();
  // A main agent alone is no tree, and nothing says a section is empty.
  expect(stillRunning(work)).toBeNull();
  expect(within(work).queryByRole("region", { name: "Agents" })).toBeNull();
  expect(within(work).queryByRole("tree")).toBeNull();
  expect(within(work).queryByRole("region", { name: "Plan" })).toBeNull();
  expect(within(work).queryByText(/automations? in this project/)).toBeNull();
});

test("a working tree lists every agent once with what it is doing, finished ones at rest", async () => {
  const { work } = await open();
  const done = await agentRow(work, "Read restart history");
  expect(done.getAttribute("aria-label")).toMatch(/: finished$/);
  expect(isBreathing(done)).toBe(false);
  const working = await agentRow(work, "Check supervisor logs");
  expect(working.getAttribute("aria-label")).not.toMatch(/finished|needs/i);
  expect(isBreathing(working)).toBe(true);
  // Still running lists the live agent, never the finished one.
  expect(await liveRow(work, /^Check supervisor logs: /)).toBeTruthy();
  expect(
    within(stillRunning(work) as HTMLElement).queryByRole("button", {
      name: /^Read restart history/,
    }),
  ).toBeNull();
});

test("a running background command's row opens its output", async () => {
  const { work } = await open();
  await userEvent.click(await liveRow(work, "$ bun run dev: running"));
  expect(await screen.findByRole("tab", { name: /^Watch/, selected: true })).toBeTruthy();
});

test.each(["completed", "interrupted"] as const)(
  "an %s parent stays live until its child finishes",
  async (outcome) => {
    const { app, scenario, work } = await open();
    act(() => app.daemon.apply(scenario.thread.id, [facts.endTurn("worker-0", outcome)]));
    await waitFor(async () =>
      expect((await agentRow(work, "Write retry tests")).getAttribute("aria-label")).toMatch(
        /: waiting/,
      ),
    );
    expect(isBreathing(await agentRow(work, "Write retry tests"))).toBe(true);
    act(() => app.daemon.apply(scenario.thread.id, [facts.endTurn("worker-1")]));
    // Both settle and fold into one "2 done" line; opened, the parent rests.
    await waitFor(() => within(work).getByRole("treeitem", { name: "2 done" }));
    await showFinished(work);
    expect(isBreathing(await agentRow(work, "Write retry tests"))).toBe(false);
  },
);

test("an idle main agent stays live while an ambient command runs, then settles after Stop", async () => {
  const { app, scenario, work } = await open();
  act(() =>
    app.daemon.apply(scenario.thread.id, [facts.endTurn("worker-0"), facts.endTurn("worker-1")]),
  );
  await waitFor(async () => expect(isBreathing(await agentRow(work, "Codex"))).toBe(true));
  const command = await liveRow(work, "$ bun run dev: running");
  await userEvent.click(
    within(command.parentElement as HTMLElement).getByRole("button", { name: "Stop" }),
  );
  await waitFor(() =>
    expect(within(work).queryByRole("treeitem", { name: /^\$ bun run dev/ })).toBeNull(),
  );
  // Nothing anywhere runs: Still running goes.
  await waitFor(() => expect(stillRunning(work)).toBeNull());
  expect(isBreathing(await agentRow(work, "Codex"))).toBe(false);
});
