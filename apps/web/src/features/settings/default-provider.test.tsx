import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const select = () => screen.findByRole("combobox", { name: "Default provider for new threads" });

async function offered() {
  await userEvent.click(await select());
  return (await screen.findAllByRole("option")).map((option) => option.textContent);
}

test("Settings offers an installed Codex CLI with unverified login as sign-in unknown", async () => {
  const app = harness();
  const { services } = app.daemon;
  services.accounts = services.accounts.filter((account) => account.provider !== "codex");
  await app.open("/settings/general");

  expect(await offered()).toContain("Codex (sign-in unknown)");
  await userEvent.click(screen.getByRole("option", { name: "Codex (sign-in unknown)" }));
  await waitFor(() => expect(services.settings.get("providers.default")).toBe("codex"));
});

test("the Providers page verifies the CLI login before showing signed in with no ace account", async () => {
  const app = harness();
  const { services } = app.daemon;
  services.accounts = services.accounts.filter((account) => account.provider !== "codex");
  await app.open("/settings/providers");

  const providers = await screen.findByRole("region", { name: "Providers" });
  expect(within(providers).getByText("codex · sign-in unknown")).toBeTruthy();
  const codex = services.providerStatuses.find((status) => status.provider === "codex");
  if (!codex) throw new Error("Missing Codex discovery");
  codex.auth = "logged_in";
  await userEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(await within(providers).findByText("codex · signed in")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Manage Codex" })).toBeTruthy();
});

test("a CLI whose ace accounts are all signed out is offered as not signed in", async () => {
  const app = harness();
  const { services } = app.daemon;
  for (const account of services.accounts)
    if (account.provider === "claude") {
      account.availability = "logged_out";
      account.quota.auth = "logged_out";
    }
  await app.open("/settings/general");

  expect(await offered()).toEqual([
    "Claude Code (not signed in)",
    "Codex",
    "OpenCode",
    "Cursor",
    "Pi (sign-in unknown)",
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
    "Cursor",
    "Pi (sign-in unknown)",
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
