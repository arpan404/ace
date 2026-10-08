import type { ProviderKind, ProviderStatus } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

type Harness = ReturnType<typeof harness>;

function stage(app: Harness, provider: ProviderKind, staged: Partial<ProviderStatus>) {
  const found = app.daemon.services.providerStatuses.find((entry) => entry.provider === provider);
  if (!found) throw new Error(`No ${provider} discovery`);
  Object.assign(found, staged);
}

const section = (name = "On this computer") =>
  screen.findByRole("region", { name }, { timeout: 10_000 });

/** The row of the list that holds the link to `name`'s page. */
async function rowOf(name: string) {
  const link = await screen.findByRole("link", { name }, { timeout: 10_000 });
  const found = link.closest<HTMLElement>(".group");
  if (!found) throw new Error(`No row for ${name}`);
  return found;
}

test("the list says each provider's state in one line and asks only where something's wrong", async () => {
  // The fake's machine: Claude Code signed in, Codex's CLI login signed out, OpenCode and Pi
  // connected through their services, Cursor's sign-in expired, Antigravity not installed.
  await harness().open("/settings/providers");
  const installed = await section();
  expect(within(await rowOf("Claude Code")).getByText("Signed in as ada@example.com")).toBeTruthy();
  expect(within(await rowOf("Codex")).getByText("Sign in needed")).toBeTruthy();
  expect(await within(await rowOf("OpenCode")).findByText("4 services connected")).toBeTruthy();
  expect(
    await within(await rowOf("Cursor")).findByText("Needs attention · Cursor sign-in has expired."),
  ).toBeTruthy();
  // Only the two that need something have a button; nothing else asks.
  expect(
    within(installed)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent),
  ).toEqual(["Check again", "Sign in to Codex", "Reconnect Cursor"]);
  // No CLI versions or "sign-in unknown" in the list; those live on each page.
  expect(installed.textContent).not.toMatch(/2\.1\.4|unknown|opencode 1/);
  const missing = await section("Not installed");
  expect(within(missing).getByRole("link", { name: "Antigravity" })).toBeTruthy();
}, 30_000);

test("a provider's row opens its page, with its accounts, models and facts; Back returns", async () => {
  await harness().open("/settings/providers");
  await userEvent.click(await screen.findByRole("link", { name: "Claude Code" }));
  expect(await screen.findByRole("heading", { level: 2, name: "Claude Code" })).toBeTruthy();
  const about = await screen.findByRole("region", { name: "About" });
  expect(within(about).getByText("2.1.4")).toBeTruthy();
  expect(within(about).getByText("/opt/homebrew/bin/claude")).toBeTruthy();
  const accounts = await screen.findByRole("list", { name: "Claude Code accounts" });
  expect(within(accounts).getByText("ada@example.com")).toBeTruthy();
  expect(within(accounts).getByText("Work")).toBeTruthy();
  // Sign out is on the page, apart from everything else.
  expect(screen.getByRole("region", { name: "Sign out of Claude Code" })).toBeTruthy();

  await userEvent.click(screen.getByRole("link", { name: "Back to Providers" }));
  expect(await section()).toBeTruthy();
}, 30_000);

test("a provider that needs attention leads its page with what's wrong and Reconnect", async () => {
  await harness().open("/settings/providers/cursor");
  const alert = await screen.findByRole("alert", {}, { timeout: 10_000 });
  expect(within(alert).getByText("Cursor sign-in has expired.")).toBeTruthy();
  await userEvent.click(within(alert).getByRole("button", { name: "Reconnect Cursor" }));
  expect(await screen.findByRole("dialog", { name: "Sign in to Cursor" })).toBeTruthy();
}, 30_000);

test("OpenCode's page shows each service; a failing one reconnects with its choice made for the person", async () => {
  const app = harness();
  app.daemon.services.failingSources.add("openai");
  await app.open("/settings/providers/opencode");
  const services = await screen.findByRole(
    "list",
    { name: "OpenCode services" },
    { timeout: 10_000 },
  );
  expect(within(services).getByText("OpenRouter could not be reached.")).toBeTruthy();
  expect(within(services).getAllByText("Connected · API key").length).toBeGreaterThan(0);
  // Local runtimes need no sign-in; they're named once.
  expect(screen.getByText(/models running on this computer: LM Studio, Ollama/)).toBeTruthy();

  await userEvent.click(within(services).getByRole("button", { name: "Reconnect OpenAI" }));
  const dialog = await screen.findByRole("dialog", { name: "Connect OpenAI" });
  // OpenAI was chosen from the CLI's list without asking.
  expect(await within(dialog).findByText("Press Enter to continue.")).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: "GitHub Copilot" })).toBeNull();
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  expect(await within(dialog).findByLabelText("Sign-in code")).toBeTruthy();
}, 30_000);

