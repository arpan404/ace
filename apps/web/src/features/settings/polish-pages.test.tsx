import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

// Like the app harness, warm deferred modules before test deadlines start.
await Promise.all([
  import("./agents-page.tsx"),
  import("./pair-device.tsx"),
  import("./prompts-page.tsx"),
]);
beforeEach(() => localStorage.clear());

test("Agents finishes loading and keyboard changes are stored", async () => {
  const app = harness();
  await app.open("/settings/agents");
  const worktree = await screen.findByRole("switch", { name: "New threads use a worktree" });
  await userEvent.click(worktree);
  worktree.focus();
  await userEvent.keyboard(" ");
  await waitFor(() => expect(app.daemon.services.settings.get("threads.useWorktree")).toBe(true));
});

test("keyboard users can read a compact switch hint and still change its setting", async () => {
  await harness().open("/settings/notifications");
  const control = await screen.findByRole("switch", { name: "Needs you", checked: true });
  control.focus();
  await userEvent.tab({ shift: true });
  expect(
    await screen.findByRole("tooltip", { name: "Approvals, questions and plans." }),
  ).toBeTruthy();
  await userEvent.tab();
  expect(document.activeElement).toBe(control);
  await userEvent.keyboard(" ");
  await screen.findByRole("switch", { name: "Needs you", checked: false });
});

test("settings search reveals and highlights the pairing control before it opens", async () => {
  await harness().open("/settings/general");
  await userEvent.type(
    await screen.findByRole("searchbox", { name: "Search settings" }),
    "Pair a device",
  );
  await userEvent.click(
    await screen.findByRole("link", { name: /Pair a device.*Machines and devices/ }),
  );
  const button = await screen.findByRole("button", { name: "Pair a device" });
  await waitFor(() => expect(button.closest(".bg-accent")).not.toBeNull());
  expect(screen.queryByRole("dialog", { name: "Pair a device" })).toBeNull();
  await userEvent.click(button);
  expect(await screen.findByRole("dialog", { name: "Pair a device" })).toBeTruthy();
});

test("pair opens pairing instead of a thread and creates a code only when requested", async () => {
  await harness().open("/pair");
  await screen.findByRole("heading", { level: 2, name: "Pair a device" });
  expect(screen.queryByRole("feed", { name: "Transcript" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Pairing link" })).toBeNull();
  await userEvent.click(await screen.findByRole("button", { name: "Show pairing code" }));
  expect(await screen.findByRole("textbox", { name: "Pairing link" })).toBeTruthy();
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
