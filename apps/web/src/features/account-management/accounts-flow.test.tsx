import { longHistory, replayCursor, teamAtLimit, workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import {
  chooseAccount,
  closeModelControl,
  openModelControl,
  openModelPicker,
} from "@/test/model-control.ts";

beforeEach(() => localStorage.clear());

const namedAccounts = async (app: ReturnType<typeof harness>) =>
  (await app.client.request({ type: "accounts.list" })).accounts.map((account) => account.label);

test("the provider count opens its accounts and cancelling a new API-key form leaves no account", async () => {
  const app = harness();
  await app.open("/settings/providers");
  const row = await screen.findByRole("group", { name: "Codex" });
  expect(await within(row).findByText("3 accounts")).toBeTruthy();
  await userEvent.click(within(row).getByRole("link", { name: "Codex" }));
  const accounts = await screen.findByRole("list", { name: "Codex accounts" });
  await userEvent.click(within(accounts).getByRole("button", { name: "Add account" }));
  const form = await screen.findByRole("form", { name: "Add account" });
  await userEvent.click(await within(form).findByRole("combobox", { name: "Sign-in method" }));
  await userEvent.click(await screen.findByRole("option", { name: "API key" }));
  await userEvent.type(within(form).getByRole("textbox"), "Client key");
  await userEvent.click(within(form).getByRole("button", { name: "Add and sign in" }));
  await screen.findByLabelText("OpenAI API key");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByLabelText("OpenAI API key")).toBeNull());
  expect(await namedAccounts(app)).not.toContain("Client key");
  expect(within(accounts).queryByText("Client key")).toBeNull();
});

test("Usage & accounts offers the same named-account form for each provider", async () => {
  const app = harness();
  await app.open("/accounts");
  const codex = await screen.findByRole("region", { name: "Codex" });
  await userEvent.click(within(codex).getByRole("button", { name: "Add account" }));
  const form = await screen.findByRole("form", { name: "Add account" });
  await userEvent.type(within(form).getByRole("textbox"), "Not saved");
  await userEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  expect(await namedAccounts(app)).not.toContain("Not saved");
  expect(screen.queryByRole("form", { name: "Add account" })).toBeNull();
});

test("the picker adds a named account, closes on device-code success and never claims the CLI's email", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  const popover = await openModelControl(/^Model: Opus 5.5/);
  await chooseAccount(popover, "Add account…");
  const form = await screen.findByRole("form", { name: "Add account" });
  await userEvent.type(within(form).getByRole("textbox"), "Client work");
  await userEvent.click(within(form).getByRole("button", { name: "Add and sign in" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Claude Code" });
  await within(dialog).findByRole("link", { name: /Open sign-in page/ });
  app.daemon.services.providerLogin.complete("fake-login-1");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Sign in to Claude Code" })).toBeNull(),
  );
  expect(await screen.findByText("Signed in to Claude Code · Client work")).toBeTruthy();
  expect(screen.queryByText("Signed in as ada@example.com")).toBeNull();
  expect(await namedAccounts(app)).toContain("Client work");
});

test("a renamed default account immediately names the new-thread composer and picker group", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/settings/providers/claude");
  const accounts = await screen.findByRole("list", { name: "Claude Code accounts" });
  await userEvent.click(within(accounts).getByRole("button", { name: "Manage Work" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit label…" }));
  const field = screen.getByRole("textbox", { name: "Account name" });
  await userEvent.clear(field);
  await userEvent.type(field, "Studio Work{Enter}");
  await userEvent.click(
    await within(accounts).findByRole("button", { name: "Manage Studio Work" }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: "Make default" }));
  await screen.findByText("Near its limit · Studio Work");
  await userEvent.click(screen.getByRole("link", { name: /^New thread/ }));
  const chip = await screen.findByRole("button", { name: /^Model: Opus 5.5, Studio Work/ });
  expect(
    within(chip).getByRole("img", { name: "Claude Code · Studio Work · label W" }),
  ).toBeTruthy();
  const popover = await openModelControl(/^Model: Opus 5.5, Studio Work/);
  const list = await openModelPicker(popover);
  expect(await within(list).findByRole("group", { name: "Studio Work" })).toBeTruthy();
  expect(within(list).queryByRole("group", { name: "Work" })).toBeNull();
  expect(within(list).getAllByText("Recommended").length).toBeGreaterThan(0);
});

test("account-switch confirmations name the account and disappear when another thread opens", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  app.play(longHistory(2)).runUntilBlocked();
  await app.open("/t/thread-replay-cursor");
  const popover = await openModelControl(/^Model: Opus 5.5/);
  await chooseAccount(popover, "Work");
  await closeModelControl();
  expect(await screen.findByText("Next turn runs on Claude Code · Work")).toBeTruthy();
  await userEvent.click(screen.getByRole("link", { name: /Document the router/ }));
  await screen.findByRole("heading", { level: 1, name: "Document the router" });
  await waitFor(() =>
    expect(screen.queryByText("Next turn runs on Claude Code · Work")).toBeNull(),
  );
});

test("a limited current account remains selected and its notice opens the shared Add another account flow", async () => {
  const app = harness();
  const scenario = teamAtLimit()[0];
  if (!scenario) throw new Error("Missing limited thread");
  app.play(scenario).runThrough("limited");
  await app.open(`/t/${scenario.thread.id}`);
  const popover = await openModelControl();
  await openModelPicker(popover);
  const selected = within(popover).getByRole("tab", { name: "Codex · Team" });
  expect(selected.getAttribute("aria-selected")).toBe("true");
  expect(selected.getAttribute("aria-disabled")).toBe("true");
  await closeModelControl();
  await userEvent.click(screen.getByRole("button", { name: "Add another account" }));
  expect(await screen.findByRole("form", { name: "Add account" })).toBeTruthy();
});

test("successive account sign-ins announce one consistently named success, replacing the previous one", async () => {
  const app = harness();
  await app.open("/settings/providers/codex");
  const accounts = await screen.findByRole("list", { name: "Codex accounts" });
  for (const [name, session] of [
    ["Team", "fake-login-1"],
    ["Personal", "fake-login-2"],
  ]) {
    await userEvent.click(within(accounts).getByRole("button", { name: `Manage ${name}` }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Sign in again" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign in to Codex" });
    await within(dialog).findByLabelText("Sign-in code");
    app.daemon.services.providerLogin.complete(session ?? "");
    const notices = screen.getByRole("region", { name: "Notifications" });
    await within(notices).findByText(`Signed in to Codex · ${name}`);
    expect(within(notices).getAllByText(/^Signed in to/)).toHaveLength(1);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Sign in to Codex" })).toBeNull(),
    );
  }
});
