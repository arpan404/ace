import { workbench } from "@ace/fake-daemon";
import { fireEvent, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { openProfileMenu } from "@/test/navigation.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());
async function open(path = "/t/thread-checkout") {
  const app = harness({ storage: memoryKeyValue() });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open(path);
  await screen.findByRole("navigation", { name: "Threads" }, { timeout: 10000 });
  if (path.startsWith("/t/"))
    await screen.findByRole("feed", { name: "Transcript" }, { timeout: 10000 });
  return app;
}

test("Add opens without editing or persisting the draft and slash commands still open after Escape", async () => {
  const app = await open("/t/thread-pdf-locale");
  const message = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.click(screen.getByRole("button", { name: "Add files and context" }));
  await screen.findByRole("listbox", { name: "Add" });
  expect(message.textContent).toBe("");
  await userEvent.keyboard("{Escape}");
  cleanup();
  await app.open("/t/thread-pdf-locale");
  const restored = await screen.findByRole("combobox", { name: "Message" });
  expect(restored.textContent).toBe("");
  await userEvent.type(restored, "/");
  expect(await screen.findByRole("listbox", { name: "Commands" })).toBeTruthy();
});

test("Delete asks before removing an idle thread, and Escape preserves it", async () => {
  await open("/");
  const threads = screen.getByRole("navigation", { name: "Threads" });
  const link = await within(threads).findByRole("link", { name: /Invoice PDF/ });
  await userEvent.pointer({ keys: "[MouseRight]", target: link });
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete thread" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete thread?" });
  expect(link.isConnected).toBe(true);
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Delete thread?" })).toBeNull();
  await userEvent.pointer({ keys: "[MouseRight]", target: link });
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete thread" }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Delete thread?" })).getByRole("button", {
      name: "Delete",
    }),
  );
  await waitFor(() =>
    expect(within(threads).queryByRole("link", { name: /Invoice PDF/ })).toBeNull(),
  );
  expect(dialog.isConnected).toBe(false);
});

test("a running thread describes the work that will stop before deletion", async () => {
  await open("/");
  const threads = screen.getByRole("navigation", { name: "Threads" });
  const link = await within(threads).findByRole("link", { name: /Dedupe thread events/ });
  await userEvent.pointer({ keys: "[MouseRight]", target: link });
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete thread" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete thread?" });
  expect(dialog.textContent).toMatch(/agent.*running/);
  await userEvent.click(within(dialog).getByRole("button", { name: "Stop and delete" }));
  await waitFor(() =>
    expect(within(threads).queryByRole("link", { name: /Dedupe thread events/ })).toBeNull(),
  );
});

test("an empty fresh diff does not claim saved uncommitted counts", async () => {
  await open();
  await userEvent.keyboard("{Shift>}{Meta>}d{/Meta}{/Shift}");
  expect(await screen.findByText("No uncommitted changes")).toBeTruthy();
  expect(screen.queryByRole("status", { name: "Working tree" })).toBeNull();
  const tabs = screen.getAllByRole("tab");
  expect(tabs.every((tab) => !/\+27|−11/.test(tab.textContent ?? ""))).toBe(true);
});

test("an approval is explained once in its inline request", async () => {
  await open("/t/thread-retry-budget");
  await screen.findByRole("region", { name: "Waiting for you" });
  expect(
    within(screen.getByRole("feed", { name: "Transcript" })).queryAllByText(
      /Waiting for your approval/,
    ),
  ).toHaveLength(0);
  expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();
});

test("a pending question has one inline prompt and no repeated transcript request", async () => {
  await open("/t/thread-sheet-rotate");
  const request = await screen.findByRole("region", { name: "Waiting for you" });
  expect(within(request).getAllByRole("radio").length).toBeGreaterThan(1);
  expect(
    within(screen.getByRole("feed", { name: "Transcript" })).queryByText(
      /Waiting for your answer|Answer below/,
    ),
  ).toBeNull();
});

test("the shortcut sheet opens with Command slash, question mark and the profile menu", async () => {
  await open();
  await userEvent.keyboard("{Meta>}/{/Meta}");
  const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
  expect(within(sheet).getByText("Rename the thread")).toBeTruthy();
  await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull(),
  );
  fireEvent.keyDown(document.body, { key: "?", code: "Slash", shiftKey: true });
  const second = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
  await waitFor(() => expect(second.contains(document.activeElement)).toBe(true));
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull(),
  );
  await openProfileMenu();
  await userEvent.click(await screen.findByRole("menuitem", { name: "Keyboard shortcuts" }));
  expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
});

test("the shortcut sheet lists the keys saved by the person", async () => {
  const app = harness();
  app.daemon.services.settings.seed({ "clients.keybindings": { renameThread: "alt+mod+y" } });
  await app.open("/");
  await userEvent.keyboard("{Meta>}/{/Meta}");
  const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
  expect(within(sheet).getByText(/Alt\+Ctrl\+Y/)).toBeTruthy();
});

test("fresh diff counts describe the displayed patch once even when saved counts disagree", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setGitDiff(
    "thread-checkout",
    "diff --git a/readme.md b/readme.md\n--- a/readme.md\n+++ b/readme.md\n@@ -1 +1,2 @@\n existing\n+fresh line\n",
  );
  await app.open("/t/thread-checkout");
  await userEvent.keyboard("{Shift>}{Meta>}d{/Meta}{/Shift}");
  expect((await screen.findByLabelText("Uncommitted diff")).textContent).toContain("+fresh line");
  const toolbar = screen.getByRole("toolbar", { name: "Changes" });
  expect(toolbar.textContent).toContain("+1");
  expect(screen.getAllByText("+1").length).toBe(1);
  expect(screen.queryByText("No uncommitted changes")).toBeNull();
});
