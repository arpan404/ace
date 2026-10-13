import { flakyCheckout, workbench } from "@ace/fake-daemon";
import { configure, fireEvent, cleanup, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { openProfileMenu } from "@/test/navigation.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

beforeEach(() => localStorage.clear());
async function open(path = "/t/thread-checkout") {
  const app = harness({ storage: memoryKeyValue() });
  for (const scenario of [...workbench(), flakyCheckout()]) app.play(scenario).runUntilBlocked();
  await app.open(path);
  await screen.findByRole("navigation", { name: "Threads" }, { timeout: 10000 });
  if (path.startsWith("/t/"))
    await screen.findByRole("button", { name: /^Model:/ }, { timeout: 10000 });
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

test("Add keeps the draft and accepts a context choice with the keyboard", async () => {
  await open("/t/thread-pdf-locale");
  const message = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(message, "Keep this draft");
  await userEvent.click(screen.getByRole("button", { name: "Add files and context" }));
  const menu = await screen.findByRole("listbox", { name: "Add" });
  expect(document.activeElement).toBe(message);
  expect(message.textContent).toBe("Keep this draft");
  const choices = within(menu).getAllByRole("option");
  const files = choices.findIndex((choice) => choice.textContent?.includes("Files and folders"));
  expect(files).toBeGreaterThanOrEqual(0);
  for (let index = 0; index < files; index++) await userEvent.keyboard("{ArrowDown}");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(message.textContent).toBe("Keep this draft @ "), { timeout: 1000 });
  expect(await screen.findByRole("listbox", { name: "Files and threads" })).toBeTruthy();
  expect(message.textContent).toBe("Keep this draft @ ");
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
  await screen.findByRole("button", { name: "Right panel" }, { timeout: 10000 });
  await userEvent.keyboard("{Shift>}{Meta>}d{/Meta}{/Shift}");
  expect(await screen.findByText("No uncommitted changes")).toBeTruthy();
  expect(screen.queryByRole("status", { name: "Working tree" })).toBeNull();
  const tabs = screen.getAllByRole("tab");
  expect(tabs.every((tab) => !/\+27|−11/.test(tab.textContent ?? ""))).toBe(true);
});

test("an approval is explained once in its inline request", async () => {
  await open("/t/thread-retry-budget");
  const strip = await screen.findByRole("region", { name: "Waiting for you" });
  const card = await within(strip).findByRole("article");
  // The transcript only points at it.
  const feed = screen.getByRole("feed", { name: "Transcript" });
  expect(
    within(feed).queryByRole("article", { name: card.getAttribute("aria-label") ?? "" }),
  ).toBeNull();
  // Beyond the live head's own status line, which names the wait.
  expect(
    within(feed)
      .queryAllByText(/Waiting for your approval/)
      .every((mention) => mention.closest("a") || inLiveHead(mention)),
  ).toBe(true);
  expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();
});

test("a pending question has one inline prompt and no repeated transcript request", async () => {
  await open("/t/thread-sheet-rotate");
  const request = await screen.findByRole("region", { name: "Waiting for you" });
  expect(within(request).getAllByRole("radio").length).toBeGreaterThan(1);
  const feed = screen.getByRole("feed", { name: "Transcript" });
  expect(within(feed).queryByText("How should the sheet recover after rotate?")).toBeNull();
  expect(within(feed).queryByText(/Answer below/)).toBeNull();
  // The live head names the wait once; nothing else in the transcript repeats it.
  expect(
    within(feed)
      .queryAllByText(/Waiting for your answer/)
      .filter((mention) => !inLiveHead(mention)),
  ).toHaveLength(0);
});

const inLiveHead = (element: Element) =>
  !!element.closest('[role="group"][aria-label="Turn in progress"]');

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
  for (const scenario of [...workbench(), flakyCheckout()]) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setGitDiff(
    "thread-checkout",
    "diff --git a/readme.md b/readme.md\n--- a/readme.md\n+++ b/readme.md\n@@ -1 +1,2 @@\n existing\n+fresh line\n",
  );
  await app.open("/t/thread-checkout");
  await screen.findByRole("button", { name: "Right panel" }, { timeout: 10000 });
  await userEvent.keyboard("{Shift>}{Meta>}d{/Meta}{/Shift}");
  expect((await screen.findByLabelText("Uncommitted diff")).textContent).toContain("+fresh line");
  const toolbar = screen.getByRole("toolbar", { name: "Changes" });
  expect(toolbar.textContent).toContain("+1");
  expect(screen.getAllByText("+1").length).toBe(1);
  expect(screen.queryByText("No uncommitted changes")).toBeNull();
});
