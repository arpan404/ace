import { facts, restartedSubagents, summaryFleet } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openDoneAgents, openWorkPanel } from "@/test/open-work.ts";

beforeEach(() => localStorage.clear());

/** The thread whose two subagents a daemon restart stopped, played through `label`. */
async function openRestarted(label?: string) {
  const app = harness();
  const script = app.play(restartedSubagents());
  if (label) script.runThrough(label);
  else script.runUntilBlocked();
  await app.open("/t/thread-restarted");
  return { app, script, work: await openWorkPanel() };
}

test("a failure is shown while it is the agent's latest state", async () => {
  const { work } = await openRestarted("restart-failed");
  const needs = await within(work).findByRole("region", { name: "Needs you" });
  const row = await within(needs).findByRole("listitem", { name: "Fix ack buffer replay failed" });
  expect(row.textContent).toContain("Daemon restarted; previous provider work stopped");
  expect(within(needs).getByRole("listitem", { name: "Recover stale leases failed" })).toBeTruthy();
});

test("a subagent resumed after a restart reads as working once, and the thread is not done", async () => {
  const { work } = await openRestarted("resumed");
  const working = await within(work).findByRole("region", { name: "Working" });
  expect(
    await within(working).findAllByRole("treeitem", { name: "Fix ack buffer replay: Working" }),
  ).toHaveLength(1);
  expect(within(work).queryByRole("treeitem", { name: /: Failed$/ })).toBeNull();
  expect(within(work).queryByRole("region", { name: "Needs you" })).toBeNull();
  expect(within(work).queryByRole("region", { name: "Done" })).toBeNull();
  const status = within(work).getByRole("status", { name: /^Thread status/ });
  expect(status.textContent).toMatch(/^Working · 2 agents running/);
});

test("restart-failed, resumed, then done: one done row per agent and nothing needs the person", async () => {
  const { work } = await openRestarted();
  await waitFor(() =>
    expect(within(work).getByRole("status", { name: /^Thread status/ }).textContent).toMatch(
      /^Done · finished/,
    ),
  );
  expect(within(work).queryByRole("region", { name: "Needs you" })).toBeNull();
  expect(within(work).queryByRole("region", { name: "Working" })).toBeNull();
  const done = await openDoneAgents(work);
  const ack = within(done).getAllByRole("treeitem", { name: /^Fix ack buffer replay:/ });
  expect(ack).toHaveLength(1);
  expect(ack[0]?.getAttribute("aria-label")).toBe("Fix ack buffer replay: Idle");
  expect(within(done).getAllByRole("treeitem")).toHaveLength(2);
  expect(within(done).queryByRole("treeitem", { name: /: Failed$/ })).toBeNull();
  // Its earlier run is a quiet note on the row, and the PR it reported opening sits beside it.
  expect(within(ack[0] as HTMLElement).getByTitle("Resumed after a restart").textContent).toBe(
    "resumed",
  );
  expect(
    within(ack[0] as HTMLElement).getByRole("img", { name: "Pull request #301, merged" }),
  ).toBeTruthy();
});

test("an agent's earlier runs open from its row as history", async () => {
  const { work } = await openRestarted();
  const done = await openDoneAgents(work);
  const ack = await within(done).findByRole("treeitem", { name: "Fix ack buffer replay: Idle" });
  expect(ack.getAttribute("aria-expanded")).toBe("false");
  ack.focus();
  await userEvent.keyboard("{ArrowRight}");
  const group = document.getElementById(ack.getAttribute("aria-owns") ?? "");
  const earlier = within(group as HTMLElement).getByRole("treeitem", {
    name: "Fix ack buffer replay: Failed",
  });
  expect(earlier.textContent).toContain("Earlier run");
  // History, not a failure to act on.
  expect(within(work).queryByRole("region", { name: "Needs you" })).toBeNull();
});

