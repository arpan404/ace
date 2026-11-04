import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const worktrees = async () => {
  const heading = await screen.findByText("Worktrees");
  const section = heading.closest("section");
  if (!section) throw new Error("No Worktrees section");
  return within(section);
};

test("Agents › Worktrees shows the machine's worktree preparation timeout and saves it", async () => {
  const app = harness();
  await app.open("/settings/agents");
  const field = await (
    await worktrees()
  ).findByRole("spinbutton", { name: "Preparation timeout in minutes" });
  await waitFor(() => expect(field).toHaveProperty("value", "10"));

  await userEvent.clear(field);
  await userEvent.type(field, "15{Enter}");
  await waitFor(() =>
    expect(app.daemon.services.settings.get("worktree.preparationTimeoutMs")).toBe(900_000),
  );
  expect(field).toHaveProperty("value", "15");

  await userEvent.clear(field);
  await userEvent.type(field, "0{Enter}");
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Use 1 to 60 minutes.");
  expect(app.daemon.services.settings.get("worktree.preparationTimeoutMs")).toBe(900_000);
});

test("using worktrees, their timeout and backing them up sit together on Agents", async () => {
  const app = harness();
  await app.open("/settings/agents");
  const section = await worktrees();
  expect(section.getByRole("switch", { name: "New threads use a worktree" })).toBeTruthy();
  expect(section.getByRole("spinbutton", { name: "Preparation timeout in minutes" })).toBeTruthy();
  const backup = section.getByRole("switch", { name: "Back up worktrees to origin" });
  await waitFor(() => expect(backup.hasAttribute("disabled")).toBe(false));
  await userEvent.click(backup);
  await waitFor(() =>
    expect(app.daemon.services.settings.get("storage.backupWorktrees")).toBe(true),
  );
});

test("Advanced and Storage no longer hold worktree timeout or backup", async () => {
  await harness().open("/settings/advanced");
  await screen.findByRole("heading", { name: "Advanced", level: 2 });
  expect(screen.queryByRole("spinbutton", { name: "Preparation timeout in minutes" })).toBeNull();

  await harness().open("/settings/storage");
  await screen.findByRole("switch", { name: "Automatic worktree deletion" });
  expect(screen.queryByRole("switch", { name: "Back up worktrees to origin" })).toBeNull();
});

test("searching for the worktree timeout opens Agents", async () => {
  await harness().open("/settings/general");
  await userEvent.type(
    await screen.findByRole("searchbox", { name: "Search settings" }),
    "worktree timeout",
  );
  await userEvent.click(await screen.findByRole("link", { name: /Worktree preparation timeout/ }));
  await screen.findByRole("heading", { name: "Agents", level: 2 });
  expect(document.getElementById("worktree.preparationTimeout")).not.toBeNull();
});
