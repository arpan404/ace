import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

type Harness = ReturnType<typeof harness>;

/** Settings › Providers › ACP agents: the registry on the page, its steps held for the test. */
async function openRegistry(app: Harness = harness()) {
  app.daemon.services.registry.stepMs = null;
  await app.open("/settings/providers");
  const hub = await screen.findByRole("region", { name: "ACP agents" }, { timeout: 10_000 });
  await within(hub).findByRole("group", { name: "Amp" }, { timeout: 10_000 });
  return { app, hub, registry: app.daemon.services.registry };
}

/** The agents the group lists, by name, in order. */
const names = (hub: HTMLElement) =>
  within(hub)
    .queryAllByRole("group")
    .map((row) => row.getAttribute("aria-label") ?? "");

async function search(hub: HTMLElement, text: string) {
  const field = within(hub).getByRole("searchbox", { name: "Search agents" });
  await userEvent.clear(field);
  if (text) await userEvent.type(field, text);
}

/** Search for one agent and return its row. */
async function rowFor(hub: HTMLElement, text: string, name: string) {
  await search(hub, text);
  return within(hub).findByRole("group", { name });
}

test("the first few agents show, Show all lists every one and Show fewer folds them again", async () => {
  const { hub } = await openRegistry();
  // Five registry agents, after the built-in providers not on this computer (Antigravity).
  expect(names(hub)[0]).toBe("Antigravity");
  expect(names(hub)).toHaveLength(6);
  const more = within(hub).getByRole("button", { name: /^Show all \d+ agents$/ });
  const total = Number(/\d+/.exec(more.textContent ?? "")?.[0]);
  expect(total).toBeGreaterThan(5);
  await userEvent.click(more);
  expect(names(hub)).toHaveLength(total + 1);
  // What can't install here sorts last and says why, in words, without an Install.
  const last = within(hub).getByRole("group", { name: names(hub).at(-1) ?? "" });
  expect(last.textContent).toMatch(
    /Not built for this computer|Ships in a format ace can't install/,
  );
  expect(within(last).queryByRole("button", { name: "Install" })).toBeNull();
  const goose = within(hub).getByRole("group", { name: "goose" });
  expect(within(goose).getByText("Ships in a format ace can't install")).toBeTruthy();
  await userEvent.click(within(hub).getByRole("button", { name: "Show fewer" }));
  expect(names(hub)).toHaveLength(6);
}, 30_000);

test("search filters the agents by name, publisher and description", async () => {
  const { hub } = await openRegistry();
  await search(hub, "kimi");
  expect(names(hub)).toEqual(["Kimi CLI"]);
  await search(hub, "pair programmer");
  expect(names(hub)).toEqual(["GitHub Copilot"]);
  await search(hub, "Mistral AI");
  expect(names(hub)).toEqual(["Mistral Vibe"]);
  // A search shows every match, with no Show all.
  expect(within(hub).queryByRole("button", { name: /^Show all/ })).toBeNull();
  await search(hub, "nothing like this");
  expect(names(hub)).toEqual([]);
  expect(within(hub).getByText(/No agents match/)).toBeTruthy();
}, 30_000);

test("agents ace already has are left out: added ones are under Installed", async () => {
  const { hub } = await openRegistry();
  for (const [text, name] of [
    ["claude", "Claude"],
    ["opencode", "OpenCode"],
    ["gemini", "Gemini CLI"],
  ] as const) {
    await search(hub, text);
    expect(names(hub).some((row) => row.startsWith(name))).toBe(false);
  }
  const installed = screen.getByRole("region", { name: "Installed" });
  expect(within(installed).getByRole("link", { name: "Gemini CLI" })).toBeTruthy();
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
  const { hub } = await openRegistry(app);
  // The cached entries are there before the refresh lands, with the refresh visibly running.
  expect(within(hub).getByText(/updating…/)).toBeTruthy();
  await search(hub, "newcomer");
  expect(names(hub)).toEqual([]);
  registry.step();
  expect(
    await within(hub).findByRole("group", { name: "Newcomer Agent" }, { timeout: 10_000 }),
  ).toBeTruthy();
  expect(await within(hub).findByText(/updated just now/)).toBeTruthy();
}, 30_000);

test("an agent installs in place with progress, then reads Installed with Set up and joins Installed", async () => {
  const { app, hub } = await openRegistry();
  app.daemon.services.providerInstalls.autoComplete = false;
  const row = await rowFor(hub, "kimi", "Kimi CLI");
  await userEvent.click(within(row).getByRole("button", { name: "Install" }));
  await within(row).findByRole("progressbar", { name: "Kimi CLI installation progress" });
  expect(within(row).getByText("Installing…")).toBeTruthy();
  app.daemon.services.providerInstalls.complete("fake-install-1");
  expect(await within(row).findByText("Installed")).toBeTruthy();
  expect(within(row).getByRole("link", { name: "Set up Kimi CLI" }).getAttribute("href")).toContain(
    "/settings/providers/acp",
  );
  const installed = screen.getByRole("region", { name: "Installed" });
  expect(
    await within(installed).findByRole("link", { name: "Kimi CLI" }, { timeout: 10_000 }),
  ).toBeTruthy();
}, 30_000);

