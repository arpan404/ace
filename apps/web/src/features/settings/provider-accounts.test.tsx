import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const accounts = () =>
  screen.findByRole("list", { name: "Claude Code accounts" }, { timeout: 10_000 });

/** An account's row in the list, found by its name. */
async function account(name: string) {
  const found = (await within(await accounts()).findByText(name)).closest("li");
  if (!found) throw new Error(`No ${name} row`);
  return found;
}

test("Add account names it and starts its sign-in straight away; it joins the list", async () => {
  const app = harness();
  await app.open("/settings/providers/claude");
  await userEvent.click(within(await accounts()).getByRole("button", { name: "Add account" }));
  const form = await screen.findByRole("form", { name: "Add account" });
  await userEvent.click(within(form).getByRole("button", { name: "Add and sign in" }));
  expect(within(form).getByRole("alert").textContent).toBe("Give the account a name, like Work.");
  await userEvent.type(within(form).getByRole("textbox"), "Side project");
  await userEvent.click(within(form).getByRole("button", { name: "Add and sign in" }));

  // The new account's own sign-in, at once.
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Claude Code" });
  expect(await within(dialog).findByRole("link", { name: /open sign-in page/i })).toBeTruthy();
  const added = app.daemon.services.accounts.find((entry) => entry.label === "Side project");
  expect(added?.provider).toBe("claude");
  app.daemon.services.providerLogin.complete("fake-login-1");
  await userEvent.click(await within(dialog).findByRole("button", { name: "Done" }));
  expect(await account("Side project")).toBeTruthy();
}, 30_000);

test("an account's menu renames it, makes it the default and removes it after asking", async () => {
  const app = harness();
  await app.open("/settings/providers/claude");
  const work = await account("Work");
  await userEvent.click(within(work).getByRole("button", { name: "Manage Work" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const field = within(work).getByRole("textbox", { name: "Account name" });
  await userEvent.clear(field);
  await userEvent.type(field, "Client work{Enter}");
  expect(await account("Client work")).toBeTruthy();
  const renamed = app.daemon.services.accounts.find((entry) => entry.label === "Client work");
  if (!renamed) throw new Error("Not renamed on the daemon");

  await userEvent.click(
    within(await account("Client work")).getByRole("button", { name: "Manage Client work" }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: "Make default" }));
  await waitFor(() => expect(renamed.isDefault).toBe(true));
  expect(await within(await account("Client work")).findByText("Default")).toBeTruthy();

  await userEvent.click(
    within(await account("Client work")).getByRole("button", { name: "Manage Client work" }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
  const confirm = await screen.findByRole("dialog", { name: "Remove Client work?" });
  await userEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
  await waitFor(() =>
    expect(app.daemon.services.accounts.some((entry) => entry.id === renamed.id)).toBe(false),
  );
  await waitFor(async () => expect(within(await accounts()).queryByText("Client work")).toBeNull());
}, 30_000);

test("the CLI's own sign-in can't be renamed or removed, only signed in again", async () => {
  await harness().open("/settings/providers/claude");
  const own = await account("ada@example.com");
  expect(within(own).getByText("Claude Code's own sign-in")).toBeTruthy();
  await userEvent.click(within(own).getByRole("button", { name: "Manage ada@example.com" }));
  const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
  expect(items).toEqual(["Sign in again"]);
  await userEvent.click(screen.getByRole("menuitem", { name: "Sign in again" }));
  expect(await screen.findByRole("dialog", { name: "Sign in to Claude Code" })).toBeTruthy();
}, 30_000);

test("each account shows how much of its plan is left and when it resets", async () => {
  await harness().open("/settings/providers/claude");
  const personal = await account("Personal");
  const fiveHour = within(personal).getByRole("meter", { name: "5-hour window" });
  expect(fiveHour.getAttribute("aria-valuenow")).toBe("62");
  expect(fiveHour.getAttribute("aria-valuetext")).toMatch(/^62% used, resets/);
  expect(within(personal).getByRole("meter", { name: "Weekly window" })).toBeTruthy();
}, 30_000);
