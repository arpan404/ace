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
        name === "Claude Code" ? "Signed in as ada@example.com" : "Signed in",
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
  const field = await screen.findByLabelText("Codex API key");
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
