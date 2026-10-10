import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());
const accounts = () =>
  screen.findByRole("list", { name: "Claude Code accounts" }, { timeout: 10_000 });
async function account(name: string) {
  const row = (await within(await accounts()).findByText(name)).closest("li");
  if (!row) throw new Error(`No ${name} row`);
  return row;
}
async function add() {
  await userEvent.click(within(await accounts()).getByRole("button", { name: "+ Add account" }));
  const dialog = await screen.findByRole("dialog", { name: "Add a Claude Code account" });
  return within(dialog);
}

test("adding an account focuses its name, waits in the same dialog and closes on success", async () => {
  const app = harness();
  await app.open("/settings/providers/claude");
  const dialog = await add();
  expect(document.activeElement).toBe(dialog.getByRole("textbox", { name: "Account name" }));
  await userEvent.type(dialog.getByRole("textbox", { name: "Account name" }), "Side project");
  await userEvent.click(dialog.getByRole("button", { name: "Use blue badge" }));
  await userEvent.click(dialog.getByRole("button", { name: "Add and sign in" }));
  await dialog.findByText("Waiting for you to finish signing in…", {}, { timeout: 10_000 });
  expect(dialog.getByRole("link", { name: "Open again" })).toBeTruthy();
  expect(
    (await app.client.request({ type: "accounts.list" })).accounts.some(
      (row) => row.label === "Side project",
    ),
  ).toBe(false);
  app.daemon.services.providerLogin.complete("fake-login-1");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Add a Claude Code account" })).toBeNull(),
  );
  expect(await account("Side project")).toBeTruthy();
  const saved = (await app.client.request({ type: "accounts.list" })).accounts.find(
    (row) => row.label === "Side project",
  );
  expect(saved?.badgeColor).toBe("blue");
});

test("failed sign-in explains the failure inline and Retry starts a fresh attempt", async () => {
  const app = harness();
  await app.open("/settings/providers/claude");
  const dialog = await add();
  await userEvent.type(dialog.getByRole("textbox", { name: "Account name" }), "Research");
  await userEvent.click(dialog.getByRole("button", { name: "Add and sign in" }));
  await dialog.findByRole("link", { name: "Open again" });
  app.daemon.services.providerLogin.complete("fake-login-1", false);
  await dialog.findByText("The provider declined sign-in. Try again.");
  await userEvent.click(dialog.getByRole("button", { name: /Try again|Retry/ }));
  await dialog.findByRole("link", { name: "Open again" });
  app.daemon.services.providerLogin.complete("fake-login-2");
  expect(await account("Research")).toBeTruthy();
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Add a Claude Code account" })).toBeNull(),
  );
});

test.each(["idle", "waiting"])("cancel in %s leaves no new account", async (state) => {
  const app = harness();
  await app.open("/settings/providers/claude");
  const dialog = await add();
  await userEvent.type(dialog.getByRole("textbox", { name: "Account name" }), "Cancelled");
  if (state === "waiting") {
    await userEvent.click(dialog.getByRole("button", { name: "Add and sign in" }));
    await dialog.findByRole("link", { name: "Open again" });
  }
  await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Add a Claude Code account" })).toBeNull(),
  );
  expect(
    (await app.client.request({ type: "accounts.list" })).accounts.some(
      (row) => row.label === "Cancelled",
    ),
  ).toBe(false);
});

