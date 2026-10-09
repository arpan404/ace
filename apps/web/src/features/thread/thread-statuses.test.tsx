import {
  askingQuestion,
  oneTurnWork,
  runningTests,
  waitingOnSubagents,
  watchingRelay,
  type Scenario,
} from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

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

test("a thread watching a background command says so in its live line and row", async () => {
  const { header, row } = await open(watchingRelay());
  const line = await screen.findByRole("status", { name: "Watching bun run dev:relay" });
  expect(within(line).getByText("bun run dev:relay").tagName).toBe("CODE");
  expect(row.getAttribute("aria-label")).toContain("Watching bun run dev:relay");
  expect(within(header).queryByRole("status")).toBeNull();
});

test("a thread waiting on its subagents keeps their count in the thread and row", async () => {
  const { header, row } = await open(waitingOnSubagents());
  expect(await screen.findByRole("status", { name: "Waiting on 2 subagents" })).toBeTruthy();
  expect(row.getAttribute("aria-label")).toContain("Waiting on 2 subagents");
  expect(within(header).queryByRole("status")).toBeNull();
});

test("a thread that asked a question keeps the waiting state in the thread and row", async () => {
  const { header, row } = await open(askingQuestion());
  expect(await screen.findByRole("status", { name: "Waiting for your answer" })).toBeTruthy();
  expect(row.getAttribute("aria-label")).toContain("Waiting for your answer");
  expect(within(header).queryByRole("status")).toBeNull();
});

test("a thread running its tests says Running tests", async () => {
  const { feed, header, row } = await open(runningTests());
  expect(await within(feed).findByText("Running tests…")).toBeTruthy();
  expect(row.getAttribute("aria-label")).toContain("Running tests…");
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
