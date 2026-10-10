import { configure, act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => localStorage.clear());

test("Codex's usable sibling and Gemini's daily quota agree on Usage and provider pages", async () => {
  await harness().open("/accounts");
  const codex = await screen.findByRole("article", { name: "Codex Personal" });
  expect(
    within(codex).getByRole("meter", { name: "5-hour window" }).getAttribute("aria-valuenow"),
  ).toBe("38");
  const gemini = await screen.findByRole("article", { name: "Gemini CLI Google" });
  expect(
    within(gemini).getByRole("meter", { name: "Daily window" }).getAttribute("aria-valuenow"),
  ).toBe("71");
  await userEvent.click(
    screen.getByRole("link", { name: "Manage accounts in Settings › Providers." }),
  );
  const row = await screen.findByRole("group", { name: "Codex" });
  expect(within(row).queryByRole("button", { name: "Sign in to Codex" })).toBeNull();
  await userEvent.click(within(row).getByRole("link", { name: "Codex" }));
  const accounts = await screen.findByRole("list", { name: "Codex accounts" });
  expect(
    within(accounts).getByRole("meter", { name: "5-hour window" }).getAttribute("aria-valuenow"),
  ).toBe("38");
});

test("API-key reauthentication clears input and refreshes the account without storing the key", async () => {
  const storage = memoryKeyValue();
  const app = harness({ storage });
  await app.open("/settings/providers/codex");
  const accounts = await screen.findByRole("list", { name: "Codex accounts" });
  await userEvent.click(within(accounts).getByRole("button", { name: "Manage Your CLI login" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Use API key" }));
  const field = await screen.findByLabelText("OpenAI API key");
  await userEvent.type(field, "fake-key-for-ui-test");
  await userEvent.click(screen.getByRole("button", { name: "Use key" }));
  expect(field).toHaveProperty("value", "");
  await waitFor(() => expect(screen.queryByLabelText("OpenAI API key")).toBeNull());
  expect([...storage.data.values()].join(" ")).not.toContain("fake-key-for-ui-test");
  expect(JSON.stringify(app.daemon.services.accounts)).not.toContain("fake-key-for-ui-test");
});

test("CLI installation and removal show progress and recover after reconnect", async () => {
  const app = harness();
  app.daemon.services.providerInstalls.autoComplete = false;
  app.daemon.services.installed.delete("codex");
  const status = app.daemon.services.providerStatuses.find((row) => row.provider === "codex");
  if (!status) throw new Error("Missing Codex fixture");
  status.installed = false;
  await app.open("/settings/providers/codex");
  await userEvent.click(await screen.findByRole("button", { name: "Install" }));
  await screen.findByRole("progressbar");
  app.daemon.refuseConnections(true);
  await waitFor(() => expect(app.client.connectionState().getSnapshot()).not.toBe("ready"));
  app.daemon.services.providerInstalls.complete("fake-install-1");
  app.daemon.refuseConnections(false);
  await userEvent.click(await screen.findByRole("button", { name: "Manage Codex" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Remove…" }));
  await screen.findByText(/Remove Codex's CLI from this computer/);
  await userEvent.click(screen.getByRole("button", { name: "Remove CLI" }));
  await screen.findByRole("progressbar");
  app.daemon.services.providerInstalls.complete("fake-install-2");
  expect(await screen.findByRole("button", { name: "Install" })).toBeTruthy();
});

test("leaving a provider page during update resumes the same job in the Providers list", async () => {
  const app = harness({ storage: memoryKeyValue() });
  app.daemon.services.providerInstalls.autoComplete = false;
  await app.open("/settings/providers/codex");
  await userEvent.click(await screen.findByRole("button", { name: "Update" }));
  await screen.findByRole("progressbar");
  await userEvent.click(screen.getByRole("link", { name: "Back to Providers" }));
  const group = await screen.findByRole("group", { name: "Codex" });
  await within(group).findByRole("progressbar");
  app.daemon.services.providerInstalls.complete("fake-install-1");
  await waitFor(() => expect(within(group).queryByRole("progressbar")).toBeNull());
  expect(await within(group).findByText("Installed")).toBeTruthy();
});

test("live limits replace a signed-in meter without losing the reason or resetless blocker", async () => {
  const app = harness();
  await app.open("/settings/providers/codex");
  const accounts = await screen.findByRole("list", { name: "Codex accounts" });
  const personal = app.daemon.services.accounts.find((row) => row.id === "codex-personal");
  if (!personal) throw new Error("Missing Personal fixture");
  await within(accounts).findByRole("meter", { name: "5-hour window" });
  await act(async () =>
    app.daemon.services.updateQuota(personal.id, {
      ...personal.quota,
      observedAt: personal.quota.observedAt + 1,
      windows: { daily: { usedPercent: 100, resetsAt: null } },
    }),
  );
  const item = (await within(accounts).findByText("Personal")).closest("li");
  if (!item) throw new Error("Missing Personal row");
  expect(await within(item).findByText("Limit reached")).toBeTruthy();
  expect(within(item).queryByRole("meter")).toBeNull();
  await userEvent.click(screen.getByRole("link", { name: "Back to Providers" }));
  expect(
    await within(await screen.findByRole("group", { name: "Codex" })).findByText("Limit reached"),
  ).toBeTruthy();
});

test("Cursor shows its SDK version and never offers CLI uninstall or a CLI path", async () => {
  await harness().open("/settings/providers/cursor");
  await screen.findByRole("list", { name: "Cursor accounts" });
  await userEvent.click(screen.getByText("Advanced", { selector: "summary" }));
  const about = await screen.findByRole("region", { name: "About" });
  expect(within(about).getByText("SDK version")).toBeTruthy();
  expect(within(about).getByText("1.0.35")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "CLI path" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove CLI" })).toBeNull();
});

test("Manage models retains free models and their upstream distinctions", async () => {
  await harness().open("/settings/providers/opencode");
  await userEvent.click(await screen.findByRole("button", { name: "Manage" }));
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

test("the add-account dialog cancels an API-key handoff without storing its input", async () => {
  const storage = memoryKeyValue();
  const app = harness({ storage });
  await app.open("/settings/providers/opencode");
  await userEvent.click(await screen.findByRole("button", { name: "+ Add account" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Add an OpenCode account" }));
  await userEvent.type(dialog.getByRole("textbox", { name: "Account name" }), "Research");
  await userEvent.click(dialog.getByRole("combobox", { name: "Sign-in method" }));
  await userEvent.click(await screen.findByRole("option", { name: "API key" }));
  await userEvent.click(dialog.getByRole("button", { name: "Add and sign in" }));
  const field = await dialog.findByLabelText("OpenAI API key");
  await userEvent.type(field, "fake-key-that-must-be-cleared");
  await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(field).toHaveProperty("value", "");
  await waitFor(() => expect(screen.queryByLabelText("OpenAI API key")).toBeNull());
  expect([...storage.data.values()].join(" ")).not.toContain("fake-key-that-must-be-cleared");
});
