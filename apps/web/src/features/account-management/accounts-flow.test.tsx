import { longHistory, replayCursor, teamAtLimit, workbench } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";
import {
  chooseAccount,
  closeModelControl,
  openModelControl,
  openModelPicker,
} from "@/test/model-control.ts";

configure({ asyncUtilTimeout: 10_000 });

vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => localStorage.clear());

const namedAccounts = async (app: ReturnType<typeof harness>) =>
  (await app.client.request({ type: "accounts.list" })).accounts.map((account) => account.label);

test("the provider name opens its accounts and cancelling a new API-key form leaves no account", async () => {
  const app = harness();
  await app.open("/settings/providers");
  const row = await screen.findByRole("group", { name: "Codex" });
  expect(within(row).queryByText("3 accounts")).toBeNull();
  await userEvent.click(within(row).getByRole("link", { name: "Codex" }));
  const accounts = await screen.findByRole("list", { name: "Codex accounts" });
  await userEvent.click(within(accounts).getByRole("button", { name: "Add account" }));
  const form = await screen.findByRole("form", { name: "Add account" });
  await userEvent.click(await within(form).findByRole("combobox", { name: "Sign-in method" }));
  await userEvent.click(await screen.findByRole("option", { name: "API key" }));
  await userEvent.type(within(form).getByRole("textbox", { name: "Account name" }), "Client key");
  await userEvent.click(within(form).getByRole("button", { name: "Continue" }));
  await screen.findByLabelText("OpenAI API key");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByLabelText("OpenAI API key")).toBeNull());
  expect(await namedAccounts(app)).not.toContain("Client key");
  expect(within(accounts).queryByText("Client key")).toBeNull();
});

test("Usage and the model picker leave account management on the provider page", async () => {
  const app = harness();
  await app.open("/usage");
  await screen.findByRole("article", { name: /^Codex · Personal · / });
  expect(screen.queryByRole("button", { name: /Add account/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Rename|Remove|Sign in|Sign out/ })).toBeNull();
});

test("a renamed default account immediately names the new-thread composer and picker group", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/settings/providers/claude");
  const accounts = await screen.findByRole("list", { name: "Claude Code accounts" });
  await userEvent.click(within(accounts).getByRole("button", { name: "Manage Work" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const field = screen.getByRole("textbox", { name: "Account name" });
  await userEvent.clear(field);
  await userEvent.type(field, "Studio Work{Enter}");
  const renamed = (await within(accounts).findByText("Studio Work")).closest("li");
  if (!renamed) throw new Error("Missing renamed account");
  await userEvent.hover(renamed);
  await userEvent.click(within(renamed).getByRole("button", { name: "Make default" }));
  await within(renamed).findByText("Default");
  await userEvent.click(screen.getByRole("link", { name: "Back to app" }));
  const chip = await screen.findByRole("button", { name: /^Model: Opus 5.5, Studio Work/ });
  // The chip's account badge is decorative; the provider mark names the account (6ce23181d).
  expect(within(chip).getByRole("img", { name: "Claude Code · Studio Work" })).toBeTruthy();
  const popover = await openModelControl(/^Model: Opus 5.5, Studio Work/);
  const list = await openModelPicker(popover);
  expect(await within(list).findByRole("group", { name: "Studio Work" })).toBeTruthy();
  expect(within(list).queryByRole("group", { name: "Work" })).toBeNull();
  expect(
    within(list)
      .getAllByRole("option")
      .some((option) => option.getAttribute("aria-label")?.includes(", recommended,")),
  ).toBe(true);
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

test("a limited current account remains selected while account management stays in Settings", async () => {
  const app = harness();
  const scenario = teamAtLimit()[0];
  if (!scenario) throw new Error("Missing limited thread");
  app.play(scenario).runThrough("limited");
  await app.open(`/t/${scenario.thread.id}`);
  const popover = await openModelControl();
  await openModelPicker(popover);
  const selected = within(popover).getByRole("tab", { name: "Codex" });
  expect(selected.getAttribute("aria-selected")).toBe("true");
  // A provider's accounts are tabs in the list header (49ef284a8).
  const accounts = within(popover).getByRole("tablist", { name: "Accounts" });
  const team = within(accounts).getByRole("tab", { name: "Codex · Team" });
  expect(team.getAttribute("aria-selected")).toBe("true");
  expect(team.getAttribute("aria-disabled")).toBe("true");
  await closeModelControl();
  expect(screen.queryByRole("button", { name: "Add another account" })).toBeNull();
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
    await screen.findByRole("heading", { name: `Signed in to Codex · ${name}` });
    const notices = await screen.findByRole("region", { name: "Notifications" });
    expect(within(notices).getAllByText(/^Signed in to/)).toHaveLength(1);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Sign in to Codex" })).toBeNull(),
    );
  }
});

test("the API service picker names its known marks and connects the selected OpenRouter service", async () => {
  const app = harness();
  await app.open("/settings/providers/opencode");
  const accounts = await screen.findByRole("list", { name: "OpenCode accounts" });
  await userEvent.click(within(accounts).getByRole("button", { name: "Add account" }));
  const form = await screen.findByRole("form", { name: "Add account" });
  await userEvent.click(await within(form).findByRole("combobox", { name: "Sign-in method" }));
  await userEvent.click(await screen.findByRole("option", { name: "API key" }));
  await userEvent.click(await within(form).findByRole("combobox", { name: "API service" }));
  const service = await screen.findByRole("option", { name: "OpenRouter" });
  expect(within(service).getByRole("img", { name: "OpenRouter" })).toBeTruthy();
  await userEvent.click(service);
  await userEvent.type(within(form).getByRole("textbox", { name: "Account name" }), "Router work");
  expect(within(form).queryByRole("button", { name: "Add and sign in" })).toBeNull();
  await userEvent.click(within(form).getByRole("button", { name: "Continue" }));
  expect(await screen.findByLabelText("OpenRouter API key")).toBeTruthy();
});

test("choosing API key describes the key hand-off instead of a browser sign-in", async () => {
  const app = harness();
  await app.open("/settings/providers/opencode");
  const accounts = await screen.findByRole("list", { name: "OpenCode accounts" });
  await userEvent.click(within(accounts).getByRole("button", { name: "Add account" }));
  const form = await screen.findByRole("form", { name: "Add account" });
  expect(within(form).getByText(/opens OpenCode's own sign-in in your browser/)).toBeTruthy();
  expect(within(form).getByRole("button", { name: "Add and sign in" })).toBeTruthy();
  await userEvent.click(await within(form).findByRole("combobox", { name: "Sign-in method" }));
  await userEvent.click(await screen.findByRole("option", { name: "API key" }));
  await userEvent.click(await within(form).findByRole("combobox", { name: "API service" }));
  await userEvent.click(await screen.findByRole("option", { name: "Anthropic" }));
  expect(within(form).queryByText(/in your browser/)).toBeNull();
  expect(
    within(form).getByText(
      "Next, paste your Anthropic API key. OpenCode stores it; ace hands it over once and never saves it.",
    ),
  ).toBeTruthy();
  expect(within(form).queryByRole("button", { name: "Add and sign in" })).toBeNull();
  await userEvent.type(within(form).getByRole("textbox", { name: "Account name" }), "Keyed");
  await userEvent.click(within(form).getByRole("button", { name: "Continue" }));
  expect(await screen.findByLabelText("Anthropic API key")).toBeTruthy();
});
