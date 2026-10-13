import { flakyCheckout, workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });
beforeEach(() => localStorage.clear());

const threadId = "thread-checkout";

/** The workbench, opened on the checkout thread: working, with an approval waiting. */
async function openThread() {
  const app = harness();
  for (const scenario of [...workbench(), flakyCheckout()]) app.play(scenario).runUntilBlocked();
  await app.open(`/t/${threadId}`);
  await screen.findByRole("heading", { level: 1, name: "Fix flaky checkout test" });
  await screen.findByRole("combobox", { name: "Message" });
  return app;
}

const launcher = () => screen.findByRole("combobox", { name: "Search commands" });

/** Type into the launcher and run the option whose name starts with `name`. */
async function run(words: string, name: RegExp) {
  await userEvent.keyboard("{Meta>}k{/Meta}");
  await userEvent.type(await launcher(), words);
  await userEvent.click(await screen.findByRole("option", { name }));
}

test("⌘K, ⇧⌘K and the sidebar's Search all open the one launcher", async () => {
  await openThread();
  await userEvent.keyboard("{Meta>}k{/Meta}");
  expect(await launcher()).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("combobox", { name: "Search commands" })).toBeNull(),
  );
  await userEvent.keyboard("{Shift>}{Meta>}k{/Meta}{/Shift}");
  expect(await launcher()).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Search every thread" })).toBeNull();
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("combobox", { name: "Search commands" })).toBeNull(),
  );
  await userEvent.click(
    within(screen.getByRole("navigation", { name: "App" })).getByRole("button", { name: "Search" }),
  );
  expect(await launcher()).toBeTruthy();
});

test("typing approve answers the open thread's approval from the launcher", async () => {
  const app = await openThread();
  await run("approve", /^Allow once/);
  await waitFor(() =>
    expect(app.daemon.resolution(threadId, "approve-clear-cache")).toMatchObject({
      kind: "approval",
    }),
  );
});

test("typing stop stops the open thread's agent", async () => {
  const app = await openThread();
  await run("stop", /^Stop the agent/);
  await waitFor(() => {
    const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(threadId) });
    const state = view && "thread" in view ? view.thread.status.state : undefined;
    expect(state).not.toBe("working");
  });
});

test("typing model opens the model list, and effort the effort slider", async () => {
  await openThread();
  await run("model", /^Switch model/);
  const list = await screen.findByRole("dialog", { name: "Model and effort" });
  expect(await within(list).findByRole("combobox", { name: "Search models" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Model and effort" })).toBeNull(),
  );
  await run("effort", /^Change effort/);
  const tune = await screen.findByRole("dialog", { name: "Model and effort" });
  expect(await within(tune).findByRole("slider", { name: "Effort" })).toBeTruthy();
});

test("typing dark switches the app to dark mode", async () => {
  await openThread();
  await run("dark", /^Dark mode/);
  await waitFor(() => expect(document.documentElement.getAttribute("data-scheme")).toBe("dark"));
});

test("choosing a thread from the launcher puts the caret in its composer", async () => {
  await openThread();
  await run("replay", /Dedupe thread events after reconnect/);
  await screen.findByRole("heading", { level: 1, name: "Dedupe thread events after reconnect" });
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Message" })),
  );
});