test("the main agent never reads as done while a resumed subagent still works", async () => {
  const { app, work } = await openRestarted("resumed");
  act(() =>
    app.daemon.apply("thread-restarted", [
      facts.endTurn("ack-resumed"),
      { type: "turn.ended", agent: "root", nativeTurnId: "root-resumed", outcome: "completed" },
    ]),
  );
  // The main agent's own turn is over, but a resumed run still works under it.
  const working = await within(work).findByRole("region", { name: "Working" });
  await within(working).findByRole("treeitem", { name: /^Main agent: Waiting on/ });
  expect(
    within(working).getByRole("treeitem", { name: "Recover stale leases: Working" }),
  ).toBeTruthy();
  expect(within(working).queryByRole("treeitem", { name: /^Fix ack buffer replay/ })).toBeNull();
  expect(within(work).getByRole("status", { name: /^Thread status/ }).textContent).not.toMatch(
    /^Done/,
  );
});

test("the pull requests the thread's agents opened list in review first, each opening its PR", async () => {
  const app = harness();
  app.play(summaryFleet()).runUntilBlocked();
  await app.open("/t/thread-fleet");
  const work = await openWorkPanel();
  const prs = await within(work).findByRole("region", { name: "Pull requests" });
  const rows = within(prs).getAllByRole("button", { name: /^Pull request #/ });
  expect(rows.map((row) => row.getAttribute("aria-label")?.split(":")[0])).toEqual([
    "Pull request #1066",
    "Pull request #1065",
    "Pull request #1064",
    "Pull request #1063",
  ]);
  expect(rows[0]?.getAttribute("aria-label")).toMatch(/, in review$/);
  const more = within(prs).getByRole("button", { name: "22 more merged" });
  await userEvent.click(more);
  expect(within(prs).getAllByRole("button", { name: /^Pull request #/ })).toHaveLength(26);
  await userEvent.click(rows[0] as HTMLElement);
  expect(await screen.findByRole("tab", { name: /^#1066/, selected: true })).toBeTruthy();
});

test("a fleet with resumed agents counts each agent once and asks only for the real approval", async () => {
  const app = harness();
  app.play(summaryFleet()).runUntilBlocked();
  await app.open("/t/thread-fleet");
  const work = await openWorkPanel();
  const needs = await within(work).findByRole("region", { name: "Needs you" });
  expect(within(needs).getAllByRole("listitem")).toHaveLength(1);
  expect(within(needs).getByRole("button", { name: /^Show Run gh pr merge 1065/ })).toBeTruthy();
  const figures = within(work).getByLabelText("Thread figures");
  expect(figures.textContent).toContain("PRs merged24");
  expect(figures.textContent).toContain("In review2");
  expect(figures.textContent).toContain("Agents332 live");
  expect(within(work).getByRole("button", { name: "31 done" })).toBeTruthy();
});

test("each agent row names its provider and model, and the status line what the thread runs on", async () => {
  const app = harness();
  app.play(summaryFleet()).runUntilBlocked();
  await app.open("/t/thread-fleet");
  const work = await openWorkPanel();
  expect(within(work).getByTitle("Claude Code · Opus 5.5 · High")).toBeTruthy();
  const working = await within(work).findByRole("region", { name: "Working" });
  const main = within(working).getByRole("treeitem", { name: /^Main agent: / });
  expect(main.textContent).toContain("Opus 5.5 · High");
  const devices = within(working).getByRole("treeitem", { name: /^Devices panel redesign: / });
  expect(within(devices).getByRole("img", { name: "Claude Code" })).toBeTruthy();
  expect(devices.textContent).toContain("Opus 5.5");
  // A subagent's effort isn't recorded, so none is shown.
  expect(devices.textContent).not.toContain("High");
  expect(devices.getAttribute("title")).toMatch(/Claude Code · Opus 5\.5\nStarted /);
  const media = within(working).getByRole("treeitem", { name: /^Devices shared media: / });
  expect(within(media).getByRole("img", { name: "Codex" })).toBeTruthy();
});
