import { uxAudit, workbenchServices } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("OpenCode accounts reflect their service failure while a working account stays signed in", async () => {
  const app = harness();
  app.daemon.seedServices(workbenchServices(1_000));
  await app.open("/settings/providers/opencode");
  const accounts = await screen.findByRole("list", { name: "OpenCode accounts" });
  const rows = within(accounts).getAllByRole("listitem");
  const failing = rows.find((row) => within(row).queryByText("OpenRouter API"));
  const working = rows.find((row) => within(row).queryByText("Work"));
  if (!failing || !working) throw new Error("Missing account fixtures");
  expect(await within(failing).findByText("Connection needs attention")).toBeTruthy();
  expect(within(failing).queryByText("Signed in")).toBeNull();
  expect(within(working).getByText("Signed in")).toBeTruthy();
  const services = within(await screen.findByRole("list", { name: "OpenCode services" }));
  expect(services.getByRole("button", { name: "Reconnect OpenRouter" })).toBeTruthy();
  expect(services.getByText("Connect a service")).toBeTruthy();
  expect(screen.queryByText("Sign in for more models")).toBeNull();
});

test("Cursor names its SDK login consistently without calling it a service failure", async () => {
  await harness().open("/settings/providers/cursor");
  const accounts = await screen.findByRole("list", { name: "Cursor accounts" });
  expect(within(accounts).getByText("Your Cursor login")).toBeTruthy();
  expect(within(accounts).queryByText("Your CLI login")).toBeNull();
  expect(screen.queryByText("Services need attention")).toBeNull();
});

test("a delegated failure names the rejected model after replay without exposing the role", async () => {
  const app = harness();
  for (const scenario of uxAudit()) app.play(scenario).runUntilBlocked();
  await app.open("/t/thread-ux-delegated-model-error");
  const feed = within(await screen.findByRole("feed", { name: "Transcript" }));
  expect(await feed.findByText(/doesn't recognise the model “opus-5.5”/)).toBeTruthy();
  expect(feed.queryByText("greeter", { exact: true })).toBeNull();
  expect(feed.queryByText("model_not_found", { exact: true })).toBeNull();
  expect(await feed.findByText("Write a short welcome message.")).toBeTruthy();
});

test("an inline account login uses the same provider and account wording as a dialog login", async () => {
  await harness().open("/settings/providers/codex");
  await userEvent.click(await screen.findByRole("button", { name: "Add account" }));
  const form = within(await screen.findByRole("form", { name: "Add account" }));
  await userEvent.type(form.getByRole("textbox", { name: "Account name" }), "Work2");
  await userEvent.click(form.getByRole("combobox", { name: "Sign-in method" }));
  await userEvent.click(await screen.findByRole("option", { name: "API key" }));
  await userEvent.click(form.getByRole("button", { name: "Add and sign in" }));
  await userEvent.type(await screen.findByLabelText("OpenAI API key"), "synthetic-copy-key");
  await userEvent.click(screen.getByRole("button", { name: "Use key" }));
  expect(await screen.findByText("Signed in to Codex · Work2")).toBeTruthy();
  expect(
    await within(screen.getByRole("list", { name: "Codex accounts" })).findByText("Work2"),
  ).toBeTruthy();
});
