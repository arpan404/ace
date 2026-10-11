import {
  askingQuestion,
  oneTurnWork,
  runningTests,
  waitingOnSubagents,
  watchingRelay,
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
  expect(row.getAttribute("aria-label")).toContain("Watching bun run dev:relay");
  expect(within(header).queryByRole("status")).toBeNull();
});

test("a thread waiting on subagents shows their count in its row and all active agents in its composer", async () => {
  const { header, row } = await open(waitingOnSubagents());
  expect(
    await within(await screen.findByRole("region", { name: "Agents" })).findByText(
      "3 agents working",
    ),
  ).toBeTruthy();
  expect(row.getAttribute("aria-label")).toContain("Waiting on 2 subagents");
  expect(within(header).queryByRole("status")).toBeNull();
});

test("a thread that asked a question keeps the waiting state in the thread and row", async () => {
  const { header, row } = await open(askingQuestion());
  expect(await screen.findByRole("region", { name: "Waiting for you" })).toBeTruthy();
  expect(screen.queryByRole("status", { name: "Waiting for your answer" })).toBeNull();
  expect(row.getAttribute("aria-label")).toContain("Waiting for your answer");
  expect(within(header).queryByRole("status")).toBeNull();
});

test("a thread running tests keeps its activity in the composer and row without repeating it in the transcript", async () => {
  const { feed, header, row } = await open(runningTests());
  expect(
    await within(await screen.findByRole("region", { name: "Agents" })).findByText(
      /Running tests…$/,
    ),
  ).toBeTruthy();
  expect(within(feed).queryByText("Running tests…")).toBeNull();
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
