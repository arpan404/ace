import { seedColdStartState, seedRealCatalogs } from "@ace/fake-daemon";
import { configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => localStorage.clear());
function fixture() {
  const app = harness();
  seedColdStartState(app.daemon);
  seedRealCatalogs(app.daemon, 1);
  const row = app.daemon.services.providerStatuses.find(
    (candidate) => candidate.provider === "opencode",
  );
  if (row)
    Object.assign(row, {
      auth: "unknown",
      readiness: "needs_attention",
      error: "Some services have no enabled models",
      authDetail: "2 services configured",
    });
  return app;
}

test("OpenCode stays quiet without a Sign in action while another source needs attention", async () => {
  const app = fixture();
  await app.open("/settings/providers");
  const row = await screen.findByRole("group", { name: "OpenCode" });
  expect(within(row).queryByText("Ready")).toBeNull();
  expect(within(row).queryByRole("button", { name: /Sign in/ })).toBeNull();
  await userEvent.click(within(row).getByRole("link", { name: "OpenCode" }));
  const accounts = await screen.findByRole("list", { name: "OpenCode accounts" });
  expect(within(accounts).queryByText("Needs attention")).toBeNull();
  expect(screen.queryByText(/entitlement unverified/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Sign in to OpenCode" })).toBeNull();
});

test("Pi's Ollama Cloud service shows its named mark instead of a letter", async () => {
  await fixture().open("/settings/providers/pi");
  const services = await screen.findByRole("list", { name: "Pi services" });
  expect(await within(services).findByRole("img", { name: "Ollama Cloud" })).toBeTruthy();
  expect(within(services).queryByText("O", { exact: true })).toBeNull();
});

test("a free model whose name says Free carries that word once in the visible model row", async () => {
  await fixture().open("/settings/providers/opencode");
  await userEvent.click(await screen.findByRole("button", { name: "Manage" }));
  const models = await screen.findByRole("list", { name: "Models" });
  const row = within(models)
    .getAllByRole("listitem")
    .findLast((candidate) => within(candidate).queryByText("Exo Free"));
  if (!row) throw new Error("Missing model row");
  expect(within(row).getByText("Exo Free")).toBeTruthy();
  expect(within(row).queryByText("Free", { exact: true })).toBeNull();
});

test("Pi General permissions reports its unavailable modes before the native adapter is admitted", async () => {
  const app = fixture();
  app.daemon.services.installed.delete("pi");
  await app.open("/settings/general");
  const permissions = await screen.findByRole("combobox", { name: "Pi permissions" });
  expect(await within(permissions).findByText("Permissions unavailable")).toBeTruthy();
  expect(permissions.hasAttribute("disabled")).toBe(true);
  const row = screen.getByText("Pi", { exact: true }).parentElement;
  if (!row) throw new Error("Missing Pi permission setting");
  expect(within(row).getByText("No supported permission mode is available.")).toBeTruthy();
  expect(screen.queryByText("Use provider default")).toBeNull();
  expect(screen.queryByText("Couldn't load permission modes. Reconnect and try again.")).toBeNull();
});

test("Usage shows OpenCode's unreported limits quietly while another source needs attention", async () => {
  await fixture().open("/accounts");
  const row = await screen.findByRole("article", { name: "OpenCode Your CLI login" });
  expect(within(row).getByText("Not reported yet")).toBeTruthy();
  expect(within(row).queryByText("Needs attention")).toBeNull();
});
