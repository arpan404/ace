import { coldStartReplay, failingSubagent } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

async function openLogs(
  through: string,
  scenario = coldStartReplay(),
  path = "/t/thread-cold-start",
) {
  const app = harness();
  const script = app.play(scenario);
  script.runThrough(through);
  await app.open(path);
  return { app, script };
}
async function showLogs(title: string) {
  await screen.findByRole("heading", { level: 1, name: title });
  await userEvent.keyboard("{Control>}`{/Control}");
  const panel = await screen.findByRole("region", { name: "Bottom panel" });
  await userEvent.click(within(panel).getByRole("tab", { name: "Logs" }));
  return panel;
}
const lines = (panel: HTMLElement) =>
  within(within(panel).getByRole("list", { name: "Thread log" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent ?? "");

test("the log records sessions, subagents, background work and turns as they happen", async () => {
  const { script } = await openLogs("turn-1");
  const panel = await showLogs("Cap cold-start replay at 200 events");
  await waitFor(() =>
    expect(
      lines(panel).some((line) => line.includes("claude-code session started in /Users/dev/ace")),
    ).toBe(true),
  );
  expect(lines(panel).some((line) => line.includes("turn completed"))).toBe(true);
  expect(lines(panel).some((line) => line.includes("subagent reconnect-audit"))).toBe(false);

  await act(async () => script.runThrough("turn-2"));
  await waitFor(() =>
    expect(lines(panel).some((line) => line.includes("subagent reconnect-audit spawned"))).toBe(
      true,
    ),
  );
  expect(
    lines(panel).some((line) => line.includes("started bun run dev:relay in background")),
  ).toBe(true);
});

test("shell commands with their exit, the thread's creation and quota warnings are logged in order", async () => {
  const { script } = await openLogs("relay-output");
  const panel = await showLogs("Cap cold-start replay at 200 events");
  await waitFor(() =>
    expect(
      lines(panel).some((line) => line.includes("$ bun run test replay (regression-test)")),
    ).toBe(true),
  );
  expect(lines(panel)[0]).toMatch(/daemon\s*thread created in ace/);
  expect(lines(panel).find((line) => line.includes("82% of its 5-hour window"))).toMatch(/warn/);
  // A background shell is logged as background work, not as a command.
  expect(lines(panel).some((line) => line.includes("$ bun run dev:relay"))).toBe(false);

  await act(async () => script.runThrough("test-done"));
  await waitFor(() =>
    expect(lines(panel).some((line) => line.includes("bun run test replay · succeeded"))).toBe(
      true,
    ),
  );
});

test("a failed subagent is logged as an error with its reason", async () => {
  await openLogs("tester-failed", failingSubagent(), "/t/thread-settings");
  const panel = await showLogs("Migrate settings schema");
  await waitFor(() =>
    expect(lines(panel).find((line) => line.includes("migration-tester failed"))).toMatch(
      /error\s*migration-tester failed: Context window exceeded/,
    ),
  );
});

test("Clear hides what is logged so far; new lines still appear and Show brings the rest back", async () => {
  const { script } = await openLogs("turn-1");
  const panel = await showLogs("Cap cold-start replay at 200 events");
  await waitFor(() => expect(lines(panel).length).toBeGreaterThan(0));
  const before = lines(panel).length;

  await userEvent.click(within(panel).getByRole("button", { name: "Clear logs" }));
  expect(within(panel).getByText(`${before} earlier lines cleared`, { exact: false })).toBeTruthy();

  await act(async () => script.runThrough("turn-2"));
  await waitFor(() =>
    expect(lines(panel).some((line) => line.includes("subagent regression-test spawned"))).toBe(
      true,
    ),
  );
  expect(lines(panel).some((line) => line.includes("session started"))).toBe(false);

  await userEvent.click(within(panel).getByRole("button", { name: "Show" }));
  expect(lines(panel).some((line) => line.includes("session started"))).toBe(true);
});
