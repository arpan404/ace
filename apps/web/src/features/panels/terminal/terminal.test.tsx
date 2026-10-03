import { coldStartReplay, facts, seedPanels } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

async function openTerminal(through = "turn-2") {
  const app = harness();
  const script = app.play(coldStartReplay());
  script.runThrough(through);
  seedPanels(app.daemon);
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}`{/Control}");
  const panel = await screen.findByRole("region", { name: "Bottom panel" });
  return { app, script, panel, terminals: app.daemon.terminals };
}
const tab = (panel: HTMLElement, name: string | RegExp) =>
  within(within(panel).getByRole("tablist", { name: "Terminals" })).getByRole("tab", { name });
const output = (panel: HTMLElement, name: string) => within(panel).getByRole("log", { name });

test("the agent's background dev server streams into its own tab", async () => {
  const { panel, script } = await openTerminal();
  const relay = await within(panel).findByRole("tab", {
    name: "relay:soak, running",
    selected: true,
  });
  expect(relay).toBeTruthy();
  expect(output(panel, "relay:soak output").textContent).toContain(
    "soak relay listening on ws://127.0.0.1:8790",
  );
  expect(output(panel, "relay:soak output").textContent).not.toContain("cold start");

  await act(async () => script.runThrough("relay-output"));
  await waitFor(() =>
    expect(output(panel, "relay:soak output").textContent).toContain(
      "client ios-2 connected · resume seq 0 · cold start",
    ),
  );
  // A background shell is the agent's: there is nothing to type into.
  expect(within(panel).queryByRole("textbox")).toBeNull();
});

test("typing into a terminal runs the command in the thread's worktree", async () => {
  const { panel, terminals } = await openTerminal();
  await userEvent.click(await within(panel).findByRole("tab", { name: "zsh" }));
  expect(output(panel, "zsh output").textContent).toContain("M apps/server/src/replay.ts");

  await userEvent.type(
    within(panel).getByRole("textbox", { name: "zsh input" }),
    "git branch{Enter}",
  );
  await waitFor(() =>
    expect(output(panel, "zsh output").textContent).toContain("* fix/replay-dedupe"),
  );
  expect(terminals.received.map((entry) => entry.data).join("")).toBe("git branch\r");
});

test("New terminal opens another shell in the thread's checkout and Close ends it", async () => {
  const { panel, terminals } = await openTerminal();
  await userEvent.click(await within(panel).findByRole("button", { name: "New terminal" }));
  await waitFor(() => expect(tab(panel, "Terminal").getAttribute("aria-selected")).toBe("true"));
  const opened = tab(panel, "Terminal");
  await userEvent.type(
    await within(panel).findByRole("textbox", { name: "Terminal input" }),
    "pwd{Enter}",
  );
  await waitFor(() =>
    expect(output(panel, "Terminal output").textContent).toContain("/Users/dev/ace"),
  );

  await userEvent.click(within(panel).getByRole("button", { name: "Close Terminal" }));
  await waitFor(() => expect(opened.isConnected).toBe(false));
  expect(terminals.list("thread-cold-start").map((info) => info.name)).toEqual(["tests", "zsh"]);
});

test("after a dropped connection the terminal replays only the output it missed", async () => {
  const { app, panel, terminals } = await openTerminal();
  await userEvent.click(await within(panel).findByRole("tab", { name: "tests" }));
  await waitFor(() => expect(output(panel, "tests output").textContent).toContain("3 pass"));
  const tests = terminals.list("thread-cold-start").find((info) => info.name === "tests");
  if (!tests) throw new Error("expected the tests terminal");

  // Output written while the socket is down reaches the page only through the replay.
  act(() => {
    app.daemon.disconnectAll();
    terminals.output(tests.id, "watching for changes…\r\n");
  });
  expect(output(panel, "tests output").textContent).not.toContain("watching for changes");

  await waitFor(() =>
    expect(output(panel, "tests output").textContent).toContain("watching for changes…"),
  );
  const after = output(panel, "tests output").textContent ?? "";
  expect(after.split("3 pass").length - 1).toBe(1);
  expect(after.split("watching for changes").length - 1).toBe(1);
  await waitFor(() => expect(within(panel).queryByRole("status")).toBeNull());
});

test("Clear empties the terminal that is showing", async () => {
  const { panel } = await openTerminal();
  await userEvent.click(await within(panel).findByRole("tab", { name: "tests" }));
  expect(output(panel, "tests output").textContent).toContain("3 pass");
  await userEvent.click(within(panel).getByRole("button", { name: "Clear terminal" }));
  await waitFor(() => expect(output(panel, "tests output").textContent).toBe(""));
  expect(tab(panel, "tests").getAttribute("aria-selected")).toBe("true");
});

test("a long background shell shows its latest output, and the whole of it on request", async () => {
  const { app, panel } = await openTerminal();
  const lines = Array.from(
    { length: 120 },
    (_, n) => `client ios-${n} connected · resume seq ${n}\n`,
  );
  act(() => app.daemon.apply("thread-cold-start", [facts.output("root", "relay", lines.join(""))]));
  await within(panel).findByText("Showing the latest output.", { exact: false });
  const shell = output(panel, "relay:soak output");
  await waitFor(() => expect(shell.textContent).toContain("client ios-119 connected"));
  expect(shell.textContent).not.toContain("soak relay listening");

  await userEvent.click(within(panel).getByRole("button", { name: "Show full output" }));
  await waitFor(() =>
    expect(output(panel, "relay:soak output").textContent).toContain(
      "soak relay listening on ws://127.0.0.1:8790",
    ),
  );
  expect(output(panel, "relay:soak output").textContent).toContain("client ios-119 connected");
});

test("a terminal that fell further behind than the daemon keeps starts again from what it holds", async () => {
  const { app, panel, terminals } = await openTerminal();
  await userEvent.click(await within(panel).findByRole("tab", { name: "tests" }));
  await waitFor(() => expect(output(panel, "tests output").textContent).toContain("3 pass"));
  const tests = terminals.list("thread-cold-start").find((info) => info.name === "tests");
  if (!tests) throw new Error("expected the tests terminal");

  // While the socket is down, the build prints more than the daemon's scrollback ring holds.
  const block = (n: number) => `${`chunk ${n} `.padEnd(20_000, ".")}\r\n`;
  act(() => {
    app.daemon.disconnectAll();
    for (let n = 1; n <= 5; n++) terminals.output(tests.id, block(n));
    terminals.output(tests.id, "build finished\r\n");
  });

  await waitFor(() =>
    expect(output(panel, "tests output").textContent).toContain("build finished"),
  );
  // What the ring dropped is gone from the screen too, rather than spliced in out of order.
  expect(output(panel, "tests output").textContent).not.toContain("3 pass");
});
