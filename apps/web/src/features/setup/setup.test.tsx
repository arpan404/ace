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

async function toProject() {
  await userEvent.click(await screen.findByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "Choose your first project" });
}

const progress = () => screen.findByRole("progressbar", { name: "Providers ready" });

test("a first launch opens setup; signing in updates readiness, and Add a project opens the folder chooser", async () => {
  const app = firstRun();
  await app.open("/");
  const cards = await screen.findByRole(
    "list",
    { name: "Providers on this computer" },
    {
      timeout: 10_000,
    },
  );
  expect((await progress()).getAttribute("aria-valuetext")).toBe("0 of 5 ready");
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

  await waitFor(async () =>
    expect((await progress()).getAttribute("aria-valuetext")).toBe("1 of 5 ready"),
  );
  expect(within(claude).queryByRole("button", { name: "Sign in to Claude Code" })).toBeNull();
  expect(screen.getByRole("heading", { level: 2, name: "Connect your agents" })).toBeTruthy();
  await toProject();
  await userEvent.click(screen.getByRole("button", { name: "Add a project" }));
  expect(await screen.findByRole("dialog", { name: "Add project" })).toBeTruthy();
  expect(await screen.findByRole("combobox", { name: "Search folders" })).toBeTruthy();
  expect(await dismissedOnDaemon(app)).toBe(true);
}, 30_000);

test("Skip for now goes on to adding a project, and Home doesn't send this device back to setup", async () => {
  const app = firstRun();
  await app.open("/");
  await screen.findByRole("list", { name: "Providers on this computer" }, { timeout: 10_000 });
  await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
  // The first run's next step: a project to work in.
  expect(await screen.findByRole("heading", { name: "Add your first project" })).toBeTruthy();
  expect(await dismissedOnDaemon(app)).toBe(true);

  // Home again: it stays Home.
  await openProfileView("Automations");
  await screen.findByRole("heading", { level: 1, name: "Automations" });
  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("heading", { name: "Add your first project" })).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Providers on this computer" })).toBeNull();
}, 30_000);

test("a CLI that doesn't report its sign-in counts as ready once its upstreams list models; each provider offers only its next action", async () => {
  // The fake's machine: Claude Code signed in, OpenCode and Pi connected through their
  // upstreams (Pi doesn't report a sign-in), Codex's CLI login signed out with Personal available, Cursor expired.
  const app = harness({ onboarding: "pending" });
  await app.open("/");
  const cards = await screen.findByRole(
    "list",
    { name: "Providers on this computer" },
    {
      timeout: 10_000,
    },
  );
  await waitFor(async () =>
    expect((await progress()).getAttribute("aria-valuetext")).toBe("4 of 5 ready"),
  );
  for (const name of ["Claude Code", "Codex", "OpenCode", "Pi"]) {
    const card = within(cards).getByRole("listitem", { name });
    if (name === "Codex") expect(within(card).getByRole("button", { name: "Update" })).toBeTruthy();
    else expect(within(card).queryByRole("button")).toBeNull();
  }
  // Pi's upstream models make it ready without requiring a sign-in action.
  expect(
    within(within(cards).getByRole("listitem", { name: "Pi" })).queryByText("Signed out"),
  ).toBeNull();
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
  await app.open("/setup");
  const missing = await screen.findByRole("region", { name: "Not installed" }, { timeout: 10_000 });
  const codex = within(missing).getByRole("listitem", { name: "Codex" });
  await userEvent.click(within(codex).getByRole("button", { name: "Install" }));
  expect(
    await within(codex).findByRole("progressbar", { name: "Codex installation progress" }),
  ).toBeTruthy();
  expect((await progress()).getAttribute("aria-valuetext")).toMatch(/ of 4 ready$/);
}, 30_000);

test("first launch is two steps and reaches the composer in four actions", async () => {
  const app = harness({ onboarding: "pending" });
  app.daemon.projects.seedFolders("/home/dev", [{ path: "/home/dev/weather", git: true }]);
  await app.open("/");
  // Setup opens on its first step: no welcome page before the agents.
  expect(
    await screen.findByRole("heading", { level: 2, name: "Connect your agents" }),
  ).toBeTruthy();
  expect(screen.getByRole("list", { name: "Step 1 of 2" })).toBeTruthy();
  const skip = screen.getByRole("button", { name: "Skip for now" });
  // 1. Continue, once an agent is ready.
  const next = screen.getByRole<HTMLButtonElement>("button", { name: "Continue" });
  await waitFor(() => expect(next.disabled).toBe(false));
  await userEvent.click(next);
  await screen.findByRole("heading", { level: 2, name: "Choose your first project" });
  // Skip for now stays where it was.
  expect(screen.getByRole("button", { name: "Skip for now" })).toBe(skip);
  // 2. Add a project opens the folder browser itself.
  await userEvent.click(screen.getByRole("button", { name: "Add a project" }));
  const folders = await screen.findByRole("listbox", { name: "Folders" });
  // 3. The folder, 4. Add it: New thread's composer is ready for the first prompt.
  await userEvent.click(await within(folders).findByRole("option", { name: /^weather/ }));
  await userEvent.click(await screen.findByRole("button", { name: "Add weather" }));
  expect(await screen.findByRole("button", { name: "Project: weather" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: /^Message$/ })).toBeTruthy();
}, 30_000);
