import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AccountSummary } from "@ace/protocol/accounts";
import { harness } from "@/test/harness.tsx";

/** Antigravity installed and signed in, with its CLI login as the daemon keeps it. */
export async function antigravityPage(overrides: Partial<AccountSummary> = {}) {
  const app = harness();
  const services = app.daemon.services;
  services.installed.add("antigravity");
  const status = services.providerStatuses.find((row) => row.provider === "antigravity");
  if (!status) throw new Error("Missing Antigravity status");
  Object.assign(status, { installed: true, version: "1.4.1", auth: "logged_in" });
  const example = services.accounts.find((entry) => entry.provider === "acp");
  if (!example) throw new Error("Missing ACP account fixture");
  services.accounts.push({
    ...example,
    id: "antigravity-cli-default",
    acpAgentId: "official:antigravity-acp",
    installationId: "antigravity-cli",
    instanceId: "antigravity-cli-default",
    homeStrategy: "default_cli",
    label: "Antigravity",
    isDefault: true,
    ...overrides,
  });
  // The CLI login's catalog, so an account that signs in has models to list.
  const template = services.models.find((entry) => entry.provider === "claude");
  if (!template) throw new Error("Missing model fixture");
  services.models.push({
    ...template,
    id: "gemini-3.8-flash",
    nativeModelId: "gemini-3.8-flash",
    displayName: "Gemini 3.8 Flash",
    provider: "antigravity",
    instance: "antigravity-cli-default",
  });
  await app.open("/settings/providers");
  await userEvent.click(
    await screen.findByRole("link", { name: "Antigravity" }, { timeout: 10_000 }),
  );
  const list = await screen.findByRole("list", { name: "Antigravity accounts" });
  const row = async (name: string) => {
    const found = (await within(list).findByText(name)).closest("li");
    if (!found) throw new Error(`No ${name} row`);
    return found;
  };
  const listed = async () =>
    (await app.client.request({ type: "accounts.list" })).accounts.filter(
      (entry) => entry.acpAgentId === "official:antigravity-acp",
    );
  return { app, list, row, listed };
}
