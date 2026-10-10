import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

async function openAccounts() {
  await userEvent.click(screen.getByRole("link", { name: "Back to app" }));
  await screen.findByRole("heading", { level: 1, name: "New thread" });
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
  const claude = await screen.findByRole("article", { name: "Claude Code Your CLI login" });
  expect(within(claude).getByText("Signed in")).toBeTruthy();
  const gemini = await screen.findByRole("article", { name: "Gemini CLI Google" });
  expect(meter(gemini, "Daily")).toBe("71");

  for (const [name, account] of [
    ["Codex", "Personal", "5-hour", "38"],
    ["Claude Code", "Your CLI login", undefined, undefined],
    ["Gemini CLI", "Google", "Daily", "71"],
  ] as const) {
    await userEvent.click(screen.getByRole("link", { name }));
    const list = await screen.findByRole("list", { name: `${name} accounts` });
    const item = within(list)
      .getAllByRole("listitem")
      .find((candidate) => within(candidate).queryByText(account ?? ""));
    if (!item) throw new Error(`Missing ${account}`);
    expect(within(item).getByText("Signed in")).toBeTruthy();
    expect(within(item).queryByRole("meter")).toBeNull();
    expect(screen.getByRole("link", { name: "View usage ›" })).toBeTruthy();
    expect(screen.queryByText(`Sign in to use ${name}.`)).toBeNull();
    await userEvent.click(screen.getByRole("link", { name: "Back to Providers" }));
    const section = await screen.findByRole("region", {
      name: name === "Gemini CLI" ? "ACP agents" : "On this computer",
    });
    const providerRow = await within(section).findByRole("group", { name });
    expect(
      await within(providerRow).findByText(name === "Claude Code" ? "Ready" : "Update available"),
    ).toBeTruthy();
    await openAccounts();
  }
});

test("signing in with an API key clears the field and refreshes the account without saving the key", async () => {
  const storage = memoryKeyValue();
  const app = harness({ storage });
  await app.open("/settings/providers/codex");
  const list = await screen.findByRole("list", { name: "Codex accounts" });
  await userEvent.click(within(list).getByRole("button", { name: "Manage Your CLI login" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Use API key" }));
  const field = await screen.findByLabelText("OpenAI API key");
  await userEvent.type(field, "fake-key-for-ui-test");
  await userEvent.click(screen.getByRole("button", { name: "Use key" }));
  expect(field instanceof HTMLInputElement && field.value).toBe("");
  await waitFor(() => expect(screen.queryByLabelText("OpenAI API key")).toBeNull());
  const item = within(list)
    .getAllByRole("listitem")
    .find((candidate) => within(candidate).queryByText("Your CLI login"));
  if (!item) throw new Error("Default account did not refresh");
  expect(await within(item).findByText("Signed in")).toBeTruthy();
  expect([...storage.data.values()].join(" ")).not.toContain("fake-key-for-ui-test");
  expect(JSON.stringify(app.daemon.services.accounts)).not.toContain("fake-key-for-ui-test");
});

test("CLI install and removal show progress and refresh the provider after reconnect", async () => {
  const app = harness();
  app.daemon.services.providerInstalls.autoComplete = false;
  app.daemon.services.installed.delete("codex");
  const row = app.daemon.services.providerStatuses.find(
    (candidate) => candidate.provider === "codex",
  );
  if (!row) throw new Error("Missing Codex fixture");
  row.installed = false;
  await app.open("/settings/providers/codex");
  const cli = await screen.findByRole("region", { name: "Setup" });
  await userEvent.click(await within(cli).findByRole("button", { name: "Install" }));
  await within(cli).findByRole("progressbar");
  app.daemon.refuseConnections(true);
  await waitFor(() => expect(app.client.connectionState().getSnapshot()).not.toBe("ready"));
  app.daemon.services.providerInstalls.complete("fake-install-1");
  app.daemon.refuseConnections(false);
  await userEvent.click(await within(cli).findByRole("button", { name: "Remove Codex CLI" }));
  await within(cli).findByText(/Remove Codex's CLI from this computer/);
  await userEvent.click(within(cli).getByRole("button", { name: "Remove CLI" }));
  await within(cli).findByRole("progressbar");
  app.daemon.services.providerInstalls.complete("fake-install-2");
  expect(await within(cli).findByRole("button", { name: "Install" })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("region", { name: "Models" })).toBeNull());
});

test("leaving the provider page during update resumes the same job on the Providers list", async () => {
  const app = harness({ storage: memoryKeyValue() });
  app.daemon.services.providerInstalls.autoComplete = false;
  const row = app.daemon.services.providerStatuses.find(
    (candidate) => candidate.provider === "codex",
  );
  if (!row) throw new Error("Missing Codex fixture");
  row.updateAvailable = true;
  await app.open("/settings/providers/codex");
  const setup = await screen.findByRole("region", { name: "Setup" });
  await userEvent.click(await within(setup).findByRole("button", { name: "Update" }));
  await within(setup).findByRole("progressbar");
  await userEvent.click(screen.getByRole("link", { name: "Back to Providers" }));
  const group = await screen.findByRole("group", { name: "Codex" });
  await within(group).findByRole("progressbar");
  app.daemon.services.providerInstalls.complete("fake-install-1");
  await waitFor(() => expect(within(group).queryByRole("progressbar")).toBeNull());
  expect(await within(group).findByText("Installed")).toBeTruthy();
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

test("provider pages link to the shared usage screen, with separate quota for each ACP agent", async () => {
  await harness().open("/settings/providers/acp:Gemini CLI");
  expect(screen.queryByRole("region", { name: "Usage" })).toBeNull();
  await userEvent.click(await screen.findByRole("link", { name: "View usage ›" }));
  const gemini = await screen.findByRole("article", { name: "Gemini CLI Google" });
  expect(meter(gemini, "Daily")).toBe("71");
  expect(await screen.findByRole("table", { name: "Usage by model" })).toBeTruthy();
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
    await within(await screen.findByRole("region", { name: "Setup" })).findByText(
      "Cursor sign-in has expired.",
    ),
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
      within(models)
        .getAllByRole("list", { name: source })
        .some((list) => within(list).queryByText("Opus 5.5")),
    ).toBe(true);
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
  await waitFor(() => expect(within(list).queryByLabelText("OpenAI API key")).toBeNull());
  expect(within(list).queryByLabelText("OpenAI API key")).toBeNull();
  expect([...storage.data.values()].join(" ")).not.toContain("fake-key-that-must-be-cleared");
});

test("a missing Antigravity provider starts its official ACP registry installation", async () => {
  const app = harness();
  app.daemon.services.providerInstalls.autoComplete = false;
  await app.open("/settings/providers/antigravity");
  const enabled = await screen.findByRole<HTMLInputElement>("switch", { name: "Enable provider" });
  expect(enabled.getAttribute("aria-disabled") === "true" || enabled.disabled).toBe(true);
  const setup = await screen.findByRole("region", { name: "Setup" });
  await userEvent.click(await within(setup).findByRole("button", { name: "Install" }));
  expect(
    await within(setup).findByRole("progressbar", { name: "Antigravity installation progress" }),
  ).toBeTruthy();
});
