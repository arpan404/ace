import { facts, restartedSubagents, summaryFleet } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import {
  agentRow,
  agentTree,
  isBreathing,
  openWorkPanel,
  liveRow,
  showFinished,
  stillRunning,
} from "@/test/open-work.ts";

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
  await agentTree(work);
  await waitFor(() => expect(rows(work, "Fix ack buffer replay")).toHaveLength(1));
  expect(isBreathing(await agentRow(work, "Fix ack buffer replay"))).toBe(true);
  expect(work.querySelector("[role=treeitem] [data-tone=failed]")).toBeNull();
  expect(await liveRow(work, /^Fix ack buffer replay: /)).toBeTruthy();
});

test("restart-failed, resumed, then done: one row per agent and nothing needs the person", async () => {
  const { work } = await openRestarted();
  await waitFor(() => expect(stillRunning(work)).toBeNull());
  await showFinished(work);
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
  expect(await liveRow(work, /^Recover stale leases: /)).toBeTruthy();
});

test("a Summary pull request unlinks after asking, and the next one leads", async () => {
  const app = harness();
  app.play(summaryFleet()).runUntilBlocked();
  await app.open("/t/thread-fleet");
  const work = await openWorkPanel();
  const lead = await within(work).findByRole("region", { name: "Pull request #1066" });
  // The × shows on hover; jsdom has no hover, but the button is in the block regardless.
  await userEvent.click(within(lead).getByRole("button", { name: "Unlink pull request #1066" }));
  const dialog = await screen.findByRole("dialog", { name: "Unlink pull request #1066?" });
  expect(within(dialog).getByText(/stays on GitHub/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Unlink" }));
  await waitFor(() =>
    expect(within(work).queryByRole("region", { name: "Pull request #1066" })).toBeNull(),
  );
  expect(await within(work).findByRole("region", { name: "Pull request #1065" })).toBeTruthy();
});

test("the thread's open pull request leads, the other open ones follow, and merged ones fold into one line", async () => {
  const app = harness();
  app.play(summaryFleet()).runUntilBlocked();
  await app.open("/t/thread-fleet");
  const work = await openWorkPanel();
  const lead = await within(work).findByRole("region", { name: "Pull request #1066" });
  expect(within(lead).getByRole("list", { name: "State" }).textContent).toMatch(/In review/);
  const others = within(work).getByRole("region", { name: "Other pull requests" });
  const open = within(others).getAllByRole("button", { name: /^Pull request #/ });
  expect(open[0]?.getAttribute("aria-label")).toMatch(/^Pull request #1065: .*, in review$/);
  // Merged ones are one quiet line until the person opens them.
  expect(within(others).queryByRole("button", { name: /, merged$/ })).toBeNull();
  const fold = within(others).getByText(/^\d+ merged/);
  await userEvent.click(within(others).getByRole("button", { name: "Show" }));
  expect(within(others).getAllByRole("button", { name: /, merged$/ }).length).toBe(
    Number(fold.textContent?.match(/^(\d+) merged/)?.[1]),
  );
  await userEvent.click(within(lead).getByRole("button", { name: "Open #1066" }));
  expect(await screen.findByRole("tab", { name: /^#1066/, selected: true })).toBeTruthy();
});

test("a fleet whose main agent asks leaves the ask to the composer, and lists only what still runs", async () => {
  const app = harness();
  app.play(summaryFleet()).runUntilBlocked();
  await app.open("/t/thread-fleet");
  const work = await openWorkPanel();
  const live = await within(work).findByRole("region", { name: "Still running" });
  // The main agent is this thread: the composer answers it, and Still running doesn't list it.
  expect(within(live).queryByRole("button", { name: /^Claude Code: / })).toBeNull();
  expect(within(work).queryByRole("button", { name: /^Open [^#]/ })).toBeNull();
  for (const row of within(live).getAllByRole("button", { name: /: / }))
    expect(row.getAttribute("aria-label")).not.toMatch(/: finished$/);
  expect(within(work).getByRole("button", { name: "Show all agents (34)" })).toBeTruthy();
});

test("each agent row's tooltip names its provider and model", async () => {
  const app = harness();
  app.play(summaryFleet()).runUntilBlocked();
  await app.open("/t/thread-fleet");
  const work = await openWorkPanel();
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
