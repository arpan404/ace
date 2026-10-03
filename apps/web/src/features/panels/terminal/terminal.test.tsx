import { FakeTerminals, coldStartReplay } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { panelServices } from "../services.ts";

async function openTerminal(through = "turn-2") {
  const app = harness();
  const script = app.play(coldStartReplay());
  script.runThrough(through);
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}`{/Control}");
  const panel = await screen.findByRole("region", { name: "Bottom panel" });
  const terminals = (await panelServices(app.client)).terminals.source;
  if (!(terminals instanceof FakeTerminals)) throw new Error("expected the fake terminal service");
  return { app, script, panel, terminals };
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

test("New terminal opens another shell in the thread's directory and Close ends it", async () => {
  const { panel, terminals } = await openTerminal();
  await userEvent.click(within(panel).getByRole("button", { name: "New terminal" }));
  const opened = await within(panel).findByRole("tab", { name: "zsh 2", selected: true });
  await userEvent.type(within(panel).getByRole("textbox", { name: "zsh 2 input" }), "pwd{Enter}");
  await waitFor(() =>
    expect(output(panel, "zsh 2 output").textContent).toContain("/Users/dev/ace"),
  );

  await userEvent.click(within(panel).getByRole("button", { name: "Close zsh 2" }));
  await waitFor(() => expect(opened.isConnected).toBe(false));
  expect(terminals.list("thread-cold-start").map((info) => info.name)).toEqual(["tests", "zsh"]);
});

test("after a dropped connection the terminal replays only the output it missed", async () => {
  const { panel, terminals } = await openTerminal();
  await userEvent.click(await within(panel).findByRole("tab", { name: "tests" }));
  const before = output(panel, "tests output").textContent ?? "";
  expect(before).toContain("3 pass");
  const tests = terminals.list("thread-cold-start").find((info) => info.name === "tests");
  if (!tests) throw new Error("expected the tests terminal");

  act(() => terminals.disconnect());
  await within(panel).findByRole("status");
  expect(within(panel).getByRole("status").textContent).toContain("Reconnecting");
  act(() => terminals.output(tests.id, "watching for changes…\r\n"));
  expect(output(panel, "tests output").textContent).not.toContain("watching for changes");

  act(() => terminals.reconnect());
  await waitFor(() =>
    expect(output(panel, "tests output").textContent).toContain("watching for changes…"),
  );
  const after = output(panel, "tests output").textContent ?? "";
  expect(after.split("3 pass").length - 1).toBe(1);
  expect(after.split("watching for changes").length - 1).toBe(1);
  expect(within(panel).queryByRole("status")).toBeNull();
});

test("Clear empties the terminal that is showing", async () => {
  const { panel } = await openTerminal();
  await userEvent.click(await within(panel).findByRole("tab", { name: "tests" }));
  expect(output(panel, "tests output").textContent).toContain("3 pass");
  await userEvent.click(within(panel).getByRole("button", { name: "Clear terminal" }));
  await waitFor(() => expect(output(panel, "tests output").textContent).toBe(""));
  expect(tab(panel, "tests").getAttribute("aria-selected")).toBe("true");
});