test("hover actions make an account default, rename it and require confirmation to remove it", async () => {
  const app = harness();
  await app.open("/settings/providers/claude");
  const work = await account("Work");
  await userEvent.hover(work);
  await userEvent.click(within(work).getByRole("button", { name: "Make default" }));
  await within(work).findByText("Default");
  await userEvent.click(within(work).getByRole("button", { name: "Manage Work" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const field = screen.getByRole("textbox", { name: "Account name" });
  await userEvent.clear(field);
  await userEvent.type(field, "Client work{Enter}");
  const renamed = await account("Client work");
  await userEvent.click(within(renamed).getByRole("button", { name: "Manage Client work" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
  const confirm = within(await screen.findByRole("dialog", { name: "Remove Client work?" }));
  await userEvent.click(confirm.getByRole("button", { name: "Cancel" }));
  expect(await account("Client work")).toBeTruthy();
  await userEvent.click(within(renamed).getByRole("button", { name: "Manage Client work" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Remove Client work?" })).getByRole("button", {
      name: "Remove",
    }),
  );
  await waitFor(async () => expect(within(await accounts()).queryByText("Client work")).toBeNull());
});

test("signed-in rows show quota and the CLI login can be renamed but cannot be removed", async () => {
  await harness().open("/settings/providers/claude");
  const personal = await account("Personal");
  expect(
    within(personal).getByRole("meter", { name: "5-hour window" }).getAttribute("aria-valuenow"),
  ).toBe("62");
  expect(within(personal).queryByText("Signed in")).toBeNull();
  const cli = await account("Your CLI login");
  await userEvent.click(within(cli).getByRole("button", { name: "Manage Your CLI login" }));
  expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Change badge" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Remove" })).toBeNull();
  await userEvent.click(await screen.findByRole("menuitem", { name: "Sign in again" }));
  expect(await screen.findByRole("dialog", { name: "Sign in to Claude Code" })).toBeTruthy();
});

test("CLI path stays collapsed and saves on blur without a Save step", async () => {
  const app = harness();
  await app.open("/settings/providers/claude");
  await account("Personal");
  expect(screen.queryByRole("textbox", { name: "CLI path" })).toBeNull();
  await userEvent.click(screen.getByText("Advanced", { selector: "summary" }));
  const path = await screen.findByRole("textbox", { name: "CLI path" });
  await userEvent.type(path, "/tmp/claude");
  await userEvent.tab();
  await waitFor(() =>
    expect(app.daemon.services.settings.get("providers.configuration")).toEqual([
      { provider: "claude", binaryPath: "/tmp/claude" },
    ]),
  );
  await userEvent.clear(path);
  await userEvent.tab();
  await waitFor(() =>
    expect(app.daemon.services.settings.get("providers.configuration")).toEqual([
      { provider: "claude" },
    ]),
  );
});

test("Advanced removal opens the same supervised confirmation as the header menu", async () => {
  await harness().open("/settings/providers/claude");
  await accounts();
  await userEvent.click(screen.getByText("Advanced", { selector: "summary" }));
  await userEvent.click(await screen.findByRole("button", { name: "Remove provider…" }));
  expect(await screen.findByText(/Remove Claude Code's CLI from this computer/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove CLI" })).toBeTruthy();
});

test("CLI login rename follows its new initial, preserves the default and keeps the home visible", async () => {
  const app = harness();
  await app.open("/settings/providers/claude");
  const cli = await account("Your CLI login");
  expect(within(cli).getByRole("img", { name: "Your CLI login account" }).textContent).toBe("Y");
  await userEvent.click(within(cli).getByRole("button", { name: "Manage Your CLI login" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const form = within(screen.getByRole("form", { name: "Edit account label" }));
  const name = form.getByRole("textbox", { name: "Account name" });
  await waitFor(() => expect(document.activeElement).toBe(name));
  await userEvent.clear(name);
  await userEvent.type(name, "Studio{Enter}");
  const renamed = await account("Studio");
  expect(within(renamed).getByRole("img", { name: "Studio account" }).textContent).toBe("S");
  expect(within(renamed).getByText("Default")).toBeTruthy();
  expect(within(renamed).getByText("/Users/ada/.claude")).toBeTruthy();
  const saved = (await app.client.request({ type: "accounts.list" })).accounts.find(
    (row) => row.id === "claude-cli-default",
  );
  expect(saved).toMatchObject({
    label: "Studio",
    shortLabel: "S",
    badgeUsesInitial: true,
    isDefault: true,
    cliHome: "/Users/ada/.claude",
  });
});

test("Escape cancels account editing and a failed save can be retried without losing the entered name", async () => {
  const app = harness();
  await app.open("/settings/providers/claude");
  const cli = await account("Your CLI login");
  await userEvent.click(within(cli).getByRole("button", { name: "Manage Your CLI login" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
  await screen.findByRole("form", { name: "Edit account label" });
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("form", { name: "Edit account label" })).toBeNull(),
  );
  await userEvent.click(within(cli).getByRole("button", { name: "Manage Your CLI login" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const form = within(screen.getByRole("form", { name: "Edit account label" }));
  const name = form.getByRole("textbox", { name: "Account name" });
  await userEvent.clear(name);
  await userEvent.type(name, "Studio");
  app.daemon.failRequests("accounts.rename");
  await userEvent.click(form.getByRole("button", { name: "Save" }));
  await form.findByRole("alert");
  expect(name).toHaveProperty("value", "Studio");
  app.daemon.restoreRequests();
  await userEvent.click(form.getByRole("button", { name: "Retry" }));
  expect(await account("Studio")).toBeTruthy();
});
