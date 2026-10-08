import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

type Harness = ReturnType<typeof harness>;

/** Providers › ACP agents › Add: the registry browser, its steps held for the test. */
async function openRegistry(app: Harness = harness()) {
  app.daemon.services.registry.stepMs = null;
  await app.open("/settings/providers");
  const agents = await screen.findByRole("region", { name: "ACP agents" }, { timeout: 10_000 });
  await userEvent.click(within(agents).getByRole("button", { name: "Add" }));
  const dialog = await screen.findByRole(
    "dialog",
    { name: "Add an ACP agent" },
    { timeout: 10_000 },
  );
  await within(dialog).findByRole("option", { name: /Kimi CLI/ }, { timeout: 10_000 });
  return { app, dialog, registry: app.daemon.services.registry };
}

const names = (dialog: HTMLElement) =>
  within(dialog)
    .queryAllByRole("option")
    .map((option) => option.textContent ?? "");

async function search(dialog: HTMLElement, text: string) {
  const field = within(dialog).getByRole("combobox", { name: "Search the ACP registry" });
  await userEvent.clear(field);
  if (text) await userEvent.type(field, text);
}

/** Open an entry the way a keyboard does: search, then Enter on the first match. */
async function openEntry(dialog: HTMLElement, text: string) {
  await search(dialog, text);
  await userEvent.keyboard("{Enter}");
  return within(dialog).findByRole("heading", { level: 2 });
}

test("search filters the registry by name, publisher and description; installed and unavailable entries say so", async () => {
  const { dialog } = await openRegistry();
  // Unavailable entries sort last and say why; the one installed a release behind says so.
  const all = names(dialog);
  expect(all.at(-1)).toMatch(/Poolside.*Not built for this computer/);
  expect(all.find((row) => row.includes("goose"))).toMatch(/Ships in a format ace can't install/);
  expect(all.find((row) => row.includes("Gemini CLI"))).toMatch(/Update available/);

  await search(dialog, "kimi");
  expect(names(dialog)).toEqual([expect.stringMatching(/^Kimi CLI/)]);
  await search(dialog, "google");
  expect(names(dialog)).toEqual([expect.stringMatching(/^Gemini CLI/)]);
  await search(dialog, "pair programmer");
  expect(names(dialog)).toEqual([expect.stringMatching(/^GitHub Copilot/)]);
  await search(dialog, "nothing like this");
  expect(names(dialog)).toEqual([]);
  expect(within(dialog).getByText(/No agents match/)).toBeTruthy();
}, 30_000);

test("arrow keys move through the results and Enter opens one", async () => {
  const { dialog } = await openRegistry();
  await search(dialog, "code");
  // Name matches lead: Codex starts with it, Qwen Code has it as a word.
  expect(names(dialog).slice(0, 2)).toEqual([
    expect.stringMatching(/^Codex/),
    expect.stringMatching(/^Qwen Code/),
  ]);
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(await within(dialog).findByRole("heading", { level: 2, name: "Qwen Code" })).toBeTruthy();
}, 30_000);

test("a stale cache shows at once, then the background refresh brings the new list", async () => {
  const app = harness();
  const registry = app.daemon.services.registry;
  registry.fetchedAt = Date.now() - 2 * 86_400_000;
  const [first] = registry.entries;
  if (!first) throw new Error("Empty fixture");
  registry.upstream = [
    ...registry.entries,
    {
      ...first,
      agent: { ...first.agent, acpAgentId: "official:newcomer", name: "Newcomer Agent" },
    },
  ];
  const { dialog } = await openRegistry(app);
  // The cached entries are there before the refresh lands, with the refresh visibly running.
  expect(within(dialog).getByText("Updating…")).toBeTruthy();
  expect(names(dialog).some((row) => row.includes("Newcomer Agent"))).toBe(false);
  registry.step();
  expect(
    await within(dialog).findByRole("option", { name: /Newcomer Agent/ }, { timeout: 10_000 }),
  ).toBeTruthy();
  expect(await within(dialog).findByText("Updated just now")).toBeTruthy();
}, 30_000);

test("install shows the plan, asks once more, sends the intent with the plan's digest, then shows progress and the result", async () => {
  const { app, dialog, registry } = await openRegistry();
  expect(await openEntry(dialog, "kimi")).toHaveProperty("textContent", "Kimi CLI");
  const plan = await within(dialog).findByLabelText("Install plan", {}, { timeout: 5_000 });
  expect(plan.textContent).toContain("Download from github.com");
  expect(plan.textContent).toContain("Prebuilt binary for macOS on Apple silicon");
  expect(plan.textContent).toContain("SHA-256 checksum from the registry");
  expect(plan.textContent).toMatch(/installations\/[a-f0-9]{64}\/kimi acp/);

  await userEvent.click(within(dialog).getByRole("button", { name: "Install" }));
  // Nothing is sent until the person confirms.
  expect(registry.intents).toEqual([]);
  await userEvent.click(within(dialog).getByRole("button", { name: "Confirm install" }));
  const [reviewed] = [...registry.plans.keys()];
  await waitFor(() =>
    expect(registry.intents).toEqual([{ intentId: expect.any(String), digest: reviewed }]),
  );

  registry.step(); // preparing → downloading
  expect(
    await within(dialog).findByText(/Downloading · 7\.5 MB/, {}, { timeout: 5_000 }),
  ).toBeTruthy();
  while (registry.step()) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    await within(dialog).findByText("Kimi CLI 1.52.0 is installed", {}, { timeout: 5_000 }),
  ).toBeTruthy();
  expect(within(dialog).getByText(/signs in with its own CLI/)).toBeTruthy();

  // It's a provider now.
  await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  const agents = await screen.findByRole("region", { name: "ACP agents" });
  expect(await within(agents).findByRole("link", { name: "Kimi CLI" })).toBeTruthy();
  expect(app.daemon.services.registry.installations.at(-1)?.acpAgentId).toBe("official:kimi");
}, 30_000);

