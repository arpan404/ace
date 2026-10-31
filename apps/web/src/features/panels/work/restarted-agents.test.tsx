import { facts, restartedSubagents, summaryFleet } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { agentRow, isBreathing, openWorkPanel, summaryStatus } from "@/test/open-work.ts";

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

const rows = (work: HTMLElement, name: string) =>
  within(work).queryAllByRole("treeitem", { name: new RegExp(`^${name}: `) });

test("a failure reads in red on its row while it is the agent's latest state", async () => {
  const { work } = await openRestarted("restart-failed");
  const ack = await agentRow(work, "Fix ack buffer replay");
  const step = within(ack).getByText(/./, { selector: "[data-tone=failed]" });
  expect(step).toBeTruthy();
  expect(await agentRow(work, "Recover stale leases")).toBeTruthy();
});

test("a subagent resumed after a restart is one live row, and the thread is not done", async () => {
  const { work } = await openRestarted("resumed");
  await waitFor(() => expect(rows(work, "Fix ack buffer replay")).toHaveLength(1));
  expect(isBreathing(await agentRow(work, "Fix ack buffer replay"))).toBe(true);
  expect(work.querySelector("[role=treeitem] [data-tone=failed]")).toBeNull();
  expect(await summaryStatus(work)).toMatch(/^Working/);
});

test("restart-failed, resumed, then done: one row per agent and nothing needs the person", async () => {
  const { work } = await openRestarted();
  await waitFor(async () => expect(await summaryStatus(work)).toMatch(/^Done/));
  expect(rows(work, "Fix ack buffer replay")).toHaveLength(1);
  expect(rows(work, "Recover stale leases")).toHaveLength(1);
  expect(work.querySelector("[data-tone=failed], [data-tone=needs-you]")).toBeNull();
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
  await waitFor(async () =>
    expect((await agentRow(work, "Claude Code")).getAttribute("aria-label")).toMatch(/: waiting/),
  );
  expect(isBreathing(await agentRow(work, "Claude Code"))).toBe(true);
  expect(isBreathing(await agentRow(work, "Recover stale leases"))).toBe(true);
  expect(isBreathing(await agentRow(work, "Fix ack buffer replay"))).toBe(false);
  expect(await summaryStatus(work)).not.toMatch(/^Done/);
});

test("a Summary pull request unlinks from its row after asking", async () => {
  const app = harness();
  app.play(summaryFleet()).runUntilBlocked();
  await app.open("/t/thread-fleet");
  const work = await openWorkPanel();
  const results = await within(work).findByRole("region", { name: "Results" });
  // The × shows on hover; jsdom has no hover, but the button is in the row regardless.
  await userEvent.click(within(results).getByRole("button", { name: "Unlink pull request #1066" }));
  const dialog = await screen.findByRole("dialog", { name: "Unlink pull request #1066?" });
  expect(within(dialog).getByText(/stays on GitHub/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Unlink" }));
  await waitFor(() =>
    expect(within(results).queryByRole("button", { name: /^Pull request #1066/ })).toBeNull(),
  );
  expect(within(results).getByRole("button", { name: /^Pull request #1065/ })).toBeTruthy();
});

test("Results list the thread's pull requests in review first, each opening its PR", async () => {
  const app = harness();
  app.play(summaryFleet()).runUntilBlocked();
  await app.open("/t/thread-fleet");
  const work = await openWorkPanel();
  const results = await within(work).findByRole("region", { name: "Results" });
  const prs = within(results).getAllByRole("button", { name: /^Pull request #/ });
  expect(prs.slice(0, 3).map((row) => row.getAttribute("aria-label")?.split(":")[0])).toEqual([
    "Pull request #1066",
    "Pull request #1065",
    "Pull request #1064",
  ]);
  expect(prs[0]?.getAttribute("aria-label")).toMatch(/, in review$/);
  expect(prs[0]?.textContent).toMatch(/#1066 · In review/);
  await userEvent.click(prs[0] as HTMLElement);
  expect(await screen.findByRole("tab", { name: /^#1066/, selected: true })).toBeTruthy();
});

test("a fleet reads the approval it waits on in the warning colour, naming what it asks", async () => {
  const app = harness();
  app.play(summaryFleet()).runUntilBlocked();
  await app.open("/t/thread-fleet");
  const work = await openWorkPanel();
  const status = await within(work).findByRole("status", { name: /^Thread status/ });
  expect(status.textContent).toBe("The main agent needs your approval");
  expect(status.getAttribute("data-tone")).toBe("needs-you");
  expect(within(work).getByText(/^Asks: /)).toBeTruthy();
  // The main agent is this thread: there is nothing to open, the composer answers it.
  expect(within(work).queryByRole("button", { name: /^Open / })).toBeNull();
  expect(within(work).getByRole("region", { name: "Agents" }).textContent).toMatch(/^Agents34/);
});

test("each agent row's tooltip names its provider and model; the header what the thread runs on", async () => {
  const app = harness();
  app.play(summaryFleet()).runUntilBlocked();
  await app.open("/t/thread-fleet");
  const work = await openWorkPanel();
  expect(within(work).getByTitle("Claude Code · Opus 5.5 · High")).toBeTruthy();
  const main = await agentRow(work, "Claude Code");
  expect(main.textContent).not.toContain("Opus 5.5");
  expect(main.getAttribute("title")).toMatch(/Claude Code · Opus 5\.5/);
  const devices = await agentRow(work, "Devices panel redesign");
  // A subagent's effort isn't recorded, so none is shown.
  expect(devices.getAttribute("title")).toMatch(/Claude Code · Opus 5\.5\nStarted /);
  expect(devices.textContent).not.toContain("High");
  expect((await agentRow(work, "Devices shared media")).getAttribute("title")).toMatch(
    /^.*\nCodex/,
  );
});
