import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

// General's lazy body must be transformed before the first interaction's deadline starts.
await import("./general-page.tsx");

const select = () => screen.findByRole("combobox", { name: "Default provider for new threads" });

async function offered() {
  await userEvent.click(await select());
  return (await screen.findAllByRole("option")).map((option) => option.textContent);
}

test("Settings offers an installed Codex CLI with unverified login as sign-in unknown", async () => {
  const app = harness();
  const { services } = app.daemon;
  services.accounts = services.accounts.filter((account) => account.provider !== "codex");
  services.models = services.models.filter((model) => model.provider !== "codex");
  const codex = services.providerStatuses.find((status) => status.provider === "codex");
  if (codex) codex.auth = "unknown";
  await app.open("/settings/general");

  expect(await offered()).toContain("Codex (sign-in not reported)");
  await userEvent.click(screen.getByRole("option", { name: "Codex (sign-in not reported)" }));
  await waitFor(() => expect(services.settings.get("providers.default")).toBe("codex"));
});

test("the Providers list trusts working models for unreported login and refreshes reported sign-in", async () => {
  const app = harness();
  const { services } = app.daemon;
  services.accounts = services.accounts.filter((account) => account.provider !== "codex");
  const codex = services.providerStatuses.find((status) => status.provider === "codex");
  if (!codex) throw new Error("Missing Codex discovery");
  codex.auth = "unknown";
  codex.updateAvailable = false;
  await app.open("/settings/providers");

  const row = await screen.findByRole("group", { name: "Codex" }, { timeout: 10_000 });
  // It lists models, so it works; nothing in the list calls it unknown.
  expect(await within(row).findByText("Ready")).toBeTruthy();
  codex.auth = "logged_out";
  await userEvent.click(screen.getByRole("button", { name: "Check again" }));
  await within(row).findByRole("button", { name: "Sign in to Codex" });
  codex.auth = "logged_in";
  await userEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(await within(row).findByText("Ready", {}, { timeout: 10_000 })).toBeTruthy();
  expect(within(row).queryByRole("button", { name: "Sign in to Codex" })).toBeNull();
});

test("a CLI whose ace accounts are all signed out is offered as not signed in", async () => {
  const app = harness();
  const { services } = app.daemon;
  for (const account of services.accounts)
    if (account.provider === "claude") {
      account.availability = "logged_out";
      account.quota.auth = "logged_out";
    }
  // The CLI's own login doesn't say otherwise.
  const claude = services.providerStatuses.find((status) => status.provider === "claude");
  if (claude) claude.auth = "unknown";
  await app.open("/settings/general");

  expect(await offered()).toEqual([
    "Claude Code (signed out)",
    "Codex",
    "OpenCode",
    "Cursor (needs attention)",
    "Pi",
    "Gemini CLI",
  ]);
});

test("a CLI discovery didn't find isn't offered, but the stored choice of it stays visible", async () => {
  const app = harness();
  const { services } = app.daemon;
  services.installed.delete("claude");
  const claude = services.providerStatuses.find((status) => status.provider === "claude");
  if (!claude) throw new Error("Missing Claude discovery");
  claude.installed = false;
  services.accounts = services.accounts.filter((account) => account.provider !== "claude");
  await app.open("/settings/general");

  await waitFor(async () => expect((await select()).textContent).toContain("(not installed)"));
  expect(await offered()).toEqual([
    "Claude Code (not installed)",
    "Codex",
    "OpenCode",
    "Cursor (needs attention)",
    "Pi",
    "Gemini CLI",
  ]);
});

test("with no default picked, Settings shows the installed provider new threads start on", async () => {
  const app = harness();
  const { services } = app.daemon;
  services.settings.unset("providers.default");
  services.installed.delete("claude");
  const claude = services.providerStatuses.find((status) => status.provider === "claude");
  if (!claude) throw new Error("Missing Claude discovery");
  claude.installed = false;
  await app.open("/settings/general");

  await waitFor(async () => expect((await select()).textContent).toBe("Codex"));
  expect(screen.getByText(/Until you pick one, new threads start on the provider/)).toBeTruthy();
});
