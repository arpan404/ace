import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => localStorage.clear());

async function row(provider: string, name: string) {
  const list = await screen.findByRole("list", { name: `${provider} accounts` });
  const item = (await within(list).findByText(name)).closest("li");
  if (!item) throw new Error(`No ${name} row`);
  return item;
}

test("a signed-out default account leads the page with Sign in, and the line goes once it's signed in", async () => {
  const app = harness();
  await app.open("/settings/providers/codex");
  const words = await screen.findByText(
    "Your CLI login is signed out, so new threads can't start on it.",
  );
  const line = words.closest<HTMLElement>('[role="status"]');
  if (!line) throw new Error("The problem isn't a status line");
  await userEvent.click(within(line).getByRole("button", { name: "Sign in to Codex" }));
  await screen.findByRole("dialog", { name: "Sign in to Codex" });
  app.daemon.services.providerLogin.complete("fake-login-1");
  await waitFor(() =>
    expect(
      screen.queryByText("Your CLI login is signed out, so new threads can't start on it."),
    ).toBeNull(),
  );
  expect(screen.queryByRole("button", { name: "Sign in to Codex" })).toBeNull();
});

test("a provider that is ready shows no problem line", async () => {
  await harness().open("/settings/providers/claude");
  await row("Claude Code", "Personal");
  expect(screen.queryByText(/so new threads can't start/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Sign in to Claude Code" })).toBeNull();
});

test("an account's menu offers Remove account, which asks first with Cancel focused and then removes the row", async () => {
  await harness().open("/settings/providers/claude");
  const work = await row("Claude Code", "Work");
  await userEvent.click(within(work).getByRole("button", { name: "Manage Work" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Remove account…" }));
  const dialog = await screen.findByRole("dialog", { name: "Remove Work from Claude Code?" });
  await waitFor(() =>
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })),
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Remove account" }));
  const list = await screen.findByRole("list", { name: "Claude Code accounts" });
  await waitFor(() => expect(within(list).queryByText("Work")).toBeNull());
  expect(within(list).getByText("Personal")).toBeTruthy();
});

test("Make default moves the Default tag to the chosen account", async () => {
  await harness().open("/settings/providers/claude");
  const cli = await row("Claude Code", "Your CLI login");
  expect(within(cli).getByText("Default")).toBeTruthy();
  const personal = await row("Claude Code", "Personal");
  expect(within(personal).queryByText("Default")).toBeNull();
  await userEvent.click(within(personal).getByRole("button", { name: "Make default" }));
  await within(personal).findByText("Default");
  await waitFor(() => expect(within(cli).queryByText("Default")).toBeNull());
  expect(within(personal).queryByRole("button", { name: "Make default" })).toBeNull();
  expect(within(cli).getByRole("button", { name: "Make default" })).toBeTruthy();
});
