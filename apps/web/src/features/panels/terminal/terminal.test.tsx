import { coldStartReplay, facts, seedPanels } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

/**
 * The cold-start thread with two shells of yours already running in the daemon (`tests`, which
 * ran the test suite, and `zsh`, which ran git status) and the agent's background soak relay.
 * ⌃` shows the thread's terminal as a tab of the side panel.
 */
async function openTerminal(through = "turn-2") {
  const app = harness();
  const script = app.play(coldStartReplay());
  script.runThrough(through);
  seedPanels(app.daemon);
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}`{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  return { app, script, panel, terminals: app.daemon.terminals };
}
const names = (app: ReturnType<typeof harness>) =>
  app.daemon.terminals.list("thread-cold-start").map((info) => info.name);
const output = (panel: HTMLElement, name: string) => within(panel).getByRole("log", { name });
const selectedTab = (panel: HTMLElement, name: string) =>
  within(panel).findByRole("tab", { name, selected: true });
/** About 20 KB of build output, so a few of them overflow the daemon's 64 KiB ring. */
const block = (n: number) => `${`chunk ${n} `.padEnd(20_000, ".")}\r\n`;

async function openSession(panel: HTMLElement, name: RegExp) {
  await userEvent.click(within(panel).getByRole("button", { name: /^Terminal sessions/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name }));
}
/** New terminal, from the sessions menu a terminal tab shows. */
const newTerminal = (panel: HTMLElement) => openSession(panel, /^New terminal/);

test("⌃` picks up a running shell of the thread that no tab shows, rather than starting another", async () => {
  const { app, panel } = await openTerminal();
  expect(await selectedTab(panel, "zsh")).toBeTruthy();
  await waitFor(() =>
    expect(output(panel, "zsh output").textContent).toContain("M apps/server/src/replay.ts"),
  );
  expect(names(app)).toEqual(["tests", "zsh"]);
});

test("typing into a terminal runs the command in the thread's worktree", async () => {
  const { panel, terminals } = await openTerminal();
  await selectedTab(panel, "zsh");
  await userEvent.type(
    await within(panel).findByRole("textbox", { name: "zsh input" }),
    "git branch{Enter}",
  );
  await waitFor(() =>
    expect(output(panel, "zsh output").textContent).toContain("* fix/replay-dedupe"),
  );
  expect(terminals.received.map((entry) => entry.data).join("")).toBe("git branch\r");
});

test("a shell that exits says so, takes no more input and can start again in the same tab", async () => {
  const { app, panel } = await openTerminal();
  await selectedTab(panel, "zsh");
  await userEvent.type(
    await within(panel).findByRole("textbox", { name: "zsh input" }),
    "exit{Enter}",
  );
  expect(await within(panel).findByText("The shell exited with code 0.")).toBeTruthy();
  expect(
    (within(panel).getByRole("textbox", { name: "zsh input" }) as HTMLTextAreaElement).disabled,
  ).toBe(true);

  await userEvent.click(within(panel).getByRole("button", { name: "Restart" }));
  await waitFor(() => expect(names(app)).toEqual(["tests", "zsh 2"]));
  // The new shell keeps the tab's place and name.
  expect(await selectedTab(panel, "zsh")).toBeTruthy();
  await userEvent.type(
    await within(panel).findByRole("textbox", { name: "zsh input" }),
    "pwd{Enter}",
  );
  await waitFor(() => expect(output(panel, "zsh output").textContent).toContain("/Users/dev/ace"));
});

test("New terminal opens another shell named after the first (zsh 2), and closing its tab ends that shell", async () => {
  const { app, panel } = await openTerminal();
  await selectedTab(panel, "zsh");
  await newTerminal(panel);
  expect(await selectedTab(panel, "zsh 2")).toBeTruthy();
  await userEvent.type(
    await within(panel).findByRole("textbox", { name: "zsh 2 input" }),
    "pwd{Enter}",
  );
  await waitFor(() =>
    expect(output(panel, "zsh 2 output").textContent).toContain("/Users/dev/ace"),
  );
  expect(names(app)).toEqual(["tests", "zsh", "zsh 2"]);

  await userEvent.click(within(panel).getByRole("button", { name: "End session zsh 2" }));
  const ask = await screen.findByRole("dialog", { name: "End zsh 2?" });
  await userEvent.click(within(ask).getByRole("button", { name: "End" }));
  await waitFor(() => expect(names(app)).toEqual(["tests", "zsh"]));
  expect(within(panel).queryByRole("tab", { name: "zsh 2" })).toBeNull();
});