test("cancel stops an install and nothing is installed", async () => {
  const { dialog, registry } = await openRegistry();
  await openEntry(dialog, "mistral");
  await userEvent.click(await within(dialog).findByRole("button", { name: "Install" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Confirm install" }));
  registry.step();
  await within(dialog).findByText(/Downloading/, {}, { timeout: 5_000 });
  const before = registry.installations.length;
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(
    await within(dialog).findByText("Installation cancelled. Nothing was changed."),
  ).toBeTruthy();
  while (registry.step());
  expect(registry.installations).toHaveLength(before);
}, 30_000);

test("failures read as fixed, friendly words, never the daemon's raw output", async () => {
  const { dialog, registry } = await openRegistry();
  registry.missingManagers.add("npm");
  await openEntry(dialog, "cline");
  expect(
    await within(dialog).findByText(/ace couldn't find the package manager this agent needs/),
  ).toBeTruthy();

  await userEvent.click(within(dialog).getByRole("button", { name: "Back to the registry" }));
  registry.failInstall = "npm ERR! 401 token=sk-secret-value in /Users/ada/.npmrc";
  await openEntry(dialog, "amp");
  await userEvent.click(await within(dialog).findByRole("button", { name: "Install" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Confirm install" }));
  while (registry.step()) await new Promise((resolve) => setTimeout(resolve, 0));
  const alert = await within(dialog).findByRole("alert", {}, { timeout: 5_000 });
  expect(alert.textContent).toBe("That didn't work. Try again.");
  expect(dialog.textContent).not.toMatch(/npm ERR|sk-secret|npmrc/);
}, 30_000);

test("an agent the registry doesn't list is added by command, from a quiet link", async () => {
  const { dialog } = await openRegistry();
  await userEvent.click(within(dialog).getByRole("button", { name: "Add by command" }));
  const form = await within(dialog).findByRole("form", { name: "Add an ACP agent by command" });
  await userEvent.click(within(form).getByRole("button", { name: "Add agent" }));
  expect(await within(form).findByText("Give the agent a name.")).toBeTruthy();
  await userEvent.type(within(form).getByRole("textbox", { name: "Name" }), "House Agent");
  await userEvent.type(within(form).getByRole("textbox", { name: "Command" }), "house --acp");
  await userEvent.click(within(form).getByRole("button", { name: "Add agent" }));
  const agents = await screen.findByRole("region", { name: "ACP agents" });
  expect(await within(agents).findByRole("link", { name: "House Agent" })).toBeTruthy();
}, 30_000);

test("an agent installed a release behind offers Update on its page, which opens its plan", async () => {
  const app = harness();
  app.daemon.services.registry.stepMs = null;
  await app.open("/settings/providers");
  await userEvent.click(
    await screen.findByRole("link", { name: "Gemini CLI" }, { timeout: 10_000 }),
  );
  const about = await screen.findByRole("region", { name: "About" }, { timeout: 10_000 });
  expect(within(about).getByText("ACP registry")).toBeTruthy();
  const cli = await screen.findByRole("region", { name: "CLI" });
  await userEvent.click(within(cli).getByRole("button", { name: "Check for updates" }));
  expect(
    await within(cli).findByRole("link", { name: "Official setup instructions" }),
  ).toBeTruthy();
  expect(await within(cli).findByRole("button", { name: "Update CLI" })).toBeTruthy();
  expect(within(cli).getByText(/npm install/).textContent).toContain("@google/gemini-cli");
}, 30_000);