test("Connect a service on Pi's page opens the CLI's own choices", async () => {
  await harness().open("/settings/providers/pi");
  // Pi doesn't report its own sign-in; its page says so, quietly, with the terminal recipe.
  const about = await screen.findByRole("region", { name: "About" }, { timeout: 10_000 });
  expect(await within(about).findByText(/Not reported by this CLI/)).toBeTruthy();
  expect(about.textContent).toContain("Run pi, then type /login");
  await userEvent.click(screen.getByRole("button", { name: "Connect a service" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Pi" });
  expect(await within(dialog).findByRole("button", { name: "GitHub Copilot" })).toBeTruthy();
}, 30_000);

test("Disconnect on a working service runs the CLI's logout for it", async () => {
  await harness().open("/settings/providers/opencode");
  const services = await screen.findByRole(
    "list",
    { name: "OpenCode services" },
    { timeout: 10_000 },
  );
  await userEvent.click(within(services).getByRole("button", { name: "Disconnect OpenAI" }));
  const dialog = await screen.findByRole("dialog", { name: "Disconnect OpenAI" });
  expect(await within(dialog).findByText("OpenAI is disconnected")).toBeTruthy();
}, 30_000);

test("Check again reads fresh discovery: a CLI signed in meanwhile reads signed in", async () => {
  const app = harness();
  stage(app, "codex", { auth: "logged_out" });
  await app.open("/settings/providers");
  expect(within(await rowOf("Codex")).getByText("Sign in needed")).toBeTruthy();
  stage(app, "codex", { auth: "logged_in", accountLabel: "grace@example.com" });
  await userEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(
    await within(await rowOf("Codex")).findByText(
      "Signed in as grace@example.com",
      {},
      { timeout: 10_000 },
    ),
  ).toBeTruthy();
}, 30_000);

test("a CLI that isn't installed says how to install it on its page", async () => {
  const app = harness();
  app.daemon.services.installed.delete("codex");
  stage(app, "codex", { installed: false });
  await app.open("/settings/providers");
  await userEvent.click(
    within(await section("Not installed")).getByRole("link", { name: "Codex" }),
  );
  const install = await screen.findByRole("region", { name: "Install" });
  expect(within(install).getByText("npm install -g @openai/codex")).toBeTruthy();
  expect(within(install).getByRole("button", { name: "Check again" })).toBeTruthy();
  // Nothing to sign out of, and no models to list.
  expect(screen.queryByRole("region", { name: "Sign out of Codex" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Models" })).toBeNull();
}, 30_000);

test("Show models lists a provider's models by name, older ones folded away", async () => {
  await harness().open("/settings/providers/codex");
  const models = await screen.findByRole("region", { name: "Models" }, { timeout: 10_000 });
  await userEvent.click(await within(models).findByRole("button", { name: /^Show models/ }));
  const shown = await within(models).findByRole("list", { name: "Models" });
  const personal = await within(shown).findByRole("group", { name: "Personal" });
  expect(within(personal).getByText("GPT-6.1 Sol")).toBeTruthy();
  // Names only: no raw ids, and the older models wait behind Legacy models.
  expect(shown.textContent).not.toMatch(/gpt-6\.1-sol|gpt-5-codex/);
  expect(within(personal).queryByText("GPT-5.5")).toBeNull();
  await userEvent.click(within(personal).getByRole("button", { name: "Legacy models (4)" }));
  expect(within(personal).getByText("GPT-5.5")).toBeTruthy();
}, 30_000);

test("a provider's default model can be changed, even to a legacy one, and reads as the person's", async () => {
  const app = harness();
  await app.open("/settings/providers/claude");
  const models = await screen.findByRole("region", { name: "Models" }, { timeout: 10_000 });
  await userEvent.click(
    await within(models).findByRole("button", { name: "Default model: Opus 5.5" }),
  );
  const picker = await screen.findByRole("listbox", { name: "Models" });
  // One list for the provider: the default is the provider's, whichever account runs it.
  expect(within(picker).queryByRole("group", { name: "Work" })).toBeNull();
  await userEvent.click(within(picker).getByRole("option", { name: "Legacy models, 6" }));
  await userEvent.click(within(picker).getByRole("option", { name: /^Sonnet 4\.5/ }));

  expect(
    await within(models).findByRole("button", { name: "Default model: Sonnet 4.5, Your choice" }),
  ).toBeTruthy();
  expect(app.daemon.services.settings.get("providers.configuration")).toEqual([
    { provider: "claude", defaultModel: "claude-sonnet-4-5" },
  ]);
  await userEvent.click(within(models).getByRole("button", { name: "Reset" }));
  expect(
    await within(models).findByRole("button", { name: "Default model: Opus 5.5" }),
  ).toBeTruthy();
}, 30_000);

test("a provider's page shows its recent tokens and what they'd cost at API prices, as an estimate", async () => {
  await harness().open("/settings/providers/claude");
  const usage = await screen.findByRole("region", { name: "Usage" }, { timeout: 10_000 });
  await within(usage).findByRole("list", { name: "Tokens per day" });
  expect(within(usage).getByText(/^Estimate\./)).toBeTruthy();
  expect(within(usage).getByText(/^\$[\d,.]+$/)).toBeTruthy();
}, 30_000);

test("an ACP agent added by command joins the list, and its page removes it", async () => {
  await harness().open("/settings/providers");
  const agents = await section("ACP agents");
  await userEvent.click(within(agents).getByRole("button", { name: "Add" }));
  const dialog = await screen.findByRole(
    "dialog",
    { name: "Add an ACP agent" },
    { timeout: 10_000 },
  );
  await userEvent.click(await within(dialog).findByRole("button", { name: "Add by command" }));
  const form = await screen.findByRole("form", { name: "Add an ACP agent by command" });
  await userEvent.click(within(form).getByRole("button", { name: "Add agent" }));
  expect(await within(form).findByText("Give the agent a name.")).toBeTruthy();
  await userEvent.type(within(form).getByRole("textbox", { name: "Name" }), "Qwen Code");
  await userEvent.type(within(form).getByRole("textbox", { name: "Command" }), "qwen --acp");
  await userEvent.click(within(form).getByRole("button", { name: "Add agent" }));
  await waitFor(() =>
    expect(screen.queryByRole("form", { name: "Add an ACP agent by command" })).toBeNull(),
  );

  await userEvent.click(await within(agents).findByRole("link", { name: "Qwen Code" }));
  await userEvent.click(await screen.findByRole("button", { name: "Remove Qwen Code" }));
  expect(await section("ACP agents")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("link", { name: "Qwen Code" })).toBeNull());
}, 30_000);
