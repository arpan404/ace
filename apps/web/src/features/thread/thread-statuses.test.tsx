import {
  askingQuestion,
  oneTurnWork,
  runningTests,
  waitingOnSubagents,
  watchingRelay,
  uxAudit,
  workbench,
  type Scenario,
} from "@ace/fake-daemon";
import { configure, screen, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

beforeEach(() => localStorage.clear());

/** Open one scenario's thread, played to its end, with the sidebar's list beside it. */
async function open(scenario: Scenario) {
  const app = harness();
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${scenario.thread.id}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const header = screen.getByRole("banner");
  const row = await within(await screen.findByRole("navigation", { name: "Threads" })).findByRole(
    "link",
    {
      name: new RegExp(`^${scenario.thread.title}`),
    },
  );
  return { app, feed, header, row };
}

test("a background command appears once in the transcript while its row keeps the status", async () => {
  const { header, row, feed } = await open(watchingRelay());
  expect(within(feed).getAllByText("bun run dev:relay")).toHaveLength(1);
  expect(screen.queryByRole("status", { name: "Watching bun run dev:relay" })).toBeNull();
  expect(row.getAttribute("aria-label")).toContain("Working · bun run dev:relay");
  expect(within(header).queryByRole("status")).toBeNull();
});

test("a thread waiting on subagents keeps the transcript live with their count", async () => {
  const { header, row } = await open(waitingOnSubagents());
  expect(screen.getByRole("group", { name: "Turn in progress" }).textContent).toContain(
    "2 subagents",
  );
  expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();
  expect(row.getAttribute("aria-label")).toContain("2 subagents running");
  expect(within(header).queryByRole("status")).toBeNull();
});

test.each([
  ["waiting on its subagents", waitingOnSubagents],
  ["watching its background command", watchingRelay],
])(
  "a thread %s reads Working in its sidebar row and its transcript alike",
  async (_name, scenario) => {
    const { feed, row } = await open(scenario());
    expect(within(feed).getByRole("status", { name: "Working" }).textContent).toMatch(
      /^Working for/,
    );
    expect(within(row).getByText("Working", { exact: true })).toBeTruthy();
    expect(within(row).queryByText("Waiting", { exact: true })).toBeNull();
    // What the row says aloud and what its hover card shows read the same word.
    const spoken = row.getAttribute("aria-label") ?? "";
    expect(spoken).toContain(". Working");
    expect(spoken).not.toMatch(/Waiting on|Watching/);
    await userEvent.hover(row);
    const details = await screen.findByLabelText(/^Details for /);
    expect(details.textContent).toContain("Working");
    expect(details.textContent).not.toMatch(/Waiting on|Watching/);
  },
);

test("a thread that asked a question keeps the waiting state in the thread, row and details icon", async () => {
  const { header, row } = await open(askingQuestion());
  expect(await screen.findByRole("region", { name: "Waiting for you" })).toBeTruthy();
  expect(screen.getByRole("status", { name: "Waiting for your answer" })).toBeTruthy();
  expect(row.getAttribute("aria-label")).toContain("Waiting for your answer");
  expect(within(header).queryByRole("status")).toBeNull();
  expect(
    await within(header).findByRole("button", { name: "Thread details, something needs you" }),
  ).toBeTruthy();
});

function find(scenarios: readonly Scenario[], id: string): Scenario {
  const found = scenarios.find((candidate) => candidate.thread.id === id);
  if (!found) throw new Error(`lost scenario ${id}`);
  return found;
}

test.each([
  ["Codex", () => find(workbench(), "thread-sheet-rotate")],
  ["Claude", () => find(uxAudit(), "thread-ux-formatting-questions")],
])(
  "a %s thread waiting for an answer never reads Working in its live head, row or details icon",
  async (_provider, scenario) => {
    const { feed, header, row } = await open(scenario());
    expect(await screen.findByRole("region", { name: "Waiting for you" })).toBeTruthy();
    const head = within(feed).getByRole("group", { name: "Turn in progress" });
    expect(head.textContent).toBe("Waiting for your answer");
    expect(within(feed).queryByRole("status", { name: /^Working/ })).toBeNull();
    expect(row.getAttribute("aria-label")).toContain("Waiting for your answer");
    expect(row.getAttribute("aria-label")).not.toContain("Working");
    expect(
      await within(header).findByRole("button", { name: "Thread details, something needs you" }),
    ).toBeTruthy();
  },
);

test("a thread running tests keeps its live head working and names the action in its row", async () => {
  const { header, row } = await open(runningTests());
  // The step in flight closes the transcript's flow; the head says the turn works.
  expect(screen.getByRole("group", { name: "Turn in progress" }).textContent).toContain(
    "Working for",
  );
  expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();
  expect(row.getAttribute("aria-label")).toContain("Working · running tests");
  expect(within(header).queryByRole("status")).toBeNull();
});

test("a finished thread has no live status in its header", async () => {
  const { header } = await open(oneTurnWork());
  expect(within(header).queryByRole("status")).toBeNull();
});

test("the side panel lists only the background commands still running", async () => {
  // The turn built the app in the background (finished) and left the relay running.
  const { feed } = await open(watchingRelay());
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(
    await within(panel).findByRole("listitem", { name: "bun run dev:relay: running" }),
  ).toBeTruthy();
  expect(within(panel).queryByRole("listitem", { name: /^bun run build/ })).toBeNull();
  // The finished build stays reachable from its transcript row, which opens its output.
  const build = within(feed).getByRole("group", { name: "Background task bun run build" });
  expect(build.textContent).toContain("Finished");
  expect(within(build).getByRole("button", { name: "Show output of bun run build" })).toBeTruthy();
});

test("with nothing running in the background, the side panel shows no background list", async () => {
  await open(oneTurnWork());
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole("treeitem", { name: /^Main agent/ });
  expect(within(panel).queryByRole("heading", { name: "Background" })).toBeNull();
  expect(within(panel).queryByRole("listitem", { name: /OpenCode background work/ })).toBeNull();
});
