import { openProfileView } from "@/test/navigation.ts";
import type { ProviderKind, ProviderStatus } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { fakeClient, harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

type Harness = ReturnType<typeof harness>;

function stage(app: Harness, provider: ProviderKind, row: Partial<ProviderStatus>) {
  const found = app.daemon.services.providerStatuses.find((entry) => entry.provider === provider);
  if (!found) throw new Error(`No ${provider} discovery`);
  Object.assign(found, row);
}

/** A first launch: no threads, setup never done on this device, every CLI signed out. */
function firstRun() {
  const app = harness({ onboarding: "pending" });
  for (const provider of ["claude", "codex", "opencode", "cursor", "pi"] as const)
    stage(app, provider, { auth: "logged_out" });
  for (const account of app.daemon.services.accounts) {
    account.quota.auth = "logged_out";
    account.availability = "logged_out";
  }
  // OpenCode and Pi have no upstream connected yet.
  app.daemon.services.models = app.daemon.services.models.filter(
    (model) => model.provider !== "opencode" && model.provider !== "pi",
  );
  return app;
}

/** Whether this device's setup is done, as the daemon keeps it (a fresh connection asks). */
async function dismissedOnDaemon(app: Harness) {
  const client = fakeClient(app.daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const reply = await client.request({ type: "onboarding.query" });
  if (!reply.result.ok) throw new Error("Setup unavailable");
  return reply.result.dismissed;
}

/** Welcome's Get started, onto the agents. */
async function toAgents() {
  await userEvent.click(
    await screen.findByRole("button", { name: "Get started" }, { timeout: 10_000 }),
  );
  return screen.findByRole("list", { name: "Providers on this computer" }, { timeout: 10_000 });
}

/** How many agents the agents step says are ready. */
const readyLine = () => screen.findByText(/^\d+ ready\.|^Sign in to one to start\.$/);

test("a first launch opens setup on Welcome; signing in readies an agent, and a source opens Add project on it", async () => {
  const app = firstRun();
  await app.open("/");
  expect(
    await screen.findByRole("heading", { level: 2, name: "Welcome to ace" }, { timeout: 10_000 }),
  ).toBeTruthy();
  const cards = await toAgents();
  expect((await readyLine()).textContent).toBe("Sign in to one to start.");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Continue" }).disabled).toBe(true);
  const claude = within(cards).getByRole("listitem", { name: "Claude Code" });
  // Antigravity isn't installed: it shows apart, with how to get it.
  const missing = screen.getByRole("region", { name: "Not installed" });
  expect(within(missing).getByText("Antigravity")).toBeTruthy();

  await userEvent.click(within(claude).getByRole("button", { name: "Sign in to Claude Code" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Claude Code" });
  await within(dialog).findByRole("link", { name: "Open sign-in page" });
  app.daemon.services.providerLogin.complete("fake-login-1");
  await screen.findByText("Signed in to Claude Code");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Sign in to Claude Code" })).toBeNull(),
  );

  await waitFor(async () => expect((await readyLine()).textContent).toMatch(/^1 ready\./));
  expect(within(claude).queryByRole("button", { name: "Sign in to Claude Code" })).toBeNull();
  expect(within(claude).getByText(/^Signed in/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { level: 2, name: "Add your first project" });
  await userEvent.click(screen.getByRole("button", { name: /^Git URL/ }));
  expect(await screen.findByRole("dialog", { name: "Add project" })).toBeTruthy();
  // Opening a source isn't finishing: closing it leaves this device's setup to come back to.
  expect(await dismissedOnDaemon(app)).toBe(false);
}, 30_000);

test("Skip for now goes on to Home, which offers a project to add and doesn't send this device back to setup", async () => {
  const app = firstRun();
  await app.open("/");
  await screen.findByRole("heading", { level: 2, name: "Welcome to ace" }, { timeout: 10_000 });
  await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
  // Home's empty list: a chat needs no project, and Add a project is on offer.
  expect(await screen.findByRole("heading", { level: 1, name: "No threads yet" })).toBeTruthy();
  expect(
    within(screen.getByRole("main")).getByRole("button", { name: "Add a project" }),
  ).toBeTruthy();
  expect(await dismissedOnDaemon(app)).toBe(true);

  // Home again: it stays Home.
  await openProfileView("Automations");
  await screen.findByRole("heading", { level: 1, name: "Automations" });
  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("heading", { level: 1, name: "No threads yet" })).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Providers on this computer" })).toBeNull();
}, 30_000);

test("a CLI that doesn't report its sign-in counts as ready once its upstreams list models; each provider offers only its next action", async () => {
  // The fake's machine: Claude Code signed in, OpenCode and Pi connected through their
  // upstreams (Pi doesn't report a sign-in), Codex's CLI login signed out with Personal available, Cursor expired.
  const app = harness({ onboarding: "pending" });
  await app.open("/setup?step=agents");
  const cards = await screen.findByRole(
    "list",
    { name: "Providers on this computer" },
    { timeout: 10_000 },
  );
  await waitFor(async () => expect((await readyLine()).textContent).toMatch(/^4 ready\./));
  for (const name of ["Claude Code", "Codex", "OpenCode", "Pi"]) {
    const card = within(cards).getByRole("listitem", { name });
    if (name === "Codex") expect(within(card).getByRole("button", { name: "Update" })).toBeTruthy();
    else expect(within(card).queryByRole("button")).toBeNull();
  }
  // Pi's upstream models make it ready without requiring a sign-in action.
  expect(
    within(within(cards).getByRole("listitem", { name: "Pi" })).queryByText("Signed out"),
  ).toBeNull();
  // A ready agent says how it's signed in, so no row reads as unknown.
  expect(
    within(within(cards).getByRole("listitem", { name: "Claude Code" })).getByText(/^Signed in/),
  ).toBeTruthy();
  const codex = within(cards).getByRole("listitem", { name: "Codex" });
  expect(within(codex).getByText("Update available")).toBeTruthy();
  const cursor = within(cards).getByRole("listitem", { name: "Cursor" });
  expect(within(cursor).getByRole("button", { name: "Sign in to Cursor" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
}, 30_000);

test("an agent that isn't installed starts its official installer with one click", async () => {
  const app = harness({ onboarding: "pending" });
  app.daemon.services.providerInstalls.autoComplete = false;
  app.daemon.services.installed.delete("codex");
  stage(app, "codex", { installed: false });
  await app.open("/setup?step=agents");
  const missing = await screen.findByRole("region", { name: "Not installed" }, { timeout: 10_000 });
  const codex = within(missing).getByRole("listitem", { name: "Codex" });
  await userEvent.click(within(codex).getByRole("button", { name: "Install" }));
  expect(
    await within(codex).findByRole("progressbar", { name: "Codex installation progress" }),
  ).toBeTruthy();
}, 30_000);

test("first launch walks Welcome, Agents, Project and Done, and reaches the composer in the added project", async () => {
  const app = harness({ onboarding: "pending" });
  app.daemon.projects.seedFolders("/home/dev", [{ path: "/home/dev/weather", git: true }]);
  await app.open("/");
  expect(
    await screen.findByRole("heading", { level: 2, name: "Welcome to ace" }, { timeout: 10_000 }),
  ).toBeTruthy();
  expect(screen.getByRole("list", { name: "Step 1 of 4" })).toBeTruthy();
  // Welcome names what it found on this computer.
  expect(await screen.findByRole("list", { name: "Agents found" })).toBeTruthy();
  const skip = screen.getByRole("button", { name: "Skip for now" });
  await toAgents();
  const next = screen.getByRole<HTMLButtonElement>("button", { name: "Continue" });
  await waitFor(() => expect(next.disabled).toBe(false));
  await userEvent.click(next);
  await screen.findByRole("heading", { level: 2, name: "Add your first project" });
  // Skip for now stays where it was.
  expect(screen.getByRole("button", { name: "Skip for now" })).toBe(skip);
  // Local folder opens Add project on the folder chooser.
  await userEvent.click(screen.getByRole("button", { name: /^Local folder/ }));
  const folders = await screen.findByRole("listbox", { name: "Folders" });
  await userEvent.click(await within(folders).findByRole("option", { name: "weather" }));
  await screen.findByText("~/weather");
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  // Adding from setup comes back to Done, which names the project; setup is finished.
  expect(
    await screen.findByRole("heading", { level: 2, name: "You're set up" }, { timeout: 10_000 }),
  ).toBeTruthy();
  expect(screen.getByText("weather")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  await waitFor(async () => expect(await dismissedOnDaemon(app)).toBe(true));
  await userEvent.click(screen.getByRole("button", { name: "Start a thread" }));
  expect(await screen.findByRole("button", { name: "Project: weather" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: /^Message$/ })).toBeTruthy();
}, 30_000);

test("Start a chat on the project step finishes setup and opens a chat", async () => {
  const app = harness({ onboarding: "pending" });
  await app.open("/setup?step=project");
  await userEvent.click(
    await screen.findByRole("button", { name: /^Start a chat/ }, { timeout: 10_000 }),
  );
  expect(await screen.findByRole("combobox", { name: /^Message$/ })).toBeTruthy();
  expect(await dismissedOnDaemon(app)).toBe(true);
}, 30_000);
