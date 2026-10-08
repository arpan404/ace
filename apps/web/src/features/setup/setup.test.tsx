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

const progress = () => screen.findByRole("progressbar", { name: "Providers ready" });

test("a first launch opens setup; signing in updates readiness, and Add a project opens the folder chooser", async () => {
  const app = firstRun();
  await app.open("/");
  await userEvent.click(await screen.findByRole("button", { name: "Get started" }));
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
  await userEvent.click(await within(dialog).findByRole("button", { name: "Done" }));

  await waitFor(async () =>
    expect((await progress()).getAttribute("aria-valuetext")).toBe("1 of 5 ready"),
  );
  expect(within(claude).queryByRole("button", { name: "Sign in to Claude Code" })).toBeNull();
  expect(screen.getByRole("heading", { level: 2, name: "You're ready to go" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Add a project" }));
  expect(await screen.findByRole("dialog", { name: "Add project" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Search folders" })).toBeTruthy();
  expect(await dismissedOnDaemon(app)).toBe(true);
}, 30_000);

test("Skip for now goes on to adding a project, and Home doesn't send this device back to setup", async () => {
  const app = firstRun();
  await app.open("/");
  await userEvent.click(await screen.findByRole("button", { name: "Get started" }));
  await screen.findByRole("list", { name: "Providers on this computer" }, { timeout: 10_000 });
  await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
  // The first run's next step: a project to work in.
  expect(await screen.findByRole("heading", { name: "Add your first project" })).toBeTruthy();
  expect(await dismissedOnDaemon(app)).toBe(true);

  // Home again: it stays Home.
  const sidebar = screen.getByRole("navigation", { name: "App" });
  await userEvent.click(within(sidebar).getByRole("link", { name: "Automations" }));
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
  await userEvent.click(await screen.findByRole("button", { name: "Get started" }));
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
    expect(within(card).queryByRole("button")).toBeNull();
  }
  // Pi doesn't report a sign-in; its connected upstreams say it works.
  expect(
    within(within(cards).getByRole("listitem", { name: "Pi" })).getByText("Ready"),
  ).toBeTruthy();
  const codex = within(cards).getByRole("listitem", { name: "Codex" });
  expect(within(codex).getByText("Signed in · Personal")).toBeTruthy();
  const cursor = within(cards).getByRole("listitem", { name: "Cursor" });
  expect(within(cursor).getByRole("button", { name: "Reconnect Cursor" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add a project" })).toBeTruthy();
}, 30_000);

test("an agent that isn't installed waits apart, its install command a click away", async () => {
  const app = harness({ onboarding: "pending" });
  app.daemon.services.installed.delete("codex");
  stage(app, "codex", { installed: false });
  await app.open("/setup");
  await userEvent.click(await screen.findByRole("button", { name: "Get started" }));
  const missing = await screen.findByRole("region", { name: "Not installed" }, { timeout: 10_000 });
  const codex = within(missing).getByRole("listitem", { name: "Codex" });
  expect(within(codex).queryByText("npm install -g @openai/codex")).toBeNull();
  await userEvent.click(within(codex).getByRole("button", { name: "How to install" }));
  expect(within(codex).getByText("npm install -g @openai/codex")).toBeTruthy();
  // Installed ones count toward setup; this one doesn't.
  expect((await progress()).getAttribute("aria-valuetext")).toMatch(/ of 4 ready$/);
}, 30_000);

test("setup welcomes a new user before showing ready providers", async () => {
  const app = harness({ onboarding: "pending" });
  await app.open("/");
  expect(await screen.findByRole("heading", { name: "Welcome to ace" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "You're ready to go" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Get started" }));
  expect(await screen.findByRole("heading", { name: "You're ready to go" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add a project" })).toBeTruthy();
});
