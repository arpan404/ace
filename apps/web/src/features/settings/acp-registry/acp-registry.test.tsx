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

test("one click installs a registry agent, then its own sign-in makes it ready in the same dialog", async () => {
  const { app, dialog } = await openRegistry();
  app.daemon.services.providerInstalls.autoComplete = false;
  await openEntry(dialog, "kimi");
  await userEvent.click(await within(dialog).findByRole("button", { name: "Install" }));
  await within(dialog).findByRole("progressbar", { name: "Kimi CLI installation progress" });
  app.daemon.services.providerInstalls.complete("fake-install-1");
  await userEvent.click(await within(dialog).findByRole("button", { name: "Sign in to Kimi CLI" }));
  const login = await screen.findByRole("dialog", { name: "Sign in to Kimi CLI" });
  await within(login).findByRole("link", { name: "Open sign-in page" });
  app.daemon.services.providerLogin.complete("fake-login-1");
  await userEvent.click(await within(login).findByRole("button", { name: "Done" }));
  expect(await within(dialog).findByText("Ready")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Close agent setup" }));
  expect(
    await within(await screen.findByRole("region", { name: "ACP agents" })).findByRole("link", {
      name: "Kimi CLI",
    }),
  ).toBeTruthy();
}, 30_000);

test("cancelling a registry install leaves the agent available to install again", async () => {
  const { app, dialog, registry } = await openRegistry();
  app.daemon.services.providerInstalls.autoComplete = false;
  const before = registry.installations.length;
  await openEntry(dialog, "mistral");
  await userEvent.click(await within(dialog).findByRole("button", { name: "Install" }));
  await within(dialog).findByRole("progressbar");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Cancel Mistral Vibe installation" }),
  );
  expect(await within(dialog).findByText("Cancelled")).toBeTruthy();
  expect(await within(dialog).findByRole("button", { name: "Install" })).toBeTruthy();
  expect(registry.installations).toHaveLength(before);
}, 30_000);

test("registry prerequisites and failures give a way to retry on the agent's page", async () => {
  const { app, dialog } = await openRegistry();
  app.daemon.services.providerInstalls.scenarios.acp = "missing_prerequisite";
  await openEntry(dialog, "cline");
  await userEvent.click(await within(dialog).findByRole("button", { name: "Install" }));
  expect(await within(dialog).findByRole("link", { name: "Get Node.js" })).toBeTruthy();
  app.daemon.services.providerInstalls.scenarios.acp = "failure";
  await userEvent.click(
    within(dialog).getByRole("button", {
      name: "Retry Cline installation after installing prerequisites",
    }),
  );
  expect(await within(dialog).findByRole("button", { name: "Retry" })).toBeTruthy();
  expect(dialog.textContent).toContain("The installer couldn't finish");
  app.daemon.services.providerInstalls.scenarios.acp = "success";
  await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
  expect(await within(dialog).findByRole("button", { name: "Sign in to Cline" })).toBeTruthy();
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

test("an outdated registry agent updates directly from its Setup row", async () => {
  const app = harness();
  app.daemon.services.providerInstalls.autoComplete = false;
  await app.open("/settings/providers");
  await userEvent.click(
    await screen.findByRole("link", { name: "Gemini CLI" }, { timeout: 10_000 }),
  );
  const setup = await screen.findByRole("region", { name: "Setup" });
  await userEvent.click(await within(setup).findByRole("button", { name: "Update" }));
  await within(setup).findByRole("progressbar", { name: "Gemini CLI installation progress" });
  app.daemon.services.providerInstalls.complete("fake-install-1");
  await waitFor(() => expect(within(setup).queryByRole("button", { name: "Update" })).toBeNull());
}, 30_000);

test("registry identifies agents already available through their native provider", async () => {
  const { dialog } = await openRegistry();
  const claude = await within(dialog).findByRole("option", { name: /^Claude/ });
  await within(claude).findByText("Already added");
  const opencode = within(dialog).getByRole("option", { name: /^OpenCode/ });
  expect(within(opencode).getByText("Already added")).toBeTruthy();
  expect(within(dialog).queryByRole("option", { name: /^Kimi CLI.*Already added/ })).toBeNull();
});
