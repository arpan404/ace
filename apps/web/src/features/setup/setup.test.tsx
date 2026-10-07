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

test("a first launch opens setup; a sign-in fills progress live, and Start a thread finishes setup", async () => {
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
  // The suggested first step is the one primary action on the page.
  const claude = within(cards).getByRole("listitem", { name: "Claude Code" });
  expect(claude.hasAttribute("data-next")).toBe(true);
  expect(
    within(cards)
      .getAllByRole("listitem")
      .filter((card) => card.hasAttribute("data-next")),
  ).toHaveLength(1);
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
  expect(within(claude).getByRole("img", { name: "Ready" })).toBeTruthy();
  expect(screen.getByRole("heading", { level: 2, name: "You're ready" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Start a thread" }));
  expect(await screen.findByRole("heading", { level: 1, name: "New thread" })).toBeTruthy();
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
  const rail = screen.getByRole("navigation", { name: "Views" });
  await userEvent.click(within(rail).getByRole("link", { name: /^Deck/ }));
  await screen.findByRole("heading", { level: 1, name: "Deck" });
  await userEvent.click(within(rail).getByRole("link", { name: /^Home/ }));
  expect(await screen.findByRole("heading", { name: "Add your first project" })).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Providers on this computer" })).toBeNull();
}, 30_000);

test("a CLI that doesn't report its sign-in counts as ready once it lists models; only a card needing action stands out", async () => {
  // The fake's machine: Claude Code and Codex signed in, Pi not reporting its sign-in but
  // listing models, OpenCode signed out, Cursor's sign-in expired.
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
    expect((await progress()).getAttribute("aria-valuetext")).toBe("3 of 5 ready"),
  );
  for (const name of ["Claude Code", "Codex", "Pi"]) {
    const card = within(cards).getByRole("listitem", { name });
    expect(within(card).getByRole("img", { name: "Ready" })).toBeTruthy();
    expect(within(card).queryByRole("button")).toBeNull();
  }
  expect(
    within(within(cards).getByRole("listitem", { name: "Pi" })).getByText("Ready"),
  ).toBeTruthy();
  const opencode = within(cards).getByRole("listitem", { name: "OpenCode" });
  expect(within(opencode).getByRole("button", { name: "Sign in to OpenCode" })).toBeTruthy();
  const cursor = within(cards).getByRole("listitem", { name: "Cursor" });
  expect(within(cursor).getByRole("button", { name: "Reconnect Cursor" })).toBeTruthy();
  // Something is ready: starting a thread is the next step, so no card is highlighted.
  expect(
    within(cards)
      .getAllByRole("listitem")
      .filter((card) => card.hasAttribute("data-next")),
  ).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Start a thread" })).toBeTruthy();
}, 30_000);

test("after setup, Settings → Set up providers opens it again", async () => {
  const app = harness();
  stage(app, "codex", { auth: "logged_in", accountLabel: "ada@example.com" });
  await app.open("/settings/providers");
  const providers = await screen.findByRole("region", { name: "Providers" }, { timeout: 10_000 });
  await userEvent.click(within(providers).getByRole("link", { name: "Set up providers" }));
  const cards = await screen.findByRole("list", { name: "Providers on this computer" });
  const codex = within(cards).getByRole("listitem", { name: "Codex" });
  expect(within(codex).getByText("Signed in as ada@example.com")).toBeTruthy();
  expect(within(codex).getByRole("img", { name: "Ready" })).toBeTruthy();
}, 30_000);