test("cancelling an install leaves the agent available to install again", async () => {
  const { app, hub, registry } = await openRegistry();
  app.daemon.services.providerInstalls.autoComplete = false;
  const before = registry.installations.length;
  const row = await rowFor(hub, "mistral", "Mistral Vibe");
  await userEvent.click(within(row).getByRole("button", { name: "Install" }));
  await within(row).findByRole("progressbar");
  await userEvent.click(
    within(row).getByRole("button", { name: "Cancel Mistral Vibe installation" }),
  );
  expect(await within(row).findByText("Cancelled")).toBeTruthy();
  expect(await within(row).findByRole("button", { name: "Install" })).toBeTruthy();
  expect(registry.installations).toHaveLength(before);
}, 30_000);

test("a missing prerequisite and a failure each give a way to retry on the row", async () => {
  const { app, hub } = await openRegistry();
  app.daemon.services.providerInstalls.scenarios.acp = "missing_prerequisite";
  const row = await rowFor(hub, "cline", "Cline");
  await userEvent.click(within(row).getByRole("button", { name: "Install" }));
  expect(await within(row).findByRole("link", { name: "Get Node.js" })).toBeTruthy();
  app.daemon.services.providerInstalls.scenarios.acp = "failure";
  await userEvent.click(
    within(row).getByRole("button", {
      name: "Retry Cline installation after installing prerequisites",
    }),
  );
  expect(await within(row).findByText("Install failed")).toBeTruthy();
  expect(row.textContent).toContain("The official installer failed. Try again.");
  app.daemon.services.providerInstalls.scenarios.acp = "success";
  await userEvent.click(within(row).getByRole("button", { name: "Retry" }));
  expect(await within(row).findByText("Installed")).toBeTruthy();
}, 30_000);

test("an agent the registry doesn't list is added by command from the group's last row", async () => {
  const { hub } = await openRegistry();
  await userEvent.click(within(hub).getByRole("button", { name: "Add an agent by command" }));
  const form = await screen.findByRole("form", { name: "Add an ACP agent by command" });
  await userEvent.click(within(form).getByRole("button", { name: "Add agent" }));
  expect(await within(form).findByText("Give the agent a name.")).toBeTruthy();
  await userEvent.type(within(form).getByRole("textbox", { name: "Name" }), "House Agent");
  await userEvent.type(within(form).getByRole("textbox", { name: "Command" }), "house --acp");
  await userEvent.click(within(form).getByRole("button", { name: "Add agent" }));
  const installed = screen.getByRole("region", { name: "Installed" });
  expect(await within(installed).findByRole("link", { name: "House Agent" })).toBeTruthy();
}, 30_000);

test("an outdated registry agent signs in then updates from its setup actions", async () => {
  const app = harness();
  for (const account of app.daemon.services.accounts) {
    if (account.provider === "acp") {
      account.quota.auth = "unknown";
      account.availability = "unknown";
    }
  }
  const installed = app.daemon.services.registry.installations.find(
    (entry) => entry.acpAgentId === "official:gemini",
  );
  const account = app.daemon.services.accounts.find((entry) => entry.provider === "acp");
  if (!installed || !account) throw new Error("Missing installed ACP fixture");
  const previousInstance = account.id;
  // The account belongs to this registry installation, rather than the legacy named fixture.
  Object.assign(account, {
    id: installed.instanceId,
    acpAgentId: installed.acpAgentId,
    installationId: installed.installationId,
    instanceId: installed.instanceId,
    availability: "logged_out",
    quota: { ...account.quota, auth: "logged_out" },
  });
  app.daemon.services.models = app.daemon.services.models.map((model) =>
    model.instance === previousInstance ? { ...model, instance: installed.instanceId } : model,
  );
  app.daemon.services.providerInstalls.autoComplete = false;
  await app.open("/settings/providers");
  await userEvent.click(
    await screen.findByRole("link", { name: "Gemini CLI" }, { timeout: 10_000 }),
  );
  await screen.findByRole("heading", { level: 2, name: "Gemini CLI" });
  const setup = screen.getByRole("main");
  await userEvent.click(
    await within(setup).findByRole("button", { name: "Sign in to Gemini CLI" }),
  );
  const login = await screen.findByRole("dialog", { name: "Sign in to Gemini CLI" });
  await within(login).findByRole("link", { name: "Open sign-in page" });
  app.daemon.services.providerLogin.complete("fake-login-1");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Sign in to Gemini CLI" })).toBeNull(),
  );
  await userEvent.click(await within(setup).findByRole("button", { name: "Update" }));
  await within(setup).findByRole("progressbar", { name: "Gemini CLI installation progress" });
  app.daemon.services.providerInstalls.complete("fake-install-1");
  await waitFor(() => expect(within(setup).queryByRole("progressbar")).toBeNull());
  expect(await within(setup).findByText("0.63.0")).toBeTruthy();
  await waitFor(() => expect(within(setup).queryByRole("button", { name: "Update" })).toBeNull());
}, 30_000);