test("closing a running shell's tab asks first: Cancel keeps the tab and its shell", async () => {
  const { app, panel } = await openTerminal();
  const tab = await selectedTab(panel, "zsh");
  tab.focus();
  await userEvent.keyboard("{Delete}");
  const ask = await screen.findByRole("dialog", { name: "End zsh?" });
  expect(ask.textContent).toContain("Its shell and anything running in it stop.");
  await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(within(panel).getByRole("tab", { name: "zsh", selected: true })).toBeTruthy();
  expect(names(app)).toEqual(["tests", "zsh"]);

  // The tab's own menu asks the same question.
  within(panel).getByRole("tab", { name: "zsh" }).focus();
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  await userEvent.click(await screen.findByRole("menuitem", { name: /^End session/ }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "End zsh?" })).getByRole("button", {
      name: "Cancel",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(names(app)).toEqual(["tests", "zsh"]);

  // ⌥⌘W asks as well, and End ends it.
  await userEvent.keyboard("{Alt>}{Meta>}w{/Meta}{/Alt}");
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "End zsh?" })).getByRole("button", {
      name: "End",
    }),
  );
  await waitFor(() => expect(names(app)).toEqual(["tests"]));
});

test("a shell that already exited closes without asking", async () => {
  const { app, panel } = await openTerminal();
  await selectedTab(panel, "zsh");
  await userEvent.type(
    await within(panel).findByRole("textbox", { name: "zsh input" }),
    "exit{Enter}",
  );
  await within(panel).findByText("The shell exited with code 0.");
  await userEvent.click(within(panel).getByRole("button", { name: "End session zsh" }));
  await waitFor(() => expect(within(panel).queryByRole("tab", { name: "zsh" })).toBeNull());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(names(app)).toContain("tests");
});

test("the panel's + opens a new tab's launcher beside the terminals", async () => {
  const { panel } = await openTerminal();
  await selectedTab(panel, "zsh");
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  expect(await selectedTab(panel, "New tab")).toBeTruthy();
  expect(await within(panel).findByRole("list", { name: "Tools" })).toBeTruthy();
  expect(within(panel).getByRole("tab", { name: "zsh" })).toBeTruthy();
});

