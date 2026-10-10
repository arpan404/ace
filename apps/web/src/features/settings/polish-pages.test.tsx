import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

// Like the app harness, warm deferred modules before test deadlines start.
await Promise.all([
  import("./general-page.tsx"),
  import("./pair-device.tsx"),
  import("./theme-editor/theme-editor-page.tsx"),
  import("./prompts-page.tsx"),
]);
beforeEach(() => localStorage.clear());

test("General finishes loading and keyboard changes are stored", async () => {
  const app = harness();
  await app.open("/settings/general");
  const worktree = await screen.findByRole("switch", { name: "New threads use a worktree" });
  await userEvent.click(worktree);
  worktree.focus();
  await userEvent.keyboard(" ");
  await waitFor(() => expect(app.daemon.services.settings.get("threads.useWorktree")).toBe(true));
  expect(await screen.findByRole("textbox", { name: "Your name" })).toBeTruthy();
});

test("pair opens pairing instead of a thread and creates a code only when requested", async () => {
  await harness().open("/pair");
  await screen.findByRole("heading", { level: 2, name: "Pair a device" });
  expect(screen.queryByRole("feed", { name: "Transcript" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Pairing link" })).toBeNull();
  await userEvent.click(await screen.findByRole("button", { name: "Show pairing code" }));
  expect(await screen.findByRole("textbox", { name: "Pairing link" })).toBeTruthy();
});

test("computer use off shows access controls without an inactive emergency stop", async () => {
  await harness().open("/settings/computer-use");
  await screen.findByRole("switch", { name: "Let agents use apps" });
  expect(screen.queryByRole("button", { name: "Stop all computer use" })).toBeNull();
  expect(screen.queryByText(/^Stops every session at once/)).toBeNull();
  expect(screen.queryByText("Granted", { exact: true })).toBeNull();
});

test("theme editing keeps raw values behind Advanced and actions reachable by keyboard", async () => {
  await harness().open("/settings/theme-editor");
  expect(await screen.findByRole("combobox", { name: "Theme to edit" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Window background" })).toBeNull();
  const menu = screen.getByRole("button", { name: "Theme actions" });
  menu.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("menuitem", { name: "Duplicate" });
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(menu);
  await userEvent.click(within(screen.getByRole("main")).getByText("Advanced", { exact: true }));
  expect(await screen.findByRole("textbox", { name: "Window background" })).toBeTruthy();
});

test("prompt errors have a short label and clicking the title opens the editor", async () => {
  await harness().open("/settings/prompts");
  const files = await screen.findByRole("list", { name: "Prompt files" });
  expect(await within(files).findByText("Invalid frontmatter")).toBeTruthy();
  const title = within(files).getAllByRole("button")[0];
  if (!title) throw new Error("No prompt title");
  title.focus();
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByRole("textbox", { name: "Prompt content" })).toBeTruthy();
});
