import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

async function openAccounts() {
  await userEvent.click(screen.getByRole("button", { name: /^You, account/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Usage & accounts" }));
  await screen.findByRole("heading", { name: "Usage & accounts", level: 1 });
}
const meter = (element: HTMLElement, name: string) =>
  within(element)
    .getByRole("meter", { name: `${name} window` })
    .getAttribute("aria-valuenow");

test("one world agrees on Codex's usable sibling, Claude's default login and Gemini's daily quota on every surface", async () => {
  const app = harness();
  await app.open("/accounts");
  const codex = await screen.findByRole("article", { name: "Codex Personal" });
  expect(within(codex).getByText("Signed in")).toBeTruthy();
  expect(meter(codex, "5-hour")).toBe("38");
  const claude = await screen.findByRole("article", { name: "Claude Code ada@example.com" });
  expect(within(claude).getByText("Signed in")).toBeTruthy();
  const gemini = await screen.findByRole("article", { name: "Gemini CLI Google" });
  expect(meter(gemini, "Daily")).toBe("71");

  for (const [name, account, window, used] of [
    ["Codex", "Personal", "5-hour", "38"],
    ["Claude Code", "ada@example.com", undefined, undefined],
    ["Gemini CLI", "Google", "Daily", "71"],
  ] as const) {
    await userEvent.click(screen.getByRole("link", { name }));
    const list = await screen.findByRole("list", { name: `${name} accounts` });
    const item = within(list)
      .getAllByRole("listitem")
      .find((candidate) => within(candidate).queryByText(account ?? ""));
    if (!item) throw new Error(`Missing ${account}`);
    expect(within(item).getByText("Signed in")).toBeTruthy();
    if (window) expect(meter(item, window)).toBe(used);
    expect(screen.queryByText(`Sign in to use ${name}.`)).toBeNull();
    await userEvent.click(screen.getByRole("link", { name: "Back to Providers" }));
    const section = await screen.findByRole("region", {
      name: name === "Gemini CLI" ? "ACP agents" : "On this computer",
    });
    const providerRow = await within(section).findByRole("group", { name });
    expect(
      await within(providerRow).findByText(
        name === "Claude Code"
          ? "Signed in as ada@example.com"
          : name === "Codex"
            ? "Signed in · Personal"
            : "Signed in",
      ),
    ).toBeTruthy();
    await openAccounts();
  }
});

test("signing in with an API key clears the field and refreshes the account without saving the key", async () => {
  const storage = memoryKeyValue();
  const app = harness({ storage });
  await app.open("/settings/providers/codex");
  const list = await screen.findByRole("list", { name: "Codex accounts" });
  await userEvent.click(
    within(list).getByRole("button", { name: "Manage Default (your CLI login)" }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: "Use API key" }));
  const field = await screen.findByLabelText("OpenAI API key");
  await userEvent.type(field, "fake-key-for-ui-test");
  await userEvent.click(screen.getByRole("button", { name: "Use key" }));
  expect(field instanceof HTMLInputElement && field.value).toBe("");
  await userEvent.click(await screen.findByRole("button", { name: "Done" }));
  const item = within(list)
    .getAllByRole("listitem")
    .find((candidate) => within(candidate).queryByText("Default (your CLI login)"));
  if (!item) throw new Error("Default account did not refresh");
  expect(await within(item).findByText("Signed in")).toBeTruthy();
  expect([...storage.data.values()].join(" ")).not.toContain("fake-key-for-ui-test");
  expect(JSON.stringify(app.daemon.services.accounts)).not.toContain("fake-key-for-ui-test");
});

test("CLI install, update and removal show progress and refresh the provider after completion", async () => {
  const app = harness();
  app.daemon.services.providerInstalls.autoComplete = false;
  app.daemon.services.installed.delete("codex");
  const row = app.daemon.services.providerStatuses.find(
    (candidate) => candidate.provider === "codex",
  );
  if (!row) throw new Error("Missing Codex fixture");
  row.installed = false;
  await app.open("/settings/providers/codex");
  const cli = await screen.findByRole("region", { name: "CLI" });
  await userEvent.click(await within(cli).findByRole("button", { name: "Install CLI" }));
  await userEvent.click(await within(cli).findByRole("button", { name: "Install CLI" }));
  await within(cli).findByRole("progressbar", { name: "CLI installation progress" });
  app.daemon.refuseConnections(true);
  await waitFor(() => expect(app.client.connectionState().getSnapshot()).not.toBe("ready"));
  app.daemon.services.providerInstalls.complete("fake-install-1");
  app.daemon.refuseConnections(false);
  expect(await within(cli).findByText("Finished")).toBeTruthy();
  await userEvent.click(within(cli).getByRole("button", { name: "Close" }));
  await userEvent.click(await within(cli).findByRole("button", { name: "Check for updates" }));
  await userEvent.click(await within(cli).findByRole("button", { name: "Update CLI" }));
  await within(cli).findByRole("progressbar", { name: "CLI installation progress" });
  app.daemon.services.providerInstalls.complete("fake-install-2");
  await within(cli).findByText("Finished");
  await userEvent.click(within(cli).getByRole("button", { name: "Close" }));
  await userEvent.click(within(cli).getByRole("button", { name: "Remove CLI" }));
  expect(await within(cli).findByText(/Remove Codex's CLI from this computer/)).toBeTruthy();
  await userEvent.click(within(cli).getByRole("button", { name: "Remove CLI" }));
  await within(cli).findByText("Removing…");
  app.daemon.services.providerInstalls.complete("fake-install-3");
  await within(cli).findByText("Finished");
  await userEvent.click(within(cli).getByRole("button", { name: "Close" }));
  expect(await within(cli).findByRole("button", { name: "Install CLI" })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("region", { name: "Models" })).toBeNull());
});

test("leaving the provider page during installation resumes the same job on return", async () => {
  const app = harness({ storage: memoryKeyValue() });
  app.daemon.services.providerInstalls.autoComplete = false;
  await app.open("/settings/providers/codex");
  const cli = await screen.findByRole("region", { name: "CLI" });
  await userEvent.click(await within(cli).findByRole("button", { name: "Check for updates" }));
  await userEvent.click(await within(cli).findByRole("button", { name: "Update CLI" }));
  await within(cli).findByRole("progressbar", { name: "CLI installation progress" });
  await userEvent.click(screen.getByRole("link", { name: "Back to Providers" }));
  await screen.findByRole("region", { name: "On this computer" });
  app.daemon.services.providerInstalls.complete("fake-install-1");
  await userEvent.click(screen.getByRole("link", { name: "Codex" }));
  expect(
    await within(await screen.findByRole("region", { name: "CLI" })).findByText("Finished"),
  ).toBeTruthy();
});

test("a live limit update changes the provider and account surfaces together", async () => {
  const app = harness();
  await app.open("/settings/providers/codex");
  const list = await screen.findByRole("list", { name: "Codex accounts" });
  const personal = app.daemon.services.accounts.find(
    (account) => account.provider === "codex" && account.label === "Personal",
  );
  if (!personal) throw new Error("Missing Personal fixture");
  app.daemon.services.updateQuota(personal.id, {
    ...personal.quota,
    observedAt: personal.quota.observedAt + 1,
    windows: { daily: { usedPercent: 100, resetsAt: null } },
  });
  await waitFor(() => expect(within(list).getAllByText("Limit reached")).toHaveLength(2));
  await userEvent.click(screen.getByRole("link", { name: "Back to Providers" }));
  const providers = await screen.findByRole("region", { name: "On this computer" });
  expect(await within(providers).findByText("Limit reached")).toBeTruthy();
  await openAccounts();
  const card = await screen.findByRole("article", { name: "Codex Personal" });
  expect(within(card).getByText("Limit reached")).toBeTruthy();
  expect(meter(card, "Daily")).toBe("100");
});

test("Gemini's usage excludes token history belonging to another ACP agent", async () => {
  const app = harness();
  app.daemon.services.usage.sources = [
    {
      provider: "acp",
      account: "other-acp-account",
      model: "other-model",
      daily: 900_000,
      apiUsdPerMillion: 3,
      billing: "api",
      threads: [],
    },
  ];
  await app.open("/settings/providers/acp:Gemini CLI");
  const usage = await screen.findByRole("region", { name: "Usage" });
  expect(await within(usage).findByText(/No token activity recorded/)).toBeTruthy();
  const list = await screen.findByRole("list", { name: "Gemini CLI accounts" });
  expect(meter(list, "Daily")).toBe("71");
});

test("missing model prices never produce a complete API-price estimate", async () => {
  const app = harness();
  await app.open("/settings/providers/opencode");
  const usage = await screen.findByRole("region", { name: "Usage" });
  expect(
    await within(usage).findByText("No complete API-price estimate for this usage."),
  ).toBeTruthy();
});

test("Cursor reports its bundled SDK and offers no CLI management", async () => {
  await harness().open("/settings/providers/cursor");
  const about = await screen.findByRole("region", { name: "About" });
  expect(within(about).getByText("SDK version")).toBeTruthy();
  expect(within(about).getByText("1.0.35")).toBeTruthy();
  expect(screen.queryByLabelText("CLI path")).toBeNull();
  expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove CLI" })).toBeNull();
  expect(
    await within(await screen.findByRole("alert")).findByText("Cursor sign-in has expired."),
  ).toBeTruthy();
});

test("accounts are grouped once per provider even when only the default account reports a version", async () => {
  await harness().open("/accounts");
  await screen.findByRole("article", { name: "OpenCode OpenRouter API" });
  expect(screen.getAllByRole("region", { name: "OpenCode" })).toHaveLength(1);
  expect(screen.getAllByRole("region", { name: "Cursor" })).toHaveLength(1);
  const table = await screen.findByRole("table", { name: "Usage by model" });
  expect(await within(table).findByText("Opus 4.6")).toBeTruthy();
  expect(within(table).getByText("GPT-5.3 Codex")).toBeTruthy();
  expect(within(table).queryByText("claude-opus-4-6")).toBeNull();
});

test("OpenCode lists Free models and distinguishes identically named models by their upstream", async () => {
  await harness().open("/settings/providers/opencode");
  await userEvent.click(await screen.findByRole("button", { name: "Show models" }));
  const models = await screen.findByRole("list", { name: "Models" });
  const zen = within(models).getByRole("list", { name: "OpenCode Zen" });
  expect(within(zen).getByText("Big Pickle")).toBeTruthy();
  expect(within(zen).getByText("Free")).toBeTruthy();
  for (const source of ["Anthropic", "OpenRouter"])
    expect(
      within(within(models).getByRole("list", { name: source })).getByText("Opus 5.5"),
    ).toBeTruthy();
});

test("OpenAI key entry stays inline in an OpenCode account and cancels without storing input", async () => {
  const storage = memoryKeyValue();
  const app = harness({ storage });
  await app.open("/settings/providers/opencode");
  const list = await screen.findByRole("list", { name: "OpenCode accounts" });
  await userEvent.click(within(list).getByRole("button", { name: "Add account" }));
  const form = await screen.findByRole("form", { name: "Add account" });
  expect(within(form).getByText("Add an OpenCode account")).toBeTruthy();
  await userEvent.click(within(form).getByRole("combobox", { name: "Sign-in method" }));
  await userEvent.click(await screen.findByRole("option", { name: "API key" }));
  await userEvent.type(within(form).getByRole("textbox"), "Research");
  await userEvent.click(within(form).getByRole("button", { name: "Add and sign in" }));
  const field = await within(list).findByLabelText("OpenAI API key");
  expect(screen.queryByRole("dialog")).toBeNull();
  await userEvent.type(field, "fake-key-that-must-be-cleared");
  await userEvent.click(within(list).getByRole("button", { name: "Cancel" }));
  expect(field instanceof HTMLInputElement && field.value).toBe("");
  expect(await within(list).findByText("Sign-in cancelled")).toBeTruthy();
  await userEvent.click(within(list).getByRole("button", { name: "Close" }));
  expect(within(list).queryByLabelText("OpenAI API key")).toBeNull();
  expect([...storage.data.values()].join(" ")).not.toContain("fake-key-that-must-be-cleared");
});

test("a missing Antigravity provider links to its ACP download and cannot be enabled", async () => {
  await harness().open("/settings/providers/antigravity");
  const enabled = await screen.findByRole<HTMLInputElement>("switch", { name: "Enable provider" });
  expect(enabled.getAttribute("aria-disabled") === "true" || enabled.disabled).toBe(true);
  expect(enabled.getAttribute("aria-checked")).toBe("false");
  await userEvent.click(await screen.findByRole("button", { name: "How to install" }));
  const link = await screen.findByRole("link", { name: "Official setup instructions" });
  expect(link.getAttribute("href")).toBe(
    "https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json",
  );
  expect(screen.getByText(/Extract the archive with its companion files/)).toBeTruthy();
});