test("hiding the side panel keeps every shell, and ⌘J returns to the same one", async () => {
  const { app, panel } = await openTerminal();
  await selectedTab(panel, "zsh");
  await userEvent.click(within(panel).getByRole("button", { name: "Right panel" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());
  expect(names(app)).toEqual(["tests", "zsh"]);

  await userEvent.keyboard("{Meta>}j{/Meta}");
  const shown = await screen.findByRole("region", { name: "Thread panel" });
  expect(await selectedTab(shown, "zsh")).toBeTruthy();
  await waitFor(() =>
    expect(output(shown, "zsh output").textContent).toContain("M apps/server/src/replay.ts"),
  );
});

test("the sessions menu lists your shells and the agents', and opens one as a tab", async () => {
  const { panel } = await openTerminal();
  await selectedTab(panel, "zsh");
  // `tests` and the agent's soak relay run without a tab.
  expect(
    within(panel).getByRole("button", { name: "Terminal sessions, 2 not shown" }),
  ).toBeTruthy();
  await openSession(panel, /^tests/);
  expect(await selectedTab(panel, "tests")).toBeTruthy();
  await waitFor(() => expect(output(panel, "tests output").textContent).toContain("3 pass"));
  expect(
    within(panel).getByRole("button", { name: "Terminal sessions, 1 not shown" }),
  ).toBeTruthy();
});

test("an agent's background shell opens read-only, streams its output and keeps running when its tab closes", async () => {
  const { panel, script } = await openTerminal();
  await selectedTab(panel, "zsh");
  await openSession(panel, /^relay:soak/);
  expect(await selectedTab(panel, "relay:soak")).toBeTruthy();
  expect(await within(panel).findByText("Agent shell")).toBeTruthy();
  expect(output(panel, "relay:soak output").textContent).toContain(
    "soak relay listening on ws://127.0.0.1:8790",
  );
  // The agent owns it: nothing to type into, and no take-over the daemon could honour.
  expect(within(panel).queryByRole("textbox", { name: /relay:soak/ })).toBeNull();
  expect(
    within(panel).getByRole("button", { name: "Take over (unavailable)" }).hasAttribute("disabled"),
  ).toBe(true);

  await act(async () => script.runThrough("relay-output"));
  await waitFor(() =>
    expect(output(panel, "relay:soak output").textContent).toContain(
      "client ios-2 connected · resume seq 0 · cold start",
    ),
  );

  await userEvent.click(within(panel).getByRole("button", { name: "Close relay:soak" }));
  await waitFor(() => expect(within(panel).queryByRole("tab", { name: "relay:soak" })).toBeNull());
  expect(screen.getByRole("group", { name: /Background task bun run relay:soak/ })).toHaveProperty(
    "textContent",
    expect.stringContaining("Running in background"),
  );
});

test("the transcript's background command opens its shell's output", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await userEvent.click(
    await screen.findByRole("button", { name: "Show output of bun run relay:soak --clients 2" }),
  );
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(await selectedTab(panel, "relay:soak")).toBeTruthy();
});

test("after a dropped connection the terminal replays only the output it missed", async () => {
  const { app, panel, terminals } = await openTerminal();
  await selectedTab(panel, "zsh");
  await openSession(panel, /^tests/);
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
  await waitFor(() => expect(within(panel).queryByText(/Reconnecting/)).toBeNull());
});

test("Clear empties the terminal that is showing and leaves the shell running", async () => {
  const { app, panel } = await openTerminal();
  await openSession(panel, /^tests/);
  await waitFor(() => expect(output(panel, "tests output").textContent).toContain("3 pass"));
  await userEvent.click(within(panel).getByRole("button", { name: "Terminal actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Clear terminal" }));
  await waitFor(() => expect(output(panel, "tests output").textContent).toBe(""));
  expect(await selectedTab(panel, "tests")).toBeTruthy();
  expect(names(app)).toEqual(["tests", "zsh"]);
});

test("a terminal renamed from its menu keeps the name on its tab", async () => {
  const { panel } = await openTerminal();
  await selectedTab(panel, "zsh");
  await userEvent.click(within(panel).getByRole("button", { name: "Terminal actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
  const field = await screen.findByRole("textbox", { name: "Name" });
  await userEvent.clear(field);
  await userEvent.type(field, "api server{Enter}");
  expect(await selectedTab(panel, "api server")).toBeTruthy();

  // Cleared, it goes back to the shell's own name.
  await userEvent.click(within(panel).getByRole("button", { name: "Terminal actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
  await userEvent.clear(await screen.findByRole("textbox", { name: "Name" }));
  await userEvent.keyboard("{Enter}");
  expect(await selectedTab(panel, "zsh")).toBeTruthy();
});

test("Find steps through matches in the scrollback, newest first, and Escape closes it", async () => {
  const { panel, terminals } = await openTerminal();
  await selectedTab(panel, "zsh");
  const zsh = terminals.list("thread-cold-start").find((info) => info.name === "zsh");
  if (!zsh) throw new Error("expected the zsh terminal");
  act(() => terminals.output(zsh.id, "replay ok\r\nreplay failed: seq 0\r\n"));
  await waitFor(() => expect(output(panel, "zsh output").textContent).toContain("replay failed"));

  await userEvent.click(within(panel).getByRole("button", { name: "Find" }));
  await userEvent.type(await within(panel).findByRole("searchbox", { name: "Find" }), "replay");
  // git status printed two paths with "replay" in them, then the two lines above.
  await waitFor(() => expect(within(panel).getByRole("status").textContent).toBe("4 of 4"));
  expect(
    within(panel).getByRole("log", { name: "zsh output" }).querySelector("mark")?.textContent,
  ).toBe("replay");
  await userEvent.keyboard("{Enter}");
  expect(within(panel).getByRole("status").textContent).toBe("1 of 4");
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  expect(within(panel).getByRole("status").textContent).toBe("4 of 4");

  await userEvent.keyboard("{Escape}");
  expect(within(panel).queryByRole("search")).toBeNull();
  expect(within(panel).getByRole("log", { name: "zsh output" }).querySelector("mark")).toBeNull();
});

test("a long background shell shows its latest output, and the whole of it on request", async () => {
  const { app, panel } = await openTerminal();
  await openSession(panel, /^relay:soak/);
  const lines = Array.from(
    { length: 120 },
    (_, n) => `client ios-${n} connected · resume seq ${n}\n`,
  );
  act(() => app.daemon.apply("thread-cold-start", [facts.output("root", "relay", lines.join(""))]));
  await within(panel).findByText("Showing the latest output.", { exact: false });
  await waitFor(() =>
    expect(output(panel, "relay:soak output").textContent).toContain("client ios-119 connected"),
  );
  expect(output(panel, "relay:soak output").textContent).not.toContain("soak relay listening");

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
  await openSession(panel, /^tests/);
  await waitFor(() => expect(output(panel, "tests output").textContent).toContain("3 pass"));
  const tests = terminals.list("thread-cold-start").find((info) => info.name === "tests");
  if (!tests) throw new Error("expected the tests terminal");

  // While the socket is down, the build prints more than the daemon's scrollback ring holds.
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

test("terminals you stopped looking at give their streams back, so the next one still shows output", async () => {
  const { panel } = await openTerminal();
  await selectedTab(panel, "zsh");
  // The daemon streams at most eight terminals to a connection.
  for (let n = 1; n <= 9; n++) {
    await newTerminal(panel);
    expect(await selectedTab(panel, `zsh ${n + 1}`)).toBeTruthy();
  }
  await userEvent.type(
    await within(panel).findByRole("textbox", { name: "zsh 10 input" }),
    "pwd{Enter}",
  );
  await waitFor(() =>
    expect(output(panel, "zsh 10 output").textContent).toContain("/Users/dev/ace"),
  );

  // Going back to the first replays what it printed.
  await userEvent.click(within(panel).getByRole("tab", { name: "zsh 2" }));
  await userEvent.type(
    await within(panel).findByRole("textbox", { name: "zsh 2 input" }),
    "pwd{Enter}",
  );
  await waitFor(() =>
    expect(output(panel, "zsh 2 output").textContent).toContain("/Users/dev/ace"),
  );
});

test("a tab whose shell the daemon no longer runs says it has ended and starts a new one in place", async () => {
  const { app, panel, terminals } = await openTerminal();
  await selectedTab(panel, "zsh");
  const zsh = terminals.list("thread-cold-start").find((info) => info.name === "zsh");
  if (!zsh) throw new Error("expected the zsh terminal");
  // The daemon restarted without it while the page was away.
  act(() => {
    app.daemon.disconnectAll();
    terminals.close(zsh.id);
  });
  expect(await within(panel).findByText("This terminal has ended")).toBeTruthy();

  await userEvent.click(within(panel).getByRole("button", { name: "Start a new terminal" }));
  expect(await selectedTab(panel, "Terminal")).toBeTruthy();
  await waitFor(() => expect(names(app)).toEqual(["tests", "Terminal"]));
});

test("Logs opens as a tab beside the terminal, and going back to the terminal still counts the unseen shells", async () => {
  const { panel } = await openTerminal();
  await selectedTab(panel, "zsh");
  await userEvent.keyboard("{Control>}{Shift>}l{/Shift}{/Control}");
  expect(await selectedTab(panel, "Logs")).toBeTruthy();
  expect(within(panel).getByRole("tab", { name: "zsh" })).toBeTruthy();
  await userEvent.click(within(panel).getByRole("tab", { name: "zsh" }));
  // `tests` and the agent's soak relay run in no tab.
  expect(
    await within(panel).findByRole("button", { name: "Terminal sessions, 2 not shown" }),
  ).toBeTruthy();
  expect(within(panel).getAllByRole("button", { name: /^Terminal sessions/ })).toHaveLength(1);
});
