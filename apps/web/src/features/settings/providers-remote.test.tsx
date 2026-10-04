import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("providers show what discovery found, with the account at its limit flagged", async () => {
  await harness().open("/settings/providers");
  const providers = await screen.findByRole("region", { name: "Providers" });
  expect(within(providers).getByText("claude 2.1.4 · 2 accounts")).toBeTruthy();
  expect(within(providers).getByText("codex 0.48 · 2 accounts · 1 at limit")).toBeTruthy();
  expect(within(providers).getByText("opencode 1.4 · signed in")).toBeTruthy();
  expect(within(providers).getByText("via ACP · 1 account")).toBeTruthy();
  expect(
    within(providers).getByText("Not installed · ace looks for antigravity on your PATH"),
  ).toBeTruthy();
  // An uninstalled CLI has nothing to manage.
  expect(screen.queryByRole("button", { name: "Manage Antigravity" })).toBeNull();
});

test("Manage opens a provider's accounts and models", async () => {
  await harness().open("/settings/providers");
  await userEvent.click(await screen.findByRole("button", { name: "Manage Codex" }));
  const detail = screen.getByRole("region", { name: "Codex details" });
  expect(within(detail).getByText("Limit reached")).toBeTruthy();
  const models = await within(detail).findByRole("list", { name: "Models" });
  expect(within(models).getByText("GPT-5 Codex")).toBeTruthy();
  expect(within(models).getByText("Default · 400K context")).toBeTruthy();
  expect(within(models).queryByText("Opus 4.1")).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Manage Codex" }));
  expect(screen.queryByRole("region", { name: "Codex details" })).toBeNull();
});

test("an ACP agent added by command joins the provider list", async () => {
  await harness().open("/settings/providers");
  await userEvent.click(await screen.findByRole("button", { name: "Add" }));
  const form = await screen.findByRole("form", { name: "Add an ACP agent" });
  await userEvent.click(within(form).getByRole("button", { name: "Add agent" }));
  expect(await within(form).findByText("Give the agent a name.")).toBeTruthy();

  await userEvent.type(within(form).getByRole("textbox", { name: "Name" }), "Qwen Code");
  await userEvent.type(within(form).getByRole("textbox", { name: "Command" }), "qwen --acp");
  await userEvent.click(within(form).getByRole("button", { name: "Add agent" }));
  await waitFor(() => expect(screen.queryByRole("form", { name: "Add an ACP agent" })).toBeNull());
  expect(await screen.findByText("Qwen Code")).toBeTruthy();
  expect(screen.getByText("via ACP · runs qwen")).toBeTruthy();
});

test("machines and paired devices are listed; revoking a device removes it after confirming", async () => {
  const app = harness();
  await app.open("/settings/remote");
  const machines = await screen.findByRole("region", { name: "Machines" });
  expect(await within(machines).findByText("studio-mac")).toBeTruthy();
  expect(within(machines).getByText(/^Linux · 3 threads · daemon 0\.8\.0/)).toBeTruthy();

  const devices = screen.getByRole("region", { name: "Paired devices" });
  expect(await within(devices).findByText("iPhone 16 Pro")).toBeTruthy();
  await userEvent.click(within(devices).getByRole("button", { name: "Revoke iPhone 16 Pro" }));
  await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(within(devices).getByText("iPhone 16 Pro")).toBeTruthy();

  await userEvent.click(within(devices).getByRole("button", { name: "Revoke iPhone 16 Pro" }));
  const dialog = await screen.findByRole("dialog", { name: "Revoke iPhone 16 Pro?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(within(devices).queryByText("iPhone 16 Pro")).toBeNull());
  expect(within(devices).getByText("iPad Air")).toBeTruthy();
  expect(await screen.findByText("iPhone 16 Pro can no longer reach this daemon")).toBeTruthy();
  expect(app.daemon.access.list().map((device) => device.name)).toEqual(["iPad Air"]);
});

test("pairing shows a one-time QR code, its code and a link that can be copied", async () => {
  const user = userEvent.setup();
  // Pairing codes expire on the daemon's clock; here it is the page's.
  await harness({ clock: () => Date.now() }).open("/settings/remote");
  await user.click(await screen.findByRole("button", { name: "Pair" }));
  const dialog = await screen.findByRole("dialog", { name: "Pair a device" });
  await user.click(within(dialog).getByRole("button", { name: "View only" }));
  await user.click(within(dialog).getByRole("button", { name: "Show pairing code" }));

  expect(await within(dialog).findByRole("img", { name: "Pairing QR code" })).toBeTruthy();
  const code = within(dialog).getByLabelText("Pairing code").textContent ?? "";
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(within(dialog).getByText(/^Expires in (10:00|9:5\d)$/)).toBeTruthy();

  await user.click(within(dialog).getByRole("button", { name: "Copy link" }));
  const copied = await navigator.clipboard.readText();
  expect(copied).toContain(`code=${code}`);
  expect(copied).toContain("scopes=read");
  expect(copied).not.toContain("operate");
});

test("a CLI with no ace account says how that CLI signs in, outside ace", async () => {
  const app = harness();
  app.daemon.services.installed.add("pi");
  await app.open("/settings/providers");
  await userEvent.click(await screen.findByRole("button", { name: "Manage Pi" }));
  const detail = screen.getByRole("region", { name: "Pi details" });
  // Pi signs in from its own prompt; it has no `pi login` command.
  expect(detail.textContent).toContain("Run pi in a terminal, then type /login.");
  expect(detail.textContent).not.toContain("pi login");
});
