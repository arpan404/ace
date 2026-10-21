import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("remote access and transport choices are saved and machine renaming is shown immediately", async () => {
  const app = harness();
  await app.open("/settings/remote");
  const control = await screen.findByRole("switch", { name: "Remote access" });
  await waitFor(() => expect(control.hasAttribute("disabled")).toBe(false));
  await userEvent.click(control);
  await waitFor(() => expect(app.daemon.services.settings.get("remote.enabled")).toBe(false));
  const transport = await screen.findByRole("combobox", { name: "Transport" });
  await waitFor(() => expect(transport.hasAttribute("disabled")).toBe(false));
  await userEvent.click(transport);
  await userEvent.click(await screen.findByRole("option", { name: "LAN" }));
  await waitFor(() => expect(app.daemon.services.settings.get("remote.transport")).toBe("lan"));
  expect(
    screen.getByText("Local network only. Browsers must trust its HTTPS certificate."),
  ).toBeTruthy();
  const thisMachine = screen.getByRole("region", { name: "This machine" });
  await userEvent.click(within(thisMachine).getByRole("button", { name: "Edit" }));
  const name = screen.getByRole("textbox", { name: "Machine name" });
  await userEvent.clear(name);
  await userEvent.type(name, "Office Mac");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(app.daemon.services.settings.get("host.displayName")).toBe("Office Mac"),
  );
  expect(await within(thisMachine).findByText("Office Mac")).toBeTruthy();
});

test("administrator access still requires explicit Projects and Accounts grants", async () => {
  const app = harness({ clock: () => Date.now() });
  await app.open("/settings/remote");
  await userEvent.click(await screen.findByRole("button", { name: "Pair a device" }));
  const dialog = await screen.findByRole("dialog", { name: "Pair a device" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Administrator" }));
  await userEvent.click(within(dialog).getByText("Advanced access", { exact: true }));
  await userEvent.click(within(dialog).getByRole("switch", { name: "Projects" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Show pairing code" }));
  const link = await within(dialog).findByRole<HTMLInputElement>("textbox", {
    name: "Pairing link",
  });
  expect(new URLSearchParams(new URL(link.value).hash.slice(1)).get("scopes")).toBe(
    "read,operate,admin,projects",
  );
  expect(within(dialog).getByText("Administrator, Projects")).toBeTruthy();
});

test("agents on other devices stay out until the person lets them in, read-only first", async () => {
  const app = harness();
  await app.open("/settings/remote");
  const access = await screen.findByRole("group", {
    name: "Agents on other devices can use this machine",
  });
  const choice = (name: string) => within(access).getByRole("button", { name });
  await waitFor(() => expect(choice("Off").getAttribute("aria-pressed")).toBe("true"));
  await userEvent.click(choice("Read"));
  await waitFor(() => expect(app.daemon.services.settings.get("remote.agentAccess")).toBe("read"));
  await userEvent.click(choice("Read and act"));
  await waitFor(() =>
    expect(app.daemon.services.settings.get("remote.agentAccess")).toBe("operate"),
  );
  await userEvent.click(choice("Off"));
  await waitFor(() => expect(app.daemon.services.settings.get("remote.agentAccess")).toBe("off"));
});
