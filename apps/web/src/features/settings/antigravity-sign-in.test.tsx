import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { antigravityPage } from "@/test/antigravity-page.ts";

beforeEach(() => localStorage.clear());

/** Open "Sign in again" on Antigravity's CLI login: it asks how to sign in first. */
async function signInAgain(row: (name: string) => Promise<HTMLElement>) {
  const cli = await row("Antigravity");
  await userEvent.click(within(cli).getByRole("button", { name: "Manage Antigravity" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Sign in again" }));
  return within(await screen.findByRole("form", { name: "Choose how to sign in" }));
}

test("signing in again asks how, and Gemini Enterprise needs a valid project and location", async () => {
  const { app, row } = await antigravityPage();
  const form = await signInAgain(row);
  await userEvent.click(form.getByRole("combobox", { name: "Sign in with" }));
  // Key-based methods aren't offered.
  expect(screen.queryByRole("option", { name: /API key/i })).toBeNull();
  await userEvent.click(await screen.findByRole("option", { name: "Gemini Enterprise" }));
  await userEvent.type(form.getByRole("textbox", { name: "Project ID" }), "Not A Project");
  await userEvent.type(form.getByRole("textbox", { name: "Location" }), "eu");
  await userEvent.click(form.getByRole("button", { name: "Continue" }));
  expect((await form.findByRole("alert")).textContent).toContain("project ID");
  expect(app.daemon.services.providerLogin.signIns.size).toBe(0);

  await userEvent.clear(form.getByRole("textbox", { name: "Project ID" }));
  await userEvent.type(form.getByRole("textbox", { name: "Project ID" }), "acme-agents");
  await userEvent.click(form.getByRole("button", { name: "Continue" }));
  await screen.findByRole("dialog", { name: "Sign in to Antigravity" });
  await waitFor(() =>
    expect([...app.daemon.services.providerLogin.signIns.values()]).toEqual([
      { method: "enterprise", project: "acme-agents", location: "eu" },
    ]),
  );
}, 30_000);

test("a sign-in finished on another device continues with the address its last page ended on", async () => {
  const { app, row } = await antigravityPage();
  const form = await signInAgain(row);
  // Google account is the default.
  await userEvent.click(form.getByRole("button", { name: "Continue" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Sign in to Antigravity" }));
  const field = await dialog.findByLabelText("Page didn't load?");
  await userEvent.type(field, "https://accounts.google.com/");
  await userEvent.click(dialog.getByRole("button", { name: "Continue" }));
  expect((await dialog.findByRole("alert")).textContent).toContain("Copy the whole address");
  expect(app.daemon.services.providerLogin.returned.size).toBe(0);

  await userEvent.type(field, "http://127.0.0.1:41234/?state=s&code=one-time");
  await userEvent.click(dialog.getByRole("button", { name: "Continue" }));
  expect(await screen.findByText("Signed in to Antigravity")).toBeTruthy();
  expect([...app.daemon.services.providerLogin.returned.values()]).toEqual([
    "http://127.0.0.1:41234/?state=s&code=one-time",
  ]);
  expect([...app.daemon.services.providerLogin.signIns.values()]).toEqual([{ method: "google" }]);
}, 30_000);

test("an added Antigravity account can sign in with Agent Platform", async () => {
  const { app, list } = await antigravityPage();
  await userEvent.click(within(list).getByRole("button", { name: "Add account" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Add an Antigravity account" }));
  await userEvent.type(dialog.getByRole("textbox", { name: "Account name" }), "Cloud");
  await userEvent.click(dialog.getByRole("combobox", { name: "Sign in with" }));
  await userEvent.click(await screen.findByRole("option", { name: "Agent Platform" }));
  expect(dialog.getByText(/Application Default Credentials/)).toBeTruthy();
  await userEvent.type(dialog.getByRole("textbox", { name: "Project ID" }), "acme-agents");
  await userEvent.type(dialog.getByRole("textbox", { name: "Location" }), "us-central1");
  await userEvent.click(dialog.getByRole("button", { name: "Add and sign in" }));
  await waitFor(() =>
    expect([...app.daemon.services.providerLogin.signIns.values()]).toEqual([
      { method: "agent_platform", project: "acme-agents", location: "us-central1" },
    ]),
  );
}, 30_000);

test("an Antigravity account's row says how it signs in", async () => {
  const { row } = await antigravityPage({ antigravitySignIn: "enterprise" });
  expect(within(await row("Antigravity")).getByText("Gemini Enterprise")).toBeTruthy();
}, 30_000);
