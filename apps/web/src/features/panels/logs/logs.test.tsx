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
  await userEvent.keyboard("{Control>}{Shift>}L{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole("tab", { name: "Logs", selected: true });
  return panel;
}
const lines = (panel: HTMLElement, name = "Thread log") =>
  within(within(panel).getByRole("list", { name }))
    .getAllByRole("listitem")
    .map((item) => item.textContent ?? "");
async function pickSource(panel: HTMLElement, source: string | RegExp) {
  await userEvent.click(await within(panel).findByRole("button", { name: /^Log source/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: source }));
}

test("the log records sessions, subagents, background work and turns as they happen", async () => {
  const { script } = await openLogs("turn-1");
  const panel = await showLogs("Cap cold-start replay at 200 events");
  await waitFor(() =>
    expect(
      lines(panel).some((line) => line.includes("claude-code session started in /Users/dev/ace")),
    ).toBe(true),
  );
  expect(lines(panel).some((line) => line.includes("turn completed"))).toBe(true);
  expect(lines(panel).some((line) => line.includes("subagent resume-sweep"))).toBe(false);

  await act(async () => script.runThrough("turn-2"));
  await waitFor(() =>
    expect(lines(panel).some((line) => line.includes("subagent resume-sweep spawned"))).toBe(true),
  );
  expect(
    lines(panel).some((line) =>
      line.includes("started bun run relay:soak --clients 2 in background"),
    ),
  ).toBe(true);
});

test("shell commands with their exit, the thread's creation and quota warnings are logged in order", async () => {
  const { script } = await openLogs("relay-output");
  const panel = await showLogs("Cap cold-start replay at 200 events");
  await waitFor(() =>
    expect(
      lines(panel).some((line) => line.includes("$ bun run test outbox (ack-buffer-test)")),
    ).toBe(true),
  );
  expect(lines(panel)[0]).toMatch(/daemon\s*thread created in ace/);
  expect(lines(panel).find((line) => line.includes("82% of its 5-hour window"))).toMatch(/warn/);
  // A background shell is logged as background work, not as a command.
  expect(lines(panel).some((line) => line.includes("$ bun run relay:soak"))).toBe(false);

  await act(async () => script.runThrough("test-done"));
  await waitFor(() =>
    expect(lines(panel).some((line) => line.includes("bun run test outbox · succeeded"))).toBe(
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
    expect(lines(panel).some((line) => line.includes("subagent ack-buffer-test spawned"))).toBe(
      true,
    ),
  );
  expect(lines(panel).some((line) => line.includes("session started"))).toBe(false);

  await userEvent.click(within(panel).getByRole("button", { name: "Show" }));
  expect(lines(panel).some((line) => line.includes("session started"))).toBe(true);
});

test("an agent's log holds that agent and its subagents, not the rest of the thread", async () => {
  await openLogs("turn-2");
  const panel = await showLogs("Cap cold-start replay at 200 events");
  await pickSource(panel, "resume-sweep");
  expect(
    await within(panel).findByRole("tab", { name: "resume-sweep log", selected: true }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(
      lines(panel, "resume-sweep log").some((line) => line.includes("resume-sweep spawned")),
    ).toBe(true),
  );
  expect(lines(panel, "resume-sweep log").some((line) => line.includes("session started"))).toBe(
    false,
  );
  expect(lines(panel, "resume-sweep log").some((line) => line.includes("ack-buffer-test"))).toBe(
    false,
  );

  // Back to the whole thread, in the same tab.
  await pickSource(panel, "Thread");
  expect(await within(panel).findByRole("tab", { name: "Logs", selected: true })).toBeTruthy();
  expect(lines(panel).some((line) => line.includes("session started"))).toBe(true);
});

test("Filter lines narrows the log to what matches and says how many of how many", async () => {
  await openLogs("relay-output");
  const panel = await showLogs("Cap cold-start replay at 200 events");
  await waitFor(() => expect(lines(panel).length).toBeGreaterThan(3));
  const total = lines(panel).length;
  await userEvent.type(within(panel).getByRole("searchbox", { name: "Filter lines" }), "outbox");
  await waitFor(() =>
    expect(lines(panel).every((line) => line.toLowerCase().includes("outbox"))).toBe(true),
  );
  const shown = lines(panel).length;
  expect(shown).toBeGreaterThan(0);
  expect(within(panel).getByText(`${shown} of ${total} lines`)).toBeTruthy();

  await userEvent.type(within(panel).getByRole("searchbox", { name: "Filter lines" }), "zzz");
  expect(await within(panel).findByText("No lines match")).toBeTruthy();
});

test("a level filter keeps to warnings and errors, and the thread's Logs come back filtered", async () => {
  const { app } = await openLogs("relay-output");
  const panel = await showLogs("Cap cold-start replay at 200 events");
  await waitFor(() => expect(lines(panel).length).toBeGreaterThan(3));
  await userEvent.click(within(panel).getByRole("button", { name: "Levels and sources" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Warnings and errors" }));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(lines(panel).every((line) => /warn|error/.test(line))).toBe(true));
  expect(lines(panel).some((line) => line.includes("82% of its 5-hour window"))).toBe(true);

  // Away to another thread and back: the filter was kept with the tab.
  await app.open("/t/thread-settings");
  await app.open("/t/thread-cold-start");
  const again = await screen.findByRole("region", { name: "Thread panel" });
  expect(within(again).getByRole("button", { name: "Levels and sources (filtered)" })).toBeTruthy();
  await waitFor(() => expect(lines(again).every((line) => /warn|error/.test(line))).toBe(true));
});

test("the daemon's log scope leads with its health and copies where its log is kept", async () => {
  await openLogs("turn-1");
  const panel = await showLogs("Cap cold-start replay at 200 events");
  await pickSource(panel, "ace");
  expect(await within(panel).findByRole("tab", { name: "ace log", selected: true })).toBeTruthy();
  const health = await within(panel).findByText("Event loop");
  const note = within(panel).getByText("ace's own log isn't streamed yet.");
  // The health comes first; the missing log is one line after it.
  expect(health.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  const user = userEvent.setup();
  await user.click(within(panel).getByRole("button", { name: "Copy log folder path" }));
  expect(await navigator.clipboard.readText()).toBe("/Users/dev/.ace-next/logs");
  expect(await screen.findByText("Copied the log folder's path")).toBeTruthy();
});
