import { facts, type Scenario } from "@ace/fake-daemon";
import { act, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, onTestFinished, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { agentRow, openWorkPanel } from "@/test/open-work.ts";

/*
 * How the Summary's tree folds when a sync finishes many agents at once: the rows that leave
 * play their exit one after another and then go, and the "N done" line rises in.
 */

beforeEach(() => localStorage.clear());

const tasks = 6;
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
  ],
});
const busy: Scenario = {
  thread: { id: "thread-busy", workspaceId: "relay", title: "Busy subagents", provider: "claude" },
  steps: [
    { kind: "facts", facts: [facts.rootAgent("claude"), facts.turn("root")] },
    ...Array.from({ length: tasks }, (_, index) => spawn(index)),
  ],
};
const finishAll = Array.from({ length: tasks }, (_, index) => facts.endTurn(`s${index}`));

/** A task's row anywhere in the panel, leaving or not: the accessible queries skip leaving rows. */
const taskRow = (work: HTMLElement, index: number) =>
  work.querySelector<HTMLElement>(`[role="treeitem"][aria-label^="Task ${index}: "]`);
const leavingRow = (row: HTMLElement | null) => row?.closest<HTMLElement>("[inert]") ?? null;

async function openBusy() {
  const app = harness();
  app.play(busy).runUntilBlocked();
  await app.open("/t/thread-busy");
  const work = await openWorkPanel();
  for (let index = 0; index < tasks; index++) await agentRow(work, `Task ${index}`);
  return { app, work };
}

test("agents finishing together fade out one after another, then go, while their done line rises in", async () => {
  const { app, work } = await openBusy();

  act(() => app.daemon.apply("thread-busy", finishAll));
  const done = await within(work).findByRole("treeitem", { name: `${tasks} done` });
  expect(done.closest("li")?.className).toContain("fx-rise-in");
  // Every finished row is still drawn where it was, inert and fading, each starting later.
  const delays = Array.from({ length: tasks }, (_, index) => {
    const leaving = leavingRow(taskRow(work, index));
    expect(leaving?.className).toContain("fx-fade-out");
    return Number.parseFloat(leaving?.style.animationDelay || "0");
  });
  expect(delays[0]).toBe(0);
  for (let index = 1; index < tasks; index++)
    expect(delays[index]).toBeGreaterThan(delays[index - 1] ?? 0);
  // The whole fold, last delay plus the exit, stays short.
  expect((delays.at(-1) ?? 0) + 140).toBeLessThanOrEqual(400);

  await waitFor(() => {
    for (let index = 0; index < tasks; index++) expect(taskRow(work, index)).toBeNull();
  });
  expect(within(work).getByRole("treeitem", { name: `${tasks} done` })).toBe(done);
});

test("with reduced motion, finished rows go at once instead of playing an exit", async () => {
  const { app, work } = await openBusy();
  // The theme provider marks <html> from the Reduce motion setting.
  act(() => document.documentElement.setAttribute("data-reduce-motion", ""));
  onTestFinished(() => document.documentElement.removeAttribute("data-reduce-motion"));

  act(() => app.daemon.apply("thread-busy", finishAll));
  await within(work).findByRole("treeitem", { name: `${tasks} done` });
  for (let index = 0; index < tasks; index++) expect(taskRow(work, index)).toBeNull();
});

test("when the focused agent finishes with its siblings, focus goes to the done line, never a row on its way out", async () => {
  const { app, work } = await openBusy();
  const tree = await within(work).findByRole("tree", { name: "Agent tree" });
  for (let step = 0; step < 80 && !tree.contains(document.activeElement); step++)
    await userEvent.tab();
  await userEvent.keyboard("{Home}{ArrowDown}{ArrowDown}");
  expect(document.activeElement).toBe(await agentRow(work, "Task 1"));

  act(() => app.daemon.apply("thread-busy", finishAll));
  const done = await within(work).findByRole("treeitem", { name: `${tasks} done` });
  // The row it was on is still fading out, but the keyboard is already on its stand-in.
  expect(leavingRow(taskRow(work, 1))).not.toBeNull();
  expect(document.activeElement).toBe(done);
  // Arrow keys skip rows on their way out: ↑ goes straight to the main agent.
  await userEvent.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(await agentRow(work, "Claude Code"));
});
