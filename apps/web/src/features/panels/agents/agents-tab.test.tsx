import { coldStartReplay, failingSubagent } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("the agent tree shows subagents as they spawn and marks the one that fails", async () => {
  const app = harness();
  const script = app.play(failingSubagent());
  script.step();
  await app.open("/t/thread-settings");
  await screen.findByRole("heading", { level: 1, name: "Migrate settings schema" });

  await userEvent.keyboard("{Meta>}j{/Meta}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(within(panel).getByRole("tab", { name: "Agents", selected: true })).toBeTruthy();
  await within(panel).findByRole("group", { name: "Main agent: Working" });
  expect(within(panel).queryByRole("group", { name: /migration-tester/ })).toBeNull();

  await act(async () => script.runThrough("workers-spawned"));
  await within(panel).findByRole("group", { name: "schema-writer: Working" });
  await within(panel).findByRole("group", { name: "migration-tester: Working" });

  await act(async () => script.runThrough("tester-failed"));
  const failed = await within(panel).findByRole("group", { name: "migration-tester: Failed" });
  expect(within(failed).getByText(/Context window exceeded/)).toBeTruthy();
  expect(within(panel).getByRole("group", { name: "schema-writer: Working" })).toBeTruthy();
});

test("the Agents tab shows what each agent is doing, the background shell, and why the thread isn't done", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Meta>}j{/Meta}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });

  const root = await within(panel).findByRole("group", {
    name: "Main agent: Waiting on subagents",
  });
  expect(within(root).getByText("Claude Code")).toBeTruthy();
  expect(within(root).getByText("waiting for subagents")).toBeTruthy();
  const audit = within(panel).getByRole("group", { name: "reconnect-audit: Working" });
  // Its running browser call is what it is doing (the Preview tab names it as the driver).
  expect(within(audit).getByText("Pair a phone on localhost:5173/settings/devices")).toBeTruthy();
  const tester = within(panel).getByRole("group", { name: "regression-test: Working" });
  expect(within(tester).getByText("Run the replay tests")).toBeTruthy();

  expect(within(panel).getByRole("listitem", { name: "bun run dev:relay: running" })).toBeTruthy();
  expect(within(panel).getByRole("region", { name: "Why isn't this done?" }).textContent).toContain(
    "Two subagents are still running and one background shell is open.",
  );
});

test("Stop ends a background shell, and the thread settles once nothing else is running", async () => {
  const app = harness();
  const script = app.play(coldStartReplay());
  script.runThrough("root-replied");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Meta>}j{/Meta}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  const why = await within(panel).findByRole("region", { name: "Why isn't this done?" });
  expect(why.textContent).toContain(
    "One background shell is open. The thread settles when the shell is stopped or finishes.",
  );

  const shell = within(panel).getByRole("listitem", { name: "bun run dev:relay: running" });
  await userEvent.click(within(shell).getByRole("button", { name: "Stop" }));
  await within(panel).findByRole("listitem", { name: "bun run dev:relay: stopped" });
  expect(within(panel).queryByRole("button", { name: "Stop" })).toBeNull();
  const done = await within(panel).findByRole("region", { name: "Done" });
  expect(done.textContent).toContain("Every agent has finished");
});

test("Stop on a subagent interrupts only that subagent", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Meta>}j{/Meta}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  const audit = await within(panel).findByRole("group", { name: "reconnect-audit: Working" });
  await userEvent.hover(audit);
  await userEvent.click(within(audit).getByRole("button", { name: "Stop" }));
  await within(panel).findByRole("group", { name: "reconnect-audit: Interrupted" });
  expect(within(panel).getByRole("group", { name: "regression-test: Working" })).toBeTruthy();
  expect(within(panel).getByRole("region", { name: "Why isn't this done?" }).textContent).toContain(
    "One subagent is still running",
  );
});
